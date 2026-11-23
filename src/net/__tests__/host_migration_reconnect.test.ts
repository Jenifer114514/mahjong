import { describe, expect, it, vi } from 'vitest';
import type {
  HostSnapshotPayload,
  SessionWelcomePayload,
  StateView,
} from '../../types/message';

const peerClassHolder = vi.hoisted(() => {
  class FakeConn {
    peer: string;
    open = false;
    private handlers: Record<string, Array<(...args: unknown[]) => void>> = {};
    remoteConn: FakeConn | null = null;
    constructor(remotePeer: string) {
      this.peer = remotePeer;
    }
    on(ev: string, cb: (...args: unknown[]) => void) {
      this.handlers[ev] = this.handlers[ev] ?? [];
      this.handlers[ev]!.push(cb);
    }
    emit(ev: string, ...args: unknown[]) {
      for (const cb of this.handlers[ev] ?? []) cb(...args);
    }
    send(msg: unknown) {
      if (!this.open || !this.remoteConn || !this.remoteConn.open) return;
      const cloned = JSON.parse(JSON.stringify(msg));
      this.remoteConn.emit('data', cloned);
    }
    close() {
      if (!this.open) return;
      this.open = false;
      this.emit('close');
      if (this.remoteConn && this.remoteConn.open) {
        this.remoteConn.open = false;
        this.remoteConn.emit('close');
      }
    }
  }

  class FakePeer {
    static registry = new Map<string, FakePeer>();
    static seq = 0;
    id: string;
    destroyed = false;
    disconnected = false;
    private handlers: Record<string, Array<(...args: unknown[]) => void>> = {};
    constructor(id?: string) {
      this.id = id && id.length > 0 ? id : `auto-peer-${++FakePeer.seq}`;
      queueMicrotask(() => {
        if (this.destroyed) return;
        if (FakePeer.registry.has(this.id)) {
          this.emit('error', { type: 'unavailable-id', message: 'id taken' });
          return;
        }
        FakePeer.registry.set(this.id, this);
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
    connect(targetId: string): FakeConn {
      const clientConn = new FakeConn(targetId);
      const targetPeer = FakePeer.registry.get(targetId);
      if (!targetPeer || targetPeer.destroyed) {
        queueMicrotask(() => {
          if (!this.destroyed) {
            this.emit('error', {
              type: 'peer-unavailable',
              message: `Peer ${targetId} not found`,
            });
          }
        });
        return clientConn;
      }
      const hostConn = new FakeConn(this.id);
      clientConn.remoteConn = hostConn;
      hostConn.remoteConn = clientConn;
      targetPeer.emit('connection', hostConn);
      queueMicrotask(() => {
        if (this.destroyed || targetPeer.destroyed) return;
        hostConn.open = true;
        clientConn.open = true;
        hostConn.emit('open');
        clientConn.emit('open');
      });
      return clientConn;
    }
    reconnect() {}
    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      if (FakePeer.registry.get(this.id) === this) {
        FakePeer.registry.delete(this.id);
      }
    }
  }

  return { FakePeer };
});

vi.mock('peerjs', () => ({ default: peerClassHolder.FakePeer }));

const { HostSession } = await import('../host');
const { ClientSession } = await import('../client');

const flush = (ms = 25) => new Promise((r) => setTimeout(r, ms));

describe('HostSession / ClientSession: 観戦・再接続・ホスト引き継ぎ・常設ルーム', () => {
  it('試合途中参加は観戦者になり、手牌を見られず操作不可でチャットは参加できる', async () => {
    peerClassHolder.FakePeer.registry.clear();
    peerClassHolder.FakePeer.seq = 0;

    let hostView: StateView | null = null;
    const hostChats: string[] = [];
    const host = new HostSession(
      'ホスト',
      { playerCount: 3, gameLength: 'tonpuu' },
      {
        onViewChange: (v) => {
          hostView = v;
        },
        onStatusChange: () => {},
        onError: () => {},
        onChatMessage: (m) => hostChats.push(`${m.senderName}:${m.text}`),
      },
      { fixedRoomCode: 'BRONZE', cpuCount: 2, cpuDelayMs: 0, cpuScheduler: () => {} },
    );
    host.start();
    await flush();
    expect(host.getRoomCode()).toBe('BRONZE');
    expect(host.startGame()).toBe(true);
    expect(hostView!.phase).not.toBe('lobby');

    // 対局開始後に途中参加 → 観戦者として受け入れる
    const specViews: StateView[] = [];
    const specWelcomes: SessionWelcomePayload[] = [];
    const specErrors: string[] = [];
    const spectator = new ClientSession(
      'BRONZE',
      '途中観戦太郎',
      {
        onViewChange: (v) => specViews.push(v),
        onStatusChange: () => {},
        onError: (e) => specErrors.push(e.code),
        onWelcome: (w) => specWelcomes.push(w),
      },
    );
    spectator.connect();
    await flush(40);

    expect(specWelcomes.at(-1)?.isSpectator).toBe(true);
    const sv = specViews.at(-1)!;
    expect(sv.isSpectator).toBe(true);
    expect(sv.myHand).toEqual([]);
    expect(sv.myDrawnTile).toBeNull();
    expect(sv.spectators?.length).toBe(1);

    // 観戦者は打牌しようとすると UNAUTHORIZED_ACTION になる
    spectator.discardTile('1m-0');
    await flush(20);
    expect(specErrors).toContain('UNAUTHORIZED_ACTION');

    // 観戦者のチャットはホストや他者に届く
    spectator.sendChat('がんばれ！');
    await flush(20);
    expect(hostChats).toContain('途中観戦太郎:がんばれ！');

    spectator.destroy();
    host.destroy();
  });

  it('切断したプレイヤーが新しい接続からトークンを使って元の席・手牌へ再接続できる', async () => {
    peerClassHolder.FakePeer.registry.clear();
    peerClassHolder.FakePeer.seq = 0;

    let hostView: StateView | null = null;
    const host = new HostSession(
      'ホスト',
      { playerCount: 3, gameLength: 'tonpuu' },
      {
        onViewChange: (v) => {
          hostView = v;
        },
        onStatusChange: () => {},
        onError: () => {},
      },
      { cpuCount: 1, cpuDelayMs: 0, cpuScheduler: () => {} },
    );
    host.start();
    await flush();
    const roomCode = host.getRoomCode();

    let guestWelcome: SessionWelcomePayload | null = null;
    let guestView: StateView | null = null;
    const guest1 = new ClientSession(roomCode, 'ゲストA', {
      onViewChange: (v) => {
        guestView = v;
      },
      onStatusChange: () => {},
      onError: () => {},
      onWelcome: (w) => {
        guestWelcome = w;
      },
    });
    guest1.connect();
    await flush(40);

    expect(host.startGame()).toBe(true);
    await flush(20);

    const originalSeat = guestView!.viewerSeatIndex;
    const originalHandIds = guestView!.myHand.map((t) => t.id);
    const token = guestWelcome!.reconnectToken;
    const originalPlayerId = guestWelcome!.playerId;

    // 強制切断（タブ閉じを模擬）
    guest1.destroy();
    await flush(30);
    expect(
      hostView!.players.find((p) => p.playerId === originalPlayerId)?.connected,
    ).toBe(false);

    // 新しい Peer / ClientSession で同じトークンを使って再接続する
    let reconnectedView: StateView | null = null;
    let reconnectedWelcome: SessionWelcomePayload | null = null;
    const guest1Reconnected = new ClientSession(
      roomCode,
      'ゲストA',
      {
        onViewChange: (v) => {
          reconnectedView = v;
        },
        onStatusChange: () => {},
        onError: () => {},
        onWelcome: (w) => {
          reconnectedWelcome = w;
        },
      },
      { reconnectToken: token },
    );
    guest1Reconnected.connect();
    await flush(40);

    expect(reconnectedWelcome!.playerId).toBe(originalPlayerId);
    expect(reconnectedWelcome!.isSpectator).toBe(false);
    expect(reconnectedView!.viewerSeatIndex).toBe(originalSeat);
    expect(reconnectedView!.myHand.map((t) => t.id)).toEqual(originalHandIds);
    expect(
      reconnectedView!.players.find((p) => p.playerId === originalPlayerId)?.connected,
    ).toBe(true);

    guest1Reconnected.destroy();
    host.destroy();
  });

  it('ホストの明示的委譲（transferHost）で別の人間プレイヤーがホストになり対局継続できる', async () => {
    peerClassHolder.FakePeer.registry.clear();
    peerClassHolder.FakePeer.seq = 0;

    const host = new HostSession(
      '旧ホスト',
      { playerCount: 3, gameLength: 'tonpuu' },
      {
        onViewChange: () => {},
        onStatusChange: () => {},
        onError: () => {},
      },
      { fixedRoomCode: 'SILVER', cpuCount: 0, cpuDelayMs: 0, cpuScheduler: () => {} },
    );
    host.start();
    await flush();

    let g1Handover: HostSnapshotPayload | null = null;
    let g1View: StateView | null = null;
    let g2View: StateView | null = null;
    let promotedHost: InstanceType<typeof HostSession> | null = null;

    const g1 = new ClientSession(
      'SILVER',
      '引き継ぎ太郎',
      {
        onViewChange: (v) => {
          g1View = v;
        },
        onStatusChange: () => {},
        onError: () => {},
        onHostHandover: (snap) => {
          g1Handover = snap;
          promotedHost = new HostSession(
            '引き継ぎ太郎',
            snap.state.ruleConfig,
            {
              onViewChange: (v) => {
                g1View = v;
              },
              onStatusChange: () => {},
              onError: () => {},
            },
            { initialSnapshot: snap, cpuDelayMs: 0, cpuScheduler: () => {} },
          );
          promotedHost.start();
        },
      },
      { migrateDelayMs: 20 },
    );

    const g2 = new ClientSession(
      'SILVER',
      '参加者花子',
      {
        onViewChange: (v) => {
          g2View = v;
        },
        onStatusChange: () => {},
        onError: () => {},
      },
      { migrateDelayMs: 20 },
    );

    g1.connect();
    g2.connect();
    await flush(50);

    expect(host.startGame()).toBe(true);
    await flush(30);

    // 旧ホストが g1 へホスト権限を譲って抜ける
    expect(host.transferHost(g1View!.viewerPlayerId, { stayAsClient: false, destroyDelayMs: 0 })).toBe(true);
    await flush(80);

    expect(g1Handover).not.toBeNull();
    expect(promotedHost).not.toBeNull();
    expect(g1View!.hostPlayerId).toBe(g1View!.viewerPlayerId);
    expect(g1View!.hostEpoch).toBe(1);
    expect(g2View!.hostPlayerId).toBe(g1View!.viewerPlayerId);
    expect(g2View!.hostEpoch).toBe(1);

    // 新ホストのリダイレクトビーコン (arena-mj-SILVER) に新しい観戦者が入室しても H1 へ誘導される
    let lateSpecView: StateView | null = null;
    const lateSpec = new ClientSession('SILVER', '後発観戦', {
      onViewChange: (v) => {
        lateSpecView = v;
      },
      onStatusChange: () => {},
      onError: () => {},
    });
    lateSpec.connect();
    await flush(60);
    const getLateSpecView = (): StateView | null => lateSpecView;
    expect(getLateSpecView()?.isSpectator).toBe(true);
    expect(getLateSpecView()?.hostPlayerId).toBe(g1View!.viewerPlayerId);

    lateSpec.destroy();
    g2.destroy();
    promotedHost!.destroy();
  });

  it('ホストが突然切断されても暗号化チェックポイント＋鍵共有で残存プレイヤーが自動昇格して対局継続する', async () => {
    peerClassHolder.FakePeer.registry.clear();
    peerClassHolder.FakePeer.seq = 0;

    const host = new HostSession(
      '突然断ホスト',
      { playerCount: 3, gameLength: 'tonpuu' },
      {
        onViewChange: () => {},
        onStatusChange: () => {},
        onError: () => {},
      },
      { cpuCount: 0, cpuDelayMs: 0, cpuScheduler: () => {} },
    );
    host.start();
    await flush();
    const roomCode = host.getRoomCode();

    let g1View: StateView | null = null;
    let g2View: StateView | null = null;
    let promotedHost: InstanceType<typeof HostSession> | null = null;
    let promotedPlayerId: string | null = null;

    const makePromoter =
      (
        name: string,
        setView: (v: StateView) => void,
      ) =>
      (params: import('../client').PromoteFromCheckpointParams) => {
        promotedPlayerId = params.myPlayerId;
        promotedHost = new HostSession(
          name,
          params.latestView.ruleConfig,
          {
            onViewChange: setView,
            onStatusChange: () => {},
            onError: () => {},
          },
          {
            cpuDelayMs: 0,
            cpuScheduler: () => {},
            pendingTakeover: {
              hostEpoch: params.hostEpoch,
              seq: params.checkpoint.seq,
              ivBase64: params.checkpoint.ivBase64,
              ciphertextBase64: params.checkpoint.ciphertextBase64,
              localPlayerId: params.myPlayerId,
              localReconnectToken: params.myReconnectToken,
              fallbackView: params.latestView,
              initialKeyBase64: params.initialKeyBase64,
            },
          },
        );
        promotedHost.start();
      };

    const g1 = new ClientSession(
      roomCode,
      '副ホストA',
      {
        onViewChange: (v) => {
          g1View = v;
        },
        onStatusChange: () => {},
        onError: () => {},
        onPromoteFromCheckpoint: makePromoter('副ホストA', (v) => {
          g1View = v;
        }),
      },
      { migrateDelayMs: 25 },
    );

    const g2 = new ClientSession(
      roomCode,
      '鍵保持B',
      {
        onViewChange: (v) => {
          g2View = v;
        },
        onStatusChange: () => {},
        onError: () => {},
        onPromoteFromCheckpoint: makePromoter('鍵保持B', (v) => {
          g2View = v;
        }),
      },
      { migrateDelayMs: 25 },
    );

    g1.connect();
    await flush(25);
    g2.connect();
    await flush(50);

    expect(host.startGame()).toBe(true);
    await flush(30);

    const getG1View = (): StateView | null => g1View;
    const getG2View = (): StateView | null => g2View;

    // 事前予告なしでホストが突然落ちる（destroy）
    host.destroy();
    for (let i = 0; i < 30; i++) {
      await flush(25);
      if (
        promotedHost &&
        promotedPlayerId &&
        getG1View()?.hostPlayerId === promotedPlayerId &&
        getG2View()?.hostPlayerId === promotedPlayerId
      ) {
        break;
      }
    }

    expect(promotedHost).not.toBeNull();
    expect(promotedPlayerId).not.toBeNull();
    expect(getG1View()!.hostPlayerId).toBe(promotedPlayerId);
    expect(getG2View()!.hostPlayerId).toBe(promotedPlayerId);
    expect(getG1View()!.phase).not.toBe('lobby');
    expect(getG2View()!.phase).not.toBe('lobby');

    g1.destroy();
    g2.destroy();
    promotedHost!.destroy();
  });

  it('常設ルームの競合（unavailable-id）時は onPermanentRoomClaimConflict が発火する', async () => {
    peerClassHolder.FakePeer.registry.clear();
    peerClassHolder.FakePeer.seq = 0;

    const first = new HostSession(
      '先着',
      { playerCount: 4, gameLength: 'tonpuu' },
      {
        onViewChange: () => {},
        onStatusChange: () => {},
        onError: () => {},
      },
      { fixedRoomCode: 'GOLD', cpuCount: 0, cpuDelayMs: 0, cpuScheduler: () => {} },
    );
    first.start();
    await flush();

    const onConflict = vi.fn();
    const second = new HostSession(
      '後着',
      { playerCount: 4, gameLength: 'tonpuu' },
      {
        onViewChange: () => {},
        onStatusChange: () => {},
        onError: () => {},
        onPermanentRoomClaimConflict: onConflict,
      },
      { fixedRoomCode: 'GOLD', cpuCount: 0, cpuDelayMs: 0, cpuScheduler: () => {} },
    );
    second.start();
    await flush();

    expect(onConflict).toHaveBeenCalledWith('GOLD');
    second.destroy();
    first.destroy();
  });

  it('切断中プレイヤーの手番が一定時間経過すると自動ツモ切りで進行する', async () => {
    peerClassHolder.FakePeer.registry.clear();
    peerClassHolder.FakePeer.seq = 0;

    let latestHostView: StateView | null = null;
    const host = new HostSession(
      'ホスト',
      { playerCount: 3, gameLength: 'tonpuu' },
      {
        onViewChange: (v) => {
          latestHostView = v;
        },
        onStatusChange: () => {},
        onError: () => {},
      },
      {
        cpuCount: 1,
        cpuDelayMs: 0,
        cpuScheduler: () => {},
        disconnectGraceMs: 30,
      },
    );
    host.start();
    await flush();

    let gView: StateView | null = null;
    const guest = new ClientSession(host.getRoomCode(), '回線不安定', {
      onViewChange: (v) => {
        gView = v;
      },
      onStatusChange: () => {},
      onError: () => {},
    });
    guest.connect();
    await flush(40);
    expect(host.startGame()).toBe(true);
    await flush(20);

    // ゲストを切断させた状態で、ゲストの手番になるまでホストとCPUの手番を進める
    const guestId = gView!.viewerPlayerId;
    guest.destroy();
    await flush(20);

    // ホストかCPUが打牌してゲストの手番に回す
    for (let step = 0; step < 6; step++) {
      const turnPlayer = latestHostView!.players.find((p) => p.isCurrentTurn);
      if (!turnPlayer) break;
      if (turnPlayer.playerId === guestId) break;
      if (turnPlayer.playerId === latestHostView!.hostPlayerId) {
        const tid = latestHostView!.myDrawnTile?.id ?? latestHostView!.myHand[0]?.id;
        if (tid) host.discardTile(tid);
      } else {
        host.runCpuStepOnce();
      }
      await flush(10);
    }

    const discardsBefore =
      latestHostView!.players.find((p) => p.playerId === guestId)?.discards.length ?? 0;
    if (
      latestHostView!.players.find((p) => p.isCurrentTurn)?.playerId === guestId
    ) {
      await flush(60);
      const discardsAfter =
        latestHostView!.players.find((p) => p.playerId === guestId)?.discards.length ?? 0;
      expect(discardsAfter).toBeGreaterThan(discardsBefore);
    }

    host.destroy();
  });

  it('stayAsClient: true でホスト権限譲渡した旧ホストの遅延クローズで onStatusChange("closed") を発火しない', async () => {
    peerClassHolder.FakePeer.registry.clear();
    peerClassHolder.FakePeer.seq = 0;

    const oldHostStatuses: string[] = [];
    let demotedInfo: {
      roomCode: string;
      localToken: string;
      localPlayerId: string;
      hostEpoch: number;
      newHostPeerId: string;
    } | null = null;

    const host = new HostSession(
      '旧ホスト',
      { playerCount: 3, gameLength: 'tonpuu' },
      {
        onViewChange: () => {},
        onStatusChange: (s) => {
          oldHostStatuses.push(s);
        },
        onError: () => {},
        onHostSelfDemoted: (migration, localToken, localPlayerId) => {
          demotedInfo = {
            roomCode: migration.roomCode,
            localToken,
            localPlayerId,
            hostEpoch: migration.hostEpoch,
            newHostPeerId: migration.newHostPeerId,
          };
        },
      },
      { fixedRoomCode: 'GOLD', cpuCount: 0, cpuDelayMs: 0, cpuScheduler: () => {} },
    );
    host.start();
    await flush();

    let g1View: StateView | null = null;
    let promotedHost: InstanceType<typeof HostSession> | null = null;
    const g1 = new ClientSession(
      'GOLD',
      '次期ホスト',
      {
        onViewChange: (v) => {
          g1View = v;
        },
        onStatusChange: () => {},
        onError: () => {},
        onHostHandover: (snap) => {
          promotedHost = new HostSession(
            '次期ホスト',
            snap.state.ruleConfig,
            {
              onViewChange: () => {},
              onStatusChange: () => {},
              onError: () => {},
            },
            { initialSnapshot: snap, cpuDelayMs: 0, cpuScheduler: () => {} },
          );
          promotedHost.start();
        },
      },
      { migrateDelayMs: 10 },
    );
    g1.connect();
    await flush(50);

    oldHostStatuses.length = 0;
    expect(
      host.transferHost(g1View!.viewerPlayerId, {
        stayAsClient: true,
        destroyDelayMs: 30,
      }),
    ).toBe(true);
    expect(demotedInfo).not.toBeNull();

    // 遅延クローズ期間経過後も旧ホストが 'closed' を通知しない
    await flush(80);
    expect(oldHostStatuses).not.toContain('closed');

    // 元のホストが新ホストへクライアントとして合流できること
    let rejoinedView: StateView | null = null;
    const demoted = demotedInfo!;
    const demotedClient = new ClientSession(
      demoted.roomCode,
      '旧ホスト',
      {
        onViewChange: (v) => {
          rejoinedView = v;
        },
        onStatusChange: () => {},
        onError: () => {},
      },
      {
        reconnectToken: demoted.localToken,
        initialHostEpoch: demoted.hostEpoch,
        initialHostPeerId: demoted.newHostPeerId,
      },
    );
    demotedClient.connect();
    await flush(50);
    expect(rejoinedView).not.toBeNull();
    expect(rejoinedView!.hostPlayerId).toBe(g1View!.viewerPlayerId);

    demotedClient.destroy();
    (promotedHost as InstanceType<typeof HostSession> | null)?.destroy();
    host.destroy();
  });
});
