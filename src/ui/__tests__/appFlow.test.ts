// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

// PeerJS はブラウザ専用のためスタブ化（常設ルーム自動開設試験にも対応）
vi.mock('peerjs', () => {
  class FakePeer {
    static openPeers = new Set<string>();
    id: string;
    destroyed = false;
    private handlers: Record<string, Array<(...args: unknown[]) => void>> = {};
    constructor(id?: string) {
      this.id = id && id.length > 0 ? id : 'stub-client-peer';
      queueMicrotask(() => {
        if (this.destroyed) return;
        FakePeer.openPeers.add(this.id);
        this.emit('open', this.id);
      });
    }
    on(ev: string, cb: (...args: unknown[]) => void) {
      this.handlers[ev] = this.handlers[ev] ?? [];
      this.handlers[ev]!.push(cb);
    }
    emit(ev: string, ...args: unknown[]) {
      for (const cb of this.handlers[ev] ?? []) cb(...args);
    }
    connect() {
      const connHandlers: Record<string, Array<(...args: unknown[]) => void>> = {};
      queueMicrotask(() => {
        if (!this.destroyed) {
          this.emit('error', { type: 'peer-unavailable', message: 'not found' });
        }
      });
      return {
        open: false,
        on(ev: string, cb: (...args: unknown[]) => void) {
          connHandlers[ev] = connHandlers[ev] ?? [];
          connHandlers[ev]!.push(cb);
        },
        send() {},
        close() {},
      };
    }
    destroy() {
      this.destroyed = true;
      FakePeer.openPeers.delete(this.id);
    }
  }
  return { default: FakePeer };
});

type AppInstance = { render: () => void };

function bootApp(): { root: HTMLElement; app: AppInstance } {
  document.body.innerHTML = '<div id="app"></div>';
  vi.resetModules();
  const root = document.getElementById('app') as HTMLElement;
  return { root, app: {} as AppInstance };
}

async function loadMain(): Promise<void> {
  await import('../../main');
}

function clickByText(
  root: HTMLElement,
  selector: string,
  matcher: string,
): boolean {
  const target = Array.from(root.querySelectorAll<HTMLElement>(selector)).find(
    (el) => (el.textContent ?? '').includes(matcher),
  );
  if (!target) return false;
  target.click();
  return true;
}

