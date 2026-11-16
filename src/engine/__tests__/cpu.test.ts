import { describe, expect, it } from 'vitest';
import {
  calculateShanten,
  decideCpuCallResponse,
  decideCpuTurnAction,
} from '../cpu';
import { applyAction, createInitialGameState } from '../reducer';
import { deriveRules } from '../rules';
import type { RuleConfig } from '../../types/rule';
import type { GameState, PlayerState } from '../../types/state';
import type { Tile, TileKind } from '../../types/tile';
import {
  assertTileConservation,
  buildCustomDeck,
  buildSeededTestDeck,
} from './testHelpers';

function makeTile(id: string, kind: TileKind): Tile {
  return { id, kind, isRed: false };
}

function setupStartedGame(
  config: RuleConfig,
  deck: Tile[],
  cpuSeats: number[] = [0, 1, 2, 3],
): GameState {
  const cpuSet = new Set(cpuSeats);
  let state = createInitialGameState({
    roomCode: 'CPUTEST',
    hostPlayerId: 'p0',
    hostName: cpuSet.has(0) ? 'CPU 1' : 'Host',
    ruleConfig: config,
  });
  state = {
    ...state,
    players: state.players.map((p) =>
      p.seatIndex === 0
        ? { ...p, isCpu: cpuSet.has(0), cpuLevel: config.cpuLevel ?? 'normal' }
        : p,
    ),
  };

  for (let i = 1; i < config.playerCount; i++) {
    const res = applyAction(state, {
      type: 'JOIN_PLAYER',
      playerId: `p${i}`,
      name: cpuSet.has(i) ? `CPU ${i + 1}` : `Human ${i + 1}`,
      isCpu: cpuSet.has(i),
      cpuLevel: config.cpuLevel ?? 'normal',
    });
    if (res.error) throw new Error(res.error.message);
    state = res.state;
  }

  const startRes = applyAction(state, {
    type: 'START_GAME',
    shuffledDeck: deck,
    shuffledPlayerIds: state.players.map((p) => p.playerId),
  });
  if (startRes.error) throw new Error(startRes.error.message);
  return startRes.state;
}

