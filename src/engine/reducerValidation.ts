import type { Action, GameError } from '../types/message';
import type { GameState } from '../types/state';
import {
  canAnkanPreserveRiichiWaits,
  getCanRiichiDiscardTileIds,
} from './agari';
import {
  canDeclareKyuushuKyuuhai,
  DEFAULT_ENGINE_HOOKS,
  type EngineHooks,
  evaluateTsumoFromRound,
  validateChiTilePair,
  validatePonTilePair,
} from './calls';
import {
  areSamePlayerIds,
  getNextRoundDecisionForRound,
  mergeRuleConfig,
} from './reducerHelpers';
import { deriveRules } from './rules';
import { validateDeckForRules } from './wall';

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
      if (
        state.players.some((p) => p.playerId === action.playerId) ||
        (state.spectators ?? []).some((s) => s.spectatorId === action.playerId)
      ) {
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

    case 'JOIN_SPECTATOR': {
      if (
        state.players.some((p) => p.playerId === action.spectatorId) ||
        (state.spectators ?? []).some((s) => s.spectatorId === action.spectatorId)
      ) {
        return {
          code: 'DUPLICATE_PLAYER',
          message: 'すでに参加済みのIDです。',
        };
      }
      return null;
    }

    case 'LEAVE_SPECTATOR':
    case 'SET_SPECTATOR_CONNECTED': {
      if (!(state.spectators ?? []).some((s) => s.spectatorId === action.spectatorId)) {
        return {
          code: 'PLAYER_NOT_FOUND',
          message: '観戦者が見つかりません。',
        };
      }
      return null;
    }

    case 'TRANSFER_HOST': {
      const target = state.players.find((p) => p.playerId === action.newHostPlayerId);
      if (!target) {
        return {
          code: 'PLAYER_NOT_FOUND',
          message: '引き継ぎ先のプレイヤーが見つかりません。',
        };
      }
      if (target.playerId.startsWith('cpu-')) {
        return {
          code: 'UNAUTHORIZED_ACTION',
          message: 'CPU にはホスト権限を引き継げません。',
        };
      }
      return null;
    }

    case 'RESET_TO_LOBBY': {
      if (state.phase !== 'finished') {
        return {
          code: 'INVALID_PHASE',
          message: '終局後のみロビーに戻せます。',
        };
      }
      if (action.playerId !== state.hostPlayerId) {
        return {
          code: 'UNAUTHORIZED_ACTION',
          message: '次の対局へ戻せるのはホストだけです。',
        };
      }
      return null;
    }
  }
}
