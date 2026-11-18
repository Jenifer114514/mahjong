import Peer, { type DataConnection } from 'peerjs';
import type { RoomStatusPayload } from '../types/message';
import { PEER_OPTIONS, parseHostMessage, roomCodeToPeerId } from './protocol';
import { PERMANENT_ROOMS, type PermanentRoomId } from './rooms';

export type PermanentRoomProbeState =
  | { status: 'checking' }
  | { status: 'empty' }
  | { status: 'occupied'; info: RoomStatusPayload }
  | { status: 'error' };

export type ProbeErrorSink = (
  handler: ((err: { type?: string; message?: string }) => void) | null,
) => void;

export interface ProbeSingleRoomOptions {
  timeoutMs?: number;
  maxRedirects?: number;
  shouldAbort?: () => boolean;
  setPeerErrorHandler?: ProbeErrorSink;
}

type SingleAttemptOutcome =
  | { kind: 'empty' }
  | { kind: 'occupied'; info: RoomStatusPayload }
  | { kind: 'redirect'; hostPeerId: string }
  | { kind: 'error' };

function probeTargetOnce(
  peer: Peer,
  targetPeerId: string,
  timeoutMs: number,
  shouldAbort: () => boolean,
  setPeerErrorHandler?: ProbeErrorSink,
): Promise<SingleAttemptOutcome> {
  return new Promise<SingleAttemptOutcome>((resolve) => {
    if (shouldAbort() || peer.destroyed) {
      resolve({ kind: 'error' });
      return;
    }

    let settled = false;
    let timerId: ReturnType<typeof setTimeout> | null = null;
    let conn: DataConnection | null = null;
    let localPeerErrorFallback = false;

    const finish = (outcome: SingleAttemptOutcome) => {
      if (settled) return;
      settled = true;
      if (timerId !== null) {
        clearTimeout(timerId);
        timerId = null;
      }
      if (setPeerErrorHandler) {
        setPeerErrorHandler(null);
      } else if (
        localPeerErrorFallback &&
        typeof (peer as unknown as { off?: unknown }).off === 'function'
      ) {
        (
          peer as unknown as {
            off: (ev: string, fn: (err: { type?: string }) => void) => void;
          }
        ).off('error', onPeerError);
      }
      if (conn) {
        try {
          conn.close();
        } catch {
          // ignore close errors during probe cleanup
        }
      }
      resolve(outcome);
    };

    const onPeerError = (err: { type?: string; message?: string }) => {
      if (settled) return;
      if (err?.type === 'peer-unavailable') {
        finish({ kind: 'empty' });
        return;
      }
      finish({ kind: 'error' });
    };

    if (setPeerErrorHandler) {
      setPeerErrorHandler(onPeerError);
    } else {
      localPeerErrorFallback = true;
      peer.on('error', onPeerError);
    }

    timerId = setTimeout(() => {
      finish({ kind: 'error' });
    }, timeoutMs);

    try {
      conn = peer.connect(targetPeerId, {
        reliable: true,
        serialization: 'json',
      });
    } catch {
      finish({ kind: 'error' });
      return;
    }

    if (!conn || typeof conn.on !== 'function') {
      finish({ kind: 'error' });
      return;
    }

    const sendProbe = () => {
      if (settled || shouldAbort()) {
        finish({ kind: 'error' });
        return;
      }
      try {
        conn!.send({ kind: 'PROBE_ROOM' });
      } catch {
        finish({ kind: 'error' });
      }
    };

    conn.on('data', (raw) => {
      if (settled || shouldAbort()) return;
      const msg = parseHostMessage(raw);
      if (!msg) return;
      if (msg.kind === 'ROOM_STATUS') {
        finish({ kind: 'occupied', info: msg.payload });
        return;
      }
      if (msg.kind === 'HOST_REDIRECT') {
        finish({ kind: 'redirect', hostPeerId: msg.payload.hostPeerId });
      }
    });

    conn.on('error', () => {
      finish({ kind: 'error' });
    });

    conn.on('close', () => {
      finish({ kind: 'error' });
    });

    if (conn.open) {
      sendProbe();
    } else {
      conn.on('open', sendProbe);
    }
  });
}

export async function probeSingleRoom(
  peer: Peer,
  roomCode: string,
  options: ProbeSingleRoomOptions = {},
): Promise<PermanentRoomProbeState> {
  const timeoutMs = options.timeoutMs ?? 2500;
  const maxRedirects = options.maxRedirects ?? 2;
  const shouldAbort = options.shouldAbort ?? (() => false);

  let targetPeerId = roomCodeToPeerId(roomCode);
  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (shouldAbort() || peer.destroyed) {
      return { status: 'error' };
    }
    const outcome = await probeTargetOnce(
      peer,
      targetPeerId,
      timeoutMs,
      shouldAbort,
      options.setPeerErrorHandler,
    );
    if (outcome.kind === 'occupied') {
      return { status: 'occupied', info: outcome.info };
    }
    if (outcome.kind === 'empty') {
      return { status: 'empty' };
    }
    if (outcome.kind === 'redirect' && outcome.hostPeerId !== targetPeerId) {
      targetPeerId = outcome.hostPeerId;
      continue;
    }
    return { status: 'error' };
  }
  return { status: 'error' };
}

export interface PermanentRoomWatcherOptions {
  probeTimeoutMs?: number;
  openTimeoutMs?: number;
  refreshIntervalMs?: number;
  shouldContinue?: () => boolean;
  onRoomUpdate: (
    roomId: PermanentRoomId,
    state: PermanentRoomProbeState,
  ) => void;
  onScanningChange?: (scanning: boolean) => void;
}

