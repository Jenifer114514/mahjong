import type { DerivedRules } from '../types/rule';
import type {
  AbortiveDrawReason,
  FinalKyotakuAward,
  NextRoundDecision,
  PlayerState,
} from '../types/state';
import type { Tile } from '../types/tile';
import { getTenpaiWaitKinds } from './agari';
import { sortTiles } from './wall';

export interface NotenPenaltyResult {
  tenpaiPlayerIds: string[];
  notenPlayerIds: string[];
  deltasByPlayerId: Record<string, number>;
  revealedHands: Record<string, Tile[]>;
}

export interface RoundOutcomeForProgression {
  roundIndex: number;
  honba: number;
  dealerIndex: number;
  agariWinnerSeatIndices?: readonly number[];
  abortiveDrawReason?: AbortiveDrawReason | null;
  tenpaiPlayerIds?: readonly string[];
  isTobiEnded?: boolean;
}

export function seatOffsetFromDealer(
  initialDealerIndex: number,
  seatIndex: number,
  playerCount: number,
): number {
  return ((seatIndex - initialDealerIndex) % playerCount + playerCount) % playerCount;
}

/** 持ち点降順、同点は起家(initialDealerIndex)に近い席が上位 */
export function rankPlayers<T extends { seatIndex: number; score: number }>(
  players: readonly T[],
  initialDealerIndex: number,
): T[] {
  const count = players.length;
  return [...players].sort(
    (a, b) =>
      b.score - a.score ||
      seatOffsetFromDealer(initialDealerIndex, a.seatIndex, count) -
        seatOffsetFromDealer(initialDealerIndex, b.seatIndex, count),
  );
}

/**
 * 通常流局時のテンパイ自動判定。
 * リーチ者は必ずテンパイ、それ以外は getTenpaiWaitKinds に従い、
 * 自分の手牌＋副露で4枚使い切りの純粋空聴はノーテン、フリテン中・役なし・他家河4枚切れ形式空聴はテンパイとする。
 */
export function isPlayerTenpai(
  player: Pick<PlayerState, 'isRiichi' | 'hand' | 'melds'>,
  rules: DerivedRules,
): boolean {
  if (player.isRiichi) {
    return true;
  }
  return getTenpaiWaitKinds(player.hand, player.melds, rules).length > 0;
}

/** 通常流局時のノーテン罰符（総額3000点を人数割り）とテンパイ者手牌開示を計算 */
export function calculateNotenPenalties(
  players: readonly PlayerState[],
  rules: DerivedRules,
): NotenPenaltyResult {
  const ordered = [...players].sort((a, b) => a.seatIndex - b.seatIndex);
  const tenpaiPlayerIds: string[] = [];
  const notenPlayerIds: string[] = [];
  const revealedHands: Record<string, Tile[]> = {};
  const deltasByPlayerId: Record<string, number> = {};

  for (const p of ordered) {
    deltasByPlayerId[p.playerId] = 0;
    if (isPlayerTenpai(p, rules)) {
      tenpaiPlayerIds.push(p.playerId);
      revealedHands[p.playerId] = sortTiles(p.hand);
    } else {
      notenPlayerIds.push(p.playerId);
    }
  }

  const tenpaiCount = tenpaiPlayerIds.length;
  const notenCount = notenPlayerIds.length;

  if (tenpaiCount > 0 && notenCount > 0) {
    const tenpaiGain = Math.floor(rules.notenPenaltyTotal / tenpaiCount);
    const notenPay = Math.floor(rules.notenPenaltyTotal / notenCount);
    for (const pid of tenpaiPlayerIds) {
      deltasByPlayerId[pid] = tenpaiGain;
    }
    for (const pid of notenPlayerIds) {
      deltasByPlayerId[pid] = -notenPay;
    }
  }

  return {
    tenpaiPlayerIds,
    notenPlayerIds,
    deltasByPlayerId,
    revealedHands,
  };
}

/**
 * 次局の進行（連荘 / 親流れ / 終局）を決定する純粋関数。
 * 優先順位: トビ終了（最優先） > 途中流局 > 和了 > 通常流局
 * オーラスのアガリ止め・テンパイ止め・西入はなし。
 */
