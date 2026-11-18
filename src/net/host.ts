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
import type {
  Action,
  ChatMessage,
  GameError,
  HostCheckpointPayload,
  HostMessage,
  HostMigratingPayload,
  HostSnapshotPayload,
  RoomStatusPayload,
  SessionWelcomePayload,
  StateView,
} from '../types/message';
import type { RuleConfig } from '../types/rule';
import type { CallResponseChoice, GameState } from '../types/state';
import type { TileKind } from '../types/tile';
import {
  PEER_OPTIONS,
  generateRoomCode,
  migratedHostPeerId,
  normalizeRoomCode,
  parseClientMessage,
  roomCodeToPeerId,
} from './protocol';
import {
  decryptCheckpoint,
  encryptCheckpoint,
  generateReconnectToken,
} from './recovery';
import { isPermanentRoomCode } from './rooms';

export type HostConnectionStatus = 'initializing' | 'ready' | 'error' | 'closed';

export interface PendingEncryptedTakeover {
  hostEpoch: number;
  seq: number;
  ivBase64: string;
  ciphertextBase64: string;
  localPlayerId: string;
  localReconnectToken: string;
  fallbackView: StateView;
  initialKeyBase64?: string;
}

export interface HostSessionCallbacks {
  onViewChange: (view: StateView) => void;
  onStatusChange: (status: HostConnectionStatus, detail?: string) => void;
  onError: (error: GameError) => void;
  onChatMessage?: (message: ChatMessage) => void;
  onChatHistory?: (messages: ChatMessage[]) => void;
  onWelcome?: (welcome: SessionWelcomePayload) => void;
  onPermanentRoomClaimConflict?: (roomCode: string) => void;
  onHostSelfDemoted?: (
    migration: HostMigratingPayload,
    localReconnectToken: string,
    localPlayerId: string,
  ) => void;
}

export interface HostSessionOptions {
  /** 追加する CPU の数 */
  cpuCount?: number;
  /** CPU の思考時間(ms)。0 にすると即座に打牌する（テスト用） */
  cpuDelayMs?: number;
  /** CPU 遅延の揺らぎ生成用乱数（決定論テスト用に差し替え可能） */
  cpuRandom?: () => number;
  /** CPU 操作の遅延スケジュール（テスト用に差し替え可能） */
  cpuScheduler?: (fn: () => void, delayMs: number) => void;
  /**
   * オンライン化せず CPU だけで遊ぶローカル対局モード。
   * PeerJS へ接続しないため、オフライン環境でも対局できる。
   */
  offline?: boolean;
  /**
   * 人数が揃った時点で自動開局するか（既定: false）。
   * 「いますぐCPUと対局」などの即開始モードでのみ true にする。
   */
  autoStart?: boolean;
  /** 固定部屋コード（銅・銀・金の間など常設ルーム用） */
  fixedRoomCode?: string;
  /** ホスト委譲で引き継いだスナップショット */
  initialSnapshot?: HostSnapshotPayload;
  /** ホスト突然死後に復号鍵を待って復元するチェックポイント */
  pendingTakeover?: PendingEncryptedTakeover;
  /** 切断中のプレイヤー手番を自動ツモ切り代打ちするまでの猶予(ms) */
  disconnectGraceMs?: number;
}

export class HostSession {
  private peer: Peer | null = null;
  private beaconPeer: Peer | null = null;
  private beaconRetryTimerId: ReturnType<typeof setTimeout> | null = null;
  private beaconRetryCount = 0;
  private reconnectPeerTimerId: ReturnType<typeof setTimeout> | null = null;
  private reconnectPeerAttempts = 0;

  private state: GameState;
  private readonly participantConns = new Map<string, DataConnection>();
  private readonly peerToParticipant = new Map<
    string,
    { kind: 'player' | 'spectator'; id: string }
  >();
  private readonly playerTokens = new Map<string, string>();
  private readonly spectatorTokens = new Map<string, string>();

  private readonly callbacks: HostSessionCallbacks;
  private destroyed = false;
  private idRetryCount = 0;
  private responseTimerId: ReturnType<typeof setTimeout> | null = null;
  private disconnectTurnTimerId: ReturnType<typeof setTimeout> | null = null;

  private readonly offline: boolean;
  private readonly autoStart: boolean;
  private readonly fixedRoomCode: string | null;
  private readonly disconnectGraceMs: number;

  /** 設定された CPU 数（ロビーで後から増やせるため可変） */
  private cpuCount: number;
  private readonly cpuDelayMs: number;
  private readonly cpuRandom: () => number;
  private readonly cpuScheduler: (fn: () => void, delayMs: number) => void;
  private cpuToken = 0;
  private cpuDeadlineMs: number | null = null;
  private postDiscardHoldActive = false;
  private postDiscardHoldToken = 0;
  private postDiscardHoldDeadlineMs: number | null = null;
  private disconnectTargetTurnCount: number | null = null;
  private disconnectDeadlineMs: number | null = null;
  private hostAway = false;
  private chatMessages: ChatMessage[] = [];
  private chatSeq = 0;
  private hostEpoch = 0;
  private checkpointSeq = 0;

  private pendingTakeover: PendingEncryptedTakeover | null = null;
  private pendingQueuedJoins: Array<{
    conn: DataConnection;
    message: Extract<ReturnType<typeof parseClientMessage>, { kind: 'JOIN' }>;
  }> = [];

  constructor(
    hostName: string,
    ruleConfig: RuleConfig,
    callbacks: HostSessionCallbacks,
    options: HostSessionOptions = {},
  ) {
    this.callbacks = callbacks;
    this.offline = options.offline ?? false;
    this.autoStart = options.autoStart ?? false;
    this.fixedRoomCode = options.fixedRoomCode
      ? normalizeRoomCode(options.fixedRoomCode)
      : null;
    this.disconnectGraceMs = options.disconnectGraceMs ?? 15000;
    this.cpuCount = options.cpuCount ?? 0;
    this.cpuDelayMs = options.cpuDelayMs ?? 700;
    this.cpuRandom = options.cpuRandom ?? (() => Math.random());
    this.cpuScheduler =
      options.cpuScheduler ??
      ((fn, delay) => {
        setTimeout(fn, delay);
      });

    if (options.initialSnapshot) {
      const snap = options.initialSnapshot;
      this.state = snap.state;
      this.chatMessages = [...snap.chatMessages];
      this.chatSeq = snap.chatSeq;
      this.hostEpoch = snap.hostEpoch;
      for (const [pid, tok] of Object.entries(snap.playerTokens)) {
        this.playerTokens.set(pid, tok);
      }
      for (const [sid, tok] of Object.entries(snap.spectatorTokens)) {
        this.spectatorTokens.set(sid, tok);
      }
      this.cpuCount = this.state.players.filter((p) =>
        isCpuPlayerId(p.playerId),
      ).length;
      // 引き継ぎ元の古い接続状態は一旦オンラインとオフラインを整理する
      this.state = {
        ...this.state,
        players: this.state.players.map((p) =>
          p.playerId === this.state.hostPlayerId || isCpuPlayerId(p.playerId)
            ? { ...p, connected: true }
            : p,
        ),
      };
      return;
    }

    if (options.pendingTakeover) {
      const t = options.pendingTakeover;
      this.hostEpoch = t.hostEpoch;
      this.pendingTakeover = t;
      this.state = createInitialGameState({
        roomCode: t.fallbackView.roomCode,
        hostPlayerId: t.localPlayerId,
        hostName,
        ruleConfig: t.fallbackView.ruleConfig,
      });
      this.playerTokens.set(t.localPlayerId, t.localReconnectToken);
      return;
    }

    const roomCode = this.fixedRoomCode ?? generateRoomCode();
    const hostPeerId = roomCodeToPeerId(roomCode);
    this.state = createInitialGameState({
      roomCode,
      hostPlayerId: hostPeerId,
      hostName,
      ruleConfig,
    });
    this.playerTokens.set(hostPeerId, generateReconnectToken());
  }

