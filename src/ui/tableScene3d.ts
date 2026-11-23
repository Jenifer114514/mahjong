import { deriveRules } from '../engine/rules';
import { getActiveDoraKinds } from '../engine/dora';
import type { StateView, PublicPlayerView } from '../types/message';
import type { Meld } from '../types/state';
import type { Tile, TileKind } from '../types/tile';
import {
  createTileAtlas,
  waitForTileFonts,
  type TileAtlas,
  TILE_FACE_ASPECT,
} from './tileTexture';
import { windToJa } from './tileView';

export type Table3DCameraPreset = 'standard' | 'high' | 'low';

export type SeatSide3D = 'self' | 'right' | 'top' | 'left';

export interface Table3DCallbacks {
  onClickHandTile?: (tileId: string) => void;
  onClickTableVoid?: () => void;
}

export interface Table3DSyncParams {
  view: StateView;
  isSpectator: boolean;
  canDiscardNow: boolean;
  selectedTileId: string | null;
  riichiSelectingMode: boolean;
  canRiichiTileIds: readonly string[];
  kuikaeForbiddenKinds: readonly TileKind[];
  cameraPreset: Table3DCameraPreset;
  newlyDiscardedSides?: ReadonlySet<SeatSide3D>;
  newlyDrawnSides?: ReadonlySet<SeatSide3D>;
  newlyRevealedDoraIndices?: ReadonlySet<number>;
}

interface MeshBuffers {
  vao: WebGLVertexArrayObject;
  vbo: WebGLBuffer;
  ibo: WebGLBuffer;
  indexCount: number;
}

interface TileFaceUv {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

interface HandHitBox {
  tileId: string;
  clickable: boolean;
  center: [number, number, number];
  axisX: [number, number, number];
  axisY: [number, number, number];
  axisZ: [number, number, number];
  halfX: number;
  halfY: number;
  halfZ: number;
}

interface ThrowAnimState {
  side: SeatSide3D;
  discardIndex: number;
  startTime: number;
  duration: number;
  from: [number, number, number];
}

interface DrawAnimState {
  side: SeatSide3D;
  startTime: number;
  duration: number;
}

interface DoraFlipAnimState {
  index: number;
  startTime: number;
  duration: number;
}

interface DrawRequest {
  mesh: MeshBuffers;
  model: Float32Array;
  color: [number, number, number, number];
  uvRect: [number, number, number, number];
  useAtlas: number;
  useConsole: number;
  backTone: number;
  highlight: number;
  emissive: number;
  doraGlow: number;
}

// ==================================================
// 牌・卓ディメンション（卓面 Y = 0 上に実寸比で配置）
// ==================================================
const TILE_W = 0.62;
const TILE_H = TILE_W / TILE_FACE_ASPECT; // 約 0.816
const TILE_D = 0.36;

const SELF_SCALE = 1.44;
const OPP_SCALE = 1.04;
const RIVER_SCALE = 0.88;
const WALL_SCALE = 0.8;
const MELD_SCALE = 0.84;

const deg = (d: number): number => (d * Math.PI) / 180;

// ==================================================
// 軽量 4×4 行列 & ベクトル数学
// ==================================================
function mat4Identity(): Float32Array {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

function mat4Multiply(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    const b0 = b[c * 4]!;
    const b1 = b[c * 4 + 1]!;
    const b2 = b[c * 4 + 2]!;
    const b3 = b[c * 4 + 3]!;
    out[c * 4] = a[0]! * b0 + a[4]! * b1 + a[8]! * b2 + a[12]! * b3;
    out[c * 4 + 1] = a[1]! * b0 + a[5]! * b1 + a[9]! * b2 + a[13]! * b3;
    out[c * 4 + 2] = a[2]! * b0 + a[6]! * b1 + a[10]! * b2 + a[14]! * b3;
    out[c * 4 + 3] = a[3]! * b0 + a[7]! * b1 + a[11]! * b2 + a[15]! * b3;
  }
  return out;
}

function mat4Perspective(
  fovy: number,
  aspect: number,
  near: number,
  far: number,
): Float32Array {
  const f = 1 / Math.tan(fovy / 2);
  const out = new Float32Array(16);
  out[0] = f / aspect;
  out[5] = f;
  out[10] = (far + near) / (near - far);
  out[11] = -1;
  out[14] = (2 * far * near) / (near - far);
  return out;
}

function mat4LookAt(
  eye: readonly [number, number, number],
  target: readonly [number, number, number],
  up: readonly [number, number, number],
): Float32Array {
  let zx = eye[0] - target[0];
  let zy = eye[1] - target[1];
  let zz = eye[2] - target[2];
  const zLen = Math.hypot(zx, zy, zz) || 1;
  zx /= zLen;
  zy /= zLen;
  zz /= zLen;

  let xx = up[1] * zz - up[2] * zy;
  let xy = up[2] * zx - up[0] * zz;
  let xz = up[0] * zy - up[1] * zx;
  const xLen = Math.hypot(xx, xy, xz) || 1;
  xx /= xLen;
  xy /= xLen;
  xz /= xLen;

  const yx = zy * xz - zz * xy;
  const yy = zz * xx - zx * xz;
  const yz = zx * xy - zy * xx;

  const m = new Float32Array(16);
  m[0] = xx;
  m[1] = yx;
  m[2] = zx;
  m[3] = 0;
  m[4] = xy;
  m[5] = yy;
  m[6] = zy;
  m[7] = 0;
  m[8] = xz;
  m[9] = yz;
  m[10] = zz;
  m[11] = 0;
  m[12] = -(xx * eye[0] + xy * eye[1] + xz * eye[2]);
  m[13] = -(yx * eye[0] + yy * eye[1] + yz * eye[2]);
  m[14] = -(zx * eye[0] + zy * eye[1] + zz * eye[2]);
  m[15] = 1;
  return m;
}

function mat4Invert(m: Float32Array): Float32Array | null {
  const out = new Float32Array(16);
  const a00 = m[0]!, a01 = m[1]!, a02 = m[2]!, a03 = m[3]!;
  const a10 = m[4]!, a11 = m[5]!, a12 = m[6]!, a13 = m[7]!;
  const a20 = m[8]!, a21 = m[9]!, a22 = m[10]!, a23 = m[11]!;
  const a30 = m[12]!, a31 = m[13]!, a32 = m[14]!, a33 = m[15]!;

  const b00 = a00 * a11 - a01 * a10;
  const b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11;
  const b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30;
  const b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31;
  const b11 = a22 * a33 - a23 * a32;

  let det =
    b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (Math.abs(det) < 1e-10) return null;
  det = 1 / det;

  out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
  out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
  out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
  out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
  out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
  out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
  out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
  out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
  out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
  out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
  out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
  out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
  out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
  out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
  out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
  out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
  return out;
}

function mat4Compose(
  tx: number,
  ty: number,
  tz: number,
  rx: number,
  ry: number,
  rz: number,
  sx: number,
  sy: number,
  sz: number,
): Float32Array {
  const cx = Math.cos(rx), sxr = Math.sin(rx);
  const cy = Math.cos(ry), syr = Math.sin(ry);
  const cz = Math.cos(rz), szr = Math.sin(rz);

  // R = Ry * Rx * Rz * S（卓配置で直感的）
  const m00 = (cy * cz + syr * sxr * szr) * sx;
  const m10 = cx * szr * sx;
  const m20 = (-syr * cz + cy * sxr * szr) * sx;

  const m01 = (-cy * szr + syr * sxr * cz) * sy;
  const m11 = cx * cz * sy;
  const m21 = (syr * szr + cy * sxr * cz) * sy;

  const m02 = syr * cx * sz;
  const m12 = -sxr * sz;
  const m22 = cy * cx * sz;

  const m = new Float32Array(16);
  m[0] = m00; m[1] = m10; m[2] = m20; m[3] = 0;
  m[4] = m01; m[5] = m11; m[6] = m21; m[7] = 0;
  m[8] = m02; m[9] = m12; m[10] = m22; m[11] = 0;
  m[12] = tx; m[13] = ty; m[14] = tz; m[15] = 1;
  return m;
}

function rotatePointXZ(
  x: number,
  z: number,
  ry: number,
): [number, number] {
  const c = Math.cos(ry);
  const s = Math.sin(ry);
  return [x * c + z * s, -x * s + z * c];
}

// ==================================================
// シェーダ（WebGL2）
// ==================================================
const VERT_SRC = `#version 300 es
precision highp float;

layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in vec2 aUv;
layout(location = 3) in float aZone;

uniform mat4 uViewProj;
uniform mat4 uModel;

out vec3 vWorldPos;
out vec3 vNormal;
out vec2 vUv;
out float vZone;

void main() {
  vec4 wp = uModel * vec4(aPos, 1.0);
  vWorldPos = wp.xyz;
  vNormal = mat3(uModel) * aNormal;
  vUv = aUv;
  vZone = aZone;
  gl_Position = uViewProj * wp;
}
`;

const FRAG_SRC = `#version 300 es
precision highp float;

in vec3 vWorldPos;
in vec3 vNormal;
in vec2 vUv;
in float vZone;

uniform vec4 uColor;
uniform vec4 uUvRect;
uniform float uUseAtlas;
uniform float uUseConsole;
uniform float uBackTone;
uniform float uHighlight;
uniform float uEmissive;
uniform float uDoraGlow;
uniform float uTime;
uniform vec3 uCamPos;
uniform sampler2D uAtlasTex;
uniform sampler2D uConsoleTex;

out vec4 outColor;

void main() {
  vec3 N = normalize(vNormal);
  vec3 V = normalize(uCamPos - vWorldPos);
  vec3 L1 = normalize(vec3(3.4, 9.8, 5.2));
  vec3 L2 = normalize(vec3(-5.0, 5.8, -3.6));

  float diff1 = max(dot(N, L1), 0.0);
  float diff2 = max(dot(N, L2), 0.0);
  vec3 H1 = normalize(L1 + V);
  float spec = pow(max(dot(N, H1), 0.0), 42.0);
  float rim = pow(1.0 - max(dot(N, V), 0.0), 3.0);

  vec3 base = uColor.rgb;
  float alpha = uColor.a;

  if (uUseConsole > 0.5 && vZone > 1.5) {
    base = texture(uConsoleTex, vUv).rgb;
  } else if (uUseAtlas > 0.5) {
    if (vZone < 0.5) {
      // 天面: アトラス UV にマップし、角を丸く象牙面と馴染ませる
      vec2 edge = min(vUv, 1.0 - vUv);
      float minEdge = min(edge.x, edge.y);
      float radius = 0.075;
      float cornerDist = length(max(vec2(radius) - edge, 0.0));
      float faceMask = smoothstep(radius + 0.015, radius - 0.015, cornerDist);

      vec2 atlasUv = mix(uUvRect.xy, uUvRect.zw, vUv);
      vec4 tex = texture(uAtlasTex, atlasUv);
      vec3 ivory = vec3(0.96, 0.94, 0.89);
      vec3 faceCol = mix(ivory, tex.rgb, tex.a);
      base = mix(vec3(0.91, 0.87, 0.78), faceCol, faceMask);
      if (minEdge < 0.025) {
        base *= 0.96;
      }
      base *= uColor.rgb;
    } else if (vZone < 1.5) {
      // 側面・面取りベベル: 象牙色
      base = vec3(0.92, 0.88, 0.78) * uColor.rgb;
      if (vUv.y < 0.25) {
        base = mix(base, vec3(0.84, 0.64, 0.28) * uColor.rgb, 0.45);
      }
    } else {
      // 背面（雀魂風 琥珀ゴールドグラデ）
      float grad = clamp(vUv.y * 0.7 + 0.15, 0.0, 1.0);
      vec3 goldTop = vec3(0.95, 0.72, 0.24);
      vec3 goldBot = vec3(0.76, 0.48, 0.11);
      base = mix(goldBot, goldTop, grad) * uColor.rgb;
      float edgeFrame = min(min(vUv.x, 1.0 - vUv.x), min(vUv.y, 1.0 - vUv.y));
      if (edgeFrame < 0.06) {
        base *= 0.86;
      }
      if (uBackTone > 0.5) {
        base *= 0.94;
      }
    }
  } else if (vZone > 4.5 && vZone < 5.5) {
    // 卓の青藍フェルト: 織り目＋中心照明のグラデーション
    float d = length(vWorldPos.xz) / 8.8;
    vec3 centerFelt = vec3(0.16, 0.30, 0.52);
    vec3 outerFelt = vec3(0.07, 0.14, 0.27);
    base = mix(centerFelt, outerFelt, smoothstep(0.05, 0.98, d));
    float weave = sin(vWorldPos.x * 62.0) * sin(vWorldPos.z * 62.0) * 0.011;
    base += weave;
    // 卓中心の緩やかな内枠ガイドライン
    float box = max(abs(vWorldPos.x), abs(vWorldPos.z));
    if (abs(box - 3.92) < 0.028 || abs(box - 1.38) < 0.022) {
      base = mix(base, vec3(0.04, 0.09, 0.18), 0.55);
    }
  } else if (vZone > 5.5) {
    // 接地ソフトシャドウ
    float r = length(vUv - vec2(0.5)) * 2.0;
    alpha *= smoothstep(1.0, 0.15, r);
  }

  vec3 lit = base * (0.46 + 0.62 * diff1 + 0.16 * diff2);
  if (uUseAtlas > 0.5) {
    lit += vec3(0.24, 0.23, 0.21) * spec + vec3(0.11, 0.12, 0.15) * rim;
  } else if (vZone < 4.5) {
    lit += vec3(0.14) * spec;
  }

  // ドラシマー
  if (uDoraGlow > 0.5 && vZone < 0.5) {
    float wave = sin(vUv.x * 7.0 - vUv.y * 5.0 - uTime * 3.1);
    float band = smoothstep(0.82, 0.99, wave);
    lit += vec3(1.0, 0.86, 0.42) * band * 0.22;
  }

  // 選択・ホバー・リーチ候補ハイライト
  if (uHighlight > 0.01) {
    float pulse = 0.85 + 0.15 * sin(uTime * 4.5);
    if (uHighlight > 1.5) {
      // リーチ候補: ゴールド寄りの強調
      lit = mix(lit, vec3(1.0, 0.84, 0.40), 0.24 * pulse);
    } else if (uHighlight > 0.65) {
      // 選択中 / 最新捨て牌
      lit = mix(lit, vec3(0.84, 0.94, 1.0), 0.20 * pulse);
    } else {
      // ホバー
      lit = mix(lit, vec3(0.95, 0.98, 1.0), 0.12);
    }
  }

  if (uEmissive > 0.01) {
    lit += base * uEmissive;
  }

  outColor = vec4(lit, alpha);
}
`;

function compileShader(
  gl: WebGL2RenderingContext,
  type: number,
  src: string,
): WebGLShader {
  const s = gl.createShader(type);
  if (!s) throw new Error('Failed to create shader');
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(s);
    gl.deleteShader(s);
    throw new Error(`Shader error: ${info}`);
  }
  return s;
}

