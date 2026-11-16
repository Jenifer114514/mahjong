import { describe, expect, it, vi } from 'vitest';
import { isCpuPlayerId } from '../../cpu/player';
import type { StateView } from '../../types/message';
import type { RuleConfig } from '../../types/rule';

// PeerJS はブラウザ向けのため、テストでは接続部分のみスタブ化する
vi.mock('peerjs', () => {
  class FakePeer {
    on() {}
    destroy() {}
    destroyed = false;
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

  it('destroy 後は CPU 操作を実行しない', () => {
    const { session, drain } = createSession(3, 4);
    session.start();
    session.destroy();
    expect(session.runCpuStepOnce()).toBe(false);
    expect(() => drain(10)).not.toThrow();
  });
});
