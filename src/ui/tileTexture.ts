/**
 * 牌テクスチャ生成（Canvas 2D）
 *
 * Notion「麻雀アプリ 3D牌生成・操作エンジン」の `mahjong-engine.js` にあった
 * `createTileTexture()` / `drawCircles()` / `drawBamboos()` / `createBackTexture()` を
 * 次の方針で作り直したもの。
 *
 *  1. 実物の牌面に近づける
 *     萬子 = 数字（黒）+「萬」（赤） / 筒子 = 的（リング） / 索子 = 竹（1索は鳥） /
 *     白は無地 / 5萬・5筒・5索の赤ドラは図柄そのものを赤にする。
 *  2. 1枚のアトラスにまとめる（牌種ごとにテクスチャを作らない）
 *     37 種 × 512×768 の個別テクスチャ（約 58MB）→ 2048×2048 のアトラス 1 枚（約 16MB）。
 *     さらにミップマップ境界のにじみを防ぐため、セルごとに余白（ガター）を確保する。
 *  3. 3D 側の形状とアスペクト比を一致させる
 *     面の PlaneGeometry は必ず `TILE_FACE_ASPECT` から作る（図柄の横潰れ防止）。
 *  4. 起動時に document を触らない
 *     モジュールスコープで canvas を作らないので、SSR / テスト / Node からも呼べる。
 *     canvas の生成は `Canvas2DFactory` で注入できる。
 *  5. フォントは明示的に指定し、`document.fonts.ready` を待ってから描く
 *     （CJK を含まない serif へのフォールバックによる字形崩れを防ぐ）。
 *  6. 座標はすべて牌面サイズに対する比率で計算する（解像度を変えても崩れない）
 *  7. 彫刻（エングレーブ）風の陰影を付けて、印刷シールではなく牌らしい質感にする
 *
 * このモジュールは Three.js に依存しない。UV 矩形を返すので、呼び出し側で
 * 「1 アトラス + 1 マテリアル + 牌種ごとのジオメトリ」を組めば InstancedMesh で描ける。
 */

import type { TileKind } from '../types/tile';

/** 牌面の幅 / 高さ。3D 側の PlaneGeometry は必ずこの比で作る。 */
export const TILE_FACE_ASPECT = 0.76;

/** 赤ドラとして別セルを用意する牌種。 */
export const RED_FIVE_KINDS = ['5m', '5p', '5s'] as const;
export type RedFiveKind = (typeof RED_FIVE_KINDS)[number];

/** 牌面の色。1 か所にまとめて調整できるようにしている。 */
const INK = {
  ivoryTop: '#fffdf6',
  ivoryBottom: '#ecdfc5',
  ivoryEdge: '#d8c9a9',
  ink: '#1f1d1a',
  inkSoft: '#2b2823',
  red: '#c3222b',
  green: '#0e6b3d',
  blue: '#1b4f9c',
  bambooDark: '#0d5c34',
  bambooLight: '#2f8f58',
  backBase: '#14603c',
  backBaseDeep: '#0c3f27',
  backPattern: 'rgba(255, 255, 255, 0.10)',
  backFrame: '#d8c7a0',
} as const;

/** 明朝系のフォントスタック。CJK を必ず含むものを先に並べる。 */
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
 * `document.fonts` が無い環境（Node / jsdom）では何もしない。
 */
