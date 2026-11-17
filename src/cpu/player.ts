import { getTenpaiWaitKinds } from '../engine/agari';
import { getActiveDoraKinds } from '../engine/dora';
import { deriveRules } from '../engine/rules';
import { evaluateBestAgari } from '../engine/score';
import { isTerminalOrHonorKind } from '../engine/yaku';
import type { Action, PublicPlayerView, StateView } from '../types/message';
import { DEFAULT_CPU_LEVEL, type DerivedRules } from '../types/rule';
import type { CallResponseChoice, Meld } from '../types/state';
import type { Tile, TileKind } from '../types/tile';
import { ALL_TILE_KINDS } from '../types/tile';
import {
  analyzeHand,
  countsFromTiles,
  handShanten,
  kindIndex,
  KIND_COUNT,
  kokushiShanten,
} from './shanten';

/**
 * CPU が選択する操作。UI からの操作（ClientMessage.action）と同じ粒度にそろえ、
 * ホスト側で対局エンジンの Action に変換して適用する。
 */
export type CpuAction =
  | { type: 'DISCARD_TILE'; tileId: string }
  | { type: 'CALL_RESPONSE'; choice: CallResponseChoice }
  | { type: 'DECLARE_TSUMO' }
  | { type: 'DECLARE_RIICHI'; tileId: string }
  | { type: 'DECLARE_ANKAN'; kind: TileKind }
  | { type: 'DECLARE_KAKAN'; tileId: string }
  | { type: 'DECLARE_KITA'; tileId: string }
  | { type: 'DECLARE_KYUUSHU_KYUUHAI' }
  | { type: 'ADVANCE_ROUND' };

const YAKUHAI_HONORS: readonly TileKind[] = ['5z', '6z', '7z'];

/** CPU 席の playerId 接頭辞（ホストが CPU 席を生成する際に使用） */
export const CPU_PLAYER_ID_PREFIX = 'cpu-';

/** 指定した playerId が CPU 席かどうか */
export function isCpuPlayerId(playerId: string): boolean {
  return playerId.startsWith(CPU_PLAYER_ID_PREFIX);
}

function hashSeed(parts: readonly (string | number)[]): number {
  let h = 2166136261 >>> 0;
  for (const part of parts) {
    const s = String(part);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
  }
  return h >>> 0;
}

function buildKindCounts(tiles: readonly Tile[]): Map<TileKind, number> {
  const counts = new Map<TileKind, number>();
  for (const tile of tiles) {
    counts.set(tile.kind, (counts.get(tile.kind) ?? 0) + 1);
  }
  return counts;
}

/**
 * 全プレイヤーの捨て牌・副露・抜北およびドラ表示牌から、自分の手牌外で見えている牌の枚数を数える。
 * 自分の melds / kitaTiles も手牌（myHand / myDrawnTile）には含まれないため加算する。
 */
function buildVisibleCounts(view: StateView): number[] {
  const visible = new Array<number>(KIND_COUNT).fill(0);
  const add = (kind: TileKind): void => {
    const idx = kindIndex(kind);
    if (idx >= 0) visible[idx] = (visible[idx] ?? 0) + 1;
  };
  for (const p of view.players) {
    for (const discard of p.discards) add(discard.tile.kind);
    for (const meld of p.melds) for (const t of meld.tiles) add(t.kind);
    for (const t of p.kitaTiles) add(t.kind);
  }
  for (const indicator of view.round?.doraIndicators ?? []) add(indicator.kind);
  return visible;
}

/** 自分の捨て牌履歴（鳴かれた牌も含め StateView の公開情報から復元） */
function getMyDiscardedKinds(view: StateView, self: PublicPlayerView): Set<TileKind> {
  const kinds = new Set<TileKind>();
  for (const d of self.discards) kinds.add(d.tile.kind);
  for (const p of view.players) {
    for (const m of p.melds) {
      if (m.fromSeatIndex === self.seatIndex && m.calledTile) {
        kinds.add(m.calledTile.kind);
      }
    }
  }
  return kinds;
}

/** 指定プレイヤーの現物集合（本人の河 + 本人から鳴かれた牌） */
function getGenbutsuKinds(view: StateView, opponent: PublicPlayerView): Set<TileKind> {
  const safe = new Set<TileKind>();
  for (const d of opponent.discards) safe.add(d.tile.kind);
  for (const p of view.players) {
    for (const m of p.melds) {
      if (m.fromSeatIndex === opponent.seatIndex && m.calledTile) {
        safe.add(m.calledTile.kind);
      }
    }
  }
  return safe;
}

/** 指定プレイヤーの河に対してスジになっている牌種か */
function isSujiAgainst(kind: TileKind, genbutsu: ReadonlySet<TileKind>): boolean {
  if (kind.endsWith('z')) return false;
  const rank = Number(kind[0]);
  const suit = kind[1];
  const has = (r: number) => genbutsu.has(`${r}${suit}` as TileKind);
  if (rank <= 3) return has(rank + 3);
  if (rank >= 7) return has(rank - 3);
  return has(rank - 3) && has(rank + 3);
}

