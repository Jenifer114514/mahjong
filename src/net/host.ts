import Peer, { type DataConnection } from 'peerjs';
import {
  CPU_PLAYER_ID_PREFIX,
  cpuDisplayName,
  decideCpuAction,
  isCpuPlayerId,
  toEngineAction,
  type CpuAction,
} from '../cpu/player';
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
  /** 追加する CPU の数（ホスト + CPU で規定人数に達すると自動開局） */
  cpuCount?: number;
  /** CPU の思考時間(ms)。0 にすると即座に打牌する（テスト用） */
  cpuDelayMs?: number;
  /** CPU 操作の遅延スケジュール（テスト用に差し替え可能） */
  cpuScheduler?: (fn: () => void, delayMs: number) => void;
  /**
   * オンライン化せず CPU だけで遊ぶローカル対局モード。
   * PeerJS へ接続しないため、オフライン環境でも対局できる。
   */
  offline?: boolean;
}

export class HostSession {
  private peer: Peer | null = null;
  private state: GameState;
  private readonly connections = new Map<string, DataConnection>();
  private readonly callbacks: HostSessionCallbacks;
  private destroyed = false;
  private idRetryCount = 0;
  private responseTimerId: ReturnType<typeof setTimeout> | null = null;
  private readonly offline: boolean;
  /** 設定された CPU 数（ロビーで後から増やせるため可変） */
  private cpuCount: number;
  private readonly cpuDelayMs: number;
  private readonly cpuScheduler: (fn: () => void, delayMs: number) => void;
  private cpuToken = 0;

  constructor(
    hostName: string,
    ruleConfig: RuleConfig,
    callbacks: HostSessionCallbacks,
    options: HostSessionOptions = {},
  ) {
    this.callbacks = callbacks;
    this.offline = options.offline ?? false;
    this.cpuCount = options.cpuCount ?? 0;
    this.cpuDelayMs = options.cpuDelayMs ?? 700;
    this.cpuScheduler = options.cpuScheduler ?? ((fn, delay) => {
      setTimeout(fn, delay);
    });
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
    return this.offline ? 'LOCAL' : this.state.roomCode;
  }

  /** ローカル対局（CPU戦）かどうか */
  isOffline(): boolean {
    return this.offline;
  }

  start(): void {
    if (this.destroyed) return;
    if (this.offline) {
      // ローカル対局: 通信を張らずに CPU 席だけ用意する
      this.callbacks.onStatusChange('ready', 'ローカル対局（CPU戦）');
      this.bootstrapCpuSeats();
      if (this.cpuCount <= 0) {
        this.emitHostView();
      }
      return;
    }
    this.callbacks.onStatusChange('initializing', 'PeerJS サーバーに接続中...');
    this.openPeerWithCurrentRoomCode();
    this.bootstrapCpuSeats();
  }

  /** 設定された人数分の CPU 席をロビーに追加し、揃っていれば開局する */
  private bootstrapCpuSeats(): void {
    if (this.cpuCount <= 0 || this.destroyed) return;
    let next = this.state;
    const rules = deriveRules(next.ruleConfig);
    for (let i = 0; i < this.cpuCount; i++) {
      const cpuId = cpuPlayerId(i);
      if (next.players.some((p) => p.playerId === cpuId)) continue;
      if (next.players.length >= rules.playerCount) break;
      const result = applyAction(next, {
        type: 'JOIN_PLAYER',
        playerId: cpuId,
        name: cpuName(i),
      });
      if (result.error) break;
      next = result.state;
    }
    if (next !== this.state) {
      this.commitState(this.maybeAutoStart(next));
    }
  }

  /**
   * ロビーに CPU を 1 体追加する（ホストのみ・開局後は不可）。
   * 席が埋まった時点で通常どおり自動開局する。
   */
  addCpu(): boolean {
    if (this.destroyed || this.state.phase !== 'lobby') return false;
    const rules = deriveRules(this.state.ruleConfig);
    if (this.state.players.length >= rules.playerCount) return false;

    // まだ使われていない CPU 番号を探す
    let index = 0;
    while (
      this.state.players.some((p) => p.playerId === cpuPlayerId(index))
    ) {
      index++;
    }
    const result = applyAction(this.state, {
      type: 'JOIN_PLAYER',
      playerId: cpuPlayerId(index),
      name: cpuName(index),
    });
    if (result.error) return false;

    this.cpuCount = Math.max(this.cpuCount, index + 1);
    this.commitState(this.maybeAutoStart(result.state));
    return true;
  }

