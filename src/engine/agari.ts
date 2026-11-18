import type { DerivedRules } from '../types/rule';
import type { Meld } from '../types/state';
import { ALL_TILE_KINDS, type Tile, type TileKind } from '../types/tile';

export type MachiType = 'ryanmen' | 'kanchan' | 'penchan' | 'tanki' | 'shanpon';

export interface AgariMentsu {
  type: 'shuntsu' | 'koutsu' | 'kantsu';
  kinds: TileKind[];
  isOpen: boolean;
}

export interface StandardAgariDecomposition {
  form: 'standard';
  pairKind: TileKind;
  mentsu: AgariMentsu[];
  machi: MachiType;
  winningKind: TileKind;
  isMenzen: boolean;
}

export interface ChiitoitsuAgariDecomposition {
  form: 'chiitoitsu';
  pairKinds: TileKind[];
  machi: 'tanki';
  winningKind: TileKind;
  isMenzen: true;
}

export interface KokushiAgariDecomposition {
  form: 'kokushi';
  pairKind: TileKind;
  is13Wait: boolean;
  winningKind: TileKind;
  isMenzen: true;
}

export type AgariDecomposition =
  | StandardAgariDecomposition
  | ChiitoitsuAgariDecomposition
  | KokushiAgariDecomposition;

const KIND_TO_INDEX = new Map<TileKind, number>(
  ALL_TILE_KINDS.map((k, idx) => [k, idx]),
);

const KOKUSHI_KINDS: readonly TileKind[] = [
  '1m', '9m',
  '1p', '9p',
  '1s', '9s',
  '1z', '2z', '3z', '4z', '5z', '6z', '7z',
];

const KOKUSHI_SET = new Set<TileKind>(KOKUSHI_KINDS);

function toCounts(kinds: readonly TileKind[]): number[] {
  const counts = new Array<number>(ALL_TILE_KINDS.length).fill(0);
  for (const kind of kinds) {
    const idx = KIND_TO_INDEX.get(kind);
    if (idx !== undefined) {
      counts[idx] = counts[idx]! + 1;
    }
  }
  return counts;
}

function getShuntsuMachi(
  shuntsuKinds: readonly TileKind[],
  winningKind: TileKind,
): MachiType {
  const k0 = shuntsuKinds[0]!;
  const k1 = shuntsuKinds[1]!;
  const k2 = shuntsuKinds[2]!;
  if (winningKind === k1) {
    return 'kanchan';
  }
  const r0 = Number(k0[0]);
  const r2 = Number(k2[0]);
  if (winningKind === k2 && r0 === 1) {
    return 'penchan';
  }
  if (winningKind === k0 && r2 === 9) {
    return 'penchan';
  }
  return 'ryanmen';
}

function extractClosedMentsu(
  counts: number[],
  needed: number,
  current: AgariMentsu[],
  results: AgariMentsu[][],
): void {
  if (needed === 0) {
    if (counts.every((c) => c === 0)) {
      results.push(current.map((m) => ({ ...m, kinds: [...m.kinds] })));
    }
    return;
  }

  let firstIdx = -1;
  for (let i = 0; i < counts.length; i++) {
    if (counts[i]! > 0) {
      firstIdx = i;
      break;
    }
  }
  if (firstIdx === -1) return;

  const firstKind = ALL_TILE_KINDS[firstIdx]!;

  // 1. 刻子を試す
  if (counts[firstIdx]! >= 3) {
    counts[firstIdx] = counts[firstIdx]! - 3;
    current.push({
      type: 'koutsu',
      kinds: [firstKind, firstKind, firstKind],
      isOpen: false,
    });
    extractClosedMentsu(counts, needed - 1, current, results);
    current.pop();
    counts[firstIdx] = counts[firstIdx]! + 3;
  }

  // 2. 順子を試す（数牌 1..7 のみ）
  if (firstIdx < 27) {
    const rank = (firstIdx % 9) + 1;
    if (
      rank <= 7 &&
      counts[firstIdx + 1]! >= 1 &&
      counts[firstIdx + 2]! >= 1
    ) {
      const k1 = ALL_TILE_KINDS[firstIdx + 1]!;
      const k2 = ALL_TILE_KINDS[firstIdx + 2]!;
      counts[firstIdx] = counts[firstIdx]! - 1;
      counts[firstIdx + 1] = counts[firstIdx + 1]! - 1;
      counts[firstIdx + 2] = counts[firstIdx + 2]! - 1;
      current.push({
        type: 'shuntsu',
        kinds: [firstKind, k1, k2],
        isOpen: false,
      });
      extractClosedMentsu(counts, needed - 1, current, results);
      current.pop();
      counts[firstIdx] = counts[firstIdx]! + 1;
      counts[firstIdx + 1] = counts[firstIdx + 1]! + 1;
      counts[firstIdx + 2] = counts[firstIdx + 2]! + 1;
    }
  }
}

