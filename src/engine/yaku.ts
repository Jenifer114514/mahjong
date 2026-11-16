import type { DerivedRules, Wind } from '../types/rule';
import type { YakuEntry } from '../types/state';
import type { TileKind } from '../types/tile';
import type { AgariDecomposition, AgariMentsu } from './agari';

export interface YakuContext {
  isTsumo: boolean;
  roundWind: Wind;
  seatWind: Wind;
  rules: DerivedRules;
  isRiichi?: boolean;
  isDoubleRiichi?: boolean;
  isIppatsu?: boolean;
  isRinshan?: boolean;
  isChankan?: boolean;
  isHaitei?: boolean;
  isHoutei?: boolean;
  isTenhou?: boolean;
  isChiihou?: boolean;
}

export interface YakuEvaluation {
  yaku: YakuEntry[];
  yakuHan: number;
  isYakuman: boolean;
  yakumanMultiplier: number;
  hasPinfu: boolean;
}

const WIND_TO_KIND: Record<Wind, TileKind> = {
  E: '1z',
  S: '2z',
  W: '3z',
  N: '4z',
};

const WIND_JA: Record<Wind, string> = {
  E: '東',
  S: '南',
  W: '西',
  N: '北',
};

const GREEN_KINDS = new Set<TileKind>(['2s', '3s', '4s', '6s', '8s', '6z']);
const WIND_KINDS: readonly TileKind[] = ['1z', '2z', '3z', '4z'];
const DRAGON_KINDS: readonly TileKind[] = ['5z', '6z', '7z'];

export function isTerminalOrHonorKind(kind: TileKind): boolean {
  if (kind.endsWith('z')) return true;
  const rank = Number(kind[0]);
  return rank === 1 || rank === 9;
}

export function isTerminalKind(kind: TileKind): boolean {
  if (kind.endsWith('z')) return false;
  const rank = Number(kind[0]);
  return rank === 1 || rank === 9;
}

export function isHonorKind(kind: TileKind): boolean {
  return kind.endsWith('z');
}

function getSuit(kind: TileKind): 'm' | 'p' | 's' | 'z' {
  return kind[1] as 'm' | 'p' | 's' | 'z';
}

export function getPairYakuhaiHan(pairKind: TileKind, ctx: YakuContext): number {
  if (pairKind === '5z' || pairKind === '6z' || pairKind === '7z') {
    return 2;
  }
  if (ctx.rules.playerCount === 3 && pairKind === '4z') {
    return 0;
  }
  const matchesRound = pairKind === WIND_TO_KIND[ctx.roundWind];
  const matchesSeat = pairKind === WIND_TO_KIND[ctx.seatWind];
  if (matchesRound && matchesSeat) {
    return ctx.rules.doubleWindPairFu;
  }
  if (matchesRound || matchesSeat) {
    return 2;
  }
  return 0;
}

function getMentsuYakuhaiEntries(
  mentsu: AgariMentsu,
  ctx: YakuContext,
): YakuEntry[] {
  if (mentsu.type === 'shuntsu') return [];
  const kind = mentsu.kinds[0]!;
  const entries: YakuEntry[] = [];

  if (kind === '5z') entries.push({ id: 'yakuhai_haku', name: '役牌 白', han: 1 });
  if (kind === '6z') entries.push({ id: 'yakuhai_hatsu', name: '役牌 發', han: 1 });
  if (kind === '7z') entries.push({ id: 'yakuhai_chun', name: '役牌 中', han: 1 });

  // 3人麻雀では北(4z)は役牌にならない
  if (ctx.rules.playerCount === 3 && kind === '4z') {
    return entries;
  }

  if (kind === WIND_TO_KIND[ctx.roundWind]) {
    entries.push({
      id: 'yakuhai_round_wind',
      name: `場風 ${WIND_JA[ctx.roundWind]}`,
      han: 1,
    });
  }
  if (kind === WIND_TO_KIND[ctx.seatWind]) {
    entries.push({
      id: 'yakuhai_seat_wind',
      name: `自風 ${WIND_JA[ctx.seatWind]}`,
      han: 1,
    });
  }

  return entries;
}

