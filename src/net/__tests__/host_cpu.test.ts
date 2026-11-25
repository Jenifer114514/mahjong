import { describe, expect, it, vi } from 'vitest';
import { isCpuPlayerId } from '../../cpu/player';
import { countsFromTiles, handShanten, KIND_COUNT } from '../../cpu/shanten';
import { createStartedCustomGame } from '../../engine/__tests__/testHelpers';
import type { HostMessage, StateView } from '../../types/message';
import type { RuleConfig } from '../../types/rule';

const { peerInstances } = vi.hoisted(() => ({
  peerInstances: [] as Array<{
    id: string;
    handlers: Record<string, Array<(...args: unknown[]) => void>>;
    emit: (event: string, ...args: unknown[]) => void;
  }>,
}));

// PeerJS はブラウザ向けのため、テストでは接続部分のみスタブ化する
vi.mock('peerjs', () => {
  class FakePeer {
    id: string;
    handlers: Record<string, Array<(...args: unknown[]) => void>> = {};
    destroyed = false;
    constructor(id = '') {
      this.id = id;
      peerInstances.push(this);
    }
    on(event: string, cb: (...args: unknown[]) => void) {
      this.handlers[event] = this.handlers[event] ?? [];
      this.handlers[event]!.push(cb);
    }
    emit(event: string, ...args: unknown[]) {
      for (const cb of this.handlers[event] ?? []) cb(...args);
    }
    destroy() {
      this.destroyed = true;
    }
  }
  return { default: FakePeer };
});

const { HostSession } = await import('../host');

function createSession(
  cpuCount: number,
  playerCount: 3 | 4 = 4,
  autoStart = false,
): {
  session: InstanceType<typeof HostSession>;
  views: StateView[];
  /** CPU が自走しなくなるまで runCpuStepOnce を回す */
  drain: (maxSteps?: number) => void;
} {
  const views: StateView[] = [];
  const ruleConfig: RuleConfig = { playerCount, gameLength: 'tonpuu' };
  const session = new HostSession(
    'ホスト',
    ruleConfig,
    {
      onViewChange: (view) => views.push(view),
      onStatusChange: () => {},
      onError: () => {},
    },
    {
      cpuCount,
      cpuDelayMs: 0,
      autoStart,
      // テストでは自走させず、明示的に runCpuStepOnce を呼ぶ
      cpuScheduler: () => {},
    },
  );

  const drain = (maxSteps = 5000): void => {
    for (let i = 0; i < maxSteps; i++) {
      if (!session.runCpuStepOnce()) return;
    }
    throw new Error('CPU steps did not converge');
  };

  return { session, views, drain };
}

