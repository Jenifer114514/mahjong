import type { PublicPlayerView, RoundView, StateView } from '../types/message';
import type { GameState } from '../types/state';
import { deriveRules, getSeatWind } from './rules';

export function toStateView(state: GameState, viewerPlayerId: string): StateView {
  const rules = deriveRules(state.ruleConfig);
  const viewer = state.players.find((p) => p.playerId === viewerPlayerId);
  if (!viewer) {
    throw new Error(`Viewer player not found: ${viewerPlayerId}`);
  }

  const orderedPlayers = [...state.players].sort(
    (a, b) => a.seatIndex - b.seatIndex,
  );

  const players: PublicPlayerView[] = orderedPlayers.map((p) => ({
    playerId: p.playerId,
    name: p.name,
    seatIndex: p.seatIndex,
    seatWind: state.round
      ? getSeatWind(p.seatIndex, state.round.dealerIndex, rules.seatWinds)
      : null,
    score: p.score,
    handCount: p.hand.length,
    hasDrawnTile: p.drawnTile !== null,
    discards: p.discards.map((d) => ({
      tile: { ...d.tile },
      isTsumogiri: d.isTsumogiri,
    })),
    melds: p.melds.map((m) => ({
      ...m,
      tiles: m.tiles.map((t) => ({ ...t })),
    })),
    isDealer: state.round ? p.seatIndex === state.round.dealerIndex : false,
    isCurrentTurn:
      state.phase === 'playing' &&
      state.round !== null &&
      p.seatIndex === state.round.currentTurnIndex,
    connected: p.connected,
  }));

  const round: RoundView | null = state.round
    ? {
        roundIndex: state.round.roundIndex,
        totalRounds: rules.totalRounds,
        roundWind: state.round.roundWind,
        kyokuNumber: state.round.kyokuNumber,
        dealerIndex: state.round.dealerIndex,
        currentTurnIndex: state.round.currentTurnIndex,
        remainingWallCount: state.round.wall.length,
      }
    : null;

  return {
    roomCode: state.roomCode,
    hostPlayerId: state.hostPlayerId,
    viewerPlayerId: viewer.playerId,
    viewerSeatIndex: viewer.seatIndex,
    ruleConfig: { ...state.ruleConfig },
    phase: state.phase,
    players,
    myHand: viewer.hand.map((t) => ({ ...t })),
    myDrawnTile: viewer.drawnTile ? { ...viewer.drawnTile } : null,
    round,
  };
}
