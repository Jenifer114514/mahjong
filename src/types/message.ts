import type { RuleConfig, Wind } from './rule';
import type {
  CallOptions,
  CallResponseChoice,
  DiscardEntry,
  GamePhase,
  Meld,
  RoundRonWinner,
} from './state';
import type { Tile, TileKind } from './tile';

/** 純粋関数 (state, action) => state に渡すアクション */
export type Action =
  | {
      type: 'JOIN_PLAYER';
      playerId: string;
      name: string;
    }
  | {
      type: 'LEAVE_LOBBY';
      playerId: string;
    }
  | {
      type: 'START_GAME';
      /** ホストが CSPRNG 等で生成したシャッフル済み山（テストでは固定牌順） */
      shuffledDeck: Tile[];
      /** 席順シャッフル結果の playerId 配列（省略時は参加順） */
      shuffledPlayerIds?: string[];
    }
  | {
      type: 'DISCARD_TILE';
      playerId: string;
      tileId: string;
      /** 応答タイマー基準時刻 (epoch ms、省略時は 0) */
      now?: number;
    }
  | {
      type: 'CALL_RESPONSE';
      playerId: string;
      choice: CallResponseChoice;
    }
  | {
      type: 'RESPONSE_TIMEOUT';
      playerId: string;
      /** タイムアウトスケジュール時の turnCount（古いタイマー発火防止） */
      turnCount?: number;
    }
  | {
      type: 'DECLARE_ANKAN';
      playerId: string;
      kind: TileKind;
    }
  | {
      type: 'DECLARE_KAKAN';
      playerId: string;
      tileId: string;
    }
  | {
      type: 'DECLARE_KITA';
      playerId: string;
      tileId: string;
    }
  | {
      type: 'ADVANCE_ROUND';
      playerId: string;
      /** ホストが CSPRNG 等で生成した次局のシャッフル済み山 */
      shuffledDeck: Tile[];
    }
  | {
      type: 'SET_PLAYER_CONNECTED';
      playerId: string;
      connected: boolean;
    };

export interface PublicPlayerView {
  playerId: string;
  name: string;
  seatIndex: number;
  seatWind: Wind | null; // 対局中は自風、ロビー・終局時は null
  score: number;
  handCount: number;     // 枚数のみ（他人の手牌内容は送らない）
  hasDrawnTile: boolean; // ツモ牌保持フラグ
  discards: DiscardEntry[];
  melds: Meld[];
  kitaTiles: Tile[];
  isDealer: boolean;
  isCurrentTurn: boolean;
  connected: boolean;
}

export interface RoundView {
  roundIndex: number;
  totalRounds: number;
  roundWind: Wind;
  kyokuNumber: number;
  dealerIndex: number;
  currentTurnIndex: number;
  remainingWallCount: number; // 残り枚数のみ（牌山の中身は送らない）
  /** めくり済みの表ドラ表示牌のみ */
  doraIndicators: Tile[];
  kanCount: number;
  ronWinners: RoundRonWinner[];
}

export interface SelfTurnActionsView {
  canAnkanKinds: TileKind[];
  canKakanTileIds: string[];
  canKitaTileIds: string[];
}

export interface StateView {
  roomCode: string;
  hostPlayerId: string;
  viewerPlayerId: string;
  viewerSeatIndex: number;
  ruleConfig: RuleConfig;
  phase: GamePhase;
  players: PublicPlayerView[];
  /** 受信者本人の手牌のみ */
  myHand: Tile[];
  /** 受信者本人のツモ牌のみ */
  myDrawnTile: Tile | null;
  /** 受信者本人に対する鳴き・ロン選択要求（該当者のみ非 null） */
  myCallOptions: CallOptions | null;
  /** 受信者本人の手番中に可能な暗槓・加槓・北抜き */
  mySelfActions: SelfTurnActionsView | null;
  /** ポン・チー直後に喰い替えで切れない牌種 */
  kuikaeForbiddenKinds: TileKind[];
  /** 応答待ちの残り時間(ms)（クライアントのタイマー表示用） */
  responseRemainingMs: number | null;
  round: RoundView | null;
}

export type ErrorCode =
  | 'ROOM_FULL'
  | 'GAME_ALREADY_STARTED'
  | 'NOT_ENOUGH_PLAYERS'
  | 'INVALID_PHASE'
  | 'NOT_YOUR_TURN'
  | 'PLAYER_NOT_FOUND'
  | 'DUPLICATE_PLAYER'
  | 'TILE_NOT_IN_HAND'
  | 'FORBIDDEN_KUIKAE'
  | 'INVALID_CALL'
  | 'INVALID_DECK'
  | 'KAN_LIMIT_REACHED'
  | 'WALL_EXHAUSTED'
  | 'UNAUTHORIZED_ACTION'
  | 'INVALID_MESSAGE';

export interface GameError {
  code: ErrorCode;
  message: string;
}

/** クライアント → ホスト（要求のみ送る） */
export type ClientMessage =
  | {
      kind: 'JOIN';
      playerName: string;
    }
  | {
      kind: 'ACTION';
      action:
        | { type: 'DISCARD_TILE'; tileId: string }
        | { type: 'CALL_RESPONSE'; choice: CallResponseChoice }
        | { type: 'DECLARE_ANKAN'; kind: TileKind }
        | { type: 'DECLARE_KAKAN'; tileId: string }
        | { type: 'DECLARE_KITA'; tileId: string }
        | { type: 'ADVANCE_ROUND' };
    };

/** ホスト → クライアント */
export type HostMessage =
  | {
      kind: 'STATE_VIEW';
      payload: StateView;
    }
  | {
      kind: 'ERROR';
      payload: GameError;
    };
