import type { Action, StateView } from '../types/message';
import { DEFAULT_CPU_LEVEL } from '../types/rule';
import type { CallResponseChoice } from '../types/state';
import type { Tile, TileKind } from '../types/tile';
import { ALL_TILE_KINDS } from '../types/tile';
import {
  analyzeHand,
  countsFromTiles,
  kindIndex,
  KIND_COUNT,
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

/** 他家の捨て牌・副露・ドラ表示牌など、既に見えている牌の枚数を数える */
function buildVisibleCounts(view: StateView): number[] {
  const visible = new Array<number>(KIND_COUNT).fill(0);
  const add = (kind: TileKind): void => {
    const idx = kindIndex(kind);
    if (idx >= 0) visible[idx] = (visible[idx] ?? 0) + 1;
  };
  for (const p of view.players) {
    for (const discard of p.discards) add(discard.tile.kind);
    if (p.playerId !== view.viewerPlayerId) {
      for (const meld of p.melds) for (const t of meld.tiles) add(t.kind);
      for (const t of p.kitaTiles) add(t.kind);
    }
  }
  for (const indicator of view.round?.doraIndicators ?? []) add(indicator.kind);
  return visible;
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

  const meldCount = self.melds.filter((m) => m.type !== 'ankan').length + 1;
  const visible = buildVisibleCounts(view);
  const cpuLevel = view.ruleConfig.cpuLevel ?? DEFAULT_CPU_LEVEL;
  const seed = hashSeed([view.viewerPlayerId, view.round?.turnCount ?? 0]);
  const yakuhai = isYakuhaiView(view);

  type Score = {
    tile: Tile;
    shanten: number;
    ukeire: number;
    value: number;
    tie: number;
  };

  const scored: Score[] = [];
  for (const tile of pool) {
    const counts = countsFromTiles(candidates);
    const idx = kindIndex(tile.kind);
    if (idx >= 0) counts[idx] = (counts[idx] ?? 0) - 1;
    const { shanten, ukeire } = analyzeHand(counts, meldCount, visible);
    // 進めない打牌は避け、受け入れの広い形を優先する
    const value = tileKeepValue(tile.kind, counts, yakuhai);
    const tie = hashSeed([seed, tile.id]);
    scored.push({ tile, shanten, ukeire, value, tie });
  }

  if (scored.length === 0) return null;

  scored.sort((a, b) => {
    if (a.shanten !== b.shanten) return a.shanten - b.shanten;
    if (a.ukeire !== b.ukeire) return b.ukeire - a.ukeire;
    if (Math.abs(a.value - b.value) >= 1e-9) return a.value - b.value;
    return a.tie - b.tie;
  });

  if (cpuLevel === 'easy') {
    const windowSize = Math.min(3, scored.length);
    const picked = scored[seed % windowSize]!;
    return { type: 'DISCARD_TILE', tileId: picked.tile.id };
  }

  const best = scored[0]!;

  // 同評価ならツモ牌を切って手牌の並びを保つ
  if (drawn && drawn.id !== best.tile.id) {
    const counts = countsFromTiles(candidates);
    const idx = kindIndex(drawn.kind);
    if (idx >= 0) counts[idx] = (counts[idx] ?? 0) - 1;
    const drawnEval = analyzeHand(counts, meldCount, visible);
    if (
      drawnEval.shanten === best.shanten &&
      drawnEval.ukeire >= best.ukeire
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
): number {
  const idx = kindIndex(kind);
  if (idx < 0) return 0;
  const same = counts[idx] ?? 0;
  let value = (same - 1) * 2.5;

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

function decideCallResponse(view: StateView): CpuAction | null {
  const opts = view.myCallOptions;
  if (!opts) return null;

  if (opts.canRon) {
    return { type: 'CALL_RESPONSE', choice: { type: 'ron' } };
  }

  const self = view.players.find((p) => p.playerId === view.viewerPlayerId);
  if (!self) return { type: 'CALL_RESPONSE', choice: { type: 'pass' } };

  const cpuLevel = view.ruleConfig.cpuLevel ?? DEFAULT_CPU_LEVEL;
  const isOpen = self.melds.length > 0;
  const allTiles: Tile[] = [...view.myHand];
  if (view.myDrawnTile) allTiles.push(view.myDrawnTile);
  const counts = buildKindCounts(allTiles);
  const seed = hashSeed([view.viewerPlayerId, view.round?.turnCount ?? 0]);

  if (cpuLevel === 'easy') {
    if (
      opts.canPon &&
      (counts.get(opts.discardedTile.kind) ?? 0) >= 2 &&
      isYakuhaiView(view).has(opts.discardedTile.kind) &&
      seed % 3 === 0
    ) {
      return { type: 'CALL_RESPONSE', choice: { type: 'pon' } };
    }
    return { type: 'CALL_RESPONSE', choice: { type: 'pass' } };
  }

  // 大明槓は手が開いている時のみ（門前を壊さない）
  if (opts.canDaiminkan && isOpen && seed % 2 === 0) {
    return { type: 'CALL_RESPONSE', choice: { type: 'daiminkan' } };
  }

  if (opts.canPon && (counts.get(opts.discardedTile.kind) ?? 0) >= 2) {
    // 役牌は鳴く価値が高く、既に鳴いている手は速度優先で鳴く
    const isYakuhai = isYakuhaiView(view).has(opts.discardedTile.kind);
    if (isYakuhai || isOpen) {
      return { type: 'CALL_RESPONSE', choice: { type: 'pon' } };
    }
  }

  if (isOpen && opts.chiOptions.length > 0) {
    // 既に鳴いている手のみチーで形を整える
    const chiOption = opts.chiOptions[seed % opts.chiOptions.length]!;
    return {
      type: 'CALL_RESPONSE',
      choice: {
        type: 'chi',
        tileIds: [chiOption.tiles[0].id, chiOption.tiles[1].id],
      },
    };
  }

  return { type: 'CALL_RESPONSE', choice: { type: 'pass' } };
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
  const cpuLevel = view.ruleConfig.cpuLevel ?? DEFAULT_CPU_LEVEL;
  const seed = hashSeed([view.viewerPlayerId, view.round.turnCount]);

  if (actions?.canTsumo) {
    return { type: 'DECLARE_TSUMO' };
  }

  // 抜き北はドラを増やせるので常に行う
  if (actions && actions.canKitaTileIds.length > 0) {
    return { type: 'DECLARE_KITA', tileId: actions.canKitaTileIds[0]! };
  }

  // 加槓・暗槓は手牌を減らさず打点を上げられるため行う（やさしめは控えめ）
  if (
    actions &&
    actions.canKakanTileIds.length > 0 &&
    (cpuLevel !== 'easy' || seed % 2 === 0)
  ) {
    return { type: 'DECLARE_KAKAN', tileId: actions.canKakanTileIds[0]! };
  }
  if (
    actions &&
    actions.canAnkanKinds.length > 0 &&
    (cpuLevel !== 'easy' || seed % 2 === 0)
  ) {
    return { type: 'DECLARE_ANKAN', kind: actions.canAnkanKinds[0]! };
  }

  // テンパイならリーチ（打点を伸ばす基本戦略、やさしめは控えめ）
  if (
    actions &&
    actions.canRiichiTileIds.length > 0 &&
    (cpuLevel !== 'easy' || seed % 2 === 0)
  ) {
    const drawnId = view.myDrawnTile?.id;
    const tileId =
      drawnId && actions.canRiichiTileIds.includes(drawnId)
        ? drawnId
        : actions.canRiichiTileIds[0]!;
    return { type: 'DECLARE_RIICHI', tileId };
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
