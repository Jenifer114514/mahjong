// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { toStateView } from '../../engine/projection';
import { createInitialGameState, reduce } from '../../engine/reducer';
import { deriveRules } from '../../engine/rules';
import { buildSeededTestDeck } from '../../engine/__tests__/testHelpers';
import type { Tile, TileKind } from '../../types/tile';
import { computeSelfTenpaiGuide } from '../tenpaiGuide';

function t(id: string, kind: TileKind, isRed = false): Tile {
  return { id, kind, isRed };
}

function makeBaseView(playerCount: 3 | 4 = 4) {
  const ruleConfig = { playerCount, gameLength: 'tonpuu' as const };
  const rules = deriveRules(ruleConfig);
  let state = createInitialGameState({
    roomCode: 'TNP001',
    hostPlayerId: 'p0',
    hostName: 'P0',
    ruleConfig,
  });
  for (let i = 1; i < playerCount; i++) {
    state = reduce(state, {
      type: 'JOIN_PLAYER',
      playerId: `p${i}`,
      name: `P${i}`,
    });
  }
  state = reduce(state, {
    type: 'START_GAME',
    shuffledDeck: buildSeededTestDeck(rules, 777),
  });
  return toStateView(state, 'p0', 0);
}

describe('computeSelfTenpaiGuide', () => {
  it('手番で牌を選択したとき、切れば聴牌になる待ちと残り枚数を返す', () => {
    const view = makeBaseView(4);
    // 123m 456p 789s 11z 45s + ツモ9z（9zを切ると3s/6s待ち）
    view.myHand = [
      t('m1', '1m'),
      t('m2', '2m'),
      t('m3', '3m'),
      t('p4', '4p'),
      t('p5', '5p', true),
      t('p6', '6p'),
      t('s7', '7s'),
      t('s8', '8s'),
      t('s9', '9s'),
      t('z1a', '1z'),
      t('z1b', '1z'),
      t('s4', '4s'),
      t('s5', '5s', true),
    ];
    view.myDrawnTile = t('z9', '7z');
    view.players.forEach((p, idx) => {
      p.isCurrentTurn = idx === view.viewerSeatIndex;
      p.discards = [];
      p.melds = [];
      p.kitaTiles = [];
    });
    // 他家の河に 3s が 2枚、ドラ表示牌に 6s の直前牌(=5s) がある状況を作る
    view.players[1]!.discards = [
      { tile: t('d3s1', '3s'), isTsumogiri: false, isRiichiDeclaration: false },
      { tile: t('d3s2', '3s'), isTsumogiri: false, isRiichiDeclaration: false },
    ];
    view.round!.doraIndicators = [t('ind5s', '5s', false)];

    const guide = computeSelfTenpaiGuide(view, 'z9');
    expect(guide).not.toBeNull();
    expect(guide!.mode).toBe('discard_preview');
    expect(guide!.discardTile?.id).toBe('z9');
    expect(guide!.waits.map((w) => w.kind)).toEqual(['3s', '6s']);

    const w3 = guide!.waits.find((w) => w.kind === '3s')!;
    const w6 = guide!.waits.find((w) => w.kind === '6s')!;
    expect(w3.remainingCount).toBe(2); // 4 - 他家河2
    expect(w6.remainingCount).toBe(4);
    expect(w6.isDora).toBe(true);
    expect(guide!.totalRemainingCount).toBe(6);
    expect(guide!.hasFuritenWait).toBe(false);
  });

  it('切っても聴牌しない牌を選択したときは null を返す', () => {
    const view = makeBaseView(4);
    view.myHand = [
      t('m1', '1m'),
      t('m2', '2m'),
      t('m3', '3m'),
      t('p4', '4p'),
      t('p5', '5p'),
      t('p6', '6p'),
      t('s7', '7s'),
      t('s8', '8s'),
      t('s9', '9s'),
      t('z1a', '1z'),
      t('z1b', '1z'),
      t('s4', '4s'),
      t('s5', '5s'),
    ];
    view.myDrawnTile = t('z7', '7z');
    view.players.forEach((p, idx) => {
      p.isCurrentTurn = idx === view.viewerSeatIndex;
      p.discards = [];
      p.melds = [];
    });

    // 4s を切ると孤立の5s+中7zで聴牌しない
    expect(computeSelfTenpaiGuide(view, 's4')).toBeNull();
  });

  it('相手番の13枚聴牌中なら選択なしでも waiting ガイドを返し、フリテンを検出する', () => {
    const view = makeBaseView(4);
    view.myHand = [
      t('m1', '1m'),
      t('m2', '2m'),
      t('m3', '3m'),
      t('p4', '4p'),
      t('p5', '5p'),
      t('p6', '6p'),
      t('s7', '7s'),
      t('s8', '8s'),
      t('s9', '9s'),
      t('z1a', '1z'),
      t('z1b', '1z'),
      t('s4', '4s'),
      t('s5', '5s'),
    ];
    view.myDrawnTile = null;
    view.players.forEach((p, idx) => {
      p.isCurrentTurn = idx !== view.viewerSeatIndex && idx === 1;
      p.discards = [];
      p.melds = [];
    });
    // 自分の河に 3s があるフリテン
    view.players[view.viewerSeatIndex]!.discards = [
      { tile: t('my3s', '3s'), isTsumogiri: false, isRiichiDeclaration: false },
    ];

    const guide = computeSelfTenpaiGuide(view, null);
    expect(guide).not.toBeNull();
    expect(guide!.mode).toBe('waiting');
    expect(guide!.hasFuritenWait).toBe(true);
    const w3 = guide!.waits.find((w) => w.kind === '3s')!;
    const w6 = guide!.waits.find((w) => w.kind === '6s')!;
    expect(w3.isFuriten).toBe(true);
    expect(w6.isFuriten).toBe(false);
    expect(w3.remainingCount).toBe(3); // 4 - 自分河1
  });

  it('3人麻雀でも2m-8mを除外して聴牌待ちを正しく算出する', () => {
    const view = makeBaseView(3);
    view.myHand = [
      t('p1', '1p'),
      t('p2', '2p'),
      t('p3', '3p'),
      t('p4', '4p'),
      t('p5', '5p'),
      t('p6', '6p'),
      t('s7', '7s'),
      t('s8', '8s'),
      t('s9', '9s'),
      t('m1a', '1m'),
      t('m1b', '1m'),
      t('m9a', '9m'),
      t('m9b', '9m'),
    ];
    view.myDrawnTile = null;
    view.players.forEach((p, idx) => {
      p.isCurrentTurn = idx === 1;
      p.discards = [];
      p.melds = [];
    });

    const guide = computeSelfTenpaiGuide(view, null);
    expect(guide).not.toBeNull();
    expect(guide!.waits.map((w) => w.kind)).toEqual(['1m', '9m']);
  });

  it('観戦中や round_end フェーズでは null を返す', () => {
    const view = makeBaseView(4);
    view.isSpectator = true;
    expect(computeSelfTenpaiGuide(view, null)).toBeNull();

    view.isSpectator = false;
    view.phase = 'round_end';
    expect(computeSelfTenpaiGuide(view, null)).toBeNull();
  });
});