export class PermanentRoomWatcher {
  private readonly options: PermanentRoomWatcherOptions;
  private peer: Peer | null = null;
  private peerOpen = false;
  private activePeerErrorHandler:
    | ((err: { type?: string; message?: string }) => void)
    | null = null;
  private refreshTimerId: ReturnType<typeof setTimeout> | null = null;
  private openTimerId: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private stopped = false;
  private scanning = false;
  private pendingRescan = false;

  constructor(options: PermanentRoomWatcherOptions) {
    this.options = options;
  }

  start(): void {
    if (this.started && !this.stopped) return;
    this.started = true;
    this.stopped = false;
    void this.runCycle();
  }

  refreshNow(): void {
    if (this.stopped) {
      this.started = true;
      this.stopped = false;
    }
    if (this.refreshTimerId !== null) {
      clearTimeout(this.refreshTimerId);
      this.refreshTimerId = null;
    }
    if (this.scanning) {
      this.pendingRescan = true;
      return;
    }
    void this.runCycle();
  }

  stop(): void {
    this.stopped = true;
    this.scanning = false;
    this.pendingRescan = false;
    this.activePeerErrorHandler = null;
    if (this.refreshTimerId !== null) {
      clearTimeout(this.refreshTimerId);
      this.refreshTimerId = null;
    }
    if (this.openTimerId !== null) {
      clearTimeout(this.openTimerId);
      this.openTimerId = null;
    }
    if (this.peer) {
      try {
        if (!this.peer.destroyed) {
          this.peer.destroy();
        }
      } catch {
        // ignore destroy errors
      }
      this.peer = null;
    }
    this.peerOpen = false;
  }

  private shouldAbort(): boolean {
    if (this.stopped) return true;
    if (this.options.shouldContinue && !this.options.shouldContinue()) {
      this.stop();
      return true;
    }
    return false;
  }

  private async ensureOpenPeer(): Promise<Peer | null> {
    if (this.shouldAbort()) return null;
    if (this.peer && !this.peer.destroyed && this.peerOpen) {
      return this.peer;
    }

    if (this.peer) {
      try {
        if (!this.peer.destroyed) this.peer.destroy();
      } catch {
        // ignore
      }
      this.peer = null;
      this.peerOpen = false;
    }

    const openTimeoutMs = this.options.openTimeoutMs ?? 5000;
    return new Promise<Peer | null>((resolve) => {
      let settled = false;
      const done = (result: Peer | null) => {
        if (settled) return;
        settled = true;
        if (this.openTimerId !== null) {
          clearTimeout(this.openTimerId);
          this.openTimerId = null;
        }
        resolve(result);
      };

      let peer: Peer;
      try {
        peer = new Peer(PEER_OPTIONS);
      } catch {
        done(null);
        return;
      }
      if (typeof peer.on !== 'function') {
        try {
          peer.destroy?.();
        } catch {
          // ignore
        }
        done(null);
        return;
      }

      this.peer = peer;
      this.peerOpen = false;

      this.openTimerId = setTimeout(() => {
        if (!this.peerOpen) {
          try {
            if (!peer.destroyed) peer.destroy();
          } catch {
            // ignore
          }
          if (this.peer === peer) {
            this.peer = null;
          }
          done(null);
        }
      }, openTimeoutMs);

      peer.on('open', () => {
        if (this.shouldAbort() || this.peer !== peer) {
          try {
            if (!peer.destroyed) peer.destroy();
          } catch {
            // ignore
          }
          done(null);
          return;
        }
        this.peerOpen = true;
        done(peer);
      });

      peer.on('disconnected', () => {
        if (this.peer === peer) {
          this.peerOpen = false;
        }
      });

      peer.on('error', (err) => {
        if (this.shouldAbort() || this.peer !== peer) return;
        if (!this.peerOpen) {
          try {
            if (!peer.destroyed) peer.destroy();
          } catch {
            // ignore
          }
          if (this.peer === peer) {
            this.peer = null;
          }
          done(null);
          return;
        }
        if (this.activePeerErrorHandler) {
          this.activePeerErrorHandler(err);
        }
      });
    });
  }

  private async runCycle(): Promise<void> {
    if (this.scanning || this.shouldAbort()) return;
    this.scanning = true;
    this.pendingRescan = false;
    this.options.onScanningChange?.(true);

    try {
      const peer = await this.ensureOpenPeer();
      if (this.shouldAbort()) return;

      if (!peer) {
        for (const room of PERMANENT_ROOMS) {
          if (this.shouldAbort()) return;
          this.options.onRoomUpdate(room.id, { status: 'error' });
        }
        return;
      }

      for (const room of PERMANENT_ROOMS) {
        if (this.shouldAbort()) return;
        const result = await probeSingleRoom(peer, room.id, {
          timeoutMs: this.options.probeTimeoutMs ?? 2500,
          shouldAbort: () => this.shouldAbort(),
          setPeerErrorHandler: (handler) => {
            this.activePeerErrorHandler = handler;
          },
        });
        if (this.shouldAbort()) return;
        this.options.onRoomUpdate(room.id, result);
      }
    } finally {
      this.scanning = false;
      if (!this.stopped) {
        this.options.onScanningChange?.(false);
        if (this.pendingRescan) {
          this.pendingRescan = false;
          void this.runCycle();
        } else {
          this.scheduleNextRefresh();
        }
      }
    }
  }

  private scheduleNextRefresh(): void {
    if (this.shouldAbort()) return;
    const interval = this.options.refreshIntervalMs ?? 12000;
    if (interval <= 0) return;
    if (this.refreshTimerId !== null) {
      clearTimeout(this.refreshTimerId);
    }
    this.refreshTimerId = setTimeout(() => {
      this.refreshTimerId = null;
      if (!this.shouldAbort()) {
        void this.runCycle();
      }
    }, interval);
  }
}
