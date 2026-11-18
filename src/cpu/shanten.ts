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

const shantenSuitCache = new Map<number, Int8Array>();
const EMPTY_SUIT_RESULT = new Int8Array([0, -1, -1, -1, -1, -1, -1, -1, -1, -1]);

function solveSuit(counts: readonly number[], offset: number): Int8Array {
  const c0 = counts[offset]!;
  const c1 = counts[offset + 1]!;
  const c2 = counts[offset + 2]!;
  const c3 = counts[offset + 3]!;
  const c4 = counts[offset + 4]!;
  const c5 = counts[offset + 5]!;
  const c6 = counts[offset + 6]!;
  const c7 = counts[offset + 7]!;
  const c8 = counts[offset + 8]!;

  const code =
    c0 +
    5 * (c1 + 5 * (c2 + 5 * (c3 + 5 * (c4 + 5 * (c5 + 5 * (c6 + 5 * (c7 + 5 * c8)))))));
  if (code === 0) return EMPTY_SUIT_RESULT;

  const cached = shantenSuitCache.get(code);
  if (cached) return cached;

  const c = [c0, c1, c2, c3, c4, c5, c6, c7, c8];
  const res = new Int8Array(10).fill(-1);

  const search = (startIdx: number, m: number, t: number, p: number): void => {
    let idx = startIdx;
    while (idx < 9 && c[idx] === 0) idx++;
    if (idx >= 9) {
      const mIdx = m > 4 ? 4 : m;
      const slot = (mIdx << 1) | (p > 0 ? 1 : 0);
      const tTotal = t + p;
      if (tTotal > res[slot]!) res[slot] = tTotal;
      return;
    }

    const count = c[idx]!;

    // 刻子
    if (count >= 3) {
      c[idx] = count - 3;
      search(idx, m + 1, t, p);
      c[idx] = count;
    }

    // 順子
    if (idx <= 6 && c[idx + 1]! > 0 && c[idx + 2]! > 0) {
      c[idx] = count - 1;
      c[idx + 1]!--;
      c[idx + 2]!--;
      search(idx, m + 1, t, p);
      c[idx] = count;
      c[idx + 1]!++;
      c[idx + 2]!++;
    }

    // 対子
    if (count >= 2) {
      c[idx] = count - 2;
      search(idx, m, t, p + 1);
      c[idx] = count;
    }

    // 塔子（連続・嵌張）
    if (idx <= 7 && c[idx + 1]! > 0) {
      c[idx] = count - 1;
      c[idx + 1]!--;
      search(idx, m, t + 1, p);
      c[idx] = count;
      c[idx + 1]!++;
    }
    if (idx <= 6 && c[idx + 2]! > 0) {
      c[idx] = count - 1;
      c[idx + 2]!--;
      search(idx, m, t + 1, p);
      c[idx] = count;
      c[idx + 2]!++;
    }

    // 孤立牌として飛ばす
    c[idx] = count - 1;
    search(idx, m, t, p);
    c[idx] = count;
  };

  search(0, 0, 0, 0);
  if (shantenSuitCache.size > 100000) shantenSuitCache.clear();
  shantenSuitCache.set(code, res);
  return res;
}

function mergeSuitStates(acc: Int8Array, next: Int8Array, out: Int8Array): void {
  out.fill(-1);
  for (let i = 0; i < 10; i++) {
    const aT = acc[i]!;
    if (aT < 0) continue;
    const aM = i >> 1;
    const aP = i & 1;
    for (let j = 0; j < 10; j++) {
      const bT = next[j]!;
      if (bT < 0) continue;
      const m = aM + (j >> 1);
      const mCap = m > 4 ? 4 : m;
      const hp = aP | (j & 1);
      const slot = (mCap << 1) | hp;
      const sumT = aT + bT;
      if (sumT > out[slot]!) out[slot] = sumT;
    }
  }
}

const workA = new Int8Array(10);
const workB = new Int8Array(10);
const honorBuf = new Int8Array(10);
const honorNext = new Int8Array(10);

