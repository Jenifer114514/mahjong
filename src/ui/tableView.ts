import {
  CPU_PLAYER_ID_PREFIX,
  cpuDisplayName,
  isCpuPlayerId,
} from '../cpu/player';
import { deriveRules } from '../engine/rules';
import { formatRoomDisplayName } from '../net/rooms';
import type { PublicPlayerView, RoundView, StateView } from '../types/message';
import type {
  AbortiveDrawReason,
  CallResponseChoice,
  DiscardEntry,
  Meld,
  RoundAgariWinner,
} from '../types/state';
import type { TileKind } from '../types/tile';
import {
  createTileBackElement,
  createTileElement,
  formatRoundName,
  formatTileLabel,
  windToJa,
} from './tileView';
import { soundEngine } from './sound';
import {
  Mahjong3DScene,
  type Table3DCameraPreset,
} from './tableScene3d';
import { computeSelfTenpaiGuide } from './tenpaiGuide';

export type { Table3DCameraPreset } from './tableScene3d';

/** 卓を囲む4方向（下=自分から見た相対位置） */
export type SeatSide = 'self' | 'top' | 'left' | 'right';

/** 席ごとの河・手牌の向き（CSS の data-seat と対応） */
const SEAT_CLASS: Record<SeatSide, string> = {
  self: 'seat-self',
  top: 'seat-top',
  left: 'seat-left',
  right: 'seat-right',
};

export type RoundEndStep = 'details' | 'scores';

export interface TableHandlers {
  onDiscardTile: (tileId: string) => void;
  onSelectTile?: (tileId: string | null) => void;
  onChangeRoundEndStep?: (step: RoundEndStep) => void;
  onCallResponse: (choice: CallResponseChoice) => void;
  onDeclareTsumo: () => void;
  onDeclareRiichi: (tileId: string) => void;
  onDeclareAnkan: (kind: TileKind) => void;
  onDeclareKakan: (tileId: string) => void;
  onDeclareKita: (tileId: string) => void;
  onDeclareKyuushuKyuuhai: () => void;
  onToggleRiichiMode?: (enabled: boolean) => void;
  onToggleAutoTsumogiri?: (enabled: boolean) => void;
  onToggleAutoAgari?: (enabled: boolean) => void;
  onToggleAutoNoCall?: (enabled: boolean) => void;
  onAdvanceRound: () => void;
  onReturnToLobby: () => void;
  /** 対局中に卓上から部屋を離れる（トップバーを出さないため） */
  onLeaveGame?: () => void;
  /** 卓上に離脱ボタンを出すか */
  canLeaveGame?: boolean;
  /** 設定パネルを開く */
  onOpenSettings?: () => void;
  /** チャットパネルを開く */
  onOpenChat?: () => void;
  /** 終局後に同じ部屋のままロビーに戻る（ホストのみ） */
  onResetToLobby?: () => void;
  /** 観戦中に下側へ配置する視点席を切り替える */
  onChangePerspective?: (seatIndex: number) => void;
}

export interface TileRectSnapshot {
  cx: number;
  cy: number;
  width: number;
  height: number;
}

export interface SeatHandOriginSnapshot {
  tiles: TileRectSnapshot[];
  area: TileRectSnapshot | null;
}

export interface DiscardOriginSnapshot {
  selfTileRects: Map<string, TileRectSnapshot>;
  seatHands: Partial<Record<SeatSide, SeatHandOriginSnapshot>>;
}

export interface SeatChatBubble {
  messageId: string;
  senderId: string;
  senderName: string;
  text: string;
  animate?: boolean;
}

export interface TableUiState {
  riichiSelectingMode: boolean;
  autoTsumogiriEnabled: boolean;
  autoAgariEnabled?: boolean;
  autoNoCallEnabled?: boolean;
  selectedTileId?: string | null;
  roundEndStep?: RoundEndStep;
  unreadChatCount?: number;
  perspectiveSeatIndex?: number;
  hostStatusBanner?: string | null;
  prevView?: StateView | null;
  prevPerspectiveSeatIndex?: number;
  discardOriginSnapshot?: DiscardOriginSnapshot | null;
  /** 対局中の各プレイヤーアイコンから出すチャット吹き出し（playerId キー） */
  chatBubbles?: Record<string, SeatChatBubble>;
  /** 3D WebGL2 麻雀卓を使うか（既定 true、非対応環境は自動 2D フォールバック） */
  enable3dTable?: boolean;
  /** 3D 卓カメラ視点プリセット */
  cameraPreset?: Table3DCameraPreset;
}

const DEFAULT_TABLE_UI_STATE: TableUiState = {
  riichiSelectingMode: false,
  autoTsumogiriEnabled: true,
  autoAgariEnabled: false,
  autoNoCallEnabled: false,
  selectedTileId: null,
  roundEndStep: 'details',
  unreadChatCount: 0,
  hostStatusBanner: null,
  enable3dTable: true,
  cameraPreset: 'standard',
};

const table3dScenes = new WeakMap<HTMLElement, Mahjong3DScene>();
const table3dContainers = new Set<HTMLElement>();
const feltVoidClickCallbacks = new WeakMap<HTMLElement, () => void>();

/** コンテナに紐づく 3D 卓カメラ視点を標準位置へリセットする */
export function resetTable3DCamera(container: HTMLElement): void {
  table3dScenes.get(container)?.resetCamera();
}

/** DOM から切り離された孤児コンテナの 3D シーン（WebGL2 コンテキスト）を自動回収する */
function cleanupDetached3dScenes(activeContainer: HTMLElement): void {
  for (const tracked of Array.from(table3dContainers)) {
    if (tracked === activeContainer) continue;
    if (!tracked.isConnected) {
      destroyTable3DScene(tracked);
    }
  }
}

/** コンテナに 3D 卓がアタッチされているか（または破棄する） */
export function destroyTable3DScene(container: HTMLElement): void {
  table3dContainers.delete(container);
  const existing = table3dScenes.get(container);
  if (existing) {
    existing.destroy();
    table3dScenes.delete(container);
  }
}

const MELD_TYPE_LABELS: Record<Meld['type'], string> = {
  pon: 'ポン',
  chi: 'チー',
  daiminkan: '大明槓',
  kakan: '加槓',
  ankan: '暗槓',
};

const ABORTIVE_DRAW_META: Record<
  AbortiveDrawReason,
  { title: string; description: string }
> = {
  kyuushu_kyuuhai: {
    title: '九種九牌',
    description: '第1ツモ時に么九牌が9種以上あったため途中流局となりました。',
  },
  suufon_renda: {
    title: '四風連打',
    description: '1巡目に4人全員が同じ風牌を捨てたため途中流局となりました。',
  },
  suucha_riichi: {
    title: '四家立直',
    description: '4人全員がリーチを宣言したため途中流局となりました。',
  },
  suukanzu: {
    title: '四槓散了',
    description: '2人以上で合計4回の槓が行われたため途中流局となりました。',
  },
  sancha_hou: {
    title: '三家和',
    description: '3人同時にロン宣言が発生したため途中流局となりました。',
  },
};

interface InternalRenderSnapshot {
  viewRef: StateView;
  viewerSeatIndex: number;
}

const previousRenderSnapshots = new WeakMap<HTMLElement, InternalRenderSnapshot>();

function toTileRectSnapshot(el: Element): TileRectSnapshot | null {
  if (typeof el.getBoundingClientRect !== 'function') return null;
  const rect = el.getBoundingClientRect();
  if (!Number.isFinite(rect.width) || !Number.isFinite(rect.height)) return null;
  if (rect.width <= 0 || rect.height <= 0) return null;
  return {
    cx: rect.left + rect.width / 2,
    cy: rect.top + rect.height / 2,
    width: rect.width,
    height: rect.height,
  };
}

/**
 * 再描画前に現行 DOM から自分手牌・各席手牌の座標を採取する。
 * 捨て牌アニメーションの開始位置を実際の牌位置へ合わせるために使用する。
 */
export function captureDiscardOriginSnapshot(
  root: ParentNode,
): DiscardOriginSnapshot {
  const selfTileRects = new Map<string, TileRectSnapshot>();
  const seatHands: Partial<Record<SeatSide, SeatHandOriginSnapshot>> = {};

  const selfTiles = root.querySelectorAll<HTMLElement>(
    '.seat-self .hand-area [data-tile-id]',
  );
  for (const el of selfTiles) {
    const id = el.dataset.tileId;
    if (!id) continue;
    const snap = toTileRectSnapshot(el);
    if (snap) {
      selfTileRects.set(id, snap);
    }
  }

  const collectSeatHand = (
    areaEl: HTMLElement | null,
    tileSelector: string,
  ): SeatHandOriginSnapshot => {
    if (!areaEl) return { tiles: [], area: null };
    const tiles: TileRectSnapshot[] = [];
    for (const el of areaEl.querySelectorAll(tileSelector)) {
      const snap = toTileRectSnapshot(el);
      if (snap) tiles.push(snap);
    }
    return {
      tiles,
      area: toTileRectSnapshot(areaEl),
    };
  };

  seatHands.self = collectSeatHand(
    root.querySelector<HTMLElement>('.seat-self .hand-area'),
    '.mj-tile',
  );
  for (const side of ['top', 'left', 'right'] as const) {
    seatHands[side] = collectSeatHand(
      root.querySelector<HTMLElement>(`.hand-orient-${side}`),
      '.mj-tile',
    );
  }

  return { selfTileRects, seatHands };
}

function getSeatSideForIndex(
  viewerSeatIndex: number,
  playerCount: number,
  seatIndex: number,
): SeatSide | null {
  if (playerCount <= 0) return null;
  if (seatIndex === viewerSeatIndex) return 'self';
  if (seatIndex === (viewerSeatIndex + 1) % playerCount) return 'right';
  if (playerCount === 4 && seatIndex === (viewerSeatIndex + 2) % playerCount) {
    return 'top';
  }
  if (
    seatIndex ===
    (viewerSeatIndex + (playerCount === 4 ? 3 : 2)) % playerCount
  ) {
    return 'left';
  }
  return null;
}

interface NewDiscardTarget {
  side: SeatSide;
  entry: DiscardEntry;
}

function detectNewlyDiscardedTargets(
  prevView: StateView | null,
  prevPerspectiveSeatIndex: number | undefined,
  nextView: StateView,
  nextPerspectiveSeatIndex: number,
): NewDiscardTarget[] {
  if (!prevView || prevView === nextView) return [];
  if (
    prevView.phase === 'lobby' ||
    nextView.phase === 'lobby' ||
    nextView.phase === 'finished'
  ) {
    return [];
  }
  if (!prevView.round || !nextView.round) return [];
  if (prevView.round.roundIndex !== nextView.round.roundIndex) return [];
  if (
    prevPerspectiveSeatIndex !== undefined &&
    prevPerspectiveSeatIndex !== nextPerspectiveSeatIndex
  ) {
    return [];
  }

  const playerCount = nextView.players.length;
  const targets: NewDiscardTarget[] = [];

  for (const player of nextView.players) {
    const prevPlayer = prevView.players.find(
      (p) => p.playerId === player.playerId,
    );
    if (!prevPlayer) continue;
    if (player.discards.length <= prevPlayer.discards.length) continue;

    let prefixMatches = true;
    for (let i = 0; i < prevPlayer.discards.length; i++) {
      if (player.discards[i]?.tile.id !== prevPlayer.discards[i]?.tile.id) {
        prefixMatches = false;
        break;
      }
    }
    if (!prefixMatches) continue;

    const latestEntry = player.discards[player.discards.length - 1];
    if (!latestEntry) continue;

    const side = getSeatSideForIndex(
      nextPerspectiveSeatIndex,
      playerCount,
      player.seatIndex,
    );
    if (!side) continue;
    targets.push({ side, entry: latestEntry });
  }

  return targets;
}

function resolveDiscardOriginRect(
  snapshot: DiscardOriginSnapshot | null,
  side: SeatSide,
  entry: DiscardEntry,
  isSpectator: boolean,
): TileRectSnapshot | null {
  if (!snapshot) return null;

  if (side === 'self' && !isSpectator) {
    const exact = snapshot.selfTileRects.get(entry.tile.id);
    if (exact) return exact;
  }

  const hand = snapshot.seatHands[side];
  if (!hand) return null;
  if (hand.tiles.length > 0) {
    if (entry.isTsumogiri) {
      return hand.tiles[hand.tiles.length - 1] ?? hand.area;
    }
    const midIdx = Math.floor(hand.tiles.length / 2);
    return hand.tiles[midIdx] ?? hand.area;
  }
  return hand.area;
}

const FALLBACK_DISCARD_DELTA: Record<SeatSide, { dx: number; dy: number }> = {
  self: { dx: 0, dy: 92 },
  top: { dx: 0, dy: -92 },
  left: { dx: -92, dy: 0 },
  right: { dx: 92, dy: 0 },
};

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function applyDiscardThrowAnimations(
  felt: HTMLElement,
  targets: readonly NewDiscardTarget[],
  originSnapshot: DiscardOriginSnapshot | null,
  isSpectator: boolean,
): void {
  for (const { side, entry } of targets) {
    const riverZone = felt.querySelector<HTMLElement>(`.river-zone.river-${side}`);
    if (!riverZone) continue;

    let tileEl: HTMLElement | null = null;
    for (const candidate of riverZone.querySelectorAll<HTMLElement>(
      '.discard-river .mj-tile',
    )) {
      if (candidate.dataset.tileId === entry.tile.id) {
        tileEl = candidate;
        break;
      }
    }
    if (!tileEl) continue;

    const destRect = toTileRectSnapshot(tileEl);
    const originRect = resolveDiscardOriginRect(
      originSnapshot,
      side,
      entry,
      isSpectator,
    );

    const fallback = FALLBACK_DISCARD_DELTA[side];
    let dx = fallback.dx;
    let dy = fallback.dy;
    let startScale = side === 'self' && !isSpectator ? 1.38 : 1.04;

    if (destRect && originRect) {
      const rawDx = clampNumber(originRect.cx - destRect.cx, -900, 900);
      const rawDy = clampNumber(originRect.cy - destRect.cy, -700, 700);
      if (Math.hypot(rawDx, rawDy) >= 4) {
        dx = rawDx;
        dy = rawDy;
      }
      if (side === 'self' && !isSpectator) {
        startScale = clampNumber(originRect.width / destRect.width, 1.12, 1.48);
      }
    }

    const dist = Math.hypot(dx, dy);
    const ux = dist > 0 ? -dx / dist : 0;
    const uy = dist > 0 ? -dy / dist : -1;
    const arcLift = clampNumber(dist * 0.09, 9, 18);
    const midX = dx * 0.48;
    const midY = dy * 0.48 - arcLift;
    const settleDist = 2.2;
    const settleX = ux * settleDist;
    const settleY = uy * settleDist;
    const peakScale =
      side === 'self' && !isSpectator
        ? Math.max(startScale * 1.03, 1.28)
        : 1.22;

    const isRiichiDecl = Boolean(entry.isRiichiDeclaration);
    if (isRiichiDecl) {
      tileEl.style.setProperty('--discard-start-rot', 'var(--river-rot, 0deg)');
      tileEl.style.setProperty(
        '--discard-mid-rot',
        'calc(var(--river-rot, 0deg) - 24deg)',
      );
      tileEl.style.setProperty(
        '--discard-settle-rot',
        'calc(var(--river-rot, 0deg) - 94deg)',
      );
      tileEl.style.setProperty(
        '--discard-end-rot',
        'calc(var(--river-rot, 0deg) - 90deg)',
      );
    } else {
      const tiltStart = side === 'right' ? 4 : -4;
      const tiltMid = side === 'right' ? -2 : 3;
      tileEl.style.setProperty(
        '--discard-start-rot',
        `calc(var(--river-rot, 0deg) + ${tiltStart}deg)`,
      );
      tileEl.style.setProperty(
        '--discard-mid-rot',
        `calc(var(--river-rot, 0deg) + ${tiltMid}deg)`,
      );
      tileEl.style.setProperty(
        '--discard-settle-rot',
        'var(--river-rot, 0deg)',
      );
      tileEl.style.setProperty('--discard-end-rot', 'var(--river-rot, 0deg)');
    }

    tileEl.style.setProperty('--discard-dx', `${dx.toFixed(1)}px`);
    tileEl.style.setProperty('--discard-dy', `${dy.toFixed(1)}px`);
    tileEl.style.setProperty('--discard-mid-x', `${midX.toFixed(1)}px`);
    tileEl.style.setProperty('--discard-mid-y', `${midY.toFixed(1)}px`);
    tileEl.style.setProperty('--discard-settle-x', `${settleX.toFixed(1)}px`);
    tileEl.style.setProperty('--discard-settle-y', `${settleY.toFixed(1)}px`);
    tileEl.style.setProperty('--discard-start-scale', startScale.toFixed(3));
    tileEl.style.setProperty('--discard-peak-scale', peakScale.toFixed(3));

    tileEl.dataset.discardAnim = 'true';
    riverZone.classList.add('is-discard-animating');
    tileEl.classList.add('mj-tile-discard-anim');
    if (isRiichiDecl) {
      tileEl.classList.add('mj-tile-discard-riichi-anim');
    }

    const animTile = tileEl;
    let cleaned = false;
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      if (fallbackTimer !== null) {
        clearTimeout(fallbackTimer);
        fallbackTimer = null;
      }
      animTile.classList.remove(
        'mj-tile-discard-anim',
        'mj-tile-discard-riichi-anim',
      );
      if (!riverZone.querySelector('.mj-tile-discard-anim')) {
        riverZone.classList.remove('is-discard-animating');
      }
    };

    animTile.addEventListener(
      'animationend',
      (event) => {
        if (event.target !== animTile) return;
        const animName = (event as AnimationEvent).animationName;
        if (animName && animName !== 'tileDiscardThrow') return;
        cleanup();
      },
    );
    fallbackTimer = setTimeout(cleanup, isRiichiDecl ? 500 : 440);
  }
}

