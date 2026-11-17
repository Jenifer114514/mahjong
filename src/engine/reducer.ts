import type { Action, GameError } from '../types/message';
import type { DerivedRules, RuleConfig } from '../types/rule';
import type {
  AbortiveDrawReason,
  CallResponseChoice,
  GameState,
  PendingResponseState,
  PlayerState,
  RoundAgariWinner,
  RoundRonWinner,
} from '../types/state';
import type { Tile } from '../types/tile';
import {
  canAnkanPreserveRiichiWaits,
  getCanRiichiDiscardTileIds,
} from './agari';
import {
  buildPendingCallOptions,
  buildPendingChankanOptions,
  canDeclareKyuushuKyuuhai,
  computeChiKuikaeKinds,
  DEFAULT_ENGINE_HOOKS,
  type EngineHooks,
  evaluateRonForPlayer,
  evaluateTsumoFromRound,
  isSuukanzuTriggered,
  validateChiTilePair,
  validatePonTilePair,
} from './calls';
import { getRevealedUraDoraIndicators } from './dora';
import {
  calculateNotenPenalties,
  decideNextRound,
  resolveLeftoverKyotaku,
} from './roundProgression';
import { deriveRules, getRoundMetadata } from './rules';
import type { AgariScoreResult } from './score';
import {
  applyKandoraTiming,
  dealRoundFromDeck,
  drawRinshanAndReplenish,
  flushPendingKandora,
  sortTiles,
  validateDeckForRules,
} from './wall';

export interface CreateInitialGameParams {
  roomCode: string;
  hostPlayerId: string;
  hostName: string;
  ruleConfig: RuleConfig;
}

function normalizePlayerName(name: string, fallbackNumber: number): string {
  const trimmed = name.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 20) : `プレイヤー${fallbackNumber}`;
}

function areSamePlayerIds(
  existing: readonly PlayerState[],
  candidateIds: readonly string[],
): boolean {
  if (existing.length !== candidateIds.length) return false;
  const expected = new Set(existing.map((p) => p.playerId));
  const seen = new Set<string>();
  for (const id of candidateIds) {
    if (!expected.has(id) || seen.has(id)) {
      return false;
    }
    seen.add(id);
  }
  return seen.size === expected.size;
}

function removeTilesFromHand(
  hand: readonly Tile[],
  removeIds: readonly string[],
): Tile[] {
  const ids = new Set(removeIds);
  return sortTiles(hand.filter((t) => !ids.has(t.id)));
}

function extractTileFromHandOrDrawn(
  player: PlayerState,
  tileId: string,
): { extracted: Tile; nextHand: Tile[] } | null {
  if (player.drawnTile && player.drawnTile.id === tileId) {
    return {
      extracted: player.drawnTile,
      nextHand: sortTiles(player.hand),
    };
  }
  const idx = player.hand.findIndex((t) => t.id === tileId);
  if (idx === -1) return null;
  const extracted = player.hand[idx]!;
  const remaining = player.hand.filter((_, i) => i !== idx);
  if (player.drawnTile !== null) {
    remaining.push(player.drawnTile);
  }
  return {
    extracted,
    nextHand: sortTiles(remaining),
  };
}

function deltasBySeatToPlayerMap(
  players: readonly PlayerState[],
  deltasBySeat: readonly number[],
): Record<string, number> {
  const result: Record<string, number> = {};
  for (const p of players) {
    result[p.playerId] = deltasBySeat[p.seatIndex] ?? 0;
  }
  return result;
}

function buildAgariWinnerRecord(params: {
  winType: 'ron' | 'tsumo';
  winner: PlayerState;
  fromSeatIndex: number | null;
  winningTile: Tile;
  players: readonly PlayerState[];
  evalResult: AgariScoreResult;
}): RoundAgariWinner {
  const { winType, winner, fromSeatIndex, winningTile, players, evalResult } = params;
  return {
    winType,
    playerId: winner.playerId,
    seatIndex: winner.seatIndex,
    fromSeatIndex,
    winningTile,
    hand: sortTiles(winner.hand),
    melds: winner.melds.map((m) => ({
      ...m,
      tiles: [...m.tiles],
    })),
    kitaTiles: [...winner.kitaTiles],
    yaku: evalResult.yaku.map((y) => ({ ...y })),
    doraCount: evalResult.doraCount,
    uraDoraCount: evalResult.uraDoraCount,
    kitaCount: evalResult.kitaCount,
    han: evalResult.totalHan,
    fu: evalResult.fu,
    isYakuman: evalResult.isYakuman,
    scoreLabel: evalResult.scoreLabel,
    pointsAwarded: evalResult.pointsAwarded,
    honbaPointsAwarded: evalResult.honbaPointsAwarded,
    scoreDeltas: deltasBySeatToPlayerMap(players, evalResult.deltasBySeat),
  };
}

function getNextRoundDecisionForRound(
  state: GameState,
  rules: DerivedRules,
) {
  const round = state.round!;
  if (round.nextRoundDecision !== null) {
    return round.nextRoundDecision;
  }
  const winnerSeats = (
    round.agariResults.length > 0 ? round.agariResults : round.ronWinners
  ).map((w) => w.seatIndex);
  return decideNextRound(
    {
      roundIndex: round.roundIndex,
      honba: round.honba,
      dealerIndex: round.dealerIndex,
      agariWinnerSeatIndices: winnerSeats,
      abortiveDrawReason: round.abortiveDrawReason,
      tenpaiPlayerIds: round.tenpaiPlayerIds,
      isTobiEnded: round.isTobiEnded,
    },
    state.players,
    rules,
  );
}

function mergeRuleConfig(
  current: RuleConfig,
  patch: Partial<RuleConfig>,
): RuleConfig {
  const next: RuleConfig = {
    ...current,
    ...patch,
  };
  if (
    patch.playerCount !== undefined &&
    patch.playerCount !== current.playerCount
  ) {
    delete next.tileSetId;
    delete next.allowChi;
    delete next.allowKita;
    if (next.playerCount === 4) {
      next.tsumoLoss = false;
    }
  }
  return next;
}

export function createInitialGameState(params: CreateInitialGameParams): GameState {
  const rules = deriveRules(params.ruleConfig);
  const hostPlayer: PlayerState = {
    playerId: params.hostPlayerId,
    name: normalizePlayerName(params.hostName, 1),
    seatIndex: 0,
    score: rules.initialPoints,
    hand: [],
    drawnTile: null,
    discards: [],
    discardedKinds: [],
    sameTurnFuriten: false,
    isRiichiFuriten: false,
    isRiichi: false,
    isDoubleRiichi: false,
    ippatsuEligible: false,
    pendingRiichiSideways: false,
    isRinshanDraw: false,
    melds: [],
    kitaTiles: [],
    connected: true,
  };

  return {
    roomCode: params.roomCode,
    hostPlayerId: params.hostPlayerId,
    ruleConfig: { ...params.ruleConfig },
    phase: 'lobby',
    players: [hostPlayer],
    initialDealerIndex: 0,
    kyotakuCount: 0,
    finalKyotakuAward: null,
    round: null,
  };
}