function createProgram(
  gl: WebGL2RenderingContext,
  vsSrc: string,
  fsSrc: string,
): WebGLProgram {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vsSrc);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSrc);
  const prog = gl.createProgram();
  if (!prog) throw new Error('Failed to create shader program');
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(prog);
    gl.deleteProgram(prog);
    throw new Error(`Program link error: ${info}`);
  }
  return prog;
}

function uploadMesh(
  gl: WebGL2RenderingContext,
  verts: number[],
  indices: number[],
): MeshBuffers {
  const vao = gl.createVertexArray()!;
  const vbo = gl.createBuffer()!;
  const ibo = gl.createBuffer()!;

  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.STATIC_DRAW);

  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
  gl.bufferData(
    gl.ELEMENT_ARRAY_BUFFER,
    new Uint16Array(indices),
    gl.STATIC_DRAW,
  );

  const stride = 9 * 4;
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 3, gl.FLOAT, false, stride, 3 * 4);
  gl.enableVertexAttribArray(2);
  gl.vertexAttribPointer(2, 2, gl.FLOAT, false, stride, 6 * 4);
  gl.enableVertexAttribArray(3);
  gl.vertexAttribPointer(3, 1, gl.FLOAT, false, stride, 8 * 4);

  gl.bindVertexArray(null);
  return { vao, vbo, ibo, indexCount: indices.length };
}