/** 横向き画面（スマホ横持ち・PC）と縦向き画面の両対応を切り替える目印 */
function applyOrientationClass(element: HTMLElement): void {
  element.classList.add('is-landscape');
}

const KANJI_KYOKU_NUMBERS = ['', '一', '二', '三', '四'] as const;

function formatRoundKanjiTitle(
  roundWind: 'E' | 'S' | 'W' | 'N',
  kyokuNumber: number,
): string {
  const windStr = windToJa(roundWind);
  const numStr = KANJI_KYOKU_NUMBERS[kyokuNumber] ?? String(kyokuNumber);
  return `${windStr}${numStr}局`;
}

interface DrawTarget {
  side: SeatSide;
  tileId: string | null;
}

const FALLBACK_DRAW_DELTA: Record<SeatSide, { dx: number; dy: number }> = {
  self: { dx: 0, dy: -110 },
  top: { dx: 0, dy: 96 },
  left: { dx: 110, dy: 0 },
  right: { dx: -110, dy: 0 },
};

function detectNewDrawTargets(
  prevView: StateView | null,
  prevPerspectiveSeatIndex: number | undefined,
  nextView: StateView,
  nextPerspectiveSeatIndex: number,
): DrawTarget[] {
  if (nextView.phase !== 'playing' || !nextView.round) return [];
  if (prevView === nextView) return [];
  if (
    prevView &&
    prevPerspectiveSeatIndex !== undefined &&
    prevView.round?.roundIndex === nextView.round.roundIndex &&
    prevPerspectiveSeatIndex !== nextPerspectiveSeatIndex
  ) {
    return [];
  }

  const isSpectator = Boolean(nextView.isSpectator);
  const playerCount = nextView.players.length;
  const sameRound =
    prevView !== null &&
    prevView.phase !== 'lobby' &&
    prevView.phase !== 'round_end' &&
    prevView.phase !== 'finished' &&
    prevView.round?.roundIndex === nextView.round.roundIndex;

  const isFreshRoundStart =
    !sameRound &&
    nextView.players.every((p) => p.discards.length === 0 && p.melds.length === 0);

  const targets: DrawTarget[] = [];

  for (const player of nextView.players) {
    const side = getSeatSideForIndex(
      nextPerspectiveSeatIndex,
      playerCount,
      player.seatIndex,
    );
    if (!side) continue;

    const prevPlayer = sameRound
      ? prevView?.players.find((p) => p.playerId === player.playerId)
      : undefined;

    if (side === 'self' && !isSpectator) {
      const drawn = nextView.myDrawnTile;
      if (!drawn) continue;
      if (isFreshRoundStart) {
        targets.push({ side, tileId: drawn.id });
        continue;
      }
      if (
        sameRound &&
        (prevView?.myDrawnTile === null ||
          prevView?.myDrawnTile?.id !== drawn.id)
      ) {
        targets.push({ side, tileId: drawn.id });
      }
      continue;
    }

    if (!player.hasDrawnTile) continue;
    if (isFreshRoundStart) {
      targets.push({ side, tileId: null });
      continue;
    }
    if (
      sameRound &&
      prevPlayer &&
      (!prevPlayer.hasDrawnTile ||
        (player.isCurrentTurn && !prevPlayer.isCurrentTurn))
    ) {
      targets.push({ side, tileId: null });
    }
  }

  return targets;
}

function applyDrawSlideAnimations(
  felt: HTMLElement,
  targets: readonly DrawTarget[],
  delayMs: number,
  isSpectator: boolean,
): void {
  const centerHub = felt.querySelector<HTMLElement>('.center-hub');
  const centerRect = centerHub ? toTileRectSnapshot(centerHub) : null;

  for (const target of targets) {
    const seatEl = felt.querySelector<HTMLElement>(
      `.seat-orient-${target.side}`,
    );
    if (!seatEl) continue;

    let tileEl: HTMLElement | null = null;
    if (target.side === 'self' && !isSpectator && target.tileId) {
      for (const candidate of seatEl.querySelectorAll<HTMLElement>(
        '.hand-area .mj-tile-drawn',
      )) {
        if (candidate.dataset.tileId === target.tileId) {
          tileEl = candidate;
          break;
        }
      }
    } else {
      tileEl = seatEl.querySelector<HTMLElement>(
        `.hand-orient-${target.side} .opp-tile-drawn`,
      );
    }
    if (!tileEl) continue;

    const destRect = toTileRectSnapshot(tileEl);
    const fallback = FALLBACK_DRAW_DELTA[target.side];
    let dx = fallback.dx;
    let dy = fallback.dy;

    if (destRect && centerRect) {
      const rawDx = clampNumber(centerRect.cx - destRect.cx, -850, 850);
      const rawDy = clampNumber(centerRect.cy - destRect.cy, -650, 650);
      if (Math.hypot(rawDx, rawDy) >= 6) {
        dx = rawDx;
        dy = rawDy;
      }
    }

    tileEl.style.setProperty('--draw-dx', `${dx.toFixed(1)}px`);
    tileEl.style.setProperty('--draw-dy', `${dy.toFixed(1)}px`);
    tileEl.style.setProperty(
      '--draw-delay',
      delayMs > 0 ? `${delayMs}ms` : '0ms',
    );
    tileEl.dataset.drawAnim = 'true';
    tileEl.classList.add('mj-tile-draw-anim');

    const animTile = tileEl;
    let cleaned = false;
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      if (fallbackTimer !== null) {
        clearTimeout(fallbackTimer);
        fallbackTimer = null;
      }
      animTile.classList.remove('mj-tile-draw-anim');
    };

    animTile.addEventListener('animationend', (event) => {
      if (event.target !== animTile) return;
      const animName = (event as AnimationEvent).animationName;
      if (animName && animName !== 'tileDrawSlide') return;
      cleanup();
    });
    fallbackTimer = setTimeout(cleanup, delayMs + 340);
  }
}

interface RenderDiffSummary {
  newlyRiichiSides: Set<SeatSide>;
  newlyMeldedSides: Map<SeatSide, Set<number>>;
  newlyAddedKitaSides: Set<SeatSide>;
  newlyRevealedDoraIndices: Set<number>;
  scoreDeltasBySide: Map<SeatSide, { prevScore: number; nextScore: number }>;
  hasNewDoraFlipSound: boolean;
  hasNewMeldSound: boolean;
}

function computeRenderDiff(
  prevView: StateView | null,
  prevPerspectiveSeatIndex: number | undefined,
  nextView: StateView,
  nextPerspectiveSeatIndex: number,
): RenderDiffSummary {
  const newlyRiichiSides = new Set<SeatSide>();
  const newlyMeldedSides = new Map<SeatSide, Set<number>>();
  const newlyAddedKitaSides = new Set<SeatSide>();
  const newlyRevealedDoraIndices = new Set<number>();
  const scoreDeltasBySide = new Map<
    SeatSide,
    { prevScore: number; nextScore: number }
  >();

  let hasNewDoraFlipSound = false;
  let hasNewMeldSound = false;

  const samePerspective =
    prevPerspectiveSeatIndex === undefined ||
    prevPerspectiveSeatIndex === nextPerspectiveSeatIndex;
  const sameRound =
    prevView !== null &&
    prevView.phase !== 'lobby' &&
    prevView.phase !== 'round_end' &&
    prevView.phase !== 'finished' &&
    prevView.round !== null &&
    nextView.round !== null &&
    prevView.round.roundIndex === nextView.round.roundIndex;

  if (nextView.round) {
    if (sameRound && prevView?.round) {
      const prevLen = prevView.round.doraIndicators.length;
      const nextLen = nextView.round.doraIndicators.length;
      for (let i = prevLen; i < nextLen; i++) {
        newlyRevealedDoraIndices.add(i);
        hasNewDoraFlipSound = true;
      }
    } else if (
      nextView.phase === 'playing' &&
      nextView.players.every((p) => p.discards.length === 0) &&
      nextView.round.doraIndicators.length > 0
    ) {
      newlyRevealedDoraIndices.add(0);
    }
  }

  const playerCount = nextView.players.length;
  if (prevView && prevView !== nextView && prevView.phase !== 'lobby') {
    for (const player of nextView.players) {
      const prevPlayer = prevView.players.find(
        (p) => p.playerId === player.playerId,
      );
      if (!prevPlayer) continue;
      const side = getSeatSideForIndex(
        nextPerspectiveSeatIndex,
        playerCount,
        player.seatIndex,
      );
      if (!side) continue;

      if (player.score !== prevPlayer.score) {
        scoreDeltasBySide.set(side, {
          prevScore: prevPlayer.score,
          nextScore: player.score,
        });
      }

      if (sameRound && samePerspective) {
        if (!prevPlayer.isRiichi && player.isRiichi) {
          newlyRiichiSides.add(side);
        }

        const meldIndices = new Set<number>();
        if (player.melds.length > prevPlayer.melds.length) {
          for (let i = prevPlayer.melds.length; i < player.melds.length; i++) {
            meldIndices.add(i);
          }
        }
        for (
          let i = 0;
          i < Math.min(player.melds.length, prevPlayer.melds.length);
          i++
        ) {
          if (
            prevPlayer.melds[i]?.type === 'pon' &&
            player.melds[i]?.type === 'kakan'
          ) {
            meldIndices.add(i);
          }
        }
        if (meldIndices.size > 0) {
          newlyMeldedSides.set(side, meldIndices);
          hasNewMeldSound = true;
        }

        if (player.kitaTiles.length > prevPlayer.kitaTiles.length) {
          newlyAddedKitaSides.add(side);
          hasNewMeldSound = true;
        }
      }
    }
  }

  return {
    newlyRiichiSides,
    newlyMeldedSides,
    newlyAddedKitaSides,
    newlyRevealedDoraIndices,
    scoreDeltasBySide,
    hasNewDoraFlipSound,
    hasNewMeldSound,
  };
}

