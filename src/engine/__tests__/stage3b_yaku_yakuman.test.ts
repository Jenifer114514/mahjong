import { describe, expect, it } from 'vitest';
import type { Meld } from '../../types/state';
import type { Tile, TileKind } from '../../types/tile';
import { evaluateRonForPlayer } from '../calls';
import { toStateView } from '../projection';
import { reduce } from '../reducer';
import { deriveRules } from '../rules';
import { evaluateBestAgari } from '../score';
import {
  assertTileConservation,
  createStartedCustomGame,
  passAllPendingResponses,
} from './testHelpers';

function makeTiles(kinds: readonly TileKind[], prefix = 'y'): Tile[] {
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
  const tiles = makeTiles(kinds, `m-${type}-${kinds[0]}`);
  return {
    type,
    tiles,
    calledTile: type === 'ankan' ? null : tiles[0]!,
    fromSeatIndex: type === 'ankan' ? null : fromSeatIndex,
    addedTile: type === 'kakan' ? tiles[3]! : null,
  };
}

describe('Stage 3B 状況役（嶺上開花・槍槓・海底摸月・河底撈魚）', () => {
  it('嶺上開花: 暗槓後および三麻抜北後の嶺上ツモで成立し、カンで山残り0になっても海底にはならない', () => {
    // 1. 暗槓後、山が0枚になっても嶺上開花のみ成立（海底摸月にならない）
    const s = createStartedCustomGame(4, {
      hands: {
        0: ['1m', '1m', '1m', '2p', '3p', '4p', '5s', '6s', '7s', '4m', '5m', '9p', '9p'],
      },
      dealerDrawnKind: '1m',
      rinshanKinds: ['6m'],
      doraIndicatorKinds: ['7z'],
    });
    // 山を1枚だけ残す（暗槓の嶺上補充で最後の1枚を使って wall.length === 0 になる）
    const oneWallLeft = {
      ...s,
      round: { ...s.round!, wall: s.round!.wall.slice(0, 1) },
    };
    const afterAnkan = reduce(oneWallLeft, {
      type: 'DECLARE_ANKAN',
      playerId: 'p0',
      kind: '1m',
    });
    expect(afterAnkan.round!.wall).toHaveLength(0);
    expect(afterAnkan.players[0]!.isRinshanDraw).toBe(true);
    expect(afterAnkan.players[0]!.drawnTile?.kind).toBe('6m');

    const tsumoRes = reduce(afterAnkan, {
      type: 'DECLARE_TSUMO',
      playerId: 'p0',
    });
    const agari = tsumoRes.round!.agariResults[0]!;
    expect(agari.yaku.map((y) => y.id)).toContain('rinshan_kaihou');
    expect(agari.yaku.map((y) => y.id)).not.toContain('haitei_tsumo');

    // 2. 三麻抜北後の嶺上ツモでも嶺上開花が付く (1巡目打牌済みの2巡目に北抜き -> 天和にならず嶺上開花)
    let s3 = createStartedCustomGame(3, {
      hands: {
        0: ['4z', '1p', '2p', '3p', '5p', '6p', '5s', '6s', '7s', '8p', '8p', '9s', '9s'],
      },
      dealerDrawnKind: '6z',
      rinshanKinds: ['7p'],
      liveWallHeadKinds: ['1z', '2z', '9s'],
      doraIndicatorKinds: ['7z'],
    });
    s3 = passAllPendingResponses(
      reduce(s3, {
        type: 'DISCARD_TILE',
        playerId: 'p0',
        tileId: s3.players[0]!.drawnTile!.id,
      }),
    );
    s3 = passAllPendingResponses(
      reduce(s3, {
        type: 'DISCARD_TILE',
        playerId: 'p1',
        tileId: s3.players[1]!.drawnTile!.id,
      }),
    );
    s3 = passAllPendingResponses(
      reduce(s3, {
        type: 'DISCARD_TILE',
        playerId: 'p2',
        tileId: s3.players[2]!.drawnTile!.id,
      }),
    );
    const afterKita = reduce(s3, {
      type: 'DECLARE_KITA',
      playerId: 'p0',
      tileId: s3.players[0]!.hand.find((t) => t.kind === '4z')!.id,
    });
    expect(afterKita.players[0]!.isRinshanDraw).toBe(true);
    const kitaTsumo = reduce(afterKita, {
      type: 'DECLARE_TSUMO',
      playerId: 'p0',
    });
    expect(kitaTsumo.round!.agariResults[0]!.yaku.map((y) => y.id)).toContain(
      'rinshan_kaihou',
    );
  });

  it('槍槓: 加槓への通常ロン・暗槓への国士無双のみロン(槍槓翻なし)・抜北へのロン不可・見送り時のカン成立と視点隠蔽', () => {
    // 1. 加槓槍槓（他に役のない副露手でも槍槓1翻でロン可・カン不成立）
    const baseKakan = createStartedCustomGame(4, {
      hands: {
        0: ['4m', '5m', '6m', '2p', '3p', '4p', '5s', '6s', '7s', '9s'],
        1: ['2m', '3m', '4m', '5p', '6p', '7p', '3s', '4s', '5s', '7s', '8s', '9m', '9m'],
        2: ['1z', '1z', '1z', '2z', '2z', '2z', '3z', '3z', '3z', '4z', '4z', '4z', '6z'],
        3: ['1s', '1s', '1s', '2s', '2s', '2s', '8p', '8p', '8p', '7z', '7z', '7z', '5z'],
      },
      dealerDrawnKind: '8m', // 8mポンに加槓
      doraIndicatorKinds: ['7z'],
    });
    // p0に8mポンを追加して10枚＋ツモ1枚(=3*3+1+1)の状態を作る
    const p0WithPon = {
      ...baseKakan,
      players: baseKakan.players.map((p, idx) =>
        idx === 0
          ? {
              ...p,
              hand: p.hand.slice(0, 10),
              drawnTile: { id: 'kakan-8m', kind: '8m' as const, isRed: false },
              melds: [makeMeld('pon', ['8m', '8m', '8m'], 2)],
            }
          : idx === 1
            ? {
                ...p,
                hand: makeTiles(
                  ['2m', '3m', '4m', '5p', '6p', '7p', '3s', '4s', '5s', '9m'],
                  'p1h',
                ),
                melds: [makeMeld('chi', ['7s', '8s', '9s'], 0)],
              } // 副露して9m単騎（通常役なし！）
            : p,
      ),
    };
    // p1は8m待ちに変更するため hand を 9s 待ちにするか、あるいは kakanTile を '9m' にする
    const kakanReady = {
      ...p0WithPon,
      players: p0WithPon.players.map((p, idx) =>
        idx === 0
          ? {
              ...p,
              drawnTile: { id: 'kakan-9m', kind: '9m' as const, isRed: false },
              melds: [makeMeld('pon', ['9m', '9m', '9m'], 2)],
            }
          : p,
      ),
    };

    const awaitChankan = reduce(kakanReady, {
      type: 'DECLARE_KAKAN',
      playerId: 'p0',
      tileId: 'kakan-9m',
      now: 1000,
    });
    expect(awaitChankan.phase).toBe('awaiting_responses');

    // 対象外の p0, p2, p3 からは情報漏れせず、手番が p0 のままに見える
    const v0 = toStateView(awaitChankan, 'p0', 2000);
    const v1 = toStateView(awaitChankan, 'p1', 2000);
    const v2 = toStateView(awaitChankan, 'p2', 2000);
    expect(v0.phase).toBe('playing');
    expect(v0.round?.currentTurnIndex).toBe(0);
    expect(v2.phase).toBe('playing');
    expect(v2.round?.currentTurnIndex).toBe(0);
    expect(v1.phase).toBe('awaiting_responses');
    expect(v1.myCallOptions?.canRon).toBe(true);

    // ロン成立（副露手だが槍槓1翻で30符1翻1000点、p0のカンは不成立）
    const chankanRon = reduce(awaitChankan, {
      type: 'CALL_RESPONSE',
      playerId: 'p1',
      choice: { type: 'ron' },
    });
    expect(chankanRon.phase).toBe('round_end');
    expect(chankanRon.round!.kanCount).toBe(0);
    expect(chankanRon.players[0]!.melds[0]!.type).toBe('pon');
    expect(chankanRon.round!.agariResults[0]!.yaku.map((y) => y.id)).toEqual(['chankan']);
    expect(chankanRon.round!.agariResults[0]!.pointsAwarded).toBe(1000);

    // 見送った場合は同巡フリテンになり、加槓が成立して嶺上ツモへ進む
    const chankanPass = reduce(awaitChankan, {
      type: 'CALL_RESPONSE',
      playerId: 'p1',
      choice: { type: 'pass' },
    });
    expect(chankanPass.phase).toBe('playing');
    expect(chankanPass.round!.kanCount).toBe(1);
    expect(chankanPass.players[0]!.melds[0]!.type).toBe('kakan');
    expect(chankanPass.players[0]!.isRinshanDraw).toBe(true);
    expect(chankanPass.players[1]!.sameTurnFuriten).toBe(true);

    // 2. 暗槓槍槓: 国士無双のみロンでき（槍槓+1翻は付かない）、通常手はロン不可
    const ankanState = createStartedCustomGame(4, {
      hands: {
        0: ['1z', '1z', '1z', '2m', '3m', '4m', '5p', '6p', '7p', '2s', '3s', '4s', '8s'],
        // p1: 国士無双 1z単騎（1z以外の12種＋1m2枚）
        1: ['1m', '1m', '9m', '1p', '9p', '1s', '9s', '2z', '3z', '4z', '5z', '6z', '7z'],
        // p2: 通常手（対して、評価関数へ暗槓槍槓の通常手を与えた場合も null で拒否される）
        2: ['2m', '3m', '4m', '5p', '6p', '7p', '2s', '3s', '4s', '5s', '6s', '7s', '8m'],
        3: ['8m', '8m', '8m', '2p', '2p', '2p', '9p', '9p', '9p', '5z', '5z', '5z', '6z'],
      },
      dealerDrawnKind: '1z',
      doraIndicatorKinds: ['7z'],
    });
    const syntheticNormalChankan = evaluateRonForPlayer(
      ankanState,
      {
        ...ankanState.players[2]!,
        hand: makeTiles(
          ['2m', '3m', '4m', '5p', '6p', '7p', '2s', '3s', '4s', '5s', '6s', '7s', '1z'],
          'syn',
        ),
      },
      { id: 'syn-1z', kind: '1z', isRed: false },
      ankanState.players[0]!,
      { chankanKind: 'ankan' },
    );
    expect(syntheticNormalChankan).toBeNull();
    const awaitAnkan = reduce(ankanState, {
      type: 'DECLARE_ANKAN',
      playerId: 'p0',
      kind: '1z',
    });
    expect(awaitAnkan.phase).toBe('awaiting_responses');
    expect(Object.keys(awaitAnkan.round!.pendingResponse!.optionsByPlayerId)).toEqual([
      'p1',
    ]);
    const ankanRon = reduce(awaitAnkan, {
      type: 'CALL_RESPONSE',
      playerId: 'p1',
      choice: { type: 'ron' },
    });
    expect(ankanRon.phase).toBe('round_end');
    const kokushiRes = ankanRon.round!.agariResults[0]!;
    expect(kokushiRes.yaku.map((y) => y.id)).toEqual(['kokushi']);
    expect(kokushiRes.yaku.map((y) => y.id)).not.toContain('chankan');
    expect(kokushiRes.pointsAwarded).toBe(32000);
    assertTileConservation(ankanRon, 136);

    // 3. 三麻抜北に対しては国士無双でもロンできない
    const s3KitaKokushi = createStartedCustomGame(3, {
      hands: {
        0: ['4z', '1p', '2p', '3p', '4p', '5p', '6p', '5s', '6s', '7s', '8p', '8p', '9s'],
        1: ['1m', '1m', '9m', '1p', '9p', '1s', '9s', '1z', '2z', '3z', '5z', '6z', '7z'], // 4z待ち国士
        2: ['2p', '2p', '2p', '3p', '3p', '3p', '4s', '4s', '4s', '5z', '5z', '5z', '6z'],
      },
      dealerDrawnKind: '9s',
      rinshanKinds: ['7p'],
    });
    const afterKitaNoChankan = reduce(s3KitaKokushi, {
      type: 'DECLARE_KITA',
      playerId: 'p0',
      tileId: s3KitaKokushi.players[0]!.hand.find((t) => t.kind === '4z')!.id,
    });
    expect(afterKitaNoChankan.phase).toBe('playing');
    expect(afterKitaNoChankan.players[0]!.kitaTiles).toHaveLength(1);
  });

  it('海底摸月と河底撈魚が最後の牌でそれぞれ成立する', () => {
    const s = createStartedCustomGame(4, {
      hands: {
        0: ['1m', '1m', '1m', '2p', '3p', '4p', '5s', '6s', '7s', '2m', '3m', '8p', '8p'],
        1: ['1z', '1z', '1z', '2z', '2z', '2z', '3z', '3z', '3z', '4z', '4z', '4z', '7z'],
        2: ['5m', '6m', '7m', '4p', '5p', '6p', '2s', '3s', '4s', '7p', '8p', '9p', '1s'],
        3: ['8m', '8m', '8m', '9m', '9m', '9m', '9s', '9s', '9s', '5z', '5z', '5z', '6z'],
      },
      dealerDrawnKind: '1m',
      doraIndicatorKinds: ['7z'],
    });
    // 山を空にし、すでに1打牌済み(非天和)の p0 が通常ツモの最終牌を持っている状態でツモ
    const haiteiReady = {
      ...s,
      players: s.players.map((p, idx) =>
        idx === 0
          ? {
              ...p,
              discards: [
                {
                  tile: { id: 'dummy-d0', kind: '7z' as const, isRed: false },
                  isTsumogiri: true,
                },
              ],
              drawnTile: { id: 'last-4m', kind: '4m' as const, isRed: false },
              isRinshanDraw: false,
            }
          : p,
      ),
      round: { ...s.round!, wall: [], turnCount: 5 },
    };
    const haiteiWin = reduce(haiteiReady, {
      type: 'DECLARE_TSUMO',
      playerId: 'p0',
    });
    expect(haiteiWin.round!.agariResults[0]!.yaku.map((y) => y.id)).toContain(
      'haitei_tsumo',
    );

    // 河底撈魚: 山残り0枚で p0 が 1s を切り、役なし副露手でも河底撈魚1翻でロン可
    const houteiReady = {
      ...s,
      players: s.players.map((p, idx) =>
        idx === 0
          ? { ...p, drawnTile: { id: 'last-1s', kind: '1s' as const, isRed: false } }
          : idx === 2
            ? {
                ...p,
                hand: makeTiles(
                  ['5m', '6m', '7m', '4p', '5p', '6p', '2s', '3s', '4s', '1s'],
                  'h2',
                ),
                melds: [makeMeld('chi', ['7p', '8p', '9p'], 1)],
              }
            : p,
      ),
      round: { ...s.round!, wall: [], turnCount: 5 },
    };
    const awaitHoutei = reduce(houteiReady, {
      type: 'DISCARD_TILE',
      playerId: 'p0',
      tileId: 'last-1s',
    });
    expect(awaitHoutei.phase).toBe('awaiting_responses');
    const houteiRon = reduce(awaitHoutei, {
      type: 'CALL_RESPONSE',
      playerId: 'p2',
      choice: { type: 'ron' },
    });
    expect(houteiRon.round!.agariResults[0]!.yaku.map((y) => y.id)).toEqual([
      'houtei_ron',
    ]);
    expect(houteiRon.round!.agariResults[0]!.pointsAwarded).toBe(1000);
  });
});

