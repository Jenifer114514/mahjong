import { describe, expect, it } from 'vitest';
import { toStateView } from '../projection';
import { applyAction, reduce } from '../reducer';
import { deriveRules } from '../rules';
import {
  assertTileConservation,
  buildCustomDeck,
  buildSeededTestDeck,
  createStartedCustomGame,
  passAllPendingResponses,
} from './testHelpers';

describe('第3A段階: ツモ和了・ロン・ダブロン・フリテン・トビ・三麻ツモ損', () => {
  it('ツモ和了で点棒移動・和了者のみ手牌開示・他家手牌隠蔽・親回転が行われる', () => {
    // p0(親): 234m 456m 345p 678s 55p + 2m(ツモ) -> 平和+門前ツモ+断幺九 (20符3翻 = 1300オール = 3900)
    let state = createStartedCustomGame(4, {
      hands: {
        0: ['3m', '4m', '4m', '5m', '6m', '3p', '4p', '5p', '6s', '7s', '8s', '5p', '5p'],
        1: ['1m', '1m', '9m', '9m', '1p', '1p', '9p', '9p', '1s', '1s', '9s', '9s', '1z'],
        2: ['2z', '2z', '3z', '3z', '4z', '4z', '5z', '5z', '6z', '6z', '7z', '7z', '8s'],
        3: ['1p', '2p', '3p', '7p', '8p', '9p', '1s', '2s', '3s', '4s', '5s', '7p', '8p'],
      },
      dealerDrawnKind: '2m',
      doraIndicatorKinds: ['1z', '2z', '3z', '4z', '5z'],
    });

    const p0View = toStateView(state, 'p0');
    expect(p0View.mySelfActions?.canTsumo).toBe(true);
    expect(p0View.isFuriten).toBe(false);

    // 他家には p0 の手牌が含まれない
    const p1ViewBefore = toStateView(state, 'p1');
    const serializedBefore = JSON.stringify(p1ViewBefore);
    for (const t of state.players[0]!.hand) {
      expect(serializedBefore).not.toContain(`"${t.id}"`);
    }

    const tsumoRes = applyAction(state, {
      type: 'DECLARE_TSUMO',
      playerId: 'p0',
    });
    expect(tsumoRes.error).toBeNull();
    state = tsumoRes.state;
    assertTileConservation(state, 136);

    expect(state.phase).toBe('round_end');
    expect(state.players.map((p) => p.score)).toEqual([28900, 23700, 23700, 23700]);
    expect(state.round!.agariResults).toHaveLength(1);
    expect(state.round!.agariResults[0]!.winType).toBe('tsumo');
    expect(state.round!.agariResults[0]!.fu).toBe(20);
    expect(state.round!.agariResults[0]!.pointsAwarded).toBe(3900);
    expect(state.round!.roundScoreDeltas).toEqual({
      p0: 3900,
      p1: -1300,
      p2: -1300,
      p3: -1300,
    });

    // round_end の投影では全員が和了者(p0)の手牌・役を見られるが、非和了者(p2)の手牌は非公開のまま
    const p1EndView = toStateView(state, 'p1');
    expect(p1EndView.round?.agariResults[0]?.hand).toEqual(state.players[0]!.hand);
    expect(p1EndView.round?.agariResults[0]?.yaku.map((y) => y.id).sort()).toEqual([
      'menzen_tsumo',
      'pinfu',
      'tanyao',
    ]);
    const serializedEnd = JSON.stringify(p1EndView);
    for (const t of state.players[2]!.hand) {
      expect(serializedEnd).not.toContain(`"${t.id}"`);
    }

    // 和了後でも ADVANCE_ROUND で親は必ず次席へ回る（連荘なし）
    const rules = deriveRules(state.ruleConfig);
    state = reduce(state, {
      type: 'ADVANCE_ROUND',
      playerId: 'p0',
      shuffledDeck: buildSeededTestDeck(rules, 12345),
    });
    expect(state.phase).toBe('playing');
    expect(state.round!.roundIndex).toBe(1);
    expect(state.round!.dealerIndex).toBe(1);
  });

  it('山残り0枚の最終ツモでもツモ和了できる (海底ツモ)', () => {
    // 3人麻雀 東1局 (dealerIndex=0): 54回ツモ切り後の最終牌(55枚目)は seat 0 (p0) が引く
    let lastDrawState = createStartedCustomGame(3, {
      hands: {
        0: ['5z', '5z', '5z', '1p', '2p', '3p', '4p', '5p', '6p', '7p', '8p', '9p', '9s'],
        1: ['1m', '1m', '9m', '9m', '1s', '1s', '2s', '2s', '3s', '3s', '1z', '1z', '2z'],
        2: ['6z', '6z', '7z', '7z', '3z', '3z', '4s', '4s', '5s', '5s', '6s', '6s', '7s'],
      },
      dealerDrawnKind: '2z',
      wallTailKinds: ['9s'],
      doraIndicatorKinds: ['1z', '2z', '3z', '4z', '6z'],
    });

    while (lastDrawState.round!.wall.length > 0) {
      const cur = lastDrawState.players.find(
        (p) => p.seatIndex === lastDrawState.round!.currentTurnIndex,
      )!;
      lastDrawState = passAllPendingResponses(
        reduce(lastDrawState, {
          type: 'DISCARD_TILE',
          playerId: cur.playerId,
          tileId: cur.drawnTile!.id,
        }),
      );
    }

    expect(lastDrawState.phase).toBe('playing');
    expect(lastDrawState.round!.wall).toHaveLength(0);
    expect(lastDrawState.round!.currentTurnIndex).toBe(0);
    expect(lastDrawState.players[0]!.drawnTile!.kind).toBe('9s');

    const lastView = toStateView(lastDrawState, 'p0');
    expect(lastView.mySelfActions?.canTsumo).toBe(true);
    expect(lastView.mySelfActions?.canAnkanKinds).toEqual([]);
    expect(lastView.mySelfActions?.canKitaTileIds).toEqual([]);

    const tsumoWin = applyAction(lastDrawState, {
      type: 'DECLARE_TSUMO',
      playerId: 'p0',
    });
    expect(tsumoWin.error).toBeNull();
    expect(tsumoWin.state.phase).toBe('round_end');
    expect(tsumoWin.state.round!.agariResults[0]!.winType).toBe('tsumo');
  });

  it('ダブロン・頭ハネの実和了計算とゼロサム点棒移動が正しい', () => {
    // p0 が 5s を切ると p1(平和+断幺九=30符2翻=2000) と p3(白単騎=40符1翻=1300) の両方がロン可能
    const spec = {
      hands: {
        0: ['1z', '1z', '2z', '2z', '3z', '3z', '6z', '6z', '7z', '7z', '1p', '1p', '9p'],
        1: ['2m', '3m', '4m', '4p', '5p', '6p', '7p', '8p', '7s', '7s', '3s', '4s', '6p'],
        2: ['1m', '1m', '9m', '9m', '1s', '1s', '9s', '9s', '2p', '2p', '8p', '8p', '4z'],
        3: ['5z', '5z', '5z', '1m', '2m', '3m', '4p', '5p', '6p', '1s', '2s', '3s', '5s'],
      },
      dealerDrawnKind: '5s',
      doraIndicatorKinds: ['1z', '2z', '3z', '4z', '6z'],
    };

    // doubleRon: true (既定)
    let sDouble = createStartedCustomGame(4, spec);
    sDouble = reduce(sDouble, {
      type: 'DISCARD_TILE',
      playerId: 'p0',
      tileId: sDouble.players[0]!.drawnTile!.id,
    });
    expect(sDouble.phase).toBe('awaiting_responses');
    expect(toStateView(sDouble, 'p1').myCallOptions?.canRon).toBe(true);
    expect(toStateView(sDouble, 'p3').myCallOptions?.canRon).toBe(true);

    sDouble = reduce(sDouble, {
      type: 'CALL_RESPONSE',
      playerId: 'p3',
      choice: { type: 'ron' },
    });
    sDouble = reduce(sDouble, {
      type: 'CALL_RESPONSE',
      playerId: 'p1',
      choice: { type: 'ron' },
    });
    expect(sDouble.phase).toBe('round_end');
    expect(sDouble.round!.agariResults.map((r) => r.playerId)).toEqual(['p1', 'p3']);
    expect(sDouble.round!.roundScoreDeltas).toEqual({
      p0: -3300,
      p1: 2000,
      p2: 0,
      p3: 1300,
    });
    expect(sDouble.players.map((p) => p.score)).toEqual([21700, 27000, 25000, 26300]);

    // doubleRon: false (頭ハネ -> 下家に近い p1 のみ和了)
    let sHead = createStartedCustomGame(4, spec, { doubleRon: false });
    sHead = reduce(sHead, {
      type: 'DISCARD_TILE',
      playerId: 'p0',
      tileId: sHead.players[0]!.drawnTile!.id,
    });
    sHead = reduce(sHead, {
      type: 'CALL_RESPONSE',
      playerId: 'p3',
      choice: { type: 'ron' },
    });
    sHead = reduce(sHead, {
      type: 'CALL_RESPONSE',
      playerId: 'p1',
      choice: { type: 'ron' },
    });
    expect(sHead.round!.agariResults.map((r) => r.playerId)).toEqual(['p1']);
    expect(sHead.players.map((p) => p.score)).toEqual([23000, 27000, 25000, 25000]);
  });

  it('捨て牌フリテン: 待ち牌の片方を過去に切っていたら別の待ち牌でもロン不可・ツモ可能、鳴かれた捨て牌も履歴に残る', () => {
    let fState = createStartedCustomGame(4, {
      hands: {
        0: ['1z', '1z', '2z', '2z', '3z', '3z', '5z', '5z', '6z', '6z', '7z', '7z', '9p'],
        1: ['2m', '3m', '4m', '4m', '5m', '4p', '5p', '6p', '5s', '6s', '8p', '8p', '4s'],
        2: ['4s', '4s', '1s', '1s', '2s', '2s', '3s', '3s', '8s', '8s', '9s', '9s', '2p'],
        3: ['1m', '1m', '9m', '9m', '7m', '7m', '8m', '8m', '9p', '9p', '3p', '3p', '4z'],
      },
      dealerDrawnKind: '9m',
      liveWallHeadKinds: ['6m', '7s', '1s', '7s'],
      doraIndicatorKinds: ['1z', '2z', '3z', '4z', '5z'],
    });

    // p0 打 9m
    fState = passAllPendingResponses(
      reduce(fState, {
        type: 'DISCARD_TILE',
        playerId: 'p0',
        tileId: fState.players[0]!.drawnTile!.id,
      }),
    );

    // p1 が 6m を引き、4s を切る -> p2 が 4s をポン（p1の河から消えても discardedKinds には残る）
    const f1FourS = fState.players[1]!.hand.find((t) => t.kind === '4s')!;
    fState = reduce(fState, {
      type: 'DISCARD_TILE',
      playerId: 'p1',
      tileId: f1FourS.id,
    });
    expect(fState.phase).toBe('awaiting_responses');
    fState = reduce(fState, {
      type: 'CALL_RESPONSE',
      playerId: 'p2',
      choice: { type: 'pon' },
    });
    expect(fState.players[1]!.discards).toHaveLength(0);
    expect(fState.players[1]!.discardedKinds).toEqual(['4s']);

    // p1 は 4s/7s 待ちテンパイでフリテン！ 他家の StateView には漏れない
    const p1View = toStateView(fState, 'p1');
    expect(p1View.isFuriten).toBe(true);
    expect(toStateView(fState, 'p2').isFuriten).toBe(false);

    // p2 が 2p を切り、p3 が 7s をツモ切りしても、p1 はロンできない！
    const p2TwoP = fState.players[2]!.hand.find((t) => t.kind === '2p')!;
    fState = passAllPendingResponses(
      reduce(fState, {
        type: 'DISCARD_TILE',
        playerId: 'p2',
        tileId: p2TwoP.id,
      }),
    );
    const p3SevenS = fState.players[3]!.drawnTile!;
    expect(p3SevenS.kind).toBe('7s');
    const afterP3Discard = reduce(fState, {
      type: 'DISCARD_TILE',
      playerId: 'p3',
      tileId: p3SevenS.id,
    });
    expect(afterP3Discard.phase).toBe('playing');
    expect(afterP3Discard.round!.currentTurnIndex).toBe(0);

    // そのまま p0 が 1s をツモ切りし、p1 が 7s を自摸った場合はツモ和了可能！
    const afterP0Discard = passAllPendingResponses(
      reduce(afterP3Discard, {
        type: 'DISCARD_TILE',
        playerId: 'p0',
        tileId: afterP3Discard.players[0]!.drawnTile!.id,
      }),
    );
    const p1SelfView = toStateView(afterP0Discard, 'p1');
    expect(afterP0Discard.players[1]!.drawnTile!.kind).toBe('7s');
    expect(p1SelfView.mySelfActions?.canTsumo).toBe(true);
    const winRes = applyAction(afterP0Discard, {
      type: 'DECLARE_TSUMO',
      playerId: 'p1',
    });
    expect(winRes.error).toBeNull();
    expect(winRes.state.phase).toBe('round_end');
  });

  it('同巡フリテン: ロンを見逃すと同巡ロン不可となり、自分の次回打牌で解除される', () => {
    // p2 のみ 7s 待ち（p3 は非テンパイの孤立牌構成）
    let st = createStartedCustomGame(4, {
      hands: {
        0: ['1z', '1z', '2z', '2z', '3z', '3z', '5z', '5z', '6z', '6z', '7z', '7z', '9p'],
        1: ['1m', '4m', '7m', '2p', '5p', '8p', '1s', '4s', '9s', '1z', '2z', '3z', '7s'],
        2: ['2m', '3m', '4m', '4m', '5m', '6m', '4p', '5p', '6p', '5s', '6s', '8p', '8p'],
        3: ['4z', '4z', '4z', '1s', '4s', '9s', '1p', '7p', '9m', '2s', '3s', '8s', '7s'],
      },
      dealerDrawnKind: '7s',
      liveWallHeadKinds: ['1p', '2p', '8p'],
      doraIndicatorKinds: ['1z', '2z', '3z', '4z', '5z'],
    });

    // p0 が 7s を切る -> p2 はロン可能だがスルー
    st = reduce(st, {
      type: 'DISCARD_TILE',
      playerId: 'p0',
      tileId: st.players[0]!.drawnTile!.id,
    });
    expect(toStateView(st, 'p2').myCallOptions?.canRon).toBe(true);
    st = reduce(st, {
      type: 'CALL_RESPONSE',
      playerId: 'p2',
      choice: { type: 'pass' },
    });
    expect(st.phase).toBe('playing');
    expect(st.players[2]!.sameTurnFuriten).toBe(true);
    expect(toStateView(st, 'p2').isFuriten).toBe(true);

    // p1 が手出しで 7s を切っても、p2 は同巡フリテン中なのでロンできない（チー候補が出ても canRon=false）
    const p1SevenS = st.players[1]!.hand.find((t) => t.kind === '7s')!;
    st = reduce(st, {
      type: 'DISCARD_TILE',
      playerId: 'p1',
      tileId: p1SevenS.id,
    });
    expect(toStateView(st, 'p2').myCallOptions?.canRon ?? false).toBe(false);
    st = passAllPendingResponses(st);
    expect(st.phase).toBe('playing');
    expect(st.round!.currentTurnIndex).toBe(2);

    // p2 が 2p をツモ切りすると sameTurnFuriten が解除される
    st = passAllPendingResponses(
      reduce(st, {
        type: 'DISCARD_TILE',
        playerId: 'p2',
        tileId: st.players[2]!.drawnTile!.id,
      }),
    );
    expect(st.players[2]!.sameTurnFuriten).toBe(false);
    expect(toStateView(st, 'p2').isFuriten).toBe(false);

    // p3 が 7s を切ると p2 は再びロン可能！
    const p3SevenS = st.players[3]!.hand.find((t) => t.kind === '7s')!;
    st = reduce(st, {
      type: 'DISCARD_TILE',
      playerId: 'p3',
      tileId: p3SevenS.id,
    });
    expect(st.phase).toBe('awaiting_responses');
    expect(toStateView(st, 'p2').myCallOptions?.canRon).toBe(true);
  });

  it('トビ終了: tobi=true で0点未満になると即終局し、tobi=false は続行する', () => {
    // 親(p0)の国士無双(48000)を p1(初期25000 -> -23000) が振り込む
    // ※ p0 の第1打は国士牌以外の 8p にすることで捨て牌フリテンを回避
    const kokushiSpec = {
      hands: {
        0: ['1m', '9m', '1p', '9p', '1s', '9s', '1z', '2z', '3z', '4z', '5z', '6z', '7z'],
        1: ['1m', '2m', '2m', '3m', '3m', '4m', '4m', '5m', '5m', '6m', '6m', '7m', '7m'],
        2: ['2p', '2p', '3p', '3p', '4p', '4p', '5p', '5p', '6p', '6p', '7p', '7p', '9p'],
        3: ['2s', '2s', '3s', '3s', '4s', '4s', '5s', '5s', '6s', '6s', '7s', '7s', '8s'],
      },
      dealerDrawnKind: '8p',
      liveWallHeadKinds: ['8s'],
    };

    // tobi: true (既定) -> 東1局でも finished になる
    let sTobi = createStartedCustomGame(4, kokushiSpec, {
      gameLength: 'hanchan',
      tobi: true,
    });
    sTobi = passAllPendingResponses(
      reduce(sTobi, {
        type: 'DISCARD_TILE',
        playerId: 'p0',
        tileId: sTobi.players[0]!.drawnTile!.id,
      }),
    );
    const p1OneM = sTobi.players[1]!.hand.find((t) => t.kind === '1m')!;
    sTobi = reduce(sTobi, {
      type: 'DISCARD_TILE',
      playerId: 'p1',
      tileId: p1OneM.id,
    });
    expect(sTobi.phase).toBe('awaiting_responses');
    sTobi = reduce(sTobi, {
      type: 'CALL_RESPONSE',
      playerId: 'p0',
      choice: { type: 'ron' },
    });
    expect(sTobi.phase).toBe('round_end');
    expect(sTobi.players[1]!.score).toBe(-23000);
    expect(sTobi.round!.isTobiEnded).toBe(true);
    expect(toStateView(sTobi, 'p0').round?.isTobiEnded).toBe(true);

    sTobi = reduce(sTobi, {
      type: 'ADVANCE_ROUND',
      playerId: 'p0',
      shuffledDeck: [],
    });
    expect(sTobi.phase).toBe('finished');
    expect(sTobi.round).toBeNull();

    // tobi: false -> マイナスでも次局へ進める
    let sNoTobi = createStartedCustomGame(4, kokushiSpec, {
      gameLength: 'hanchan',
      tobi: false,
    });
    sNoTobi = passAllPendingResponses(
      reduce(sNoTobi, {
        type: 'DISCARD_TILE',
        playerId: 'p0',
        tileId: sNoTobi.players[0]!.drawnTile!.id,
      }),
    );
    const p1OneM2 = sNoTobi.players[1]!.hand.find((t) => t.kind === '1m')!;
    sNoTobi = reduce(sNoTobi, {
      type: 'DISCARD_TILE',
      playerId: 'p1',
      tileId: p1OneM2.id,
    });
    sNoTobi = reduce(sNoTobi, {
      type: 'CALL_RESPONSE',
      playerId: 'p0',
      choice: { type: 'ron' },
    });
    expect(sNoTobi.players[1]!.score).toBe(-23000);
    expect(sNoTobi.round!.isTobiEnded).toBe(false);

    const rules = deriveRules(sNoTobi.ruleConfig);
    sNoTobi = reduce(sNoTobi, {
      type: 'ADVANCE_ROUND',
      playerId: 'p0',
      shuffledDeck: buildSeededTestDeck(rules, 77),
    });
    expect(sNoTobi.phase).toBe('playing');
    expect(sNoTobi.round!.roundIndex).toBe(1);
  });

  it('0点ちょうどではトビ終了しない', () => {
    const rules = deriveRules({ playerCount: 4, gameLength: 'tonpuu', tobi: true });
    // 第1局: p1 が p2 に 平和ロン (30符1翻=1000点) 振込 -> p1 が 24000点になる
    let stZero = createStartedCustomGame(4, {
      hands: {
        0: ['1m', '1m', '9m', '9m', '1p', '1p', '9p', '9p', '1s', '1s', '9s', '9s', '2p'],
        1: ['1z', '1z', '2z', '2z', '3z', '3z', '4z', '4z', '6z', '6z', '7z', '7z', '4s'],
        2: ['1m', '2m', '3m', '4p', '5p', '6p', '7s', '8s', '9s', '2s', '3s', '5p', '5p'],
        3: ['1p', '1p', '2p', '2p', '3p', '3p', '6s', '6s', '7s', '7s', '8s', '8s', '8m'],
      },
      dealerDrawnKind: '5m',
      doraIndicatorKinds: ['1z', '2z', '3z', '4z', '6z'],
    });
    stZero = passAllPendingResponses(
      reduce(stZero, {
        type: 'DISCARD_TILE',
        playerId: 'p0',
        tileId: stZero.players[0]!.drawnTile!.id,
      }),
    );
    stZero = reduce(stZero, {
      type: 'DISCARD_TILE',
      playerId: 'p1',
      tileId: stZero.players[1]!.hand.find((t) => t.kind === '4s')!.id,
    });
    stZero = reduce(stZero, {
      type: 'CALL_RESPONSE',
      playerId: 'p2',
      choice: { type: 'ron' },
    });
    expect(stZero.players[1]!.score).toBe(24000);

    // 第2局: p1(24000点) が p2(子) に三倍満(24000点)を振り込む -> ちょうど 0 点！
    // p2: 111p 222p 333p 555p 77p (清一色6 + 対々和2 + 三暗刻2 + ドラ2[7p×2] = 12翻 三倍満 24000)
    const deckExact24000 = buildCustomDeck(rules, {
      dealerIndex: 1,
      hands: {
        0: ['1m', '1m', '9m', '9m', '9p', '9p', '1s', '1s', '9s', '9s', '2s', '2s', '3s'],
        1: ['1z', '1z', '2z', '2z', '3z', '3z', '4z', '4z', '5z', '5z', '6z', '6z', '7z'],
        2: ['1p', '1p', '1p', '2p', '2p', '2p', '3p', '3p', '3p', '5p', '5p', '7p', '7p'],
        3: ['4m', '4m', '5m', '5m', '6m', '6m', '7m', '7m', '8m', '8m', '2m', '2m', '3m'],
      },
      dealerDrawnKind: '5p',
      doraIndicatorKinds: ['6p', '1z', '2z', '3z', '7z'], // 7pがドラ×2
    });
    stZero = reduce(stZero, {
      type: 'ADVANCE_ROUND',
      playerId: 'p0',
      shuffledDeck: deckExact24000,
    });
    stZero = reduce(stZero, {
      type: 'DISCARD_TILE',
      playerId: 'p1',
      tileId: stZero.players[1]!.drawnTile!.id,
    });
    stZero = reduce(stZero, {
      type: 'CALL_RESPONSE',
      playerId: 'p2',
      choice: { type: 'ron' },
    });
    expect(stZero.players[1]!.score).toBe(0);
    expect(stZero.round!.isTobiEnded).toBe(false);

    // 0点ではトビにならないため、東3局へ進める
    stZero = reduce(stZero, {
      type: 'ADVANCE_ROUND',
      playerId: 'p0',
      shuffledDeck: buildSeededTestDeck(rules, 999),
    });
    expect(stZero.phase).toBe('playing');
    expect(stZero.round!.roundIndex).toBe(2);
  });

  it('3人麻雀の抜北 + 三麻萬子ドラ循環 + ツモ損なし(折半)の統合フロー', () => {
    let s3 = createStartedCustomGame(
      3,
      {
        hands: {
          0: ['1m', '1m', '1m', '4z', '1p', '2p', '3p', '4p', '5p', '6p', '7s', '8s', '9s'],
          1: ['9p', '9p', '2s', '2s', '3s', '3s', '4s', '4s', '5s', '5s', '6s', '6s', '1z'],
          2: ['2p', '2p', '3p', '3p', '4p', '4p', '5p', '5p', '6p', '6p', '7p', '7p', '2z'],
        },
        dealerDrawnKind: '9p',
        rinshanKinds: ['9p', '1z', '2z', '3z'],
        doraIndicatorKinds: ['9m', '1z', '2z', '3z', '5z'],
      },
      { tsumoLoss: false },
    );

    const kitaId = s3.players[0]!.hand.find((t) => t.kind === '4z')!.id;
    s3 = reduce(s3, { type: 'DECLARE_KITA', playerId: 'p0', tileId: kitaId });
    expect(s3.players[0]!.kitaTiles).toHaveLength(1);
    expect(s3.players[0]!.drawnTile!.kind).toBe('9p');

    const res = applyAction(s3, { type: 'DECLARE_TSUMO', playerId: 'p0' });
    expect(res.error).toBeNull();
    s3 = res.state;
    assertTileConservation(s3, 108);

    const agari = s3.round!.agariResults[0]!;
    expect(agari.doraCount).toBe(3); // 9m表ドラ -> 三麻では1mがドラ×3
    expect(agari.kitaCount).toBe(1);
    expect(agari.han).toBe(5);
    expect(agari.scoreLabel).toBe('満貫');
    expect(agari.pointsAwarded).toBe(12000); // 4000オールを2人で折半 -> 6000ずつ
    expect(s3.players.map((p) => p.score)).toEqual([47000, 29000, 29000]);
  });
});
