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

  const waits: TileKind[] = [];
  for (const kind of rules.allowedTileKinds) {
    if (
      countKindInHandAndMelds(hand, melds, kind) >= rules.tileSet.copiesPerKind
    ) {
      continue;
    }
    if (enumerateAgariDecompositions(hand, melds, kind, false).length > 0) {
      waits.push(kind);
    }
  }
  return waits;
}
