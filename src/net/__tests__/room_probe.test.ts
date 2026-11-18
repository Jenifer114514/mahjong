// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostMessage } from '../../types/message';
import type { PermanentRoomId } from '../rooms';

type EventMap = Record<string, Array<(...args: unknown[]) => void>>;

const { peerRegistry } = vi.hoisted(() => ({
  peerRegistry: new Map<string, FakePeer>(),
}));

class FakeConn {
  peer: string;
  open = true;
  private handlers: EventMap = {};
  private remote: FakeConn | null = null;
  constructor(remotePeerId: string) {
    this.peer = remotePeerId;
  }
  link(other: FakeConn) {
    this.remote = other;
  }
  on(ev: string, cb: (...args: unknown[]) => void) {
    this.handlers[ev] = this.handlers[ev] ?? [];
    this.handlers[ev]!.push(cb);
  }
  emit(ev: string, ...args: unknown[]) {
    for (const cb of this.handlers[ev] ?? []) cb(...args);
  }
  send(data: unknown) {
    if (!this.open || !this.remote) return;
    const remote = this.remote;
    queueMicrotask(() => {
      if (remote.open) {
        remote.emit('data', data);
      }
    });
  }
  close() {
    if (!this.open) return;
    this.open = false;
    this.emit('close');
    if (this.remote && this.remote.open) {
      const other = this.remote;
      other.open = false;
      queueMicrotask(() => other.emit('close'));
    }
  }
}

class FakePeer {
  id: string;
  destroyed = false;
  private handlers: EventMap = {};
  constructor(id?: string) {
    this.id =
      id && id.length > 0
        ? id
        : `probe-peer-${Math.random().toString(36).slice(2, 8)}`;
    queueMicrotask(() => {
      if (this.destroyed) return;
      if (peerRegistry.has(this.id)) {
        this.emit('error', { type: 'unavailable-id', message: 'id taken' });
        return;
      }
      peerRegistry.set(this.id, this);
      this.emit('open', this.id);
    });
  }
  on(ev: string, cb: (...args: unknown[]) => void) {
    this.handlers[ev] = this.handlers[ev] ?? [];
    this.handlers[ev]!.push(cb);
  }
  emit(ev: string, ...args: unknown[]) {
    for (const cb of this.handlers[ev] ?? []) cb(...args);
  }
  connect(targetPeerId: string) {
    const clientConn = new FakeConn(targetPeerId);
    clientConn.open = false;
    queueMicrotask(() => {
      if (this.destroyed) return;
      const hostPeer = peerRegistry.get(targetPeerId);
      if (!hostPeer || hostPeer.destroyed) {
        this.emit('error', {
          type: 'peer-unavailable',
          message: `Could not connect to peer ${targetPeerId}`,
        });
        return;
      }
      const hostConn = new FakeConn(this.id);
      clientConn.link(hostConn);
      hostConn.link(clientConn);
      clientConn.open = true;
      hostPeer.emit('connection', hostConn);
      clientConn.emit('open');
    });
    return clientConn;
  }
  destroy() {
    this.destroyed = true;
    if (peerRegistry.get(this.id) === this) {
      peerRegistry.delete(this.id);
    }
  }
}

vi.mock('peerjs', () => ({ default: FakePeer }));

const { HostSession } = await import('../host');
const { PermanentRoomWatcher, probeSingleRoom } = await import('../roomProbe');
const { PERMANENT_ROOM_DEFAULT_RULE_CONFIG } = await import('../rooms');

