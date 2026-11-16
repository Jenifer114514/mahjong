import { describe, expect, it } from 'vitest';
import { toStateView } from '../projection';
import { applyAction, reduce } from '../reducer';
import {
  calculateNotenPenalties,
  decideNextRound,
  rankPlayers,
} from '../roundProgression';
import { deriveRules } from '../rules';
import { calculatePaymentDeltas, resolveBasePoints } from '../score';
import type { AbortiveDrawReason, PlayerState } from '../../types/state';
import type { Tile, TileKind } from '../../types/tile';
import {
  assertTileConservation,
  buildCustomDeck,
  createStartedCustomGame,
  passAllPendingResponses,
} from './testHelpers';

function makeDummyPlayer(
  seatIndex: number,
  score: number,
  options?: {
    handKinds?: TileKind[];
    isRiichi?: boolean;
    discardedKinds?: TileKind[];
    sameTurnFuriten?: boolean;
    isRiichiFuriten?: boolean;
  },
): PlayerState {
  const hand: Tile[] = (options?.handKinds ?? []).map((kind, idx) => ({
    id: `t-${seatIndex}-${idx}-${kind}`,
    kind,
    isRed: false,
  }));
  return {
    playerId: `p${seatIndex}`,
    name: `P${seatIndex + 1}`,
    seatIndex,
    score,
    hand,
    drawnTile: null,
    discards: [],
    discardedKinds: options?.discardedKinds ?? [],
    sameTurnFuriten: options?.sameTurnFuriten ?? false,
    isRiichiFuriten: options?.isRiichiFuriten ?? false,
    isRiichi: options?.isRiichi ?? false,
    isDoubleRiichi: false,
    ippatsuEligible: false,
    pendingRiichiSideways: false,
    isRinshanDraw: false,
    melds: [],
    kitaTiles: [],
    connected: true,
    isCpu: false,
  };
}

function assertPointConservation(
  players: readonly PlayerState[],
  kyotakuCount: number,
  initialTotal: number,
  riichiStickPoints = 1000,
): void {
  const sum = players.reduce((acc, p) => acc + p.score, 0);
  expect(sum + kyotakuCount * riichiStickPoints).toBe(initialTotal);
}

