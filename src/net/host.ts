import Peer, { type DataConnection } from 'peerjs';
import { toStateView } from '../engine/projection';
import { applyAction, createInitialGameState } from '../engine/reducer';
import { deriveRules } from '../engine/rules';
import { buildTileDeck, shuffleWithCrypto } from '../engine/wall';
import type { Action, GameError, HostMessage, StateView } from '../types/message';
import type { RuleConfig } from '../types/rule';
import type { CallResponseChoice, GameState } from '../types/state';
import type { TileKind } from '../types/tile';
import {
  PEER_OPTIONS,
  generateRoomCode,
  parseClientMessage,
  roomCodeToPeerId,
} from './protocol';

export type HostConnectionStatus = 'initializing' | 'ready' | 'error' | 'closed';

export interface HostSessionCallbacks {
  onViewChange: (view: StateView) => void;
  onStatusChange: (status: HostConnectionStatus, detail?: string) => void;
  onError: (error: GameError) => void;
}

export class HostSession {
  private peer: Peer | null = null;
  private state: GameState;
  private readonly connections = new Map<string, DataConnection>();
  private readonly callbacks: HostSessionCallbacks;
  private destroyed = false;
  private idRetryCount = 0;
  private responseTimerId: ReturnType<typeof setTimeout> | null = null;

  constructor(
    hostName: string,
    ruleConfig: RuleConfig,
    callbacks: HostSessionCallbacks,
  ) {
    this.callbacks = callbacks;
    const roomCode = generateRoomCode();
    const hostPeerId = roomCodeToPeerId(roomCode);
    this.state = createInitialGameState({
      roomCode,
      hostPlayerId: hostPeerId,
      hostName,
      ruleConfig,
    });
  }

  getRoomCode(): string {
    return this.state.roomCode;
  }

  start(): void {
    if (this.destroyed) return;
    this.callbacks.onStatusChange('initializing', 'PeerJS サーバーに接続中...');
    this.openPeerWithCurrentRoomCode();
  }

  private openPeerWithCurrentRoomCode(): void {
    const peerId = roomCodeToPeerId(this.state.roomCode);
    const peer = new Peer(peerId, PEER_OPTIONS);
    this.peer = peer;

    let opened = false;

    peer.on('open', (id) => {
      if (this.destroyed) {
        peer.destroy();
        return;
      }
      opened = true;
      this.state = {
        ...this.state,
        hostPlayerId: id,
        players: this.state.players.map((p, idx) =>
          idx === 0 ? { ...p, playerId: id } : p,
        ),
      };
      this.callbacks.onStatusChange('ready', '参加者待機中');
      this.emitHostView();
    });

    peer.on('connection', (conn) => {
      if (this.destroyed) {
        conn.close();
        return;
      }
      this.attachConnection(conn);
    });

    peer.on('error', (err) => {
      if (this.destroyed) return;
      if (!opened && err.type === 'unavailable-id' && this.idRetryCount < 5) {
        this.idRetryCount++;
        peer.destroy();
        const nextCode = generateRoomCode();
        const nextHostId = roomCodeToPeerId(nextCode);
        this.state = {
          ...this.state,
          roomCode: nextCode,
          hostPlayerId: nextHostId,
          players: this.state.players.map((p, idx) =>
            idx === 0 ? { ...p, playerId: nextHostId } : p,
          ),
        };
        this.openPeerWithCurrentRoomCode();
        return;
      }

      this.callbacks.onStatusChange(
        'error',
        `接続エラー (${err.type}): ${err.message}`,
      );
    });

    peer.on('disconnected', () => {
      if (!this.destroyed && !peer.destroyed) {
        this.callbacks.onStatusChange(
          'error',
          'シグナリングサーバーから切断されました',
        );
      }
    });
  }

  private attachConnection(conn: DataConnection): void {
    const peerId = conn.peer;

    conn.on('open', () => {
      if (this.destroyed) {
        conn.close();
        return;
      }
      const existing = this.connections.get(peerId);
      if (existing && existing !== conn) {
        existing.close();
      }
      this.connections.set(peerId, conn);
    });

    conn.on('data', (raw) => {
      if (this.destroyed) return;
      if (!this.connections.has(peerId) && conn.open) {
        this.connections.set(peerId, conn);
      }
      this.handleClientData(conn, raw);
    });

    conn.on('close', () => {
      if (this.destroyed) return;
      if (this.connections.get(peerId) === conn) {
        this.connections.delete(peerId);
      }
      this.handlePeerDisconnect(peerId);
    });

    conn.on('error', (err) => {
      if (this.destroyed) return;
      this.callbacks.onError({
        code: 'INVALID_MESSAGE',
        message: `通信エラー (${peerId}): ${err.message}`,
      });
    });
  }

