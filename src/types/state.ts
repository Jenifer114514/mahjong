import type { CpuLevel, RuleConfig, Wind } from './rule';
import type { Tile, TileKind } from './tile';

export type GamePhase =
  | 'lobby'              // 参加者待機中
  | 'playing'            // 現在の手番プレイヤーの操作待ち
  | 'awaiting_responses' // 打牌に対する鳴き・ロン応答待ち
  | 'round_end'          // 流局または和了表示・次局待ち
  | 'finished';          // 全規定局終了・結果表示

export type AbortiveDrawReason =
  | 'kyuushu_kyuuhai'
  | 'suufon_renda'
  | 'suucha_riichi'
  | 'suukanzu'
  | 'sancha_hou';

export interface DiscardEntry {
  tile: Tile;
  isTsumogiri: boolean;
  isRiichiDeclaration?: boolean;
}

export type MeldType = 'pon' | 'chi' | 'daiminkan' | 'kakan' | 'ankan';

export interface Meld {
  type: MeldType;
  /** 面子を構成する全牌（3枚または4枚） */
  tiles: Tile[];
  /** 鳴いた牌（暗槓は null、加槓は元ポンの鳴いた牌） */
  calledTile: Tile | null;
  /** 鳴き元の席番号（暗槓は null、加槓は元ポンの鳴き元席番号） */
  fromSeatIndex: number | null;
  /** 加槓で手牌／ツモ牌から足した牌（加槓以外は null） */
  addedTile: Tile | null;
}

export interface DeadWallState {
  /** 嶺上牌（4枚） */
  rinshanTiles: Tile[];
  /** 表ドラ表示牌（5枚） */
  doraIndicators: Tile[];
  /** 裏ドラ表示牌（5枚） */
  uraDoraIndicators: Tile[];
  /** めくり済みの表ドラ表示牌枚数（初期 1） */
  revealedDoraCount: number;
  /** 打牌後にめくる予約が入っているカンドラ数 */
  pendingKandoraCount: number;
}

export interface ChiOption {
  /** 手牌から出す2枚（種類・UI表示・送信指定用） */
  tiles: [Tile, Tile];
}

export interface CallOptions {
  discardedTile: Tile;
  discarderSeatIndex: number;
  canRon: boolean;
  canPon: boolean;
  canDaiminkan: boolean;
  chiOptions: ChiOption[];
}

export type CallResponseChoice =
  | { type: 'pass' }
  | { type: 'ron' }
  | { type: 'pon'; tileIds?: [string, string] }
  | { type: 'daiminkan' }
  | { type: 'chi'; tileIds: [string, string] };

export interface PendingRiichiDeclaration {
  playerId: string;
  isDoubleRiichi: boolean;
}

export interface PendingResponseState {
  /** 応答待ちの契機（省略時は通常打牌 'discard'） */
  kind?: 'discard' | 'kakan' | 'ankan';
  discarderSeatIndex: number;
  discardedTile: Tile;
  /** 応答待ち開始時点の turnCount */
  turnCount: number;
  /** 応答待ち開始時刻 (epoch ms、テスト時は 0) */
  openedAt: number;
  /** 選択肢を持つプレイヤーID -> 許可された選択肢（他者には非公開） */
  optionsByPlayerId: Record<string, CallOptions>;
  /** 受信済みの応答 */
  responses: Record<string, CallResponseChoice>;
  /** この打牌がリーチ宣言牌である場合の保留情報 */
  riichiDeclaration?: PendingRiichiDeclaration | null;
  /** 加槓の槍槓応答待ち時の保留情報 */
  kakanTarget?: { playerId: string; addedTile: Tile } | null;
  /** 暗槓の国士無双槍槓応答待ち時の保留情報 */
  ankanTarget?: { playerId: string; kind: TileKind } | null;
}

export interface RoundRonWinner {
  playerId: string;
  seatIndex: number;
  fromSeatIndex: number;
  winningTile: Tile;
}

export interface YakuEntry {
  id: string;
  name: string;
  han: number;
  isYakuman?: boolean;
  yakumanMultiplier?: number;
}

export interface RoundAgariWinner {
  winType: 'ron' | 'tsumo';
  playerId: string;
  seatIndex: number;
  fromSeatIndex: number | null;
  winningTile: Tile;
  hand: Tile[];
  melds: Meld[];
  kitaTiles: Tile[];
  yaku: YakuEntry[];
  doraCount: number;
  uraDoraCount: number;
  kitaCount: number;
  han: number;
  fu: number;
  isYakuman: boolean;
  scoreLabel: string;
  pointsAwarded: number;
  honbaPointsAwarded: number;
  /** playerId -> この和了による点棒増減（供託受取分は別で roundScoreDeltas に合算、本場加算はここにも含む） */
  scoreDeltas: Record<string, number>;
}

