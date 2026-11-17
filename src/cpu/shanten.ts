import type { Tile, TileKind } from '../types/tile';
import { ALL_TILE_KINDS } from '../types/tile';

/**
 * CPU の打牌判断に使う簡易向聴（シャンテン）計算。
 * 牌種インデックスは ALL_TILE_KINDS（0..26: 数牌, 27..33: 字牌）に従う。
 */

export const KIND_COUNT = ALL_TILE_KINDS.length;

const KIND_INDEX = new Map<TileKind, number>(
  ALL_TILE_KINDS.map((kind, idx) => [kind, idx]),
);

const TERMINAL_OR_HONOR_INDICES: readonly number[] = (() => {
  const indices: number[] = [];
  for (const kind of ALL_TILE_KINDS) {
    if (kind.endsWith('z')) {
      indices.push(KIND_INDEX.get(kind)!);
      continue;
    }
    const rank = Number(kind[0]);
    if (rank === 1 || rank === 9) indices.push(KIND_INDEX.get(kind)!);
  }
  return indices;
})();

export function kindIndex(kind: TileKind): number {
  return KIND_INDEX.get(kind) ?? -1;
}

export function countsFromTiles(tiles: readonly Tile[]): number[] {
  const counts = new Array<number>(KIND_COUNT).fill(0);
  for (const tile of tiles) {
    const idx = kindIndex(tile.kind);
    if (idx >= 0) counts[idx] = (counts[idx] ?? 0) + 1;
  }
  return counts;
}

const shantenCache = new Map<string, number>();

function cacheKey(counts: readonly number[], meldCount: number): string {
  return `${meldCount}|${counts.join('')}`;
}

function standardShanten(counts: readonly number[], meldCount: number): number {
  const c = [...counts];
  let best = 8;

  const evaluate = (m: number, t: number, p: number): void => {
    const mCap = Math.min(m + meldCount, 4);
    const tTotal = t + p;
    const tUse = Math.min(tTotal, 5 - mCap);
    let shanten = 8 - 2 * mCap - tUse;
    if (p === 0 && mCap + tUse === 5) {
      shanten += 1;
    }
    if (shanten < best) best = shanten;
  };

  const search = (startIdx: number, m: number, t: number, p: number): void => {
    let idx = startIdx;
    while (idx < KIND_COUNT && c[idx] === 0) idx++;
    if (idx >= KIND_COUNT) {
      evaluate(m, t, p);
      return;
    }

    const count = c[idx]!;

    // 刻子
    if (count >= 3) {
      c[idx] = count - 3;
      search(idx, m + 1, t, p);
      c[idx] = count;
      if (m + meldCount >= 4) {
        // これ以上面子は増やせない
      }
    }

    // 順子（数牌のみ、同一スート内）
    if (idx < 27 && idx % 9 <= 6 && c[idx + 1]! > 0 && c[idx + 2]! > 0) {
      c[idx] = count - 1;
      c[idx + 1] = c[idx + 1]! - 1;
      c[idx + 2] = c[idx + 2]! - 1;
      search(idx, m + 1, t, p);
      c[idx] = count;
      c[idx + 1] = c[idx + 1]! + 1;
      c[idx + 2] = c[idx + 2]! + 1;
    }

    // 対子（= 雀頭候補 / 塔子）
    if (count >= 2) {
      c[idx] = count - 2;
      search(idx, m, t, p + 1);
      c[idx] = count;
    }

    // 塔子（連続・嵌張）
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

    // 使わずに飛ばす
    c[idx] = count - 1;
    search(idx, m, t, p);
    c[idx] = count;
  };

  search(0, 0, 0, 0);
  return best;
}

function chiitoiShanten(counts: readonly number[]): number {
  let pairs = 0;
  let kinds = 0;
  for (const count of counts) {
    if (count >= 2) pairs += 1;
    if (count >= 1) kinds += 1;
  }
  return 6 - pairs + Math.max(0, 7 - kinds);
}

function kokushiShanten(counts: readonly number[]): number {
  let kinds = 0;
  let hasPair = false;
  for (const idx of TERMINAL_OR_HONOR_INDICES) {
    const count = counts[idx] ?? 0;
    if (count >= 1) kinds += 1;
    if (count >= 2) hasPair = true;
  }
  return 13 - kinds - (hasPair ? 1 : 0);
}

/**
 * 手牌（必要なら副露数）の向聴数を返す。0 でテンパイ、-1 で和了。
 * 門前かつ副露なしの場合は七対子・国士無双も考慮する。
 */
export function handShanten(
  counts: readonly number[],
  meldCount: number,
): number {
  const key = cacheKey(counts, meldCount);
  const cached = shantenCache.get(key);
  if (cached !== undefined) return cached;

  let best = standardShanten(counts, meldCount);
  if (meldCount === 0) {
    best = Math.min(best, chiitoiShanten(counts), kokushiShanten(counts));
  }
  if (shantenCache.size > 20000) shantenCache.clear();
  shantenCache.set(key, best);
  return best;
}

/** 見えている牌（自分の手牌・全員の捨て牌・副露・ドラ表示）から残り枚数を求める */
export function buildVisibility(
  tiles: readonly Tile[],
): number[] {
  return countsFromTiles(tiles);
}

export interface ShantenWithUkeire {
  shanten: number;
  /** 有効牌の残り枚数合計（見えている牌を除外） */
  ukeire: number;
  /** 有効な牌種の数 */
  ukeireKinds: number;
}

/**
 * 13 枚（または 3n+1 枚）の手牌について向聴数と受け入れを計算する。
 * `visibleCounts` は他家の捨て牌・副露など既知の牌の枚数（自分の手牌は含めない）。
 */
export function analyzeHand(
  counts: readonly number[],
  meldCount: number,
  visibleCounts: readonly number[],
): ShantenWithUkeire {
  const shanten = handShanten(counts, meldCount);
  let ukeire = 0;
  let ukeireKinds = 0;
  const next = [...counts];
  for (let idx = 0; idx < KIND_COUNT; idx++) {
    if ((next[idx] ?? 0) >= 4) continue;
    next[idx] = (next[idx] ?? 0) + 1;
    if (handShanten(next, meldCount) < shanten) {
      const remaining = 4 - (counts[idx] ?? 0) - (visibleCounts[idx] ?? 0);
      if (remaining > 0) {
        ukeire += remaining;
        ukeireKinds += 1;
      }
    }
    next[idx] = (next[idx] ?? 0) - 1;
  }
  return { shanten, ukeire, ukeireKinds };
}