  private handleClientData(conn: DataConnection, raw: unknown): void {
    const message = parseClientMessage(raw);
    if (!message) {
      this.sendToConn(conn, {
        kind: 'ERROR',
        payload: {
          code: 'INVALID_MESSAGE',
          message: '不正な形式のメッセージです。',
        },
      });
      return;
    }

    const playerId = conn.peer;

    if (message.kind === 'JOIN') {
      const joinResult = applyAction(this.state, {
        type: 'JOIN_PLAYER',
        playerId,
        name: message.playerName,
      });

      if (joinResult.error) {
        this.sendToConn(conn, {
          kind: 'ERROR',
          payload: joinResult.error,
        });
        return;
      }

      let nextState = joinResult.state;
      const rules = deriveRules(nextState.ruleConfig);

      // 設定した人数が揃ったら自動開局（CSPRNG で席順と山牌をシャッフル）
      if (
        nextState.phase === 'lobby' &&
        nextState.players.length === rules.playerCount
      ) {
        const shuffledPlayerIds = shuffleWithCrypto(
          nextState.players.map((p) => p.playerId),
        );
        const shuffledDeck = shuffleWithCrypto(buildTileDeck(rules));
        const startResult = applyAction(nextState, {
          type: 'START_GAME',
          shuffledDeck,
          shuffledPlayerIds,
        });
        if (!startResult.error) {
          nextState = startResult.state;
        }
      }

      this.commitState(nextState);
      return;
    }

    const rules = deriveRules(this.state.ruleConfig);
    let engineAction: Action;
    switch (message.action.type) {
      case 'DISCARD_TILE':
        engineAction = {
          type: 'DISCARD_TILE',
          playerId,
          tileId: message.action.tileId,
          now: Date.now(),
        };
        break;
      case 'CALL_RESPONSE':
        engineAction = {
          type: 'CALL_RESPONSE',
          playerId,
          choice: message.action.choice,
        };
        break;
      case 'DECLARE_TSUMO':
        engineAction = {
          type: 'DECLARE_TSUMO',
          playerId,
        };
        break;
      case 'DECLARE_RIICHI':
        engineAction = {
          type: 'DECLARE_RIICHI',
          playerId,
          tileId: message.action.tileId,
          now: Date.now(),
        };
        break;
      case 'DECLARE_ANKAN':
        engineAction = {
          type: 'DECLARE_ANKAN',
          playerId,
          kind: message.action.kind,
          now: Date.now(),
        };
        break;
      case 'DECLARE_KAKAN':
        engineAction = {
          type: 'DECLARE_KAKAN',
          playerId,
          tileId: message.action.tileId,
          now: Date.now(),
        };
        break;
      case 'DECLARE_KITA':
        engineAction = {
          type: 'DECLARE_KITA',
          playerId,
          tileId: message.action.tileId,
        };
        break;
      case 'DECLARE_KYUUSHU_KYUUHAI':
        engineAction = {
          type: 'DECLARE_KYUUSHU_KYUUHAI',
          playerId,
        };
        break;
      case 'ADVANCE_ROUND':
        engineAction = {
          type: 'ADVANCE_ROUND',
          playerId,
          shuffledDeck: shuffleWithCrypto(buildTileDeck(rules)),
        };
        break;
    }

    const result = applyAction(this.state, engineAction);
    if (result.error) {
      this.sendToConn(conn, {
        kind: 'ERROR',
        payload: result.error,
      });
      return;
    }

    this.commitState(result.state);
  }

  private handlePeerDisconnect(playerId: string): void {
    const exists = this.state.players.some((p) => p.playerId === playerId);
    if (!exists) return;

    const action: Action =
      this.state.phase === 'lobby'
        ? { type: 'LEAVE_LOBBY', playerId }
        : { type: 'SET_PLAYER_CONNECTED', playerId, connected: false };

    const result = applyAction(this.state, action);
    if (!result.error) {
      this.commitState(result.state);
    }
  }

  private dispatchHostAction(action: Action): void {
    const result = applyAction(this.state, action);
    if (result.error) {
      this.callbacks.onError(result.error);
      return;
    }
    this.commitState(result.state);
  }

