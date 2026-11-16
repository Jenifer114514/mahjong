import { describe, expect, it } from 'vitest';
import type { EngineHooks } from '../calls';
import { toStateView } from '../projection';
import { applyAction, reduce } from '../reducer';
import {
  assertTileConservation,
  createStartedCustomGame,
  passAllPendingResponses,
} from './testHelpers';

describe('第2段階: ポン・チー・喰い替え・三麻チー禁止', () => {
  it('ポン成立後に手牌が減り、喰い替え牌(切った現物)は即打牌禁止され、他牌打牌で解除される', () => {
    let state = createStartedCustomGame(4, {
      hands: {
        0: ['1m', '1m', '2m', '2m', '3m', '3m', '4m', '4m', '5m', '5m', '6m', '6m', '9p'],
        1: ['2p', '2p', '3p', '3p', '4p', '4p', '5p', '5p', '6p', '6p', '1p', '1p', '2z'],
        2: ['9p', '9p', '7s', '7s', '8s', '8s', '9s', '9s', '1z', '1z', '2z', '2z', '3z'],
        3: ['1s', '1s', '2s', '2s', '3s', '3s', '4s', '4s', '5s', '5s', '6s', '6s', '7m'],
      },
      dealerDrawnKind: '9p',
    });

    const p0Drawn = state.players[0]!.drawnTile!;
    expect(p0Drawn.kind).toBe('9p');

    state = reduce(state, {
      type: 'DISCARD_TILE',
      playerId: 'p0',
      tileId: p0Drawn.id,
    });
    expect(state.phase).toBe('awaiting_responses');

    const p2View = toStateView(state, 'p2');
    expect(p2View.myCallOptions?.canPon).toBe(true);
    expect(p2View.myCallOptions?.chiOptions).toHaveLength(0);

    // ポン実行
    const afterPon = applyAction(state, {
      type: 'CALL_RESPONSE',
      playerId: 'p2',
      choice: { type: 'pon' },
    });
    expect(afterPon.error).toBeNull();
    state = afterPon.state;
    assertTileConservation(state, 136);

    expect(state.phase).toBe('playing');
    expect(state.round!.currentTurnIndex).toBe(2);
    expect(state.players[2]!.hand).toHaveLength(11);
    expect(state.players[2]!.drawnTile).toBeNull();
    expect(state.players[2]!.melds).toHaveLength(1);
    expect(state.players[2]!.melds[0]!.type).toBe('pon');
    expect(state.round!.kuikaeForbiddenKinds).toEqual(['9p']);

    // 9p が1枚余っている状態で喰い替え打牌が拒否されることを確認
    let stateExtra = createStartedCustomGame(4, {
      hands: {
        0: ['1m', '1m', '2m', '2m', '3m', '3m', '4m', '4m', '5m', '5m', '6m', '6m', '7m'],
        1: ['1p', '1p', '2p', '2p', '3p', '3p', '4p', '4p', '5p', '5p', '6p', '6p', '7p'],
        2: ['9p', '9p', '9p', '7s', '7s', '8s', '8s', '9s', '9s', '1z', '1z', '2z', '3z'],
        3: ['1s', '1s', '2s', '2s', '3s', '3s', '4s', '4s', '5s', '5s', '6s', '6s', '8p'],
      },
      dealerDrawnKind: '9p',
    });
    stateExtra = reduce(stateExtra, {
      type: 'DISCARD_TILE',
      playerId: 'p0',
      tileId: stateExtra.players[0]!.drawnTile!.id,
    });
    stateExtra = reduce(stateExtra, {
      type: 'CALL_RESPONSE',
      playerId: 'p2',
      choice: { type: 'pon' },
    });
    const extra9p = stateExtra.players[2]!.hand.find((t) => t.kind === '9p')!;
    const kuikaeErr = applyAction(stateExtra, {
      type: 'DISCARD_TILE',
      playerId: 'p2',
      tileId: extra9p.id,
    });
    expect(kuikaeErr.error?.code).toBe('FORBIDDEN_KUIKAE');

    // 別の牌 (3z) を切れば成功し、喰い替え禁止も解除される
    const legalTile = stateExtra.players[2]!.hand.find((t) => t.kind === '3z')!;
    const afterLegal = applyAction(stateExtra, {
      type: 'DISCARD_TILE',
      playerId: 'p2',
      tileId: legalTile.id,
    });
    expect(afterLegal.error).toBeNull();
    expect(afterLegal.state.round!.kuikaeForbiddenKinds).toEqual([]);
    assertTileConservation(afterLegal.state, 136);
  });

  it('チーは4人麻雀の下家のみ可能で、筋喰い替えも含め禁止される', () => {
    let state = createStartedCustomGame(4, {
      hands: {
        0: ['1z', '1z', '2z', '2z', '3z', '3z', '5z', '5z', '6z', '6z', '7z', '7z', '8p'],
        1: ['2m', '3m', '4m', '5p', '5p', '6p', '6p', '7s', '7s', '8s', '8s', '9s', '9s'],
        2: ['2m', '3m', '7p', '7p', '1p', '1p', '2p', '2p', '3p', '3p', '4p', '4p', '6s'],
        3: ['5m', '5m', '6m', '6m', '7m', '7m', '8m', '8m', '9m', '9m', '1s', '1s', '2s'],
      },
      dealerDrawnKind: '1m',
    });

    // p0 が 1m を打牌 -> 下家 p1 のみ 2m-3m でチーできる（対面 p2 はチー不可）
    state = reduce(state, {
      type: 'DISCARD_TILE',
      playerId: 'p0',
      tileId: state.players[0]!.drawnTile!.id,
    });
    expect(state.phase).toBe('awaiting_responses');
    expect(toStateView(state, 'p1').myCallOptions?.chiOptions).toHaveLength(1);
    expect(toStateView(state, 'p2').myCallOptions).toBeNull();

    const chiChoice = toStateView(state, 'p1').myCallOptions!.chiOptions[0]!;
    state = reduce(state, {
      type: 'CALL_RESPONSE',
      playerId: 'p1',
      choice: {
        type: 'chi',
        tileIds: [chiChoice.tiles[0].id, chiChoice.tiles[1].id],
      },
    });
    expect(state.phase).toBe('playing');
    expect(state.round!.currentTurnIndex).toBe(1);
    expect(state.players[1]!.melds[0]!.type).toBe('chi');
    // 2m-3m で 1m をチーしたので 1m と 4m の両方が喰い替え禁止
    expect(state.round!.kuikaeForbiddenKinds).toEqual(['1m', '4m']);

    const forbidden4m = state.players[1]!.hand.find((t) => t.kind === '4m')!;
    const err4m = applyAction(state, {
      type: 'DISCARD_TILE',
      playerId: 'p1',
      tileId: forbidden4m.id,
    });
    expect(err4m.error?.code).toBe('FORBIDDEN_KUIKAE');
    assertTileConservation(state, 136);
  });

  it('喰い替えにより切る牌が一切残らない鳴き候補は最初から提示されない', () => {
    // p1 に3回ポンさせて残り4枚 [2m, 3m, 4m, 4m] にした後、上家 p0 が 1m を切る -> 1m/4m しか残らないためチー不可
    let state = createStartedCustomGame(4, {
      hands: {
        0: ['5s', '6s', '7s', '1m', '1z', '1z', '2z', '2z', '3z', '3z', '5z', '5z', '6z'],
        1: ['5s', '5s', '6s', '6s', '7s', '7s', '2m', '3m', '4m', '4m', '8p', '9p', '1s'],
        2: ['1p', '1p', '2p', '2p', '3p', '3p', '4p', '4p', '5p', '5p', '6p', '6p', '7p'],
        3: ['2s', '2s', '3s', '3s', '4s', '4s', '8s', '8s', '9s', '9s', '7m', '7m', '8m'],
      },
      dealerDrawnKind: '6z',
      liveWallHeadKinds: ['9m', '8m', '7p', '9s', '9s', '8p'],
    });

    // Helper: p0 が targetKind を切り、p1 がポンして、p1 が不要牌を捨てるを3回繰り返す
    const ponAndDiscard = (ponKind: string, discardKind: string) => {
      const p0Tile = state.players[0]!.hand.find((t) => t.kind === ponKind)!;
      state = reduce(state, {
        type: 'DISCARD_TILE',
        playerId: 'p0',
        tileId: p0Tile.id,
      });
      state = reduce(state, {
        type: 'CALL_RESPONSE',
        playerId: 'p1',
        choice: { type: 'pon' },
      });
      const p1Discard = state.players[1]!.hand.find((t) => t.kind === discardKind)!;
      state = passAllPendingResponses(
        reduce(state, {
          type: 'DISCARD_TILE',
          playerId: 'p1',
          tileId: p1Discard.id,
        }),
      );
      // p2 -> p3 -> p0 のツモ切りで p0 に手番を戻す
      for (const pid of ['p2', 'p3']) {
        state = passAllPendingResponses(
          reduce(state, {
            type: 'DISCARD_TILE',
            playerId: pid,
            tileId: state.players.find((p) => p.playerId === pid)!.drawnTile!.id,
          }),
        );
      }
    };

    ponAndDiscard('5s', '8p');
    ponAndDiscard('6s', '9p');
    ponAndDiscard('7s', '1s');

    // p1 の手牌は [2m, 3m, 4m, 4m] の4枚だけになった
    expect(state.players[1]!.hand.map((t) => t.kind)).toEqual(['2m', '3m', '4m', '4m']);

    // p0 が 1m を打牌 -> 2m+3m でチーすると残りが 4m,4m のみ（喰い替え禁止牌だけ）になるためチー不可！
    const oneM = state.players[0]!.hand.find((t) => t.kind === '1m')!;
    const afterOneM = reduce(state, {
      type: 'DISCARD_TILE',
      playerId: 'p0',
      tileId: oneM.id,
    });
    expect(afterOneM.phase).toBe('playing');
    expect(afterOneM.round!.currentTurnIndex).toBe(1);
    expect(toStateView(afterOneM, 'p1').myCallOptions).toBeNull();
  });

  it('3人麻雀では下家であってもチー不可（allowChi = false）', () => {
    const state = createStartedCustomGame(3, {
      hands: {
        0: ['1z', '1z', '2z', '2z', '3z', '3z', '5z', '5z', '6z', '6z', '7z', '7z', '8p'],
        1: ['2p', '3p', '5p', '5p', '6p', '6p', '7s', '7s', '8s', '8s', '9s', '9s', '1m'],
        2: ['2s', '2s', '3s', '3s', '4s', '4s', '5s', '5s', '6s', '6s', '9m', '9m', '4z'],
      },
      dealerDrawnKind: '1p',
    });

    const after = reduce(state, {
      type: 'DISCARD_TILE',
      playerId: 'p0',
      tileId: state.players[0]!.drawnTile!.id,
    });
    // 1p を捨てても3麻ではチーできないので応答待ちにならず次家 p1 のツモへ進む
    expect(after.phase).toBe('playing');
    expect(after.round!.currentTurnIndex).toBe(1);
  });
});

