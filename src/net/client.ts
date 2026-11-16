import Peer, { type DataConnection } from 'peerjs';
import type { ClientMessage, GameError, StateView } from '../types/message';
import type { CallResponseChoice } from '../types/state';
import type { TileKind } from '../types/tile';
import {
  PEER_OPTIONS,
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

export interface ClientSessionCallbacks {
  onViewChange: (view: StateView) => void;
  onStatusChange: (status: ClientConnectionStatus, detail?: string) => void;
  onError: (error: GameError) => void;
}

const CONNECT_TIMEOUT_MS = 15000;

export class ClientSession {
  private peer: Peer | null = null;
  private conn: DataConnection | null = null;
  private readonly roomCode: string;
  private readonly playerName: string;
  private readonly callbacks: ClientSessionCallbacks;
  private destroyed = false;
  private hasJoined = false;
  private timeoutId: ReturnType<typeof setTimeout> | null = null;

  constructor(
    roomCode: string,
    playerName: string,
    callbacks: ClientSessionCallbacks,
  ) {
    this.roomCode = normalizeRoomCode(roomCode);
    this.playerName = playerName;
    this.callbacks = callbacks;
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

    this.timeoutId = setTimeout(() => {
      if (!this.hasJoined && !this.destroyed) {
        this.callbacks.onStatusChange(
          'error',
          '接続がタイムアウトしました。部屋コードやネットワーク環境（NAT/TURN制限）を確認してください。',
        );
      }
    }, CONNECT_TIMEOUT_MS);

    peer.on('open', () => {
      if (this.destroyed) {
        peer.destroy();
        return;
      }

      const hostPeerId = roomCodeToPeerId(this.roomCode);
      const conn = peer.connect(hostPeerId, {
        reliable: true,
        serialization: 'json',
      });
      this.conn = conn;

      conn.on('open', () => {
        if (this.destroyed) {
          conn.close();
          return;
        }
        this.callbacks.onStatusChange(
          'waiting_state',
          '入室リクエストを送信しました...',
        );
        this.send({
          kind: 'JOIN',
          playerName: this.playerName,
        });
      });

      conn.on('data', (raw) => {
        if (this.destroyed) return;
        const msg = parseHostMessage(raw);
        if (!msg) {
          this.callbacks.onError({
            code: 'INVALID_MESSAGE',
            message: 'ホストから不正なメッセージを受信しました。',
          });
          return;
        }

        if (msg.kind === 'STATE_VIEW') {
          this.clearTimeout();
          this.hasJoined = true;
          this.callbacks.onStatusChange('connected', '接続済み');
          this.callbacks.onViewChange(msg.payload);
        } else {
          this.clearTimeout();
          this.callbacks.onError(msg.payload);
          if (!this.hasJoined) {
            this.callbacks.onStatusChange('error', msg.payload.message);
            this.destroy();
          }
        }
      });

      conn.on('close', () => {
        this.clearTimeout();
        if (this.destroyed) return;
        this.callbacks.onStatusChange(
          'disconnected',
          this.hasJoined
            ? 'ホストとの接続が切断されました（対局終了）。'
            : 'ホストとの接続が確立する前に切断されました。',
        );
      });

      conn.on('error', (err) => {
        this.clearTimeout();
        if (this.destroyed) return;
        this.callbacks.onStatusChange(
          'error',
          `データ通信エラー: ${err.message}`,
        );
      });
    });

    peer.on('error', (err) => {
      this.clearTimeout();
      if (this.destroyed) return;
      if (err.type === 'peer-unavailable') {
        this.callbacks.onStatusChange(
          'error',
          `部屋コード「${this.roomCode}」が見つかりません。ホストが部屋を開いているか確認してください。`,
        );
        return;
      }
      this.callbacks.onStatusChange(
        'error',
        `接続エラー (${err.type}): ${err.message}`,
      );
    });
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
