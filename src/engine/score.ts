import {
  HONBA_POINTS_BY_PLAYERS,
  type DerivedRules,
  type PlayerCount,
  type Wind,
} from '../types/rule';
import type { Meld, YakuEntry } from '../types/state';
import type { Tile, TileKind } from '../types/tile';
import {
  countKindInHandAndMelds,
  enumerateAgariDecompositions,
  type AgariDecomposition,
  type AgariMentsu,
} from './agari';
import { countDoraAndKita } from './dora';
import {
  evaluateYaku,
  getPairYakuhaiHan,
  isTerminalOrHonorKind,
  type YakuContext,
  type YakuEvaluation,
} from './yaku';

export interface ScoreEvaluationParams {
  hand: readonly Tile[];
  melds: readonly Meld[];
  kitaTiles: readonly Tile[];
  winningTile: Tile;
  isTsumo: boolean;
  isDealer: boolean;
  roundWind: Wind;
  seatWind: Wind;
  doraIndicators: readonly Tile[];
  uraDoraIndicators?: readonly Tile[];
  isRiichi?: boolean;
  isDoubleRiichi?: boolean;
  isIppatsu?: boolean;
  isRinshan?: boolean;
  isChankan?: boolean;
  isHaitei?: boolean;
  isHoutei?: boolean;
  isTenhou?: boolean;
  isChiihou?: boolean;
  winnerSeatIndex: number;
  fromSeatIndex: number | null;
  honba?: number;
  rules: DerivedRules;
}

export interface ScoreLimitDetail {
  basePoints: number;
  scoreLabel: string;
}

export interface AgariScoreResult {
  decomposition: AgariDecomposition;
  yaku: YakuEntry[];
  yakuHan: number;
  doraCount: number;
  uraDoraCount: number;
  kitaCount: number;
  totalHan: number;
  fu: number;
  isYakuman: boolean;
  basePoints: number;
  scoreLabel: string;
  pointsAwarded: number;
  honbaPointsAwarded: number;
  /** 席番号(0..playerCount-1)ごとの点棒増減（本場加算を含む） */
  deltasBySeat: number[];
}

export function ceilTo10(value: number): number {
  return Math.ceil(value / 10) * 10;
}

export function ceilTo100(value: number): number {
  return Math.ceil(value / 100) * 100;
}

function getMentsuFu(mentsu: AgariMentsu): number {
  if (mentsu.type === 'shuntsu') return 0;
  const isYaochu = isTerminalOrHonorKind(mentsu.kinds[0]!);
  if (mentsu.type === 'koutsu') {
    if (mentsu.isOpen) {
      return isYaochu ? 4 : 2;
    }
    return isYaochu ? 8 : 4;
  }
  // kantsu
  if (mentsu.isOpen) {
    return isYaochu ? 16 : 8;
  }
  return isYaochu ? 32 : 16;
}

export function calculateFu(
  decomp: AgariDecomposition,
  yakuEval: YakuEvaluation,
  ctx: YakuContext,
): number {
  if (decomp.form === 'kokushi') {
    return 0;
  }
  if (decomp.form === 'chiitoitsu') {
    return 25;
  }
  if (yakuEval.hasPinfu && ctx.isTsumo) {
    return 20;
  }

  let fu = 20;

  if (decomp.isMenzen && !ctx.isTsumo) {
    fu += 10;
  }
  if (ctx.isTsumo) {
    fu += 2;
  }

  for (const m of decomp.mentsu) {
    fu += getMentsuFu(m);
  }

  fu += getPairYakuhaiHan(decomp.pairKind, ctx);

  if (
    decomp.machi === 'kanchan' ||
    decomp.machi === 'penchan' ||
    decomp.machi === 'tanki'
  ) {
    fu += 2;
  }

  const rounded = ceilTo10(fu);
  // 副露した平和形のロンは30符（20符のままにはしない）
  if (!decomp.isMenzen && !ctx.isTsumo && rounded < 30) {
    return 30;
  }
  return rounded;
}

export function resolveBasePoints(
  totalHan: number,
  fu: number,
  isYakuman: boolean,
  rules: DerivedRules,
  yakumanMultiplier?: number,
): ScoreLimitDetail {
  const limits = rules.scoreLimits;

  if (isYakuman) {
    const mult = Math.max(
      1,
      yakumanMultiplier ?? Math.floor(totalHan / 13),
    );
    const scoreLabel =
      mult === 1
        ? '役満'
        : mult === 2
          ? 'ダブル役満'
          : mult === 3
            ? 'トリプル役満'
            : `${mult}倍役満`;
    return { basePoints: limits.yakuman * mult, scoreLabel };
  }
  if (rules.allowKazoeYakuman && totalHan >= 13) {
    return { basePoints: limits.yakuman, scoreLabel: '数え役満' };
  }
  if (totalHan >= 11) {
    return { basePoints: limits.sanbaiman, scoreLabel: '三倍満' };
  }
  if (totalHan >= 8) {
    return { basePoints: limits.baiman, scoreLabel: '倍満' };
  }
  if (totalHan >= 6) {
    return { basePoints: limits.haneman, scoreLabel: '跳満' };
  }
  if (totalHan >= 5) {
    return { basePoints: limits.mangan, scoreLabel: '満貫' };
  }

  if (
    rules.kiriageMangan &&
    ((totalHan === 4 && fu === 30) || (totalHan === 3 && fu === 60))
  ) {
    return { basePoints: limits.mangan, scoreLabel: '満貫' };
  }

  const rawBase = fu * Math.pow(2, totalHan + 2);
  if (rawBase >= limits.mangan) {
    return { basePoints: limits.mangan, scoreLabel: '満貫' };
  }
  return {
    basePoints: rawBase,
    scoreLabel: `${fu}符${totalHan}翻`,
  };
}

