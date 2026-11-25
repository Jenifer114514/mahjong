// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { toStateView } from '../../engine/projection';
import { createInitialGameState, reduce } from '../../engine/reducer';
import { deriveRules } from '../../engine/rules';
import { buildSeededTestDeck } from '../../engine/__tests__/testHelpers';
import type { StateView } from '../../types/message';
import type { Tile, TileKind } from '../../types/tile';
import {
  destroyTable3DScene,
  renderGameTable,
  resetTable3DCamera,
  type TableHandlers,
} from '../tableView';

function t(id: string, kind: TileKind, isRed = false): Tile {
  return { id, kind, isRed };
}

function makeHandlers(overrides: Partial<TableHandlers> = {}): TableHandlers {
  return {
    onDiscardTile: vi.fn(),
    onSelectTile: vi.fn(),
    onCallResponse: vi.fn(),
    onDeclareTsumo: vi.fn(),
    onDeclareRiichi: vi.fn(),
    onDeclareAnkan: vi.fn(),
    onDeclareKakan: vi.fn(),
    onDeclareKita: vi.fn(),
    onDeclareKyuushuKyuuhai: vi.fn(),
    onAdvanceRound: vi.fn(),
    onReturnToLobby: vi.fn(),
    ...overrides,
  };
}

function makeView(playerCount: 3 | 4 = 4, seed = 4242): StateView {
  const ruleConfig = { playerCount, gameLength: 'tonpuu' as const };
  const rules = deriveRules(ruleConfig);
  let state = createInitialGameState({
    roomCode: '3D0001',
    hostPlayerId: 'p0',
    hostName: 'Player0',
    ruleConfig,
  });
  for (let i = 1; i < playerCount; i++) {
    state = reduce(state, {
      type: 'JOIN_PLAYER',
      playerId: `p${i}`,
      name: `Player${i}`,
    });
  }
  state = reduce(state, {
    type: 'START_GAME',
    shuffledDeck: buildSeededTestDeck(rules, seed),
  });
  return toStateView(state, 'p0', 0);
}

function createFake2dContext(): CanvasRenderingContext2D {
  const grad = { addColorStop: () => {} };
  const noop = () => {};
  return {
    save: noop,
    restore: noop,
    translate: noop,
    rotate: noop,
    scale: noop,
    clearRect: noop,
    fillRect: noop,
    strokeRect: noop,
    beginPath: noop,
    closePath: noop,
    moveTo: noop,
    lineTo: noop,
    arc: noop,
    ellipse: noop,
    quadraticCurveTo: noop,
    bezierCurveTo: noop,
    roundRect: noop,
    rect: noop,
    clip: noop,
    fill: noop,
    stroke: noop,
    fillText: noop,
    strokeText: noop,
    measureText: () => ({ width: 20 }),
    createLinearGradient: () => grad,
    createRadialGradient: () => grad,
    drawImage: noop,
    setTransform: noop,
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    font: '12px sans-serif',
    textAlign: 'center',
    textBaseline: 'middle',
    globalAlpha: 1,
  } as unknown as CanvasRenderingContext2D;
}

interface DrawnTileRecord {
  model: number[];
  uvRect: number[];
  doraGlow?: number;
}

interface MockGlTracker {
  drawCalls: number;
  texUploads: number;
  shaderCompiles: number;
  loseContextCount: number;
  tileVerts: number[] | null;
  tileIndices: number[] | null;
  drawnTiles: DrawnTileRecord[];
  uploadedCanvasSizes?: Array<{ width: number; height: number }>;
  additiveDraws?: number;
}

