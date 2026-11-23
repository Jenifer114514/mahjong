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
}

interface MockGlTracker {
  drawCalls: number;
  texUploads: number;
  shaderCompiles: number;
  tileVerts: number[] | null;
  tileIndices: number[] | null;
  drawnTiles: DrawnTileRecord[];
}

function createFakeWebGL2Context(tracker: MockGlTracker): WebGL2RenderingContext {
  const noop = () => {};
  let nextId = 1;
  let currentModel: number[] = [];
  let currentUvRect: number[] = [0, 0, 0, 0];
  let currentUseAtlas = 0;

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
    texImage2D: () => {
      tracker.texUploads++;
    },
    generateMipmap: noop,
    texParameteri: noop,
    texParameterf: noop,
    activeTexture: noop,
    getExtension: () => null,
    getParameter: () => 1,
    enable: noop,
    disable: noop,
    cullFace: noop,
    blendFunc: noop,
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
      }
    },
    uniform1i: noop,
    drawElements: () => {
      tracker.drawCalls++;
      if (currentUseAtlas > 0.5) {
        tracker.drawnTiles.push({
          model: currentModel,
          uvRect: currentUvRect,
        });
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
});
