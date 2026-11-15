import { describe, expect, it } from 'vitest';
import { toStateView } from '../projection';
import { createInitialGameState, reduce } from '../reducer';
import { deriveRules } from '../rules';
import { buildSeededTestDeck, createStartedCustomGame } from './testHelpers';

describe('toStateView (情報隠蔽の検証)', () => {
  it('他人の手牌・牌山・未公開ドラ/裏ドラ/嶺上牌・他人の鳴き候補を一切含まない', () => {
    const ruleConfig = { playerCount: 4 as const, gameLength: 'tonpuu' as const };
    const rules = deriveRules(ruleConfig);
    let state = createInitialGameState({
      roomCode: 'HIDEME',
      hostPlayerId: 'host',
      hostName: 'ホスト',
      ruleConfig,
    });
    state = reduce(state, { type: 'JOIN_PLAYER', playerId: 'p2', name: 'P2' });
    state = reduce(state, { type: 'JOIN_PLAYER', playerId: 'p3', name: 'P3' });
    state = reduce(state, { type: 'JOIN_PLAYER', playerId: 'p4', name: 'P4' });
    state = reduce(state, {
      type: 'START_GAME',
      shuffledDeck: buildSeededTestDeck(rules, 314159),
    });

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

    // 牌山・嶺上牌・未公開ドラ表示牌・裏ドラ表示牌が含まれない
    for (const tile of state.round!.wall) {
      expect(serialized).not.toContain(`"${tile.id}"`);
    }
    for (const tile of state.round!.deadWall.rinshanTiles) {
      expect(serialized).not.toContain(`"${tile.id}"`);
    }
    for (const tile of state.round!.deadWall.uraDoraIndicators) {
      expect(serialized).not.toContain(`"${tile.id}"`);
    }
    for (const tile of state.round!.deadWall.doraIndicators.slice(1)) {
      expect(serialized).not.toContain(`"${tile.id}"`);
    }

    // 1枚目の表ドラ表示牌のみ公開される
    expect(view.round?.doraIndicators).toEqual([
      state.round!.deadWall.doraIndicators[0],
    ]);

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

  it('鳴き応答待ち中は該当プレイヤーのみ自分の myCallOptions と残り時間を受け取り、他者には漏れない', () => {
    const state = createStartedCustomGame(4, {
      hands: {
        0: ['9p', '9p', '9p', '1z', '1z', '1z', '2z', '2z', '2z', '3z', '3z', '3z', '5m'],
        1: ['4m', '6m', '1p', '1p', '1p', '2p', '2p', '2p', '3p', '3p', '3p', '4p', '4p'],
        2: ['5m', '5m', '5s', '5s', '5s', '6s', '6s', '6s', '7s', '7s', '7s', '8s', '8s'],
      },
      dealerDrawnKind: '5m',
    });

    const p0Drawn = state.players[0]!.drawnTile!;
    const awaiting = reduce(state, {
      type: 'DISCARD_TILE',
      playerId: 'p0',
      tileId: p0Drawn.id,
      now: 1000,
    });
    expect(awaiting.phase).toBe('awaiting_responses');

    const v0 = toStateView(awaiting, 'p0', 3000);
    const v1 = toStateView(awaiting, 'p1', 3000);
    const v2 = toStateView(awaiting, 'p2', 3000);
    const v3 = toStateView(awaiting, 'p3', 3000);

    expect(v0.myCallOptions).toBeNull();
    expect(v3.myCallOptions).toBeNull();
    expect(v1.myCallOptions?.chiOptions).toHaveLength(1);
    expect(v1.myCallOptions?.canPon).toBe(false);
    expect(v2.myCallOptions?.canPon).toBe(true);
    expect(v2.myCallOptions?.chiOptions).toHaveLength(0);

    // カウントダウン計算と他家候補非公開
    expect(v1.responseRemainingMs).toBe(13000);
    expect(JSON.stringify(v1)).not.toContain('canPon":true');
  });
});
