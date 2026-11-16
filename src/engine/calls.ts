import type { SelfTurnActionsView } from '../types/message';
import type { DerivedRules } from '../types/rule';
import type {
  CallOptions,
  ChiOption,
  GameState,
  PlayerState,
  RoundState,
} from '../types/state';
import type { Tile, TileKind } from '../types/tile';
import {
  canAnkanPreserveRiichiWaits,
  enumerateAgariDecompositions,
  getCanRiichiDiscardTileIds,
  getTenpaiWaitKinds,
} from './agari';
import {
  getRevealedDoraIndicators,
  getRevealedUraDoraIndicators,
} from './dora';
import { deriveRules, getSeatWind } from './rules';
import { type AgariScoreResult, evaluateBestAgari } from './score';
import { isTerminalOrHonorKind } from './yaku';

export interface CanRonParams {
  state: GameState;
  player: PlayerState;
  discardedTile: Tile;
  discarder: PlayerState;
  chankanKind?: 'kakan' | 'ankan';
}

export interface EngineHooks {
  /** ロン可能判定（既定は第3A段階の和了・役・フリテン判定） */
  canRon?: (params: CanRonParams) => boolean;
}

/**
 * フリテン判定（捨て牌フリテン + 同巡フリテン）
 * - 同巡フリテン中なら true
 * - 非手番形（手牌枚数が 13 - 副露数*3）で待ち牌種のいずれかが自分の捨て牌履歴にあるなら true
 */
export function isPlayerFuriten(
  player: PlayerState,
  rules: DerivedRules,
): boolean {
  if (player.sameTurnFuriten || player.isRiichiFuriten) {
    return true;
  }
  if (player.discardedKinds.length === 0) {
    return false;
  }
  const expectedTenpaiCount = (4 - player.melds.length) * 3 + 1;
  if (player.hand.length !== expectedTenpaiCount) {
    return false;
  }
  const waitKinds = getTenpaiWaitKinds(player.hand, player.melds, rules);
  if (waitKinds.length === 0) {
    return false;
  }
  const discardedSet = new Set(player.discardedKinds);
  return waitKinds.some((k) => discardedSet.has(k));
}

export function evaluateRonForPlayer(
  state: GameState,
  player: PlayerState,
  discardedTile: Tile,
  discarder: PlayerState,
  options?: { chankanKind?: 'kakan' | 'ankan' },
): AgariScoreResult | null {
  const round = state.round;
  if (!round) return null;
  if (player.playerId === discarder.playerId) return null;

  const rules = deriveRules(state.ruleConfig);
  if (player.sameTurnFuriten || player.isRiichiFuriten) {
    return null;
  }

  const waitKinds = getTenpaiWaitKinds(player.hand, player.melds, rules);
  if (!waitKinds.includes(discardedTile.kind)) {
    return null;
  }

  const discardedSet = new Set(player.discardedKinds);
  if (waitKinds.some((k) => discardedSet.has(k))) {
    return null;
  }

  const chankanKind = options?.chankanKind;
  if (chankanKind === 'ankan') {
    const canKokushi = enumerateAgariDecompositions(
      player.hand,
      player.melds,
      discardedTile.kind,
      false,
    ).some((d) => d.form === 'kokushi');
    if (!canKokushi) {
      return null;
    }
  }

  return evaluateBestAgari({
    hand: player.hand,
    melds: player.melds,
    kitaTiles: player.kitaTiles,
    winningTile: discardedTile,
    isTsumo: false,
    isDealer: player.seatIndex === round.dealerIndex,
    dealerIndex: round.dealerIndex,
    roundWind: round.roundWind,
    seatWind: getSeatWind(player.seatIndex, round.dealerIndex, rules.seatWinds),
    doraIndicators: getRevealedDoraIndicators(round.deadWall),
    uraDoraIndicators: getRevealedUraDoraIndicators(round.deadWall, player.isRiichi),
    isRiichi: player.isRiichi,
    isDoubleRiichi: player.isDoubleRiichi,
    isIppatsu: player.ippatsuEligible,
    isChankan: chankanKind === 'kakan',
    isHoutei: chankanKind === undefined && round.wall.length === 0,
    winnerSeatIndex: player.seatIndex,
    fromSeatIndex: discarder.seatIndex,
    rules,
  });
}

export function evaluateTsumoFromRound(
  player: PlayerState,
  round: RoundState,
  rules: DerivedRules,
): AgariScoreResult | null {
  if (player.drawnTile === null) {
    return null;
  }
  const isFirstDraw =
    player.discards.length === 0 &&
    player.melds.length === 0 &&
    round.firstTurnUninterrupted;

  return evaluateBestAgari({
    hand: player.hand,
    melds: player.melds,
    kitaTiles: player.kitaTiles,
    winningTile: player.drawnTile,
    isTsumo: true,
    isDealer: player.seatIndex === round.dealerIndex,
    dealerIndex: round.dealerIndex,
    roundWind: round.roundWind,
    seatWind: getSeatWind(player.seatIndex, round.dealerIndex, rules.seatWinds),
    doraIndicators: getRevealedDoraIndicators(round.deadWall),
    uraDoraIndicators: getRevealedUraDoraIndicators(round.deadWall, player.isRiichi),
    isRiichi: player.isRiichi,
    isDoubleRiichi: player.isDoubleRiichi,
    isIppatsu: player.ippatsuEligible,
    isRinshan: player.isRinshanDraw,
    isHaitei: !player.isRinshanDraw && round.wall.length === 0,
    isTenhou: isFirstDraw && player.seatIndex === round.dealerIndex,
    isChiihou: isFirstDraw && player.seatIndex !== round.dealerIndex,
    winnerSeatIndex: player.seatIndex,
    fromSeatIndex: null,
    rules,
  });
}