function animateNumericCounter(
  el: HTMLElement,
  from: number,
  to: number,
  durationMs = 520,
): void {
  el.dataset.targetScore = String(to);
  if (from === to) {
    el.textContent = String(to);
    return;
  }
  if (
    typeof requestAnimationFrame !== 'function' ||
    typeof performance === 'undefined' ||
    (typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  ) {
    el.textContent = String(to);
    return;
  }

  el.textContent = String(from);
  const startTime = performance.now();
  const diff = to - from;
  const step = (now: number) => {
    if (!el.isConnected) return;
    const t = clampNumber((now - startTime) / durationMs, 0, 1);
    // イーズアウト（3乗）
    const eased = 1 - Math.pow(1 - t, 3);
    const current = Math.round(from + diff * eased);
    el.textContent = String(current);
    if (t < 1) {
      requestAnimationFrame(step);
    } else {
      el.textContent = String(to);
    }
  };
  requestAnimationFrame(step);
}

interface ActiveRoundBannerState {
  key: string;
  title: string;
  subtitle: string;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout> | null;
}

const activeRoundBanners = new WeakMap<HTMLElement, ActiveRoundBannerState>();

function updateAndRenderRoundBanner(
  container: HTMLElement,
  felt: HTMLElement,
  prevView: StateView | null,
  view: StateView,
): boolean {
  const existing = activeRoundBanners.get(container) ?? null;
  const existingBannerEls = Array.from(felt.children).filter((el): el is HTMLElement =>
    el.classList.contains('round-start-banner'),
  );

  if (view.phase !== 'playing' || !view.round) {
    if (existing?.timer) clearTimeout(existing.timer);
    activeRoundBanners.delete(container);
    for (const el of existingBannerEls) el.remove();
    return false;
  }

  const round = view.round;
  const key = `${round.roundIndex}:${round.honba}`;
  const isTransitionToNewRound =
    prevView === null
      ? view.players.every((p) => p.discards.length === 0 && p.melds.length === 0)
      : prevView.phase === 'lobby' ||
        prevView.phase === 'round_end' ||
        prevView.round?.roundIndex !== round.roundIndex;

  let bannerState = existing;
  let triggeredNew = false;

  if (isTransitionToNewRound && existing?.key !== key) {
    if (existing?.timer) clearTimeout(existing.timer);
    const dealer = view.players.find((p) => p.seatIndex === round.dealerIndex);
    const title = formatRoundKanjiTitle(round.roundWind, round.kyokuNumber);
    const parts: string[] = [];
    if (round.honba > 0) parts.push(`${round.honba}本場`);
    if (dealer) parts.push(`親: ${dealer.name}`);
    const subtitle = parts.join(' ・ ');

    bannerState = {
      key,
      title,
      subtitle,
      expiresAt: Date.now() + 1650,
      timer: null,
    };
    activeRoundBanners.set(container, bannerState);
    triggeredNew = true;
  }

  if (!bannerState || Date.now() >= bannerState.expiresAt) {
    if (bannerState && Date.now() >= bannerState.expiresAt) {
      if (bannerState.timer) clearTimeout(bannerState.timer);
      activeRoundBanners.delete(container);
    }
    for (const el of existingBannerEls) el.remove();
    return false;
  }

  const reusable = existingBannerEls.find(
    (el) => el.dataset.roundKey === bannerState.key,
  );
  for (const el of existingBannerEls) {
    if (el !== reusable) el.remove();
  }
  if (reusable) {
    return false;
  }

  const bannerEl = document.createElement('div');
  bannerEl.className = 'round-start-banner';
  bannerEl.dataset.roundKey = bannerState.key;
  bannerEl.setAttribute('role', 'status');

  const titleEl = document.createElement('div');
  titleEl.className = 'round-start-banner-title';
  titleEl.textContent = bannerState.title;
  bannerEl.appendChild(titleEl);

  if (bannerState.subtitle) {
    const subEl = document.createElement('div');
    subEl.className = 'round-start-banner-sub';
    subEl.textContent = bannerState.subtitle;
    bannerEl.appendChild(subEl);
  }

  felt.appendChild(bannerEl);

  if (!bannerState.timer) {
    const remaining = Math.max(50, bannerState.expiresAt - Date.now());
    const refState = bannerState;
    refState.timer = setTimeout(() => {
      if (activeRoundBanners.get(container) === refState) {
        activeRoundBanners.delete(container);
      }
      if (bannerEl.isConnected) {
        bannerEl.classList.add('is-leaving');
        setTimeout(() => {
          bannerEl.remove();
        }, 260);
      }
    }, remaining);
  }

  return triggeredNew;
}

function resolveActiveSeatIndex(
  view: StateView,
  perspectiveSeatIndex: number | undefined,
): number {
  const count = view.players.length;
  if (
    Boolean(view.isSpectator) &&
    count > 0 &&
    perspectiveSeatIndex !== undefined
  ) {
    return ((perspectiveSeatIndex % count) + count) % count;
  }
  return view.viewerSeatIndex;
}

export function renderGameTable(
  container: HTMLElement,
  view: StateView,
  handlers: TableHandlers,
  uiState: TableUiState = DEFAULT_TABLE_UI_STATE,
): void {
  const internalPrev = previousRenderSnapshots.get(container) ?? null;
  const useExternalPrev = uiState.prevView !== undefined;
  const prevView = useExternalPrev
    ? (uiState.prevView ?? null)
    : (internalPrev?.viewRef ?? null);
  const prevPerspectiveSeatIndex = prevView
    ? useExternalPrev
      ? resolveActiveSeatIndex(prevView, uiState.prevPerspectiveSeatIndex)
      : internalPrev?.viewerSeatIndex
    : undefined;
  const originSnapshot = useExternalPrev
    ? (uiState.discardOriginSnapshot ?? null)
    : internalPrev
      ? captureDiscardOriginSnapshot(container)
      : null;

  const playerCount = view.players.length;
  const isSpectator = Boolean(view.isSpectator);
  const isHost = !isSpectator && view.viewerPlayerId === view.hostPlayerId;

  if (view.phase === 'finished') {
    table3dScenes.get(container)?.pause();
    container.innerHTML = '';
    const isFreshFinish = prevView !== null && prevView.phase !== 'finished';
    if (
      isFreshFinish &&
      prevView?.phase !== 'round_end' &&
      view.players.some((p) => p.score !== deriveRules(view.ruleConfig).initialPoints)
    ) {
      soundEngine.playRoundStart();
    }
    previousRenderSnapshots.set(container, {
      viewRef: view,
      viewerSeatIndex: view.viewerSeatIndex,
    });
    renderFinishedScreen(container, view, handlers);
    return;
  }

  // 3D WebGL2 麻雀卓の取得・再利用（DOM を切り離さずに維持してチラつき・コンテキストリークを防止）
  const want3d = uiState.enable3dTable !== false;
  let scene3d: Mahjong3DScene | null = null;
  if (want3d) {
    scene3d = table3dScenes.get(container) ?? null;
    if (!scene3d) {
      cleanupDetached3dScenes(container);
      scene3d = Mahjong3DScene.tryCreate();
      if (scene3d) {
        table3dScenes.set(container, scene3d);
        table3dContainers.add(container);
      }
    }
  } else {
    table3dScenes.get(container)?.pause();
  }

  const existingStage = Array.from(container.children).find((el): el is HTMLElement =>
    el.classList.contains('table-stage'),
  );
  const existingFelt = existingStage
    ? Array.from(existingStage.children).find((el): el is HTMLElement =>
        el.classList.contains('table-felt'),
      )
    : undefined;
  const canReuse3dDom = Boolean(
    scene3d && existingStage && existingFelt && scene3d.canvas.parentElement === existingFelt,
  );

  let wrapper: HTMLElement;
  let felt: HTMLElement;
  if (canReuse3dDom && existingStage && existingFelt) {
    wrapper = existingStage;
    felt = existingFelt;
    for (const child of Array.from(container.children)) {
      if (child !== wrapper) child.remove();
    }
    for (const child of Array.from(felt.children)) {
      if (
        child !== scene3d!.canvas &&
        !child.classList.contains('round-start-banner')
      ) {
        child.remove();
      }
    }
  } else {
    container.innerHTML = '';
    wrapper = document.createElement('div');
    wrapper.className = 'table-stage';
    applyOrientationClass(wrapper);

    felt = document.createElement('div');
    felt.className = 'table-felt';
    applyOrientationClass(felt);

    felt.addEventListener('click', (event) => {
      if (
        event.target instanceof Element &&
        event.target.closest('.hand-area, button, .table-3d-canvas')
      ) {
        return;
      }
      feltVoidClickCallbacks.get(felt)?.();
    });
  }

  const activeSeatIndex = resolveActiveSeatIndex(
    view,
    uiState.perspectiveSeatIndex,
  );

  const discardTargets = detectNewlyDiscardedTargets(
    prevView,
    prevPerspectiveSeatIndex,
    view,
    activeSeatIndex,
  );
  const drawTargets = detectNewDrawTargets(
    prevView,
    prevPerspectiveSeatIndex,
    view,
    activeSeatIndex,
  );
  const diff = computeRenderDiff(
    prevView,
    prevPerspectiveSeatIndex,
    view,
    activeSeatIndex,
  );
  const rankByPlayerId = computePlayerRankMap(
    view.players,
    view.initialDealerIndex,
  );

  const perspectiveView: StateView =
    activeSeatIndex === view.viewerSeatIndex
      ? view
      : { ...view, viewerSeatIndex: activeSeatIndex };

  // 相対座席の割り当て（下:自分または視点席、右:下家、上:対面(4人のみ)、左:上家）
  const selfPlayer = perspectiveView.players.find(
    (p) => p.seatIndex === perspectiveView.viewerSeatIndex,
  );
  const rightPlayer = perspectiveView.players.find(
    (p) => p.seatIndex === (perspectiveView.viewerSeatIndex + 1) % playerCount,
  );
  const topPlayer =
    playerCount === 4
      ? perspectiveView.players.find(
          (p) =>
            p.seatIndex === (perspectiveView.viewerSeatIndex + 2) % playerCount,
        )
      : undefined;
  const leftPlayer =
    playerCount === 4
      ? perspectiveView.players.find(
          (p) =>
            p.seatIndex === (perspectiveView.viewerSeatIndex + 3) % playerCount,
        )
      : perspectiveView.players.find(
          (p) =>
            p.seatIndex === (perspectiveView.viewerSeatIndex + 2) % playerCount,
        );

  if (topPlayer) {
    felt.appendChild(
      renderOpponentSeat(
        'top',
        topPlayer,
        perspectiveView,
        rankByPlayerId.get(topPlayer.playerId),
        diff.newlyMeldedSides.get('top'),
        diff.newlyAddedKitaSides.has('top'),
        uiState.chatBubbles?.[topPlayer.playerId],
      ),
    );
  } else {
    const emptyTop = document.createElement('div');
    emptyTop.className = 'seat-top seat-empty';
    felt.appendChild(emptyTop);
  }

  if (leftPlayer) {
    felt.appendChild(
      renderOpponentSeat(
        'left',
        leftPlayer,
        perspectiveView,
        rankByPlayerId.get(leftPlayer.playerId),
        diff.newlyMeldedSides.get('left'),
        diff.newlyAddedKitaSides.has('left'),
        uiState.chatBubbles?.[leftPlayer.playerId],
      ),
    );
  } else {
    const emptyLeft = document.createElement('div');
    emptyLeft.className = 'seat-left seat-empty';
    felt.appendChild(emptyLeft);
  }

  felt.appendChild(renderCenterHub(perspectiveView, diff));

  if (rightPlayer) {
    felt.appendChild(
      renderOpponentSeat(
        'right',
        rightPlayer,
        perspectiveView,
        rankByPlayerId.get(rightPlayer.playerId),
        diff.newlyMeldedSides.get('right'),
        diff.newlyAddedKitaSides.has('right'),
        uiState.chatBubbles?.[rightPlayer.playerId],
      ),
    );
  } else {
    const emptyRight = document.createElement('div');
    emptyRight.className = 'seat-right seat-empty';
    felt.appendChild(emptyRight);
  }

  let selfSeatController: SelfSeatController | null = null;
  if (selfPlayer) {
    if (isSpectator) {
      felt.appendChild(
        renderSpectatedBottomSeat(
          selfPlayer,
          rankByPlayerId.get(selfPlayer.playerId),
          diff.newlyMeldedSides.get('self'),
          diff.newlyAddedKitaSides.has('self'),
          uiState.chatBubbles?.[selfPlayer.playerId],
        ),
      );
    } else {
      selfSeatController = renderSelfSeat(
        perspectiveView,
        selfPlayer,
        handlers,
        uiState,
        rankByPlayerId.get(selfPlayer.playerId),
        diff.newlyMeldedSides.get('self'),
        diff.newlyAddedKitaSides.has('self'),
      );
      felt.appendChild(selfSeatController.box);
    }
  }

  // 対局中は雀卓だけを表示する（チャット・設定・退出ボタンは右上に集約）
  felt.appendChild(renderTableChrome(handlers, uiState));

  if (isSpectator) {
    felt.appendChild(
      renderSpectatorHud(perspectiveView, activeSeatIndex, handlers),
    );
  } else {
    felt.appendChild(renderLeftActionBar(handlers, uiState));
  }

  const doraPanel = renderDoraPanel(
    perspectiveView,
    diff.newlyRevealedDoraIndices,
  );
  if (doraPanel) {
    felt.appendChild(doraPanel);
  }

  if (uiState.hostStatusBanner) {
    const awayBanner = document.createElement('div');
    awayBanner.className = 'table-host-away-banner';
    awayBanner.setAttribute('role', 'alert');
    awayBanner.textContent = uiState.hostStatusBanner;
    felt.appendChild(awayBanner);
  }

  const triggeredNewRoundBanner = updateAndRenderRoundBanner(
    container,
    felt,
    prevView,
    view,
  );

  feltVoidClickCallbacks.set(felt, () => {
    if (selfSeatController) {
      selfSeatController.clearSelection();
      return;
    }
    const selected = felt.querySelectorAll<HTMLElement>(
      '.seat-self .hand-area .mj-tile-selected',
    );
    if (selected.length === 0) return;
    for (const el of selected) {
      el.classList.remove('mj-tile-selected');
      el.setAttribute('aria-pressed', 'false');
    }
    handlers.onSelectTile?.(null);
  });

  if (scene3d) {
    felt.classList.add('is-3d-table');
    if (scene3d.canvas.parentElement !== felt) {
      felt.prepend(scene3d.canvas);
    }
    selfSeatController?.setSceneRef(scene3d);
    scene3d.setCallbacks({
      onClickHandTile: (tileId) => selfSeatController?.tapTileById(tileId),
      onClickTableVoid: () => selfSeatController?.clearSelection(),
    });
  } else {
    felt.classList.remove('is-3d-table');
  }

  if (!canReuse3dDom) {
    wrapper.appendChild(felt);
    container.appendChild(wrapper);
  }

  if (scene3d) {
    const canDiscardNow = Boolean(selfSeatController?.canDiscardNow);
    const newlyDiscardedSides = new Set(discardTargets.map((t) => t.side));
    const newlyDrawnSides = new Set(drawTargets.map((t) => t.side));
    scene3d.syncView({
      view: perspectiveView,
      isSpectator,
      canDiscardNow,
      selectedTileId: canDiscardNow ? (uiState.selectedTileId ?? null) : null,
      riichiSelectingMode: uiState.riichiSelectingMode,
      canRiichiTileIds: perspectiveView.mySelfActions?.canRiichiTileIds ?? [],
      kuikaeForbiddenKinds: perspectiveView.kuikaeForbiddenKinds,
      cameraPreset: uiState.cameraPreset ?? 'standard',
      newlyDiscardedSides,
      newlyDrawnSides,
      newlyRevealedDoraIndices: diff.newlyRevealedDoraIndices,
    });
    scene3d.resume();
  } else {
    if (discardTargets.length > 0) {
      applyDiscardThrowAnimations(
        felt,
        discardTargets,
        originSnapshot,
        isSpectator,
      );
    }

    if (drawTargets.length > 0) {
      const drawDelayMs = discardTargets.length > 0 ? 150 : 0;
      applyDrawSlideAnimations(felt, drawTargets, drawDelayMs, isSpectator);
    }
  }

  // 各種効果音をアニメーションタイミングに合わせて再生
  const isEnteringRoundEnd =
    prevView !== null &&
    prevView.phase !== 'round_end' &&
    view.phase === 'round_end' &&
    view.round !== null;
  const hasAgariInRound =
    Boolean(
      view.round &&
        (view.round.agariResults.length > 0 || view.round.ronWinners.length > 0),
    );

  if (isEnteringRoundEnd) {
    if (hasAgariInRound) {
      const isTsumo = view.round!.agariResults[0]?.winType === 'tsumo';
      soundEngine.playAgari(isTsumo);
    } else {
      soundEngine.playDrawRound();
    }
  } else {
    const hasRiichiDiscard = discardTargets.some(
      (t) => t.entry.isRiichiDeclaration,
    );
    if (hasRiichiDiscard || diff.newlyRiichiSides.size > 0) {
      soundEngine.playRiichi(195);
    } else if (discardTargets.length > 0) {
      soundEngine.playDiscard(195);
    }
    if (diff.hasNewMeldSound) {
      soundEngine.playMeld();
    }
    if (diff.hasNewDoraFlipSound) {
      soundEngine.playDoraFlip();
    }
    if (triggeredNewRoundBanner) {
      soundEngine.playRoundStart();
    }
    if (drawTargets.length > 0 && !triggeredNewRoundBanner) {
      soundEngine.playDraw(discardTargets.length > 0 ? 185 : 55);
    }
  }

  previousRenderSnapshots.set(container, {
    viewRef: view,
    viewerSeatIndex: activeSeatIndex,
  });

  // 局終了オーバーレイ（和了 / 流局）
  if (view.phase === 'round_end' && view.round) {
    renderRoundEndOverlay(
      container,
      view,
      isHost,
      handlers,
      uiState,
      isEnteringRoundEnd && hasAgariInRound,
    );
  }
}

function formatNextRoundDescription(view: StateView, round: RoundView): string {
  const decision = round.nextRoundDecision;
  const currentTitle = formatRoundName(round.roundWind, round.kyokuNumber);
  const rules = deriveRules(view.ruleConfig);
  if (!decision) {
    if (round.isTobiEnded) {
      return '持ち点が0点未満になったプレイヤーがいるため、トビ終了となります。';
    }
    return round.roundIndex + 1 >= round.totalRounds
      ? '規定局数がすべて終了しました。'
      : '次局へ進みます。';
  }

  if (decision.outcome === 'renchan') {
    switch (decision.reason) {
      case 'abortive_draw':
        return `途中流局のため親の連荘となり、${currentTitle} ${decision.nextHonba}本場へ進みます。`;
      case 'oya_agari':
        return `親の和了により連荘となり、${currentTitle} ${decision.nextHonba}本場へ進みます。`;
      case 'double_ron_with_oya':
        return `親と子の同時ダブロンのため親の連荘となり、${currentTitle} ${decision.nextHonba}本場へ進みます。`;
      case 'oya_tenpai_draw':
        return `親がテンパイで流局したため連荘となり、${currentTitle} ${decision.nextHonba}本場へ進みます。`;
      default:
        return `連荘となり、${currentTitle} ${decision.nextHonba}本場へ進みます。`;
    }
  }

  if (decision.outcome === 'oya_nagare') {
    const nextMeta = getRoundMetadataSafe(decision.nextRoundIndex, rules);
    const nextTitle = formatRoundName(
      nextMeta.roundWind,
      nextMeta.kyokuNumber,
      decision.nextHonba,
    );
    switch (decision.reason) {
      case 'ko_agari':
        return `子の和了により親流れとなり、${nextTitle}へ進みます。`;
      case 'oya_noten_draw':
        return `親がノーテンで流局したため親流れとなり、${nextTitle}へ進みます。`;
      default:
        return `親流れとなり、${nextTitle}へ進みます。`;
    }
  }

  // decision.outcome === 'game_end'
  switch (decision.reason) {
    case 'tobi':
      return '持ち点が0点未満になったプレイヤーがいるため、トビ終了となります。';
    case 'ko_agari':
      return 'オーラスで子が和了したため、対局終了（終局）となります。';
    case 'oya_noten_draw':
      return 'オーラスで親がノーテン流局となったため、対局終了（終局）となります。';
    default:
      return '規定局数が終了したため、対局終了（終局）となります。';
  }
}

function getRoundMetadataSafe(
  roundIndex: number,
  rules: ReturnType<typeof deriveRules>,
): { roundWind: 'E' | 'S' | 'W' | 'N'; kyokuNumber: number } {
  // 総局数超過時は最終局の表示にフォールバックする
  const clampedIndex = Math.min(roundIndex, rules.totalRounds - 1);
  const roundWindIndex = Math.floor(clampedIndex / rules.playerCount);
  const roundWind = rules.roundWinds[roundWindIndex] ?? 'E';
  return {
    roundWind,
    kyokuNumber: (clampedIndex % rules.playerCount) + 1,
  };
}

function renderRoundEndOverlay(
  container: HTMLElement,
  view: StateView,
  isHost: boolean,
  handlers: TableHandlers,
  uiState: TableUiState = DEFAULT_TABLE_UI_STATE,
  isFreshAgariReveal = false,
): void {
  const round = view.round!;
  const hasAgariResults =
    round.agariResults.length > 0 || round.ronWinners.length > 0;
  const overlay = document.createElement('div');
  overlay.className = `overlay-panel round-end-panel${
    hasAgariResults ? ' is-agari-panel' : ''
  }`;
  applyOrientationClass(overlay);

  const roundTitle = formatRoundName(round.roundWind, round.kyokuNumber, round.honba);
  const isGameClosing = round.nextRoundDecision
    ? round.nextRoundDecision.outcome === 'game_end'
    : round.isTobiEnded || round.roundIndex + 1 >= round.totalRounds;

  let headingLabel = `${roundTitle} 流局（荒牌平局）`;
  if (round.agariResults.length > 0) {
    const first = round.agariResults[0]!;
    if (first.winType === 'tsumo') {
      headingLabel = `${roundTitle} ツモ和了`;
    } else if (round.agariResults.length >= 2) {
      headingLabel = `${roundTitle} ダブロン和了`;
    } else {
      headingLabel = `${roundTitle} ロン和了`;
    }
  } else if (round.ronWinners.length > 0) {
    headingLabel = `${roundTitle} ロン和了`;
  } else if (round.abortiveDrawReason) {
    const meta = ABORTIVE_DRAW_META[round.abortiveDrawReason];
    headingLabel = `${roundTitle} 途中流局（${meta.title}）`;
  }

  let currentStep: RoundEndStep = uiState.roundEndStep ?? 'details';

  const setStep = (nextStep: RoundEndStep): void => {
    currentStep = nextStep;
    renderStepBody(nextStep);
    handlers.onChangeRoundEndStep?.(nextStep);
  };

  const renderStepBody = (step: RoundEndStep): void => {
    overlay.innerHTML = '';
    overlay.dataset.resultStep = step;

    const headerRow = document.createElement('div');
    headerRow.className = 'round-end-header-row';

    const heading = document.createElement('h2');
    heading.style.margin = '0';
    heading.style.color = 'var(--accent-gold)';
    heading.textContent = headingLabel;

    if (round.isTobiEnded) {
      const tobiTag = document.createElement('span');
      tobiTag.className = 'tobi-badge';
      tobiTag.textContent = 'トビ終了';
      heading.appendChild(tobiTag);
    }

    const headerRight = document.createElement('div');
    headerRight.className = 'round-end-step-controls';

    const stepPill = document.createElement('span');
    stepPill.className = 'round-step-pill';
    stepPill.textContent =
      step === 'details'
        ? round.agariResults.length > 0
          ? '1 / 2 役・裏ドラ'
          : '1 / 2 結果詳細'
        : '2 / 2 点数移動';
    headerRight.appendChild(stepPill);

    if (step === 'scores') {
      const backBtn = document.createElement('button');
      backBtn.type = 'button';
      backBtn.className = 'btn btn-secondary round-step-back-btn';
      backBtn.textContent =
        round.agariResults.length > 0 ? '← 役・裏ドラ' : '← 結果詳細';
      backBtn.addEventListener('click', () => setStep('details'));
      headerRight.appendChild(backBtn);
    }

    headerRow.append(heading, headerRight);
    overlay.appendChild(headerRow);

    if (step === 'details') {
      if (round.agariResults.length > 0) {
        const firstAgari = round.agariResults[0]!;
        const calloutHero = document.createElement('div');
        calloutHero.className = 'agari-callout-hero';

        const calloutType = document.createElement('div');
        calloutType.className = 'agari-callout-type';
        calloutType.textContent =
          firstAgari.winType === 'tsumo'
            ? 'TSUMO'
            : round.agariResults.length >= 2
              ? 'DOUBLE RON'
              : 'RON';

        const calloutMain = document.createElement('div');
        calloutMain.className = 'agari-callout-main';
        const firstWinner = view.players.find(
          (p) => p.playerId === firstAgari.playerId,
        );
        const heroTitle = document.createElement('div');
        heroTitle.className = 'agari-callout-winner';
        heroTitle.textContent =
          round.agariResults.length >= 2
            ? round.agariResults
                .map(
                  (a) =>
                    view.players.find((p) => p.playerId === a.playerId)?.name ??
                    a.playerId,
                )
                .join(' ・ ')
            : `${firstWinner?.name ?? firstAgari.playerId} の${firstAgari.winType === 'tsumo' ? 'ツモ和了' : 'ロン和了'}`;

        const heroPoints = document.createElement('div');
        heroPoints.className = 'agari-callout-points';
        const totalAwarded = round.agariResults.reduce(
          (sum, a) => sum + a.pointsAwarded + a.honbaPointsAwarded,
          0,
        );
        heroPoints.textContent = firstAgari.isYakuman
          ? `${firstAgari.scoreLabel}  ${totalAwarded.toLocaleString()}点`
          : `${firstAgari.han}翻 ${firstAgari.fu}符  ${firstAgari.scoreLabel}  ${totalAwarded.toLocaleString()}点`;

        calloutMain.append(heroTitle, heroPoints);
        calloutHero.append(calloutType, calloutMain);
        overlay.appendChild(calloutHero);

        const cardsWrap = document.createElement('div');
        cardsWrap.className = 'agari-cards-list';
        for (const agari of round.agariResults) {
          cardsWrap.appendChild(
            renderAgariWinnerCard(agari, view.players, round.dealerIndex),
          );
        }
        overlay.appendChild(cardsWrap);

        if (round.uraDoraIndicators.length > 0) {
          const uraBox = document.createElement('div');
          uraBox.className = 'ura-dora-box';
          const uraLabel = document.createElement('span');
          uraLabel.className = 'hub-sub';
          uraLabel.textContent = '裏ドラ表示牌:';
          const uraRow = document.createElement('div');
          uraRow.className = 'dora-tiles-row';
          for (const indicator of round.uraDoraIndicators) {
            uraRow.appendChild(createTileElement(indicator, { small: true }));
          }
          uraBox.append(uraLabel, uraRow);
          overlay.appendChild(uraBox);
        }
      } else if (round.ronWinners.length > 0) {
        const winnerList = document.createElement('div');
        winnerList.className = 'ron-winners-list';

        for (const winner of round.ronWinners) {
          const winnerPlayer = view.players.find(
            (p) => p.playerId === winner.playerId,
          );
          const loserPlayer = view.players.find(
            (p) => p.seatIndex === winner.fromSeatIndex,
          );
          const item = document.createElement('div');
          item.className = 'ron-winner-item';

          const text = document.createElement('span');
          text.textContent = `${winnerPlayer?.name ?? winner.playerId}（${loserPlayer?.name ?? ''} からロン）`;

          item.append(text, createTileElement(winner.winningTile, { small: true }));
          winnerList.appendChild(item);
        }
        overlay.appendChild(winnerList);
      } else if (round.abortiveDrawReason) {
        const meta = ABORTIVE_DRAW_META[round.abortiveDrawReason];
        const abortDesc = document.createElement('div');
        abortDesc.className = 'progression-reason-note';
        abortDesc.textContent = meta.description;
        overlay.appendChild(abortDesc);

        if (
          round.abortiveDrawReason === 'kyuushu_kyuuhai' &&
          round.abortiveDrawPlayerId &&
          round.revealedHands[round.abortiveDrawPlayerId]
        ) {
          const declarer = view.players.find(
            (p) => p.playerId === round.abortiveDrawPlayerId,
          );
          const revealCard = document.createElement('div');
          revealCard.className = 'agari-result-card';
          const who = document.createElement('div');
          who.className = 'agari-who';
          who.textContent = `${declarer?.name ?? round.abortiveDrawPlayerId} が九種九牌を宣言（開示手牌）`;
          const tilesRow = document.createElement('div');
          tilesRow.className = 'agari-tiles-row';
          for (const tile of round.revealedHands[round.abortiveDrawPlayerId]!) {
            tilesRow.appendChild(createTileElement(tile, { small: true }));
          }
          revealCard.append(who, tilesRow);
          overlay.appendChild(revealCard);
        }
      } else {
        const tenpaiSet = new Set(round.tenpaiPlayerIds);
        const tenpaiWrap = document.createElement('div');
        tenpaiWrap.className = 'tenpai-cards-list';

        for (const p of view.players) {
          const isTenpai = tenpaiSet.has(p.playerId);
          const isOya = p.seatIndex === round.dealerIndex;
          const delta = round.roundScoreDeltas[p.playerId] ?? 0;
          const deltaStr =
            delta > 0
              ? `+${delta.toLocaleString()}点`
              : delta < 0
                ? `${delta.toLocaleString()}点`
                : '±0点';

          const card = document.createElement('div');
          card.className = 'agari-result-card';

          const header = document.createElement('div');
          header.className = 'agari-header';

          const who = document.createElement('div');
          who.className = 'agari-who';
          who.textContent = `${p.name}（${isOya ? '親' : '子'}）`;

          const statusGroup = document.createElement('div');
          statusGroup.style.display = 'flex';
          statusGroup.style.alignItems = 'center';
          statusGroup.style.gap = '8px';

          const badge = document.createElement('span');
          badge.className = isTenpai ? 'tenpai-badge' : 'noten-badge';
          badge.textContent = isTenpai ? 'テンパイ' : 'ノーテン';

          const deltaSpan = document.createElement('span');
          deltaSpan.className =
            delta > 0 ? 'delta-pos' : delta < 0 ? 'delta-neg' : 'hub-sub';
          deltaSpan.textContent = deltaStr;

          statusGroup.append(badge, deltaSpan);
          header.append(who, statusGroup);
          card.appendChild(header);

          const revealed = round.revealedHands[p.playerId];
          if (isTenpai && revealed) {
            const tilesRow = document.createElement('div');
            tilesRow.className = 'agari-tiles-row';
            for (const tile of revealed) {
              tilesRow.appendChild(createTileElement(tile, { small: true }));
            }
            for (const meld of p.melds) {
              tilesRow.appendChild(
                renderMeldGroup(meld, { ankanHidden: true, small: true }),
              );
            }
            if (p.kitaTiles.length > 0) {
              tilesRow.appendChild(renderKitaGroup(p.kitaTiles, true));
            }
            card.appendChild(tilesRow);
          } else {
            const hiddenNote = document.createElement('div');
            hiddenNote.className = 'hub-sub';
            hiddenNote.textContent = '手牌非公開';
            card.appendChild(hiddenNote);
          }

          tenpaiWrap.appendChild(card);
        }
        overlay.appendChild(tenpaiWrap);
      }

      const toScoresBtn = document.createElement('button');
      toScoresBtn.type = 'button';
      toScoresBtn.className = 'btn btn-primary round-result-next-btn';
      toScoresBtn.textContent = '次へ';
      toScoresBtn.addEventListener('click', () => setStep('scores'));
      overlay.appendChild(toScoresBtn);
      return;
    }

    // Step 2: 点数の移行表示（供託・次局案内・スコア増減テーブル・次局へボタン）
    const scoresWrap = document.createElement('div');
    scoresWrap.className = 'round-score-transition';

    if (round.agariResults.length > 0) {
      if (round.kyotakuPointsAwarded > 0 && round.kyotakuWinnerPlayerId) {
        const kWinner = view.players.find(
          (p) => p.playerId === round.kyotakuWinnerPlayerId,
        );
        const kyotakuNote = document.createElement('div');
        kyotakuNote.className = 'kyotaku-award-note';
        kyotakuNote.textContent = `供託リーチ棒受取: ${kWinner?.name ?? round.kyotakuWinnerPlayerId} (+${round.kyotakuPointsAwarded.toLocaleString()}点)`;
        scoresWrap.appendChild(kyotakuNote);
      }
    } else if (view.kyotakuCount > 0) {
      const rules = deriveRules(view.ruleConfig);
      const kyotakuNote = document.createElement('div');
      kyotakuNote.className = 'kyotaku-award-note';
      kyotakuNote.textContent =
        !round.abortiveDrawReason && isGameClosing
          ? `供託リーチ棒 ${view.kyotakuCount}本（${(view.kyotakuCount * rules.riichiStickPoints).toLocaleString()}点）は終局時の最終トップに加算されます。`
          : `供託リーチ棒 ${view.kyotakuCount}本（${(view.kyotakuCount * rules.riichiStickPoints).toLocaleString()}点）は次局へ持ち越されます。`;
      scoresWrap.appendChild(kyotakuNote);
    }

    const desc = document.createElement('div');
    desc.className = 'progression-reason-note';
    desc.textContent = formatNextRoundDescription(view, round);
    scoresWrap.appendChild(desc);

    scoresWrap.appendChild(
      buildScoreTable(
        view.players,
        false,
        round.roundScoreDeltas,
        view.initialDealerIndex,
      ),
    );
    overlay.appendChild(scoresWrap);

    if (isHost) {
      const nextBtn = document.createElement('button');
      nextBtn.type = 'button';
      nextBtn.className = 'btn btn-primary';
      nextBtn.textContent = isGameClosing ? '結果を見る' : '次の局へ';
      nextBtn.addEventListener('click', handlers.onAdvanceRound);
      overlay.appendChild(nextBtn);
    } else {
      const waitMsg = document.createElement('div');
      waitMsg.className = 'hub-sub';
      waitMsg.textContent = 'ホストが次へ進めるのを待っています...';
      overlay.appendChild(waitMsg);
    }
  };

  renderStepBody(currentStep);

  const backdrop = document.createElement('div');
  backdrop.className = `overlay-backdrop overlay-backdrop-modal${
    hasAgariResults ? ' is-agari-backdrop' : ''
  }${isFreshAgariReveal ? ' is-agari-flash' : ''}`;
  backdrop.appendChild(overlay);
  container.appendChild(backdrop);
}

const MELD_SLIDE_VECTOR: Record<SeatSide, { x: string; y: string }> = {
  self: { x: '-72px', y: '28px' },
  top: { x: '72px', y: '-28px' },
  left: { x: '-28px', y: '-72px' },
  right: { x: '28px', y: '72px' },
};

function renderMeldGroup(
  meld: Meld,
  options: {
    ankanHidden?: boolean;
    small?: boolean;
    animateMeld?: boolean;
    side?: SeatSide;
  } = {},
): HTMLElement {
  const small = options.small ?? true;
  const group = document.createElement('div');
  group.className = `meld-group${options.animateMeld ? ' is-meld-anim' : ''}`;
  if (options.animateMeld) {
    const vec = MELD_SLIDE_VECTOR[options.side ?? 'self'];
    group.style.setProperty('--meld-slide-x', vec.x);
    group.style.setProperty('--meld-slide-y', vec.y);
  }

  const label = document.createElement('span');
  label.className = 'meld-label';
  label.textContent = MELD_TYPE_LABELS[meld.type];
  group.appendChild(label);

  const tiles = document.createElement('div');
  tiles.className = 'meld-tiles';

  if (meld.type === 'ankan' && meld.tiles.length === 4 && options.ankanHidden) {
    tiles.appendChild(createTileBackElement(small, true));
    tiles.appendChild(createTileElement(meld.tiles[1]!, { small }));
    tiles.appendChild(createTileElement(meld.tiles[2]!, { small }));
    tiles.appendChild(createTileBackElement(small, true));
  } else {
    for (const tile of meld.tiles) {
      const isCalled =
        meld.calledTile?.id === tile.id || meld.addedTile?.id === tile.id;
      tiles.appendChild(createTileElement(tile, { small, called: isCalled }));
    }
  }

  group.appendChild(tiles);
  return group;
}

function renderKitaGroup(
  kitaTiles: readonly { id: string; kind: TileKind }[],
  small = true,
  animateKita = false,
  side: SeatSide = 'self',
): HTMLElement {
  const group = document.createElement('div');
  group.className = `meld-group meld-group-kita${
    animateKita ? ' is-meld-anim' : ''
  }`;
  if (animateKita) {
    const vec = MELD_SLIDE_VECTOR[side];
    group.style.setProperty('--meld-slide-x', vec.x);
    group.style.setProperty('--meld-slide-y', vec.y);
  }

  const label = document.createElement('span');
  label.className = 'meld-label';
  label.textContent = `抜北 ×${kitaTiles.length}`;
  group.appendChild(label);

  const tiles = document.createElement('div');
  tiles.className = 'meld-tiles';
  for (const tile of kitaTiles) {
    tiles.appendChild(
      createTileElement({ ...tile, isRed: false }, { small }),
    );
  }
  group.appendChild(tiles);
  return group;
}

function renderAgariWinnerCard(
  agari: RoundAgariWinner,
  players: readonly PublicPlayerView[],
  dealerIndex: number,
): HTMLElement {
  const card = document.createElement('div');
  card.className = 'agari-result-card';

  const winnerPlayer = players.find((p) => p.playerId === agari.playerId);
  const loserPlayer =
    agari.fromSeatIndex !== null
      ? players.find((p) => p.seatIndex === agari.fromSeatIndex)
      : undefined;
  const isOya = agari.seatIndex === dealerIndex;

  const header = document.createElement('div');
  header.className = 'agari-header';

  const who = document.createElement('div');
  who.className = 'agari-who';
  const winSourceText =
    agari.winType === 'tsumo'
      ? 'ツモ和了'
      : `${loserPlayer?.name ?? ''} からロン`;
  who.textContent = `${winnerPlayer?.name ?? agari.playerId}（${isOya ? '親' : '子'}）— ${winSourceText}`;

  const scoreBadge = document.createElement('div');
  scoreBadge.className = 'agari-score-badge';
  scoreBadge.textContent =
    agari.honbaPointsAwarded > 0
      ? `${agari.scoreLabel} / ${agari.pointsAwarded.toLocaleString()}点 (+本場 ${agari.honbaPointsAwarded.toLocaleString()}点)`
      : `${agari.scoreLabel} / ${agari.pointsAwarded.toLocaleString()}点`;

  header.append(who, scoreBadge);
  card.appendChild(header);

  // 和了者の手牌＋和了牌＋副露＋抜北公開
  const tilesRow = document.createElement('div');
  tilesRow.className = 'agari-tiles-row';

  for (const tile of agari.hand) {
    tilesRow.appendChild(createTileElement(tile, { small: true }));
  }

  const winGap = document.createElement('div');
  winGap.className = 'drawn-gap';
  tilesRow.appendChild(winGap);

  tilesRow.appendChild(
    createTileElement(agari.winningTile, { small: true, called: true }),
  );

  for (const meld of agari.melds) {
    tilesRow.appendChild(
      renderMeldGroup(meld, { ankanHidden: true, small: true }),
    );
  }

  if (agari.kitaTiles.length > 0) {
    tilesRow.appendChild(renderKitaGroup(agari.kitaTiles, true));
  }

  card.appendChild(tilesRow);

  // 役一覧・ドラ・符翻サマリー
  const yakuList = document.createElement('div');
  yakuList.className = 'yaku-list';

  for (const y of agari.yaku) {
    const chip = document.createElement('span');
    chip.className = `yaku-chip${y.isYakuman ? ' is-yakuman' : ''}`;
    chip.textContent = y.isYakuman
      ? (y.yakumanMultiplier ?? 1) >= 2
        ? `${y.name} ダブル役満`
        : `${y.name} 役満`
      : `${y.name} ${y.han}翻`;
    yakuList.appendChild(chip);
  }

  if (!agari.isYakuman && agari.doraCount > 0) {
    const doraChip = document.createElement('span');
    doraChip.className = 'yaku-chip is-dora';
    doraChip.textContent = `ドラ ${agari.doraCount}翻`;
    yakuList.appendChild(doraChip);
  }

  if (!agari.isYakuman && agari.uraDoraCount > 0) {
    const uraChip = document.createElement('span');
    uraChip.className = 'yaku-chip is-dora';
    uraChip.textContent = `裏ドラ ${agari.uraDoraCount}翻`;
    yakuList.appendChild(uraChip);
  }

  if (!agari.isYakuman && agari.kitaCount > 0) {
    const kitaChip = document.createElement('span');
    kitaChip.className = 'yaku-chip is-dora';
    kitaChip.textContent = `抜北 ${agari.kitaCount}翻`;
    yakuList.appendChild(kitaChip);
  }

  card.appendChild(yakuList);

  const summary = document.createElement('div');
  summary.className = 'hub-sub';
  const totalWithHonba = agari.pointsAwarded + agari.honbaPointsAwarded;
  const honbaDetail =
    agari.honbaPointsAwarded > 0
      ? ` + 本場 ${agari.honbaPointsAwarded.toLocaleString()}点 = 計 ${totalWithHonba.toLocaleString()}点`
      : '';
  summary.textContent = agari.isYakuman
    ? `${agari.scoreLabel}（${agari.pointsAwarded.toLocaleString()}点${honbaDetail}）`
    : `${agari.han}翻 ${agari.fu}符 — ${agari.scoreLabel}（${agari.pointsAwarded.toLocaleString()}点${honbaDetail}）`;
  card.appendChild(summary);

  return card;
}

/**
 * 卓の左上に固定するドラ表示パネル（雀魂準拠）。
 * ドラ表示牌 5 枠 + リーチ棒・本場棒の集計 + 対局モード表記をコンパクトにまとめる。
 */
function renderDoraPanel(
  view: StateView,
  newlyRevealedDoraIndices?: Set<number>,
): HTMLElement | null {
  const round = view.round;
  if (!round) return null;
  const rules = deriveRules(view.ruleConfig);

  const panel = document.createElement('div');
  panel.className = 'dora-panel';
  panel.setAttribute('aria-label', 'ドラ表示');

  const box = document.createElement('div');
  box.className = 'dora-panel-box';

  const tiles = document.createElement('div');
  tiles.className = 'dora-panel-tiles';
  for (let i = 0; i < rules.doraIndicatorCount; i++) {
    const indicator = round.doraIndicators[i];
    if (indicator) {
      const tileEl = createTileElement(indicator, { small: true });
      if (newlyRevealedDoraIndices?.has(i)) {
        tileEl.classList.add('dora-tile-flip');
      }
      tiles.appendChild(tileEl);
    } else {
      const back = createTileBackElement(true, true);
      back.classList.add('dora-slot-back');
      tiles.appendChild(back);
    }
  }

  const sticks = document.createElement('div');
  sticks.className = 'dora-panel-sticks';

  const kyotakuItem = document.createElement('span');
  kyotakuItem.className = 'dora-stick-item';
  kyotakuItem.title = `供託リーチ棒 ${view.kyotakuCount}本 (${(view.kyotakuCount * rules.riichiStickPoints).toLocaleString()}点)`;
  kyotakuItem.innerHTML = `<span class="stick-icon stick-riichi" aria-hidden="true"></span><span>× ${view.kyotakuCount}</span>`;

  const honbaItem = document.createElement('span');
  honbaItem.className = 'dora-stick-item';
  honbaItem.title = `本場 ${round.honba}本場`;
  honbaItem.innerHTML = `<span class="stick-icon stick-honba" aria-hidden="true"></span><span>× ${round.honba}</span>`;

  sticks.append(kyotakuItem, honbaItem);

  if (round.kanCount > 0) {
    const kanTag = document.createElement('span');
    kanTag.className = 'dora-kan-tag';
    kanTag.textContent = `槓${round.kanCount}/${rules.maxKansPerRound}`;
    sticks.appendChild(kanTag);
  }

  box.append(tiles, sticks);

  const mode = document.createElement('div');
  mode.className = 'dora-panel-mode';
  const lengthJa = view.ruleConfig.gameLength === 'tonpuu' ? '東風戦' : '半荘戦';
  const roomLabel = formatRoomDisplayName(view.roomCode);
  const connectedSpecCount = (view.spectators ?? []).filter(
    (s) => s.connected,
  ).length;
  mode.textContent =
    connectedSpecCount > 0
      ? `${view.ruleConfig.playerCount}人${lengthJa}・${roomLabel}（観戦${connectedSpecCount}）`
      : `${view.ruleConfig.playerCount}人${lengthJa}・${roomLabel}`;

  panel.append(box, mode);

  if (!rules.honbaBonus && round.honba > 0) {
    const honbaNote = document.createElement('div');
    honbaNote.className = 'honba-note';
    honbaNote.textContent = '本場加算なし';
    panel.appendChild(honbaNote);
  }

  return panel;
}

/** 卓の右上に置く操作ボタン（チャット・設定・退出） */
function renderTableChrome(
  handlers: TableHandlers,
  uiState: TableUiState,
): HTMLElement {
  const bar = document.createElement('div');
  bar.className = 'table-chrome';

  const unread = uiState.unreadChatCount ?? 0;
  const chatBtn = document.createElement('button');
  chatBtn.type = 'button';
  chatBtn.className = `table-chrome-btn table-chrome-chat${unread > 0 ? ' has-unread' : ''}`;
  chatBtn.title = 'チャットを開く';
  chatBtn.textContent = 'チャット';
  if (unread > 0) {
    const badge = document.createElement('span');
    badge.className = 'chat-unread-badge';
    badge.textContent = unread > 9 ? '9+' : String(unread);
    chatBtn.appendChild(badge);
  }
  chatBtn.addEventListener('click', () => handlers.onOpenChat?.());
  bar.appendChild(chatBtn);

  const settingsBtn = document.createElement('button');
  settingsBtn.type = 'button';
  settingsBtn.className = 'table-chrome-btn table-chrome-settings';
  settingsBtn.textContent = '設定';
  settingsBtn.title = '表示設定を開く';
  settingsBtn.addEventListener('click', () => handlers.onOpenSettings?.());
  bar.appendChild(settingsBtn);

  if (handlers.canLeaveGame && handlers.onLeaveGame) {
    const leave = document.createElement('button');
    leave.type = 'button';
    leave.className = 'table-chrome-btn table-chrome-leave';
    leave.textContent = '退出';
    leave.title = '対局を離れてロビーに戻る';
    leave.addEventListener('click', () => handlers.onLeaveGame?.());
    bar.appendChild(leave);
  }

  return bar;
}

/** 卓の左端に置く縦型クイック補助バー（理 / 和 / 鳴 / 切） */
function renderLeftActionBar(
  handlers: TableHandlers,
  uiState: TableUiState,
): HTMLElement {
  const bar = document.createElement('div');
  bar.className = 'table-left-actions';

  const makeTab = (
    char: string,
    title: string,
    active: boolean,
    onClick?: () => void,
  ): HTMLButtonElement => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `left-action-tab${active ? ' is-active' : ''}`;
    btn.textContent = char;
    btn.title = title;
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    if (onClick) {
      btn.addEventListener('click', onClick);
    }
    return btn;
  };

  bar.append(
    makeTab('理', '自動理牌（有効）', true),
    makeTab(
      '和',
      '自動和了（ONでツモ・ロンを自動実行）',
      Boolean(uiState.autoAgariEnabled),
      () => handlers.onToggleAutoAgari?.(!uiState.autoAgariEnabled),
    ),
    makeTab(
      '鳴',
      '鳴き無し（ONでポン・チー・カンを自動パス）',
      Boolean(uiState.autoNoCallEnabled),
      () => handlers.onToggleAutoNoCall?.(!uiState.autoNoCallEnabled),
    ),
    makeTab(
      '切',
      'リーチ後ツモ切り（ONで自動ツモ切り）',
      uiState.autoTsumogiriEnabled,
      () => handlers.onToggleAutoTsumogiri?.(!uiState.autoTsumogiriEnabled),
    ),
  );

  return bar;
}