export function calculatePaymentDeltas(params: {
  playerCount: PlayerCount;
  dealerIndex: number;
  winnerSeatIndex: number;
  fromSeatIndex: number | null;
  basePoints: number;
  isDealer: boolean;
  isTsumo: boolean;
  tsumoLoss: boolean;
  honba?: number;
  honbaBonus?: boolean;
  honbaPointsPerStick?: number;
}): { pointsAwarded: number; honbaPointsAwarded: number; deltasBySeat: number[] } {
  const {
    playerCount,
    dealerIndex,
    winnerSeatIndex,
    fromSeatIndex,
    basePoints,
    isDealer,
    isTsumo,
    tsumoLoss,
    honba = 0,
    honbaBonus = true,
    honbaPointsPerStick = HONBA_POINTS_BY_PLAYERS[playerCount],
  } = params;

  const deltas = new Array<number>(playerCount).fill(0);
  const honbaPointsAwarded =
    honbaBonus && honba > 0 ? honba * honbaPointsPerStick : 0;

  if (!isTsumo) {
    if (fromSeatIndex === null) {
      throw new Error('Ron payment requires fromSeatIndex');
    }
    const ronPoints = ceilTo100(basePoints * (isDealer ? 6 : 4));
    deltas[winnerSeatIndex] = ronPoints + honbaPointsAwarded;
    deltas[fromSeatIndex] = -(ronPoints + honbaPointsAwarded);
    return {
      pointsAwarded: ronPoints,
      honbaPointsAwarded,
      deltasBySeat: deltas,
    };
  }

  // ツモ支払い
  let totalAwarded = 0;
  const payerCount = playerCount - 1;
  const eachHonbaPay =
    honbaPointsAwarded > 0 ? Math.floor(honbaPointsAwarded / payerCount) : 0;

  if (isDealer) {
    const baseChildPay = ceilTo100(basePoints * 2);
    const sanmaExtra =
      playerCount === 3 && !tsumoLoss ? ceilTo100(baseChildPay / 2) : 0;
    const eachPay = baseChildPay + sanmaExtra;

    for (let seat = 0; seat < playerCount; seat++) {
      if (seat === winnerSeatIndex) continue;
      deltas[seat] = -(eachPay + eachHonbaPay);
      totalAwarded += eachPay;
    }
    deltas[winnerSeatIndex] = totalAwarded + eachHonbaPay * payerCount;
    return {
      pointsAwarded: totalAwarded,
      honbaPointsAwarded: eachHonbaPay * payerCount,
      deltasBySeat: deltas,
    };
  }

  // 子のツモ
  const baseChildPay = ceilTo100(basePoints);
  const baseDealerPay = ceilTo100(basePoints * 2);
  const sanmaExtra =
    playerCount === 3 && !tsumoLoss ? ceilTo100(baseChildPay / 2) : 0;

  for (let seat = 0; seat < playerCount; seat++) {
    if (seat === winnerSeatIndex) continue;
    const pay =
      (seat === dealerIndex ? baseDealerPay : baseChildPay) + sanmaExtra;
    deltas[seat] = -(pay + eachHonbaPay);
    totalAwarded += pay;
  }
  deltas[winnerSeatIndex] = totalAwarded + eachHonbaPay * payerCount;
  return {
    pointsAwarded: totalAwarded,
    honbaPointsAwarded: eachHonbaPay * payerCount,
    deltasBySeat: deltas,
  };
}

function hasAnyNonDoraYakuForWaitKind(
  handWithoutWin: readonly Tile[],
  melds: readonly Meld[],
  waitKind: TileKind,
  ctx: YakuContext,
): boolean {
  const decomps = enumerateAgariDecompositions(
    handWithoutWin,
    melds,
    waitKind,
    ctx.isTsumo,
  );
  return decomps.some((d) => evaluateYaku(d, ctx).yaku.length > 0);
}