export function decideNextRound(
  roundOutcome: RoundOutcomeForProgression,
  players: readonly Pick<PlayerState, 'playerId' | 'seatIndex' | 'score'>[],
  rules: DerivedRules,
): NextRoundDecision {
  const isOorasu = roundOutcome.roundIndex >= rules.totalRounds - 1;
  const isTobi =
    rules.tobi &&
    (roundOutcome.isTobiEnded === true || players.some((p) => p.score < 0));

  if (isTobi) {
    return {
      outcome: 'game_end',
      nextRoundIndex: roundOutcome.roundIndex,
      nextHonba: roundOutcome.honba,
      isOorasu,
      reason: 'tobi',
    };
  }

  if (
    roundOutcome.abortiveDrawReason !== undefined &&
    roundOutcome.abortiveDrawReason !== null
  ) {
    return {
      outcome: 'renchan',
      nextRoundIndex: roundOutcome.roundIndex,
      nextHonba: roundOutcome.honba + 1,
      isOorasu,
      reason: 'abortive_draw',
    };
  }

  const winnerSeats = roundOutcome.agariWinnerSeatIndices ?? [];
  if (winnerSeats.length > 0) {
    const dealerWon = winnerSeats.includes(roundOutcome.dealerIndex);
    if (dealerWon) {
      return {
        outcome: 'renchan',
        nextRoundIndex: roundOutcome.roundIndex,
        nextHonba: roundOutcome.honba + 1,
        isOorasu,
        reason: winnerSeats.length >= 2 ? 'double_ron_with_oya' : 'oya_agari',
      };
    }

    if (isOorasu) {
      return {
        outcome: 'game_end',
        nextRoundIndex: roundOutcome.roundIndex,
        nextHonba: 0,
        isOorasu,
        reason: 'ko_agari',
      };
    }

    return {
      outcome: 'oya_nagare',
      nextRoundIndex: roundOutcome.roundIndex + 1,
      nextHonba: 0,
      isOorasu,
      reason: 'ko_agari',
    };
  }

  // 通常流局（荒牌平局）
  const dealerPlayer = players.find(
    (p) => p.seatIndex === roundOutcome.dealerIndex,
  );
  const tenpaiSet = new Set(roundOutcome.tenpaiPlayerIds ?? []);
  const dealerIsTenpai =
    dealerPlayer !== undefined && tenpaiSet.has(dealerPlayer.playerId);

  if (dealerIsTenpai) {
    return {
      outcome: 'renchan',
      nextRoundIndex: roundOutcome.roundIndex,
      nextHonba: roundOutcome.honba + 1,
      isOorasu,
      reason: 'oya_tenpai_draw',
    };
  }

  if (isOorasu) {
    return {
      outcome: 'game_end',
      nextRoundIndex: roundOutcome.roundIndex,
      nextHonba: roundOutcome.honba + 1,
      isOorasu,
      reason: 'oya_noten_draw',
    };
  }

  return {
    outcome: 'oya_nagare',
    nextRoundIndex: roundOutcome.roundIndex + 1,
    nextHonba: roundOutcome.honba + 1,
    isOorasu,
    reason: 'oya_noten_draw',
  };
}

/** 終局時に場に残った供託リーチ棒を最終トップ（同点は起家寄り）へ加算する */
export function resolveLeftoverKyotaku(
  players: readonly PlayerState[],
  kyotakuCount: number,
  initialDealerIndex: number,
  rules: DerivedRules,
): { players: PlayerState[]; award: FinalKyotakuAward | null } {
  if (kyotakuCount <= 0 || players.length === 0) {
    return { players: [...players], award: null };
  }
  const ranked = rankPlayers(players, initialDealerIndex);
  const topPlayer = ranked[0]!;
  const points = kyotakuCount * rules.riichiStickPoints;
  return {
    players: players.map((p) =>
      p.playerId === topPlayer.playerId
        ? { ...p, score: p.score + points }
        : p,
    ),
    award: {
      playerId: topPlayer.playerId,
      points,
    },
  };
}