function pushQuad(
  verts: number[],
  indices: number[],
  p0: readonly [number, number, number],
  p1: readonly [number, number, number],
  p2: readonly [number, number, number],
  p3: readonly [number, number, number],
  n: readonly [number, number, number],
  uv0: readonly [number, number],
  uv1: readonly [number, number],
  uv2: readonly [number, number],
  uv3: readonly [number, number],
  zone: number,
): void {
  const base = verts.length / 9;
  const pts = [p0, p1, p2, p3] as const;
  const uvs = [uv0, uv1, uv2, uv3] as const;
  for (let i = 0; i < 4; i++) {
    const p = pts[i]!;
    const uv = uvs[i]!;
    verts.push(p[0], p[1], p[2], n[0], n[1], n[2], uv[0], uv[1], zone);
  }
  indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

/** 面取りベベル付き麻雀牌メッシュ（原点 = 牌底面中心、Y+ 上向き、Z+ 手前方向） */
function buildBeveledTileMesh(gl: WebGL2RenderingContext): MeshBuffers {
  const hw = TILE_W * 0.5;
  const hd = TILE_H * 0.5;
  const h = TILE_D;
  const b = 0.045;
  const bh = 0.045;
  const backSplitY = h * 0.34;

  const verts: number[] = [];
  const indices: number[] = [];

  // 1. 天面 (zone=0)
  pushQuad(
    verts,
    indices,
    [-hw + b, h, -hd + b],
    [-hw + b, h, hd - b],
    [hw - b, h, hd - b],
    [hw - b, h, -hd + b],
    [0, 1, 0],
    [0, 0],
    [0, 1],
    [1, 1],
    [1, 0],
    0,
  );

  // 2. 上面取りベベル (zone=1)
  const ny = 0.707;
  const nxz = 0.707;
  pushQuad(
    verts,
    indices,
    [-hw, h - bh, -hd],
    [-hw + b, h, -hd + b],
    [hw - b, h, -hd + b],
    [hw, h - bh, -hd],
    [0, ny, -nxz],
    [0, 1], [0, 1], [1, 1], [1, 1],
    1,
  );
  pushQuad(
    verts,
    indices,
    [-hw + b, h, hd - b],
    [-hw, h - bh, hd],
    [hw, h - bh, hd],
    [hw - b, h, hd - b],
    [0, ny, nxz],
    [0, 1], [0, 1], [1, 1], [1, 1],
    1,
  );
  pushQuad(
    verts,
    indices,
    [-hw, h - bh, -hd],
    [-hw, h - bh, hd],
    [-hw + b, h, hd - b],
    [-hw + b, h, -hd + b],
    [-nxz, ny, 0],
    [0, 1], [0, 1], [1, 1], [1, 1],
    1,
  );
  pushQuad(
    verts,
    indices,
    [hw - b, h, -hd + b],
    [hw - b, h, hd - b],
    [hw, h - bh, hd],
    [hw, h - bh, -hd],
    [nxz, ny, 0],
    [0, 1], [0, 1], [1, 1], [1, 1],
    1,
  );

  // 3. 象牙側面 (zone=1)
  const addSide = (
    x0: number, z0: number,
    x1: number, z1: number,
    y0: number, y1: number,
    nx: number, nz: number,
    uvY0: number, uvY1: number,
    zone: number,
  ) => {
    pushQuad(
      verts,
      indices,
      [x0, y1, z0],
      [x0, y0, z0],
      [x1, y0, z1],
      [x1, y1, z1],
      [nx, 0, nz],
      [0, uvY1], [0, uvY0], [1, uvY0], [1, uvY1],
      zone,
    );
  };

  addSide(-hw, -hd, hw, -hd, backSplitY, h - bh, 0, -1, 0.35, 1.0, 1);
  addSide(hw, hd, -hw, hd, backSplitY, h - bh, 0, 1, 0.35, 1.0, 1);
  addSide(-hw, hd, -hw, -hd, backSplitY, h - bh, -1, 0, 0.35, 1.0, 1);
  addSide(hw, -hd, hw, hd, backSplitY, h - bh, 1, 0, 0.35, 1.0, 1);

  // 4. 背面ゴールド側面・下ベベル・底面 (zone=2)
  addSide(-hw, -hd, hw, -hd, bh, backSplitY, 0, -1, 0.0, 0.35, 2);
  addSide(hw, hd, -hw, hd, bh, backSplitY, 0, 1, 0.0, 0.35, 2);
  addSide(-hw, hd, -hw, -hd, bh, backSplitY, -1, 0, 0.0, 0.35, 2);
  addSide(hw, -hd, hw, hd, bh, backSplitY, 1, 0, 0.0, 0.35, 2);

  pushQuad(
    verts, indices,
    [-hw + b, 0, -hd + b], [-hw, bh, -hd], [hw, bh, -hd], [hw - b, 0, -hd + b],
    [0, -ny, -nxz], [0, 0], [0, 0.2], [1, 0.2], [1, 0], 2,
  );
  pushQuad(
    verts, indices,
    [-hw, bh, hd], [-hw + b, 0, hd - b], [hw - b, 0, hd - b], [hw, bh, hd],
    [0, -ny, nxz], [0, 0.2], [0, 0], [1, 0], [1, 0.2], 2,
  );
  pushQuad(
    verts, indices,
    [-hw, bh, -hd], [-hw + b, 0, -hd + b], [-hw + b, 0, hd - b], [-hw, bh, hd],
    [-nxz, -ny, 0], [0, 0.2], [0, 0], [1, 0], [1, 0.2], 2,
  );
  pushQuad(
    verts, indices,
    [hw - b, 0, -hd + b], [hw, bh, -hd], [hw, bh, hd], [hw - b, 0, hd - b],
    [nxz, -ny, 0], [0, 0], [0, 0.2], [1, 0.2], [1, 0], 2,
  );

  pushQuad(
    verts, indices,
    [-hw + b, 0, hd - b], [-hw + b, 0, -hd + b], [hw - b, 0, -hd + b], [hw - b, 0, hd - b],
    [0, -1, 0], [0, 0], [0, 1], [1, 1], [1, 0], 2,
  );

  return uploadMesh(gl, verts, indices);
}

function buildBoxMesh(
  gl: WebGL2RenderingContext,
  zone = 3,
  topZone = zone,
): MeshBuffers {
  const verts: number[] = [];
  const indices: number[] = [];
  const h = 0.5;
  pushQuad(verts, indices, [-h, h, -h], [-h, h, h], [h, h, h], [h, h, -h], [0, 1, 0], [0, 0], [0, 1], [1, 1], [1, 0], topZone);
  pushQuad(verts, indices, [-h, -h, h], [-h, -h, -h], [h, -h, -h], [h, -h, h], [0, -1, 0], [0, 0], [0, 1], [1, 1], [1, 0], zone);
  pushQuad(verts, indices, [-h, h, h], [-h, -h, h], [h, -h, h], [h, h, h], [0, 0, 1], [0, 0], [0, 1], [1, 1], [1, 0], zone);
  pushQuad(verts, indices, [h, h, -h], [h, -h, -h], [-h, -h, -h], [-h, h, -h], [0, 0, -1], [0, 0], [0, 1], [1, 1], [1, 0], zone);
  pushQuad(verts, indices, [-h, h, -h], [-h, -h, -h], [-h, -h, h], [-h, h, h], [-1, 0, 0], [0, 0], [0, 1], [1, 1], [1, 0], zone);
  pushQuad(verts, indices, [h, h, h], [h, -h, h], [h, -h, -h], [h, h, -h], [1, 0, 0], [0, 0], [0, 1], [1, 1], [1, 0], zone);
  return uploadMesh(gl, verts, indices);
}

function buildQuadPlaneMesh(gl: WebGL2RenderingContext, zone: number): MeshBuffers {
  const verts: number[] = [];
  const indices: number[] = [];
  pushQuad(
    verts,
    indices,
    [-0.5, 0, -0.5],
    [-0.5, 0, 0.5],
    [0.5, 0, 0.5],
    [0.5, 0, -0.5],
    [0, 1, 0],
    [0, 0],
    [0, 1],
    [1, 1],
    [1, 0],
    zone,
  );
  return uploadMesh(gl, verts, indices);
}

function buildDiamondMarkerMesh(gl: WebGL2RenderingContext): MeshBuffers {
  const verts: number[] = [];
  const indices: number[] = [];
  const top: [number, number, number] = [0, 0.5, 0];
  const bot: [number, number, number] = [0, -0.5, 0];
  const ring: [number, number, number][] = [
    [0.24, 0.1, 0],
    [0, 0.1, 0.24],
    [-0.24, 0.1, 0],
    [0, 0.1, -0.24],
  ];
  const addTri = (
    a: readonly [number, number, number],
    b: readonly [number, number, number],
    c: readonly [number, number, number],
  ) => {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    const base = verts.length / 9;
    verts.push(a[0], a[1], a[2], nx, ny, nz, 0.5, 0.5, 3);
    verts.push(b[0], b[1], b[2], nx, ny, nz, 0.5, 0.5, 3);
    verts.push(c[0], c[1], c[2], nx, ny, nz, 0.5, 0.5, 3);
    indices.push(base, base + 1, base + 2);
  };
  for (let i = 0; i < 4; i++) {
    const p1 = ring[i]!;
    const p2 = ring[(i + 1) % 4]!;
    addTri(top, p1, p2);
    addTri(bot, p2, p1);
  }
  return uploadMesh(gl, verts, indices);
}

function drawRoundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rad = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.lineTo(x + w - rad, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rad);
  ctx.lineTo(x + w, y + h - rad);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rad, y + h);
  ctx.lineTo(x + rad, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rad);
  ctx.lineTo(x, y + rad);
  ctx.quadraticCurveTo(x, y, x + rad, y);
  ctx.closePath();
}

// ==================================================
// メイン 3D シーンコントローラ
// ==================================================
export class Mahjong3DScene {
  readonly canvas: HTMLCanvasElement;
  private readonly gl: WebGL2RenderingContext;
  private readonly prog: WebGLProgram;

  private readonly uViewProj: WebGLUniformLocation;
  private readonly uModel: WebGLUniformLocation;
  private readonly uColor: WebGLUniformLocation;
  private readonly uUvRect: WebGLUniformLocation;
  private readonly uUseAtlas: WebGLUniformLocation;
  private readonly uUseConsole: WebGLUniformLocation;
  private readonly uBackTone: WebGLUniformLocation;
  private readonly uHighlight: WebGLUniformLocation;
  private readonly uEmissive: WebGLUniformLocation;
  private readonly uDoraGlow: WebGLUniformLocation;
  private readonly uTime: WebGLUniformLocation;
  private readonly uCamPos: WebGLUniformLocation;
  private readonly uAtlasTex: WebGLUniformLocation;
  private readonly uConsoleTex: WebGLUniformLocation;

  private readonly tileMesh: MeshBuffers;
  private readonly boxMesh: MeshBuffers;
  private readonly consoleDeckMesh: MeshBuffers;
  private readonly feltMesh: MeshBuffers;
  private readonly shadowMesh: MeshBuffers;
  private readonly markerMesh: MeshBuffers;

  private atlas: TileAtlas;
  private readonly atlasUvMap = new Map<string, TileFaceUv>();
  private atlasTex: WebGLTexture;

  private readonly consoleCanvas: HTMLCanvasElement;
  private readonly consoleCtx: CanvasRenderingContext2D;
  private readonly consoleTex: WebGLTexture;
  private consoleDirty = true;

  private params: Table3DSyncParams | null = null;
  private callbacks: Table3DCallbacks = {};
  private selectedTileId: string | null = null;
  private hoveredTileId: string | null = null;
  private hoverProgress = new Map<string, number>();
  private selectProgress = new Map<string, number>();
  private handHitBoxes: HandHitBox[] = [];

  private throwAnims: ThrowAnimState[] = [];
  private drawAnims: DrawAnimState[] = [];
  private doraFlipAnims: DoraFlipAnimState[] = [];
  private animQueue: DrawRequest[] = [];

  private cameraPreset: Table3DCameraPreset = 'standard';
  private userYawOffset = 0;
  private userPitchOffset = 0;
  private currentYaw = 0;
  private currentPitch = deg(47);
  private currentZoom = 1.0;

  private viewProjMatrix = mat4Identity();
  private invViewProjMatrix: Float32Array | null = null;
  private camPos: [number, number, number] = [0, 12, 12];

  private dragging = false;
  private dragMoved = false;
  private dragStartX = 0;
  private dragStartY = 0;
  private dragStartYaw = 0;
  private dragStartPitch = 0;
  private lastDiscardTarget: { playerId: string; tileId: string } | null = null;
  private lastRoundKey: string | null = null;

  private resizeObserver: ResizeObserver | null = null;
  private rafId: number | null = null;
  private paused = false;
  private destroyed = false;
  private contextLost = false;
  private lastTickTime = 0;
  private elapsed = 0;
  private activeDoraKinds = new Set<TileKind>();

  private readonly onPointerDownBound = (e: PointerEvent) => this.handlePointerDown(e);
  private readonly onPointerMoveBound = (e: PointerEvent) => this.handlePointerMove(e);
  private readonly onPointerUpBound = (e: PointerEvent) => this.handlePointerUp(e);
  private readonly onPointerCancelBound = () => this.handlePointerCancel();
  private readonly onPointerLeaveBound = () => {
    this.hoveredTileId = null;
    this.canvas.style.cursor = 'default';
  };
  private readonly onDoubleClickBound = () => this.resetCamera();
  private readonly onContextLostBound = (e: Event) => {
    e.preventDefault();
    this.contextLost = true;
  };
  private readonly onContextRestoredBound = () => {
    this.contextLost = false;
    this.uploadAtlasTexture();
    this.consoleDirty = true;
  };

  static tryCreate(callbacks: Table3DCallbacks = {}): Mahjong3DScene | null {
    if (typeof document === 'undefined') return null;
    const canvas = document.createElement('canvas');
    let gl: WebGL2RenderingContext | null = null;
    try {
      gl = canvas.getContext('webgl2', {
        antialias: true,
        alpha: false,
        powerPreference: 'high-performance',
      });
    } catch {
      return null;
    }
    if (!gl) return null;
    try {
      return new Mahjong3DScene(canvas, gl, callbacks);
    } catch {
      return null;
    }
  }

