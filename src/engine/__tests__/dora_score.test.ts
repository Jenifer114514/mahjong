import { describe, expect, it } from 'vitest';
import type { Meld } from '../../types/state';
import type { Tile, TileKind } from '../../types/tile';
import { countDoraAndKita, getDoraKindFromIndicator } from '../dora';
import { deriveRules } from '../rules';
import {
  calculatePaymentDeltas,
  evaluateBestAgari,
  resolveBasePoints,
} from '../score';

function makeTiles(kinds: readonly TileKind[], prefix = 't'): Tile[] {
  return kinds.map((kind, i) => ({
    id: `${prefix}-${kind}-${i}`,
    kind,
    isRed: false,
  }));
}

function makeMeld(
  type: Meld['type'],
  kinds: readonly TileKind[],
  fromSeatIndex: number | null = 3,
): Meld {
  const tiles = makeTiles(kinds, `m-${type}`);
  return {
    type,
    tiles,
    calledTile: type === 'ankan' ? null : tiles[0]!,
    fromSeatIndex: type === 'ankan' ? null : fromSeatIndex,
    addedTile: type === 'kakan' ? tiles[3]! : null,
  };
}

describe('第3A段階: ドラ判定・抜北・三麻萬子循環', () => {
  it('4人麻雀・3人麻雀のドラ表示牌循環ルールが正しく動作する', () => {
    const r4 = deriveRules({ playerCount: 4, gameLength: 'tonpuu' });
    const r3 = deriveRules({ playerCount: 3, gameLength: 'tonpuu' });

    expect(getDoraKindFromIndicator('1m', r4)).toBe('2m');
    expect(getDoraKindFromIndicator('9m', r4)).toBe('1m');
    expect(getDoraKindFromIndicator('9p', r4)).toBe('1p');
    expect(getDoraKindFromIndicator('9s', r4)).toBe('1s');
    expect(getDoraKindFromIndicator('4z', r4)).toBe('1z');
    expect(getDoraKindFromIndicator('7z', r4)).toBe('5z');

    // 三麻は2m〜8mが存在しないため 1m <-> 9m
    expect(getDoraKindFromIndicator('1m', r3)).toBe('9m');
    expect(getDoraKindFromIndicator('9m', r3)).toBe('1m');
  });

  it('三麻の抜北は各1翻 + ドラ表示牌が西(3z)なら北ドラとも重複する', () => {
    const r3 = deriveRules({ playerCount: 3, gameLength: 'tonpuu' });
    const res = countDoraAndKita({
      hand: makeTiles(['1p', '2p', '3p']),
      winningTile: { id: 'win', kind: '1m', isRed: false },
      melds: [makeMeld('ankan', ['9m', '9m', '9m', '9m'], null)],
      kitaTiles: makeTiles(['4z', '4z'], 'k'),
      doraIndicators: makeTiles(['1m', '3z'], 'd'), // ドラ: 9m と 4z
      rules: r3,
    });
    expect(res.doraCount).toBe(6); // 9m×4 (暗槓) + 4z×2 (抜北)
    expect(res.kitaCount).toBe(2);
  });
});

