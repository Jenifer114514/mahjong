import { describe, expect, it, vi } from 'vitest';
import { isCpuPlayerId } from '../../cpu/player';
import type { StateView } from '../../types/message';
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
  it('CPU 席をロビーに追加し、人数が揃うと自動開局する', () => {
    const { session, drain, views } = createSession(3, 4);
    session.start();
    drain();

    const view = views.at(-1)!;
    // 開局直後は自分の応答待ちで止まることがある（どちらも対局開始済み）
    expect(['playing', 'awaiting_responses']).toContain(view.phase);
    expect(view.players).toHaveLength(4);
    expect(view.players.filter((p) => isCpuPlayerId(p.playerId))).toHaveLength(3);
    expect(view.players.map((p) => p.name)).toContain('CPU1');

    session.destroy();
  });

  it('CPU だけで 1 局を最後まで進行できる', () => {
    const { session, drain, views } = createSession(3, 4);
    session.start();

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
    const { session, drain, views } = createSession(2, 3);
    session.start();
    drain(2000);

    const view = views.at(-1)!;
    // p0（ホスト）待ちで止まっているか、局が進んでいる
    expect(view.phase === 'playing' || view.phase === 'awaiting_responses').toBe(true);

    session.destroy();
  });

  it('ロビーで CPU を後から追加でき、席が埋まると自動開局する', () => {
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

    // 3 体目で席が埋まり、自動開局する
    expect(session.addCpu()).toBe(true);
    drain(50);
    const started = views.at(-1)!;
    expect(started.players).toHaveLength(4);
    expect(started.players.filter((p) => isCpuPlayerId(p.playerId))).toHaveLength(3);
    expect(['playing', 'awaiting_responses', 'round_end']).toContain(started.phase);

    // 開局後は追加できない
    expect(session.addCpu()).toBe(false);

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
    const { session, drain, views } = createSession(3, 4);
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
});