export function validateAction(
  state: GameState,
  action: Action,
  _hooks: EngineHooks = DEFAULT_ENGINE_HOOKS,
): GameError | null {
  const rules = deriveRules(state.ruleConfig);

  switch (action.type) {
    case 'JOIN_PLAYER': {
      if (state.phase !== 'lobby') {
        return {
          code: 'GAME_ALREADY_STARTED',
          message: 'すでに対局が開始されています。',
        };
      }
      if (state.players.some((p) => p.playerId === action.playerId)) {
        return {
          code: 'DUPLICATE_PLAYER',
          message: 'すでに参加済みのプレイヤーです。',
        };
      }
      if (state.players.length >= rules.playerCount) {
        return {
          code: 'ROOM_FULL',
          message: '部屋が満員です。',
        };
      }
      return null;
    }

    case 'LEAVE_LOBBY': {
      if (state.phase !== 'lobby') {
        return {
          code: 'INVALID_PHASE',
          message: '対局開始後はロビー離脱できません。',
        };
      }
      if (action.playerId === state.hostPlayerId) {
        return {
          code: 'UNAUTHORIZED_ACTION',
          message: 'ホストはロビー離脱できません。',
        };
      }
      if (!state.players.some((p) => p.playerId === action.playerId)) {
        return {
          code: 'PLAYER_NOT_FOUND',
          message: '該当プレイヤーが見つかりません。',
        };
      }
      return null;
    }

    case 'START_GAME': {
      if (state.phase !== 'lobby') {
        return {
          code: 'INVALID_PHASE',
          message: 'ロビー待機中のみ開始できます。',
        };
      }
      if (state.players.length !== rules.playerCount) {
        return {
          code: 'NOT_ENOUGH_PLAYERS',
          message: `開始には${rules.playerCount}人の参加者が必要です。`,
        };
      }
      if (
        action.shuffledPlayerIds !== undefined &&
        !areSamePlayerIds(state.players, action.shuffledPlayerIds)
      ) {
        return {
          code: 'INVALID_MESSAGE',
          message: '席順シャッフル結果が参加プレイヤーと一致しません。',
        };
      }
      if (!validateDeckForRules(rules, action.shuffledDeck)) {
        return {
          code: 'INVALID_DECK',
          message: '山牌の構成がルールと一致しません。',
        };
      }
      return null;
    }

    case 'DISCARD_TILE': {
      if (state.phase !== 'playing' || state.round === null) {
        return {
          code: 'INVALID_PHASE',
          message: '打牌できる状態ではありません。',
        };
      }
      const player = state.players.find((p) => p.playerId === action.playerId);
      if (!player) {
        return {
          code: 'PLAYER_NOT_FOUND',
          message: 'プレイヤーが見つかりません。',
        };
      }
      if (player.seatIndex !== state.round.currentTurnIndex) {
        return {
          code: 'NOT_YOUR_TURN',
          message: 'あなたの手番ではありません。',
        };
      }
      const drawnMatch =
        player.drawnTile?.id === action.tileId ? player.drawnTile : null;
      const handMatch =
        drawnMatch ?? player.hand.find((t) => t.id === action.tileId) ?? null;
      if (!handMatch) {
        return {
          code: 'TILE_NOT_IN_HAND',
          message: '指定した牌が手牌にありません。',
        };
      }
      if (player.isRiichi && action.tileId !== player.drawnTile?.id) {
        return {
          code: 'TSUMOGIRI_ONLY',
          message: 'リーチ後はツモ切りしかできません。',
        };
      }
      if (
        rules.forbidKuikae &&
        state.round.kuikaeForbiddenKinds.includes(handMatch.kind)
      ) {
        return {
          code: 'FORBIDDEN_KUIKAE',
          message: '喰い替えとなる牌は切れません。',
        };
      }
      return null;
    }

    case 'DECLARE_RIICHI': {
      if (state.phase !== 'playing' || state.round === null) {
        return {
          code: 'INVALID_PHASE',
          message: 'リーチ宣言できる状態ではありません。',
        };
      }
      const player = state.players.find((p) => p.playerId === action.playerId);
      if (!player) {
        return {
          code: 'PLAYER_NOT_FOUND',
          message: 'プレイヤーが見つかりません。',
        };
      }
      if (player.seatIndex !== state.round.currentTurnIndex) {
        return {
          code: 'NOT_YOUR_TURN',
          message: 'あなたの手番ではありません。',
        };
      }
      if (player.isRiichi) {
        return {
          code: 'INVALID_RIICHI',
          message: 'すでにリーチ宣言済みです。',
        };
      }
      if (!player.melds.every((m) => m.type === 'ankan')) {
        return {
          code: 'INVALID_RIICHI',
          message: '門前でないためリーチできません。',
        };
      }
      if (player.drawnTile === null) {
        return {
          code: 'INVALID_RIICHI',
          message: 'ツモ直後のみリーチ宣言できます。',
        };
      }
      if (player.score < rules.riichiStickPoints) {
        return {
          code: 'INVALID_RIICHI',
          message: `リーチには持ち点${rules.riichiStickPoints}点以上が必要です。`,
        };
      }
      if (state.round.wall.length < rules.playerCount) {
        return {
          code: 'INVALID_RIICHI',
          message: 'ツモ山が残り人数未満のためリーチできません。',
        };
      }
      const drawnMatch =
        player.drawnTile.id === action.tileId ? player.drawnTile : null;
      const handMatch =
        drawnMatch ?? player.hand.find((t) => t.id === action.tileId) ?? null;
      if (!handMatch) {
        return {
          code: 'TILE_NOT_IN_HAND',
          message: '指定した牌が手牌にありません。',
        };
      }
      const legalIds = getCanRiichiDiscardTileIds(
        player.hand,
        player.drawnTile,
        player.melds,
        rules,
      );
      if (!legalIds.includes(action.tileId)) {
        return {
          code: 'INVALID_RIICHI',
          message: 'その牌を切っても聴牌にならないためリーチできません。',
        };
      }
      return null;
    }

    case 'CALL_RESPONSE': {
      if (
        state.phase !== 'awaiting_responses' ||
        state.round === null ||
        state.round.pendingResponse === null
      ) {
        return {
          code: 'INVALID_PHASE',
          message: '現在は鳴き・ロンの応答待ち状態ではありません。',
        };
      }
      const pending = state.round.pendingResponse;
      const options = pending.optionsByPlayerId[action.playerId];
      if (!options) {
        return {
          code: 'INVALID_CALL',
          message: '応答権限のないプレイヤーです。',
        };
      }
      if (action.playerId in pending.responses) {
        return {
          code: 'INVALID_CALL',
          message: 'すでに応答を送信済みです。',
        };
      }
      const player = state.players.find((p) => p.playerId === action.playerId);
      if (!player) {
        return {
          code: 'PLAYER_NOT_FOUND',
          message: 'プレイヤーが見つかりません。',
        };
      }

      switch (action.choice.type) {
        case 'pass':
          return null;
        case 'ron':
          if (!options.canRon) {
            return {
              code: 'INVALID_CALL',
              message: 'ロンできない状態です。',
            };
          }
          return null;
        case 'pon': {
          if (!options.canPon) {
            return {
              code: 'INVALID_CALL',
              message: 'ポンできない状態です。',
            };
          }
          const pair = validatePonTilePair(
            player.hand,
            pending.discardedTile,
            action.choice.tileIds,
            rules.forbidKuikae,
          );
          if (!pair) {
            return {
              code: 'INVALID_CALL',
              message: 'ポンに指定された牌が不正です。',
            };
          }
          return null;
        }
        case 'daiminkan':
          if (
            !options.canDaiminkan ||
            state.round.wall.length === 0 ||
            state.round.kanCount >= rules.maxKansPerRound
          ) {
            return {
              code: 'INVALID_CALL',
              message: '大明槓できない状態です。',
            };
          }
          return null;
        case 'chi': {
          if (options.chiOptions.length === 0) {
            return {
              code: 'INVALID_CALL',
              message: 'チーできない状態です。',
            };
          }
          const pair = validateChiTilePair(
            player.hand,
            pending.discardedTile,
            action.choice.tileIds,
            rules.forbidKuikae,
          );
          if (!pair) {
            return {
              code: 'INVALID_CALL',
              message: 'チーに指定された牌の組み合わせが不正です。',
            };
          }
          return null;
        }
      }
    }

    case 'RESPONSE_TIMEOUT': {
      if (
        state.phase !== 'awaiting_responses' ||
        state.round === null ||
        state.round.pendingResponse === null
      ) {
        return {
          code: 'INVALID_PHASE',
          message: '現在は応答待ち状態ではありません。',
        };
      }
      if (action.playerId !== state.hostPlayerId) {
        return {
          code: 'UNAUTHORIZED_ACTION',
          message: 'タイムアウト処理はホストのみ実行できます。',
        };
      }
      if (
        action.turnCount !== undefined &&
        action.turnCount !== state.round.pendingResponse.turnCount
      ) {
        return {
          code: 'INVALID_PHASE',
          message: '古い応答待ちタイマーは無視されました。',
        };
      }
      return null;
    }

    case 'DECLARE_TSUMO': {
      if (state.phase !== 'playing' || state.round === null) {
        return {
          code: 'INVALID_PHASE',
          message: 'ツモ和了できる状態ではありません。',
        };
      }
      const player = state.players.find((p) => p.playerId === action.playerId);
      if (!player) {
        return {
          code: 'PLAYER_NOT_FOUND',
          message: 'プレイヤーが見つかりません。',
        };
      }
      if (player.seatIndex !== state.round.currentTurnIndex) {
        return {
          code: 'NOT_YOUR_TURN',
          message: 'あなたの手番ではありません。',
        };
      }
      if (player.drawnTile === null) {
        return {
          code: 'INVALID_AGARI',
          message: '副露直後の打牌前にはツモ和了できません。',
        };
      }
      if (evaluateTsumoFromRound(player, state.round, rules) === null) {
        return {
          code: 'INVALID_AGARI',
          message: '和了形または成立役を満たしていないためツモ和了できません。',
        };
      }
      return null;
    }

    case 'DECLARE_ANKAN': {
      if (state.phase !== 'playing' || state.round === null) {
        return {
          code: 'INVALID_PHASE',
          message: '暗槓できる状態ではありません。',
        };
      }
      const player = state.players.find((p) => p.playerId === action.playerId);
      if (!player) {
        return {
          code: 'PLAYER_NOT_FOUND',
          message: 'プレイヤーが見つかりません。',
        };
      }
      if (player.seatIndex !== state.round.currentTurnIndex) {
        return {
          code: 'NOT_YOUR_TURN',
          message: 'あなたの手番ではありません。',
        };
      }
      if (player.drawnTile === null) {
        return {
          code: 'INVALID_CALL',
          message: '副露直後の打牌前には暗槓できません。',
        };
      }
      if (state.round.wall.length === 0) {
        return {
          code: 'WALL_EXHAUSTED',
          message: '海底ではカンできません。',
        };
      }
      if (state.round.kanCount >= rules.maxKansPerRound) {
        return {
          code: 'KAN_LIMIT_REACHED',
          message: `1局の合計カン上限（${rules.maxKansPerRound}回）に達しています。`,
        };
      }
      const count = [...player.hand, player.drawnTile].filter(
        (t) => t.kind === action.kind,
      ).length;
      if (count !== 4) {
        return {
          code: 'TILE_NOT_IN_HAND',
          message: '同じ牌が4枚揃っていないため暗槓できません。',
        };
      }
      if (
        player.isRiichi &&
        !canAnkanPreserveRiichiWaits(
          player.hand,
          player.drawnTile,
          player.melds,
          action.kind,
          rules,
        )
      ) {
        return {
          code: 'INVALID_CALL',
          message: 'リーチ後は待ちが変わる暗槓はできません。',
        };
      }
      return null;
    }

    case 'DECLARE_KAKAN': {
      if (state.phase !== 'playing' || state.round === null) {
        return {
          code: 'INVALID_PHASE',
          message: '加槓できる状態ではありません。',
        };
      }
      const player = state.players.find((p) => p.playerId === action.playerId);
      if (!player) {
        return {
          code: 'PLAYER_NOT_FOUND',
          message: 'プレイヤーが見つかりません。',
        };
      }
      if (player.seatIndex !== state.round.currentTurnIndex) {
        return {
          code: 'NOT_YOUR_TURN',
          message: 'あなたの手番ではありません。',
        };
      }
      if (player.isRiichi) {
        return {
          code: 'INVALID_CALL',
          message: 'リーチ後は加槓できません。',
        };
      }
      if (player.drawnTile === null) {
        return {
          code: 'INVALID_CALL',
          message: '副露直後の打牌前には加槓できません。',
        };
      }
      if (state.round.wall.length === 0) {
        return {
          code: 'WALL_EXHAUSTED',
          message: '海底ではカンできません。',
        };
      }
      if (state.round.kanCount >= rules.maxKansPerRound) {
        return {
          code: 'KAN_LIMIT_REACHED',
          message: `1局の合計カン上限（${rules.maxKansPerRound}回）に達しています。`,
        };
      }
      const targetTile =
        player.drawnTile.id === action.tileId
          ? player.drawnTile
          : player.hand.find((t) => t.id === action.tileId);
      if (!targetTile) {
        return {
          code: 'TILE_NOT_IN_HAND',
          message: '指定した牌が手牌にありません。',
        };
      }
      const hasMatchingPon = player.melds.some(
        (m) => m.type === 'pon' && m.tiles[0]?.kind === targetTile.kind,
      );
      if (!hasMatchingPon) {
        return {
          code: 'INVALID_CALL',
          message: '対応するポン面子がないため加槓できません。',
        };
      }
      return null;
    }

    case 'DECLARE_KITA': {
      if (state.phase !== 'playing' || state.round === null) {
        return {
          code: 'INVALID_PHASE',
          message: '北抜きできる状態ではありません。',
        };
      }
      if (!rules.allowKita) {
        return {
          code: 'UNAUTHORIZED_ACTION',
          message: '現在のルールでは北抜きは無効です。',
        };
      }
      const player = state.players.find((p) => p.playerId === action.playerId);
      if (!player) {
        return {
          code: 'PLAYER_NOT_FOUND',
          message: 'プレイヤーが見つかりません。',
        };
      }
      if (player.seatIndex !== state.round.currentTurnIndex) {
        return {
          code: 'NOT_YOUR_TURN',
          message: 'あなたの手番ではありません。',
        };
      }
      if (player.drawnTile === null) {
        return {
          code: 'INVALID_CALL',
          message: '副露直後の打牌前には北抜きできません。',
        };
      }
      if (state.round.wall.length === 0) {
        return {
          code: 'WALL_EXHAUSTED',
          message: '海底では北抜きできません。',
        };
      }
      const targetTile =
        player.drawnTile.id === action.tileId
          ? player.drawnTile
          : player.hand.find((t) => t.id === action.tileId);
      if (!targetTile || targetTile.kind !== '4z') {
        return {
          code: 'TILE_NOT_IN_HAND',
          message: '指定した牌が北(4z)ではありません。',
        };
      }
      if (player.isRiichi && action.tileId !== player.drawnTile.id) {
        return {
          code: 'INVALID_CALL',
          message: 'リーチ後はツモってきた北のみ抜けます。',
        };
      }
      return null;
    }

    case 'DECLARE_KYUUSHU_KYUUHAI': {
      if (state.phase !== 'playing' || state.round === null) {
        return {
          code: 'INVALID_PHASE',
          message: '九種九牌を宣言できる状態ではありません。',
        };
      }
      const player = state.players.find((p) => p.playerId === action.playerId);
      if (!player) {
        return {
          code: 'PLAYER_NOT_FOUND',
          message: 'プレイヤーが見つかりません。',
        };
      }
      if (player.seatIndex !== state.round.currentTurnIndex) {
        return {
          code: 'NOT_YOUR_TURN',
          message: 'あなたの手番ではありません。',
        };
      }
      if (!canDeclareKyuushuKyuuhai(player, state.round)) {
        return {
          code: 'INVALID_ABORTIVE_DRAW',
          message: '九種九牌の条件（第1ツモ時・鳴きなし・么九牌9種以上）を満たしていません。',
        };
      }
      return null;
    }

    case 'ADVANCE_ROUND': {
      if (state.phase !== 'round_end' || state.round === null) {
        return {
          code: 'INVALID_PHASE',
          message: '局終了状態でのみ次局へ進めます。',
        };
      }
      if (action.playerId !== state.hostPlayerId) {
        return {
          code: 'UNAUTHORIZED_ACTION',
          message: '次局への進行はホストのみ操作できます。',
        };
      }
      const decision = getNextRoundDecisionForRound(state, rules);
      if (
        decision.outcome !== 'game_end' &&
        !validateDeckForRules(rules, action.shuffledDeck)
      ) {
        return {
          code: 'INVALID_DECK',
          message: '次局の山牌構成がルールと一致しません。',
        };
      }
      return null;
    }

    case 'SET_PLAYER_CONNECTED': {
      if (!state.players.some((p) => p.playerId === action.playerId)) {
        return {
          code: 'PLAYER_NOT_FOUND',
          message: 'プレイヤーが見つかりません。',
        };
      }
      return null;
    }

    case 'UPDATE_RULE_CONFIG': {
      if (state.phase !== 'lobby') {
        return {
          code: 'INVALID_PHASE',
          message: '対局開始後はルールを変更できません。',
        };
      }
      if (action.playerId !== state.hostPlayerId) {
        return {
          code: 'UNAUTHORIZED_ACTION',
          message: 'ルールを変更できるのはホストだけです。',
        };
      }
      const nextRules = deriveRules(mergeRuleConfig(state.ruleConfig, action.patch));
      if (state.players.length > nextRules.playerCount) {
        return {
          code: 'ROOM_FULL',
          message: `現在の参加人数（${state.players.length}人）が${nextRules.playerCount}人を超えているため変更できません。先に人数を減らしてください。`,
        };
      }
      return null;
    }
  }
}

