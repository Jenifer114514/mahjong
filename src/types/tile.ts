export type Suit = 'm' | 'p' | 's' | 'z';

export type NumberTileKind = `${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}${'m' | 'p' | 's'}`;
export type HonorTileKind = `${1 | 2 | 3 | 4 | 5 | 6 | 7}z`;
export type TileKind = NumberTileKind | HonorTileKind;

export interface Tile {
  /** 同種牌を区別する一意ID（例: "1m-0".."1m-3"） */
  id: string;
  kind: TileKind;
  /** 第1段階は常に false（将来の赤ドラ対応用） */
  isRed: boolean;
}

/** 34種すべての麻雀牌（理牌順） */
export const ALL_TILE_KINDS: readonly TileKind[] = [
  '1m', '2m', '3m', '4m', '5m', '6m', '7m', '8m', '9m',
  '1p', '2p', '3p', '4p', '5p', '6p', '7p', '8p', '9p',
  '1s', '2s', '3s', '4s', '5s', '6s', '7s', '8s', '9s',
  '1z', '2z', '3z', '4z', '5z', '6z', '7z',
] as const;
