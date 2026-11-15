import type { Action, GameError } from '../types/message';
import type { RuleConfig } from '../types/rule';
import type { GameState, PlayerState } from '../types/state';
import { deriveRules, getRoundMetadata } from './rules';
import { dealRound, deriveSubSeed, shuffleWithSeed, sortTiles } from './wall';

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
    melds: [],
    connected: true,
  };

  return {
    roomCode: params.roomCode,
    hostPlayerId: params.hostPlayerId,
    ruleConfig: { ...params.ruleConfig },
    phase: 'lobby',
    players: [hostPlayer],
    round: null,
  };
}

export function validateAction(state: GameState, action: Action): GameError | null {
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
      const inDrawn = player.drawnTile?.id === action.tileId;
      const inHand = player.hand.some((t) => t.id === action.tileId);
      if (!inDrawn && !inHand) {
        return {
          code: 'TILE_NOT_IN_HAND',
          message: '指定した牌が手牌にありません。',
        };
      }
      return null;
    }

    case 'ADVANCE_ROUND': {
      if (state.phase !== 'round_end' || state.round === null) {
        return {
          code: 'INVALID_PHASE',
          message: '流局状態でのみ次局へ進めます。',
        };
      }
      if (action.playerId !== state.hostPlayerId) {
        return {
          code: 'UNAUTHORIZED_ACTION',
          message: '次局への進行はホストのみ操作できます。',
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
  }
}

export function reduce(state: GameState, action: Action): GameState {
  if (validateAction(state, action) !== null) {
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
        melds: [],
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
      const shuffledPlayers = shuffleWithSeed(state.players, action.seed);
      const initialDealerIndex = 0;
      const roundMeta = getRoundMetadata(0, initialDealerIndex, rules);
      const deal = dealRound(
        rules,
        roundMeta.dealerIndex,
        deriveSubSeed(action.seed, 1),
      );

      const players: PlayerState[] = shuffledPlayers.map((p, seatIndex) => ({
        ...p,
        seatIndex,
        score: rules.initialPoints,
        hand: deal.hands[seatIndex]!,
        drawnTile: seatIndex === roundMeta.dealerIndex ? deal.dealerDrawnTile : null,
        discards: [],
        melds: [],
      }));

      return {
        ...state,
        phase: 'playing',
        players,
        round: {
          roundIndex: 0,
          roundWind: roundMeta.roundWind,
          kyokuNumber: roundMeta.kyokuNumber,
          initialDealerIndex,
          dealerIndex: roundMeta.dealerIndex,
          currentTurnIndex: roundMeta.dealerIndex,
          wall: deal.wall,
          deadWall: deal.deadWall,
          turnCount: 0,
        },
      };
    }

    case 'DISCARD_TILE': {
      const round = state.round!;
      const activePlayer = state.players.find(
        (p) => p.playerId === action.playerId,
      )!;
      const isTsumogiri = activePlayer.drawnTile?.id === action.tileId;

      let discardedTile = activePlayer.drawnTile;
      let nextHand = activePlayer.hand;

      if (!isTsumogiri) {
        const handIdx = activePlayer.hand.findIndex(
          (t) => t.id === action.tileId,
        );
        discardedTile = activePlayer.hand[handIdx]!;
        const remainingHand = activePlayer.hand.filter(
          (_, idx) => idx !== handIdx,
        );
        if (activePlayer.drawnTile !== null) {
          remainingHand.push(activePlayer.drawnTile);
        }
        nextHand = sortTiles(remainingHand);
      }

      if (discardedTile === null) {
        return state;
      }

      const isWallExhausted = round.wall.length === 0;
      const nextTurnIndex =
        (round.currentTurnIndex + 1) % rules.playerCount;
      const nextDrawnTile = isWallExhausted ? null : round.wall[0]!;
      const nextWall = isWallExhausted ? round.wall : round.wall.slice(1);

      const nextPlayers = state.players.map((p) => {
        if (p.playerId === activePlayer.playerId) {
          return {
            ...p,
            hand: nextHand,
            drawnTile: null,
            discards: [
              ...p.discards,
              { tile: discardedTile, isTsumogiri },
            ],
          };
        }
        if (!isWallExhausted && p.seatIndex === nextTurnIndex) {
          return {
            ...p,
            drawnTile: nextDrawnTile,
          };
        }
        return p;
      });

      return {
        ...state,
        phase: isWallExhausted ? 'round_end' : 'playing',
        players: nextPlayers,
        round: {
          ...round,
          currentTurnIndex: isWallExhausted
            ? round.currentTurnIndex
            : nextTurnIndex,
          wall: nextWall,
          turnCount: round.turnCount + 1,
        },
      };
    }

    case 'ADVANCE_ROUND': {
      const currentRound = state.round!;
      const nextRoundIndex = currentRound.roundIndex + 1;

      if (nextRoundIndex >= rules.totalRounds) {
        const finishedPlayers = state.players.map((p) => ({
          ...p,
          hand: [],
          drawnTile: null,
          discards: [],
          melds: [],
        }));
        return {
          ...state,
          phase: 'finished',
          players: finishedPlayers,
          round: null,
        };
      }

      const roundMeta = getRoundMetadata(
        nextRoundIndex,
        currentRound.initialDealerIndex,
        rules,
      );
      const deal = dealRound(rules, roundMeta.dealerIndex, action.seed);

      const nextPlayers = state.players.map((p) => ({
        ...p,
        hand: deal.hands[p.seatIndex]!,
        drawnTile:
          p.seatIndex === roundMeta.dealerIndex ? deal.dealerDrawnTile : null,
        discards: [],
        melds: [],
      }));

      return {
        ...state,
        phase: 'playing',
        players: nextPlayers,
        round: {
          roundIndex: nextRoundIndex,
          roundWind: roundMeta.roundWind,
          kyokuNumber: roundMeta.kyokuNumber,
          initialDealerIndex: currentRound.initialDealerIndex,
          dealerIndex: roundMeta.dealerIndex,
          currentTurnIndex: roundMeta.dealerIndex,
          wall: deal.wall,
          deadWall: deal.deadWall,
          turnCount: 0,
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
  }
}

export function applyAction(
  state: GameState,
  action: Action,
): { state: GameState; error: GameError | null } {
  const error = validateAction(state, action);
  if (error !== null) {
    return { state, error };
  }
  return { state: reduce(state, action), error: null };
}