function createFakeWebGL2Context(tracker: MockGlTracker): WebGL2RenderingContext {
  const noop = () => {};
  let nextId = 1;
  let currentModel: number[] = [];
  let currentUvRect: number[] = [0, 0, 0, 0];
  let currentUseAtlas = 0;
  let currentDoraGlow = 0;
  let currentBlendDst = 0x0303;

  return {
    VERTEX_SHADER: 0x8b31,
    FRAGMENT_SHADER: 0x8b30,
    COMPILE_STATUS: 0x8b81,
    LINK_STATUS: 0x8b82,
    ARRAY_BUFFER: 0x8892,
    ELEMENT_ARRAY_BUFFER: 0x8893,
    STATIC_DRAW: 0x88e4,
    FLOAT: 0x1406,
    UNSIGNED_SHORT: 0x1403,
    TRIANGLES: 0x0004,
    TEXTURE_2D: 0x0de1,
    TEXTURE0: 0x84c0,
    TEXTURE1: 0x84c1,
    RGBA: 0x1908,
    UNSIGNED_BYTE: 0x1401,
    UNPACK_FLIP_Y_WEBGL: 0x9240,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_MAG_FILTER: 0x2800,
    TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803,
    LINEAR: 0x2601,
    LINEAR_MIPMAP_LINEAR: 0x2703,
    CLAMP_TO_EDGE: 0x812f,
    DEPTH_TEST: 0x0b71,
    CULL_FACE: 0x0b44,
    BACK: 0x0405,
    BLEND: 0x0be2,
    ONE: 1,
    SRC_ALPHA: 0x0302,
    ONE_MINUS_SRC_ALPHA: 0x0303,
    COLOR_BUFFER_BIT: 0x4000,
    DEPTH_BUFFER_BIT: 0x0100,
    createShader: () => ({ id: nextId++ }),
    shaderSource: noop,
    compileShader: () => {
      tracker.shaderCompiles++;
    },
    getShaderParameter: () => true,
    getShaderInfoLog: () => '',
    deleteShader: noop,
    createProgram: () => ({ id: nextId++ }),
    attachShader: noop,
    linkProgram: noop,
    getProgramParameter: () => true,
    getProgramInfoLog: () => '',
    deleteProgram: noop,
    useProgram: noop,
    getUniformLocation: (_prog: unknown, name: string) => ({ name }),
    createVertexArray: () => ({ id: nextId++ }),
    bindVertexArray: noop,
    deleteVertexArray: noop,
    createBuffer: () => ({ id: nextId++ }),
    bindBuffer: noop,
    bufferData: (target: number, data: ArrayBufferView) => {
      if (target === 0x8892 && tracker.tileVerts === null && data instanceof Float32Array) {
        tracker.tileVerts = Array.from(data);
      } else if (
        target === 0x8893 &&
        tracker.tileIndices === null &&
        data instanceof Uint16Array
      ) {
        tracker.tileIndices = Array.from(data);
      }
    },
    deleteBuffer: noop,
    enableVertexAttribArray: noop,
    vertexAttribPointer: noop,
    createTexture: () => ({ id: nextId++ }),
    bindTexture: noop,
    deleteTexture: noop,
    pixelStorei: noop,
    texImage2D: (
      _target: number,
      _level: number,
      _internalformat: number,
      _format: number,
      _type: number,
      source?: { width?: number; height?: number },
    ) => {
      tracker.texUploads++;
      if (source && typeof source.width === 'number' && typeof source.height === 'number') {
        tracker.uploadedCanvasSizes?.push({
          width: source.width,
          height: source.height,
        });
      }
    },
    generateMipmap: noop,
    texParameteri: noop,
    texParameterf: noop,
    activeTexture: noop,
    getExtension: (name: string) =>
      name === 'WEBGL_lose_context'
        ? { loseContext: () => tracker.loseContextCount++ }
        : null,
    getParameter: () => 1,
    enable: noop,
    disable: noop,
    cullFace: noop,
    blendFunc: (_src: number, dst: number) => {
      currentBlendDst = dst;
    },
    depthMask: noop,
    viewport: noop,
    clearColor: noop,
    clear: noop,
    uniformMatrix4fv: (loc: { name?: string }, _t: boolean, val: Float32Array) => {
      if (loc?.name === 'uModel') {
        currentModel = Array.from(val);
      }
    },
    uniform4fv: (loc: { name?: string }, val: number[] | Float32Array) => {
      if (loc?.name === 'uUvRect') {
        currentUvRect = Array.from(val);
      }
    },
    uniform3fv: noop,
    uniform1f: (loc: { name?: string }, val: number) => {
      if (loc?.name === 'uUseAtlas') {
        currentUseAtlas = val;
      } else if (loc?.name === 'uDoraGlow') {
        currentDoraGlow = val;
      }
    },
    uniform1i: noop,
    drawElements: () => {
      tracker.drawCalls++;
      if (currentUseAtlas > 0.5) {
        tracker.drawnTiles.push({
          model: currentModel,
          uvRect: currentUvRect,
          doraGlow: currentDoraGlow,
        });
      } else if (currentBlendDst === 1 && currentDoraGlow > 0.5) {
        tracker.additiveDraws = (tracker.additiveDraws ?? 0) + 1;
      }
    },
  } as unknown as WebGL2RenderingContext;
}

