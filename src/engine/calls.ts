import type { DerivedRules } from '../types/rule';
import type {
  CallOptions,
  ChiOption,
  GameState,
  PlayerState,
  RoundState,
} from '../types/state';
import type { SelfTurnActionsView } from '../types/message';
import type { Tile, TileKind } from '../types/tile';

export interface CanRonParams {
  state: GameState;
  player: PlayerState;
  discardedTile: Tile;
  discarder: PlayerState;
}

export interface EngineHooks {
  /** ロン可能判定（第3段階で和了判定を実装するまで既定は常に false） */
  canRon?: (params: CanRonParams) => boolean;
}

export const DEFAULT_ENGINE_HOOKS: Required<EngineHooks> = {
  canRon: () => false,
};

function parseNumberTile(
  kind: TileKind,
): { rank: number; suit: 'm' | 'p' | 's' } | null {
  const suit = kind[1];
  if (suit !== 'm' && suit !== 'p' && suit !== 's') {
    return null;
  }
  const rank = Number(kind[0]);
  if (!Number.isInteger(rank) || rank < 1 || rank > 9) {
    return null;
  }
  return { rank, suit };
}

function makeNumberKind(rank: number, suit: 'm' | 'p' | 's'): TileKind {
  return `${rank}${suit}` as TileKind;
}

/** チー直後の喰い替え禁止牌種を算出する */
export function computeChiKuikaeKinds(
  calledKind: TileKind,
  handKindA: TileKind,
  handKindB: TileKind,
): TileKind[] {
  const called = parseNumberTile(calledKind);
  const a = parseNumberTile(handKindA);
  const b = parseNumberTile(handKindB);
  if (!called || !a || !b || a.suit !== called.suit || b.suit !== called.suit) {
    return [calledKind];
  }
  const [r1, r2] = [a.rank, b.rank].sort((x, y) => x - y) as [number, number];
  const forbidden: TileKind[] = [calledKind];

  if (r2 - r1 === 1) {
    if (called.rank === r1 - 1 && r2 + 1 <= 9) {
      forbidden.push(makeNumberKind(r2 + 1, called.suit));
    } else if (called.rank === r2 + 1 && r1 - 1 >= 1) {
      forbidden.push(makeNumberKind(r1 - 1, called.suit));
    }
  }
  return forbidden;
}

function hasRemainingLegalDiscard(
  hand: readonly Tile[],
  usedIds: readonly string[],
  forbiddenKinds: readonly TileKind[],
): boolean {
  const used = new Set(usedIds);
  const forbidden = new Set(forbiddenKinds);
  return hand.some((t) => !used.has(t.id) && !forbidden.has(t.kind));
}

export function validatePonTilePair(
  hand: readonly Tile[],
  discardedTile: Tile,
  tileIds: readonly [string, string] | undefined,
  forbidKuikae: boolean,
): [Tile, Tile] | null {
  let pair: [Tile, Tile] | null = null;
  if (tileIds) {
    if (tileIds[0] === tileIds[1]) return null;
    const t1 = hand.find((t) => t.id === tileIds[0]);
    const t2 = hand.find((t) => t.id === tileIds[1]);
    if (!t1 || !t2) return null;
    if (t1.kind !== discardedTile.kind || t2.kind !== discardedTile.kind) {
      return null;
    }
    pair = [t1, t2];
  } else {
    const matching = hand.filter((t) => t.kind === discardedTile.kind);
    if (matching.length < 2) return null;
    pair = [matching[0]!, matching[1]!];
  }

  if (
    forbidKuikae &&
    !hasRemainingLegalDiscard(hand, [pair[0].id, pair[1].id], [discardedTile.kind])
  ) {
    return null;
  }
  return pair;
}

export function validateChiTilePair(
  hand: readonly Tile[],
  discardedTile: Tile,
  tileIds: readonly [string, string],
  forbidKuikae: boolean,
): [Tile, Tile] | null {
  if (tileIds[0] === tileIds[1]) return null;
  const t1 = hand.find((t) => t.id === tileIds[0]);
  const t2 = hand.find((t) => t.id === tileIds[1]);
  if (!t1 || !t2) return null;

  const c = parseNumberTile(discardedTile.kind);
  const p1 = parseNumberTile(t1.kind);
  const p2 = parseNumberTile(t2.kind);
  if (!c || !p1 || !p2) return null;
  if (p1.suit !== c.suit || p2.suit !== c.suit) return null;

  const ranks = [c.rank, p1.rank, p2.rank].sort((x, y) => x - y);
  if (ranks[0]! + 1 !== ranks[1]! || ranks[1]! + 1 !== ranks[2]!) {
    return null;
  }

  const ordered: [Tile, Tile] = p1.rank <= p2.rank ? [t1, t2] : [t2, t1];
  if (forbidKuikae) {
    const forbidden = computeChiKuikaeKinds(
      discardedTile.kind,
      ordered[0].kind,
      ordered[1].kind,
    );
    if (!hasRemainingLegalDiscard(hand, [ordered[0].id, ordered[1].id], forbidden)) {
      return null;
    }
  }
  return ordered;
}