function getSeatPlayersMap(view: StateView): Map<SeatSide, PublicPlayerView> {
  const playerCount = view.players.length;
  const bySide = new Map<SeatSide, PublicPlayerView>();
  const selfPlayer = view.players.find((p) => p.seatIndex === view.viewerSeatIndex);
  if (selfPlayer) bySide.set('self', selfPlayer);
  const right = view.players.find(
    (p) => p.seatIndex === (view.viewerSeatIndex + 1) % playerCount,
  );
  if (right) bySide.set('right', right);
  const leftSide =
    view.players.find(
      (p) =>
        p.seatIndex ===
        (view.viewerSeatIndex + (playerCount === 4 ? 3 : 2)) % playerCount,
    ) ?? undefined;
  if (leftSide) bySide.set('left', leftSide);
  if (playerCount === 4) {
    const top = view.players.find(
      (p) => p.seatIndex === (view.viewerSeatIndex + 2) % playerCount,
    );
    if (top) bySide.set('top', top);
  }
  return bySide;
}

function renderCenterHub(
  view: StateView,
  diff?: RenderDiffSummary,
): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'seat-center';

  const hub = document.createElement('div');
  hub.className = 'center-hub';

  const round = view.round;
  const bySide = getSeatPlayersMap(view);

  hub.appendChild(renderCompass(view, bySide));

  const scoresLayer = document.createElement('div');
  scoresLayer.className = 'console-scores';
  for (const side of ['top', 'right', 'self', 'left'] as const) {
    const player = bySide.get(side);
    const cell = document.createElement('div');
    cell.className = `console-score console-score-${side}${
      player?.isCurrentTurn ? ' is-turn' : ''
    }${player?.isRiichi ? ' is-riichi' : ''}${!player ? ' is-empty' : ''}`;
    if (player) {
      const val = document.createElement('span');
      val.className = 'console-score-val';
      const deltaInfo = diff?.scoreDeltasBySide.get(side);
      if (deltaInfo && deltaInfo.prevScore !== deltaInfo.nextScore) {
        animateNumericCounter(val, deltaInfo.prevScore, deltaInfo.nextScore);
        const deltaNum = deltaInfo.nextScore - deltaInfo.prevScore;
        const deltaEl = document.createElement('span');
        deltaEl.className = `console-score-delta ${
          deltaNum > 0 ? 'is-pos' : 'is-neg'
        }`;
        deltaEl.textContent =
          deltaNum > 0
            ? `+${deltaNum.toLocaleString()}`
            : deltaNum.toLocaleString();
        cell.appendChild(deltaEl);
      } else {
        val.textContent = String(player.score);
      }
      cell.appendChild(val);

      if (player.isRiichi) {
        const stick = document.createElement('span');
        stick.className = `console-riichi-stick${
          diff?.newlyRiichiSides.has(side) ? ' is-riichi-stick-placed' : ''
        }`;
        stick.setAttribute('aria-label', 'リーチ棒');
        cell.appendChild(stick);
      }
    }
    scoresLayer.appendChild(cell);
  }
  hub.appendChild(scoresLayer);

  const core = document.createElement('div');
  core.className = 'console-core';

  const roundLabel = document.createElement('div');
  roundLabel.className = 'round-label';
  roundLabel.textContent = round
    ? formatRoundName(round.roundWind, round.kyokuNumber)
    : '対局';

  const wallCounter = document.createElement('div');
  wallCounter.className = 'wall-counter';
  wallCounter.textContent = round ? `余 ${round.remainingWallCount}` : '';

  core.append(roundLabel, wallCounter);

  if (round) {
    const dealer = view.players.find((p) => p.seatIndex === round.dealerIndex);
    const metaRow = document.createElement('div');
    metaRow.className = 'console-meta-row';

    if (dealer) {
      const oyaPill = document.createElement('span');
      oyaPill.className = 'console-meta-pill console-oya-pill';
      oyaPill.title = `親: ${dealer.name}`;
      oyaPill.textContent = `親 ${dealer.name}`;
      metaRow.appendChild(oyaPill);
    }

    const sticksMeta = document.createElement('div');
    sticksMeta.className = 'console-sticks-meta';

    const honbaTag = document.createElement('span');
    honbaTag.className = `console-honba${round.honba > 0 ? ' is-active' : ''}`;
    honbaTag.textContent = `${round.honba}本`;

    const kyotakuTag = document.createElement('span');
    kyotakuTag.className = `console-kyotaku${
      view.kyotakuCount > 0 ? ' is-active' : ''
    }`;
    kyotakuTag.title = `供託 ${view.kyotakuCount}本`;
    kyotakuTag.innerHTML = `<span class="stick-icon stick-riichi" aria-hidden="true"></span><span>${view.kyotakuCount}</span>`;

    sticksMeta.append(honbaTag, kyotakuTag);
    metaRow.appendChild(sticksMeta);
    core.appendChild(metaRow);
  }

  hub.appendChild(core);
  wrap.appendChild(hub);
  return wrap;
}

