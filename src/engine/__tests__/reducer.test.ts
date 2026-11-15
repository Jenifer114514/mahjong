import { describe, expect, it } from 'vitest';
import type { RuleConfig } from '../../types/rule';
import type { GameState } from '../../types/state';
import { applyAction, createInitialGameState, reduce, validateAction } from '../reducer';
import { deriveRules, getSeatWind } from '../rules';
import { countAllDeadWallTiles } from '../wall';
import {
  assertTileConservation,
  buildSeededTestDeck,
  passAllPendingResponses,
} from './testHelpers';

function setupFullLobby(ruleConfig: RuleConfig): GameState {
  let state = createInitialGameState({
    roomCode: 'ABC123',
    hostPlayerId: 'host',
    hostName: 'ホスト',
    ruleConfig,
  });

  for (let i = 1; i < ruleConfig.playerCount; i++) {
    state = reduce(state, {
      type: 'JOIN_PLAYER',
      playerId: `guest-${i}`,
      name: `ゲスト${i}`,
    });
  }

  return state;
}

function playUntilExhaustiveDraw(initial: GameState): GameState {
  let state = initial;
  let guard = 0;
  while (state.phase === 'playing') {
    guard++;
    if (guard > 200) {
      throw new Error('Infinite loop detected during round play');
    }
    const round = state.round!;
    const currentPlayer = state.players.find(
      (p) => p.seatIndex === round.currentTurnIndex,
    )!;
    // ツモ切りと手出しを交互に混ぜて両方検証する
    const tileToDiscard =
      guard % 2 === 0 && currentPlayer.hand[0]
        ? currentPlayer.hand[0]
        : currentPlayer.drawnTile!;

    const result = applyAction(state, {
      type: 'DISCARD_TILE',
      playerId: currentPlayer.playerId,
      tileId: tileToDiscard.id,
    });
    expect(result.error).toBeNull();
    state = passAllPendingResponses(result.state);
  }
  return state;
}

