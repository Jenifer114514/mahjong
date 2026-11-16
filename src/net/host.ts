import Peer, { type DataConnection } from 'peerjs';
import {
  decideCpuCallResponse,
  decideCpuTurnAction,
} from '../engine/cpu';
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

export interface HostSessionOptions {
  disablePeer?: boolean;
  cpuTurnDelayMs?: number;
  cpuResponseDelayMs?: number;
}

export class HostSession {
  private peer: Peer | null = null;
  private state: GameState;
  private readonly connections = new Map<string, DataConnection>();
  private readonly callbacks: HostSessionCallbacks;
  private readonly options: Required<HostSessionOptions>;
  private destroyed = false;
  private idRetryCount = 0;
  private nextCpuSeq = 1;
  private responseTimerId: ReturnType<typeof setTimeout> | null = null;
  private cpuTimerIds: ReturnType<typeof setTimeout>[] = [];

  constructor(
    hostName: string,
    ruleConfig: RuleConfig,
    callbacks: HostSessionCallbacks,
    options: HostSessionOptions = {},
  ) {
    this.callbacks = callbacks;
    this.options = {
      disablePeer: options.disablePeer ?? false,
      cpuTurnDelayMs: options.cpuTurnDelayMs ?? 420,
      cpuResponseDelayMs: options.cpuResponseDelayMs ?? 220,
    };
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
    // PeerJS シグナリング前でもロビー画面と CPU 対戦操作を即座に使えるようにする
    this.emitHostView();
    if (this.options.disablePeer) {
      this.callbacks.onStatusChange('ready', 'ローカル対戦モード');
      return;
    }
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
      if (this.state.phase === 'lobby' && this.state.hostPlayerId !== id) {
        this.state = {
          ...this.state,
          hostPlayerId: id,
          players: this.state.players.map((p, idx) =>
            idx === 0 ? { ...p, playerId: id } : p,
          ),
        };
      }
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
      if (
        !opened &&
        this.state.phase === 'lobby' &&
        err.type === 'unavailable-id' &&
        this.idRetryCount < 5
      ) {
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
        this.emitHostView();
        this.openPeerWithCurrentRoomCode();
        return;
      }

      this.callbacks.onStatusChange(
        'error',
        `通信待機オフライン (${err.type}) — CPU対戦はそのまま利用できます`,
      );
    });

    peer.on('disconnected', () => {
      if (!this.destroyed && !peer.destroyed) {
        this.callbacks.onStatusChange(
          'error',
          'シグナリングサーバーから切断されました（CPU対戦は継続可能）',
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

  private getNextCpuDisplayName(existingNames: readonly string[]): string {
    const used = new Set(existingNames);
    for (let i = 1; i <= 4; i++) {
      const candidate = `CPU ${i}`;
      if (!used.has(candidate)) {
        return candidate;
      }
    }
    return `CPU ${existingNames.length + 1}`;
  }

  private maybeStartIfLobbyFull(candidateState: GameState): GameState {
    const rules = deriveRules(candidateState.ruleConfig);
    if (
      candidateState.phase !== 'lobby' ||
      candidateState.players.length !== rules.playerCount
    ) {
      return candidateState;
    }
    const shuffledPlayerIds = shuffleWithCrypto(
      candidateState.players.map((p) => p.playerId),
    );
    const shuffledDeck = shuffleWithCrypto(buildTileDeck(rules));
    const startResult = applyAction(candidateState, {
      type: 'START_GAME',
      shuffledDeck,
      shuffledPlayerIds,
    });
    return startResult.error ? candidateState : startResult.state;
  }

  addCpuPlayer(): void {
    if (this.destroyed || this.state.phase !== 'lobby') return;
    const rules = deriveRules(this.state.ruleConfig);
    if (this.state.players.length >= rules.playerCount) return;

    const cpuId = `cpu-${this.nextCpuSeq++}`;
    const name = this.getNextCpuDisplayName(
      this.state.players.map((p) => p.name),
    );
    const joinResult = applyAction(this.state, {
      type: 'JOIN_PLAYER',
      playerId: cpuId,
      name,
      isCpu: true,
      cpuLevel: rules.cpuLevel,
    });
    if (joinResult.error) {
      this.callbacks.onError(joinResult.error);
      return;
    }
    const nextState = this.maybeStartIfLobbyFull(joinResult.state);
    this.commitState(nextState);
  }

  removeCpuPlayer(playerId: string): void {
    if (this.destroyed || this.state.phase !== 'lobby') return;
    const target = this.state.players.find((p) => p.playerId === playerId);
    if (!target || !target.isCpu) return;
    this.dispatchHostAction({
      type: 'LEAVE_LOBBY',
      playerId,
    });
  }

  fillWithCpusAndStart(): void {
    if (this.destroyed || this.state.phase !== 'lobby') return;
    const rules = deriveRules(this.state.ruleConfig);
    let nextState = this.state;

    while (nextState.players.length < rules.playerCount) {
      const cpuId = `cpu-${this.nextCpuSeq++}`;
      const name = this.getNextCpuDisplayName(
        nextState.players.map((p) => p.name),
      );
      const joinResult = applyAction(nextState, {
        type: 'JOIN_PLAYER',
        playerId: cpuId,
        name,
        isCpu: true,
        cpuLevel: rules.cpuLevel,
      });
      if (joinResult.error) {
        this.callbacks.onError(joinResult.error);
        return;
      }
      nextState = joinResult.state;
    }

    nextState = this.maybeStartIfLobbyFull(nextState);
    this.commitState(nextState);
  }

  private commitState(nextState: GameState): void {
    this.clearCpuTimers();
    this.state = nextState;
    this.syncResponseTimer();
    this.broadcastViews();
    this.scheduleCpuActionsIfNeeded();
  }

  private clearCpuTimers(): void {
    for (const id of this.cpuTimerIds) {
      clearTimeout(id);
    }
    this.cpuTimerIds = [];
  }

  private attachNowTimestamp(action: Action): Action {
    const now = Date.now();
    switch (action.type) {
      case 'DISCARD_TILE':
      case 'DECLARE_RIICHI':
      case 'DECLARE_ANKAN':
      case 'DECLARE_KAKAN':
        return { ...action, now };
      default:
        return action;
    }
  }

  private scheduleCpuActionsIfNeeded(): void {
    if (this.destroyed || !this.state.round) return;
    const rules = deriveRules(this.state.ruleConfig);

    if (this.state.phase === 'playing') {
      const round = this.state.round;
      const activePlayer = this.state.players.find(
        (p) => p.seatIndex === round.currentTurnIndex,
      );
      if (!activePlayer || !activePlayer.isCpu) return;

      const expectedTurnCount = round.turnCount;
      const expectedPlayerId = activePlayer.playerId;

      const timerId = setTimeout(() => {
        if (this.destroyed || this.state.phase !== 'playing' || !this.state.round) {
          return;
        }
        const curPlayer = this.state.players.find(
          (p) => p.seatIndex === this.state.round!.currentTurnIndex,
        );
        if (
          this.state.round.turnCount !== expectedTurnCount ||
          !curPlayer ||
          curPlayer.playerId !== expectedPlayerId ||
          !curPlayer.isCpu
        ) {
          return;
        }

        const rawAction = decideCpuTurnAction(this.state, curPlayer, rules);
        let result = applyAction(this.state, this.attachNowTimestamp(rawAction));

        // 万一のフォールバック: 必ず合法な打牌で進行を止めない
        if (result.error) {
          const fallbackTile = curPlayer.drawnTile ?? curPlayer.hand[0];
          if (fallbackTile) {
            result = applyAction(this.state, {
              type: 'DISCARD_TILE',
              playerId: curPlayer.playerId,
              tileId: fallbackTile.id,
              now: Date.now(),
            });
          }
        }

        if (!result.error) {
          this.commitState(result.state);
        }
      }, this.options.cpuTurnDelayMs);

      this.cpuTimerIds.push(timerId);
      return;
    }

    if (
      this.state.phase === 'awaiting_responses' &&
      this.state.round.pendingResponse
    ) {
      const pending = this.state.round.pendingResponse;
      const unrespondedCpuIds = Object.keys(pending.optionsByPlayerId).filter(
        (pid) => {
          if (pid in pending.responses) return false;
          const player = this.state.players.find((p) => p.playerId === pid);
          return Boolean(player?.isCpu);
        },
      );
      if (unrespondedCpuIds.length === 0) return;

      const expectedTurnCount = pending.turnCount;

      const timerId = setTimeout(() => {
        if (
          this.destroyed ||
          this.state.phase !== 'awaiting_responses' ||
          !this.state.round?.pendingResponse ||
          this.state.round.pendingResponse.turnCount !== expectedTurnCount
        ) {
          return;
        }

        let nextState = this.state;
        let changed = false;

        for (const cpuId of unrespondedCpuIds) {
          if (
            nextState.phase !== 'awaiting_responses' ||
            !nextState.round?.pendingResponse
          ) {
            break;
          }
          const curPending = nextState.round.pendingResponse;
          if (cpuId in curPending.responses) continue;
          const opts = curPending.optionsByPlayerId[cpuId];
          const cpuPlayer = nextState.players.find((p) => p.playerId === cpuId);
          if (!opts || !cpuPlayer || !cpuPlayer.isCpu) continue;

          let choice = decideCpuCallResponse(nextState, cpuPlayer, opts, rules);
          let res = applyAction(nextState, {
            type: 'CALL_RESPONSE',
            playerId: cpuId,
            choice,
          });
          if (res.error) {
            choice = { type: 'pass' };
            res = applyAction(nextState, {
              type: 'CALL_RESPONSE',
              playerId: cpuId,
              choice,
            });
          }
          if (!res.error) {
            nextState = res.state;
            changed = true;
          }
        }

        if (changed) {
          this.commitState(nextState);
        }
      }, this.options.cpuResponseDelayMs);

      this.cpuTimerIds.push(timerId);
    }
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
      if (player.playerId === this.state.hostPlayerId || player.isCpu) {
        continue;
      }
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
    this.clearCpuTimers();
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
