import Peer, { type DataConnection } from 'peerjs';
import { isCpuPlayerId } from '../cpu/player';
import type {
  ChangeHistoryEntry,
  ChatMessage,
  CheckpointKeyPayload,
  ClientMessage,
  GameError,
  HostCheckpointPayload,
  HostMigratingPayload,
  HostSnapshotPayload,
  SecretLuckMode,
  SecretStatePayload,
  SessionWelcomePayload,
  StateView,
} from '../types/message';
import type { CallResponseChoice } from '../types/state';
import type { TileKind } from '../types/tile';
import {
  PEER_OPTIONS,
  hasTurnConfig,
  migratedHostPeerId,
  normalizeRoomCode,
  parseHostMessage,
  roomCodeToPeerId,
} from './protocol';

export type ClientConnectionStatus =
  | 'connecting'
  | 'waiting_state'
  | 'connected'
  | 'disconnected'
  | 'error';

export function formatConnectionFailureMessage(
  baseMessage: string,
  turnConfigured: boolean,
): string {
  if (turnConfigured) return baseMessage;
  return `${baseMessage} TURNサーバー未設定のため、異なる回線や制限の厳しいNAT環境ではP2P接続できない場合があります。`;
}

export interface PromoteFromCheckpointParams {
  checkpoint: HostCheckpointPayload;
  initialKeyBase64?: string;
  latestView: StateView;
  myPlayerId: string;
  myReconnectToken: string;
  hostEpoch: number;
}

export interface ClientSessionCallbacks {
  onViewChange: (view: StateView) => void;
  onStatusChange: (status: ClientConnectionStatus, detail?: string) => void;
  onError: (error: GameError) => void;
  onChatMessage?: (message: ChatMessage) => void;
  onChatHistory?: (messages: ChatMessage[]) => void;
  onWelcome?: (welcome: SessionWelcomePayload) => void;
  onHostHandover?: (snapshot: HostSnapshotPayload) => void;
  onPromoteFromCheckpoint?: (params: PromoteFromCheckpointParams) => void;
  onNoHostAvailable?: (roomCode: string) => void;
  onMigrated?: (migration: HostMigratingPayload) => void;
  onHostAwayChange?: (away: boolean) => void;
  onSecretState?: (state: SecretStatePayload) => void;
  onChangeHistory?: (history: ChangeHistoryEntry[]) => void;
}

export interface ClientSessionOptions {
  reconnectToken?: string;
  preferSpectate?: boolean;
  initialHostEpoch?: number;
  initialHostPeerId?: string;
  connectTimeoutMs?: number;
  migrateDelayMs?: number;
  reconnectMaxAttempts?: number;
  turnConfigured?: boolean;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 12000;

export class ClientSession {
  private peer: Peer | null = null;
  private conn: DataConnection | null = null;
  private readonly roomCode: string;
  private readonly playerName: string;
  private readonly callbacks: ClientSessionCallbacks;

  private reconnectToken?: string;
  private readonly preferSpectate: boolean;
  private readonly connectTimeoutMs: number;
  private readonly migrateDelayMs: number;
  private readonly reconnectMaxAttempts: number;
  private readonly turnConfigured: boolean;

  private hostEpoch: number;
  private currentHostPeerId: string;
  private myPlayerId: string | null = null;
  private latestView: StateView | null = null;
  private latestCheckpoint: HostCheckpointPayload | null = null;
  private latestCheckpointKey: CheckpointKeyPayload | null = null;

  private destroyed = false;
  private hasJoined = false;
  private switchingConnection = false;
  private isRecovering = false;
  private triedSameHostRecovery = false;
  private recoveryAttempts = 0;
  private timeoutId: ReturnType<typeof setTimeout> | null = null;
  private retryTimerId: ReturnType<typeof setTimeout> | null = null;
  private peerReconnectAttempts = 0;

