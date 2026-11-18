import type { RuleConfig, Wind } from './rule';
import type {
  AbortiveDrawReason,
  CallOptions,
  CallResponseChoice,
  DiscardEntry,
  FinalKyotakuAward,
  GamePhase,
  GameState,
  Meld,
  NextRoundDecision,
  RoundAgariWinner,
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
      type: 'DECLARE_TSUMO';
      playerId: string;
    }
  | {
      type: 'DECLARE_RIICHI';
      playerId: string;
      tileId: string;
      /** 応答タイマー基準時刻 (epoch ms、省略時は 0) */
      now?: number;
    }
  | {
      type: 'DECLARE_ANKAN';
      playerId: string;
      kind: TileKind;
      /** 槍槓応答タイマー基準時刻 (epoch ms、省略時は 0) */
      now?: number;
    }
  | {
      type: 'DECLARE_KAKAN';
      playerId: string;
      tileId: string;
      /** 槍槓応答タイマー基準時刻 (epoch ms、省略時は 0) */
      now?: number;
    }
  | {
      type: 'DECLARE_KITA';
      playerId: string;
      tileId: string;
    }
  | {
      type: 'DECLARE_KYUUSHU_KYUUHAI';
      playerId: string;
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
    }
  | {
      type: 'UPDATE_RULE_CONFIG';
      playerId: string;
      patch: Partial<RuleConfig>;
    }
  | {
      type: 'JOIN_SPECTATOR';
      spectatorId: string;
      name: string;
    }
  | {
      type: 'LEAVE_SPECTATOR';
      spectatorId: string;
    }
  | {
      type: 'SET_SPECTATOR_CONNECTED';
      spectatorId: string;
      connected: boolean;
    }
  | {
      type: 'TRANSFER_HOST';
      newHostPlayerId: string;
    }
  | {
      type: 'RESET_TO_LOBBY';
      playerId: string;
    };

export interface PublicSpectatorView {
  spectatorId: string;
  name: string;
  connected: boolean;
}

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
  isRiichi: boolean;
  isDoubleRiichi: boolean;
  connected: boolean;
}

export interface RoundView {
  roundIndex: number;
  honba: number;
  totalRounds: number;
  roundWind: Wind;
  kyokuNumber: number;
  dealerIndex: number;
  currentTurnIndex: number;
  /** 現在操作すべきプレイヤーID（応答待ちの秘匿中も自然な手番表示に使う） */
  actingPlayerId: string | null;
  /** 現在の巡目カウント（CPU の決定論的な思考シードに利用） */
  turnCount: number;
  remainingWallCount: number; // 残り枚数のみ（牌山の中身は送らない）
  /** めくり済みの表ドラ表示牌のみ */
  doraIndicators: Tile[];
  /** リーチ者の和了時（round_end）のみ公開される裏ドラ表示牌 */
  uraDoraIndicators: Tile[];
  kanCount: number;
  ronWinners: RoundRonWinner[];
  agariResults: RoundAgariWinner[];
  abortiveDrawReason: AbortiveDrawReason | null;
  abortiveDrawPlayerId: string | null;
  tenpaiPlayerIds: string[];
  revealedHands: Record<string, Tile[]>;
  kyotakuWinnerPlayerId: string | null;
  kyotakuPointsAwarded: number;
  roundScoreDeltas: Record<string, number>;
  isTobiEnded: boolean;
  nextRoundDecision: NextRoundDecision | null;
}

export interface SelfTurnActionsView {
  canTsumo: boolean;
  canRiichiTileIds: string[];
  canAnkanKinds: TileKind[];
  canKakanTileIds: string[];
  canKitaTileIds: string[];
  canKyuushuKyuuhai: boolean;
}