describe('アプリ起動とローカルCPU対局', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('ロビーを描画し4人/3人と東風/半荘の選択肢のみを持つ', async () => {
    bootApp();
    await loadMain();

    const root = document.getElementById('app') as HTMLElement;
    expect(root.querySelector('.app-shell')).not.toBeNull();
    expect(root.querySelector('.app-title')?.textContent).toBe('PeerJS 対戦リーチ麻雀');
    expect(root.textContent).toContain('部屋を作る（ホスト）');
    expect(root.textContent).toContain('いますぐCPUと対局');
    expect(
      Array.from(root.querySelectorAll('.seg-btn')).some(
        (b) => (b.textContent ?? '').includes('4人麻雀') &&
          b.classList.contains('is-active'),
      ),
    ).toBe(true);
    expect(
      Array.from(root.querySelectorAll('.seg-btn')).some(
        (b) => (b.textContent ?? '').includes('東風戦') &&
          b.classList.contains('is-active'),
      ),
    ).toBe(true);
    // 入口画面には詳細トグルを出さず、4択（4人/3人、東風/半荘）のみ
    expect(root.querySelector('.rule-toggle-field')).toBeNull();
    expect(root.querySelectorAll('.seg-btn')).toHaveLength(4);
  });

  it('「部屋を作成」でロビーへ入り、作成後に人数・長さ・ON/OFF設定を変更してCPU追加で対局開始できる', async () => {
    bootApp();
    await loadMain();

    const root = document.getElementById('app') as HTMLElement;
    expect(clickByText(root, 'button', '部屋を作成')).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(root.querySelector('.lobby-settings-panel')).not.toBeNull();
    expect(clickByText(root, 'button', '3人麻雀')).toBe(true);
    expect(clickByText(root, 'button', '半荘戦')).toBe(true);
    // 3人麻雀にするとツモ損トグルも出る
    expect(root.textContent).toContain('ツモ損');

    // CPU を 2 体追加しても自動開局せず、開始ボタンが有効になって押すと開局する
    expect(clickByText(root, 'button', 'CPU を追加')).toBe(true);
    expect(clickByText(root, 'button', 'CPU を追加')).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(root.querySelector('.table-stage')).toBeNull();
    const startBtn = root.querySelector<HTMLButtonElement>('.lobby-start-btn')!;
    expect(startBtn).not.toBeNull();
    expect(startBtn.disabled).toBe(false);
    startBtn.click();
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(root.querySelector('.table-stage.is-landscape')).not.toBeNull();
    expect(root.querySelector('.dora-panel-mode')?.textContent).toContain('3人半荘戦');
  });

  it('「CPU対局をはじめる」で対局画面（横画面レイアウト）に遷移する', async () => {
    bootApp();
    await loadMain();

    const root = document.getElementById('app') as HTMLElement;
    expect(clickByText(root, 'button', 'CPU対局をはじめる')).toBe(true);

    // CPU の自動進行はタイマー駆動なので、決定論的に進めるため少し待つ
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(root.querySelector('.table-stage.is-landscape')).not.toBeNull();
    // 対戦中は雀卓だけを表示する（トップバー・サイドパネルなし）
    expect(root.querySelector('.top-bar.is-hidden-in-game')).not.toBeNull();
    expect(root.querySelector('.side-panel')).toBeNull();
    expect(root.querySelector('.table-chrome-leave')).not.toBeNull();
    expect(root.querySelector('.dora-panel')).not.toBeNull();
    expect(root.querySelectorAll('.cpu-badge').length).toBe(3);
    // 自分の手牌が描画されている
    const handTiles = root.querySelectorAll('.seat-self .hand-area .mj-tile');
    expect(handTiles.length).toBeGreaterThanOrEqual(13);
  });

  it('手番になったら1回目タップで牌が選択状態になり、2回目タップで打牌できて捨て牌が増える', async () => {
    bootApp();
    await loadMain();

    const root = document.getElementById('app') as HTMLElement;
    clickByText(root, 'button', 'CPU対局をはじめる');

    // 自分の手番になるまで待つ（CPU 3体が打牌を終えるまで。途中で鳴き確認が出たらスルー）
    let selectedObserved = false;
    let acted = false;
    let before = 0;
    for (let i = 0; i < 200 && !acted; i++) {
      await new Promise((resolve) => setTimeout(resolve, 40));
      clickByText(root, '.call-action-bar button', 'スルー');
      const clickable = root.querySelectorAll<HTMLElement>(
        '.seat-self .hand-area .mj-tile-clickable',
      );
      if (clickable.length > 0) {
        const firstTile = clickable[0]!;
        before = root.querySelectorAll('.seat-self .discard-river .mj-tile')
          .length;
        // 1回目タップ: 選択のみ行いまだ打牌しない
        firstTile.click();
        if (firstTile.classList.contains('mj-tile-selected')) {
          selectedObserved = true;
        }
        expect(
          root.querySelectorAll('.seat-self .discard-river .mj-tile').length,
        ).toBe(before);

        // 2回目タップ: 選択中の牌を打牌確定
        firstTile.click();
        for (let j = 0; j < 20 && !acted; j++) {
          await new Promise((resolve) => setTimeout(resolve, 30));
          const after = root.querySelectorAll(
            '.seat-self .discard-river .mj-tile',
          ).length;
          if (after === before + 1) acted = true;
        }
      }
    }
    expect(selectedObserved, '1回目タップで選択状態になる').toBe(true);
    expect(acted, '2回目タップで自分の捨て牌が 1 枚増える').toBe(true);
  }, 30000);

  it('対局中に退出を押すとアプリ内確認モーダルが出て、キャンセルで続行・確定でロビーへ戻る', async () => {
    bootApp();
    await loadMain();

    const root = document.getElementById('app') as HTMLElement;
    expect(clickByText(root, 'button', 'CPU対局をはじめる')).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 40));

    const leaveBtn = root.querySelector<HTMLButtonElement>('.table-chrome-leave')!;
    expect(leaveBtn).not.toBeNull();
    leaveBtn.click();

    const modal = root.querySelector('.leave-confirm-modal');
    expect(modal).not.toBeNull();
    expect(modal!.textContent).toContain('対局を離れますか？');

    expect(clickByText(root, '.leave-confirm-modal button', '対局を続ける')).toBe(true);
    expect(root.querySelector('.leave-confirm-modal')).toBeNull();
    expect(root.querySelector('.table-stage')).not.toBeNull();

    root.querySelector<HTMLButtonElement>('.table-chrome-leave')!.click();
    expect(clickByText(root, '.leave-confirm-modal button', 'ロビーに戻る')).toBe(true);
    expect(root.querySelector('.table-stage')).toBeNull();
    expect(root.textContent).toContain('部屋を作る（ホスト）');
  });

  it('設定ボタンでフル画面表示のON/OFF設定が開き、チャットボタンでメッセージ送信できる', async () => {
    bootApp();
    await loadMain();

    let fsEl: Element | null = null;
    Object.defineProperty(document, 'fullscreenElement', {
      configurable: true,
      get: () => fsEl,
    });
    const reqFs = vi.fn(async () => {
      fsEl = document.documentElement;
      document.dispatchEvent(new Event('fullscreenchange'));
    });
    const exitFs = vi.fn(async () => {
      fsEl = null;
      document.dispatchEvent(new Event('fullscreenchange'));
    });
    document.documentElement.requestFullscreen = reqFs;
    document.exitFullscreen = exitFs;

    const root = document.getElementById('app') as HTMLElement;
    expect(clickByText(root, 'button', 'CPU対局をはじめる')).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 40));

    // 退出の横に設定とチャットがある
    expect(root.querySelector('.table-chrome-chat')).not.toBeNull();
    expect(root.querySelector('.table-chrome-settings')).not.toBeNull();
    expect(root.querySelector('.table-chrome-leave')).not.toBeNull();

    // 設定を開いてフル画面表示トグルを OFF → ON → OFF に切り替える
    root.querySelector<HTMLButtonElement>('.table-chrome-settings')!.click();
    const settingsModal = root.querySelector('.table-settings-modal');
    expect(settingsModal).not.toBeNull();
    expect(settingsModal!.textContent).toContain('フル画面表示');

    const fsSwitch1 = root.querySelector<HTMLButtonElement>('.table-settings-modal [role="switch"]')!;
    expect(fsSwitch1.getAttribute('aria-checked')).toBe('false');
    expect(fsSwitch1.textContent).toContain('OFF');
    fsSwitch1.click();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(reqFs).toHaveBeenCalledTimes(1);

    const fsSwitch2 = root.querySelector<HTMLButtonElement>('.table-settings-modal [role="switch"]')!;
    expect(fsSwitch2.getAttribute('aria-checked')).toBe('true');
    expect(fsSwitch2.textContent).toContain('ON');
    fsSwitch2.click();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(exitFs).toHaveBeenCalledTimes(1);

    expect(clickByText(root, '.table-settings-modal button', '閉じる')).toBe(true);
    expect(root.querySelector('.table-settings-modal')).toBeNull();

    // チャットを開いて定型文・入力送信できる
    root.querySelector<HTMLButtonElement>('.table-chrome-chat')!.click();
    const chatModal = root.querySelector('.table-chat-modal');
    expect(chatModal).not.toBeNull();
    expect(clickByText(root, '.table-chat-modal .chat-quick-btn', 'よろしく！')).toBe(true);

    const input = root.querySelector<HTMLInputElement>('.table-chat-modal .chat-input')!;
    input.value = 'おつかれさまです';
    input.dispatchEvent(new Event('input'));
    root.querySelector<HTMLFormElement>('.table-chat-modal .chat-input-row')!.dispatchEvent(
      new Event('submit', { cancelable: true }),
    );

    const items = Array.from(root.querySelectorAll('.chat-message-item')).map(
      (el) => el.textContent ?? '',
    );
    expect(items.some((t) => t.includes('よろしく！'))).toBe(true);
    expect(items.some((t) => t.includes('おつかれさまです'))).toBe(true);

    expect(clickByText(root, '.table-chat-modal button', '閉じる')).toBe(true);
    expect(root.querySelector('.table-chat-modal')).toBeNull();
  });

  it('常設ルーム（銅の間）に誰もいない状態で入室すると自動でホスト立卓し待機ロビーへ入る', async () => {
    localStorage.clear();
    bootApp();
    await loadMain();

    const root = document.getElementById('app') as HTMLElement;
    expect(root.textContent).toContain('常設ルーム（銅の間・銀の間・金の間）');
    expect(clickByText(root, 'button', '銅の間に入る')).toBe(true);

    let enteredLobby = false;
    for (let i = 0; i < 40; i++) {
      await new Promise((resolve) => setTimeout(resolve, 15));
      if (root.textContent?.includes('銅の間 (BRONZE)')) {
        enteredLobby = true;
        break;
      }
    }
    expect(enteredLobby).toBe(true);
    expect(root.querySelector('.lobby-start-btn')).not.toBeNull();
  });

  it('対局中は Wake Lock を取得し、visibilitychange でホスト警告表示・復帰で解除、離脱時に Wake Lock を解放する', async () => {
    localStorage.clear();
    let visState: 'visible' | 'hidden' = 'visible';
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => visState,
    });

    const releaseMock = vi.fn(async () => {});
    const requestMock = vi.fn(async () => ({
      released: false,
      release: releaseMock,
      addEventListener: () => {},
    }));
    Object.defineProperty(navigator, 'wakeLock', {
      configurable: true,
      value: { request: requestMock },
    });

    bootApp();
    await loadMain();

    const root = document.getElementById('app') as HTMLElement;
    expect(clickByText(root, 'button', 'CPU対局をはじめる')).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(requestMock).toHaveBeenCalledWith('screen');

    // タブ背面化でホスト自身に警告バナーが出る
    visState = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    const warnBanner = root.querySelector('.table-host-away-banner');
    expect(warnBanner).not.toBeNull();
    expect(warnBanner!.textContent).toContain('背面');

    // タブ復帰で警告が消え、Wake Lock を再取得する
    visState = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(root.querySelector('.table-host-away-banner')).toBeNull();
    expect(requestMock.mock.calls.length).toBeGreaterThanOrEqual(2);

    // 対局から退出すると Wake Lock が解放される
    root.querySelector<HTMLButtonElement>('.table-chrome-leave')!.click();
    expect(clickByText(root, '.leave-confirm-modal button', 'ロビーに戻る')).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(releaseMock).toHaveBeenCalled();
  });

  it('クライアント側で HOST_STATUS(away) に応じて「ホストが画面を離れています」バナーを表示・解除できる', async () => {
    const { renderGameTable } = await import('../tableView');
    const { ClientSession } = await import('../../net/client');

    // 1. ClientSession が HOST_STATUS を受けて onHostAwayChange を発火すること
    let receivedAway: boolean | null = null;
    const client = new ClientSession(
      'ROOM01',
      'ゲスト',
      {
        onViewChange: () => {},
        onStatusChange: () => {},
        onError: () => {},
        onHostAwayChange: (away) => {
          receivedAway = away;
        },
      },
      { turnConfigured: false },
    );
    client.connect();
    // openDataConnection を呼び出して fake conn に HOST_STATUS を流すため peer open を発火
    const fakePeer = (client as unknown as {
      peer: { emit: (ev: string, ...args: unknown[]) => void };
    }).peer;
    let dataHandler: ((msg: unknown) => void) | undefined;
    (client as unknown as {
      peer: {
        connect: () => {
          open: boolean;
          on: (ev: string, cb: (...args: unknown[]) => void) => void;
          send: () => void;
          close: () => void;
        };
      };
    }).peer.connect = () => ({
      open: true,
      on(ev: string, cb: (...args: unknown[]) => void) {
        if (ev === 'data') dataHandler = cb;
      },
      send() {},
      close() {},
    });
    fakePeer.emit('open', 'client-peer-1');
    dataHandler?.({ kind: 'HOST_STATUS', payload: { away: true } });
    expect(receivedAway).toBe(true);
    dataHandler?.({ kind: 'HOST_STATUS', payload: { away: false } });
    expect(receivedAway).toBe(false);
    client.destroy();

    // 2. tableView が hostStatusBanner に「ホストが画面を離れています」を描画すること
    const { createStartedCustomGame } = await import(
      '../../engine/__tests__/testHelpers'
    );
    const { toStateView } = await import('../../engine/projection');
    const state = createStartedCustomGame(4, { hands: {} });
    const view = toStateView(state, 'p1', 1000);
    const container = document.createElement('div');
    const noopHandlers = {
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
    renderGameTable(container, view, noopHandlers, {
      riichiSelectingMode: false,
      autoTsumogiriEnabled: true,
      hostStatusBanner: 'ホストが画面を離れています',
    });
    const banner = container.querySelector('.table-host-away-banner');
    expect(banner?.textContent).toBe('ホストが画面を離れています');
  });
});
