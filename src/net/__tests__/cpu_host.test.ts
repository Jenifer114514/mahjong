import { describe, expect, it } from 'vitest';
import { HostSession } from '../host';
import type { StateView } from '../../types/message';

describe('HostSession CPU lobby & auto-play orchestration', () => {
  it('即座にロビービューを発行し、CPUの追加・削除と自動対局開始ができる', async () => {
    const views: StateView[] = [];
    const errors: string[] = [];

    const host = new HostSession(
      'ホスト太郎',
      { playerCount: 4, gameLength: 'tonpuu', cpuLevel: 'easy' },
      {
        onViewChange: (v) => views.push(v),
        onStatusChange: () => {},
        onError: (err) => errors.push(err.message),
      },
      { disablePeer: true, cpuTurnDelayMs: 0, cpuResponseDelayMs: 0 },
    );

    host.start();
    expect(views.length).toBe(1);
    expect(views[0]!.phase).toBe('lobby');
    expect(views[0]!.players).toHaveLength(1);
    expect(views[0]!.players[0]!.isCpu).toBe(false);

    // CPUを1人追加
    host.addCpuPlayer();
    let latest = views[views.length - 1]!;
    expect(latest.phase).toBe('lobby');
    expect(latest.players).toHaveLength(2);
    expect(latest.players[1]!.isCpu).toBe(true);
    expect(latest.players[1]!.cpuLevel).toBe('easy');

    // 追加したCPUを外す
    host.removeCpuPlayer(latest.players[1]!.playerId);
    latest = views[views.length - 1]!;
    expect(latest.players).toHaveLength(1);

    // 残りをCPUで埋めて開始（1人 + 3CPU）
    host.fillWithCpusAndStart();
    latest = views[views.length - 1]!;
    expect(latest.phase).not.toBe('lobby');
    expect(latest.players).toHaveLength(4);
    expect(latest.players.filter((p) => p.isCpu)).toHaveLength(3);

    // CPUの手番が自動で進んで自分の手番（または局終了）まで到達する
    for (let i = 0; i < 40; i++) {
      latest = views[views.length - 1]!;
      if (latest.phase === 'round_end' || latest.phase === 'finished') break;
      const self = latest.players.find(
        (p) => p.seatIndex === latest.viewerSeatIndex,
      );
      if (
        (latest.phase === 'playing' && self?.isCurrentTurn) ||
        (latest.phase === 'awaiting_responses' && latest.myCallOptions !== null)
      ) {
        break;
      }
      await new Promise((r) => setTimeout(r, 10));
    }

    latest = views[views.length - 1]!;
    const selfAfterWait = latest.players.find(
      (p) => p.seatIndex === latest.viewerSeatIndex,
    );
    const reachedHumanInteraction =
      latest.phase === 'round_end' ||
      (latest.phase === 'playing' && Boolean(selfAfterWait?.isCurrentTurn)) ||
      (latest.phase === 'awaiting_responses' && latest.myCallOptions !== null);

    expect(reachedHumanInteraction).toBe(true);
    expect(errors).toEqual([]);
    host.destroy();
  });

  it('3人麻雀でCPUを2人追加すると自動で対局が始まる', () => {
    const views: StateView[] = [];
    const host = new HostSession(
      '三麻ホスト',
      { playerCount: 3, gameLength: 'tonpuu', cpuLevel: 'normal' },
      {
        onViewChange: (v) => views.push(v),
        onStatusChange: () => {},
        onError: () => {},
      },
      { disablePeer: true, cpuTurnDelayMs: 50, cpuResponseDelayMs: 50 },
    );

    host.start();
    host.addCpuPlayer();
    expect(views[views.length - 1]!.phase).toBe('lobby');

    host.addCpuPlayer();
    const started = views[views.length - 1]!;
    expect(started.phase).toBe('playing');
    expect(started.players).toHaveLength(3);
    expect(started.players.filter((p) => p.isCpu)).toHaveLength(2);
    host.destroy();
  });
});