/** リーチ者に対する牌の危険度（0 = 現物または残り枚数0の完全安全牌） */
function tileDangerScore(
  tile: Tile,
  riichiOpponents: readonly PublicPlayerView[],
  genbutsuByOpponent: readonly Set<TileKind>[],
  myCounts: readonly number[],
  visible: readonly number[],
  doraSet: ReadonlySet<TileKind>,
  copiesPerKind: number,
): number {
  const idx = kindIndex(tile.kind);
  const myCount = idx >= 0 ? (myCounts[idx] ?? 0) : 0;
  const visCount = idx >= 0 ? (visible[idx] ?? 0) : 0;
  // 手牌 + 公開情報で全4枚が見えていれば他家は絶対にロンできない
  if (myCount + visCount >= copiesPerKind) {
    return 0;
  }

  let totalDanger = 0;
  for (let i = 0; i < riichiOpponents.length; i++) {
    const genbutsu = genbutsuByOpponent[i]!;
    if (genbutsu.has(tile.kind)) continue;

    let base: number;
    if (tile.kind.endsWith('z')) {
      if (visCount >= 2) base = 1.2;
      else if (visCount === 1) base = 2.4;
      else base = 4.2;
    } else {
      const rank = Number(tile.kind[0]);
      const suji = isSujiAgainst(tile.kind, genbutsu);
      if (rank === 1 || rank === 9) base = suji ? 1.8 : 3.5;
      else if (rank === 2 || rank === 8) base = suji ? 2.5 : 5.5;
      else if (rank === 3 || rank === 7) base = suji ? 3.0 : 7.0;
      else base = suji ? 3.2 : 8.5;
    }

    if (tile.isRed || doraSet.has(tile.kind)) {
      base += 4.0;
    }
    totalDanger += base;
  }

  return totalDanger;
}

function getDoraKindSet(view: StateView, rules: DerivedRules): Set<TileKind> {
  const indicators = view.round?.doraIndicators ?? [];
  return new Set<TileKind>(getActiveDoraKinds(indicators, rules));
}

function countHandDora(
  tiles: readonly Tile[],
  melds: readonly Meld[],
  kitaTiles: readonly Tile[],
  doraSet: ReadonlySet<TileKind>,
): number {
  let total = kitaTiles.length;
  for (const t of tiles) {
    if (t.isRed) total += 1;
    if (doraSet.has(t.kind)) total += 1;
  }
  for (const m of melds) {
    for (const t of m.tiles) {
      if (t.isRed) total += 1;
      if (doraSet.has(t.kind)) total += 1;
    }
  }
  return total;
}

/** リーチ宣言時の最適打牌を選ぶ（空聴は避け、非フリテン・待ち枚数優先） */
function pickBestRiichiDiscard(
  view: StateView,
  self: PublicPlayerView,
  canRiichiTileIds: readonly string[],
  visible: readonly number[],
  rules: DerivedRules,
  doraSet: ReadonlySet<TileKind>,
): string | null {
  const allTiles: Tile[] = [...view.myHand];
  if (view.myDrawnTile) allTiles.push(view.myDrawnTile);

  const myDiscardedKinds = getMyDiscardedKinds(view, self);
  const cpuLevel = view.ruleConfig.cpuLevel ?? DEFAULT_CPU_LEVEL;
  const seed = hashSeed([view.viewerPlayerId, view.round?.turnCount ?? 0]);

  interface RiichiCandidate {
    tile: Tile;
    liveWaitCount: number;
    isFuriten: boolean;
    keepPenalty: number;
    tie: number;
  }

  const byKindCache = new Map<
    TileKind,
    { liveWaitCount: number; isFuriten: boolean }
  >();
  const evaluated: RiichiCandidate[] = [];

  for (const tileId of canRiichiTileIds) {
    const tile = allTiles.find((t) => t.id === tileId);
    if (!tile) continue;

    let cached = byKindCache.get(tile.kind);
    if (!cached) {
      const remainingHand = allTiles.filter((t) => t.id !== tile.id);
      const waitKinds = getTenpaiWaitKinds(remainingHand, self.melds, rules);
      const handCounts = countsFromTiles(remainingHand);

      let liveWaitCount = 0;
      for (const w of waitKinds) {
        const wIdx = kindIndex(w);
        if (wIdx < 0) continue;
        const left =
          rules.tileSet.copiesPerKind -
          (handCounts[wIdx] ?? 0) -
          (visible[wIdx] ?? 0);
        if (left > 0) liveWaitCount += left;
      }

      const afterDiscards = new Set(myDiscardedKinds);
      afterDiscards.add(tile.kind);
      const isFuriten = waitKinds.some((w) => afterDiscards.has(w));
      cached = { liveWaitCount, isFuriten };
      byKindCache.set(tile.kind, cached);
    }

    const keepPenalty =
      (tile.isRed ? 1 : 0) + (doraSet.has(tile.kind) ? 1 : 0);
    evaluated.push({
      tile,
      liveWaitCount: cached.liveWaitCount,
      isFuriten: cached.isFuriten,
      keepPenalty,
      tie: hashSeed([seed, tile.id]),
    });
  }

  // 空聴（残り待ち牌 0 枚）でのリーチはしない
  const liveCandidates = evaluated.filter((c) => c.liveWaitCount > 0);
  if (liveCandidates.length === 0) {
    return null;
  }

  const nonFuriten = liveCandidates.filter((c) => !c.isFuriten);
  if (cpuLevel === 'normal' && nonFuriten.length === 0) {
    // フリテンリーチしかできない場合、強い多面張（残り4枚以上）でなければダマで手変わりを待つ
    const maxLive = Math.max(...liveCandidates.map((c) => c.liveWaitCount));
    if (maxLive < 4) {
      return null;
    }
  }

  const pool = nonFuriten.length > 0 ? nonFuriten : liveCandidates;
  pool.sort((a, b) => {
    if (a.liveWaitCount !== b.liveWaitCount) {
      return b.liveWaitCount - a.liveWaitCount;
    }
    if (a.keepPenalty !== b.keepPenalty) {
      return a.keepPenalty - b.keepPenalty;
    }
    const aDrawn = a.tile.id === view.myDrawnTile?.id ? 0 : 1;
    const bDrawn = b.tile.id === view.myDrawnTile?.id ? 0 : 1;
    if (aDrawn !== bDrawn) return aDrawn - bDrawn;
    return a.tie - b.tie;
  });

  if (cpuLevel === 'easy') {
    return pool[seed % Math.min(2, pool.length)]!.tile.id;
  }

  return pool[0]!.tile.id;
}