  /** ロビーから CPU を 1 体減らす（最後に追加された CPU を抜く） */
  removeCpu(): boolean {
    if (this.destroyed || this.state.phase !== 'lobby') return false;
    const cpuPlayers = this.state.players.filter((p) => isCpuPlayerId(p.playerId));
    if (cpuPlayers.length === 0) return false;
    // CPU 番号が大きいものから抜く
    const target = [...cpuPlayers].sort((a, b) =>
      b.playerId.localeCompare(a.playerId, 'en', { numeric: true }),
    )[0]!;
    const result = applyAction(this.state, {
      type: 'LEAVE_LOBBY',
      playerId: target.playerId,
    });
    if (result.error) return false;
    this.cpuCount = Math.max(0, this.cpuCount - 1);
    this.commitState(result.state);
    return true;
  }

  /** ロビーで人数が揃っていれば自動開局する */
  private maybeAutoStart(nextState: GameState): GameState {
    const rules = deriveRules(nextState.ruleConfig);
    if (
      nextState.phase !== 'lobby' ||
      nextState.players.length !== rules.playerCount
    ) {
      return nextState;
    }
    const shuffledPlayerIds = shuffleWithCrypto(
      nextState.players.map((p) => p.playerId),
    );
    const shuffledDeck = shuffleWithCrypto(buildTileDeck(rules));
    const startResult = applyAction(nextState, {
      type: 'START_GAME',
      shuffledDeck,
      shuffledPlayerIds,
    });
    return startResult.error ? nextState : startResult.state;
  }

  private isCpuPlayer(playerId: string): boolean {
    // ロビーで追加された CPU は番号が飛ぶことがあるため接頭辞で判定する
    return isCpuPlayerId(playerId);
  }

  private remapHostPlayerId(prevId: string, nextId: string): void {
    if (prevId === nextId) return;
    const round = this.state.round;
    let nextRound = round;
    if (round?.pendingResponse) {
      const pending = round.pendingResponse;
      const remapRecord = <T>(rec: Record<string, T>): Record<string, T> => {
        if (!(prevId in rec)) return rec;
        const next: Record<string, T> = {};
        for (const [key, val] of Object.entries(rec)) {
          next[key === prevId ? nextId : key] = val;
        }
        return next;
      };
      nextRound = {
        ...round,
        pendingResponse: {
          ...pending,
          optionsByPlayerId: remapRecord(pending.optionsByPlayerId),
          responses: remapRecord(pending.responses),
          riichiDeclaration:
            pending.riichiDeclaration?.playerId === prevId
              ? { ...pending.riichiDeclaration, playerId: nextId }
              : pending.riichiDeclaration,
          kakanTarget:
            pending.kakanTarget?.playerId === prevId
              ? { ...pending.kakanTarget, playerId: nextId }
              : pending.kakanTarget,
          ankanTarget:
            pending.ankanTarget?.playerId === prevId
              ? { ...pending.ankanTarget, playerId: nextId }
              : pending.ankanTarget,
        },
      };
    }

    this.state = {
      ...this.state,
      hostPlayerId: nextId,
      players: this.state.players.map((p) =>
        p.playerId === prevId ? { ...p, playerId: nextId } : p,
      ),
      round: nextRound,
    };
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
      this.remapHostPlayerId(this.state.hostPlayerId, id);
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
        };
        this.remapHostPlayerId(this.state.hostPlayerId, nextHostId);
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

