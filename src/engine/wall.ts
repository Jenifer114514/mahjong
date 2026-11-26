import type { DerivedRules, KandoraRevealTiming } from '../types/rule';
import type { DeadWallState } from '../types/state';
import { ALL_TILE_KINDS, type Tile, type TileKind } from '../types/tile';

const TILE_ORDER = new Map<TileKind, number>(
  ALL_TILE_KINDS.map((kind, idx) => [kind, idx]),
);

function secureRandomIndex(maxExclusive: number): number {
  if (maxExclusive <= 1) return 0;
  if (typeof crypto === 'undefined' || typeof crypto.getRandomValues !== 'function') {
    return Math.floor(Math.random() * maxExclusive);
  }
  const range = 0x100000000;
  const limit = range - (range % maxExclusive);
  const buf = new Uint32Array(1);
  while (true) {
    crypto.getRandomValues(buf);
    const val = buf[0]!;
    if (val < limit) {
      return val % maxExclusive;
    }
  }
}

/** CSPRNG (crypto.getRandomValues) を使った偏りのない Fisher-Yates シャッフル */
export function shuffleWithCrypto<T>(items: readonly T[]): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = secureRandomIndex(i + 1);
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
    const isFive = kind === '5m' || kind === '5p' || kind === '5s';
    for (let copy = 0; copy < rules.tileSet.copiesPerKind; copy++) {
      deck.push({
        id: `${kind}-${copy}`,
        kind,
        isRed: isFive && copy >= rules.tileSet.copiesPerKind - rules.redDoraPerFive,
      });
    }
  }
  return deck;
}

export function validateDeckForRules(
  rules: DerivedRules,
  deck: readonly Tile[],
): boolean {
  if (deck.length !== rules.totalTiles) {
    return false;
  }
  const expected = buildTileDeck(rules);
  const expectedById = new Map<string, TileKind>(
    expected.map((t) => [t.id, t.kind]),
  );
  const seen = new Set<string>();
  for (const tile of deck) {
    if (!tile || typeof tile.id !== 'string' || typeof tile.kind !== 'string') {
      return false;
    }
    if (seen.has(tile.id)) {
      return false;
    }
    const expectedKind = expectedById.get(tile.id);
    if (expectedKind !== tile.kind) {
      return false;
    }
    seen.add(tile.id);
  }
  return seen.size === rules.totalTiles;
}

export interface DealtRound {
  hands: Tile[][];
  dealerDrawnTile: Tile;
  wall: Tile[];
  deadWall: DeadWallState;
}

/** シャッフル済みの山配列から決定論的に配牌・王牌を構築する */
export function dealRoundFromDeck(
  rules: DerivedRules,
  dealerIndex: number,
  shuffledDeck: readonly Tile[],
): DealtRound {
  const requiredForDeal = rules.playerCount * rules.handSize + 1;
  if (shuffledDeck.length < requiredForDeal + rules.deadWallSize) {
    throw new Error(
      `Insufficient tiles (${shuffledDeck.length}) for ${rules.playerCount} players`,
    );
  }

  const deck = shuffledDeck.map((t) => ({ ...t }));
  const liveEndIndex = deck.length - rules.deadWallSize;
  const liveWall = deck.slice(0, liveEndIndex);
  const deadWallSlice = deck.slice(liveEndIndex);

  const rinshanTiles = deadWallSlice.slice(0, rules.rinshanSize);
  const doraIndicators = deadWallSlice.slice(
    rules.rinshanSize,
    rules.rinshanSize + rules.doraIndicatorCount,
  );
  const uraDoraIndicators = deadWallSlice.slice(
    rules.rinshanSize + rules.doraIndicatorCount,
    rules.rinshanSize + rules.doraIndicatorCount + rules.uraDoraIndicatorCount,
  );

  const deadWall: DeadWallState = {
    rinshanTiles,
    doraIndicators,
    uraDoraIndicators,
    revealedDoraCount: 1,
    pendingKandoraCount: 0,
  };

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

/** 嶺上牌を1枚引き、牌山の最後尾から1枚を王牌へ補充する */
export function drawRinshanAndReplenish(
  wall: readonly Tile[],
  deadWall: DeadWallState,
): { drawnTile: Tile; wall: Tile[]; deadWall: DeadWallState } {
  if (wall.length === 0) {
    throw new Error('Cannot draw rinshan tile when live wall is empty');
  }
  const drawnTile = deadWall.rinshanTiles[0];
  if (!drawnTile) {
    throw new Error('Dead wall has no rinshan tiles');
  }
  const replenishment = wall[wall.length - 1]!;
  const nextWall = wall.slice(0, -1);
  const nextDeadWall: DeadWallState = {
    ...deadWall,
    rinshanTiles: [...deadWall.rinshanTiles.slice(1), replenishment],
  };

  return {
    drawnTile,
    wall: nextWall,
    deadWall: nextDeadWall,
  };
}

export function applyKandoraTiming(
  deadWall: DeadWallState,
  timing: KandoraRevealTiming,
): DeadWallState {
  if (timing === 'immediate') {
    return {
      ...deadWall,
      revealedDoraCount: Math.min(
        deadWall.doraIndicators.length,
        deadWall.revealedDoraCount + 1,
      ),
    };
  }
  return {
    ...deadWall,
    pendingKandoraCount: deadWall.pendingKandoraCount + 1,
  };
}

export function flushPendingKandora(deadWall: DeadWallState): DeadWallState {
  if (deadWall.pendingKandoraCount <= 0) {
    return deadWall;
  }
  return {
    ...deadWall,
    revealedDoraCount: Math.min(
      deadWall.doraIndicators.length,
      deadWall.revealedDoraCount + deadWall.pendingKandoraCount,
    ),
    pendingKandoraCount: 0,
  };
}

export function countAllDeadWallTiles(deadWall: DeadWallState): number {
  return (
    deadWall.rinshanTiles.length +
    deadWall.doraIndicators.length +
    deadWall.uraDoraIndicators.length
  );
}