function pickDiscard(view: StateView): CpuAction | null {
  const self = view.players.find((p) => p.playerId === view.viewerPlayerId);
  if (!self) return null;

  const drawn = view.myDrawnTile;
  // リーチ後はツモ切りしかできない
  if (self.isRiichi) {
    return drawn ? { type: 'DISCARD_TILE', tileId: drawn.id } : null;
  }

  const forbidden = new Set(view.kuikaeForbiddenKinds);
  const candidates: Tile[] = [...view.myHand];
  if (drawn) candidates.push(drawn);

  const allowed = candidates.filter((t) => !forbidden.has(t.kind));
  const pool = allowed.length > 0 ? allowed : candidates;
  if (pool.length === 0) return null;

  const rules = deriveRules(view.ruleConfig);
  const allowedKinds = new Set<TileKind>(rules.allowedTileKinds);
  const copiesPerKind = rules.tileSet.copiesPerKind;
  const meldCount = self.melds.length;
  const visible = buildVisibleCounts(view);
  const doraSet = getDoraKindSet(view, rules);
  const cpuLevel = view.ruleConfig.cpuLevel ?? DEFAULT_CPU_LEVEL;
  const seed = hashSeed([view.viewerPlayerId, view.round?.turnCount ?? 0]);
  const yakuhai = isYakuhaiView(view);
  const baseCounts = countsFromTiles(candidates);

  const riichiOpponents = view.players.filter(
    (p) => p.playerId !== view.viewerPlayerId && p.isRiichi,
  );
  const genbutsuByOpponent = riichiOpponents.map((opp) =>
    getGenbutsuKinds(view, opp),
  );

  type Score = {
    tile: Tile;
    shanten: number;
    ukeire: number;
    value: number;
    danger: number;
    tie: number;
  };

  const evalCache = new Map<
    TileKind,
    { shanten: number; ukeire: number; value: number }
  >();
  const scored: Score[] = [];

  for (const tile of pool) {
    let cached = evalCache.get(tile.kind);
    if (!cached) {
      const counts = [...baseCounts];
      const idx = kindIndex(tile.kind);
      if (idx >= 0) counts[idx] = (counts[idx] ?? 0) - 1;
      const { shanten, ukeire } = analyzeHand(
        counts,
        meldCount,
        visible,
        allowedKinds,
        copiesPerKind,
      );
      const value = tileKeepValue(tile.kind, counts, yakuhai, doraSet);
      cached = { shanten, ukeire, value };
      evalCache.set(tile.kind, cached);
    }

    const redBonus = tile.isRed ? 2.0 : 0;
    const danger =
      riichiOpponents.length > 0
        ? tileDangerScore(
            tile,
            riichiOpponents,
            genbutsuByOpponent,
            baseCounts,
            visible,
            doraSet,
            copiesPerKind,
          )
        : 0;
    const tie = hashSeed([seed, tile.id]);
    scored.push({
      tile,
      shanten: cached.shanten,
      ukeire: cached.ukeire,
      value: cached.value + redBonus,
      danger,
      tie,
    });
  }

  if (scored.length === 0) return null;

  const minShanten = Math.min(...scored.map((s) => s.shanten));
  const bestAtMinShanten = scored
    .filter((s) => s.shanten === minShanten)
    .sort((a, b) => b.ukeire - a.ukeire)[0]!;

  // リーチ者に対するベタオリ判定（normal モード）
  const shouldBetaori = (() => {
    if (cpuLevel !== 'normal' || riichiOpponents.length === 0) return false;
    // 自分が有効待ちテンパイなら原則押し（空聴テンパイなら降り）
    if (minShanten === 0) return bestAtMinShanten.ukeire === 0;
    // 2向聴以上ならベタオリ
    if (minShanten >= 2) return true;
    // 1向聴: 相手が2人以上リーチ、または受け入れが狭い場合は降りる
    if (riichiOpponents.length >= 2) return true;
    return bestAtMinShanten.ukeire < 6;
  })();

  if (shouldBetaori) {
    scored.sort((a, b) => {
      if (Math.abs(a.danger - b.danger) >= 1e-9) return a.danger - b.danger;
      // 同危険度（現物同士など）なら形式聴牌や手牌形を維持できる側を優先
      if (a.shanten !== b.shanten) return a.shanten - b.shanten;
      if (a.ukeire !== b.ukeire) return b.ukeire - a.ukeire;
      if (Math.abs(a.value - b.value) >= 1e-9) return a.value - b.value;
      return a.tie - b.tie;
    });
    return { type: 'DISCARD_TILE', tileId: scored[0]!.tile.id };
  }

  scored.sort((a, b) => {
    if (a.shanten !== b.shanten) return a.shanten - b.shanten;
    if (a.ukeire !== b.ukeire) return b.ukeire - a.ukeire;
    // リーチがいる押し局面でも、同向聴・同受け入れなら安全な牌を選ぶ
    if (riichiOpponents.length > 0 && Math.abs(a.danger - b.danger) >= 1e-9) {
      return a.danger - b.danger;
    }
    if (Math.abs(a.value - b.value) >= 1e-9) return a.value - b.value;
    return a.tie - b.tie;
  });

  if (cpuLevel === 'easy') {
    const windowSize = Math.min(3, scored.length);
    const picked = scored[seed % windowSize]!;
    return { type: 'DISCARD_TILE', tileId: picked.tile.id };
  }

  // 序盤〜中盤で0向聴かつ空聴（有効牌0枚）しか残らない場合は1向聴の広い形に組む
  if (
    minShanten === 0 &&
    bestAtMinShanten.ukeire === 0 &&
    (view.round?.remainingWallCount ?? 0) > 24 &&
    riichiOpponents.length === 0
  ) {
    const oneShantenBest = scored
      .filter((s) => s.shanten === 1 && s.ukeire >= 8)
      .sort((a, b) => b.ukeire - a.ukeire || a.value - b.value)[0];
    if (oneShantenBest) {
      return { type: 'DISCARD_TILE', tileId: oneShantenBest.tile.id };
    }
  }

  const best = scored[0]!;

  // 同評価ならツモ牌を切って手牌の並びを保つ（危険度が同等の場合）
  if (drawn && drawn.id !== best.tile.id) {
    const drawnScore = scored.find((s) => s.tile.id === drawn.id);
    if (
      drawnScore &&
      drawnScore.shanten === best.shanten &&
      drawnScore.ukeire >= best.ukeire &&
      drawnScore.danger <= best.danger + 1e-9
    ) {
      return { type: 'DISCARD_TILE', tileId: drawn.id };
    }
  }

  return { type: 'DISCARD_TILE', tileId: best.tile.id };
}

