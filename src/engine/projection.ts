import type {
  PublicPlayerView,
  RoundView,
  SelfTurnActionsView,
  StateView,
} from '../types/message';
import type { CallOptions, GameState, RoundAgariWinner } from '../types/state';
import { getSelfTurnActions, isPlayerFuriten } from './calls';
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

function cloneAgariWinner(w: RoundAgariWinner): RoundAgariWinner {
  return {
    winType: w.winType,
    playerId: w.playerId,
    seatIndex: w.seatIndex,
    fromSeatIndex: w.fromSeatIndex,
    winningTile: { ...w.winningTile },
    hand: w.hand.map((t) => ({ ...t })),
    melds: w.melds.map((m) => ({
      type: m.type,
      tiles: m.tiles.map((t) => ({ ...t })),
      calledTile: m.calledTile ? { ...m.calledTile } : null,
      fromSeatIndex: m.fromSeatIndex,
      addedTile: m.addedTile ? { ...m.addedTile } : null,
    })),
    kitaTiles: w.kitaTiles.map((t) => ({ ...t })),
    yaku: w.yaku.map((y) => ({ ...y })),
    doraCount: w.doraCount,
    uraDoraCount: w.uraDoraCount,
    kitaCount: w.kitaCount,
    han: w.han,
    fu: w.fu,
    isYakuman: w.isYakuman,
    scoreLabel: w.scoreLabel,
    pointsAwarded: w.pointsAwarded,
    honbaPointsAwarded: w.honbaPointsAwarded,
    scoreDeltas: { ...w.scoreDeltas },
  };
}

export interface ToStateViewOptions {
  perspectiveSeatIndex?: number;
  hostEpoch?: number;
}

