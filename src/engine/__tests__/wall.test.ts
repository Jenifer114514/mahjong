import { describe, expect, it } from 'vitest';
import { deriveRules } from '../rules';
import { buildTileDeck, dealRound } from '../wall';

describe('buildTileDeck & dealRound', () => {
  it('4人麻雀: 136枚・赤ドラなし・重複なし・配牌整合性を満たす', () => {
    const rules = deriveRules({ playerCount: 4, gameLength: 'tonpuu' });
    const deck = buildTileDeck(rules);

    expect(deck).toHaveLength(136);
    expect(deck.every((t) => t.isRed === false)).toBe(true);
    expect(new Set(deck.map((t) => t.id)).size).toBe(136);

    const deal = dealRound(rules, 0, 12345);
    expect(deal.hands).toHaveLength(4);
    for (const hand of deal.hands) {
      expect(hand).toHaveLength(13);
    }
    expect(deal.deadWall).toHaveLength(14);
    expect(deal.wall).toHaveLength(136 - 4 * 13 - 1 - 14); // 69

    const allDealtIds = [
      ...deal.hands.flat().map((t) => t.id),
      deal.dealerDrawnTile.id,
      ...deal.wall.map((t) => t.id),
      ...deal.deadWall.map((t) => t.id),
    ];
    expect(allDealtIds).toHaveLength(136);
    expect(new Set(allDealtIds).size).toBe(136);
  });

  it('3人麻雀: 萬子2〜8を除いた108枚・赤ドラなし・配牌整合性を満たす', () => {
    const rules = deriveRules({ playerCount: 3, gameLength: 'tonpuu' });
    const deck = buildTileDeck(rules);

    expect(deck).toHaveLength(108);
    expect(deck.every((t) => t.isRed === false)).toBe(true);
    expect(new Set(deck.map((t) => t.id)).size).toBe(108);

    const excluded = new Set(['2m', '3m', '4m', '5m', '6m', '7m', '8m']);
    expect(deck.some((t) => excluded.has(t.kind))).toBe(false);
    expect(deck.filter((t) => t.kind === '1m')).toHaveLength(4);
    expect(deck.filter((t) => t.kind === '9m')).toHaveLength(4);

    const deal = dealRound(rules, 1, 67890);
    expect(deal.hands).toHaveLength(3);
    for (const hand of deal.hands) {
      expect(hand).toHaveLength(13);
    }
    expect(deal.deadWall).toHaveLength(14);
    expect(deal.wall).toHaveLength(108 - 3 * 13 - 1 - 14); // 54

    const allDealtIds = [
      ...deal.hands.flat().map((t) => t.id),
      deal.dealerDrawnTile.id,
      ...deal.wall.map((t) => t.id),
      ...deal.deadWall.map((t) => t.id),
    ];
    expect(allDealtIds).toHaveLength(108);
    expect(new Set(allDealtIds).size).toBe(108);
  });

  it('同一シードで決定論的に同じ配牌になり、異なるシードでは結果が変わる', () => {
    const rules = deriveRules({ playerCount: 4, gameLength: 'hanchan' });
    const d1 = dealRound(rules, 0, 999);
    const d2 = dealRound(rules, 0, 999);
    const d3 = dealRound(rules, 0, 1000);

    expect(d1).toEqual(d2);
    expect(d1.wall.map((t) => t.id)).not.toEqual(d3.wall.map((t) => t.id));
  });
});