function serializeStandardDecomp(d: StandardAgariDecomposition): string {
  const mentsuSig = d.mentsu
    .map((m) => `${m.type}:${m.isOpen ? 'O' : 'C'}:${m.kinds.join(',')}`)
    .sort()
    .join('|');
  return `${d.pairKind}|${d.machi}|${mentsuSig}`;
}

export function enumerateAgariDecompositions(
  handWithoutWin: readonly Tile[],
  melds: readonly Meld[],
  winningKind: TileKind,
  isTsumo: boolean,
): AgariDecomposition[] {
  const expectedClosedCount = (4 - melds.length) * 3 + 2;
  const closedKinds: TileKind[] = [
    ...handWithoutWin.map((t) => t.kind),
    winningKind,
  ];
  if (closedKinds.length !== expectedClosedCount) {
    return [];
  }

  const isMenzen = melds.every((m) => m.type === 'ankan');
  const results: AgariDecomposition[] = [];
  const counts = toCounts(closedKinds);

  // 1. 国士無双（門前・副露なしのみ）
  if (melds.length === 0) {
    const allYaochu = closedKinds.every((k) => KOKUSHI_SET.has(k));
    if (allYaochu) {
      let pairKind: TileKind | null = null;
      let validKokushi = true;
      for (const k of KOKUSHI_KINDS) {
        const c = counts[KIND_TO_INDEX.get(k)!]!;
        if (c === 0) {
          validKokushi = false;
          break;
        }
        if (c === 2) {
          if (pairKind !== null) {
            validKokushi = false;
            break;
          }
          pairKind = k;
        } else if (c !== 1) {
          validKokushi = false;
          break;
        }
      }
      if (validKokushi && pairKind !== null) {
        results.push({
          form: 'kokushi',
          pairKind,
          is13Wait: pairKind === winningKind,
          winningKind,
          isMenzen: true,
        });
      }
    }
  }

  // 2. 七対子（門前・副露なし・7種各2枚のみ）
  if (melds.length === 0) {
    const pairKinds: TileKind[] = [];
    let validChiitoitsu = true;
    for (let i = 0; i < counts.length; i++) {
      const c = counts[i]!;
      if (c === 0) continue;
      if (c !== 2) {
        validChiitoitsu = false;
        break;
      }
      pairKinds.push(ALL_TILE_KINDS[i]!);
    }
    if (validChiitoitsu && pairKinds.length === 7) {
      results.push({
        form: 'chiitoitsu',
        pairKinds,
        machi: 'tanki',
        winningKind,
        isMenzen: true,
      });
    }
  }

  // 3. 通常形（4面子1雀頭）
  const fixedMentsu: AgariMentsu[] = melds.map((m) => ({
    type:
      m.type === 'chi'
        ? 'shuntsu'
        : m.type === 'pon'
          ? 'koutsu'
          : 'kantsu',
    kinds: m.tiles.map((t) => t.kind),
    isOpen: m.type !== 'ankan',
  }));

  const neededClosedMentsu = 4 - fixedMentsu.length;
  const seenKeys = new Set<string>();

  for (let pairIdx = 0; pairIdx < counts.length; pairIdx++) {
    if (counts[pairIdx]! < 2) continue;
    const pairKind = ALL_TILE_KINDS[pairIdx]!;
    counts[pairIdx] = counts[pairIdx]! - 2;

    const closedLists: AgariMentsu[][] = [];
    extractClosedMentsu(counts, neededClosedMentsu, [], closedLists);

    for (const closedList of closedLists) {
      // パターンA: 和了牌が雀頭を完成させた（単騎待ち）
      if (pairKind === winningKind) {
        const decomp: StandardAgariDecomposition = {
          form: 'standard',
          pairKind,
          mentsu: [
            ...closedList.map((m) => ({ ...m, kinds: [...m.kinds] })),
            ...fixedMentsu.map((m) => ({ ...m, kinds: [...m.kinds] })),
          ],
          machi: 'tanki',
          winningKind,
          isMenzen,
        };
        const key = serializeStandardDecomp(decomp);
        if (!seenKeys.has(key)) {
          seenKeys.add(key);
          results.push(decomp);
        }
      }

      // パターンB: 和了牌がいずれかの門前面子を完成させた
      for (let mIdx = 0; mIdx < closedList.length; mIdx++) {
        const target = closedList[mIdx]!;
        if (!target.kinds.includes(winningKind)) continue;

        const machi: MachiType =
          target.type === 'koutsu'
            ? 'shanpon'
            : getShuntsuMachi(target.kinds, winningKind);

        const nextClosed = closedList.map((m, idx) => {
          if (idx !== mIdx) {
            return { ...m, kinds: [...m.kinds] };
          }
          // ロンで完成した刻子は明刻扱い
          const isOpen = m.type === 'koutsu' && !isTsumo;
          return { ...m, kinds: [...m.kinds], isOpen };
        });

        const decomp: StandardAgariDecomposition = {
          form: 'standard',
          pairKind,
          mentsu: [
            ...nextClosed,
            ...fixedMentsu.map((m) => ({ ...m, kinds: [...m.kinds] })),
          ],
          machi,
          winningKind,
          isMenzen,
        };
        const key = serializeStandardDecomp(decomp);
        if (!seenKeys.has(key)) {
          seenKeys.add(key);
          results.push(decomp);
        }
      }
    }

    counts[pairIdx] = counts[pairIdx]! + 2;
  }

  return results;
}