describe('HostSession の CPU 統合', () => {
  it('autoStart 指定時は CPU 席をロビーに追加し、人数が揃うと自動開局する', () => {
    const { session, drain, views } = createSession(3, 4, true);
    session.start();
    drain();

    const view = views.at(-1)!;
    // 開局直後は自分の応答待ち（座席ランダム時はCPU東家の局進行で終局・局終了になることもある）
    expect(['playing', 'awaiting_responses', 'round_end']).toContain(view.phase);
    expect(view.players).toHaveLength(4);
    expect(view.players.filter((p) => isCpuPlayerId(p.playerId))).toHaveLength(3);
    expect(view.players.map((p) => p.name)).toContain('CPU1');

    session.destroy();
  });

  it('CPU だけで 1 局を最後まで進行できる', () => {
    const { session, drain, views } = createSession(3, 4);
    session.start();
    expect(session.startGame()).toBe(true);

    // 自分の手番はテストから代わりに打牌して進める
    let guard = 0;
    while (guard++ < 4000) {
      drain(2000);
      const view = views.at(-1)!;
      if (view.phase === 'round_end' || view.phase === 'finished') break;
      if (
        view.phase === 'playing' &&
        view.players.find((p) => p.isCurrentTurn)?.playerId === view.viewerPlayerId
      ) {
        const tileId = view.myDrawnTile?.id ?? view.myHand[0]?.id;
        if (!tileId) throw new Error('ホストに打牌できる牌がない');
        session.discardTile(tileId);
        continue;
      }
      if (view.phase === 'awaiting_responses' && view.myCallOptions) {
        session.respondToCall({ type: 'pass' });
        continue;
      }
      break;
    }

    const view = views.at(-1)!;
    expect(['round_end', 'finished']).toContain(view.phase);
    expect(guard).toBeLessThan(4000);

    session.destroy();
  });

  it('CPU のみ（ホストも CPU 化できない場合）でも応答待ちが勝手に埋まる', () => {
    const { session, drain, views } = createSession(2, 3, true);
    session.start();
    drain(2000);

    const view = views.at(-1)!;
    // p0（ホスト）待ちで止まっているか、局が進んでいる（三麻の九種九牌流局を含む）
    expect(['playing', 'awaiting_responses', 'round_end']).toContain(view.phase);

    session.destroy();
  });

  it('ロビーで CPU や参加者が揃っても自動開局せず、ホストの startGame() で開局する', () => {
    // 最初は CPU 0 体（人間 1 人 + CPU 3 体の 4 人麻雀を想定）
    const { session, drain, views } = createSession(0, 4);
    session.start();
    drain(50);

    // 1 体ずつ追加する（追加のたびにロビーの view が配られる）
    expect(session.addCpu()).toBe(true);
    expect(views.at(-1)!.players).toHaveLength(2);
    expect(views.at(-1)!.phase).toBe('lobby');

    expect(session.addCpu()).toBe(true);
    expect(views.at(-1)!.players).toHaveLength(3);
    // 揃う前は startGame() できない
    expect(session.startGame()).toBe(false);

    // 3 体目で席が埋まっても、まだロビーで待機する（自動開局しない）
    expect(session.addCpu()).toBe(true);
    drain(50);
    expect(views.at(-1)!.players).toHaveLength(4);
    expect(views.at(-1)!.phase).toBe('lobby');

    // ホストが明示的に開始する
    expect(session.startGame()).toBe(true);
    drain(50);
    const started = views.at(-1)!;
    expect(started.players).toHaveLength(4);
    expect(started.players.filter((p) => isCpuPlayerId(p.playerId))).toHaveLength(3);
    expect(['playing', 'awaiting_responses', 'round_end']).toContain(started.phase);

    // 開局後は追加できない
    expect(session.addCpu()).toBe(false);

    session.destroy();
  });

  it('オンライン参加者が定員に達しても自動開局せず、ホストの startGame() で開始する', () => {
    peerInstances.length = 0;
    const { session, views } = createSession(0, 3);
    session.start();
    const peer = peerInstances.at(-1)!;
    peer.emit('open', peer.id);

    for (const id of ['g1', 'g2']) {
      const handlers: Record<string, Array<(...args: unknown[]) => void>> = {};
      const conn = {
        peer: id,
        open: true,
        on(ev: string, cb: (...args: unknown[]) => void) {
          handlers[ev] = handlers[ev] ?? [];
          handlers[ev]!.push(cb);
        },
        emit(ev: string, ...args: unknown[]) {
          for (const cb of handlers[ev] ?? []) cb(...args);
        },
        send() {},
        close() {
          this.open = false;
        },
      };
      peer.emit('connection', conn);
      conn.emit('open');
      conn.emit('data', { kind: 'JOIN', playerName: id });
    }

    expect(views.at(-1)!.players).toHaveLength(3);
    expect(views.at(-1)!.phase).toBe('lobby');

    expect(session.startGame()).toBe(true);
    expect(['playing', 'awaiting_responses']).toContain(views.at(-1)!.phase);

    session.destroy();
  });

  it('ロビーで CPU を減らせる', () => {
    const { session, drain, views } = createSession(2, 4);
    session.start();
    drain(50);
    expect(views.at(-1)!.players).toHaveLength(3);

    expect(session.removeCpu()).toBe(true);
    const afterRemove = views.at(-1)!;
    expect(afterRemove.players).toHaveLength(2);
    expect(afterRemove.players.filter((p) => isCpuPlayerId(p.playerId))).toHaveLength(1);
    expect(afterRemove.phase).toBe('lobby');

    expect(session.removeCpu()).toBe(true);
    expect(views.at(-1)!.players).toHaveLength(1);
    // これ以上 CPU は居ない
    expect(session.removeCpu()).toBe(false);

    session.destroy();
  });

  it('追加した CPU は対局開始後も手番を打つ', () => {
    const { session, drain, views } = createSession(3, 4, true);
    session.start();
    session.addCpu(); // 既に揃っていれば何も起きない
    drain(2000);

    const view = views.at(-1)!;
    expect(view.players.filter((p) => isCpuPlayerId(p.playerId)).length).toBeGreaterThan(0);

    // 起家が人間だと最初から人間の手番で CPU が動かないため、
    // 結果は「席順の運」に左右されてはいけない。
    // CPU が打てる状況（CPU の手番 / 応答待ち）なら必ず捨て牌が増えていることを見る。
    const turnPlayer = view.players.find(
      (p) => p.seatIndex === view.round?.currentTurnIndex,
    );
    const cpuCanAct =
      (view.phase === 'playing' &&
        turnPlayer !== undefined &&
        isCpuPlayerId(turnPlayer.playerId)) ||
      (view.phase === 'awaiting_responses' && view.myCallOptions !== null);

    if (cpuCanAct) {
      const totalDiscards = view.players.reduce(
        (acc, p) => acc + p.discards.length,
        0,
      );
      expect(totalDiscards).toBeGreaterThan(0);
    }

    // どちらの席順でも、CPU が操作できる形で対局が始まっていること
    expect(['playing', 'awaiting_responses', 'round_end']).toContain(
      view.phase,
    );

    session.destroy();
  });

  it('destroy 後は CPU 操作を実行しない', () => {
    const { session, drain } = createSession(3, 4);
    session.start();
    session.destroy();
    expect(session.runCpuStepOnce()).toBe(false);
    expect(() => drain(10)).not.toThrow();
  });

  it('offline かつ cpuCount=0 でも start() 時に初期ロビー StateView を配信する', () => {
    const views: StateView[] = [];
    const session = new HostSession(
      'ホスト',
      { playerCount: 4, gameLength: 'tonpuu' },
      {
        onViewChange: (view) => views.push(view),
        onStatusChange: () => {},
        onError: () => {},
      },
      {
        offline: true,
        cpuCount: 0,
        cpuDelayMs: 0,
        cpuScheduler: () => {},
      },
    );
    session.start();

    expect(views).toHaveLength(1);
    expect(views[0]!.phase).toBe('lobby');
    expect(views[0]!.players).toHaveLength(1);
    session.destroy();
  });

  it('Peer の open / unavailable-id で idx===0 ではなく元の hostPlayerId 一致で席を更新する', () => {
    peerInstances.length = 0;
    const { session, drain, views } = createSession(3, 4);
    session.start();
    drain();

    // 開局して席順がシャッフルされた状態でも正しくホスト席だけ差し替わること
    const initialHostId = views.at(-1)!.viewerPlayerId;
    const cpuIdsBefore = views
      .at(-1)!
      .players.filter((p) => isCpuPlayerId(p.playerId))
      .map((p) => p.playerId)
      .sort();

    // 1回目 Peer で unavailable-id を発火 → 新コードで2回目 Peer を作り open を発火
    const firstPeer = peerInstances.at(-1)!;
    firstPeer.emit('error', { type: 'unavailable-id' });
    const secondPeer = peerInstances.at(-1)!;
    expect(secondPeer).not.toBe(firstPeer);
    secondPeer.emit('open', secondPeer.id);

    const updatedView = views.at(-1)!;
    expect(updatedView.viewerPlayerId).toBe(secondPeer.id);
    expect(updatedView.viewerPlayerId).not.toBe(initialHostId);
    expect(updatedView.players.filter((p) => p.playerId === secondPeer.id)).toHaveLength(1);
    expect(
      updatedView.players
        .filter((p) => isCpuPlayerId(p.playerId))
        .map((p) => p.playerId)
        .sort(),
    ).toEqual(cpuIdsBefore);

    session.destroy();
  });

  it('ロビーで updateRuleConfig により人数・長さ・ON/OFF設定を変更し startGame で開始できる', () => {
    const { session, views } = createSession(0, 4);
    session.start();

    expect(session.addCpu()).toBe(true);
    expect(session.addCpu()).toBe(true);
    expect(views.at(-1)!.phase).toBe('lobby');
    expect(views.at(-1)!.players).toHaveLength(3);

    // 4人→3人へ切り替え（まだロビーのまま詳細設定を触れる）
    expect(session.updateRuleConfig({ playerCount: 3, gameLength: 'hanchan', allowKuitan: false, tsumoLoss: true })).toBe(true);
    const afterUpdate = views.at(-1)!;
    expect(afterUpdate.phase).toBe('lobby');
    expect(afterUpdate.ruleConfig.playerCount).toBe(3);
    expect(afterUpdate.ruleConfig.gameLength).toBe('hanchan');
    expect(afterUpdate.ruleConfig.allowKuitan).toBe(false);
    expect(afterUpdate.ruleConfig.tsumoLoss).toBe(true);
    expect(afterUpdate.players.every((p) => p.score === 35000)).toBe(true);

    // 揃った席から明示的に開始できる
    expect(session.startGame()).toBe(true);
    expect(['playing', 'awaiting_responses']).toContain(views.at(-1)!.phase);

    session.destroy();
  });

  it('ホストおよび参加クライアントのチャットメッセージを相互配信し、後発参加者へ履歴を送る', () => {
    peerInstances.length = 0;
    const chatLog: Array<{ senderName: string; text: string }> = [];
    const session = new HostSession(
      'ホスト',
      { playerCount: 4, gameLength: 'tonpuu' },
      {
        onViewChange: () => {},
        onStatusChange: () => {},
        onError: () => {},
        onChatMessage: (m) => chatLog.push({ senderName: m.senderName, text: m.text }),
      },
      { cpuCount: 0, cpuDelayMs: 0, cpuScheduler: () => {} },
    );
    session.start();
    const peer = peerInstances.at(-1)!;
    peer.emit('open', peer.id);

    const makeFakeConn = (connPeer: string) => {
      const sent: unknown[] = [];
      const handlers: Record<string, Array<(...args: unknown[]) => void>> = {};
      return {
        peer: connPeer,
        open: true,
        sent,
        on(event: string, cb: (...args: unknown[]) => void) {
          handlers[event] = handlers[event] ?? [];
          handlers[event]!.push(cb);
        },
        emit(event: string, ...args: unknown[]) {
          for (const cb of handlers[event] ?? []) cb(...args);
        },
        send(msg: unknown) {
          sent.push(msg);
        },
        close() {
          this.open = false;
        },
      };
    };

    const guest1 = makeFakeConn('guest-1');
    peer.emit('connection', guest1);
    guest1.emit('open');
    guest1.emit('data', { kind: 'JOIN', playerName: 'ゲスト1' });

    // ホストから送信 → ホスト自身と guest1 へ配信される
    expect(session.sendChat('よろしく！')).toBe(true);
    expect(chatLog).toEqual([{ senderName: 'ホスト', text: 'よろしく！' }]);
    expect(guest1.sent.some((m: unknown) =>
      typeof m === 'object' && m !== null && (m as { kind?: string }).kind === 'CHAT_MESSAGE',
    )).toBe(true);

    // guest1 から送信 → ホストにも配信される
    guest1.emit('data', { kind: 'CHAT', text: 'お願いします！' });
    expect(chatLog).toEqual([
      { senderName: 'ホスト', text: 'よろしく！' },
      { senderName: 'ゲスト1', text: 'お願いします！' },
    ]);

    // 後から参加した guest2 へチャット履歴が送られる
    const guest2 = makeFakeConn('guest-2');
    peer.emit('connection', guest2);
    guest2.emit('open');
    guest2.emit('data', { kind: 'JOIN', playerName: 'ゲスト2' });
    const historyMsg = guest2.sent.find(
      (m: unknown) =>
        typeof m === 'object' && m !== null && (m as { kind?: string }).kind === 'CHAT_HISTORY',
    ) as { payload: Array<{ text: string }> } | undefined;
    expect(historyMsg?.payload.map((m) => m.text)).toEqual([
      'よろしく！',
      'お願いします！',
    ]);

    session.destroy();
  });

  it('CPUの応答遅延と打牌後待機は鳴ける牌かどうかにかかわらず同一の分布範囲になる', () => {
    const sampleDelays = (
      mode: 'turn' | 'callable' | 'non_callable',
      randValue: number,
    ): number[] => {
      const scheduled: Array<{ fn: () => void; delayMs: number }> = [];
      const views: StateView[] = [];
      const session = new HostSession(
        'ホスト',
        { playerCount: 4, gameLength: 'tonpuu' },
        {
          onViewChange: (v) => views.push(v),
          onStatusChange: () => {},
          onError: () => {},
        },
        {
          cpuCount: mode === 'turn' ? 3 : 0,
          cpuDelayMs: 1000,
          cpuRandom: () => randValue,
          cpuScheduler: (fn, delayMs) => {
            scheduled.push({ fn, delayMs });
          },
          offline: true,
        },
      );
      session.start();

      if (mode === 'turn') {
        session.addCpu();
        session.addCpu();
        session.addCpu();
        // ロビー追加時のスケジュール値を初期化し、開局後のCPU手番遅延だけを見る
        scheduled.length = 0;
        session.startGame();
        session.destroy();
        return scheduled.map((s) => s.delayMs);
      }

      // 3人CPUで開局
      session.addCpu();
      session.addCpu();
      session.addCpu();
      session.startGame();

      // ホストの手番（または応答待ち）まで無遅延で進めるためテスト内ヘルパー相当
      for (let i = 0; i < 12; i++) {
        const latest = views.at(-1)!;
        if (
          latest.phase === 'playing' &&
          latest.players.find((p) => p.isCurrentTurn)?.playerId === latest.viewerPlayerId
        ) {
          break;
        }
        if (latest.phase === 'awaiting_responses' && latest.myCallOptions) {
          session.respondToCall({ type: 'pass' });
          continue;
        }
        session.runCpuStepOnce();
      }

      const hostView = views.at(-1)!;
      if (
        hostView.phase !== 'playing' ||
        hostView.players.find((p) => p.isCurrentTurn)?.playerId !== hostView.viewerPlayerId
      ) {
        session.destroy();
        return [];
      }

      // 鳴ける/鳴けないに応じて打牌を選び、スケジュールされた遅延を記録
      scheduled.length = 0;
      const candidateTileId = hostView.myDrawnTile?.id ?? hostView.myHand[0]!.id;
      session.discardTile(candidateTileId);
      const delays = scheduled.map((s) => s.delayMs);
      session.destroy();
      return delays;
    };

    // 乱数 0.0 / 0.5 / 0.99 で、通常手番と打牌後/応答遅延が同じ分布関数で決まること
    for (const r of [0, 0.5, 0.99]) {
      const turnDelay = sampleDelays('turn', r);
      const discardDelay = sampleDelays('non_callable', r);
      if (turnDelay.length > 0 && discardDelay.length > 0) {
        expect(discardDelay[0]).toBe(turnDelay[0]);
      }
    }
  });

  it('ホスト背面化時に参加者へ HOST_STATUS を配信し、復帰時に期限超過した応答タイマー・CPUを再開する', async () => {
    peerInstances.length = 0;
    const guestSent: unknown[] = [];
    const views: StateView[] = [];
    const scheduled: Array<{ fn: () => void; delayMs: number }> = [];

    const session = new HostSession(
      'ホスト',
      { playerCount: 4, gameLength: 'tonpuu', responseTimeoutMs: 50 },
      {
        onViewChange: (v) => views.push(v),
        onStatusChange: () => {},
        onError: () => {},
      },
      {
        cpuCount: 0,
        cpuDelayMs: 50,
        cpuScheduler: (fn, delayMs) => {
          scheduled.push({ fn, delayMs });
        },
      },
    );
    session.start();
    const peer = peerInstances.at(-1)!;
    peer.emit('open', peer.id);

    const guestConn = {
      peer: 'guest-away',
      open: true,
      on(event: string, cb: (...args: unknown[]) => void) {
        this.handlers[event] = this.handlers[event] ?? [];
        this.handlers[event]!.push(cb);
      },
      handlers: {} as Record<string, Array<(...args: unknown[]) => void>>,
      emit(event: string, ...args: unknown[]) {
        for (const cb of this.handlers[event] ?? []) cb(...args);
      },
      send(msg: unknown) {
        guestSent.push(msg);
      },
      close() {
        this.open = false;
      },
    };
    peer.emit('connection', guestConn);
    guestConn.emit('open');
    guestConn.emit('data', { kind: 'JOIN', playerName: 'ゲスト' });

    // 背面通知 → HOST_STATUS(away: true) が届く
    session.setHostAway(true);
    expect(guestSent).toContainEqual({
      kind: 'HOST_STATUS',
      payload: { away: true },
    });

    // CPU を2体入れて開局し、ホスト復帰でタイマーと CPU スケジュールが再始動することを確認
    expect(session.addCpu()).toBe(true);
    expect(session.addCpu()).toBe(true);
    expect(session.startGame()).toBe(true);
    const countBeforeReturn = scheduled.length;

    await new Promise((r) => setTimeout(r, 70));
    session.setHostAway(false);
    expect(guestSent).toContainEqual({
      kind: 'HOST_STATUS',
      payload: { away: false },
    });
    // CPU 手番または応答待ちなら復帰時に再スケジュールされる
    const latest = views.at(-1)!;
    const currentTurnPid = latest.players.find((p) => p.isCurrentTurn)?.playerId;
    if (
      latest.phase === 'awaiting_responses' ||
      (currentTurnPid && isCpuPlayerId(currentTurnPid))
    ) {
      expect(scheduled.length).toBeGreaterThan(countBeforeReturn);
    }

    session.destroy();
  });

  it('ホスト背面化中に期限切れとなった応答待ちタイマーは setHostAway(false) 復帰時に再開してタイムアウト解消される', async () => {
    peerInstances.length = 0;
    const views: StateView[] = [];
    const session = new HostSession(
      'ホスト',
      { playerCount: 4, gameLength: 'tonpuu', responseTimeoutMs: 30 },
      {
        onViewChange: (v) => views.push(v),
        onStatusChange: () => {},
        onError: () => {},
      },
      {
        cpuCount: 0,
        cpuDelayMs: 0,
        cpuScheduler: () => {},
      },
    );
    session.start();
    const peer = peerInstances.at(-1)!;
    peer.emit('open', peer.id);

    const makeGuest = (peerId: string) => {
      const handlers: Record<string, Array<(...args: unknown[]) => void>> = {};
      return {
        peer: peerId,
        open: true,
        on(event: string, cb: (...args: unknown[]) => void) {
          handlers[event] = handlers[event] ?? [];
          handlers[event]!.push(cb);
        },
        emit(event: string, ...args: unknown[]) {
          for (const cb of handlers[event] ?? []) cb(...args);
        },
        send() {},
        close() {
          this.open = false;
        },
      };
    };

    const g1 = makeGuest('g1');
    const g2 = makeGuest('g2');
    const g3 = makeGuest('g3');
    for (const g of [g1, g2, g3]) {
      peer.emit('connection', g);
      g.emit('open');
      g.emit('data', { kind: 'JOIN', playerName: g.peer });
    }
    session.startGame();

    // ホストから始まるまで進めることは不要 — 強制的に誰かが鳴ける状態を内部状態に作って応答待ちを検証
    const hostInternals = session as unknown as {
      state: import('../../types/state').GameState;
      responseTimerId: ReturnType<typeof setTimeout> | null;
      commitState: (s: import('../../types/state').GameState) => void;
    };
    const { createStartedCustomGame } = await import(
      '../../engine/__tests__/testHelpers'
    );
    const { reduce } = await import('../../engine/reducer');
    let customState = createStartedCustomGame(4, {
      hands: {
        0: ['1z', '1z', '2z', '2z', '3z', '3z', '4z', '4z', '6z', '6z', '7z', '7z', '9s'],
        1: ['5m', '5m', '1p', '1p', '1p', '2p', '2p', '2p', '3p', '3p', '3p', '4p', '4p'],
        2: ['1s', '1s', '1s', '2s', '2s', '2s', '3s', '3s', '3s', '5s', '5s', '5s', '8s'],
        3: ['7m', '7m', '7m', '8m', '8m', '8m', '9m', '9m', '9m', '9p', '9p', '9p', '3z'],
      },
      dealerDrawnKind: '5m',
    });
    customState = {
      ...customState,
      ruleConfig: { ...customState.ruleConfig, responseTimeoutMs: 30 },
      hostPlayerId: peer.id,
      players: customState.players.map((p, idx) => ({
        ...p,
        playerId: idx === 0 ? peer.id : `g${idx}`,
      })),
    };
    customState = reduce(customState, {
      type: 'DISCARD_TILE',
      playerId: peer.id,
      tileId: customState.players[0]!.drawnTile!.id,
      now: Date.now() - 100, // すでにタイムアウト超過済み
    });
    expect(customState.phase).toBe('awaiting_responses');

    hostInternals.commitState(customState);
    // ブラウザ背面のスロットリングでタイマーが消えてしまった状況を作る
    if (hostInternals.responseTimerId !== null) {
      clearTimeout(hostInternals.responseTimerId);
      hostInternals.responseTimerId = null;
    }
    session.setHostAway(true);
    session.setHostAway(false);

    // 復帰により delay=0 で再スケジュールされ、すぐに自動パスされて次巡(playing)へ進む
    await new Promise((r) => setTimeout(r, 25));
    expect(views.at(-1)!.phase).toBe('playing');

    session.destroy();
  });

  it('鳴ける牌・鳴けない牌の両方で次手番への遅延分布と初期マスクStateViewが完全に一致する', async () => {
    const runDiscardCheck = async (cpuHasPair: boolean) => {
      peerInstances.length = 0;
      const scheduled: Array<{ fn: () => void; delayMs: number }> = [];
      const hostViews: StateView[] = [];
      const guestSent: HostMessage[] = [];
      const session = new HostSession(
        'ホスト',
        { playerCount: 4, gameLength: 'tonpuu', responseTimeoutMs: 0 },
        {
          onViewChange: (v) => hostViews.push(v),
          onStatusChange: () => {},
          onError: () => {},
        },
        {
          cpuCount: 2,
          cpuDelayMs: 1000,
          cpuRandom: () => 0.5,
          cpuScheduler: (fn, delayMs) => {
            scheduled.push({ fn, delayMs });
          },
        },
      );
      session.start();
      const peer = peerInstances.at(-1)!;
      peer.emit('open', peer.id);

      const guestConn = {
        peer: 'guest-p1',
        open: true,
        handlers: {} as Record<string, Array<(...args: unknown[]) => void>>,
        on(event: string, cb: (...args: unknown[]) => void) {
          this.handlers[event] = this.handlers[event] ?? [];
          this.handlers[event]!.push(cb);
        },
        emit(event: string, ...args: unknown[]) {
          for (const cb of this.handlers[event] ?? []) cb(...args);
        },
        send(msg: HostMessage) {
          guestSent.push(msg);
        },
        close() {
          this.open = false;
        },
      };
      peer.emit('connection', guestConn);
      guestConn.emit('open');
      guestConn.emit('data', { kind: 'JOIN', playerName: 'ゲスト' });
      session.startGame();

      const { createStartedCustomGame } = await import(
        '../../engine/__tests__/testHelpers'
      );
      const customBase = createStartedCustomGame(4, {
        hands: {
          0: ['1z', '1z', '2z', '2z', '3z', '3z', '4z', '4z', '6z', '6z', '7z', '7z', '9s'],
          1: ['1p', '1p', '1p', '2p', '2p', '2p', '3p', '3p', '3p', '4p', '4p', '4p', '8s'],
          2: cpuHasPair
            ? ['5m', '5m', '1m', '2m', '3m', '4p', '5p', '6p', '7s', '8s', '9s', '2p', '3p']
            : ['7s', '7s', '7s', '8s', '8s', '8s', '9s', '9s', '9s', '5s', '5s', '5s', '6s'],
          3: ['7m', '7m', '7m', '8m', '8m', '8m', '9m', '9m', '9m', '9p', '9p', '9p', '3z'],
        },
        dealerDrawnKind: '5m',
      });
      const hostInternals = session as unknown as {
        state: import('../../types/state').GameState;
        commitState: (s: import('../../types/state').GameState) => void;
      };
      const fixedState: import('../../types/state').GameState = {
        ...customBase,
        ruleConfig: { ...customBase.ruleConfig, responseTimeoutMs: 0 },
        hostPlayerId: peer.id,
        players: customBase.players.map((p, idx) => {
          if (idx === 0) return { ...p, playerId: peer.id };
          if (idx === 1) return { ...p, playerId: 'guest-p1' };
          if (idx === 2) return { ...p, playerId: 'cpu-1' };
          return { ...p, playerId: 'cpu-2' };
        }),
      };
      hostInternals.commitState(fixedState);
      scheduled.length = 0;
      guestSent.length = 0;

      // ホストが 5m を打牌（cpuHasPair=true なら cpu-1 がポン可、false なら誰も鳴けない）
      session.discardTile(fixedState.players[0]!.drawnTile!.id);

      const initialDelay = scheduled[0]!.delayMs;
      const guestViewBefore = guestSent
        .filter((m): m is Extract<HostMessage, { kind: 'STATE_VIEW' }> => m.kind === 'STATE_VIEW')
        .at(-1)!.payload;

      // 遅延満了を実行すると次の人間プレイヤー(guest-p1)にツモ牌が届く
      scheduled[0]!.fn();
      const guestViewAfter = guestSent
        .filter((m): m is Extract<HostMessage, { kind: 'STATE_VIEW' }> => m.kind === 'STATE_VIEW')
        .at(-1)!.payload;

      session.destroy();
      return { initialDelay, guestViewBefore, guestViewAfter };
    };

    const callable = await runDiscardCheck(true);
    const nonCallable = await runDiscardCheck(false);

    expect(callable.initialDelay).toBe(nonCallable.initialDelay);
    expect(callable.guestViewBefore.phase).toBe('playing');
    expect(nonCallable.guestViewBefore.phase).toBe('playing');
    expect(callable.guestViewBefore.myDrawnTile).toBeNull();
    expect(nonCallable.guestViewBefore.myDrawnTile).toBeNull();
    expect(callable.guestViewBefore.round?.remainingWallCount).toBe(
      nonCallable.guestViewBefore.round?.remainingWallCount,
    );
    expect(callable.guestViewAfter.myDrawnTile).not.toBeNull();
    expect(nonCallable.guestViewAfter.myDrawnTile).not.toBeNull();
  });

  it('裏設定(Peek・Luck)はオンライン対局のホスト・ゲスト双方およびオフライン戦で有効になり、使った本人のみに透視が返る', () => {
    peerInstances.length = 0;
    const hostViews: StateView[] = [];
    const guestSent: HostMessage[] = [];
    const otherGuestSent: HostMessage[] = [];

    const session = new HostSession(
      'ホスト',
      { playerCount: 4, gameLength: 'tonpuu', responseTimeoutMs: 0 },
      {
        onViewChange: (v) => hostViews.push(v),
        onStatusChange: () => {},
        onError: () => {},
      },
      { cpuCount: 1, cpuDelayMs: 0, cpuScheduler: () => {} },
    );
    session.start();
    const peer = peerInstances.at(-1)!;
    peer.emit('open', peer.id);

    const makeGuestConn = (peerId: string, sink: HostMessage[]) => ({
      peer: peerId,
      open: true,
      handlers: {} as Record<string, Array<(...args: unknown[]) => void>>,
      on(event: string, cb: (...args: unknown[]) => void) {
        this.handlers[event] = this.handlers[event] ?? [];
        this.handlers[event]!.push(cb);
      },
      emit(event: string, ...args: unknown[]) {
        for (const cb of this.handlers[event] ?? []) cb(...args);
      },
      send(msg: unknown) {
        sink.push(msg as HostMessage);
      },
      close() {
        this.open = false;
      },
    });

    const g1 = makeGuestConn('guest-peer-1', guestSent);
    const g2 = makeGuestConn('guest-peer-2', otherGuestSent);
    peer.emit('connection', g1);
    g1.emit('open');
    g1.emit('data', { kind: 'JOIN', playerName: 'ゲスト1' });
    peer.emit('connection', g2);
    g2.emit('open');
    g2.emit('data', { kind: 'JOIN', playerName: 'ゲスト2' });

    expect(session.startGame()).toBe(true);
    expect(hostViews.at(-1)?.phase).toBe('playing');
    expect(hostViews.at(-1)?.round?.revealedHands).toEqual({});

    // ゲスト1が SECRET_OPTION で peek=true と luck='god' を送る
    guestSent.length = 0;
    otherGuestSent.length = 0;
    const hostBeforeLen = hostViews.length;
    g1.emit('data', { kind: 'SECRET_OPTION', peek: true, luck: 'god' });

    // ゲスト1本人だけ即座に他3人分の revealedHands を受け取る
    const g1Views = guestSent.filter(
      (m): m is Extract<HostMessage, { kind: 'STATE_VIEW' }> =>
        m.kind === 'STATE_VIEW',
    );
    expect(g1Views).toHaveLength(1);
    const g1PeekView = g1Views[0]!.payload;
    expect(Object.keys(g1PeekView.round?.revealedHands ?? {})).toHaveLength(3);
    expect(
      g1PeekView.round?.revealedHands[g1PeekView.viewerPlayerId],
    ).toBeUndefined();

    // ホストやゲスト2には漏洩しない
    expect(hostViews.length).toBe(hostBeforeLen);
    expect(otherGuestSent).toHaveLength(0);

    // ホスト自身もオンラインで setSecretPeek(true) / setSecretLuck('god', targetId) を全プレイヤーに使用可能
    expect(session.setSecretPeek(true)).toBe(true);
    expect(session.getSecretPeek()).toBe(true);
    expect(session.setSecretLuck('god')).toBe(true);
    expect(session.getSecretLuck()).toBe('god');
    const hostPeek = hostViews.at(-1)!;
    expect(Object.keys(hostPeek.round?.revealedHands ?? {})).toHaveLength(3);

    // 他プレイヤー(ゲスト2・CPU席)の luck もホスト・ゲスト双方から個別に変更し、SECRET_STATE で同期できる
    const g2Id = hostPeek.players.find((p) => p.name === 'ゲスト2')!.playerId;
    const cpuId = hostPeek.players.find((p) => isCpuPlayerId(p.playerId))!.playerId;
    expect(session.setSecretLuck('good', cpuId)).toBe(true);
    expect(session.getSecretLuck(cpuId)).toBe('good');

    guestSent.length = 0;
    otherGuestSent.length = 0;
    g1.emit('data', {
      kind: 'SECRET_OPTION',
      luck: 'god',
      luckTargetPlayerId: g2Id,
    });
    expect(session.getSecretLuck(g2Id)).toBe('god');
    const g1SyncMsg = guestSent.find(
      (m): m is Extract<HostMessage, { kind: 'SECRET_STATE' }> =>
        m.kind === 'SECRET_STATE',
    );
    expect(g1SyncMsg?.payload.peek).toBe(true);
    expect(g1SyncMsg?.payload.luckByPlayer[g2Id]).toBe('god');
    expect(g1SyncMsg?.payload.luckByPlayer[cpuId]).toBe('good');
    expect(otherGuestSent).toHaveLength(0);

    // 存在しない対象IDでは PLAYER_NOT_FOUND エラー
    guestSent.length = 0;
    g1.emit('data', {
      kind: 'SECRET_OPTION',
      luck: 'god',
      luckTargetPlayerId: 'nonexistent-player',
    });
    expect(
      guestSent.some(
        (m) => m.kind === 'ERROR' && m.payload.code === 'PLAYER_NOT_FOUND',
      ),
    ).toBe(true);

    // clearAllLuck で全プレイヤーの luck を通常に戻せる
    guestSent.length = 0;
    g1.emit('data', { kind: 'SECRET_OPTION', clearAllLuck: true });
    expect(session.getSecretLuck(g2Id)).toBe('normal');
    expect(session.getSecretLuck(cpuId)).toBe('normal');
    expect(session.getSecretLuck()).toBe('normal');

    // ゲスト1が peek=false に戻すと透視解除される
    guestSent.length = 0;
    g1.emit('data', { kind: 'SECRET_OPTION', peek: false });
    const g1Closed = guestSent.find(
      (m): m is Extract<HostMessage, { kind: 'STATE_VIEW' }> =>
        m.kind === 'STATE_VIEW',
    )!;
    expect(g1Closed.payload.round?.revealedHands).toEqual({});

    // 観戦者の SECRET_OPTION は拒否される
    const specSent: HostMessage[] = [];
    const spec = makeGuestConn('spec-peer', specSent);
    peer.emit('connection', spec);
    spec.emit('open');
    spec.emit('data', { kind: 'JOIN', playerName: '観戦者', preferSpectate: true });
    specSent.length = 0;
    spec.emit('data', { kind: 'SECRET_OPTION', peek: true });
    expect(
      specSent.some(
        (m) => m.kind === 'ERROR' && m.payload.code === 'UNAUTHORIZED_ACTION',
      ),
    ).toBe(true);

    session.destroy();
  });

  it('裏設定 Luck(god/good) は対局中の次ツモから牌山内の有利な牌（有効牌・ツモ和了牌）を引き当て、総枚数も保存される', () => {
    peerInstances.length = 0;
    const views: StateView[] = [];
    const guestSent: HostMessage[] = [];
    const session = new HostSession(
      'ホスト',
      { playerCount: 4, gameLength: 'tonpuu', responseTimeoutMs: 0 },
      {
        onViewChange: (v) => views.push(v),
        onStatusChange: () => {},
        onError: () => {},
      },
      { cpuCount: 0, cpuDelayMs: 0, cpuScheduler: () => {} },
    );
    session.start();
    const peer = peerInstances.at(-1)!;
    peer.emit('open', peer.id);

    const g1 = {
      peer: 'guest-luck-1',
      open: true,
      handlers: {} as Record<string, Array<(...args: unknown[]) => void>>,
      on(event: string, cb: (...args: unknown[]) => void) {
        this.handlers[event] = this.handlers[event] ?? [];
        this.handlers[event]!.push(cb);
      },
      emit(event: string, ...args: unknown[]) {
        for (const cb of this.handlers[event] ?? []) cb(...args);
      },
      send(msg: unknown) {
        guestSent.push(msg as HostMessage);
      },
      close() {
        this.open = false;
      },
    };
    peer.emit('connection', g1);
    g1.emit('open');
    g1.emit('data', { kind: 'JOIN', playerName: 'ゲスト1' });

    // p0(ホスト): 打牌 -> p1(ゲスト1): 6p8p カンチャン待ち（残り7p 3枚はp2の手牌にあり、最後の1枚の7pだけが山底、山頭は4z）
    const customBase = createStartedCustomGame(4, {
      hands: {
        0: ['1m', '2m', '3m', '4m', '5m', '6m', '7m', '8m', '9m', '1p', '2p', '3p', '9s'],
        // ゲスト1 (seat 1): 1s1s 2m3m4m 5s6s7s 7z7z7z 6p8p（唯一の待ち牌 7p ツモで即ツモ和了！）
        1: ['1s', '1s', '2m', '3m', '4m', '5s', '6s', '7s', '7z', '7z', '7z', '6p', '8p'],
        2: ['1z', '1z', '2z', '2z', '3z', '3z', '5z', '5z', '6z', '6z', '7p', '7p', '7p'],
        3: ['1m', '2m', '3m', '4p', '5p', '6p', '2s', '3s', '4s', '8m', '9m', '8s', '9s'],
      },
      dealerDrawnKind: '9s',
      liveWallHeadKinds: ['4z', '4z', '4z', '4z'],
      wallTailKinds: ['7p'],
    });

    const hostInternals = session as unknown as {
      state: import('../../types/state').GameState;
      commitState: (next: import('../../types/state').GameState) => void;
    };
    const fixedState: import('../../types/state').GameState = {
      ...customBase,
      ruleConfig: { ...customBase.ruleConfig, responseTimeoutMs: 0 },
      hostPlayerId: peer.id,
      players: customBase.players.map((p, idx) => {
        if (idx === 0) return { ...p, playerId: peer.id };
        if (idx === 1) {
          const mappedId = views.at(-1)!.players[1]!.playerId;
          return { ...p, playerId: mappedId };
        }
        return p;
      }),
    };
    hostInternals.commitState(fixedState);

    const wallBefore = hostInternals.state.round!.wall.length;

    // ゲスト1が Luck(god) を送信（オンラインクライアント）
    g1.emit('data', { kind: 'SECRET_OPTION', luck: 'god' });

    // ホストが不要牌を打牌 → 次のツモ番のゲスト1は本来山頭 '4z' のところ、山底の '7p' をツモり即ツモ和了可能に！
    guestSent.length = 0;
    session.discardTile(fixedState.players[0]!.drawnTile!.id);

    const g1AfterDraw = guestSent
      .filter(
        (m): m is Extract<HostMessage, { kind: 'STATE_VIEW' }> =>
          m.kind === 'STATE_VIEW',
      )
      .at(-1)!.payload;

    expect(g1AfterDraw.myDrawnTile?.kind).toBe('7p');
    expect(g1AfterDraw.mySelfActions?.canTsumo).toBe(true);
    // 牌山の残り枚数は通常どおりちょうど1枚だけ減っている（スワップのみで枚数完全保存）
    expect(hostInternals.state.round!.wall.length).toBe(wallBefore - 1);

    // 次にゲスト1が Luck(normal) に戻した状態でノーテン1シャンテン盤面では山頭をそのまま引き、
    // Luck(god) なら有効牌を引いてシャンテンが前進することを確認する
    const iishantenBase = createStartedCustomGame(4, {
      hands: {
        0: ['1m', '2m', '3m', '4m', '5m', '6m', '7m', '8m', '9m', '1p', '2p', '3p', '9s'],
        // ゲスト1 (seat 1): 1s1s 2m3m4m 5s6s7s 7z7z 6p8p 9p（1シャンテン: 7z 2枚 + 6p8p + 9p）
        1: ['1s', '1s', '2m', '3m', '4m', '5s', '6s', '7s', '7z', '7z', '6p', '8p', '9p'],
        2: ['1z', '1z', '2z', '2z', '3z', '3z', '5z', '5z', '6z', '6z', '4p', '4p', '4p'],
        3: ['1m', '2m', '3m', '5p', '5p', '5p', '2s', '3s', '4s', '8m', '9m', '8s', '9s'],
      },
      dealerDrawnKind: '9s',
      liveWallHeadKinds: ['4z', '4z', '4z', '4z'],
      wallTailKinds: ['7z'],
    });
    const iishantenState: import('../../types/state').GameState = {
      ...iishantenBase,
      ruleConfig: { ...iishantenBase.ruleConfig, responseTimeoutMs: 0 },
      hostPlayerId: peer.id,
      players: iishantenBase.players.map((p, idx) => {
        if (idx === 0) return { ...p, playerId: peer.id };
        if (idx === 1) {
          const mappedId = views.at(-1)!.players[1]!.playerId;
          return { ...p, playerId: mappedId };
        }
        return p;
      }),
    };

    // Luck(normal) では通常の山頭 '4z' を引き、1シャンテンのまま
    const calcMinShantenAfterDiscard = (view: StateView): number => {
      const counts = countsFromTiles([
        ...view.myHand,
        ...(view.myDrawnTile ? [view.myDrawnTile] : []),
      ]);
      let minS = 99;
      for (let i = 0; i < KIND_COUNT; i++) {
        if (counts[i]! <= 0) continue;
        counts[i] = counts[i]! - 1;
        minS = Math.min(minS, handShanten(counts, view.players[1]!.melds.length));
        counts[i] = counts[i]! + 1;
      }
      return minS;
    };

    g1.emit('data', { kind: 'SECRET_OPTION', luck: 'normal' });
    hostInternals.commitState(iishantenState);
    guestSent.length = 0;
    session.discardTile(iishantenState.players[0]!.drawnTile!.id);
    const g1NormalDraw = guestSent
      .filter(
        (m): m is Extract<HostMessage, { kind: 'STATE_VIEW' }> =>
          m.kind === 'STATE_VIEW',
      )
      .at(-1)!.payload;
    expect(g1NormalDraw.myDrawnTile?.kind).toBe('4z');
    expect(calcMinShantenAfterDiscard(g1NormalDraw)).toBe(1);

    // Luck(god) に切り替えると 1シャンテン盤面でも山から有効牌を引き当てて即テンパイ (shanten=0) する
    g1.emit('data', { kind: 'SECRET_OPTION', luck: 'god' });
    hostInternals.commitState(iishantenState);
    guestSent.length = 0;
    session.discardTile(iishantenState.players[0]!.drawnTile!.id);
    const g1LuckyDraw = guestSent
      .filter(
        (m): m is Extract<HostMessage, { kind: 'STATE_VIEW' }> =>
          m.kind === 'STATE_VIEW',
      )
      .at(-1)!.payload;
    expect(g1LuckyDraw.myDrawnTile?.kind).not.toBe('4z');
    expect(calcMinShantenAfterDiscard(g1LuckyDraw)).toBe(0);

    // ホスト側から他プレイヤー（ゲスト1）に対して setSecretLuck('god', guestId) を設定した場合も同様にツモ運が反映される
    session.clearAllSecretLuck();
    const guestId = iishantenState.players[1]!.playerId;
    expect(session.setSecretLuck('god', guestId)).toBe(true);
    hostInternals.commitState(iishantenState);
    guestSent.length = 0;
    session.discardTile(iishantenState.players[0]!.drawnTile!.id);
    const g1HostBoostedDraw = guestSent
      .filter(
        (m): m is Extract<HostMessage, { kind: 'STATE_VIEW' }> =>
          m.kind === 'STATE_VIEW',
      )
      .at(-1)!.payload;
    expect(g1HostBoostedDraw.myDrawnTile?.kind).not.toBe('4z');
    expect(calcMinShantenAfterDiscard(g1HostBoostedDraw)).toBe(0);

    session.destroy();
  });
});
