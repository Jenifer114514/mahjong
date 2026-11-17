import { describe, expect, it, vi } from 'vitest';

import type { TileKind } from '../../types/tile';
import {
  createAtlasKeys,
  createTileSpriteSheet,
  SPRITE_COLUMNS,
  SPRITE_ROWS,
  createTileAtlas,
  createTileBackCanvas,
  createTileFaceCanvas,
  DEFAULT_FONT_FAMILY,
  drawTileFace,
  RED_FIVE_KINDS,
  TILE_FACE_ASPECT,
  TILE_INK,
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

  it('白は無地（文字を描かない）、東はベクター筆文字を彫刻 3 層で描く', () => {
    const { factory, created } = createRecordingGlobal();

    const haku = factory(200, 263);
    const hakuFills: string[] = [];
    const origHakuFill = haku.ctx.fill as (...args: unknown[]) => void;
    haku.ctx.fill = (...args: unknown[]) => {
      hakuFills.push(String(haku.ctx.fillStyle).toLowerCase());
      origHakuFill(...args);
    };
    drawTileFace(haku.ctx as unknown as CanvasRenderingContext2D, '5z' as TileKind, {
      width: 200,
      height: 263,
    });
    expect(haku.calls.filter((call) => call.name === 'fillText')).toHaveLength(0);
    expect(hakuFills).toHaveLength(0);

    const east = factory(200, 263);
    const eastFills: string[] = [];
    const origEastFill = east.ctx.fill as (...args: unknown[]) => void;
    east.ctx.fill = (...args: unknown[]) => {
      eastFills.push(String(east.ctx.fillStyle).toLowerCase());
      origEastFill(...args);
    };
    drawTileFace(east.ctx as unknown as CanvasRenderingContext2D, '1z' as TileKind, {
      width: 200,
      height: 263,
    });
    // 彫刻表現（明部・影・藍黒本体）の 3 層パスを描画
    expect(eastFills).toHaveLength(3);
    expect(eastFills.at(-1)).toBe(TILE_INK.ink.toLowerCase());

    // fontFamily 明示指定時は fillText フォールバックも機能する
    const texts = drawnTexts('1z', factory, created, DEFAULT_FONT_FAMILY);
    expect(texts).toEqual(expect.arrayContaining(['東']));
    expect(texts.filter((t) => t === '東')).toHaveLength(3);
  });

  it('萬子は数字（藍黒）+ 萬（臙脂）で描き、5萬は「伍」を用いる', () => {
    const { factory } = createRecordingGlobal();
    const { ctx } = factory(200, 263);
    const fills: string[] = [];
    const origFill = ctx.fill as (...args: unknown[]) => void;
    ctx.fill = (...args: unknown[]) => {
      fills.push(String(ctx.fillStyle).toLowerCase());
      origFill(...args);
    };

    drawTileFace(ctx as unknown as CanvasRenderingContext2D, '1m', {
      width: 200,
      height: 263,
    });

    // 数字 3 層 + 萬 3 層 = 6 層
    expect(fills).toHaveLength(6);
    expect(fills[2]).toBe(TILE_INK.ink.toLowerCase());
    expect(fills[5]).toBe(TILE_INK.maroon.toLowerCase());

    // 5萬は「伍」「萬」を使用
    const f5 = factory(200, 263);
    const f5Fills: string[] = [];
    const origF5Text = f5.ctx.fillText as (...args: unknown[]) => void;
    f5.ctx.fillText = (...args: unknown[]) => {
      f5Fills.push(String(f5.ctx.fillStyle).toLowerCase());
      origF5Text(...args);
    };
    drawTileFace(f5.ctx as unknown as CanvasRenderingContext2D, '5m', {
      width: 200,
      height: 263,
      fontFamily: DEFAULT_FONT_FAMILY,
    });
    const texts5 = f5.calls
      .filter((call) => call.name === 'fillText')
      .map((call) => String(call.args[0]));
    expect(texts5).toContain('伍');
    expect(texts5).toContain('萬');
    expect(f5Fills[texts5.lastIndexOf('伍')]).toBe(TILE_INK.ink.toLowerCase());
    expect(f5Fills[texts5.lastIndexOf('萬')]).toBe(TILE_INK.maroon.toLowerCase());
  });

  it('赤ドラの五萬は図柄全体（伍・萬）が鮮紅色になる', () => {
    const { factory } = createRecordingGlobal();
    const { ctx } = factory(200, 263);
    const fills: string[] = [];
    const origFill = ctx.fill as (...args: unknown[]) => void;
    ctx.fill = (...args: unknown[]) => {
      fills.push(String(ctx.fillStyle).toLowerCase());
      origFill(...args);
    };

    drawTileFace(ctx as unknown as CanvasRenderingContext2D, '5m', {
      width: 200,
      height: 263,
      isRed: true,
    });

    expect(fills).toHaveLength(6);
    expect(fills[2]).toBe(TILE_INK.red.toLowerCase());
    expect(fills[5]).toBe(TILE_INK.red.toLowerCase());
  });

  it('通常5筒は外4つ藍黒＋中1つ臙脂、赤5筒は外4つ鮮紅＋中央輝石になる', () => {
    const { factory } = createRecordingGlobal();

    const normal = factory(200, 263);
    const normalFills: string[] = [];
    const origNormalFill = normal.ctx.fill as (...args: unknown[]) => void;
    normal.ctx.fill = (...args: unknown[]) => {
      normalFills.push(String(normal.ctx.fillStyle).toLowerCase());
      origNormalFill(...args);
    };
    drawTileFace(normal.ctx as unknown as CanvasRenderingContext2D, '5p', {
      width: 200,
      height: 263,
      isRed: false,
    });

    const red = factory(200, 263);
    const redFills: string[] = [];
    const origRedFill = red.ctx.fill as (...args: unknown[]) => void;
    red.ctx.fill = (...args: unknown[]) => {
      redFills.push(String(red.ctx.fillStyle).toLowerCase());
      origRedFill(...args);
    };
    drawTileFace(red.ctx as unknown as CanvasRenderingContext2D, '5p', {
      width: 200,
      height: 263,
      isRed: true,
    });

    // 通常の5p: 藍黒 (#1e2736) と中央の臙脂 (#632530) を使う
    expect(normalFills.filter((c) => c === TILE_INK.ink.toLowerCase()).length).toBeGreaterThan(0);
    expect(normalFills.filter((c) => c === TILE_INK.maroon.toLowerCase()).length).toBeGreaterThan(0);

    // 赤5p: 藍黒はなく、外4つの鮮紅 (#cf232e) ＋ 中央の輝石 (#6f6554, #ffffff) になる
    expect(redFills.filter((c) => c === TILE_INK.ink.toLowerCase())).toHaveLength(0);
    expect(redFills.filter((c) => c === TILE_INK.red.toLowerCase())).toHaveLength(12);
    expect(redFills).toContain('#6f6554');
    expect(redFills).toContain('#ffffff');
  });

  it('6筒・7筒・8筒・8索・發/中が写真の意匠（2+4・3+4・2×4・M/W型・藍黒發/臙脂中）で描かれる', () => {
    const { factory } = createRecordingGlobal();

    // 8索は斜め4本を含む8本の竹（rotate が 4 回呼ばれる）
    const s8 = factory(200, 263);
    drawTileFace(s8.ctx as unknown as CanvasRenderingContext2D, '8s', {
      width: 200,
      height: 263,
    });
    expect(s8.calls.filter((c) => c.name === 'rotate')).toHaveLength(4);

    // 8筒は 2 列 (x=0.32, 0.68) × 4 段で全 8 個が同じ 2 つの X 座標のみに並ぶ
    const p8 = factory(200, 263);
    const p8Xs = new Set<number>();
    const origArc8 = p8.ctx.arc as (...args: unknown[]) => void;
    p8.ctx.arc = (cx: number, cy: number, r: number, s: number, e: number) => {
      p8Xs.add(Math.round(cx));
      origArc8(cx, cy, r, s, e);
    };
    drawTileFace(p8.ctx as unknown as CanvasRenderingContext2D, '8p', {
      width: 200,
      height: 263,
    });
    expect([...p8Xs].sort((a, b) => a - b)).toEqual([64, 136]);

    // 發は藍黒 (#1e2736)、中は臙脂 (#632530)
    const hatsu = factory(200, 263);
    const hatsuFills: string[] = [];
    const origHatsuFill = hatsu.ctx.fill as (...args: unknown[]) => void;
    hatsu.ctx.fill = (...args: unknown[]) => {
      hatsuFills.push(String(hatsu.ctx.fillStyle).toLowerCase());
      origHatsuFill(...args);
    };
    drawTileFace(hatsu.ctx as unknown as CanvasRenderingContext2D, '6z', {
      width: 200,
      height: 263,
    });
    expect(hatsuFills.at(-1)).toBe(TILE_INK.ink.toLowerCase());

    const chun = factory(200, 263);
    const chunFills: string[] = [];
    const origChunFill = chun.ctx.fill as (...args: unknown[]) => void;
    chun.ctx.fill = (...args: unknown[]) => {
      chunFills.push(String(chun.ctx.fillStyle).toLowerCase());
      origChunFill(...args);
    };
    drawTileFace(chun.ctx as unknown as CanvasRenderingContext2D, '7z', {
      width: 200,
      height: 263,
    });
    expect(chunFills.at(-1)).toBe(TILE_INK.maroon.toLowerCase());
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

  it('canvas 2D が使えない環境ではスプライトシートを作らず null を返す（テキスト描画にフォールバック）', () => {
    // node 環境（document なし）なので canvas は作れない
    expect(createTileSpriteSheet({ cellHeight: 96 })).toBeNull();
  });

  it('スプライトシートは 37 枠（34 種 + 赤ドラ 3 種）を収める格子を持つ', () => {
    // 34 種 + 赤ドラ 3 種 = 37 枠。格子が足りないと最後の赤ドラがはみ出す
    expect(SPRITE_COLUMNS * SPRITE_ROWS).toBeGreaterThanOrEqual(
      createAtlasKeys(true).length,
    );
  });

  it('2索は縦2本、3索は上1本+下2本の対称配置で描画される', () => {
    const { factory } = createRecordingGlobal();

    const s2 = factory(200, 263);
    const s2Centers: Array<{ x: number; y: number }> = [];
    const origTranslate2 = s2.ctx.translate as (...args: unknown[]) => void;
    s2.ctx.translate = (x: number, y: number) => {
      s2Centers.push({ x, y });
      origTranslate2(x, y);
    };
    drawTileFace(s2.ctx as unknown as CanvasRenderingContext2D, '2s', {
      width: 200,
      height: 263,
    });
    expect(s2Centers).toHaveLength(2);
    expect(s2Centers[0]!.x).toBeCloseTo(s2Centers[1]!.x, 1);
    expect(s2Centers[0]!.y).toBeLessThan(263 * 0.4);
    expect(s2Centers[1]!.y).toBeGreaterThan(263 * 0.6);

    const s3 = factory(200, 263);
    const s3Centers: Array<{ x: number; y: number }> = [];
    const origTranslate3 = s3.ctx.translate as (...args: unknown[]) => void;
    s3.ctx.translate = (x: number, y: number) => {
      s3Centers.push({ x, y });
      origTranslate3(x, y);
    };
    drawTileFace(s3.ctx as unknown as CanvasRenderingContext2D, '3s', {
      width: 200,
      height: 263,
    });
    expect(s3Centers).toHaveLength(3);
    // 上段1本（中央）、下段2本（左右対称で下半分に配置）
    expect(s3Centers[0]!.x).toBeCloseTo(100, 1);
    expect(s3Centers[0]!.y).toBeLessThan(263 * 0.4);
    expect(s3Centers[1]!.y).toBeGreaterThan(263 * 0.6);
    expect(s3Centers[2]!.y).toBeGreaterThan(263 * 0.6);
    expect(s3Centers[1]!.y).toBeCloseTo(s3Centers[2]!.y, 1);
    expect(s3Centers[1]!.x + s3Centers[2]!.x).toBeCloseTo(200, 1);
  });

});

function drawnTexts(
  kind: TileKind,
  factory: ReturnType<typeof createRecordingGlobal>['factory'],
  created: ReturnType<typeof createRecordingGlobal>['created'],
  fontFamily?: string,
): string[] {
  const ctx = factory(200, 263).ctx;
  drawTileFace(ctx as unknown as CanvasRenderingContext2D, kind, {
    width: 200,
    height: 263,
    fontFamily,
  });
  return created
    .at(-1)!
    .ctx.calls.filter((call) => call.name === 'fillText')
    .map((call) => String(call.args[0]));
}
