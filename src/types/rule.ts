import type { TileKind } from './tile';

export type PlayerCount = 3 | 4;
export type GameLength = 'tonpuu' | 'hanchan';
export type Wind = 'E' | 'S' | 'W' | 'N';

export type TileSetId = 'standard_136' | 'sanma_no_2m_to_8m_108';
export type KandoraRevealTiming = 'immediate' | 'after_discard';

export interface KandoraTimingConfig {
  ankan: KandoraRevealTiming;
  daiminkan: KandoraRevealTiming;
  kakan: KandoraRevealTiming;
}

export interface ScoreLimitBasePoints {
  mangan: number;
  haneman: number;
  baiman: number;
  sanbaiman: number;
  yakuman: number;
}

export interface RuleConfig {
  playerCount: PlayerCount;
  gameLength: GameLength;
  /** 省略時は DEFAULT_TILE_SET_BY_PLAYERS[playerCount] を使用（将来の差し替え用） */
  tileSetId?: TileSetId;
  /** チー許可（既定: 4人のみ true、3人は false） */
  allowChi?: boolean;
  /** 北抜き許可（既定: 3人のみ true、4人は false） */
  allowKita?: boolean;
  /** ダブロン許可（既定: true。false なら頭ハネ） */
  doubleRon?: boolean;
  /** 喰い替え禁止（既定: true） */
  forbidKuikae?: boolean;
  /** 鳴き応答タイムアウト(ms)（既定: 15000） */
  responseTimeoutMs?: number;
  /** 1局あたりの合計カン上限（既定: 4） */
  maxKansPerRound?: number;
  /** カンドラ表示牌をめくる時期（既定: 暗槓=即時、大明槓・加槓=打牌後） */
  kandoraTiming?: Partial<KandoraTimingConfig>;
  /** トビ終了（持ち点0点未満で終局、既定: true） */
  tobi?: boolean;
  /** 3人麻雀のツモ損あり/なし（3人のみ有効、既定: false=ツモ損なし） */
  tsumoLoss?: boolean;
  /** 喰いタンあり/なし（既定: true） */
  allowKuitan?: boolean;
  /** 後付けあり/なし（既定: true） */
  allowAtozuke?: boolean;
  /** 本場加算あり/なし（既定: true。なしでも本場数のカウント・表示は行う） */
  honbaBonus?: boolean;
}

/** 将来のローカルルール変更に備えて差し替え可能な定数群 */
export const INITIAL_POINTS_BY_PLAYERS: Record<PlayerCount, number> = {
  4: 25000,
  3: 35000,
};

export const SEAT_WINDS_BY_PLAYERS: Record<PlayerCount, readonly Wind[]> = {
  4: ['E', 'S', 'W', 'N'],
  3: ['E', 'S', 'W'],
};

export const ROUND_WINDS_BY_LENGTH: Record<GameLength, readonly Wind[]> = {
  tonpuu: ['E'],
  hanchan: ['E', 'S'],
};

export const HAND_SIZE = 13;

export const DEAD_WALL_RINSHAN_COUNT = 4;
export const DEAD_WALL_DORA_COUNT = 5;
export const DEAD_WALL_URA_DORA_COUNT = 5;
export const DEAD_WALL_TOTAL_SIZE =
  DEAD_WALL_RINSHAN_COUNT + DEAD_WALL_DORA_COUNT + DEAD_WALL_URA_DORA_COUNT;

export const DEAD_WALL_SIZE_BY_PLAYERS: Record<PlayerCount, number> = {
  4: DEAD_WALL_TOTAL_SIZE,
  3: DEAD_WALL_TOTAL_SIZE,
};

export const DEFAULT_RESPONSE_TIMEOUT_MS = 15000;
export const DEFAULT_MAX_KANS_PER_ROUND = 4;
export const RIICHI_STICK_POINTS = 1000;
export const DEFAULT_HONBA_BONUS = true;
export const HONBA_POINTS_BY_PLAYERS: Record<PlayerCount, number> = {
  4: 300,
  3: 1000,
};
export const NOTEN_PENALTY_TOTAL = 3000;

export const DEFAULT_KANDORA_TIMING: KandoraTimingConfig = {
  ankan: 'immediate',
  daiminkan: 'after_discard',
  kakan: 'after_discard',
};

export const DEFAULT_TOBI = true;
export const DEFAULT_TSUMO_LOSS = false;
export const DEFAULT_ALLOW_KUITAN = true;
export const DEFAULT_ALLOW_ATOZUKE = true;

/** 部屋設定には出さず差し替え可能な点数・ローカルルール定数 */
export const DEFAULT_KIRIAGE_MANGAN = false;
export const DEFAULT_ALLOW_KAZOE_YAKUMAN = true;
export const DEFAULT_DOUBLE_WIND_PAIR_FU = 4;
export const DEFAULT_KITA_COUNTS_AS_INDICATOR_DORA = true;

export const SCORE_LIMIT_BASE_POINTS: ScoreLimitBasePoints = {
  mangan: 2000,
  haneman: 3000,
  baiman: 4000,
  sanbaiman: 6000,
  yakuman: 8000,
};

export const DEFAULT_TILE_SET_BY_PLAYERS: Record<PlayerCount, TileSetId> = {
  4: 'standard_136',
  3: 'sanma_no_2m_to_8m_108',
};

/** 牌構成定義（除外牌・コピー枚数を差し替え可能に管理） */
export interface TileSetSpec {
  id: TileSetId;
  copiesPerKind: number;
  excludedKinds: readonly TileKind[];
}

export const TILE_SETS: Record<TileSetId, TileSetSpec> = {
  standard_136: {
    id: 'standard_136',
    copiesPerKind: 4,
    excludedKinds: [],
  },
  sanma_no_2m_to_8m_108: {
    id: 'sanma_no_2m_to_8m_108',
    copiesPerKind: 4,
    excludedKinds: ['2m', '3m', '4m', '5m', '6m', '7m', '8m'],
  },
};

/** deriveRules(config) の返却型（ロジックはすべてこの値を参照） */
export interface DerivedRules {
  playerCount: PlayerCount;
  gameLength: GameLength;
  tileSet: TileSetSpec;
  allowedTileKinds: readonly TileKind[];
  totalTiles: number;
  initialPoints: number;
  seatWinds: readonly Wind[];
  roundWinds: readonly Wind[];
  /** 親が一周する分 × 場数（4人東風=4, 3人東風=3, 4人半荘=8, 3人半荘=6） */
  totalRounds: number;
  handSize: number;
  deadWallSize: number;
  rinshanSize: number;
  doraIndicatorCount: number;
  uraDoraIndicatorCount: number;
  allowChi: boolean;
  allowKita: boolean;
  doubleRon: boolean;
  forbidKuikae: boolean;
  responseTimeoutMs: number;
  maxKansPerRound: number;
  kandoraTiming: KandoraTimingConfig;
  tobi: boolean;
  tsumoLoss: boolean;
  allowKuitan: boolean;
  allowAtozuke: boolean;
  honbaBonus: boolean;
  honbaPointsPerStick: number;
  notenPenaltyTotal: number;
  kiriageMangan: boolean;
  allowKazoeYakuman: boolean;
  doubleWindPairFu: number;
  kitaCountsAsIndicatorDora: boolean;
  riichiStickPoints: number;
  scoreLimits: ScoreLimitBasePoints;
}