  constructor(
    roomCode: string,
    playerName: string,
    callbacks: ClientSessionCallbacks,
    options: ClientSessionOptions = {},
  ) {
    this.roomCode = normalizeRoomCode(roomCode);
    this.playerName = playerName;
    this.callbacks = callbacks;
    this.reconnectToken = options.reconnectToken;
    this.preferSpectate = options.preferSpectate ?? false;
    this.hostEpoch = options.initialHostEpoch ?? 0;
    this.currentHostPeerId =
      options.initialHostPeerId ??
      migratedHostPeerId(this.roomCode, this.hostEpoch);
    this.connectTimeoutMs =
      options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.migrateDelayMs = options.migrateDelayMs ?? 600;
    this.reconnectMaxAttempts = options.reconnectMaxAttempts ?? 8;
    this.turnConfigured = options.turnConfigured ?? hasTurnConfig();
  }

  connect(): void {
    if (this.destroyed) return;
    if (this.roomCode.length === 0) {
      this.callbacks.onStatusChange('error', '部屋コードを入力してください。');
      return;
    }

    this.callbacks.onStatusChange(
      'connecting',
      `部屋 ${this.roomCode} に接続中...`,
    );

    const peer = new Peer(PEER_OPTIONS);
    this.peer = peer;

    this.scheduleConnectTimeout();

    peer.on('open', () => {
      if (this.destroyed) {
        peer.destroy();
        return;
      }
      this.peerReconnectAttempts = 0;
      this.openDataConnection(this.currentHostPeerId);
    });

    peer.on('disconnected', () => {
      if (this.destroyed || peer.destroyed) return;
      if (
        typeof peer.reconnect === 'function' &&
        this.peerReconnectAttempts < 4
      ) {
        this.peerReconnectAttempts++;
        setTimeout(() => {
          if (!this.destroyed && !peer.destroyed) {
            try {
              peer.reconnect();
            } catch {
              // handled by error event
            }
          }
        }, 500 * this.peerReconnectAttempts);
      }
    });

    peer.on('error', (err) => {
      this.clearTimeout();
      if (this.destroyed) return;

      if (err.type === 'peer-unavailable') {
        if (this.isRecovering) {
          this.handleRecoveryFailure();
          return;
        }
        if (!this.hasJoined && this.callbacks.onNoHostAvailable) {
          const cb = this.callbacks.onNoHostAvailable;
          this.destroy();
          cb(this.roomCode);
          return;
        }
        if (
          !this.hasJoined &&
          this.currentHostPeerId !== roomCodeToPeerId(this.roomCode)
        ) {
          this.openDataConnection(roomCodeToPeerId(this.roomCode));
          return;
        }
        this.callbacks.onStatusChange(
          'error',
          formatConnectionFailureMessage(
            `部屋コード「${this.roomCode}」が見つかりません。ホストが部屋を開いているか確認してください。`,
            this.turnConfigured,
          ),
        );
        return;
      }

      if (this.isRecovering) {
        this.handleRecoveryFailure();
        return;
      }

      this.callbacks.onStatusChange(
        'error',
        formatConnectionFailureMessage(
          `接続エラー (${err.type}): ${err.message}`,
          this.turnConfigured,
        ),
      );
    });
  }

  private scheduleConnectTimeout(): void {
    this.clearTimeout();
    this.timeoutId = setTimeout(() => {
      if (this.destroyed) return;
      if (!this.hasJoined && !this.isRecovering) {
        if (this.callbacks.onNoHostAvailable) {
          const cb = this.callbacks.onNoHostAvailable;
          this.destroy();
          cb(this.roomCode);
          return;
        }
        this.callbacks.onStatusChange(
          'error',
          formatConnectionFailureMessage(
            '接続がタイムアウトしました。部屋コードやネットワーク環境を確認してください。',
            this.turnConfigured,
          ),
        );
      } else if (this.isRecovering) {
        this.handleRecoveryFailure();
      }
    }, this.connectTimeoutMs);
  }

