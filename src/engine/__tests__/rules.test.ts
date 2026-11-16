import { describe, expect, it } from 'vitest';
import { deriveRules, getRoundMetadata, getSeatWind } from '../rules';
import { TILE_SETS, type RuleConfig, type TileSetId, type TileSetSpec } from '../../types/rule';

describe('deriveRules (RuleConfig)', () => {
  const cases: Array<{
    label: string;
    config: RuleConfig;
    expectedTotalTiles: number;
    expectedInitialPoints: number;
    expectedSeatWinds: readonly string[];
    expectedTotalRounds: number;
    expectedRoundLabels: string[];
    expectedAllowChi: boolean;
    expectedAllowKita: boolean;
  }> = [
    {
      label: '4人・東風戦',
      config: { playerCount: 4, gameLength: 'tonpuu' },
      expectedTotalTiles: 136,
      expectedInitialPoints: 25000,
      expectedSeatWinds: ['E', 'S', 'W', 'N'],
      expectedTotalRounds: 4,
      expectedRoundLabels: ['E1', 'E2', 'E3', 'E4'],
      expectedAllowChi: true,
      expectedAllowKita: false,
    },
    {
      label: '4人・半荘戦',
      config: { playerCount: 4, gameLength: 'hanchan' },
      expectedTotalTiles: 136,
      expectedInitialPoints: 25000,
      expectedSeatWinds: ['E', 'S', 'W', 'N'],
      expectedTotalRounds: 8,
      expectedRoundLabels: ['E1', 'E2', 'E3', 'E4', 'S1', 'S2', 'S3', 'S4'],
      expectedAllowChi: true,
      expectedAllowKita: false,
    },
    {
      label: '3人・東風戦',
      config: { playerCount: 3, gameLength: 'tonpuu' },
      expectedTotalTiles: 108,
      expectedInitialPoints: 35000,
      expectedSeatWinds: ['E', 'S', 'W'],
      expectedTotalRounds: 3,
      expectedRoundLabels: ['E1', 'E2', 'E3'],
      expectedAllowChi: false,
      expectedAllowKita: true,
    },
    {
      label: '3人・半荘戦',
      config: { playerCount: 3, gameLength: 'hanchan' },
      expectedTotalTiles: 108,
      expectedInitialPoints: 35000,
      expectedSeatWinds: ['E', 'S', 'W'],
      expectedTotalRounds: 6,
      expectedRoundLabels: ['E1', 'E2', 'E3', 'S1', 'S2', 'S3'],
      expectedAllowChi: false,
      expectedAllowKita: true,
    },
  ];

  it.each(cases)(
    '$label のルール値をすべて RuleConfig から導出できる',
    ({
      config,
      expectedTotalTiles,
      expectedInitialPoints,
      expectedSeatWinds,
      expectedTotalRounds,
      expectedRoundLabels,
      expectedAllowChi,
      expectedAllowKita,
    }) => {
      const rules = deriveRules(config);
      expect(rules.totalTiles).toBe(expectedTotalTiles);
      expect(rules.initialPoints).toBe(expectedInitialPoints);
      expect(rules.seatWinds).toEqual(expectedSeatWinds);
      expect(rules.totalRounds).toBe(expectedTotalRounds);
      expect(rules.allowChi).toBe(expectedAllowChi);
      expect(rules.allowKita).toBe(expectedAllowKita);
      expect(rules.doubleRon).toBe(true);
      expect(rules.forbidKuikae).toBe(true);
      expect(rules.responseTimeoutMs).toBe(15000);
      expect(rules.maxKansPerRound).toBe(4);
      expect(rules.kandoraTiming).toEqual({
        ankan: 'immediate',
        daiminkan: 'after_discard',
        kakan: 'after_discard',
      });

      const roundLabels: string[] = [];
      for (let i = 0; i < rules.totalRounds; i++) {
        const meta = getRoundMetadata(i, 0, rules);
        roundLabels.push(`${meta.roundWind}${meta.kyokuNumber}`);
        expect(meta.dealerIndex).toBe(i % config.playerCount);
      }
      expect(roundLabels).toEqual(expectedRoundLabels);
    },
  );

  it('席風が親の移動に合わせて人数通りに回転する', () => {
    expect(
      [0, 1, 2].map((seat) => getSeatWind(seat, 1, ['E', 'S', 'W'])),
    ).toEqual(['W', 'E', 'S']);

    expect(
      [0, 1, 2, 3].map((seat) => getSeatWind(seat, 2, ['E', 'S', 'W', 'N'])),
    ).toEqual(['W', 'N', 'E', 'S']);
  });

  it('三麻の牌構成定数を差し替えられる', () => {
    const customTileSets: Record<TileSetId, TileSetSpec> = {
      ...TILE_SETS,
      sanma_no_2m_to_8m_108: {
        id: 'sanma_no_2m_to_8m_108',
        copiesPerKind: 4,
        excludedKinds: ['1m', '2m', '3m', '4m', '5m', '6m', '7m', '8m', '9m'],
      },
    };
    const rules = deriveRules(
      { playerCount: 3, gameLength: 'tonpuu' },
      customTileSets,
    );
    expect(rules.totalTiles).toBe(100);
  });

  it('第3A段階ローカルルール設定（トビ・ツモ損・喰いタン・後付け）が既定値と上書きに従う', () => {
    const def4 = deriveRules({ playerCount: 4, gameLength: 'tonpuu' });
    expect(def4.tobi).toBe(true);
    expect(def4.tsumoLoss).toBe(false);
    expect(def4.allowKuitan).toBe(true);
    expect(def4.allowAtozuke).toBe(true);

    // 4人麻雀では tsumoLoss: true を渡しても false に正規化される
    const override4 = deriveRules({
      playerCount: 4,
      gameLength: 'hanchan',
      tobi: false,
      tsumoLoss: true,
      allowKuitan: false,
      allowAtozuke: false,
    });
    expect(override4.tobi).toBe(false);
    expect(override4.tsumoLoss).toBe(false);
    expect(override4.allowKuitan).toBe(false);
    expect(override4.allowAtozuke).toBe(false);

    // 3人麻雀では tsumoLoss が有効になる
    const override3 = deriveRules({
      playerCount: 3,
      gameLength: 'tonpuu',
      tsumoLoss: true,
    });
    expect(override3.tsumoLoss).toBe(true);
  });
});