describe('Stage 3B 全役満・ダブル役満・複合役満', () => {
  const rules4 = deriveRules({ playerCount: 4, gameLength: 'tonpuu' });

  it('四暗刻（ツモ=役満, ロン=非役満）と四暗刻単騎（ロン/ツモ=ダブル役満）を正しく判定する', () => {
    const shaboHand = makeTiles([
      '1m', '1m', '1m',
      '4p', '4p', '4p',
      '7s', '7s', '7s',
      '2m', '2m', '9s', '9s',
    ]);
    const suuankouTsumo = evaluateBestAgari({
      hand: shaboHand,
      melds: [],
      kitaTiles: [],
      winningTile: { id: 'w-2m', kind: '2m', isRed: false },
      isTsumo: true,
      isDealer: false,
      dealerIndex: 0,
      roundWind: 'E',
      seatWind: 'S',
      doraIndicators: [],
      winnerSeatIndex: 1,
      fromSeatIndex: null,
      rules: rules4,
    })!;
    expect(suuankouTsumo.isYakuman).toBe(true);
    expect(suuankouTsumo.yaku.map((y) => y.id)).toEqual(['suuankou']);
    expect(suuankouTsumo.scoreLabel).toBe('役満');
    expect(suuankouTsumo.pointsAwarded).toBe(32000);

    // 同じ双碰待ちのロンは三暗刻・対々和のみで役満にならない
    const shaboRon = evaluateBestAgari({
      hand: shaboHand,
      melds: [],
      kitaTiles: [],
      winningTile: { id: 'w-2m', kind: '2m', isRed: false },
      isTsumo: false,
      isDealer: false,
      dealerIndex: 0,
      roundWind: 'E',
      seatWind: 'S',
      doraIndicators: [],
      winnerSeatIndex: 1,
      fromSeatIndex: 2,
      rules: rules4,
    })!;
    expect(shaboRon.isYakuman).toBe(false);
    expect(shaboRon.yaku.map((y) => y.id)).toEqual(
      expect.arrayContaining(['toitoi', 'sanankou']),
    );

    // 四暗刻単騎はロンでもダブル役満
    const tankiHand = makeTiles([
      '1m', '1m', '1m',
      '4p', '4p', '4p',
      '7s', '7s', '7s',
      '9s', '9s', '9s',
      '2m',
    ]);
    const suuankouTankiRon = evaluateBestAgari({
      hand: tankiHand,
      melds: [],
      kitaTiles: [],
      winningTile: { id: 'w-2m', kind: '2m', isRed: false },
      isTsumo: false,
      isDealer: true,
      dealerIndex: 0,
      roundWind: 'E',
      seatWind: 'E',
      doraIndicators: makeTiles(['1m', '4p']), // 役満時はドラ無効
      winnerSeatIndex: 0,
      fromSeatIndex: 1,
      rules: rules4,
    })!;
    expect(suuankouTankiRon.isYakuman).toBe(true);
    expect(suuankouTankiRon.yaku.map((y) => y.id)).toEqual(['suuankou_tanki']);
    expect(suuankouTankiRon.scoreLabel).toBe('ダブル役満');
    expect(suuankouTankiRon.doraCount).toBe(0);
    expect(suuankouTankiRon.pointsAwarded).toBe(96000);
  });

  it('大三元・字一色(七対子含む)・緑一色(發なし含む)・清老頭・小四喜・大四喜・四槓子', () => {
    // 大三元（副露あり）
    const daisangen = evaluateBestAgari({
      hand: makeTiles(['5z', '5z', '5z', '6z', '6z', '6z', '2m', '3m', '4m', '8p']),
      melds: [makeMeld('pon', ['7z', '7z', '7z'])],
      kitaTiles: [],
      winningTile: { id: 'w-8p', kind: '8p', isRed: false },
      isTsumo: false,
      isDealer: false,
      dealerIndex: 0,
      roundWind: 'E',
      seatWind: 'S',
      doraIndicators: [],
      winnerSeatIndex: 1,
      fromSeatIndex: 2,
      rules: rules4,
    })!;
    expect(daisangen.yaku.map((y) => y.id)).toEqual(['daisangen']);
    expect(daisangen.pointsAwarded).toBe(32000);

    // 字一色（七対子 / 大七星形）
    const tsuuiisouChiitoi = evaluateBestAgari({
      hand: makeTiles([
        '1z', '1z', '2z', '2z', '3z', '3z', '4z', '4z', '5z', '5z', '6z', '6z', '7z',
      ]),
      melds: [],
      kitaTiles: [],
      winningTile: { id: 'w-7z', kind: '7z', isRed: false },
      isTsumo: false,
      isDealer: false,
      dealerIndex: 0,
      roundWind: 'E',
      seatWind: 'S',
      doraIndicators: [],
      winnerSeatIndex: 1,
      fromSeatIndex: 2,
      rules: rules4,
    })!;
    expect(tsuuiisouChiitoi.isYakuman).toBe(true);
    expect(tsuuiisouChiitoi.yaku.map((y) => y.id)).toEqual(['tsuuiisou']);
    expect(tsuuiisouChiitoi.pointsAwarded).toBe(32000);

    // 緑一色（發なしオール萬子/筒子ではなく索子のみ: 2223334446668s + 8s）
    const ryuuiisouNoHatsu = evaluateBestAgari({
      hand: makeTiles(['2s', '2s', '2s', '3s', '3s', '3s', '4s', '4s', '4s', '8s']),
      melds: [makeMeld('pon', ['6s', '6s', '6s'])],
      kitaTiles: [],
      winningTile: { id: 'w-8s', kind: '8s', isRed: false },
      isTsumo: true,
      isDealer: false,
      dealerIndex: 0,
      roundWind: 'E',
      seatWind: 'S',
      doraIndicators: [],
      winnerSeatIndex: 1,
      fromSeatIndex: null,
      rules: rules4,
    })!;
    expect(ryuuiisouNoHatsu.yaku.map((y) => y.id)).toEqual(['ryuuiisou']);
    expect(ryuuiisouNoHatsu.pointsAwarded).toBe(32000);

    // 清老頭
    const chinroutou = evaluateBestAgari({
      hand: makeTiles(['1m', '1m', '1m', '9m', '9m', '9m', '1p', '1p', '1p', '9s']),
      melds: [makeMeld('pon', ['1s', '1s', '1s'])],
      kitaTiles: [],
      winningTile: { id: 'w-9s', kind: '9s', isRed: false },
      isTsumo: false,
      isDealer: false,
      dealerIndex: 0,
      roundWind: 'E',
      seatWind: 'S',
      doraIndicators: [],
      winnerSeatIndex: 1,
      fromSeatIndex: 2,
      rules: rules4,
    })!;
    expect(chinroutou.yaku.map((y) => y.id)).toEqual(['chinroutou']);
    expect(chinroutou.pointsAwarded).toBe(32000);

    // 小四喜
    const shousuushii = evaluateBestAgari({
      hand: makeTiles(['1z', '1z', '1z', '2z', '2z', '2z', '3z', '3z', '3z', '4z']),
      melds: [makeMeld('chi', ['2p', '3p', '4p'])],
      kitaTiles: [],
      winningTile: { id: 'w-4z', kind: '4z', isRed: false },
      isTsumo: false,
      isDealer: false,
      dealerIndex: 0,
      roundWind: 'E',
      seatWind: 'S',
      doraIndicators: [],
      winnerSeatIndex: 1,
      fromSeatIndex: 2,
      rules: rules4,
    })!;
    expect(shousuushii.yaku.map((y) => y.id)).toEqual(['shousuushii']);
    expect(shousuushii.pointsAwarded).toBe(32000);

    // 大四喜 + 字一色（トリプル役満: 2 + 1 = 3倍 96,000）
    const daisuushiiTsuuiisou = evaluateBestAgari({
      hand: makeTiles(['1z', '1z', '1z', '2z', '2z', '2z', '3z', '3z', '3z', '5z']),
      melds: [makeMeld('pon', ['4z', '4z', '4z'])],
      kitaTiles: [],
      winningTile: { id: 'w-5z', kind: '5z', isRed: false },
      isTsumo: false,
      isDealer: false,
      dealerIndex: 0,
      roundWind: 'E',
      seatWind: 'S',
      doraIndicators: [],
      winnerSeatIndex: 1,
      fromSeatIndex: 2,
      rules: rules4,
    })!;
    expect(daisuushiiTsuuiisou.yaku.map((y) => y.id)).toEqual(
      expect.arrayContaining(['daisuushii', 'tsuuiisou']),
    );
    expect(daisuushiiTsuuiisou.scoreLabel).toBe('トリプル役満');
    expect(daisuushiiTsuuiisou.pointsAwarded).toBe(96000);

    // 四槓子
    const suukantsu = evaluateBestAgari({
      hand: makeTiles(['8p']),
      melds: [
        makeMeld('daiminkan', ['1m', '1m', '1m', '1m'], 2),
        makeMeld('kakan', ['4p', '4p', '4p', '4p'], 3),
        makeMeld('ankan', ['7s', '7s', '7s', '7s'], null),
        makeMeld('ankan', ['2s', '2s', '2s', '2s'], null),
      ],
      kitaTiles: [],
      winningTile: { id: 'w-8p', kind: '8p', isRed: false },
      isTsumo: true,
      isDealer: false,
      dealerIndex: 0,
      roundWind: 'E',
      seatWind: 'S',
      doraIndicators: [],
      winnerSeatIndex: 1,
      fromSeatIndex: null,
      rules: rules4,
    })!;
    expect(suukantsu.yaku.map((y) => y.id)).toEqual(['suukantsu']);
    expect(suukantsu.pointsAwarded).toBe(32000);
  });

  it('九蓮宝燈・純正九蓮宝燈・国士無双十三面待ち・天和・地和（三麻北抜き後も天和/地和維持）', () => {
    // 非純正九蓮宝燈 (1111234567899m + 9m -> 9m切り前の形に9mが2枚で1mが4枚だったため純正ではない)
    const nonJunsei = evaluateBestAgari({
      hand: makeTiles(['1m', '1m', '1m', '1m', '2m', '3m', '4m', '5m', '6m', '7m', '8m', '9m', '9m']),
      melds: [],
      kitaTiles: [],
      winningTile: { id: 'w-9m', kind: '9m', isRed: false },
      isTsumo: false,
      isDealer: false,
      dealerIndex: 0,
      roundWind: 'E',
      seatWind: 'S',
      doraIndicators: [],
      winnerSeatIndex: 1,
      fromSeatIndex: 2,
      rules: rules4,
    })!;
    expect(nonJunsei.yaku.map((y) => y.id)).toEqual(['chuuren_poutou']);
    expect(nonJunsei.scoreLabel).toBe('役満');
    expect(nonJunsei.pointsAwarded).toBe(32000);

    // 純正九蓮宝燈 (1112345678999m + 5m -> 9面待ちでダブル役満)
    const junsei = evaluateBestAgari({
      hand: makeTiles(['1m', '1m', '1m', '2m', '3m', '4m', '5m', '6m', '7m', '8m', '9m', '9m', '9m']),
      melds: [],
      kitaTiles: [],
      winningTile: { id: 'w-5m', kind: '5m', isRed: false },
      isTsumo: true,
      isDealer: false,
      dealerIndex: 0,
      roundWind: 'E',
      seatWind: 'S',
      doraIndicators: [],
      winnerSeatIndex: 1,
      fromSeatIndex: null,
      rules: rules4,
    })!;
    expect(junsei.yaku.map((y) => y.id)).toEqual(['junsei_chuuren']);
    expect(junsei.scoreLabel).toBe('ダブル役満');
    expect(junsei.pointsAwarded).toBe(64000);

    // 国士無双十三面待ち (ダブル役満)
    const kokushi13 = evaluateBestAgari({
      hand: makeTiles(['1m', '9m', '1p', '9p', '1s', '9s', '1z', '2z', '3z', '4z', '5z', '6z', '7z']),
      melds: [],
      kitaTiles: [],
      winningTile: { id: 'w-1m', kind: '1m', isRed: false },
      isTsumo: false,
      isDealer: false,
      dealerIndex: 0,
      roundWind: 'E',
      seatWind: 'S',
      doraIndicators: [],
      winnerSeatIndex: 1,
      fromSeatIndex: 2,
      rules: rules4,
    })!;
    expect(kokushi13.yaku.map((y) => y.id)).toEqual(['kokushi_13']);
    expect(kokushi13.scoreLabel).toBe('ダブル役満');
    expect(kokushi13.pointsAwarded).toBe(64000);

    // 三人麻雀: 親が北抜き後に嶺上牌で和了しても天和が消えない、さらに子が北抜きしても地和が消えない
    const s3Tenhou = createStartedCustomGame(3, {
      hands: {
        0: ['4z', '1p', '2p', '3p', '4p', '5p', '6p', '5s', '6s', '8s', '8s', '8s', '9s'],
        1: ['4z', '1p', '2p', '3p', '4p', '5p', '6p', '2s', '3s', '4s', '9p', '9p', '7s'],
        2: ['1z', '1z', '1z', '2z', '2z', '2z', '3z', '3z', '3z', '5z', '5z', '5z', '6z'],
      },
      dealerDrawnKind: '9s',
      rinshanKinds: ['7s', '9s'], // p0北抜きで7s(123p 456p 567s 888s 99s 和了!)
      liveWallHeadKinds: ['1m'],
    });
    const p0AfterKita = reduce(s3Tenhou, {
      type: 'DECLARE_KITA',
      playerId: 'p0',
      tileId: s3Tenhou.players[0]!.hand.find((t) => t.kind === '4z')!.id,
    });
    const tenhouWin = reduce(p0AfterKita, {
      type: 'DECLARE_TSUMO',
      playerId: 'p0',
    });
    expect(tenhouWin.round!.agariResults[0]!.yaku.map((y) => y.id)).toEqual([
      'tenhou',
    ]);
    expect(tenhouWin.round!.agariResults[0]!.pointsAwarded).toBe(48000);

    // 天和 + 四暗刻単騎 = トリプル役満 (親 144,000)
    const tenhouSuuankouTanki = createStartedCustomGame(4, {
      hands: {
        0: ['1m', '1m', '1m', '4p', '4p', '4p', '7s', '7s', '7s', '2z', '2z', '2z', '5z'],
      },
      dealerDrawnKind: '5z',
    });
    const tripleWin = reduce(tenhouSuuankouTanki, {
      type: 'DECLARE_TSUMO',
      playerId: 'p0',
    });
    expect(tripleWin.round!.agariResults[0]!.yaku.map((y) => y.id)).toEqual(
      expect.arrayContaining(['tenhou', 'suuankou_tanki']),
    );
    expect(tripleWin.round!.agariResults[0]!.scoreLabel).toBe('トリプル役満');
    expect(tripleWin.round!.agariResults[0]!.pointsAwarded).toBe(144000);

    // 地和: 三麻で親が打牌(抜北含む)後に子p1が抜北して第1ツモ和了 -> 地和成立
    const s3Chiihou = createStartedCustomGame(3, {
      hands: {
        0: ['1z', '1z', '1z', '2z', '2z', '2z', '3z', '3z', '3z', '5z', '5z', '6z', '6z'],
        1: ['4z', '1p', '2p', '3p', '4p', '5p', '6p', '2s', '3s', '4s', '9p', '9p', '7s'],
        2: ['1m', '1m', '9m', '9m', '2p', '2p', '3p', '3p', '5z', '5z', '6z', '6z', '8s'],
      },
      dealerDrawnKind: '7z',
      rinshanKinds: ['8s'],
      liveWallHeadKinds: ['9s'], // p1 draws 9s, then kita(4z) -> rinshan 8s -> chiihou!
    });
    let sc = reduce(s3Chiihou, {
      type: 'DISCARD_TILE',
      playerId: 'p0',
      tileId: s3Chiihou.players[0]!.drawnTile!.id,
    });
    sc = reduce(sc, {
      type: 'DECLARE_KITA',
      playerId: 'p1',
      tileId: sc.players[1]!.hand.find((t) => t.kind === '4z')!.id,
    });
    const chiihouWin = reduce(sc, {
      type: 'DECLARE_TSUMO',
      playerId: 'p1',
    });
    expect(chiihouWin.round!.agariResults[0]!.yaku.map((y) => y.id)).toEqual([
      'chiihou',
    ]);
    expect(chiihouWin.round!.agariResults[0]!.pointsAwarded).toBe(32000);
  });
});
