import type { DerivedRules, Wind } from '../types/rule';
import type { YakuEntry } from '../types/state';
import type { TileKind } from '../types/tile';
import type { AgariDecomposition, AgariMentsu } from './agari';

export interface YakuContext {
  isTsumo: boolean;
  roundWind: Wind;
  seatWind: Wind;
  rules: DerivedRules;
}

export interface YakuEvaluation {
  yaku: YakuEntry[];
  yakuHan: number;
  isYakuman: boolean;
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

export function isTerminalOrHonorKind(kind: TileKind): boolean {
  if (kind.endsWith('z')) return true;
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

export function evaluateYaku(
  decomp: AgariDecomposition,
  ctx: YakuContext,
): YakuEvaluation {
  if (decomp.form === 'kokushi') {
    const yaku: YakuEntry[] = [
      {
        id: 'kokushi',
        name: '国士無双',
        han: 13,
        isYakuman: true,
      },
    ];
    return {
      yaku,
      yakuHan: 13,
      isYakuman: true,
      hasPinfu: false,
    };
  }

  const yaku: YakuEntry[] = [];

  if (decomp.form === 'chiitoitsu') {
    yaku.push({ id: 'chiitoitsu', name: '七対子', han: 2 });

    if (ctx.isTsumo) {
      yaku.push({ id: 'menzen_tsumo', name: '門前清自摸和', han: 1 });
    }

    const allKinds = decomp.pairKinds;
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
      hasPinfu: false,
    };
  }

  // 通常形 (4面子1雀頭)
  const { isMenzen, mentsu, pairKind, machi } = decomp;
  const allKinds: TileKind[] = [
    pairKind,
    ...mentsu.flatMap((m) => m.kinds),
  ];

  // 門前清自摸和
  if (isMenzen && ctx.isTsumo) {
    yaku.push({ id: 'menzen_tsumo', name: '門前清自摸和', han: 1 });
  }

  // 平和（門前・全順子・非役牌雀頭・両面待ち）
  const shuntsuList = mentsu.filter((m) => m.type === 'shuntsu');
  const koutsuOrKantsuList = mentsu.filter((m) => m.type !== 'shuntsu');
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
  const closedTriplets = koutsuOrKantsuList.filter((m) => !m.isOpen).length;
  if (closedTriplets >= 3) {
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
  const kantsuCount = mentsu.filter((m) => m.type === 'kantsu').length;
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
  const dragonKinds: readonly TileKind[] = ['5z', '6z', '7z'];
  if (dragonKinds.includes(pairKind)) {
    const dragonTripletCount = koutsuOrKantsuList.filter((m) =>
      dragonKinds.includes(m.kinds[0]!),
    ).length;
    if (dragonTripletCount === 2) {
      yaku.push({ id: 'shousangen', name: '小三元', han: 2 });
    }
  }

  // 混一色 / 清一色
  addFlushYaku(yaku, allKinds, isMenzen);

  return {
    yaku,
    yakuHan: yaku.reduce((s, e) => s + e.han, 0),
    isYakuman: false,
    hasPinfu,
  };
}