export function standardShanten(counts: readonly number[], meldCount: number): number {
  const man = solveSuit(counts, 0);
  const pin = solveSuit(counts, 9);
  const sou = solveSuit(counts, 18);

  // 字牌 (27..33): 順子がないため閉形式で集計
  let basePairs = 0;
  let k3 = 0;
  let k4 = 0;
  for (let idx = 27; idx < 34; idx++) {
    const cnt = counts[idx]!;
    if (cnt === 2) basePairs += 1;
    else if (cnt === 3) k3 += 1;
    else if (cnt >= 4) k4 += 1;
  }

  let acc: Int8Array;
  if (k3 === 0 && k4 === 0) {
    honorBuf.fill(-1);
    honorBuf[basePairs > 0 ? 1 : 0] = basePairs;
    acc = honorBuf;
  } else {
    honorBuf.fill(-1);
    honorBuf[basePairs > 0 ? 1 : 0] = basePairs;
    for (let i = 0; i < k3; i++) {
      honorNext.fill(-1);
      for (let s = 0; s < 10; s++) {
        const curT = honorBuf[s]!;
        if (curT < 0) continue;
        const m = s >> 1;
        const hp = s & 1;
        // 刻子として使う
        const m1 = m >= 4 ? 4 : m + 1;
        const slotM = (m1 << 1) | hp;
        if (curT > honorNext[slotM]!) honorNext[slotM] = curT;
        // 対子として使う
        const slotP = (m << 1) | 1;
        if (curT + 1 > honorNext[slotP]!) honorNext[slotP] = curT + 1;
      }
      honorBuf.set(honorNext);
    }
    for (let i = 0; i < k4; i++) {
      honorNext.fill(-1);
      for (let s = 0; s < 10; s++) {
        const curT = honorBuf[s]!;
        if (curT < 0) continue;
        const m = s >> 1;
        const hp = s & 1;
        // 刻子として使う
        const m1 = m >= 4 ? 4 : m + 1;
        const slotM = (m1 << 1) | hp;
        if (curT > honorNext[slotM]!) honorNext[slotM] = curT;
        // 2対子として使う
        const slotP = (m << 1) | 1;
        if (curT + 2 > honorNext[slotP]!) honorNext[slotP] = curT + 2;
      }
      honorBuf.set(honorNext);
    }
    acc = honorBuf;
  }

  workA.set(acc);
  if (man !== EMPTY_SUIT_RESULT) {
    mergeSuitStates(workA, man, workB);
    workA.set(workB);
  }
  if (pin !== EMPTY_SUIT_RESULT) {
    mergeSuitStates(workA, pin, workB);
    workA.set(workB);
  }
  if (sou !== EMPTY_SUIT_RESULT) {
    mergeSuitStates(workA, sou, workB);
    workA.set(workB);
  }

  let best = 8;
  for (let s = 0; s < 10; s++) {
    const tTotal = workA[s]!;
    if (tTotal < 0) continue;
    const m = s >> 1;
    const hasPair = s & 1;
    const mCap = Math.min(m + meldCount, 4);
    const tUse = Math.min(tTotal, 5 - mCap);
    let shanten = 8 - 2 * mCap - tUse;
    if (hasPair === 0 && mCap + tUse === 5) {
      shanten += 1;
    }
    if (shanten < best) best = shanten;
  }
  return best;
}

function chiitoiShanten(counts: readonly number[]): number {
  let pairs = 0;
  let kinds = 0;
  for (let i = 0; i < KIND_COUNT; i++) {
    const count = counts[i]!;
    if (count >= 2) pairs += 1;
    if (count >= 1) kinds += 1;
  }
  return 6 - pairs + Math.max(0, 7 - kinds);
}