/**
 * 卓の中央に置く方位表示（四隅の自風＋手番＋リーチ表示）。
 */
function renderCompass(
  view: StateView,
  bySide: Map<SeatSide, PublicPlayerView> = getSeatPlayersMap(view),
): HTMLElement {
  const ring = document.createElement('div');
  ring.className = 'table-compass';

  const positions: Array<{ side: SeatSide; label: string }> = [
    { side: 'top', label: '対面' },
    { side: 'right', label: '下家' },
    { side: 'left', label: '上家' },
    { side: 'self', label: '自分' },
  ];

  for (const { side } of positions) {
    const player = bySide.get(side);
    const slot = document.createElement('div');
    slot.className = `compass-slot compass-${side}${
      player?.isCurrentTurn ? ' is-turn' : ''
    }`;
    if (!player) {
      slot.classList.add('is-empty');
      ring.appendChild(slot);
      continue;
    }
    if (player.seatWind) {
      const wind = document.createElement('span');
      wind.className = `compass-wind${player.isDealer ? ' is-dealer' : ''}`;
      wind.textContent = windToJa(player.seatWind);
      slot.appendChild(wind);
    }
    if (player.isRiichi) {
      const riichi = document.createElement('span');
      riichi.className = 'compass-riichi';
      riichi.textContent = 'リーチ';
      slot.appendChild(riichi);
    }
    ring.appendChild(slot);
  }

  return ring;
}

