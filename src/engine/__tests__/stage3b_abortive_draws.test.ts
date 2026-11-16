import { describe, expect, it } from 'vitest';
import type { EngineHooks } from '../calls';
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

describe('Stage 3B 途中流局（九種九牌・四風連打・四家立直・四槓散了・三家和）', () => {
  it('九種九牌: 第1ツモで么九牌9種以上なら宣言でき手牌開示、8種以下や鳴き後・2巡目は拒否、三麻北抜き後も維持される', () => {
    // 1. 4人麻雀: 么九牌9種 (1m, 9m, 1p, 9p, 1s, 9s, 1z, 2z, 3z) + 中張牌5枚
    const s4 = createStartedCustomGame(4, {
      hands: {
        0: ['1m', '9m', '1p', '9p', '1s', '9s', '1z', '2z', '2m', '3m', '4p', '5p', '6s'],
        1: ['2p', '2p', '3p', '3p', '5m', '5m', '6m', '6m', '7m', '7m', '8s', '8s', '7z'],
      },
      dealerDrawnKind: '3z',
    });
    const v0 = toStateView(s4, 'p0');
    expect(v0.mySelfActions?.canKyuushuKyuuhai).toBe(true);

    const declared = applyAction(s4, {
      type: 'DECLARE_KYUUSHU_KYUUHAI',
      playerId: 'p0',
    });
    expect(declared.error).toBeNull();
    expect(declared.state.phase).toBe('round_end');
    expect(declared.state.round!.abortiveDrawReason).toBe('kyuushu_kyuuhai');
    expect(declared.state.round!.abortiveDrawPlayerId).toBe('p0');
    expect(declared.state.round!.revealedHands['p0']).toHaveLength(14);
    assertTileConservation(declared.state, 136);

    // 他家(p1)には p0 のみ手牌開示され、非宣言者(p2)の手牌は隠蔽のまま
    const v1End = toStateView(declared.state, 'p1');
    expect(v1End.round?.abortiveDrawReason).toBe('kyuushu_kyuuhai');
    expect(Object.keys(v1End.round?.revealedHands ?? {})).toEqual(['p0']);
    expect(v1End.round?.revealedHands['p0']).toHaveLength(14);
    const serializedEnd = JSON.stringify(v1End);
    for (const t of declared.state.players[2]!.hand) {
      expect(serializedEnd).not.toContain(`"${t.id}"`);
    }

    // 2. 么九牌8種（1mが3枚重複して種類数は8）では拒否
    const sEight = createStartedCustomGame(4, {
      hands: {
        0: ['1m', '1m', '1m', '9m', '1p', '9p', '1s', '9s', '1z', '2z', '3m', '4p', '5s'],
      },
      dealerDrawnKind: '6s',
    });
    expect(toStateView(sEight, 'p0').mySelfActions?.canKyuushuKyuuhai ?? false).toBe(false);
    expect(
      applyAction(sEight, {
        type: 'DECLARE_KYUUSHU_KYUUHAI',
        playerId: 'p0',
      }).error?.code,
    ).toBe('INVALID_ABORTIVE_DRAW');

    // 3. 三人麻雀: 抜北(DECLARE_KITA)しても第1巡の鳴き無し状態は崩れないため九種九牌が可能
    // (抜いた4zを含めずとも他に9種以上ある場合、北抜き後も宣言できる)
    const s3 = createStartedCustomGame(3, {
      hands: {
        0: ['4z', '1m', '9m', '1p', '9p', '1s', '9s', '1z', '2z', '3z', '2p', '3p', '4s'],
      },
      dealerDrawnKind: '5s',
      rinshanKinds: ['6s'],
    });
    const afterKita = reduce(s3, {
      type: 'DECLARE_KITA',
      playerId: 'p0',
      tileId: s3.players[0]!.hand.find((t) => t.kind === '4z')!.id,
    });
    expect(afterKita.round!.firstTurnUninterrupted).toBe(true);
    expect(toStateView(afterKita, 'p0').mySelfActions?.canKyuushuKyuuhai).toBe(true);
    const kyuushuAfterKita = applyAction(afterKita, {
      type: 'DECLARE_KYUUSHU_KYUUHAI',
      playerId: 'p0',
    });
    expect(kyuushuAfterKita.error).toBeNull();
    expect(kyuushuAfterKita.state.round!.abortiveDrawReason).toBe('kyuushu_kyuuhai');

    // 4. 親が暗槓してから、子が么九牌9種あっても宣言不可（鳴き・カンで終了）
    const sAnkanBreak = createStartedCustomGame(4, {
      hands: {
        0: ['1m', '1m', '1m', '2p', '3p', '4p', '5p', '6p', '7p', '2s', '3s', '4s', '5s'],
        1: ['9m', '1p', '9p', '1s', '9s', '1z', '2z', '3z', '4z', '5z', '6z', '7z', '3m'],
      },
      dealerDrawnKind: '1m',
      rinshanKinds: ['6s'],
      liveWallHeadKinds: ['3s'],
    });
    let broken = reduce(sAnkanBreak, {
      type: 'DECLARE_ANKAN',
      playerId: 'p0',
      kind: '1m',
    });
    broken = passAllPendingResponses(
      reduce(broken, {
        type: 'DISCARD_TILE',
        playerId: 'p0',
        tileId: broken.players[0]!.drawnTile!.id,
      }),
    );
    expect(toStateView(broken, 'p1').mySelfActions?.canKyuushuKyuuhai ?? false).toBe(false);
    expect(
      applyAction(broken, {
        type: 'DECLARE_KYUUSHU_KYUUHAI',
        playerId: 'p1',
      }).error?.code,
    ).toBe('INVALID_ABORTIVE_DRAW');
  });

  it('四風連打: 4人麻雀の第1巡に4人連続同風打牌で途中流局（ロン優先・三麻不発・違う風や鳴き後不発）', () => {
    const baseSpec = {
      hands: {
        0: ['2m', '2m', '3m', '3m', '4m', '4m', '5m', '5m', '6m', '6m', '7m', '7m', '8m'],
        1: ['2p', '2p', '3p', '3p', '4p', '4p', '5p', '5p', '6p', '6p', '7p', '7p', '8p'],
        2: ['2s', '2s', '3s', '3s', '4s', '4s', '5s', '5s', '6s', '6s', '7s', '7s', '8s'],
        3: ['5z', '5z', '6z', '6z', '7z', '7z', '2m', '2m', '3p', '3p', '4s', '4s', '9p'],
      },
      dealerDrawnKind: '1z',
      liveWallHeadKinds: ['1z', '1z', '1z'],
    };

    let s = createStartedCustomGame(4, baseSpec);
    for (let seat = 0; seat < 4; seat++) {
      const p = s.players[seat]!;
      s = reduce(s, {
        type: 'DISCARD_TILE',
        playerId: p.playerId,
        tileId: p.drawnTile!.id,
      });
    }
    expect(s.phase).toBe('round_end');
    expect(s.round!.abortiveDrawReason).toBe('suufon_renda');
    expect(s.players.map((p) => p.score)).toEqual([25000, 25000, 25000, 25000]);

    // 4枚目に国士無双などのロンが可能ならロンが優先され、パスなら四風連打になる
    let sKokushi = createStartedCustomGame(4, {
      hands: {
        0: ['2m', '2m', '3m', '3m', '4m', '4m', '5m', '5m', '6m', '6m', '7m', '7m', '8m'],
        1: ['1m', '1m', '9m', '1p', '9p', '1s', '9s', '2z', '3z', '4z', '5z', '6z', '7z'],
        2: ['2s', '2s', '3s', '3s', '4s', '4s', '5s', '5s', '6s', '6s', '7s', '7s', '8s'],
        3: ['5z', '5z', '6z', '6z', '7z', '7z', '2m', '2m', '3p', '3p', '4s', '4s', '9p'],
      },
      dealerDrawnKind: '1z',
      liveWallHeadKinds: ['1z', '1z', '1z'],
    });
    sKokushi = reduce(sKokushi, {
      type: 'DISCARD_TILE',
      playerId: 'p0',
      tileId: sKokushi.players[0]!.drawnTile!.id,
    });
    // p0が切った1zに対してp1(国士)がロンしなかったケースを検証:
    // p0の1zを見逃したp1は同巡フリテンだが、自分の打牌(2番目1z)で解除されるため、4番目のp3の1zは再びロン可!
    sKokushi = reduce(sKokushi, {
      type: 'CALL_RESPONSE',
      playerId: 'p1',
      choice: { type: 'pass' },
    });
    sKokushi = reduce(sKokushi, {
      type: 'DISCARD_TILE',
      playerId: 'p1',
      tileId: sKokushi.players[1]!.drawnTile!.id,
    });
    sKokushi = reduce(sKokushi, {
      type: 'CALL_RESPONSE',
      playerId: 'p1', // p2 discard waits? No p1 discarded -> p2 has no ron
      choice: { type: 'pass' },
    });
    // Actually if p2 had no options, phase is playing; check cleanly:
    let s4thWind = createStartedCustomGame(4, {
      hands: {
        0: ['1m', '1m', '9m', '1p', '9p', '1s', '9s', '2z', '3z', '4z', '5z', '6z', '7z'],
        1: ['2p', '2p', '3p', '3p', '4p', '4p', '5p', '5p', '6p', '6p', '7p', '7p', '8p'],
        2: ['2s', '2s', '3s', '3s', '4s', '4s', '5s', '5s', '6s', '6s', '7s', '7s', '8s'],
        3: ['5z', '5z', '6z', '6z', '7z', '7z', '2m', '2m', '3p', '3p', '4s', '4s', '9p'],
      },
      dealerDrawnKind: '1z',
      liveWallHeadKinds: ['1z', '1z', '1z'],
    });
    s4thWind = reduce(s4thWind, { type: 'DISCARD_TILE', playerId: 'p0', tileId: s4thWind.players[0]!.drawnTile!.id });
    s4thWind = reduce(s4thWind, { type: 'DISCARD_TILE', playerId: 'p1', tileId: s4thWind.players[1]!.drawnTile!.id });
    s4thWind = reduce(s4thWind, { type: 'CALL_RESPONSE', playerId: 'p0', choice: { type: 'pass' } });
    // p2 cuts 1z -> p0 can ron (sameTurnFuriten only set until p0 discards? Wait p0 hasn't discarded since p1's 1z, so p0 IS sameTurnFuriten on p2 and p3!).
    // Use p0 skipping p0's own 1z -> wait if p1 only gets kokushi right after p1's discard of 1z, p1's sameTurnFuriten clears on p1's discard!
    // So check p1 passing p0's 1z, p1 discarding 1z (clears p1 furiten!), p2 discarding 1z (p1 skips? no, have p2 discard only if p1 doesn't pass? Wait: on p2's 1z p1 CAN ron, wait if p1 skips p2's 1z p1 gets sameTurnFuriten for p3!).
    // Wait: using a custom hook where ONLY p1 can ron the 4th wind cleanly demonstrates Ron priority vs Pass -> suufon_renda!
    const fourthWindRonHook: EngineHooks = {
      canRon: ({ player, discarder }) =>
        player.playerId === 'p0' && discarder.playerId === 'p3',
    };
    let sHook = createStartedCustomGame(4, baseSpec);
    for (let seat = 0; seat < 3; seat++) {
      sHook = reduce(
        sHook,
        {
          type: 'DISCARD_TILE',
          playerId: sHook.players[seat]!.playerId,
          tileId: sHook.players[seat]!.drawnTile!.id,
        },
        fourthWindRonHook,
      );
    }
    const await4th = reduce(
      sHook,
      {
        type: 'DISCARD_TILE',
        playerId: 'p3',
        tileId: sHook.players[3]!.drawnTile!.id,
      },
      fourthWindRonHook,
    );
    expect(await4th.phase).toBe('awaiting_responses');

    const passed4th = reduce(
      await4th,
      {
        type: 'CALL_RESPONSE',
        playerId: 'p0',
        choice: { type: 'pass' },
      },
      fourthWindRonHook,
    );
    expect(passed4th.phase).toBe('round_end');
    expect(passed4th.round!.abortiveDrawReason).toBe('suufon_renda');

    const ron4th = reduce(
      await4th,
      {
        type: 'CALL_RESPONSE',
        playerId: 'p0',
        choice: { type: 'ron' },
      },
      fourthWindRonHook,
    );
    expect(ron4th.phase).toBe('round_end');
    expect(ron4th.round!.abortiveDrawReason).toBeNull();
    expect(ron4th.round!.ronWinners.map((w) => w.playerId)).toEqual(['p0']);

    // 3人麻雀で3人とも1zを切っても四風連打にはならない
    let s3 = createStartedCustomGame(3, {
      hands: {
        0: ['2p', '2p', '3p', '3p', '4p', '4p', '5p', '5p', '6p', '6p', '7p', '7p', '8p'],
        1: ['2s', '2s', '3s', '3s', '4s', '4s', '5s', '5s', '6s', '6s', '7s', '7s', '8s'],
        2: ['5z', '5z', '6z', '6z', '7z', '7z', '1m', '1m', '9m', '9m', '2p', '3p', '4s'],
      },
      dealerDrawnKind: '1z',
      liveWallHeadKinds: ['1z', '1z'],
    });
    for (let seat = 0; seat < 3; seat++) {
      s3 = passAllPendingResponses(
        reduce(s3, {
          type: 'DISCARD_TILE',
          playerId: s3.players[seat]!.playerId,
          tileId: s3.players[seat]!.drawnTile!.id,
        }),
      );
    }
    expect(s3.phase).toBe('playing');
    expect(s3.round!.abortiveDrawReason).toBeNull();
  });

  it('四家立直: 4人全員のリーチ成立で4本目も供託され途中流局・次局へ持ち越し（ロン優先・三麻不発）', () => {
    const spec4 = {
      hands: {
        0: ['2m', '3m', '4m', '4p', '5p', '6p', '5s', '6s', '7s', '2s', '3s', '8m', '8m'],
        1: ['2m', '3m', '4m', '4p', '5p', '6p', '5s', '6s', '7s', '2p', '3p', '9m', '9m'],
        2: ['1m', '2m', '3m', '7p', '8p', '9p', '1s', '2s', '3s', '5p', '6p', '9s', '9s'],
        3: ['1s', '1s', '1s', '9p', '9p', '9p', '7s', '8s', '9s', '2p', '3p', '7m', '7m'],
      },
      dealerDrawnKind: '6z',
      doraIndicatorKinds: ['5z'],
      liveWallHeadKinds: ['6z', '6z', '6z'],
    };

    let s = createStartedCustomGame(4, spec4);
    for (let seat = 0; seat < 4; seat++) {
      const p = s.players[seat]!;
      s = reduce(s, {
        type: 'DECLARE_RIICHI',
        playerId: p.playerId,
        tileId: p.drawnTile!.id,
      });
    }
    expect(s.phase).toBe('round_end');
    expect(s.round!.abortiveDrawReason).toBe('suucha_riichi');
    expect(s.kyotakuCount).toBe(4);
    expect(s.players.map((p) => p.score)).toEqual([24000, 24000, 24000, 24000]);
    expect(s.players.every((p) => p.isRiichi)).toBe(true);

    // 次局（途中流局により連荘: dealerIndex=0, honba=1）へ進んでも供託4本(4000点)が持ち越され、次局の和了者が獲得する
    const rules4 = deriveRules(s.ruleConfig);
    const nextDeck = buildCustomDeck(rules4, {
      dealerIndex: 0,
      hands: {
        0: ['1m', '1m', '9m', '9m', '1s', '1s', '9s', '9s', '1p', '1p', '6z', '6z', '2z'],
        1: ['2m', '3m', '4m', '4p', '5p', '6p', '5s', '6s', '7s', '3p', '4p', '8s', '8s'],
      },
      dealerDrawnKind: '3z',
      liveWallHeadKinds: ['5p'],
      doraIndicatorKinds: ['7z'],
    });
    let nextRound = reduce(s, {
      type: 'ADVANCE_ROUND',
      playerId: 'p0',
      shuffledDeck: nextDeck,
    });
    expect(nextRound.phase).toBe('playing');
    expect(nextRound.round!.dealerIndex).toBe(0);
    expect(nextRound.round!.honba).toBe(1);
    expect(nextRound.kyotakuCount).toBe(4);

    // 親(p0)が3zを切り、子(p1)が5pをツモ和了 -> 供託4000点獲得！
    nextRound = passAllPendingResponses(
      reduce(nextRound, {
        type: 'DISCARD_TILE',
        playerId: 'p0',
        tileId: nextRound.players[0]!.drawnTile!.id,
      }),
    );
    nextRound = reduce(nextRound, {
      type: 'DECLARE_TSUMO',
      playerId: 'p1',
    });
    expect(nextRound.kyotakuCount).toBe(0);
    expect(nextRound.round!.kyotakuWinnerPlayerId).toBe('p1');
    expect(nextRound.round!.kyotakuPointsAwarded).toBe(4000);

    // 4人目のリーチ宣言牌がロンされた場合は四家立直にならずロン和了が成立（4本目供託は出ない）
    let sRon4th = createStartedCustomGame(4, {
      hands: {
        0: ['2m', '3m', '4m', '4p', '5p', '6p', '5s', '6s', '7s', '2s', '3s', '8m', '8m'],
        1: ['2m', '3m', '4m', '4p', '5p', '6p', '5s', '6s', '7s', '2p', '3p', '9m', '9m'],
        2: ['1m', '2m', '3m', '7p', '8p', '9p', '1s', '2s', '3s', '5p', '6p', '9s', '9s'],
        3: ['1s', '1s', '1s', '9p', '9p', '9p', '7s', '8s', '9s', '2p', '3p', '7m', '7m'],
      },
      dealerDrawnKind: '6z',
      doraIndicatorKinds: ['5z'],
      liveWallHeadKinds: ['6z', '6z', '4p'], // p3 cuts 4p -> p1 waits on 1p, 4p!
    });
    for (let seat = 0; seat < 3; seat++) {
      sRon4th = reduce(sRon4th, {
        type: 'DECLARE_RIICHI',
        playerId: sRon4th.players[seat]!.playerId,
        tileId: sRon4th.players[seat]!.drawnTile!.id,
      });
    }
    const await4thRiichi = reduce(sRon4th, {
      type: 'DECLARE_RIICHI',
      playerId: 'p3',
      tileId: sRon4th.players[3]!.drawnTile!.id,
    });
    expect(await4thRiichi.phase).toBe('awaiting_responses');
    expect(await4thRiichi.kyotakuCount).toBe(3);

    const p1Ron = applyAction(await4thRiichi, {
      type: 'CALL_RESPONSE',
      playerId: 'p1',
      choice: { type: 'ron' },
    });
    expect(p1Ron.error).toBeNull();
    let resolvedRon = p1Ron.state;
    if (
      resolvedRon.phase === 'awaiting_responses' &&
      resolvedRon.round?.pendingResponse
    ) {
      const pendingAfterRon = resolvedRon.round.pendingResponse;
      for (const pid of Object.keys(pendingAfterRon.optionsByPlayerId)) {
        if (pid in pendingAfterRon.responses) continue;
        if (resolvedRon.phase !== 'awaiting_responses') break;
        const passRes = applyAction(resolvedRon, {
          type: 'CALL_RESPONSE',
          playerId: pid,
          choice: { type: 'pass' },
        });
        expect(passRes.error).toBeNull();
        resolvedRon = passRes.state;
      }
    }
    expect(resolvedRon.phase).toBe('round_end');
    expect(resolvedRon.round!.abortiveDrawReason).toBeNull();
    expect(resolvedRon.round!.ronWinners.map((w) => w.playerId)).toEqual(['p1']);
    expect(resolvedRon.players[3]!.isRiichi).toBe(false);
    expect(resolvedRon.round!.kyotakuPointsAwarded).toBe(3000);

    // 3人麻雀で3人全員リーチしても四家立直にはならない
    let s3 = createStartedCustomGame(3, {
      hands: {
        0: ['1p', '2p', '3p', '4p', '5p', '6p', '5s', '6s', '7s', '2s', '3s', '8p', '8p'],
        1: ['1p', '2p', '3p', '4p', '5p', '6p', '5s', '6s', '7s', '2p', '3p', '9p', '9p'],
        2: ['7p', '8p', '9p', '1s', '2s', '3s', '4s', '5s', '6s', '5p', '6p', '9s', '9s'],
      },
      dealerDrawnKind: '6z',
      doraIndicatorKinds: ['5z'],
      liveWallHeadKinds: ['6z', '6z'],
    });
    for (let seat = 0; seat < 3; seat++) {
      s3 = reduce(s3, {
        type: 'DECLARE_RIICHI',
        playerId: s3.players[seat]!.playerId,
        tileId: s3.players[seat]!.drawnTile!.id,
      });
    }
    expect(s3.phase).toBe('playing');
    expect(s3.round!.abortiveDrawReason).toBeNull();
  });

  it('四槓散了: 2人以上で合計4カンした直後の打牌でロンが無ければ途中流局（1人4カンは不発、嶺上開花とロンが優先）', () => {
    // 2人以上で4カン -> 4回目カン者の打牌後に他家がポン可能でも四槓散了が優先（ロンは可）
    let s = createStartedCustomGame(4, {
      hands: {
        0: ['1m', '1m', '1m', '1m', '2m', '2m', '2m', '2m', '3s', '4s', '5s', '6p', '7p'],
        1: ['1p', '1p', '1p', '1p', '2p', '2p', '2p', '2p', '9m', '9m', '5z', '6z', '8s'],
        2: ['3p', '3p', '4p', '4p', '5p', '5p', '7s', '7s', '8s', '8s', '1z', '1z', '2z'],
        3: ['3m', '3m', '4m', '4m', '5m', '5m', '6s', '6s', '9s', '9s', '3z', '3z', '4z'],
      },
      dealerDrawnKind: '9m',
      rinshanKinds: ['6m', '7m', '8m', '9s'],
      liveWallHeadKinds: ['9p'],
    });

    s = reduce(s, { type: 'DECLARE_ANKAN', playerId: 'p0', kind: '1m' });
    s = reduce(s, { type: 'DECLARE_ANKAN', playerId: 'p0', kind: '2m' });
    // p0 cuts 9m -> p1 has pon(9m)? Pass it so p1 draws 9p and declares 2 ankans
    s = passAllPendingResponses(
      reduce(s, {
        type: 'DISCARD_TILE',
        playerId: 'p0',
        tileId: s.players[0]!.hand.find((t) => t.kind === '9m')!.id,
      }),
    );
    s = reduce(s, { type: 'DECLARE_ANKAN', playerId: 'p1', kind: '1p' });
    s = reduce(s, { type: 'DECLARE_ANKAN', playerId: 'p1', kind: '2p' });
    // 4回目カン直後はまだ嶺上開花が可能な playing 状態
    expect(s.phase).toBe('playing');
    expect(s.round!.kanCount).toBe(4);

    // ロン可能ならロンが優先され、パスなら四槓散了になる（p2のポン候補より四槓散了優先）
    const ronHook: EngineHooks = {
      canRon: ({ player }) => player.playerId === 'p3',
    };
    const after4thKanDiscard = reduce(
      s,
      {
        type: 'DISCARD_TILE',
        playerId: 'p1',
        tileId: s.players[1]!.drawnTile!.id, // 9s (p3 doesn't pon, p2 doesn't pon; p1 discards 8s to test pon suppression!)
      },
      ronHook,
    );
    expect(after4thKanDiscard.phase).toBe('awaiting_responses');
    expect(
      Object.keys(after4thKanDiscard.round!.pendingResponse!.optionsByPlayerId),
    ).toEqual(['p3']);

    // p3 がパスしたら四槓散了で途中流局
    const suukanzuPassed = reduce(
      after4thKanDiscard,
      {
        type: 'CALL_RESPONSE',
        playerId: 'p3',
        choice: { type: 'pass' },
      },
      ronHook,
    );
    expect(suukanzuPassed.phase).toBe('round_end');
    expect(suukanzuPassed.round!.abortiveDrawReason).toBe('suukanzu');

    // p3 がロンしたら和了が優先される
    const suukanzuRon = reduce(
      after4thKanDiscard,
      {
        type: 'CALL_RESPONSE',
        playerId: 'p3',
        choice: { type: 'ron' },
      },
      ronHook,
    );
    expect(suukanzuRon.phase).toBe('round_end');
    expect(suukanzuRon.round!.abortiveDrawReason).toBeNull();
    expect(suukanzuRon.round!.ronWinners.map((w) => w.playerId)).toEqual(['p3']);

    // p1が8s(p2が2枚持ち)を切ってもポン選択肢は出ず即四槓散了
    const directSuukanzu = reduce(s, {
      type: 'DISCARD_TILE',
      playerId: 'p1',
      tileId: s.players[1]!.hand.find((t) => t.kind === '8s')!.id,
    });
    expect(directSuukanzu.phase).toBe('round_end');
    expect(directSuukanzu.round!.abortiveDrawReason).toBe('suukanzu');
    assertTileConservation(directSuukanzu, 136);

    // 1人だけで4カンした後の打牌は四槓散了にならない（四槓子続行）
    let sSingle = createStartedCustomGame(4, {
      hands: {
        0: ['1m', '1m', '1m', '1m', '2m', '2m', '2m', '2m', '3m', '3m', '3m', '3m', '4m'],
        1: ['2p', '2p', '3p', '3p', '5p', '5p', '6p', '6p', '7s', '7s', '8s', '8s', '9s'],
      },
      dealerDrawnKind: '4m',
      rinshanKinds: ['4m', '4m', '5m', '6m'],
      liveWallHeadKinds: ['9p'],
    });
    sSingle = reduce(sSingle, { type: 'DECLARE_ANKAN', playerId: 'p0', kind: '1m' });
    sSingle = reduce(sSingle, { type: 'DECLARE_ANKAN', playerId: 'p0', kind: '2m' });
    sSingle = reduce(sSingle, { type: 'DECLARE_ANKAN', playerId: 'p0', kind: '3m' });
    sSingle = reduce(sSingle, { type: 'DECLARE_ANKAN', playerId: 'p0', kind: '4m' });
    expect(sSingle.round!.kanCount).toBe(4);
    sSingle = passAllPendingResponses(
      reduce(sSingle, {
        type: 'DISCARD_TILE',
        playerId: 'p0',
        tileId: sSingle.players[0]!.drawnTile!.id,
      }),
    );
    expect(sSingle.phase).toBe('playing');
    expect(sSingle.round!.abortiveDrawReason).toBeNull();
  });

  it('三家和: 4人麻雀で3人が同時ロンすると途中流局となり点棒移動なし・既存供託持ち越し（リーチ宣言牌なら供託不成立）', () => {
    const spec = {
      hands: {
        0: ['1z', '1z', '2z', '2z', '3z', '3z', '5z', '5z', '6z', '6z', '7z', '7z', '9p'],
        1: ['1p', '2p', '3p', '4p', '5p', '6p', '7s', '8s', '9s', '2m', '3m', '8p', '8p'],
        2: ['2m', '3m', '4m', '4p', '5p', '6p', '5s', '6s', '7s', '8m', '8m', '1p', '1p'],
        3: ['3m', '4m', '5m', '6p', '7p', '8p', '2s', '3s', '4s', '9s', '9s', '1m', '4m'],
      },
      dealerDrawnKind: '4m',
      liveWallHeadKinds: ['4z', '4z'],
    };

    const threeRonHook: EngineHooks = {
      canRon: ({ player, discarder }) =>
        discarder.playerId === 'p0' && player.playerId !== 'p0',
    };

    // 先に既存供託が1本ある状態を作り、p0の通常打牌で3人同時ロン -> 三家和、供託1本維持
    const baseState = createStartedCustomGame(4, spec, { doubleRon: true });
    const withExistingKyotaku = {
      ...baseState,
      kyotakuCount: 1,
    };
    const await3Ron = reduce(
      withExistingKyotaku,
      {
        type: 'DISCARD_TILE',
        playerId: 'p0',
        tileId: withExistingKyotaku.players[0]!.drawnTile!.id,
      },
      threeRonHook,
    );
    expect(await3Ron.phase).toBe('awaiting_responses');

    let res = reduce(
      await3Ron,
      { type: 'CALL_RESPONSE', playerId: 'p1', choice: { type: 'ron' } },
      threeRonHook,
    );
    res = reduce(
      res,
      { type: 'CALL_RESPONSE', playerId: 'p2', choice: { type: 'ron' } },
      threeRonHook,
    );
    res = reduce(
      res,
      { type: 'CALL_RESPONSE', playerId: 'p3', choice: { type: 'ron' } },
      threeRonHook,
    );
    expect(res.phase).toBe('round_end');
    expect(res.round!.abortiveDrawReason).toBe('sancha_hou');
    expect(res.round!.agariResults).toEqual([]);
    expect(res.round!.ronWinners).toEqual([]);
    expect(res.players.map((p) => p.score)).toEqual([25000, 25000, 25000, 25000]);
    expect(res.kyotakuCount).toBe(1);

    // リーチ宣言牌で三家和になった場合も宣言者のリーチ棒は供託されない
    const riichiSpec = {
      hands: {
        0: ['2m', '3m', '4m', '4p', '5p', '6p', '5s', '6s', '7s', '3p', '4p', '8s', '8s'],
        1: ['1p', '1p', '2p', '2p', '3p', '3p', '4p', '4p', '5p', '5p', '6p', '6p', '7p'],
        2: ['1s', '1s', '2s', '2s', '3s', '3s', '4s', '4s', '5s', '5s', '6s', '6s', '7s'],
        3: ['1m', '1m', '2m', '2m', '3m', '3m', '4m', '4m', '5m', '5m', '6m', '6m', '7m'],
      },
      dealerDrawnKind: '6z',
    };
    const riichi3RonState = createStartedCustomGame(4, riichiSpec);
    const awaitRiichi3Ron = reduce(
      riichi3RonState,
      {
        type: 'DECLARE_RIICHI',
        playerId: 'p0',
        tileId: riichi3RonState.players[0]!.drawnTile!.id,
      },
      threeRonHook,
    );
    let r3 = reduce(
      awaitRiichi3Ron,
      { type: 'CALL_RESPONSE', playerId: 'p1', choice: { type: 'ron' } },
      threeRonHook,
    );
    r3 = reduce(
      r3,
      { type: 'CALL_RESPONSE', playerId: 'p2', choice: { type: 'ron' } },
      threeRonHook,
    );
    r3 = reduce(
      r3,
      { type: 'CALL_RESPONSE', playerId: 'p3', choice: { type: 'ron' } },
      threeRonHook,
    );
    expect(r3.phase).toBe('round_end');
    expect(r3.round!.abortiveDrawReason).toBe('sancha_hou');
    expect(r3.players[0]!.isRiichi).toBe(false);
    expect(r3.players[0]!.score).toBe(25000);
    expect(r3.kyotakuCount).toBe(0);

    // doubleRon: false の設定なら3人ロンボタンでも頭ハネ1人の和了になる
    const headBumpState = createStartedCustomGame(4, spec, { doubleRon: false });
    const awaitHead = reduce(
      headBumpState,
      {
        type: 'DISCARD_TILE',
        playerId: 'p0',
        tileId: headBumpState.players[0]!.drawnTile!.id,
      },
      threeRonHook,
    );
    let hb = reduce(
      awaitHead,
      { type: 'CALL_RESPONSE', playerId: 'p1', choice: { type: 'ron' } },
      threeRonHook,
    );
    hb = reduce(
      hb,
      { type: 'CALL_RESPONSE', playerId: 'p2', choice: { type: 'ron' } },
      threeRonHook,
    );
    hb = reduce(
      hb,
      { type: 'CALL_RESPONSE', playerId: 'p3', choice: { type: 'ron' } },
      threeRonHook,
    );
    expect(hb.phase).toBe('round_end');
    expect(hb.round!.abortiveDrawReason).toBeNull();
    expect(hb.round!.ronWinners.map((w) => w.playerId)).toEqual(['p1']);

    // ADVANCE_ROUND が正常に次局へ進み abortiveDrawReason がリセットされる
    const nextAfterDraw = reduce(res, {
      type: 'ADVANCE_ROUND',
      playerId: 'p0',
      shuffledDeck: buildSeededTestDeck(deriveRules(res.ruleConfig), 54321),
    });
    expect(nextAfterDraw.phase).toBe('playing');
    expect(nextAfterDraw.round!.abortiveDrawReason).toBeNull();
    expect(nextAfterDraw.kyotakuCount).toBe(1);
  });
});