export function toStateView(
  state: GameState,
  viewerPlayerId: string,
  now = 0,
  options: ToStateViewOptions = {},
): StateView {
  const rules = deriveRules(state.ruleConfig);
  const viewer = state.players.find((p) => p.playerId === viewerPlayerId);
  const spectator = viewer
    ? undefined
    : (state.spectators ?? []).find((s) => s.spectatorId === viewerPlayerId);
  if (!viewer && !spectator) {
    throw new Error(`Viewer player not found: ${viewerPlayerId}`);
  }

  let myCallOptions: CallOptions | null = null;
  let responseRemainingMs: number | null = null;

  if (
    viewer &&
    state.phase === 'awaiting_responses' &&
    state.round?.pendingResponse
  ) {
    const pending = state.round.pendingResponse;
    const rawOpts = pending.optionsByPlayerId[viewer.playerId];
    if (rawOpts && !(viewer.playerId in pending.responses)) {
      myCallOptions = cloneCallOptions(rawOpts);
      if (rules.responseTimeoutMs > 0) {
        responseRemainingMs = Math.max(
          0,
          pending.openedAt + rules.responseTimeoutMs - now,
        );
      }
    }
  }

  // 選択肢のない視点には応答待ちの有無を漏らさない（phase・手番・残り時間を通常進行に見せる）
  const isMaskedAwaiting =
    state.phase === 'awaiting_responses' && myCallOptions === null;
  const viewPhase = isMaskedAwaiting ? 'playing' : state.phase;

  let maskedTurnIndex = state.round?.currentTurnIndex ?? 0;
  if (isMaskedAwaiting && state.round?.pendingResponse) {
    const pending = state.round.pendingResponse;
    maskedTurnIndex =
      pending.kind === 'kakan' || pending.kind === 'ankan'
        ? pending.discarderSeatIndex
        : state.round.wall.length > 0
          ? (pending.discarderSeatIndex + 1) % rules.playerCount
          : pending.discarderSeatIndex;
  }

  const maskedTurnPlayer = state.round
    ? state.players.find((p) => p.seatIndex === maskedTurnIndex)
    : undefined;
  const maskedTurnPlayerId = maskedTurnPlayer?.playerId ?? null;

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
      ...(d.isRiichiDeclaration ? { isRiichiDeclaration: true } : {}),
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
      viewPhase === 'playing' &&
      state.round !== null &&
      p.seatIndex === maskedTurnIndex,
    isRiichi: p.isRiichi,
    isDoubleRiichi: p.isDoubleRiichi,
    connected: p.connected,
  }));

  const round: RoundView | null = state.round
    ? {
        roundIndex: state.round.roundIndex,
        honba: state.round.honba,
        totalRounds: rules.totalRounds,
        roundWind: state.round.roundWind,
        kyokuNumber: state.round.kyokuNumber,
        dealerIndex: state.round.dealerIndex,
        currentTurnIndex: maskedTurnIndex,
        actingPlayerId: maskedTurnPlayerId,
        turnCount: state.round.turnCount,
        remainingWallCount: state.round.wall.length,
        doraIndicators: state.round.deadWall.doraIndicators
          .slice(0, state.round.deadWall.revealedDoraCount)
          .map((t) => ({ ...t })),
        uraDoraIndicators:
          state.phase === 'round_end'
            ? state.round.uraDoraIndicators.map((t) => ({ ...t }))
            : [],
        kanCount: state.round.kanCount,
        ronWinners: state.round.ronWinners.map((w) => ({
          ...w,
          winningTile: { ...w.winningTile },
        })),
        agariResults: state.round.agariResults.map(cloneAgariWinner),
        abortiveDrawReason: state.round.abortiveDrawReason,
        abortiveDrawPlayerId: state.round.abortiveDrawPlayerId,
        tenpaiPlayerIds:
          state.phase === 'round_end'
            ? [...state.round.tenpaiPlayerIds]
            : [],
        revealedHands:
          state.phase === 'round_end'
            ? Object.fromEntries(
                Object.entries(state.round.revealedHands).map(([pid, tiles]) => [
                  pid,
                  tiles.map((t) => ({ ...t })),
                ]),
              )
            : {},
        kyotakuWinnerPlayerId: state.round.kyotakuWinnerPlayerId,
        kyotakuPointsAwarded: state.round.kyotakuPointsAwarded,
        roundScoreDeltas: { ...state.round.roundScoreDeltas },
        isTobiEnded: state.round.isTobiEnded,
        nextRoundDecision:
          state.phase === 'round_end' && state.round.nextRoundDecision
            ? { ...state.round.nextRoundDecision }
            : null,
      }
    : null;

  const isViewerTurn =
    Boolean(viewer) &&
    state.phase === 'playing' &&
    state.round !== null &&
    viewer!.seatIndex === state.round.currentTurnIndex;

  let mySelfActions: SelfTurnActionsView | null = null;
  if (viewer && isViewerTurn && state.round) {
    const actions = getSelfTurnActions(viewer, state.round, rules);
    if (
      actions.canTsumo ||
      actions.canRiichiTileIds.length > 0 ||
      actions.canAnkanKinds.length > 0 ||
      actions.canKakanTileIds.length > 0 ||
      actions.canKitaTileIds.length > 0 ||
      actions.canKyuushuKyuuhai
    ) {
      mySelfActions = actions;
    }
  }

  const kuikaeForbiddenKinds =
    viewer && isViewerTurn && state.round
      ? [...state.round.kuikaeForbiddenKinds]
      : [];

  const isFuriten =
    viewer &&
    state.round !== null &&
    state.phase !== 'round_end' &&
    state.phase !== 'finished'
      ? isPlayerFuriten(viewer, rules)
      : false;

  const spectatorSeatCount = state.players.length;
  const spectatorSeatIndex =
    spectatorSeatCount > 0
      ? (((options.perspectiveSeatIndex ?? 0) % spectatorSeatCount) +
          spectatorSeatCount) %
        spectatorSeatCount
      : 0;

  return {
    roomCode: state.roomCode,
    hostPlayerId: state.hostPlayerId,
    viewerPlayerId: viewer ? viewer.playerId : spectator!.spectatorId,
    viewerSeatIndex: viewer ? viewer.seatIndex : spectatorSeatIndex,
    ruleConfig: { ...state.ruleConfig },
    phase: viewPhase,
    players,
    initialDealerIndex: state.initialDealerIndex,
    kyotakuCount: state.kyotakuCount,
    finalKyotakuAward: state.finalKyotakuAward
      ? { ...state.finalKyotakuAward }
      : null,
    myHand: viewer ? viewer.hand.map((t) => ({ ...t })) : [],
    myDrawnTile: viewer && viewer.drawnTile ? { ...viewer.drawnTile } : null,
    myCallOptions,
    mySelfActions,
    isFuriten,
    kuikaeForbiddenKinds,
    responseRemainingMs,
    round,
    isSpectator: Boolean(spectator),
    spectators: (state.spectators ?? []).map((s) => ({ ...s })),
    ...(options.hostEpoch !== undefined ? { hostEpoch: options.hostEpoch } : {}),
  };
}