function createSeatAvatar(
  player: PublicPlayerView,
  isSelf: boolean,
): HTMLElement {
  const frame = document.createElement('div');
  frame.className = `seat-avatar${isSelf ? ' is-self' : ''}${
    player.isCurrentTurn ? ' is-turn' : ''
  }`;
  frame.setAttribute('aria-hidden', 'true');

  const palettes: Record<string, { bg1: string; bg2: string; accent: string }> = {
    E: { bg1: '#5d1c24', bg2: '#2d0c12', accent: '#f3cb68' },
    S: { bg1: '#1b4d40', bg2: '#0d2620', accent: '#7ce8b8' },
    W: { bg1: '#1d3a68', bg2: '#0d1b36', accent: '#82c5ff' },
    N: { bg1: '#3d255e', bg2: '#1b102d', accent: '#d8b4fe' },
  };
  const pal = palettes[player.seatWind ?? 'E'] ?? palettes.E!;
  const initial = Array.from(player.name.trim())[0] ?? (isSelf ? '自' : '家');

  frame.innerHTML = `<svg viewBox="0 0 40 40" class="seat-avatar-svg"><defs><linearGradient id="av-${player.seatIndex}" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="${pal.bg1}"/><stop offset="100%" stop-color="${pal.bg2}"/></linearGradient></defs><rect width="40" height="40" rx="4" fill="url(#av-${player.seatIndex})"/><circle cx="20" cy="16" r="7.5" fill="${pal.accent}" fill-opacity="0.26" stroke="${pal.accent}" stroke-width="1.2"/><path d="M9 36c1.5-6.5 6-10 11-10s9.5 3.5 11 10" fill="${pal.accent}" fill-opacity="0.24" stroke="${pal.accent}" stroke-width="1.1"/><text x="20" y="20" text-anchor="middle" font-size="11" font-weight="800" fill="#f7f4ea">${escapeSvgText(initial)}</text></svg>`;

  return frame;
}

function escapeSvgText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function renderSeatHeader(
  player: PublicPlayerView,
  isSelf: boolean,
  isSelfFuriten = false,
  rank?: number,
  isSelfTurnGlow = false,
  chatBubble?: SeatChatBubble,
): HTMLElement {
  const header = document.createElement('div');
  header.className = `seat-header${player.isCurrentTurn ? ' is-turn' : ''}${
    isSelf && isSelfTurnGlow ? ' is-self-turn' : ''
  }${chatBubble ? ' has-chat-bubble' : ''}`;

  const cardTop = document.createElement('div');
  cardTop.className = 'seat-card-top';
  cardTop.appendChild(createSeatAvatar(player, isSelf));
  if (chatBubble) {
    const bubble = document.createElement('div');
    bubble.className = `seat-chat-bubble${chatBubble.animate ? ' is-bubble-enter' : ''}${
      isSelf ? ' is-self' : ''
    }`;
    bubble.dataset.bubbleId = chatBubble.messageId;
    bubble.dataset.senderId = chatBubble.senderId;
    bubble.setAttribute('role', 'status');
    bubble.setAttribute(
      'aria-label',
      `${chatBubble.senderName}: ${chatBubble.text}`,
    );

    const textEl = document.createElement('span');
    textEl.className = 'seat-chat-bubble-text';
    textEl.textContent = chatBubble.text;
    bubble.appendChild(textEl);
    cardTop.appendChild(bubble);
  }

  const info = document.createElement('div');
  info.className = 'seat-card-info';

  const nameSpan = document.createElement('div');
  nameSpan.className = 'seat-name';
  nameSpan.textContent = isSelf ? `${player.name}（あなた）` : player.name;

  const identity = document.createElement('div');
  identity.className = 'seat-identity';

  if (rank !== undefined) {
    const rankBadge = document.createElement('span');
    rankBadge.className = `seat-rank-badge rank-${rank}`;
    rankBadge.textContent = `${rank}位`;
    identity.appendChild(rankBadge);
  }

  if (isCpuPlayerId(player.playerId)) {
    const cpuBadge = document.createElement('span');
    cpuBadge.className = 'cpu-badge';
    cpuBadge.textContent = 'CPU';
    identity.appendChild(cpuBadge);
  }

  if (player.isDealer) {
    const oya = document.createElement('span');
    oya.className = 'oya-tag';
    oya.textContent = '親';
    identity.appendChild(oya);
  }

  if (player.isDoubleRiichi || player.isRiichi) {
    const riichiTag = document.createElement('span');
    riichiTag.className = 'riichi-badge';
    riichiTag.textContent = player.isDoubleRiichi ? 'Wリーチ' : 'リーチ';
    identity.appendChild(riichiTag);
  }

  if (player.kitaTiles.length > 0) {
    const kitaBadge = document.createElement('span');
    kitaBadge.className = 'kita-badge';
    kitaBadge.title = `抜北 ${player.kitaTiles.length}枚`;
    kitaBadge.setAttribute('aria-label', `抜北 ${player.kitaTiles.length}枚`);
    kitaBadge.textContent = `北×${player.kitaTiles.length}`;
    identity.appendChild(kitaBadge);
  }

  if (player.isCurrentTurn) {
    const turn = document.createElement('span');
    turn.className = 'turn-tag';
    turn.textContent = '手番';
    identity.appendChild(turn);
  }

  if (isSelf && isSelfFuriten) {
    const furiten = document.createElement('span');
    furiten.className = 'furiten-badge';
    furiten.textContent = 'フリテン（ロン不可）';
    identity.appendChild(furiten);
  }

  if (!player.connected) {
    const dc = document.createElement('span');
    dc.className = 'disconnect-tag';
    dc.textContent = '切断';
    identity.appendChild(dc);
  }

  info.appendChild(nameSpan);
  if (identity.childElementCount > 0) {
    info.appendChild(identity);
  }
  header.append(cardTop, info);
  return header;
}

/**
 * 河（捨て牌）を再現する。
 * 実物の麻雀と同じく、中央のデジタル盤の周囲に各席の河を6枚折り返しで配置する。
 */
function renderDiscardRiver(
  player: PublicPlayerView,
  options: {
    side?: SeatSide;
    limit?: number;
    latestOnly?: boolean;
    compact?: boolean;
    label?: string | null;
  } = {},
): HTMLElement {
  const side = options.side ?? 'self';
  const wrap = document.createElement('div');
  wrap.className = `river-zone river-${side}`;
  wrap.dataset.seat = side;

  if (options.label) {
    const label = document.createElement('span');
    label.className = 'river-label';
    label.textContent = options.label;
    wrap.appendChild(label);
  }

  const river = document.createElement('div');
  const hasRiichiTile = player.discards.some((entry) =>
    Boolean(entry.isRiichiDeclaration),
  );
  river.className = `discard-river river-${side} river-rows-6${
    options.compact ? ' is-compact' : ''
  }${hasRiichiTile ? ' has-riichi-tile' : ''}`;

  const limit = options.limit ?? player.discards.length;
  const start =
    options.latestOnly && player.discards.length > limit
      ? Math.max(0, player.discards.length - limit)
      : 0;
  const visible = player.discards.slice(start);
  const lastIndex = player.discards.length - 1;

  if (visible.length === 0) {
    const empty = document.createElement('span');
    empty.className = 'river-empty';
    empty.setAttribute('aria-hidden', 'true');
    river.appendChild(empty);
  }

  visible.forEach((entry, idx) => {
    const absoluteIndex = start + idx;
    const isLatest = absoluteIndex === lastIndex;
    river.appendChild(
      createTileElement(entry.tile, {
        small: true,
        tsumogiri: entry.isTsumogiri,
        latestDiscard: isLatest,
        riichiDeclaration: Boolean(entry.isRiichiDeclaration),
      }),
    );
  });

  wrap.appendChild(river);
  return wrap;
}

function renderMeldsAndKita(
  player: PublicPlayerView,
  side: SeatSide = 'self',
  newlyMeldedIndices?: Set<number>,
  newlyAddedKita = false,
): HTMLElement | null {
  if (player.melds.length === 0 && player.kitaTiles.length === 0) {
    return null;
  }

  const row = document.createElement('div');
  row.className = `meld-kita-row meld-orient-${side}`;

  player.melds.forEach((meld, idx) => {
    row.appendChild(
      renderMeldGroup(meld, {
        ankanHidden: true,
        small: true,
        animateMeld: newlyMeldedIndices?.has(idx) ?? false,
        side,
      }),
    );
  });

  if (player.kitaTiles.length > 0) {
    row.appendChild(renderKitaGroup(player.kitaTiles, true, newlyAddedKita, side));
  }

  return row;
}

function renderOpponentSeat(
  side: Exclude<SeatSide, 'self'>,
  player: PublicPlayerView,
  _view: StateView,
  rank?: number,
  newlyMeldedIndices?: Set<number>,
  newlyAddedKita = false,
  chatBubble?: SeatChatBubble,
): HTMLElement {
  const box = document.createElement('div');
  box.className = `seat-box ${SEAT_CLASS[side]} seat-orient-${side}${
    player.isCurrentTurn ? ' is-turn' : ''
  }`;
  box.dataset.seat = side;

  // 席情報（名前・自風・持ち点）は卓の外周側に置く
  box.appendChild(
    renderSeatHeader(player, false, false, rank, false, chatBubble),
  );

  // 外周（手牌）→ 副露 → 中央（河）の順に並べる入れ物
  const body = document.createElement('div');
  body.className = `seat-body seat-body-${side}`;

  // 手牌（裏向き）は卓の外周を向く。実物同様、左家は縦、対面は逆さになる。
  const handRow = document.createElement('div');
  handRow.className = `opponent-hand hand-orient-${side}`;
  for (let i = 0; i < player.handCount; i++) {
    handRow.appendChild(createTileBackElement(true));
  }
  if (player.hasDrawnTile) {
    const drawnBack = createTileBackElement(true);
    drawnBack.classList.add('opp-tile-drawn');
    handRow.appendChild(drawnBack);
  }
  body.appendChild(handRow);

  const meldsEl = renderMeldsAndKita(
    player,
    side,
    newlyMeldedIndices,
    newlyAddedKita,
  );
  if (meldsEl) {
    body.appendChild(meldsEl);
  }

  // 河は中央に向かって積まれる（全牌を表示・6枚折り返し）
  body.appendChild(renderDiscardRiver(player, { side }));

  box.appendChild(body);
  return box;
}

function createActionTilePreview(
  tiles: readonly { id: string; kind: TileKind; isRed: boolean }[],
): HTMLElement {
  const wrap = document.createElement('span');
  wrap.className = 'btn-tile-preview';
  wrap.setAttribute('aria-hidden', 'true');
  for (const tile of tiles) {
    wrap.appendChild(createTileElement(tile, { small: true }));
  }
  return wrap;
}