export const DEFAULT_ENGINE_HOOKS: Required<EngineHooks> = {
  canRon: ({ state, player, discardedTile, discarder, chankanKind }) =>
    evaluateRonForPlayer(state, player, discardedTile, discarder, {
      chankanKind,
    }) !== null,
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

export function isSuukanzuTriggered(state: GameState): boolean {
  const round = state.round;
  if (!round || round.kanCount < 4) return false;
  const playersWithKan = state.players.filter((p) =>
    p.melds.some(
      (m) => m.type === 'ankan' || m.type === 'kakan' || m.type === 'daiminkan',
    ),
  ).length;
  return playersWithKan >= 2;
}

export function canDeclareKyuushuKyuuhai(
  player: PlayerState,
  round: RoundState,
): boolean {
  if (player.drawnTile === null) return false;
  if (player.discards.length > 0 || player.melds.length > 0) return false;
  if (!round.firstTurnUninterrupted) return false;
  const yaochuKinds = new Set<TileKind>();
  for (const tile of [...player.hand, player.drawnTile]) {
    if (isTerminalOrHonorKind(tile.kind)) {
      yaochuKinds.add(tile.kind);
    }
  }
  return yaochuKinds.size >= 9;
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
  const suppressCalls = isSuukanzuTriggered(stateAfterDiscard);
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

    const canPon =
      player.isRiichi || isHoutei || suppressCalls
        ? false
        : canCallPon(player.hand, discardedTile, rules.forbidKuikae);

    const canDaiminkan =
      player.isRiichi || isHoutei || suppressCalls
        ? false
        : canCallDaiminkan(player.hand, discardedTile, round, rules);

    const chiOptions =
      !player.isRiichi &&
      !isHoutei &&
      !suppressCalls &&
      rules.allowChi &&
      player.seatIndex === nextSeatIndex
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

export function buildPendingChankanOptions(
  stateBeforeKan: GameState,
  kanPlayer: PlayerState,
  targetTile: Tile,
  chankanKind: 'kakan' | 'ankan',
  hooks: EngineHooks,
): Record<string, CallOptions> {
  const canRonFn = hooks.canRon ?? DEFAULT_ENGINE_HOOKS.canRon;
  const optionsByPlayerId: Record<string, CallOptions> = {};

  for (const player of stateBeforeKan.players) {
    if (player.playerId === kanPlayer.playerId) continue;

    const canRon = canRonFn({
      state: stateBeforeKan,
      player,
      discardedTile: targetTile,
      discarder: kanPlayer,
      chankanKind,
    });

    if (canRon) {
      optionsByPlayerId[player.playerId] = {
        discardedTile: targetTile,
        discarderSeatIndex: kanPlayer.seatIndex,
        canRon: true,
        canPon: false,
        canDaiminkan: false,
        chiOptions: [],
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
  const canTsumo =
    player.drawnTile !== null &&
    evaluateTsumoFromRound(player, round, rules) !== null;
  const canKyuushuKyuuhai = canDeclareKyuushuKyuuhai(player, round);

  // カン・北抜き・リーチはツモ直後かつ山残りがある場合のみ
  if (player.drawnTile === null || round.wall.length === 0) {
    return {
      canTsumo,
      canRiichiTileIds: [],
      canAnkanKinds: [],
      canKakanTileIds: [],
      canKitaTileIds: [],
      canKyuushuKyuuhai,
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
      if (count !== 4) continue;
      if (
        player.isRiichi &&
        !canAnkanPreserveRiichiWaits(
          player.hand,
          player.drawnTile,
          player.melds,
          kind,
          rules,
        )
      ) {
        continue;
      }
      canAnkanKinds.push(kind);
    }
  }

  const canKakanTileIds: string[] = [];
  if (canKan && !player.isRiichi) {
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

  // リーチ後は引いた北のみ抜け、リーチ前は手牌・ツモ牌どちらの北も抜ける
  const canKitaTileIds: string[] = rules.allowKita
    ? player.isRiichi
      ? player.drawnTile.kind === '4z'
        ? [player.drawnTile.id]
        : []
      : allTiles.filter((t) => t.kind === '4z').map((t) => t.id)
    : [];

  const canRiichiTileIds =
    !player.isRiichi &&
    player.melds.every((m) => m.type === 'ankan') &&
    player.score >= rules.riichiStickPoints &&
    round.wall.length >= rules.playerCount
      ? getCanRiichiDiscardTileIds(
          player.hand,
          player.drawnTile,
          player.melds,
          rules,
        )
      : [];

  return {
    canTsumo,
    canRiichiTileIds,
    canAnkanKinds,
    canKakanTileIds,
    canKitaTileIds,
    canKyuushuKyuuhai,
  };
}
