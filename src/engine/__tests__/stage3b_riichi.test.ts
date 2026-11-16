import { describe, expect, it } from 'vitest';
import { getCanRiichiDiscardTileIds } from '../agari';
import { toStateView } from '../projection';
import { applyAction, reduce } from '../reducer';
import { deriveRules } from '../rules';
import { buildTileDeck } from '../wall';
import {
  assertTileConservation,
  createStartedCustomGame,
  passAllPendingResponses,
} from './testHelpers';

describe('Stage 3B リーチ系（リーチ・ダブルリーチ・一発・裏ドラ・リーチ後フリテン・供託）', () => {
  it('例題手牌 234m 456p 567s 34p 88s のリーチ和了点数がツモ・ロン・一発裏ドラで期待値と一致する', () => {
    // 親が最初にツモ切りして、子 p1 が2巡目（または初回でもWリーチ検証を兼ねず通常リーチとして2巡目）にリーチする
    const rules = deriveRules({
      playerCount: 4,
      gameLength: 'tonpuu',
      tobi: true,
      tsumoLoss: false,
      allowKuitan: true,
      allowAtozuke: true,
    });

    const p1Hand = [
      '2m', '3m', '4m',
      '4p', '5p', '6p',
      '5s', '6s', '7s',
      '3p', '4p', '8s', '8s',
    ];
    // 1巡目: p0 discards 9m -> p1 discards 1z (通常リーチテスト用) -> p2 discards 9p -> p3 discards 1s
    // 2巡目: p0 discards 9m -> p1 draws 1z and declares riichi cutting 1z!
    // p2 discards 5p -> ロン和了テスト (リーチ・タンヤオ・平和 = 3翻30符 3900)
    // もしくは p2..p0 が通り、p1 が 5p ツモ -> ツモ和了テスト (リーチ・一発・ツモ・タンヤオ・平和・裏1...)
    const baseState = createStartedCustomGame(4, {
      hands: {
        0: ['1m', '1m', '9m', '9m', '9m', '2s', '2s', '2s', '3s', '3s', '3s', '7z', '7z'],
        1: p1Hand,
        2: ['5p', '1z', '1z', '1z', '2z', '2z', '2z', '3z', '3z', '3z', '4z', '4z', '4z'],
        3: ['1s', '1s', '1s', '2p', '2p', '2p', '7p', '7p', '7p', '9s', '9s', '9s', '6z'],
      },
      dealerDrawnKind: '9m',
      doraIndicatorKinds: ['5z'], // ドラなし (白の次は発)
      uraDoraIndicatorKinds: ['7s'], // 8s が裏ドラ表示7sの次＝1枚×2枚乗る!
      liveWallHeadKinds: [
        '1z', '6z', '6z', // p1, p2, p3 1巡目ツモ
        '9p', '5z', '5p', // 2巡目: p0 draws 9p, p1 draws 5z -> declares riichi cutting 5z! Then p2 draws 5p!
      ],
    });

    // 1巡目を回す（p1が鳴きやポンで邪魔されないよう進める）
    let s = baseState;
    s = passAllPendingResponses(
      reduce(s, { type: 'DISCARD_TILE', playerId: 'p0', tileId: s.players[0]!.drawnTile!.id }),
    );
    // p1: ツモ 1z を切る（まだリーチしない -> p1.discards.length === 1 となり次巡は通常リーチ）
    s = passAllPendingResponses(
      reduce(s, { type: 'DISCARD_TILE', playerId: 'p1', tileId: s.players[1]!.drawnTile!.id }),
    );
    s = passAllPendingResponses(
      reduce(s, { type: 'DISCARD_TILE', playerId: 'p2', tileId: s.players[2]!.drawnTile!.id }),
    );
    s = passAllPendingResponses(
      reduce(s, { type: 'DISCARD_TILE', playerId: 'p3', tileId: s.players[3]!.drawnTile!.id }),
    );
    s = passAllPendingResponses(
      reduce(s, { type: 'DISCARD_TILE', playerId: 'p0', tileId: s.players[0]!.drawnTile!.id }),
    );

    // 2巡目 p1 が 5z ツモ、リーチ宣言して 5z 切り
    const p1 = s.players[1]!;
    expect(p1.drawnTile?.kind).toBe('5z');
    const legalRiichiIds = getCanRiichiDiscardTileIds(p1.hand, p1.drawnTile, p1.melds, rules);
    expect(legalRiichiIds).toEqual([p1.drawnTile!.id]);

    const afterRiichi = reduce(s, {
      type: 'DECLARE_RIICHI',
      playerId: 'p1',
      tileId: p1.drawnTile!.id,
    });
    expect(afterRiichi.phase).toBe('playing');
    expect(afterRiichi.kyotakuCount).toBe(1);
    expect(afterRiichi.players[1]!.isRiichi).toBe(true);
    expect(afterRiichi.players[1]!.isDoubleRiichi).toBe(false);
    expect(afterRiichi.players[1]!.ippatsuEligible).toBe(true);
    expect(afterRiichi.players[1]!.score).toBe(24000);
    expect(afterRiichi.players[1]!.discards[1]!.isRiichiDeclaration).toBe(true);

    // ケースA: p2 が 5p を切ると、p1 が リーチ・一発・タンヤオ・平和・裏2 = 6翻 跳満 12000点 + 供託1000点！
    const p2FivePin = afterRiichi.players[2]!.hand.find((t) => t.kind === '5p')!;
    const awaitingRon = reduce(afterRiichi, {
      type: 'DISCARD_TILE',
      playerId: 'p2',
      tileId: p2FivePin.id,
    });
    expect(awaitingRon.phase).toBe('awaiting_responses');

    const ronEnded = reduce(awaitingRon, {
      type: 'CALL_RESPONSE',
      playerId: 'p1',
      choice: { type: 'ron' },
    });
    expect(ronEnded.phase).toBe('round_end');
    expect(ronEnded.kyotakuCount).toBe(0);
    const ronAgari = ronEnded.round!.agariResults[0]!;
    expect(ronAgari.yaku.map((y) => y.id)).toEqual(
      expect.arrayContaining(['riichi', 'ippatsu', 'tanyao', 'pinfu']),
    );
    expect(ronAgari.uraDoraCount).toBe(2);
    expect(ronAgari.han).toBe(6);
    expect(ronAgari.pointsAwarded).toBe(12000);
    expect(ronEnded.round!.kyotakuWinnerPlayerId).toBe('p1');
    expect(ronEnded.round!.kyotakuPointsAwarded).toBe(1000);
    expect(ronEnded.round!.uraDoraIndicators).toHaveLength(1);
    expect(ronEnded.players[1]!.score).toBe(24000 + 12000 + 1000);
    expect(ronEnded.players[2]!.score).toBe(25000 - 12000);

    // ケースB: 一発なし・裏ドラなし時のツモ (20符4翻 1300/2600) と ロン (30符3翻 3900)
    const exactBase = createStartedCustomGame(4, {
      hands: {
        0: ['1m', '1m', '9m', '9m', '9m', '2s', '2s', '2s', '3s', '3s', '3s', '7z', '7z'],
        1: p1Hand,
        2: ['5p', '1z', '1z', '1z', '2z', '2z', '2z', '3z', '3z', '3z', '4z', '4z', '4z'],
        3: ['1s', '1s', '1s', '2p', '2p', '2p', '7p', '7p', '7p', '9s', '9s', '9s', '6z'],
      },
      dealerDrawnKind: '9m',
      doraIndicatorKinds: ['5z'],
      uraDoraIndicatorKinds: ['5z'], // 裏0
      liveWallHeadKinds: [
        '1z', '6z', '6z',
        '9p', '5z', '1m', '7p', '9p', '1s', // p1 riichi(5z) -> p2,p3,p0 pass -> p1 draws 1s (not winning, clears ippatsu!)
        '1m', '9p', '9p', '5p', // p2,p3,p0 -> p1 draws 5p!
      ],
    });
    let s2 = exactBase;
    s2 = passAllPendingResponses(reduce(s2, { type: 'DISCARD_TILE', playerId: 'p0', tileId: s2.players[0]!.drawnTile!.id }));
    s2 = passAllPendingResponses(reduce(s2, { type: 'DISCARD_TILE', playerId: 'p1', tileId: s2.players[1]!.drawnTile!.id }));
    s2 = passAllPendingResponses(reduce(s2, { type: 'DISCARD_TILE', playerId: 'p2', tileId: s2.players[2]!.drawnTile!.id }));
    s2 = passAllPendingResponses(reduce(s2, { type: 'DISCARD_TILE', playerId: 'p3', tileId: s2.players[3]!.drawnTile!.id }));
    s2 = passAllPendingResponses(reduce(s2, { type: 'DISCARD_TILE', playerId: 'p0', tileId: s2.players[0]!.drawnTile!.id }));
    // p1 declares riichi cutting 5z
    s2 = passAllPendingResponses(
      reduce(s2, { type: 'DECLARE_RIICHI', playerId: 'p1', tileId: s2.players[1]!.drawnTile!.id }),
    );
    // 1巡目経過して一発消滅
    s2 = passAllPendingResponses(reduce(s2, { type: 'DISCARD_TILE', playerId: 'p2', tileId: s2.players[2]!.drawnTile!.id }));
    s2 = passAllPendingResponses(reduce(s2, { type: 'DISCARD_TILE', playerId: 'p3', tileId: s2.players[3]!.drawnTile!.id }));
    s2 = passAllPendingResponses(reduce(s2, { type: 'DISCARD_TILE', playerId: 'p0', tileId: s2.players[0]!.drawnTile!.id }));
    s2 = passAllPendingResponses(reduce(s2, { type: 'DISCARD_TILE', playerId: 'p1', tileId: s2.players[1]!.drawnTile!.id }));
    expect(s2.players[1]!.ippatsuEligible).toBe(false);

    // 2通りの分岐: p2が5p切ってロン(30符3翻3900) vs p2が1m切ってp1が5pツモ(20符4翻1300/2600)
    const ron3900State = reduce(
      reduce(s2, {
        type: 'DISCARD_TILE',
        playerId: 'p2',
        tileId: s2.players[2]!.hand.find((t) => t.kind === '5p')!.id,
      }),
      { type: 'CALL_RESPONSE', playerId: 'p1', choice: { type: 'ron' } },
    );
    const ron3900 = ron3900State.round!.agariResults[0]!;
    expect(ron3900.fu).toBe(30);
    expect(ron3900.han).toBe(3);
    expect(ron3900.pointsAwarded).toBe(3900);

    let tsumoState = s2;
    tsumoState = passAllPendingResponses(reduce(tsumoState, { type: 'DISCARD_TILE', playerId: 'p2', tileId: tsumoState.players[2]!.drawnTile!.id }));
    tsumoState = passAllPendingResponses(reduce(tsumoState, { type: 'DISCARD_TILE', playerId: 'p3', tileId: tsumoState.players[3]!.drawnTile!.id }));
    tsumoState = passAllPendingResponses(reduce(tsumoState, { type: 'DISCARD_TILE', playerId: 'p0', tileId: tsumoState.players[0]!.drawnTile!.id }));
    expect(tsumoState.players[1]!.drawnTile?.kind).toBe('5p');
    const tsumoEnded = reduce(tsumoState, { type: 'DECLARE_TSUMO', playerId: 'p1' });
    const tsumo204 = tsumoEnded.round!.agariResults[0]!;
    expect(tsumo204.fu).toBe(20);
    expect(tsumo204.han).toBe(4);
    expect(tsumo204.scoreDeltas['p0']).toBe(-2600);
    expect(tsumo204.scoreDeltas['p2']).toBe(-1300);
    expect(tsumo204.scoreDeltas['p3']).toBe(-1300);
    expect(tsumo204.pointsAwarded).toBe(5200);
    assertTileConservation(tsumoEnded, 136);
  });

  it('1翻の期待値（裏1が1枚乗る場合: 例題 234m 234p 567s 34p 88s + 5p + リーチ + 一発 + 裏1 = 5翻 8000）', () => {
    const baseState = createStartedCustomGame(4, {
      hands: {
        0: ['1m', '1m', '9m', '9m', '9m', '2s', '2s', '2s', '3s', '3s', '3s', '7z', '7z'],
        1: ['2m', '3m', '4m', '2p', '3p', '4p', '5s', '6s', '7s', '3p', '4p', '8s', '8s'],
        2: ['5p', '1z', '1z', '1z', '2z', '2z', '2z', '3z', '3z', '3z', '4z', '4z', '4z'],
        3: ['1s', '1s', '1s', '1p', '1p', '1p', '7p', '7p', '7p', '9s', '9s', '9s', '6z'],
      },
      dealerDrawnKind: '9m',
      doraIndicatorKinds: ['5z'],
      uraDoraIndicatorKinds: ['1p'], // 2p が1枚だけ乗る!
      liveWallHeadKinds: ['1z', '6z', '6z', '9p', '5z'],
    });
    let s = passAllPendingResponses(reduce(baseState, { type: 'DISCARD_TILE', playerId: 'p0', tileId: baseState.players[0]!.drawnTile!.id }));
    s = passAllPendingResponses(reduce(s, { type: 'DISCARD_TILE', playerId: 'p1', tileId: s.players[1]!.drawnTile!.id }));
    s = passAllPendingResponses(reduce(s, { type: 'DISCARD_TILE', playerId: 'p2', tileId: s.players[2]!.drawnTile!.id }));
    s = passAllPendingResponses(reduce(s, { type: 'DISCARD_TILE', playerId: 'p3', tileId: s.players[3]!.drawnTile!.id }));
    s = passAllPendingResponses(reduce(s, { type: 'DISCARD_TILE', playerId: 'p0', tileId: s.players[0]!.drawnTile!.id }));

    s = reduce(s, { type: 'DECLARE_RIICHI', playerId: 'p1', tileId: s.players[1]!.drawnTile!.id });
    const ended = reduce(
      reduce(s, { type: 'DISCARD_TILE', playerId: 'p2', tileId: s.players[2]!.hand.find((t) => t.kind === '5p')!.id }),
      { type: 'CALL_RESPONSE', playerId: 'p1', choice: { type: 'ron' } },
    );
    const agari = ended.round!.agariResults[0]!;
    expect(agari.uraDoraCount).toBe(1);
    expect(agari.han).toBe(5);
    expect(agari.pointsAwarded).toBe(8000);
  });

  it('ダブルリーチ成立と、ポン・チー・暗槓による無効化、および3人麻雀北抜きではダブルリーチも一発も消えないこと', () => {
    // 4人麻雀: p0 が1打目にダブルリーチ -> 鳴きなしで p1 も1打目にダブルリーチ可能
    const s4 = createStartedCustomGame(4, {
      hands: {
        0: ['2m', '3m', '4m', '4p', '5p', '6p', '5s', '6s', '7s', '3p', '4p', '8s', '8s'],
        1: ['2m', '3m', '4m', '4p', '5p', '6p', '5s', '6s', '7s', '3p', '4p', '9s', '9s'],
        2: ['1z', '1z', '1z', '2z', '2z', '2z', '3z', '3z', '3z', '4z', '4z', '4z', '7p'],
        3: ['1s', '1s', '1s', '2p', '2p', '2p', '8p', '8p', '8p', '9m', '9m', '9m', '6z'],
      },
      dealerDrawnKind: '5z',
      doraIndicatorKinds: ['7z'],
      uraDoraIndicatorKinds: ['7z'],
      liveWallHeadKinds: ['5z', '5p'],
    });
    const p0Double = reduce(s4, {
      type: 'DECLARE_RIICHI',
      playerId: 'p0',
      tileId: s4.players[0]!.drawnTile!.id,
    });
    expect(p0Double.players[0]!.isDoubleRiichi).toBe(true);
    expect(p0Double.players[0]!.ippatsuEligible).toBe(true);

    // 続けて p1 も鳴きなしで第1打宣言 -> ダブルリーチになる
    const p1Double = reduce(p0Double, {
      type: 'DECLARE_RIICHI',
      playerId: 'p1',
      tileId: p0Double.players[1]!.drawnTile!.id,
    });
    expect(p1Double.players[1]!.isDoubleRiichi).toBe(true);

    // 3人麻雀: p0 が1巡目に北抜きをしてからダブルリーチ宣言 -> ダブルリーチ有効！
    // さらに p1 が1巡目に北抜きしても p0 の一発と p1 のダブルリーチ権利は消えない！
    const s3 = createStartedCustomGame(3, {
      hands: {
        0: ['4z', '1p', '2p', '3p', '4p', '5p', '6p', '5s', '6s', '7s', '3p', '4p', '8s'],
        1: ['4z', '1p', '2p', '3p', '4p', '5p', '6p', '5s', '6s', '7s', '3p', '4p', '9s'],
        2: ['1z', '1z', '1z', '2z', '2z', '2z', '3z', '3z', '3z', '5z', '5z', '5z', '7p'],
      },
      dealerDrawnKind: '8s',
      rinshanKinds: ['6z', '6z', '6z', '6z'],
      doraIndicatorKinds: ['7z'],
      uraDoraIndicatorKinds: ['7z'],
      liveWallHeadKinds: ['7p', '5p'],
    });

    const afterP0Kita = reduce(s3, {
      type: 'DECLARE_KITA',
      playerId: 'p0',
      tileId: s3.players[0]!.hand.find((t) => t.kind === '4z')!.id,
    });
    expect(afterP0Kita.round!.firstTurnUninterrupted).toBe(true);

    const afterP0DoubleRiichi = reduce(afterP0Kita, {
      type: 'DECLARE_RIICHI',
      playerId: 'p0',
      tileId: afterP0Kita.players[0]!.drawnTile!.id, // 6z 切り
    });
    expect(afterP0DoubleRiichi.players[0]!.isDoubleRiichi).toBe(true);
    expect(afterP0DoubleRiichi.players[0]!.ippatsuEligible).toBe(true);

    // p1 が北抜きしても、p0 の一発は消えず、p1 もダブルリーチできる
    const afterP1Kita = reduce(afterP0DoubleRiichi, {
      type: 'DECLARE_KITA',
      playerId: 'p1',
      tileId: afterP0DoubleRiichi.players[1]!.hand.find((t) => t.kind === '4z')!.id,
    });
    expect(afterP1Kita.players[0]!.ippatsuEligible).toBe(true);
    expect(afterP1Kita.round!.firstTurnUninterrupted).toBe(true);
    expect(afterP1Kita.players[1]!.drawnTile?.kind).toBe('6z');

    const s3WithPair = createStartedCustomGame(3, {
      hands: {
        0: ['4z', '1p', '2p', '3p', '4p', '5p', '6p', '5s', '6s', '7s', '3p', '4p', '8s'],
        1: ['1s', '2s', '3s', '4p', '5p', '6p', '5s', '6s', '7s', '3p', '4p', '9s', '9s'],
        2: ['1z', '1z', '1z', '2z', '2z', '2z', '3z', '3z', '3z', '5z', '5z', '6z', '8p'],
      },
      dealerDrawnKind: '8s',
      rinshanKinds: ['6z', '6z', '1m', '9m'],
      doraIndicatorKinds: ['7z'],
      uraDoraIndicatorKinds: ['7z'],
      liveWallHeadKinds: ['7z', '5p'], // p1 draws 7z, p2 draws 5p
    });
    let k3 = reduce(s3WithPair, {
      type: 'DECLARE_KITA',
      playerId: 'p0',
      tileId: s3WithPair.players[0]!.hand.find((t) => t.kind === '4z')!.id,
    });
    k3 = reduce(k3, {
      type: 'DECLARE_RIICHI',
      playerId: 'p0',
      tileId: k3.players[0]!.drawnTile!.id,
    });
    expect(k3.players[0]!.isDoubleRiichi).toBe(true);
    k3 = reduce(k3, {
      type: 'DECLARE_RIICHI',
      playerId: 'p1',
      tileId: k3.players[1]!.drawnTile!.id,
    });
    expect(k3.players[1]!.isDoubleRiichi).toBe(true);
    // p2 cuts 5p -> both p0 and p1 win double riichi + ippatsu (double ron!)
    const p2FiveP = reduce(k3, {
      type: 'DISCARD_TILE',
      playerId: 'p2',
      tileId: k3.players[2]!.drawnTile!.id,
    });
    const dr1 = reduce(p2FiveP, {
      type: 'CALL_RESPONSE',
      playerId: 'p0',
      choice: { type: 'ron' },
    });
    const dr2 = reduce(dr1, {
      type: 'CALL_RESPONSE',
      playerId: 'p1',
      choice: { type: 'ron' },
    });
    expect(dr2.phase).toBe('round_end');
    expect(dr2.round!.agariResults).toHaveLength(2);
    expect(dr2.round!.agariResults[0]!.yaku.map((y) => y.id)).toEqual(
      expect.arrayContaining(['double_riichi', 'ippatsu']),
    );
    // ダブロン時は放銃者(p2=seat2)からツモ順で最も近い p0(seat0) が供託2本(2000点)を獲得
    expect(dr2.round!.kyotakuWinnerPlayerId).toBe('p0');
    expect(dr2.round!.kyotakuPointsAwarded).toBe(2000);
    expect(dr2.kyotakuCount).toBe(0);

    // 4人麻雀: 第1巡に誰かが暗槓・ポンすると以後のリーチはダブルリーチにならず通常リーチになる
    const s4PonBreaks = createStartedCustomGame(4, {
      hands: {
        0: ['1z', '1z', '1z', '2z', '2z', '2z', '3z', '3z', '3z', '4z', '4z', '4z', '9m'],
        1: ['9m', '9m', '2p', '3p', '4p', '5p', '6p', '7p', '1s', '2s', '3s', '8s', '8s'],
        2: ['2m', '3m', '4m', '4p', '5p', '6p', '5s', '6s', '7s', '3p', '4p', '7s', '7s'],
        3: ['1p', '1p', '1p', '2s', '2s', '2s', '9s', '9s', '9s', '5z', '5z', '5z', '6z'],
      },
      dealerDrawnKind: '9m',
      liveWallHeadKinds: ['6z'], // p2 draws 6z after p1 pons 9m and discards 8s? Wait p1 discards 8s -> p2 won't pon/chi
    });
    // p0 cuts 9m -> p1 pons 9m -> p1 cuts 8s? Wait p2 has 234m456p567s34p77s so doesn't call 8s! Wait p1 has 12 tiles left after pon(9m) = 10 + 9m pon -> cuts 1z? No, p1 cuts 8s leaving 234p 567p 123s + 8s -> wait that's not tenpai! Let's just have p0 ankan 1z!
    const s4AnkanBreaks = createStartedCustomGame(4, {
      hands: {
        0: ['1z', '1z', '1z', '2z', '2z', '2z', '3z', '3z', '3z', '4z', '4z', '4z', '9m'],
        1: ['2m', '3m', '4m', '4p', '5p', '6p', '5s', '6s', '7s', '3p', '4p', '8s', '8s'],
        2: ['1s', '1s', '1s', '2p', '2p', '2p', '8p', '8p', '8p', '9p', '9p', '9p', '7z'],
        3: ['5z', '5z', '5z', '6z', '6z', '6z', '7p', '7p', '7p', '9s', '9s', '9s', '7z'],
      },
      dealerDrawnKind: '1z',
      rinshanKinds: ['5z'],
      liveWallHeadKinds: ['6z'],
    });
    void s4PonBreaks;
    let ab = reduce(s4AnkanBreaks, { type: 'DECLARE_ANKAN', playerId: 'p0', kind: '1z' });
    expect(ab.round!.firstTurnUninterrupted).toBe(false);
    ab = passAllPendingResponses(
      reduce(ab, { type: 'DISCARD_TILE', playerId: 'p0', tileId: ab.players[0]!.drawnTile!.id }),
    );
    ab = passAllPendingResponses(
      reduce(ab, { type: 'DECLARE_RIICHI', playerId: 'p1', tileId: ab.players[1]!.drawnTile!.id }),
    );
    expect(ab.players[1]!.isRiichi).toBe(true);
    expect(ab.players[1]!.isDoubleRiichi).toBe(false);
  });

  it('リーチ宣言牌がロンされた場合はリーチ・供託が成立せず、鳴かれた場合は次巡打牌が横向き宣言牌になる', () => {
    // 1. 宣言牌へのロン -> リーチ不成立・供託不増
    const ronOnRiichiState = createStartedCustomGame(4, {
      hands: {
        0: ['2m', '3m', '4m', '4p', '5p', '6p', '5s', '6s', '7s', '3p', '4p', '8s', '8s'],
        1: ['1p', '2p', '3p', '7s', '8s', '9s', '2m', '2m', '5z', '5z', '5z', '6m', '6m'],
        2: ['1z', '1z', '1z', '2z', '2z', '2z', '3z', '3z', '3z', '4z', '4z', '4z', '7p'],
        3: ['1s', '1s', '1s', '9p', '9p', '9p', '8p', '8p', '8p', '9m', '9m', '9m', '6z'],
      },
      dealerDrawnKind: '6m', // p0 cuts 6m to declare riichi -> p1 rons 6m!
    });
    const awaiting = reduce(ronOnRiichiState, {
      type: 'DECLARE_RIICHI',
      playerId: 'p0',
      tileId: ronOnRiichiState.players[0]!.drawnTile!.id,
    });
    expect(awaiting.phase).toBe('awaiting_responses');
    expect(awaiting.players[0]!.score).toBe(25000); // まだ引かれない
    expect(awaiting.kyotakuCount).toBe(0);

    const ronRes = reduce(awaiting, {
      type: 'CALL_RESPONSE',
      playerId: 'p1',
      choice: { type: 'ron' },
    });
    expect(ronRes.phase).toBe('round_end');
    expect(ronRes.players[0]!.isRiichi).toBe(false);
    expect(ronRes.kyotakuCount).toBe(0);
    expect(ronRes.round!.kyotakuPointsAwarded).toBe(0);

    // 2. 宣言牌をチー・ポンされた場合 -> リーチは成立し一発は消え、本人の次打牌が横向きになる
    const calledRiichiState = createStartedCustomGame(4, {
      hands: {
        0: ['2m', '3m', '4m', '4p', '5p', '6p', '5s', '6s', '7s', '3p', '4p', '8s', '8s'],
        1: ['5z', '5z', '1p', '2p', '3p', '7s', '8s', '9s', '1m', '1m', '6z', '6z', '6z'],
        2: ['1z', '1z', '1z', '2z', '2z', '2z', '3z', '3z', '3z', '4z', '4z', '4z', '7p'],
        3: ['1s', '1s', '1s', '9p', '9p', '9p', '8p', '8p', '8p', '9m', '9m', '9m', '7z'],
      },
      dealerDrawnKind: '5z',
      liveWallHeadKinds: ['7p', '7p', '9m', '6m'], // p2, p3, p0(draws 6m)
    });
    const awaitPon = reduce(calledRiichiState, {
      type: 'DECLARE_RIICHI',
      playerId: 'p0',
      tileId: calledRiichiState.players[0]!.drawnTile!.id,
    });
    const afterPon = reduce(awaitPon, {
      type: 'CALL_RESPONSE',
      playerId: 'p1',
      choice: { type: 'pon' },
    });
    expect(afterPon.phase).toBe('playing');
    expect(afterPon.players[0]!.isRiichi).toBe(true);
    expect(afterPon.players[0]!.ippatsuEligible).toBe(false);
    expect(afterPon.players[0]!.pendingRiichiSideways).toBe(true);
    expect(afterPon.players[0]!.score).toBe(24000);
    expect(afterPon.kyotakuCount).toBe(1);

    // p1 -> p2 -> p3 -> p0 draws 6m and must tsumogiri, and that tile becomes sideways declaration!
    let s = passAllPendingResponses(
      reduce(afterPon, {
        type: 'DISCARD_TILE',
        playerId: 'p1',
        tileId: afterPon.players[1]!.hand.find((t) => t.kind === '6z')!.id,
      }),
    );
    s = passAllPendingResponses(
      reduce(s, { type: 'DISCARD_TILE', playerId: 'p2', tileId: s.players[2]!.drawnTile!.id }),
    );
    s = passAllPendingResponses(
      reduce(s, { type: 'DISCARD_TILE', playerId: 'p3', tileId: s.players[3]!.drawnTile!.id }),
    );
    const afterSideways = passAllPendingResponses(
      reduce(s, { type: 'DISCARD_TILE', playerId: 'p0', tileId: s.players[0]!.drawnTile!.id }),
    );
    expect(afterSideways.players[0]!.pendingRiichiSideways).toBe(false);
    expect(afterSideways.players[0]!.discards[0]!.isRiichiDeclaration).toBe(true);
  });

  it('リーチ後の制約: ツモ切り強制・待ち不変暗槓のみ許可・リーチ後永久ロンフリテン（ツモ可）・持ち点不足と山残り不足拒否・3人抜北は引いた北のみ', () => {
    // 1. 持ち点900点・山残り3枚(4人麻雀)でのリーチ拒否
    const lowScore = createStartedCustomGame(4, {
      hands: { 0: ['2m', '3m', '4m', '4p', '5p', '6p', '5s', '6s', '7s', '3p', '4p', '8s', '8s'] },
      dealerDrawnKind: '5z',
    });
    const lowScore900 = {
      ...lowScore,
      players: lowScore.players.map((p, i) => (i === 0 ? { ...p, score: 900 } : p)),
    };
    const errLow = applyAction(lowScore900, {
      type: 'DECLARE_RIICHI',
      playerId: 'p0',
      tileId: lowScore900.players[0]!.drawnTile!.id,
    });
    expect(errLow.error?.code).toBe('INVALID_RIICHI');

    const shallowWall = {
      ...lowScore,
      round: { ...lowScore.round!, wall: lowScore.round!.wall.slice(0, 3) },
    };
    const errWall = applyAction(shallowWall, {
      type: 'DECLARE_RIICHI',
      playerId: 'p0',
      tileId: shallowWall.players[0]!.drawnTile!.id,
    });
    expect(errWall.error?.code).toBe('INVALID_RIICHI');

    // 2. 待ち不変暗槓 (111m 234m 567p 45s 88s: waits 3s,6s -> ankan 1m keeps waits 3s,6s -> OK)
    // vs 待ち変化暗槓 (111m 23m 567p 456s 88s: waits 1m,4m -> ankan 1m changes waits -> NG)
    const rules = deriveRules({
      playerCount: 4,
      gameLength: 'tonpuu',
      tobi: true,
      tsumoLoss: false,
      allowKuitan: true,
      allowAtozuke: true,
    });
    const ankanState = createStartedCustomGame(4, {
      hands: {
        0: ['1m', '1m', '1m', '2m', '3m', '4m', '5p', '6p', '7p', '4s', '5s', '8s', '8s'],
        1: ['9p', '9p', '9p', '1z', '1z', '1z', '2z', '2z', '2z', '3z', '3z', '3z', '3s'],
        2: ['1s', '1s', '1s', '2p', '2p', '2p', '8p', '8p', '8p', '9m', '9m', '9m', '7z'],
        3: ['4z', '4z', '4z', '5z', '5z', '5z', '6z', '6z', '6z', '7z', '7z', '7z', '9s'],
      },
      dealerDrawnKind: '6z',
      rinshanKinds: ['9m'],
      liveWallHeadKinds: ['9s', '9s', '1p', '1m'], // p0 next draw is 4th 1m!
    });
    let rState = passAllPendingResponses(
      reduce(ankanState, {
        type: 'DECLARE_RIICHI',
        playerId: 'p0',
        tileId: ankanState.players[0]!.drawnTile!.id,
      }),
    );
    // p1 cuts 3s -> p0 passes on ron -> リーチ後永久ロンフリテンになる！
    const awaitP0Ron = reduce(rState, {
      type: 'DISCARD_TILE',
      playerId: 'p1',
      tileId: rState.players[1]!.hand.find((t) => t.kind === '3s')!.id,
    });
    expect(awaitP0Ron.round!.pendingResponse!.optionsByPlayerId['p0']?.canRon).toBe(true);
    rState = reduce(awaitP0Ron, {
      type: 'CALL_RESPONSE',
      playerId: 'p0',
      choice: { type: 'pass' },
    });
    expect(rState.players[0]!.isRiichiFuriten).toBe(true);

    // p2 cuts 7p, p3 cuts 6s (later) -> wait let's advance to p0 draw 1m!
    rState = passAllPendingResponses(
      reduce(rState, { type: 'DISCARD_TILE', playerId: 'p2', tileId: rState.players[2]!.drawnTile!.id }),
    );
    // p3 が 3s 切っても p0 は永遠にロンできない（同巡フリテン前の別牌でも・本人のツモ挟んだ後でも不可）
    const p3Discards3s = reduce(rState, {
      type: 'DISCARD_TILE',
      playerId: 'p3',
      tileId: rState.players[3]!.drawnTile!.id, // 7p
    });
    rState = passAllPendingResponses(p3Discards3s);
    // p0 draws 1m!
    expect(rState.players[0]!.drawnTile?.kind).toBe('1m');
    expect(toStateView(rState, 'p0').isFuriten).toBe(true);
    expect(toStateView(rState, 'p0').mySelfActions?.canAnkanKinds).toEqual(['1m']);

    // リーチ後はツモ切り以外拒否される
    const wrongDiscard = applyAction(rState, {
      type: 'DISCARD_TILE',
      playerId: 'p0',
      tileId: rState.players[0]!.hand[0]!.id,
    });
    expect(wrongDiscard.error?.code).toBe('TSUMOGIRI_ONLY');

    // 待ち不変なので 1m 暗槓は成功する
    const afterAnkan = reduce(rState, {
      type: 'DECLARE_ANKAN',
      playerId: 'p0',
      kind: '1m',
    });
    expect(afterAnkan.players[0]!.melds).toHaveLength(1);
    expect(afterAnkan.players[0]!.ippatsuEligible).toBe(false);
    expect(afterAnkan.players[0]!.drawnTile?.kind).toBe('9m');

    // 待ちが変わる暗槓 (111m 23m 567p 456s 88s で 1m を暗槓) は拒否される
    const changeWaitState = createStartedCustomGame(4, {
      hands: {
        0: ['1m', '1m', '1m', '2m', '3m', '5p', '6p', '7p', '4s', '5s', '6s', '8s', '8s'],
      },
      dealerDrawnKind: '5z',
      liveWallHeadKinds: ['7p', '7p', '7p', '1m'],
    });
    let cw = passAllPendingResponses(
      reduce(changeWaitState, {
        type: 'DECLARE_RIICHI',
        playerId: 'p0',
        tileId: changeWaitState.players[0]!.drawnTile!.id,
      }),
    );
    cw = passAllPendingResponses(reduce(cw, { type: 'DISCARD_TILE', playerId: 'p1', tileId: cw.players[1]!.drawnTile!.id }));
    cw = passAllPendingResponses(reduce(cw, { type: 'DISCARD_TILE', playerId: 'p2', tileId: cw.players[2]!.drawnTile!.id }));
    cw = passAllPendingResponses(reduce(cw, { type: 'DISCARD_TILE', playerId: 'p3', tileId: cw.players[3]!.drawnTile!.id }));
    expect(cw.players[0]!.drawnTile?.kind).toBe('1m');
    expect(toStateView(cw, 'p0').mySelfActions?.canAnkanKinds ?? []).toEqual([]);
    const rejectAnkan = applyAction(cw, {
      type: 'DECLARE_ANKAN',
      playerId: 'p0',
      kind: '1m',
    });
    expect(rejectAnkan.error?.code).toBe('INVALID_CALL');
    void rules;

    // 3人麻雀リーチ後: 手牌にある北は抜けず、ツモってきた北だけ抜ける
    const s3KitaRiichi = createStartedCustomGame(3, {
      hands: {
        0: ['4z', '1s', '2s', '3s', '4p', '5p', '6p', '5s', '6s', '7s', '3p', '4p', '4z'],
      },
      dealerDrawnKind: '9s', // cut 9s leaves 4z pair wait!
      rinshanKinds: ['6z', '1m', '9m', '7z'],
      liveWallHeadKinds: ['7p', '7p', '4z'], // p0 draws 4z after riichi
    });
    let kr = passAllPendingResponses(
      reduce(s3KitaRiichi, {
        type: 'DECLARE_RIICHI',
        playerId: 'p0',
        tileId: s3KitaRiichi.players[0]!.drawnTile!.id,
      }),
    );
    kr = passAllPendingResponses(reduce(kr, { type: 'DISCARD_TILE', playerId: 'p1', tileId: kr.players[1]!.drawnTile!.id }));
    kr = passAllPendingResponses(reduce(kr, { type: 'DISCARD_TILE', playerId: 'p2', tileId: kr.players[2]!.drawnTile!.id }));
    expect(kr.players[0]!.drawnTile?.kind).toBe('4z');
    // 手牌中の 4z を抜こうとするとエラー
    const handNorthId = kr.players[0]!.hand.find((t) => t.kind === '4z')!.id;
    expect(
      applyAction(kr, { type: 'DECLARE_KITA', playerId: 'p0', tileId: handNorthId }).error?.code,
    ).toBe('INVALID_CALL');
    expect(toStateView(kr, 'p0').mySelfActions?.canKitaTileIds).toEqual([
      kr.players[0]!.drawnTile!.id,
    ]);
    // ツモってきた北を抜くのはOK
    const afterDrawnKita = reduce(kr, {
      type: 'DECLARE_KITA',
      playerId: 'p0',
      tileId: kr.players[0]!.drawnTile!.id,
    });
    expect(afterDrawnKita.players[0]!.kitaTiles).toHaveLength(1);
    expect(afterDrawnKita.players[0]!.drawnTile?.kind).toBe('6z');
  });

  it('流局時に供託リーチ棒が次局へ繰り越され、次の和了者が受け取る', () => {
    const rules = deriveRules({
      playerCount: 4,
      gameLength: 'tonpuu',
      tobi: true,
      tsumoLoss: false,
      allowKuitan: true,
      allowAtozuke: true,
    });
    const base = createStartedCustomGame(4, {
      hands: {
        0: ['2m', '3m', '4m', '4p', '5p', '6p', '5s', '6s', '7s', '3p', '4p', '8s', '8s'],
      },
      dealerDrawnKind: '5z',
    });
    let s = passAllPendingResponses(
      reduce(base, {
        type: 'DECLARE_RIICHI',
        playerId: 'p0',
        tileId: base.players[0]!.drawnTile!.id,
      }),
    );
    expect(s.kyotakuCount).toBe(1);

    // 強制的に山を空にして次巡の捨て牌で流局させる
    s = { ...s, round: { ...s.round!, wall: [] } };
    const p1Id = s.players[1]!.drawnTile!.id;
    s = passAllPendingResponses(
      reduce(s, { type: 'DISCARD_TILE', playerId: 'p1', tileId: p1Id }),
    );
    expect(s.phase).toBe('round_end');
    expect(s.round!.agariResults).toHaveLength(0);
    expect(s.kyotakuCount).toBe(1); // 流局時は場に残る

    // 次局開始（供託引き継ぎ、プレイヤーのリーチ状態はリセット）
    const nextRound = reduce(s, {
      type: 'ADVANCE_ROUND',
      playerId: 'p0',
      shuffledDeck: buildTileDeck(rules),
    });
    expect(nextRound.phase).toBe('playing');
    expect(nextRound.kyotakuCount).toBe(1);
    expect(nextRound.players.every((p) => !p.isRiichi)).toBe(true);
    // リーチ後フリテンでも自分のツモ和了は可能であることを確認
    expect(toStateView(nextRound, 'p0').kyotakuCount).toBe(1);
  });
});
