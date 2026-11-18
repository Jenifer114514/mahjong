import type { DerivedRules } from '../types/rule';
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
  computeChiKuikaeKinds,
  evaluateRonForPlayer,
  isSuukanzuTriggered,
  validateChiTilePair,
  validatePonTilePair,
} from './calls';
import { getRevealedUraDoraIndicators } from './dora';
import {
  buildAgariWinnerRecord,
  clearIppatsuForAllPlayers,
  commitPendingRiichiIfAny,
  extractTileFromHandOrDrawn,
  markSameTurnFuritenForMissedRons,
  removeLastDiscardFromDiscarder,
  removeTilesFromHand,
  seatDistance,
} from './reducerHelpers';
import { calculateNotenPenalties, decideNextRound } from './roundProgression';
import { deriveRules } from './rules';
import {
  applyKandoraTiming,
  drawRinshanAndReplenish,
  flushPendingKandora,
  sortTiles,
} from './wall';

export function enterAbortiveDrawRound(
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

export function resolveAbortiveDrawOrAdvanceTurn(
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

export function commitAnkan(
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

export function commitKakan(
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

export function resolvePendingResponses(
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