  private openDataConnection(targetPeerId: string): void {
    if (this.destroyed || !this.peer || this.peer.destroyed) return;

    this.currentHostPeerId = targetPeerId;
    if (this.conn) {
      this.switchingConnection = true;
      this.conn.close();
      this.conn = null;
      this.switchingConnection = false;
    }

    const conn = this.peer.connect(targetPeerId, {
      reliable: true,
      serialization: 'json',
    });
    this.conn = conn;
    this.scheduleConnectTimeout();

    conn.on('open', () => {
      if (this.destroyed || this.conn !== conn) {
        conn.close();
        return;
      }
      this.callbacks.onStatusChange(
        'waiting_state',
        this.isRecovering ? 'ホストへ再接続中...' : '入室リクエストを送信しました...',
      );
      if (this.isRecovering && this.latestCheckpointKey) {
        this.send({
          kind: 'CHECKPOINT_KEY_SHARE',
          hostEpoch: this.latestCheckpointKey.hostEpoch,
          seq: this.latestCheckpointKey.seq,
          keyBase64: this.latestCheckpointKey.keyBase64,
        });
      }
      this.send({
        kind: 'JOIN',
        playerName: this.playerName,
        ...(this.reconnectToken ? { reconnectToken: this.reconnectToken } : {}),
        ...(this.preferSpectate ? { preferSpectate: true } : {}),
      });
    });

    conn.on('data', (raw) => {
      if (this.destroyed || this.conn !== conn) return;
      const msg = parseHostMessage(raw);
      if (!msg) {
        this.callbacks.onError({
          code: 'INVALID_MESSAGE',
          message: 'ホストから不正なメッセージを受信しました。',
        });
        return;
      }

      if (msg.kind === 'SESSION_WELCOME') {
        this.myPlayerId = msg.payload.playerId;
        this.reconnectToken = msg.payload.reconnectToken;
        this.hostEpoch = msg.payload.hostEpoch;
        this.currentHostPeerId = msg.payload.hostPeerId;
        this.callbacks.onWelcome?.(msg.payload);
        return;
      }

      if (msg.kind === 'STATE_VIEW') {
        this.clearTimeout();
        this.hasJoined = true;
        this.isRecovering = false;
        this.triedSameHostRecovery = false;
        this.recoveryAttempts = 0;
        this.latestView = msg.payload;
        if (msg.payload.hostEpoch !== undefined) {
          this.hostEpoch = msg.payload.hostEpoch;
        }
        this.callbacks.onStatusChange(
          'connected',
          msg.payload.isSpectator ? '観戦中' : '接続済み',
        );
        this.callbacks.onViewChange(msg.payload);
        return;
      }

      if (msg.kind === 'CHAT_MESSAGE') {
        this.callbacks.onChatMessage?.(msg.payload);
        return;
      }

      if (msg.kind === 'CHAT_HISTORY') {
        this.callbacks.onChatHistory?.(msg.payload);
        return;
      }

      if (msg.kind === 'HOST_CHECKPOINT') {
        this.latestCheckpoint = msg.payload;
        return;
      }

      if (msg.kind === 'CHECKPOINT_KEY') {
        this.latestCheckpointKey = msg.payload;
        return;
      }

      if (msg.kind === 'HOST_REDIRECT') {
        this.clearTimeout();
        this.hostEpoch = msg.payload.hostEpoch;
        this.switchingConnection = true;
        conn.close();
        this.switchingConnection = false;
        this.openDataConnection(msg.payload.hostPeerId);
        return;
      }

      if (msg.kind === 'HOST_MIGRATING') {
        this.clearTimeout();
        this.hostEpoch = msg.payload.hostEpoch;
        this.currentHostPeerId = msg.payload.newHostPeerId;
        this.isRecovering = true;
        this.triedSameHostRecovery = true;
        this.recoveryAttempts = 0;
        this.callbacks.onMigrated?.(msg.payload);
        this.callbacks.onStatusChange('connecting', '新しいホストへ引き継ぎ中...');
        this.switchingConnection = true;
        conn.close();
        this.switchingConnection = false;
        this.scheduleRetryConnect(Math.min(350, this.migrateDelayMs));
        return;
      }

      if (msg.kind === 'HOST_STATUS') {
        this.callbacks.onHostAwayChange?.(msg.payload.away);
        return;
      }

      if (msg.kind === 'HOST_HANDOVER') {
        this.clearTimeout();
        this.callbacks.onHostAwayChange?.(false);
        const cb = this.callbacks.onHostHandover;
        this.destroy();
        cb?.(msg.payload);
        return;
      }

      if (msg.kind === 'ROOM_STATUS') {
        return;
      }

      if (msg.kind === 'SECRET_STATE') {
        this.callbacks.onSecretState?.(msg.payload);
        return;
      }

      if (msg.kind === 'CHANGE_HISTORY') {
        this.callbacks.onChangeHistory?.(msg.payload);
        return;
      }

      if (msg.kind === 'ERROR') {
        this.clearTimeout();
        this.callbacks.onError(msg.payload);
        if (!this.hasJoined) {
          this.callbacks.onStatusChange('error', msg.payload.message);
          this.destroy();
        }
      }
    });

    conn.on('close', () => {
      if (this.destroyed || this.switchingConnection || this.conn !== conn) {
        return;
      }
      this.clearTimeout();
      if (!this.hasJoined) {
        if (this.isRecovering) {
          this.handleRecoveryFailure();
          return;
        }
        if (this.callbacks.onNoHostAvailable) {
          const cb = this.callbacks.onNoHostAvailable;
          this.destroy();
          cb(this.roomCode);
          return;
        }
        this.callbacks.onStatusChange(
          'disconnected',
          formatConnectionFailureMessage(
            'ホストとの接続が確立する前に切断されました。',
            this.turnConfigured,
          ),
        );
        return;
      }

      this.callbacks.onHostAwayChange?.(false);
      this.beginConnectionRecovery();
    });

    conn.on('error', (err) => {
      if (this.destroyed || this.conn !== conn) return;
      this.clearTimeout();
      if (this.isRecovering) {
        this.handleRecoveryFailure();
        return;
      }
      this.callbacks.onStatusChange(
        'error',
        formatConnectionFailureMessage(
          `データ通信エラー: ${err.message}`,
          this.turnConfigured,
        ),
      );
    });
  }

