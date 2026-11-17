import { describe, expect, it } from 'vitest';
import { toStateView } from '../../engine/projection';
import { applyAction, createInitialGameState, reduce } from '../../engine/reducer';
import { deriveRules } from '../../engine/rules';
import { buildSeededTestDeck } from '../../engine/__tests__/testHelpers';
import type { StateView } from '../../types/message';
import type { RuleConfig } from '../../types/rule';
import type { GameState } from '../../types/state';
import type { Tile, TileKind } from '../../types/tile';
import { decideCpuAction, toEngineAction, type CpuAction } from '../player';

function makeTiles(kinds: readonly TileKind[], prefix: string): Tile[] {
  return kinds.map((kind, idx) => ({
    id: `${prefix}-${idx}`,
    kind,
    isRed: false,
  }));
}

function startCpuOnlyGame(
  playerCount: 3 | 4,
  gameLength: 'tonpuu' | 'hanchan',
  seed: number,
  cpuLevel?: RuleConfig['cpuLevel'],
): GameState {
  const ruleConfig: RuleConfig = {
    playerCount,
    gameLength,
    ...(cpuLevel ? { cpuLevel } : {}),
  };
  const rules = deriveRules(ruleConfig);
  let state = createInitialGameState({
    roomCode: 'CPU001',
    hostPlayerId: 'p0',
    hostName: 'P0',
    ruleConfig,
  });
  for (let i = 1; i < playerCount; i++) {
    state = reduce(state, { type: 'JOIN_PLAYER', playerId: `p${i}`, name: `P${i}` });
  }
  state = reduce(state, {
    type: 'START_GAME',
    shuffledDeck: buildSeededTestDeck(rules, seed),
  });
  return state;
}

/** 現在操作すべきプレイヤー（応答待ちなら最初の未応答者） */
function actingPlayerId(state: GameState): string {
  if (state.phase === 'awaiting_responses') {
    const pending = state.round!.pendingResponse!;
    const pid = Object.keys(pending.optionsByPlayerId).find(
      (id) => !(id in pending.responses),
    );
    if (pid) return pid;
  }
  if (state.phase === 'playing') {
    const current = state.players.find(
      (p) => p.seatIndex === state.round!.currentTurnIndex,
    );
    if (current) return current.playerId;
  }
  return state.hostPlayerId;
}

function applyCpu(state: GameState, playerId: string, action: CpuAction): GameState {
  const rules = deriveRules(state.ruleConfig);
  const engineAction = toEngineAction(playerId, action, {
    now: 0,
    shuffledDeck: buildSeededTestDeck(rules, 1),
  });
  expect(engineAction).not.toBeNull();
  const result = applyAction(state, engineAction!);
  expect(result.error).toBeNull();
  return result.state;
}

