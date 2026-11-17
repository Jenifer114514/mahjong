// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { toStateView } from '../../engine/projection';
import { createInitialGameState, reduce } from '../../engine/reducer';
import { deriveRules } from '../../engine/rules';
import { buildSeededTestDeck } from '../../engine/__tests__/testHelpers';
import type { StateView } from '../../types/message';
import type { GameState } from '../../types/state';
import { decideCpuAction } from '../../cpu/player';
import { applyAction } from '../../engine/reducer';
import { renderGameTable, type TableHandlers } from '../tableView';

const onLeaveGameSpy = vi.fn();

const noopHandlers: TableHandlers = {
  onDiscardTile: () => {},
  onCallResponse: () => {},
  onDeclareTsumo: () => {},
  onDeclareRiichi: () => {},
  onDeclareAnkan: () => {},
  onDeclareKakan: () => {},
  onDeclareKita: () => {},
  onDeclareKyuushuKyuuhai: () => {},
  onAdvanceRound: () => {},
  onReturnToLobby: () => {},
};

function startedState(playerCount: 3 | 4, seed: number): GameState {
  const ruleConfig = { playerCount, gameLength: 'tonpuu' as const };
  const rules = deriveRules(ruleConfig);
  let state = createInitialGameState({
    roomCode: 'VIEW01',
    hostPlayerId: 'p0',
    hostName: 'P0',
    ruleConfig,
  });
  for (let i = 1; i < playerCount; i++) {
    state = reduce(state, { type: 'JOIN_PLAYER', playerId: `p${i}`, name: `P${i}` });
  }
  return reduce(state, {
    type: 'START_GAME',
    shuffledDeck: buildSeededTestDeck(rules, seed),
  });
}

let state4: GameState;
let state3: GameState;

beforeAll(() => {
  state4 = startedState(4, 9090);
  state3 = startedState(3, 3131);
});