  discardTile(tileId: string): void {
    this.dispatchHostAction({
      type: 'DISCARD_TILE',
      playerId: this.state.hostPlayerId,
      tileId,
      now: Date.now(),
    });
  }

  respondToCall(choice: CallResponseChoice): void {
    this.dispatchHostAction({
      type: 'CALL_RESPONSE',
      playerId: this.state.hostPlayerId,
      choice,
    });
  }

  declareTsumo(): void {
    this.dispatchHostAction({
      type: 'DECLARE_TSUMO',
      playerId: this.state.hostPlayerId,
    });
  }

  declareRiichi(tileId: string): void {
    this.dispatchHostAction({
      type: 'DECLARE_RIICHI',
      playerId: this.state.hostPlayerId,
      tileId,
      now: Date.now(),
    });
  }

  declareAnkan(kind: TileKind): void {
    this.dispatchHostAction({
      type: 'DECLARE_ANKAN',
      playerId: this.state.hostPlayerId,
      kind,
      now: Date.now(),
    });
  }

  declareKakan(tileId: string): void {
    this.dispatchHostAction({
      type: 'DECLARE_KAKAN',
      playerId: this.state.hostPlayerId,
      tileId,
      now: Date.now(),
    });
  }

  declareKita(tileId: string): void {
    this.dispatchHostAction({
      type: 'DECLARE_KITA',
      playerId: this.state.hostPlayerId,
      tileId,
    });
  }

  declareKyuushuKyuuhai(): void {
    this.dispatchHostAction({
      type: 'DECLARE_KYUUSHU_KYUUHAI',
      playerId: this.state.hostPlayerId,
    });
  }

  advanceRound(): void {
    const rules = deriveRules(this.state.ruleConfig);
    this.dispatchHostAction({
      type: 'ADVANCE_ROUND',
      playerId: this.state.hostPlayerId,
      shuffledDeck: shuffleWithCrypto(buildTileDeck(rules)),
    });
  }

  private commitState(nextState: GameState): void {
    this.state = nextState;
    this.syncResponseTimer();
    this.broadcastViews();
  }

  private clearResponseTimer(): void {
    if (this.responseTimerId !== null) {
      clearTimeout(this.responseTimerId);
      this.responseTimerId = null;
    }
  }

  private syncResponseTimer(): void {
    this.clearResponseTimer();
    if (
      this.destroyed ||
      this.state.phase !== 'awaiting_responses' ||
      !this.state.round?.pendingResponse
    ) {
      return;
    }
    const rules = deriveRules(this.state.ruleConfig);
    if (rules.responseTimeoutMs <= 0) {
      return;
    }
    const pending = this.state.round.pendingResponse;
    const delayMs = Math.max(
      0,
      pending.openedAt + rules.responseTimeoutMs - Date.now(),
    );
    const scheduledTurnCount = pending.turnCount;

    this.responseTimerId = setTimeout(() => {
      this.responseTimerId = null;
      if (this.destroyed) return;
      const result = applyAction(this.state, {
        type: 'RESPONSE_TIMEOUT',
        playerId: this.state.hostPlayerId,
        turnCount: scheduledTurnCount,
      });
      if (!result.error) {
        this.commitState(result.state);
      }
    }, delayMs);
  }

  private emitHostView(): void {
    const now = Date.now();
    this.callbacks.onViewChange(
      toStateView(this.state, this.state.hostPlayerId, now),
    );
  }

  private broadcastViews(): void {
    const now = Date.now();
    this.callbacks.onViewChange(
      toStateView(this.state, this.state.hostPlayerId, now),
    );
    for (const player of this.state.players) {
      if (player.playerId === this.state.hostPlayerId) continue;
      const conn = this.connections.get(player.playerId);
      if (conn && conn.open) {
        this.sendToConn(conn, {
          kind: 'STATE_VIEW',
          payload: toStateView(this.state, player.playerId, now),
        });
      }
    }
  }

  private sendToConn(conn: DataConnection, message: HostMessage): void {
    if (!conn.open) return;
    try {
      conn.send(message);
    } catch {
      // ignore send errors on closing channel
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.clearResponseTimer();
    for (const conn of this.connections.values()) {
      conn.close();
    }
    this.connections.clear();
    if (this.peer && !this.peer.destroyed) {
      this.peer.destroy();
    }
    this.peer = null;
    this.callbacks.onStatusChange('closed');
  }
}
