import { describe, expect, it } from 'vitest';
import {
  assertTileConservation,
  buildSeededTestDeck,
} from '../../engine/__tests__/testHelpers';
import { toStateView } from '../../engine/projection';
import { applyAction, createInitialGameState } from '../../engine/reducer';
import { deriveRules } from '../../engine/rules';
import type { StateView } from '../../types/message';
import type { RuleConfig } from '../../types/rule';
import type { GameState } from '../../types/state';
import { decideCpuAction, toEngineAction } from '../player';

function readCountEnv(name: string, fallback: number): number {
  const proc = (
    globalThis as unknown as {
      process?: { env?: Record<string, string | undefined> };
    }
  ).process;
  const raw = proc?.env?.[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function assertCond(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function assertStateViewNoLeak(
  state: GameState,
  view: StateView,
  viewerId: string,
): void {
  const rawView = view as unknown as Record<string, unknown>;
  assertCond(rawView.wall === undefined, 'StateView leaked wall');
  assertCond(rawView.deadWall === undefined, 'StateView leaked deadWall');

  if (state.phase === 'playing' || state.phase === 'awaiting_responses') {
    assertCond(
      view.round !== null && view.round.uraDoraIndicators.length === 0,
      'StateView leaked uraDoraIndicators during play',
    );
    assertCond(
      view.round !== null &&
        Object.keys(view.round.revealedHands).length === 0,
      'StateView leaked revealedHands during play',
    );
  }

  for (let i = 0; i < view.players.length; i++) {
    const pv = view.players[i]!;
    const pvRaw = pv as unknown as Record<string, unknown>;
    assertCond(pvRaw.hand === undefined, 'PublicPlayerView leaked hand');
    assertCond(
      pvRaw.drawnTile === undefined,
      'PublicPlayerView leaked drawnTile',
    );
  }

  if (state.phase === 'awaiting_responses' && state.round?.pendingResponse) {
    const pending = state.round.pendingResponse;
    const hasOption =
      viewerId in pending.optionsByPlayerId && !(viewerId in pending.responses);
    if (!hasOption) {
      assertCond(
        view.phase === 'playing',
        `Masked awaiting view leaked phase=${view.phase}`,
      );
      assertCond(
        view.myCallOptions === null,
        'Masked awaiting view leaked myCallOptions',
      );
      assertCond(
        view.responseRemainingMs === null,
        'Masked awaiting view leaked responseRemainingMs',
      );
      if (
        pending.kind !== 'kakan' &&
        pending.kind !== 'ankan' &&
        state.round.wall.length > 0
      ) {
        const nextSeat =
          (pending.discarderSeatIndex + 1) % state.players.length;
        assertCond(
          view.round?.remainingWallCount === state.round.wall.length - 1,
          `Masked remainingWallCount=${view.round?.remainingWallCount} expected=${state.round.wall.length - 1}`,
        );
        assertCond(
          view.round?.turnCount === state.round.turnCount + 1,
          `Masked turnCount=${view.round?.turnCount} expected=${state.round.turnCount + 1}`,
        );
        const nextPublic = view.players.find((p) => p.seatIndex === nextSeat);
        assertCond(
          nextPublic?.hasDrawnTile === true,
          'Masked next player missing hasDrawnTile=true',
        );
        assertCond(
          nextPublic?.isCurrentTurn === true,
          'Masked next player missing isCurrentTurn=true',
        );
      }
    } else {
      assertCond(
        view.phase === 'awaiting_responses',
        `Waiting viewer got phase=${view.phase}`,
      );
      assertCond(
        view.myCallOptions !== null,
        'Waiting viewer missing myCallOptions',
      );
    }
  }
}

function assertScoreConservation(state: GameState, expectedTotal: number): void {
  let playerSum = 0;
  for (let i = 0; i < state.players.length; i++) {
    playerSum += state.players[i]!.score;
  }
  const kyotakuPoints = state.kyotakuCount * 1000;
  assertCond(
    playerSum + kyotakuPoints === expectedTotal,
    `Score conservation violated: ${playerSum} + ${kyotakuPoints} !== ${expectedTotal}`,
  );
}

function runSingleSeededMatch(baseRuleConfig: RuleConfig, seed: number): void {
  const cpuLevels = ['normal', 'easy'] as const;
  const matchRuleConfig: RuleConfig = {
    ...baseRuleConfig,
    cpuLevel: cpuLevels[seed % 2]!,
    doubleRon: seed % 4 !== 0,
    honbaBonus: seed % 3 !== 0,
    allowKuitan: seed % 5 !== 0,
    ...(baseRuleConfig.playerCount === 3
      ? { tsumoLoss: seed % 2 === 1 }
      : {}),
  };
  const rules = deriveRules(matchRuleConfig);
  const expectedTotalScore = rules.playerCount * rules.initialPoints;

  let state = createInitialGameState({
    roomCode: `S${seed}`,
    hostPlayerId: 'p0',
    hostName: 'CPU0',
    ruleConfig: matchRuleConfig,
  });

  for (let i = 1; i < rules.playerCount; i++) {
    const joined = applyAction(state, {
      type: 'JOIN_PLAYER',
      playerId: `p${i}`,
      name: `CPU${i}`,
    });
    if (joined.error) {
      throw new Error(`JOIN_PLAYER failed (seed=${seed}): ${joined.error.code}`);
    }
    state = joined.state;
  }

  let deckSeed = seed * 1009 + 7;
  const initialDeck = buildSeededTestDeck(rules, deckSeed++);
  const expectedTotalTiles = initialDeck.length;

  const started = applyAction(state, {
    type: 'START_GAME',
    shuffledDeck: initialDeck,
  });
  if (started.error) {
    throw new Error(`START_GAME failed (seed=${seed}): ${started.error.code}`);
  }
  state = started.state;

  let guard = 0;
  let lastActionDesc = 'START_GAME';

  try {
    while (state.phase !== 'finished' && guard < 4000) {
      guard++;

      assertScoreConservation(state, expectedTotalScore);
      if (guard % 16 === 1 || state.phase === 'round_end') {
        assertTileConservation(state, expectedTotalTiles);
      }

      if (state.phase === 'round_end') {
        const nextDeck = buildSeededTestDeck(rules, deckSeed++);
        const view = toStateView(state, 'p0', 1000 + guard);
        assertStateViewNoLeak(state, view, 'p0');

        const dec = decideCpuAction(view);
        assertCond(
          dec?.type === 'ADVANCE_ROUND',
          `Expected ADVANCE_ROUND on round_end, got ${dec?.type}`,
        );

        const res = applyAction(
          state,
          toEngineAction('p0', dec!, {
            now: 1000 + guard,
            shuffledDeck: nextDeck,
          })!,
        );
        if (res.error) {
          throw new Error(
            `ADVANCE_ROUND error: ${res.error.code} ${res.error.message}`,
          );
        }
        state = res.state;
        lastActionDesc = 'ADVANCE_ROUND';
        continue;
      }

      if (state.phase === 'awaiting_responses') {
        const pending = state.round?.pendingResponse;
        if (!pending) {
          throw new Error('awaiting_responses without pendingResponse');
        }
        let actingPid: string | null = null;
        let actingView: StateView | null = null;

        for (const p of state.players) {
          const v = toStateView(state, p.playerId, 1000 + guard);
          assertStateViewNoLeak(state, v, p.playerId);
          if (
            !actingPid &&
            p.playerId in pending.optionsByPlayerId &&
            !(p.playerId in pending.responses)
          ) {
            actingPid = p.playerId;
            actingView = v;
          }
        }

        if (!actingPid || !actingView) {
          throw new Error('awaiting_responses has no unresponded player');
        }
        const dec = decideCpuAction(actingView) ?? {
          type: 'CALL_RESPONSE' as const,
          choice: { type: 'pass' as const },
        };
        const action = toEngineAction(actingPid, dec, { now: 1000 + guard })!;
        const res = applyAction(state, action);
        if (res.error) {
          throw new Error(
            `CALL_RESPONSE error (${actingPid}): ${res.error.code} ${res.error.message}`,
          );
        }
        state = res.state;
        lastActionDesc = `${actingPid}:${dec.type}`;
        continue;
      }

      if (state.phase !== 'playing' || !state.round) {
        throw new Error(`Unexpected phase: ${state.phase}`);
      }

      const current = state.players.find(
        (p) => p.seatIndex === state.round!.currentTurnIndex,
      );
      if (!current) {
        throw new Error(
          `Current turn player not found: ${state.round.currentTurnIndex}`,
        );
      }

      const view = toStateView(state, current.playerId, 1000 + guard);
      assertStateViewNoLeak(state, view, current.playerId);

      if (guard % 8 === 1) {
        for (const other of state.players) {
          if (other.playerId !== current.playerId) {
            const ov = toStateView(state, other.playerId, 1000 + guard);
            assertStateViewNoLeak(state, ov, other.playerId);
          }
        }
      }

      const dec = decideCpuAction(view);
      if (!dec) {
        throw new Error(`decideCpuAction returned null for ${current.playerId}`);
      }

      const action = toEngineAction(current.playerId, dec, {
        now: 1000 + guard,
      })!;
      let res = applyAction(state, action);
      if (res.error && dec.type !== 'DISCARD_TILE' && view.myDrawnTile) {
        res = applyAction(state, {
          type: 'DISCARD_TILE',
          playerId: current.playerId,
          tileId: view.myDrawnTile.id,
          now: 1000 + guard,
        });
      }
      if (res.error) {
        throw new Error(
          `Action error (${current.playerId} ${dec.type}): ${res.error.code} ${res.error.message}`,
        );
      }
      state = res.state;
      lastActionDesc = `${current.playerId}:${dec.type}`;
    }

    assertCond(
      state.phase === 'finished',
      `Match did not reach finished within ${guard} steps (phase=${state.phase})`,
    );
    assertCond(
      state.kyotakuCount === 0,
      `Expected kyotakuCount=0 on finished, got ${state.kyotakuCount}`,
    );
    assertScoreConservation(state, expectedTotalScore);
  } catch (err) {
    const context = {
      seed,
      playerCount: baseRuleConfig.playerCount,
      gameLength: baseRuleConfig.gameLength,
      cpuLevel: matchRuleConfig.cpuLevel,
      doubleRon: matchRuleConfig.doubleRon,
      tsumoLoss: matchRuleConfig.tsumoLoss,
      step: guard,
      phase: state.phase,
      roundIndex: state.round?.roundIndex,
      kyokuNumber: state.round?.kyokuNumber,
      turnCount: state.round?.turnCount,
      lastActionDesc,
    };
    throw new Error(
      `Selfplay failed [${JSON.stringify(context)}]: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

describe('修正7: 決定論的シードによる大規模セルフプレイ整合性検証', () => {
  const count4pTonpuu = readCountEnv('SELFPLAY_4P_TONPUU', 100);
  const count3pTonpuu = readCountEnv('SELFPLAY_3P_TONPUU', 100);
  const count4pHanchan = readCountEnv('SELFPLAY_4P_HANCHAN', 30);
  const count3pHanchan = readCountEnv('SELFPLAY_3P_HANCHAN', 30);

  it(`4人東風 (${count4pTonpuu}試合) が例外なく完走し保存則・StateView非漏洩を満たす`, () => {
    for (let i = 0; i < count4pTonpuu; i++) {
      runSingleSeededMatch({ playerCount: 4, gameLength: 'tonpuu' }, 10000 + i);
    }
    expect(count4pTonpuu).toBeGreaterThanOrEqual(0);
  }, 60000);

  it(`3人東風 (${count3pTonpuu}試合) が例外なく完走し保存則・StateView非漏洩を満たす`, () => {
    for (let i = 0; i < count3pTonpuu; i++) {
      runSingleSeededMatch({ playerCount: 3, gameLength: 'tonpuu' }, 20000 + i);
    }
    expect(count3pTonpuu).toBeGreaterThanOrEqual(0);
  }, 60000);

  it(`4人半荘 (${count4pHanchan}試合) が例外なく完走し保存則・StateView非漏洩を満たす`, () => {
    for (let i = 0; i < count4pHanchan; i++) {
      runSingleSeededMatch({ playerCount: 4, gameLength: 'hanchan' }, 30000 + i);
    }
    expect(count4pHanchan).toBeGreaterThanOrEqual(0);
  }, 60000);

  it(`3人半荘 (${count3pHanchan}試合) が例外なく完走し保存則・StateView非漏洩を満たす`, () => {
    for (let i = 0; i < count3pHanchan; i++) {
      runSingleSeededMatch({ playerCount: 3, gameLength: 'hanchan' }, 40000 + i);
    }
    expect(count3pHanchan).toBeGreaterThanOrEqual(0);
  }, 60000);
});