export function findChiOptions(
  hand: readonly Tile[],
  discardedTile: Tile,
  forbidKuikae: boolean,
): ChiOption[] {
  const parsed = parseNumberTile(discardedTile.kind);
  if (!parsed) return [];

  const patterns: Array<[number, number]> = [
    [parsed.rank - 2, parsed.rank - 1],
    [parsed.rank - 1, parsed.rank + 1],
    [parsed.rank + 1, parsed.rank + 2],
  ];

  const options: ChiOption[] = [];
  for (const [r1, r2] of patterns) {
    if (r1 < 1 || r2 > 9) continue;
    const k1 = makeNumberKind(r1, parsed.suit);
    const k2 = makeNumberKind(r2, parsed.suit);
    const t1 = hand.find((t) => t.kind === k1);
    const t2 = hand.find((t) => t.kind === k2);
    if (!t1 || !t2) continue;

    if (forbidKuikae) {
      const forbidden = computeChiKuikaeKinds(discardedTile.kind, k1, k2);
      if (!hasRemainingLegalDiscard(hand, [t1.id, t2.id], forbidden)) {
        continue;
      }
    }
    options.push({ tiles: [t1, t2] });
  }
  return options;
}

export function canCallPon(
  hand: readonly Tile[],
  discardedTile: Tile,
  forbidKuikae: boolean,
): boolean {
  return validatePonTilePair(hand, discardedTile, undefined, forbidKuikae) !== null;
}

export function canCallDaiminkan(
  hand: readonly Tile[],
  discardedTile: Tile,
  round: RoundState,
  rules: DerivedRules,
): boolean {
  if (round.wall.length === 0) return false;
  if (round.kanCount >= rules.maxKansPerRound) return false;
  return hand.filter((t) => t.kind === discardedTile.kind).length >= 3;
}

export function buildPendingCallOptions(
  stateAfterDiscard: GameState,
  discarder: PlayerState,
  discardedTile: Tile,
  rules: DerivedRules,
  hooks: EngineHooks,
): Record<string, CallOptions> {
  const round = stateAfterDiscard.round!;
  const isHoutei = round.wall.length === 0;
  const canRonFn = hooks.canRon ?? DEFAULT_ENGINE_HOOKS.canRon;
  const nextSeatIndex = (discarder.seatIndex + 1) % rules.playerCount;
  const optionsByPlayerId: Record<string, CallOptions> = {};

  for (const player of stateAfterDiscard.players) {
    if (player.playerId === discarder.playerId) continue;

    const canRon = canRonFn({
      state: stateAfterDiscard,
      player,
      discardedTile,
      discarder,
    });

    const canPon = isHoutei
      ? false
      : canCallPon(player.hand, discardedTile, rules.forbidKuikae);

    const canDaiminkan = isHoutei
      ? false
      : canCallDaiminkan(player.hand, discardedTile, round, rules);

    const chiOptions =
      !isHoutei && rules.allowChi && player.seatIndex === nextSeatIndex
        ? findChiOptions(player.hand, discardedTile, rules.forbidKuikae)
        : [];

    if (canRon || canPon || canDaiminkan || chiOptions.length > 0) {
      optionsByPlayerId[player.playerId] = {
        discardedTile,
        discarderSeatIndex: discarder.seatIndex,
        canRon,
        canPon,
        canDaiminkan,
        chiOptions,
      };
    }
  }

  return optionsByPlayerId;
}

export function getSelfTurnActions(
  player: PlayerState,
  round: RoundState,
  rules: DerivedRules,
): SelfTurnActionsView {
  // ツモ直後かつ山残りがある場合のみ（ポン・チー直後の打牌前、または海底では不可）
  if (player.drawnTile === null || round.wall.length === 0) {
    return {
      canAnkanKinds: [],
      canKakanTileIds: [],
      canKitaTileIds: [],
    };
  }

  const allTiles = [...player.hand, player.drawnTile];
  const canKan = round.kanCount < rules.maxKansPerRound;

  const canAnkanKinds: TileKind[] = [];
  if (canKan) {
    const counts = new Map<TileKind, number>();
    for (const tile of allTiles) {
      counts.set(tile.kind, (counts.get(tile.kind) ?? 0) + 1);
    }
    for (const [kind, count] of counts) {
      if (count === 4) {
        canAnkanKinds.push(kind);
      }
    }
  }

  const canKakanTileIds: string[] = [];
  if (canKan) {
    const ponKinds = new Set<TileKind>();
    for (const meld of player.melds) {
      if (meld.type === 'pon' && meld.tiles[0]) {
        ponKinds.add(meld.tiles[0].kind);
      }
    }
    for (const tile of allTiles) {
      if (ponKinds.has(tile.kind)) {
        canKakanTileIds.push(tile.id);
      }
    }
  }

  const canKitaTileIds: string[] = rules.allowKita
    ? allTiles.filter((t) => t.kind === '4z').map((t) => t.id)
    : [];

  return {
    canAnkanKinds,
    canKakanTileIds,
    canKitaTileIds,
  };
}
