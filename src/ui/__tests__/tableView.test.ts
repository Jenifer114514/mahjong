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
import {
  captureDiscardOriginSnapshot,
  renderGameTable,
  type TableHandlers,
} from '../tableView';
import { soundEngine } from '../sound';

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

  it('局終了の結果画面はまず役と裏ドラを表示し、「次へ」で点数の移行表示へ切り替わる', () => {
    const view = toStateView(state4, 'p0', 0);
    const round = view.round!;
    const roundEndView: StateView = {
      ...view,
      phase: 'round_end',
      round: {
        ...round,
        uraDoraIndicators: [{ id: 'ura-1', kind: '6s', isRed: false }],
        roundScoreDeltas: {
          [view.players[0]!.playerId]: -2000,
          [view.players[1]!.playerId]: 4000,
          [view.players[2]!.playerId]: -1000,
          [view.players[3]!.playerId]: -1000,
        },
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
            uraDoraCount: 1,
            kitaCount: 0,
            han: 4,
            fu: 30,
            isYakuman: false,
            scoreLabel: '満貫',
            pointsAwarded: 8000,
            honbaPointsAwarded: 0,
            scoreDeltas: {},
          },
        ],
      },
    };

    const onAdvanceRound = vi.fn();
    const root = document.createElement('div');
    renderGameTable(root, roundEndView, { ...noopHandlers, onAdvanceRound });

    const overlay = root.querySelector<HTMLElement>('.round-end-panel')!;
    expect(overlay).not.toBeNull();
    // 1段階目: 役・和了牌・裏ドラ表示牌を表示し、スコア表はまだ出さない
    expect(overlay.dataset.resultStep).toBe('details');
    const chips = [...overlay.querySelectorAll('.yaku-chip')].map(
      (c) => c.textContent,
    );
    expect(chips).toContain('リーチ 1翻');
    expect(chips).toContain('平和 1翻');
    expect(chips).toContain('ドラ 1翻');
    expect(chips).toContain('裏ドラ 1翻');
    expect(overlay.querySelector('.ura-dora-box')).not.toBeNull();
    expect(overlay.querySelector('.score-table')).toBeNull();

    const nextStepBtn = overlay.querySelector<HTMLButtonElement>('.round-result-next-btn')!;
    expect(nextStepBtn).not.toBeNull();
    expect(nextStepBtn.textContent).toBe('次へ');
    nextStepBtn.click();

    // 2段階目: 点数移行テーブルと次局へボタンが表示される（通算収支列は出さない）
    expect(overlay.dataset.resultStep).toBe('scores');
    expect(overlay.querySelector('.ura-dora-box')).toBeNull();
    expect(overlay.querySelectorAll('.score-table tbody tr')).toHaveLength(4);
    const roundEndHeaders = Array.from(
      overlay.querySelectorAll('.score-table thead th'),
    ).map((th) => th.textContent);
    expect(roundEndHeaders).toEqual(['プレイヤー', '今局増減', '持ち点']);
    const advanceBtn = Array.from(overlay.querySelectorAll('button')).find((b) =>
      ['次の局へ', '結果を見る'].includes(b.textContent ?? ''),
    )!;
    expect(advanceBtn).not.toBeNull();
    advanceBtn.click();
    expect(onAdvanceRound).toHaveBeenCalledTimes(1);

    // 戻るボタンで役・裏ドラ画面にも戻れる
    const backBtn = overlay.querySelector<HTMLButtonElement>('.round-step-back-btn')!;
    expect(backBtn).not.toBeNull();
    backBtn.click();
    expect(overlay.dataset.resultStep).toBe('details');
    expect(overlay.querySelector('.ura-dora-box')).not.toBeNull();
  });

  it('流局終了時は1段階目で聴牌開示、次へを押すと2段階目のスコア表と次局ボタンを描画する（ホストのみ）', () => {
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

    const overlay = root.querySelector<HTMLElement>('.overlay-panel')!;
    expect(overlay).not.toBeNull();
    expect(root.querySelector('.overlay-backdrop.overlay-backdrop-modal .overlay-panel')).toBe(
      overlay,
    );
    expect(root.querySelector('.table-stage')).not.toBeNull();
    expect(overlay.querySelector('.tenpai-cards-list')).not.toBeNull();
    expect(overlay.querySelector('.score-table')).toBeNull();

    overlay.querySelector<HTMLButtonElement>('.round-result-next-btn')!.click();
    expect(overlay.querySelectorAll('.score-table tbody tr')).toHaveLength(4);
    expect(
      Array.from(overlay.querySelectorAll('button')).some((b) =>
        ['次の局へ', '結果を見る'].includes(b.textContent ?? ''),
      ),
    ).toBe(true);
  });

  it('終局時は overlay-backdrop-finished 内に結果パネルを描画し、通算収支列は出さない', () => {
    const baseView = toStateView(state4, 'p0', 0);
    const finishedView: StateView = {
      ...baseView,
      phase: 'finished',
      round: null,
    };
    const root = document.createElement('div');
    renderGameTable(root, finishedView, noopHandlers);

    const panel = root.querySelector(
      '.overlay-backdrop.overlay-backdrop-finished .overlay-panel.finished-panel',
    );
    expect(panel).not.toBeNull();
    const headers = Array.from(panel!.querySelectorAll('.score-table thead th')).map(
      (th) => th.textContent,
    );
    expect(headers).toEqual(['順位', 'プレイヤー', '持ち点']);
    expect(panel!.textContent).not.toContain('通算収支');
  });

  it('リーチ中でもツモ牌は2回タップ（選択→再タップ）で手動ツモ切りできる（手牌側は固定）', () => {
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

    // 1回目タップ: 選択状態（せり上がり）になり、まだ捨てない
    drawnTileEl.click();
    expect(drawnTileEl.classList.contains('mj-tile-selected')).toBe(true);
    expect(drawnTileEl.getAttribute('aria-pressed')).toBe('true');
    expect(onDiscardTile).not.toHaveBeenCalled();

    // 2回目タップ: 打牌確定
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

  it('中央コンソールの4方向点数・隅の自風・ドラパネル供託棒・左端クイック操作(理/和/鳴/切)・右上(チャット/設定/退出)を描画する', () => {
    const baseView = toStateView(state4, 'p0', 0);
    const onToggleAutoAgari = vi.fn();
    const onToggleAutoNoCall = vi.fn();
    const onToggleAutoTsumogiri = vi.fn();
    const onOpenSettings = vi.fn();
    const onOpenChat = vi.fn();

    const root = document.createElement('div');
    renderGameTable(
      root,
      baseView,
      {
        ...noopHandlers,
        canLeaveGame: true,
        onLeaveGame: () => {},
        onOpenSettings,
        onOpenChat,
        onToggleAutoAgari,
        onToggleAutoNoCall,
        onToggleAutoTsumogiri,
      },
      {
        riichiSelectingMode: false,
        autoTsumogiriEnabled: true,
        autoAgariEnabled: false,
        autoNoCallEnabled: false,
        unreadChatCount: 2,
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

    // 右上にチャット・設定・退出ボタンが並び、クリックで各ハンドラが呼ばれる
    const chromeButtons = Array.from(
      root.querySelectorAll<HTMLButtonElement>('.table-chrome > .table-chrome-btn'),
    );
    expect(chromeButtons.map((b) => b.className)).toEqual([
      expect.stringContaining('table-chrome-chat'),
      expect.stringContaining('table-chrome-settings'),
      expect.stringContaining('table-chrome-leave'),
    ]);
    const chatBtn = root.querySelector<HTMLButtonElement>('.table-chrome-chat')!;
    const settingsBtn = root.querySelector<HTMLButtonElement>('.table-chrome-settings')!;
    expect(chatBtn.querySelector('.chat-unread-badge')?.textContent).toBe('2');
    chatBtn.click();
    settingsBtn.click();
    expect(onOpenChat).toHaveBeenCalledTimes(1);
    expect(onOpenSettings).toHaveBeenCalledTimes(1);

    // 自分の手牌と副露ドックが存在する
    expect(root.querySelector('.self-hand-dock .self-melds-dock')).not.toBeNull();
    expect(root.querySelector('.self-hand-dock .hand-area')).not.toBeNull();
  });

  it('プレイヤー表示には東南西北・点数を出さずアイコンと名前・状態のみ表示し、中央方位・点数は中央コンソールに出す', () => {
    const baseView = toStateView(state4, 'p0', 0);
    const root = document.createElement('div');
    renderGameTable(root, baseView, noopHandlers);

    // 自分の .seat-header は .self-top-bar の外、.seat-orient-self 直下にある（5×5 卓グリッド左下セル配置）
    expect(root.querySelector('.self-top-bar > .seat-header')).toBeNull();
    const selfHeader = root.querySelector('.seat-orient-self > .seat-header');
    expect(selfHeader).not.toBeNull();
    expect(selfHeader!.querySelector('.seat-name')!.textContent).toContain('あなた');

    // 左右席の .seat-header は各席コンテナ直下に配置される（CSS Grid で手牌と河の間に配置）
    expect(root.querySelector('.seat-orient-left > .seat-header')).not.toBeNull();
    expect(root.querySelector('.seat-orient-right > .seat-header')).not.toBeNull();

    // 全4人ともアバター(seat-card-top) → 情報(seat-card-info -> seat-name) の縦順で、東南西北(.wind-badge)・点数(.seat-score)は出さない
    const headers = Array.from(root.querySelectorAll('.seat-header'));
    expect(headers).toHaveLength(4);
    for (const header of headers) {
      const children = Array.from(header.children);
      expect(children[0]!.classList.contains('seat-card-top')).toBe(true);
      expect(children[0]!.querySelector('.seat-avatar')).not.toBeNull();
      expect(header.querySelector('.wind-badge')).toBeNull();
      expect(header.querySelector('.seat-score')).toBeNull();

      expect(children[1]!.classList.contains('seat-card-info')).toBe(true);
      const infoChildren = Array.from(children[1]!.children);
      expect(infoChildren[0]!.classList.contains('seat-name')).toBe(true);
    }

    // 中央コンソールの東西南北が4隅すべて揃う
    expect(root.querySelector('.table-compass .compass-self .compass-wind')).not.toBeNull();
    expect(root.querySelector('.table-compass .compass-right .compass-wind')).not.toBeNull();
    expect(root.querySelector('.table-compass .compass-top .compass-wind')).not.toBeNull();
    expect(root.querySelector('.table-compass .compass-left .compass-wind')).not.toBeNull();
  });

  it('手番中は1回目タップで牌が選択状態になり、別牌へ切替でき、選択中の牌をもう一度押すと打牌される', () => {
    const view = toStateView(state4, 'p0', 0);
    const onDiscardTile = vi.fn();
    const onSelectTile = vi.fn();
    const root = document.createElement('div');
    renderGameTable(root, view, { ...noopHandlers, onDiscardTile, onSelectTile });

    const tiles = Array.from(
      root.querySelectorAll<HTMLButtonElement>('.seat-self .hand-area .mj-tile-clickable'),
    );
    expect(tiles.length).toBeGreaterThanOrEqual(2);

    const tileA = tiles[0]!;
    const tileB = tiles[1]!;

    // 1回目タップ: A が選択され打牌されない
    tileA.click();
    expect(tileA.classList.contains('mj-tile-selected')).toBe(true);
    expect(tileA.getAttribute('aria-pressed')).toBe('true');
    expect(onSelectTile).toHaveBeenLastCalledWith(tileA.dataset.tileId);
    expect(onDiscardTile).not.toHaveBeenCalled();

    // 別の牌 B をタップ: A が下がり B が選択される（打牌されない）
    tileB.click();
    expect(tileA.classList.contains('mj-tile-selected')).toBe(false);
    expect(tileB.classList.contains('mj-tile-selected')).toBe(true);
    expect(onSelectTile).toHaveBeenLastCalledWith(tileB.dataset.tileId);
    expect(onDiscardTile).not.toHaveBeenCalled();

    // 選択中の牌 B をもう一度タップ: 打牌確定
    tileB.click();
    expect(tileB.classList.contains('mj-tile-selected')).toBe(false);
    expect(onDiscardTile).toHaveBeenCalledTimes(1);
    expect(onDiscardTile).toHaveBeenCalledWith(tileB.dataset.tileId);

    // 卓の空きスペースをクリックすると選択解除される
    tileA.click();
    expect(tileA.classList.contains('mj-tile-selected')).toBe(true);
    root.querySelector<HTMLElement>('.table-felt')!.click();
    expect(tileA.classList.contains('mj-tile-selected')).toBe(false);
    expect(onSelectTile).toHaveBeenLastCalledWith(null);
  });

  it('観戦モード時は観戦HUDと視点切替を表示し、下家席を含め全員の手牌が伏せ表示で自操作バーが出ない', () => {
    let specState = reduce(state4, {
      type: 'JOIN_SPECTATOR',
      spectatorId: 'spec-view',
      name: '観戦くん',
    });
    const view = toStateView(specState, 'spec-view', 0, {
      perspectiveSeatIndex: 1,
    });
    const onChangePerspective = vi.fn();
    const root = document.createElement('div');
    renderGameTable(root, view, { ...noopHandlers, onChangePerspective });

    expect(root.querySelector('.spectator-hud')).not.toBeNull();
    expect(root.querySelector('.spectator-badge')?.textContent).toContain('観戦中');
    expect(root.querySelector('.table-left-actions')).toBeNull();
    expect(root.querySelector('.self-action-bar')).toBeNull();
    expect(root.querySelector('.seat-self.is-spectated')).not.toBeNull();
    // 観戦中の下辺手牌はすべて裏面表示（公開手牌ボタンなし）
    expect(root.querySelectorAll('.seat-self .mj-tile-clickable')).toHaveLength(0);
    expect(
      root.querySelectorAll('.seat-self .hand-area .mj-tile-back').length,
    ).toBeGreaterThanOrEqual(13);

    const seatBtns = root.querySelectorAll<HTMLButtonElement>('.spectator-seat-btn');
    expect(seatBtns.length).toBe(4);
    seatBtns[2]!.click();
    expect(onChangePerspective).toHaveBeenCalledWith(2);
  });

  it('新しく捨てられた牌のみリアル打牌モーションが付き、animationendでクリーンアップされる', () => {
    const advanceToNextTurn = (s: GameState): GameState => {
      let cur = s;
      while (cur.phase === 'awaiting_responses' && cur.round?.pendingResponse) {
        const pending = cur.round.pendingResponse;
        const responder = Object.keys(pending.optionsByPlayerId).find(
          (pid) => !(pid in pending.responses),
        );
        if (!responder) break;
        const res = applyAction(cur, {
          type: 'CALL_RESPONSE',
          playerId: responder,
          choice: { type: 'pass' },
        });
        if (res.error) break;
        cur = res.state;
      }
      return cur;
    };

    const root = document.createElement('div');
    const view0 = toStateView(state4, 'p0', 0);
    renderGameTable(root, view0, noopHandlers);
    expect(root.querySelectorAll('.mj-tile-discard-anim')).toHaveLength(0);

    // 親 (p0) が 1 枚捨てる
    const p0TileId =
      state4.players[0]!.drawnTile?.id ?? state4.players[0]!.hand[0]!.id;
    const afterP0Discard = advanceToNextTurn(
      applyAction(state4, {
        type: 'DISCARD_TILE',
        playerId: 'p0',
        tileId: p0TileId,
        now: 1,
      }).state,
    );
    const view1 = toStateView(afterP0Discard, 'p0', 0);
    renderGameTable(root, view1, noopHandlers);

    const selfAnimTiles = root.querySelectorAll<HTMLElement>(
      '.river-self .mj-tile-discard-anim',
    );
    expect(selfAnimTiles).toHaveLength(1);
    expect(selfAnimTiles[0]!.dataset.tileId).toBe(p0TileId);
    expect(selfAnimTiles[0]!.dataset.discardAnim).toBe('true');
    expect(selfAnimTiles[0]!.style.getPropertyValue('--discard-dx')).not.toBe('');
    expect(selfAnimTiles[0]!.style.getPropertyValue('--discard-dy')).not.toBe('');
    expect(
      root.querySelector('.river-zone.river-self')?.classList.contains(
        'is-discard-animating',
      ),
    ).toBe(true);

    // 同じ StateView で再描画してもアニメーションは再発火しない
    renderGameTable(root, view1, noopHandlers);
    expect(root.querySelectorAll('.mj-tile-discard-anim')).toHaveLength(0);

    // 下家 (p1) が 1 枚捨てる → 右家の新捨て牌のみアニメーションが付く
    const p1 = afterP0Discard.players[1]!;
    const p1TileId = p1.drawnTile?.id ?? p1.hand[0]!.id;
    const afterP1Discard = advanceToNextTurn(
      applyAction(afterP0Discard, {
        type: 'DISCARD_TILE',
        playerId: 'p1',
        tileId: p1TileId,
        now: 2,
      }).state,
    );
    const view2 = toStateView(afterP1Discard, 'p0', 0);
    renderGameTable(root, view2, noopHandlers);

    expect(root.querySelectorAll('.river-self .mj-tile-discard-anim')).toHaveLength(
      0,
    );
    const rightAnimTiles = root.querySelectorAll<HTMLElement>(
      '.river-right .mj-tile-discard-anim',
    );
    expect(rightAnimTiles).toHaveLength(1);
    expect(rightAnimTiles[0]!.dataset.tileId).toBe(p1TileId);
    expect(
      root.querySelector('.river-zone.river-right')?.classList.contains(
        'is-discard-animating',
      ),
    ).toBe(true);

    // animationend でクラスと河の前面昇格フラグが片付く
    const endEvent = Object.assign(new Event('animationend'), {
      animationName: 'tileDiscardThrow',
    });
    rightAnimTiles[0]!.dispatchEvent(endEvent);
    expect(root.querySelectorAll('.mj-tile-discard-anim')).toHaveLength(0);
    expect(
      root.querySelector('.river-zone.river-right')?.classList.contains(
        'is-discard-animating',
      ),
    ).toBe(false);
  });

  it('リーチ打牌時は専用の回転アニメが付与され、元の手牌座標差がFLIP反映される', () => {
    const baseView = toStateView(state4, 'p0', 0);
    const root = document.createElement('div');
    renderGameTable(root, baseView, noopHandlers);

    const discardTile = baseView.myDrawnTile ?? baseView.myHand[0]!;
    const handEl = root.querySelector<HTMLElement>(
      `.seat-self .hand-area [data-tile-id="${discardTile.id}"]`,
    )!;
    expect(handEl).not.toBeNull();

    // 元の手牌座標をモックしてスナップショットを採取
    vi.spyOn(handEl, 'getBoundingClientRect').mockReturnValue({
      left: 380,
      top: 520,
      width: 54,
      height: 74,
      right: 434,
      bottom: 594,
      x: 380,
      y: 520,
      toJSON: () => ({}),
    } as DOMRect);
    const snapshot = captureDiscardOriginSnapshot(root);
    expect(snapshot.selfTileRects.get(discardTile.id)?.cx).toBe(407);

    // リーチ宣言牌が追加された次のビューを用意し、着地先の rect もモックできるよう Element プロトタイプ側で一時フック
    const nextView: StateView = {
      ...baseView,
      players: baseView.players.map((p) =>
        p.playerId === 'p0'
          ? {
              ...p,
              isRiichi: true,
              discards: [
                ...p.discards,
                {
                  tile: discardTile,
                  isTsumogiri: false,
                  isRiichiDeclaration: true,
                },
              ],
            }
          : p,
      ),
    };

    const origGetRect = HTMLElement.prototype.getBoundingClientRect;
    const rectSpy = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement) {
        if (
          this.closest('.discard-river') &&
          this.dataset.tileId === discardTile.id
        ) {
          return {
            left: 290,
            top: 320,
            width: 31,
            height: 43,
            right: 321,
            bottom: 363,
            x: 290,
            y: 320,
            toJSON: () => ({}),
          } as DOMRect;
        }
        return origGetRect.call(this);
      });

    try {
      renderGameTable(root, nextView, noopHandlers, {
        riichiSelectingMode: false,
        autoTsumogiriEnabled: true,
        prevView: baseView,
        discardOriginSnapshot: snapshot,
      });

      const animTile = root.querySelector<HTMLElement>(
        '.river-self .mj-tile-discard-anim',
      )!;
      expect(animTile).not.toBeNull();
      expect(animTile.classList.contains('mj-tile-discard-riichi-anim')).toBe(
        true,
      );
      // 407 - 305.5 = +101.5px, 557 - 341.5 = +215.5px
      expect(animTile.style.getPropertyValue('--discard-dx')).toBe('101.5px');
      expect(animTile.style.getPropertyValue('--discard-dy')).toBe('215.5px');
      expect(animTile.style.getPropertyValue('--discard-end-rot')).toContain(
        '- 90deg',
      );
    } finally {
      rectSpy.mockRestore();
    }
  });

  it('鳴きで捨て牌が減った場合や局が変わった場合はアニメーションしない', () => {
    const baseView = toStateView(state4, 'p0', 0);
    const t0 = baseView.myDrawnTile ?? baseView.myHand[0]!;
    const withDiscardView: StateView = {
      ...baseView,
      players: baseView.players.map((p) =>
        p.playerId === 'p0'
          ? {
              ...p,
              discards: [
                { tile: t0, isTsumogiri: false, isRiichiDeclaration: false },
              ],
            }
          : p,
      ),
    };
    const root = document.createElement('div');
    renderGameTable(root, withDiscardView, noopHandlers);
    expect(root.querySelectorAll('.mj-tile-discard-anim')).toHaveLength(0);

    // 鳴きで捨て牌が減ったとき
    renderGameTable(root, baseView, noopHandlers);
    expect(root.querySelectorAll('.mj-tile-discard-anim')).toHaveLength(0);

    // 局が進んで次の局になったとき
    const nextRoundView: StateView = {
      ...withDiscardView,
      round: {
        ...withDiscardView.round!,
        roundIndex: withDiscardView.round!.roundIndex + 1,
      },
    };
    renderGameTable(root, nextRoundView, noopHandlers);
    expect(root.querySelectorAll('.mj-tile-discard-anim')).toHaveLength(0);
  });

  it('南家・西家など viewerSeatIndex が 0 以外のプレイヤーでも打牌モーションが発火し、観戦視点切替時は発火しない', () => {
    const southView0 = toStateView(state4, 'p1', 0);
    expect(southView0.viewerSeatIndex).toBe(1);
    const root = document.createElement('div');
    renderGameTable(root, southView0, noopHandlers, {
      riichiSelectingMode: false,
      autoTsumogiriEnabled: true,
      perspectiveSeatIndex: 0,
      prevView: null,
      prevPerspectiveSeatIndex: 0,
    });

    const p0TileId =
      state4.players[0]!.drawnTile?.id ?? state4.players[0]!.hand[0]!.id;
    const afterP0Discard = applyAction(state4, {
      type: 'DISCARD_TILE',
      playerId: 'p0',
      tileId: p0TileId,
      now: 1,
    }).state;
    const southView1 = toStateView(afterP0Discard, 'p1', 0);
    renderGameTable(root, southView1, noopHandlers, {
      riichiSelectingMode: false,
      autoTsumogiriEnabled: true,
      perspectiveSeatIndex: 0,
      prevView: southView0,
      prevPerspectiveSeatIndex: 0,
    });
    // p1(席1) から見て p0(席0) は上家 (left)
    expect(
      root.querySelectorAll('.river-left .mj-tile-discard-anim'),
    ).toHaveLength(1);

    // 観戦中に視点席を切り替えた瞬間は誤発火しない
    const specState = reduce(afterP0Discard, {
      type: 'JOIN_SPECTATOR',
      spectatorId: 'spec-persp',
      name: '観戦',
    });
    const specView0 = toStateView(specState, 'spec-persp', 0, {
      perspectiveSeatIndex: 0,
    });
    const specView1: StateView = {
      ...specView0,
      players: specView0.players.map((p) =>
        p.playerId === 'p1'
          ? {
              ...p,
              discards: [
                ...p.discards,
                {
                  tile: afterP0Discard.players[1]!.hand[0]!,
                  isTsumogiri: false,
                  isRiichiDeclaration: false,
                },
              ],
            }
          : p,
      ),
    };
    renderGameTable(root, specView1, noopHandlers, {
      riichiSelectingMode: false,
      autoTsumogiriEnabled: true,
      perspectiveSeatIndex: 1,
      prevView: specView0,
      prevPerspectiveSeatIndex: 0,
    });
    expect(root.querySelectorAll('.mj-tile-discard-anim')).toHaveLength(0);
  });

  it('ツモモーション・ツモ牌間隔・手番発光・局開始テロップ・中央コンソール情報・順位バッジを描画する', () => {
    const playRoundStartSpy = vi.spyOn(soundEngine, 'playRoundStart');
    const playDrawSpy = vi.spyOn(soundEngine, 'playDraw');
    const baseView = toStateView(state4, 'p0', 0);
    const root = document.createElement('div');
    renderGameTable(root, baseView, noopHandlers);

    // 1. 局開始テロップ（例: 東一局）が中央に出る
    const banner = root.querySelector('.round-start-banner');
    expect(banner).not.toBeNull();
    expect(banner!.querySelector('.round-start-banner-title')?.textContent).toBe('東一局');
    expect(playRoundStartSpy).toHaveBeenCalledTimes(1);

    // 2. ツモ牌が分離・スライドアニメーションが付く
    expect(root.querySelector('.seat-self .hand-area > .drawn-gap')).not.toBeNull();
    const drawnTile = root.querySelector('.seat-self .hand-area .mj-tile-drawn');
    expect(drawnTile).not.toBeNull();
    expect(drawnTile!.classList.contains('mj-tile-draw-anim')).toBe(true);

    // 3. 自分の手番時は手牌とプレイヤー枠が発光する
    expect(root.querySelector('.seat-self .hand-area.is-my-turn-hand')).not.toBeNull();
    expect(root.querySelector('.seat-orient-self .seat-header.is-turn.is-self-turn')).not.toBeNull();

    // 4. 中央コンソールに親・本場・供託・残り枚数が表示される
    expect(root.querySelector('.console-core .console-oya-pill')?.textContent).toContain('親');
    expect(root.querySelector('.console-core .console-honba')?.textContent).toContain('本');
    expect(root.querySelector('.console-core .console-kyotaku .stick-riichi')).not.toBeNull();

    // 5. 4席すべての統一プレイヤーカードに順位バッジがある
    expect(root.querySelectorAll('.seat-header .seat-rank-badge')).toHaveLength(4);

    // 6. 他家のツモ遷移でも相手の手牌ツモギャップとツモ音・アニメーションが発火する
    const p1Tile = baseView.myDrawnTile ?? baseView.myHand[0]!;
    const nextTurnView: StateView = {
      ...baseView,
      myDrawnTile: null,
      players: baseView.players.map((p) => {
        if (p.playerId === 'p0') {
          return {
            ...p,
            isCurrentTurn: false,
            hasDrawnTile: false,
            discards: [
              { tile: p1Tile, isTsumogiri: false, isRiichiDeclaration: false },
            ],
          };
        }
        if (p.playerId === 'p1') {
          return { ...p, isCurrentTurn: true, hasDrawnTile: true };
        }
        return p;
      }),
    };
    renderGameTable(root, nextTurnView, noopHandlers);
    const rightDrawn = root.querySelector('.seat-orient-right .hand-orient-right .opp-tile-drawn');
    expect(rightDrawn).not.toBeNull();
    expect(rightDrawn!.classList.contains('mj-tile-draw-anim')).toBe(true);
    expect(playDrawSpy).toHaveBeenCalled();

    playRoundStartSpy.mockRestore();
    playDrawSpy.mockRestore();
  });

  it('リーチ棒配置・鳴き移動＆横向き表示・ドラめくり・点数増減ポップが遷移に合わせて発火する', () => {
    const playRiichiSpy = vi.spyOn(soundEngine, 'playRiichi');
    const playMeldSpy = vi.spyOn(soundEngine, 'playMeld');
    const playDoraFlipSpy = vi.spyOn(soundEngine, 'playDoraFlip');

    const baseView = toStateView(state4, 'p0', 0);
    const root = document.createElement('div');
    renderGameTable(root, baseView, noopHandlers);

    const tileA = baseView.myHand[0]!;
    const tileB = baseView.myHand[1]!;
    const tileC = baseView.myHand[2]!;
    const extraDora = baseView.myHand[3]!;

    const updatedView: StateView = {
      ...baseView,
      kyotakuCount: 1,
      round: baseView.round
        ? {
            ...baseView.round,
            doraIndicators: [...baseView.round.doraIndicators, extraDora],
          }
        : null,
      players: baseView.players.map((p) => {
        if (p.playerId === 'p0') {
          return {
            ...p,
            score: p.score - 1000,
            isRiichi: true,
            discards: [
              { tile: tileA, isTsumogiri: false, isRiichiDeclaration: true },
            ],
          };
        }
        if (p.playerId === 'p1') {
          return {
            ...p,
            score: p.score + 2000,
            melds: [
              {
                type: 'pon',
                tiles: [tileA, tileB, tileC],
                calledTile: tileA,
                addedTile: null,
                fromSeatIndex: 0,
              },
            ],
          };
        }
        return p;
      }),
    };

    renderGameTable(root, updatedView, noopHandlers);

    // リーチ棒の実要素配置とアニメ
    const stick = root.querySelector('.console-score-self .console-riichi-stick');
    expect(stick).not.toBeNull();
    expect(stick!.classList.contains('is-riichi-stick-placed')).toBe(true);
    expect(playRiichiSpy).toHaveBeenCalled();

    // 点数増減ポップ表示
    const selfDelta = root.querySelector('.console-score-self .console-score-delta');
    expect(selfDelta?.textContent).toBe('-1,000');
    const rightDelta = root.querySelector('.console-score-right .console-score-delta');
    expect(rightDelta?.textContent).toBe('+2,000');

    // 鳴き移動アニメ＆鳴き牌クラス
    const meldGroup = root.querySelector('.seat-orient-right .meld-group.is-meld-anim');
    expect(meldGroup).not.toBeNull();
    expect(meldGroup!.querySelector('.mj-tile-called')).not.toBeNull();
    expect(playMeldSpy).toHaveBeenCalled();

    // 新規ドラめくりアニメ
    const flippedDoras = root.querySelectorAll('.dora-panel-tiles .dora-tile-flip');
    expect(flippedDoras).toHaveLength(1);
    expect(playDoraFlipSpy).toHaveBeenCalled();

    playRiichiSpy.mockRestore();
    playMeldSpy.mockRestore();
    playDoraFlipSpy.mockRestore();
  });

  it('鳴きボタンに牌の画像プレビューを含め、和了時は暗転フラッシュと大きな和了表示を出し、終局時は専用リザルトに点数変動を出す', () => {
    const playAgariSpy = vi.spyOn(soundEngine, 'playAgari');
    const baseView = toStateView(state4, 'p0', 0);

    // 1. 鳴き選択肢に牌の画像が含まれる
    const callView: StateView = {
      ...baseView,
      phase: 'awaiting_responses',
      myCallOptions: {
        discardedTile: baseView.myHand[0]!,
        discarderSeatIndex: 1,
        canRon: true,
        canPon: true,
        canDaiminkan: true,
        chiOptions: [
          { tiles: [baseView.myHand[1]!, baseView.myHand[2]!] },
        ],
      },
    };
    const root = document.createElement('div');
    renderGameTable(root, callView, noopHandlers);
    const callBtns = root.querySelectorAll('.call-action-bar .btn-with-tiles');
    expect(callBtns.length).toBeGreaterThanOrEqual(4);
    for (const btn of Array.from(callBtns)) {
      expect(btn.querySelector('.btn-tile-preview .mj-tile')).not.toBeNull();
    }
    const callText = root.querySelector('.call-action-bar')!.textContent!;
    expect(callText).toContain('ロン');
    expect(callText).toContain('ポン');
    expect(callText).toContain('大明槓');
    expect(callText).toContain('チー');
    expect(callText).toContain('スルー');

    // 2. playing -> round_end (和了あり) で暗転フラッシュ・強調コールアウト・和了音
    const agariView: StateView = {
      ...baseView,
      phase: 'round_end',
      round: {
        ...baseView.round!,
        agariResults: [
          {
            playerId: 'p0',
            seatIndex: 0,
            winType: 'tsumo',
            fromSeatIndex: null,
            winningTile: { id: 'w1', kind: '1m', isRed: false },
            hand: [...baseView.myHand],
            melds: [],
            kitaTiles: [],
            yaku: [{ id: 'riichi', name: '立直', han: 1 }],
            doraCount: 1,
            uraDoraCount: 0,
            kitaCount: 0,
            han: 2,
            fu: 30,
            isYakuman: false,
            scoreLabel: '2000点',
            pointsAwarded: 2000,
            honbaPointsAwarded: 0,
            scoreDeltas: {},
          },
        ],
      },
    };
    renderGameTable(root, agariView, noopHandlers);
    const backdrop = root.querySelector('.overlay-backdrop-modal');
    expect(backdrop!.classList.contains('is-agari-flash')).toBe(true);
    expect(root.querySelector('.agari-callout-hero')?.textContent).toContain('TSUMO');
    expect(playAgariSpy).toHaveBeenCalledWith(true);

    // 3. 終局リザルト画面に順位・最終点数・開始比点数変動カードが表示される（既存契約も維持）
    const finishedView: StateView = {
      ...baseView,
      phase: 'finished',
      round: null,
      players: baseView.players.map((p, idx) => ({
        ...p,
        score: idx === 0 ? 38000 : idx === 1 ? 26000 : idx === 2 ? 21000 : 15000,
      })),
    };
    renderGameTable(root, finishedView, noopHandlers);
    const podiumCards = root.querySelectorAll('.finished-panel .finished-podium-card');
    expect(podiumCards).toHaveLength(4);
    expect(podiumCards[0]!.textContent).toContain('1位');
    expect(podiumCards[0]!.textContent).toContain('38,000点');
    expect(podiumCards[0]!.textContent).toContain('開始比 +13,000点');
    expect(podiumCards[3]!.textContent).toContain('開始比 -10,000点');

    playAgariSpy.mockRestore();
  });
});