/** 手牌に残す価値（小さいほど切りやすい）。同点時のタイブレークにのみ使う */
function tileKeepValue(
  kind: TileKind,
  counts: readonly number[],
  yakuhai: ReadonlySet<TileKind>,
  doraSet: ReadonlySet<TileKind>,
): number {
  const idx = kindIndex(kind);
  if (idx < 0) return 0;
  const same = counts[idx] ?? 0;
  let value = (same - 1) * 2.5;
  if (doraSet.has(kind)) value += 2.0;

  if (kind.endsWith('z')) {
    return value + (yakuhai.has(kind) ? 0.6 : -1.5);
  }

  for (const delta of [-2, -1, 1, 2]) {
    const neighbor = ALL_TILE_KINDS[idx + delta];
    if (!neighbor || neighbor.endsWith('z') || neighbor[1] !== kind[1]) continue;
    const count = counts[kindIndex(neighbor)] ?? 0;
    if (count === 0) continue;
    value += Math.abs(delta) === 1 ? count * 1.4 : count * 0.6;
  }

  const rank = Number(kind[0]);
  if (rank === 1 || rank === 9) value -= 0.4;
  if (rank >= 3 && rank <= 7) value += 0.2;
  return value;
}

/** 自風・場風・三元牌（役牌）の集合 */
function isYakuhaiView(view: StateView): Set<TileKind> {
  const result = new Set<TileKind>(YAKUHAI_HONORS);
  const self = view.players.find((p) => p.playerId === view.viewerPlayerId);
  const windKind = (wind: string | undefined): TileKind | null => {
    const idx = ['E', 'S', 'W', 'N'].indexOf(wind ?? '');
    return idx >= 0 ? ((`${idx + 1}z`) as TileKind) : null;
  };
  const seat = windKind(self?.seatWind ?? undefined);
  if (seat) result.add(seat);
  const round = windKind(view.round?.roundWind);
  if (round) result.add(round);
  return result;
}

/** チー後の喰い替え禁止牌種を求める（鳴いた牌 + 逆側スジ） */
function getChiKuikaeForbiddenKinds(
  calledKind: TileKind,
  pairKinds: readonly [TileKind, TileKind],
  forbidKuikae: boolean,
): Set<TileKind> {
  const forbidden = new Set<TileKind>();
  if (!forbidKuikae) return forbidden;
  forbidden.add(calledKind);

  const suit = calledKind[1];
  const calledRank = Number(calledKind[0]);
  const ranks = [Number(pairKinds[0][0]), Number(pairKinds[1][0])].sort(
    (a, b) => a - b,
  );
  if (ranks[1]! - ranks[0]! === 1) {
    if (calledRank === ranks[0]! - 1 && ranks[1]! + 1 <= 9) {
      forbidden.add(`${ranks[1]! + 1}${suit}` as TileKind);
    } else if (calledRank === ranks[1]! + 1 && ranks[0]! - 1 >= 1) {
      forbidden.add(`${ranks[0]! - 1}${suit}` as TileKind);
    }
  }
  return forbidden;
}

