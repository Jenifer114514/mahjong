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

  it('鳴き応答待ち中は該当プレイヤーのみ自分の myCallOptions と残り時間・awaiting_responsesを受け取り、他者には漏れない', () => {
    const state = createStartedCustomGame(4, {
      hands: {
        0: ['9p', '9p', '9p', '1z', '1z', '1z', '2z', '2z', '2z', '3z', '3z', '3z', '5m'],
        1: ['4m', '6m', '1p', '1p', '1p', '2p', '2p', '2p', '3p', '3p', '3p', '4p', '4p'],
        2: ['5m', '5m', '5s', '5s', '5s', '6s', '6s', '6s', '7s', '7s', '7s', '8s', '8s'],
        // 鳴き・ロンを持たない明示的な非テンパイ手牌（未指定時の山残りによる偶然テンパイを防止）
        3: ['4z', '4z', '4z', '5z', '5z', '5z', '6z', '6z', '6z', '7z', '7z', '7z', '1s'],
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

    // 選択肢のない視点 (p0, p3) には応答待ち・残り時間・手番停止が漏れない
    expect(v0.myCallOptions).toBeNull();
    expect(v0.phase).toBe('playing');
    expect(v0.responseRemainingMs).toBeNull();
    expect(v0.round?.currentTurnIndex).toBe(1);
    expect(v0.players.map((p) => p.isCurrentTurn)).toEqual([false, true, false, false]);

    expect(v3.myCallOptions).toBeNull();
    expect(v3.phase).toBe('playing');
    expect(v3.responseRemainingMs).toBeNull();
    expect(v3.round?.currentTurnIndex).toBe(1);
    expect(v3.players.map((p) => p.isCurrentTurn)).toEqual([false, true, false, false]);

    // 選択肢のある視点 (p1, p2) にのみ awaiting_responses・選択肢・残り時間が届く
    expect(v1.phase).toBe('awaiting_responses');
    expect(v1.myCallOptions?.chiOptions).toHaveLength(1);
    expect(v1.myCallOptions?.canPon).toBe(false);
    expect(v1.responseRemainingMs).toBe(13000);

    expect(v2.phase).toBe('awaiting_responses');
    expect(v2.myCallOptions?.canPon).toBe(true);
    expect(v2.myCallOptions?.chiOptions).toHaveLength(0);
    expect(v2.responseRemainingMs).toBe(13000);
    expect(JSON.stringify(v1)).not.toContain('canPon":true');

    // p1 が先にパスすると、p2 の応答待ち中でも p1 への応答待ち表示は解除される
    const afterP1Pass = reduce(awaiting, {
      type: 'CALL_RESPONSE',
      playerId: 'p1',
      choice: { type: 'pass' },
    });
    expect(afterP1Pass.phase).toBe('awaiting_responses');
    const v1AfterPass = toStateView(afterP1Pass, 'p1', 4000);
    expect(v1AfterPass.myCallOptions).toBeNull();
    expect(v1AfterPass.phase).toBe('playing');
    expect(v1AfterPass.responseRemainingMs).toBeNull();
    expect(v1AfterPass.round?.currentTurnIndex).toBe(1);
  });

  it('選択肢のない視点 (p3, p0) の StateView 判定項目は応答待ちの有無で変わらない', () => {
    const noCallState = createStartedCustomGame(4, {
      hands: {
        0: ['9p', '9p', '9p', '1z', '1z', '1z', '2z', '2z', '2z', '3z', '3z', '3z', '5m'],
        1: ['1p', '1p', '1p', '2p', '2p', '2p', '3p', '3p', '3p', '4p', '4p', '4p', '8s'],
        2: ['5s', '5s', '5s', '6s', '6s', '6s', '7s', '7s', '7s', '8s', '8s', '9s', '9s'],
        3: ['4z', '4z', '4z', '5z', '5z', '5z', '6z', '6z', '6z', '7z', '7z', '7z', '1s'],
      },
      dealerDrawnKind: '5m',
    });
    const afterNoCall = reduce(noCallState, {
      type: 'DISCARD_TILE',
      playerId: 'p0',
      tileId: noCallState.players[0]!.drawnTile!.id,
      now: 1000,
    });
    expect(afterNoCall.phase).toBe('playing');

    const withCallState = createStartedCustomGame(4, {
      hands: {
        0: ['9p', '9p', '9p', '1z', '1z', '1z', '2z', '2z', '2z', '3z', '3z', '3z', '5m'],
        1: ['1p', '1p', '1p', '2p', '2p', '2p', '3p', '3p', '3p', '4p', '4p', '4p', '8s'],
        2: ['5m', '5m', '5s', '5s', '5s', '6s', '6s', '6s', '7s', '7s', '7s', '8s', '9s'],
        3: ['4z', '4z', '4z', '5z', '5z', '5z', '6z', '6z', '6z', '7z', '7z', '7z', '1s'],
      },
      dealerDrawnKind: '5m',
    });
    const afterWithCall = reduce(withCallState, {
      type: 'DISCARD_TILE',
      playerId: 'p0',
      tileId: withCallState.players[0]!.drawnTile!.id,
      now: 1000,
    });
    expect(afterWithCall.phase).toBe('awaiting_responses');

    for (const viewerId of ['p0', 'p3']) {
      const viewNoCall = toStateView(afterNoCall, viewerId, 3000);
      const viewWithCall = toStateView(afterWithCall, viewerId, 3000);

      expect(viewWithCall.phase).toBe(viewNoCall.phase);
      expect(viewWithCall.responseRemainingMs).toBe(viewNoCall.responseRemainingMs);
      expect(viewWithCall.myCallOptions).toBe(viewNoCall.myCallOptions);
      expect(viewWithCall.mySelfActions).toBe(viewNoCall.mySelfActions);
      expect(viewWithCall.round?.currentTurnIndex).toBe(
        viewNoCall.round?.currentTurnIndex,
      );
      expect(viewWithCall.players.map((p) => p.isCurrentTurn)).toEqual(
        viewNoCall.players.map((p) => p.isCurrentTurn),
      );
    }
  });
});