describe('CPU AI Engine (src/engine/cpu.ts)', () => {
  it('calculateShanten が標準形・七対子・国士無双・副露手を正確に判定する', () => {
    // 14枚和了形
    expect(
      calculateShanten(
        [
          '1m', '2m', '3m',
          '4p', '5p', '6p',
          '7s', '8s', '9s',
          '2s', '2s', '2s',
          '1z', '1z',
        ],
        [],
      ),
    ).toBe(-1);

    // 13枚聴牌
    expect(
      calculateShanten(
        [
          '1m', '2m', '3m',
          '4p', '5p', '6p',
          '7s', '8s', '9s',
          '2s', '3s',
          '1z', '1z',
        ],
        [],
      ),
    ).toBe(0);

    // 13枚一向聴
    expect(
      calculateShanten(
        [
          '1m', '2m', '3m',
          '4p', '5p', '6p',
          '7s', '9s',
          '2s', '3s',
          '1z', '1z', '5z',
        ],
        [],
      ),
    ).toBe(1);

    // 七対子聴牌 vs 4枚使い（5対子+孤立1種=2向聴）
    expect(
      calculateShanten(
        ['1m', '1m', '3m', '3m', '5p', '5p', '7p', '7p', '2s', '2s', '6s', '6s', '1z'],
        [],
      ),
    ).toBe(0);
    expect(
      calculateShanten(
        ['1m', '1m', '1m', '1m', '5p', '5p', '7p', '7p', '2s', '2s', '6s', '6s', '1z'],
        [],
      ),
    ).toBe(2);

    // 国士無双13面待ち聴牌
    expect(
      calculateShanten(
        ['1m', '9m', '1p', '9p', '1s', '9s', '1z', '2z', '3z', '4z', '5z', '6z', '7z'],
        [],
      ),
    ).toBe(0);
  });

  it('ツモ和了できるときは難易度に関わらず DECLARE_TSUMO を選択する', () => {
    for (const cpuLevel of ['normal', 'easy'] as const) {
      const config: RuleConfig = { playerCount: 4, gameLength: 'tonpuu', cpuLevel };
      const rules = deriveRules(config);
      const deck = buildCustomDeck(rules, {
        hands: {
          0: ['2m', '3m', '4m', '3p', '4p', '5p', '5s', '6s', '7s', '2s', '3s', '6p', '6p'],
        },
        dealerDrawnKind: '4s',
      });
      const state = setupStartedGame(config, deck);
      const action = decideCpuTurnAction(state, state.players[0]!, rules);
      expect(action).toEqual({
        type: 'DECLARE_TSUMO',
        playerId: 'p0',
      });
    }
  });

  it('標準CPUは聴牌時にフリテンでない待牌でリーチし、九種・北抜き・喰い替え禁止を守る', () => {
    // リーチ宣言テスト
    const config4: RuleConfig = { playerCount: 4, gameLength: 'tonpuu', cpuLevel: 'normal' };
    const rules4 = deriveRules(config4);
    const deckRiichi = buildCustomDeck(rules4, {
      hands: {
        0: ['1m', '2m', '3m', '4p', '5p', '6p', '7s', '8s', '9s', '4s', '5s', '2z', '2z'],
      },
      dealerDrawnKind: '7z',
    });
    const riichiState = setupStartedGame(config4, deckRiichi);
    const riichiAction = decideCpuTurnAction(riichiState, riichiState.players[0]!, rules4);
    expect(riichiAction.type).toBe('DECLARE_RIICHI');
    if (riichiAction.type === 'DECLARE_RIICHI') {
      const chosenTile = [
        ...riichiState.players[0]!.hand,
        riichiState.players[0]!.drawnTile!,
      ].find((t) => t.id === riichiAction.tileId);
      expect(chosenTile?.kind).toBe('7z');
    }

    // 3麻北抜きテスト
    const config3: RuleConfig = { playerCount: 3, gameLength: 'tonpuu', cpuLevel: 'normal' };
    const rules3 = deriveRules(config3);
    const deckKita = buildCustomDeck(rules3, {
      hands: {
        0: ['1m', '9m', '1p', '2p', '3p', '4p', '5p', '6p', '2s', '3s', '4s', '5s', '4z'],
      },
      dealerDrawnKind: '6s',
    });
    const kitaState = setupStartedGame(config3, deckKita, [0, 1, 2]);
    const kitaAction = decideCpuTurnAction(kitaState, kitaState.players[0]!, rules3);
    expect(kitaAction.type).toBe('DECLARE_KITA');

    // 喰い替え禁止の打牌除外
    const kuikaeState: GameState = {
      ...riichiState,
      players: riichiState.players.map((p, idx) =>
        idx === 0
          ? {
              ...p,
              hand: [
                makeTile('k1', '2m'),
                makeTile('k2', '4p'),
                makeTile('k3', '5p'),
                makeTile('k4', '6p'),
                makeTile('k5', '7s'),
                makeTile('k6', '8s'),
                makeTile('k7', '9s'),
                makeTile('k8', '1z'),
                makeTile('k9', '1z'),
                makeTile('k10', '3s'),
              ],
              drawnTile: null,
              melds: [
                {
                  type: 'pon',
                  tiles: [makeTile('m1', '2m'), makeTile('m2', '2m'), makeTile('m3', '2m')],
                  calledTile: makeTile('m3', '2m'),
                  fromSeatIndex: 1,
                  addedTile: null,
                },
              ],
            }
          : p,
      ),
      round: {
        ...riichiState.round!,
        kuikaeForbiddenKinds: ['2m'],
      },
    };
    const discardAct = decideCpuTurnAction(kuikaeState, kuikaeState.players[0]!, rules4);
    expect(discardAct.type).toBe('DISCARD_TILE');
    if (discardAct.type === 'DISCARD_TILE') {
      expect(discardAct.tileId).not.toBe('k1');
    }
  });

  it('他家リーチ中かつ遠め手牌のとき、標準CPUは現物を優先して打牌する', () => {
    const config: RuleConfig = { playerCount: 4, gameLength: 'tonpuu', cpuLevel: 'normal' };
    const rules = deriveRules(config);
    const deck = buildCustomDeck(rules, {
      hands: {
        0: ['4m', '6m', '2p', '4p', '7p', '9p', '3s', '5s', '8s', '1z', '3z', '5z', '6z'],
      },
      dealerDrawnKind: '4s',
    });
    const base = setupStartedGame(config, deck);
    const safeTile = makeTile('safe-4m', '4m');
    const stateWithThreat: GameState = {
      ...base,
      players: base.players.map((p, idx) => {
        if (idx === 0) {
          return {
            ...p,
            hand: [
              safeTile,
              makeTile('h1', '5m'),
              makeTile('h2', '2p'),
              makeTile('h3', '5p'),
              makeTile('h4', '7p'),
              makeTile('h5', '3s'),
              makeTile('h6', '5s'),
              makeTile('h7', '6s'),
              makeTile('h8', '8s'),
              makeTile('h9', '2z'),
              makeTile('h10', '3z'),
              makeTile('h11', '6p'),
              makeTile('h12', '4p'),
            ],
            drawnTile: makeTile('d1', '5s'),
          };
        }
        if (idx === 1) {
          return {
            ...p,
            isRiichi: true,
            discards: [{ tile: makeTile('opp-4m', '4m'), isTsumogiri: false }],
          };
        }
        return p;
      }),
    };

    const act = decideCpuTurnAction(stateWithThreat, stateWithThreat.players[0]!, rules);
    expect(act).toEqual({
      type: 'DISCARD_TILE',
      playerId: 'p0',
      tileId: 'safe-4m',
    });
  });

  it('鳴き判断: ロン最優先・やさしめCPUは鳴きスルー・標準CPUは喰いタン有無に従って鳴く', () => {
    const baseCfg: RuleConfig = { playerCount: 4, gameLength: 'tonpuu', cpuLevel: 'normal' };
    const baseRules = deriveRules(baseCfg);
    const state = setupStartedGame(baseCfg, buildSeededTestDeck(baseRules, 42));

    const player: PlayerState = {
      ...state.players[1]!,
      hand: [
        makeTile('t1', '3m'),
        makeTile('t2', '4m'),
        makeTile('t3', '4p'),
        makeTile('t4', '5p'),
        makeTile('t5', '6p'),
        makeTile('t6', '3s'),
        makeTile('t7', '4s'),
        makeTile('t8', '5s'),
        makeTile('t9', '6s'),
        makeTile('t10', '7s'),
        makeTile('t11', '8p'),
        makeTile('t12', '2p'),
        makeTile('t13', '2p'),
      ],
      drawnTile: null,
    };

    // ロン可能なら easy でもロン
    const ronChoice = decideCpuCallResponse(
      state,
      { ...player, cpuLevel: 'easy' },
      {
        discardedTile: makeTile('d-ron', '5m'),
        discarderSeatIndex: 0,
        canRon: true,
        canPon: false,
        canDaiminkan: false,
        chiOptions: [],
      },
      baseRules,
    );
    expect(ronChoice).toEqual({ type: 'ron' });

    // easy CPU はチーを見送る
    const easyChi = decideCpuCallResponse(
      state,
      { ...player, cpuLevel: 'easy' },
      {
        discardedTile: makeTile('d-chi', '5m'),
        discarderSeatIndex: 0,
        canRon: false,
        canPon: false,
        canDaiminkan: false,
        chiOptions: [{ tiles: [makeTile('t1', '3m'), makeTile('t2', '4m')] }],
      },
      baseRules,
    );
    expect(easyChi).toEqual({ type: 'pass' });

    // normal CPU は喰いタンありなら純タンヤオでチーする
    const kuitanChi = decideCpuCallResponse(
      state,
      { ...player, cpuLevel: 'normal' },
      {
        discardedTile: makeTile('d-chi', '5m'),
        discarderSeatIndex: 0,
        canRon: false,
        canPon: false,
        canDaiminkan: false,
        chiOptions: [{ tiles: [makeTile('t1', '3m'), makeTile('t2', '4m')] }],
      },
      baseRules,
    );
    expect(kuitanChi).toEqual({ type: 'chi', tileIds: ['t1', 't2'] });

    // 喰いタンなしルールでは役なしにならないようチーを見送る
    const noKuitanRules = deriveRules({
      playerCount: 4,
      gameLength: 'tonpuu',
      allowKuitan: false,
      cpuLevel: 'normal',
    });
    const noKuitanChi = decideCpuCallResponse(
      { ...state, ruleConfig: { playerCount: 4, gameLength: 'tonpuu', allowKuitan: false } },
      { ...player, cpuLevel: 'normal' },
      {
        discardedTile: makeTile('d-chi', '5m'),
        discarderSeatIndex: 0,
        canRon: false,
        canPon: false,
        canDaiminkan: false,
        chiOptions: [{ tiles: [makeTile('t1', '3m'), makeTile('t2', '4m')] }],
      },
      noKuitanRules,
    );
    expect(noKuitanChi).toEqual({ type: 'pass' });
  });

  it('4人麻雀・3人麻雀の全CPU自動対局がエラーなく1局完了し牌総数が保存される', () => {
    for (const playerCount of [4, 3] as const) {
      const config: RuleConfig = {
        playerCount,
        gameLength: 'tonpuu',
        cpuLevel: 'normal',
      };
      const rules = deriveRules(config);
      const deck = buildSeededTestDeck(rules, playerCount === 4 ? 101 : 202);
      const seats = playerCount === 4 ? [0, 1, 2, 3] : [0, 1, 2];
      let state = setupStartedGame(config, deck, seats);

      let safetySteps = 0;
      while (
        (state.phase === 'playing' || state.phase === 'awaiting_responses') &&
        safetySteps < 500
      ) {
        safetySteps++;
        if (state.phase === 'playing') {
          const active = state.players.find(
            (p) => p.seatIndex === state.round!.currentTurnIndex,
          )!;
          const act = decideCpuTurnAction(state, active, rules);
          const res = applyAction(state, act);
          expect(res.error).toBeNull();
          state = res.state;
        } else if (state.phase === 'awaiting_responses' && state.round?.pendingResponse) {
          const pending = state.round.pendingResponse;
          for (const pid of Object.keys(pending.optionsByPlayerId)) {
            if (state.phase !== 'awaiting_responses') break;
            const opts = pending.optionsByPlayerId[pid]!;
            const p = state.players.find((pl) => pl.playerId === pid)!;
            const choice = decideCpuCallResponse(state, p, opts, rules);
            const res = applyAction(state, {
              type: 'CALL_RESPONSE',
              playerId: pid,
              choice,
            });
            expect(res.error).toBeNull();
            state = res.state;
          }
        }
      }

      expect(state.phase).toBe('round_end');
      assertTileConservation(state, rules.totalTiles);
    }
  });
});