describe('reducer: 4通り (3人/4人 × 東風/半荘) の完全フロー検証', () => {
  const configs: Array<{
    label: string;
    ruleConfig: RuleConfig;
    expectedTotalRounds: number;
    expectedInitialPoints: number;
    expectedTotalTiles: number;
    expectedPlayableDrawsPerRound: number;
  }> = [
    {
      label: '4人 × 東風戦',
      ruleConfig: { playerCount: 4, gameLength: 'tonpuu' },
      expectedTotalRounds: 4,
      expectedInitialPoints: 25000,
      expectedTotalTiles: 136,
      expectedPlayableDrawsPerRound: 70,
    },
    {
      label: '4人 × 半荘戦',
      ruleConfig: { playerCount: 4, gameLength: 'hanchan' },
      expectedTotalRounds: 8,
      expectedInitialPoints: 25000,
      expectedTotalTiles: 136,
      expectedPlayableDrawsPerRound: 70,
    },
    {
      label: '3人 × 東風戦',
      ruleConfig: { playerCount: 3, gameLength: 'tonpuu' },
      expectedTotalRounds: 3,
      expectedInitialPoints: 35000,
      expectedTotalTiles: 108,
      expectedPlayableDrawsPerRound: 55,
    },
    {
      label: '3人 × 半荘戦',
      ruleConfig: { playerCount: 3, gameLength: 'hanchan' },
      expectedTotalRounds: 6,
      expectedInitialPoints: 35000,
      expectedTotalTiles: 108,
      expectedPlayableDrawsPerRound: 55,
    },
  ];

  it.each(configs)(
    '$label: 配牌・ツモ打牌・流局・親の順・規定局終了まで正しく進行する',
    ({
      ruleConfig,
      expectedTotalRounds,
      expectedInitialPoints,
      expectedTotalTiles,
      expectedPlayableDrawsPerRound,
    }) => {
      const rules = deriveRules(ruleConfig);
      let state = setupFullLobby(ruleConfig);

      state = reduce(state, {
        type: 'START_GAME',
        shuffledDeck: buildSeededTestDeck(rules, 20261116),
      });
      expect(state.phase).toBe('playing');
      expect(state.players).toHaveLength(ruleConfig.playerCount);

      for (const p of state.players) {
        expect(p.score).toBe(expectedInitialPoints);
      }

      const observedRoundHeaders: string[] = [];
      const observedDealers: number[] = [];

      for (let roundIdx = 0; roundIdx < expectedTotalRounds; roundIdx++) {
        expect(state.phase).toBe('playing');
        expect(state.round).not.toBeNull();
        const round = state.round!;
        observedRoundHeaders.push(`${round.roundWind}${round.kyokuNumber}`);
        observedDealers.push(round.dealerIndex);

        // 親が第1ツモを持っていること
        const dealer = state.players.find((p) => p.seatIndex === round.dealerIndex)!;
        expect(dealer.drawnTile).not.toBeNull();
        expect(dealer.hand).toHaveLength(13);

        // 親の席風は常に東であること
        expect(
          getSeatWind(round.dealerIndex, round.dealerIndex, rules.seatWinds),
        ).toBe('E');

        // 合計牌数チェック
        assertTileConservation(state, expectedTotalTiles);
        expect(countAllDeadWallTiles(round.deadWall)).toBe(14);
        expect(round.wall.length).toBe(expectedPlayableDrawsPerRound - 1);

        // 山が尽きるまでツモ→打牌を回す
        state = playUntilExhaustiveDraw(state);
        expect(state.phase).toBe('round_end');
        expect(state.round!.wall).toHaveLength(0);
        expect(state.round!.turnCount).toBe(expectedPlayableDrawsPerRound);

        // 全プレイヤーの手牌は13枚、ツモ牌はnull、捨て牌合計はツモ総数と一致
        const totalDiscards = state.players.reduce(
          (sum, p) => sum + p.discards.length,
          0,
        );
        expect(totalDiscards).toBe(expectedPlayableDrawsPerRound);
        for (const p of state.players) {
          expect(p.hand).toHaveLength(13);
          expect(p.drawnTile).toBeNull();
        }
        assertTileConservation(state, expectedTotalTiles);

        // ホストが次局へ進める
        state = reduce(state, {
          type: 'ADVANCE_ROUND',
          playerId: state.hostPlayerId,
          shuffledDeck: buildSeededTestDeck(rules, 5000 + roundIdx),
        });
      }

      expect(state.phase).toBe('finished');
      expect(state.round).toBeNull();

      // 親の順番（全員を1周 / 2周）
      const expectedDealerSeq = Array.from(
        { length: expectedTotalRounds },
        (_, i) => i % ruleConfig.playerCount,
      );
      expect(observedDealers).toEqual(expectedDealerSeq);

      // 局表記（東1.. / 南1..）
      const expectedHeaders =
        ruleConfig.gameLength === 'tonpuu'
          ? Array.from({ length: ruleConfig.playerCount }, (_, i) => `E${i + 1}`)
          : [
              ...Array.from({ length: ruleConfig.playerCount }, (_, i) => `E${i + 1}`),
              ...Array.from({ length: ruleConfig.playerCount }, (_, i) => `S${i + 1}`),
            ];
      expect(observedRoundHeaders).toEqual(expectedHeaders);

      // 最終持ち点が残っていること
      for (const p of state.players) {
        expect(p.score).toBe(expectedInitialPoints);
      }
    },
  );
});