export function kokushiShanten(counts: readonly number[]): number {
  let kinds = 0;
  let hasPair = false;
  for (let i = 0; i < TERMINAL_OR_HONOR_INDICES.length; i++) {
    const count = counts[TERMINAL_OR_HONOR_INDICES[i]!]!;
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
  let best = standardShanten(counts, meldCount);
  if (meldCount === 0) {
    const chiitoi = chiitoiShanten(counts);
    if (chiitoi < best) best = chiitoi;
    const kokushi = kokushiShanten(counts);
    if (kokushi < best) best = kokushi;
  }
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
 * `visibleCounts` は他家の捨て牌・副露・抜北・自分の副露/抜北など手牌外の既知枚数。
 * `allowedKinds` を渡した場合は使用牌種（3人麻雀での 2m..8m 除外等）だけを有効牌として数える。
 */
export function analyzeHand(
  counts: readonly number[],
  meldCount: number,
  visibleCounts: readonly number[],
  allowedKinds?: ReadonlySet<TileKind>,
  copiesPerKind = 4,
): ShantenWithUkeire {
  const man = solveSuit(counts, 0);
  const pin = solveSuit(counts, 9);
  const sou = solveSuit(counts, 18);

  // 字牌 (27..33) の基礎状態
  const honorBase = new Int8Array(10).fill(-1);
  let hBasePairs = 0;
  let k3 = 0;
  let k4 = 0;
  for (let idx = 27; idx < 34; idx++) {
    const cnt = counts[idx]!;
    if (cnt === 2) hBasePairs += 1;
    else if (cnt === 3) k3 += 1;
    else if (cnt >= 4) k4 += 1;
  }
  honorBase[hBasePairs > 0 ? 1 : 0] = hBasePairs;
  for (let i = 0; i < k3; i++) {
    honorNext.fill(-1);
    for (let s = 0; s < 10; s++) {
      const curT = honorBase[s]!;
      if (curT < 0) continue;
      const m = s >> 1;
      const hp = s & 1;
      const m1 = m >= 4 ? 4 : m + 1;
      const slotM = (m1 << 1) | hp;
      if (curT > honorNext[slotM]!) honorNext[slotM] = curT;
      const slotP = (m << 1) | 1;
      if (curT + 1 > honorNext[slotP]!) honorNext[slotP] = curT + 1;
    }
    honorBase.set(honorNext);
  }
  for (let i = 0; i < k4; i++) {
    honorNext.fill(-1);
    for (let s = 0; s < 10; s++) {
      const curT = honorBase[s]!;
      if (curT < 0) continue;
      const m = s >> 1;
      const hp = s & 1;
      const m1 = m >= 4 ? 4 : m + 1;
      const slotM = (m1 << 1) | hp;
      if (curT > honorNext[slotM]!) honorNext[slotM] = curT;
      const slotP = (m << 1) | 1;
      if (curT + 2 > honorNext[slotP]!) honorNext[slotP] = curT + 2;
    }
    honorBase.set(honorNext);
  }

  const evalCombined = (combined: Int8Array): number => {
    let best = 8;
    for (let s = 0; s < 10; s++) {
      const tTotal = combined[s]!;
      if (tTotal < 0) continue;
      const m = s >> 1;
      const hasPair = s & 1;
      const mCap = Math.min(m + meldCount, 4);
      const tUse = Math.min(tTotal, 5 - mCap);
      let sh = 8 - 2 * mCap - tUse;
      if (hasPair === 0 && mCap + tUse === 5) sh += 1;
      if (sh < best) best = sh;
    }
    return best;
  };

  // 七対子・国士の基礎統計を1回だけ集計
  let baseChiitoiPairs = 0;
  let baseChiitoiKinds = 0;
  for (let i = 0; i < KIND_COUNT; i++) {
    const c = counts[i]!;
    if (c >= 2) baseChiitoiPairs++;
    if (c >= 1) baseChiitoiKinds++;
  }
  let baseKokushiKinds = 0;
  let baseKokushiPairCount = 0;
  if (meldCount === 0) {
    for (let i = 0; i < TERMINAL_OR_HONOR_INDICES.length; i++) {
      const c = counts[TERMINAL_OR_HONOR_INDICES[i]!]!;
      if (c >= 1) baseKokushiKinds++;
      if (c >= 2) baseKokushiPairCount++;
    }
  }

  // 各スートを除いた 3 部分の合成テーブルを事前に作る（ループ内で1回だけ合算）
  const withoutMan = new Int8Array(honorBase);
  if (pin !== EMPTY_SUIT_RESULT) { mergeSuitStates(withoutMan, pin, workB); withoutMan.set(workB); }
  if (sou !== EMPTY_SUIT_RESULT) { mergeSuitStates(withoutMan, sou, workB); withoutMan.set(workB); }

  const withoutPin = new Int8Array(honorBase);
  if (man !== EMPTY_SUIT_RESULT) { mergeSuitStates(withoutPin, man, workB); withoutPin.set(workB); }
  if (sou !== EMPTY_SUIT_RESULT) { mergeSuitStates(withoutPin, sou, workB); withoutPin.set(workB); }

  const withoutSou = new Int8Array(honorBase);
  if (man !== EMPTY_SUIT_RESULT) { mergeSuitStates(withoutSou, man, workB); withoutSou.set(workB); }
  if (pin !== EMPTY_SUIT_RESULT) { mergeSuitStates(withoutSou, pin, workB); withoutSou.set(workB); }

  const allSuits = new Int8Array(man);
  if (pin !== EMPTY_SUIT_RESULT) { mergeSuitStates(allSuits, pin, workB); allSuits.set(workB); }
  if (sou !== EMPTY_SUIT_RESULT) { mergeSuitStates(allSuits, sou, workB); allSuits.set(workB); }

  // 元のシャンテン数
  mergeSuitStates(withoutMan, man, workB);
  let shanten = evalCombined(workB);
  if (meldCount === 0) {
    const chiitoi = 6 - baseChiitoiPairs + Math.max(0, 7 - baseChiitoiKinds);
    const kokushi = 13 - baseKokushiKinds - (baseKokushiPairCount > 0 ? 1 : 0);
    if (chiitoi < shanten) shanten = chiitoi;
    if (kokushi < shanten) shanten = kokushi;
  }

  let ukeire = 0;
  let ukeireKinds = 0;
  const next = [...counts];

  for (let idx = 0; idx < KIND_COUNT; idx++) {
    const kind = ALL_TILE_KINDS[idx]!;
    if (allowedKinds && !allowedKinds.has(kind)) continue;
    const prevC = next[idx]!;
    if (prevC >= copiesPerKind) continue;

    next[idx] = prevC + 1;

    let nextSh: number;
    if (idx < 9) {
      const nextMan = solveSuit(next, 0);
      mergeSuitStates(withoutMan, nextMan, workB);
      nextSh = evalCombined(workB);
    } else if (idx < 18) {
      const nextPin = solveSuit(next, 9);
      mergeSuitStates(withoutPin, nextPin, workB);
      nextSh = evalCombined(workB);
    } else if (idx < 27) {
      const nextSou = solveSuit(next, 18);
      mergeSuitStates(withoutSou, nextSou, workB);
      nextSh = evalCombined(workB);
    } else {
      // 字牌 idx に +1: 新規孤立(prevC===0) は通常形を改善しないため既存 allSuits+honorBase 相当
      const newPairs = hBasePairs + (prevC === 1 ? 1 : 0) - (prevC === 2 ? 1 : 0);
      const newK3 = k3 + (prevC === 2 ? 1 : 0) - (prevC === 3 ? 1 : 0);
      const newK4 = k4 + (prevC === 3 ? 1 : 0);
      honorBuf.fill(-1);
      honorBuf[newPairs > 0 ? 1 : 0] = newPairs;
      for (let i = 0; i < newK3; i++) {
        honorNext.fill(-1);
        for (let s = 0; s < 10; s++) {
          const curT = honorBuf[s]!;
          if (curT < 0) continue;
          const m = s >> 1;
          const hp = s & 1;
          const m1 = m >= 4 ? 4 : m + 1;
          const slotM = (m1 << 1) | hp;
          if (curT > honorNext[slotM]!) honorNext[slotM] = curT;
          const slotP = (m << 1) | 1;
          if (curT + 1 > honorNext[slotP]!) honorNext[slotP] = curT + 1;
        }
        honorBuf.set(honorNext);
      }
      for (let i = 0; i < newK4; i++) {
        honorNext.fill(-1);
        for (let s = 0; s < 10; s++) {
          const curT = honorBuf[s]!;
          if (curT < 0) continue;
          const m = s >> 1;
          const hp = s & 1;
          const m1 = m >= 4 ? 4 : m + 1;
          const slotM = (m1 << 1) | hp;
          if (curT > honorNext[slotM]!) honorNext[slotM] = curT;
          const slotP = (m << 1) | 1;
          if (curT + 2 > honorNext[slotP]!) honorNext[slotP] = curT + 2;
        }
        honorBuf.set(honorNext);
      }
      mergeSuitStates(allSuits, honorBuf, workB);
      nextSh = evalCombined(workB);
    }

    if (meldCount === 0) {
      const nPairs = baseChiitoiPairs + (prevC === 1 ? 1 : 0);
      const nKinds = baseChiitoiKinds + (prevC === 0 ? 1 : 0);
      const chiitoi = 6 - nPairs + Math.max(0, 7 - nKinds);
      if (chiitoi < nextSh) nextSh = chiitoi;

      if (isTerminalOrHonorIdx(idx)) {
        const nkKinds = baseKokushiKinds + (prevC === 0 ? 1 : 0);
        const nkPair = baseKokushiPairCount > 0 || prevC === 1;
        const kokushi = 13 - nkKinds - (nkPair ? 1 : 0);
        if (kokushi < nextSh) nextSh = kokushi;
      }
    }

    next[idx] = prevC;

    if (nextSh < shanten) {
      const remaining = copiesPerKind - prevC - visibleCounts[idx]!;
      if (remaining > 0) {
        ukeire += remaining;
        ukeireKinds += 1;
      }
    }
  }
  return { shanten, ukeire, ukeireKinds };
}

function isTerminalOrHonorIdx(idx: number): boolean {
  if (idx >= 27) return true;
  const r = idx % 9;
  return r === 0 || r === 8;
}
