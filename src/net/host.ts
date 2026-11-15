import Peer, { type DataConnection } from 'peerjs';
import { toStateView } from '../engine/projection';
import { applyAction, createInitialGameState } from '../engine/reducer';
import { deriveRules } from '../engine/rules';
import type { Action, GameError, HostMessage, StateView } from '../types/message';
import type { RuleConfig } from '../types/rule';
import type { GameState } from '../types/state';
import {
  PEER_OPTIONS,
  createRandomSeed,
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

      // 設定した人数が揃ったら自動開局
      if (
        nextState.phase === 'lobby' &&
        nextState.players.length === rules.playerCount
      ) {
        const startResult = applyAction(nextState, {
          type: 'START_GAME',
          seed: createRandomSeed(),
        });
        if (!startResult.error) {
          nextState = startResult.state;
        }
      }

      this.state = nextState;
      this.broadcastViews();
      return;
    }

    // message.kind === 'ACTION'
    let engineAction: Action;
    if (message.action.type === 'DISCARD_TILE') {
      engineAction = {
        type: 'DISCARD_TILE',
        playerId,
        tileId: message.action.tileId,
      };
    } else {
      engineAction = {
        type: 'ADVANCE_ROUND',
        playerId,
        seed: createRandomSeed(),
      };
    }

    const result = applyAction(this.state, engineAction);
    if (result.error) {
      this.sendToConn(conn, {
        kind: 'ERROR',
        payload: result.error,
      });
      return;
    }

    this.state = result.state;
    this.broadcastViews();
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
      this.state = result.state;
      this.broadcastViews();
    }
  }

  discardTile(tileId: string): void {
    const result = applyAction(this.state, {
      type: 'DISCARD_TILE',
      playerId: this.state.hostPlayerId,
      tileId,
    });
    if (result.error) {
      this.callbacks.onError(result.error);
      return;
    }
    this.state = result.state;
    this.broadcastViews();
  }

  advanceRound(): void {
    const result = applyAction(this.state, {
      type: 'ADVANCE_ROUND',
      playerId: this.state.hostPlayerId,
      seed: createRandomSeed(),
    });
    if (result.error) {
      this.callbacks.onError(result.error);
      return;
    }
    this.state = result.state;
    this.broadcastViews();
  }

  private emitHostView(): void {
    this.callbacks.onViewChange(
      toStateView(this.state, this.state.hostPlayerId),
    );
  }

  private broadcastViews(): void {
    this.emitHostView();
    for (const player of this.state.players) {
      if (player.playerId === this.state.hostPlayerId) continue;
      const conn = this.connections.get(player.playerId);
      if (conn && conn.open) {
        this.sendToConn(conn, {
          kind: 'STATE_VIEW',
          payload: toStateView(this.state, player.playerId),
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
