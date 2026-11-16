import {
  DEAD_WALL_DORA_COUNT,
  DEAD_WALL_RINSHAN_COUNT,
  DEAD_WALL_SIZE_BY_PLAYERS,
  DEAD_WALL_URA_DORA_COUNT,
  DEFAULT_ALLOW_ATOZUKE,
  DEFAULT_ALLOW_KAZOE_YAKUMAN,
  DEFAULT_ALLOW_KUITAN,
  DEFAULT_DOUBLE_WIND_PAIR_FU,
  DEFAULT_HONBA_BONUS,
  DEFAULT_KANDORA_TIMING,
  DEFAULT_KIRIAGE_MANGAN,
  DEFAULT_KITA_COUNTS_AS_INDICATOR_DORA,
  DEFAULT_MAX_KANS_PER_ROUND,
  DEFAULT_RESPONSE_TIMEOUT_MS,
  DEFAULT_TILE_SET_BY_PLAYERS,
  DEFAULT_TOBI,
  DEFAULT_TSUMO_LOSS,
  HAND_SIZE,
  HONBA_POINTS_BY_PLAYERS,
  INITIAL_POINTS_BY_PLAYERS,
  NOTEN_PENALTY_TOTAL,
  RIICHI_STICK_POINTS,
  ROUND_WINDS_BY_LENGTH,
  SCORE_LIMIT_BASE_POINTS,
  SEAT_WINDS_BY_PLAYERS,
  TILE_SETS,
  type DerivedRules,
  type RuleConfig,
  type TileSetId,
  type TileSetSpec,
  type Wind,
} from '../types/rule';
import { ALL_TILE_KINDS } from '../types/tile';

export function deriveRules(
  config: RuleConfig,
  tileSets: Record<TileSetId, TileSetSpec> = TILE_SETS,
): DerivedRules {
  const tileSetId = config.tileSetId ?? DEFAULT_TILE_SET_BY_PLAYERS[config.playerCount];
  const tileSet = tileSets[tileSetId];
  const excludedSet = new Set(tileSet.excludedKinds);
  const allowedTileKinds = ALL_TILE_KINDS.filter((kind) => !excludedSet.has(kind));
  const totalTiles = allowedTileKinds.length * tileSet.copiesPerKind;

  const initialPoints = INITIAL_POINTS_BY_PLAYERS[config.playerCount];
  const seatWinds = SEAT_WINDS_BY_PLAYERS[config.playerCount];
  const roundWinds = ROUND_WINDS_BY_LENGTH[config.gameLength];
  const totalRounds = roundWinds.length * config.playerCount;
  const deadWallSize = DEAD_WALL_SIZE_BY_PLAYERS[config.playerCount];

  return {
    playerCount: config.playerCount,
    gameLength: config.gameLength,
    tileSet,
    allowedTileKinds,
    totalTiles,
    initialPoints,
    seatWinds,
    roundWinds,
    totalRounds,
    handSize: HAND_SIZE,
    deadWallSize,
    rinshanSize: DEAD_WALL_RINSHAN_COUNT,
    doraIndicatorCount: DEAD_WALL_DORA_COUNT,
    uraDoraIndicatorCount: DEAD_WALL_URA_DORA_COUNT,
    allowChi: config.allowChi ?? config.playerCount === 4,
    allowKita: config.allowKita ?? config.playerCount === 3,
    doubleRon: config.doubleRon ?? true,
    forbidKuikae: config.forbidKuikae ?? true,
    responseTimeoutMs: config.responseTimeoutMs ?? DEFAULT_RESPONSE_TIMEOUT_MS,
    maxKansPerRound: config.maxKansPerRound ?? DEFAULT_MAX_KANS_PER_ROUND,
    kandoraTiming: {
      ankan: config.kandoraTiming?.ankan ?? DEFAULT_KANDORA_TIMING.ankan,
      daiminkan: config.kandoraTiming?.daiminkan ?? DEFAULT_KANDORA_TIMING.daiminkan,
      kakan: config.kandoraTiming?.kakan ?? DEFAULT_KANDORA_TIMING.kakan,
    },
    tobi: config.tobi ?? DEFAULT_TOBI,
    tsumoLoss:
      config.playerCount === 3
        ? (config.tsumoLoss ?? DEFAULT_TSUMO_LOSS)
        : false,
    allowKuitan: config.allowKuitan ?? DEFAULT_ALLOW_KUITAN,
    allowAtozuke: config.allowAtozuke ?? DEFAULT_ALLOW_ATOZUKE,
    honbaBonus: config.honbaBonus ?? DEFAULT_HONBA_BONUS,
    honbaPointsPerStick: HONBA_POINTS_BY_PLAYERS[config.playerCount],
    notenPenaltyTotal: NOTEN_PENALTY_TOTAL,
    kiriageMangan: DEFAULT_KIRIAGE_MANGAN,
    allowKazoeYakuman: DEFAULT_ALLOW_KAZOE_YAKUMAN,
    doubleWindPairFu: DEFAULT_DOUBLE_WIND_PAIR_FU,
    kitaCountsAsIndicatorDora: DEFAULT_KITA_COUNTS_AS_INDICATOR_DORA,
    riichiStickPoints: RIICHI_STICK_POINTS,
    scoreLimits: { ...SCORE_LIMIT_BASE_POINTS },
  };
}

export function getSeatWind(
  seatIndex: number,
  dealerIndex: number,
  seatWinds: readonly Wind[],
): Wind {
  const count = seatWinds.length;
  const offset = ((seatIndex - dealerIndex) % count + count) % count;
  const wind = seatWinds[offset];
  if (wind === undefined) {
    throw new Error(`Invalid seat wind offset: ${offset}`);
  }
  return wind;
}

export function getRoundMetadata(
  roundIndex: number,
  initialDealerIndex: number,
  rules: DerivedRules,
): { roundWind: Wind; kyokuNumber: number; dealerIndex: number } {
  const roundWindIndex = Math.floor(roundIndex / rules.playerCount);
  const roundWind = rules.roundWinds[roundWindIndex];
  if (roundWind === undefined) {
    throw new Error(`Invalid roundIndex ${roundIndex} for totalRounds ${rules.totalRounds}`);
  }
  const kyokuNumber = (roundIndex % rules.playerCount) + 1;
  const dealerIndex = (initialDealerIndex + roundIndex) % rules.playerCount;
  return { roundWind, kyokuNumber, dealerIndex };
}