  getRoomCode(): string {
    return this.offline ? 'LOCAL' : this.state.roomCode;
  }

  getHostEpoch(): number {
    return this.hostEpoch;
  }

  getCurrentHostPeerId(): string {
    return migratedHostPeerId(this.state.roomCode, this.hostEpoch);
  }

  getHostReconnectToken(): string | undefined {
    return this.playerTokens.get(this.state.hostPlayerId);
  }

  /** ローカル対局（CPU戦）かどうか */
  isOffline(): boolean {
    return this.offline;
  }

  /** 他のオンライン人間プレイヤーへホストを譲れるか */
  getConnectedRemoteHumanIds(): string[] {
    return this.state.players
      .filter(
        (p) =>
          p.playerId !== this.state.hostPlayerId &&
          !isCpuPlayerId(p.playerId) &&
          p.connected &&
          Boolean(this.participantConns.get(p.playerId)?.open),
      )
      .sort((a, b) => a.seatIndex - b.seatIndex)
      .map((p) => p.playerId);
  }

  start(): void {
    if (this.destroyed) return;
    if (this.offline) {
      this.callbacks.onStatusChange('ready', 'ローカル対局（CPU戦）');
      this.bootstrapCpuSeats();
      if (this.cpuCount <= 0) {
        this.emitHostView();
      }
      return;
    }
    this.callbacks.onStatusChange('initializing', 'PeerJS サーバーに接続中...');
    this.openPeerWithCurrentRoomCode();

    if (this.pendingTakeover) {
      if (this.pendingTakeover.initialKeyBase64) {
        const key = this.pendingTakeover.initialKeyBase64;
        if (this.resolvePendingTakeoverWithKey(key)) {
          return;
        }
      }
      // 鍵待ち状態でも画面を出しつつ他参加者の再接続を受ける
      this.callbacks.onViewChange(this.pendingTakeover.fallbackView);
      return;
    }

    if (this.hostEpoch > 0) {
      // 引き継ぎ直後のホスト開始: スナップショットがあれば即座にタイマーと状態同期を再開
      this.syncResponseTimer();
      this.syncDisconnectTurnTimer();
      this.scheduleCpuTick();
      this.startRedirectBeacon();
      return;
    }

    this.bootstrapCpuSeats();
    if (this.cpuCount <= 0) {
      this.emitHostView();
    }
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
      this.commitState(this.autoStart ? this.tryStartGame(next) : next);
    }
  }

  /**
   * ロビーに CPU を 1 体追加する（ホストのみ・開局後は不可）。
   * 既定では自動開局せず、ホストが開始ボタンを押したタイミングで開局する。
   */
  addCpu(): boolean {
    if (this.destroyed || this.state.phase !== 'lobby') return false;
    const rules = deriveRules(this.state.ruleConfig);
    if (this.state.players.length >= rules.playerCount) return false;

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
    this.commitState(
      this.autoStart ? this.tryStartGame(result.state) : result.state,
    );
    return true;
  }

  /** ロビーから CPU を 1 体減らす（最後に追加された CPU を抜く） */
  removeCpu(): boolean {
    if (this.destroyed || this.state.phase !== 'lobby') return false;
    const cpuPlayers = this.state.players.filter((p) =>
      isCpuPlayerId(p.playerId),
    );
    if (cpuPlayers.length === 0) return false;
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

  /** ロビー中にホストがルール設定を変更し、全参加者へ反映する */
  updateRuleConfig(patch: Partial<RuleConfig>): boolean {
    if (this.destroyed || this.state.phase !== 'lobby') return false;
    const result = applyAction(this.state, {
      type: 'UPDATE_RULE_CONFIG',
      playerId: this.state.hostPlayerId,
      patch,
    });
    if (result.error) {
      this.callbacks.onError(result.error);
      return false;
    }
    this.commitState(result.state);
    return true;
  }

  /** 人数が揃っているロビーからホストが明示的に対局を開始する */
  startGame(): boolean {
    if (this.destroyed || this.state.phase !== 'lobby') return false;
    const started = this.tryStartGame(this.state);
    if (started === this.state) return false;
    this.commitState(started);
    return true;
  }

  /** 終局後に同じ部屋・メンバーでロビーへ戻る（常設ルーム等の連戦用） */
  resetToLobby(): boolean {
    if (this.destroyed || this.state.phase !== 'finished') return false;
    const result = applyAction(this.state, {
      type: 'RESET_TO_LOBBY',
      playerId: this.state.hostPlayerId,
    });
    if (result.error) {
      this.callbacks.onError(result.error);
      return false;
    }
    const keptIds = new Set(result.state.players.map((p) => p.playerId));
    for (const pid of [...this.playerTokens.keys()]) {
      if (!keptIds.has(pid)) {
        this.playerTokens.delete(pid);
      }
    }
    const keptSpecIds = new Set(
      (result.state.spectators ?? []).map((s) => s.spectatorId),
    );
    for (const sid of [...this.spectatorTokens.keys()]) {
      if (!keptSpecIds.has(sid)) {
        this.spectatorTokens.delete(sid);
      }
    }
    this.commitState(result.state);
    return true;
  }

  /**
   * 他のオンライン参加者にホスト権限を委譲する。
   * - `stayAsClient: false`（既定）: 部屋を抜けて他の人へ譲る（ロビーなら席を空け、対局中なら切断状態にする）
   * - `stayAsClient: true`: 自分は参加者として残り、相手を新ホストにする
   */
  transferHost(
    targetPlayerId?: string,
    options: { stayAsClient?: boolean; destroyDelayMs?: number } = {},
  ): boolean {
    if (this.destroyed || this.offline || this.pendingTakeover) return false;
    const candidates = this.getConnectedRemoteHumanIds();
    const chosenId =
      targetPlayerId && candidates.includes(targetPlayerId)
        ? targetPlayerId
        : candidates[0];
    if (!chosenId) return false;

    const targetConn = this.participantConns.get(chosenId);
    if (!targetConn || !targetConn.open) return false;

    const oldHostId = this.state.hostPlayerId;
    const stayAsClient = options.stayAsClient ?? false;
    let nextState = this.state;

    const transferRes = applyAction(nextState, {
      type: 'TRANSFER_HOST',
      newHostPlayerId: chosenId,
    });
    if (transferRes.error) return false;
    nextState = transferRes.state;

    const nextTokens = new Map(this.playerTokens);
    const oldHostToken = nextTokens.get(oldHostId) ?? generateReconnectToken();
    nextTokens.set(oldHostId, oldHostToken);

    if (!stayAsClient) {
      if (nextState.phase === 'lobby') {
        const leaveRes = applyAction(nextState, {
          type: 'LEAVE_LOBBY',
          playerId: oldHostId,
        });
        if (!leaveRes.error) {
          nextState = leaveRes.state;
          nextTokens.delete(oldHostId);
        }
      } else {
        const dcRes = applyAction(nextState, {
          type: 'SET_PLAYER_CONNECTED',
          playerId: oldHostId,
          connected: false,
        });
        if (!dcRes.error) {
          nextState = dcRes.state;
        }
      }
    }

    const nextEpoch = this.hostEpoch + 1;
    const newHostPeerId = migratedHostPeerId(this.state.roomCode, nextEpoch);
    const snapshot: HostSnapshotPayload = {
      state: nextState,
      chatMessages: [...this.chatMessages],
      chatSeq: this.chatSeq,
      playerTokens: Object.fromEntries(nextTokens),
      spectatorTokens: Object.fromEntries(this.spectatorTokens),
      hostEpoch: nextEpoch,
      permanentRoom: isPermanentRoomCode(this.state.roomCode),
    };

    const migratingPayload: HostMigratingPayload = {
      roomCode: this.state.roomCode,
      newHostPlayerId: chosenId,
      newHostPeerId,
      hostEpoch: nextEpoch,
    };

    // 他の参加者・観戦者へ先に移行先を通知する
    for (const [pid, conn] of this.participantConns.entries()) {
      if (pid === chosenId || !conn.open) continue;
      this.sendToConn(conn, {
        kind: 'HOST_MIGRATING',
        payload: migratingPayload,
      });
    }

    // 引き継ぎ先にはフルスナップショットを送る
    this.sendToConn(targetConn, {
      kind: 'HOST_HANDOVER',
      payload: snapshot,
    });

    if (stayAsClient) {
      this.callbacks.onHostSelfDemoted?.(
        migratingPayload,
        oldHostToken,
        oldHostId,
      );
    }

    // PeerJS 送信バッファが流れる猶予を少し置いて旧ホストを閉じる
    const destroyDelay = options.destroyDelayMs ?? 120;
    if (destroyDelay <= 0) {
      this.destroy();
    } else {
      this.destroyed = true;
      this.cpuToken++;
      this.clearResponseTimer();
      this.clearDisconnectTurnTimer();
      setTimeout(() => {
        for (const conn of this.participantConns.values()) {
          conn.close();
        }
        this.participantConns.clear();
        this.peerToParticipant.clear();
        if (this.beaconPeer && !this.beaconPeer.destroyed) {
          this.beaconPeer.destroy();
        }
        this.beaconPeer = null;
        if (this.peer && !this.peer.destroyed) {
          this.peer.destroy();
        }
        this.peer = null;
        this.callbacks.onStatusChange('closed');
      }, destroyDelay);
    }

    return true;
  }

  /** ホストからチャットメッセージを送信し全参加者へ配信する */
  sendChat(text: string): boolean {
    if (this.destroyed) return false;
    return this.publishChat(this.state.hostPlayerId, text);
  }

  private publishChat(senderId: string, rawText: string): boolean {
    const trimmed = rawText.trim().slice(0, 200);
    if (!trimmed) return false;
    const playerSender = this.state.players.find(
      (p) => p.playerId === senderId,
    );
    const spectatorSender = (this.state.spectators ?? []).find(
      (s) => s.spectatorId === senderId,
    );
    const senderName = playerSender?.name ?? spectatorSender?.name;
    if (!senderName) return false;
    const chatMessage: ChatMessage = {
      id: `chat-${++this.chatSeq}`,
      senderId,
      senderName,
      text: trimmed,
      timestamp: Date.now(),
    };
    this.chatMessages = [...this.chatMessages.slice(-49), chatMessage];
    this.callbacks.onChatMessage?.(chatMessage);
    for (const [pid, conn] of this.participantConns.entries()) {
      if (pid === this.state.hostPlayerId) continue;
      if (conn.open) {
        this.sendToConn(conn, {
          kind: 'CHAT_MESSAGE',
          payload: chatMessage,
        });
      }
    }
    return true;
  }

  /** ロビーで人数が揃っていれば開局状態を生成する */
  private tryStartGame(nextState: GameState): GameState {
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
    return isCpuPlayerId(playerId);
  }

  private remapHostPlayerId(prevId: string, nextId: string): void {
    if (prevId === nextId) return;
    const prevToken = this.playerTokens.get(prevId);
    if (prevToken !== undefined) {
      this.playerTokens.delete(prevId);
      this.playerTokens.set(nextId, prevToken);
    }

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
    const peerId = this.getCurrentHostPeerId();
    const peer = new Peer(peerId, PEER_OPTIONS);
    this.peer = peer;

    let opened = false;

    peer.on('open', (id) => {
      if (this.destroyed) {
        peer.destroy();
        return;
      }
      opened = true;
      this.reconnectPeerAttempts = 0;
      if (this.hostEpoch === 0 && !this.fixedRoomCode) {
        this.remapHostPlayerId(this.state.hostPlayerId, id);
      }
      const hostPlayer = this.state.players.find(
        (p) => p.playerId === this.state.hostPlayerId,
      );
      const token =
        this.playerTokens.get(this.state.hostPlayerId) ??
        generateReconnectToken();
      this.playerTokens.set(this.state.hostPlayerId, token);

      this.callbacks.onWelcome?.({
        roomCode: this.state.roomCode,
        playerId: this.state.hostPlayerId,
        playerName: hostPlayer?.name ?? 'ホスト',
        reconnectToken: token,
        isSpectator: false,
        hostEpoch: this.hostEpoch,
        hostPeerId: id,
      });

      this.callbacks.onStatusChange(
        'ready',
        this.hostEpoch > 0 ? 'ホストを引き継ぎました' : '参加者待機中',
      );
      if (!this.pendingTakeover) {
        this.emitHostView();
      }
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
      if (!opened && err.type === 'unavailable-id') {
        if (this.hostEpoch === 0 && this.fixedRoomCode) {
          // 常設ルームで既に別ホストが開設していた場合はクライアント参加へ回す
          this.callbacks.onPermanentRoomClaimConflict?.(this.state.roomCode);
          this.destroy();
          return;
        }
        if (this.hostEpoch > 0 && this.idRetryCount < 5) {
          this.idRetryCount++;
          this.hostEpoch++;
          peer.destroy();
          this.openPeerWithCurrentRoomCode();
          return;
        }
        if (this.idRetryCount < 5) {
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
      }

      this.callbacks.onStatusChange(
        'error',
        `接続エラー (${err.type}): ${err.message}`,
      );
    });

    peer.on('disconnected', () => {
      if (this.destroyed || peer.destroyed) return;
      if (
        typeof peer.reconnect === 'function' &&
        this.reconnectPeerAttempts < 5
      ) {
        this.reconnectPeerAttempts++;
        const delay = Math.min(4000, 600 * this.reconnectPeerAttempts);
        this.callbacks.onStatusChange(
          'initializing',
          'シグナリングサーバーへ再接続中...',
        );
        this.reconnectPeerTimerId = setTimeout(() => {
          this.reconnectPeerTimerId = null;
          if (this.destroyed || peer.destroyed) return;
          try {
            peer.reconnect();
          } catch {
            // Peer error listener handles fatal failures
          }
        }, delay);
        return;
      }
      this.callbacks.onStatusChange(
        'error',
        'シグナリングサーバーから切断されました',
      );
    });
  }

  /**
   * ホスト引き継ぎ後（hostEpoch > 0）に元の部屋コード（例: arena-mj-BRONZE）が空いたら
   * リダイレクト用ビーコンとして確保し、後発入室・再接続を新ホストへ誘導する。
   */
  private startRedirectBeacon(): void {
    if (
      this.destroyed ||
      this.offline ||
      this.hostEpoch <= 0 ||
      this.beaconPeer
    ) {
      return;
    }
    const basePeerId = roomCodeToPeerId(this.state.roomCode);
    if (basePeerId === this.getCurrentHostPeerId()) return;

    let candidate: Peer;
    try {
      candidate = new Peer(basePeerId, PEER_OPTIONS);
    } catch {
      return;
    }
    if (typeof candidate.on !== 'function') {
      return;
    }

    let opened = false;
    this.beaconPeer = candidate;

    candidate.on('open', () => {
      if (this.destroyed) {
        candidate.destroy();
        return;
      }
      opened = true;
    });

    candidate.on('connection', (conn) => {
      if (this.destroyed) {
        conn.close();
        return;
      }
      const sendRedirect = () => {
        this.sendToConn(conn, {
          kind: 'HOST_REDIRECT',
          payload: {
            roomCode: this.state.roomCode,
            hostPeerId: this.getCurrentHostPeerId(),
            hostEpoch: this.hostEpoch,
          },
        });
        setTimeout(() => conn.close(), 200);
      };
      if (conn.open) {
        sendRedirect();
      } else {
        conn.on('open', sendRedirect);
      }
    });

    candidate.on('error', (err) => {
      if (this.destroyed) return;
      if (!opened && err.type === 'unavailable-id') {
        candidate.destroy();
        this.beaconPeer = null;
        if (this.beaconRetryCount < 12) {
          this.beaconRetryCount++;
          this.beaconRetryTimerId = setTimeout(() => {
            this.beaconRetryTimerId = null;
            this.startRedirectBeacon();
          }, 10000);
        }
      }
    });
  }

  private attachConnection(conn: DataConnection): void {
    const connPeerId = conn.peer;

    conn.on('data', (raw) => {
      if (this.destroyed) return;
      this.handleClientData(conn, raw);
    });

    conn.on('close', () => {
      if (this.destroyed) return;
      this.handlePeerDisconnect(connPeerId);
    });

    conn.on('error', (err) => {
      if (this.destroyed) return;
      this.callbacks.onError({
        code: 'INVALID_MESSAGE',
        message: `通信エラー (${connPeerId}): ${err.message}`,
      });
    });
  }

  private resolvePendingTakeoverWithKey(keyBase64: string): boolean {
    if (!this.pendingTakeover) return false;
    const t = this.pendingTakeover;
    const json = decryptCheckpoint(t.ivBase64, t.ciphertextBase64, keyBase64);
    if (!json) return false;

    let snap: HostSnapshotPayload;
    try {
      snap = JSON.parse(json) as HostSnapshotPayload;
    } catch {
      return false;
    }
    if (!snap || !snap.state || !Array.isArray(snap.state.players)) {
      return false;
    }

    const oldHostId = snap.state.hostPlayerId;
    let restoredState = snap.state;

    // 引き継ぎ後の新ホストとして自分を登録し、旧ホストは切断状態にする
    const transferRes = applyAction(restoredState, {
      type: 'TRANSFER_HOST',
      newHostPlayerId: t.localPlayerId,
    });
    if (transferRes.error) return false;
    restoredState = transferRes.state;

    if (oldHostId !== t.localPlayerId) {
      if (restoredState.phase === 'lobby') {
        const leaveRes = applyAction(restoredState, {
          type: 'LEAVE_LOBBY',
          playerId: oldHostId,
        });
        if (!leaveRes.error) {
          restoredState = leaveRes.state;
        }
      } else {
        const dcRes = applyAction(restoredState, {
          type: 'SET_PLAYER_CONNECTED',
          playerId: oldHostId,
          connected: false,
        });
        if (!dcRes.error) {
          restoredState = dcRes.state;
        }
      }
    }

    // 他リモートプレイヤーは再接続が来るまで一旦切断扱いとし、接続済みのものは繋ぎ直す
    restoredState = {
      ...restoredState,
      players: restoredState.players.map((p) => {
        if (p.playerId === t.localPlayerId || isCpuPlayerId(p.playerId)) {
          return { ...p, connected: true };
        }
        if (p.playerId === oldHostId) {
          return { ...p, connected: false };
        }
        const hasOpen = Boolean(this.participantConns.get(p.playerId)?.open);
        return { ...p, connected: hasOpen };
      }),
    };

    this.state = restoredState;
    this.chatMessages = [...snap.chatMessages];
    this.chatSeq = snap.chatSeq;
    this.playerTokens.clear();
    for (const [pid, tok] of Object.entries(snap.playerTokens)) {
      this.playerTokens.set(pid, tok);
    }
    this.playerTokens.set(t.localPlayerId, t.localReconnectToken);
    this.spectatorTokens.clear();
    for (const [sid, tok] of Object.entries(snap.spectatorTokens)) {
      this.spectatorTokens.set(sid, tok);
    }
    this.cpuCount = this.state.players.filter((p) =>
      isCpuPlayerId(p.playerId),
    ).length;

    this.pendingTakeover = null;
    const newHostPlayer = this.state.players.find(
      (p) => p.playerId === t.localPlayerId,
    );
    this.callbacks.onWelcome?.({
      roomCode: this.state.roomCode,
      playerId: t.localPlayerId,
      playerName: newHostPlayer?.name ?? 'ホスト',
      reconnectToken: t.localReconnectToken,
      isSpectator: false,
      hostEpoch: this.hostEpoch,
      hostPeerId: this.getCurrentHostPeerId(),
    });
    this.commitState(this.state);
    this.startRedirectBeacon();

    // 待機していた JOIN リクエストを順番に処理する
    const queued = [...this.pendingQueuedJoins];
    this.pendingQueuedJoins = [];
    for (const item of queued) {
      if (item.conn.open) {
        this.processJoinMessage(item.conn, item.message);
      }
    }
    return true;
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

    if (message.kind === 'PROBE_ROOM') {
      this.sendToConn(conn, {
        kind: 'ROOM_STATUS',
        payload: this.buildRoomStatusPayload(),
      });
      setTimeout(() => {
        if (!this.destroyed && conn.open) {
          conn.close();
        }
      }, 150);
      return;
    }

    if (message.kind === 'CHECKPOINT_KEY_SHARE') {
      if (this.pendingTakeover) {
        this.resolvePendingTakeoverWithKey(message.keyBase64);
      }
      return;
    }

    if (message.kind === 'JOIN') {
      if (this.pendingTakeover) {
        this.pendingQueuedJoins.push({ conn, message });
        return;
      }
      this.processJoinMessage(conn, message);
      return;
    }

    if (this.pendingTakeover) {
      return;
    }

    const mapped = this.peerToParticipant.get(conn.peer);
    const participantId = mapped?.id ?? conn.peer;

    if (message.kind === 'CHAT') {
      this.publishChat(participantId, message.text);
      return;
    }

    if (
      mapped?.kind === 'spectator' ||
      !this.state.players.some((p) => p.playerId === participantId)
    ) {
      this.sendToConn(conn, {
        kind: 'ERROR',
        payload: {
          code: 'UNAUTHORIZED_ACTION',
          message: '観戦中は対局操作を行えません。',
        },
      });
      return;
    }

    const rules = deriveRules(this.state.ruleConfig);
    let engineAction: Action;
    switch (message.action.type) {
      case 'DISCARD_TILE':
        engineAction = {
          type: 'DISCARD_TILE',
          playerId: participantId,
          tileId: message.action.tileId,
          now: Date.now(),
        };
        break;
      case 'CALL_RESPONSE':
        engineAction = {
          type: 'CALL_RESPONSE',
          playerId: participantId,
          choice: message.action.choice,
        };
        break;
      case 'DECLARE_TSUMO':
        engineAction = {
          type: 'DECLARE_TSUMO',
          playerId: participantId,
        };
        break;
      case 'DECLARE_RIICHI':
        engineAction = {
          type: 'DECLARE_RIICHI',
          playerId: participantId,
          tileId: message.action.tileId,
          now: Date.now(),
        };
        break;
      case 'DECLARE_ANKAN':
        engineAction = {
          type: 'DECLARE_ANKAN',
          playerId: participantId,
          kind: message.action.kind,
          now: Date.now(),
        };
        break;
      case 'DECLARE_KAKAN':
        engineAction = {
          type: 'DECLARE_KAKAN',
          playerId: participantId,
          tileId: message.action.tileId,
          now: Date.now(),
        };
        break;
      case 'DECLARE_KITA':
        engineAction = {
          type: 'DECLARE_KITA',
          playerId: participantId,
          tileId: message.action.tileId,
        };
        break;
      case 'DECLARE_KYUUSHU_KYUUHAI':
        engineAction = {
          type: 'DECLARE_KYUUSHU_KYUUHAI',
          playerId: participantId,
        };
        break;
      case 'ADVANCE_ROUND':
        engineAction = {
          type: 'ADVANCE_ROUND',
          playerId: participantId,
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

    this.commitState(result.state, {
      fromDiscard:
        engineAction.type === 'DISCARD_TILE' ||
        engineAction.type === 'DECLARE_RIICHI',
    });
  }

  private bindParticipantConn(
    kind: 'player' | 'spectator',
    participantId: string,
    conn: DataConnection,
  ): void {
    const prevConn = this.participantConns.get(participantId);
    if (prevConn && prevConn !== conn) {
      this.peerToParticipant.delete(prevConn.peer);
      if (prevConn.open) {
        prevConn.close();
      }
    }
    this.participantConns.set(participantId, conn);
    this.peerToParticipant.set(conn.peer, { kind, id: participantId });
    if (this.hostAway) {
      this.sendToConn(conn, {
        kind: 'HOST_STATUS',
        payload: { away: true },
      });
    }
  }

  private processJoinMessage(
    conn: DataConnection,
    message: Extract<ReturnType<typeof parseClientMessage>, { kind: 'JOIN' }>,
  ): void {
    const token = message.reconnectToken;

    // 1. トークンによるプレイヤー再接続
    if (token) {
      for (const [pid, savedToken] of this.playerTokens.entries()) {
        if (savedToken !== token) continue;
        const player = this.state.players.find((p) => p.playerId === pid);
        if (!player) continue;

        if (pid === this.state.hostPlayerId) {
          // 既にホストになっている本人がクライアント再接続することは通常ないが念のため拒否せず扱う
          break;
        }

        this.bindParticipantConn('player', pid, conn);
        this.sendToConn(conn, {
          kind: 'SESSION_WELCOME',
          payload: {
            roomCode: this.state.roomCode,
            playerId: pid,
            playerName: player.name,
            reconnectToken: savedToken,
            isSpectator: false,
            hostEpoch: this.hostEpoch,
            hostPeerId: this.getCurrentHostPeerId(),
          },
        });

        if (!player.connected) {
          const res = applyAction(this.state, {
            type: 'SET_PLAYER_CONNECTED',
            playerId: pid,
            connected: true,
          });
          if (!res.error) {
            this.commitState(res.state);
          }
        } else {
          this.sendToConn(conn, {
            kind: 'STATE_VIEW',
            payload: toStateView(this.state, pid, Date.now(), {
              hostEpoch: this.hostEpoch,
            }),
          });
          this.broadcastCheckpoint();
        }
        if (this.chatMessages.length > 0) {
          this.sendToConn(conn, {
            kind: 'CHAT_HISTORY',
            payload: this.chatMessages,
          });
        }
        return;
      }

      // 2. トークンによる観戦者再接続
      for (const [sid, savedToken] of this.spectatorTokens.entries()) {
        if (savedToken !== token) continue;
        const spectator = (this.state.spectators ?? []).find(
          (s) => s.spectatorId === sid,
        );
        if (!spectator) continue;

        this.bindParticipantConn('spectator', sid, conn);
        this.sendToConn(conn, {
          kind: 'SESSION_WELCOME',
          payload: {
            roomCode: this.state.roomCode,
            playerId: sid,
            playerName: spectator.name,
            reconnectToken: savedToken,
            isSpectator: true,
            hostEpoch: this.hostEpoch,
            hostPeerId: this.getCurrentHostPeerId(),
          },
        });
        if (!spectator.connected) {
          const res = applyAction(this.state, {
            type: 'SET_SPECTATOR_CONNECTED',
            spectatorId: sid,
            connected: true,
          });
          if (!res.error) {
            this.commitState(res.state);
          }
        } else {
          this.sendToConn(conn, {
            kind: 'STATE_VIEW',
            payload: toStateView(this.state, sid, Date.now(), {
              hostEpoch: this.hostEpoch,
            }),
          });
        }
        if (this.chatMessages.length > 0) {
          this.sendToConn(conn, {
            kind: 'CHAT_HISTORY',
            payload: this.chatMessages,
          });
        }
        return;
      }
    }

    // 同一 PeerID による切断直後の再接続（テストや一時断救済）
    const existingByPeer = this.state.players.find(
      (p) => p.playerId === conn.peer && !p.connected,
    );
    if (existingByPeer) {
      const existingToken =
        this.playerTokens.get(existingByPeer.playerId) ??
        generateReconnectToken();
      this.playerTokens.set(existingByPeer.playerId, existingToken);
      this.bindParticipantConn('player', existingByPeer.playerId, conn);
      this.sendToConn(conn, {
        kind: 'SESSION_WELCOME',
        payload: {
          roomCode: this.state.roomCode,
          playerId: existingByPeer.playerId,
          playerName: existingByPeer.name,
          reconnectToken: existingToken,
          isSpectator: false,
          hostEpoch: this.hostEpoch,
          hostPeerId: this.getCurrentHostPeerId(),
        },
      });
      const res = applyAction(this.state, {
        type: 'SET_PLAYER_CONNECTED',
        playerId: existingByPeer.playerId,
        connected: true,
      });
      if (!res.error) {
        this.commitState(res.state);
      }
      if (this.chatMessages.length > 0) {
        this.sendToConn(conn, {
          kind: 'CHAT_HISTORY',
          payload: this.chatMessages,
        });
      }
      return;
    }

    const rules = deriveRules(this.state.ruleConfig);
    const idUsed =
      this.state.players.some((p) => p.playerId === conn.peer) ||
      (this.state.spectators ?? []).some((s) => s.spectatorId === conn.peer);
    const participantId = idUsed
      ? `p-${generateReconnectToken().slice(0, 10)}`
      : conn.peer;

    const canJoinAsPlayer =
      this.state.phase === 'lobby' &&
      !message.preferSpectate &&
      this.state.players.length < rules.playerCount;

    if (canJoinAsPlayer) {
      const joinResult = applyAction(this.state, {
        type: 'JOIN_PLAYER',
        playerId: participantId,
        name: message.playerName,
      });

      if (joinResult.error) {
        this.sendToConn(conn, {
          kind: 'ERROR',
          payload: joinResult.error,
        });
        return;
      }

      const issuedToken = generateReconnectToken();
      this.playerTokens.set(participantId, issuedToken);
      this.bindParticipantConn('player', participantId, conn);

      const joinedPlayer = joinResult.state.players.find(
        (p) => p.playerId === participantId,
      )!;
      this.sendToConn(conn, {
        kind: 'SESSION_WELCOME',
        payload: {
          roomCode: this.state.roomCode,
          playerId: participantId,
          playerName: joinedPlayer.name,
          reconnectToken: issuedToken,
          isSpectator: false,
          hostEpoch: this.hostEpoch,
          hostPeerId: this.getCurrentHostPeerId(),
        },
      });

      this.commitState(
        this.autoStart
          ? this.tryStartGame(joinResult.state)
          : joinResult.state,
      );
      if (this.chatMessages.length > 0) {
        this.sendToConn(conn, {
          kind: 'CHAT_HISTORY',
          payload: this.chatMessages,
        });
      }
      return;
    }

    // 対局途中・満席時は観戦者として入室させる
    const specResult = applyAction(this.state, {
      type: 'JOIN_SPECTATOR',
      spectatorId: participantId,
      name: message.playerName,
    });
    if (specResult.error) {
      this.sendToConn(conn, {
        kind: 'ERROR',
        payload: specResult.error,
      });
      return;
    }

    const issuedSpecToken = generateReconnectToken();
    this.spectatorTokens.set(participantId, issuedSpecToken);
    this.bindParticipantConn('spectator', participantId, conn);

    const joinedSpec = (specResult.state.spectators ?? []).find(
      (s) => s.spectatorId === participantId,
    )!;
    this.sendToConn(conn, {
      kind: 'SESSION_WELCOME',
      payload: {
        roomCode: this.state.roomCode,
        playerId: participantId,
        playerName: joinedSpec.name,
        reconnectToken: issuedSpecToken,
        isSpectator: true,
        hostEpoch: this.hostEpoch,
        hostPeerId: this.getCurrentHostPeerId(),
      },
    });

    this.commitState(specResult.state);
    if (this.chatMessages.length > 0) {
      this.sendToConn(conn, {
        kind: 'CHAT_HISTORY',
        payload: this.chatMessages,
      });
    }
  }

  private handlePeerDisconnect(connPeerId: string): void {
    const entry = this.peerToParticipant.get(connPeerId);
    this.peerToParticipant.delete(connPeerId);
    const participantId = entry?.id ?? connPeerId;

    const currentConn = this.participantConns.get(participantId);
    if (currentConn && currentConn.peer !== connPeerId) {
      // 既に新しい接続へ差し替わっている古いソケットの close は無視する
      return;
    }
    this.participantConns.delete(participantId);

    if (
      entry?.kind === 'spectator' ||
      (this.state.spectators ?? []).some((s) => s.spectatorId === participantId)
    ) {
      const action: Action =
        this.state.phase === 'lobby'
          ? { type: 'LEAVE_SPECTATOR', spectatorId: participantId }
          : {
              type: 'SET_SPECTATOR_CONNECTED',
              spectatorId: participantId,
              connected: false,
            };
      if (this.state.phase === 'lobby') {
        this.spectatorTokens.delete(participantId);
      }
      const res = applyAction(this.state, action);
      if (!res.error) {
        this.commitState(res.state);
      }
      return;
    }

    const exists = this.state.players.some((p) => p.playerId === participantId);
    if (!exists) return;

    if (this.state.phase === 'lobby') {
      this.playerTokens.delete(participantId);
    }

    const action: Action =
      this.state.phase === 'lobby'
        ? { type: 'LEAVE_LOBBY', playerId: participantId }
        : { type: 'SET_PLAYER_CONNECTED', playerId: participantId, connected: false };

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
    this.commitState(result.state, {
      fromDiscard:
        action.type === 'DISCARD_TILE' || action.type === 'DECLARE_RIICHI',
    });
  }

  setHostAway(away: boolean): void {
    if (this.destroyed) return;
    this.hostAway = away;
    for (const conn of this.participantConns.values()) {
      this.sendToConn(conn, {
        kind: 'HOST_STATUS',
        payload: { away },
      });
    }
    if (!away) {
      this.resumeAfterVisibilityRestore();
    }
  }

  private resumeAfterVisibilityRestore(): void {
    if (this.destroyed || this.pendingTakeover) return;
    this.syncResponseTimer();
    this.syncDisconnectTurnTimer(true);

    if (this.postDiscardHoldActive && this.postDiscardHoldDeadlineMs !== null) {
      const remaining = Math.max(0, this.postDiscardHoldDeadlineMs - Date.now());
      const token = ++this.postDiscardHoldToken;
      this.cpuScheduler(() => {
        this.finishPostDiscardHold(token);
      }, remaining);
      return;
    }

    if (this.hasAnyCpu() && this.needsCpuProgress()) {
      const remaining =
        this.cpuDeadlineMs !== null
          ? Math.max(0, this.cpuDeadlineMs - Date.now())
          : this.sampleCpuDelayMs();
      this.scheduleCpuTickWithDelay(remaining);
    }
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

  private commitState(
    nextState: GameState,
    options: { fromDiscard?: boolean } = {},
  ): void {
    this.state = nextState;
    this.postDiscardHoldToken++;
    this.postDiscardHoldActive = false;
    this.postDiscardHoldDeadlineMs = null;
    this.cpuDeadlineMs = null;

    if (
      options.fromDiscard &&
      nextState.phase === 'playing' &&
      this.cpuDelayMs > 0 &&
      this.hasAnyCpu()
    ) {
      const holdDelayMs = this.sampleCpuDelayMs();
      const token = ++this.postDiscardHoldToken;
      this.postDiscardHoldActive = true;
      this.postDiscardHoldDeadlineMs = Date.now() + holdDelayMs;
      this.syncResponseTimer();
      this.clearDisconnectTurnTimer();
      this.broadcastViews();
      this.broadcastCheckpoint();
      this.cpuScheduler(() => {
        this.finishPostDiscardHold(token);
      }, holdDelayMs);
      return;
    }

    this.syncResponseTimer();
    this.syncDisconnectTurnTimer();
    this.broadcastViews();
    this.broadcastCheckpoint();
    this.scheduleCpuTick();
  }

  private finishPostDiscardHold(token: number): void {
    if (
      this.destroyed ||
      !this.postDiscardHoldActive ||
      token !== this.postDiscardHoldToken
    ) {
      return;
    }
    this.postDiscardHoldActive = false;
    this.postDiscardHoldDeadlineMs = null;
    this.syncDisconnectTurnTimer();
    this.broadcastViews();
    this.scheduleCpuTick();
  }

  private hasAnyCpu(): boolean {
    return (
      this.cpuCount > 0 ||
      this.state.players.some((p) => this.isCpuPlayer(p.playerId))
    );
  }

  private sampleCpuDelayMs(): number {
    if (this.cpuDelayMs <= 0) return 0;
    const min = Math.round(this.cpuDelayMs * 0.45);
    const max = Math.round(this.cpuDelayMs * 0.85);
    const r = Math.min(0.999999, Math.max(0, this.cpuRandom()));
    return Math.round(min + (max - min) * r);
  }

  private needsCpuProgress(): boolean {
    const phase = this.state.phase;
    if (phase === 'finished') return false;
    if (phase === 'lobby') {
      return this.missingCpuIds().length > 0;
    }
    if (phase === 'awaiting_responses') {
      const pending = this.state.round?.pendingResponse;
      if (!pending) return false;
      return Object.keys(pending.optionsByPlayerId).some(
        (pid) => !(pid in pending.responses) && this.isCpuPlayer(pid),
      );
    }
    if (phase === 'playing') {
      const current = this.state.players.find(
        (p) => p.seatIndex === this.state.round?.currentTurnIndex,
      );
      return Boolean(
        current &&
          this.isCpuPlayer(current.playerId) &&
          !this.state.round?.pendingResponse,
      );
    }
    return false;
  }

  /** CPU の手番・応答待ちが残っていれば次の一手を予約する */
  private scheduleCpuTick(): void {
    if (
      this.destroyed ||
      this.pendingTakeover ||
      this.postDiscardHoldActive ||
      !this.hasAnyCpu()
    ) {
      return;
    }
    const phase = this.state.phase;
    if (phase === 'finished') return;
    if (phase === 'lobby' && this.missingCpuIds().length === 0) return;
    if (!this.needsCpuProgress()) return;

    const delayMs = this.sampleCpuDelayMs();
    this.scheduleCpuTickWithDelay(delayMs);
  }

  private scheduleCpuTickWithDelay(delayMs: number): void {
    const token = ++this.cpuToken;
    this.cpuDeadlineMs = Date.now() + delayMs;
    this.cpuScheduler(() => {
      if (this.destroyed || token !== this.cpuToken) return;
      this.cpuDeadlineMs = null;
      this.runCpuStepOnce();
    }, delayMs);
  }

  /**
   * CPU の操作を 1 手だけ適用する（適用したら true）。
   * タイマー経由の自動進行のほか、テストから決定的に駆動する場合にも使う。
   */
  runCpuStepOnce(): boolean {
    if (this.destroyed || this.pendingTakeover || !this.hasAnyCpu()) {
      return false;
    }
    const phase = this.state.phase;

    if (phase === 'lobby') {
      const missing = this.missingCpuIds();
      if (missing.length === 0) {
        if (!this.autoStart) return false;
        const started = this.tryStartGame(this.state);
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
      this.commitState(
        this.autoStart ? this.tryStartGame(result.state) : result.state,
      );
      return true;
    }

    if (phase === 'awaiting_responses') {
      const rules = deriveRules(this.state.ruleConfig);
      let curState = this.state;
      let progressed = false;
      while (curState.phase === 'awaiting_responses') {
        const pending = curState.round?.pendingResponse;
        if (!pending) break;
        const nextCpuPid = Object.keys(pending.optionsByPlayerId).find(
          (pid) => !(pid in pending.responses) && this.isCpuPlayer(pid),
        );
        if (!nextCpuPid) break;
        const view = toStateView(curState, nextCpuPid, Date.now());
        if (!view.myCallOptions) break;
        const decision =
          decideCpuAction(view) ?? {
            type: 'CALL_RESPONSE' as const,
            choice: { type: 'pass' as const },
          };
        const engineAction = toEngineAction(nextCpuPid, decision, {
          now: Date.now(),
          shuffledDeck: shuffleWithCrypto(buildTileDeck(rules)),
        });
        if (!engineAction) break;
        let res = applyAction(curState, engineAction);
        if (res.error) {
          res = applyAction(curState, {
            type: 'CALL_RESPONSE',
            playerId: nextCpuPid,
            choice: { type: 'pass' },
          });
        }
        if (res.error) break;
        curState = res.state;
        progressed = true;
      }
      if (!progressed) return false;
      this.commitState(curState);
      return true;
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
    const isDiscard =
      engineAction.type === 'DISCARD_TILE' ||
      engineAction.type === 'DECLARE_RIICHI';
    const result = applyAction(this.state, engineAction);
    if (result.error) {
      if (decision.type !== 'DISCARD_TILE') {
        const view = toStateView(this.state, playerId, Date.now());
        if (view.myDrawnTile) {
          const fallback = applyAction(this.state, {
            type: 'DISCARD_TILE',
            playerId,
            tileId: view.myDrawnTile.id,
            now: Date.now(),
          });
          if (!fallback.error) {
            this.commitState(fallback.state, { fromDiscard: true });
            return true;
          }
        }
      }
      return false;
    }
    this.commitState(result.state, { fromDiscard: isDiscard });
    return true;
  }

  private missingCpuIds(): string[] {
    const rules = deriveRules(this.state.ruleConfig);
    const existing = this.state.players.filter((p) =>
      isCpuPlayerId(p.playerId),
    ).length;
    const missing: string[] = [];
    for (let i = 0; i < this.cpuCount - existing; i++) {
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
      return missing.slice(
        0,
        Math.max(0, rules.playerCount - this.state.players.length),
      );
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
      this.pendingTakeover ||
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

  private clearDisconnectTurnTimer(): void {
    if (this.disconnectTurnTimerId !== null) {
      clearTimeout(this.disconnectTurnTimerId);
      this.disconnectTurnTimerId = null;
    }
  }

  /** 切断中の人間プレイヤーの手番が止まらないよう猶予後にツモ切り代打ちする */
  private syncDisconnectTurnTimer(preserveDeadline = false): void {
    this.clearDisconnectTurnTimer();
    if (
      this.destroyed ||
      this.offline ||
      this.pendingTakeover ||
      this.postDiscardHoldActive ||
      this.disconnectGraceMs < 0 ||
      this.state.phase !== 'playing' ||
      !this.state.round
    ) {
      if (!this.postDiscardHoldActive) {
        this.disconnectTargetTurnCount = null;
        this.disconnectDeadlineMs = null;
      }
      return;
    }

    const round = this.state.round;
    const currentPlayer = this.state.players.find(
      (p) => p.seatIndex === round.currentTurnIndex,
    );
    if (
      !currentPlayer ||
      this.isCpuPlayer(currentPlayer.playerId) ||
      currentPlayer.connected ||
      currentPlayer.playerId === this.state.hostPlayerId
    ) {
      this.disconnectTargetTurnCount = null;
      this.disconnectDeadlineMs = null;
      return;
    }

    const scheduledTurnCount = round.turnCount;
    const targetPlayerId = currentPlayer.playerId;
    if (
      !preserveDeadline ||
      this.disconnectTargetTurnCount !== scheduledTurnCount ||
      this.disconnectDeadlineMs === null
    ) {
      this.disconnectTargetTurnCount = scheduledTurnCount;
      this.disconnectDeadlineMs = Date.now() + this.disconnectGraceMs;
    }
    const delayMs = Math.max(0, this.disconnectDeadlineMs - Date.now());

    this.disconnectTurnTimerId = setTimeout(() => {
      this.disconnectTurnTimerId = null;
      this.disconnectTargetTurnCount = null;
      this.disconnectDeadlineMs = null;
      if (this.destroyed || this.state.phase !== 'playing' || !this.state.round) {
        return;
      }
      if (this.state.round.turnCount !== scheduledTurnCount) return;
      const latestPlayer = this.state.players.find(
        (p) => p.playerId === targetPlayerId,
      );
      if (!latestPlayer || latestPlayer.connected) return;

      const forbidden = new Set(this.state.round.kuikaeForbiddenKinds);
      const candidates = [
        ...(latestPlayer.drawnTile ? [latestPlayer.drawnTile] : []),
        ...latestPlayer.hand,
      ];
      const discardTile =
        candidates.find((t) => !forbidden.has(t.kind)) ?? candidates[0];
      if (!discardTile) return;

      const res = applyAction(this.state, {
        type: 'DISCARD_TILE',
        playerId: targetPlayerId,
        tileId: discardTile.id,
        now: Date.now(),
      });
      if (!res.error) {
        this.commitState(res.state, { fromDiscard: true });
      }
    }, delayMs);
  }

  private broadcastCheckpoint(): void {
    if (this.destroyed || this.offline || this.pendingTakeover) return;

    const remoteHumans = this.state.players
      .filter(
        (p) =>
          p.playerId !== this.state.hostPlayerId &&
          !this.isCpuPlayer(p.playerId) &&
          p.connected &&
          Boolean(this.participantConns.get(p.playerId)?.open),
      )
      .sort((a, b) => a.seatIndex - b.seatIndex);

    if (remoteHumans.length === 0) return;

    const backup = remoteHumans[0]!;
    const backupConn = this.participantConns.get(backup.playerId);
    if (!backupConn || !backupConn.open) return;

    const seq = ++this.checkpointSeq;
    const snapshot: HostSnapshotPayload = {
      state: this.state,
      chatMessages: [...this.chatMessages],
      chatSeq: this.chatSeq,
      playerTokens: Object.fromEntries(this.playerTokens),
      spectatorTokens: Object.fromEntries(this.spectatorTokens),
      hostEpoch: this.hostEpoch,
      permanentRoom: isPermanentRoomCode(this.state.roomCode),
    };

    const encrypted = encryptCheckpoint(JSON.stringify(snapshot));

    if (remoteHumans.length >= 2) {
      const payload: HostCheckpointPayload = {
        hostEpoch: this.hostEpoch,
        seq,
        backupPlayerId: backup.playerId,
        ivBase64: encrypted.ivBase64,
        ciphertextBase64: encrypted.ciphertextBase64,
      };
      this.sendToConn(backupConn, {
        kind: 'HOST_CHECKPOINT',
        payload,
      });

      for (const other of remoteHumans.slice(1)) {
        const otherConn = this.participantConns.get(other.playerId);
        if (otherConn && otherConn.open) {
          this.sendToConn(otherConn, {
            kind: 'CHECKPOINT_KEY',
            payload: {
              hostEpoch: this.hostEpoch,
              seq,
              keyBase64: encrypted.keyBase64,
            },
          });
        }
      }
      return;
    }

    // リモートの人間参加者が1名のみの場合は、その1名が突然断を引き継げるよう鍵を同梱する
    this.sendToConn(backupConn, {
      kind: 'HOST_CHECKPOINT',
      payload: {
        hostEpoch: this.hostEpoch,
        seq,
        backupPlayerId: backup.playerId,
        ivBase64: encrypted.ivBase64,
        ciphertextBase64: encrypted.ciphertextBase64,
        inlineKeyBase64: encrypted.keyBase64,
      },
    });
  }

  private buildRoomStatusPayload(): RoomStatusPayload {
    if (this.pendingTakeover) {
      const v = this.pendingTakeover.fallbackView;
      const rules = deriveRules(v.ruleConfig);
      return {
        roomCode: v.roomCode,
        phase: v.phase === 'awaiting_responses' ? 'playing' : v.phase,
        maxPlayers: rules.playerCount,
        players: v.players.map((p) => ({
          name: p.name,
          isCpu: isCpuPlayerId(p.playerId),
          connected: p.connected,
          isHost: p.playerId === v.hostPlayerId,
        })),
        spectatorNames: (v.spectators ?? [])
          .filter((s) => s.connected)
          .map((s) => s.name),
      };
    }

    const rules = deriveRules(this.state.ruleConfig);
    return {
      roomCode: this.state.roomCode,
      phase:
        this.state.phase === 'awaiting_responses'
          ? 'playing'
          : this.state.phase,
      maxPlayers: rules.playerCount,
      players: this.state.players.map((p) => ({
        name: p.name,
        isCpu: isCpuPlayerId(p.playerId),
        connected: p.connected,
        isHost: p.playerId === this.state.hostPlayerId,
      })),
      spectatorNames: (this.state.spectators ?? [])
        .filter((s) => s.connected)
        .map((s) => s.name),
    };
  }

  private buildViewForViewer(viewerId: string, now: number): StateView {
    const view = toStateView(this.state, viewerId, now, {
      hostEpoch: this.hostEpoch,
    });
    if (
      this.postDiscardHoldActive &&
      this.state.phase === 'playing' &&
      this.state.round &&
      !view.isSpectator
    ) {
      const current = this.state.players.find(
        (p) => p.seatIndex === this.state.round?.currentTurnIndex,
      );
      if (current && current.playerId === viewerId) {
        return {
          ...view,
          myDrawnTile: null,
          mySelfActions: null,
        };
      }
    }
    return view;
  }

  private emitHostView(): void {
    const now = Date.now();
    this.callbacks.onViewChange(
      this.buildViewForViewer(this.state.hostPlayerId, now),
    );
  }

  private broadcastViews(): void {
    const now = Date.now();
    this.callbacks.onViewChange(
      this.buildViewForViewer(this.state.hostPlayerId, now),
    );
    for (const player of this.state.players) {
      if (player.playerId === this.state.hostPlayerId) continue;
      const conn = this.participantConns.get(player.playerId);
      if (conn && conn.open) {
        this.sendToConn(conn, {
          kind: 'STATE_VIEW',
          payload: this.buildViewForViewer(player.playerId, now),
        });
      }
    }
    for (const spectator of this.state.spectators ?? []) {
      const conn = this.participantConns.get(spectator.spectatorId);
      if (conn && conn.open) {
        this.sendToConn(conn, {
          kind: 'STATE_VIEW',
          payload: this.buildViewForViewer(spectator.spectatorId, now),
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
    this.postDiscardHoldToken++;
    this.postDiscardHoldActive = false;
    this.postDiscardHoldDeadlineMs = null;
    this.cpuDeadlineMs = null;
    this.disconnectTargetTurnCount = null;
    this.disconnectDeadlineMs = null;
    this.clearResponseTimer();
    this.clearDisconnectTurnTimer();
    if (this.beaconRetryTimerId !== null) {
      clearTimeout(this.beaconRetryTimerId);
      this.beaconRetryTimerId = null;
    }
    if (this.reconnectPeerTimerId !== null) {
      clearTimeout(this.reconnectPeerTimerId);
      this.reconnectPeerTimerId = null;
    }
    for (const conn of this.participantConns.values()) {
      conn.close();
    }
    this.participantConns.clear();
    this.peerToParticipant.clear();
    if (this.beaconPeer && !this.beaconPeer.destroyed) {
      this.beaconPeer.destroy();
    }
    this.beaconPeer = null;
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