  private beginConnectionRecovery(): void {
    if (this.destroyed) return;
    this.isRecovering = true;
    this.triedSameHostRecovery = false;
    this.recoveryAttempts = 0;
    this.callbacks.onStatusChange('connecting', '再接続を試みています...');
    this.scheduleRetryConnect(Math.min(400, this.migrateDelayMs));
  }

  private handleRecoveryFailure(): void {
    if (this.destroyed) return;

    // 1回だけ同一ホストへの再接続を試し、駄目ならホスト引き継ぎ判定を行う
    if (!this.triedSameHostRecovery) {
      this.triedSameHostRecovery = true;
      if (this.tryPromoteOrSwitchHost()) {
        return;
      }
    }

    if (this.recoveryAttempts < this.reconnectMaxAttempts) {
      this.recoveryAttempts++;
      this.scheduleRetryConnect(this.migrateDelayMs);
      return;
    }

    // 最後の手段として元の部屋コードのリダイレクトビーコンにも1回問い合わせる
    const basePeerId = roomCodeToPeerId(this.roomCode);
    if (this.currentHostPeerId !== basePeerId) {
      this.currentHostPeerId = basePeerId;
      this.recoveryAttempts = this.reconnectMaxAttempts;
      this.scheduleRetryConnect(this.migrateDelayMs);
      return;
    }

    this.isRecovering = false;
    this.callbacks.onStatusChange(
      'disconnected',
      'ホストとの接続が切断されました（再接続できませんでした）。',
    );
  }

