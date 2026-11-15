import type {
  PublicPlayerView,
  RoundView,
  SelfTurnActionsView,
  StateView,
} from '../types/message';
import type { CallOptions, GameState } from '../types/state';
import { getSelfTurnActions } from './calls';
import { deriveRules, getSeatWind } from './rules';

function cloneCallOptions(opts: CallOptions): CallOptions {
  return {
    discardedTile: { ...opts.discardedTile },
    discarderSeatIndex: opts.discarderSeatIndex,
    canRon: opts.canRon,
    canPon: opts.canPon,
    canDaiminkan: opts.canDaiminkan,
    chiOptions: opts.chiOptions.map((c) => ({
      tiles: [{ ...c.tiles[0] }, { ...c.tiles[1] }],
    })),
  };
}

export function toStateView(
  state: GameState,
  viewerPlayerId: string,
  now = 0,
): StateView {
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
      type: m.type,
      tiles: m.tiles.map((t) => ({ ...t })),
      calledTile: m.calledTile ? { ...m.calledTile } : null,
      fromSeatIndex: m.fromSeatIndex,
      addedTile: m.addedTile ? { ...m.addedTile } : null,
    })),
    kitaTiles: p.kitaTiles.map((t) => ({ ...t })),
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
        doraIndicators: state.round.deadWall.doraIndicators
          .slice(0, state.round.deadWall.revealedDoraCount)
          .map((t) => ({ ...t })),
        kanCount: state.round.kanCount,
        ronWinners: state.round.ronWinners.map((w) => ({
          ...w,
          winningTile: { ...w.winningTile },
        })),
      }
    : null;

  let myCallOptions: CallOptions | null = null;
  let responseRemainingMs: number | null = null;

  if (
    state.phase === 'awaiting_responses' &&
    state.round?.pendingResponse
  ) {
    const pending = state.round.pendingResponse;
    const rawOpts = pending.optionsByPlayerId[viewer.playerId];
    if (rawOpts && !(viewer.playerId in pending.responses)) {
      myCallOptions = cloneCallOptions(rawOpts);
    }
    if (rules.responseTimeoutMs > 0) {
      responseRemainingMs = Math.max(
        0,
        pending.openedAt + rules.responseTimeoutMs - now,
      );
    }
  }

  const isViewerTurn =
    state.phase === 'playing' &&
    state.round !== null &&
    viewer.seatIndex === state.round.currentTurnIndex;

  let mySelfActions: SelfTurnActionsView | null = null;
  if (isViewerTurn && state.round) {
    const actions = getSelfTurnActions(viewer, state.round, rules);
    if (
      actions.canAnkanKinds.length > 0 ||
      actions.canKakanTileIds.length > 0 ||
      actions.canKitaTileIds.length > 0
    ) {
      mySelfActions = actions;
    }
  }

  const kuikaeForbiddenKinds =
    isViewerTurn && state.round
      ? [...state.round.kuikaeForbiddenKinds]
      : [];

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
    myCallOptions,
    mySelfActions,
    kuikaeForbiddenKinds,
    responseRemainingMs,
    round,
  };
}