export type NextRoundOutcome = 'renchan' | 'oya_nagare' | 'game_end';

export type NextRoundReason =
  | 'tobi'
  | 'oya_agari'
  | 'double_ron_with_oya'
  | 'ko_agari'
  | 'oya_tenpai_draw'
  | 'oya_noten_draw'
  | 'abortive_draw';

export interface NextRoundDecision {
  outcome: NextRoundOutcome;
  nextRoundIndex: number;
  nextHonba: number;
  isOorasu: boolean;
  reason: NextRoundReason;
}

export interface FinalKyotakuAward {
  playerId: string;
  points: number;
}

export interface PlayerState {
  playerId: string;
  name: string;
  seatIndex: number;
  score: number;
  hand: Tile[];           // 門前手牌（理牌済み）
  drawnTile: Tile | null; // ツモ牌（副露直後の打牌前は null）
  discards: DiscardEntry[];
  /** 鳴かれた牌も含むこの局の打牌履歴（捨て牌フリテン判定用） */
  discardedKinds: TileKind[];
  /** ロン見逃し後の同巡フリテン状態（本人の次回打牌で解除） */
  sameTurnFuriten: boolean;
  /** リーチ後にロンを見逃した場合の永久ロンフリテン状態 */
  isRiichiFuriten: boolean;
  isRiichi: boolean;
  isDoubleRiichi: boolean;
  ippatsuEligible: boolean;
  /** リーチ宣言牌を他家に鳴かれたため、次打牌を横向き宣言牌とするフラグ */
  pendingRiichiSideways: boolean;
  /** 現在のツモ牌が嶺上牌（カン・抜北の補充ツモ）によるものか */
  isRinshanDraw: boolean;
  melds: Meld[];
  kitaTiles: Tile[];      // 3人麻雀の抜き北
  connected: boolean;
  isCpu: boolean;
  cpuLevel?: CpuLevel;
}

export interface RoundState {
  roundIndex: number;         // 0 .. totalRounds - 1
  honba: number;              // 積み棒の本数（0..）
  roundWind: Wind;            // 'E' | 'S'
  kyokuNumber: number;        // 1 .. playerCount（例: 東2局なら2）
  initialDealerIndex: number; // 起家の席番号
  dealerIndex: number;        // 現局の親の席番号
  currentTurnIndex: number;   // 現在の手番席番号
  wall: Tile[];               // 残りのツモ可能牌山
  deadWall: DeadWallState;    // 構造化された王牌（14枚）
  turnCount: number;
  kanCount: number;           // この局で行われた合計カン回数（上限4）
  /** 鳴き・カンがまだ一度も発生していない第1巡状態（北抜きでは崩れない） */
  firstTurnUninterrupted: boolean;
  kuikaeForbiddenKinds: TileKind[]; // ポン・チー直後の1打のみ禁止される牌種
  pendingResponse: PendingResponseState | null;
  ronWinners: RoundRonWinner[];
  agariResults: RoundAgariWinner[];
  /** リーチ者の和了時に公開される裏ドラ表示牌 */
  uraDoraIndicators: Tile[];
  /** 途中流局の種別（通常進行・和了・荒牌平局では null） */
  abortiveDrawReason: AbortiveDrawReason | null;
  /** 九種九牌などを宣言したプレイヤーID */
  abortiveDrawPlayerId: string | null;
  /** 通常流局時に自動判定されたテンパイ者のプレイヤーID一覧 */
  tenpaiPlayerIds: string[];
  /** 途中流局（九種九牌）や通常流局（テンパイ者のみ）で開示された手牌 */
  revealedHands: Record<string, Tile[]>;
  kyotakuWinnerPlayerId: string | null;
  kyotakuPointsAwarded: number;
  roundScoreDeltas: Record<string, number>;
  isTobiEnded: boolean;
  nextRoundDecision: NextRoundDecision | null;
}

export interface GameState {
  roomCode: string;
  hostPlayerId: string;
  ruleConfig: RuleConfig;
  phase: GamePhase;
  players: PlayerState[];
  initialDealerIndex: number;
  /** 場に出ている供託リーチ棒の本数（1本 = 1000点） */
  kyotakuCount: number;
  /** 終局時に場に残っていた供託を最終トップへ加算した記録 */
  finalKyotakuAward: FinalKyotakuAward | null;
  round: RoundState | null;
}
