import type { DerivedRules } from '../../types/rule';
import type { GameState } from '../../types/state';
import type { Tile } from '../../types/tile';
import { applyAction, createInitialGameState, reduce } from '../reducer';
import { buildTileDeck, countAllDeadWallTiles } from '../wall';

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** テスト用の決定論的シャッフル済み山（本番コードには含めない） */
export function buildSeededTestDeck(rules: DerivedRules, seed: number): Tile[] {
  const result = buildTileDeck(rules);
  const rand = mulberry32(seed);
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const a = result[i]!;
    const b = result[j]!;
    result[i] = b;
    result[j] = a;
  }
  return result;
}

/** 鳴き・ロン応答待ち状態であれば全候補者をスルーさせて進行するテスト用ヘルパー */
export function passAllPendingResponses(state: GameState): GameState {
  let current = state;
  if (
    current.phase === 'awaiting_responses' &&
    current.round?.pendingResponse
  ) {
    const pending = current.round.pendingResponse;
    for (const pid of Object.keys(pending.optionsByPlayerId)) {
      if (current.phase !== 'awaiting_responses') break;
      const res = applyAction(current, {
        type: 'CALL_RESPONSE',
        playerId: pid,
        choice: { type: 'pass' },
      });
      if (res.error) {
        throw new Error(`Unexpected pass error: ${res.error.code}`);
      }
      current = res.state;
    }
  }
  return current;
}

/** ゲーム内の全牌IDを収集し、枚数・重複・構成の一致を検証する */
export function collectAllTileIds(state: GameState): string[] {
  const ids: string[] = [];
  if (state.round) {
    ids.push(...state.round.wall.map((t) => t.id));
    ids.push(...state.round.deadWall.rinshanTiles.map((t) => t.id));
    ids.push(...state.round.deadWall.doraIndicators.map((t) => t.id));
    ids.push(...state.round.deadWall.uraDoraIndicators.map((t) => t.id));
  }
  for (const p of state.players) {
    ids.push(...p.hand.map((t) => t.id));
    if (p.drawnTile) ids.push(p.drawnTile.id);
    ids.push(...p.discards.map((d) => d.tile.id));
    for (const m of p.melds) {
      ids.push(...m.tiles.map((t) => t.id));
    }
    ids.push(...p.kitaTiles.map((t) => t.id));
  }
  return ids;
}

export function assertTileConservation(
  state: GameState,
  expectedTotalTiles: number,
): void {
  const allIds = collectAllTileIds(state);
  if (allIds.length !== expectedTotalTiles) {
    throw new Error(
      `Expected ${expectedTotalTiles} tiles in game, got ${allIds.length}`,
    );
  }
  if (new Set(allIds).size !== expectedTotalTiles) {
    throw new Error('Duplicate tile IDs detected in game state');
  }
  if (state.round && countAllDeadWallTiles(state.round.deadWall) !== 14) {
    throw new Error(
      `Dead wall size drifted to ${countAllDeadWallTiles(state.round.deadWall)}`,
    );
  }
}

/**
 * 狙った手牌・山牌構成を簡単に組み立てるテスト用ビルダー。
 * 指定しなかった牌は残りの山から自動充填して完全なデッキを作る。
 */