describe('reducer & validateAction: 合法性検証', () => {
  it('定員未満では開始できず、定員超過の参加は拒否される', () => {
    const ruleConfig = { playerCount: 3 as const, gameLength: 'tonpuu' as const };
    const rules = deriveRules(ruleConfig);
    let state = createInitialGameState({
      roomCode: 'ROOM01',
      hostPlayerId: 'host',
      hostName: 'ホスト',
      ruleConfig,
    });

    expect(
      validateAction(state, {
        type: 'START_GAME',
        shuffledDeck: buildSeededTestDeck(rules, 1),
      })?.code,
    ).toBe('NOT_ENOUGH_PLAYERS');

    state = reduce(state, { type: 'JOIN_PLAYER', playerId: 'p2', name: 'P2' });
    state = reduce(state, { type: 'JOIN_PLAYER', playerId: 'p3', name: 'P3' });

    const overflow = applyAction(state, {
      type: 'JOIN_PLAYER',
      playerId: 'p4',
      name: 'P4',
    });
    expect(overflow.error?.code).toBe('ROOM_FULL');
    expect(overflow.state).toBe(state);
  });

  it('手番外打牌・未所持牌の打牌・非ホストによる次局進行を拒否し状態を変更しない', () => {
    const ruleConfig = { playerCount: 4 as const, gameLength: 'tonpuu' as const };
    const rules = deriveRules(ruleConfig);
    const lobby = setupFullLobby(ruleConfig);
    let state = reduce(lobby, {
      type: 'START_GAME',
      shuffledDeck: buildSeededTestDeck(rules, 42),
    });

    const round = state.round!;
    const currentPlayer = state.players.find(
      (p) => p.seatIndex === round.currentTurnIndex,
    )!;
    const otherPlayer = state.players.find(
      (p) => p.seatIndex !== round.currentTurnIndex,
    )!;

    // 他家のターンで打牌要求
    const notYourTurn = applyAction(state, {
      type: 'DISCARD_TILE',
      playerId: otherPlayer.playerId,
      tileId: otherPlayer.hand[0]!.id,
    });
    expect(notYourTurn.error?.code).toBe('NOT_YOUR_TURN');
    expect(notYourTurn.state).toBe(state);

    // 持っていない牌を打牌要求
    const missingTile = applyAction(state, {
      type: 'DISCARD_TILE',
      playerId: currentPlayer.playerId,
      tileId: otherPlayer.hand[0]!.id,
    });
    expect(missingTile.error?.code).toBe('TILE_NOT_IN_HAND');
    expect(missingTile.state).toBe(state);

    // 流局まで進めて非ホストの次局進行を拒否
    state = playUntilExhaustiveDraw(state);
    const nonHostAdvance = applyAction(state, {
      type: 'ADVANCE_ROUND',
      playerId: 'guest-1',
      shuffledDeck: buildSeededTestDeck(rules, 99),
    });
    expect(nonHostAdvance.error?.code).toBe('UNAUTHORIZED_ACTION');
    expect(nonHostAdvance.state).toBe(state);
  });

  it('手出しした牌が捨て牌に並び、ツモ牌が手牌に組み込まれて理牌される', () => {
    const ruleConfig = { playerCount: 4 as const, gameLength: 'tonpuu' as const };
    const rules = deriveRules(ruleConfig);
    const lobby = setupFullLobby(ruleConfig);
    const started = reduce(lobby, {
      type: 'START_GAME',
      shuffledDeck: buildSeededTestDeck(rules, 777),
    });
    const dealer = started.players.find(
      (p) => p.seatIndex === started.round!.currentTurnIndex,
    )!;
    const discardTarget = dealer.hand[0]!;
    const drawnBefore = dealer.drawnTile!;

    const after = passAllPendingResponses(
      reduce(started, {
        type: 'DISCARD_TILE',
        playerId: dealer.playerId,
        tileId: discardTarget.id,
      }),
    );

    const updatedDealer = after.players.find(
      (p) => p.playerId === dealer.playerId,
    )!;
    expect(updatedDealer.hand).toHaveLength(13);
    expect(updatedDealer.drawnTile).toBeNull();
    expect(updatedDealer.hand.some((t) => t.id === drawnBefore.id)).toBe(true);
    expect(updatedDealer.hand.some((t) => t.id === discardTarget.id)).toBe(false);
    expect(updatedDealer.discards).toEqual([
      { tile: discardTarget, isTsumogiri: false },
    ]);
  });
});
