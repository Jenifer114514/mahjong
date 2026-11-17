import type { Wind } from '../types/rule';
import type { Tile, TileKind } from '../types/tile';
import {
  createTileSpriteSheet,
  getPrewarmedTileSpriteSheet,
  SPRITE_COLUMNS,
  SPRITE_ROWS,
  type TileSpriteSheet,
} from './tileTexture';

const KANJI_NUMBERS = ['', '一', '二', '三', '四', '伍', '六', '七', '八', '九'] as const;

const HONOR_LABELS: Record<string, { char: string; colorClass: string }> = {
  '1z': { char: '東', colorClass: 'tile-honor-dark' },
  '2z': { char: '南', colorClass: 'tile-honor-dark' },
  '3z': { char: '西', colorClass: 'tile-honor-dark' },
  '4z': { char: '北', colorClass: 'tile-honor-dark' },
  '5z': { char: '白', colorClass: 'tile-honor-haku' },
  '6z': { char: '發', colorClass: 'tile-honor-green' },
  '7z': { char: '中', colorClass: 'tile-honor-red' },
};

export function windToJa(wind: Wind): string {
  switch (wind) {
    case 'E':
      return '東';
    case 'S':
      return '南';
    case 'W':
      return '西';
    case 'N':
      return '北';
  }
}

export function formatRoundName(
  roundWind: Wind,
  kyokuNumber: number,
  honba?: number,
): string {
  const base = `${windToJa(roundWind)}${kyokuNumber}局`;
  return honba !== undefined ? `${base} ${honba}本場` : base;
}

export function formatTileLabel(kind: TileKind): string {
  if (kind.endsWith('z')) {
    return HONOR_LABELS[kind]?.char ?? kind;
  }
  const num = Number(kind[0]);
  const suit = kind[1];
  const suitJa = suit === 'm' ? '萬' : suit === 'p' ? '筒' : '索';
  return `${num}${suitJa}`;
}

export interface TileElementOptions {
  clickable?: boolean;
  disabled?: boolean;
  disabledReason?: string;
  tsumogiri?: boolean;
  latestDiscard?: boolean;
  riichiDeclaration?: boolean;
  riichiCandidate?: boolean;
  called?: boolean;
  small?: boolean;
  onClick?: () => void;
}

/**
 * DOM 牌のアトラス（スプライトシート）。
 * 初回だけ生成し、以降は全牌で同じ data URL の canvas を共有する。
 * canvas 2D が使えない環境（jsdom / SSR）では null のままで、
 * 従来どおり文字（一萬・5筒 など）で描くフォールバックに切り替わる。
 */
let spriteSheet: TileSpriteSheet | null = null;
let spriteSheetTried = false;

/** スプライトシートの基準セル高さ（CSS px、DPR を掛けて描画） */
const SPRITE_CELL_HEIGHT = 54;

function getSpriteSheet(): TileSpriteSheet | null {
  // 事前生成済み（フォント読み込み後に生成されたもの）を優先して使う
  const prewarmed = getPrewarmedTileSpriteSheet();
  if (prewarmed) return prewarmed;

  if (spriteSheetTried) return spriteSheet;
  spriteSheetTried = true;
  if (typeof document === 'undefined') return null;

  const dpr =
    typeof window !== 'undefined' && Number.isFinite(window.devicePixelRatio)
      ? Math.min(window.devicePixelRatio || 1, 3)
      : 1;

  spriteSheet = createTileSpriteSheet({
    cellHeight: Math.round(SPRITE_CELL_HEIGHT * dpr),
  });
  return spriteSheet;
}

/**
 * 牌面を canvas 画像で描く。使えない場合は false を返し、呼び出し側が文字描画に落ちる。
 * スプライトシートは 1 枚を共有し、CSS の牌サイズ（大小・メディアクエリ・枠線幅）に
 * 追随するよう background-size / background-position を % 指定で設定する。
 */
