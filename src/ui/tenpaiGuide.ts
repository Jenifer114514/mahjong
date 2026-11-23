import { getTenpaiWaitKinds } from '../engine/agari';
import { getActiveDoraKinds } from '../engine/dora';
import { deriveRules } from '../engine/rules';
import type { StateView } from '../types/message';
import type { Tile, TileKind } from '../types/tile';

export interface TenpaiWaitEntry {
  kind: TileKind;
  remainingCount: number;
  isFuriten: boolean;
  isDora: boolean;
}

export interface TenpaiGuideInfo {
  mode: 'waiting' | 'discard_preview';
  discardTile: Tile | null;
  waits: TenpaiWaitEntry[];
  totalRemainingCount: number;
  hasFuritenWait: boolean;
}

function collectVisibleTileCounts(view: StateView): Map<TileKind, number> {
  const counts = new Map<TileKind, number>();
  const add = (kind: TileKind) => {
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  };

  for (const tile of view.myHand) {
    add(tile.kind);
  }
  if (view.myDrawnTile) {
    add(view.myDrawnTile.kind);
  }
  for (const player of view.players) {
    for (const d of player.discards) {
      add(d.tile.kind);
    }
    for (const m of player.melds) {
      for (const t of m.tiles) {
        add(t.kind);
      }
      if (m.type === 'kakan' && m.addedTile) {
        add(m.addedTile.kind);
      }
    }
    for (const k of player.kitaTiles) {
      add(k.kind);
    }
  }
  if (view.round) {
    for (const ind of view.round.doraIndicators) {
      add(ind.kind);
    }
  }
  return counts;
}

export function computeSelfTenpaiGuide(
  view: StateView,
  selectedTileId: string | null,
): TenpaiGuideInfo | null {
  if (view.isSpectator || view.phase !== 'playing' || !view.round) {
    return null;
  }

  const selfPlayer = view.players.find(
    (p) => p.seatIndex === view.viewerSeatIndex,
  );
  if (!selfPlayer) return null;

  const rules = deriveRules(view.ruleConfig);
  const expectedTenpaiCount = (4 - selfPlayer.melds.length) * 3 + 1;
  const allTiles = view.myDrawnTile
    ? [...view.myHand, view.myDrawnTile]
    : [...view.myHand];

  let targetRemaining: Tile[] | null = null;
  let discardTile: Tile | null = null;
  let mode: 'waiting' | 'discard_preview' = 'waiting';

  const isMyTurn = selfPlayer.isCurrentTurn;
  const canDiscardNow = isMyTurn && allTiles.length === expectedTenpaiCount + 1;

  if (canDiscardNow && selectedTileId !== null) {
    const idx = allTiles.findIndex((t) => t.id === selectedTileId);
    if (idx !== -1) {
      discardTile = allTiles[idx]!;
      targetRemaining = allTiles.filter((_, i) => i !== idx);
      mode = 'discard_preview';
    }
  } else if (
    !canDiscardNow &&
    view.myDrawnTile === null &&
    view.myHand.length === expectedTenpaiCount
  ) {
    targetRemaining = [...view.myHand];
    mode = 'waiting';
  } else if (canDiscardNow && selfPlayer.isRiichi && view.myHand.length === expectedTenpaiCount) {
    // リーチ中はツモ牌以外切れないため、手牌そのものの待ちを常に表示しておく
    targetRemaining = [...view.myHand];
    mode = 'waiting';
  }

  if (!targetRemaining) return null;

  const waitKinds = getTenpaiWaitKinds(targetRemaining, selfPlayer.melds, rules);
  if (waitKinds.length === 0) return null;

  const visibleCounts = collectVisibleTileCounts(view);
  const activeDoraSet = new Set(
    getActiveDoraKinds(view.round.doraIndicators, rules),
  );
  if (rules.playerCount === 3 && rules.kitaCountsAsIndicatorDora) {
    activeDoraSet.add('4z');
  }
  const selfDiscardKinds = new Set(selfPlayer.discards.map((d) => d.tile.kind));

  const waits: TenpaiWaitEntry[] = waitKinds.map((kind) => {
    const remainingCount = Math.max(0, 4 - (visibleCounts.get(kind) ?? 0));
    return {
      kind,
      remainingCount,
      isFuriten: selfDiscardKinds.has(kind),
      isDora: activeDoraSet.has(kind),
    };
  });

  const totalRemainingCount = waits.reduce(
    (sum, w) => sum + w.remainingCount,
    0,
  );
  const hasFuritenWait =
    view.isFuriten || waits.some((w) => w.isFuriten);

  return {
    mode,
    discardTile,
    waits,
    totalRemainingCount,
    hasFuritenWait,
  };
}
