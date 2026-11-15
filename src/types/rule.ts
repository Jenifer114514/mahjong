import type { TileKind } from './tile';

export type PlayerCount = 3 | 4;
export type GameLength = 'tonpuu' | 'hanchan';
export type Wind = 'E' | 'S' | 'W' | 'N';

export type TileSetId = 'standard_136' | 'sanma_no_2m_to_8m_108';

export interface RuleConfig {
  playerCount: PlayerCount;
  gameLength: GameLength;
  /** 省略時は DEFAULT_TILE_SET_BY_PLAYERS[playerCount] を使用（将来の差し替え用） */
  tileSetId?: TileSetId;
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

export const DEAD_WALL_SIZE_BY_PLAYERS: Record<PlayerCount, number> = {
  4: 14,
  3: 14,
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
}