/** 副露後の聴牌形で、残り枚数のある有効待ち＋ルール上有効な役があるか判定 */
function hasValidOpenTenpai(
  remainingHand: readonly Tile[],
  afterMelds: readonly Meld[],
  view: StateView,
  self: PublicPlayerView,
  rules: DerivedRules,
  visible: readonly number[],
  discarderSeatIndex: number,
): boolean {
  if (!view.round) return false;
  const waitKinds = getTenpaiWaitKinds(remainingHand, afterMelds, rules);
  if (waitKinds.length === 0) return false;
  const handCounts = countsFromTiles(remainingHand);

  for (const w of waitKinds) {
    const wIdx = kindIndex(w);
    if (wIdx < 0) continue;
    const left =
      rules.tileSet.copiesPerKind -
      (handCounts[wIdx] ?? 0) -
      (visible[wIdx] ?? 0);
    if (left <= 0) continue;

    const agari = evaluateBestAgari({
      hand: remainingHand,
      melds: afterMelds,
      kitaTiles: self.kitaTiles,
      winningTile: { id: '__sim_win', kind: w, isRed: false },
      isTsumo: false,
      isDealer: self.isDealer,
      dealerIndex: view.round.dealerIndex,
      roundWind: view.round.roundWind,
      seatWind: self.seatWind ?? 'E',
      doraIndicators: view.round.doraIndicators,
      winnerSeatIndex: self.seatIndex,
      fromSeatIndex: discarderSeatIndex,
      rules,
    });
    if (agari !== null) return true;
  }
  return false;
}

/** 副露後に、まだ現実的に達成可能な食い下がり・副露役があるかを判定 */
function hasOpenYakuViability(
  remainingHand: readonly Tile[],
  afterMelds: readonly Meld[],
  yakuhai: ReadonlySet<TileKind>,
  rules: DerivedRules,
  visible: readonly number[],
): boolean {
  // 1. 既に役牌の刻子・槓子ができている
  const hasYakuhaiMeld = afterMelds.some(
    (m) => m.type !== 'chi' && m.tiles[0] && yakuhai.has(m.tiles[0].kind),
  );
  if (hasYakuhaiMeld) return true;

  // 2. 後付け可かつ生きた役牌対子がある
  const handCounts = countsFromTiles(remainingHand);
  if (rules.allowAtozuke) {
    for (const yk of yakuhai) {
      const idx = kindIndex(yk);
      if (idx < 0) continue;
      const inHand = handCounts[idx] ?? 0;
      const seen = visible[idx] ?? 0;
      if (inHand >= 2 && inHand + seen < rules.tileSet.copiesPerKind) {
        return true;
      }
    }
  }

  // 3. 喰いタン可 & 全副露が中張牌 & 手牌も中張牌中心
  if (
    rules.allowKuitan &&
    afterMelds.every((m) => m.tiles.every((t) => !isTerminalOrHonorKind(t.kind)))
  ) {
    const simpleCount = remainingHand.filter(
      (t) => !isTerminalOrHonorKind(t.kind),
    ).length;
    if (simpleCount >= remainingHand.length - 1) {
      return true;
    }
  }

  // 4. 混一色・清一色ルート（副露が 1 色以内＋字牌）
  const meldNumberSuits = new Set<string>();
  for (const m of afterMelds) {
    for (const t of m.tiles) {
      if (!t.kind.endsWith('z')) meldNumberSuits.add(t.kind[1]!);
    }
  }
  if (meldNumberSuits.size <= 1) {
    const targetSuit = [...meldNumberSuits][0];
    const matchingTiles = remainingHand.filter(
      (t) =>
        t.kind.endsWith('z') ||
        targetSuit === undefined ||
        t.kind[1] === targetSuit,
    ).length;
    if (matchingTiles >= remainingHand.length - 1) {
      return true;
    }
  }

  // 5. 対々和・混老頭ルート（チーを含まず対子・刻子が十分）
  if (afterMelds.every((m) => m.type !== 'chi')) {
    let pairsOrMore = 0;
    for (const c of handCounts) {
      if (c >= 2) pairsOrMore += 1;
    }
    if (pairsOrMore >= (afterMelds.length >= 2 ? 1 : 2)) {
      return true;
    }
  }

  // 6. チャンタ・ジュンチャン（全副露に么九牌が含まれる）
  if (
    afterMelds.every((m) => m.tiles.some((t) => isTerminalOrHonorKind(t.kind)))
  ) {
    const yaochuBlocks = remainingHand.filter((t) =>
      isTerminalOrHonorKind(t.kind),
    ).length;
    if (yaochuBlocks >= 2) return true;
  }

  return false;
}