      // 設定した人数が揃ったら自動開局（CSPRNG で席順と山牌をシャッフル）
      this.commitState(this.maybeAutoStart(joinResult.state));
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
    this.scheduleCpuTick();
  }

  private hasAnyCpu(): boolean {
    return (
      this.cpuCount > 0 ||
      this.state.players.some((p) => this.isCpuPlayer(p.playerId))
    );
  }

  /** CPU の手番・応答待ちが残っていれば次の一手を予約する */
  private scheduleCpuTick(): void {
    if (this.destroyed || !this.hasAnyCpu()) return;
    const phase = this.state.phase;
    if (phase === 'finished') return;

    const token = ++this.cpuToken;
    // 鳴き・ロンの応答は打牌より短く待ってテンポよく進める
    const delayMs =
      phase === 'awaiting_responses'
        ? Math.round(this.cpuDelayMs * 0.45)
        : this.cpuDelayMs;
    this.cpuScheduler(() => {
      if (this.destroyed || token !== this.cpuToken) return;
      const progressed = this.runCpuStepOnce();
      if (progressed) {
        this.scheduleCpuTick();
      }
    }, delayMs);
  }

  /**
   * CPU の操作を 1 手だけ適用する（適用したら true）。
   * タイマー経由の自動進行のほか、テストから決定的に駆動する場合にも使う。
   */
  runCpuStepOnce(): boolean {
    if (this.destroyed || !this.hasAnyCpu()) return false;
    const phase = this.state.phase;

    if (phase === 'lobby') {
      const missing = this.missingCpuIds();
      if (missing.length === 0) {
        // CPU 席は揃っているが未開局（人間の参加待ちなど）
        const started = this.maybeAutoStart(this.state);
        if (started !== this.state) {
          this.commitState(started);
          return true;
        }
        return false;
      }
      const result = applyAction(this.state, {
        type: 'JOIN_PLAYER',
        playerId: missing[0]!,
        name: cpuName(cpuIndexOf(missing[0]!, this.cpuCount)),
      });
      if (result.error) return false;
      this.commitState(this.maybeAutoStart(result.state));
      return true;
    }

    if (phase === 'awaiting_responses') {
      const pending = this.state.round?.pendingResponse;
      if (!pending) return false;
      for (const pid of Object.keys(pending.optionsByPlayerId)) {
        if (pid in pending.responses) continue;
        if (!this.isCpuPlayer(pid)) continue;
        const view = toStateView(this.state, pid, Date.now());
        if (!view.myCallOptions) continue;
        const decision =
          decideCpuAction(view) ?? {
            type: 'CALL_RESPONSE' as const,
            choice: { type: 'pass' as const },
          };
        return this.applyCpuDecision(pid, decision);
      }
      return false;
    }

    if (phase !== 'playing') return false;

    const current = this.state.players.find(
      (p) => p.seatIndex === this.state.round?.currentTurnIndex,
    );
    if (!current || !this.isCpuPlayer(current.playerId)) return false;
    if (this.state.round?.pendingResponse) return false;

    const view = toStateView(this.state, current.playerId, Date.now());
    const decision =
      decideCpuAction(view) ??
      (view.myDrawnTile
        ? { type: 'DISCARD_TILE' as const, tileId: view.myDrawnTile.id }
        : null);
    if (!decision) return false;
    return this.applyCpuDecision(current.playerId, decision);
  }

  private applyCpuDecision(playerId: string, decision: CpuAction): boolean {
    const rules = deriveRules(this.state.ruleConfig);
    const engineAction = toEngineAction(playerId, decision, {
      now: Date.now(),
      shuffledDeck: shuffleWithCrypto(buildTileDeck(rules)),
    });
    if (!engineAction) return false;
    const result = applyAction(this.state, engineAction);
    if (result.error) {
      if (decision.type !== 'DISCARD_TILE') {
        // 選択が却下された場合はツモ切りでフォールバックする
        const view = toStateView(this.state, playerId, Date.now());
        if (view.myDrawnTile) {
          const fallback = applyAction(this.state, {
            type: 'DISCARD_TILE',
            playerId,
            tileId: view.myDrawnTile.id,
            now: Date.now(),
          });
          if (!fallback.error) {
            this.commitState(fallback.state);
            return true;
          }
        }
      }
      return false;
    }
    this.commitState(result.state);
    return true;
  }

  private missingCpuIds(): string[] {
    const rules = deriveRules(this.state.ruleConfig);
    const existing = this.state.players.filter((p) =>
      isCpuPlayerId(p.playerId),
    ).length;
    const missing: string[] = [];
    for (let i = 0; i < this.cpuCount - existing; i++) {
      // 追加予定の CPU 番号は、空いている番号を順に使う
      let index = 0;
      while (
        this.state.players.some((p) => p.playerId === cpuPlayerId(index)) ||
        missing.includes(cpuPlayerId(index))
      ) {
        index++;
      }
      missing.push(cpuPlayerId(index));
    }
    if (this.state.players.length + missing.length > rules.playerCount) {
      return missing.slice(0, Math.max(0, rules.playerCount - this.state.players.length));
    }
    return missing;
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
    this.cpuToken++;
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

function cpuPlayerId(index: number): string {
  return `${CPU_PLAYER_ID_PREFIX}${index + 1}`;
}

function cpuName(index: number): string {
  return cpuDisplayName(index);
}

function cpuIndexOf(playerId: string, cpuCount: number): number {
  for (let i = 0; i < cpuCount; i++) {
    if (cpuPlayerId(i) === playerId) return i;
  }
  return 0;
}