function renderCallResponseBar(
  view: StateView,
  handlers: TableHandlers,
): HTMLElement | null {
  const opts = view.myCallOptions;
  if (!opts) return null;

  const bar = document.createElement('div');
  bar.className = 'call-action-bar';

  const info = document.createElement('div');
  info.className = 'call-bar-info';

  const title = document.createElement('span');
  title.className = 'call-bar-title';
  title.textContent = '鳴き・ロン選択';

  const targetTileEl = createTileElement(opts.discardedTile, { small: true });

  info.append(title, targetTileEl);

  if (view.responseRemainingMs !== null) {
    const timer = document.createElement('span');
    timer.className = 'call-timer';
    const secs = Math.ceil(view.responseRemainingMs / 1000);
    timer.innerHTML = `残り <strong data-countdown-ms>${secs}</strong> 秒`;
    info.appendChild(timer);
  }

  const btns = document.createElement('div');
  btns.className = 'action-buttons-row';

  if (opts.canRon) {
    const ronBtn = document.createElement('button');
    ronBtn.type = 'button';
    ronBtn.className = 'btn btn-ron btn-with-tiles';
    const textSpan = document.createElement('span');
    textSpan.textContent = 'ロン';
    ronBtn.append(textSpan, createActionTilePreview([opts.discardedTile]));
    ronBtn.addEventListener('click', () =>
      handlers.onCallResponse({ type: 'ron' }),
    );
    btns.appendChild(ronBtn);
  }

  if (opts.canPon) {
    const ponBtn = document.createElement('button');
    ponBtn.type = 'button';
    ponBtn.className = 'btn btn-call btn-with-tiles';
    const textSpan = document.createElement('span');
    textSpan.textContent = `ポン (${formatTileLabel(opts.discardedTile.kind)})`;
    ponBtn.append(textSpan, createActionTilePreview([opts.discardedTile]));
    ponBtn.addEventListener('click', () =>
      handlers.onCallResponse({ type: 'pon' }),
    );
    btns.appendChild(ponBtn);
  }

  if (opts.canDaiminkan) {
    const kanBtn = document.createElement('button');
    kanBtn.type = 'button';
    kanBtn.className = 'btn btn-call btn-with-tiles';
    const textSpan = document.createElement('span');
    textSpan.textContent = `大明槓 (${formatTileLabel(opts.discardedTile.kind)})`;
    kanBtn.append(textSpan, createActionTilePreview([opts.discardedTile]));
    kanBtn.addEventListener('click', () =>
      handlers.onCallResponse({ type: 'daiminkan' }),
    );
    btns.appendChild(kanBtn);
  }

  for (const chiOpt of opts.chiOptions) {
    const [t1, t2] = chiOpt.tiles;
    const chiBtn = document.createElement('button');
    chiBtn.type = 'button';
    chiBtn.className = 'btn btn-call btn-with-tiles';
    const textSpan = document.createElement('span');
    textSpan.textContent = `チー (${formatTileLabel(t1.kind)}・${formatTileLabel(t2.kind)})`;
    chiBtn.append(textSpan, createActionTilePreview([t1, t2]));
    chiBtn.addEventListener('click', () =>
      handlers.onCallResponse({
        type: 'chi',
        tileIds: [t1.id, t2.id],
      }),
    );
    btns.appendChild(chiBtn);
  }

  const passBtn = document.createElement('button');
  passBtn.type = 'button';
  passBtn.className = 'btn btn-secondary';
  passBtn.textContent = 'スルー';
  passBtn.addEventListener('click', () =>
    handlers.onCallResponse({ type: 'pass' }),
  );
  btns.appendChild(passBtn);

  bar.append(info, btns);
  return bar;
}

function renderSelfTurnActionsBar(
  view: StateView,
  player: PublicPlayerView,
  handlers: TableHandlers,
  uiState: TableUiState,
  canDiscardNow: boolean,
): HTMLElement | null {
  if (view.phase !== 'playing') {
    return null;
  }
  const actions = canDiscardNow ? view.mySelfActions : null;
  const hasTurnAction = Boolean(
    actions &&
      (actions.canTsumo ||
        actions.canRiichiTileIds.length > 0 ||
        actions.canAnkanKinds.length > 0 ||
        actions.canKakanTileIds.length > 0 ||
        actions.canKitaTileIds.length > 0 ||
        actions.canKyuushuKyuuhai),
  );
  if (!hasTurnAction && !player.isRiichi) {
    return null;
  }

  const bar = document.createElement('div');
  bar.className = 'self-action-bar';

  const label = document.createElement('span');
  label.className = 'hub-sub';
  label.textContent =
    player.isRiichi && !hasTurnAction ? 'リーチ待機中:' : '手番アクション:';
  bar.appendChild(label);

  const btns = document.createElement('div');
  btns.className = 'action-buttons-row';

  if (actions?.canTsumo) {
    const tsumoBtn = document.createElement('button');
    tsumoBtn.type = 'button';
    tsumoBtn.className = 'btn btn-ron btn-with-tiles';
    const textSpan = document.createElement('span');
    textSpan.textContent = 'ツモ和了';
    tsumoBtn.appendChild(textSpan);
    if (view.myDrawnTile) {
      tsumoBtn.appendChild(createActionTilePreview([view.myDrawnTile]));
    }
    tsumoBtn.addEventListener('click', handlers.onDeclareTsumo);
    btns.appendChild(tsumoBtn);
  }

  if (actions && actions.canRiichiTileIds.length > 0) {
    const riichiBtn = document.createElement('button');
    riichiBtn.type = 'button';
    riichiBtn.className = uiState.riichiSelectingMode
      ? 'btn btn-secondary'
      : 'btn btn-riichi';
    riichiBtn.textContent = uiState.riichiSelectingMode
      ? 'リーチ宣言キャンセル'
      : 'リーチ';
    riichiBtn.addEventListener('click', () => {
      handlers.onToggleRiichiMode?.(!uiState.riichiSelectingMode);
    });
    btns.appendChild(riichiBtn);
  }

  if (actions) {
    const allMyTiles = view.myDrawnTile
      ? [...view.myHand, view.myDrawnTile]
      : view.myHand;

    for (const kind of actions.canAnkanKinds) {
      const sample = allMyTiles.find((t) => t.kind === kind) ?? {
        id: `ankan-preview-${kind}`,
        kind,
        isRed: false,
      };
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-call btn-with-tiles';
      const textSpan = document.createElement('span');
      textSpan.textContent = `暗槓 (${formatTileLabel(kind)})`;
      btn.append(textSpan, createActionTilePreview([sample]));
      btn.addEventListener('click', () => handlers.onDeclareAnkan(kind));
      btns.appendChild(btn);
    }

    for (const tileId of actions.canKakanTileIds) {
      const tile = allMyTiles.find((t) => t.id === tileId);
      const tileLabel = tile ? formatTileLabel(tile.kind) : tileId;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-call btn-with-tiles';
      const textSpan = document.createElement('span');
      textSpan.textContent = `加槓 (${tileLabel})`;
      btn.appendChild(textSpan);
      if (tile) {
        btn.appendChild(createActionTilePreview([tile]));
      }
      btn.addEventListener('click', () => handlers.onDeclareKakan(tileId));
      btns.appendChild(btn);
    }

    if (actions.canKitaTileIds.length > 0) {
      const firstKitaId = actions.canKitaTileIds[0]!;
      const kitaSample = allMyTiles.find((t) => t.id === firstKitaId) ?? {
        id: 'kita-preview-4z',
        kind: '4z' as TileKind,
        isRed: false,
      };
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-kita btn-with-tiles';
      const textSpan = document.createElement('span');
      textSpan.textContent = '抜北 (北)';
      btn.append(textSpan, createActionTilePreview([kitaSample]));
      btn.addEventListener('click', () => handlers.onDeclareKita(firstKitaId));
      btns.appendChild(btn);
    }

    if (actions.canKyuushuKyuuhai) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-abortive';
      btn.textContent = '九種九牌（流局）';
      btn.addEventListener('click', handlers.onDeclareKyuushuKyuuhai);
      btns.appendChild(btn);
    }
  }

  if (player.isRiichi) {
    const autoBtn = document.createElement('button');
    autoBtn.type = 'button';
    autoBtn.className = uiState.autoTsumogiriEnabled
      ? 'btn btn-call'
      : 'btn btn-secondary';
    autoBtn.textContent = `自動ツモ切り: ${uiState.autoTsumogiriEnabled ? 'ON' : 'OFF'}`;
    autoBtn.addEventListener('click', () => {
      handlers.onToggleAutoTsumogiri?.(!uiState.autoTsumogiriEnabled);
    });
    btns.appendChild(autoBtn);
  }

  bar.appendChild(btns);
  return bar;
}

function buildTurnPrompt(view: StateView, canDiscardNow: boolean): HTMLElement {
  const prompt = document.createElement('div');
  prompt.className = `turn-prompt${canDiscardNow ? ' is-my-turn' : ''}`;

  if (view.phase === 'round_end') {
    const hasAgari =
      view.round &&
      (view.round.agariResults.length > 0 || view.round.ronWinners.length > 0);
    if (hasAgari) {
      const winType = view.round!.agariResults[0]?.winType;
      prompt.textContent =
        winType === 'tsumo' ? 'ツモ和了が発生しました' : 'ロン和了が発生しました';
    } else if (view.round?.abortiveDrawReason) {
      prompt.textContent = `途中流局（${ABORTIVE_DRAW_META[view.round.abortiveDrawReason].title}）が発生しました`;
    } else {
      prompt.textContent = '流局しました';
    }
    return prompt;
  }

  if (view.phase === 'awaiting_responses' && view.myCallOptions !== null) {
    prompt.textContent = '相手の打牌に対して鳴き・ロンを選択できます';
    return prompt;
  }

  if (canDiscardNow) {
    if (view.mySelfActions?.canTsumo) {
      prompt.textContent =
        'ツモ和了が可能です！「ツモ和了」を押すか、切る牌を選んでください';
    } else if (view.players.find((p) => p.playerId === view.viewerPlayerId)?.isRiichi) {
      prompt.textContent = 'リーチ中です — ツモ牌のみ切れます';
    } else if (view.kuikaeForbiddenKinds.length > 0) {
      prompt.textContent =
        'あなたの手番です — 切る牌を選んでください（喰い替え禁止牌は選択不可）';
    } else {
      prompt.textContent = 'あなたの手番です — 切る牌をタップしてください';
    }
    return prompt;
  }

  const current = view.players.find((p) => p.isCurrentTurn);
  if (current?.playerId === view.viewerPlayerId) {
    prompt.textContent = '待機中...';
  } else if (current) {
    prompt.textContent = `${current.name} の打牌を待っています...`;
  } else {
    prompt.textContent = '待機中...';
  }
  return prompt;
}

interface SelfSeatController {
  box: HTMLElement;
  canDiscardNow: boolean;
  tapTileById: (tileId: string) => void;
  clearSelection: () => void;
  setSceneRef: (scene: Mahjong3DScene | null) => void;
}

function updateTenpaiGuideElement(
  guideEl: HTMLElement,
  view: StateView,
  selectedTileId: string | null,
): void {
  const info = computeSelfTenpaiGuide(view, selectedTileId);
  guideEl.innerHTML = '';
  if (!info) {
    guideEl.hidden = true;
    guideEl.classList.remove('is-visible', 'is-furiten-risk');
    return;
  }

  guideEl.hidden = false;
  guideEl.classList.add('is-visible');
  guideEl.classList.toggle('is-furiten-risk', info.hasFuritenWait);

  const label = document.createElement('span');
  label.className = 'tenpai-guide-label';
  if (info.mode === 'discard_preview' && info.discardTile) {
    label.textContent = `打 ${formatTileLabel(info.discardTile.kind)} で聴牌`;
  } else {
    label.textContent = '聴牌待ち';
  }
  guideEl.appendChild(label);

  const waitsRow = document.createElement('div');
  waitsRow.className = 'tenpai-guide-waits';
  for (const w of info.waits) {
    const item = document.createElement('span');
    item.className = `tenpai-guide-item${w.isDora ? ' is-dora' : ''}${
      w.isFuriten ? ' is-furiten' : ''
    }${w.remainingCount === 0 ? ' is-empty' : ''}`;
    item.appendChild(
      createTileElement(
        { id: `tenpai-wait-${w.kind}`, kind: w.kind, isRed: false },
        { small: true },
      ),
    );
    const rem = document.createElement('span');
    rem.className = 'tenpai-guide-rem';
    rem.textContent = `残${w.remainingCount}`;
    item.appendChild(rem);
    waitsRow.appendChild(item);
  }
  guideEl.appendChild(waitsRow);

  const totalBadge = document.createElement('span');
  totalBadge.className = 'tenpai-guide-total';
  totalBadge.textContent = `計${info.totalRemainingCount}枚`;
  guideEl.appendChild(totalBadge);

  if (info.hasFuritenWait) {
    const furitenBadge = document.createElement('span');
    furitenBadge.className = 'tenpai-guide-furiten';
    furitenBadge.textContent = 'フリテン';
    guideEl.appendChild(furitenBadge);
  }
}

