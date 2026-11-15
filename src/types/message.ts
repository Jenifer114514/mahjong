import type { RuleConfig, Wind } from './rule';
import type { DiscardEntry, GamePhase, Meld } from './state';
import type { Tile } from './tile';

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
      /** 決定論的テスト・純粋関数維持のため乱数シードをActionに含める */
      seed: number;
    }
  | {
      type: 'DISCARD_TILE';
      playerId: string;
      tileId: string;
    }
  | {
      type: 'ADVANCE_ROUND';
      playerId: string;
      seed: number;
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
  melds: Meld[];         // 第1段階は常に []
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