export function countKindInHandAndMelds(
  hand: readonly Tile[],
  melds: readonly Meld[],
  kind: TileKind,
): number {
  let count = 0;
  for (const t of hand) {
    if (t.kind === kind) count++;
  }
  for (const m of melds) {
    for (const t of m.tiles) {
      if (t.kind === kind) count++;
    }
  }
  return count;
}

const KOKUSHI_INDICES: readonly number[] = KOKUSHI_KINDS.map(
  (k) => KIND_TO_INDEX.get(k)!,
);

function canExtractMentsuFast(
  counts: number[],
  needed: number,
  startIdx: number,
): boolean {
  if (needed === 0) return true;
  let i = startIdx;
  while (i < 34 && counts[i] === 0) i++;
  if (i >= 34) return false;

  const c = counts[i]!;
  if (c >= 3) {
    counts[i] = c - 3;
    if (canExtractMentsuFast(counts, needed - 1, i)) {
      counts[i] = c;
      return true;
    }
    counts[i] = c;
  }
  if (i < 27 && i % 9 <= 6 && counts[i + 1]! > 0 && counts[i + 2]! > 0) {
    counts[i] = c - 1;
    counts[i + 1]!--;
    counts[i + 2]!--;
    if (canExtractMentsuFast(counts, needed - 1, i)) {
      counts[i] = c;
      counts[i + 1]!++;
      counts[i + 2]!++;
      return true;
    }
    counts[i] = c;
    counts[i + 1]!++;
    counts[i + 2]!++;
  }
  return false;
}