function renderSelfSeat(
  view: StateView,
  player: PublicPlayerView,
  handlers: TableHandlers,
  uiState: TableUiState,
  rank?: number,
  newlyMeldedIndices?: Set<number>,
  newlyAddedKita = false,
): SelfSeatController {
  const isMyTurn = view.phase === 'playing' && player.isCurrentTurn;
  const canDiscardNow =
    isMyTurn && (view.myDrawnTile !== null || view.myHand.length % 3 === 2);

  const box = document.createElement('div');
  box.className = `seat-box seat-self seat-orient-self${
    player.isCurrentTurn ? ' is-turn' : ''
  }${canDiscardNow ? ' is-my-turn-active' : ''}`;
  box.dataset.seat = 'self';

  box.appendChild(
    renderSeatHeader(
      player,
      true,
      view.isFuriten,
      rank,
      canDiscardNow,
      uiState.chatBubbles?.[player.playerId],
    ),
  );

  const canRiichiIds = view.mySelfActions?.canRiichiTileIds ?? [];
  const inRiichiMode =
    canDiscardNow && uiState.riichiSelectingMode && canRiichiIds.length > 0;
  const riichiCandidateSet = new Set(canRiichiIds);

  const controls = document.createElement('div');
  controls.className = 'self-controls';

  const topBar = document.createElement('div');
  topBar.className = 'self-top-bar';

  const tenpaiGuideEl = document.createElement('div');
  tenpaiGuideEl.className = 'tenpai-wait-guide';
  tenpaiGuideEl.setAttribute('aria-live', 'polite');
  topBar.appendChild(tenpaiGuideEl);

  const actionDock = document.createElement('div');
  actionDock.className = 'self-action-dock';
  actionDock.appendChild(buildTurnPrompt(view, canDiscardNow));

  const callBar = renderCallResponseBar(view, handlers);
  if (callBar) {
    actionDock.appendChild(callBar);
  }

  const selfActionsBar = renderSelfTurnActionsBar(
    view,
    player,
    handlers,
    uiState,
    canDiscardNow,
  );
  if (selfActionsBar) {
    actionDock.appendChild(selfActionsBar);
  }

  if (
    view.phase === 'awaiting_responses' &&
    view.myCallOptions !== null &&
    view.responseRemainingMs !== null
  ) {
    const secs = Math.ceil(view.responseRemainingMs / 1000);
    const timer = document.createElement('div');
    timer.className = 'table-timer-digits';
    timer.innerHTML = `<span data-countdown-ms>${secs}</span>`;
    actionDock.appendChild(timer);
  }

  topBar.appendChild(actionDock);
  controls.appendChild(topBar);

  const forbiddenSet = new Set(canDiscardNow ? view.kuikaeForbiddenKinds : []);
  const handArea = document.createElement('div');
  handArea.className = `hand-area${canDiscardNow ? ' is-my-turn-hand' : ''}`;
  const initialSelectedId = canDiscardNow ? (uiState.selectedTileId ?? null) : null;
  updateTenpaiGuideElement(tenpaiGuideEl, view, initialSelectedId);

  let sceneRef: Mahjong3DScene | null = null;
  const tapHandlers = new Map<string, () => void>();

  const setSelectedTileInDom = (nextId: string | null): void => {
    const buttons = handArea.querySelectorAll<HTMLElement>('.mj-tile-clickable');
    for (const btn of buttons) {
      const isSelected = nextId !== null && btn.dataset.tileId === nextId;
      btn.classList.toggle('mj-tile-selected', isSelected);
      btn.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
    }
    updateTenpaiGuideElement(tenpaiGuideEl, view, nextId);
    sceneRef?.setSelectedTileId(nextId);
    handlers.onSelectTile?.(nextId);
  };

  const handleTileTap = (tileId: string, onConfirm: () => void): void => {
    const currentSelected = handArea
      .querySelector('.mj-tile-selected')
      ?.getAttribute('data-tile-id');
    if (currentSelected === tileId) {
      setSelectedTileInDom(null);
      onConfirm();
      return;
    }
    soundEngine.playSelect();
    setSelectedTileInDom(tileId);
  };

  for (const tile of view.myHand) {
    if (inRiichiMode) {
      const isCandidate = riichiCandidateSet.has(tile.id);
      const onTap = () =>
        handleTileTap(tile.id, () => handlers.onDeclareRiichi(tile.id));
      if (isCandidate) tapHandlers.set(tile.id, onTap);
      handArea.appendChild(
        createTileElement(tile, {
          clickable: isCandidate,
          selected: isCandidate && initialSelectedId === tile.id,
          disabled: !isCandidate,
          riichiCandidate: isCandidate,
          disabledReason: isCandidate
            ? undefined
            : 'この牌を切っても聴牌にならないためリーチできません',
          onClick: onTap,
        }),
      );
    } else {
      const lockedByRiichi = canDiscardNow && player.isRiichi;
      const blockedByKuikae = forbiddenSet.has(tile.kind);
      const blocked = lockedByRiichi || blockedByKuikae;
      const canTap = canDiscardNow && !blocked;
      const onTap = () =>
        handleTileTap(tile.id, () => handlers.onDiscardTile(tile.id));
      if (canTap) tapHandlers.set(tile.id, onTap);
      handArea.appendChild(
        createTileElement(tile, {
          clickable: canTap,
          selected: canTap && initialSelectedId === tile.id,
          disabled: canDiscardNow && blocked,
          disabledReason: lockedByRiichi
            ? 'リーチ後は手牌を入れ替えられません'
            : blockedByKuikae
              ? '喰い替え禁止のため切れません'
              : undefined,
          onClick: onTap,
        }),
      );
    }
  }

  if (view.myDrawnTile) {
    const drawn = view.myDrawnTile;
    const gap = document.createElement('div');
    gap.className = 'drawn-gap';
    handArea.appendChild(gap);
    if (inRiichiMode) {
      const isCandidate = riichiCandidateSet.has(drawn.id);
      const onTap = () =>
        handleTileTap(drawn.id, () => handlers.onDeclareRiichi(drawn.id));
      if (isCandidate) tapHandlers.set(drawn.id, onTap);
      const drawnEl = createTileElement(drawn, {
        clickable: isCandidate,
        selected: isCandidate && initialSelectedId === drawn.id,
        disabled: !isCandidate,
        riichiCandidate: isCandidate,
        disabledReason: isCandidate
          ? undefined
          : 'この牌を切っても聴牌にならないためリーチできません',
        onClick: onTap,
      });
      drawnEl.classList.add('mj-tile-drawn');
      handArea.appendChild(drawnEl);
    } else {
      const blocked = forbiddenSet.has(drawn.kind);
      const canTap = canDiscardNow && !blocked;
      const onTap = () =>
        handleTileTap(drawn.id, () => handlers.onDiscardTile(drawn.id));
      if (canTap) tapHandlers.set(drawn.id, onTap);
      const drawnEl = createTileElement(drawn, {
        clickable: canTap,
        selected: canTap && initialSelectedId === drawn.id,
        disabled: canDiscardNow && blocked,
        disabledReason: blocked ? '喰い替え禁止のため切れません' : undefined,
        onClick: onTap,
      });
      drawnEl.classList.add('mj-tile-drawn');
      handArea.appendChild(drawnEl);
    }
  }

  const handDock = document.createElement('div');
  handDock.className = 'self-hand-dock';

  const meldsSlot = document.createElement('div');
  meldsSlot.className = 'self-melds-dock';
  const meldsEl = renderMeldsAndKita(
    player,
    'self',
    newlyMeldedIndices,
    newlyAddedKita,
  );
  if (meldsEl) {
    meldsSlot.appendChild(meldsEl);
  }

  const rightSpacer = document.createElement('div');
  rightSpacer.className = 'self-hand-spacer';

  handDock.append(meldsSlot, handArea, rightSpacer);
  controls.appendChild(handDock);

  box.appendChild(controls);

  // 自分の河は手牌より中央側（卓の内側）に置き、実物と同じ並びにする
  box.appendChild(renderDiscardRiver(player, { side: 'self' }));
  return {
    box,
    canDiscardNow,
    tapTileById: (tileId) => {
      tapHandlers.get(tileId)?.();
    },
    clearSelection: () => {
      if (handArea.querySelector('.mj-tile-selected')) {
        setSelectedTileInDom(null);
      }
    },
    setSceneRef: (scene) => {
      sceneRef = scene;
    },
  };
}

function renderSpectatedBottomSeat(
  player: PublicPlayerView,
  rank?: number,
  newlyMeldedIndices?: Set<number>,
  newlyAddedKita = false,
  chatBubble?: SeatChatBubble,
): HTMLElement {
  const box = document.createElement('div');
  box.className = `seat-box seat-self seat-orient-self is-spectated${
    player.isCurrentTurn ? ' is-turn' : ''
  }`;
  box.dataset.seat = 'self';

  box.appendChild(
    renderSeatHeader(player, false, false, rank, false, chatBubble),
  );

  const controls = document.createElement('div');
  controls.className = 'self-controls';

  const handDock = document.createElement('div');
  handDock.className = 'self-hand-dock';

  const meldsSlot = document.createElement('div');
  meldsSlot.className = 'self-melds-dock';
  const meldsEl = renderMeldsAndKita(
    player,
    'self',
    newlyMeldedIndices,
    newlyAddedKita,
  );
  if (meldsEl) {
    meldsSlot.appendChild(meldsEl);
  }

  const handArea = document.createElement('div');
  handArea.className = 'hand-area spectator-hand-area';
  for (let i = 0; i < player.handCount; i++) {
    handArea.appendChild(createTileBackElement(false));
  }
  if (player.hasDrawnTile) {
    const gap = document.createElement('div');
    gap.className = 'drawn-gap';
    handArea.appendChild(gap);
    const drawnBack = createTileBackElement(false);
    drawnBack.classList.add('opp-tile-drawn');
    handArea.appendChild(drawnBack);
  }

  const rightSpacer = document.createElement('div');
  rightSpacer.className = 'self-hand-spacer';

  handDock.append(meldsSlot, handArea, rightSpacer);
  controls.appendChild(handDock);
  box.appendChild(controls);

  box.appendChild(renderDiscardRiver(player, { side: 'self' }));
  return box;
}

function renderSpectatorHud(
  view: StateView,
  activeSeatIndex: number,
  handlers: TableHandlers,
): HTMLElement {
  const hud = document.createElement('div');
  hud.className = 'spectator-hud';

  const badge = document.createElement('span');
  badge.className = 'spectator-badge';
  const specCount = (view.spectators ?? []).filter((s) => s.connected).length;
  badge.textContent = specCount > 1 ? `観戦中 (${specCount}人)` : '観戦中';
  hud.appendChild(badge);

  const switchRow = document.createElement('div');
  switchRow.className = 'spectator-perspective-row';
  const ordered = [...view.players].sort((a, b) => a.seatIndex - b.seatIndex);
  for (const p of ordered) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `spectator-seat-btn${
      p.seatIndex === activeSeatIndex ? ' is-active' : ''
    }`;
    const windLabel = p.seatWind ? `${windToJa(p.seatWind)}:` : '';
    btn.textContent = `${windLabel}${p.name}`;
    btn.title = `${p.name} の視点に切り替え`;
    btn.addEventListener('click', () => {
      handlers.onChangePerspective?.(p.seatIndex);
    });
    switchRow.appendChild(btn);
  }
  hud.appendChild(switchRow);
  return hud;
}

function buildScoreTable(
  players: PublicPlayerView[],
  ranked = false,
  roundScoreDeltas?: Record<string, number>,
  initialDealerIndex = 0,
): HTMLElement {
  const list = ranked ? rankPlayersByScore(players, initialDealerIndex) : players;

  const hasRoundDelta =
    roundScoreDeltas !== undefined && Object.keys(roundScoreDeltas).length > 0;

  const table = document.createElement('table');
  table.className = 'score-table';
  const thead = document.createElement('thead');
  thead.innerHTML = `<tr>${ranked ? '<th>順位</th>' : ''}<th>プレイヤー</th>${hasRoundDelta ? '<th class="num">今局増減</th>' : ''}<th class="num">持ち点</th></tr>`;
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  list.forEach((p, idx) => {
    const tr = document.createElement('tr');
    if (ranked) {
      const rankTd = document.createElement('td');
      rankTd.textContent = `${idx + 1}位`;
      tr.appendChild(rankTd);
    }
    const nameTd = document.createElement('td');
    nameTd.textContent = p.name;
    tr.appendChild(nameTd);

    if (hasRoundDelta) {
      const delta = roundScoreDeltas![p.playerId] ?? 0;
      const deltaTd = document.createElement('td');
      deltaTd.className = `num${delta > 0 ? ' delta-pos' : delta < 0 ? ' delta-neg' : ''}`;
      deltaTd.textContent =
        delta > 0
          ? `+${delta.toLocaleString()}`
          : delta < 0
            ? delta.toLocaleString()
            : '±0';
      tr.appendChild(deltaTd);
    }

    const scoreTd = document.createElement('td');
    scoreTd.className = 'num';
    scoreTd.textContent = `${p.score.toLocaleString()}点`;
    tr.appendChild(scoreTd);
    tbody.appendChild(tr);
  });

  table.appendChild(tbody);
  return table;
}

/** 席順の起家からの距離 → 持ち点の順で並べる（同点は起家に近い席が上位） */
function rankPlayersByScore<T extends { seatIndex: number; score: number }>(
  players: readonly T[],
  initialDealerIndex: number,
): T[] {
  const count = players.length;
  return [...players].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const distA = ((a.seatIndex - initialDealerIndex) % count + count) % count;
    const distB = ((b.seatIndex - initialDealerIndex) % count + count) % count;
    return distA - distB;
  });
}

function computePlayerRankMap(
  players: readonly PublicPlayerView[],
  initialDealerIndex: number,
): Map<string, number> {
  const ranked = rankPlayersByScore(players, initialDealerIndex);
  const map = new Map<string, number>();
  ranked.forEach((p, idx) => {
    map.set(p.playerId, idx + 1);
  });
  return map;
}

function renderFinishedScreen(
  container: HTMLElement,
  view: StateView,
  handlers: TableHandlers,
): void {
  const rules = deriveRules(view.ruleConfig);
  const panel = document.createElement('div');
  panel.className = 'overlay-panel finished-panel';
  applyOrientationClass(panel);

  const title = document.createElement('h2');
  title.style.margin = '0';
  title.style.color = 'var(--accent-gold)';
  const lengthJa = view.ruleConfig.gameLength === 'tonpuu' ? '東風戦' : '半荘戦';
  const hasTobi = view.players.some((p) => p.score < 0);
  title.textContent = `終局 — ${view.ruleConfig.playerCount}人 ${lengthJa} 最終結果${hasTobi ? '（トビ終了）' : ''}`;

  const rankedPlayers = rankPlayersByScore(
    view.players,
    view.initialDealerIndex,
  );
  const podium = document.createElement('div');
  podium.className = 'finished-podium-list';
  rankedPlayers.forEach((p, idx) => {
    const rank = idx + 1;
    const isSelf = !view.isSpectator && p.playerId === view.viewerPlayerId;
    const card = document.createElement('div');
    card.className = `finished-podium-card rank-${rank}${isSelf ? ' is-self' : ''}`;

    const rankEl = document.createElement('div');
    rankEl.className = `finished-rank-badge rank-${rank}`;
    rankEl.textContent = `${rank}位`;

    const avatar = createSeatAvatar(p, isSelf);

    const info = document.createElement('div');
    info.className = 'finished-podium-info';
    const nameEl = document.createElement('div');
    nameEl.className = 'finished-podium-name';
    nameEl.textContent = isSelf ? `${p.name}（あなた）` : p.name;

    const delta = p.score - rules.initialPoints;
    const deltaEl = document.createElement('div');
    deltaEl.className = `finished-podium-delta ${
      delta > 0 ? 'delta-pos' : delta < 0 ? 'delta-neg' : 'delta-even'
    }`;
    deltaEl.textContent =
      delta > 0
        ? `開始比 +${delta.toLocaleString()}点`
        : delta < 0
          ? `開始比 ${delta.toLocaleString()}点`
          : '開始比 ±0点';

    info.append(nameEl, deltaEl);

    const scoreEl = document.createElement('div');
    scoreEl.className = 'finished-podium-score';
    scoreEl.textContent = `${p.score.toLocaleString()}点`;

    card.append(rankEl, avatar, info, scoreEl);
    podium.appendChild(card);
  });

  const table = buildScoreTable(
    view.players,
    true,
    undefined,
    view.initialDealerIndex,
  );
  panel.append(title, podium, table);

  if (view.finalKyotakuAward) {
    const awardPlayer = view.players.find(
      (p) => p.playerId === view.finalKyotakuAward!.playerId,
    );
    const awardNote = document.createElement('div');
    awardNote.className = 'kyotaku-award-note';
    awardNote.textContent = `終局時残供託加算: ${awardPlayer?.name ?? view.finalKyotakuAward.playerId} に +${view.finalKyotakuAward.points.toLocaleString()}点 を加算しました（同点時は起家に近い席が上位）。`;
    panel.appendChild(awardNote);
  }

  if (view.kyotakuCount > 0) {
    const rules = deriveRules(view.ruleConfig);
    const leftover = document.createElement('div');
    leftover.className = 'hub-sub';
    leftover.textContent = `場に残った供託リーチ棒: ${view.kyotakuCount}本（${(view.kyotakuCount * rules.riichiStickPoints).toLocaleString()}点）`;
    panel.appendChild(leftover);
  }

  const isHost =
    !view.isSpectator && view.viewerPlayerId === view.hostPlayerId;
  const btnRow = document.createElement('div');
  btnRow.style.display = 'flex';
  btnRow.style.gap = '8px';
  btnRow.style.flexWrap = 'wrap';

  if (isHost && handlers.onResetToLobby) {
    const replayBtn = document.createElement('button');
    replayBtn.type = 'button';
    replayBtn.className = 'btn btn-primary';
    replayBtn.textContent = '同じメンバーでロビーに戻る';
    replayBtn.addEventListener('click', handlers.onResetToLobby);
    btnRow.appendChild(replayBtn);
  }

  const backBtn = document.createElement('button');
  backBtn.type = 'button';
  backBtn.className =
    isHost && handlers.onResetToLobby ? 'btn btn-secondary' : 'btn btn-primary';
  backBtn.textContent =
    isHost && handlers.onResetToLobby ? 'トップに戻る（退室）' : 'ロビーに戻る';
  backBtn.addEventListener('click', handlers.onReturnToLobby);
  btnRow.appendChild(backBtn);

  panel.appendChild(btnRow);
  const backdrop = document.createElement('div');
  backdrop.className = 'overlay-backdrop overlay-backdrop-finished';
  backdrop.appendChild(panel);
  container.appendChild(backdrop);
}

/** CPU 名のラベル（ロビー表示用の再エクスポート） */
export { cpuDisplayName, CPU_PLAYER_ID_PREFIX };