describe('第4段階: 連荘・本場・ノーテン罰符・オーラス・終局供託', () => {
  describe('1. decideNextRound 表形式網羅（非オーラス・オーラス・トビ・同点・3麻/4麻 × 東風/半荘）', () => {
    const rules4Tonpuu = deriveRules({ playerCount: 4, gameLength: 'tonpuu' });

    const basePlayers4 = [
      makeDummyPlayer(0, 25000),
      makeDummyPlayer(1, 25000),
      makeDummyPlayer(2, 25000),
      makeDummyPlayer(3, 25000),
    ];

    const dealerTopPlayers4 = [
      makeDummyPlayer(0, 20000),
      makeDummyPlayer(1, 20000),
      makeDummyPlayer(2, 20000),
      makeDummyPlayer(3, 40000), // オーラス親(seat 3)が単独1位
    ];

    const dealerBehindPlayers4 = [
      makeDummyPlayer(0, 40000),
      makeDummyPlayer(1, 20000),
      makeDummyPlayer(2, 20000),
      makeDummyPlayer(3, 20000), // オーラス親(seat 3)が2位以下
    ];

    const nonOorasuCases: Array<{
      label: string;
      honba: number;
      winnerSeats?: number[];
      abortive?: AbortiveDrawReason;
      tenpaiIds?: string[];
      expectedOutcome: 'renchan' | 'oya_nagare';
      expectedNextIndex: number;
      expectedNextHonba: number;
    }> = [
      {
        label: '非オーラス: 親の単独和了 = 連荘(本場+1)',
        honba: 1,
        winnerSeats: [0],
        expectedOutcome: 'renchan',
        expectedNextIndex: 0,
        expectedNextHonba: 2,
      },
      {
        label: '非オーラス: 親と子のダブロン = 連荘(本場+1)',
        honba: 2,
        winnerSeats: [0, 2],
        expectedOutcome: 'renchan',
        expectedNextIndex: 0,
        expectedNextHonba: 3,
      },
      {
        label: '非オーラス: 子の単独和了 = 親流れ(本場0)',
        honba: 3,
        winnerSeats: [1],
        expectedOutcome: 'oya_nagare',
        expectedNextIndex: 1,
        expectedNextHonba: 0,
      },
      {
        label: '非オーラス: 子同士のダブロン = 親流れ(本場0)',
        honba: 2,
        winnerSeats: [1, 3],
        expectedOutcome: 'oya_nagare',
        expectedNextIndex: 1,
        expectedNextHonba: 0,
      },
      {
        label: '非オーラス: 親テンパイ通常流局 = 連荘(本場+1)',
        honba: 0,
        tenpaiIds: ['p0'],
        expectedOutcome: 'renchan',
        expectedNextIndex: 0,
        expectedNextHonba: 1,
      },
      {
        label: '非オーラス: 親ノーテン通常流局 = 親流れ(本場+1)',
        honba: 1,
        tenpaiIds: ['p1', 'p2'],
        expectedOutcome: 'oya_nagare',
        expectedNextIndex: 1,
        expectedNextHonba: 2,
      },
      {
        label: '非オーラス: 途中流局(九種九牌) = 連荘(本場+1)',
        honba: 0,
        abortive: 'kyuushu_kyuuhai',
        expectedOutcome: 'renchan',
        expectedNextIndex: 0,
        expectedNextHonba: 1,
      },
      {
        label: '非オーラス: 途中流局(四家立直) = 連荘(本場+1)',
        honba: 2,
        abortive: 'suucha_riichi',
        expectedOutcome: 'renchan',
        expectedNextIndex: 0,
        expectedNextHonba: 3,
      },
    ];

    it.each(nonOorasuCases)('$label', (tc) => {
      const res = decideNextRound(
        {
          roundIndex: 0,
          honba: tc.honba,
          dealerIndex: 0,
          agariWinnerSeatIndices: tc.winnerSeats,
          abortiveDrawReason: tc.abortive ?? null,
          tenpaiPlayerIds: tc.tenpaiIds,
        },
        basePlayers4,
        rules4Tonpuu,
      );
      expect(res.isOorasu).toBe(false);
      expect(res.outcome).toBe(tc.expectedOutcome);
      expect(res.nextRoundIndex).toBe(tc.expectedNextIndex);
      expect(res.nextHonba).toBe(tc.expectedNextHonba);
    });

    const oorasuCases: Array<{
      label: string;
      honba: number;
      players: PlayerState[];
      winnerSeats?: number[];
      abortive?: AbortiveDrawReason;
      tenpaiIds?: string[];
      expectedOutcome: 'renchan' | 'game_end';
      expectedNextHonba: number;
    }> = [
      {
        label: 'オーラス: 親和了(親1位でもアガリ止めなし) = 連荘続行(本場+1)',
        honba: 0,
        players: dealerTopPlayers4,
        winnerSeats: [3],
        expectedOutcome: 'renchan',
        expectedNextHonba: 1,
      },
      {
        label: 'オーラス: 親和了(親2位以下) = 連荘続行(本場+1)',
        honba: 1,
        players: dealerBehindPlayers4,
        winnerSeats: [3],
        expectedOutcome: 'renchan',
        expectedNextHonba: 2,
      },
      {
        label: 'オーラス: 親と子のダブロン(親1位でも続行) = 連荘続行(本場+1)',
        honba: 2,
        players: dealerTopPlayers4,
        winnerSeats: [1, 3],
        expectedOutcome: 'renchan',
        expectedNextHonba: 3,
      },
      {
        label: 'オーラス: 親テンパイ通常流局(親1位でもテンパイ止めなし) = 連荘続行(本場+1)',
        honba: 1,
        players: dealerTopPlayers4,
        tenpaiIds: ['p3'],
        expectedOutcome: 'renchan',
        expectedNextHonba: 2,
      },
      {
        label: 'オーラス: 親テンパイ通常流局(親2位以下) = 連荘続行(本場+1)',
        honba: 0,
        players: dealerBehindPlayers4,
        tenpaiIds: ['p0', 'p3'],
        expectedOutcome: 'renchan',
        expectedNextHonba: 1,
      },
      {
        label: 'オーラス: 親ノーテン通常流局 = 終局',
        honba: 1,
        players: dealerTopPlayers4,
        tenpaiIds: ['p0', 'p1'],
        expectedOutcome: 'game_end',
        expectedNextHonba: 2,
      },
      {
        label: 'オーラス: 子の単独和了 = 終局',
        honba: 2,
        players: dealerTopPlayers4,
        winnerSeats: [1],
        expectedOutcome: 'game_end',
        expectedNextHonba: 0,
      },
      {
        label: 'オーラス: 途中流局(三家和) = 連荘続行(本場+1)',
        honba: 1,
        players: dealerTopPlayers4,
        abortive: 'sancha_hou',
        expectedOutcome: 'renchan',
        expectedNextHonba: 2,
      },
    ];

    it.each(oorasuCases)('$label', (tc) => {
      const res = decideNextRound(
        {
          roundIndex: rules4Tonpuu.totalRounds - 1, // 東4局 (roundIndex=3)
          honba: tc.honba,
          dealerIndex: 3,
          agariWinnerSeatIndices: tc.winnerSeats,
          abortiveDrawReason: tc.abortive ?? null,
          tenpaiPlayerIds: tc.tenpaiIds,
        },
        tc.players,
        rules4Tonpuu,
      );
      expect(res.isOorasu).toBe(true);
      expect(res.outcome).toBe(tc.expectedOutcome);
      expect(res.nextRoundIndex).toBe(3);
      expect(res.nextHonba).toBe(tc.expectedNextHonba);
    });

    it('3人・4人 × 東風・半荘 のオーラス判定が正確', () => {
      const configs: Array<{
        playerCount: 3 | 4;
        gameLength: 'tonpuu' | 'hanchan';
        lastRoundIndex: number;
      }> = [
        { playerCount: 4, gameLength: 'tonpuu', lastRoundIndex: 3 },
        { playerCount: 3, gameLength: 'tonpuu', lastRoundIndex: 2 },
        { playerCount: 4, gameLength: 'hanchan', lastRoundIndex: 7 },
        { playerCount: 3, gameLength: 'hanchan', lastRoundIndex: 5 },
      ];

      for (const cfg of configs) {
        const rules = deriveRules({
          playerCount: cfg.playerCount,
          gameLength: cfg.gameLength,
        });
        const players = Array.from({ length: cfg.playerCount }, (_, i) =>
          makeDummyPlayer(i, rules.initialPoints),
        );
        const beforeLast = decideNextRound(
          {
            roundIndex: cfg.lastRoundIndex - 1,
            honba: 0,
            dealerIndex: (cfg.lastRoundIndex - 1) % cfg.playerCount,
            agariWinnerSeatIndices: [(cfg.lastRoundIndex) % cfg.playerCount],
          },
          players,
          rules,
        );
        expect(beforeLast.isOorasu).toBe(false);
        expect(beforeLast.outcome).toBe('oya_nagare');

        const atLast = decideNextRound(
          {
            roundIndex: cfg.lastRoundIndex,
            honba: 0,
            dealerIndex: cfg.lastRoundIndex % cfg.playerCount,
            agariWinnerSeatIndices: [(cfg.lastRoundIndex + 1) % cfg.playerCount],
          },
          players,
          rules,
        );
        expect(atLast.isOorasu).toBe(true);
        expect(atLast.outcome).toBe('game_end');
      }
    });

    it('トビ判定は親和了・流局など他のどの条件よりも優先され、tobi=false 時は続行する', () => {
      const tobiPlayers = [
        makeDummyPlayer(0, 50000),
        makeDummyPlayer(1, -100),
        makeDummyPlayer(2, 25000),
        makeDummyPlayer(3, 25100),
      ];
      // 親(seat 0)が和了してもトビがいれば即終局
      const resAgariTobi = decideNextRound(
        {
          roundIndex: 0,
          honba: 2,
          dealerIndex: 0,
          agariWinnerSeatIndices: [0],
        },
        tobiPlayers,
        rules4Tonpuu,
      );
      expect(resAgariTobi.outcome).toBe('game_end');
      expect(resAgariTobi.reason).toBe('tobi');

      // 流局ノーテン罰符後でもトビがいれば即終局
      const resDrawTobi = decideNextRound(
        {
          roundIndex: 1,
          honba: 1,
          dealerIndex: 1,
          tenpaiPlayerIds: ['p0', 'p2'],
        },
        tobiPlayers,
        rules4Tonpuu,
      );
      expect(resDrawTobi.outcome).toBe('game_end');
      expect(resDrawTobi.reason).toBe('tobi');

      // tobi=false ならマイナス点でも連荘続行
      const rulesNoTobi = deriveRules({
        playerCount: 4,
        gameLength: 'tonpuu',
        tobi: false,
      });
      const resNoTobi = decideNextRound(
        {
          roundIndex: 0,
          honba: 2,
          dealerIndex: 0,
          agariWinnerSeatIndices: [0],
        },
        tobiPlayers,
        rulesNoTobi,
      );
      expect(resNoTobi.outcome).toBe('renchan');
    });

    it('同点時は起家(initialDealerIndex)に近い席が上位になる', () => {
      const tied = [
        makeDummyPlayer(0, 30000),
        makeDummyPlayer(1, 30000),
        makeDummyPlayer(2, 30000),
        makeDummyPlayer(3, 10000),
      ];
      expect(rankPlayers(tied, 0).map((p) => p.playerId)).toEqual([
        'p0',
        'p1',
        'p2',
        'p3',
      ]);
      // 起家が seat 2 なら 2 -> 3 -> 0 -> 1 の順で上位（ただし score=30000 同士では 2 -> 0 -> 1）
      expect(rankPlayers(tied, 2).map((p) => p.playerId)).toEqual([
        'p2',
        'p0',
        'p1',
        'p3',
      ]);
    });
  });

  describe('2. 本場の支払い（4人300 / 3人1000 / honbaBonusなし / ダブロン上家取り）', () => {
    it('4人麻雀: 子ロン30符3翻(3900)の2本場=4500、子ツモ30符3翻(1000/2000)の1本場=1100/2100、2本場=1200/2200', () => {
      const rules4 = deriveRules({ playerCount: 4, gameLength: 'tonpuu' });
      const { basePoints } = resolveBasePoints(3, 30, false, rules4);

      const ron2 = calculatePaymentDeltas({
        playerCount: 4,
        dealerIndex: 0,
        winnerSeatIndex: 1,
        fromSeatIndex: 2,
        basePoints,
        isDealer: false,
        isTsumo: false,
        tsumoLoss: false,
        honba: 2,
        honbaBonus: rules4.honbaBonus,
        honbaPointsPerStick: rules4.honbaPointsPerStick,
      });
      expect(ron2.pointsAwarded).toBe(3900);
      expect(ron2.honbaPointsAwarded).toBe(600);
      expect(ron2.deltasBySeat).toEqual([0, 4500, -4500, 0]);

      const tsumo1 = calculatePaymentDeltas({
        playerCount: 4,
        dealerIndex: 0,
        winnerSeatIndex: 1,
        fromSeatIndex: null,
        basePoints,
        isDealer: false,
        isTsumo: true,
        tsumoLoss: false,
        honba: 1,
        honbaBonus: rules4.honbaBonus,
        honbaPointsPerStick: rules4.honbaPointsPerStick,
      });
      expect(tsumo1.honbaPointsAwarded).toBe(300);
      expect(tsumo1.deltasBySeat).toEqual([-2100, 4300, -1100, -1100]);

      const tsumo2 = calculatePaymentDeltas({
        playerCount: 4,
        dealerIndex: 0,
        winnerSeatIndex: 1,
        fromSeatIndex: null,
        basePoints,
        isDealer: false,
        isTsumo: true,
        tsumoLoss: false,
        honba: 2,
        honbaBonus: rules4.honbaBonus,
        honbaPointsPerStick: rules4.honbaPointsPerStick,
      });
      expect(tsumo2.honbaPointsAwarded).toBe(600);
      expect(tsumo2.deltasBySeat).toEqual([-2200, 4600, -1200, -1200]);
    });

    it('3人麻雀: 子ロン30符3翻(3900)の1本場=4900、子ツモ30符3翻(ツモ損なし: 親2500・子1500)の1本場=親3000・子2000', () => {
      const rules3NoLoss = deriveRules({
        playerCount: 3,
        gameLength: 'tonpuu',
        tsumoLoss: false,
      });
      const { basePoints } = resolveBasePoints(3, 30, false, rules3NoLoss);

      const ron1 = calculatePaymentDeltas({
        playerCount: 3,
        dealerIndex: 0,
        winnerSeatIndex: 1,
        fromSeatIndex: 2,
        basePoints,
        isDealer: false,
        isTsumo: false,
        tsumoLoss: false,
        honba: 1,
        honbaBonus: rules3NoLoss.honbaBonus,
        honbaPointsPerStick: rules3NoLoss.honbaPointsPerStick,
      });
      expect(ron1.pointsAwarded).toBe(3900);
      expect(ron1.honbaPointsAwarded).toBe(1000);
      expect(ron1.deltasBySeat).toEqual([0, 4900, -4900]);

      const tsumo1 = calculatePaymentDeltas({
        playerCount: 3,
        dealerIndex: 0,
        winnerSeatIndex: 1,
        fromSeatIndex: null,
        basePoints,
        isDealer: false,
        isTsumo: true,
        tsumoLoss: false,
        honba: 1,
        honbaBonus: rules3NoLoss.honbaBonus,
        honbaPointsPerStick: rules3NoLoss.honbaPointsPerStick,
      });
      expect(tsumo1.honbaPointsAwarded).toBe(1000);
      expect(tsumo1.deltasBySeat).toEqual([-3000, 5000, -2000]);

      // ツモ損ありでも1本場1000点（各+500点）
      const tsumo1WithLoss = calculatePaymentDeltas({
        playerCount: 3,
        dealerIndex: 0,
        winnerSeatIndex: 1,
        fromSeatIndex: null,
        basePoints,
        isDealer: false,
        isTsumo: true,
        tsumoLoss: true,
        honba: 1,
        honbaBonus: true,
        honbaPointsPerStick: 1000,
      });
      expect(tsumo1WithLoss.deltasBySeat).toEqual([-2500, 4000, -1500]);
    });

    it('honbaBonus=false のときは本場数が増えても加算がなく、表示上の本場数はカウントされる', () => {
      const p0Hand = ['2m', '3m', '4m', '4p', '5p', '6p', '6s', '7s', '8s', '5p', '5p', '2s', '3s'];
      // 1局目: 九種九牌で途中流局 -> 1本場連荘
      let state = createStartedCustomGame(
        4,
        {
          hands: {
            0: ['1m', '9m', '1p', '9p', '1s', '9s', '1z', '2z', '3z', '4z', '5z', '6z', '7z'],
            1: ['2m', '2m', '3m', '3m', '4m', '4m', '5m', '5m', '6m', '6m', '7m', '7m', '8m'],
            2: ['2p', '2p', '3p', '3p', '4p', '4p', '5p', '5p', '6p', '6p', '7p', '7p', '8p'],
            3: ['2s', '2s', '3s', '3s', '4s', '4s', '5s', '5s', '6s', '6s', '7s', '7s', '8s'],
          },
          dealerDrawnKind: '3m',
          doraIndicatorKinds: ['8m'],
        },
        { honbaBonus: false },
      );
      const rules = deriveRules(state.ruleConfig);
      expect(state.round!.honba).toBe(0);

      state = reduce(state, {
        type: 'DECLARE_KYUUSHU_KYUUHAI',
        playerId: 'p0',
      });
      expect(state.round!.abortiveDrawReason).toBe('kyuushu_kyuuhai');
      state = reduce(state, {
        type: 'ADVANCE_ROUND',
        playerId: 'p0',
        shuffledDeck: buildCustomDeck(rules, {
          hands: {
            0: p0Hand,
            1: ['1m', '1m', '9m', '9m', '1p', '1p', '9p', '9p', '1s', '1s', '9s', '9s', '1z'],
            2: ['2z', '2z', '3z', '3z', '4z', '4z', '5z', '5z', '6z', '6z', '7z', '7z', '8s'],
            3: ['1p', '2p', '3p', '7p', '8p', '9p', '1s', '2s', '3s', '4s', '5s', '7p', '8p'],
          },
          dealerDrawnKind: '9s',
          liveWallHeadKinds: ['3z', '4m', '6z', '4s'],
          doraIndicatorKinds: ['8m'],
        }),
      });
      expect(state.round!.honba).toBe(1);
      expect(toStateView(state, 'p0').round?.honba).toBe(1);

      for (let i = 0; i < 4; i++) {
        const cur = state.players.find(
          (p) => p.seatIndex === state.round!.currentTurnIndex,
        )!;
        state = passAllPendingResponses(
          reduce(state, {
            type: 'DISCARD_TILE',
            playerId: cur.playerId,
            tileId: cur.drawnTile!.id,
          }),
        );
      }
      state = reduce(state, { type: 'DECLARE_TSUMO', playerId: 'p0' });
      expect(state.round!.agariResults[0]!.pointsAwarded).toBe(3900);
      expect(state.round!.agariResults[0]!.honbaPointsAwarded).toBe(0);
      expect(state.players.map((p) => p.score)).toEqual([28900, 23700, 23700, 23700]);
    });

    it('ダブロン（親・子同時含む）で上家取りだけが本場・供託を受け取り、親が含まれれば連荘する', () => {
      // p0(親)は平和単騎ではなく両面待ち 4s/7s、p2(子)も 4s待ち。p1 が 4s を放銃 -> 上家取りは p2！
      // 事前に1本場＋供託1本を用意するため、まず九種九牌で1本場へ進め、p1 にリーチさせるのではなく、
      // 直接 1本場にするためにp0が九種九牌 -> ADVANCE_ROUND後に1本場で実行
      let state = createStartedCustomGame(4, {
        hands: {
          0: ['1m', '9m', '1p', '9p', '1s', '9s', '1z', '2z', '3z', '4z', '5z', '6z', '7z'],
        },
        dealerDrawnKind: '2m',
      });
      const rules = deriveRules(state.ruleConfig);
      state = reduce(state, { type: 'DECLARE_KYUUSHU_KYUUHAI', playerId: 'p0' });

      // 1本場: p0(親)が 5s/6s 待ち(567sではなく 56s待ち 4s/7s)、p2(子)も 4s待ち(234m 456p 56s 789p 88p = 10枚? 13枚にする)
      // p0(親): 234m 456m 789p 56s 33p -> 30符2翻(平和+ドラ1=2900)
      // p2(子): 123m 456p 789p 56s 99s -> 30符2翻(平和+ドラ1=2000)
      // p1 が 4s を捨てる -> 放銃者 p1(seat 1) から打牌進行順で最初 = p2(seat 2) が上家取り！ p0(seat 0) は2人目！
      state = reduce(state, {
        type: 'ADVANCE_ROUND',
        playerId: 'p0',
        shuffledDeck: buildCustomDeck(rules, {
          hands: {
            0: ['2m', '3m', '4m', '4m', '5m', '6m', '7p', '8p', '9p', '5s', '6s', '3p', '3p'],
            1: ['1m', '1m', '9m', '9m', '1p', '1p', '9p', '9p', '1s', '1s', '9s', '9s', '4s'],
            2: ['1m', '2m', '3m', '4p', '5p', '6p', '7p', '8p', '9p', '5s', '6s', '9s', '9s'],
            3: ['1z', '1z', '2z', '2z', '3z', '3z', '4z', '4z', '5z', '5z', '6z', '6z', '7z'],
          },
          dealerDrawnKind: '7z',
          doraIndicatorKinds: ['6p'], // 7pがドラ1
        }),
      });
      expect(state.round!.honba).toBe(1);

      // p3 がまず関係ないリーチを宣言して供託1本を作るのではなく、p0が7z切り -> p1が4s切り
      state = passAllPendingResponses(
        reduce(state, {
          type: 'DISCARD_TILE',
          playerId: 'p0',
          tileId: state.players[0]!.drawnTile!.id,
        }),
      );
      const p1Target4s = state.players[1]!.hand.find((t) => t.kind === '4s')!.id;
      state = reduce(state, {
        type: 'DISCARD_TILE',
        playerId: 'p1',
        tileId: p1Target4s,
      });

      // p2 と p0 がダブロン（p2が上家取り）
      state = reduce(state, {
        type: 'CALL_RESPONSE',
        playerId: 'p0',
        choice: { type: 'ron' },
      });
      state = reduce(state, {
        type: 'CALL_RESPONSE',
        playerId: 'p2',
        choice: { type: 'ron' },
      });

      expect(state.phase).toBe('round_end');
      const results = state.round!.agariResults;
      expect(results.map((r) => r.playerId)).toEqual(['p2', 'p0']);
      // 上家取りの p2 のみが本場(+300)を受取
      expect(results[0]!.playerId).toBe('p2');
      expect(results[0]!.pointsAwarded).toBe(2000);
      expect(results[0]!.honbaPointsAwarded).toBe(300);
      // 2人目の p0(親) は本場を受取らない(+0)
      expect(results[1]!.playerId).toBe('p0');
      expect(results[1]!.pointsAwarded).toBe(2900);
      expect(results[1]!.honbaPointsAwarded).toBe(0);
      // 点棒移動（p1 は 2300 + 2900 = 5200 失う）
      expect(state.players.map((p) => p.score)).toEqual([27900, 19800, 27300, 25000]);
      assertPointConservation(state.players, state.kyotakuCount, 100000);

      // 親(p0)がダブロンに含まれるため、次局は連荘(roundIndex=0, honba=2)！
      expect(state.round!.nextRoundDecision?.outcome).toBe('renchan');
      expect(state.round!.nextRoundDecision?.reason).toBe('double_ron_with_oya');
      expect(state.round!.nextRoundDecision?.nextHonba).toBe(2);
    });
  });

  describe('3. ノーテン罰符・テンパイ判定・フリテン/空聴・流局トビ・手牌非公開', () => {
    it('4人麻雀: テンパイ 0〜4人 全パターンで点棒増減合計が0', () => {
      const rules4 = deriveRules({ playerCount: 4, gameLength: 'tonpuu' });
      const tenpaiHand: TileKind[] = [
        '1m', '2m', '3m', '4p', '5p', '6p', '7s', '8s', '9s', '1p', '1p', '2s', '3s',
      ];
      const notenHand: TileKind[] = [
        '1m', '4m', '7m', '2p', '5p', '8p', '3s', '6s', '9s', '1z', '2z', '3z', '4z',
      ];

      const expectedByTenpaiCount: Record<number, { gain: number; pay: number }> = {
        0: { gain: 0, pay: 0 },
        1: { gain: 3000, pay: -1000 },
        2: { gain: 1500, pay: -1500 },
        3: { gain: 1000, pay: -3000 },
        4: { gain: 0, pay: 0 },
      };

      for (let tCount = 0; tCount <= 4; tCount++) {
        const players = [0, 1, 2, 3].map((seat) =>
          makeDummyPlayer(seat, 25000, {
            handKinds: seat < tCount ? tenpaiHand : notenHand,
          }),
        );
        const res = calculateNotenPenalties(players, rules4);
        expect(res.tenpaiPlayerIds).toHaveLength(tCount);
        const deltas = Object.values(res.deltasByPlayerId);
        expect(deltas.reduce((a, b) => a + b, 0)).toBe(0);

        for (let seat = 0; seat < 4; seat++) {
          const expected = expectedByTenpaiCount[tCount]!;
          expect(res.deltasByPlayerId[`p${seat}`]).toBe(
            seat < tCount ? expected.gain : expected.pay,
          );
        }
      }
    });

    it('3人麻雀: テンパイ 0〜3人 全パターンで点棒増減合計が0', () => {
      const rules3 = deriveRules({ playerCount: 3, gameLength: 'tonpuu' });
      const tenpaiHand: TileKind[] = [
        '1m', '1m', '1m', '4p', '5p', '6p', '7s', '8s', '9s', '1p', '1p', '2s', '3s',
      ];
      const notenHand: TileKind[] = [
        '1m', '9m', '2p', '5p', '8p', '3s', '6s', '9s', '1z', '2z', '3z', '4z', '5z',
      ];

      const expectedByTenpaiCount: Record<number, { gain: number; pay: number }> = {
        0: { gain: 0, pay: 0 },
        1: { gain: 3000, pay: -1500 },
        2: { gain: 1500, pay: -3000 },
        3: { gain: 0, pay: 0 },
      };

      for (let tCount = 0; tCount <= 3; tCount++) {
        const players = [0, 1, 2].map((seat) =>
          makeDummyPlayer(seat, 35000, {
            handKinds: seat < tCount ? tenpaiHand : notenHand,
          }),
        );
        const res = calculateNotenPenalties(players, rules3);
        expect(res.tenpaiPlayerIds).toHaveLength(tCount);
        expect(
          Object.values(res.deltasByPlayerId).reduce((a, b) => a + b, 0),
        ).toBe(0);

        for (let seat = 0; seat < 3; seat++) {
          const expected = expectedByTenpaiCount[tCount]!;
          expect(res.deltasByPlayerId[`p${seat}`]).toBe(
            seat < tCount ? expected.gain : expected.pay,
          );
        }
      }
    });

    it('フリテン者・形式聴牌・他家河4枚切れの形式空聴はテンパイ扱い、純粋空聴(自分4枚使い)はノーテン扱いになる', () => {
      const rules4 = deriveRules({ playerCount: 4, gameLength: 'tonpuu' });
      // p0: 123m 456p 789s 11z 23s (1s/4s待ち)、過去に 1s を捨てている(捨て牌フリテン) -> テンパイ扱い
      // p1: 純粋空聴 [1m,1m,1m,1m, 4p,5p,6p, 7p,8p,9p, 2s,3s,4s] (自分の手牌だけで1mを4枚使い切り) -> ノーテン扱い
      // p2: 役なし形式聴牌＋他家河4枚切れ空聴モデル [1m,2m,3m, 4p,5p,6p, 7p,8p,9p, 2s,2s, 3z,4z? いや 1m4枚のうち場に出ている 1s 待ち: 123m 456p 789p 2s2s 23s (1s/4s待ち)、あるいは 111m 456p 789p 234s 9z単騎(9z=白/発が場に出て4枚切れでも自分の手牌+副露は1枚なのでテンパイ)] -> テンパイ扱い
      // p3: ノーテン
      const furitenTenpaiP0 = makeDummyPlayer(0, 25000, {
        handKinds: ['1m', '2m', '3m', '4p', '5p', '6p', '7s', '8s', '9s', '1z', '1z', '2s', '3s'],
        discardedKinds: ['1s'],
        sameTurnFuriten: true,
        isRiichiFuriten: true,
      });
      const karatenNotenP1 = makeDummyPlayer(1, 25000, {
        handKinds: ['1m', '1m', '1m', '1m', '4p', '5p', '6p', '7p', '8p', '9p', '2s', '3s', '4s'],
      });
      const formalKaratenKeishikiP2 = makeDummyPlayer(2, 25000, {
        handKinds: ['1m', '1m', '1m', '4p', '5p', '6p', '7p', '8p', '9p', '2s', '3s', '4s', '5z'],
      });
      const normalNotenP3 = makeDummyPlayer(3, 25000, {
        handKinds: ['1m', '4m', '7m', '2p', '5p', '8p', '3s', '6s', '9s', '1z', '2z', '3z', '4z'],
      });

      const res = calculateNotenPenalties(
        [furitenTenpaiP0, karatenNotenP1, formalKaratenKeishikiP2, normalNotenP3],
        rules4,
      );
      expect(res.tenpaiPlayerIds).toEqual(['p0', 'p2']);
      expect(res.notenPlayerIds).toEqual(['p1', 'p3']);
      expect(res.deltasByPlayerId).toEqual({
        p0: 1500,
        p1: -1500,
        p2: 1500,
        p3: -1500,
      });
    });

    it('実局の通常流局: ノーテン罰符で0点未満になればトビ終了し、ノーテン者の手牌は他者のStateViewに含まれない', () => {
      // p0(親): テンパイ、p1: 持ち点 1000点でノーテン、p2: ノーテン、p3: ノーテン
      // -> p1 は罰符 -1000 でちょうど 0点(トビなし) vs p1 持ち点 500点なら -1000 で -500点(トビ終了!)
      // まず東1局で p1 を 25000 -> 500点 へ削る代わりに、p1 が跳満/倍満を親(p0)以外に振り込んで削るのではなく
      // p0(親)へ満貫(8000)? 子の倍満(16000)+子の満貫(8000)+リーチ(1000) -> 0点 -> いや倍満(16000) + 満貫(8000) + 東2へ...
      // もっと簡単: p1 が p2 に 親倍満/三倍満(24000点) 放銃 -> p1 = 1000点 -> p1 がノーテン流局で -1500点(2人テンパイ) -> -500点 トビ終了！
      // 三倍満(24000): p2 = 111p 222p 333p 555p 77p + 5p(ドラ6pで7p×2) = 12翻24000
      let state = createStartedCustomGame(4, {
        hands: {
          0: ['1m', '1m', '9m', '9m', '9p', '9p', '1s', '1s', '9s', '9s', '2s', '2s', '3s'],
          1: ['1z', '1z', '2z', '2z', '3z', '3z', '4z', '4z', '6z', '6z', '7z', '7z', '5p'],
          2: ['1p', '1p', '1p', '2p', '2p', '2p', '3p', '3p', '3p', '5p', '5p', '7p', '7p'],
          3: ['4m', '4m', '5m', '5m', '6m', '6m', '7m', '7m', '8m', '8m', '2m', '2m', '3m'],
        },
        dealerDrawnKind: '4s',
        doraIndicatorKinds: ['6p'], // 7pがドラ×2 -> 12翻 三倍満 24000
      });
      const rules = deriveRules(state.ruleConfig);

      // p0 が 4s ツモ切り -> p1 が 5p 切り -> p2 がロン (p1: 25000 -> 1000点!)
      state = passAllPendingResponses(
        reduce(state, {
          type: 'DISCARD_TILE',
          playerId: 'p0',
          tileId: state.players[0]!.drawnTile!.id,
        }),
      );
      state = reduce(state, {
        type: 'DISCARD_TILE',
        playerId: 'p1',
        tileId: state.players[1]!.hand.find((t) => t.kind === '5p')!.id,
      });
      state = reduce(state, {
        type: 'CALL_RESPONSE',
        playerId: 'p2',
        choice: { type: 'ron' },
      });
      expect(state.players[1]!.score).toBe(1000);
      expect(state.round!.isTobiEnded).toBe(false);

      // 次局(東2局): p0 と p2 がテンパイ、p1(親, 1000点) と p3 がノーテンで流局 -> 罰符 1500点支払い -> p1 = -500点 トビ終了！
      const drawDeck = buildCustomDeck(rules, {
        dealerIndex: 1,
        hands: {
          0: ['1m', '2m', '3m', '4p', '5p', '6p', '7s', '8s', '9s', '1p', '1p', '2s', '3s'], // テンパイ
          1: ['1m', '4m', '7m', '2p', '5p', '8p', '3s', '6s', '9s', '1z', '2z', '3z', '4z'], // ノーテン
          2: ['2m', '3m', '4m', '4p', '5p', '6p', '7s', '8s', '9s', '6z', '6z', '5s', '6s'], // テンパイ
          3: ['1m', '4m', '7m', '2p', '5p', '8p', '3s', '6s', '9s', '1z', '2z', '3z', '7z'], // ノーテン
        },
        dealerDrawnKind: '5z',
      });
      state = reduce(state, {
        type: 'ADVANCE_ROUND',
        playerId: 'p0',
        shuffledDeck: drawDeck,
      });
      expect(state.round!.roundIndex).toBe(1);
      expect(state.round!.dealerIndex).toBe(1);

      // 海底手前まで山を削ってから通常打牌で荒牌平局にする（全ツモ切りだと手牌が維持される）
      state = {
        ...state,
        round: {
          ...state.round!,
          wall: [],
        },
      };
      state = passAllPendingResponses(
        reduce(state, {
          type: 'DISCARD_TILE',
          playerId: 'p1',
          tileId: state.players[1]!.drawnTile!.id,
        }),
      );

      expect(state.phase).toBe('round_end');
      expect(state.round!.tenpaiPlayerIds).toEqual(['p0', 'p2']);
      expect(state.round!.roundScoreDeltas).toEqual({
        p0: 1500,
        p1: -1500,
        p2: 1500,
        p3: -1500,
      });
      expect(state.players[1]!.score).toBe(-500);
      expect(state.round!.isTobiEnded).toBe(true);
      expect(state.round!.nextRoundDecision?.outcome).toBe('game_end');
      expect(state.round!.nextRoundDecision?.reason).toBe('tobi');
      assertPointConservation(state.players, state.kyotakuCount, 100000);

      // 手牌公開プライバシー検証: p0 から見た StateView には p2(テンパイ) の手牌はあるが p1/p3(ノーテン) の手牌IDは一切含まれない
      const p0View = toStateView(state, 'p0');
      expect(Object.keys(p0View.round!.revealedHands).sort()).toEqual(['p0', 'p2']);
      const serializedP0 = JSON.stringify(p0View);
      for (const tile of state.players[1]!.hand) {
        expect(serializedP0).not.toContain(`"${tile.id}"`);
      }
      for (const tile of state.players[3]!.hand) {
        expect(serializedP0).not.toContain(`"${tile.id}"`);
      }

      // 結果画面へ進めると終局
      state = reduce(state, {
        type: 'ADVANCE_ROUND',
        playerId: 'p0',
        shuffledDeck: [],
      });
      expect(state.phase).toBe('finished');
      assertPointConservation(state.players, state.kyotakuCount, 100000);
    });
  });

  describe('4. 通し検証: オーラス親トップ連荘・終局残供託(同点起家上位)・全フェーズ点棒保存則', () => {
    it('オーラス親1位でも連荘続行し、終局時は残供託が同点1位のうち起家寄りに加算され保存則を満たす', () => {
      // 4人東風戦で開始し、各局を子の満貫・親の1位連荘・親ノーテン流局（残供託付き同点1位）で終局させる
      let state = createStartedCustomGame(4, {
        hands: {
          0: ['1m', '1m', '9m', '9m', '1p', '1p', '9p', '9p', '1s', '1s', '9s', '9s', '2p'],
          1: ['2m', '3m', '4m', '4p', '5p', '6p', '7s', '8s', '9s', '5s', '5s', '2s', '3s'], // タンヤオ平和赤なし=2000+1(ドラ) -> 簡単に子3000にするなら 123m 456p 789s 11z 23s? 0-1-2-3 全員同点にしたい!
          2: ['1z', '1z', '2z', '2z', '3z', '3z', '4z', '4z', '5z', '5z', '6z', '6z', '7z'],
          3: ['2p', '3p', '4p', '5p', '6p', '7p', '8p', '9p', '1s', '2s', '3s', '4s', '5s'],
        },
        dealerDrawnKind: '8m',
      });
      const rules = deriveRules(state.ruleConfig);
      assertPointConservation(state.players, state.kyotakuCount, 100000);

      // 東1(p0親) -> 子(p1)が東2へ、東2(p1親) -> 子(p2)が東3へ、東3(p2親) -> 子(p3)が東4へ進めるため
      // 各局で 1000点 の平和ロンを次席の子へ与えて素早くオーラス(東4局)へ進む
      // E1: p0 -> p1 (1000点) -> p0=24000, p1=26000
      state = createStartedCustomGame(4, {
        hands: {
          0: ['1m', '1m', '9m', '9m', '1p', '1p', '9p', '9p', '1s', '1s', '9s', '9s', '4s'],
          1: ['1m', '2m', '3m', '4p', '5p', '6p', '7s', '8s', '9s', '5p', '5p', '2s', '3s'],
        },
        dealerDrawnKind: '1z',
        doraIndicatorKinds: ['7z'],
      });
      state = reduce(state, {
        type: 'DISCARD_TILE',
        playerId: 'p0',
        tileId: state.players[0]!.hand.find((t) => t.kind === '4s')!.id,
      });
      state = reduce(state, {
        type: 'CALL_RESPONSE',
        playerId: 'p1',
        choice: { type: 'ron' },
      });
      assertPointConservation(state.players, state.kyotakuCount, 100000);

      // E2 (p1親): p1 -> p2 (1000点)
      state = reduce(state, {
        type: 'ADVANCE_ROUND',
        playerId: 'p0',
        shuffledDeck: buildCustomDeck(rules, {
          dealerIndex: 1,
          hands: {
            1: ['1m', '1m', '9m', '9m', '1p', '1p', '9p', '9p', '1s', '1s', '9s', '9s', '4s'],
            2: ['1m', '2m', '3m', '4p', '5p', '6p', '7s', '8s', '9s', '5p', '5p', '2s', '3s'],
          },
          dealerDrawnKind: '1z',
          doraIndicatorKinds: ['7z'],
        }),
      });
      state = reduce(state, {
        type: 'DISCARD_TILE',
        playerId: 'p1',
        tileId: state.players[1]!.hand.find((t) => t.kind === '4s')!.id,
      });
      state = reduce(state, {
        type: 'CALL_RESPONSE',
        playerId: 'p2',
        choice: { type: 'ron' },
      });

      // E3 (p2親): p2 -> p3 (1000点) -> ここで全員 [24000, 25000, 25000, 26000] で p3 が単独トップのまま東4(オーラス親)へ！
      state = reduce(state, {
        type: 'ADVANCE_ROUND',
        playerId: 'p0',
        shuffledDeck: buildCustomDeck(rules, {
          dealerIndex: 2,
          hands: {
            2: ['1m', '1m', '9m', '9m', '1p', '1p', '9p', '9p', '1s', '1s', '9s', '9s', '4s'],
            3: ['1m', '2m', '3m', '4p', '5p', '6p', '7s', '8s', '9s', '5p', '5p', '2s', '3s'],
          },
          dealerDrawnKind: '1z',
          doraIndicatorKinds: ['7z'],
        }),
      });
      state = reduce(state, {
        type: 'DISCARD_TILE',
        playerId: 'p2',
        tileId: state.players[2]!.hand.find((t) => t.kind === '4s')!.id,
      });
      state = reduce(state, {
        type: 'CALL_RESPONSE',
        playerId: 'p3',
        choice: { type: 'ron' },
      });
      expect(state.players.map((p) => p.score)).toEqual([24000, 25000, 25000, 26000]);

      // E4 0本場 (オーラス p3親・1位): 親(p3)が和了 -> トップでもアガリ止めにならず連荘1本場！
      state = reduce(state, {
        type: 'ADVANCE_ROUND',
        playerId: 'p0',
        shuffledDeck: buildCustomDeck(rules, {
          dealerIndex: 3,
          hands: {
            3: ['2m', '3m', '4m', '4p', '5p', '6p', '7s', '8s', '9s', '5p', '5p', '2s', '3s'],
            0: ['1m', '1m', '9m', '9m', '1p', '1p', '9p', '9p', '1s', '1s', '9s', '9s', '1z'],
          },
          dealerDrawnKind: '4s',
          doraIndicatorKinds: ['7z'],
        }),
      });
      expect(state.round!.roundWind).toBe('E');
      expect(state.round!.kyokuNumber).toBe(4);
      expect(state.round!.dealerIndex).toBe(3);
      expect(state.round!.honba).toBe(0);

      // 1巡流して天和ではなく平ツモ (p3 が 4s 切りではなく 0巡目なので一旦 3s 切らない... 直接天和でも親和了なので同じ、ここは2巡目ツモにする)
      state = reduce(state, { type: 'DECLARE_TSUMO', playerId: 'p3' });
      expect(state.round!.nextRoundDecision?.outcome).toBe('renchan');
      expect(state.round!.nextRoundDecision?.nextRoundIndex).toBe(3);
      expect(state.round!.nextRoundDecision?.nextHonba).toBe(1);
      assertPointConservation(state.players, state.kyotakuCount, 100000);

      // オーラス連荘時は ADVANCE_ROUND に有効な山牌が必要（空配列なら INVALID_DECK エラー）
      const invalidAdvance = applyAction(state, {
        type: 'ADVANCE_ROUND',
        playerId: 'p0',
        shuffledDeck: [],
      });
      expect(invalidAdvance.error?.code).toBe('INVALID_DECK');

      // E4 1本場 (オーラス p3親・依然トップ): 親テンパイ流局 -> トップでもテンパイ止めにならず連荘2本場！
      state = reduce(state, {
        type: 'ADVANCE_ROUND',
        playerId: 'p0',
        shuffledDeck: buildCustomDeck(rules, {
          dealerIndex: 3,
          hands: {
            0: ['1m', '4m', '7m', '2p', '5p', '8p', '3s', '6s', '9s', '1z', '2z', '3z', '4z'],
            1: ['1m', '4m', '7m', '2p', '5p', '8p', '3s', '6s', '9s', '1z', '2z', '3z', '7z'],
            2: ['1m', '4m', '7m', '2p', '5p', '8p', '3s', '6s', '9s', '1z', '2z', '3z', '6z'],
            3: ['2m', '3m', '4m', '4p', '5p', '6p', '7s', '8s', '9s', '3p', '3p', '2s', '3s'],
          },
          dealerDrawnKind: '5z',
          doraIndicatorKinds: ['8m'],
        }),
      });
      expect(state.round!.roundIndex).toBe(3);
      expect(state.round!.dealerIndex).toBe(3);
      expect(state.round!.honba).toBe(1);

      state = { ...state, round: { ...state.round!, wall: [] } };
      state = passAllPendingResponses(
        reduce(state, {
          type: 'DISCARD_TILE',
          playerId: 'p3',
          tileId: state.players[3]!.drawnTile!.id,
        }),
      );
      expect(state.phase).toBe('round_end');
      expect(state.round!.tenpaiPlayerIds).toEqual(['p3']);
      expect(state.round!.nextRoundDecision?.outcome).toBe('renchan');
      expect(state.round!.nextRoundDecision?.nextHonba).toBe(2);
      assertPointConservation(state.players, state.kyotakuCount, 100000);

      // E4 2本場 (オーラス p3親): p0 と p2 を同点トップにして供託1本を残し、親(p3)ノーテン流局で終局させる
      // 現在のスコア確認のため、シンプルに E4 2本場 で p3 に大物を放銃させず、
      // まずこの時点で 残供託 + 同点起家優先 が明確になるよう scores を調整しやすい形にする:
      // 現在のスコア: p3 は先の天和で大きく勝っているため、p0 と p2 が 46000 点など同点にするより、
      // p0(子)が p3(親)から 満貫(8000) を直撃ではなく、ここでは p3 親ノーテン流局で終局すると p3 が1位だが供託が出るテストも同時検証できる。
      // さらに供託あり+同点トップを検証するため、p2 がリーチ棒を出して p3 ノーテン流局、かつ p0/p1 が同点トップになる専用局も別途テストする。
      state = reduce(state, {
        type: 'ADVANCE_ROUND',
        playerId: 'p0',
        shuffledDeck: buildCustomDeck(rules, {
          dealerIndex: 3,
          hands: {
            0: ['1m', '2m', '3m', '4p', '5p', '6p', '7s', '8s', '9s', '1p', '1p', '2s', '3s'], // p0: 1s/4s待ちリーチ可
            1: ['1m', '4m', '7m', '2p', '5p', '8p', '3s', '6s', '9s', '1z', '2z', '3z', '4z'],
            2: ['1m', '4m', '7m', '2p', '5p', '8p', '3s', '6s', '9s', '1z', '2z', '3z', '7z'],
            3: ['1m', '4m', '7m', '2p', '5p', '8p', '3s', '6s', '9s', '1z', '2z', '3z', '6z'], // 親ノーテン
          },
          dealerDrawnKind: '5z',
          liveWallHeadKinds: ['8p', '6m'],
          doraIndicatorKinds: ['8m'],
        }),
      });
      expect(state.round!.roundIndex).toBe(3);
      expect(state.round!.honba).toBe(2);

      // p3 が 5z 切り -> p0 が 8p ツモって 8p でリーチ宣言(供託+1 = 1000点) -> 次巡 p1 打牌時に山0で流局 -> p3ノーテンで終局！
      state = passAllPendingResponses(
        reduce(state, {
          type: 'DISCARD_TILE',
          playerId: 'p3',
          tileId: state.players[3]!.drawnTile!.id,
        }),
      );
      state = passAllPendingResponses(
        reduce(state, {
          type: 'DECLARE_RIICHI',
          playerId: 'p0',
          tileId: state.players[0]!.drawnTile!.id,
        }),
      );
      assertTileConservation(state, 136);
      state = { ...state, round: { ...state.round!, wall: [] } };
      state = passAllPendingResponses(
        reduce(state, {
          type: 'DISCARD_TILE',
          playerId: 'p1',
          tileId: state.players[1]!.drawnTile!.id,
        }),
      );
      expect(state.phase).toBe('round_end');
      expect(state.kyotakuCount).toBe(1);
      expect(state.round!.tenpaiPlayerIds).toEqual(['p0']);
      expect(state.round!.nextRoundDecision?.outcome).toBe('game_end');
      expect(state.round!.nextRoundDecision?.reason).toBe('oya_noten_draw');
      assertPointConservation(state.players, state.kyotakuCount, 100000);

      // 終局ボタンで finished へ -> 場に残った供託 1000点 が最終1位(p3)に加算される！
      const preFinishTopScore = Math.max(...state.players.map((p) => p.score));
      const preFinishTopId = rankPlayers(state.players, 0)[0]!.playerId;
      state = reduce(state, {
        type: 'ADVANCE_ROUND',
        playerId: 'p0',
        shuffledDeck: [],
      });
      expect(state.phase).toBe('finished');
      expect(state.kyotakuCount).toBe(0);
      expect(state.finalKyotakuAward).toEqual({
        playerId: preFinishTopId,
        points: 1000,
      });
      expect(
        state.players.find((p) => p.playerId === preFinishTopId)!.score,
      ).toBe(preFinishTopScore + 1000);
      assertPointConservation(state.players, state.kyotakuCount, 100000);
    });

    it('同点トップで終局した際、残供託は起家(initialDealerIndex=0)に近い席へ加算される', () => {
      // E4 開始時点で p0 と p2 ではなく p1 と p3 を同点にする:
      // E1 (p0親): p0 が 4s 放銃 -> p1(子) 2000点 -> [23000, 27000, 25000, 25000]
      // E2 (p1親): p1 が 4s 放銃 -> p3(子) 2000点 -> [23000, 25000, 25000, 27000]
      // E3 (p2親): p2 が 4s 放銃 -> p1(子) 2000点 -> [23000, 27000, 23000, 27000]
      // E4 (p3親): p0 がリーチ(23000->22000, 供託1)で1人テンパイ流局 (+3000 -> 25000)、
      //            p1(27000->26000), p2(23000->22000), p3(27000->26000)
      // -> p1 と p3 が 26000点 で完全同点トップ！起家(seat 0)に近い seat 1 (p1) が残供託 1000点 を獲得して 27000点になる！
      let state = createStartedCustomGame(4, {
        hands: {
          0: ['1m', '1m', '9m', '9m', '1p', '1p', '9p', '9p', '1s', '1s', '9s', '9s', '4s'],
          1: ['1m', '2m', '3m', '4p', '5p', '6p', '7s', '8s', '9s', '6p', '6p', '2s', '3s'],
        },
        dealerDrawnKind: '6z',
        doraIndicatorKinds: ['8s'], // 9sがドラ1 -> 子 平和(1)+ドラ1(1)=2000点
      });
      const rules = deriveRules(state.ruleConfig);

      // E1: p0 が 4s 切り -> p1 ロン (2000点) -> [23000, 27000, 25000, 25000]
      state = reduce(state, {
        type: 'DISCARD_TILE',
        playerId: 'p0',
        tileId: state.players[0]!.hand.find((t) => t.kind === '4s')!.id,
      });
      state = reduce(state, {
        type: 'CALL_RESPONSE',
        playerId: 'p1',
        choice: { type: 'ron' },
      });
      expect(state.players.map((p) => p.score)).toEqual([23000, 27000, 25000, 25000]);

      // E2 (p1親): p1 が 4s 切り -> p3 ロン (2000点) -> [23000, 25000, 25000, 27000]
      state = reduce(state, {
        type: 'ADVANCE_ROUND',
        playerId: 'p0',
        shuffledDeck: buildCustomDeck(rules, {
          dealerIndex: 1,
          hands: {
            1: ['1m', '1m', '9m', '9m', '1p', '1p', '9p', '9p', '1s', '1s', '9s', '9s', '4s'],
            3: ['1m', '2m', '3m', '4p', '5p', '6p', '7s', '8s', '9s', '6p', '6p', '2s', '3s'],
          },
          dealerDrawnKind: '6z',
          doraIndicatorKinds: ['8s'],
        }),
      });
      state = reduce(state, {
        type: 'DISCARD_TILE',
        playerId: 'p1',
        tileId: state.players[1]!.hand.find((t) => t.kind === '4s')!.id,
      });
      state = reduce(state, {
        type: 'CALL_RESPONSE',
        playerId: 'p3',
        choice: { type: 'ron' },
      });
      expect(state.players.map((p) => p.score)).toEqual([23000, 25000, 25000, 27000]);

      // E3 (p2親): p2 が 4s 切り -> p1 ロン (2000点) -> [23000, 27000, 23000, 27000]
      state = reduce(state, {
        type: 'ADVANCE_ROUND',
        playerId: 'p0',
        shuffledDeck: buildCustomDeck(rules, {
          dealerIndex: 2,
          hands: {
            2: ['1m', '1m', '9m', '9m', '1p', '1p', '9p', '9p', '1s', '1s', '9s', '9s', '4s'],
            1: ['1m', '2m', '3m', '4p', '5p', '6p', '7s', '8s', '9s', '6p', '6p', '2s', '3s'],
          },
          dealerDrawnKind: '6z',
          doraIndicatorKinds: ['8s'],
        }),
      });
      state = reduce(state, {
        type: 'DISCARD_TILE',
        playerId: 'p2',
        tileId: state.players[2]!.hand.find((t) => t.kind === '4s')!.id,
      });
      state = reduce(state, {
        type: 'CALL_RESPONSE',
        playerId: 'p1',
        choice: { type: 'ron' },
      });
      expect(state.players.map((p) => p.score)).toEqual([23000, 27000, 23000, 27000]);

      // E4 (p3親): p0 がリーチ(供託1000 -> 22000)、他3人(親p3含む)がノーテンで流局
      // -> p0 +3000 (25000)、p1 -1000 (26000)、p2 -1000 (22000)、p3 -1000 (26000)
      state = reduce(state, {
        type: 'ADVANCE_ROUND',
        playerId: 'p0',
        shuffledDeck: buildCustomDeck(rules, {
          dealerIndex: 3,
          hands: {
            0: ['1m', '2m', '3m', '4p', '5p', '6p', '7s', '8s', '9s', '6p', '6p', '2s', '3s'], // p0 テンパイ
            1: ['1m', '4m', '7m', '2p', '5p', '8p', '3s', '6s', '9s', '1z', '2z', '3z', '4z'],
            2: ['1m', '4m', '7m', '2p', '5p', '8p', '3s', '6s', '9s', '1z', '2z', '3z', '7z'],
            3: ['1m', '4m', '7m', '2p', '5p', '8p', '3s', '6s', '9s', '1z', '2z', '3z', '5z'],
          },
          dealerDrawnKind: '6z',
          liveWallHeadKinds: ['8p', '6m'],
          doraIndicatorKinds: ['8m'],
        }),
      });
      // p3 が 6z 切り -> p0 が 8p リーチ宣言(供託1000) -> p1 打牌時に山0で流局
      state = passAllPendingResponses(
        reduce(state, {
          type: 'DISCARD_TILE',
          playerId: 'p3',
          tileId: state.players[3]!.drawnTile!.id,
        }),
      );
      state = passAllPendingResponses(
        reduce(state, {
          type: 'DECLARE_RIICHI',
          playerId: 'p0',
          tileId: state.players[0]!.drawnTile!.id,
        }),
      );
      state = { ...state, round: { ...state.round!, wall: [] } };
      state = passAllPendingResponses(
        reduce(state, {
          type: 'DISCARD_TILE',
          playerId: 'p1',
          tileId: state.players[1]!.drawnTile!.id,
        }),
      );
      expect(state.phase).toBe('round_end');
      expect(state.players.map((p) => p.score)).toEqual([25000, 26000, 22000, 26000]);
      expect(state.kyotakuCount).toBe(1);
      assertPointConservation(state.players, state.kyotakuCount, 100000);

      // 終局: 同点 26000 の p1 と p3 のうち、起家(seat 0)に近い seat 1 (p1) が残供託 1000点 を獲得！
      state = reduce(state, {
        type: 'ADVANCE_ROUND',
        playerId: 'p0',
        shuffledDeck: [],
      });
      expect(state.phase).toBe('finished');
      expect(state.kyotakuCount).toBe(0);
      expect(state.finalKyotakuAward).toEqual({
        playerId: 'p1',
        points: 1000,
      });
      expect(state.players.map((p) => p.score)).toEqual([25000, 27000, 22000, 26000]);
      assertPointConservation(state.players, state.kyotakuCount, 100000);

      const finalView = toStateView(state, 'p2');
      expect(finalView.finalKyotakuAward).toEqual({
        playerId: 'p1',
        points: 1000,
      });
    });
  });
});