describe('第2段階: 優先順位 (ロン > ポン/大明槓 > チー) と ダブロン/頭ハネ', () => {
  it('チー・ポン・ロンが同時発生するとロンが最優先され、ロンなしならポンがチーに勝つ', () => {
    const baseSpec = {
      hands: {
        0: ['1z', '1z', '2z', '2z', '3z', '3z', '5z', '5z', '6z', '6z', '7z', '7z', '9p'],
        1: ['2m', '3m', '5p', '5p', '6p', '6p', '7s', '7s', '8s', '8s', '9s', '9s', '8p'],
        2: ['1m', '1m', '4p', '4p', '5p', '6p', '7p', '8p', '9p', '1s', '2s', '3s', '4s'],
        3: ['7m', '7m', '8m', '8m', '9m', '9m', '2p', '2p', '3p', '3p', '4s', '5s', '6s'],
      },
      dealerDrawnKind: '1m',
    };

    const hooksWithP3Ron: EngineHooks = {
      canRon: ({ player }) => player.playerId === 'p3',
    };

    // Case 1: p1 チー, p2 ポン, p3 ロン -> p3 のロンが勝つ
    let s1 = createStartedCustomGame(4, baseSpec);
    s1 = reduce(
      s1,
      {
        type: 'DISCARD_TILE',
        playerId: 'p0',
        tileId: s1.players[0]!.drawnTile!.id,
      },
      hooksWithP3Ron,
    );
    expect(s1.phase).toBe('awaiting_responses');

    const p1Chi = toStateView(s1, 'p1').myCallOptions!.chiOptions[0]!;
    s1 = reduce(s1, {
      type: 'CALL_RESPONSE',
      playerId: 'p1',
      choice: { type: 'chi', tileIds: [p1Chi.tiles[0].id, p1Chi.tiles[1].id] },
    });
    s1 = reduce(s1, {
      type: 'CALL_RESPONSE',
      playerId: 'p2',
      choice: { type: 'pon' },
    });
    expect(s1.phase).toBe('awaiting_responses'); // p3のロン応答を待つ

    s1 = reduce(s1, {
      type: 'CALL_RESPONSE',
      playerId: 'p3',
      choice: { type: 'ron' },
    });
    expect(s1.phase).toBe('round_end');
    expect(s1.round!.ronWinners.map((w) => w.playerId)).toEqual(['p3']);
    assertTileConservation(s1, 136);

    // Case 2: ロン無し（p1 チー vs p2 ポン）-> p2 のポンが勝つ
    let s2 = createStartedCustomGame(4, baseSpec);
    s2 = reduce(s2, {
      type: 'DISCARD_TILE',
      playerId: 'p0',
      tileId: s2.players[0]!.drawnTile!.id,
    });
    const s2Chi = toStateView(s2, 'p1').myCallOptions!.chiOptions[0]!;
    s2 = reduce(s2, {
      type: 'CALL_RESPONSE',
      playerId: 'p1',
      choice: { type: 'chi', tileIds: [s2Chi.tiles[0].id, s2Chi.tiles[1].id] },
    });
    s2 = reduce(s2, {
      type: 'CALL_RESPONSE',
      playerId: 'p2',
      choice: { type: 'pon' },
    });
    expect(s2.phase).toBe('playing');
    expect(s2.round!.currentTurnIndex).toBe(2);
    expect(s2.players[2]!.melds[0]!.type).toBe('pon');
    assertTileConservation(s2, 136);
  });

  it('doubleRon: true でダブロン、doubleRon: false で頭ハネになる', () => {
    const spec = {
      hands: {
        0: ['1z', '1z', '2z', '2z', '3z', '3z', '5z', '5z', '6z', '6z', '7z', '7z', '9p'],
        1: ['2m', '2m', '3m', '3m', '4m', '4m', '5m', '5m', '6m', '6m', '7m', '7m', '8p'],
        2: ['1p', '1p', '2p', '2p', '3p', '3p', '4p', '4p', '5p', '5p', '6p', '6p', '7p'],
        3: ['1s', '1s', '2s', '2s', '3s', '3s', '4s', '4s', '5s', '5s', '6s', '6s', '7s'],
      },
      dealerDrawnKind: '9m',
    };
    const hooksTwoRon: EngineHooks = {
      canRon: ({ player }) =>
        player.playerId === 'p1' || player.playerId === 'p3',
    };

    // doubleRon: true
    let sDouble = createStartedCustomGame(4, spec, { doubleRon: true });
    sDouble = reduce(
      sDouble,
      {
        type: 'DISCARD_TILE',
        playerId: 'p0',
        tileId: sDouble.players[0]!.drawnTile!.id,
      },
      hooksTwoRon,
    );
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
    // 上家・下家順（p0 から見て p1 が距離1、p3 が距離3）
    expect(sDouble.round!.ronWinners.map((w) => w.playerId)).toEqual(['p1', 'p3']);

    // doubleRon: false（頭ハネ）
    let sHead = createStartedCustomGame(4, spec, { doubleRon: false });
    sHead = reduce(
      sHead,
      {
        type: 'DISCARD_TILE',
        playerId: 'p0',
        tileId: sHead.players[0]!.drawnTile!.id,
      },
      hooksTwoRon,
    );
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
    expect(sHead.phase).toBe('round_end');
    expect(sHead.round!.ronWinners.map((w) => w.playerId)).toEqual(['p1']);
  });
});

