import type { Wind } from '../types/rule';
import type { Tile, TileKind } from '../types/tile';

const KANJI_NUMBERS = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九'] as const;

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

export function formatRoundName(roundWind: Wind, kyokuNumber: number): string {
  return `${windToJa(roundWind)}${kyokuNumber}局`;
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
  tsumogiri?: boolean;
  latestDiscard?: boolean;
  small?: boolean;
  onClick?: () => void;
}

export function createTileElement(
  tile: Tile,
  options: TileElementOptions = {},
): HTMLElement {
  const el = document.createElement(options.clickable ? 'button' : 'div');
  if (el instanceof HTMLButtonElement) {
    el.type = 'button';
  }
  el.className = 'mj-tile';
  if (options.clickable) el.classList.add('mj-tile-clickable');
  if (options.tsumogiri) el.classList.add('mj-tile-tsumogiri');
  if (options.latestDiscard) el.classList.add('mj-tile-latest');
  if (options.small) el.classList.add('mj-tile-sm');

  el.setAttribute('aria-label', formatTileLabel(tile.kind));
  el.dataset.tileId = tile.id;
  el.dataset.tileKind = tile.kind;

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
    top.textContent = suit === 'm' ? (KANJI_NUMBERS[rank] ?? String(rank)) : String(rank);

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

  if (options.clickable && options.onClick) {
    el.addEventListener('click', options.onClick);
  }

  return el;
}

export function createTileBackElement(small = true): HTMLElement {
  const el = document.createElement('div');
  el.className = small ? 'mj-tile mj-tile-back mj-tile-sm' : 'mj-tile mj-tile-back';
  el.setAttribute('aria-hidden', 'true');
  return el;
}
