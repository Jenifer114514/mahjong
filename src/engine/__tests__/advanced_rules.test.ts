import { describe, expect, it } from 'vitest';
import { deriveRules } from '../rules';
import { buildTileDeck, validateDeckForRules } from '../wall';
import { countDoraAndKita } from '../dora';
import { evaluateBestAgari, resolveBasePoints } from '../score';
import { toStateView } from '../projection';
import { createInitialGameState, reduce } from '../reducer';
import { mergeRuleConfig } from '../reducerHelpers';
import type { Tile, TileKind } from '../../types/tile';
import { createStartedCustomGame } from './testHelpers';

function tile(id: string, kind: TileKind, isRed = false): Tile {
  return { id, kind, isRed };
}

describe('詳細設定ルール（8項目）と裏設定 Peek プロジェクション', () => {
  it('デフォルトでは赤ドラは各5牌1枚ずつ（4麻3枚・3麻2枚）が標準になる', () => {
    const rules4 = deriveRules({ playerCount: 4, gameLength: 'tonpuu' });
    expect(rules4.redDoraPerFive).toBe(1);
    const deck4 = buildTileDeck(rules4);
    expect(validateDeckForRules(rules4, deck4)).toBe(true);
    expect(deck4.filter((t) => t.isRed).map((t) => t.kind).sort()).toEqual([
      '5m',
      '5p',
      '5s',
    ]);

    const rules3 = deriveRules({ playerCount: 3, gameLength: 'tonpuu' });
    expect(rules3.redDoraPerFive).toBe(1);
    const deck3 = buildTileDeck(rules3);
    expect(validateDeckForRules(rules3, deck3)).toBe(true);
    expect(deck3.filter((t) => t.isRed).map((t) => t.kind).sort()).toEqual([
      '5p',
      '5s',
    ]);
  });

  it('redDoraPerFive=0 で赤ドラなし、redDoraPerFive=4 で全5牌が赤ドラになり翻数加算される', () => {
    const r4Zero = deriveRules({
      playerCount: 4,
      gameLength: 'tonpuu',
      redDoraPerFive: 0,
    });
    expect(r4Zero.redDoraPerFive).toBe(0);
    const deck4Zero = buildTileDeck(r4Zero);
    expect(validateDeckForRules(r4Zero, deck4Zero)).toBe(true);
    expect(deck4Zero.filter((t) => t.isRed)).toHaveLength(0);

    const r4All = deriveRules({
      playerCount: 4,
      gameLength: 'tonpuu',
      redDoraPerFive: 4,
    });
    const deck4All = buildTileDeck(r4All);
    expect(validateDeckForRules(r4All, deck4All)).toBe(true);
    expect(deck4All.filter((t) => t.isRed)).toHaveLength(12);

    const redResult = countDoraAndKita({
      hand: [tile('a', '5m', true), tile('b', '5p', true)],
      winningTile: tile('c', '5s', true),
      melds: [],
      kitaTiles: [],
      doraIndicators: [tile('ind', '4z')],
      uraDoraIndicators: [],
      rules: r4All,
    });
    expect(redResult.doraCount).toBe(3);

    const agari = evaluateBestAgari({
      hand: [
        tile('1', '3m'),
        tile('2', '4m'),
        tile('3', '5m', true),
        tile('4', '3p'),
        tile('5', '4p'),
        tile('6', '5p', true),
        tile('7', '3s'),
        tile('8', '4s'),
        tile('9', '2m'),
        tile('10', '2m'),
        tile('11', '6p'),
        tile('12', '7p'),
        tile('13', '8p'),
      ],
      melds: [],
      kitaTiles: [],
      winningTile: tile('14', '5s', true),
      isTsumo: false,
      isRiichi: true,
      isDealer: false,
      roundWind: 'E',
      seatWind: 'S',
      doraIndicators: [tile('ind', '4z')],
      dealerIndex: 0,
      winnerSeatIndex: 1,
      fromSeatIndex: 2,
      rules: r4All,
    });
    expect(agari?.doraCount).toBe(3);
  });

  it('切り上げ満貫(kiriageMangan)・数え役満(allowKazoeYakuman)・連風牌符(doubleWindPairFu)が正しく反映される', () => {
    const rStd = deriveRules({ playerCount: 4, gameLength: 'tonpuu' });
    const rAdv = deriveRules({
      playerCount: 4,
      gameLength: 'tonpuu',
      kiriageMangan: true,
      allowKazoeYakuman: false,
      doubleWindPairFu: 2,
    });

    expect(resolveBasePoints(4, 30, false, rStd).scoreLabel).toBe('30符4翻');
    expect(resolveBasePoints(4, 30, false, rAdv).scoreLabel).toBe('満貫');
    expect(resolveBasePoints(13, 30, false, rStd).scoreLabel).toBe('数え役満');
    expect(resolveBasePoints(13, 30, false, rAdv).scoreLabel).toBe('三倍満');

    const handSharp: Tile[] = [
      tile('1', '2m'),
      tile('2', '3m'),
      tile('3', '4m'),
      tile('4', '5p'),
      tile('5', '6p'),
      tile('6', '7p'),
      tile('7', '7z'),
      tile('8', '7z'),
      tile('9', '7z'),
      tile('10', '1z'),
      tile('11', '1z'),
      tile('12', '2s'),
      tile('13', '3s'),
    ];
    const a4 = evaluateBestAgari({
      hand: handSharp,
      melds: [],
      kitaTiles: [],
      winningTile: tile('14', '4s'),
      isTsumo: false,
      isDealer: true,
      roundWind: 'E',
      seatWind: 'E',
      doraIndicators: [tile('d1', '4z')],
      dealerIndex: 0,
      winnerSeatIndex: 0,
      fromSeatIndex: 1,
      rules: rStd,
    });
    const a2 = evaluateBestAgari({
      hand: handSharp,
      melds: [],
      kitaTiles: [],
      winningTile: tile('14', '4s'),
      isTsumo: false,
      isDealer: true,
      roundWind: 'E',
      seatWind: 'E',
      doraIndicators: [tile('d1', '4z')],
      dealerIndex: 0,
      winnerSeatIndex: 0,
      fromSeatIndex: 1,
      rules: rAdv,
    });
    expect(a4?.fu).toBe(50);
    expect(a2?.fu).toBe(40);
  });

  it('初期持ち点(initialPoints)・ノーテン罰符(notenPenaltyTotal)・鳴き制限時間・カン上限が導出およびリセットされる', () => {
    const state = createInitialGameState({
      roomCode: 'ADV001',
      hostPlayerId: 'p0',
      hostName: 'ホスト',
      ruleConfig: {
        playerCount: 4,
        gameLength: 'tonpuu',
        initialPoints: 50000,
        notenPenaltyTotal: 0,
        responseTimeoutMs: 0,
        maxKansPerRound: 8,
      },
    });
    let cur = reduce(state, { type: 'JOIN_PLAYER', playerId: 'p1', name: 'P1' });
    cur = reduce(cur, { type: 'JOIN_PLAYER', playerId: 'p2', name: 'P2' });
    cur = reduce(cur, { type: 'JOIN_PLAYER', playerId: 'p3', name: 'P3' });
    expect(cur.players.every((p) => p.score === 50000)).toBe(true);

    const rules = deriveRules(cur.ruleConfig);
    expect(rules.initialPoints).toBe(50000);
    expect(rules.notenPenaltyTotal).toBe(0);
    expect(rules.responseTimeoutMs).toBe(0);
    expect(rules.maxKansPerRound).toBe(8);

    // initialPoints: undefined で人数標準値に戻る
    const resetCfg = mergeRuleConfig(cur.ruleConfig, { initialPoints: undefined });
    expect('initialPoints' in resetCfg).toBe(false);
    expect(deriveRules(resetCfg).initialPoints).toBe(25000);
  });

  it('toStateView は既定で他家手牌を隠し、revealOpponentHands=true の対局者視点のみ公開し観戦者には公開しない', () => {
    const state = createStartedCustomGame(4, { hands: {} });
    expect(toStateView(state, 'p0', 1000).round?.revealedHands).toEqual({});

    const peek = toStateView(state, 'p0', 1000, { revealOpponentHands: true });
    expect(Object.keys(peek.round?.revealedHands ?? {}).sort()).toEqual([
      'p1',
      'p2',
      'p3',
    ]);
    expect(peek.round?.revealedHands['p1']).toHaveLength(
      state.players[1]!.hand.length,
    );

    const stateWithSpec = {
      ...state,
      spectators: [
        {
          spectatorId: 'spectator-1',
          name: '観戦',
          joinedAt: 1000,
          connected: true,
        },
      ],
    };
    const specView = toStateView(stateWithSpec, 'spectator-1', 1000, {
      revealOpponentHands: true,
    });
    expect(specView.isSpectator).toBe(true);
    expect(specView.round?.revealedHands).toEqual({});
  });
});
