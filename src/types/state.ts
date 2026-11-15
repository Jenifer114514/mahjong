import type { RuleConfig, Wind } from './rule';
import type { Tile } from './tile';

export type GamePhase =
  | 'lobby'     // 参加者待機中
  | 'playing'   // ツモ→打牌ループ中
  | 'round_end' // 流局表示・次局待ち
  | 'finished'; // 全規定局終了・結果表示

export interface DiscardEntry {
  tile: Tile;
  isTsumogiri: boolean;
}

/** 第2段階（副露）用の型スロット（第1段階では常に空配列） */
export interface Meld {
  type: 'pon' | 'chi' | 'kan';
  tiles: Tile[];
  fromSeatIndex?: number;
}

export interface PlayerState {
  playerId: string;
  name: string;
  seatIndex: number;
  score: number;
  hand: Tile[];           // 13枚（理牌済み）
  drawnTile: Tile | null; // 自分の手番中のツモ牌（14枚目）
  discards: DiscardEntry[];
  melds: Meld[];          // 第1段階は常に []
  connected: boolean;
}

export interface RoundState {
  roundIndex: number;         // 0 .. totalRounds - 1
  roundWind: Wind;            // 'E' | 'S'
  kyokuNumber: number;        // 1 .. playerCount（例: 東2局なら2）
  initialDealerIndex: number; // 起家の席番号
  dealerIndex: number;        // 現局の親の席番号
  currentTurnIndex: number;   // 現在の手番席番号
  wall: Tile[];               // 残りのツモ可能牌山
  deadWall: Tile[];           // 王牌
  turnCount: number;
}

export interface GameState {
  roomCode: string;
  hostPlayerId: string;
  ruleConfig: RuleConfig;
  phase: GamePhase;
  players: PlayerState[];
  round: RoundState | null;
}
