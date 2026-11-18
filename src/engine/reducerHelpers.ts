import type { DerivedRules, RuleConfig } from '../types/rule';
import type {
  CallResponseChoice,
  GameState,
  PendingResponseState,
  PlayerState,
  RoundAgariWinner,
} from '../types/state';
import type { Tile } from '../types/tile';
import { decideNextRound } from './roundProgression';
import type { AgariScoreResult } from './score';
import { sortTiles } from './wall';

export function normalizePlayerName(name: string, fallbackNumber: number): string {
  const trimmed = name.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 20) : `プレイヤー${fallbackNumber}`;
}

export function areSamePlayerIds(
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

export function removeTilesFromHand(
  hand: readonly Tile[],
  removeIds: readonly string[],
): Tile[] {
  const ids = new Set(removeIds);
  return sortTiles(hand.filter((t) => !ids.has(t.id)));
}

export function extractTileFromHandOrDrawn(
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

export function deltasBySeatToPlayerMap(
  players: readonly PlayerState[],
  deltasBySeat: readonly number[],
): Record<string, number> {
  const result: Record<string, number> = {};
  for (const p of players) {
    result[p.playerId] = deltasBySeat[p.seatIndex] ?? 0;
  }
  return result;
}

export function buildAgariWinnerRecord(params: {
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

export function getNextRoundDecisionForRound(
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

export function mergeRuleConfig(
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

export function markSameTurnFuritenForMissedRons(
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

export function clearIppatsuForAllPlayers(
  players: readonly PlayerState[],
): PlayerState[] {
  return players.map((p) =>
    p.ippatsuEligible ? { ...p, ippatsuEligible: false } : p,
  );
}

export function commitPendingRiichiIfAny(
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

export function seatDistance(
  fromSeat: number,
  targetSeat: number,
  playerCount: number,
): number {
  return (((targetSeat - fromSeat) % playerCount) + playerCount) % playerCount;
}

export function removeLastDiscardFromDiscarder(
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