  private tryPromoteOrSwitchHost(): boolean {
    if (!this.latestView) return false;
    const candidates = this.latestView.players
      .filter(
        (p) =>
          !isCpuPlayerId(p.playerId) &&
          p.playerId !== this.latestView!.hostPlayerId &&
          p.connected,
      )
      .sort((a, b) => a.seatIndex - b.seatIndex);

    if (candidates.length === 0) {
      return false;
    }

    const nextEpoch = (this.latestView.hostEpoch ?? this.hostEpoch) + 1;
    const leader = candidates[0]!;

    if (
      leader.playerId === this.myPlayerId &&
      this.latestCheckpoint &&
      this.callbacks.onPromoteFromCheckpoint
    ) {
      const cb = this.callbacks.onPromoteFromCheckpoint;
      const checkpoint = this.latestCheckpoint;
      const view = this.latestView;
      const myPlayerId = this.myPlayerId;
      const myReconnectToken = this.reconnectToken ?? '';
      this.destroy();
      cb({
        checkpoint,
        initialKeyBase64: checkpoint.inlineKeyBase64,
        latestView: view,
        myPlayerId,
        myReconnectToken,
        hostEpoch: nextEpoch,
      });
      return true;
    }

    this.hostEpoch = nextEpoch;
    this.currentHostPeerId = migratedHostPeerId(this.roomCode, nextEpoch);
    this.recoveryAttempts = 0;
    this.callbacks.onStatusChange(
      'connecting',
      `${leader.name} へホストを引き継ぎ中...`,
    );
    this.scheduleRetryConnect(this.migrateDelayMs);
    return true;
  }

  private scheduleRetryConnect(delayMs: number): void {
    if (this.retryTimerId !== null) {
      clearTimeout(this.retryTimerId);
    }
    this.retryTimerId = setTimeout(() => {
      this.retryTimerId = null;
      if (this.destroyed) return;
      this.openDataConnection(this.currentHostPeerId);
    }, delayMs);
  }

  discardTile(tileId: string): void {
    this.send({
      kind: 'ACTION',
      action: { type: 'DISCARD_TILE', tileId },
    });
  }

  respondToCall(choice: CallResponseChoice): void {
    this.send({
      kind: 'ACTION',
      action: { type: 'CALL_RESPONSE', choice },
    });
  }

  declareTsumo(): void {
    this.send({
      kind: 'ACTION',
      action: { type: 'DECLARE_TSUMO' },
    });
  }

  declareRiichi(tileId: string): void {
    this.send({
      kind: 'ACTION',
      action: { type: 'DECLARE_RIICHI', tileId },
    });
  }

  declareAnkan(kind: TileKind): void {
    this.send({
      kind: 'ACTION',
      action: { type: 'DECLARE_ANKAN', kind },
    });
  }

  declareKakan(tileId: string): void {
    this.send({
      kind: 'ACTION',
      action: { type: 'DECLARE_KAKAN', tileId },
    });
  }

  declareKita(tileId: string): void {
    this.send({
      kind: 'ACTION',
      action: { type: 'DECLARE_KITA', tileId },
    });
  }

  declareKyuushuKyuuhai(): void {
    this.send({
      kind: 'ACTION',
      action: { type: 'DECLARE_KYUUSHU_KYUUHAI' },
    });
  }

  sendChat(text: string): boolean {
    const trimmed = text.trim().slice(0, 200);
    if (!trimmed) return false;
    this.send({
      kind: 'CHAT',
      text: trimmed,
    });
    return true;
  }

  setSecretOption(options: {
    peek?: boolean;
    luck?: SecretLuckMode;
    luckTargetPlayerId?: string;
    clearAllLuck?: boolean;
    clearAllCheat?: boolean;
    requestSync?: boolean;
  }): void {
    this.send({
      kind: 'SECRET_OPTION',
      ...options,
    });
  }

  requestChangeHistory(watch?: boolean): void {
    if (this.destroyed) return;
    if (watch === false && (!this.conn || !this.conn.open)) {
      return;
    }
    this.send(
      watch === undefined
        ? { kind: 'REQUEST_CHANGE_HISTORY' }
        : { kind: 'REQUEST_CHANGE_HISTORY', watch },
    );
  }

  private send(msg: ClientMessage): void {
    if (!this.conn || !this.conn.open) {
      this.callbacks.onError({
        code: 'INVALID_MESSAGE',
        message: 'ホストに接続されていません。',
      });
      return;
    }
    this.conn.send(msg);
  }

  private clearTimeout(): void {
    if (this.timeoutId !== null) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.clearTimeout();
    if (this.retryTimerId !== null) {
      clearTimeout(this.retryTimerId);
      this.retryTimerId = null;
    }
    if (this.conn) {
      this.conn.close();
      this.conn = null;
    }
    if (this.peer && !this.peer.destroyed) {
      this.peer.destroy();
    }
    this.peer = null;
  }
}