  private constructor(
    canvas: HTMLCanvasElement,
    gl: WebGL2RenderingContext,
    callbacks: Table3DCallbacks,
  ) {
    this.canvas = canvas;
    this.canvas.className = 'table-3d-canvas';
    this.gl = gl;
    this.callbacks = callbacks;

    this.prog = createProgram(gl, VERT_SRC, FRAG_SRC);
    this.uViewProj = gl.getUniformLocation(this.prog, 'uViewProj')!;
    this.uModel = gl.getUniformLocation(this.prog, 'uModel')!;
    this.uColor = gl.getUniformLocation(this.prog, 'uColor')!;
    this.uUvRect = gl.getUniformLocation(this.prog, 'uUvRect')!;
    this.uUseAtlas = gl.getUniformLocation(this.prog, 'uUseAtlas')!;
    this.uUseConsole = gl.getUniformLocation(this.prog, 'uUseConsole')!;
    this.uBackTone = gl.getUniformLocation(this.prog, 'uBackTone')!;
    this.uHighlight = gl.getUniformLocation(this.prog, 'uHighlight')!;
    this.uEmissive = gl.getUniformLocation(this.prog, 'uEmissive')!;
    this.uDoraGlow = gl.getUniformLocation(this.prog, 'uDoraGlow')!;
    this.uTime = gl.getUniformLocation(this.prog, 'uTime')!;
    this.uCamPos = gl.getUniformLocation(this.prog, 'uCamPos')!;
    this.uAtlasTex = gl.getUniformLocation(this.prog, 'uAtlasTex')!;
    this.uConsoleTex = gl.getUniformLocation(this.prog, 'uConsoleTex')!;

    this.tileMesh = buildBeveledTileMesh(gl);
    this.boxMesh = buildBoxMesh(gl, 3, 3);
    this.consoleDeckMesh = buildBoxMesh(gl, 3, 2);
    this.feltMesh = buildQuadPlaneMesh(gl, 5);
    this.shadowMesh = buildQuadPlaneMesh(gl, 6);
    this.markerMesh = buildDiamondMarkerMesh(gl);

    this.atlas = createTileAtlas({ size: 2048 });
    this.atlasTex = gl.createTexture()!;
    this.uploadAtlasTexture();

    // Webフォント読み込み完了後に、もしフォントが新しく入っていたら高精細アトラスを貼り直す
    void waitForTileFonts().then(() => {
      if (this.destroyed || this.contextLost) return;
      this.atlas.dispose();
      this.atlas = createTileAtlas({ size: 2048 });
      this.uploadAtlasTexture();
    });

    this.consoleCanvas = document.createElement('canvas');
    this.consoleCanvas.width = 512;
    this.consoleCanvas.height = 512;
    this.consoleCtx = this.consoleCanvas.getContext('2d')!;
    this.consoleTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.consoleTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);