function markSameTurnFuritenForMissedRons(
  players: readonly PlayerState[],
  pending: PendingResponseState,
  responses: Record<string, CallResponseChoice>,
): PlayerState[] {
  const missedRonIds = new Set<string>();
  for (const [pid, opts] of Object.entries(pending.optionsByPlayerId)) {
    if (opts.canRon && responses[pid]?.type !== 'ron') {
      missedRonIds.add(pid);
    }
  }
  if (missedRonIds.size === 0) {
    return [...players];
  }
  return players.map((p) =>
    missedRonIds.has(p.playerId)
      ? {
          ...p,
          sameTurnFuriten: true,
          isRiichiFuriten: p.isRiichi ? true : p.isRiichiFuriten,
        }
      : p,
  );
}

function clearIppatsuForAllPlayers(players: readonly PlayerState[]): PlayerState[] {
  return players.map((p) =>
    p.ippatsuEligible ? { ...p, ippatsuEligible: false } : p,
  );
}

function commitPendingRiichiIfAny(
  players: readonly PlayerState[],
  kyotakuCount: number,
  pending: PendingResponseState,
  riichiStickPoints: number,
  calledDiscard: boolean,
): { players: PlayerState[]; kyotakuCount: number } {
  if (!pending.riichiDeclaration) {
    return { players: [...players], kyotakuCount };
  }
  const { playerId, isDoubleRiichi } = pending.riichiDeclaration;
  return {
    players: players.map((p) =>
      p.playerId === playerId
        ? {
            ...p,
            score: p.score - riichiStickPoints,
            isRiichi: true,
            isDoubleRiichi,
            ippatsuEligible: !calledDiscard,
            pendingRiichiSideways: calledDiscard,
          }
        : p,
    ),
    kyotakuCount: kyotakuCount + 1,
  };
}

