// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type { StateView } from '../../types/message';
import {
  renderLobbyEntry,
  renderWaitingRoom,
  type LobbyFormState,
  type LobbyHandlers,
} from '../lobbyView';

// HostSession は peerjs を読み込むためスタブ化する（オフライン対局だけを使う）
vi.mock('peerjs', () => {
  class FakePeer {
    on() {}
    destroy() {}
    destroyed = false;
  }
  return { default: FakePeer };
});

const { HostSession } = await import('../../net/host');

function lobbySession(cpuCount: number): {
  session: InstanceType<typeof HostSession>;
  latest: () => StateView;
} {
  let current: StateView | null = null;
  const session = new HostSession(
    'ホスト',
    { playerCount: 4, gameLength: 'tonpuu' },
    {
      onViewChange: (view) => {
        current = view;
      },
      onStatusChange: () => {},
      onError: () => {},
    },
    { cpuCount, offline: true, cpuScheduler: () => {}, cpuDelayMs: 0 },
  );
  return {
    session,
    latest: () => current!,
  };
}

function clickByText(root: HTMLElement, text: string): boolean {
  const button = [...root.querySelectorAll('button')].find((btn) =>
    btn.textContent?.includes(text),
  );
  if (!button) return false;
  button.click();
  return true;
}

describe('renderWaitingRoom（CPU の後入れ）', () => {
  it('ホストには CPU 追加・削除ボタンが出て、押すとハンドラが呼ばれる', () => {
    const { session, latest } = lobbySession(1);
    session.start();

    const handlers: LobbyHandlers = {
      onCreateRoom: () => {},
      onJoinRoom: () => {},
      onStartLocalGame: () => {},
      onLeaveLobby: () => {},
      onAddCpu: vi.fn(),
      onRemoveCpu: vi.fn(),
    };

    const root = document.createElement('div');
    renderWaitingRoom(root, latest(), handlers);

    expect(root.querySelector('.lobby-cpu-controls')).not.toBeNull();
    expect(clickByText(root, 'CPU を追加')).toBe(true);
    expect(handlers.onAddCpu).toHaveBeenCalledTimes(1);
    expect(clickByText(root, 'CPU を減らす')).toBe(true);
    expect(handlers.onRemoveCpu).toHaveBeenCalledTimes(1);

    session.destroy();
  });

  it('ゲスト（ホスト以外）には CPU 操作ボタンを出さない', () => {
    const { session, latest } = lobbySession(1);
    session.start();

    const view = latest();
    const guestView: StateView = {
      ...view,
      viewerPlayerId: view.players[1]!.playerId,
    };

    const root = document.createElement('div');
    renderWaitingRoom(root, guestView, {
      onCreateRoom: () => {},
      onJoinRoom: () => {},
      onStartLocalGame: () => {},
      onLeaveLobby: () => {},
      onAddCpu: () => {},
      onRemoveCpu: () => {},
    });

    expect(root.querySelector('.lobby-cpu-controls')).toBeNull();

    session.destroy();
  });

  it('席が埋まっているときは追加ボタンが無効になる', () => {
    const { session, latest } = lobbySession(3);
    session.start();

    const root = document.createElement('div');
    renderWaitingRoom(root, latest(), {
      onCreateRoom: () => {},
      onJoinRoom: () => {},
      onStartLocalGame: () => {},
      onLeaveLobby: () => {},
      onAddCpu: () => {},
      onRemoveCpu: () => {},
    });

    // CPU 3 体で 4 人ぶんが埋まる
    expect(latest().players).toHaveLength(4);
    const addBtn = [...root.querySelectorAll('button')].find((btn) =>
      btn.textContent?.includes('CPU を追加'),
    )!;
    expect(addBtn.hasAttribute('disabled')).toBe(true);

    session.destroy();
  });

  it('ロビー入口では4人麻雀/3人麻雀と東風戦/半荘戦の選択のみを表示し、部屋作成時はCPU0体で作成する', () => {
    const onCreateRoom = vi.fn();
    const onStartLocalGame = vi.fn();
    const formState: LobbyFormState = {
      playerName: 'テスト',
      playerCount: 4,
      gameLength: 'tonpuu',
      tobi: true,
      tsumoLoss: false,
      allowKuitan: true,
      allowAtozuke: true,
      honbaBonus: true,
      joinCode: '',
      cpuCount: 0,
      cpuLevel: 'normal',
    };

    const root = document.createElement('div');
    renderLobbyEntry(
      root,
      formState,
      {
        onCreateRoom,
        onJoinRoom: () => {},
        onStartLocalGame,
        onLeaveLobby: () => {},
      },
      false,
    );

    // 入口に詳細トグルや CPU 強さ設定を出さない
    expect(root.querySelector('.rule-toggle-field')).toBeNull();
    expect(root.querySelectorAll('.seg-btn')).toHaveLength(4);
    expect(root.textContent).not.toContain('CPU の強さ');
    expect(root.textContent).not.toContain('CPU の人数');

    expect(clickByText(root, '3人麻雀')).toBe(true);
    expect(clickByText(root, '半荘戦')).toBe(true);
    expect(clickByText(root, '部屋を作成')).toBe(true);
    expect(onCreateRoom).toHaveBeenCalledWith(
      'テスト',
      expect.objectContaining({ playerCount: 3, gameLength: 'hanchan' }),
      0,
    );

    expect(clickByText(root, 'CPU対局をはじめる')).toBe(true);
    expect(onStartLocalGame).toHaveBeenCalledWith(
      'テスト',
      expect.objectContaining({ playerCount: 3, gameLength: 'hanchan' }),
      2,
    );
  });

  it('ルーム作成後のロビーではホストが4人/3人・東風/半荘と各種ON/OFF設定を変更できる（ゲストには編集UIを出さない）', () => {
    const { session, latest } = lobbySession(1);
    session.start();

    const onUpdateRuleConfig = vi.fn();
    const root = document.createElement('div');
    renderWaitingRoom(root, latest(), {
      onCreateRoom: () => {},
      onJoinRoom: () => {},
      onStartLocalGame: () => {},
      onLeaveLobby: () => {},
      onUpdateRuleConfig,
    });

    expect(root.querySelector('.lobby-settings-panel')).not.toBeNull();
    expect(clickByText(root, '3人麻雀')).toBe(true);
    expect(onUpdateRuleConfig).toHaveBeenCalledWith({ playerCount: 3 });

    expect(clickByText(root, '半荘戦')).toBe(true);
    expect(onUpdateRuleConfig).toHaveBeenCalledWith({ gameLength: 'hanchan' });

    // ON/OFF トグル群（トビ終了・喰いタン・後付け・本場加算・ダブロン・喰い替え禁止・CPUやさしめ）
    const offButtons = [...root.querySelectorAll('button')].filter((b) =>
      b.textContent?.startsWith('OFF'),
    );
    expect(offButtons.length).toBeGreaterThanOrEqual(7);
    offButtons[1]!.click(); // 喰いタン OFF
    expect(onUpdateRuleConfig).toHaveBeenCalledWith({ allowKuitan: false });

    // ゲスト視点では設定パネルを出さない
    const guestRoot = document.createElement('div');
    const view = latest();
    renderWaitingRoom(
      guestRoot,
      { ...view, viewerPlayerId: view.players[1]!.playerId },
      {
        onCreateRoom: () => {},
        onJoinRoom: () => {},
        onStartLocalGame: () => {},
        onLeaveLobby: () => {},
        onUpdateRuleConfig,
      },
    );
    expect(guestRoot.querySelector('.lobby-settings-panel')).toBeNull();

    session.destroy();
  });
});