export function buildCustomDeck(
  rules: DerivedRules,
  spec: {
    dealerIndex?: number;
    hands: Partial<Record<number, string[]>>; // 例: { 0: ['1m','1m','2m', ...], 1: [...] } (tile.kind 配列)
    dealerDrawnKind?: string;
    liveWallHeadKinds?: string[]; // 以降のツモ順 (先頭から順に引かれる)
    wallTailKinds?: string[]; // 牌山最後尾（嶺上補充用：末尾が最初に補充される -> 配列末尾が一番最後尾）
    rinshanKinds?: string[]; // 王牌嶺上4枚
    doraIndicatorKinds?: string[]; // 表ドラ表示5枚
  },
): Tile[] {
  const pool = buildTileDeck(rules);
  const used = new Set<string>();

  const takeByKind = (kind: string): Tile => {
    const found = pool.find((t) => t.kind === kind && !used.has(t.id));
    if (!found) {
      throw new Error(`Not enough copies of kind ${kind} in custom deck spec`);
    }
    used.add(found.id);
    return found;
  };

  const dealerIndex = spec.dealerIndex ?? 0;
  const liveSize = rules.totalTiles - rules.deadWallSize;

  // 1. まず全指定枠（手牌・親ツモ・ツモ順先頭・牌山末尾・王牌嶺上・ドラ表示）の牌を確保
  const handSlots: Tile[][] = Array.from({ length: rules.playerCount }, () => []);
  for (let seat = 0; seat < rules.playerCount; seat++) {
    const kinds = spec.hands[seat] ?? [];
    if (kinds.length > rules.handSize) {
      throw new Error(`Seat ${seat} hand spec exceeds ${rules.handSize}`);
    }
    for (const k of kinds) {
      handSlots[seat]!.push(takeByKind(k));
    }
  }

  const dealerDrawnTile = spec.dealerDrawnKind
    ? takeByKind(spec.dealerDrawnKind)
    : null;
  const headTiles = (spec.liveWallHeadKinds ?? []).map(takeByKind);
  const tailTiles = (spec.wallTailKinds ?? []).map(takeByKind);
  const rinshanTiles = (spec.rinshanKinds ?? []).map(takeByKind);
  const doraTiles = (spec.doraIndicatorKinds ?? []).map(takeByKind);

  const remaining = pool.filter((t) => !used.has(t.id));
  let remIdx = 0;
  const takeNextUnused = (): Tile => {
    const t = remaining[remIdx];
    if (!t) throw new Error('Ran out of remaining tiles');
    remIdx++;
    return t;
  };

  for (let seat = 0; seat < rules.playerCount; seat++) {
    while (handSlots[seat]!.length < rules.handSize) {
      handSlots[seat]!.push(takeNextUnused());
    }
  }

  const liveWall: Tile[] = [];
  for (let round = 0; round < rules.handSize; round++) {
    for (let offset = 0; offset < rules.playerCount; offset++) {
      const seat = (dealerIndex + offset) % rules.playerCount;
      liveWall.push(handSlots[seat]![round]!);
    }
  }
  liveWall.push(dealerDrawnTile ?? takeNextUnused());
  liveWall.push(...headTiles);

  const fillerNeeded = liveSize - liveWall.length - tailTiles.length;
  if (fillerNeeded < 0) {
    throw new Error('Custom deck liveWallHeadKinds + wallTailKinds overflowed live wall');
  }
  for (let i = 0; i < fillerNeeded; i++) {
    liveWall.push(takeNextUnused());
  }
  liveWall.push(...tailTiles);

  while (rinshanTiles.length < rules.rinshanSize) {
    rinshanTiles.push(takeNextUnused());
  }
  while (doraTiles.length < rules.doraIndicatorCount) {
    doraTiles.push(takeNextUnused());
  }
  const uraTiles: Tile[] = [];
  while (uraTiles.length < rules.uraDoraIndicatorCount) {
    uraTiles.push(takeNextUnused());
  }

  return [...liveWall, ...rinshanTiles, ...doraTiles, ...uraTiles];
}

export function createStartedCustomGame(
  playerCount: 3 | 4,
  spec: Parameters<typeof buildCustomDeck>[1],
  ruleOverrides: Partial<Parameters<typeof createInitialGameState>[0]['ruleConfig']> = {},
): GameState {
  const ruleConfig = {
    playerCount,
    gameLength: 'tonpuu' as const,
    ...ruleOverrides,
  };
  let state = createInitialGameState({
    roomCode: 'TEST01',
    hostPlayerId: 'p0',
    hostName: 'P0',
    ruleConfig,
  });
  for (let i = 1; i < playerCount; i++) {
    state = reduce(state, {
      type: 'JOIN_PLAYER',
      playerId: `p${i}`,
      name: `P${i}`,
    });
  }
  const rules = {
    ...(awaitRules(ruleConfig)),
  };
  const deck = buildCustomDeck(rules, spec);
  return reduce(state, {
    type: 'START_GAME',
    shuffledDeck: deck,
  });
}

import { deriveRules } from '../rules';
function awaitRules(cfg: Parameters<typeof deriveRules>[0]) {
  return deriveRules(cfg);
}