function applyTileFaceImage(el: HTMLElement, tile: Tile): boolean {
  const sheet = getSpriteSheet();
  if (!sheet) return false;

  const position = sheet.getPosition(tile.kind, tile.isRed);
  if (!position) return false;

  const col = sheet.cellWidth > 0 ? Math.round(position.x / sheet.cellWidth) : 0;
  const row = sheet.cellHeight > 0 ? Math.round(position.y / sheet.cellHeight) : 0;
  const xPercent = SPRITE_COLUMNS > 1 ? (col / (SPRITE_COLUMNS - 1)) * 100 : 0;
  const yPercent = SPRITE_ROWS > 1 ? (row / (SPRITE_ROWS - 1)) * 100 : 0;

  el.classList.add('mj-tile-face');
  el.style.backgroundImage = `url("${sheet.imageUrl}")`;
  el.style.backgroundSize = `${SPRITE_COLUMNS * 100}% ${SPRITE_ROWS * 100}%`;
  el.style.backgroundPosition = `${xPercent}% ${yPercent}%`;
  el.style.backgroundRepeat = 'no-repeat';
  return true;
}

export function createTileElement(
  tile: Tile,
  options: TileElementOptions = {},
): HTMLElement {
  const isButton = Boolean(options.clickable || options.disabled);
  const el = document.createElement(isButton ? 'button' : 'div');
  if (el instanceof HTMLButtonElement) {
    el.type = 'button';
    if (options.disabled) {
      el.disabled = true;
    }
  }
  el.className = 'mj-tile';
  if (options.clickable && !options.disabled) {
    el.classList.add('mj-tile-clickable');
  }
  if (options.disabled) {
    el.classList.add('mj-tile-disabled');
    if (options.disabledReason) {
      el.title = options.disabledReason;
    }
  }
  if (options.tsumogiri) el.classList.add('mj-tile-tsumogiri');
  if (options.latestDiscard) el.classList.add('mj-tile-latest');
  if (options.riichiDeclaration) el.classList.add('mj-tile-riichi');
  if (options.riichiCandidate) el.classList.add('mj-tile-riichi-candidate');
  if (options.called) el.classList.add('mj-tile-called');
  if (options.small) el.classList.add('mj-tile-sm');

  el.setAttribute('aria-label', formatTileLabel(tile.kind));
  el.dataset.tileId = tile.id;
  el.dataset.tileKind = tile.kind;
  if (tile.isRed) el.classList.add('mj-tile-red');

  if (applyTileFaceImage(el, tile)) {
    const face = document.createElement('span');
    face.className = 'mj-tile-face-alt';
    face.textContent = formatTileLabel(tile.kind);
    el.appendChild(face);

    if (options.clickable && !options.disabled && options.onClick) {
      el.addEventListener('click', options.onClick);
    }
    return el;
  }

  if (tile.kind.endsWith('z')) {
    const honor = HONOR_LABELS[tile.kind] ?? {
      char: tile.kind,
      colorClass: 'tile-honor-dark',
    };
    el.classList.add(honor.colorClass);
    const main = document.createElement('span');
    main.className = 'mj-tile-honor';
    main.textContent = tile.kind === '5z' ? '' : honor.char;
    el.appendChild(main);
  } else {
    const rank = Number(tile.kind[0]);
    const suit = tile.kind[1];

    const top = document.createElement('span');
    top.className = 'mj-tile-rank';
    top.textContent =
      suit === 'm' ? (KANJI_NUMBERS[rank] ?? String(rank)) : String(rank);

    const bottom = document.createElement('span');
    bottom.className = 'mj-tile-suit';

    if (suit === 'm') {
      el.classList.add('tile-man');
      bottom.textContent = '萬';
    } else if (suit === 'p') {
      el.classList.add('tile-pin');
      bottom.textContent = '筒';
    } else {
      el.classList.add('tile-sou');
      bottom.textContent = '索';
    }

    el.append(top, bottom);
  }

  if (options.clickable && !options.disabled && options.onClick) {
    el.addEventListener('click', options.onClick);
  }

  return el;
}

export function createTileBackElement(
  small = true,
  tileSized = false,
): HTMLElement {
  const el = document.createElement('div');
  const classes = ['mj-tile', 'mj-tile-back'];
  if (small) classes.push('mj-tile-sm');
  if (tileSized) classes.push('mj-tile-back-meld');
  el.className = classes.join(' ');
  el.setAttribute('aria-hidden', 'true');
  return el;
}