describe('第2段階: 暗槓・大明槓・加槓・王牌補充・カンドラタイミング・4カン上限', () => {
  it('暗槓(即めくり)・大明槓(打牌後めくり)・加槓(打牌後めくり)と王牌14枚維持が正しく動く', () => {
    let state = createStartedCustomGame(4, {
      hands: {
        0: ['1m', '1m', '1m', '2p', '2p', '2p', '3p', '3p', '4p', '4p', '5p', '5p', '6p'],
        1: ['7s', '7s', '7s', '2m', '2m', '3m', '3m', '4m', '4m', '5m', '5m', '6m', '6m'],
        2: ['8s', '8s', '8s', '9s', '9s', '1s', '1s', '2s', '2s', '3s', '3s', '4s', '4s'],
        3: ['1z', '1z', '2z', '2z', '3z', '3z', '5z', '5z', '6z', '6z', '7z', '7z', '9p'],
      },
      dealerDrawnKind: '1m',
      rinshanKinds: ['8m', '9m', '6p', '7p'],
    });

    // 1. p0 が 1m を暗槓 -> 即ドラ2枚公開・嶺上牌8mツモ・山末尾が王牌へ補充
    const viewBefore = toStateView(state, 'p0');
    expect(viewBefore.mySelfActions?.canAnkanKinds).toEqual(['1m']);
    expect(viewBefore.round?.doraIndicators).toHaveLength(1);

    const wallTailKind =
      state.round!.wall[state.round!.wall.length - 1]!.kind;

    state = reduce(state, {
      type: 'DECLARE_ANKAN',
      playerId: 'p0',
      kind: '1m',
    });
    assertTileConservation(state, 136);
    expect(state.round!.kanCount).toBe(1);
    expect(state.round!.deadWall.revealedDoraCount).toBe(2); // immediate
    expect(state.players[0]!.drawnTile!.kind).toBe('8m');
    expect(state.players[0]!.melds[0]!.type).toBe('ankan');
    expect(state.players[0]!.melds[0]!.fromSeatIndex).toBeNull();
    expect(
      state.round!.deadWall.rinshanTiles[
        state.round!.deadWall.rinshanTiles.length - 1
      ]!.kind,
    ).toBe(wallTailKind);

    // 2. 大明槓 (after_discard) を検証
    let kState = createStartedCustomGame(4, {
      hands: {
        0: ['7s', '1m', '1m', '2m', '2m', '3m', '3m', '4m', '4m', '5m', '5m', '6m', '6m'],
        1: ['7s', '7s', '7s', '9s', '9s', '1p', '1p', '2p', '2p', '3p', '3p', '4p', '4p'],
        2: ['8s', '8s', '8s', '5p', '5p', '6p', '6p', '7p', '7p', '8p', '8p', '9p', '9p'],
        3: ['1z', '1z', '2z', '2z', '3z', '3z', '5z', '5z', '6z', '6z', '7z', '7z', '4z'],
      },
      dealerDrawnKind: '3z',
      rinshanKinds: ['1s', '2s', '3s', '4s'],
    });

    const p0SevenS = kState.players[0]!.hand.find((t) => t.kind === '7s')!;
    kState = reduce(kState, {
      type: 'DISCARD_TILE',
      playerId: 'p0',
      tileId: p0SevenS.id,
    });
    expect(toStateView(kState, 'p1').myCallOptions?.canDaiminkan).toBe(true);

    kState = reduce(kState, {
      type: 'CALL_RESPONSE',
      playerId: 'p1',
      choice: { type: 'daiminkan' },
    });
    assertTileConservation(kState, 136);
    expect(kState.round!.kanCount).toBe(1);
    expect(kState.round!.deadWall.revealedDoraCount).toBe(1);
    expect(kState.round!.deadWall.pendingKandoraCount).toBe(1);
    expect(kState.players[1]!.drawnTile!.kind).toBe('1s');

    // p1 が嶺上ツモの 1s を切る（ロンなし）-> カンドラがめくられて2枚になる
    kState = reduce(kState, {
      type: 'DISCARD_TILE',
      playerId: 'p1',
      tileId: kState.players[1]!.drawnTile!.id,
    });
    expect(kState.round!.deadWall.revealedDoraCount).toBe(2);
    expect(kState.round!.deadWall.pendingKandoraCount).toBe(0);

    // 3. 加槓 (after_discard) + ロン時非めくりを検証
    let kakanState = createStartedCustomGame(4, {
      hands: {
        0: ['5z', '1m', '1m', '2m', '2m', '3m', '3m', '4m', '4m', '5m', '5m', '6m', '6m'],
        1: ['1p', '1p', '2p', '2p', '3p', '3p', '4p', '4p', '5p', '5p', '6p', '6p', '8p'],
        2: ['5z', '5z', '5z', '7p', '7p', '8p', '8p', '9p', '9p', '1s', '1s', '2s', '2s'],
        3: ['3s', '3s', '4s', '4s', '5s', '5s', '6s', '6s', '7s', '7s', '8s', '8s', '9s'],
      },
      dealerDrawnKind: '3z',
      liveWallHeadKinds: ['9m', '8m', '7m', '7z'],
    });

    // p0 が 5z を打牌 -> p2 がポン（手牌に3枚あるうちの2枚を使い1枚残る）
    kakanState = reduce(kakanState, {
      type: 'DISCARD_TILE',
      playerId: 'p0',
      tileId: kakanState.players[0]!.hand.find((t) => t.kind === '5z')!.id,
    });
    kakanState = reduce(kakanState, {
      type: 'CALL_RESPONSE',
      playerId: 'p2',
      choice: { type: 'pon' },
    });
    // ポン直後の打牌前には加槓できない（drawnTile === null）
    expect(toStateView(kakanState, 'p2').mySelfActions).toBeNull();
    const kakanBeforeDiscardErr = applyAction(kakanState, {
      type: 'DECLARE_KAKAN',
      playerId: 'p2',
      tileId: kakanState.players[2]!.hand.find((t) => t.kind === '5z')!.id,
    });
    expect(kakanBeforeDiscardErr.error?.code).toBe('INVALID_CALL');

    // p2(2s) -> p3 -> p0 -> p1 と1巡回して p2 がツモった後に加槓
    kakanState = passAllPendingResponses(
      reduce(kakanState, {
        type: 'DISCARD_TILE',
        playerId: 'p2',
        tileId: kakanState.players[2]!.hand.find((t) => t.kind === '2s')!.id,
      }),
    );
    kakanState = passAllPendingResponses(
      reduce(kakanState, {
        type: 'DISCARD_TILE',
        playerId: 'p3',
        tileId: kakanState.players[3]!.drawnTile!.id,
      }),
    );
    kakanState = passAllPendingResponses(
      reduce(kakanState, {
        type: 'DISCARD_TILE',
        playerId: 'p0',
        tileId: kakanState.players[0]!.drawnTile!.id,
      }),
    );
    kakanState = passAllPendingResponses(
      reduce(kakanState, {
        type: 'DISCARD_TILE',
        playerId: 'p1',
        tileId: kakanState.players[1]!.drawnTile!.id,
      }),
    );

    // p2 の手番（ツモ済み） -> 手牌の 5z で加槓可能！
    const p2View = toStateView(kakanState, 'p2');
    const fiveZId = kakanState.players[2]!.hand.find((t) => t.kind === '5z')!.id;
    expect(p2View.mySelfActions?.canKakanTileIds).toContain(fiveZId);

    kakanState = reduce(kakanState, {
      type: 'DECLARE_KAKAN',
      playerId: 'p2',
      tileId: fiveZId,
    });
    assertTileConservation(kakanState, 136);
    expect(kakanState.players[2]!.melds[0]!.type).toBe('kakan');
    expect(kakanState.players[2]!.melds[0]!.tiles).toHaveLength(4);
    expect(kakanState.round!.deadWall.revealedDoraCount).toBe(1);
    expect(kakanState.round!.deadWall.pendingKandoraCount).toBe(1);

    // 加槓後の打牌にロンが入ったら、保留中のカンドラはめくられず和了となる
    const ronHooks: EngineHooks = {
      canRon: ({ player }) => player.playerId === 'p0',
    };
    kakanState = reduce(
      kakanState,
      {
        type: 'DISCARD_TILE',
        playerId: 'p2',
        tileId: kakanState.players[2]!.drawnTile!.id,
      },
      ronHooks,
    );
    expect(kakanState.phase).toBe('awaiting_responses');
    kakanState = reduce(kakanState, {
      type: 'CALL_RESPONSE',
      playerId: 'p0',
      choice: { type: 'ron' },
    });
    expect(kakanState.phase).toBe('round_end');
    expect(kakanState.round!.deadWall.revealedDoraCount).toBe(1);
    assertTileConservation(kakanState, 136);
  });

  it('kandoraTiming.daiminkan = immediate を指定すると大明槓時に即ドラがめくられる', () => {
    let state = createStartedCustomGame(
      4,
      {
        hands: {
          0: ['7s', '1m', '1m', '2m', '2m', '3m', '3m', '4m', '4m', '5m', '5m', '6m', '6m'],
          1: ['7s', '7s', '7s', '9s', '9s', '1p', '1p', '2p', '2p', '3p', '3p', '4p', '4p'],
          2: ['8s', '8s', '8s', '5p', '5p', '6p', '6p', '7p', '7p', '8p', '8p', '9p', '9p'],
          3: ['1z', '1z', '2z', '2z', '3z', '3z', '5z', '5z', '6z', '6z', '7z', '7z', '4z'],
        },
        dealerDrawnKind: '3z',
      },
      { kandoraTiming: { daiminkan: 'immediate' } },
    );

    const sevenS = state.players[0]!.hand.find((t) => t.kind === '7s')!;
    state = reduce(state, {
      type: 'DISCARD_TILE',
      playerId: 'p0',
      tileId: sevenS.id,
    });
    state = reduce(state, {
      type: 'CALL_RESPONSE',
      playerId: 'p1',
      choice: { type: 'daiminkan' },
    });
    expect(state.round!.deadWall.revealedDoraCount).toBe(2);
    expect(state.round!.deadWall.pendingKandoraCount).toBe(0);
  });

  it('1局合計4回までカンでき、5回目の暗槓・加槓・大明槓は拒否される', () => {
    let state = createStartedCustomGame(4, {
      hands: {
        0: ['1m', '1m', '1m', '1m', '2m', '2m', '2m', '2m', '3m', '3m', '3m', '3m', '7m'],
        1: ['5m', '5m', '5m', '5m', '6m', '6m', '6m', '6m', '7m', '7m', '7m', '9p', '9s'],
        2: ['1s', '1s', '2s', '2s', '3s', '3s', '4s', '4s', '5s', '5s', '6s', '6s', '8s'],
        3: ['1z', '1z', '2z', '2z', '3z', '3z', '5z', '5z', '6z', '6z', '7z', '7z', '4z'],
      },
      dealerDrawnKind: '4m',
      rinshanKinds: ['4m', '4m', '4m', '7p'],
      liveWallHeadKinds: ['9m'],
    });

    // p0 が4回暗槓（1m, 2m, 3m、および嶺上で揃った4m）
    state = reduce(state, { type: 'DECLARE_ANKAN', playerId: 'p0', kind: '1m' });
    state = reduce(state, { type: 'DECLARE_ANKAN', playerId: 'p0', kind: '2m' });
    state = reduce(state, { type: 'DECLARE_ANKAN', playerId: 'p0', kind: '3m' });
    state = reduce(state, { type: 'DECLARE_ANKAN', playerId: 'p0', kind: '4m' });
    expect(state.round!.kanCount).toBe(4);
    assertTileConservation(state, 136);

    // 7m を捨てると p1 はポンはできるが、合計4カン上限のため大明槓はできない
    const p0SevenM = state.players[0]!.hand.find((t) => t.kind === '7m')!;
    state = reduce(state, {
      type: 'DISCARD_TILE',
      playerId: 'p0',
      tileId: p0SevenM.id,
    });
    expect(state.phase).toBe('awaiting_responses');
    const p1CallOpts = toStateView(state, 'p1').myCallOptions!;
    expect(p1CallOpts.canPon).toBe(true);
    expect(p1CallOpts.canDaiminkan).toBe(false);

    state = reduce(state, {
      type: 'CALL_RESPONSE',
      playerId: 'p1',
      choice: { type: 'pass' },
    });
    // p1 の手番で5回目の暗槓が拒否されることを確認
    const kanLimitErr = applyAction(state, {
      type: 'DECLARE_ANKAN',
      playerId: 'p1',
      kind: '5m',
    });
    expect(kanLimitErr.error?.code).toBe('KAN_LIMIT_REACHED');
    expect(toStateView(state, 'p1').mySelfActions).toBeNull();
  });
});

