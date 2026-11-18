import type { Action, GameError } from '../types/message';
import type { RuleConfig } from '../types/rule';
import type {
  CallResponseChoice,
  GameState,
  PlayerState,
} from '../types/state';
import {
  buildPendingCallOptions,
  buildPendingChankanOptions,
  DEFAULT_ENGINE_HOOKS,
  type EngineHooks,
  evaluateTsumoFromRound,
} from './calls';
import { getRevealedUraDoraIndicators } from './dora';
import {
  buildAgariWinnerRecord,
  extractTileFromHandOrDrawn,
  getNextRoundDecisionForRound,
  mergeRuleConfig,
  normalizePlayerName,
} from './reducerHelpers';
import {
  commitAnkan,
  commitKakan,
  enterAbortiveDrawRound,
  resolveAbortiveDrawOrAdvanceTurn,
  resolvePendingResponses,
} from './reducerResolution';
import { validateAction } from './reducerValidation';
import { decideNextRound, resolveLeftoverKyotaku } from './roundProgression';
import { deriveRules, getRoundMetadata } from './rules';
import {
  dealRoundFromDeck,
  drawRinshanAndReplenish,
  sortTiles,
} from './wall';

export { validateAction };

export interface CreateInitialGameParams {
  roomCode: string;
  hostPlayerId: string;
  hostName: string;
  ruleConfig: RuleConfig;
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
    spectators: [],
  };
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

    case 'JOIN_SPECTATOR': {
      const existing = state.spectators ?? [];
      const nextSpectator = {
        spectatorId: action.spectatorId,
        name: normalizePlayerName(action.name, existing.length + 1),
        connected: true,
      };
      return {
        ...state,
        spectators: [...existing, nextSpectator],
      };
    }

    case 'LEAVE_SPECTATOR': {
      return {
        ...state,
        spectators: (state.spectators ?? []).filter(
          (s) => s.spectatorId !== action.spectatorId,
        ),
      };
    }

    case 'SET_SPECTATOR_CONNECTED': {
      return {
        ...state,
        spectators: (state.spectators ?? []).map((s) =>
          s.spectatorId === action.spectatorId
            ? { ...s, connected: action.connected }
            : s,
        ),
      };
    }

    case 'TRANSFER_HOST': {
      return {
        ...state,
        hostPlayerId: action.newHostPlayerId,
      };
    }

    case 'RESET_TO_LOBBY': {
      const remainingPlayers = state.players
        .filter(
          (p) =>
            p.playerId === state.hostPlayerId ||
            p.connected ||
            p.playerId.startsWith('cpu-'),
        )
        .slice(0, rules.playerCount)
        .map((p, idx) => ({
          ...p,
          seatIndex: idx,
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
          connected: p.playerId === state.hostPlayerId ? true : p.connected,
        }));
      return {
        ...state,
        phase: 'lobby',
        players: remainingPlayers,
        initialDealerIndex: 0,
        kyotakuCount: 0,
        finalKyotakuAward: null,
        round: null,
        spectators: (state.spectators ?? []).filter((s) => s.connected),
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