function enterAbortiveDrawRound(
  state: GameState,
  reason: AbortiveDrawReason,
  options?: {
    playerId?: string;
    revealedHands?: Record<string, Tile[]>;
  },
): GameState {
  const rules = deriveRules(state.ruleConfig);
  const round = state.round!;
  const nextRoundDecision = decideNextRound(
    {
      roundIndex: round.roundIndex,
      honba: round.honba,
      dealerIndex: round.dealerIndex,
      abortiveDrawReason: reason,
      isTobiEnded: false,
    },
    state.players,
    rules,
  );
  return {
    ...state,
    phase: 'round_end',
    round: {
      ...round,
      pendingResponse: null,
      ronWinners: [],
      agariResults: [],
      uraDoraIndicators: [],
      abortiveDrawReason: reason,
      abortiveDrawPlayerId: options?.playerId ?? null,
      tenpaiPlayerIds: [],
      revealedHands: options?.revealedHands ?? {},
      kyotakuWinnerPlayerId: null,
      kyotakuPointsAwarded: 0,
      roundScoreDeltas: {},
      isTobiEnded: false,
      nextRoundDecision,
      turnCount: round.turnCount + 1,
    },
  };
}

function isSuufonRendaTriggered(
  state: GameState,
  rules: DerivedRules,
): boolean {
  const round = state.round;
  if (!round || rules.playerCount !== 4) return false;
  if (!round.firstTurnUninterrupted) return false;
  if (state.players.some((p) => p.isRiichi || p.discards.length !== 1)) {
    return false;
  }
  const firstKind = state.players[0]!.discards[0]!.tile.kind;
  if (
    firstKind !== '1z' &&
    firstKind !== '2z' &&
    firstKind !== '3z' &&
    firstKind !== '4z'
  ) {
    return false;
  }
  return state.players.every((p) => p.discards[0]!.tile.kind === firstKind);
}

function resolveAbortiveDrawOrAdvanceTurn(
  state: GameState,
  rules: DerivedRules,
): GameState {
  if (rules.playerCount === 4 && state.players.every((p) => p.isRiichi)) {
    return enterAbortiveDrawRound(state, 'suucha_riichi');
  }
  if (isSuufonRendaTriggered(state, rules)) {
    return enterAbortiveDrawRound(state, 'suufon_renda');
  }
  if (isSuukanzuTriggered(state)) {
    return enterAbortiveDrawRound(state, 'suukanzu');
  }
  return advanceTurnAfterClearDiscard(state);
}

function advanceTurnAfterClearDiscard(state: GameState): GameState {
  const rules = deriveRules(state.ruleConfig);
  const round = state.round!;
  const flushedDeadWall = flushPendingKandora(round.deadWall);

  if (round.wall.length === 0) {
    const noten = calculateNotenPenalties(state.players, rules);
    const nextPlayers = state.players.map((p) => ({
      ...p,
      score: p.score + (noten.deltasByPlayerId[p.playerId] ?? 0),
    }));
    const isTobiEnded =
      rules.tobi && nextPlayers.some((p) => p.score < 0);
    const nextRoundDecision = decideNextRound(
      {
        roundIndex: round.roundIndex,
        honba: round.honba,
        dealerIndex: round.dealerIndex,
        tenpaiPlayerIds: noten.tenpaiPlayerIds,
        isTobiEnded,
      },
      nextPlayers,
      rules,
    );

    return {
      ...state,
      phase: 'round_end',
      players: nextPlayers,
      round: {
        ...round,
        deadWall: flushedDeadWall,
        pendingResponse: null,
        tenpaiPlayerIds: noten.tenpaiPlayerIds,
        revealedHands: noten.revealedHands,
        roundScoreDeltas: noten.deltasByPlayerId,
        isTobiEnded,
        nextRoundDecision,
        turnCount: round.turnCount + 1,
      },
    };
  }

  const nextTurnIndex = (round.currentTurnIndex + 1) % rules.playerCount;
  const nextDrawnTile = round.wall[0]!;
  const nextWall = round.wall.slice(1);

  return {
    ...state,
    phase: 'playing',
    players: state.players.map((p) =>
      p.seatIndex === nextTurnIndex
        ? { ...p, drawnTile: nextDrawnTile, isRinshanDraw: false }
        : { ...p, isRinshanDraw: false },
    ),
    round: {
      ...round,
      currentTurnIndex: nextTurnIndex,
      wall: nextWall,
      deadWall: flushedDeadWall,
      pendingResponse: null,
      turnCount: round.turnCount + 1,
    },
  };
}

function commitAnkan(
  state: GameState,
  basePlayers: readonly PlayerState[],
  playerId: string,
  kind: Tile['kind'],
): GameState {
  const rules = deriveRules(state.ruleConfig);
  const round = state.round!;
  const activePlayer = basePlayers.find((p) => p.playerId === playerId)!;
  const allTiles = [...activePlayer.hand, activePlayer.drawnTile!];
  const kanTiles = sortTiles(allTiles.filter((t) => t.kind === kind));
  const nextHand = sortTiles(allTiles.filter((t) => t.kind !== kind));

  const afterKanTiming = applyKandoraTiming(
    round.deadWall,
    rules.kandoraTiming.ankan,
  );
  const rinshan = drawRinshanAndReplenish(round.wall, afterKanTiming);

  return {
    ...state,
    phase: 'playing',
    players: clearIppatsuForAllPlayers(basePlayers).map((p) =>
      p.playerId === activePlayer.playerId
        ? {
            ...p,
            hand: nextHand,
            drawnTile: rinshan.drawnTile,
            isRinshanDraw: true,
            melds: [
              ...p.melds,
              {
                type: 'ankan',
                tiles: kanTiles,
                calledTile: null,
                fromSeatIndex: null,
                addedTile: null,
              },
            ],
          }
        : { ...p, isRinshanDraw: false },
    ),
    round: {
      ...round,
      wall: rinshan.wall,
      deadWall: rinshan.deadWall,
      kanCount: round.kanCount + 1,
      firstTurnUninterrupted: false,
      pendingResponse: null,
      turnCount: round.turnCount + 1,
    },
  };
}

