/**
 * 牌テクスチャ生成（Canvas 2D）
 *
 * 実物の日本麻雀牌（藍黒・臙脂・赤ドラ・石入り赤五筒・孔雀一索・花模様一/二筒・
 * M/W型八索・中抜き節入り索子・筆文字萬子/字牌）の意匠に忠実に描画する。
 *
 *  1. 象牙〜磁器調の滑らかな素地（木目や過度な黄ばみなし）と丸みのある陰影
 *  2. OS / 端末フォントに左右されない内蔵筆文字パス（`tileGlyphs.ts`）で
 *     「一二三四伍六七八九萬」「東南西北發中」を統一描画（5萬は「伍萬」、白は無地）
 *  3. 配色: 藍黒 (#1e2736) × 臙脂 (#632530)、赤ドラは鮮紅 (#cf232e)（赤5筒中央は銀輝石）
 *  4. 1 枚のアトラス / DOM スプライトシート（7×6 = 37 枠）にまとめ、
 *     アスペクト比は `TILE_FACE_ASPECT` で統一する。
 */

import type { TileKind } from '../types/tile';
import {
  getCalligraphyGlyphTokens,
  traceCalligraphyGlyph,
} from './tileGlyphs';

/** 牌面の幅 / 高さ。3D 側の PlaneGeometry は必ずこの比で作る。 */
export const TILE_FACE_ASPECT = 0.76;

/** 赤ドラとして別セルを用意する牌種。 */
export const RED_FIVE_KINDS = ['5m', '5p', '5s'] as const;
export type RedFiveKind = (typeof RED_FIVE_KINDS)[number];

/** 牌面の色。実物写真（藍黒＋臙脂＋鮮紅赤ドラ＋清涼象牙素地）に準拠。 */
export const TILE_INK = {
  ivoryTop: '#faf9f5',
  ivoryMid: '#f3f1ea',
  ivoryBottom: '#e9e6dc',
  ivoryHole: '#f5f4ee',
  ink: '#1e2736',
  maroon: '#632530',
  maroonDark: '#4a1b24',
  red: '#cf232e',
  redDark: '#9e1720',
  backBase: '#14603c',
  backBaseDeep: '#0c3f27',
  backPattern: 'rgba(255, 255, 255, 0.10)',
  backFrame: '#d8c7a0',
} as const;

/** 明朝・楷書系のフォントスタック。明示指定時のフォールバックに使用する。 */
export const DEFAULT_FONT_FAMILY =
  '"Hiragino Mincho ProN", "Yu Mincho", "YuMincho", "Noto Serif JP", "Noto Serif CJK JP", "Songti SC", "MS PMincho", serif';

const TAU = Math.PI * 2;

// --------------------------------------------------
// canvas 生成の抽象化
// --------------------------------------------------

export interface CanvasWithContext {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
}

/** canvas の生成方法。Node やテストでは自前の実装を差し込める。 */
export type Canvas2DFactory = (width: number, height: number) => CanvasWithContext;

export const domCanvasFactory: Canvas2DFactory = (width, height) => {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('2D コンテキストを取得できませんでした');
  }
  return { canvas, ctx };
};

/**
 * 牌面用フォントの読み込みを待つ。
 * 通常描画は内蔵ベクターグリフを使うためフォント待機なしでも崩れないが、
 * フォールバック文字描画や外部指定フォント向けに互換維持している。
 */
export async function waitForTileFonts(fontFamily = DEFAULT_FONT_FAMILY): Promise<void> {
  if (typeof document === 'undefined' || !document.fonts) return;
  const sample = '萬東南發中一伍';
  try {
    await Promise.all([
      document.fonts.load(`700 64px ${fontFamily}`, sample),
      document.fonts.load(`700 64px serif`, sample),
    ]);
    await document.fonts.ready;
  } catch {
    // フォント読み込みに失敗しても描画自体は続行できる
  }
}

// --------------------------------------------------
// 描画ヘルパー
// --------------------------------------------------

interface FaceDrawContext {
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
  fontFamily: string;
  useCustomFont: boolean;
}

function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

/** 滑らかな象牙白磁素地と緩やかな丸み陰影。 */
function drawIvoryBase({ ctx, width: w, height: h }: FaceDrawContext): void {
  const bg = ctx.createLinearGradient(0, 0, w * 0.35, h);
  bg.addColorStop(0, TILE_INK.ivoryTop);
  bg.addColorStop(0.55, TILE_INK.ivoryMid);
  bg.addColorStop(1, TILE_INK.ivoryBottom);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  // 牌面周縁のわずかな丸み（ドーム状の立体感）
  const inset = ctx.createRadialGradient(
    w * 0.48,
    h * 0.42,
    Math.min(w, h) * 0.25,
    w * 0.5,
    h * 0.5,
    Math.max(w, h) * 0.78,
  );
  inset.addColorStop(0, 'rgba(255, 255, 255, 0.14)');
  inset.addColorStop(0.7, 'rgba(255, 255, 255, 0)');
  inset.addColorStop(1, 'rgba(95, 92, 82, 0.13)');
  ctx.fillStyle = inset;
  ctx.fillRect(0, 0, w, h);

  // 上端・左端の柔らかいハイライト縁
  const rimInset = Math.max(1, w * 0.025);
  roundRectPath(
    ctx,
    rimInset,
    rimInset,
    w - rimInset * 2,
    h - rimInset * 2,
    Math.min(w, h) * 0.08,
  );
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.48)';
  ctx.lineWidth = Math.max(0.8, w * 0.014);
  ctx.stroke();
}

interface GlyphScale {
  sx?: number;
  sy?: number;
}

const GLYPH_PROPORTIONS: Record<string, GlyphScale> = {
  一: { sx: 1.18, sy: 0.96 },
  二: { sx: 1.15, sy: 0.9 },
  三: { sx: 1.14, sy: 0.94 },
  四: { sx: 1.12, sy: 0.94 },
  伍: { sx: 1.08, sy: 1.02 },
  六: { sx: 1.08, sy: 0.98 },
  七: { sx: 1.05, sy: 0.96 },
  八: { sx: 1.12, sy: 0.94 },
  九: { sx: 1.08, sy: 1.02 },
  萬: { sx: 1.12, sy: 0.96 },
  東: { sx: 1.02, sy: 1.06 },
  南: { sx: 1.04, sy: 1.04 },
  西: { sx: 1.08, sy: 0.98 },
  北: { sx: 1.06, sy: 1.0 },
  發: { sx: 1.04, sy: 1.04 },
  中: { sx: 0.96, sy: 1.18 },
};

