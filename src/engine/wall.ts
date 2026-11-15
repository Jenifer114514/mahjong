import type { DerivedRules } from '../types/rule';
import { ALL_TILE_KINDS, type Tile, type TileKind } from '../types/tile';

const TILE_ORDER = new Map<TileKind, number>(
  ALL_TILE_KINDS.map((kind, idx) => [kind, idx]),
);

/** Mulberry32 決定論的疑似乱数生成器 */
export function createRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function deriveSubSeed(seed: number, salt: number): number {
  let h = (seed ^ Math.imul(salt + 1, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

export function shuffleWithSeed<T>(items: readonly T[], seed: number): T[] {
  const result = [...items];
  const rng = createRng(seed);
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const itemI = result[i]!;
    const itemJ = result[j]!;
    result[i] = itemJ;
    result[j] = itemI;
  }
  return result;
}

export function sortTiles(tiles: readonly Tile[]): Tile[] {
  return [...tiles].sort((a, b) => {
    const orderA = TILE_ORDER.get(a.kind) ?? 999;
    const orderB = TILE_ORDER.get(b.kind) ?? 999;
    if (orderA !== orderB) {
      return orderA - orderB;
    }
    return a.id.localeCompare(b.id);
  });
}

export function buildTileDeck(rules: DerivedRules): Tile[] {
  const deck: Tile[] = [];
  for (const kind of rules.allowedTileKinds) {
    for (let copy = 0; copy < rules.tileSet.copiesPerKind; copy++) {
      deck.push({
        id: `${kind}-${copy}`,
        kind,
        isRed: false,
      });
    }
  }
  return deck;
}

export interface DealtRound {
  hands: Tile[][];
  dealerDrawnTile: Tile;
  wall: Tile[];
  deadWall: Tile[];
}

export function dealRound(
  rules: DerivedRules,
  dealerIndex: number,
  seed: number,
): DealtRound {
  const deck = buildTileDeck(rules);
  const shuffled = shuffleWithSeed(deck, seed);

  const requiredForDeal = rules.playerCount * rules.handSize + 1;
  if (shuffled.length < requiredForDeal + rules.deadWallSize) {
    throw new Error(
      `Insufficient tiles (${shuffled.length}) for ${rules.playerCount} players`,
    );
  }

  const liveEndIndex = shuffled.length - rules.deadWallSize;
  const liveWall = shuffled.slice(0, liveEndIndex);
  const deadWall = shuffled.slice(liveEndIndex);

  const hands: Tile[][] = Array.from({ length: rules.playerCount }, () => []);
  let cursor = 0;

  for (let round = 0; round < rules.handSize; round++) {
    for (let offset = 0; offset < rules.playerCount; offset++) {
      const seat = (dealerIndex + offset) % rules.playerCount;
      const tile = liveWall[cursor];
      if (tile === undefined) {
        throw new Error('Unexpected end of live wall during deal');
      }
      hands[seat]!.push(tile);
      cursor++;
    }
  }

  for (let seat = 0; seat < rules.playerCount; seat++) {
    hands[seat] = sortTiles(hands[seat]!);
  }

  const dealerDrawnTile = liveWall[cursor];
  if (dealerDrawnTile === undefined) {
    throw new Error('Unexpected end of live wall on dealer first draw');
  }
  cursor++;

  const remainingWall = liveWall.slice(cursor);

  return {
    hands,
    dealerDrawnTile,
    wall: remainingWall,
    deadWall,
  };
}