function evaluateBestPostCallState(params: {
  afterHand: readonly Tile[];
  afterMelds: readonly Meld[];
  forbiddenKinds: ReadonlySet<TileKind>;
  visible: readonly number[];
  allowedKinds: ReadonlySet<TileKind>;
  yakuhai: ReadonlySet<TileKind>;
  doraSet: ReadonlySet<TileKind>;
  rules: DerivedRules;
  view: StateView;
  self: PublicPlayerView;
  discarderSeatIndex: number;
}): { shanten: number; ukeire: number; validYaku: boolean } | null {
  const {
    afterHand,
    afterMelds,
    forbiddenKinds,
    visible,
    allowedKinds,
    yakuhai,
    doraSet,
    rules,
    view,
    self,
    discarderSeatIndex,
  } = params;

  const discardPool = afterHand.filter((t) => !forbiddenKinds.has(t.kind));
  if (discardPool.length === 0) return null;

  const baseCounts = countsFromTiles(afterHand);
  let best: {
    shanten: number;
    ukeire: number;
    validYaku: boolean;
    value: number;
  } | null = null;

  const seenKinds = new Set<TileKind>();
  for (const discard of discardPool) {
    if (seenKinds.has(discard.kind)) continue;
    seenKinds.add(discard.kind);

    const remainingHand = afterHand.filter((t) => t.id !== discard.id);
    const counts = [...baseCounts];
    const idx = kindIndex(discard.kind);
    if (idx >= 0) counts[idx] = (counts[idx] ?? 0) - 1;

    const { shanten, ukeire } = analyzeHand(
      counts,
      afterMelds.length,
      visible,
      allowedKinds,
      rules.tileSet.copiesPerKind,
    );

    const validYaku =
      shanten === 0
        ? hasValidOpenTenpai(
            remainingHand,
            afterMelds,
            view,
            self,
            rules,
            visible,
            discarderSeatIndex,
          )
        : hasOpenYakuViability(
            remainingHand,
            afterMelds,
            yakuhai,
            rules,
            visible,
          );

    if (!validYaku) continue;

    const value = tileKeepValue(discard.kind, counts, yakuhai, doraSet);
    if (
      best === null ||
      shanten < best.shanten ||
      (shanten === best.shanten && ukeire > best.ukeire) ||
      (shanten === best.shanten && ukeire === best.ukeire && value < best.value)
    ) {
      best = { shanten, ukeire, validYaku, value };
    }
  }

  return best
    ? { shanten: best.shanten, ukeire: best.ukeire, validYaku: best.validYaku }
    : null;
}