function commitKakan(
  state: GameState,
  basePlayers: readonly PlayerState[],
  playerId: string,
  tileId: string,
): GameState {
  const rules = deriveRules(state.ruleConfig);
  const round = state.round!;
  const activePlayer = basePlayers.find((p) => p.playerId === playerId)!;
  const extracted = extractTileFromHandOrDrawn(activePlayer, tileId)!;
  const addedTile = extracted.extracted;

  let upgraded = false;
  const nextMelds = activePlayer.melds.map((m) => {
    if (!upgraded && m.type === 'pon' && m.tiles[0]?.kind === addedTile.kind) {
      upgraded = true;
      return {
        ...m,
        type: 'kakan' as const,
        tiles: sortTiles([...m.tiles, addedTile]),
        addedTile,
      };
    }
    return m;
  });

  const afterKanTiming = applyKandoraTiming(
    round.deadWall,
    rules.kandoraTiming.kakan,
  );
  const rinshan = drawRinshanAndReplenish(round.wall, afterKanTiming);

  return {
    ...state,
    phase: 'playing',
    players: clearIppatsuForAllPlayers(basePlayers).map((p) =>
      p.playerId === activePlayer.playerId
        ? {
            ...p,
            hand: extracted.nextHand,
            drawnTile: rinshan.drawnTile,
            isRinshanDraw: true,
            melds: nextMelds,
          }
        : { ...p, isRinshanDraw: false },
    ),
    round: {
      ...round,
      wall: rinshan.wall,
      deadWall: rinshan.deadWall,
      kanCount: round.kanCount + 1,
      firstTurnUninterrupted: false,
      pendingResponse: null,
      turnCount: round.turnCount + 1,
    },
  };
}

function seatDistance(
  fromSeat: number,
  targetSeat: number,
  playerCount: number,
): number {
  return ((targetSeat - fromSeat) % playerCount + playerCount) % playerCount;
}

function removeLastDiscardFromDiscarder(
  players: readonly PlayerState[],
  discarderSeatIndex: number,
  discardedTileId: string,
): PlayerState[] {
  return players.map((p) => {
    if (p.seatIndex !== discarderSeatIndex) return p;
    const last = p.discards[p.discards.length - 1];
    if (!last || last.tile.id !== discardedTileId) {
      throw new Error('Expected discarded tile at tail of discarder river');
    }
    return {
      ...p,
      discards: p.discards.slice(0, -1),
    };
  });
}

function resolvePendingResponses(
  state: GameState,
  pending: PendingResponseState,
  responses: Record<string, CallResponseChoice>,
): GameState {
  const rules = deriveRules(state.ruleConfig);
  const round = state.round!;

  const eligiblePlayers = Object.keys(pending.optionsByPlayerId)
    .map((pid) => state.players.find((p) => p.playerId === pid)!)
    .sort(
      (a, b) =>
        seatDistance(pending.discarderSeatIndex, a.seatIndex, rules.playerCount) -
        seatDistance(pending.discarderSeatIndex, b.seatIndex, rules.playerCount),
    );

  // 1. ロン最優先（4人麻雀ダブロンありで3人同時ロンなら三家和で途中流局）
  const ronPlayers = eligiblePlayers.filter(
    (p) =>
      responses[p.playerId]?.type === 'ron' &&
      pending.optionsByPlayerId[p.playerId]?.canRon,
  );
  if (ronPlayers.length > 0) {
    if (rules.playerCount === 4 && rules.doubleRon && ronPlayers.length >= 3) {
      return enterAbortiveDrawRound(state, 'sancha_hou');
    }
    const chosen = rules.doubleRon ? ronPlayers : [ronPlayers[0]!];
    const discarder = state.players.find(
      (p) => p.seatIndex === pending.discarderSeatIndex,
    )!;

    const ronWinners: RoundRonWinner[] = chosen.map((p) => ({
      playerId: p.playerId,
      seatIndex: p.seatIndex,
      fromSeatIndex: pending.discarderSeatIndex,
      winningTile: pending.discardedTile,
    }));

    const agariResults: RoundAgariWinner[] = [];
    const roundScoreDeltas: Record<string, number> = {};
    for (const p of state.players) {
      roundScoreDeltas[p.playerId] = 0;
    }

    const chankanKind =
      pending.kind === 'kakan' || pending.kind === 'ankan'
        ? pending.kind
        : undefined;

    for (let idx = 0; idx < chosen.length; idx++) {
      const winner = chosen[idx]!;
      const evalResult = evaluateRonForPlayer(
        state,
        winner,
        pending.discardedTile,
        discarder,
        {
          ...(chankanKind ? { chankanKind } : {}),
          applyHonba: idx === 0,
        },
      );
      if (evalResult !== null) {
        const winnerRecord = buildAgariWinnerRecord({
          winType: 'ron',
          winner,
          fromSeatIndex: pending.discarderSeatIndex,
          winningTile: pending.discardedTile,
          players: state.players,
          evalResult,
        });
        agariResults.push(winnerRecord);
        for (const [pid, delta] of Object.entries(winnerRecord.scoreDeltas)) {
          roundScoreDeltas[pid] = (roundScoreDeltas[pid] ?? 0) + delta;
        }
      }
    }

    const kyotakuPointsAwarded = state.kyotakuCount * rules.riichiStickPoints;
    const kyotakuWinnerPlayerId =
      kyotakuPointsAwarded > 0 ? chosen[0]!.playerId : null;
    if (kyotakuWinnerPlayerId) {
      roundScoreDeltas[kyotakuWinnerPlayerId] =
        (roundScoreDeltas[kyotakuWinnerPlayerId] ?? 0) + kyotakuPointsAwarded;
    }

    const anyWinnerIsRiichi = chosen.some((p) => p.isRiichi);
    const uraDoraIndicators = anyWinnerIsRiichi
      ? getRevealedUraDoraIndicators(round.deadWall, true)
      : [];

    const nextPlayers = state.players.map((p) => ({
      ...p,
      score: p.score + (roundScoreDeltas[p.playerId] ?? 0),
    }));
    const isTobiEnded =
      rules.tobi && nextPlayers.some((p) => p.score < 0);
    const winnerSeats = (
      agariResults.length > 0 ? agariResults : ronWinners
    ).map((w) => w.seatIndex);
    const nextRoundDecision = decideNextRound(
      {
        roundIndex: round.roundIndex,
        honba: round.honba,
        dealerIndex: round.dealerIndex,
        agariWinnerSeatIndices: winnerSeats,
        isTobiEnded,
      },
      nextPlayers,
      rules,
    );

    return {
      ...state,
      phase: 'round_end',
      players: nextPlayers,
      kyotakuCount: 0,
      round: {
        ...round,
        pendingResponse: null,
        ronWinners,
        agariResults,
        uraDoraIndicators,
        tenpaiPlayerIds: [],
        kyotakuWinnerPlayerId,
        kyotakuPointsAwarded,
        roundScoreDeltas:
          agariResults.length > 0 || kyotakuPointsAwarded > 0
            ? roundScoreDeltas
            : {},
        isTobiEnded,
        nextRoundDecision,
        turnCount: round.turnCount + 1,
      },
    };
  }

  // ロン以外で終了する場合、ロンを見逃したプレイヤーに同巡フリテン・リーチ後フリテンを付与
  const playersWithFuriten = markSameTurnFuritenForMissedRons(
    state.players,
    pending,
    responses,
  );

  // 加槓 / 暗槓の槍槓チェックで全員パスの場合はカンを実行して嶺上ツモへ
  if (pending.kind === 'kakan' && pending.kakanTarget) {
    return commitKakan(
      state,
      playersWithFuriten,
      pending.kakanTarget.playerId,
      pending.kakanTarget.addedTile.id,
    );
  }
  if (pending.kind === 'ankan' && pending.ankanTarget) {
    return commitAnkan(
      state,
      playersWithFuriten,
      pending.ankanTarget.playerId,
      pending.ankanTarget.kind,
    );
  }

  // 2. ポン / 大明槓（ロンに次ぐ優先度）
  const ponOrKanPlayer = eligiblePlayers.find((p) => {
    const choice = responses[p.playerId];
    return choice?.type === 'pon' || choice?.type === 'daiminkan';
  });

  if (ponOrKanPlayer) {
    const riichiCommitted = commitPendingRiichiIfAny(
      playersWithFuriten,
      state.kyotakuCount,
      pending,
      rules.riichiStickPoints,
      true,
    );
    const choice = responses[ponOrKanPlayer.playerId]!;
    const flushedDeadWall = flushPendingKandora(round.deadWall);
    const playersWithoutDiscard = removeLastDiscardFromDiscarder(
      clearIppatsuForAllPlayers(riichiCommitted.players),
      pending.discarderSeatIndex,
      pending.discardedTile.id,
    );

    if (choice.type === 'pon') {
      const pair = validatePonTilePair(
        ponOrKanPlayer.hand,
        pending.discardedTile,
        choice.tileIds,
        rules.forbidKuikae,
      )!;
      const nextHand = removeTilesFromHand(ponOrKanPlayer.hand, [
        pair[0].id,
        pair[1].id,
      ]);
      const meldTiles = sortTiles([pending.discardedTile, pair[0], pair[1]]);
      const forbiddenKinds = rules.forbidKuikae
        ? [pending.discardedTile.kind]
        : [];

      const nextPlayers = playersWithoutDiscard.map((p) =>
        p.playerId === ponOrKanPlayer.playerId
          ? {
              ...p,
              hand: nextHand,
              drawnTile: null,
              isRinshanDraw: false,
              melds: [
                ...p.melds,
                {
                  type: 'pon' as const,
                  tiles: meldTiles,
                  calledTile: pending.discardedTile,
                  fromSeatIndex: pending.discarderSeatIndex,
                  addedTile: null,
                },
              ],
            }
          : { ...p, isRinshanDraw: false },
      );

      return {
        ...state,
        phase: 'playing',
        players: nextPlayers,
        kyotakuCount: riichiCommitted.kyotakuCount,
        round: {
          ...round,
          currentTurnIndex: ponOrKanPlayer.seatIndex,
          deadWall: flushedDeadWall,
          firstTurnUninterrupted: false,
          kuikaeForbiddenKinds: forbiddenKinds,
          pendingResponse: null,
          turnCount: round.turnCount + 1,
        },
      };
    }

    // 大明槓
    const matching = ponOrKanPlayer.hand.filter(
      (t) => t.kind === pending.discardedTile.kind,
    );
    const threeTiles = matching.slice(0, 3);
    const nextHand = removeTilesFromHand(
      ponOrKanPlayer.hand,
      threeTiles.map((t) => t.id),
    );
    const meldTiles = sortTiles([pending.discardedTile, ...threeTiles]);
    const afterKanTiming = applyKandoraTiming(
      flushedDeadWall,
      rules.kandoraTiming.daiminkan,
    );
    const rinshan = drawRinshanAndReplenish(round.wall, afterKanTiming);

    const nextPlayers = playersWithoutDiscard.map((p) =>
      p.playerId === ponOrKanPlayer.playerId
        ? {
            ...p,
            hand: nextHand,
            drawnTile: rinshan.drawnTile,
            isRinshanDraw: true,
            melds: [
              ...p.melds,
              {
                type: 'daiminkan' as const,
                tiles: meldTiles,
                calledTile: pending.discardedTile,
                fromSeatIndex: pending.discarderSeatIndex,
                addedTile: null,
              },
            ],
          }
        : { ...p, isRinshanDraw: false },
    );

    return {
      ...state,
      phase: 'playing',
      players: nextPlayers,
      kyotakuCount: riichiCommitted.kyotakuCount,
      round: {
        ...round,
        currentTurnIndex: ponOrKanPlayer.seatIndex,
        wall: rinshan.wall,
        deadWall: rinshan.deadWall,
        kanCount: round.kanCount + 1,
        firstTurnUninterrupted: false,
        kuikaeForbiddenKinds: [],
        pendingResponse: null,
        turnCount: round.turnCount + 1,
      },
    };
  }

  // 3. チー（下家のみ）
  const chiPlayer = eligiblePlayers.find(
    (p) => responses[p.playerId]?.type === 'chi',
  );
  if (chiPlayer) {
    const riichiCommitted = commitPendingRiichiIfAny(
      playersWithFuriten,
      state.kyotakuCount,
      pending,
      rules.riichiStickPoints,
      true,
    );
    const choice = responses[chiPlayer.playerId] as {
      type: 'chi';
      tileIds: [string, string];
    };
    const flushedDeadWall = flushPendingKandora(round.deadWall);
    const playersWithoutDiscard = removeLastDiscardFromDiscarder(
      clearIppatsuForAllPlayers(riichiCommitted.players),
      pending.discarderSeatIndex,
      pending.discardedTile.id,
    );
    const pair = validateChiTilePair(
      chiPlayer.hand,
      pending.discardedTile,
      choice.tileIds,
      rules.forbidKuikae,
    )!;
    const nextHand = removeTilesFromHand(chiPlayer.hand, [
      pair[0].id,
      pair[1].id,
    ]);
    const meldTiles = sortTiles([pending.discardedTile, pair[0], pair[1]]);
    const forbiddenKinds = rules.forbidKuikae
      ? computeChiKuikaeKinds(
          pending.discardedTile.kind,
          pair[0].kind,
          pair[1].kind,
        )
      : [];

    const nextPlayers = playersWithoutDiscard.map((p) =>
      p.playerId === chiPlayer.playerId
        ? {
            ...p,
            hand: nextHand,
            drawnTile: null,
            isRinshanDraw: false,
            melds: [
              ...p.melds,
              {
                type: 'chi' as const,
                tiles: meldTiles,
                calledTile: pending.discardedTile,
                fromSeatIndex: pending.discarderSeatIndex,
                addedTile: null,
              },
            ],
          }
        : { ...p, isRinshanDraw: false },
    );

    return {
      ...state,
      phase: 'playing',
      players: nextPlayers,
      kyotakuCount: riichiCommitted.kyotakuCount,
      round: {
        ...round,
        currentTurnIndex: chiPlayer.seatIndex,
        deadWall: flushedDeadWall,
        firstTurnUninterrupted: false,
        kuikaeForbiddenKinds: forbiddenKinds,
        pendingResponse: null,
        turnCount: round.turnCount + 1,
      },
    };
  }

  // 4. 全員パス
  const riichiCommitted = commitPendingRiichiIfAny(
    playersWithFuriten,
    state.kyotakuCount,
    pending,
    rules.riichiStickPoints,
    false,
  );
  return resolveAbortiveDrawOrAdvanceTurn(
    {
      ...state,
      players: riichiCommitted.players,
      kyotakuCount: riichiCommitted.kyotakuCount,
    },
    rules,
  );
}