describe('第3A段階: 点数表・満貫以上・三麻ツモ損/折半', () => {
  it('4人麻雀の固定点数表（切り上げ満貫なし・20〜110符・満貫〜役満）とゼロサムが一致する', () => {
    // 30符 1〜4翻 (子ロン: 1000 / 2000 / 3900 / 7700, 親ロン: 1500 / 2900 / 5800 / 11600)
    const childRonExpected = [1000, 2000, 3900, 7700];
    const dealerRonExpected = [1500, 2900, 5800, 11600];
    const rules = deriveRules({ playerCount: 4, gameLength: 'tonpuu' });

    for (let han = 1; han <= 4; han++) {
      const { basePoints } = resolveBasePoints(han, 30, false, rules);
      const cr = calculatePaymentDeltas({
        playerCount: 4,
        dealerIndex: 0,
        winnerSeatIndex: 1,
        fromSeatIndex: 2,
        basePoints,
        isDealer: false,
        isTsumo: false,
        tsumoLoss: false,
      });
      expect(cr.pointsAwarded).toBe(childRonExpected[han - 1]);
      expect(cr.deltasBySeat.reduce((a, b) => a + b, 0)).toBe(0);

      const dr = calculatePaymentDeltas({
        playerCount: 4,
        dealerIndex: 0,
        winnerSeatIndex: 0,
        fromSeatIndex: 2,
        basePoints,
        isDealer: true,
        isTsumo: false,
        tsumoLoss: false,
      });
      expect(dr.pointsAwarded).toBe(dealerRonExpected[han - 1]);
      expect(dr.deltasBySeat.reduce((a, b) => a + b, 0)).toBe(0);
    }

    // 七対子25符2翻 子ロン1600 / 親ロン2400
    const chiitoiBase = resolveBasePoints(2, 25, false, rules).basePoints;
    expect(
      calculatePaymentDeltas({
        playerCount: 4,
        dealerIndex: 0,
        winnerSeatIndex: 1,
        fromSeatIndex: 0,
        basePoints: chiitoiBase,
        isDealer: false,
        isTsumo: false,
        tsumoLoss: false,
      }).pointsAwarded,
    ).toBe(1600);
    expect(
      calculatePaymentDeltas({
        playerCount: 4,
        dealerIndex: 0,
        winnerSeatIndex: 0,
        fromSeatIndex: 1,
        basePoints: chiitoiBase,
        isDealer: true,
        isTsumo: false,
        tsumoLoss: false,
      }).pointsAwarded,
    ).toBe(2400);

    // 満貫・跳満・倍満・三倍満・数え役満
    const tierCases: Array<[number, number, string, number, number]> = [
      [5, 30, '満貫', 8000, 12000],
      [6, 30, '跳満', 12000, 18000],
      [7, 40, '跳満', 12000, 18000],
      [8, 30, '倍満', 16000, 24000],
      [10, 30, '倍満', 16000, 24000],
      [11, 30, '三倍満', 24000, 36000],
      [13, 30, '数え役満', 32000, 48000],
    ];
    for (const [han, fu, label, childPts, dealerPts] of tierCases) {
      const resolved = resolveBasePoints(han, fu, false, rules);
      expect(resolved.scoreLabel).toBe(label);
      expect(
        calculatePaymentDeltas({
          playerCount: 4,
          dealerIndex: 0,
          winnerSeatIndex: 1,
          fromSeatIndex: 3,
          basePoints: resolved.basePoints,
          isDealer: false,
          isTsumo: false,
          tsumoLoss: false,
        }).pointsAwarded,
      ).toBe(childPts);
      expect(
        calculatePaymentDeltas({
          playerCount: 4,
          dealerIndex: 0,
          winnerSeatIndex: 0,
          fromSeatIndex: 3,
          basePoints: resolved.basePoints,
          isDealer: true,
          isTsumo: false,
          tsumoLoss: false,
        }).pointsAwarded,
      ).toBe(dealerPts);
    }
  });

  it('3人麻雀: tsumoLoss = true (ツモ損あり) と tsumoLoss = false (折半) の支払い配分が正しい', () => {
    // 子満貫 (基本点2000 -> 4麻なら 2000/4000)
    const lossChildMangan = calculatePaymentDeltas({
      playerCount: 3,
      dealerIndex: 0,
      winnerSeatIndex: 1,
      fromSeatIndex: null,
      basePoints: 2000,
      isDealer: false,
      isTsumo: true,
      tsumoLoss: true,
    });
    expect(lossChildMangan.deltasBySeat).toEqual([-4000, 6000, -2000]);

    const splitChildMangan = calculatePaymentDeltas({
      playerCount: 3,
      dealerIndex: 0,
      winnerSeatIndex: 1,
      fromSeatIndex: null,
      basePoints: 2000,
      isDealer: false,
      isTsumo: true,
      tsumoLoss: false,
    });
    // 欠け北分 2000 を 1000 ずつ折半 -> 親5000 / 子3000 = 8000
    expect(splitChildMangan.deltasBySeat).toEqual([-5000, 8000, -3000]);
    expect(splitChildMangan.deltasBySeat.reduce((a, b) => a + b, 0)).toBe(0);

    // 親満貫 (基本点2000 -> 4麻なら 4000オール)
    const splitDealerMangan = calculatePaymentDeltas({
      playerCount: 3,
      dealerIndex: 0,
      winnerSeatIndex: 0,
      fromSeatIndex: null,
      basePoints: 2000,
      isDealer: true,
      isTsumo: true,
      tsumoLoss: false,
    });
    expect(splitDealerMangan.deltasBySeat).toEqual([12000, -6000, -6000]);

    // 端数折半切り上げ: 子 30符2翻 (基本点480 -> 4麻子500/親1000, 欠け500 -> ceil100(250)=300加算)
    const r3 = deriveRules({ playerCount: 3, gameLength: 'tonpuu', tsumoLoss: false });
    const base30_2 = resolveBasePoints(2, 30, false, r3).basePoints;
    const oddSplit = calculatePaymentDeltas({
      playerCount: 3,
      dealerIndex: 0,
      winnerSeatIndex: 1,
      fromSeatIndex: null,
      basePoints: base30_2,
      isDealer: false,
      isTsumo: true,
      tsumoLoss: false,
    });
    expect(oddSplit.deltasBySeat).toEqual([-1300, 2100, -800]);
  });
});