function decideCallResponse(view: StateView): CpuAction | null {
  const opts = view.myCallOptions;
  if (!opts) return null;

  if (opts.canRon) {
    return { type: 'CALL_RESPONSE', choice: { type: 'ron' } };
  }

  const self = view.players.find((p) => p.playerId === view.viewerPlayerId);
  if (!self) return { type: 'CALL_RESPONSE', choice: { type: 'pass' } };

  const rules = deriveRules(view.ruleConfig);
  const allowedKinds = new Set<TileKind>(rules.allowedTileKinds);
  const cpuLevel = rules.cpuLevel;
  // 暗槓のみの副露は門前扱い（鳴いていない）
  const isOpen = self.melds.some((m) => m.type !== 'ankan');
  const allTiles: Tile[] = [...view.myHand];
  if (view.myDrawnTile) allTiles.push(view.myDrawnTile);
  const counts = buildKindCounts(allTiles);
  const yakuhai = isYakuhaiView(view);
  const doraSet = getDoraKindSet(view, rules);
  const visible = buildVisibleCounts(view);
  const seed = hashSeed([view.viewerPlayerId, view.round?.turnCount ?? 0]);

  const riichiOpponentsExist = view.players.some(
    (p) => p.playerId !== view.viewerPlayerId && p.isRiichi,
  );
  const beforeCounts = countsFromTiles(allTiles);
  const beforeEval = analyzeHand(
    beforeCounts,
    self.melds.length,
    visible,
    allowedKinds,
    rules.tileSet.copiesPerKind,
  );

  // 加算見込みの可視牌（鳴いた捨牌は場から手元に移動するので、visible からは不変のまま扱える）
  if (cpuLevel === 'easy') {
    if (
      opts.canPon &&
      (counts.get(opts.discardedTile.kind) ?? 0) >= 2 &&
      yakuhai.has(opts.discardedTile.kind) &&
      seed % 3 === 0
    ) {
      return { type: 'CALL_RESPONSE', choice: { type: 'pon' } };
    }
    return { type: 'CALL_RESPONSE', choice: { type: 'pass' } };
  }

  // 大明槓は手が開いている時のみ＋シャンテン悪化しない場合（リーチ者がいるときは槓ドラ回避）
  if (
    opts.canDaiminkan &&
    isOpen &&
    !riichiOpponentsExist &&
    (view.round?.remainingWallCount ?? 0) >= 8
  ) {
    const afterKanCounts = [...beforeCounts];
    const kIdx = kindIndex(opts.discardedTile.kind);
    if (kIdx >= 0) {
      afterKanCounts[kIdx] = Math.max(0, (afterKanCounts[kIdx] ?? 0) - 3);
    }
    const afterKanShanten = handShanten(afterKanCounts, self.melds.length + 1);
    if (afterKanShanten <= beforeEval.shanten) {
      return { type: 'CALL_RESPONSE', choice: { type: 'daiminkan' } };
    }
  }

  type CallCandidate = {
    choice: CallResponseChoice;
    shanten: number;
    ukeire: number;
    priority: number;
  };
  const candidates: CallCandidate[] = [];
  const doraCount = countHandDora(allTiles, self.melds, self.kitaTiles, doraSet);

  // ポン検討
  if (opts.canPon && (counts.get(opts.discardedTile.kind) ?? 0) >= 2) {
    const isYakuhai = yakuhai.has(opts.discardedTile.kind);
    const matching = allTiles.filter((t) => t.kind === opts.discardedTile.kind);
    const pair = matching.slice(0, 2);
    const pairIds = new Set(pair.map((t) => t.id));
    const afterHand = allTiles.filter((t) => !pairIds.has(t.id));
    const newMeld: Meld = {
      type: 'pon',
      tiles: [...pair, opts.discardedTile],
      calledTile: opts.discardedTile,
      fromSeatIndex: opts.discarderSeatIndex,
      addedTile: null,
    };
    const forbidden = rules.forbidKuikae
      ? new Set<TileKind>([opts.discardedTile.kind])
      : new Set<TileKind>();

    const post = evaluateBestPostCallState({
      afterHand,
      afterMelds: [...self.melds, newMeld],
      forbiddenKinds: forbidden,
      visible,
      allowedKinds,
      yakuhai,
      doraSet,
      rules,
      view,
      self,
      discarderSeatIndex: opts.discarderSeatIndex,
    });

    if (post) {
      const improvesShanten = post.shanten < beforeEval.shanten;
      const keepsOpenTenpai =
        isOpen &&
        post.shanten === 0 &&
        beforeEval.shanten === 0 &&
        post.ukeire > beforeEval.ukeire;
      const entersValuableTenpai =
        post.shanten === 0 &&
        post.ukeire > 0 &&
        (isOpen || isYakuhai || doraCount >= 2 || (view.round?.remainingWallCount ?? 70) <= 24);
      const allowWhenClosed =
        isYakuhai && (improvesShanten || entersValuableTenpai);
      const allowWhenOpen =
        isOpen && (improvesShanten || keepsOpenTenpai) && (!riichiOpponentsExist || post.shanten === 0);

      if (allowWhenClosed || allowWhenOpen || (!isOpen && entersValuableTenpai && !riichiOpponentsExist)) {
        candidates.push({
          choice: { type: 'pon', tileIds: [pair[0]!.id, pair[1]!.id] },
          shanten: post.shanten,
          ukeire: post.ukeire,
          priority: isYakuhai ? 2 : 1,
        });
      }
    }
  }

  // チー検討
  for (const chiOpt of opts.chiOptions) {
    const [t1, t2] = chiOpt.tiles;
    const usedIds = new Set([t1.id, t2.id]);
    const afterHand = allTiles.filter((t) => !usedIds.has(t.id));
    const newMeld: Meld = {
      type: 'chi',
      tiles: [t1, t2, opts.discardedTile],
      calledTile: opts.discardedTile,
      fromSeatIndex: opts.discarderSeatIndex,
      addedTile: null,
    };
    const forbidden = getChiKuikaeForbiddenKinds(
      opts.discardedTile.kind,
      [t1.kind, t2.kind],
      rules.forbidKuikae,
    );

    const post = evaluateBestPostCallState({
      afterHand,
      afterMelds: [...self.melds, newMeld],
      forbiddenKinds: forbidden,
      visible,
      allowedKinds,
      yakuhai,
      doraSet,
      rules,
      view,
      self,
      discarderSeatIndex: opts.discarderSeatIndex,
    });

    if (post) {
      const improvesShanten = post.shanten < beforeEval.shanten;
      const keepsOpenTenpai =
        isOpen &&
        post.shanten === 0 &&
        beforeEval.shanten === 0 &&
        post.ukeire > beforeEval.ukeire;
      const entersValuableTenpai =
        !isOpen &&
        post.shanten === 0 &&
        post.ukeire > 0 &&
        !riichiOpponentsExist &&
        (doraCount >= 2 || (view.round?.remainingWallCount ?? 70) <= 24);
      const allowWhenOpen =
        isOpen &&
        (improvesShanten || keepsOpenTenpai) &&
        (!riichiOpponentsExist || post.shanten === 0);

      if (allowWhenOpen || entersValuableTenpai) {
        candidates.push({
          choice: { type: 'chi', tileIds: [t1.id, t2.id] },
          shanten: post.shanten,
          ukeire: post.ukeire,
          priority: 0,
        });
      }
    }
  }

  if (candidates.length === 0) {
    return { type: 'CALL_RESPONSE', choice: { type: 'pass' } };
  }

  candidates.sort((a, b) => {
    if (a.shanten !== b.shanten) return a.shanten - b.shanten;
    if (a.ukeire !== b.ukeire) return b.ukeire - a.ukeire;
    return b.priority - a.priority;
  });

  return { type: 'CALL_RESPONSE', choice: candidates[0]!.choice };
}

/**
 * CPU の意思決定。StateView だけを入力にすることで、他家の手牌や山牌といった
 * 本来見えない情報を参照しない（人間と同じ情報量で判断する）。
 * 操作できない状況では null を返す。
 */