/** 彫刻風に筆文字を描く（内蔵筆文字パス優先、カスタムフォント指定時のみ fillText）。 */
function drawEngravedGlyph(
  face: FaceDrawContext,
  glyph: string,
  cx: number,
  cy: number,
  sizePx: number,
  color: string,
): void {
  const { ctx } = face;
  const depth = Math.max(0.7, sizePx * 0.015);
  const prop = GLYPH_PROPORTIONS[glyph];
  const sx = sizePx * (prop?.sx ?? 1);
  const sy = sizePx * (prop?.sy ?? 1);

  const tokens = !face.useCustomFont ? getCalligraphyGlyphTokens(glyph) : undefined;
  if (tokens) {
    ctx.save();
    // 彫り底面の微かなハイライト（右下縁に光が当たる質感）
    traceCalligraphyGlyph(ctx, tokens, cx + depth * 0.75, cy + depth * 0.75, sx, sy);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.58)';
    ctx.fill();

    // 左上側の彫り影
    traceCalligraphyGlyph(ctx, tokens, cx - depth * 0.45, cy - depth * 0.45, sx, sy);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.22)';
    ctx.fill();

    // 本体インク
    traceCalligraphyGlyph(ctx, tokens, cx, cy, sx, sy);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.restore();
    return;
  }

  ctx.save();
  ctx.font = `700 ${sizePx}px ${face.fontFamily}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
  ctx.fillText(glyph, cx + depth * 0.75, cy + depth * 0.75);

  ctx.fillStyle = 'rgba(0, 0, 0, 0.2)';
  ctx.fillText(glyph, cx - depth * 0.45, cy - depth * 0.45);

  ctx.fillStyle = color;
  ctx.fillText(glyph, cx, cy);
  ctx.restore();
}

/** 萬子の基準位置（数字を大きく上段に、萬を下段に堂々と配置） */
function stackedGlyphPositions(face: FaceDrawContext): { top: number; bottom: number } {
  return { top: face.height * 0.255, bottom: face.height * 0.695 };
}

/** 5萬は実物写真どおり「伍」を使用 */
const KANJI_NUMBERS = ['', '一', '二', '三', '四', '伍', '六', '七', '八', '九'] as const;
const HONOR_GLYPHS: Record<string, string> = {
  '1z': '東',
  '2z': '南',
  '3z': '西',
  '4z': '北',
  '5z': '', // 白は無地
  '6z': '發',
  '7z': '中',
};

// --------------------------------------------------
// 筒子（ピンズ）: 花柄 1/2筒・分割リング 3..9筒・石入り赤5筒
// --------------------------------------------------

type PipTone = 'navy' | 'maroon' | 'red';

interface PipSpec {
  x: number; // 0..1（牌面幅に対する比率）
  y: number; // 0..1（牌面高さに対する比率）
  tone: PipTone;
}

const PINZU_LAYOUTS: Record<number, PipSpec[]> = {
  3: [
    { x: 0.26, y: 0.215, tone: 'navy' },
    { x: 0.5, y: 0.5, tone: 'maroon' },
    { x: 0.74, y: 0.785, tone: 'navy' },
  ],
  4: [
    { x: 0.29, y: 0.28, tone: 'navy' },
    { x: 0.71, y: 0.28, tone: 'navy' },
    { x: 0.29, y: 0.72, tone: 'navy' },
    { x: 0.71, y: 0.72, tone: 'navy' },
  ],
  5: [
    { x: 0.27, y: 0.26, tone: 'navy' },
    { x: 0.73, y: 0.26, tone: 'navy' },
    { x: 0.5, y: 0.5, tone: 'maroon' },
    { x: 0.27, y: 0.74, tone: 'navy' },
    { x: 0.73, y: 0.74, tone: 'navy' },
  ],
  6: [
    // 上2つ藍黒 + 下2×2臙脂ブロック
    { x: 0.32, y: 0.22, tone: 'navy' },
    { x: 0.68, y: 0.22, tone: 'navy' },
    { x: 0.335, y: 0.57, tone: 'maroon' },
    { x: 0.665, y: 0.57, tone: 'maroon' },
    { x: 0.335, y: 0.805, tone: 'maroon' },
    { x: 0.665, y: 0.805, tone: 'maroon' },
  ],
  7: [
    // 上斜め3つ藍黒 + 下2×2臙脂ブロック
    { x: 0.22, y: 0.18, tone: 'navy' },
    { x: 0.5, y: 0.27, tone: 'navy' },
    { x: 0.78, y: 0.36, tone: 'navy' },
    { x: 0.34, y: 0.59, tone: 'maroon' },
    { x: 0.66, y: 0.59, tone: 'maroon' },
    { x: 0.34, y: 0.81, tone: 'maroon' },
    { x: 0.66, y: 0.81, tone: 'maroon' },
  ],
  8: [
    // 2列×4段（すべて藍黒）
    { x: 0.32, y: 0.175, tone: 'navy' },
    { x: 0.68, y: 0.175, tone: 'navy' },
    { x: 0.32, y: 0.391, tone: 'navy' },
    { x: 0.68, y: 0.391, tone: 'navy' },
    { x: 0.32, y: 0.608, tone: 'navy' },
    { x: 0.68, y: 0.608, tone: 'navy' },
    { x: 0.32, y: 0.825, tone: 'navy' },
    { x: 0.68, y: 0.825, tone: 'navy' },
  ],
  9: [
    // 3×3（上段藍黒・中段臙脂・下段藍黒）
    { x: 0.225, y: 0.2, tone: 'navy' },
    { x: 0.5, y: 0.2, tone: 'navy' },
    { x: 0.775, y: 0.2, tone: 'navy' },
    { x: 0.225, y: 0.5, tone: 'maroon' },
    { x: 0.5, y: 0.5, tone: 'maroon' },
    { x: 0.775, y: 0.5, tone: 'maroon' },
    { x: 0.225, y: 0.8, tone: 'navy' },
    { x: 0.5, y: 0.8, tone: 'navy' },
    { x: 0.775, y: 0.8, tone: 'navy' },
  ],
};

function pipColors(tone: PipTone): { outer: string; inner: string } {
  if (tone === 'red') {
    return { outer: TILE_INK.red, inner: TILE_INK.red };
  }
  if (tone === 'maroon') {
    return { outer: TILE_INK.ink, inner: TILE_INK.maroon };
  }
  return { outer: TILE_INK.ink, inner: TILE_INK.ink };
}

/** 3〜9筒の標準的（外輪 + 白隙 + 5分割輪 + 白隙 + 中心点）。 */
function drawPinPip(
  { ctx }: FaceDrawContext,
  cx: number,
  cy: number,
  radius: number,
  tone: PipTone,
): void {
  const { outer, inner } = pipColors(tone);

  // 外周の輪
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, TAU);
  ctx.fillStyle = outer;
  ctx.fill();

  // 外側の白い隙間
  ctx.beginPath();
  ctx.arc(cx, cy, radius * 0.78, 0, TAU);
  ctx.fillStyle = TILE_INK.ivoryHole;
  ctx.fill();

  // 中間の色リング（5分割されるリング本体）
  ctx.beginPath();
  ctx.arc(cx, cy, radius * 0.67, 0, TAU);
  ctx.fillStyle = inner;
  ctx.fill();

  // 5本の放射状の白ノッチ（写真特有の破線リング表現）
  ctx.save();
  ctx.strokeStyle = TILE_INK.ivoryHole;
  ctx.lineWidth = Math.max(0.8, radius * 0.11);
  for (let i = 0; i < 5; i += 1) {
    const angle = -Math.PI / 2 + (i * TAU) / 5;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(angle) * radius * 0.34, cy + Math.sin(angle) * radius * 0.34);
    ctx.lineTo(cx + Math.cos(angle) * radius * 0.72, cy + Math.sin(angle) * radius * 0.72);
    ctx.stroke();
  }
  ctx.restore();

  // 内側の白い隙間
  ctx.beginPath();
  ctx.arc(cx, cy, radius * 0.39, 0, TAU);
  ctx.fillStyle = TILE_INK.ivoryHole;
  ctx.fill();

  // 中心の丸 + 極小の白芯
  ctx.beginPath();
  ctx.arc(cx, cy, radius * 0.23, 0, TAU);
  ctx.fillStyle = inner;
  ctx.fill();

  ctx.beginPath();
  ctx.arc(cx, cy, radius * 0.085, 0, TAU);
  ctx.fillStyle = TILE_INK.ivoryHole;
  ctx.fill();
}

/** 1筒: 伝統的な花輪模様（藍黒外周＋花弁連珠＋臙脂内輪＋6弁花心）。 */
function drawPinzuOne(face: FaceDrawContext): void {
  const { ctx, width: w, height: h } = face;
  const cx = w * 0.5;
  const cy = h * 0.5;
  const r = Math.min(w, h) * 0.38;

  // 最外周の藍黒リング
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, TAU);
  ctx.fillStyle = TILE_INK.ink;
  ctx.fill();

  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.87, 0, TAU);
  ctx.fillStyle = TILE_INK.ivoryHole;
  ctx.fill();

  // 外側花弁帯（16連の鉤状花弁）
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.82, 0, TAU);
  ctx.fillStyle = TILE_INK.ink;
  ctx.fill();

  const petals = 16;
  for (let i = 0; i < petals; i += 1) {
    const a = (i * TAU) / petals;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(a);
    // 鉤形の白抜き（写真の渦巻き花模様）
    ctx.fillStyle = TILE_INK.ivoryHole;
    ctx.beginPath();
    ctx.ellipse(r * 0.69, 0, r * 0.068, r * 0.048, 0.3, 0, TAU);
    ctx.fill();

    ctx.strokeStyle = TILE_INK.ivoryHole;
    ctx.lineWidth = Math.max(0.7, r * 0.036);
    ctx.beginPath();
    ctx.moveTo(r * 0.6, -r * 0.055);
    ctx.lineTo(r * 0.77, -r * 0.055);
    ctx.stroke();
    ctx.restore();
  }

  // 白輪の区切り
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.55, 0, TAU);
  ctx.fillStyle = TILE_INK.ivoryHole;
  ctx.fill();

  // 臙脂の連珠内輪
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.51, 0, TAU);
  ctx.fillStyle = TILE_INK.maroon;
  ctx.fill();

  const innerBeads = 16;
  ctx.fillStyle = TILE_INK.ivoryHole;
  for (let i = 0; i < innerBeads; i += 1) {
    const a = (i * TAU) / innerBeads;
    ctx.beginPath();
    ctx.arc(
      cx + Math.cos(a) * r * 0.425,
      cy + Math.sin(a) * r * 0.425,
      r * 0.028,
      0,
      TAU,
    );
    ctx.fill();
  }

  // 中心の白輪と6本輻の臙脂花車輪
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.3, 0, TAU);
  ctx.fillStyle = TILE_INK.ivoryHole;
  ctx.fill();

  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.24, 0, TAU);
  ctx.strokeStyle = TILE_INK.maroon;
  ctx.lineWidth = Math.max(0.8, r * 0.045);
  ctx.stroke();

  ctx.save();
  ctx.strokeStyle = TILE_INK.maroon;
  ctx.lineWidth = Math.max(0.7, r * 0.036);
  for (let i = 0; i < 6; i += 1) {
    const a = (i * TAU) / 6;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(a) * r * 0.24, cy + Math.sin(a) * r * 0.24);
    ctx.stroke();
  }
  ctx.restore();

  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.075, 0, TAU);
  ctx.fillStyle = TILE_INK.maroon;
  ctx.fill();

  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.03, 0, TAU);
  ctx.fillStyle = TILE_INK.ivoryHole;
  ctx.fill();
}

/** 2筒の8弁花柄メダリオン 1 個。 */
function drawPinzuTwoFlower(
  { ctx }: FaceDrawContext,
  cx: number,
  cy: number,
  radius: number,
): void {
  // 外輪
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, TAU);
  ctx.fillStyle = TILE_INK.ink;
  ctx.fill();

  ctx.beginPath();
  ctx.arc(cx, cy, radius * 0.85, 0, TAU);
  ctx.fillStyle = TILE_INK.ivoryHole;
  ctx.fill();

  // 花盤（藍黒地）
  ctx.beginPath();
  ctx.arc(cx, cy, radius * 0.77, 0, TAU);
  ctx.fillStyle = TILE_INK.ink;
  ctx.fill();

  // 8枚の涙滴形花弁を白抜き
  const petals = 8;
  for (let i = 0; i < petals; i += 1) {
    const a = (i * TAU) / petals;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(a);
    ctx.fillStyle = TILE_INK.ivoryHole;
    ctx.beginPath();
    ctx.ellipse(radius * 0.49, 0, radius * 0.18, radius * 0.085, 0, 0, TAU);
    ctx.fill();

    // 花弁の内側に藍黒の細脈
    ctx.fillStyle = TILE_INK.ink;
    ctx.beginPath();
    ctx.ellipse(radius * 0.51, 0, radius * 0.11, radius * 0.032, 0, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  // 中心の藍黒小輪 + 白穴
  ctx.beginPath();
  ctx.arc(cx, cy, radius * 0.22, 0, TAU);
  ctx.fillStyle = TILE_INK.ink;
  ctx.fill();

  ctx.beginPath();
  ctx.arc(cx, cy, radius * 0.1, 0, TAU);
  ctx.fillStyle = TILE_INK.ivoryHole;
  ctx.fill();
}

/** 赤5筒中央の輝き石（ファセットカット・ラインストーン）。 */
function drawPinzuGem(
  { ctx }: FaceDrawContext,
  cx: number,
  cy: number,
  radius: number,
): void {
  // 台座の金属影輪
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, TAU);
  ctx.fillStyle = '#6f6554';
  ctx.fill();

  ctx.beginPath();
  ctx.arc(cx, cy, radius * 0.9, 0, TAU);
  ctx.fillStyle = '#d4ccb8';
  ctx.fill();

  // 8方向のファセット三角形
  const facets = 8;
  const facetColors = [
    '#ffffff',
    '#b8ae99',
    '#7c725f',
    '#f5f2ea',
    '#8c826e',
    '#e8e2d3',
    '#a39985',
    '#fffef9',
  ];
  for (let i = 0; i < facets; i += 1) {
    const a0 = (i * TAU) / facets - Math.PI / 8;
    const a1 = ((i + 1) * TAU) / facets - Math.PI / 8;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(a0) * radius * 0.88, cy + Math.sin(a0) * radius * 0.88);
    ctx.lineTo(cx + Math.cos(a1) * radius * 0.88, cy + Math.sin(a1) * radius * 0.88);
    ctx.closePath();
    ctx.fillStyle = facetColors[i % facetColors.length]!;
    ctx.fill();
  }

  // 中央のテーブル面（八角風の輝き）
  const tableGrad = ctx.createRadialGradient(
    cx - radius * 0.16,
    cy - radius * 0.16,
    radius * 0.05,
    cx,
    cy,
    radius * 0.52,
  );
  tableGrad.addColorStop(0, '#ffffff');
  tableGrad.addColorStop(0.5, '#ece5d4');
  tableGrad.addColorStop(1, '#9c927d');
  ctx.beginPath();
  ctx.arc(cx, cy, radius * 0.48, 0, TAU);
  ctx.fillStyle = tableGrad;
  ctx.fill();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.78)';
  ctx.lineWidth = Math.max(0.6, radius * 0.05);
  ctx.stroke();

  // 左上の強い反射光点
  ctx.beginPath();
  ctx.arc(cx - radius * 0.22, cy - radius * 0.22, radius * 0.15, 0, TAU);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
}

function drawPinzu(face: FaceDrawContext, n: number, redFive: boolean): void {
  if (n === 1) {
    drawPinzuOne(face);
    return;
  }

  if (n === 2) {
    const r = face.width * 0.232;
    drawPinzuTwoFlower(face, face.width * 0.5, face.height * 0.275, r);
    drawPinzuTwoFlower(face, face.width * 0.5, face.height * 0.725, r);
    return;
  }

  if (n === 5 && redFive) {
    const r = face.width * 0.148;
    const corners = [
      { x: 0.27, y: 0.26 },
      { x: 0.73, y: 0.26 },
      { x: 0.27, y: 0.74 },
      { x: 0.73, y: 0.74 },
    ];
    for (const p of corners) {
      drawPinPip(face, face.width * p.x, face.height * p.y, r, 'red');
    }
    drawPinzuGem(face, face.width * 0.5, face.height * 0.5, face.width * 0.142);
    return;
  }

  const layout = PINZU_LAYOUTS[n];
  if (!layout) return;

  const radiusByCount: Record<number, number> = {
    3: face.width * 0.145,
    4: face.width * 0.16,
    5: face.width * 0.148,
    6: face.width * 0.146,
    7: face.width * 0.136,
    8: face.width * 0.122,
    9: face.width * 0.124,
  };
  const radius = radiusByCount[n] ?? face.width * 0.13;

  for (const pip of layout) {
    drawPinPip(face, face.width * pip.x, face.height * pip.y, radius, pip.tone);
  }
}

// --------------------------------------------------
// 索子（ソーズ）: 中抜き節入り竹・M/W型8索・孔雀1索
// --------------------------------------------------

interface StickSpec {
  x: number;
  y: number;
  tone?: 'navy' | 'maroon';
  angle?: number;
  heightScale?: number;
}

const SOUZU_LAYOUTS: Record<number, StickSpec[]> = {
  2: [
    { x: 0.5, y: 0.285 },
    { x: 0.5, y: 0.715 },
  ],
  3: [
    { x: 0.5, y: 0.285 },
    { x: 0.29, y: 0.715 },
    { x: 0.71, y: 0.715 },
  ],
  4: [
    { x: 0.3, y: 0.285 },
    { x: 0.7, y: 0.285 },
    { x: 0.3, y: 0.715 },
    { x: 0.7, y: 0.715 },
  ],
  5: [
    { x: 0.26, y: 0.275 },
    { x: 0.74, y: 0.275 },
    { x: 0.5, y: 0.5, tone: 'maroon' },
    { x: 0.26, y: 0.725 },
    { x: 0.74, y: 0.725 },
  ],
  6: [
    { x: 0.23, y: 0.285 },
    { x: 0.5, y: 0.285 },
    { x: 0.77, y: 0.285 },
    { x: 0.23, y: 0.715 },
    { x: 0.5, y: 0.715 },
    { x: 0.77, y: 0.715 },
  ],
  7: [
    { x: 0.5, y: 0.205, tone: 'maroon' },
    { x: 0.23, y: 0.505 },
    { x: 0.5, y: 0.505 },
    { x: 0.77, y: 0.505 },
    { x: 0.23, y: 0.8 },
    { x: 0.5, y: 0.8 },
    { x: 0.77, y: 0.8 },
  ],
  8: [
    // 写真通りの W/M 型8索（斜め2本を描いてから左右の縦棒を重ねる）
    // 上段: ∧ 型（中央上で出会う斜め2本）+ 左右縦棒
    { x: 0.365, y: 0.305, angle: 0.92, heightScale: 0.9 },
    { x: 0.635, y: 0.305, angle: -0.92, heightScale: 0.9 },
    { x: 0.215, y: 0.285 },
    { x: 0.785, y: 0.285 },
    // 下段: ∨ 型（中央下で出会う斜め2本）+ 左右縦棒
    { x: 0.365, y: 0.695, angle: -0.92, heightScale: 0.9 },
    { x: 0.635, y: 0.695, angle: 0.92, heightScale: 0.9 },
    { x: 0.215, y: 0.715 },
    { x: 0.785, y: 0.715 },
  ],
  9: [
    // 左・右列が藍黒、中央列が臙脂
    { x: 0.23, y: 0.205 },
    { x: 0.5, y: 0.205, tone: 'maroon' },
    { x: 0.77, y: 0.205 },
    { x: 0.23, y: 0.5 },
    { x: 0.5, y: 0.5, tone: 'maroon' },
    { x: 0.77, y: 0.5 },
    { x: 0.23, y: 0.795 },
    { x: 0.5, y: 0.795, tone: 'maroon' },
    { x: 0.77, y: 0.795 },
  ],
};

/** 日本牌特有の中抜き彫刻竹（上下横帽＋中央節膨らみ＋縦中抜き溝）。 */
function drawBambooStick(
  { ctx }: FaceDrawContext,
  cx: number,
  cy: number,
  widthPx: number,
  heightPx: number,
  color: string,
  angle = 0,
): void {
  const halfW = widthPx / 2;
  const halfH = heightPx / 2;
  const holeColor = TILE_INK.ivoryHole;

  ctx.save();
  ctx.translate(cx, cy);
  if (angle !== 0) {
    ctx.rotate(angle);
  }

  // 外形輪郭（濃い枠）
  ctx.fillStyle = color;

  // 縦軸本体
  roundRectPath(ctx, -halfW * 0.74, -halfH * 0.92, widthPx * 0.74, heightPx * 0.92, halfW * 0.35);
  ctx.fill();

  // 上下の張出し横帽
  const capW = widthPx * 1.14;
  const capH = heightPx * 0.18;
  roundRectPath(ctx, -capW / 2, -halfH, capW, capH, capH * 0.48);
  ctx.fill();
  roundRectPath(ctx, -capW / 2, halfH - capH, capW, capH, capH * 0.48);
  ctx.fill();

  // 中央の節（ふっくらした楕円リング）
  const nodeW = widthPx * 1.1;
  const nodeH = heightPx * 0.25;
  ctx.beginPath();
  ctx.ellipse(0, 0, nodeW / 2, nodeH / 2, 0, 0, TAU);
  ctx.fill();

  // 節の左右の横張り線
  const barW = widthPx * 1.2;
  const barH = Math.max(1.2, heightPx * 0.045);
  roundRectPath(ctx, -barW / 2, -barH / 2, barW, barH, barH / 2);
  ctx.fill();

  // 内側の白い中抜き溝（実物竹牌のくっきりした二本柱）
  ctx.fillStyle = holeColor;
  const channelW = widthPx * 0.32;
  const channelH = heightPx * 0.26;
  roundRectPath(ctx, -channelW / 2, -halfH + capH * 0.72, channelW, channelH, channelW * 0.48);
  ctx.fill();
  roundRectPath(
    ctx,
    -channelW / 2,
    halfH - capH * 0.72 - channelH,
    channelW,
    channelH,
    channelW * 0.48,
  );
  ctx.fill();

  // 中央節の白い中抜き穴
  ctx.beginPath();
  ctx.ellipse(0, 0, widthPx * 0.22, heightPx * 0.072, 0, 0, TAU);
  ctx.fill();

  // 上下の帽の細い白スリット（立体的な彫り感）
  const slitW = widthPx * 0.48;
  const slitH = Math.max(0.8, heightPx * 0.032);
  roundRectPath(ctx, -slitW / 2, -halfH + capH * 0.36, slitW, slitH, slitH / 2);
  ctx.fill();
  roundRectPath(ctx, -slitW / 2, halfH - capH * 0.36 - slitH, slitW, slitH, slitH / 2);
  ctx.fill();

  ctx.restore();
}

/** 1索: 写真の伝統孔雀（上段の放射線＋丸紋尾羽＋下段の羽ばたく鳥＋二本足）。 */
function drawSouzuBird(face: FaceDrawContext): void {
  const { ctx, width: w, height: h } = face;

  // --- 1. 上段の放射線（孔雀の飾り羽根の光線） ---
  const plumeCx = w * 0.51;
  const plumeCy = h * 0.31;
  ctx.save();
  ctx.strokeStyle = TILE_INK.ink;
  ctx.lineWidth = Math.max(0.8, w * 0.016);
  ctx.lineCap = 'round';

  const rayCount = 24;
  for (let i = 0; i < rayCount; i += 1) {
    const t = i / (rayCount - 1);
    const angle = -Math.PI * 1.06 + t * Math.PI * 1.12;
    const innerR = w * 0.23;
    const outerR = w * (0.37 + (i % 2 === 0 ? 0.04 : 0.01));
    ctx.beginPath();
    ctx.moveTo(plumeCx + Math.cos(angle) * innerR, plumeCy + Math.sin(angle) * innerR * 1.08);
    ctx.lineTo(plumeCx + Math.cos(angle) * outerR, plumeCy + Math.sin(angle) * outerR * 1.12);
    ctx.stroke();
  }
  ctx.restore();

  // --- 2. 上段の孔雀の丸紋（11個の目玉模様の束） ---
  const plumes: Array<{ x: number; y: number; r: number }> = [
    { x: 0.5, y: 0.21, r: 0.056 },
    { x: 0.37, y: 0.25, r: 0.054 },
    { x: 0.63, y: 0.25, r: 0.054 },
    { x: 0.49, y: 0.305, r: 0.058 },
    { x: 0.34, y: 0.34, r: 0.055 },
    { x: 0.66, y: 0.34, r: 0.055 },
    { x: 0.43, y: 0.39, r: 0.055 },
    { x: 0.57, y: 0.39, r: 0.055 },
    { x: 0.37, y: 0.455, r: 0.052 },
    { x: 0.5, y: 0.465, r: 0.054 },
    { x: 0.63, y: 0.455, r: 0.052 },
  ];

  // 丸紋背景を白く整えてから目玉紋を描く
  for (const p of plumes) {
    const px = w * p.x;
    const py = h * p.y;
    const pr = w * p.r;
    ctx.beginPath();
    ctx.arc(px, py, pr * 1.05, 0, TAU);
    ctx.fillStyle = TILE_INK.ivoryHole;
    ctx.fill();

    ctx.beginPath();
    ctx.arc(px, py, pr, 0, TAU);
    ctx.fillStyle = TILE_INK.ink;
    ctx.fill();

    ctx.beginPath();
    ctx.arc(px, py, pr * 0.55, 0, TAU);
    ctx.fillStyle = TILE_INK.ivoryHole;
    ctx.fill();

    ctx.beginPath();
    ctx.arc(px, py, pr * 0.24, 0, TAU);
    ctx.fillStyle = TILE_INK.ink;
    ctx.fill();
  }

  // --- 3. 鳥の両脇に跳ねる装飾小線 ---
  ctx.save();
  ctx.strokeStyle = TILE_INK.ink;
  ctx.lineWidth = Math.max(0.8, w * 0.018);
  ctx.lineCap = 'round';
  // 左の飛沫線
  ctx.beginPath();
  ctx.moveTo(w * 0.2, h * 0.53);
  ctx.lineTo(w * 0.33, h * 0.6);
  ctx.moveTo(w * 0.19, h * 0.59);
  ctx.lineTo(w * 0.29, h * 0.62);
  // 右の飛沫線
  ctx.moveTo(w * 0.8, h * 0.53);
  ctx.lineTo(w * 0.67, h * 0.6);
  ctx.moveTo(w * 0.81, h * 0.59);
  ctx.lineTo(w * 0.71, h * 0.62);
  ctx.stroke();
  ctx.restore();

  // --- 4. 左右に広げた翼（横縞入り扇翼） ---
  const drawWing = (dir: -1 | 1) => {
    ctx.save();
    const ox = w * (0.5 + dir * 0.08);
    const oy = h * 0.67;
    ctx.beginPath();
    ctx.moveTo(ox, oy - h * 0.02);
    ctx.quadraticCurveTo(w * (0.5 + dir * 0.32), h * 0.6, w * (0.5 + dir * 0.37), h * 0.755);
    ctx.lineTo(w * (0.5 + dir * 0.1), h * 0.745);
    ctx.closePath();
    ctx.fillStyle = TILE_INK.ivoryHole;
    ctx.fill();
    ctx.strokeStyle = TILE_INK.ink;
    ctx.lineWidth = Math.max(1, w * 0.022);
    ctx.stroke();

    // 翼内の羽根区切り線
    ctx.lineWidth = Math.max(0.8, w * 0.016);
    for (const frac of [0.35, 0.62, 0.84]) {
      ctx.beginPath();
      ctx.moveTo(w * (0.5 + dir * (0.09 + frac * 0.24)), h * (0.66 + frac * 0.03));
      ctx.lineTo(w * (0.5 + dir * (0.1 + frac * 0.24)), h * 0.765);
      ctx.stroke();
    }
    // 横段線
    for (const ry of [0.695, 0.73]) {
      ctx.beginPath();
      ctx.moveTo(w * (0.5 + dir * 0.11), h * ry);
      ctx.lineTo(w * (0.5 + dir * 0.33), h * (ry + 0.015));
      ctx.stroke();
    }
    ctx.restore();
  };
  drawWing(-1);
  drawWing(1);

  // --- 5. 首・胴体・頭（左向きに首をもたげる孔雀の体） ---
  ctx.save();
  // 胴体の白抜き下地
  ctx.beginPath();
  ctx.ellipse(w * 0.5, h * 0.71, w * 0.11, h * 0.115, 0, 0, TAU);
  ctx.fillStyle = TILE_INK.ivoryHole;
  ctx.fill();

  // S字の首と胴の太輪郭
  ctx.strokeStyle = TILE_INK.ink;
  ctx.lineWidth = Math.max(1.2, w * 0.026);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(w * 0.44, h * 0.62);
  ctx.bezierCurveTo(w * 0.39, h * 0.72, w * 0.44, h * 0.79, w * 0.52, h * 0.79);
  ctx.bezierCurveTo(w * 0.59, h * 0.79, w * 0.6, h * 0.69, w * 0.55, h * 0.63);
  ctx.stroke();

  // 胸の臙脂アクセント（写真でも首元〜胸に赤み）
  ctx.strokeStyle = TILE_INK.maroon;
  ctx.lineWidth = Math.max(1, w * 0.02);
  ctx.beginPath();
  ctx.moveTo(w * 0.47, h * 0.67);
  ctx.quadraticCurveTo(w * 0.5, h * 0.74, w * 0.55, h * 0.71);
  ctx.stroke();

  // 頭（右寄りに頭・左向き嘴）
  ctx.beginPath();
  ctx.arc(w * 0.51, h * 0.6, w * 0.068, 0, TAU);
  ctx.fillStyle = TILE_INK.ink;
  ctx.fill();

  // 目
  ctx.beginPath();
  ctx.arc(w * 0.49, h * 0.595, w * 0.022, 0, TAU);
  ctx.fillStyle = TILE_INK.ivoryHole;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(w * 0.488, h * 0.595, w * 0.01, 0, TAU);
  ctx.fillStyle = TILE_INK.ink;
  ctx.fill();

  // 嘴（左斜め上）
  ctx.beginPath();
  ctx.moveTo(w * 0.445, h * 0.585);
  ctx.lineTo(w * 0.37, h * 0.57);
  ctx.lineTo(w * 0.445, h * 0.615);
  ctx.closePath();
  ctx.fillStyle = TILE_INK.ink;
  ctx.fill();

  // --- 6. 二本足と爪 ---
  ctx.strokeStyle = TILE_INK.ink;
  ctx.lineWidth = Math.max(1, w * 0.022);
  for (const lx of [w * 0.455, w * 0.545]) {
    ctx.beginPath();
    ctx.moveTo(lx, h * 0.79);
    ctx.lineTo(lx, h * 0.875);
    ctx.moveTo(lx - w * 0.055, h * 0.89);
    ctx.lineTo(lx, h * 0.875);
    ctx.lineTo(lx + w * 0.045, h * 0.89);
    ctx.stroke();
  }
  ctx.restore();
}

function drawSouzu(face: FaceDrawContext, n: number, redFive: boolean): void {
  if (n === 1) {
    drawSouzuBird(face);
    return;
  }

  const layout = SOUZU_LAYOUTS[n];
  if (!layout) return;

  const stickSizeByCount: Record<number, { w: number; h: number }> = {
    2: { w: face.width * 0.21, h: face.height * 0.34 },
    3: { w: face.width * 0.2, h: face.height * 0.33 },
    4: { w: face.width * 0.2, h: face.height * 0.33 },
    5: { w: face.width * 0.19, h: face.height * 0.315 },
    6: { w: face.width * 0.185, h: face.height * 0.33 },
    7: { w: face.width * 0.175, h: face.height * 0.235 },
    8: { w: face.width * 0.165, h: face.height * 0.3 },
    9: { w: face.width * 0.175, h: face.height * 0.235 },
  };
  const baseSize = stickSizeByCount[n] ?? { w: face.width * 0.18, h: face.height * 0.25 };

  for (const stick of layout) {
    const color = redFive
      ? TILE_INK.red
      : stick.tone === 'maroon'
        ? TILE_INK.maroon
        : TILE_INK.ink;
    drawBambooStick(
      face,
      face.width * stick.x,
      face.height * stick.y,
      baseSize.w,
      baseSize.h * (stick.heightScale ?? 1),
      color,
      stick.angle ?? 0,
    );
  }
}

// --------------------------------------------------
// 牌面 1 枚
// --------------------------------------------------

export interface TileFaceDrawOptions {
  /** 牌面の幅（px）。height / width は TILE_FACE_ASPECT に合わせる。 */
  width: number;
  height: number;
  fontFamily?: string;
  /** 赤ドラ（5萬・5筒・5索）として描く */
  isRed?: boolean;
}

/** 牌面を 1 枚描く。ctx は (0,0)-(width,height) に描画する前提。 */
export function drawTileFace(
  ctx: CanvasRenderingContext2D,
  kind: TileKind,
  options: TileFaceDrawOptions,
): void {
  const face: FaceDrawContext = {
    ctx,
    width: options.width,
    height: options.height,
    fontFamily: options.fontFamily ?? DEFAULT_FONT_FAMILY,
    useCustomFont: options.fontFamily !== undefined,
  };

  drawIvoryBase(face);

  const suit = kind[1] as 'm' | 'p' | 's' | 'z';
  const n = Number(kind[0]);
  const redFive = Boolean(options.isRed) && n === 5;

  if (suit === 'm') {
    const { top, bottom } = stackedGlyphPositions(face);
    drawEngravedGlyph(
      face,
      KANJI_NUMBERS[n] ?? String(n),
      face.width * 0.5,
      top,
      face.height * 0.41,
      redFive ? TILE_INK.red : TILE_INK.ink,
    );
    drawEngravedGlyph(
      face,
      '萬',
      face.width * 0.5,
      bottom,
      face.height * 0.44,
      redFive ? TILE_INK.red : TILE_INK.maroon,
    );
    return;
  }

  if (suit === 'p') {
    drawPinzu(face, n, redFive);
    return;
  }

  if (suit === 's') {
    drawSouzu(face, n, redFive);
    return;
  }

  // 字牌
  const glyph = HONOR_GLYPHS[kind];
  if (!glyph) {
    // 白: 無地のまま（実物どおり）
    return;
  }
  const color = n === 7 ? TILE_INK.maroon : TILE_INK.ink;
  drawEngravedGlyph(
    face,
    glyph,
    face.width * 0.5,
    face.height * 0.5,
    face.height * 0.68,
    color,
  );
}

/** 牌面 1 枚を独立した canvas として作る（アトラスを使わない用途向け）。 */
export function createTileFaceCanvas(
  kind: TileKind,
  options: { height?: number; fontFamily?: string; isRed?: boolean } = {},
  factory: Canvas2DFactory = domCanvasFactory,
): HTMLCanvasElement {
  const height = options.height ?? 256;
  const width = Math.round(height * TILE_FACE_ASPECT);
  const { canvas, ctx } = factory(width, height);
  drawTileFace(ctx, kind, {
    width,
    height,
    fontFamily: options.fontFamily,
    isRed: options.isRed,
  });
  return canvas;
}

// --------------------------------------------------
// 牌裏
// --------------------------------------------------

export interface TileBackOptions {
  width: number;
  height: number;
}

/** 牌裏。深緑の素地 + 織り目 + 象牙色の枠。 */
export function drawTileBack(ctx: CanvasRenderingContext2D, options: TileBackOptions): void {
  const { width: w, height: h } = options;

  const base = ctx.createLinearGradient(0, 0, w, h);
  base.addColorStop(0, TILE_INK.backBase);
  base.addColorStop(0.5, '#0f5132');
  base.addColorStop(1, TILE_INK.backBaseDeep);
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, w, h);

  // 斜めの織り目
  ctx.save();
  ctx.strokeStyle = TILE_INK.backPattern;
  ctx.lineWidth = Math.max(0.8, w * 0.008);
  const step = Math.max(4, w * 0.055);
  for (let i = -h; i < w + h; i += step) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i + h, h);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(i, h);
    ctx.lineTo(i + h, 0);
    ctx.stroke();
  }
  ctx.restore();

  // 枠
  const inset = Math.max(2, w * 0.055);
  roundRectPath(ctx, inset, inset, w - inset * 2, h - inset * 2, Math.min(w, h) * 0.09);
  ctx.strokeStyle = TILE_INK.backFrame;
  ctx.lineWidth = Math.max(1, w * 0.028);
  ctx.stroke();

  // 角の陰影
  const vignette = ctx.createRadialGradient(
    w * 0.5,
    h * 0.4,
    Math.min(w, h) * 0.15,
    w * 0.5,
    h * 0.5,
    Math.max(w, h) * 0.8,
  );
  vignette.addColorStop(0, 'rgba(255, 255, 255, 0.06)');
  vignette.addColorStop(1, 'rgba(0, 0, 0, 0.35)');
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, w, h);
}

// --------------------------------------------------
// アトラス
// --------------------------------------------------

export interface TileAtlasKey {
  kind: TileKind;
  isRed?: boolean;
}

export interface TileAtlasCell {
  key: TileAtlasKey;
  /** アトラス内の牌面領域（px, 左上原点） */
  x: number;
  y: number;
  width: number;
  height: number;
  /**
   * テクスチャ UV 矩形。
   * three.js の既定（`texture.flipY = true`）を前提に、
   * v0 が牌面の下端、v1 が上端になるように計算している。
   */
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

export interface TileAtlas {
  canvas: HTMLCanvasElement;
  /** アトラスの一辺（px） */
  size: number;
  cells: TileAtlasCell[];
  /** 牌種 + 赤ドラ有無から UV 矩形を引く */
  getCell: (key: TileAtlasKey) => TileAtlasCell | undefined;
  dispose: () => void;
}

export interface TileAtlasOptions {
  /** アトラスの一辺（2 の累乗を推奨）。既定 2048 */
  size?: number;
  /** 1 辺あたりの列数。既定 8 */
  columns?: number;
  fontFamily?: string;
  /** 赤ドラ 5 萬・5 筒・5 索のセルも作るか。既定 true */
  includeRedFives?: boolean;
  factory?: Canvas2DFactory;
}

/** 34 種 + 赤ドラ 3 種のキー一覧 */
export function createAtlasKeys(includeRedFives = true): TileAtlasKey[] {
  const base: TileKind[] = [];
  for (const suit of ['m', 'p', 's'] as const) {
    for (let n = 1; n <= 9; n += 1) base.push(`${n}${suit}` as TileKind);
  }
  for (let n = 1; n <= 7; n += 1) base.push(`${n}z` as TileKind);

  const keys: TileAtlasKey[] = base.map((kind) => ({ kind }));
  if (includeRedFives) {
    for (const kind of RED_FIVE_KINDS) {
      keys.push({ kind: kind as TileKind, isRed: true });
    }
  }
  return keys;
}

function atlasKeyId(key: TileAtlasKey): string {
  return key.isRed ? `${key.kind}+red` : key.kind;
}

/**
 * 全牌種を 1 枚のアトラスにまとめる。
 * セル内には余白（ガター）を空けるので、ミップマップ時に隣の牌がにじまない。
 */
export function createTileAtlas(options: TileAtlasOptions = {}): TileAtlas {
  const size = options.size ?? 2048;
  const columns = options.columns ?? 8;
  const factory = options.factory ?? domCanvasFactory;
  const keys = createAtlasKeys(options.includeRedFives ?? true);

  const rows = Math.ceil(keys.length / columns);
  const cellW = size / columns;
  const cellH = size / rows;

  // 牌面はセルの内側に収める（セルが正方形でも、牌面は縦長）
  const maxFaceH = cellH * 0.9;
  const maxFaceW = cellW * 0.9;
  const faceH = Math.min(maxFaceH, maxFaceW / TILE_FACE_ASPECT);
  const faceW = faceH * TILE_FACE_ASPECT;

  const { canvas, ctx } = factory(size, size);
  ctx.clearRect(0, 0, size, size);

  const cells: TileAtlasCell[] = [];
  const lookup = new Map<string, TileAtlasCell>();

  keys.forEach((key, index) => {
    const col = index % columns;
    const row = Math.floor(index / columns);
    const x = Math.round(col * cellW + (cellW - faceW) / 2);
    const y = Math.round(row * cellH + (cellH - faceH) / 2);
    const width = Math.round(faceW);
    const height = Math.round(faceH);

    ctx.save();
    ctx.translate(x, y);
    drawTileFace(ctx, key.kind, {
      width,
      height,
      fontFamily: options.fontFamily,
      isRed: key.isRed,
    });
    ctx.restore();

    const cell: TileAtlasCell = {
      key,
      x,
      y,
      width,
      height,
      u0: x / size,
      v0: 1 - (y + height) / size,
      u1: (x + width) / size,
      v1: 1 - y / size,
    };
    cells.push(cell);
    lookup.set(atlasKeyId(key), cell);
  });

  return {
    canvas,
    size,
    cells,
    getCell: (key) => lookup.get(atlasKeyId(key)),
    dispose: () => {
      canvas.width = 0;
      canvas.height = 0;
      lookup.clear();
      cells.length = 0;
    },
  };
}

/** 牌裏のテクスチャを 1 枚作る。 */
export function createTileBackCanvas(
  options: { height?: number } = {},
  factory: Canvas2DFactory = domCanvasFactory,
): HTMLCanvasElement {
  const height = options.height ?? 256;
  const width = Math.round(height * TILE_FACE_ASPECT);
  const { canvas, ctx } = factory(width, height);
  drawTileBack(ctx, { width, height });
  return canvas;
}

// --------------------------------------------------
// DOM 用スプライトシート
// --------------------------------------------------

/** スプライトシートの格子（7×6 = 42 枠。34 種 + 赤ドラ 3 種 = 37 枠を収める） */
export const SPRITE_COLUMNS = 7;
export const SPRITE_ROWS = 6;

export interface TileSpriteCell {
  key: TileAtlasKey;
  /** CSS の background-position（px） */
  x: number;
  y: number;
}

export interface TileSpriteSheet {
  /** CSS の background-image に渡す値 */
  imageUrl: string;
  cellWidth: number;
  cellHeight: number;
  cells: Map<string, TileSpriteCell>;
  /** 牌種から background-position を引く。未登録なら undefined */
  getPosition: (kind: TileKind, isRed?: boolean) => { x: number; y: number } | undefined;
}

/**
 * DOM スプライトシートを作る。
 * `cellHeight` は「実際に画面に出す牌の高さ × devicePixelRatio」を渡す。
 * canvas 2D が使えない環境（jsdom など）では null を返すので、
 * 呼び出し側は従来のテキスト描画にフォールバックできる。
 */
export function createTileSpriteSheet(
  options: { cellHeight?: number; fontFamily?: string } = {},
): TileSpriteSheet | null {
  const cellHeight = Math.round(options.cellHeight ?? 96);
  const cellWidth = Math.round(cellHeight * TILE_FACE_ASPECT);

  let created: CanvasWithContext;
  try {
    created = domCanvasFactory(cellWidth * SPRITE_COLUMNS, cellHeight * SPRITE_ROWS);
  } catch {
    return null;
  }
  const { canvas, ctx } = created;

  const keys: TileAtlasKey[] = [...createAtlasKeys(false)];
  for (const kind of RED_FIVE_KINDS) {
    keys.push({ kind: kind as TileKind, isRed: true });
  }

  const cells = new Map<string, TileSpriteCell>();

  keys.forEach((key, index) => {
    const col = index % SPRITE_COLUMNS;
    const row = Math.floor(index / SPRITE_COLUMNS);
    const x = col * cellWidth;
    const y = row * cellHeight;

    ctx.save();
    ctx.translate(x, y);
    drawTileFace(ctx, key.kind, {
      width: cellWidth,
      height: cellHeight,
      fontFamily: options.fontFamily,
      isRed: key.isRed,
    });
    ctx.restore();

    cells.set(key.isRed ? `${key.kind}+red` : key.kind, { key, x, y });
  });

  const imageUrl = canvas.toDataURL('image/png');

  return {
    imageUrl,
    cellWidth,
    cellHeight,
    cells,
    getPosition: (kind, isRed) => {
      const cell = cells.get(isRed ? `${kind}+red` : kind);
      return cell ? { x: cell.x, y: cell.y } : undefined;
    },
  };
}

// --------------------------------------------------
// スプライトシートの事前生成
// --------------------------------------------------

export function prewarmTileSpriteSheet(): void {
  if (spriteSheetCache) return;
  spriteSheetCache = createTileSpriteSheet({ cellHeight: DEFAULT_SPRITE_CELL_HEIGHT });
}

export function getPrewarmedTileSpriteSheet(): TileSpriteSheet | null {
  return spriteSheetCache;
}

let spriteSheetCache: TileSpriteSheet | null = null;
/** スプライトシートの基準セル高さ（px、DPR 非適用） */
const DEFAULT_SPRITE_CELL_HEIGHT = 112;