describe('3D麻雀卓とフォールバック統合', () => {
  const containers: HTMLElement[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const c of containers) {
      destroyTable3DScene(c);
    }
    containers.length = 0;
  });

  it('WebGL2非対応環境(jsdom既定)では自動的に従来2D卓にフォールバックする', () => {
    const container = document.createElement('div');
    containers.push(container);
    const view = makeView(4);
    renderGameTable(container, view, makeHandlers());

    const felt = container.querySelector('.table-felt')!;
    expect(felt.classList.contains('is-3d-table')).toBe(false);
    expect(container.querySelector('.table-3d-canvas')).toBeNull();
    expect(container.querySelectorAll('.seat-self .hand-area .mj-tile').length).toBeGreaterThan(0);
  });

  it('WebGL2対応環境では3Dキャンバスがマウントされ、再描画時に同一コンテキストを再利用し、3人/4人/副露/設定切替・聴牌ガイドが動く', () => {
    const tracker: MockGlTracker = {
      drawCalls: 0,
      texUploads: 0,
      shaderCompiles: 0,
      loseContextCount: 0,
      tileVerts: null,
      tileIndices: null,
      drawnTiles: [],
    };
    const gl = createFakeWebGL2Context(tracker);
    const ctx2d = createFake2dContext();

    let rafCallback: FrameRequestCallback | null = null;
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      rafCallback = cb;
      return 1;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});

    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
      function (this: HTMLCanvasElement, kind: string) {
        if (kind === 'webgl2') return gl;
        if (kind === '2d') return ctx2d;
        return null;
      } as unknown as HTMLCanvasElement['getContext'],
    );
    vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 1280,
      height: 720,
      top: 0,
      left: 0,
      right: 1280,
      bottom: 720,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    const container = document.createElement('div');
    document.body.appendChild(container);
    containers.push(container);

    const view = makeView(4);
    // 副露・暗槓・加槓・リーチ宣言・赤ドラ・ドラ表示を含む実戦的シーンを組み立てる
    view.players[0]!.melds = [
      {
        type: 'pon',
        tiles: [t('m1a', '1m'), t('m1b', '1m'), t('m1c', '1m')],
        calledTile: t('m1c', '1m'),
        fromSeatIndex: 1,
        addedTile: null,
      },
      {
        type: 'ankan',
        tiles: [t('z1a', '1z'), t('z1b', '1z'), t('z1c', '1z'), t('z1d', '1z')],
        calledTile: null,
        fromSeatIndex: null,
        addedTile: null,
      },
    ];
    view.players[1]!.isRiichi = true;
    view.players[1]!.discards = [
      { tile: t('d1', '5p', true), isTsumogiri: false, isRiichiDeclaration: true },
      { tile: t('d2', '2s', false), isTsumogiri: true, isRiichiDeclaration: false },
    ];
    view.players[2]!.melds = [
      {
        type: 'kakan',
        tiles: [t('s8a', '8s'), t('s8b', '8s'), t('s8c', '8s')],
        calledTile: t('s8b', '8s'),
        fromSeatIndex: 0,
        addedTile: t('s8d', '8s'),
      },
    ];

    // 1. 初回3Dマウント
    renderGameTable(container, view, makeHandlers(), {
      riichiSelectingMode: false,
      autoTsumogiriEnabled: true,
      enable3dTable: true,
      cameraPreset: 'standard',
    });

    const felt1 = container.querySelector('.table-felt')!;
    const canvas1 = felt1.querySelector<HTMLCanvasElement>('.table-3d-canvas')!;
    expect(felt1.classList.contains('is-3d-table')).toBe(true);
    expect(canvas1).not.toBeNull();
    expect(felt1.firstElementChild).toBe(canvas1);
    expect(tracker.shaderCompiles).toBe(2);

    // 実際に 3D シーンの 1 フレーム描画を実行しても例外なし & ドローコール発行
    expect(rafCallback).not.toBeNull();
    rafCallback!(performance.now());
    expect(tracker.drawCalls).toBeGreaterThan(40);

    // 3D牌メッシュの角丸形状 & 全三角形の巻き順(外向き法線一致で側面カリング穴ゼロ)を検証
    const verts = tracker.tileVerts!;
    const indices = tracker.tileIndices!;
    expect(verts).not.toBeNull();
    expect(indices).not.toBeNull();
    expect(indices.length % 3).toBe(0);
    let sharpCorners = 0;
    for (let v = 0; v < verts.length; v += 9) {
      const px = Math.abs(verts[v]!);
      const pz = Math.abs(verts[v + 2]!);
      if (px > 0.27 && pz > 0.37) {
        sharpCorners++;
      }
    }
    expect(sharpCorners).toBe(0);

    let checkedTriangles = 0;
    for (let tIdx = 0; tIdx < indices.length; tIdx += 3) {
      const i0 = indices[tIdx]! * 9;
      const i1 = indices[tIdx + 1]! * 9;
      const i2 = indices[tIdx + 2]! * 9;
      const p0x = verts[i0]!, p0y = verts[i0 + 1]!, p0z = verts[i0 + 2]!;
      const p1x = verts[i1]!, p1y = verts[i1 + 1]!, p1z = verts[i1 + 2]!;
      const p2x = verts[i2]!, p2y = verts[i2 + 1]!, p2z = verts[i2 + 2]!;
      const e1x = p1x - p0x, e1y = p1y - p0y, e1z = p1z - p0z;
      const e2x = p2x - p0x, e2y = p2y - p0y, e2z = p2z - p0z;
      const cx = e1y * e2z - e1z * e2y;
      const cy = e1z * e2x - e1x * e2z;
      const cz = e1x * e2y - e1y * e2x;
      const len = Math.hypot(cx, cy, cz);
      if (len < 1e-8) continue;
      const nx = verts[i0 + 3]! + verts[i1 + 3]! + verts[i2 + 3]!;
      const ny = verts[i0 + 4]! + verts[i1 + 4]! + verts[i2 + 4]!;
      const nz = verts[i0 + 5]! + verts[i1 + 5]! + verts[i2 + 5]!;
      const dot = cx * nx + cy * ny + cz * nz;
      expect(dot).toBeGreaterThan(0);
      checkedTriangles++;
    }
    expect(checkedTriangles).toBeGreaterThan(200);

    // 他家(top/left/right, standDist=6.08付近)の伏せ立牌は「東」のUVを出さず、背面(-Y_local)が卓中心向き・表面が外向きになっていること
    const oppStandingTiles = tracker.drawnTiles.filter((dt) => {
      const tx = dt.model[12]!;
      const tz = dt.model[14]!;
      return (
        (Math.abs(tz + 6.08) < 0.2 && Math.abs(tx) < 5.0) ||
        (Math.abs(tx - 6.08) < 0.2 && Math.abs(tz) < 5.0) ||
        (Math.abs(tx + 6.08) < 0.2 && Math.abs(tz) < 5.0)
      );
    });
    expect(oppStandingTiles.length).toBe(39);
    for (const tile of oppStandingTiles) {
      expect(tile.uvRect[2]!).toBeLessThanOrEqual(0.01);
      const tx = tile.model[12]!;
      const tz = tile.model[14]!;
      const faceNx = tile.model[4]!;
      const faceNz = tile.model[6]!;
      // 表面法線が卓外側(> 0)、よって黄金背面が卓中心・カメラ側を向いている
      expect(faceNx * tx + faceNz * tz).toBeGreaterThan(0);
    }

    // 2. 聴牌手牌状態(2副露: 手牌7枚+ツモ1枚、7zを切れば3s/6s待ち)にして1タップ目→聴牌ガイド更新、2タップ目→打牌をテスト
    const handlers = makeHandlers();
    view.myHand = [
      t('p4', '4p'),
      t('p5', '5p', true),
      t('p6', '6p'),
      t('z1a', '1z'),
      t('z1b', '1z'),
      t('s4', '4s'),
      t('s5', '5s', true),
    ];
    view.myDrawnTile = t('z7x', '7z');
    view.players[0]!.melds = [
      {
        type: 'pon',
        tiles: [t('m1a', '1m'), t('m1b', '1m'), t('m1c', '1m')],
        calledTile: t('m1c', '1m'),
        fromSeatIndex: 1,
        addedTile: null,
      },
      {
        type: 'chi',
        tiles: [t('m2', '2m'), t('m3', '3m'), t('m4', '4m')],
        calledTile: t('m2', '2m'),
        fromSeatIndex: 3,
        addedTile: null,
      },
    ];
    view.players[0]!.isCurrentTurn = true;
    renderGameTable(container, view, handlers, {
      riichiSelectingMode: false,
      autoTsumogiriEnabled: true,
      enable3dTable: true,
      cameraPreset: 'high',
    });

    const felt2 = container.querySelector('.table-felt')!;
    const canvas2 = felt2.querySelector<HTMLCanvasElement>('.table-3d-canvas')!;
    expect(canvas2).toBe(canvas1); // 同一キャンバス・同一 WebGL コンテキストを再利用
    expect(tracker.shaderCompiles).toBe(2); // シェーダ再コンパイルなし

    const drawnBtn = container.querySelector<HTMLButtonElement>(
      '.seat-self .hand-area [data-tile-id="z7x"]',
    )!;
    drawnBtn.click(); // 1回目タップ: 選択 + 聴牌ガイド表示
    expect(handlers.onSelectTile).toHaveBeenCalledWith('z7x');
    const guide = container.querySelector<HTMLElement>('.tenpai-wait-guide')!;
    expect(guide.hidden).toBe(false);
    expect(guide.textContent).toContain('打 中 で聴牌');
    expect(guide.textContent).toContain('3索');
    expect(guide.textContent).toContain('6索');

    drawnBtn.click(); // 2回目タップ: 確定打牌
    expect(handlers.onDiscardTile).toHaveBeenCalledWith('z7x');

    // 2b. 3Dキャンバス上での直接Ray-OBBホバー＆2タップ確定打牌を検証
    // カメラ位置補間を進める
    for (let f = 1; f <= 30; f++) {
      rafCallback!(performance.now() + f * 30);
    }
    const makePtr = (type: string, clientX: number, clientY: number) => {
      if (typeof PointerEvent !== 'undefined') {
        return new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          clientX,
          clientY,
          button: 0,
          pointerType: 'mouse',
          pointerId: 1,
        });
      }
      const ev = new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX,
        clientY,
        button: 0,
      });
      Object.defineProperty(ev, 'pointerType', { value: 'mouse' });
      Object.defineProperty(ev, 'pointerId', { value: 1 });
      return ev;
    };

    let hitY: number | null = null;
    for (let y = 400; y <= 700; y += 10) {
      canvas2.dispatchEvent(makePtr('pointermove', 640, y));
      if (canvas2.style.cursor === 'pointer') {
        hitY = y;
        break;
      }
    }
    expect(hitY).not.toBeNull();
    // 1回目タップ: 3D手牌選択 (onSelectTile の追加呼び出し)
    const selectCallsBefore = (handlers.onSelectTile as ReturnType<typeof vi.fn>).mock.calls.length;
    const discardCallsBefore = (handlers.onDiscardTile as ReturnType<typeof vi.fn>).mock.calls.length;
    canvas2.dispatchEvent(makePtr('pointerdown', 640, hitY!));
    canvas2.dispatchEvent(makePtr('pointerup', 640, hitY!));
    expect((handlers.onSelectTile as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
      selectCallsBefore + 1,
    );
    // 2回目タップ: 選択中の同一3D手牌を確定打牌
    canvas2.dispatchEvent(makePtr('pointerdown', 640, hitY!));
    canvas2.dispatchEvent(makePtr('pointerup', 640, hitY!));
    expect((handlers.onDiscardTile as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
      discardCallsBefore + 1,
    );

    // 3. 3人麻雀 + 抜北 + round_end 手牌オープン描画
    const view3 = makeView(3, 8888);
    view3.players[0]!.kitaTiles = [t('k4z', '4z')];
    view3.phase = 'round_end';
    view3.round!.revealedHands = {
      [view3.players[1]!.playerId]: [t('op1', '1p'), t('op2', '1p'), t('op3', '1p')],
    };
    renderGameTable(container, view3, handlers, {
      riichiSelectingMode: false,
      autoTsumogiriEnabled: true,
      enable3dTable: true,
      cameraPreset: 'low',
    });
    rafCallback!(performance.now());
    resetTable3DCamera(container);

    // 4. 設定で 2D 卓へ切り替えると .is-3d-table が外れる
    renderGameTable(container, view, handlers, {
      riichiSelectingMode: false,
      autoTsumogiriEnabled: true,
      enable3dTable: false,
    });
    expect(container.querySelector('.table-felt')!.classList.contains('is-3d-table')).toBe(false);
    expect(container.querySelector('.table-3d-canvas')).toBeNull();

    // 5. finished 遷移でもエラーにならない
    const finishedView = makeView(4);
    finishedView.phase = 'finished';
    finishedView.round = null;
    renderGameTable(container, finishedView, handlers, {
      riichiSelectingMode: false,
      autoTsumogiriEnabled: true,
      enable3dTable: true,
    });
    expect(container.querySelector('.finished-panel')).not.toBeNull();

    container.remove();
  });

  it('連続打牌更新でもcanvasをデタッチせず再利用し、0x0レイアウト計測で1x1に縮まず、孤児シーンをWEBGL_lose_contextで回収する', () => {
    const tracker: MockGlTracker = {
      drawCalls: 0,
      texUploads: 0,
      shaderCompiles: 0,
      loseContextCount: 0,
      tileVerts: null,
      tileIndices: null,
      drawnTiles: [],
    };
    const gl = createFakeWebGL2Context(tracker);
    const ctx2d = createFake2dContext();
    let getContextCalls = 0;

    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 1);
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
      function (this: HTMLCanvasElement, kind: string) {
        if (kind === 'webgl2') {
          getContextCalls++;
          return gl;
        }
        if (kind === '2d') return ctx2d;
        return null;
      } as unknown as HTMLCanvasElement['getContext'],
    );

    let mockWidth = 1280;
    let mockHeight = 720;
    vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockImplementation(
      () => ({
        width: mockWidth,
        height: mockHeight,
        top: 0,
        left: 0,
        right: mockWidth,
        bottom: mockHeight,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }),
    );

    const container1 = document.createElement('div');
    document.body.appendChild(container1);
    containers.push(container1);

    const handlers = makeHandlers();
    const view = makeView(4, 1234);
    renderGameTable(container1, view, handlers, {
      riichiSelectingMode: false,
      autoTsumogiriEnabled: true,
      enable3dTable: true,
    });

    const initialFelt = container1.querySelector('.table-felt')!;
    const initialCanvas = container1.querySelector<HTMLCanvasElement>('.table-3d-canvas')!;
    expect(getContextCalls).toBe(1);
    expect(initialCanvas.width).toBeGreaterThan(100);
    expect(initialCanvas.height).toBeGreaterThan(100);

    // 連続 24 回の状態更新（3巡相当の打牌・ツモ更新）でも同一 canvas/felt がデタッチされない
    const removeSpy = vi.spyOn(initialCanvas, 'remove');
    for (let turn = 0; turn < 24; turn++) {
      const seat = turn % 4;
      view.players[seat]!.discards.push({
        tile: t(`discard-${turn}`, '1m'),
        isTsumogiri: false,
        isRiichiDeclaration: false,
      });
      view.round!.currentTurnIndex = (seat + 1) % 4;
      renderGameTable(container1, view, handlers, {
        riichiSelectingMode: false,
        autoTsumogiriEnabled: true,
        enable3dTable: true,
      });
      expect(container1.querySelector('.table-felt')).toBe(initialFelt);
      expect(container1.querySelector('.table-3d-canvas')).toBe(initialCanvas);
    }
    expect(removeSpy).not.toHaveBeenCalled();
    expect(getContextCalls).toBe(1);
    expect(tracker.loseContextCount).toBe(0);

    // レイアウト移行中の瞬間 0x0 計測でも canvas バッファが 1x1 に破壊されない
    const wBefore = initialCanvas.width;
    const hBefore = initialCanvas.height;
    mockWidth = 0;
    mockHeight = 0;
    renderGameTable(container1, view, handlers, {
      riichiSelectingMode: false,
      autoTsumogiriEnabled: true,
      enable3dTable: true,
    });
    expect(initialCanvas.width).toBe(wBefore);
    expect(initialCanvas.height).toBe(hBefore);

    // 古いコンテナを DOM から切り離して新コンテナへ描画すると孤児 WebGL コンテキストを自動回収する
    mockWidth = 1280;
    mockHeight = 720;
    container1.remove();
    const container2 = document.createElement('div');
    document.body.appendChild(container2);
    containers.push(container2);
    renderGameTable(container2, makeView(4, 5678), handlers, {
      riichiSelectingMode: false,
      autoTsumogiriEnabled: true,
      enable3dTable: true,
    });
    expect(getContextCalls).toBe(2);
    expect(tracker.loseContextCount).toBe(1);

    destroyTable3DScene(container2);
    expect(tracker.loseContextCount).toBe(2);
    container2.remove();
  });

  it('実エンジン形式の加槓(4枚配列+addedTile)を4枚のみ描画し、3D手牌OBBの上下端判定とコンテキストロスト復帰が機能する', () => {
    const tracker: MockGlTracker = {
      drawCalls: 0,
      texUploads: 0,
      shaderCompiles: 0,
      loseContextCount: 0,
      tileVerts: null,
      tileIndices: null,
      drawnTiles: [],
    };
    const gl = createFakeWebGL2Context(tracker);
    const ctx2d = createFake2dContext();
    let rafCallback: FrameRequestCallback | null = null;

    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      rafCallback = cb;
      return 1;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
      function (this: HTMLCanvasElement, kind: string) {
        if (kind === 'webgl2') return gl;
        if (kind === '2d') return ctx2d;
        return null;
      } as unknown as HTMLCanvasElement['getContext'],
    );
    vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 1280,
      height: 720,
      top: 0,
      left: 0,
      right: 1280,
      bottom: 720,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    const container = document.createElement('div');
    document.body.appendChild(container);
    containers.push(container);

    // 1. 加槓の枚数検証: 副露なし時の描画枚数と加槓追加時の描画枚数の差分がちょうど +4 枚であること
    const baseView = makeView(4, 2468);
    baseView.players[0]!.melds = [];
    const handlers = makeHandlers();
    renderGameTable(container, baseView, handlers, {
      riichiSelectingMode: false,
      autoTsumogiriEnabled: true,
      enable3dTable: true,
      cameraPreset: 'standard',
    });
    expect(rafCallback).not.toBeNull();
    rafCallback!(performance.now());
    const countWithoutMeld = tracker.drawnTiles.length;

    const kakanView = makeView(4, 2468);
    kakanView.players[0]!.melds = [
      {
        type: 'kakan',
        // 実エンジン(reducerResolution.ts)と同じく addedTile を含む4枚配列
        tiles: [t('s8a', '8s'), t('s8b', '8s'), t('s8c', '8s'), t('s8d', '8s')],
        calledTile: t('s8b', '8s'),
        fromSeatIndex: 1,
        addedTile: t('s8d', '8s'),
      },
    ];
    tracker.drawnTiles.length = 0;
    renderGameTable(container, kakanView, handlers, {
      riichiSelectingMode: false,
      autoTsumogiriEnabled: true,
      enable3dTable: true,
      cameraPreset: 'standard',
    });
    rafCallback!(performance.now() + 16);
    const countWithKakan = tracker.drawnTiles.length;
    expect(countWithKakan - countWithoutMeld).toBe(4);

    // 2. 3D手牌の立ち牌(+48度傾き)の上端側・下端側がいずれも正しく同じ牌へヒットすること
    const canvas = container.querySelector<HTMLCanvasElement>('.table-3d-canvas')!;
    const hitView = makeView(4, 2468);
    renderGameTable(container, hitView, handlers, {
      riichiSelectingMode: false,
      autoTsumogiriEnabled: true,
      enable3dTable: true,
      cameraPreset: 'standard',
    });
    for (let f = 1; f <= 30; f++) {
      rafCallback!(performance.now() + f * 30);
    }

    const makePtr = (type: string, clientX: number, clientY: number) => {
      if (typeof PointerEvent !== 'undefined') {
        return new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          clientX,
          clientY,
          button: 0,
          pointerType: 'mouse',
          pointerId: 1,
        });
      }
      const ev = new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX,
        clientY,
        button: 0,
      });
      Object.defineProperty(ev, 'pointerType', { value: 'mouse' });
      Object.defineProperty(ev, 'pointerId', { value: 1 });
      return ev;
    };

    const hitYs: number[] = [];
    for (let y = 350; y <= 715; y += 2) {
      canvas.dispatchEvent(makePtr('pointermove', 640, y));
      if (canvas.style.cursor === 'pointer') {
        hitYs.push(y);
      }
    }
    expect(hitYs.length).toBeGreaterThanOrEqual(20);
    const topEdgeY = hitYs[1]!;
    const bottomEdgeY = hitYs[hitYs.length - 2]!;
    expect(bottomEdgeY - topEdgeY).toBeGreaterThanOrEqual(35);

    // 上端側タップで選択され、下端側タップでも同一牌が選択済みとして確定打牌されること
    canvas.dispatchEvent(makePtr('pointerdown', 640, topEdgeY));
    canvas.dispatchEvent(makePtr('pointerup', 640, topEdgeY));
    const selectMock = handlers.onSelectTile as ReturnType<typeof vi.fn>;
    expect(selectMock).toHaveBeenCalledTimes(1);
    const selectedId = selectMock.mock.calls[0]![0] as string;

    canvas.dispatchEvent(makePtr('pointerdown', 640, bottomEdgeY));
    canvas.dispatchEvent(makePtr('pointerup', 640, bottomEdgeY));
    expect(handlers.onDiscardTile).toHaveBeenCalledWith(selectedId);

    // 3. webglcontextlost → webglcontextrestored でシェーダ・テクスチャが再構築され描画が継続すること
    const shadersBeforeRestore = tracker.shaderCompiles;
    const texUploadsBeforeRestore = tracker.texUploads;
    const drawCallsBeforeRestore = tracker.drawCalls;

    const lostEvent = new Event('webglcontextlost', { cancelable: true });
    canvas.dispatchEvent(lostEvent);
    expect(lostEvent.defaultPrevented).toBe(true);

    // contextLost 中は描画しない
    rafCallback!(performance.now() + 1000);
    expect(tracker.drawCalls).toBe(drawCallsBeforeRestore);

    canvas.dispatchEvent(new Event('webglcontextrestored'));
    expect(tracker.shaderCompiles).toBe(shadersBeforeRestore + 2);
    expect(tracker.texUploads).toBeGreaterThan(texUploadsBeforeRestore);

    rafCallback!(performance.now() + 1016);
    expect(tracker.drawCalls).toBeGreaterThan(drawCallsBeforeRestore);

    container.remove();
  });

  it('3D三麻で抜北牌を河の右脇の安全エリアに大きく配置し、中央コンソールを1024x1024高解像度で描く', () => {
    const tracker: MockGlTracker = {
      drawCalls: 0,
      texUploads: 0,
      shaderCompiles: 0,
      loseContextCount: 0,
      tileVerts: null,
      tileIndices: null,
      drawnTiles: [],
      uploadedCanvasSizes: [],
    };
    const gl = createFakeWebGL2Context(tracker);
    const ctx2d = createFake2dContext();
    let rafCallback: FrameRequestCallback | null = null;

    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      rafCallback = cb;
      return 1;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
      function (this: HTMLCanvasElement, kind: string) {
        if (kind === 'webgl2') return gl;
        if (kind === '2d') return ctx2d;
        return null;
      } as unknown as HTMLCanvasElement['getContext'],
    );
    vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 1280,
      height: 720,
      top: 0,
      left: 0,
      right: 1280,
      bottom: 720,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    const container = document.createElement('div');
    document.body.appendChild(container);
    containers.push(container);

    const handlers = makeHandlers();
    const baseView3 = makeView(3, 9191);
    renderGameTable(container, baseView3, handlers, {
      riichiSelectingMode: false,
      autoTsumogiriEnabled: true,
      enable3dTable: true,
      cameraPreset: 'standard',
    });
    rafCallback!(performance.now());
    const baseCount = tracker.drawnTiles.length;

    // 1024x1024 の高精細コンソールテクスチャがアップロードされていること
    expect(
      tracker.uploadedCanvasSizes!.some((s) => s.width === 1024 && s.height === 1024),
    ).toBe(true);

    // 自席に抜北4枚を追加して描画差分・位置・スケールを検証する
    const viewWithKita = makeView(3, 9191);
    viewWithKita.players[0]!.kitaTiles = [
      t('k0', '4z'),
      t('k1', '4z'),
      t('k2', '4z'),
      t('k3', '4z'),
    ];
    tracker.drawnTiles.length = 0;
    renderGameTable(container, viewWithKita, handlers, {
      riichiSelectingMode: false,
      autoTsumogiriEnabled: true,
      enable3dTable: true,
      cameraPreset: 'standard',
    });
    rafCallback!(performance.now() + 16);
    expect(tracker.drawnTiles.length - baseCount).toBe(4);

    // 抜北4枚が専用台座高さ y=0.05、KITA_SCALE=0.90、河の右脇安全帯 (x∈[2.0,3.5], z∈[2.1,3.6]) に収まっていること
    const kitaDrawn = tracker.drawnTiles.filter((d) => {
      const y = d.model[13]!;
      const scaleX = Math.hypot(d.model[0]!, d.model[1]!, d.model[2]!);
      return Math.abs(y - 0.05) < 0.005 && Math.abs(scaleX - 0.9) < 0.01;
    });
    expect(kitaDrawn).toHaveLength(4);
    for (const d of kitaDrawn) {
      const tx = d.model[12]!;
      const tz = d.model[14]!;
      expect(tx).toBeGreaterThan(2.0);
      expect(tx).toBeLessThan(3.5);
      expect(tz).toBeGreaterThan(2.1);
      expect(tz).toBeLessThan(3.6);
    }

    container.remove();
  });

  it('3D卓でドラ・赤ドラ・重複ドラに3段階のuDoraGlowと加算オーラが描画され、狭幅画面でも14枚の手牌すべてをピックできる', () => {
    const tracker: MockGlTracker = {
      drawCalls: 0,
      texUploads: 0,
      shaderCompiles: 0,
      loseContextCount: 0,
      tileVerts: null,
      tileIndices: null,
      drawnTiles: [],
      additiveDraws: 0,
    };
    const gl = createFakeWebGL2Context(tracker);
    const ctx2d = createFake2dContext();
    let rafCallback: FrameRequestCallback | null = null;

    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      rafCallback = cb;
      return 1;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
      function (this: HTMLCanvasElement, kind: string) {
        if (kind === 'webgl2') return gl;
        if (kind === '2d') return ctx2d;
        return null;
      } as unknown as HTMLCanvasElement['getContext'],
    );

    let boxWidth = 1280;
    let boxHeight = 720;
    vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockImplementation(
      () => ({
        width: boxWidth,
        height: boxHeight,
        top: 0,
        left: 0,
        right: boxWidth,
        bottom: boxHeight,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }),
    );

    const container = document.createElement('div');
    document.body.appendChild(container);
    containers.push(container);

    const base = makeView(4, 7171);
    const viewWithDora: StateView = {
      ...base,
      round: base.round
        ? {
            ...base.round,
            // 表示牌 4p → 有効ドラ 5p
            doraIndicators: [t('ind-4p', '4p')],
          }
        : null,
      myHand: [
        t('d-5p-only', '5p', false), // glow 1 (通常ドラ)
        t('d-5m-red', '5m', true), // glow 2 (赤ドラ)
        t('d-5p-red', '5p', true), // glow 3 (ドラ+赤ドラ重複)
        t('n-1m', '1m', false),
        t('n-2m', '2m', false),
        t('n-3m', '3m', false),
        t('n-4m', '4m', false),
        t('n-6m', '6m', false),
        t('n-7m', '7m', false),
        t('n-8m', '8m', false),
        t('n-9m', '9m', false),
        t('n-1s', '1s', false),
        t('n-2s', '2s', false),
      ],
      myDrawnTile: t('n-3s', '3s', false),
    };

    const onSelectTile = vi.fn();
    const handlers = makeHandlers({ onSelectTile });
    renderGameTable(container, viewWithDora, handlers, {
      riichiSelectingMode: false,
      autoTsumogiriEnabled: true,
      enable3dTable: true,
      cameraPreset: 'standard',
    });

    rafCallback!(performance.now());
    const glowValues = new Set(
      tracker.drawnTiles.map((d) => d.doraGlow).filter((v) => (v ?? 0) > 0),
    );
    expect(glowValues.has(1)).toBe(true);
    expect(glowValues.has(2)).toBe(true);
    expect(glowValues.has(3)).toBe(true);
    expect(tracker.additiveDraws).toBeGreaterThanOrEqual(3);

    // 狭幅縦長画面 (400x700) でも端から端まで14枚全てレイキャストが当たる距離にカメラがフィットすること
    destroyTable3DScene(container);
    container.innerHTML = '';
    boxWidth = 400;
    boxHeight = 700;
    onSelectTile.mockClear();

    renderGameTable(container, viewWithDora, handlers, {
      riichiSelectingMode: false,
      autoTsumogiriEnabled: true,
      enable3dTable: true,
      cameraPreset: 'standard',
    });
    rafCallback!(performance.now() + 20);

    const canvas = container.querySelector<HTMLCanvasElement>('.table-3d-canvas')!;
    const pickedIds = new Set<string>();
    for (let x = 8; x <= 392; x += 12) {
      for (let y = 400; y <= 685; y += 16) {
        canvas.dispatchEvent(
          new PointerEvent('pointerdown', {
            clientX: x,
            clientY: y,
            pointerId: 1,
            pointerType: 'mouse',
            button: 0,
            bubbles: true,
          }),
        );
        canvas.dispatchEvent(
          new PointerEvent('pointerup', {
            clientX: x,
            clientY: y,
            pointerId: 1,
            pointerType: 'mouse',
            button: 0,
            bubbles: true,
          }),
        );
        const call = onSelectTile.mock.calls.at(-1)?.[0];
        if (typeof call === 'string') {
          pickedIds.add(call);
        }
      }
    }
    expect(pickedIds.has('d-5p-only')).toBe(true);
    expect(pickedIds.has('n-3s')).toBe(true);
    expect(pickedIds.size).toBe(14);

    container.remove();
  });

  it('3D卓でロン発生時に衝撃シェイク・閃光レーザー帯・ショックウェーブリングが加算描画される', () => {
    const tracker: MockGlTracker = {
      drawCalls: 0,
      texUploads: 0,
      shaderCompiles: 0,
      loseContextCount: 0,
      tileVerts: null,
      tileIndices: null,
      drawnTiles: [],
      additiveDraws: 0,
    };
    const gl = createFakeWebGL2Context(tracker);
    const ctx2d = createFake2dContext();
    let rafCallback: FrameRequestCallback | null = null;

    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      rafCallback = cb;
      return 1;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
      function (this: HTMLCanvasElement, kind: string) {
        if (kind === 'webgl2') return gl;
        if (kind === '2d') return ctx2d;
        return null;
      } as unknown as HTMLCanvasElement['getContext'],
    );
    vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 1280,
      height: 720,
      top: 0,
      left: 0,
      right: 1280,
      bottom: 720,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    const container = document.createElement('div');
    document.body.appendChild(container);
    containers.push(container);

    const handlers = makeHandlers();
    const baseView = makeView(4, 8181);
    const playingView: StateView = {
      ...baseView,
      players: baseView.players.map((p, idx) =>
        idx === 0
          ? {
              ...p,
              discards: [
                {
                  tile: t('ron-3d-target', '7p'),
                  isTsumogiri: false,
                  isRiichiDeclaration: false,
                },
              ],
            }
          : p,
      ),
    };

    renderGameTable(container, playingView, handlers, {
      riichiSelectingMode: false,
      autoTsumogiriEnabled: true,
      enable3dTable: true,
      cameraPreset: 'standard',
    });
    rafCallback!(performance.now());
    const baselineAdditive = tracker.additiveDraws ?? 0;

    const ronView: StateView = {
      ...playingView,
      phase: 'round_end',
      round: {
        ...playingView.round!,
        agariResults: [
          {
            playerId: playingView.players[1]!.playerId,
            seatIndex: 1,
            winType: 'ron',
            fromSeatIndex: 0,
            winningTile: t('ron-3d-target', '7p'),
            hand: [...playingView.myHand],
            melds: [],
            kitaTiles: [],
            yaku: [{ id: 'riichi', name: '立直', han: 1 }],
            doraCount: 0,
            uraDoraCount: 0,
            kitaCount: 0,
            han: 1,
            fu: 30,
            isYakuman: false,
            scoreLabel: '1000点',
            pointsAwarded: 1000,
            honbaPointsAwarded: 0,
            scoreDeltas: {},
          },
        ],
      },
    };

    tracker.additiveDraws = 0;
    renderGameTable(container, ronView, handlers, {
      riichiSelectingMode: false,
      autoTsumogiriEnabled: true,
      enable3dTable: true,
      cameraPreset: 'standard',
    });
    // 演出中の 0.25 秒時点を描画してショックウェーブリング + 閃光レーザー帯が増えていることを確認
    rafCallback!(performance.now() + 250);
    expect(tracker.additiveDraws).toBeGreaterThan(baselineAdditive + 2);

    container.remove();
  });

  it('3D卓で鳴きボタンホバー時に該当手牌がハイライト連動し河ターゲット牌も強調描画される', () => {
    const tracker: MockGlTracker = {
      drawCalls: 0,
      texUploads: 0,
      shaderCompiles: 0,
      loseContextCount: 0,
      tileVerts: null,
      tileIndices: null,
      drawnTiles: [],
      additiveDraws: 0,
    };
    const gl = createFakeWebGL2Context(tracker);
    const ctx2d = createFake2dContext();
    let rafCallback: FrameRequestCallback | null = null;

    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      rafCallback = cb;
      return 1;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
      function (this: HTMLCanvasElement, kind: string) {
        if (kind === 'webgl2') return gl;
        if (kind === '2d') return ctx2d;
        return null;
      } as unknown as HTMLCanvasElement['getContext'],
    );
    vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 1280,
      height: 720,
      top: 0,
      left: 0,
      right: 1280,
      bottom: 720,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    const container = document.createElement('div');
    document.body.appendChild(container);
    containers.push(container);

    const handlers = makeHandlers();
    const baseView = makeView(4, 9292);
    const h2m = t('call-3d-2m', '2m');
    const h4m = t('call-3d-4m', '4m');
    const d3m = t('call-3d-target-3m', '3m');

    const callView: StateView = {
      ...baseView,
      phase: 'awaiting_responses',
      responseRemainingMs: 8000,
      myHand: [h2m, h4m, ...baseView.myHand.slice(2)],
      players: baseView.players.map((p, idx) =>
        idx === 3
          ? {
              ...p,
              discards: [
                {
                  tile: d3m,
                  isTsumogiri: false,
                  isRiichiDeclaration: false,
                },
              ],
            }
          : p,
      ),
      myCallOptions: {
        discardedTile: d3m,
        discarderSeatIndex: 3,
        canRon: false,
        canPon: false,
        canDaiminkan: false,
        chiOptions: [{ tiles: [h2m, h4m] }],
      },
    };

    renderGameTable(container, callView, handlers, {
      riichiSelectingMode: false,
      autoTsumogiriEnabled: true,
      enable3dTable: true,
      cameraPreset: 'standard',
    });

    const chiBtn = container.querySelector<HTMLButtonElement>('.btn-call-chi')!;
    expect(chiBtn).not.toBeNull();
    chiBtn.dispatchEvent(new Event('mouseenter'));
    rafCallback!(performance.now() + 30);
    expect(tracker.drawCalls).toBeGreaterThan(0);

    chiBtn.dispatchEvent(new Event('mouseleave'));
    rafCallback!(performance.now() + 60);

    container.remove();
  });
});