function canFormAgariFast(counts: number[], meldCount: number): boolean {
  if (meldCount === 0) {
    // 1. 国士無双チェック
    let kokushiDistinct = 0;
    let kokushiPair = false;
    let kokushiTotal = 0;
    for (let k = 0; k < KOKUSHI_INDICES.length; k++) {
      const c = counts[KOKUSHI_INDICES[k]!]!;
      if (c >= 1) {
        kokushiDistinct++;
        kokushiTotal += c;
        if (c === 2) kokushiPair = true;
      }
    }
    if (kokushiDistinct === 13 && kokushiTotal === 14 && kokushiPair) {
      return true;
    }

    // 2. 七対子チェック
    let pairs = 0;
    let nonPair = false;
    for (let i = 0; i < 34; i++) {
      const c = counts[i]!;
      if (c === 2) pairs++;
      else if (c !== 0) {
        nonPair = true;
        break;
      }
    }
    if (!nonPair && pairs === 7) return true;
  }

  // 3. 通常形（4面子1雀頭）
  const needed = 4 - meldCount;
  for (let pairIdx = 0; pairIdx < 34; pairIdx++) {
    const c = counts[pairIdx]!;
    if (c < 2) continue;
    counts[pairIdx] = c - 2;
    const ok = canExtractMentsuFast(counts, needed, 0);
    counts[pairIdx] = c;
    if (ok) return true;
  }
  return false;
}

/** フリテン・後付け判定用: 現在の手牌＋副露で和了形が完成する待ち牌種をすべて返す */
export function getTenpaiWaitKinds(
  hand: readonly Tile[],
  melds: readonly Meld[],
  rules: DerivedRules,
): TileKind[] {
  const expectedHandCount = (4 - melds.length) * 3 + 1;
  if (hand.length !== expectedHandCount) {
    return [];
  }

  const handCounts = new Array<number>(ALL_TILE_KINDS.length).fill(0);
  for (let i = 0; i < hand.length; i++) {
    const idx = KIND_TO_INDEX.get(hand[i]!.kind);
    if (idx !== undefined) handCounts[idx]!++;
  }
  const totalCounts = [...handCounts];
  for (let i = 0; i < melds.length; i++) {
    const meldTiles = melds[i]!.tiles;
    for (let j = 0; j < meldTiles.length; j++) {
      const idx = KIND_TO_INDEX.get(meldTiles[j]!.kind);
      if (idx !== undefined) totalCounts[idx]!++;
    }
  }

  let kokushiBaseKinds = 0;
  if (melds.length === 0) {
    for (let k = 0; k < KOKUSHI_INDICES.length; k++) {
      if (handCounts[KOKUSHI_INDICES[k]!]! > 0) kokushiBaseKinds++;
    }
  }
  const canTryKokushi = melds.length === 0 && kokushiBaseKinds >= 12;

  const copiesPerKind = rules.tileSet.copiesPerKind;
  const allowed = rules.allowedTileKinds;
  const waits: TileKind[] = [];

  for (let i = 0; i < allowed.length; i++) {
    const kind = allowed[i]!;
    const idx = KIND_TO_INDEX.get(kind)!;
    if (totalCounts[idx]! >= copiesPerKind) {
      continue;
    }

    const hc = handCounts[idx]!;
    let isRelevant = hc >= 1;
    if (!isRelevant && idx < 27) {
      const r = idx % 9;
      isRelevant =
        (r >= 2 && handCounts[idx - 2]! > 0 && handCounts[idx - 1]! > 0) ||
        (r >= 1 && r <= 7 && handCounts[idx - 1]! > 0 && handCounts[idx + 1]! > 0) ||
        (r <= 6 && handCounts[idx + 1]! > 0 && handCounts[idx + 2]! > 0);
    }
    if (!isRelevant && canTryKokushi && KOKUSHI_SET.has(kind)) {
      isRelevant = true;
    }
    if (!isRelevant) continue;

    handCounts[idx] = hc + 1;
    const wins = canFormAgariFast(handCounts, melds.length);
    handCounts[idx] = hc;
    if (wins) {
      waits.push(kind);
    }
  }
  return waits;
}

