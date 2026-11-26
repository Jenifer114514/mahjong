import { describe, expect, it } from 'vitest';
import { deriveRules } from '../rules';
import {
  buildTileDeck,
  countAllDeadWallTiles,
  dealRoundFromDeck,
  shuffleWithCrypto,
  validateDeckForRules,
} from '../wall';
import { buildSeededTestDeck } from './testHelpers';

describe('buildTileDeck & dealRoundFromDeck', () => {
  it('4人麻雀: 136枚・赤ドラ各5に1枚(計3枚)・重複なし・王牌(4+5+5=14)・配牌整合性を満たす', () => {
    const rules = deriveRules({ playerCount: 4, gameLength: 'tonpuu' });
    const deck = buildTileDeck(rules);

    expect(deck).toHaveLength(136);
    expect(deck.filter((t) => t.isRed).map((t) => t.kind).sort()).toEqual([
      '5m',
      '5p',
      '5s',
    ]);
    expect(new Set(deck.map((t) => t.id)).size).toBe(136);

    const shuffled = buildSeededTestDeck(rules, 12345);
    expect(validateDeckForRules(rules, shuffled)).toBe(true);

    const deal = dealRoundFromDeck(rules, 0, shuffled);
    expect(deal.hands).toHaveLength(4);
    for (const hand of deal.hands) {
      expect(hand).toHaveLength(13);
    }
    expect(deal.deadWall.rinshanTiles).toHaveLength(4);
    expect(deal.deadWall.doraIndicators).toHaveLength(5);
    expect(deal.deadWall.uraDoraIndicators).toHaveLength(5);
    expect(deal.deadWall.revealedDoraCount).toBe(1);
    expect(deal.deadWall.pendingKandoraCount).toBe(0);
    expect(countAllDeadWallTiles(deal.deadWall)).toBe(14);
    expect(deal.wall).toHaveLength(136 - 4 * 13 - 1 - 14); // 69

    const allDealtIds = [
      ...deal.hands.flat().map((t) => t.id),
      deal.dealerDrawnTile.id,
      ...deal.wall.map((t) => t.id),
      ...deal.deadWall.rinshanTiles.map((t) => t.id),
      ...deal.deadWall.doraIndicators.map((t) => t.id),
      ...deal.deadWall.uraDoraIndicators.map((t) => t.id),
    ];
    expect(allDealtIds).toHaveLength(136);
    expect(new Set(allDealtIds).size).toBe(136);
  });

  it('3人麻雀: 萬子2〜8を除いた108枚・赤ドラ各5に1枚(計2枚)・王牌(4+5+5=14)・配牌整合性を満たす', () => {
    const rules = deriveRules({ playerCount: 3, gameLength: 'tonpuu' });
    const deck = buildTileDeck(rules);

    expect(deck).toHaveLength(108);
    expect(deck.filter((t) => t.isRed).map((t) => t.kind).sort()).toEqual([
      '5p',
      '5s',
    ]);
    expect(new Set(deck.map((t) => t.id)).size).toBe(108);

    const excluded = new Set(['2m', '3m', '4m', '5m', '6m', '7m', '8m']);
    expect(deck.some((t) => excluded.has(t.kind))).toBe(false);
    expect(deck.filter((t) => t.kind === '1m')).toHaveLength(4);
    expect(deck.filter((t) => t.kind === '9m')).toHaveLength(4);

    const shuffled = buildSeededTestDeck(rules, 67890);
    const deal = dealRoundFromDeck(rules, 1, shuffled);
    expect(deal.hands).toHaveLength(3);
    for (const hand of deal.hands) {
      expect(hand).toHaveLength(13);
    }
    expect(countAllDeadWallTiles(deal.deadWall)).toBe(14);
    expect(deal.wall).toHaveLength(108 - 3 * 13 - 1 - 14); // 54

    const allDealtIds = [
      ...deal.hands.flat().map((t) => t.id),
      deal.dealerDrawnTile.id,
      ...deal.wall.map((t) => t.id),
      ...deal.deadWall.rinshanTiles.map((t) => t.id),
      ...deal.deadWall.doraIndicators.map((t) => t.id),
      ...deal.deadWall.uraDoraIndicators.map((t) => t.id),
    ];
    expect(allDealtIds).toHaveLength(108);
    expect(new Set(allDealtIds).size).toBe(108);
  });

  it('同一の山配列を渡すと決定論的に同じ配牌になり、shuffleWithCrypto は全牌を保持する', () => {
    const rules = deriveRules({ playerCount: 4, gameLength: 'hanchan' });
    const fixedA = buildSeededTestDeck(rules, 999);
    const fixedB = buildSeededTestDeck(rules, 1000);

    const d1 = dealRoundFromDeck(rules, 0, fixedA);
    const d2 = dealRoundFromDeck(rules, 0, fixedA);
    const d3 = dealRoundFromDeck(rules, 0, fixedB);

    expect(d1).toEqual(d2);
    expect(d1.wall.map((t) => t.id)).not.toEqual(d3.wall.map((t) => t.id));

    const cryptoShuffled = shuffleWithCrypto(buildTileDeck(rules));
    expect(validateDeckForRules(rules, cryptoShuffled)).toBe(true);
    expect(validateDeckForRules(rules, cryptoShuffled.slice(0, -1))).toBe(false);
  });
});
