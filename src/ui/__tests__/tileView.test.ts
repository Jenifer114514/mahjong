// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { SPRITE_COLUMNS, SPRITE_ROWS, type TileSpriteSheet } from '../tileTexture';

const { mockSheet } = vi.hoisted(() => {
  const sheet: TileSpriteSheet = {
    imageUrl: 'data:image/png;base64,MOCK',
    cellWidth: 100,
    cellHeight: 132,
    cells: new Map(),
    getPosition: (kind, isRed) => {
      if (kind === '1m' && !isRed) return { x: 0, y: 0 };
      if (kind === '5p' && isRed) return { x: 500, y: 660 };
      return { x: 200, y: 132 };
    },
  };
  return { mockSheet: sheet };
});

vi.mock('../tileTexture', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../tileTexture')>();
  return {
    ...actual,
    getPrewarmedTileSpriteSheet: () => mockSheet,
  };
});

const { createTileElement } = await import('../tileView');

describe('tileView スプライトシート描画', () => {
  it('スプライトシート利用時は牌サイズ・小牌にかかわらず % 指定で background-size/position を設定する', () => {
    const normalEl = createTileElement({ id: 't1', kind: '5p', isRed: true });
    const smallEl = createTileElement(
      { id: 't2', kind: '5p', isRed: true },
      { small: true },
    );

    expect(normalEl.classList.contains('mj-tile-face')).toBe(true);
    expect(normalEl.style.backgroundSize).toBe(
      `${SPRITE_COLUMNS * 100}% ${SPRITE_ROWS * 100}%`,
    );
    expect(smallEl.style.backgroundSize).toBe(
      `${SPRITE_COLUMNS * 100}% ${SPRITE_ROWS * 100}%`,
    );

    const expectedX = `${Number(((5 / (SPRITE_COLUMNS - 1)) * 100).toFixed(4))}%`;
    const expectedY = `${Number(((5 / (SPRITE_ROWS - 1)) * 100).toFixed(4))}%`;
    expect(normalEl.style.backgroundPosition).toBe(`${expectedX} ${expectedY}`);
    expect(smallEl.style.backgroundPosition).toBe(`${expectedX} ${expectedY}`);

    const firstCell = createTileElement({ id: 't3', kind: '1m', isRed: false });
    expect(firstCell.style.backgroundPosition).toBe('0% 0%');
  });

  it('赤ドラまたはdora指定のある牌にドラオーラと光沢シマー要素を付与し、通常牌には付与しない', () => {
    const plainEl = createTileElement({ id: 'p1', kind: '2m', isRed: false });
    expect(plainEl.classList.contains('mj-tile-dora')).toBe(false);
    expect(plainEl.classList.contains('mj-tile-red')).toBe(false);
    expect(plainEl.querySelector('.mj-tile-dora-aura')).toBeNull();
    expect(plainEl.querySelector('.mj-tile-dora-sheen')).toBeNull();

    const doraEl = createTileElement(
      { id: 'd1', kind: '2m', isRed: false },
      { dora: true },
    );
    expect(doraEl.classList.contains('mj-tile-dora')).toBe(true);
    expect(doraEl.querySelector('.mj-tile-dora-aura')?.getAttribute('aria-hidden')).toBe('true');
    expect(doraEl.querySelector('.mj-tile-dora-sheen')?.getAttribute('aria-hidden')).toBe('true');

    const redEl = createTileElement({ id: 'r1', kind: '5p', isRed: true });
    expect(redEl.classList.contains('mj-tile-red')).toBe(true);
    expect(redEl.classList.contains('mj-tile-dora')).toBe(false);
    expect(redEl.querySelector('.mj-tile-dora-aura')).not.toBeNull();
    expect(redEl.querySelector('.mj-tile-dora-sheen')).not.toBeNull();

    const bothEl = createTileElement(
      { id: 'b1', kind: '5p', isRed: true },
      { dora: true, small: true },
    );
    expect(bothEl.classList.contains('mj-tile-red')).toBe(true);
    expect(bothEl.classList.contains('mj-tile-dora')).toBe(true);
    expect(bothEl.querySelectorAll('.mj-tile-dora-aura')).toHaveLength(1);
    expect(bothEl.querySelectorAll('.mj-tile-dora-sheen')).toHaveLength(1);
  });
});