describe('renderGameTable（横画面レイアウト）', () => {
  it('横画面用のステージとサイドパネル・4方向の席を描画する', () => {
    const view: StateView = toStateView(state4, 'p0', 0);
    const root = document.createElement('div');
    renderGameTable(root, view, noopHandlers);

    const stage = root.querySelector('.table-stage');
    expect(stage).not.toBeNull();
    expect(stage!.classList.contains('is-landscape')).toBe(true);

    const felt = root.querySelector('.table-felt');
    expect(felt!.classList.contains('is-landscape')).toBe(true);

    // 4人麻雀: 対面・左・右・自分
    expect(root.querySelector('.seat-top')).not.toBeNull();
    expect(root.querySelector('.seat-left')).not.toBeNull();
    expect(root.querySelector('.seat-right')).not.toBeNull();
    expect(root.querySelector('.seat-self')).not.toBeNull();

    // 対局中は雀卓だけ（サイドパネルは出さない）
    expect(root.querySelector('.side-panel')).toBeNull();

    // ドラ表示は卓の左上にまとめる（中央の「場」からは外す）
    const doraPanel = root.querySelector('.table-felt > .dora-panel');
    expect(doraPanel).not.toBeNull();
    // 山に伏せられている分は裏向きの牌で枠だけ示す
    expect(
      doraPanel!.querySelectorAll('.dora-panel-tiles .mj-tile').length,
    ).toBeGreaterThanOrEqual(view.round!.doraIndicators.length);
    expect(root.querySelector('.center-hub .dora-strip')).toBeNull();

    // 自分の手牌 13 枚 + ツモ牌
    const handTiles = root.querySelectorAll('.seat-self .hand-area .mj-tile');
    expect(handTiles.length).toBe(view.myHand.length + (view.myDrawnTile ? 1 : 0));
  });

  it('3人麻雀では対面席を作らず、上家を左に配置する', () => {
    const view = toStateView(state3, 'p0', 0);
    const root = document.createElement('div');
    renderGameTable(root, view, noopHandlers);

    expect(root.querySelectorAll('.seat-top.seat-empty')).toHaveLength(1);
    expect(root.querySelector('.seat-left')).not.toBeNull();
    expect(root.querySelector('.seat-right')).not.toBeNull();
    // 河は各席の卓上に描かれる（3人麻雀なので 3 席ぶん）
    expect(root.querySelectorAll('.seat-box .river-zone')).toHaveLength(3);
  });

  it('CPU 席には CPU バッジを表示する', () => {
    let state = createInitialGameState({
      roomCode: 'CPUUI1',
      hostPlayerId: 'p0',
      hostName: 'P0',
      ruleConfig: { playerCount: 4, gameLength: 'tonpuu' },
    });
    for (let i = 1; i <= 3; i++) {
      state = reduce(state, {
        type: 'JOIN_PLAYER',
        playerId: `cpu-${i}`,
        name: `CPU${i}`,
      });
    }
    const rules = deriveRules(state.ruleConfig);
    state = reduce(state, {
      type: 'START_GAME',
      shuffledDeck: buildSeededTestDeck(rules, 5150),
    });

    const view = toStateView(state, 'p0', 0);
    const root = document.createElement('div');
    renderGameTable(root, view, noopHandlers);

    expect(root.querySelectorAll('.cpu-badge')).toHaveLength(3);
  });

  it('自分の手番では手牌がタップ可能・他家ターンでは操作不可になる', () => {
    const view = toStateView(state4, 'p0', 0);
    const root = document.createElement('div');
    renderGameTable(root, view, noopHandlers);

    const self = view.players.find((p) => p.playerId === 'p0')!;
    const clickable = root.querySelectorAll('.seat-self .hand-area .mj-tile-clickable');
    expect(self.isCurrentTurn).toBe(true);
    expect(clickable.length).toBeGreaterThan(0);

    // 手番でない他家視点では操作ボタンが出ない
    const otherView = toStateView(state4, 'p1', 0);
    const otherRoot = document.createElement('div');
    renderGameTable(otherRoot, otherView, noopHandlers);
    expect(
      otherRoot.querySelectorAll('.seat-self .hand-area .mj-tile-clickable'),
    ).toHaveLength(0);
  });

  it('実物の雀卓と同じ向きで4方向に席・河・方位リングを描画する', () => {
    // 数牌を打ち合った状態を作るため、対局を少し進める
    let state = state4;
    for (let i = 0; i < 12 && state.phase === 'playing'; i++) {
      const current = state.players.find(
        (p) => p.seatIndex === state.round!.currentTurnIndex,
      )!;
      const drawn = current.drawnTile;
      if (!drawn) break;
      const view = toStateView(state, current.playerId, 0);
      const decision = decideCpuAction(view);
      if (!decision || decision.type !== 'DISCARD_TILE') break;
      const result = applyAction(state, {
        type: 'DISCARD_TILE',
        playerId: current.playerId,
        tileId: decision.tileId,
        now: 0,
      });
      if (result.error) break;
      state = result.state;
      if (state.phase === 'awaiting_responses') break;
    }

    const view = toStateView(state, 'p0', 0);
    const root = document.createElement('div');
    renderGameTable(root, view, noopHandlers);

    // 4方向それぞれに「向き」クラスと data-seat が付く
    for (const side of ['self', 'top', 'left', 'right']) {
      const seat = root.querySelector(`.seat-orient-${side}`);
      expect(seat, `seat-orient-${side}`).not.toBeNull();
      expect(seat!.getAttribute('data-seat')).toBe(side);
    }

    // 対面は手牌が 180 度、左右は縦向き
    expect(root.querySelector('.hand-orient-top')).not.toBeNull();
    expect(root.querySelector('.hand-orient-left')).not.toBeNull();
    expect(root.querySelector('.hand-orient-right')).not.toBeNull();

    // 河は4人分すべて描画され、席の向きクラスを持つ
    expect(root.querySelectorAll('.seat-box .river-zone')).toHaveLength(4);
    expect(root.querySelector('.seat-box .river-top')).not.toBeNull();
    expect(root.querySelector('.seat-box .river-left')).not.toBeNull();
    expect(root.querySelector('.seat-box .river-right')).not.toBeNull();
    expect(root.querySelector('.seat-box .river-self')).not.toBeNull();

    // 河は各自 6 枚折り返し
    expect(root.querySelector('.seat-box .discard-river.river-rows-6')).not.toBeNull();

    // 中央に方位リング（自風・親・手番）
    const compass = root.querySelector('.table-compass')!;
    expect(compass).not.toBeNull();
    expect(compass.querySelectorAll('.compass-slot')).toHaveLength(4);
  });

  it('対局中は雀卓だけを表示し、退出ボタンと左上のドラ表示を出す', () => {
    const view = toStateView(state4, 'p0', 0);
    const root = document.createElement('div');
    const handlers: TableHandlers = {
      ...noopHandlers,
      canLeaveGame: true,
      onLeaveGame: onLeaveGameSpy,
    };
    onLeaveGameSpy.mockClear();
    renderGameTable(root, view, handlers);

    // 卓以外のパネルは出さない
    expect(root.querySelector('.side-panel')).toBeNull();

    // 卓の上に退出ボタン
    const leave = root.querySelector<HTMLButtonElement>('.table-chrome-leave');
    expect(leave).not.toBeNull();
    expect(leave!.textContent).toBe('退出');
    leave!.click();
    expect(onLeaveGameSpy).toHaveBeenCalledTimes(1);

    // ドラ表示は卓の左上（中央ハブには入れない）
    const felt = root.querySelector('.table-felt')!;
    expect(felt.querySelector(':scope > .dora-panel')).not.toBeNull();
    expect(root.querySelector('.center-hub .dora-strip')).toBeNull();

    // 対局中はトップバー相当の要素も出さない（canLeaveGame 無しなら退出ボタンも無し）
    const root2 = document.createElement('div');
    renderGameTable(root2, view, noopHandlers);
    expect(root2.querySelector('.table-chrome-leave')).toBeNull();
  });

  it('局と局の間は和了役をまとめて表示する', () => {
    const view = toStateView(state4, 'p0', 0);
    const round = view.round!;
    const roundEndView: StateView = {
      ...view,
      phase: 'round_end',
      round: {
        ...round,
        agariResults: [
          {
            winType: 'ron',
            playerId: view.players[1]!.playerId,
            seatIndex: view.players[1]!.seatIndex,
            fromSeatIndex: view.players[0]!.seatIndex,
            winningTile: { id: 'w1', kind: '1m', isRed: false },
            hand: [...view.myHand],
            melds: [],
            kitaTiles: [],
            yaku: [
              { id: 'riichi', name: 'リーチ', han: 1 },
              { id: 'pinfu', name: '平和', han: 1 },
            ],
            doraCount: 1,
            uraDoraCount: 0,
            kitaCount: 0,
            han: 3,
            fu: 30,
            isYakuman: false,
            scoreLabel: '3900',
            pointsAwarded: 3900,
            honbaPointsAwarded: 0,
            scoreDeltas: {},
          },
        ],
      },
    };

    const root = document.createElement('div');
    renderGameTable(root, roundEndView, noopHandlers);

    const summary = root.querySelector('.round-yaku-summary')!;
    expect(summary).not.toBeNull();
    expect(summary.querySelector('.round-yaku-title')?.textContent).toBe('和了役');

    const chips = [...summary.querySelectorAll('.round-yaku-chip')].map(
      (c) => c.textContent,
    );
    expect(chips).toContain('リーチ 1翻');
    expect(chips).toContain('平和 1翻');
    expect(chips).toContain('ドラ 1翻');
    expect(summary.querySelector('.round-yaku-total')?.textContent).toContain(
      '3翻 30符',
    );
  });

  it('局終了時はオーバーレイにスコア表と次局ボタンを描画する（ホストのみ）', () => {
    const view = toStateView(state4, 'p0', 0);
    const roundEndView: StateView = {
      ...view,
      phase: 'round_end',
      round: view.round
        ? {
            ...view.round,
            tenpaiPlayerIds: view.players.map((p) => p.playerId),
            revealedHands: Object.fromEntries(
              view.players.map((p) => [p.playerId, [...view.myHand]]),
            ),
          }
        : null,
    };
    const root = document.createElement('div');
    renderGameTable(root, roundEndView, noopHandlers);

    const overlay = root.querySelector('.overlay-panel')!;
    expect(overlay).not.toBeNull();
    expect(root.querySelector('.overlay-backdrop.overlay-backdrop-modal .overlay-panel')).toBe(
      overlay,
    );
    expect(root.querySelector('.table-stage')).not.toBeNull();
    expect(overlay.querySelectorAll('.score-table tbody tr')).toHaveLength(4);
    expect(
      Array.from(overlay.querySelectorAll('button')).some((b) =>
        ['次の局へ', '結果を見る'].includes(b.textContent ?? ''),
      ),
    ).toBe(true);
  });

  it('終局時は overlay-backdrop-finished 内に結果パネルを描画する', () => {
    const baseView = toStateView(state4, 'p0', 0);
    const finishedView: StateView = {
      ...baseView,
      phase: 'finished',
      round: null,
    };
    const root = document.createElement('div');
    renderGameTable(root, finishedView, noopHandlers);

    expect(
      root.querySelector('.overlay-backdrop.overlay-backdrop-finished .overlay-panel'),
    ).not.toBeNull();
  });

  it('リーチ中でもツモ牌はクリックして手動ツモ切りできる（手牌側は固定）', () => {
    const baseView = toStateView(state4, 'p0', 0);
    const drawn = baseView.myDrawnTile ?? baseView.myHand[0]!;
    const hand = baseView.myDrawnTile
      ? baseView.myHand
      : baseView.myHand.slice(1);
    const currentSeat = baseView.round!.currentTurnIndex;
    const riichiView: StateView = {
      ...baseView,
      phase: 'playing',
      myHand: hand,
      myDrawnTile: drawn,
      kuikaeForbiddenKinds: [],
      players: baseView.players.map((p) =>
        p.playerId === baseView.viewerPlayerId
          ? { ...p, isCurrentTurn: true, isRiichi: true }
          : { ...p, isCurrentTurn: p.seatIndex === currentSeat && false },
      ),
      round: {
        ...baseView.round!,
        currentTurnIndex: baseView.players.find(
          (p) => p.playerId === baseView.viewerPlayerId,
        )!.seatIndex,
      },
    };

    const onDiscardTile = vi.fn();
    const root = document.createElement('div');
    renderGameTable(root, riichiView, { ...noopHandlers, onDiscardTile });

    const handButtons = Array.from(
      root.querySelectorAll<HTMLButtonElement>('.seat-self .hand-area > .mj-tile'),
    );
    const closedHandButtons = handButtons.slice(0, hand.length);
    const drawnTileEl = handButtons[hand.length]!;

    expect(handButtons).toHaveLength(hand.length + 1);
    for (const btn of closedHandButtons) {
      expect(btn.disabled).toBe(true);
    }
    expect(drawnTileEl).not.toBeNull();
    expect(drawnTileEl.disabled).toBe(false);
    expect(drawnTileEl.classList.contains('mj-tile-clickable')).toBe(true);

    drawnTileEl.click();
    expect(onDiscardTile).toHaveBeenCalledTimes(1);
    expect(onDiscardTile).toHaveBeenCalledWith(drawn.id);
  });

  it('ローカルCPU戦では「部屋 LOCAL」を出さず「ローカルCPU戦」を表示し、round_end 時はリーチバーを出さない', () => {
    const baseView = toStateView(state4, 'p0', 0);
    const localView: StateView = {
      ...baseView,
      roomCode: 'LOCAL',
      phase: 'round_end',
      players: baseView.players.map((p) =>
        p.playerId === baseView.viewerPlayerId ? { ...p, isRiichi: true } : p,
      ),
    };

    const root = document.createElement('div');
    renderGameTable(root, localView, noopHandlers);
    expect(root.textContent).not.toContain('部屋 LOCAL');
    expect(root.textContent).toContain('ローカルCPU戦');
    expect(root.querySelector('.self-action-bar')).toBeNull();
  });

  it('他家の手番中に自分がリーチ済みなら「リーチ待機中:」で表示する', () => {
    const baseView = toStateView(state4, 'p0', 0);
    const otherSeat = baseView.players.find(
      (p) => p.playerId !== baseView.viewerPlayerId,
    )!.seatIndex;
    const waitingView: StateView = {
      ...baseView,
      phase: 'playing',
      mySelfActions: null,
      players: baseView.players.map((p) => ({
        ...p,
        isCurrentTurn: p.seatIndex === otherSeat,
        isRiichi: p.playerId === baseView.viewerPlayerId,
      })),
      round: {
        ...baseView.round!,
        currentTurnIndex: otherSeat,
      },
    };

    const root = document.createElement('div');
    renderGameTable(root, waitingView, noopHandlers);
    const bar = root.querySelector('.self-action-bar');
    expect(bar).not.toBeNull();
    expect(bar!.textContent).toContain('リーチ待機中:');
    expect(bar!.textContent).not.toContain('リーチ中:');
  });

  it('中央コンソールの4方向点数・隅の自風・ドラパネル供託棒・左端クイック操作(理/和/鳴/切)を描画し、右上には設定ボタンを出さない', () => {
    const baseView = toStateView(state4, 'p0', 0);
    const onToggleAutoAgari = vi.fn();
    const onToggleAutoNoCall = vi.fn();
    const onToggleAutoTsumogiri = vi.fn();

    const root = document.createElement('div');
    renderGameTable(
      root,
      baseView,
      {
        ...noopHandlers,
        canLeaveGame: true,
        onLeaveGame: () => {},
        onToggleAutoAgari,
        onToggleAutoNoCall,
        onToggleAutoTsumogiri,
      },
      {
        riichiSelectingMode: false,
        autoTsumogiriEnabled: true,
        autoAgariEnabled: false,
        autoNoCallEnabled: false,
      },
    );

    // 左上ドラパネルにドラ表示枠5枚と供託・本場棒がある
    expect(root.querySelectorAll('.dora-panel-tiles .mj-tile')).toHaveLength(5);
    expect(root.querySelector('.dora-panel-sticks .stick-riichi')).not.toBeNull();
    expect(root.querySelector('.dora-panel-sticks .stick-honba')).not.toBeNull();

    // 中央コンソールに4方向スコアと局名・残り枚数（余 XX）がある
    expect(root.querySelectorAll('.console-scores .console-score')).toHaveLength(4);
    expect(root.querySelector('.console-core .round-label')!.textContent).toContain('東1局');
    expect(root.querySelector('.console-core .wall-counter')!.textContent).toMatch(/^余 \d+/);

    // 4人全員にアバターカードがある
    expect(root.querySelectorAll('.seat-header .seat-avatar')).toHaveLength(4);

    // 左端バー 理/和/鳴/切 の操作が連動する
    const tabs = Array.from(root.querySelectorAll<HTMLButtonElement>('.table-left-actions .left-action-tab'));
    expect(tabs.map((t) => t.textContent)).toEqual(['理', '和', '鳴', '切']);
    tabs[1]!.click();
    tabs[2]!.click();
    tabs[3]!.click();
    expect(onToggleAutoAgari).toHaveBeenCalledWith(true);
    expect(onToggleAutoNoCall).toHaveBeenCalledWith(true);
    expect(onToggleAutoTsumogiri).toHaveBeenCalledWith(false);

    // 右上には退出ボタンのみ表示され、設定ボタンは出さない
    expect(root.querySelector('.table-chrome-settings')).toBeNull();
    expect(root.querySelector('.table-settings-popover')).toBeNull();
    expect(root.querySelector('.table-chrome-leave')).not.toBeNull();

    // 自分の手牌と副露ドックが存在する
    expect(root.querySelector('.self-hand-dock .self-melds-dock')).not.toBeNull();
    expect(root.querySelector('.self-hand-dock .hand-area')).not.toBeNull();
  });

  it('プレイヤー表示はアバターアイコンの下に名前を縦配置し、自分の表示は卓の左下空き領域へ独立配置し、中央方位表示が各家方向を向く', () => {
    const baseView = toStateView(state4, 'p0', 0);
    const root = document.createElement('div');
    renderGameTable(root, baseView, noopHandlers);

    // 自分の .seat-header は .self-top-bar の外、.seat-orient-self 直下にある（5×5 卓グリッド左下セル配置）
    expect(root.querySelector('.self-top-bar > .seat-header')).toBeNull();
    const selfHeader = root.querySelector('.seat-orient-self > .seat-header');
    expect(selfHeader).not.toBeNull();
    expect(selfHeader!.querySelector('.seat-name')!.textContent).toContain('あなた');

    // 全4人ともアバター上にバッジを重ねず、アイコン(seat-card-top) → 名前(seat-name) → 自風バッジ群(seat-identity) → 点数(seat-score) の縦順になっている
    const headers = Array.from(root.querySelectorAll('.seat-header'));
    expect(headers).toHaveLength(4);
    for (const header of headers) {
      const children = Array.from(header.children);
      expect(children[0]!.classList.contains('seat-card-top')).toBe(true);
      expect(children[0]!.querySelector('.seat-avatar')).not.toBeNull();
      expect(children[0]!.querySelector('.wind-badge')).toBeNull();

      expect(children[1]!.classList.contains('seat-card-info')).toBe(true);
      const infoChildren = Array.from(children[1]!.children);
      expect(infoChildren[0]!.classList.contains('seat-name')).toBe(true);
      expect(infoChildren[1]!.classList.contains('seat-identity')).toBe(true);
      expect(infoChildren[1]!.querySelector('.wind-badge')).not.toBeNull();
      expect(infoChildren[2]!.classList.contains('seat-score')).toBe(true);
    }

    // 中央コンソールの東西南北が4隅すべて揃う
    expect(root.querySelector('.table-compass .compass-self .compass-wind')).not.toBeNull();
    expect(root.querySelector('.table-compass .compass-right .compass-wind')).not.toBeNull();
    expect(root.querySelector('.table-compass .compass-top .compass-wind')).not.toBeNull();
    expect(root.querySelector('.table-compass .compass-left .compass-wind')).not.toBeNull();
  });
});