/** 後付けなしルール時: 副露ありの形で、和了形を完成させる全待ち牌種に役があるかを判定 */
function passesAtozukeCheck(
  handWithoutWin: readonly Tile[],
  melds: readonly Meld[],
  ctx: YakuContext,
): boolean {
  const isMenzen = melds.every((m) => m.type === 'ankan');
  if (isMenzen || ctx.rules.allowAtozuke) {
    return true;
  }

  for (const waitKind of ctx.rules.allowedTileKinds) {
    if (
      countKindInHandAndMelds(handWithoutWin, melds, waitKind) >=
      ctx.rules.tileSet.copiesPerKind
    ) {
      continue;
    }
    const decomps = enumerateAgariDecompositions(
      handWithoutWin,
      melds,
      waitKind,
      ctx.isTsumo,
    );
    if (decomps.length === 0) continue;
    if (!hasAnyNonDoraYakuForWaitKind(handWithoutWin, melds, waitKind, ctx)) {
      return false;
    }
  }
  return true;
}

export function evaluateBestAgari(
  params: ScoreEvaluationParams & { dealerIndex: number },
): AgariScoreResult | null {
  const {
    hand,
    melds,
    kitaTiles,
    winningTile,
    isTsumo,
    isDealer,
    roundWind,
    seatWind,
    doraIndicators,
    uraDoraIndicators = [],
    isRiichi = false,
    isDoubleRiichi = false,
    isIppatsu = false,
    isRinshan = false,
    isChankan = false,
    isHaitei = false,
    isHoutei = false,
    isTenhou = false,
    isChiihou = false,
    dealerIndex,
    winnerSeatIndex,
    fromSeatIndex,
    honba = 0,
    rules,
  } = params;

  const decomps = enumerateAgariDecompositions(
    hand,
    melds,
    winningTile.kind,
    isTsumo,
  );
  if (decomps.length === 0) {
    return null;
  }

  const ctx: YakuContext = {
    isTsumo,
    roundWind,
    seatWind,
    rules,
    isRiichi,
    isDoubleRiichi,
    isIppatsu,
    isRinshan,
    isChankan,
    isHaitei,
    isHoutei,
    isTenhou,
    isChiihou,
  };

  // 後付けなし判定は偶然役・一発を除いた本質手役のみで評価する
  const atozukeCtx: YakuContext = {
    isTsumo,
    roundWind,
    seatWind,
    rules,
    isRiichi,
    isDoubleRiichi,
  };

  if (!passesAtozukeCheck(hand, melds, atozukeCtx)) {
    return null;
  }

  const { doraCount, uraDoraCount, kitaCount } = countDoraAndKita({
    hand,
    winningTile,
    melds,
    kitaTiles,
    doraIndicators,
    uraDoraIndicators: isRiichi ? uraDoraIndicators : [],
    rules,
  });

  let best: AgariScoreResult | null = null;

  for (const decomp of decomps) {
    const yakuEval = evaluateYaku(decomp, ctx);
    if (yakuEval.yaku.length === 0) {
      continue;
    }

    const fu = calculateFu(decomp, yakuEval, ctx);
    const effectiveDora = yakuEval.isYakuman ? 0 : doraCount;
    const effectiveUraDora = yakuEval.isYakuman || !isRiichi ? 0 : uraDoraCount;
    const effectiveKita = yakuEval.isYakuman ? 0 : kitaCount;
    const totalHan = yakuEval.isYakuman
      ? yakuEval.yakuHan
      : yakuEval.yakuHan + effectiveDora + effectiveUraDora + effectiveKita;

    const { basePoints, scoreLabel } = resolveBasePoints(
      totalHan,
      fu,
      yakuEval.isYakuman,
      rules,
      yakuEval.isYakuman ? yakuEval.yakumanMultiplier : undefined,
    );

    const payment = calculatePaymentDeltas({
      playerCount: rules.playerCount,
      dealerIndex,
      winnerSeatIndex,
      fromSeatIndex,
      basePoints,
      isDealer,
      isTsumo,
      tsumoLoss: rules.tsumoLoss,
      honba,
      honbaBonus: rules.honbaBonus,
      honbaPointsPerStick: rules.honbaPointsPerStick,
    });

    const candidate: AgariScoreResult = {
      decomposition: decomp,
      yaku: yakuEval.yaku,
      yakuHan: yakuEval.yakuHan,
      doraCount: effectiveDora,
      uraDoraCount: effectiveUraDora,
      kitaCount: effectiveKita,
      totalHan,
      fu,
      isYakuman: yakuEval.isYakuman,
      basePoints,
      scoreLabel,
      pointsAwarded: payment.pointsAwarded,
      honbaPointsAwarded: payment.honbaPointsAwarded,
      deltasBySeat: payment.deltasBySeat,
    };

    if (
      best === null ||
      candidate.pointsAwarded > best.pointsAwarded ||
      (candidate.pointsAwarded === best.pointsAwarded &&
        candidate.totalHan > best.totalHan) ||
      (candidate.pointsAwarded === best.pointsAwarded &&
        candidate.totalHan === best.totalHan &&
        candidate.fu > best.fu)
    ) {
      best = candidate;
    }
  }

  return best;
}