export async function waitForTileFonts(fontFamily = DEFAULT_FONT_FAMILY): Promise<void> {
  if (typeof document === 'undefined' || !document.fonts) return;
  const sample = '萬東南發中一';
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

/** 象牙色の素地。ごく薄い繊維と周辺の減光を入れて「1 枚の板」に見せる。 */
function drawIvoryBase({ ctx, width: w, height: h }: FaceDrawContext): void {
  const bg = ctx.createLinearGradient(0, 0, w * 0.35, h);
  bg.addColorStop(0, INK.ivoryTop);
  bg.addColorStop(0.55, '#f7f0df');
  bg.addColorStop(1, INK.ivoryBottom);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  // 細かな繊維（縦方向）
  ctx.save();
  ctx.globalAlpha = 0.05;
  ctx.strokeStyle = INK.ink;
  ctx.lineWidth = Math.max(0.6, w * 0.0018);
  for (let i = 1; i < 14; i += 1) {
    const x = (w / 14) * i + (i % 3) * w * 0.004;
    ctx.beginPath();
    ctx.moveTo(x, h * 0.02);
    ctx.bezierCurveTo(x + w * 0.01, h * 0.35, x - w * 0.01, h * 0.65, x, h * 0.98);
    ctx.stroke();
  }
  ctx.restore();

  // 角の丸みを模した内側の陰影
  const inset = ctx.createRadialGradient(
    w * 0.5,
    h * 0.45,
    Math.min(w, h) * 0.2,
    w * 0.5,
    h * 0.5,
    Math.max(w, h) * 0.78,
  );
  inset.addColorStop(0, 'rgba(255, 255, 255, 0)');
  inset.addColorStop(1, 'rgba(150, 125, 80, 0.16)');
  ctx.fillStyle = inset;
  ctx.fillRect(0, 0, w, h);
}

/** 彫刻風に文字を描く（明部→影→インクの順で少しずつずらす）。 */
function drawEngravedGlyph(
  face: FaceDrawContext,
  glyph: string,
  cx: number,
  cy: number,
  sizePx: number,
  color: string,
): void {
  const { ctx } = face;
  const depth = Math.max(0.8, sizePx * 0.014);

  ctx.save();
  ctx.font = `700 ${sizePx}px ${face.fontFamily}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  ctx.fillStyle = 'rgba(255, 255, 255, 0.65)';
  ctx.fillText(glyph, cx - depth * 0.8, cy - depth * 0.8);

  ctx.fillStyle = 'rgba(0, 0, 0, 0.18)';
  ctx.fillText(glyph, cx + depth, cy + depth);

  ctx.fillStyle = color;
  ctx.fillText(glyph, cx, cy);
  ctx.restore();
}

/** 縦に 2 文字（萬子・数牌の数字 + 萬 など）を配置するときの基準位置 */
function stackedGlyphPositions(face: FaceDrawContext): { top: number; bottom: number } {
  return { top: face.height * 0.335, bottom: face.height * 0.695 };
}

const KANJI_NUMBERS = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九'] as const;
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
// 筒子（ピンズ）: 的（リング）を描く
// --------------------------------------------------

type PipColor = 'blue' | 'red' | 'green';

interface PipSpec {
  x: number; // 0..1（牌面幅に対する比率）
  y: number; // 0..1（牌面高さに対する比率）
  color: PipColor;
}

/**
 * 筒子の配列と配色。
 * 実物の牌は製造元で配色が異なるため、ここ 1 か所で調整できるようにしている。
 */
const PINZU_LAYOUTS: Record<number, PipSpec[]> = {
  2: [
    { x: 0.5, y: 0.3, color: 'blue' },
    { x: 0.5, y: 0.7, color: 'green' },
  ],
  3: [
    { x: 0.27, y: 0.23, color: 'blue' },
    { x: 0.5, y: 0.5, color: 'red' },
    { x: 0.73, y: 0.77, color: 'green' },
  ],
  4: [
    { x: 0.3, y: 0.3, color: 'blue' },
    { x: 0.7, y: 0.3, color: 'green' },
    { x: 0.3, y: 0.7, color: 'green' },
    { x: 0.7, y: 0.7, color: 'blue' },
  ],
  5: [
    { x: 0.28, y: 0.28, color: 'blue' },
    { x: 0.72, y: 0.28, color: 'green' },
    { x: 0.5, y: 0.5, color: 'red' },
    { x: 0.28, y: 0.72, color: 'green' },
    { x: 0.72, y: 0.72, color: 'blue' },
  ],
  6: [
    { x: 0.23, y: 0.3, color: 'green' },
    { x: 0.5, y: 0.3, color: 'green' },
    { x: 0.77, y: 0.3, color: 'green' },
    { x: 0.23, y: 0.7, color: 'red' },
    { x: 0.5, y: 0.7, color: 'red' },
    { x: 0.77, y: 0.7, color: 'red' },
  ],
  7: [
    { x: 0.22, y: 0.2, color: 'green' },
    { x: 0.5, y: 0.2, color: 'green' },
    { x: 0.78, y: 0.2, color: 'green' },
    { x: 0.22, y: 0.5, color: 'green' },
    { x: 0.5, y: 0.5, color: 'green' },
    { x: 0.78, y: 0.5, color: 'green' },
    { x: 0.5, y: 0.8, color: 'red' },
  ],
  8: [
    { x: 0.17, y: 0.3, color: 'blue' },
    { x: 0.39, y: 0.3, color: 'blue' },
    { x: 0.61, y: 0.3, color: 'blue' },
    { x: 0.83, y: 0.3, color: 'blue' },
    { x: 0.17, y: 0.7, color: 'blue' },
    { x: 0.39, y: 0.7, color: 'blue' },
    { x: 0.61, y: 0.7, color: 'blue' },
    { x: 0.83, y: 0.7, color: 'blue' },
  ],
  9: [
    { x: 0.22, y: 0.2, color: 'green' },
    { x: 0.5, y: 0.2, color: 'green' },
    { x: 0.78, y: 0.2, color: 'green' },
    { x: 0.22, y: 0.5, color: 'red' },
    { x: 0.5, y: 0.5, color: 'red' },
    { x: 0.78, y: 0.5, color: 'red' },
    { x: 0.22, y: 0.8, color: 'green' },
    { x: 0.5, y: 0.8, color: 'green' },
    { x: 0.78, y: 0.8, color: 'green' },
  ],
};

function pipColorValue(color: PipColor): string {
  if (color === 'blue') return INK.blue;
  if (color === 'red') return INK.red;
  return INK.green;
}

/** 的 1 個。外周の色リング + 白リング + 中心の点。 */
function drawPip(
  { ctx }: FaceDrawContext,
  cx: number,
  cy: number,
  radius: number,
  color: string,
): void {
  // 外周（わずかに暗い縁）
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, TAU);
  ctx.fillStyle = color;
  ctx.fill();

  ctx.beginPath();
  ctx.arc(cx, cy, radius * 0.9, 0, TAU);
  ctx.fillStyle = color;
  ctx.fill();

  // 白リング
  ctx.beginPath();
  ctx.arc(cx, cy, radius * 0.58, 0, TAU);
  ctx.fillStyle = INK.ivoryTop;
  ctx.fill();

  // 中心の点
  ctx.beginPath();
  ctx.arc(cx, cy, radius * 0.26, 0, TAU);
  ctx.fillStyle = color;
  ctx.fill();

  // 彫りの陰
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, TAU);
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.14)';
  ctx.lineWidth = Math.max(0.8, radius * 0.08);
  ctx.stroke();
}

function drawPinzuOne(face: FaceDrawContext, redFive: boolean): void {
  const { ctx, width: w, height: h } = face;
  const cx = w * 0.5;
  const cy = h * 0.5;
  const r = Math.min(w, h) * 0.33;

  const rings: Array<{ scale: number; color: string }> = redFive
    ? [
        { scale: 1, color: INK.red },
        { scale: 0.72, color: '#e0b46a' },
        { scale: 0.46, color: INK.red },
        { scale: 0.2, color: INK.red },
      ]
    : [
        { scale: 1, color: INK.blue },
        { scale: 0.72, color: INK.red },
        { scale: 0.46, color: INK.green },
        { scale: 0.2, color: INK.blue },
      ];

  for (const ring of rings) {
    ctx.beginPath();
    ctx.arc(cx, cy, r * ring.scale, 0, TAU);
    const gradient = ctx.createRadialGradient(
      cx - r * ring.scale * 0.3,
      cy - r * ring.scale * 0.3,
      r * ring.scale * 0.1,
      cx,
      cy,
      r * ring.scale,
    );
    gradient.addColorStop(0, ring.color);
    gradient.addColorStop(1, 'rgba(0, 0, 0, 0.28)');
    ctx.fillStyle = ring.color;
    ctx.fill();
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.18)';
    ctx.lineWidth = Math.max(0.8, r * 0.05);
    ctx.stroke();
  }
}

function drawPinzu(face: FaceDrawContext, n: number, redFive: boolean): void {
  if (n === 1) {
    drawPinzuOne(face, redFive);
    return;
  }

  const layout = PINZU_LAYOUTS[n];
  if (!layout) return;

  const columns = new Set(layout.map((p) => p.x.toFixed(3))).size;
  const rows = new Set(layout.map((p) => p.y.toFixed(3))).size;
  const radius = Math.min(
    (face.width * 0.74) / (columns * 2.35),
    (face.height * 0.76) / (rows * 2.35),
  );

  for (const pip of layout) {
    const color = redFive ? INK.red : pipColorValue(pip.color);
    drawPip(face, face.width * pip.x, face.height * pip.y, radius, color);
  }
}

// --------------------------------------------------
// 索子（ソーズ）: 竹と、1 索の鳥
// --------------------------------------------------

interface StickSpec {
  x: number;
  y: number;
  red?: boolean;
  rotate?: number;
}

const SOUZU_LAYOUTS: Record<number, StickSpec[]> = {
  2: [
    { x: 0.38, y: 0.5 },
    { x: 0.62, y: 0.5 },
  ],
  3: [
    { x: 0.5, y: 0.2 },
    { x: 0.3, y: 0.5 },
    { x: 0.7, y: 0.5 },
  ],
  4: [
    { x: 0.3, y: 0.28 },
    { x: 0.7, y: 0.28 },
    { x: 0.3, y: 0.72 },
    { x: 0.7, y: 0.72 },
  ],
  5: [
    { x: 0.28, y: 0.26 },
    { x: 0.72, y: 0.26 },
    { x: 0.5, y: 0.5, red: true },
    { x: 0.28, y: 0.74 },
    { x: 0.72, y: 0.74 },
  ],
  6: [
    { x: 0.22, y: 0.3 },
    { x: 0.5, y: 0.3 },
    { x: 0.78, y: 0.3 },
    { x: 0.22, y: 0.7 },
    { x: 0.5, y: 0.7 },
    { x: 0.78, y: 0.7 },
  ],
  7: [
    { x: 0.5, y: 0.18, red: true },
    { x: 0.22, y: 0.5 },
    { x: 0.5, y: 0.5 },
    { x: 0.78, y: 0.5 },
    { x: 0.22, y: 0.82 },
    { x: 0.5, y: 0.82 },
    { x: 0.78, y: 0.82 },
  ],
  8: [
    { x: 0.16, y: 0.3 },
    { x: 0.39, y: 0.3 },
    { x: 0.61, y: 0.3 },
    { x: 0.84, y: 0.3 },
    { x: 0.16, y: 0.7 },
    { x: 0.39, y: 0.7 },
    { x: 0.61, y: 0.7 },
    { x: 0.84, y: 0.7 },
  ],
  9: [
    { x: 0.22, y: 0.2 },
    { x: 0.5, y: 0.2 },
    { x: 0.78, y: 0.2 },
    { x: 0.22, y: 0.5 },
    { x: 0.5, y: 0.5 },
    { x: 0.78, y: 0.5 },
    { x: 0.22, y: 0.8 },
    { x: 0.5, y: 0.8 },
    { x: 0.78, y: 0.8 },
  ],
};

/** 竹 1 本。節のある竿として描く。 */
function drawBambooStick(
  { ctx }: FaceDrawContext,
  cx: number,
  cy: number,
  widthPx: number,
  heightPx: number,
  red: boolean,
): void {
  const halfW = widthPx / 2;
  const halfH = heightPx / 2;
  const radius = halfW * 0.85;

  ctx.save();
  ctx.translate(cx, cy);

  const body = ctx.createLinearGradient(-halfW, 0, halfW, 0);
  if (red) {
    body.addColorStop(0, '#9d1b23');
    body.addColorStop(0.35, INK.red);
    body.addColorStop(0.7, '#d9434b');
    body.addColorStop(1, '#8f1620');
  } else {
    body.addColorStop(0, INK.bambooDark);
    body.addColorStop(0.35, INK.bambooLight);
    body.addColorStop(0.7, '#3fa367');
    body.addColorStop(1, INK.bambooDark);
  }

  roundRectPath(ctx, -halfW, -halfH, widthPx, heightPx, radius);
  ctx.fillStyle = body;
  ctx.fill();
  ctx.strokeStyle = red ? '#6f1017' : '#084024';
  ctx.lineWidth = Math.max(0.7, widthPx * 0.075);
  ctx.stroke();

  // 節（2 本の横線）
  ctx.strokeStyle = red ? 'rgba(255, 225, 225, 0.55)' : 'rgba(228, 244, 226, 0.55)';
  ctx.lineWidth = Math.max(0.6, widthPx * 0.06);
  for (const t of [-0.2, 0.2]) {
    const y = halfH * t;
    ctx.beginPath();
    ctx.moveTo(-halfW * 0.82, y);
    ctx.quadraticCurveTo(0, y + widthPx * 0.06, halfW * 0.82, y);
    ctx.stroke();
  }

  // 上下の端の艶
  ctx.fillStyle = red ? 'rgba(255, 255, 255, 0.28)' : 'rgba(255, 255, 255, 0.32)';
  ctx.beginPath();
  ctx.ellipse(0, -halfH + heightPx * 0.06, halfW * 0.55, heightPx * 0.045, 0, 0, TAU);
  ctx.fill();

  ctx.restore();
}

/** 1 索の鳥。孔雀をかたどった簡略表現。 */
function drawSouzuBird(face: FaceDrawContext): void {
  const { ctx, width: w, height: h } = face;
  const cx = w * 0.5;
  const cy = h * 0.52;

  // 尾羽（扇状）
  const feathers = [-0.55, -0.28, 0, 0.28, 0.55];
  feathers.forEach((angle, index) => {
    ctx.save();
    ctx.translate(cx - w * 0.03, cy + h * 0.06);
    ctx.rotate(angle);
    const grad = ctx.createLinearGradient(0, 0, 0, -h * 0.34);
    grad.addColorStop(0, index % 2 === 0 ? INK.bambooLight : '#2b7f4f');
    grad.addColorStop(1, index % 2 === 0 ? '#1f6b42' : INK.green);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(-w * 0.035, 0);
    ctx.quadraticCurveTo(0, -h * 0.36, w * 0.035, 0);
    ctx.quadraticCurveTo(0, h * 0.02, -w * 0.035, 0);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.2)';
    ctx.lineWidth = Math.max(0.6, w * 0.006);
    ctx.stroke();
    ctx.restore();
  });

  // 胴
  const body = ctx.createLinearGradient(cx - w * 0.16, cy, cx + w * 0.16, cy + h * 0.16);
  body.addColorStop(0, '#2f9159');
  body.addColorStop(1, '#0c5a34');
  ctx.beginPath();
  ctx.ellipse(cx + w * 0.02, cy + h * 0.13, w * 0.115, h * 0.135, 0.18, 0, TAU);
  ctx.fillStyle = body;
  ctx.fill();
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.22)';
  ctx.lineWidth = Math.max(0.7, w * 0.007);
  ctx.stroke();

  // 頭
  ctx.beginPath();
  ctx.arc(cx + w * 0.1, cy - h * 0.03, w * 0.062, 0, TAU);
  ctx.fillStyle = '#2b8c55';
  ctx.fill();
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.22)';
  ctx.stroke();

  // 嘴
  ctx.beginPath();
  ctx.moveTo(cx + w * 0.155, cy - h * 0.04);
  ctx.lineTo(cx + w * 0.22, cy - h * 0.015);
  ctx.lineTo(cx + w * 0.155, cy + h * 0.005);
  ctx.closePath();
  ctx.fillStyle = '#e2a63c';
  ctx.fill();

  // 目の点
  ctx.beginPath();
  ctx.arc(cx + w * 0.118, cy - h * 0.045, w * 0.011, 0, TAU);
  ctx.fillStyle = INK.ink;
  ctx.fill();

  // 止まり木
  ctx.strokeStyle = '#8b6a3c';
  ctx.lineWidth = Math.max(0.8, w * 0.012);
  ctx.beginPath();
  ctx.moveTo(cx - w * 0.2, cy + h * 0.28);
  ctx.lineTo(cx + w * 0.2, cy + h * 0.28);
  ctx.stroke();
}

function drawSouzu(face: FaceDrawContext, n: number, redFive: boolean): void {
  if (n === 1) {
    drawSouzuBird(face);
    return;
  }

  const layout = SOUZU_LAYOUTS[n];
  if (!layout) return;

  const columns = new Set(layout.map((s) => s.x.toFixed(3))).size;
  const stickW = Math.min((face.width * 0.72) / (columns * 2.05), face.width * 0.13);
  const stickH = face.height * 0.25;

  for (const stick of layout) {
    drawBambooStick(
      face,
      face.width * stick.x,
      face.height * stick.y,
      stickW,
      stickH,
      Boolean(stick.red) || redFive,
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
      face.height * 0.31,
      redFive ? INK.red : INK.ink,
    );
    drawEngravedGlyph(face, '萬', face.width * 0.5, bottom, face.height * 0.3, INK.red);
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
  const color = n === 6 ? INK.green : n === 7 ? INK.red : INK.ink;
  drawEngravedGlyph(
    face,
    glyph,
    face.width * 0.5,
    face.height * 0.5,
    face.height * 0.46,
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
  base.addColorStop(0, INK.backBase);
  base.addColorStop(0.5, '#0f5132');
  base.addColorStop(1, INK.backBaseDeep);
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, w, h);

  // 斜めの織り目
  ctx.save();
  ctx.strokeStyle = INK.backPattern;
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
  ctx.strokeStyle = INK.backFrame;
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
//
// 2D の牌コンポーネント（`.mj-tile`）で使うための経路。
// canvas 1 枚を data URL にして CSS の background-image として共有し、
// 牌ごとに background-position だけを変える。
// 牌 1 枚ごとに <img> や <canvas> を作らないので、
// 136 枚 + 捨て牌 + 副露を描いても DOM ノードとメモリが増えない。

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
  // 赤ドラは 5 萬 / 5 筒 / 5 索 のみ（残りは白枠で埋める）
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

/**
 * DOM 牌のスプライトシートを今すぐ作る。
 * `waitForTileFonts()` の後に呼ぶと、正しい字形で焼き込める。
 * 一度しか作らないので、繰り返し呼んでもコストは増えない。
 */
export function prewarmTileSpriteSheet(): void {
  if (spriteSheetCache) return;
  spriteSheetCache = createTileSpriteSheet({ cellHeight: DEFAULT_SPRITE_CELL_HEIGHT });
}

/** 事前生成済みのスプライトシート（未生成なら null） */
export function getPrewarmedTileSpriteSheet(): TileSpriteSheet | null {
  return spriteSheetCache;
}

let spriteSheetCache: TileSpriteSheet | null = null;
/** スプライトシートの基準セル高さ（px、DPR 非適用） */
const DEFAULT_SPRITE_CELL_HEIGHT = 112;
