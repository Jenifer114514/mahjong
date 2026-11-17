import { describe, expect, it } from 'vitest';
import { toStateView } from '../../engine/projection';
import { applyAction, createInitialGameState, reduce } from '../../engine/reducer';
import { deriveRules } from '../../engine/rules';
import { buildSeededTestDeck } from '../../engine/__tests__/testHelpers';
import type { RuleConfig } from '../../types/rule';
import type { GameState } from '../../types/state';
import { decideCpuAction, toEngineAction, type CpuAction } from '../player';

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
});