function addFlushYaku(
  yaku: YakuEntry[],
  allKinds: readonly TileKind[],
  isMenzen: boolean,
): void {
  const numberSuits = new Set<'m' | 'p' | 's'>();
  let hasHonor = false;
  for (const k of allKinds) {
    const suit = getSuit(k);
    if (suit === 'z') {
      hasHonor = true;
    } else {
      numberSuits.add(suit);
    }
  }
  if (numberSuits.size === 1) {
    if (hasHonor) {
      yaku.push({
        id: 'honitsu',
        name: '混一色',
        han: isMenzen ? 3 : 2,
      });
    } else {
      yaku.push({
        id: 'chinitsu',
        name: '清一色',
        han: isMenzen ? 6 : 5,
      });
    }
  }
}

function makeYakumanEntry(
  id: string,
  name: string,
  multiplier: 1 | 2 = 1,
): YakuEntry {
  return {
    id,
    name,
    han: multiplier * 13,
    isYakuman: true,
    yakumanMultiplier: multiplier,
  };
}

function finalizeYakumanResult(yakumanList: YakuEntry[]): YakuEvaluation {
  const yakumanMultiplier = yakumanList.reduce(
    (sum, y) => sum + (y.yakumanMultiplier ?? 1),
    0,
  );
  return {
    yaku: yakumanList,
    yakuHan: yakumanMultiplier * 13,
    isYakuman: true,
    yakumanMultiplier,
    hasPinfu: false,
  };
}

function detectChuurenYakuman(
  decomp: Extract<AgariDecomposition, { form: 'standard' }>,
): YakuEntry | null {
  if (!decomp.isMenzen) return null;
  if (decomp.mentsu.some((m) => m.type === 'kantsu')) return null;

  const allKinds: TileKind[] = [
    decomp.pairKind,
    decomp.pairKind,
    ...decomp.mentsu.flatMap((m) => m.kinds),
  ];
  const suit = getSuit(allKinds[0]!);
  if (suit === 'z') return null;
  if (!allKinds.every((k) => getSuit(k) === suit)) return null;

  const rankCounts = Array(10).fill(0) as number[];
  for (const k of allKinds) {
    rankCounts[Number(k[0])] = (rankCounts[Number(k[0])] ?? 0) + 1;
  }

  if ((rankCounts[1] ?? 0) < 3 || (rankCounts[9] ?? 0) < 3) {
    return null;
  }
  for (let r = 2; r <= 8; r++) {
    if ((rankCounts[r] ?? 0) < 1) {
      return null;
    }
  }

  // 和了牌1枚を除いて 1112345678999 なら純正九蓮宝燈（9面待ち）
  const winRank = Number(decomp.winningKind[0]);
  const baseCounts = [...rankCounts];
  baseCounts[winRank] = (baseCounts[winRank] ?? 0) - 1;
  const isJunsei =
    baseCounts[1] === 3 &&
    baseCounts[9] === 3 &&
    [2, 3, 4, 5, 6, 7, 8].every((r) => baseCounts[r] === 1);

  return isJunsei
    ? makeYakumanEntry('junsei_chuuren', '純正九蓮宝燈', 2)
    : makeYakumanEntry('chuuren_poutou', '九蓮宝燈', 1);
}

function addSituationalYaku(yaku: YakuEntry[], ctx: YakuContext): void {
  if (ctx.isRinshan && ctx.isTsumo) {
    yaku.push({ id: 'rinshan_kaihou', name: '嶺上開花', han: 1 });
  }
  if (ctx.isChankan && !ctx.isTsumo) {
    yaku.push({ id: 'chankan', name: '槍槓', han: 1 });
  }
  if (ctx.isHaitei && ctx.isTsumo && !ctx.isRinshan) {
    yaku.push({ id: 'haitei_tsumo', name: '海底摸月', han: 1 });
  }
  if (ctx.isHoutei && !ctx.isTsumo && !ctx.isChankan) {
    yaku.push({ id: 'houtei_ron', name: '河底撈魚', han: 1 });
  }
}

