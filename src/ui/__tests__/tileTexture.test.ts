import { describe, expect, it, vi } from 'vitest';

import type { TileKind } from '../../types/tile';
import {
  createAtlasKeys,
  createTileAtlas,
  createTileBackCanvas,
  createTileFaceCanvas,
  DEFAULT_FONT_FAMILY,
  drawTileFace,
  RED_FIVE_KINDS,
  TILE_FACE_ASPECT,
  waitForTileFonts,
} from '../tileTexture';

/**
 * `@napi-rs/canvas` 等を足さずに構造だけ検証するための記録用コンテキスト。
 * 実際の描画結果は目視で確認する（docs/tile-atlas.png はローカル生成）。
 */
interface RecordingContext {
  calls: Array<{ name: string; args: unknown[] }>;
  fillStyle: unknown;
  strokeStyle: unknown;
  lineWidth: number;
  font: string;
  textAlign: string;
  textBaseline: string;
  globalAlpha: number;
  [key: string]: unknown;
}

function createRecordingGlobal() {
  const created: Array<{ width: number; height: number; ctx: RecordingContext }> = [];

  const gradient = { addColorStop: () => undefined };

  const factory = (width: number, height: number) => {
    const ctx: RecordingContext = {
      calls: [],
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 1,
      font: '',
      textAlign: 'start',
      textBaseline: 'alphabetic',
      globalAlpha: 1,
    };

    const record = (name: string) => (...args: unknown[]) => {
      ctx.calls.push({ name, args });
      return undefined;
    };

    for (const name of [
      'fillRect',
      'strokeRect',
      'beginPath',
      'moveTo',
      'lineTo',
      'quadraticCurveTo',
      'bezierCurveTo',
      'closePath',
      'arc',
      'ellipse',
      'fill',
      'stroke',
      'fillText',
      'translate',
      'rotate',
      'save',
      'restore',
      'clearRect',
    ]) {
      ctx[name] = record(name);
    }
    ctx.createLinearGradient = (() => gradient) as unknown;
    ctx.createRadialGradient = (() => gradient) as unknown;

    const canvas = { width, height } as HTMLCanvasElement;
    created.push({ width, height, ctx });

    return {
      canvas,
      ctx: ctx as unknown as CanvasRenderingContext2D,
      calls: ctx.calls,
    };
  };

  return { factory, created };
}