describe('第2段階: 三麻の抜北・タイムアウト・海底/河底制限', () => {
  it('3人麻雀では抜北が可能で嶺上ツモ＋牌山補充し、4人麻雀では抜北不可', () => {
    const s4 = createStartedCustomGame(4, {
      hands: {
        0: ['4z', '1m', '1m', '2m', '2m', '3m', '3m', '4m', '4m', '5m', '5m', '6m', '6m'],
      },
    });
    expect(toStateView(s4, 'p0').mySelfActions?.canKitaTileIds ?? []).toEqual([]);
    const kita4Err = applyAction(s4, {
      type: 'DECLARE_KITA',
      playerId: 'p0',
      tileId: s4.players[0]!.hand.find((t) => t.kind === '4z')!.id,
    });
    expect(kita4Err.error?.code).toBe('UNAUTHORIZED_ACTION');

    // 3人麻雀では 4カン + 抜北4回 (合計8回嶺上ツモ) でも王牌14枚が保たれる
    let s3 = createStartedCustomGame(3, {
      hands: {
        0: ['4z', '4z', '4z', '4z', '1p', '1p', '1p', '1p', '2p', '2p', '2p', '2p', '3p'],
        1: ['4p', '4p', '4p', '4p', '5p', '5p', '5p', '5p', '6p', '6p', '6p', '6p', '7p'],
        2: ['1s', '1s', '2s', '2s', '3s', '3s', '4s', '4s', '5s', '5s', '6s', '6s', '7s'],
      },
      dealerDrawnKind: '9s',
    });

    for (let i = 0; i < 4; i++) {
      const kitaId = s3.players[0]!.hand.find((t) => t.kind === '4z')!.id;
      s3 = reduce(s3, { type: 'DECLARE_KITA', playerId: 'p0', tileId: kitaId });
      assertTileConservation(s3, 108);
    }
    expect(s3.players[0]!.kitaTiles).toHaveLength(4);
    expect(s3.round!.kanCount).toBe(0);
    expect(s3.round!.deadWall.revealedDoraCount).toBe(1);

    s3 = reduce(s3, { type: 'DECLARE_ANKAN', playerId: 'p0', kind: '1p' });
    s3 = reduce(s3, { type: 'DECLARE_ANKAN', playerId: 'p0', kind: '2p' });
    s3 = reduce(s3, {
      type: 'DISCARD_TILE',
      playerId: 'p0',
      tileId: s3.players[0]!.drawnTile!.id,
    });
    s3 = reduce(s3, { type: 'DECLARE_ANKAN', playerId: 'p1', kind: '4p' });
    s3 = reduce(s3, { type: 'DECLARE_ANKAN', playerId: 'p1', kind: '5p' });
    assertTileConservation(s3, 108);
    expect(s3.round!.kanCount).toBe(4);
  });

  it('RESPONSE_TIMEOUT は未応答者のみ自動パスし、既存の応答は尊重される', () => {
    let state = createStartedCustomGame(4, {
      hands: {
        0: ['1z', '1z', '2z', '2z', '3z', '3z', '5z', '5z', '6z', '6z', '7z', '7z', '9p'],
        1: ['2m', '3m', '5p', '5p', '6p', '6p', '7s', '7s', '8s', '8s', '9s', '9s', '8p'],
        2: ['1m', '1m', '4p', '4p', '5p', '6p', '7p', '8p', '9p', '1s', '2s', '3s', '4s'],
        3: ['7m', '7m', '8m', '8m', '9m', '9m', '2p', '2p', '3p', '3p', '4s', '5s', '6s'],
      },
      dealerDrawnKind: '1m',
    });

    state = reduce(state, {
      type: 'DISCARD_TILE',
      playerId: 'p0',
      tileId: state.players[0]!.drawnTile!.id,
      now: 10_000,
    });
    const scheduledTurn = state.round!.pendingResponse!.turnCount;

    // p1 だけ チー を選択し、p2 は無応答のままタイムアウト
    const chiOpt = toStateView(state, 'p1').myCallOptions!.chiOptions[0]!;
    state = reduce(state, {
      type: 'CALL_RESPONSE',
      playerId: 'p1',
      choice: { type: 'chi', tileIds: [chiOpt.tiles[0].id, chiOpt.tiles[1].id] },
    });

    state = reduce(state, {
      type: 'RESPONSE_TIMEOUT',
      playerId: 'p0',
      turnCount: scheduledTurn,
    });
    expect(state.phase).toBe('playing');
    expect(state.round!.currentTurnIndex).toBe(1);
    expect(state.players[1]!.melds[0]!.type).toBe('chi');

    const staleErr = applyAction(state, {
      type: 'RESPONSE_TIMEOUT',
      playerId: 'p0',
      turnCount: scheduledTurn,
    });
    expect(staleErr.error?.code).toBe('INVALID_PHASE');
  });

  it('海底(wall.length === 0)ではカン・北抜き・ポン・チー不可でロンのみ可能', () => {
    let state = createStartedCustomGame(3, {
      hands: {
        0: ['4z', '1m', '1m', '1m', '1m', '2p', '2p', '3p', '3p', '4p', '4p', '5p', '5p'],
        1: ['9p', '9p', '5s', '5s', '6s', '6s', '7s', '7s', '8s', '8s', '1z', '1z', '2z'],
      },
      dealerDrawnKind: '9p',
    });

    while (state.round!.wall.length > 0) {
      const p = state.players.find(
        (x) => x.seatIndex === state.round!.currentTurnIndex,
      )!;
      state = reduce(state, {
        type: 'DISCARD_TILE',
        playerId: p.playerId,
        tileId: p.drawnTile!.id,
      });
      if (state.phase === 'awaiting_responses') {
        state = reduce(state, {
          type: 'RESPONSE_TIMEOUT',
          playerId: 'p0',
        });
      }
    }

    const lastPlayer = state.players.find(
      (x) => x.seatIndex === state.round!.currentTurnIndex,
    )!;
    if (lastPlayer.playerId === 'p0') {
      expect(
        applyAction(state, {
          type: 'DECLARE_ANKAN',
          playerId: 'p0',
          kind: '1m',
        }).error?.code,
      ).toBe('WALL_EXHAUSTED');
      expect(
        applyAction(state, {
          type: 'DECLARE_KITA',
          playerId: 'p0',
          tileId: state.players[0]!.hand.find((t) => t.kind === '4z')!.id,
        }).error?.code,
      ).toBe('WALL_EXHAUSTED');
    }

    const ronHooks: EngineHooks = {
      canRon: ({ player }) => player.playerId === 'p1',
    };
    const finalDiscardTile =
      lastPlayer.playerId === 'p0'
        ? state.players[0]!.hand.find((t) => t.kind === '9p') ?? lastPlayer.drawnTile!
        : lastPlayer.drawnTile!;

    const afterHoutei = reduce(
      state,
      {
        type: 'DISCARD_TILE',
        playerId: lastPlayer.playerId,
        tileId: finalDiscardTile.id,
      },
      ronHooks,
    );
    if (lastPlayer.playerId !== 'p1') {
      expect(afterHoutei.phase).toBe('awaiting_responses');
      const p1View = toStateView(afterHoutei, 'p1');
      expect(p1View.myCallOptions?.canRon).toBe(true);
      expect(p1View.myCallOptions?.canPon).toBe(false);
      expect(p1View.myCallOptions?.canDaiminkan).toBe(false);

      const afterPass = reduce(afterHoutei, {
        type: 'CALL_RESPONSE',
        playerId: 'p1',
        choice: { type: 'pass' },
      });
      expect(afterPass.phase).toBe('round_end');
    }
  });
});
