// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type { StateView } from '../../types/message';
import { renderWaitingRoom, type LobbyHandlers } from '../lobbyView';

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
});