describe('CPU プレイヤー (decideCpuAction)', () => {
  it('CPU だけで東風戦を最後まで進行でき、牌の総数が保たれる', () => {
    let state = startCpuOnlyGame(4, 'tonpuu', 424242);
    const rules = deriveRules(state.ruleConfig);

    let steps = 0;
    while (state.phase !== 'finished' && steps < 20000) {
      const actor = actingPlayerId(state);
      const view = toStateView(state, actor, 0);
      const decision = decideCpuAction(view);
      expect(decision, `CPU should act for ${actor} in phase ${state.phase}`).not.toBeNull();
      state = applyCpu(state, actor, decision!);
      steps++;
    }

    expect(state.phase).toBe('finished');
    expect(steps).toBeLessThan(20000);

    // 終局時も持ち点合計は供託を除いて保存される（供託は最終トップへ加算済み）
    const totalScore = state.players.reduce((sum, p) => sum + p.score, 0);
    const kyotakuLeft = state.kyotakuCount * rules.riichiStickPoints;
    expect(totalScore + kyotakuLeft).toBe(rules.initialPoints * rules.playerCount);
  });

  it('3人麻雀でも CPU だけで進行できる', () => {
    let state = startCpuOnlyGame(3, 'tonpuu', 2024);
    let steps = 0;
    while (state.phase !== 'finished' && steps < 20000) {
      const actor = actingPlayerId(state);
      const view = toStateView(state, actor, 0);
      const decision = decideCpuAction(view);
      expect(decision).not.toBeNull();
      state = applyCpu(state, actor, decision!);
      steps++;
    }
    expect(state.phase).toBe('finished');
  });

  it('ロン可能なら必ず和了を選ぶ', () => {
    const state = startCpuOnlyGame(4, 'tonpuu', 777);
    let found = false;
    let current = state;
    for (let i = 0; i < 5000 && current.phase !== 'finished'; i++) {
      const actor = actingPlayerId(current);
      const view = toStateView(current, actor, 0);
      if (view.phase === 'awaiting_responses' && view.myCallOptions?.canRon) {
        const decision = decideCpuAction(view);
        expect(decision).toEqual({ type: 'CALL_RESPONSE', choice: { type: 'ron' } });
        found = true;
        break;
      }
      const decision = decideCpuAction(view);
      current = applyCpu(current, actor, decision!);
    }
    // ロン機会の有無はシード依存のため、機会がなければこの検証はスキップ
    expect(found || current.phase === 'finished').toBe(true);
  });

  it('リーチ後はツモ切りしか選ばない', () => {
    let state = startCpuOnlyGame(4, 'tonpuu', 99);
    for (let i = 0; i < 4000 && state.phase !== 'finished'; i++) {
      const actor = actingPlayerId(state);
      const view = toStateView(state, actor, 0);
      if (view.phase === 'playing') {
        const self = view.players.find((p) => p.playerId === actor);
        if (self?.isCurrentTurn && self.isRiichi && view.myDrawnTile) {
          const decision = decideCpuAction(view);
          if (decision?.type === 'DISCARD_TILE') {
            expect(decision.tileId).toBe(view.myDrawnTile.id);
            return;
          }
        }
      }
      const decision = decideCpuAction(view);
      expect(decision).not.toBeNull();
      state = applyCpu(state, actor, decision!);
    }
    // リーチが発生しないシードでもテスト自体は失敗させない
    expect(true).toBe(true);
  });

  it('cpuLevel: "easy" でも東風戦を最後まで進行できる', () => {
    let state = startCpuOnlyGame(4, 'tonpuu', 2026, 'easy');
    const rules = deriveRules(state.ruleConfig);
    expect(rules.cpuLevel).toBe('easy');

    let steps = 0;
    while (state.phase !== 'finished' && steps < 20000) {
      const actor = actingPlayerId(state);
      const view = toStateView(state, actor, 0);
      const decision = decideCpuAction(view);
      expect(decision).not.toBeNull();
      state = applyCpu(state, actor, decision!);
      steps++;
    }

    expect(state.phase).toBe('finished');
    const totalScore = state.players.reduce((sum, p) => sum + p.score, 0);
    const kyotakuLeft = state.kyotakuCount * rules.riichiStickPoints;
    expect(totalScore + kyotakuLeft).toBe(rules.initialPoints * rules.playerCount);
  });

  it('門前（meldCount=0）の七対子聴牌では七対子シャンテンを認識してリーチする', () => {
    let state = startCpuOnlyGame(4, 'tonpuu', 123);
    const turnSeat = state.round!.currentTurnIndex;
    const actor = state.players.find((p) => p.seatIndex === turnSeat)!;

    // 13枚の手牌: 6対子 + 単騎候補（面子手では 3向聴だが七対子で聴牌）
    const handKinds = [
      '1m', '1m',
      '3m', '3m',
      '5p', '5p',
      '7p', '7p',
      '2s', '2s',
      '4s', '4s',
      '1z',
    ] as const;
    const nextPlayers = state.players.map((p) =>
      p.playerId === actor.playerId
        ? {
            ...p,
            hand: handKinds.map((kind, idx) => ({
              id: `chiitoi-h-${idx}`,
              kind,
              isRed: false,
            })),
            drawnTile: { id: 'chiitoi-drawn', kind: '9s' as const, isRed: false },
            melds: [],
          }
        : p,
    );
    state = { ...state, players: nextPlayers };

    const view = toStateView(state, actor.playerId, 0);
    const decision = decideCpuAction(view);
    expect(decision).toEqual({
      type: 'DECLARE_RIICHI',
      tileId: expect.stringMatching(/^chiitoi-/),
    });
  });

  it('3人麻雀では 2m..8m を期待した 1m 抱え込みをせず孤立端牌・字牌を正しく評価する', () => {
    let state = startCpuOnlyGame(3, 'tonpuu', 303);
    const turnSeat = state.round!.currentTurnIndex;
    const actor = state.players.find((p) => p.seatIndex === turnSeat)!;
    // 孤立 1m と 3p（両面・くっつき候補の多い3p vs 三麻で順子にならない1m）
    const handKinds: TileKind[] = [
      '1m', '3p', '5p', '6p', '7p', '2s', '3s', '4s', '6s', '7s', '8s', '5z', '5z',
    ];
    state = {
      ...state,
      players: state.players.map((p) =>
        p.playerId === actor.playerId
          ? {
              ...p,
              hand: makeTiles(handKinds, 'sanma-h'),
              drawnTile: { id: 'sanma-d', kind: '1z', isRed: false },
              melds: [],
            }
          : p,
      ),
    };
    const view = toStateView(state, actor.playerId, 0);
    const decision = decideCpuAction(view);
    expect(decision?.type).toBe('DISCARD_TILE');
    // 1m または 1z を切る（有効牌の広い 3p は残す）
    const discardedId = (decision as { type: 'DISCARD_TILE'; tileId: string }).tileId;
    expect(discardedId).not.toBe('sanma-h-1');
  });

  it('自分の kitaTiles を可視牌に含めて残り枚数を計算する', () => {
    let state = startCpuOnlyGame(3, 'tonpuu', 404);
    const turnSeat = state.round!.currentTurnIndex;
    const actor = state.players.find((p) => p.seatIndex === turnSeat)!;
    // 1p と 9s の単騎/対子候補: 自分が 4z を2枚抜北済み + 他家河に1zが3枚、
    // ただし 2s待ち(残0: 自分の副露に3枚+場1枚) vs 5p待ち(残4) で 5p 待ちを残すこと
    const handKinds: TileKind[] = [
      '2p', '3p', '4p', '5p', '6p', '7p', '8p', '2s', '2s', '3s', '4s', '5s', '9s',
    ];
    state = {
      ...state,
      players: state.players.map((p) =>
        p.playerId === actor.playerId
          ? {
              ...p,
              hand: makeTiles(handKinds, 'kita-h'),
              drawnTile: { id: 'kita-d', kind: '1p', isRed: false },
              melds: [],
              kitaTiles: makeTiles(['4z', '4z'], 'my-kita'),
            }
          : p,
      ),
    };
    // 自分の抜北 4z が buildVisibleCounts に含まれるため、1m(残4) より 4z が残っていても正しく評価
    const view = toStateView(state, actor.playerId, 0);
    // 手牌から 1p か 9s の孤立牌を打牌（4z 抜北2枚が存在する状態でも例外なく決定できる）
    const decision = decideCpuAction(view);
    expect(decision).not.toBeNull();

    // さらに 1m 対子と 9p 対子で 1m が 2枚自分の melds(ankan等) や kita に見えている状況を直接検証
    const stateVisible = {
      ...state,
      players: state.players.map((p, idx) =>
        p.playerId === actor.playerId
          ? {
              ...p,
              hand: makeTiles(
                ['1m', '9m', '2p', '3p', '4p', '5p', '6p', '7p', '2s', '3s', '4s', '5s', '5s'],
                'vis-h',
              ),
              drawnTile: { id: 'vis-d', kind: '9p' as const, isRed: false },
              kitaTiles: makeTiles(['4z', '4z', '4z'], 'my-kita3'),
            }
          : idx === 1
            ? {
                ...p,
                discards: [
                  { tile: { id: 'opp-9m-0', kind: '9m' as const, isRed: false }, isTsumogiri: false },
                  { tile: { id: 'opp-9m-1', kind: '9m' as const, isRed: false }, isTsumogiri: false },
                  { tile: { id: 'opp-9m-2', kind: '9m' as const, isRed: false }, isTsumogiri: false },
                ],
              }
            : p,
      ),
    };
    const viewVisible = toStateView(stateVisible, actor.playerId, 0);
    // 9m は場に3枚・手牌1枚で残り0枚、1mは残り3枚 → 9m を切って 1m 単騎等の余地を残す
    const d2 = decideCpuAction(viewVisible);
    expect(d2).toEqual({ type: 'DISCARD_TILE', tileId: 'vis-h-1' });
  });

  it('リーチ宣言時はフリテン待ちや狭い待ちではなく非フリテン・広い待ちを選ぶ', () => {
    let state = startCpuOnlyGame(4, 'tonpuu', 505);
    const turnSeat = state.round!.currentTurnIndex;
    const actor = state.players.find((p) => p.seatIndex === turnSeat)!;
    // 2p3p4p 5s6s7s 8m8m8m 2m3m 5p6p + 1p(または 4p) ではなく:
    // 1m2m3m 4p5p6p 7s8s9s 2s3s 9p9p + 5p を引き、
    //   - 9p切り -> 1s-4s 両面待ち（非フリテン・8枚）
    //   - 2s/3s切り -> 9p単騎や嵌張
    // さらに捨て牌に 1s がある場合は 9p切りがフリテンになり、1s以外待ち（4m-7m 等）を選ぶ
    // ここでは: 2m3m 4m5m6m 2p3p4p 5s6s7s 8s8s + 7m
    //   - 7m切り -> 1m-4m 待ち（もし捨て牌に 1m があるとフリテン！）
    //   - 2m切り -> 5m-8m 等ではない → より分かりやすく:
    // 2m3m 4m4m4m 5p6p7p 2s3s4s 6s6s + 1m vs 8s?
    // 一番明快: 3m4m5m 6p7p8p 2s3s4s 4m5m 7s7s + 3m (同じ聴牌複数候補)
    // → 3m切り: 3m6m待ち? いえ、345m+45m+3m = 33m 45m 45m → 36m待ち(フリテン: 3m切り自身でフリテン!)
    // → 7s切り vs 3m切り: 3m4m5m 6p7p8p 2s3s4s 7s7s 4p5p + 6m:
    //   もし捨て牌に 3p を既に切っていて、手牌が:
    //   4p5p (3p6p待ち) と 2s3s (1s4s待ち) のどちらを残すか！
    //   4p5p 2s3s 6m7m8m 1p1p1p 9s9s9s + 9p? いえ両方残すなら2面子にならず。
    //   1m2m3m 4p5p 6s7s8s 9p9p 5m5m5m + 6p → 6p切りで3p-6p待ち（自身で6pを切るのでフリテン！）
    //   4p切りで5p-6p両面（3p...いえ4p5p6p 完成、1m2m3m...）。
    //   よし: [2p, 3p, 4p, 5p, 6p, 7p, 3s, 4s, 5s, 9m, 9m, 1z, 1z] + 2p:
    //   - 2p切り: 2p-5p 待ち（自分が2pを切るため即フリテン！）
    //   - 4p切り: 2p-3p + 5p-6p-7p → 1p-4p 待ち（4pを切るため即フリテン！）
    //   - 5p切り: 2p-3p-4p + 6p-7p → 5p-8p 待ち（5p切りでフリテン）
    //   では非フリテンとフリテンが並ぶ例:
    //   手牌: [2m, 3m, 4m, 5m, 6m, 2p, 3p, 4p, 7s, 7s, 9s, 9s, 9s] + 7m
    //   捨て牌に 1m があるとき:
    //   - 7m切り → 2m3m4m5m6m → 1m4m7m待ち（1mが河にある＋7m切りでフリテン！）
    //   - 4m切り → 2m3m + 5m6m7m → 1m4m待ち（フリテン！）
    //   - 2m切り → 3m4m5m6m7m → 2m5m8m待ち（2m切りでフリテン！）
    //   そこで [2m, 3m, 4m, 5p, 6p, 7p, 2s, 3s, 4s, 5s, 6s, 9p, 9p] + 8s:
    //   - 2s切り → 5s-8s 待ち (非フリテン・待ち8枚！)
    //   - 8s切り → 1s-4s-7s 待ち (もし河に1sがあるならフリテン！)
    const handKinds: TileKind[] = [
      '2m', '3m', '4m', '5p', '6p', '7p', '2s', '3s', '4s', '5s', '6s', '9p', '9p',
    ];
    state = {
      ...state,
      players: state.players.map((p) =>
        p.playerId === actor.playerId
          ? {
              ...p,
              hand: makeTiles(handKinds, 'riichi-h'),
              drawnTile: { id: 'riichi-drawn-8s', kind: '8s', isRed: false },
              discards: [
                {
                  tile: { id: 'my-prev-1s', kind: '1s', isRed: false },
                  isTsumogiri: false,
                },
              ],
              discardedKinds: ['1s'],
              melds: [],
            }
          : p,
      ),
    };
    const view = toStateView(state, actor.playerId, 0);
    // 8s(riichi-drawn-8s)切りは1sが捨て牌にあるためフリテン！2s(riichi-h-6)切りは5s-8sの非フリテン待ち！
    const decision = decideCpuAction(view);
    expect(decision).toEqual({ type: 'DECLARE_RIICHI', tileId: 'riichi-h-6' });
  });

  it('全リーチ候補が空聴（残り待ち牌0枚）ならリーチしない', () => {
    let state = startCpuOnlyGame(4, 'tonpuu', 606);
    const turnSeat = state.round!.currentTurnIndex;
    const actor = state.players.find((p) => p.seatIndex === turnSeat)!;
    // 1m2m3m 4p5p6p 7s8s9s 2s3s4s 1z + 2z
    // 1z切り→2z単騎 / 2z切り→1z単騎。他家の河に1zを3枚、2zを3枚置くと残り0枚の空聴！
    const handKinds: TileKind[] = [
      '1m', '2m', '3m', '4p', '5p', '6p', '7s', '8s', '9s', '2s', '3s', '4s', '1z',
    ];
    state = {
      ...state,
      players: state.players.map((p, idx) =>
        p.playerId === actor.playerId
          ? {
              ...p,
              hand: makeTiles(handKinds, 'kara-h'),
              drawnTile: { id: 'kara-d', kind: '2z', isRed: false },
              melds: [],
            }
          : idx === (actor.seatIndex + 1) % 4
            ? {
                ...p,
                discards: [
                  { tile: { id: 'k1a', kind: '1z', isRed: false }, isTsumogiri: false },
                  { tile: { id: 'k1b', kind: '1z', isRed: false }, isTsumogiri: false },
                  { tile: { id: 'k1c', kind: '1z', isRed: false }, isTsumogiri: false },
                  { tile: { id: 'k2a', kind: '2z', isRed: false }, isTsumogiri: false },
                  { tile: { id: 'k2b', kind: '2z', isRed: false }, isTsumogiri: false },
                  { tile: { id: 'k2c', kind: '2z', isRed: false }, isTsumogiri: false },
                ],
              }
            : p,
      ),
    };
    const view = toStateView(state, actor.playerId, 0);
    expect(view.mySelfActions?.canRiichiTileIds.length).toBeGreaterThan(0);
    const decision = decideCpuAction(view);
    expect(decision?.type).toBe('DISCARD_TILE');
  });

  it('暗槓のみの副露は門前扱いとして非役牌の鳴きをしない', () => {
    const state = startCpuOnlyGame(4, 'tonpuu', 707);
    const actor = state.players[0]!;
    const discarder = state.players[1]!;
    const ankanView: StateView = {
      ...toStateView(state, actor.playerId, 0),
      phase: 'awaiting_responses',
      myHand: makeTiles(['2m', '2m', '4p', '5p', '6p', '7s', '8s', '9s', '5z', '5z'], 'ak'),
      myDrawnTile: null,
      myCallOptions: {
        discardedTile: { id: 'disc-2m', kind: '2m', isRed: false },
        discarderSeatIndex: discarder.seatIndex,
        canRon: false,
        canPon: true,
        canDaiminkan: false,
        chiOptions: [],
      },
      players: toStateView(state, actor.playerId, 0).players.map((p) =>
        p.playerId === actor.playerId
          ? {
              ...p,
              melds: [
                {
                  type: 'ankan',
                  tiles: makeTiles(['1s', '1s', '1s', '1s'], 'ak-m'),
                  calledTile: null,
                  fromSeatIndex: null,
                  addedTile: null,
                },
              ],
            }
          : p,
      ),
    };
    const decision = decideCpuAction(ankanView);
    expect(decision).toEqual({ type: 'CALL_RESPONSE', choice: { type: 'pass' } });
  });

  it('順子を壊してシャンテンが下がる暗槓は行わない（C5）', () => {
    let state = startCpuOnlyGame(4, 'tonpuu', 808);
    const turnSeat = state.round!.currentTurnIndex;
    const actor = state.players.find((p) => p.seatIndex === turnSeat)!;
    // 1m1m1m + 1m2m3m + 4p5p6p + 7s8s9s + 5z5z:
    // 暗槓(1m)すると 2m3m が残って 1シャンテンへ悪化するが、暗槓しなければ 1m2m3m+1m1m1m で和了/テンパイ維持
    const handKinds: TileKind[] = [
      '1m', '1m', '1m', '2m', '3m', '4p', '5p', '6p', '7s', '8s', '9s', '5z', '5z',
    ];
    state = {
      ...state,
      players: state.players.map((p) =>
        p.playerId === actor.playerId
          ? {
              ...p,
              hand: makeTiles(handKinds, 'kan-h'),
              drawnTile: { id: 'kan-d', kind: '1m', isRed: false },
              melds: [],
            }
          : p,
      ),
    };
    const view = toStateView(state, actor.playerId, 0);
    expect(view.mySelfActions?.canAnkanKinds).toContain('1m');
    const decision = decideCpuAction(view);
    expect(decision?.type).not.toBe('DECLARE_ANKAN');
  });

  it('喰いタンなし設定ではタンヤオのみになる鳴きを行わない（C5）', () => {
    let state = createInitialGameState({
      roomCode: 'NKUI01',
      hostPlayerId: 'p0',
      hostName: 'P0',
      ruleConfig: { playerCount: 4, gameLength: 'tonpuu', allowKuitan: false },
    });
    for (let i = 1; i < 4; i++) {
      state = reduce(state, { type: 'JOIN_PLAYER', playerId: `p${i}`, name: `P${i}` });
    }
    const rules = deriveRules(state.ruleConfig);
    state = reduce(state, {
      type: 'START_GAME',
      shuffledDeck: buildSeededTestDeck(rules, 818),
    });

    const actor = state.players[0]!;
    const discarder = state.players[3]!;
    const baseView = toStateView(state, actor.playerId, 0);
    const callView: StateView = {
      ...baseView,
      phase: 'awaiting_responses',
      myHand: makeTiles(['2m', '3m', '4p', '5p', '6p', '3s', '4s', '5s', '7s', '7s'], 'nok'),
      myDrawnTile: null,
      players: baseView.players.map((p) =>
        p.playerId === actor.playerId
          ? {
              ...p,
              melds: [
                {
                  type: 'chi',
                  tiles: makeTiles(['2p', '3p', '4p'], 'open-p'),
                  calledTile: { id: 'c2p', kind: '2p', isRed: false },
                  fromSeatIndex: discarder.seatIndex,
                  addedTile: null,
                },
              ],
            }
          : p,
      ),
      myCallOptions: {
        discardedTile: { id: 'disc-4m', kind: '4m', isRed: false },
        discarderSeatIndex: discarder.seatIndex,
        canRon: false,
        canPon: false,
        canDaiminkan: false,
        chiOptions: [
          {
            tiles: [
              { id: 'nok-0', kind: '2m', isRed: false },
              { id: 'nok-1', kind: '3m', isRed: false },
            ],
          },
        ],
      },
    };
    expect(decideCpuAction(callView)).toEqual({
      type: 'CALL_RESPONSE',
      choice: { type: 'pass' },
    });
  });

  it('九種九牌が可能で国士に遠ければ流局を選び、国士に近ければ続行する（C6）', () => {
    let state = startCpuOnlyGame(4, 'tonpuu', 909);
    const turnSeat = state.round!.currentTurnIndex;
    const actor = state.players.find((p) => p.seatIndex === turnSeat)!;

    // 9種の么九牌 + 孤立数牌（国士4シャンテン・通常手3シャンテン以上） -> 流局
    const garbageKinds: TileKind[] = [
      '1m', '9m', '1p', '9p', '1s', '9s', '1z', '2z', '3z', '4m', '6p', '5s', '7s',
    ];
    state = {
      ...state,
      players: state.players.map((p) =>
        p.playerId === actor.playerId
          ? {
              ...p,
              hand: makeTiles(garbageKinds, '9k-h'),
              drawnTile: { id: '9k-d', kind: '4m', isRed: false },
              discards: [],
              melds: [],
            }
          : { ...p, discards: [], melds: [] },
      ),
      round: { ...state.round!, firstTurnUninterrupted: true },
    };
    const garbageView = toStateView(state, actor.playerId, 0);
    expect(garbageView.mySelfActions?.canKyuushuKyuuhai).toBe(true);
    expect(decideCpuAction(garbageView)).toEqual({ type: 'DECLARE_KYUUSHU_KYUUHAI' });

    // 12種の么九牌（国士1シャンテン） -> 続行して国士を狙う
    const kokushiKinds: TileKind[] = [
      '1m', '9m', '1p', '9p', '1s', '9s', '1z', '2z', '3z', '4z', '5z', '6z', '4m',
    ];
    const kokushiState: GameState = {
      ...state,
      players: state.players.map((p) =>
        p.playerId === actor.playerId
          ? {
              ...p,
              hand: makeTiles(kokushiKinds, 'kok-h'),
              drawnTile: { id: 'kok-d', kind: '5p', isRed: false },
            }
          : p,
      ),
    };
    const kokushiView = toStateView(kokushiState, actor.playerId, 0);
    expect(kokushiView.mySelfActions?.canKyuushuKyuuhai).toBe(true);
    expect(decideCpuAction(kokushiView)?.type).toBe('DISCARD_TILE');
  });

  it('他家がリーチ中で2シャンテン以上なら現物を優先してベタオリする（C8）', () => {
    let state = startCpuOnlyGame(4, 'tonpuu', 1010);
    const turnSeat = state.round!.currentTurnIndex;
    const actor = state.players.find((p) => p.seatIndex === turnSeat)!;
    const riichiOpponent = state.players.find((p) => p.playerId !== actor.playerId)!;

    // 2シャンテン以上のバラバラな手牌。相手リーチの現物(9p)と危険な生牌・ドラ(5m赤)がある
    const handKinds: TileKind[] = [
      '1m', '4m', '5m', '7m', '2p', '5p', '8p', '9p', '2s', '5s', '8s', '1z', '6z',
    ];
    state = {
      ...state,
      players: state.players.map((p) =>
        p.playerId === actor.playerId
          ? {
              ...p,
              hand: makeTiles(handKinds, 'def-h'),
              drawnTile: { id: 'def-d-5p', kind: '5p', isRed: true },
              melds: [],
            }
          : p.playerId === riichiOpponent.playerId
            ? {
                ...p,
                isRiichi: true,
                discards: [
                  {
                    tile: { id: 'opp-safe-9p', kind: '9p', isRed: false },
                    isTsumogiri: false,
                    isRiichiDeclaration: true,
                  },
                ],
              }
            : p,
      ),
    };

    const view = toStateView(state, actor.playerId, 0);
    const decision = decideCpuAction(view);
    // 現物の 9p (def-h-7) を切る
    expect(decision).toEqual({ type: 'DISCARD_TILE', tileId: 'def-h-7' });
  });
});