describe('第3A段階: 役判定・符計算・高点法・喰いタン・後付け', () => {
  const rules4 = deriveRules({ playerCount: 4, gameLength: 'tonpuu' });

  it('平和ツモ(20符) vs 平和ロン(30符) vs 副露平和形ロン(30符)', () => {
    // 234m 456p 678s 23s 99p + 1s (辺張? いや両面: 4sツモ/ロン)
    const hand = makeTiles([
      '2m', '3m', '4m',
      '4p', '5p', '6p',
      '6s', '7s', '8s',
      '2s', '3s',
      '9p', '9p',
    ]);
    const winTile: Tile = { id: 'win-4s', kind: '4s', isRed: false };

    const tsumo = evaluateBestAgari({
      hand,
      melds: [],
      kitaTiles: [],
      winningTile: winTile,
      isTsumo: true,
      isDealer: false,
      dealerIndex: 0,
      roundWind: 'E',
      seatWind: 'S',
      doraIndicators: makeTiles(['9m']), // ドラ1m(0枚)
      winnerSeatIndex: 1,
      fromSeatIndex: null,
      rules: rules4,
    })!;
    expect(tsumo.fu).toBe(20);
    expect(tsumo.yaku.map((y) => y.id).sort()).toEqual(['menzen_tsumo', 'pinfu']);
    expect(tsumo.pointsAwarded).toBe(1500); // 400/700 = 1500

    const ron = evaluateBestAgari({
      hand,
      melds: [],
      kitaTiles: [],
      winningTile: winTile,
      isTsumo: false,
      isDealer: false,
      dealerIndex: 0,
      roundWind: 'E',
      seatWind: 'S',
      doraIndicators: makeTiles(['9m']),
      winnerSeatIndex: 1,
      fromSeatIndex: 0,
      rules: rules4,
    })!;
    expect(ron.fu).toBe(30);
    expect(ron.yaku.map((y) => y.id)).toEqual(['pinfu']);
    expect(ron.pointsAwarded).toBe(1000);

    // 副露した平和形（234mチー + 456p + 678s + 55p + 23s + 4sロン）は30符（喰いタンなしでも1000には役が必要 -> 役あり例として 234mチー + 345p + 567s + 23s + 88p + 4s）
    const openHand = makeTiles([
      '3p', '4p', '5p',
      '5s', '6s', '7s',
      '2s', '3s',
      '8p', '8p',
    ]);
    const openRon = evaluateBestAgari({
      hand: openHand,
      melds: [makeMeld('chi', ['2m', '3m', '4m'])],
      kitaTiles: [],
      winningTile: { id: 'w-4s', kind: '4s', isRed: false },
      isTsumo: false,
      isDealer: false,
      dealerIndex: 0,
      roundWind: 'E',
      seatWind: 'S',
      doraIndicators: makeTiles(['9m']),
      winnerSeatIndex: 1,
      fromSeatIndex: 0,
      rules: rules4,
    })!;
    expect(openRon.fu).toBe(30);
    expect(openRon.yaku.map((y) => y.id)).toEqual(['tanyao']);
    expect(openRon.pointsAwarded).toBe(1000);
  });

  it('ロンで完成した刻子は明刻扱いになり三暗刻にならないが、ツモなら三暗刻になる', () => {
    const hand = makeTiles([
      '2m', '2m', '2m',
      '5p', '5p', '5p',
      '7s', '7s',
      '1p', '2p', '3p',
      '9s', '9s',
    ]);
    const winTile: Tile = { id: 'win-7s', kind: '7s', isRed: false };

    const ron = evaluateBestAgari({
      hand,
      melds: [],
      kitaTiles: [],
      winningTile: winTile,
      isTsumo: false,
      isDealer: false,
      dealerIndex: 0,
      roundWind: 'E',
      seatWind: 'S',
      doraIndicators: makeTiles(['8m']),
      winnerSeatIndex: 1,
      fromSeatIndex: 0,
      rules: rules4,
    });
    // ロンだと三暗刻にならず役なし -> null
    expect(ron).toBeNull();

    const tsumo = evaluateBestAgari({
      hand,
      melds: [],
      kitaTiles: [],
      winningTile: winTile,
      isTsumo: true,
      isDealer: false,
      dealerIndex: 0,
      roundWind: 'E',
      seatWind: 'S',
      doraIndicators: makeTiles(['8m']),
      winnerSeatIndex: 1,
      fromSeatIndex: null,
      rules: rules4,
    })!;
    expect(tsumo.yaku.map((y) => y.id).sort()).toEqual(['menzen_tsumo', 'sanankou']);
    // 20 + 2(tsumo) + 4(2m暗刻) + 4(5p暗刻) + 4(7s暗刻) = 34 -> 40符3翻
    expect(tsumo.fu).toBe(40);
    expect(tsumo.totalHan).toBe(3);
  });

  it('高点法: 二盃口(5翻満貫) vs 七対子(3翻) や 単騎/暗刻解釈の違いで高い方を選ぶ', () => {
    // 223344m 556677s 88p + 4mロン -> 二盃口(3)+平和(1)+断幺九(1)=5翻満貫 vs 七対子は構成しない(順子形は二盃口)
    // 223344556677p 88s (8sロン vs 2pロン): 七対子でもあり二盃口+清一色/断幺九でもある -> 二盃口+断幺九+清一色(6+3+1=10翻倍満) vs 七対子+断幺九+混一色...
    // 純粋な 二盃口 vs 七対子: 223344m 556677s 88p で 2m を和了
    const hand = makeTiles([
      '2m', '3m', '3m', '4m', '4m',
      '5s', '5s', '6s', '6s', '7s', '7s',
      '8p', '8p',
    ]);
    const res = evaluateBestAgari({
      hand,
      melds: [],
      kitaTiles: [],
      winningTile: { id: 'w-2m', kind: '2m', isRed: false },
      isTsumo: false,
      isDealer: false,
      dealerIndex: 0,
      roundWind: 'E',
      seatWind: 'S',
      doraIndicators: makeTiles(['9z'.replace('9z', '1z') as TileKind]),
      winnerSeatIndex: 1,
      fromSeatIndex: 0,
      rules: rules4,
    })!;
    expect(res.decomposition.form).toBe('standard');
    expect(res.yaku.map((y) => y.id)).toContain('ryanpeikou');
    expect(res.pointsAwarded).toBe(8000); // 平和(1)+断幺九(1)+二盃口(3) = 5翻 満貫
  });

  it('ドラのみ（役なし）は和了不可で、主要各役・ダブ東4符・三麻北役牌なしを正しく判定する', () => {
    // ドラ3だが役なし
    const noYaku = evaluateBestAgari({
      hand: makeTiles(['1m', '2m', '3m', '4p', '5p', '6p', '7s', '8s', '9s', '1z', '1z', '5m', '6m']),
      melds: [],
      kitaTiles: [],
      winningTile: { id: 'w-7m', kind: '7m', isRed: false },
      isTsumo: false,
      isDealer: false,
      dealerIndex: 0,
      roundWind: 'E',
      seatWind: 'S',
      doraIndicators: makeTiles(['9m', '9m', '9m']), // 1mドラ3
      winnerSeatIndex: 1,
      fromSeatIndex: 0,
      rules: rules4,
    });
    expect(noYaku).toBeNull();

    // ダブ東（連風牌: 2翻）+ 役牌白 + 混一色（門前3）
    const doubleWind = evaluateBestAgari({
      hand: makeTiles(['1z', '1z', '1z', '5z', '5z', '5z', '1m', '2m', '3m', '7m', '8m', '9m', '6z']),
      melds: [],
      kitaTiles: [],
      winningTile: { id: 'w-6z', kind: '6z', isRed: false },
      isTsumo: true,
      isDealer: true,
      dealerIndex: 0,
      roundWind: 'E',
      seatWind: 'E',
      doraIndicators: makeTiles(['2p']),
      winnerSeatIndex: 0,
      fromSeatIndex: null,
      rules: rules4,
    })!;
    const doubleIds = doubleWind.yaku.map((y) => y.id);
    expect(doubleIds).toContain('yakuhai_round_wind');
    expect(doubleIds).toContain('yakuhai_seat_wind');
    expect(doubleIds).toContain('yakuhai_haku');
    expect(doubleIds).toContain('honitsu');

    // 連風牌の雀頭(4符)を検証: 1z1z雀頭 + 234m 456p 678s 56s + 7sロン = 20+10+4(ダブ東雀頭)=34->40符
    const doublePair = evaluateBestAgari({
      hand: makeTiles(['2m', '3m', '4m', '4p', '5p', '6p', '6s', '7s', '8s', '5s', '6s', '1z', '1z']),
      melds: [],
      kitaTiles: [],
      winningTile: { id: 'w-7s', kind: '7s', isRed: false },
      isTsumo: true,
      isDealer: true,
      dealerIndex: 0,
      roundWind: 'E',
      seatWind: 'E',
      doraIndicators: makeTiles(['9p']),
      winnerSeatIndex: 0,
      fromSeatIndex: null,
      rules: rules4,
    })!;
    expect(doublePair.fu).toBe(30); // 20 + 2(ツモ) + 4(ダブ東雀頭) = 26 -> 30符 (平和にならず!)
    expect(doublePair.yaku.map((y) => y.id)).toEqual(['menzen_tsumo']);

    // 三麻で北(4z)の刻子は役牌にならない
    const r3 = deriveRules({ playerCount: 3, gameLength: 'tonpuu' });
    const north3 = evaluateBestAgari({
      hand: makeTiles(['4z', '4z', '4z', '1p', '2p', '3p', '4s', '5s', '6s', '7s', '8s', '9s', '2p']),
      melds: [],
      kitaTiles: [],
      winningTile: { id: 'w-2p', kind: '2p', isRed: false },
      isTsumo: false,
      isDealer: false,
      dealerIndex: 0,
      roundWind: 'E',
      seatWind: 'S',
      doraIndicators: makeTiles(['1s']),
      winnerSeatIndex: 1,
      fromSeatIndex: 0,
      rules: r3,
    });
    expect(north3).toBeNull();
  });

  it('三色同順・一気通貫・混全帯・純全帯・小三元・混老頭・三槓子・清一色・国士無双が成立する', () => {
    // 一気通貫 + 混全帯幺九? いや 三色同順(2) + 純全帯(3)
    const sanshokuJunchan = evaluateBestAgari({
      hand: makeTiles(['1m', '2m', '3m', '1p', '2p', '3p', '1s', '2s', '3s', '7m', '8m', '9m', '9p']),
      melds: [],
      kitaTiles: [],
      winningTile: { id: 'w-9p', kind: '9p', isRed: false },
      isTsumo: false,
      isDealer: false,
      dealerIndex: 0,
      roundWind: 'E',
      seatWind: 'S',
      doraIndicators: makeTiles(['5z']),
      winnerSeatIndex: 1,
      fromSeatIndex: 0,
      rules: rules4,
    })!;
    expect(sanshokuJunchan.yaku.map((y) => y.id).sort()).toEqual([
      'junchan',
      'sanshoku_doujun',
    ]);
    expect(sanshokuJunchan.totalHan).toBe(5);

    // 小三元 + 混老頭 + 対々和 + 役牌白・發 + 三暗刻（9pは明刻にして四暗刻単騎にしない）
    const shousangenHonrou = evaluateBestAgari({
      hand: makeTiles(['5z', '5z', '5z', '6z', '6z', '6z', '1m', '1m', '1m', '7z']),
      melds: [makeMeld('pon', ['9p', '9p', '9p'])],
      kitaTiles: [],
      winningTile: { id: 'w-7z', kind: '7z', isRed: false },
      isTsumo: true,
      isDealer: false,
      dealerIndex: 0,
      roundWind: 'E',
      seatWind: 'S',
      doraIndicators: makeTiles(['2p']),
      winnerSeatIndex: 1,
      fromSeatIndex: null,
      rules: rules4,
    })!;
    const shIds = shousangenHonrou.yaku.map((y) => y.id);
    expect(shIds).toContain('shousangen');
    expect(shIds).toContain('honroutou');
    expect(shIds).toContain('toitoi');
    expect(shIds).toContain('yakuhai_haku');
    expect(shIds).toContain('yakuhai_hatsu');
    expect(shIds).toContain('sanankou');

    // 三槓子 + 三色同刻 + 暗槓符 (+32)
    const sankantsu = evaluateBestAgari({
      hand: makeTiles(['4p', '5p', '6p', '2s']),
      melds: [
        makeMeld('ankan', ['9m', '9m', '9m', '9m'], null),
        makeMeld('daiminkan', ['9p', '9p', '9p', '9p'], 2),
        makeMeld('kakan', ['9s', '9s', '9s', '9s'], 3),
      ],
      kitaTiles: [],
      winningTile: { id: 'w-2s', kind: '2s', isRed: false },
      isTsumo: false,
      isDealer: false,
      dealerIndex: 0,
      roundWind: 'E',
      seatWind: 'S',
      doraIndicators: makeTiles(['1z']),
      winnerSeatIndex: 1,
      fromSeatIndex: 0,
      rules: rules4,
    })!;
    expect(sankantsu.yaku.map((y) => y.id).sort()).toEqual([
      'sankantsu',
      'sanshoku_doukou',
    ]);
    // 20 + 32(9m暗槓) + 16(9p明槓) + 16(9s加槓) + 2(単騎) = 86 -> 90符
    expect(sankantsu.fu).toBe(90);

    // 国士無双単面待ち（ドラが乗っても数えではなく役満13）
    const kokushi = evaluateBestAgari({
      hand: makeTiles(['1m', '9m', '1p', '9p', '1s', '9s', '1z', '2z', '3z', '4z', '5z', '6z', '6z']),
      melds: [],
      kitaTiles: [],
      winningTile: { id: 'w-7z', kind: '7z', isRed: false },
      isTsumo: false,
      isDealer: false,
      dealerIndex: 0,
      roundWind: 'E',
      seatWind: 'S',
      doraIndicators: makeTiles(['9m', '9p', '9s']),
      winnerSeatIndex: 1,
      fromSeatIndex: 0,
      rules: rules4,
    })!;
    expect(kokushi.isYakuman).toBe(true);
    expect(kokushi.scoreLabel).toBe('役満');
    expect(kokushi.pointsAwarded).toBe(32000);
    expect(kokushi.doraCount).toBe(0);
  });

  it('喰いタン設定 (allowKuitan) と 後付け設定 (allowAtozuke) の切り替えが反映される', () => {
    const openTanyaoHand = makeTiles(['3p', '4p', '5p', '5s', '6s', '7s', '4m', '4m', '6p', '7p']);
    const melds = [makeMeld('chi', ['2m', '3m', '4m'])];
    const win5p: Tile = { id: 'w-5p', kind: '5p', isRed: false };

    const kuitanOn = deriveRules({
      playerCount: 4,
      gameLength: 'tonpuu',
      allowKuitan: true,
    });
    const kuitanOff = deriveRules({
      playerCount: 4,
      gameLength: 'tonpuu',
      allowKuitan: false,
    });

    expect(
      evaluateBestAgari({
        hand: openTanyaoHand,
        melds,
        kitaTiles: [],
        winningTile: win5p,
        isTsumo: false,
        isDealer: false,
        dealerIndex: 0,
        roundWind: 'E',
        seatWind: 'S',
        doraIndicators: makeTiles(['1z']),
        winnerSeatIndex: 1,
        fromSeatIndex: 0,
        rules: kuitanOn,
      })?.yaku.map((y) => y.id),
    ).toEqual(['tanyao']);

    expect(
      evaluateBestAgari({
        hand: openTanyaoHand,
        melds,
        kitaTiles: [],
        winningTile: win5p,
        isTsumo: false,
        isDealer: false,
        dealerIndex: 0,
        roundWind: 'E',
        seatWind: 'S',
        doraIndicators: makeTiles(['1z']),
        winnerSeatIndex: 1,
        fromSeatIndex: 0,
        rules: kuitanOff,
      }),
    ).toBeNull();

    // 後付けあり vs 後付けなし:
    // 123m(チー) + 789s(チー) + 2p2p + 5z5z (シャンポン待ち: 5zなら白で役あり、2pなら役なし)
    const kataagariHand = makeTiles(['2p', '2p', '5z', '5z']);
    const kataagariMelds = [
      makeMeld('chi', ['1m', '2m', '3m']),
      makeMeld('chi', ['7s', '8s', '9s']),
      makeMeld('pon', ['8p', '8p', '8p']),
    ];
    const win5z: Tile = { id: 'w-5z', kind: '5z', isRed: false };

    const atozukeOn = deriveRules({
      playerCount: 4,
      gameLength: 'tonpuu',
      allowAtozuke: true,
    });
    const atozukeOff = deriveRules({
      playerCount: 4,
      gameLength: 'tonpuu',
      allowAtozuke: false,
    });

    expect(
      evaluateBestAgari({
        hand: kataagariHand,
        melds: kataagariMelds,
        kitaTiles: [],
        winningTile: win5z,
        isTsumo: false,
        isDealer: false,
        dealerIndex: 0,
        roundWind: 'E',
        seatWind: 'S',
        doraIndicators: makeTiles(['1z']),
        winnerSeatIndex: 1,
        fromSeatIndex: 0,
        rules: atozukeOn,
      })?.yaku.map((y) => y.id),
    ).toEqual(['yakuhai_haku']);

    expect(
      evaluateBestAgari({
        hand: kataagariHand,
        melds: kataagariMelds,
        kitaTiles: [],
        winningTile: win5z,
        isTsumo: false,
        isDealer: false,
        dealerIndex: 0,
        roundWind: 'E',
        seatWind: 'S',
        doraIndicators: makeTiles(['1z']),
        winnerSeatIndex: 1,
        fromSeatIndex: 0,
        rules: atozukeOff,
      }),
    ).toBeNull();
  });
});