describe('tileTexture', () => {
  it('牌面のアスペクト比は 3D 側と共有する定数で定義されている', () => {
    expect(TILE_FACE_ASPECT).toBeGreaterThan(0.7);
    expect(TILE_FACE_ASPECT).toBeLessThan(0.8);

    const { factory } = createRecordingGlobal();
    const canvas = createTileFaceCanvas('1m', { height: 384 }, factory);
    expect(canvas.height).toBe(384);
    expect(canvas.width).toBe(Math.round(384 * TILE_FACE_ASPECT));
  });

  it('34 種 + 赤ドラ 3 種のキーを作る', () => {
    const keys = createAtlasKeys(true);
    expect(keys).toHaveLength(37);
    expect(keys.filter((key) => key.isRed).map((key) => key.kind)).toEqual([
      ...RED_FIVE_KINDS,
    ]);
    expect(createAtlasKeys(false)).toHaveLength(34);
  });

  it('アトラスは 1 枚の canvas に全牌種を並べ、UV は重ならず 0..1 に収まる', () => {
    const { factory, created } = createRecordingGlobal();
    const atlas = createTileAtlas({ size: 1024, columns: 8, factory });

    expect(created).toHaveLength(1);
    expect(created[0]?.width).toBe(1024);
    expect(atlas.cells).toHaveLength(37);
    expect(atlas.getCell({ kind: '5m' })).toBeDefined();
    expect(atlas.getCell({ kind: '5m', isRed: true })).toBeDefined();

    for (const cell of atlas.cells) {
      expect(cell.u0).toBeGreaterThanOrEqual(0);
      expect(cell.v0).toBeGreaterThanOrEqual(0);
      expect(cell.u1).toBeLessThanOrEqual(1);
      expect(cell.v1).toBeLessThanOrEqual(1);
      expect(cell.u1).toBeGreaterThan(cell.u0);
      expect(cell.v1).toBeGreaterThan(cell.v0);
      // 牌面の縦横比が保たれている
      expect(cell.width / cell.height).toBeCloseTo(TILE_FACE_ASPECT, 1);
    }

    // セル（牌面領域）同士が重ならない
    for (let i = 0; i < atlas.cells.length; i += 1) {
      for (let j = i + 1; j < atlas.cells.length; j += 1) {
        const a = atlas.cells[i]!;
        const b = atlas.cells[j]!;
        const overlapX = a.x < b.x + b.width && b.x < a.x + a.width;
        const overlapY = a.y < b.y + b.height && b.y < a.y + a.height;
        expect(overlapX && overlapY).toBe(false);
      }
    }

    atlas.dispose();
    expect(atlas.cells).toHaveLength(0);
  });

  it('白は無地（文字を描かない）、東は 1 文字だけ描く', () => {
    const { factory, created } = createRecordingGlobal();

    drawTileFace(
      (() => {
        const c = factory(200, 263);
        return c.ctx;
      })(),
      '5z' as TileKind,
      { width: 200, height: 263 },
    );
    const hakuTexts = created
      .at(-1)!
      .ctx.calls.filter((call) => call.name === 'fillText');
    expect(hakuTexts).toHaveLength(0);

    drawnTexts('1z', factory, created);
    expect(drawnTexts('1z', factory, created)).toEqual(expect.arrayContaining(['東']));
    // 彫刻表現のため同じ文字を 3 回（明部・影・本体）重ねる
    expect(drawnTexts('1z', factory, created).filter((t) => t === '東')).toHaveLength(3);
  });

  it('萬子は 数字（黒）+ 萬（赤）で描く', () => {
    const { factory } = createRecordingGlobal();
    const { ctx, calls } = factory(200, 263);
    const fills: string[] = [];
    const originalFillText = ctx.fillText as (...args: unknown[]) => void;
    ctx.fillText = (...args: unknown[]) => {
      fills.push(String(ctx.fillStyle));
      originalFillText(...args);
    };

    drawTileFace(ctx as unknown as CanvasRenderingContext2D, '1m', {
      width: 200,
      height: 263,
    });

    const texts = calls
      .filter((call) => call.name === 'fillText')
      .map((call) => String(call.args[0]));
    expect(texts).toContain('一');
    expect(texts).toContain('萬');
    // 數字は黒系、萬は赤系
    const numberColor = fills[texts.lastIndexOf('一')];
    const manColor = fills[texts.lastIndexOf('萬')];
    expect(numberColor?.toLowerCase()).toBe('#1f1d1a');
    expect(manColor?.toLowerCase()).toBe('#c3222b');
  });

  it('赤ドラの五萬は図柄全体が赤になる', () => {
    const { factory } = createRecordingGlobal();
    const { ctx, calls } = factory(200, 263);
    const fills: string[] = [];
    ctx.fillText = (...args: unknown[]) => {
      fills.push(String(ctx.fillStyle));
      calls.push({ name: 'fillText', args });
    };

    drawTileFace(ctx as unknown as CanvasRenderingContext2D, '5m', {
      width: 200,
      height: 263,
      isRed: true,
    });

    const texts = calls
      .filter((call) => call.name === 'fillText')
      .map((call) => String(call.args[0]));
    expect(texts).toContain('五');
    expect(fills[texts.lastIndexOf('五')]?.toLowerCase()).toBe('#c3222b');
  });

  it('全 34 種 + 赤ドラを例外なく描ける', () => {
    const { factory } = createRecordingGlobal();
    for (const key of createAtlasKeys(true)) {
      const { ctx } = factory(200, 263);
      expect(() =>
        drawTileFace(ctx as unknown as CanvasRenderingContext2D, key.kind, {
          width: 200,
          height: 263,
          isRed: key.isRed,
        }),
      ).not.toThrow();
    }
  });

  it('牌裏は別テクスチャとして 1 枚作る', () => {
    const { factory, created } = createRecordingGlobal();
    const back = createTileBackCanvas({ height: 384 }, factory);
    expect(back.height).toBe(384);
    expect(created).toHaveLength(1);
  });

  it('document が無い環境でもフォント待ちで落ちない', async () => {
    await expect(waitForTileFonts()).resolves.toBeUndefined();
    expect(DEFAULT_FONT_FAMILY).toContain('Mincho');
  });

  it('フォント指定は CJK を含む明朝系を既定にしている', async () => {
    const load = vi.fn().mockResolvedValue([]);
    const ready = Promise.resolve();
    vi.stubGlobal('document', { fonts: { load, ready } });

    await waitForTileFonts('"Test Serif"');
    expect(load).toHaveBeenCalledWith('700 64px "Test Serif"', expect.any(String));

    vi.unstubAllGlobals();
  });
});

function drawnTexts(
  kind: TileKind,
  factory: ReturnType<typeof createRecordingGlobal>['factory'],
  created: ReturnType<typeof createRecordingGlobal>['created'],
): string[] {
  const ctx = factory(200, 263).ctx;
  drawTileFace(ctx as unknown as CanvasRenderingContext2D, kind, {
    width: 200,
    height: 263,
  });
  return created
    .at(-1)!
    .ctx.calls.filter((call) => call.name === 'fillText')
    .map((call) => String(call.args[0]));
}
