import type { DerivedRules } from '../types/rule';
import type { DeadWallState, Meld } from '../types/state';
import type { Tile, TileKind } from '../types/tile';

export function getRevealedDoraIndicators(deadWall: DeadWallState): Tile[] {
  return deadWall.doraIndicators.slice(0, deadWall.revealedDoraCount);
}

const WIND_DORA_CYCLE: readonly TileKind[] = ['1z', '2z', '3z', '4z'];
const DRAGON_DORA_CYCLE: readonly TileKind[] = ['5z', '6z', '7z'];

export function getDoraKindFromIndicator(
  indicatorKind: TileKind,
  rules: DerivedRules,
): TileKind {
  const windIdx = WIND_DORA_CYCLE.indexOf(indicatorKind);
  if (windIdx !== -1) {
    return WIND_DORA_CYCLE[(windIdx + 1) % WIND_DORA_CYCLE.length]!;
  }

  const dragonIdx = DRAGON_DORA_CYCLE.indexOf(indicatorKind);
  if (dragonIdx !== -1) {
    return DRAGON_DORA_CYCLE[(dragonIdx + 1) % DRAGON_DORA_CYCLE.length]!;
  }

  const suit = indicatorKind[1];
  const suitKinds = rules.allowedTileKinds.filter((k) => k[1] === suit);
  if (suitKinds.length === 0) {
    throw new Error(`No allowed tile kinds found for suit: ${suit}`);
  }
  const idx = suitKinds.indexOf(indicatorKind);
  if (idx === -1) {
    // 万が一除外牌が表示牌に入った場合でも安全に循環先を決める
    const rank = Number(indicatorKind[0]);
    const nextKind = suitKinds.find((k) => Number(k[0]) > rank) ?? suitKinds[0]!;
    return nextKind;
  }
  return suitKinds[(idx + 1) % suitKinds.length]!;
}

export function getActiveDoraKinds(
  doraIndicators: readonly Tile[],
  rules: DerivedRules,
): TileKind[] {
  return doraIndicators.map((ind) => getDoraKindFromIndicator(ind.kind, rules));
}

export function countDoraAndKita(params: {
  hand: readonly Tile[];
  winningTile: Tile;
  melds: readonly Meld[];
  kitaTiles: readonly Tile[];
  doraIndicators: readonly Tile[];
  rules: DerivedRules;
}): { doraCount: number; kitaCount: number } {
  const { hand, winningTile, melds, kitaTiles, doraIndicators, rules } = params;
  const activeDoraKinds = getActiveDoraKinds(doraIndicators, rules);

  const countTargets: Tile[] = [
    ...hand,
    winningTile,
    ...melds.flatMap((m) => m.tiles),
    ...(rules.kitaCountsAsIndicatorDora ? kitaTiles : []),
  ];

  let doraCount = 0;
  for (const doraKind of activeDoraKinds) {
    for (const tile of countTargets) {
      if (tile.kind === doraKind) {
        doraCount++;
      }
    }
  }

  const kitaCount = rules.allowKita ? kitaTiles.length : 0;
  return { doraCount, kitaCount };
}
