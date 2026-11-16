// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest';
import { toStateView } from '../../engine/projection';
import { createInitialGameState, reduce } from '../../engine/reducer';
import { deriveRules } from '../../engine/rules';
import { buildSeededTestDeck } from '../../engine/__tests__/testHelpers';
import type { StateView } from '../../types/message';
import type { GameState } from '../../types/state';
import { renderGameTable, type TableHandlers } from '../tableView';

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

    // 右サイドパネル（局情報・スコア・捨て牌）
    const panel = root.querySelector('.side-panel')!;
    expect(panel).not.toBeNull();
    expect(panel.querySelector('.side-panel-title')?.textContent).toContain('東1局');
    expect(panel.querySelectorAll('.score-table tbody tr')).toHaveLength(4);
    expect(panel.querySelectorAll('.side-river-row')).toHaveLength(4);

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
    expect(root.querySelectorAll('.side-river-row')).toHaveLength(3);
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
    expect(overlay.querySelectorAll('.score-table tbody tr')).toHaveLength(4);
    expect(
      Array.from(overlay.querySelectorAll('button')).some((b) =>
        ['次の局へ', '結果を見る'].includes(b.textContent ?? ''),
      ),
    ).toBe(true);
  });
});
