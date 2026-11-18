import { describe, expect, it } from 'vitest';
import { deriveRules } from '../../engine/rules';
import { ALL_TILE_KINDS, type Tile } from '../../types/tile';
import {
  analyzeHand,
  countsFromTiles,
  handShanten,
  kokushiShanten,
} from '../shanten';

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

  it('3人麻雀では allowedKinds により 2m..8m を受け入れに含めない', () => {
    const sanmaRules = deriveRules({ playerCount: 3, gameLength: 'tonpuu' });
    const allowedKinds = new Set(sanmaRules.allowedTileKinds);
    // 3面子 + 孤立4枚(2シャンテン): 1m にくっつく 2m/3m を受け入れに数えないことを確認
    const c = counts(['1m','2p','3p','4p','5p','6p','7p','2s','3s','4s','8s','5z','6z']);
    const visible = new Array(ALL_TILE_KINDS.length).fill(0);

    const fourP = analyzeHand(c, 0, visible);
    const threeP = analyzeHand(c, 0, visible, allowedKinds);

    expect(threeP.shanten).toBe(fourP.shanten);
    expect(fourP.ukeire - threeP.ukeire).toBe(8);
    expect(kokushiShanten(counts(['1m','9m','1p','9p','1s','9s','1z','2z','3z','4z','5z','6z','7z']))).toBe(0);
  });

  it('3人麻雀では 1m 9m 孤立時や嵌張でも 2m..8m を有効牌に数えない', () => {
    const sanmaRules = deriveRules({ playerCount: 3, gameLength: 'tonpuu' });
    const allowedKinds = new Set(sanmaRules.allowedTileKinds);
    const visible = new Array(ALL_TILE_KINDS.length).fill(0);

    // 1m9m が含まれる2シャンテン: 2m・8m 等は 3人麻雀に存在しないため受け入れが増えない
    const c = counts(['1m','9m','1p','2p','3p','4p','5p','6p','2s','3s','4s','5z','6z']);
    const fourP = analyzeHand(c, 0, visible);
    const threeP = analyzeHand(c, 0, visible, allowedKinds);

    // 4人では 2m(4),3m(4),7m(4),8m(4) の計16枚が受け入れに入るが、3人では 0 枚（差し引き16枚）
    expect(fourP.ukeire - threeP.ukeire).toBe(16);
    expect(fourP.ukeireKinds - threeP.ukeireKinds).toBe(4);
  });

  it('牌種別分割 standardShanten は元の全探索実装と 5,000 局面のランダム手牌・特殊字牌ケースで完全に一致する', async () => {
    const { standardShanten } = await import('../shanten');

    function legacyStandardShanten(counts: readonly number[], meldCount: number): number {
      const c = [...counts];
      let best = 8;
      const evaluate = (m: number, t: number, p: number): void => {
        const mCap = Math.min(m + meldCount, 4);
        const tTotal = t + p;
        const tUse = Math.min(tTotal, 5 - mCap);
        let shanten = 8 - 2 * mCap - tUse;
        if (p === 0 && mCap + tUse === 5) shanten += 1;
        if (shanten < best) best = shanten;
      };
      const search = (startIdx: number, m: number, t: number, p: number): void => {
        let idx = startIdx;
        while (idx < 34 && c[idx] === 0) idx++;
        if (idx >= 34) {
          evaluate(m, t, p);
          return;
        }
        const count = c[idx]!;
        if (count >= 3) {
          c[idx] = count - 3;
          search(idx, m + 1, t, p);
          c[idx] = count;
        }
        if (idx < 27 && idx % 9 <= 6 && c[idx + 1]! > 0 && c[idx + 2]! > 0) {
          c[idx] = count - 1;
          c[idx + 1] = c[idx + 1]! - 1;
          c[idx + 2] = c[idx + 2]! - 1;
          search(idx, m + 1, t, p);
          c[idx] = count;
          c[idx + 1] = c[idx + 1]! + 1;
          c[idx + 2] = c[idx + 2]! + 1;
        }
        if (count >= 2) {
          c[idx] = count - 2;
          search(idx, m, t, p + 1);
          c[idx] = count;
        }
        if (idx < 27 && idx % 9 <= 7 && c[idx + 1]! > 0) {
          c[idx] = count - 1;
          c[idx + 1] = c[idx + 1]! - 1;
          search(idx, m, t + 1, p);
          c[idx] = count;
          c[idx + 1] = c[idx + 1]! + 1;
        }
        if (idx < 27 && idx % 9 <= 6 && c[idx + 2]! > 0) {
          c[idx] = count - 1;
          c[idx + 2] = c[idx + 2]! - 1;
          search(idx, m, t + 1, p);
          c[idx] = count;
          c[idx + 2] = c[idx + 2]! + 1;
        }
        c[idx] = count - 1;
        search(idx, m, t, p);
        c[idx] = count;
      };
      search(0, 0, 0, 0);
      return best;
    }

    // 4枚字牌（mCap>=4 で2対子分解が優れる特殊ケースを含む）
    const edgeCounts = new Array<number>(34).fill(0);
    edgeCounts[0] = 1; edgeCounts[1] = 1; edgeCounts[2] = 1; // 123m
    edgeCounts[9] = 1; edgeCounts[10] = 1; edgeCounts[11] = 1; // 123p
    edgeCounts[18] = 3; // 111s
    edgeCounts[27] = 4; // 1111z (m=3 + 111z triplet vs 11z+11z pairs)
    expect(standardShanten(edgeCounts, 1)).toBe(legacyStandardShanten(edgeCounts, 1));

    // 5000 局面の決定論的ランダム検証
    let seed = 123456789;
    const nextRand = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    for (let trial = 0; trial < 5000; trial++) {
      const meldCount = trial % 5;
      const tileCount = 14 - meldCount * 3 - (trial % 2);
      const counts = new Array<number>(34).fill(0);
      let placed = 0;
      while (placed < tileCount) {
        const idx = Math.floor(nextRand() * 34);
        if (counts[idx]! < 4) {
          counts[idx]!++;
          placed++;
        }
      }
      expect(standardShanten(counts, meldCount)).toBe(
        legacyStandardShanten(counts, meldCount),
      );
      if (trial < 400) {
        // analyzeHand の向聴数・受け入れ種・受け入れ枚数もナイーブ版と完全一致すること
        const visible = new Array<number>(34).fill(0);
        const fast = analyzeHand(counts, meldCount, visible);
        const baseSh = Math.min(
          legacyStandardShanten(counts, meldCount),
          ...(meldCount === 0
            ? [
                (() => {
                  let pairs = 0;
                  let kinds = 0;
                  for (const c of counts) {
                    if (c >= 2) pairs++;
                    if (c >= 1) kinds++;
                  }
                  return 6 - pairs + Math.max(0, 7 - kinds);
                })(),
                kokushiShanten(counts),
              ]
            : []),
        );
        let expUkeire = 0;
        let expKinds = 0;
        const nextC = [...counts];
        for (let idx = 0; idx < 34; idx++) {
          if (nextC[idx]! >= 4) continue;
          nextC[idx]!++;
          const nSh = Math.min(
            legacyStandardShanten(nextC, meldCount),
            ...(meldCount === 0
              ? [
                  (() => {
                    let pairs = 0;
                    let kinds = 0;
                    for (const c of nextC) {
                      if (c >= 2) pairs++;
                      if (c >= 1) kinds++;
                    }
                    return 6 - pairs + Math.max(0, 7 - kinds);
                  })(),
                  kokushiShanten(nextC),
                ]
              : []),
          );
          if (nSh < baseSh) {
            expUkeire += 4 - counts[idx]!;
            expKinds++;
          }
          nextC[idx]!--;
        }
        expect(fast.shanten).toBe(baseSh);
        expect(fast.ukeire).toBe(expUkeire);
        expect(fast.ukeireKinds).toBe(expKinds);
      }
    }
  });
});