    this.bindEvents();
    this.startLoop();
  }

  private uploadAtlasTexture(): void {
    const gl = this.gl;
    this.atlasUvMap.clear();
    for (const cell of this.atlas.cells) {
      const k = cell.key.isRed ? `${cell.key.kind}:red` : cell.key.kind;
      this.atlasUvMap.set(k, {
        u0: cell.x / this.atlas.size,
        v0: cell.y / this.atlas.size,
        u1: (cell.x + cell.width) / this.atlas.size,
        v1: (cell.y + cell.height) / this.atlas.size,
      });
    }

    gl.bindTexture(gl.TEXTURE_2D, this.atlasTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      this.atlas.canvas,
    );
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const aniso = gl.getExtension('EXT_texture_filter_anisotropic');
    if (aniso) {
      const maxAniso = gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT) as number;
      gl.texParameterf(
        gl.TEXTURE_2D,
        aniso.TEXTURE_MAX_ANISOTROPY_EXT,
        Math.min(8, maxAniso),
      );
    }
  }

  private bindEvents(): void {
    this.canvas.addEventListener('pointerdown', this.onPointerDownBound);
    this.canvas.addEventListener('pointermove', this.onPointerMoveBound);
    this.canvas.addEventListener('pointerup', this.onPointerUpBound);
    this.canvas.addEventListener('pointercancel', this.onPointerCancelBound);
    this.canvas.addEventListener('pointerleave', this.onPointerLeaveBound);
    this.canvas.addEventListener('dblclick', this.onDoubleClickBound);
    this.canvas.addEventListener('webglcontextlost', this.onContextLostBound);
    this.canvas.addEventListener('webglcontextrestored', this.onContextRestoredBound);

    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.syncCanvasSize());
      this.resizeObserver.observe(this.canvas);
    }
  }

  setCallbacks(callbacks: Table3DCallbacks): void {
    this.callbacks = callbacks;
  }

  setSelectedTileId(tileId: string | null): void {
    this.selectedTileId = tileId;
  }

  resetCamera(): void {
    this.userYawOffset = 0;
    this.userPitchOffset = 0;
  }

  pause(): void {
    this.paused = true;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  resume(): void {
    if (this.destroyed) return;
    if (!this.paused && this.rafId !== null) return;
    this.paused = false;
    this.startLoop();
  }

  syncView(nextParams: Table3DSyncParams): void {
    this.params = nextParams;
    this.selectedTileId = nextParams.selectedTileId;
    this.cameraPreset = nextParams.cameraPreset;
    this.consoleDirty = true;

    const view = nextParams.view;
    const round = view.round;
    this.activeDoraKinds.clear();
    if (round) {
      const rules = deriveRules(view.ruleConfig);
      for (const dk of getActiveDoraKinds(round.doraIndicators, rules)) {
        this.activeDoraKinds.add(dk);
      }
      if (rules.playerCount === 3 && rules.kitaCountsAsIndicatorDora) {
        this.activeDoraKinds.add('4z');
      }
    }

    const now = performance.now() / 1000;
    const bySide = this.getPlayersBySide(view);

    const roundKey = round
      ? `${round.roundIndex}:${round.kyokuNumber}:${round.honba}`
      : null;
    if (roundKey !== this.lastRoundKey) {
      this.lastRoundKey = roundKey;
      this.lastDiscardTarget = null;
      this.throwAnims.length = 0;
      this.drawAnims.length = 0;
      this.doraFlipAnims.length = 0;
    }

    // 直前の鳴き・副露で最後の捨て牌が既に回収された場合を考慮して存在チェック
    if (this.lastDiscardTarget) {
      const targetPlayer = view.players.find(
        (p) => p.playerId === this.lastDiscardTarget!.playerId,
      );
      const stillInRiver = targetPlayer?.discards.some(
        (d) => d.tile.id === this.lastDiscardTarget!.tileId,
      );
      if (!stillInRiver) {
        this.lastDiscardTarget = null;
      }
    }

    if (view.myCallOptions?.discardedTile) {
      const targetId = view.myCallOptions.discardedTile.id;
      for (const p of view.players) {
        if (p.discards.some((d) => d.tile.id === targetId)) {
          this.lastDiscardTarget = { playerId: p.playerId, tileId: targetId };
          break;
        }
      }
    }

    if (nextParams.newlyDiscardedSides) {
      for (const side of nextParams.newlyDiscardedSides) {
        const player = bySide.get(side);
        if (!player || player.discards.length === 0) continue;
        const discardIndex = player.discards.length - 1;
        this.lastDiscardTarget = {
          playerId: player.playerId,
          tileId: player.discards[discardIndex]!.tile.id,
        };
        this.throwAnims.push({
          side,
          discardIndex,
          startTime: now,
          duration: 0.28,
          from: this.getHandOriginForSide(side),
        });
      }
    }

    if (!this.lastDiscardTarget && round) {
      // 初回表示時や観戦途中参加時: 手番プレイヤーの1つ前（または河がある直近席）の最新捨て牌を推定
      const n = view.players.length;
      for (let step = 1; step <= n; step++) {
        const prevSeat = ((round.currentTurnIndex - step) % n + n) % n;
        const p = view.players.find((pl) => pl.seatIndex === prevSeat);
        if (p && p.discards.length > 0) {
          this.lastDiscardTarget = {
            playerId: p.playerId,
            tileId: p.discards[p.discards.length - 1]!.tile.id,
          };
          break;
        }
      }
    }

    if (nextParams.newlyDrawnSides) {
      for (const side of nextParams.newlyDrawnSides) {
        this.drawAnims.push({
          side,
          startTime: now,
          duration: 0.21,
        });
      }
    }

    if (nextParams.newlyRevealedDoraIndices) {
      for (const idx of nextParams.newlyRevealedDoraIndices) {
        this.doraFlipAnims.push({
          index: idx,
          startTime: now,
          duration: 0.34,
        });
      }
    }

    this.syncCanvasSize();
  }

  private getHandOriginForSide(side: SeatSide3D): [number, number, number] {
    switch (side) {
      case 'self':
        return [0.4, 0.9, 5.2];
      case 'right':
        return [5.5, 0.7, 0];
      case 'top':
        return [0, 0.7, -5.5];
      case 'left':
        return [-5.5, 0.7, 0];
    }
  }

  private getPlayersBySide(view: StateView): Map<SeatSide3D, PublicPlayerView> {
    const map = new Map<SeatSide3D, PublicPlayerView>();
    const count = view.players.length;
    for (const p of view.players) {
      const rel = ((p.seatIndex - view.viewerSeatIndex) % count + count) % count;
      if (rel === 0) map.set('self', p);
      else if (rel === 1) map.set('right', p);
      else if (count === 4 && rel === 2) map.set('top', p);
      else map.set('left', p);
    }
    return map;
  }

  private syncCanvasSize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  private getTileUv(kind: TileKind, isRed = false): [number, number, number, number] {
    const k = isRed ? `${kind}:red` : kind;
    const c = this.atlasUvMap.get(k) ?? this.atlasUvMap.get(kind);
    if (!c) return [0, 0, 0.1, 0.1];
    return [c.u0, c.v0, c.u1, c.v1];
  }

  private isDoraTile(tile: Tile): boolean {
    return tile.isRed || this.activeDoraKinds.has(tile.kind);
  }

  private startLoop(): void {
    if (this.rafId !== null || this.paused || this.destroyed) return;
    this.lastTickTime = performance.now() / 1000;
    const step = () => {
      if (this.paused || this.destroyed || !this.canvas.isConnected) {
        this.paused = true;
        this.rafId = null;
        return;
      }
      const now = performance.now() / 1000;
      const dt = Math.min(0.05, Math.max(0, now - this.lastTickTime));
      this.lastTickTime = now;
      this.elapsed += dt;
      if (!this.contextLost && this.params) {
        this.renderFrame(now, dt);
      }
      this.rafId = requestAnimationFrame(step);
    };
    this.rafId = requestAnimationFrame(step);
  }

  // ==================================================
  // ポインター / タップ・ホバー・視点ドラッグ処理
  // ==================================================
  private getCanvasNdc(e: PointerEvent): [number, number] | null {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const nx = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const ny = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    return [nx, ny];
  }

  private pickHandTile(e: PointerEvent): string | null {
    if (!this.invViewProjMatrix || this.handHitBoxes.length === 0) return null;
    const ndc = this.getCanvasNdc(e);
    if (!ndc) return null;
    const [nx, ny] = ndc;
    const inv = this.invViewProjMatrix;

    const unproject = (zNdc: number): [number, number, number] => {
      const w = inv[3]! * nx + inv[7]! * ny + inv[11]! * zNdc + inv[15]!;
      return [
        (inv[0]! * nx + inv[4]! * ny + inv[8]! * zNdc + inv[12]!) / w,
        (inv[1]! * nx + inv[5]! * ny + inv[9]! * zNdc + inv[13]!) / w,
        (inv[2]! * nx + inv[6]! * ny + inv[10]! * zNdc + inv[14]!) / w,
      ];
    };

    const pNear = unproject(-1);
    const pFar = unproject(1);
    const dx = pFar[0] - pNear[0];
    const dy = pFar[1] - pNear[1];
    const dz = pFar[2] - pNear[2];
    const len = Math.hypot(dx, dy, dz) || 1;
    const rx = dx / len;
    const ry = dy / len;
    const rz = dz / len;

    let bestDist = Infinity;
    let bestId: string | null = null;

    // 厳密な Ray-OBB 交差で手牌の各牌に当てる（Y軸方向・高さ方向にわずかな余裕を与えてスマホ指でも当てやすくする）
    for (const box of this.handHitBoxes) {
      const ox = box.center[0] - pNear[0];
      const oy = box.center[1] - pNear[1];
      const oz = box.center[2] - pNear[2];

      let tMin = -Infinity;
      let tMax = Infinity;
      const axes: ReadonlyArray<readonly [[number, number, number], number]> = [
        [box.axisX, box.halfX + 0.035],
        [box.axisY, box.halfY + 0.04],
        [box.axisZ, box.halfZ + 0.06],
      ];
      let missed = false;
      for (const [axis, half] of axes) {
        const eDot = axis[0] * ox + axis[1] * oy + axis[2] * oz;
        const fDot = axis[0] * rx + axis[1] * ry + axis[2] * rz;
        if (Math.abs(fDot) > 1e-6) {
          let t1 = (eDot - half) / fDot;
          let t2 = (eDot + half) / fDot;
          if (t1 > t2) {
            const tmp = t1;
            t1 = t2;
            t2 = tmp;
          }
          tMin = Math.max(tMin, t1);
          tMax = Math.min(tMax, t2);
          if (tMin > tMax) {
            missed = true;
            break;
          }
        } else if (-eDot - half > 0 || -eDot + half < 0) {
          missed = true;
          break;
        }
      }
      if (!missed && tMax >= 0) {
        const hitT = tMin >= 0 ? tMin : tMax;
        if (hitT < bestDist) {
          bestDist = hitT;
          bestId = box.tileId;
        }
      }
    }
    return bestId;
  }

  private handlePointerDown(e: PointerEvent): void {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    this.dragging = true;
    this.dragMoved = false;
    this.dragStartX = e.clientX;
    this.dragStartY = e.clientY;
    this.dragStartYaw = this.userYawOffset;
    this.dragStartPitch = this.userPitchOffset;
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      // ignore if capture is unsupported
    }
  }

  private handlePointerMove(e: PointerEvent): void {
    if (this.dragging) {
      const totalDist = Math.hypot(
        e.clientX - this.dragStartX,
        e.clientY - this.dragStartY,
      );
      if (totalDist > 12) {
        this.dragMoved = true;
        this.userYawOffset = Math.max(
          deg(-22),
          Math.min(deg(22), this.dragStartYaw + (e.clientX - this.dragStartX) * 0.004),
        );
        this.userPitchOffset = Math.max(
          deg(-12),
          Math.min(deg(16), this.dragStartPitch + (e.clientY - this.dragStartY) * 0.004),
        );
      }
      this.canvas.style.cursor = this.dragMoved ? 'grabbing' : 'default';
      return;
    }

    if (e.pointerType === 'mouse') {
      const hitId = this.pickHandTile(e);
      const box = hitId
        ? this.handHitBoxes.find((b) => b.tileId === hitId)
        : undefined;
      this.hoveredTileId = box?.clickable ? hitId : null;
      this.canvas.style.cursor = this.hoveredTileId ? 'pointer' : 'default';
    }
  }

  private handlePointerUp(e: PointerEvent): void {
    if (!this.dragging) return;
    this.dragging = false;
    try {
      this.canvas.releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }

    if (!this.dragMoved) {
      const hitId = this.pickHandTile(e);
      if (hitId) {
        const box = this.handHitBoxes.find((b) => b.tileId === hitId);
        if (box?.clickable) {
          this.callbacks.onClickHandTile?.(hitId);
        }
      } else {
        this.callbacks.onClickTableVoid?.();
      }
    }
    this.dragMoved = false;
    this.canvas.style.cursor = 'default';
  }

  private handlePointerCancel(): void {
    this.dragging = false;
    this.dragMoved = false;
    this.canvas.style.cursor = 'default';
  }

  // ==================================================
  // 中央デジタルコンソール（512×512 Canvas2D → GPU）
  // ==================================================
  private updateConsoleTexture(): void {
    if (!this.consoleDirty || !this.params) return;
    this.consoleDirty = false;
    const { view } = this.params;
    const ctx = this.consoleCtx;
    const W = 512;
    const H = 512;

    ctx.fillStyle = '#0c1626';
    ctx.fillRect(0, 0, W, H);

    // 外枠
    ctx.strokeStyle = '#334d73';
    ctx.lineWidth = 6;
    ctx.strokeRect(10, 10, W - 20, H - 20);

    // 内枠パネル
    const grad = ctx.createRadialGradient(256, 256, 10, 256, 256, 128);
    grad.addColorStop(0, '#162845');
    grad.addColorStop(1, '#091220');
    ctx.fillStyle = grad;
    drawRoundRectPath(ctx, 148, 148, 216, 216, 22);
    ctx.fill();
    ctx.strokeStyle = 'rgba(240, 201, 92, 0.45)';
    ctx.lineWidth = 3;
    ctx.stroke();

    const round = view.round;
    if (round) {
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      ctx.fillStyle = '#f0c95c';
      ctx.font = 'bold 44px "Noto Sans JP", "Hiragino Sans", sans-serif';
      ctx.fillText(`${windToJa(round.roundWind)}${round.kyokuNumber}局`, 256, 208);

      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 54px "Inter", "Noto Sans JP", monospace';
      ctx.fillText(`${round.remainingWallCount}`, 256, 266);

      ctx.fillStyle = '#9bb2d4';
      ctx.font = 'bold 20px "Noto Sans JP", sans-serif';
      ctx.fillText(
        `残牌 / ${round.honba}本場・供託${view.kyotakuCount}`,
        256,
        320,
      );
    }

    const bySide = this.getPlayersBySide(view);
    const drawSide = (
      side: SeatSide3D,
      cx: number,
      cy: number,
      rot: number,
    ) => {
      const p = bySide.get(side);
      if (!p) return;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(rot);

      if (p.isCurrentTurn) {
        ctx.fillStyle = 'rgba(240, 201, 92, 0.22)';
        ctx.strokeStyle = '#ffd562';
        ctx.lineWidth = 3;
        drawRoundRectPath(ctx, -130, -44, 260, 88, 12);
        ctx.fill();
        ctx.stroke();
      }

      if (p.seatWind) {
        ctx.fillStyle = p.isDealer ? '#d4382c' : '#2a436e';
        drawRoundRectPath(ctx, -114, -26, 46, 52, 8);
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 30px "Noto Sans JP", sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(windToJa(p.seatWind), -91, 1);
      }

      ctx.fillStyle = p.isCurrentTurn ? '#ffdf85' : '#eaf2ff';
      ctx.font = 'bold 36px "Inter", "Noto Sans JP", monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(p.score.toLocaleString(), -54, 1);

      ctx.restore();
    };

    drawSide('self', 256, 434, 0);
    drawSide('right', 434, 256, -Math.PI / 2);
    drawSide('top', 256, 78, Math.PI);
    drawSide('left', 78, 256, Math.PI / 2);

    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.consoleTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      this.consoleCanvas,
    );
    gl.generateMipmap(gl.TEXTURE_2D);
  }

  // ==================================================
  // 描画キュー投入 & バッチ描画
  // ==================================================
  private drawTile(
    model: Float32Array,
    uvRect: [number, number, number, number],
    opts: {
      tint?: [number, number, number, number];
      highlight?: number;
      doraGlow?: boolean;
      backTone?: number;
      useAtlas?: boolean;
    } = {},
  ): void {
    this.animQueue.push({
      mesh: this.tileMesh,
      model,
      color: opts.tint ?? [1, 1, 1, 1],
      uvRect,
      useAtlas: opts.useAtlas === false ? 0 : 1,
      useConsole: 0,
      backTone: opts.backTone ?? 0,
      highlight: opts.highlight ?? 0,
      emissive: 0,
      doraGlow: opts.doraGlow ? 1 : 0,
    });
  }

  private drawTileWithShadow(
    model: Float32Array,
    tx: number,
    tz: number,
    ry: number,
    scale: number,
    uvRect: [number, number, number, number],
    opts: {
      tint?: [number, number, number, number];
      highlight?: number;
      doraGlow?: boolean;
      backTone?: number;
      shadowAlpha?: number;
    } = {},
  ): void {
    this.animQueue.push({
      mesh: this.shadowMesh,
      model: mat4Compose(
        tx + 0.03,
        0.003,
        tz + 0.04,
        0,
        ry,
        0,
        TILE_W * scale * 1.15,
        1,
        TILE_H * scale * 1.15,
      ),
      color: [0.02, 0.04, 0.08, opts.shadowAlpha ?? 0.36],
      uvRect: [0, 0, 1, 1],
      useAtlas: 0,
      useConsole: 0,
      backTone: 0,
      highlight: 0,
      emissive: 0,
      doraGlow: 0,
    });
    this.drawTile(model, uvRect, opts);
  }

  private drawBox(
    model: Float32Array,
    color: [number, number, number, number],
    opts: { emissive?: number; useConsole?: boolean } = {},
  ): void {
    this.animQueue.push({
      mesh: opts.useConsole ? this.consoleDeckMesh : this.boxMesh,
      model,
      color,
      uvRect: [0, 0, 1, 1],
      useAtlas: 0,
      useConsole: opts.useConsole ? 1 : 0,
      backTone: 0,
      highlight: 0,
      emissive: opts.emissive ?? 0,
      doraGlow: 0,
    });
  }

  private renderFrame(now: number, dt: number): void {
    const params = this.params;
    if (!params) return;
    const gl = this.gl;

    this.syncCanvasSize();
    const w = this.canvas.width;
    const h = this.canvas.height;
    if (w <= 0 || h <= 0) return;

    this.updateConsoleTexture();

    // 終了済みアニメを掃除
    this.throwAnims = this.throwAnims.filter(
      (a) => now - a.startTime < a.duration,
    );
    this.drawAnims = this.drawAnims.filter(
      (a) => now - a.startTime < a.duration,
    );
    this.doraFlipAnims = this.doraFlipAnims.filter(
      (a) => now - a.startTime < a.duration,
    );

    // カメラ角度・距離の補間
    const basePitch =
      this.cameraPreset === 'high'
        ? deg(60)
        : this.cameraPreset === 'low'
          ? deg(38)
          : deg(47);
    const targetPitch = Math.max(
      deg(31),
      Math.min(deg(68), basePitch + this.userPitchOffset),
    );
    const targetYaw = this.userYawOffset;
    const aspect = w / h;

    // 縦狭（タブレット縦画面や狭いウインドウ）や超ワイド（スマホ横長）でも卓全体・手牌14枚が収まる距離補正
    const aspectZoom =
      aspect < 1.5 ? 1.5 / Math.max(0.85, aspect) : Math.max(0.96, 1.0 + (aspect - 1.78) * 0.04);
    const presetZoom =
      this.cameraPreset === 'high'
        ? 1.06
        : this.cameraPreset === 'low'
          ? 0.94
          : 1.0;
    const targetZoom = aspectZoom * presetZoom;

    const lerp = Math.min(1, dt * 12);
    this.currentPitch += (targetPitch - this.currentPitch) * lerp;
    this.currentYaw += (targetYaw - this.currentYaw) * lerp;
    this.currentZoom += (targetZoom - this.currentZoom) * lerp;

    const dist = 18.8 * this.currentZoom;
    const targetY = this.cameraPreset === 'high' ? -0.1 : -0.15;
    const targetZ = this.cameraPreset === 'low' ? 1.35 : 1.15;
    const target: [number, number, number] = [0, targetY, targetZ];

    const ey = Math.sin(this.currentPitch) * dist + target[1];
    const hDist = Math.cos(this.currentPitch) * dist;
    const ex = Math.sin(this.currentYaw) * hDist + target[0];
    const ez = Math.cos(this.currentYaw) * hDist + target[2];
    this.camPos = [ex, ey, ez];

    const proj = mat4Perspective(deg(40), aspect, 0.5, 100);
    const viewMat = mat4LookAt(this.camPos, target, [0, 1, 0]);
    this.viewProjMatrix = mat4Multiply(proj, viewMat);
    this.invViewProjMatrix = mat4Invert(this.viewProjMatrix);

    // シーン構築
    this.animQueue.length = 0;
    this.handHitBoxes.length = 0;
    this.populateScene(params, now, dt);

    // GPU へ描画
    gl.viewport(0, 0, w, h);
    gl.clearColor(0.035, 0.065, 0.13, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    gl.useProgram(this.prog);
    gl.uniformMatrix4fv(this.uViewProj, false, this.viewProjMatrix);
    gl.uniform1f(this.uTime, this.elapsed);
    gl.uniform3fv(this.uCamPos, this.camPos);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.atlasTex);
    gl.uniform1i(this.uAtlasTex, 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.consoleTex);
    gl.uniform1i(this.uConsoleTex, 1);

    let lastVao: WebGLVertexArrayObject | null = null;
    for (const cmd of this.animQueue) {
      if (cmd.color[3] < 0.999) {
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.depthMask(false);
      } else {
        gl.disable(gl.BLEND);
        gl.depthMask(true);
      }

      if (cmd.mesh.vao !== lastVao) {
        gl.bindVertexArray(cmd.mesh.vao);
        lastVao = cmd.mesh.vao;
      }

      gl.uniformMatrix4fv(this.uModel, false, cmd.model);
      gl.uniform4fv(this.uColor, cmd.color);
      gl.uniform4fv(this.uUvRect, cmd.uvRect);
      gl.uniform1f(this.uUseAtlas, cmd.useAtlas);
      gl.uniform1f(this.uUseConsole, cmd.useConsole);
      gl.uniform1f(this.uBackTone, cmd.backTone);
      gl.uniform1f(this.uHighlight, cmd.highlight);
      gl.uniform1f(this.uEmissive, cmd.emissive);
      gl.uniform1f(this.uDoraGlow, cmd.doraGlow);

      gl.drawElements(gl.TRIANGLES, cmd.mesh.indexCount, gl.UNSIGNED_SHORT, 0);
    }

    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
  }

  private populateScene(
    params: Table3DSyncParams,
    now: number,
    dt: number,
  ): void {
    const { view } = params;
    const round = view.round;
    const bySide = this.getPlayersBySide(view);

    // 1. 青藍色フェルト＋木枠＋真鍮エッジ＋中央デジタルコンソール
    this.animQueue.push({
      mesh: this.feltMesh,
      model: mat4Compose(0, 0, 0, 0, 0, 0, 14.8, 1, 14.8),
      color: [1, 1, 1, 1],
      uvRect: [0, 0, 1, 1],
      useAtlas: 0,
      useConsole: 0,
      backTone: 0,
      highlight: 0,
      emissive: 0,
      doraGlow: 0,
    });

    const frameCol: [number, number, number, number] = [0.22, 0.11, 0.055, 1];
    const trimCol: [number, number, number, number] = [0.68, 0.52, 0.24, 1];
    this.drawBox(mat4Compose(0, 0.22, -7.75, 0, 0, 0, 16.2, 0.55, 0.72), frameCol);
    this.drawBox(mat4Compose(0, 0.22, 7.75, 0, 0, 0, 16.2, 0.55, 0.72), frameCol);
    this.drawBox(mat4Compose(-7.75, 0.22, 0, 0, 0, 0, 0.72, 0.55, 14.8), frameCol);
    this.drawBox(mat4Compose(7.75, 0.22, 0, 0, 0, 0, 0.72, 0.55, 14.8), frameCol);

    this.drawBox(mat4Compose(0, 0.05, -7.36, 0, 0, 0, 14.76, 0.1, 0.05), trimCol);
    this.drawBox(mat4Compose(0, 0.05, 7.36, 0, 0, 0, 14.76, 0.1, 0.05), trimCol);
    this.drawBox(mat4Compose(-7.36, 0.05, 0, 0, 0, 0, 0.05, 0.1, 14.76), trimCol);
    this.drawBox(mat4Compose(7.36, 0.05, 0, 0, 0, 0, 0.05, 0.1, 14.76), trimCol);

    // 中央コンソール
    this.drawBox(mat4Compose(0, 0.03, 0, 0, 0, 0, 2.7, 0.08, 2.7), [0.16, 0.2, 0.28, 1]);
    this.drawBox(mat4Compose(0, 0.05, 0, 0, 0, 0, 2.46, 0.09, 2.46), [1, 1, 1, 1], {
      useConsole: true,
    });

    // リーチ棒（リーチ中の席の前 + 供託）
    const stickPositions: Array<{ side: SeatSide3D; x: number; z: number; ry: number }> = [
      { side: 'self', x: 0, z: 1.48, ry: 0 },
      { side: 'right', x: 1.48, z: 0, ry: Math.PI / 2 },
      { side: 'top', x: 0, z: -1.48, ry: 0 },
      { side: 'left', x: -1.48, z: 0, ry: Math.PI / 2 },
    ];
    for (const sp of stickPositions) {
      const p = bySide.get(sp.side);
      if (!p?.isRiichi) continue;
      this.drawBox(
        mat4Compose(sp.x, 0.06, sp.z, 0, sp.ry, 0, 0.92, 0.06, 0.11),
        [0.97, 0.96, 0.92, 1],
      );
      this.drawBox(
        mat4Compose(sp.x, 0.085, sp.z, 0, sp.ry, 0, 0.1, 0.03, 0.08),
        [0.86, 0.16, 0.14, 1],
        { emissive: 0.2 },
      );
    }

    // 2. 牌山 & 王牌ドラめくり
    if (round) {
      this.populateWallAndDeadWall(view, now);
    }

    // 3. 河（最大4席・3人時は3席）
    const sides: SeatSide3D[] = ['self', 'right', 'top', 'left'];
    for (const side of sides) {
      const player = bySide.get(side);
      if (!player) continue;
      this.populateRiver(side, player, now);
      this.populateMeldsAndKita(side, player, view.players.length);
    }

    // 4. 他家の立牌（round_end で revealedHands があるときは表向き公開！）
    const oppSides: SeatSide3D[] = ['top', 'left', 'right'];
    for (const side of oppSides) {
      const player = bySide.get(side);
      if (!player) continue;
      const revealed = round?.revealedHands[player.playerId];
      if (revealed && revealed.length > 0) {
        this.populateRevealedOpponentHand(side, revealed);
      } else {
        this.populateHiddenOpponentHand(side, player, now);
      }
    }

    // 5. 自分（または視点席）の手牌
    const selfPlayer = bySide.get('self');
    if (selfPlayer) {
      const revealedSelf = round?.revealedHands[selfPlayer.playerId];
      if (params.isSpectator) {
        if (revealedSelf && revealedSelf.length > 0) {
          this.populateRevealedOpponentHand('self', revealedSelf);
        } else {
          this.populateHiddenSelfHand(selfPlayer, now);
        }
      } else {
        this.populateInteractiveSelfHand(params, selfPlayer, now, dt);
      }
    }
  }

  private populateWallAndDeadWall(view: StateView, now: number): void {
    const round = view.round;
    if (!round) return;
    const rules = deriveRules(view.ruleConfig);
    const totalStacks = Math.floor(rules.totalTiles / 2); // 4p: 68幢, 3p: 54幢
    const stacksPerSide = [
      Math.ceil(totalStacks / 4),
      Math.floor(totalStacks / 4),
      Math.ceil((totalStacks - Math.ceil(totalStacks / 4) - Math.floor(totalStacks / 4)) / 2),
      totalStacks -
        Math.ceil(totalStacks / 4) -
        Math.floor(totalStacks / 4) -
        Math.ceil((totalStacks - Math.ceil(totalStacks / 4) - Math.floor(totalStacks / 4)) / 2),
    ];

    // 牌山消費数の概算（王牌7幢=14枚 + remainingWallCount）
    const deadWallTiles = rules.deadWallSize; // 通常14
    const remainingWall = Math.max(0, round.remainingWallCount);
    const drawnFromWall = Math.max(
      0,
      rules.totalTiles - deadWallTiles - remainingWall,
    );

    const wallSides = [
      { ry: 0, dist: 4.28 },
      { ry: -Math.PI / 2, dist: 4.28 },
      { ry: Math.PI, dist: 4.28 },
      { ry: Math.PI / 2, dist: 4.28 },
    ];

    const ws = WALL_SCALE;
    const step = TILE_W * ws + 0.012;
    const hLayer = TILE_D * ws;

    // ドラ表示牌が載る王牌のグローバル・スロット位置（最後の7幢、そのうち後ろから3〜7幢目の上段）
    const doraIndicators = round.doraIndicators;
    const kanBackUsed = round.kanCount;

    let globalStackIdx = 0;
    for (let s = 0; s < 4; s++) {
      const cfg = wallSides[s]!;
      const count = stacksPerSide[s]!;
      const totalW = (count - 1) * step;

      for (let i = 0; i < count; i++) {
        const localX = -totalW / 2 + i * step;
        const localZ = cfg.dist;
        const [wx, wz] = rotatePointXZ(localX, localZ, cfg.ry);

        // 先頭から drawnFromWall 分の牌（上段・下段）が減り、末尾からカン嶺上牌が上段優先で減る
        const topTileGlobalIdx = globalStackIdx * 2;
        const botTileGlobalIdx = globalStackIdx * 2 + 1;
        const totalLiveLimit = rules.totalTiles - deadWallTiles;

        let hasTop: boolean;
        let hasBot: boolean;
        if (topTileGlobalIdx < totalLiveLimit) {
          hasTop = topTileGlobalIdx >= drawnFromWall;
          hasBot = botTileGlobalIdx >= drawnFromWall;
        } else {
          const deadPairFromEnd = totalStacks - 1 - globalStackIdx; // 0 = 末尾の幢
          const removedOrderTop = deadPairFromEnd * 2;
          const removedOrderBot = deadPairFromEnd * 2 + 1;
          hasTop = kanBackUsed <= removedOrderTop;
          hasBot = kanBackUsed <= removedOrderBot;
        }

        // 王牌のドラ表示判定（全体末尾から5..13番目の位置 ＝ 後ろから3,4,5,6,7幢目の上段）
        const deadFromTail = totalStacks - 1 - globalStackIdx;
        let doraIdx = -1;
        if (deadFromTail >= 2 && deadFromTail <= 6) {
          doraIdx = 6 - deadFromTail; // 最初のドラが 6(左寄り)、カンごとに 5, 4, 3, 2
        }

        if (hasBot) {
          const rotX = Math.PI;
          const yBot = hLayer;
          this.drawTileWithShadow(
            mat4Compose(wx, yBot, wz, rotX, cfg.ry, 0, ws, ws, ws),
            wx,
            wz,
            cfg.ry,
            ws,
            this.getTileUv('1z'),
            { backTone: 1, shadowAlpha: 0.34 },
          );
        }

        if (hasTop) {
          const revealedTile =
            doraIdx >= 0 && doraIdx < doraIndicators.length
              ? doraIndicators[doraIdx]
              : undefined;
          const baseSupportY = hasBot ? hLayer : 0;
          let flipAngle = revealedTile ? 0 : Math.PI;
          let liftY = 0;

          if (revealedTile && doraIdx >= 0) {
            const flipAnim = this.doraFlipAnims.find((a) => a.index === doraIdx);
            if (flipAnim) {
              const t = Math.min(1, (now - flipAnim.startTime) / flipAnim.duration);
              const e = 1 - Math.pow(1 - t, 3);
              liftY = Math.sin(t * Math.PI) * 0.42;
              flipAngle = Math.PI * (1 - e);
            }
          }

          // rotX 回転しても下段へめり込まないよう、下端基準の Y 補間を行う
          const ty = baseSupportY + hLayer * 0.5 * (1 - Math.cos(flipAngle)) + liftY;
          const m = mat4Compose(
            wx,
            ty,
            wz,
            flipAngle,
            cfg.ry,
            0,
            ws,
            ws,
            ws,
          );

          if (revealedTile) {
            this.drawTile(
              m,
              this.getTileUv(revealedTile.kind, revealedTile.isRed),
              { highlight: 0.45, doraGlow: this.isDoraTile(revealedTile) },
            );
          } else {
            this.drawTile(m, this.getTileUv('1z'), { backTone: 0 });
          }
        }

        globalStackIdx++;
      }
    }
  }

  private populateRiver(
    side: SeatSide3D,
    player: PublicPlayerView,
    now: number,
  ): void {
    const ry =
      side === 'self'
        ? 0
        : side === 'right'
          ? Math.PI / 2
          : side === 'top'
            ? Math.PI
            : -Math.PI / 2;
    const sc = RIVER_SCALE;
    const w = TILE_W * sc;
    const h = TILE_H * sc;
    const gapX = 0.02;
    const gapZ = 0.03;

    let rowX = 0;
    let currentRow = 0;
    let colInRow = 0;

    player.discards.forEach((entry, idx) => {
      if (colInRow >= 6 && currentRow < 2) {
        currentRow++;
        colInRow = 0;
        rowX = 0;
      }

      const isRiichi = entry.isRiichiDeclaration;
      const tileSpanX = isRiichi ? h : w;
      const startX = -((w + gapX) * 6 - gapX) / 2;
      const lx = startX + rowX + tileSpanX / 2;
      const lz = 2.02 + currentRow * (h + gapZ) + (isRiichi ? (h - w) * 0.25 : 0);
      rowX += tileSpanX + gapX;
      colInRow++;

      const [wx0, wz0] = rotatePointXZ(lx, lz, ry);
      let wx = wx0;
      let wy = 0;
      let wz = wz0;

      const anim = this.throwAnims.find(
        (a) => a.side === side && a.discardIndex === idx,
      );
      let throwArcRot = 0;
      if (anim) {
        const t = Math.min(1, (now - anim.startTime) / anim.duration);
        const e = 1 - Math.pow(1 - t, 3);
        wx = anim.from[0] + (wx0 - anim.from[0]) * e;
        wz = anim.from[2] + (wz0 - anim.from[2]) * e;
        wy = Math.sin(t * Math.PI) * 1.15;
        throwArcRot = (1 - e) * deg(30);
      }

      const isLatest =
        this.lastDiscardTarget !== null &&
        this.lastDiscardTarget.playerId === player.playerId &&
        this.lastDiscardTarget.tileId === entry.tile.id;

      const tileRy = ry + (isRiichi ? Math.PI / 2 : 0);
      const tint: [number, number, number, number] = entry.isTsumogiri
        ? [0.85, 0.87, 0.91, 1]
        : [1, 1, 1, 1];

      this.drawTileWithShadow(
        mat4Compose(wx, wy, wz, throwArcRot, tileRy, 0, sc, sc, sc),
        wx,
        wz,
        tileRy,
        sc,
        this.getTileUv(entry.tile.kind, entry.tile.isRed),
        {
          tint,
          highlight: isLatest ? 0.95 : 0,
          doraGlow: this.isDoraTile(entry.tile),
        },
      );

      if (isLatest && wy < 0.08) {
        const bob = Math.sin(this.elapsed * 4.2) * 0.07;
        this.animQueue.push({
          mesh: this.markerMesh,
          model: mat4Compose(wx, 0.72 + bob, wz, 0, this.elapsed * 2.4, 0, 0.56, 0.56, 0.56),
          color: [0.35, 0.76, 1.0, 0.96],
          uvRect: [0, 0, 1, 1],
          useAtlas: 0,
          useConsole: 0,
          backTone: 0,
          highlight: 0,
          emissive: 0.78,
          doraGlow: 0,
        });
      }
    });
  }

  private getCalledIndexForMeld(
    meld: Meld,
    seatIndex: number,
    playerCount: number,
  ): number {
    if (meld.fromSeatIndex === null) return -1;
    const rel = ((meld.fromSeatIndex - seatIndex) % playerCount + playerCount) % playerCount;
    if (rel === 1) return meld.tiles.length - 1; // 下家
    if (playerCount === 4 && rel === 2) return 1; // 対面
    return 0; // 上家
  }

  private populateMeldsAndKita(
    side: SeatSide3D,
    player: PublicPlayerView,
    playerCount: number,
  ): void {
    if (player.melds.length === 0 && player.kitaTiles.length === 0) return;
    const ry =
      side === 'self'
        ? 0
        : side === 'right'
          ? Math.PI / 2
          : side === 'top'
            ? Math.PI
            : -Math.PI / 2;

    const sc = MELD_SCALE;
    const w = TILE_W * sc;
    const h = TILE_H * sc;
    const gap = 0.016;
    const meldGap = 0.14;

    // 卓の右側手前に並べる（山 z <= 4.62 と立牌 z = 6.10 の間の安全帯 z = 5.24）
    let cursorX = side === 'self' ? 6.82 : 6.2;
    const baseZ = 5.24;

    // 自分の手前副露から順に右→左へ並べる
    for (const meld of player.melds) {
      const calledIdx =
        meld.type === 'ankan'
          ? -1
          : this.getCalledIndexForMeld(meld, player.seatIndex, playerCount);

      // まずこのブロックの幅を計算
      let blockW = 0;
      for (let i = 0; i < meld.tiles.length; i++) {
        blockW += (i === calledIdx ? h : w) + gap;
      }
      let localX = cursorX - blockW;

      for (let i = 0; i < meld.tiles.length; i++) {
        const tile = meld.tiles[i]!;
        const isSideways = i === calledIdx;
        const isFaceDown =
          meld.type === 'ankan' && (i === 0 || i === meld.tiles.length - 1);
        const span = isSideways ? h : w;
        const cx = localX + span / 2;
        const cz = isSideways ? baseZ + (h - w) * 0.45 : baseZ;
        const [wx, wz] = rotatePointXZ(cx, cz, ry);
        const rotX = isFaceDown ? Math.PI : 0;
        const tileRy = ry + (isSideways ? Math.PI / 2 : 0);

        this.drawTileWithShadow(
          mat4Compose(
            wx,
            isFaceDown ? TILE_D * sc : 0,
            wz,
            rotX,
            tileRy,
            0,
            sc,
            sc,
            sc,
          ),
          wx,
          wz,
          tileRy,
          sc,
          this.getTileUv(tile.kind, tile.isRed),
          {
            doraGlow: !isFaceDown && this.isDoraTile(tile),
          },
        );

        // 加槓のときは横向き牌の奥（上）に加槓牌を重ねる
        if (meld.type === 'kakan' && isSideways && meld.addedTile) {
          const [ax, az] = rotatePointXZ(cx, cz - w - 0.015, ry);
          this.drawTileWithShadow(
            mat4Compose(ax, 0, az, 0, tileRy, 0, sc, sc, sc),
            ax,
            az,
            tileRy,
            sc,
            this.getTileUv(meld.addedTile.kind, meld.addedTile.isRed),
            { doraGlow: this.isDoraTile(meld.addedTile) },
          );
        }

        localX += span + gap;
      }

      cursorX -= blockW + meldGap;
    }

    // 三麻の抜北（kitaTiles）: 卓右奥方向へ縦に並べても手牌と被らない
    if (player.kitaTiles.length > 0) {
      const kitaBaseX = side === 'self' ? 6.68 : Math.min(cursorX - w * 0.5, 5.9);
      let kitaZ = side === 'self' ? 4.35 : baseZ - h - 0.06;
      for (const kitaTile of player.kitaTiles) {
        const [wx, wz] = rotatePointXZ(kitaBaseX, kitaZ, ry);
        this.drawTileWithShadow(
          mat4Compose(wx, 0, wz, 0, ry, 0, sc, sc, sc),
          wx,
          wz,
          ry,
          sc,
          this.getTileUv(kitaTile.kind, kitaTile.isRed),
          { doraGlow: this.isDoraTile(kitaTile) },
        );
        kitaZ -= h + 0.03;
      }
    }
  }

  private populateHiddenOpponentHand(
    side: SeatSide3D,
    player: PublicPlayerView,
    now: number,
  ): void {
    const ry =
      side === 'right'
        ? Math.PI / 2
        : side === 'top'
          ? Math.PI
          : side === 'left'
            ? -Math.PI / 2
            : 0;
    const sc = OPP_SCALE;
    const step = TILE_W * sc + 0.018;
    const handCount = player.handCount;
    const totalW =
      (handCount + (player.hasDrawnTile ? 1.25 : 0) - 1) * step;
    const startX = -totalW / 2;
    const standDist = 6.08;

    const anim = this.drawAnims.find((a) => a.side === side);
    const drawYOffset = anim
      ? (1 - (1 - Math.pow(1 - Math.min(1, (now - anim.startTime) / anim.duration), 3))) * 0.45
      : 0;

    for (let i = 0; i < handCount; i++) {
      const lx = startX + i * step;
      const [wx, wz] = rotatePointXZ(lx, standDist, ry);
      const rotX = -deg(86);
      this.drawTile(
        mat4Compose(wx, (TILE_H * sc) / 2, wz, rotX, ry, 0, sc, sc, sc),
        this.getTileUv('1z'),
      );
    }
    if (player.hasDrawnTile) {
      const lx = startX + (handCount + 0.35) * step;
      const [wx, wz] = rotatePointXZ(lx, standDist, ry);
      this.drawTile(
        mat4Compose(
          wx,
          (TILE_H * sc) / 2 + drawYOffset,
          wz,
          -deg(86),
          ry,
          0,
          sc,
          sc,
          sc,
        ),
        this.getTileUv('1z'),
      );
    }
  }

  private populateHiddenSelfHand(player: PublicPlayerView, now: number): void {
    const sc = SELF_SCALE * 0.85;
    const step = TILE_W * sc + 0.02;
    const handCount = player.handCount;
    const totalW =
      (handCount + (player.hasDrawnTile ? 1.25 : 0) - 1) * step;
    const startX = -totalW / 2;

    const anim = this.drawAnims.find((a) => a.side === 'self');
    const drawYOffset = anim
      ? (1 - (1 - Math.pow(1 - Math.min(1, (now - anim.startTime) / anim.duration), 3))) * 0.45
      : 0;

    for (let i = 0; i < handCount; i++) {
      const lx = startX + i * step;
      this.drawTile(
        mat4Compose(lx, (TILE_H * sc) / 2, 5.5, -deg(72), 0, 0, sc, sc, sc),
        this.getTileUv('1z'),
      );
    }
    if (player.hasDrawnTile) {
      const lx = startX + (handCount + 0.35) * step;
      this.drawTile(
        mat4Compose(
          lx,
          (TILE_H * sc) / 2 + drawYOffset,
          5.5,
          -deg(72),
          0,
          0,
          sc,
          sc,
          sc,
        ),
        this.getTileUv('1z'),
      );
    }
  }

  private populateRevealedOpponentHand(
    side: SeatSide3D,
    tiles: readonly Tile[],
  ): void {
    const ry =
      side === 'right'
        ? Math.PI / 2
        : side === 'top'
          ? Math.PI
          : side === 'left'
            ? -Math.PI / 2
            : 0;
    const sc = side === 'self' ? SELF_SCALE * 0.92 : OPP_SCALE;
    const step = TILE_W * sc + 0.018;
    const totalW = (tiles.length - 1) * step;
    const startX = -totalW / 2;
    const dist = side === 'self' ? 5.35 : 5.75;

    tiles.forEach((tile, i) => {
      const lx = startX + i * step;
      const [wx, wz] = rotatePointXZ(lx, dist, ry);
      this.drawTileWithShadow(
        mat4Compose(wx, 0, wz, 0, ry, 0, sc, sc, sc),
        wx,
        wz,
        ry,
        sc,
        this.getTileUv(tile.kind, tile.isRed),
        { doraGlow: this.isDoraTile(tile) },
      );
    });
  }

  private populateInteractiveSelfHand(
    params: Table3DSyncParams,
    selfPlayer: PublicPlayerView,
    now: number,
    dt: number,
  ): void {
    const { view, canDiscardNow, riichiSelectingMode, canRiichiTileIds, kuikaeForbiddenKinds } =
      params;
    const sc = SELF_SCALE;
    const w = TILE_W * sc;
    const h = TILE_H * sc;
    const step = w + 0.018;
    const drawnGap = view.myDrawnTile ? w * 0.28 : 0;

    const baseTiles = view.myHand;
    const allCount = baseTiles.length + (view.myDrawnTile ? 1 : 0);
    if (allCount === 0) return;

    const totalWidth = (allCount - 1) * step + drawnGap;
    const meldShift = Math.min(2.2, selfPlayer.melds.length * 0.55);
    const startX = -totalWidth / 2 - meldShift;

    const pitch = deg(48);
    const baseY = 0.65;
    const baseZ = 5.45;
    const cosP = Math.cos(pitch);
    const sinP = Math.sin(pitch);

    const inRiichiMode =
      canDiscardNow && riichiSelectingMode && canRiichiTileIds.length > 0;
    const riichiSet = new Set(canRiichiTileIds);
    const forbiddenSet = new Set(canDiscardNow ? kuikaeForbiddenKinds : []);

    const anim = this.drawAnims.find((a) => a.side === 'self');
    const drawYOffset = anim
      ? (1 - (1 - Math.pow(1 - Math.min(1, (now - anim.startTime) / anim.duration), 3))) * 0.42
      : 0;

    const entries: Array<{ tile: Tile; x: number; isDrawn: boolean }> = [];
    baseTiles.forEach((tile, idx) => {
      entries.push({
        tile,
        x: startX + idx * step,
        isDrawn: false,
      });
    });
    if (view.myDrawnTile) {
      entries.push({
        tile: view.myDrawnTile,
        x: startX + baseTiles.length * step + drawnGap,
        isDrawn: true,
      });
    }

    const lerpRate = Math.min(1, dt * 16);

    for (const entry of entries) {
      const { tile, x, isDrawn } = entry;
      let clickable = false;
      let blocked = false;
      let isRiichiCandidate = false;

      if (canDiscardNow) {
        if (inRiichiMode) {
          clickable = riichiSet.has(tile.id);
          blocked = !clickable;
          isRiichiCandidate = clickable;
        } else {
          const lockedByRiichi = selfPlayer.isRiichi && !isDrawn;
          const blockedByKuikae = forbiddenSet.has(tile.kind);
          blocked = lockedByRiichi || blockedByKuikae;
          clickable = !blocked;
        }
      }

      const isSelected = clickable && this.selectedTileId === tile.id;
      const isHovered = clickable && this.hoveredTileId === tile.id;

      const prevSel = this.selectProgress.get(tile.id) ?? 0;
      const nextSel = prevSel + ((isSelected ? 1 : 0) - prevSel) * lerpRate;
      this.selectProgress.set(tile.id, nextSel);

      const prevHov = this.hoverProgress.get(tile.id) ?? 0;
      const nextHov = prevHov + ((isHovered ? 1 : 0) - prevHov) * lerpRate;
      this.hoverProgress.set(tile.id, nextHov);

      const lift =
        nextSel * 0.24 +
        nextHov * 0.08 +
        (isRiichiCandidate ? 0.07 : 0) +
        (isDrawn ? drawYOffset : 0);

      // 牌の立ち面方向（Y軸に傾いた牌を自分の目線へ向けて浮き上がらせる）
      const ty = baseY + lift * sinP;
      const tz = baseZ - lift * cosP;

      const tint: [number, number, number, number] = blocked
        ? [0.58, 0.6, 0.66, 1]
        : [1, 1, 1, 1];
      const highlight = isSelected
        ? 1.0
        : isRiichiCandidate
          ? 2.0
          : isHovered
            ? 0.45
            : 0;

      this.drawTile(
        mat4Compose(x, ty, tz, pitch, 0, 0, sc, sc, sc),
        this.getTileUv(tile.kind, tile.isRed),
        {
          tint,
          highlight,
          doraGlow: this.isDoraTile(tile),
        },
      );

      // 正確な Ray-OBB ヒットボックスを登録（ローカル牌の中心＝y = TILE_D*sc/2）
      const halfD = (TILE_D * sc) / 2;
      const cx = x;
      const cy = ty + halfD * cosP;
      const cz = tz + halfD * sinP;
      this.handHitBoxes.push({
        tileId: tile.id,
        clickable,
        center: [cx, cy, cz],
        axisX: [1, 0, 0],
        axisY: [0, cosP, -sinP],
        axisZ: [0, sinP, cosP],
        halfX: w * 0.5,
        halfY: halfD,
        halfZ: h * 0.5,
      });
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.pause();

    this.canvas.removeEventListener('pointerdown', this.onPointerDownBound);
    this.canvas.removeEventListener('pointermove', this.onPointerMoveBound);
    this.canvas.removeEventListener('pointerup', this.onPointerUpBound);
    this.canvas.removeEventListener('pointercancel', this.onPointerCancelBound);
    this.canvas.removeEventListener('pointerleave', this.onPointerLeaveBound);
    this.canvas.removeEventListener('dblclick', this.onDoubleClickBound);
    this.canvas.removeEventListener('webglcontextlost', this.onContextLostBound);
    this.canvas.removeEventListener('webglcontextrestored', this.onContextRestoredBound);

    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }

    this.atlas.dispose();
    const gl = this.gl;
    const disposeMesh = (m: MeshBuffers) => {
      gl.deleteVertexArray(m.vao);
      gl.deleteBuffer(m.vbo);
      gl.deleteBuffer(m.ibo);
    };
    disposeMesh(this.tileMesh);
    disposeMesh(this.boxMesh);
    disposeMesh(this.consoleDeckMesh);
    disposeMesh(this.feltMesh);
    disposeMesh(this.shadowMesh);
    disposeMesh(this.markerMesh);
    gl.deleteTexture(this.atlasTex);
    gl.deleteTexture(this.consoleTex);
    gl.deleteProgram(this.prog);
  }
}