export function evaluateYaku(
  decomp: AgariDecomposition,
  ctx: YakuContext,
): YakuEvaluation {
  const yakuman: YakuEntry[] = [];

  if (ctx.isTenhou && ctx.isTsumo) {
    yakuman.push(makeYakumanEntry('tenhou', '天和', 1));
  } else if (ctx.isChiihou && ctx.isTsumo) {
    yakuman.push(makeYakumanEntry('chiihou', '地和', 1));
  }

  if (decomp.form === 'kokushi') {
    yakuman.push(
      decomp.is13Wait
        ? makeYakumanEntry('kokushi_13', '国士無双十三面待ち', 2)
        : makeYakumanEntry('kokushi', '国士無双', 1),
    );
    return finalizeYakumanResult(yakuman);
  }

  if (decomp.form === 'chiitoitsu') {
    const allKinds = decomp.pairKinds;
    if (allKinds.every((k) => isHonorKind(k))) {
      yakuman.push(makeYakumanEntry('tsuuiisou', '字一色', 1));
    }
    if (yakuman.length > 0) {
      return finalizeYakumanResult(yakuman);
    }

    const yaku: YakuEntry[] = [];
    if (ctx.isDoubleRiichi) {
      yaku.push({ id: 'double_riichi', name: 'ダブルリーチ', han: 2 });
    } else if (ctx.isRiichi) {
      yaku.push({ id: 'riichi', name: 'リーチ', han: 1 });
    }
    if (ctx.isIppatsu && (ctx.isRiichi || ctx.isDoubleRiichi)) {
      yaku.push({ id: 'ippatsu', name: '一発', han: 1 });
    }

    yaku.push({ id: 'chiitoitsu', name: '七対子', han: 2 });

    if (ctx.isTsumo) {
      yaku.push({ id: 'menzen_tsumo', name: '門前清自摸和', han: 1 });
    }

    addSituationalYaku(yaku, ctx);

    if (allKinds.every((k) => !isTerminalOrHonorKind(k))) {
      yaku.push({ id: 'tanyao', name: '断幺九', han: 1 });
    } else if (
      allKinds.every((k) => isTerminalOrHonorKind(k)) &&
      allKinds.some((k) => isHonorKind(k)) &&
      allKinds.some((k) => !isHonorKind(k))
    ) {
      yaku.push({ id: 'honroutou', name: '混老頭', han: 2 });
    }

    addFlushYaku(yaku, allKinds, true);

    return {
      yaku,
      yakuHan: yaku.reduce((s, e) => s + e.han, 0),
      isYakuman: false,
      yakumanMultiplier: 0,
      hasPinfu: false,
    };
  }

  // 通常形 (4面子1雀頭): まず役満判定
  const { isMenzen, mentsu, pairKind, machi } = decomp;
  const allKinds: TileKind[] = [
    pairKind,
    pairKind,
    ...mentsu.flatMap((m) => m.kinds),
  ];
  const shuntsuList = mentsu.filter((m) => m.type === 'shuntsu');
  const koutsuOrKantsuList = mentsu.filter((m) => m.type !== 'shuntsu');
  const kantsuCount = mentsu.filter((m) => m.type === 'kantsu').length;

  // 四暗刻 / 四暗刻単騎
  const closedTripletCount = koutsuOrKantsuList.filter((m) => !m.isOpen).length;
  if (closedTripletCount === 4) {
    yakuman.push(
      machi === 'tanki'
        ? makeYakumanEntry('suuankou_tanki', '四暗刻単騎', 2)
        : makeYakumanEntry('suuankou', '四暗刻', 1),
    );
  }

  // 大三元
  const dragonTripletCount = koutsuOrKantsuList.filter((m) =>
    DRAGON_KINDS.includes(m.kinds[0]!),
  ).length;
  if (dragonTripletCount === 3) {
    yakuman.push(makeYakumanEntry('daisangen', '大三元', 1));
  }

  // 小四喜 / 大四喜
  const windTripletCount = koutsuOrKantsuList.filter((m) =>
    WIND_KINDS.includes(m.kinds[0]!),
  ).length;
  if (windTripletCount === 4) {
    yakuman.push(makeYakumanEntry('daisuushii', '大四喜', 2));
  } else if (windTripletCount === 3 && WIND_KINDS.includes(pairKind)) {
    yakuman.push(makeYakumanEntry('shousuushii', '小四喜', 1));
  }

  // 字一色
  if (allKinds.every((k) => isHonorKind(k))) {
    yakuman.push(makeYakumanEntry('tsuuiisou', '字一色', 1));
  }

  // 緑一色（發なしも有効）
  if (allKinds.every((k) => GREEN_KINDS.has(k))) {
    yakuman.push(makeYakumanEntry('ryuuiisou', '緑一色', 1));
  }

  // 清老頭
  if (allKinds.every((k) => isTerminalKind(k))) {
    yakuman.push(makeYakumanEntry('chinroutou', '清老頭', 1));
  }

  // 九蓮宝燈 / 純正九蓮宝燈
  const chuuren = detectChuurenYakuman(decomp);
  if (chuuren) {
    yakuman.push(chuuren);
  }

  // 四槓子
  if (kantsuCount === 4) {
    yakuman.push(makeYakumanEntry('suukantsu', '四槓子', 1));
  }

  if (yakuman.length > 0) {
    return finalizeYakumanResult(yakuman);
  }

  // 通常役
  const yaku: YakuEntry[] = [];

  if (ctx.isDoubleRiichi) {
    yaku.push({ id: 'double_riichi', name: 'ダブルリーチ', han: 2 });
  } else if (ctx.isRiichi) {
    yaku.push({ id: 'riichi', name: 'リーチ', han: 1 });
  }

  if (ctx.isIppatsu && (ctx.isRiichi || ctx.isDoubleRiichi)) {
    yaku.push({ id: 'ippatsu', name: '一発', han: 1 });
  }

  // 門前清自摸和
  if (isMenzen && ctx.isTsumo) {
    yaku.push({ id: 'menzen_tsumo', name: '門前清自摸和', han: 1 });
  }

  addSituationalYaku(yaku, ctx);

  // 平和（門前・全順子・非役牌雀頭・両面待ち）
  const hasPinfu =
    isMenzen &&
    shuntsuList.length === 4 &&
    getPairYakuhaiHan(pairKind, ctx) === 0 &&
    machi === 'ryanmen';
  if (hasPinfu) {
    yaku.push({ id: 'pinfu', name: '平和', han: 1 });
  }

  // 断幺九（食いタン設定に従う）
  if (
    (isMenzen || ctx.rules.allowKuitan) &&
    allKinds.every((k) => !isTerminalOrHonorKind(k))
  ) {
    yaku.push({ id: 'tanyao', name: '断幺九', han: 1 });
  }

  // 一盃口 / 二盃口（門前限定）
  if (isMenzen && shuntsuList.length >= 2) {
    const shuntsuCounts = new Map<string, number>();
    for (const s of shuntsuList) {
      const key = s.kinds.join(',');
      shuntsuCounts.set(key, (shuntsuCounts.get(key) ?? 0) + 1);
    }
    let identicalPairs = 0;
    for (const c of shuntsuCounts.values()) {
      identicalPairs += Math.floor(c / 2);
    }
    if (identicalPairs === 2) {
      yaku.push({ id: 'ryanpeikou', name: '二盃口', han: 3 });
    } else if (identicalPairs === 1) {
      yaku.push({ id: 'iipeikou', name: '一盃口', han: 1 });
    }
  }

  // 役牌（白・發・中・場風・自風）
  for (const m of koutsuOrKantsuList) {
    yaku.push(...getMentsuYakuhaiEntries(m, ctx));
  }

  // 三色同順（門前2 / 副露1）
  if (shuntsuList.length >= 3) {
    const shuntsuSet = new Set<string>(
      shuntsuList.map((s) => s.kinds[0]!),
    );
    let hasSanshokuDoujun = false;
    for (let rank = 1; rank <= 7; rank++) {
      if (
        shuntsuSet.has(`${rank}m`) &&
        shuntsuSet.has(`${rank}p`) &&
        shuntsuSet.has(`${rank}s`)
      ) {
        hasSanshokuDoujun = true;
        break;
      }
    }
    if (hasSanshokuDoujun) {
      yaku.push({
        id: 'sanshoku_doujun',
        name: '三色同順',
        han: isMenzen ? 2 : 1,
      });
    }
  }

  // 一気通貫（門前2 / 副露1）
  if (shuntsuList.length >= 3) {
    const shuntsuSet = new Set<string>(
      shuntsuList.map((s) => s.kinds[0]!),
    );
    const hasIttsu = (['m', 'p', 's'] as const).some(
      (suit) =>
        shuntsuSet.has(`1${suit}`) &&
        shuntsuSet.has(`4${suit}`) &&
        shuntsuSet.has(`7${suit}`),
    );
    if (hasIttsu) {
      yaku.push({
        id: 'ittsu',
        name: '一気通貫',
        han: isMenzen ? 2 : 1,
      });
    }
  }

  // 対々和（2翻）
  if (koutsuOrKantsuList.length === 4) {
    yaku.push({ id: 'toitoi', name: '対々和', han: 2 });
  }

  // 三暗刻（2翻）
  if (closedTripletCount >= 3) {
    yaku.push({ id: 'sanankou', name: '三暗刻', han: 2 });
  }

  // 三色同刻（2翻）
  if (koutsuOrKantsuList.length >= 3) {
    const koutsuKinds = new Set<TileKind>(
      koutsuOrKantsuList.map((m) => m.kinds[0]!),
    );
    let hasSanshokuDoukou = false;
    for (let rank = 1; rank <= 9; rank++) {
      if (
        koutsuKinds.has(`${rank}m` as TileKind) &&
        koutsuKinds.has(`${rank}p` as TileKind) &&
        koutsuKinds.has(`${rank}s` as TileKind)
      ) {
        hasSanshokuDoukou = true;
        break;
      }
    }
    if (hasSanshokuDoukou) {
      yaku.push({ id: 'sanshoku_doukou', name: '三色同刻', han: 2 });
    }
  }

  // 三槓子（2翻）
  if (kantsuCount >= 3) {
    yaku.push({ id: 'sankantsu', name: '三槓子', han: 2 });
  }

  // 混老頭（2翻） vs 純全帯幺九（門前3 / 副露2） vs 混全帯幺九（門前2 / 副露1）
  const allGroupsHaveYaochu =
    isTerminalOrHonorKind(pairKind) &&
    mentsu.every((m) => m.kinds.some((k) => isTerminalOrHonorKind(k)));

  if (
    shuntsuList.length === 0 &&
    allKinds.every((k) => isTerminalOrHonorKind(k)) &&
    allKinds.some((k) => isHonorKind(k)) &&
    allKinds.some((k) => !isHonorKind(k))
  ) {
    yaku.push({ id: 'honroutou', name: '混老頭', han: 2 });
  } else if (shuntsuList.length > 0 && allGroupsHaveYaochu) {
    if (allKinds.some((k) => isHonorKind(k))) {
      yaku.push({
        id: 'chanta',
        name: '混全帯幺九',
        han: isMenzen ? 2 : 1,
      });
    } else {
      yaku.push({
        id: 'junchan',
        name: '純全帯幺九',
        han: isMenzen ? 3 : 2,
      });
    }
  }

  // 小三元（2翻）
  if (DRAGON_KINDS.includes(pairKind)) {
    const shousangenDragons = koutsuOrKantsuList.filter((m) =>
      DRAGON_KINDS.includes(m.kinds[0]!),
    ).length;
    if (shousangenDragons === 2) {
      yaku.push({ id: 'shousangen', name: '小三元', han: 2 });
    }
  }

  // 混一色 / 清一色
  addFlushYaku(yaku, allKinds, isMenzen);

  return {
    yaku,
    yakuHan: yaku.reduce((s, e) => s + e.han, 0),
    isYakuman: false,
    yakumanMultiplier: 0,
    hasPinfu,
  };
}
