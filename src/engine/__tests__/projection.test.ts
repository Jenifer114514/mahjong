import { describe, expect, it } from 'vitest';
import { toStateView } from '../projection';
import { createInitialGameState, reduce } from '../reducer';

describe('toStateView (情報隠蔽の検証)', () => {
  it('他人の手牌と牌山（wall・deadWall）を一切含まない', () => {
    let state = createInitialGameState({
      roomCode: 'HIDEME',
      hostPlayerId: 'host',
      hostName: 'ホスト',
      ruleConfig: { playerCount: 4, gameLength: 'tonpuu' },
    });
    state = reduce(state, { type: 'JOIN_PLAYER', playerId: 'p2', name: 'P2' });
    state = reduce(state, { type: 'JOIN_PLAYER', playerId: 'p3', name: 'P3' });
    state = reduce(state, { type: 'JOIN_PLAYER', playerId: 'p4', name: 'P4' });
    state = reduce(state, { type: 'START_GAME', seed: 314159 });

    const targetViewerId = 'p2';
    const view = toStateView(state, targetViewerId);
    const serialized = JSON.stringify(view);

    // 自分の手牌は含まれる
    const viewerState = state.players.find((p) => p.playerId === targetViewerId)!;
    expect(view.myHand).toEqual(viewerState.hand);
    expect(view.myDrawnTile).toEqual(viewerState.drawnTile);

    // 他家の手牌IDが StateView 内のどこにも含まれない
    for (const other of state.players) {
      if (other.playerId === targetViewerId) continue;
      for (const tile of other.hand) {
        expect(serialized).not.toContain(`"${tile.id}"`);
      }
      if (other.drawnTile) {
        expect(serialized).not.toContain(`"${other.drawnTile.id}"`);
      }
    }

    // 牌山・王牌の牌IDが StateView 内のどこにも含まれない
    for (const tile of state.round!.wall) {
      expect(serialized).not.toContain(`"${tile.id}"`);
    }
    for (const tile of state.round!.deadWall) {
      expect(serialized).not.toContain(`"${tile.id}"`);
    }

    // 残り牌数・公開情報（手牌枚数、捨て牌、副露、持ち点）は正しく送信される
    expect(view.round?.remainingWallCount).toBe(state.round!.wall.length);
    for (const pub of view.players) {
      const real = state.players.find((p) => p.playerId === pub.playerId)!;
      expect(pub.handCount).toBe(real.hand.length);
      expect(pub.hasDrawnTile).toBe(real.drawnTile !== null);
      expect(pub.score).toBe(real.score);
      expect(pub.discards).toEqual(real.discards);
      expect(pub.melds).toEqual(real.melds);
    }
  });
});