export interface StateView {
  roomCode: string;
  hostPlayerId: string;
  viewerPlayerId: string;
  viewerSeatIndex: number;
  ruleConfig: RuleConfig;
  phase: GamePhase;
  players: PublicPlayerView[];
  initialDealerIndex: number;
  /** 場に出ている供託リーチ棒の本数 */
  kyotakuCount: number;
  /** 終局時の残供託加算情報 */
  finalKyotakuAward: FinalKyotakuAward | null;
  /** 受信者本人の手牌のみ */
  myHand: Tile[];
  /** 受信者本人のツモ牌のみ */
  myDrawnTile: Tile | null;
  /** 受信者本人に対する鳴き・ロン選択要求（該当者のみ非 null） */
  myCallOptions: CallOptions | null;
  /** 受信者本人の手番中に可能なツモ・暗槓・加槓・北抜き */
  mySelfActions: SelfTurnActionsView | null;
  /** 受信者本人が現在フリテン（捨て牌・同巡）状態か */
  isFuriten: boolean;
  /** ポン・チー直後に喰い替えで切れない牌種 */
  kuikaeForbiddenKinds: TileKind[];
  /** 応答待ちの残り時間(ms)（クライアントのタイマー表示用） */
  responseRemainingMs: number | null;
  round: RoundView | null;
  /** 観戦者視点かどうか */
  isSpectator?: boolean;
  /** 現在の観戦者一覧 */
  spectators?: PublicSpectatorView[];
  /** ホスト引き継ぎ世代番号 */
  hostEpoch?: number;
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
  | 'INVALID_AGARI'
  | 'INVALID_RIICHI'
  | 'INVALID_ABORTIVE_DRAW'
  | 'TSUMOGIRI_ONLY'
  | 'FURITEN'
  | 'INVALID_DECK'
  | 'KAN_LIMIT_REACHED'
  | 'WALL_EXHAUSTED'
  | 'UNAUTHORIZED_ACTION'
  | 'INVALID_MESSAGE';

export interface GameError {
  code: ErrorCode;
  message: string;
}

export interface ChatMessage {
  id: string;
  senderId: string;
  senderName: string;
  text: string;
  timestamp: number;
}

export interface SessionWelcomePayload {
  roomCode: string;
  playerId: string;
  playerName: string;
  reconnectToken: string;
  isSpectator: boolean;
  hostEpoch: number;
  hostPeerId: string;
}

export interface HostSnapshotPayload {
  state: GameState;
  chatMessages: ChatMessage[];
  chatSeq: number;
  playerTokens: Record<string, string>;
  spectatorTokens: Record<string, string>;
  hostEpoch: number;
  permanentRoom: boolean;
}

export interface HostCheckpointPayload {
  hostEpoch: number;
  seq: number;
  backupPlayerId: string;
  ivBase64: string;
  ciphertextBase64: string;
  inlineKeyBase64?: string;
}

export interface CheckpointKeyPayload {
  hostEpoch: number;
  seq: number;
  keyBase64: string;
}

export interface HostRedirectPayload {
  roomCode: string;
  hostPeerId: string;
  hostEpoch: number;
}

export interface HostMigratingPayload {
  roomCode: string;
  newHostPlayerId: string;
  newHostPeerId: string;
  hostEpoch: number;
}

/** クライアント → ホスト（要求のみ送る） */
export type ClientMessage =
  | {
      kind: 'JOIN';
      playerName: string;
      reconnectToken?: string;
      preferSpectate?: boolean;
    }
  | {
      kind: 'CHAT';
      text: string;
    }
  | {
      kind: 'CHECKPOINT_KEY_SHARE';
      hostEpoch: number;
      seq: number;
      keyBase64: string;
    }
  | {
      kind: 'ACTION';
      action:
        | { type: 'DISCARD_TILE'; tileId: string }
        | { type: 'CALL_RESPONSE'; choice: CallResponseChoice }
        | { type: 'DECLARE_TSUMO' }
        | { type: 'DECLARE_RIICHI'; tileId: string }
        | { type: 'DECLARE_ANKAN'; kind: TileKind }
        | { type: 'DECLARE_KAKAN'; tileId: string }
        | { type: 'DECLARE_KITA'; tileId: string }
        | { type: 'DECLARE_KYUUSHU_KYUUHAI' }
        | { type: 'ADVANCE_ROUND' };
    };

/** ホスト → クライアント */
export type HostMessage =
  | {
      kind: 'STATE_VIEW';
      payload: StateView;
    }
  | {
      kind: 'SESSION_WELCOME';
      payload: SessionWelcomePayload;
    }
  | {
      kind: 'CHAT_MESSAGE';
      payload: ChatMessage;
    }
  | {
      kind: 'CHAT_HISTORY';
      payload: ChatMessage[];
    }
  | {
      kind: 'HOST_HANDOVER';
      payload: HostSnapshotPayload;
    }
  | {
      kind: 'HOST_CHECKPOINT';
      payload: HostCheckpointPayload;
    }
  | {
      kind: 'CHECKPOINT_KEY';
      payload: CheckpointKeyPayload;
    }
  | {
      kind: 'HOST_MIGRATING';
      payload: HostMigratingPayload;
    }
  | {
      kind: 'HOST_REDIRECT';
      payload: HostRedirectPayload;
    }
  | {
      kind: 'HOST_STATUS';
      payload: { away: boolean };
    }
  | {
      kind: 'ERROR';
      payload: GameError;
    };
