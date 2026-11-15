import {
  DEAD_WALL_DORA_COUNT,
  DEAD_WALL_RINSHAN_COUNT,
  DEAD_WALL_SIZE_BY_PLAYERS,
  DEAD_WALL_URA_DORA_COUNT,
  DEFAULT_KANDORA_TIMING,
  DEFAULT_MAX_KANS_PER_ROUND,
  DEFAULT_RESPONSE_TIMEOUT_MS,
  DEFAULT_TILE_SET_BY_PLAYERS,
  HAND_SIZE,
  INITIAL_POINTS_BY_PLAYERS,
  ROUND_WINDS_BY_LENGTH,
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