/** リーチ宣言時に切って聴牌を維持できる牌ID一覧を返す */
export function getCanRiichiDiscardTileIds(
  hand: readonly Tile[],
  drawnTile: Tile | null,
  melds: readonly Meld[],
  rules: DerivedRules,
): string[] {
  if (drawnTile === null) return [];
  if (!melds.every((m) => m.type === 'ankan')) return [];

  const allTiles = [...hand, drawnTile];
  const expectedAfterDiscard = (4 - melds.length) * 3 + 1;
  if (allTiles.length - 1 !== expectedAfterDiscard) {
    return [];
  }

  // 高速枝刈り: 孤立牌（対子・刻子・隣接牌なし）が 3 枚以上あれば、
  // 1枚切っても 2枚以上の孤立牌が残るため国士無双以外では聴牌にならない
  const allCounts = new Array<number>(ALL_TILE_KINDS.length).fill(0);
  for (let i = 0; i < allTiles.length; i++) {
    const idx = KIND_TO_INDEX.get(allTiles[i]!.kind);
    if (idx !== undefined) allCounts[idx]!++;
  }
  let kokushiKinds = 0;
  if (melds.length === 0) {
    for (let k = 0; k < KOKUSHI_INDICES.length; k++) {
      if (allCounts[KOKUSHI_INDICES[k]!]! > 0) kokushiKinds++;
    }
  }
  if (kokushiKinds < 12) {
    let isolatedSingles = 0;
    for (let idx = 0; idx < 34; idx++) {
      if (allCounts[idx] !== 1) continue;
      if (idx >= 27) {
        isolatedSingles++;
      } else {
        const r = idx % 9;
        const hasNeighbor =
          (r >= 1 && allCounts[idx - 1]! > 0) ||
          (r >= 2 && allCounts[idx - 2]! > 0) ||
          (r <= 7 && allCounts[idx + 1]! > 0) ||
          (r <= 6 && allCounts[idx + 2]! > 0);
        if (!hasNeighbor) isolatedSingles++;
      }
      if (isolatedSingles >= 3) return [];
    }
  }

  const result: string[] = [];
  const checkedKinds = new Map<TileKind, boolean>();

  for (let i = 0; i < allTiles.length; i++) {
    const candidate = allTiles[i]!;
    const cached = checkedKinds.get(candidate.kind);
    if (cached !== undefined) {
      if (cached) result.push(candidate.id);
      continue;
    }

    const remaining = allTiles.filter((_, idx) => idx !== i);
    const isTenpai = getTenpaiWaitKinds(remaining, melds, rules).length > 0;
    checkedKinds.set(candidate.kind, isTenpai);
    if (isTenpai) {
      result.push(candidate.id);
    }
  }

  return result;
}

/** リーチ後の暗槓で待ち牌の集合が変わらないかを判定する */
export function canAnkanPreserveRiichiWaits(
  hand: readonly Tile[],
  drawnTile: Tile | null,
  melds: readonly Meld[],
  ankanKind: TileKind,
  rules: DerivedRules,
): boolean {
  if (drawnTile === null) return false;
  if (drawnTile.kind !== ankanKind) return false;
  const matchingInHand = hand.filter((t) => t.kind === ankanKind);
  if (matchingInHand.length !== 3) return false;

  const beforeWaits = getTenpaiWaitKinds(hand, melds, rules);
  if (beforeWaits.length === 0) return false;

  const nextHand = hand.filter((t) => t.kind !== ankanKind);
  const nextMelds: Meld[] = [
    ...melds,
    {
      type: 'ankan',
      tiles: [...matchingInHand, drawnTile],
      calledTile: null,
      fromSeatIndex: null,
      addedTile: null,
    },
  ];
  const afterWaits = getTenpaiWaitKinds(nextHand, nextMelds, rules);
  return (
    afterWaits.length > 0 &&
    afterWaits.length === beforeWaits.length &&
    afterWaits.every((k, idx) => k === beforeWaits[idx])
  );
}
