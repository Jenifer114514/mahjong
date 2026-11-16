import { describe, expect, it } from 'vitest';
import { ALL_TILE_KINDS, type Tile } from '../../types/tile';
import { analyzeHand, countsFromTiles, handShanten } from '../shanten';

function tiles(kinds: string[], prefix = 't'): Tile[] {
  const used = new Map<string, number>();
  return kinds.map((k) => {
    const n = used.get(k) ?? 0;
    used.set(k, n + 1);
    return { id: `${prefix}-${k}-${n}`, kind: k as Tile['kind'], isRed: false };
  });
}

const counts = (kinds: string[]) => countsFromTiles(tiles(kinds));

describe('shanten', () => {
  it('完成形は -1', () => {
    expect(
      handShanten(counts(['1m','2m','3m','4m','5m','6m','7m','8m','9m','1p','2p','3p','5z','5z']), 0),
    ).toBe(-1);
  });

  it('テンパイは 0、1 シャンテンは 1', () => {
    expect(handShanten(counts(['1m','2m','3m','4m','5m','6m','7m','8m','9m','1p','2p','3p','5z']), 0)).toBe(0);
    expect(handShanten(counts(['1m','2m','3m','4m','5m','6m','7m','8m','9m','1p','2p','5z','6z']), 0)).toBe(1);
  });

  it('七対子・国士無双も考慮する', () => {
    expect(handShanten(counts(['1m','1m','3m','3m','5m','5m','7m','7m','9m','9m','1p','1p','3p']), 0)).toBe(0);
    expect(handShanten(counts(['1m','9m','1p','9p','1s','9s','1z','2z','3z','4z','5z','6z','7z']), 0)).toBe(0);
  });

  it('副露ありでも向聴数を計算できる', () => {
    // 副露2つ + 残り7枚でテンパイ
    expect(handShanten(counts(['1m','2m','3m','4m','5m','6m','7m']), 2)).toBe(0);
  });

  it('受け入れ枚数を返す', () => {
    const c = counts(['1m','2m','3m','4m','5m','6m','7m','8m','9m','1p','2p','3p','5z']);
    const visible = new Array(ALL_TILE_KINDS.length).fill(0);
    const result = analyzeHand(c, 0, visible);
    expect(result.shanten).toBe(0);
    expect(result.ukeire).toBeGreaterThan(0);
  });
});