export function reduce(
  state: GameState,
  action: Action,
  hooks: EngineHooks = DEFAULT_ENGINE_HOOKS,
): GameState {
  if (validateAction(state, action, hooks) !== null) {
    return state;
  }

  const rules = deriveRules(state.ruleConfig);

  switch (action.type) {
    case 'JOIN_PLAYER': {
      const nextSeat = state.players.length;
      const newPlayer: PlayerState = {
        playerId: action.playerId,
        name: normalizePlayerName(action.name, nextSeat + 1),
        seatIndex: nextSeat,
        score: rules.initialPoints,
        hand: [],
        drawnTile: null,
        discards: [],
        discardedKinds: [],
        sameTurnFuriten: false,
        isRiichiFuriten: false,
        isRiichi: false,
        isDoubleRiichi: false,
        ippatsuEligible: false,
        pendingRiichiSideways: false,
        isRinshanDraw: false,
        melds: [],
        kitaTiles: [],
        connected: true,
      };
      return {
        ...state,
        players: [...state.players, newPlayer],
      };
    }

    case 'LEAVE_LOBBY': {
      const remaining = state.players
        .filter((p) => p.playerId !== action.playerId)
        .map((p, idx) => ({ ...p, seatIndex: idx }));
      return {
        ...state,
        players: remaining,
      };
    }

    case 'START_GAME': {
      const orderedPlayers = action.shuffledPlayerIds
        ? action.shuffledPlayerIds.map(
            (id) => state.players.find((p) => p.playerId === id)!,
          )
        : [...state.players].sort((a, b) => a.seatIndex - b.seatIndex);

      const initialDealerIndex = 0;
      const roundMeta = getRoundMetadata(0, initialDealerIndex, rules);
      const deal = dealRoundFromDeck(
        rules,
        roundMeta.dealerIndex,
        action.shuffledDeck,
      );

      const players: PlayerState[] = orderedPlayers.map((p, seatIndex) => ({
        ...p,
        seatIndex,
        score: rules.initialPoints,
        hand: deal.hands[seatIndex]!,
        drawnTile:
          seatIndex === roundMeta.dealerIndex ? deal.dealerDrawnTile : null,
        discards: [],
        discardedKinds: [],
        sameTurnFuriten: false,
        isRiichiFuriten: false,
        isRiichi: false,
        isDoubleRiichi: false,
        ippatsuEligible: false,
        pendingRiichiSideways: false,
        isRinshanDraw: false,
        melds: [],
        kitaTiles: [],
      }));

      return {
        ...state,
        phase: 'playing',
        players,
        initialDealerIndex,
        kyotakuCount: 0,
        finalKyotakuAward: null,
        round: {
          roundIndex: 0,
          honba: 0,
          roundWind: roundMeta.roundWind,
          kyokuNumber: roundMeta.kyokuNumber,
          initialDealerIndex,
          dealerIndex: roundMeta.dealerIndex,
          currentTurnIndex: roundMeta.dealerIndex,
          wall: deal.wall,
          deadWall: deal.deadWall,
          turnCount: 0,
          kanCount: 0,
          firstTurnUninterrupted: true,
          kuikaeForbiddenKinds: [],
          pendingResponse: null,
          ronWinners: [],
          agariResults: [],
          uraDoraIndicators: [],
          abortiveDrawReason: null,
          abortiveDrawPlayerId: null,
          tenpaiPlayerIds: [],
          revealedHands: {},
          kyotakuWinnerPlayerId: null,
          kyotakuPointsAwarded: 0,
          roundScoreDeltas: {},
          isTobiEnded: false,
          nextRoundDecision: null,
        },
      };
    }

    case 'DISCARD_TILE': {
      const round = state.round!;
      const activePlayer = state.players.find(
        (p) => p.playerId === action.playerId,
      )!;
      const isTsumogiri = activePlayer.drawnTile?.id === action.tileId;

      const extracted = extractTileFromHandOrDrawn(activePlayer, action.tileId);
      if (!extracted) {
        return state;
      }

      const discardedTile = extracted.extracted;
      const missedTsumoInRiichi =
        activePlayer.isRiichi &&
        evaluateTsumoFromRound(activePlayer, round, rules) !== null;

      const nextPlayers = state.players.map((p) =>
        p.playerId === activePlayer.playerId
          ? {
              ...p,
              hand: extracted.nextHand,
              drawnTile: null,
              discards: [
                ...p.discards,
                {
                  tile: discardedTile,
                  isTsumogiri,
                  ...(p.pendingRiichiSideways ? { isRiichiDeclaration: true } : {}),
                },
              ],
              discardedKinds: [...p.discardedKinds, discardedTile.kind],
              sameTurnFuriten: false,
              isRiichiFuriten: p.isRiichiFuriten || missedTsumoInRiichi,
              ippatsuEligible: false,
              pendingRiichiSideways: false,
              isRinshanDraw: false,
            }
          : { ...p, isRinshanDraw: false },
      );

      const stateAfterDiscard: GameState = {
        ...state,
        players: nextPlayers,
        round: {
          ...round,
          kuikaeForbiddenKinds: [],
        },
      };

      const optionsByPlayerId = buildPendingCallOptions(
        stateAfterDiscard,
        stateAfterDiscard.players.find(
          (p) => p.playerId === activePlayer.playerId,
        )!,
        discardedTile,
        rules,
        hooks,
      );

      if (Object.keys(optionsByPlayerId).length > 0) {
        return {
          ...stateAfterDiscard,
          phase: 'awaiting_responses',
          round: {
            ...stateAfterDiscard.round!,
            pendingResponse: {
              discarderSeatIndex: activePlayer.seatIndex,
              discardedTile,
              turnCount: round.turnCount,
              openedAt: action.now ?? 0,
              optionsByPlayerId,
              responses: {},
            },
          },
        };
      }

      return resolveAbortiveDrawOrAdvanceTurn(stateAfterDiscard, rules);
    }

    case 'DECLARE_RIICHI': {
      const round = state.round!;
      const activePlayer = state.players.find(
        (p) => p.playerId === action.playerId,
      )!;
      const isTsumogiri = activePlayer.drawnTile?.id === action.tileId;
      const isDoubleRiichi =
        round.firstTurnUninterrupted && activePlayer.discards.length === 0;

      const extracted = extractTileFromHandOrDrawn(activePlayer, action.tileId);
      if (!extracted) {
        return state;
      }

      const discardedTile = extracted.extracted;
      const nextPlayers = state.players.map((p) =>
        p.playerId === activePlayer.playerId
          ? {
              ...p,
              hand: extracted.nextHand,
              drawnTile: null,
              discards: [
                ...p.discards,
                {
                  tile: discardedTile,
                  isTsumogiri,
                  isRiichiDeclaration: true,
                },
              ],
              discardedKinds: [...p.discardedKinds, discardedTile.kind],
              sameTurnFuriten: false,
              isRinshanDraw: false,
            }
          : { ...p, isRinshanDraw: false },
      );

      const stateAfterDiscard: GameState = {
        ...state,
        players: nextPlayers,
        round: {
          ...round,
          kuikaeForbiddenKinds: [],
        },
      };

      const optionsByPlayerId = buildPendingCallOptions(
        stateAfterDiscard,
        stateAfterDiscard.players.find(
          (p) => p.playerId === activePlayer.playerId,
        )!,
        discardedTile,
        rules,
        hooks,
      );

      if (Object.keys(optionsByPlayerId).length > 0) {
        return {
          ...stateAfterDiscard,
          phase: 'awaiting_responses',
          round: {
            ...stateAfterDiscard.round!,
            pendingResponse: {
              discarderSeatIndex: activePlayer.seatIndex,
              discardedTile,
              turnCount: round.turnCount,
              openedAt: action.now ?? 0,
              optionsByPlayerId,
              responses: {},
              riichiDeclaration: {
                playerId: activePlayer.playerId,
                isDoubleRiichi,
              },
            },
          },
        };
      }

      // 誰もロン・鳴きできない場合は即時にリーチ成立・供託加算
      const committedPlayers = stateAfterDiscard.players.map((p) =>
        p.playerId === activePlayer.playerId
          ? {
              ...p,
              score: p.score - rules.riichiStickPoints,
              isRiichi: true,
              isDoubleRiichi,
              ippatsuEligible: true,
            }
          : p,
      );

      return resolveAbortiveDrawOrAdvanceTurn(
        {
          ...stateAfterDiscard,
          players: committedPlayers,
          kyotakuCount: state.kyotakuCount + 1,
        },
        rules,
      );
    }

    case 'CALL_RESPONSE': {
      const round = state.round!;
      const pending = round.pendingResponse!;
      const nextResponses: Record<string, CallResponseChoice> = {
        ...pending.responses,
        [action.playerId]: action.choice,
      };
      const allResponded = Object.keys(pending.optionsByPlayerId).every(
        (pid) => pid in nextResponses,
      );

      if (!allResponded) {
        return {
          ...state,
          round: {
            ...round,
            pendingResponse: {
              ...pending,
              responses: nextResponses,
            },
          },
        };
      }

      return resolvePendingResponses(state, pending, nextResponses);
    }

    case 'RESPONSE_TIMEOUT': {
      const round = state.round!;
      const pending = round.pendingResponse!;
      const completedResponses: Record<string, CallResponseChoice> = {
        ...pending.responses,
      };
      for (const pid of Object.keys(pending.optionsByPlayerId)) {
        if (!(pid in completedResponses)) {
          completedResponses[pid] = { type: 'pass' };
        }
      }
      return resolvePendingResponses(state, pending, completedResponses);
    }

    case 'DECLARE_TSUMO': {
      const round = state.round!;
      const activePlayer = state.players.find(
        (p) => p.playerId === action.playerId,
      )!;
      const evalResult = evaluateTsumoFromRound(activePlayer, round, rules)!;
      const winnerRecord = buildAgariWinnerRecord({
        winType: 'tsumo',
        winner: activePlayer,
        fromSeatIndex: null,
        winningTile: activePlayer.drawnTile!,
        players: state.players,
        evalResult,
      });

      const roundScoreDeltas = { ...winnerRecord.scoreDeltas };
      const kyotakuPointsAwarded = state.kyotakuCount * rules.riichiStickPoints;
      const kyotakuWinnerPlayerId =
        kyotakuPointsAwarded > 0 ? activePlayer.playerId : null;
      if (kyotakuWinnerPlayerId) {
        roundScoreDeltas[kyotakuWinnerPlayerId] =
          (roundScoreDeltas[kyotakuWinnerPlayerId] ?? 0) + kyotakuPointsAwarded;
      }

      const uraDoraIndicators = activePlayer.isRiichi
        ? getRevealedUraDoraIndicators(round.deadWall, true)
        : [];

      const nextPlayers = state.players.map((p) => ({
        ...p,
        score: p.score + (roundScoreDeltas[p.playerId] ?? 0),
      }));
      const isTobiEnded =
        rules.tobi && nextPlayers.some((p) => p.score < 0);
      const nextRoundDecision = decideNextRound(
        {
          roundIndex: round.roundIndex,
          honba: round.honba,
          dealerIndex: round.dealerIndex,
          agariWinnerSeatIndices: [activePlayer.seatIndex],
          isTobiEnded,
        },
        nextPlayers,
        rules,
      );

      return {
        ...state,
        phase: 'round_end',
        players: nextPlayers,
        kyotakuCount: 0,
        round: {
          ...round,
          agariResults: [winnerRecord],
          uraDoraIndicators,
          tenpaiPlayerIds: [],
          kyotakuWinnerPlayerId,
          kyotakuPointsAwarded,
          roundScoreDeltas,
          isTobiEnded,
          nextRoundDecision,
          turnCount: round.turnCount + 1,
        },
      };
    }

    case 'DECLARE_ANKAN': {
      const round = state.round!;
      const activePlayer = state.players.find(
        (p) => p.playerId === action.playerId,
      )!;
      const allTiles = [...activePlayer.hand, activePlayer.drawnTile!];
      const sampleTile = allTiles.find((t) => t.kind === action.kind)!;

      // 暗槓に対する国士無双のみの槍槓チェック
      const optionsByPlayerId = buildPendingChankanOptions(
        state,
        activePlayer,
        sampleTile,
        'ankan',
        hooks,
      );
      if (Object.keys(optionsByPlayerId).length > 0) {
        return {
          ...state,
          phase: 'awaiting_responses',
          round: {
            ...round,
            pendingResponse: {
              kind: 'ankan',
              discarderSeatIndex: activePlayer.seatIndex,
              discardedTile: sampleTile,
              turnCount: round.turnCount,
              openedAt: action.now ?? 0,
              optionsByPlayerId,
              responses: {},
              ankanTarget: {
                playerId: activePlayer.playerId,
                kind: action.kind,
              },
            },
          },
        };
      }

      return commitAnkan(state, state.players, activePlayer.playerId, action.kind);
    }

    case 'DECLARE_KAKAN': {
      const round = state.round!;
      const activePlayer = state.players.find(
        (p) => p.playerId === action.playerId,
      )!;
      const addedTile =
        activePlayer.drawnTile?.id === action.tileId
          ? activePlayer.drawnTile
          : activePlayer.hand.find((t) => t.id === action.tileId)!;

      // 加槓に対する通常の槍槓チェック
      const optionsByPlayerId = buildPendingChankanOptions(
        state,
        activePlayer,
        addedTile,
        'kakan',
        hooks,
      );
      if (Object.keys(optionsByPlayerId).length > 0) {
        return {
          ...state,
          phase: 'awaiting_responses',
          round: {
            ...round,
            pendingResponse: {
              kind: 'kakan',
              discarderSeatIndex: activePlayer.seatIndex,
              discardedTile: addedTile,
              turnCount: round.turnCount,
              openedAt: action.now ?? 0,
              optionsByPlayerId,
              responses: {},
              kakanTarget: {
                playerId: activePlayer.playerId,
                addedTile,
              },
            },
          },
        };
      }

      return commitKakan(state, state.players, activePlayer.playerId, action.tileId);
    }

    case 'DECLARE_KITA': {
      const round = state.round!;
      const activePlayer = state.players.find(
        (p) => p.playerId === action.playerId,
      )!;
      const extracted = extractTileFromHandOrDrawn(activePlayer, action.tileId)!;
      const kitaTile = extracted.extracted;
      const rinshan = drawRinshanAndReplenish(round.wall, round.deadWall);

      return {
        ...state,
        players: state.players.map((p) =>
          p.playerId === activePlayer.playerId
            ? {
                ...p,
                hand: extracted.nextHand,
                drawnTile: rinshan.drawnTile,
                isRinshanDraw: true,
                kitaTiles: [...p.kitaTiles, kitaTile],
              }
            : { ...p, isRinshanDraw: false },
        ),
        round: {
          ...round,
          wall: rinshan.wall,
          deadWall: rinshan.deadWall,
          turnCount: round.turnCount + 1,
        },
      };
    }

    case 'DECLARE_KYUUSHU_KYUUHAI': {
      const activePlayer = state.players.find(
        (p) => p.playerId === action.playerId,
      )!;
      const fullHand = sortTiles([
        ...activePlayer.hand,
        ...(activePlayer.drawnTile ? [activePlayer.drawnTile] : []),
      ]);
      return enterAbortiveDrawRound(state, 'kyuushu_kyuuhai', {
        playerId: activePlayer.playerId,
        revealedHands: {
          [activePlayer.playerId]: fullHand,
        },
      });
    }

    case 'ADVANCE_ROUND': {
      const currentRound = state.round!;
      const decision = getNextRoundDecisionForRound(state, rules);

      if (decision.outcome === 'game_end') {
        const kyotakuResolved = resolveLeftoverKyotaku(
          state.players,
          state.kyotakuCount,
          currentRound.initialDealerIndex,
          rules,
        );
        const finishedPlayers = kyotakuResolved.players.map((p) => ({
          ...p,
          hand: [],
          drawnTile: null,
          discards: [],
          discardedKinds: [],
          sameTurnFuriten: false,
          isRiichiFuriten: false,
          isRiichi: false,
          isDoubleRiichi: false,
          ippatsuEligible: false,
          pendingRiichiSideways: false,
          isRinshanDraw: false,
          melds: [],
          kitaTiles: [],
        }));
        return {
          ...state,
          phase: 'finished',
          players: finishedPlayers,
          initialDealerIndex: currentRound.initialDealerIndex,
          kyotakuCount: 0,
          finalKyotakuAward: kyotakuResolved.award,
          round: null,
        };
      }

      const nextRoundIndex = decision.nextRoundIndex;
      const roundMeta = getRoundMetadata(
        nextRoundIndex,
        currentRound.initialDealerIndex,
        rules,
      );
      const deal = dealRoundFromDeck(
        rules,
        roundMeta.dealerIndex,
        action.shuffledDeck,
      );

      const nextPlayers = state.players.map((p) => ({
        ...p,
        hand: deal.hands[p.seatIndex]!,
        drawnTile:
          p.seatIndex === roundMeta.dealerIndex ? deal.dealerDrawnTile : null,
        discards: [],
        discardedKinds: [],
        sameTurnFuriten: false,
        isRiichiFuriten: false,
        isRiichi: false,
        isDoubleRiichi: false,
        ippatsuEligible: false,
        pendingRiichiSideways: false,
        isRinshanDraw: false,
        melds: [],
        kitaTiles: [],
      }));

      return {
        ...state,
        phase: 'playing',
        players: nextPlayers,
        round: {
          roundIndex: nextRoundIndex,
          honba: decision.nextHonba,
          roundWind: roundMeta.roundWind,
          kyokuNumber: roundMeta.kyokuNumber,
          initialDealerIndex: currentRound.initialDealerIndex,
          dealerIndex: roundMeta.dealerIndex,
          currentTurnIndex: roundMeta.dealerIndex,
          wall: deal.wall,
          deadWall: deal.deadWall,
          turnCount: 0,
          kanCount: 0,
          firstTurnUninterrupted: true,
          kuikaeForbiddenKinds: [],
          pendingResponse: null,
          ronWinners: [],
          agariResults: [],
          uraDoraIndicators: [],
          abortiveDrawReason: null,
          abortiveDrawPlayerId: null,
          tenpaiPlayerIds: [],
          revealedHands: {},
          kyotakuWinnerPlayerId: null,
          kyotakuPointsAwarded: 0,
          roundScoreDeltas: {},
          isTobiEnded: false,
          nextRoundDecision: null,
        },
      };
    }

    case 'SET_PLAYER_CONNECTED': {
      return {
        ...state,
        players: state.players.map((p) =>
          p.playerId === action.playerId
            ? { ...p, connected: action.connected }
            : p,
        ),
      };
    }

    case 'UPDATE_RULE_CONFIG': {
      const nextRuleConfig = mergeRuleConfig(state.ruleConfig, action.patch);
      const nextRules = deriveRules(nextRuleConfig);
      return {
        ...state,
        ruleConfig: nextRuleConfig,
        players: state.players.map((p) => ({
          ...p,
          score: nextRules.initialPoints,
        })),
      };
    }
  }
}

export function applyAction(
  state: GameState,
  action: Action,
  hooks: EngineHooks = DEFAULT_ENGINE_HOOKS,
): { state: GameState; error: GameError | null } {
  const error = validateAction(state, action, hooks);
  if (error !== null) {
    return { state, error };
  }
  return { state: reduce(state, action, hooks), error: null };
}