describe('常設ルームの参加状況プローブ (PROBE_ROOM / ROOM_STATUS)', () => {
  beforeEach(() => {
    peerRegistry.clear();
  });

  it('HostSession は PROBE_ROOM に ROOM_STATUS で参加者・CPU・観戦者を返し、切断副作用を起こさない', async () => {
    const views: number[] = [];
    const host = new HostSession(
      'ホスト太郎',
      { ...PERMANENT_ROOM_DEFAULT_RULE_CONFIG },
      {
        onViewChange: (v) => views.push(v.players.length),
        onStatusChange: () => {},
        onError: () => {},
      },
      {
        fixedRoomCode: 'BRONZE',
        cpuCount: 1,
        cpuDelayMs: 0,
        cpuScheduler: () => {},
      },
    );
    host.start();
    await new Promise((resolve) => setTimeout(resolve, 20));

    // クライアント1人が一般参加者、もう1人が観戦希望で参加
    const guestPeer = peerRegistry.get('arena-mj-BRONZE')!;
    expect(guestPeer).toBeDefined();

    const probePeer = new FakePeer() as unknown as import('peerjs').default;
    await new Promise((resolve) => setTimeout(resolve, 15));

    // 先に JOIN（プレイヤー）と観戦 JOIN を擬似接続
    const pConn = new FakeConn('guest-1');
    const pHostConn = new FakeConn('guest-1');
    pConn.link(pHostConn);
    pHostConn.link(pConn);
    guestPeer.emit('connection', pHostConn);
    pHostConn.emit('data', { kind: 'JOIN', playerName: '花子' });

    const sConn = new FakeConn('spec-1');
    const sHostConn = new FakeConn('spec-1');
    sConn.link(sHostConn);
    sHostConn.link(sConn);
    guestPeer.emit('connection', sHostConn);
    sHostConn.emit('data', {
      kind: 'JOIN',
      playerName: '観戦くん',
      preferSpectate: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 15));

    const viewCountBeforeProbe = views.length;
    const result = await probeSingleRoom(probePeer, 'BRONZE', {
      timeoutMs: 1000,
    });

    expect(result.status).toBe('occupied');
    if (result.status === 'occupied') {
      expect(result.info.roomCode).toBe('BRONZE');
      expect(result.info.phase).toBe('lobby');
      expect(result.info.maxPlayers).toBe(4);
      expect(result.info.players).toEqual([
        { name: 'ホスト太郎', isCpu: false, connected: true, isHost: true },
        { name: 'CPU1', isCpu: true, connected: true, isHost: false },
        { name: '花子', isCpu: false, connected: true, isHost: false },
      ]);
      expect(result.info.spectatorNames).toEqual(['観戦くん']);
    }

    // プローブの切断後もホストのプレイヤー一覧・ビュー再送信が増えていないこと
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(views.length).toBe(viewCountBeforeProbe);

    host.destroy();
    (probePeer as unknown as FakePeer).destroy();
  });

  it('PermanentRoomWatcher が銅・銀・金の間を巡回し、リダイレクトや空き卓も含めて結果を返す', async () => {
    // 銅の間は通常ホスト（たろう + CPU1）を開設
    const bronzeHost = new HostSession(
      'たろう',
      { ...PERMANENT_ROOM_DEFAULT_RULE_CONFIG },
      {
        onViewChange: () => {},
        onStatusChange: () => {},
        onError: () => {},
      },
      {
        fixedRoomCode: 'BRONZE',
        cpuCount: 1,
        cpuDelayMs: 0,
        cpuScheduler: () => {},
      },
    );
    bronzeHost.start();

    // 金の間は引き継ぎ後ホスト（arena-mj-GOLD → HOST_REDIRECT → arena-mj-GOLD-H1）をシミュレート
    const beaconPeer = new FakePeer('arena-mj-GOLD');
    beaconPeer.on('connection', (rawConn) => {
      const conn = rawConn as FakeConn;
      conn.send({
        kind: 'HOST_REDIRECT',
        payload: {
          roomCode: 'GOLD',
          hostPeerId: 'arena-mj-GOLD-H1',
          hostEpoch: 1,
        },
      } satisfies HostMessage);
      setTimeout(() => conn.close(), 30);
    });
    const redirectedHostPeer = new FakePeer('arena-mj-GOLD-H1');
    redirectedHostPeer.on('connection', (rawConn) => {
      const conn = rawConn as FakeConn;
      conn.on('data', (msg) => {
        if ((msg as { kind?: string })?.kind === 'PROBE_ROOM') {
          conn.send({
            kind: 'ROOM_STATUS',
            payload: {
              roomCode: 'GOLD',
              phase: 'playing',
              maxPlayers: 4,
              players: [
                { name: '新ホスト', isCpu: false, connected: true, isHost: true },
                { name: '次郎', isCpu: false, connected: true, isHost: false },
                { name: 'CPU1', isCpu: true, connected: true, isHost: false },
                { name: 'CPU2', isCpu: true, connected: true, isHost: false },
              ],
              spectatorNames: ['見学者'],
            },
          } satisfies HostMessage);
        }
      });
    });

    await new Promise((resolve) => setTimeout(resolve, 25));

    const updates: Partial<Record<PermanentRoomId, unknown>> = {};
    let doneCount = 0;
    const watcher = new PermanentRoomWatcher({
      probeTimeoutMs: 500,
      refreshIntervalMs: 0,
      onRoomUpdate: (roomId, state) => {
        updates[roomId] = state;
        doneCount += 1;
      },
    });

    watcher.start();
    for (let i = 0; i < 40 && doneCount < 3; i++) {
      await new Promise((resolve) => setTimeout(resolve, 15));
    }

    expect(updates.BRONZE).toMatchObject({
      status: 'occupied',
      info: {
        roomCode: 'BRONZE',
        phase: 'lobby',
        players: [
          { name: 'たろう', isHost: true },
          { name: 'CPU1', isCpu: true },
        ],
      },
    });
    expect(updates.SILVER).toEqual({ status: 'empty' });
    expect(updates.GOLD).toMatchObject({
      status: 'occupied',
      info: {
        roomCode: 'GOLD',
        phase: 'playing',
        spectatorNames: ['見学者'],
      },
    });

    watcher.stop();
    bronzeHost.destroy();
    beaconPeer.destroy();
    redirectedHostPeer.destroy();
  });
});