export function decideCpuAction(view: StateView): CpuAction | null {
  if (view.phase === 'finished' || view.phase === 'lobby') {
    return null;
  }

  // 局終了時はホスト権限でのみ次局へ進める
  if (view.phase === 'round_end') {
    return view.viewerPlayerId === view.hostPlayerId
      ? { type: 'ADVANCE_ROUND' }
      : null;
  }

  if (view.phase === 'awaiting_responses') {
    return decideCallResponse(view);
  }

  const self = view.players.find((p) => p.playerId === view.viewerPlayerId);
  if (!self || !self.isCurrentTurn || !view.round) {
    return null;
  }

  const actions = view.mySelfActions;
  const rules = deriveRules(view.ruleConfig);
  const cpuLevel = rules.cpuLevel;
  const seed = hashSeed([view.viewerPlayerId, view.round.turnCount]);

  if (actions?.canTsumo) {
    return { type: 'DECLARE_TSUMO' };
  }

  // 抜き北はドラを増やせるので常に行う
  if (actions && actions.canKitaTileIds.length > 0) {
    return { type: 'DECLARE_KITA', tileId: actions.canKitaTileIds[0]! };
  }

  const allTiles: Tile[] = [...view.myHand];
  if (view.myDrawnTile) allTiles.push(view.myDrawnTile);
  const currentCounts = countsFromTiles(allTiles);
  const currentShanten = handShanten(currentCounts, self.melds.length);

  // 九種九牌: 国士や通常のまとまった手から遠ければ流局を選ぶ
  if (actions?.canKyuushuKyuuhai) {
    const kShanten = kokushiShanten(currentCounts);
    if (
      kShanten >= 3 &&
      currentShanten >= 3 &&
      (cpuLevel !== 'easy' || seed % 2 === 0)
    ) {
      return { type: 'DECLARE_KYUUSHU_KYUUHAI' };
    }
  }

  const riichiOpponentsExist = view.players.some(
    (p) => p.playerId !== view.viewerPlayerId && p.isRiichi,
  );

  // 加槓: シャンテンを崩さない＋危険なリーチ者へのカンドラ献上を避ける
  if (
    actions &&
    actions.canKakanTileIds.length > 0 &&
    (cpuLevel !== 'easy' || seed % 2 === 0)
  ) {
    for (const tileId of actions.canKakanTileIds) {
      const tile = allTiles.find((t) => t.id === tileId);
      if (!tile) continue;
      const afterCounts = [...currentCounts];
      const idx = kindIndex(tile.kind);
      if (idx >= 0) afterCounts[idx] = Math.max(0, (afterCounts[idx] ?? 0) - 1);
      const afterShanten = handShanten(afterCounts, self.melds.length);
      if (afterShanten > currentShanten) continue;
      if (riichiOpponentsExist && afterShanten > 0) continue;
      return { type: 'DECLARE_KAKAN', tileId };
    }
  }

  // 暗槓: 順子パーツを壊してシャンテンが下がる暗槓や、非テンパイ時のリーチ者向けカンドラ献上を避ける
  if (
    actions &&
    actions.canAnkanKinds.length > 0 &&
    (cpuLevel !== 'easy' || seed % 2 === 0)
  ) {
    for (const kind of actions.canAnkanKinds) {
      const afterCounts = [...currentCounts];
      const idx = kindIndex(kind);
      if (idx >= 0) afterCounts[idx] = Math.max(0, (afterCounts[idx] ?? 0) - 4);
      const afterShanten = handShanten(afterCounts, self.melds.length + 1);
      if (afterShanten > currentShanten) continue;
      if (riichiOpponentsExist && afterShanten > 0) continue;
      return { type: 'DECLARE_ANKAN', kind };
    }
  }

  // テンパイならリーチ（待ち枚数・フリテン回避・空聴回避を判定）
  if (
    actions &&
    actions.canRiichiTileIds.length > 0 &&
    (cpuLevel !== 'easy' || seed % 2 === 0)
  ) {
    const visible = buildVisibleCounts(view);
    const doraSet = getDoraKindSet(view, rules);
    const chosenRiichiTileId = pickBestRiichiDiscard(
      view,
      self,
      actions.canRiichiTileIds,
      visible,
      rules,
      doraSet,
    );
    if (chosenRiichiTileId) {
      return { type: 'DECLARE_RIICHI', tileId: chosenRiichiTileId };
    }
  }

  if (view.myDrawnTile === null && view.myHand.length % 3 !== 2) {
    return null;
  }

  return pickDiscard(view);
}

/** CPU の操作を対局エンジンの Action に変換する（ADVANCE_ROUND は山牌が必要） */
export function toEngineAction(
  playerId: string,
  action: CpuAction,
  options: { now?: number; shuffledDeck?: Tile[] } = {},
): Action | null {
  const now = options.now ?? Date.now();
  switch (action.type) {
    case 'DISCARD_TILE':
      return { type: 'DISCARD_TILE', playerId, tileId: action.tileId, now };
    case 'CALL_RESPONSE':
      return { type: 'CALL_RESPONSE', playerId, choice: action.choice };
    case 'DECLARE_TSUMO':
      return { type: 'DECLARE_TSUMO', playerId };
    case 'DECLARE_RIICHI':
      return { type: 'DECLARE_RIICHI', playerId, tileId: action.tileId, now };
    case 'DECLARE_ANKAN':
      return { type: 'DECLARE_ANKAN', playerId, kind: action.kind, now };
    case 'DECLARE_KAKAN':
      return { type: 'DECLARE_KAKAN', playerId, tileId: action.tileId, now };
    case 'DECLARE_KITA':
      return { type: 'DECLARE_KITA', playerId, tileId: action.tileId };
    case 'DECLARE_KYUUSHU_KYUUHAI':
      return { type: 'DECLARE_KYUUSHU_KYUUHAI', playerId };
    case 'ADVANCE_ROUND':
      return options.shuffledDeck
        ? { type: 'ADVANCE_ROUND', playerId, shuffledDeck: options.shuffledDeck }
        : null;
  }
}

/** CPU 名の表示用ラベル（例: CPU1） */
export function cpuDisplayName(index: number): string {
  return `CPU${index + 1}`;
}

/** プレイヤー数に対して設定可能な CPU 人数の上限 */
export function maxCpuCount(playerCount: number): number {
  return Math.max(0, playerCount - 1);
}
