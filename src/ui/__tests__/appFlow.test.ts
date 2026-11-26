// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

// PeerJS はブラウザ専用のためスタブ化（常設ルーム自動開設試験にも対応）
const fakePeerRegistry = new Map<
  string,
  { emit: (ev: string, ...args: unknown[]) => void }
>();

vi.mock('peerjs', () => {
  class FakePeer {
    static openPeers = new Set<string>();
    id: string;
    destroyed = false;
    private handlers: Record<string, Array<(...args: unknown[]) => void>> = {};
    constructor(id?: string) {
      this.id = id && id.length > 0 ? id : 'stub-client-peer';
      fakePeerRegistry.set(this.id, this);
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
      if (fakePeerRegistry.get(this.id) === this) {
        fakePeerRegistry.delete(this.id);
      }
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
    window.dispatchEvent(new Event('beforeunload'));
    vi.useRealTimers();
  });

  it('ロビーを描画し4人/3人と東風/半荘の選択肢のみを持つ', async () => {
    bootApp();
    await loadMain();

    const root = document.getElementById('app') as HTMLElement;
    expect(root.querySelector('.app-shell')).not.toBeNull();
    expect(root.querySelector('.app-title')?.textContent).toBe('PeerJS 対戦リーチ麻雀');
    expect(root.textContent).toContain('部屋を作る');
    expect(root.textContent).not.toContain('部屋を作る（ホスト）');
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
    // 入口画面には詳細トグル・詳細設定を出さず、4択（4人/3人、東風/半荘）のみ
    expect(root.querySelector('.rule-toggle-field')).toBeNull();
    expect(root.querySelector('.lobby-advanced-details')).toBeNull();
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

    // 空席それぞれに「CPU を追加」ボタンが表示され、追加後の CPU 席には「CPU を削除」ボタンが表示される
    expect(root.querySelectorAll('.player-slot.is-empty')).toHaveLength(2);
    expect(root.querySelectorAll('.lobby-cpu-add-btn')).toHaveLength(2);
    expect(clickByText(root, 'button', 'CPU を追加')).toBe(true);
    expect(root.querySelectorAll('.lobby-cpu-remove-btn')).toHaveLength(1);
    expect(clickByText(root, 'button', 'CPU を削除')).toBe(true);
    expect(root.querySelectorAll('.lobby-cpu-remove-btn')).toHaveLength(0);
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
          const riverTiles = root.querySelectorAll<HTMLElement>(
            '.seat-self .discard-river .mj-tile',
          );
          if (riverTiles.length === before + 1) {
            expect(riverTiles[riverTiles.length - 1]!.dataset.discardAnim).toBe(
              'true',
            );
            acted = true;
          }
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
    expect(root.textContent).toContain('部屋を作る');
    expect(root.textContent).not.toContain('部屋を作る（ホスト）');
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

  it('ホーム画面で常設ルームの参加状況を自動取得しても入力欄のフォーカスを維持する', async () => {
    localStorage.clear();
    bootApp();
    await loadMain();

    const root = document.getElementById('app') as HTMLElement;
    const nameInput = root.querySelector<HTMLInputElement>('#player-name-input')!;
    expect(nameInput).not.toBeNull();
    nameInput.focus();
    expect(document.activeElement).toBe(nameInput);

    let allEmpty = false;
    for (let i = 0; i < 40; i++) {
      await new Promise((resolve) => setTimeout(resolve, 15));
      const occupancies = Array.from(
        root.querySelectorAll('.permanent-room-occupancy'),
      ).map((el) => el.textContent ?? '');
      if (
        occupancies.length === 3 &&
        occupancies.every((t) => t.includes('空き（現在 0人）'))
      ) {
        allEmpty = true;
        break;
      }
    }

    expect(allEmpty).toBe(true);
    expect(document.activeElement).toBe(nameInput);
  });

  it('対局中の設定ポップアップから効果音の ON/OFF を切り替えられる', async () => {
    localStorage.clear();
    bootApp();
    await loadMain();
    const { soundEngine } = await import('../sound');
    soundEngine.setEnabled(true);

    const root = document.getElementById('app') as HTMLElement;
    expect(clickByText(root, 'button', 'CPU対局をはじめる')).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 40));

    root.querySelector<HTMLButtonElement>('.table-chrome-settings')!.click();
    const soundSwitch = root.querySelector<HTMLButtonElement>(
      '.table-settings-panel button[aria-label="効果音"]',
    );
    expect(soundSwitch).not.toBeNull();
    expect(soundSwitch!.getAttribute('aria-checked')).toBe('true');

    soundSwitch!.click();
    expect(soundEngine.isEnabled()).toBe(false);
    expect(localStorage.getItem('arena-mahjong:sound-enabled:v1')).toBe('0');
    const updatedSwitch = root.querySelector<HTMLButtonElement>(
      '.table-settings-panel button[aria-label="効果音"]',
    );
    expect(updatedSwitch!.getAttribute('aria-checked')).toBe('false');

    updatedSwitch!.click();
    expect(soundEngine.isEnabled()).toBe(true);
    expect(localStorage.getItem('arena-mahjong:sound-enabled:v1')).toBe('1');
  });

  it('チャットを開いた時と新規受信時に会話の一番下へスクロールされる（DOM接続後にスクロール実行）', async () => {
    localStorage.clear();

    // 実ブラウザ同様、DOM 接続済み(isConnected=true)の場合だけ scrollHeight が 480 になる挙動を模擬
    const origScrollHeightDesc = Object.getOwnPropertyDescriptor(
      Element.prototype,
      'scrollHeight',
    );
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get(this: HTMLElement) {
        if (this.classList?.contains('chat-messages-list')) {
          return this.isConnected ? 480 : 0;
        }
        return origScrollHeightDesc?.get?.call(this) ?? 0;
      },
    });

    try {
      bootApp();
      await loadMain();

      const root = document.getElementById('app') as HTMLElement;
      expect(clickByText(root, 'button', 'CPU対局をはじめる')).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 40));

      // チャットを開いて連投してから一度閉じる
      root.querySelector<HTMLButtonElement>('.table-chrome-chat')!.click();
      for (const msg of ['1通目', '2通目', '3通目']) {
        const input = root.querySelector<HTMLInputElement>('.chat-input')!;
        input.value = msg;
        input.dispatchEvent(new Event('input'));
        root
          .querySelector<HTMLFormElement>('.chat-input-row')!
          .dispatchEvent(new Event('submit', { cancelable: true }));
      }
      root.querySelector<HTMLButtonElement>('.table-modal-close-btn')!.click();
      expect(root.querySelector('.table-chat-modal')).toBeNull();

      // 再度チャットを開いたとき、DOM接続後かつ rAF 後に一番下(scrollTop=480)になる
      root.querySelector<HTMLButtonElement>('.table-chrome-chat')!.click();
      const list = root.querySelector<HTMLElement>('.chat-messages-list')!;
      expect(list).not.toBeNull();
      expect(list.scrollTop).toBe(480);

      // さらに開いた状態で追加送信しても一番下のまま
      const input2 = root.querySelector<HTMLInputElement>('.chat-input')!;
      input2.value = '4通目';
      input2.dispatchEvent(new Event('input'));
      root
        .querySelector<HTMLFormElement>('.chat-input-row')!
        .dispatchEvent(new Event('submit', { cancelable: true }));
      expect(list.scrollTop).toBe(480);

      // レイアウト確定遅延(30ms〜100ms)で高さが増えた場合もユーザーが上にスクロールしていなければ追従する
      const origClientHeightDesc = Object.getOwnPropertyDescriptor(
        Element.prototype,
        'clientHeight',
      );
      let dynamicHeight = 640;
      Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
        configurable: true,
        get(this: HTMLElement) {
          if (this.classList?.contains('chat-messages-list')) {
            return this.isConnected ? dynamicHeight : 0;
          }
          return origScrollHeightDesc?.get?.call(this) ?? 0;
        },
      });
      Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
        configurable: true,
        get(this: HTMLElement) {
          if (this.classList?.contains('chat-messages-list')) {
            return 160;
          }
          return origClientHeightDesc?.get?.call(this) ?? 0;
        },
      });
      try {
        root.querySelector<HTMLButtonElement>('.table-modal-close-btn')!.click();
        root.querySelector<HTMLButtonElement>('.table-chrome-chat')!.click();
        const listReopened = root.querySelector<HTMLElement>('.chat-messages-list')!;
        expect(listReopened.scrollTop).toBe(640);

        dynamicHeight = 760;
        await new Promise((resolve) => setTimeout(resolve, 120));
        expect(listReopened.scrollTop).toBe(760);

        // ユーザーが手動で上へスクロールしたら途中位置を維持し、閉じ直して再度開けばまた一番下へ行く
        listReopened.dispatchEvent(new Event('wheel'));
        listReopened.scrollTop = 120;
        listReopened.dispatchEvent(new Event('scroll'));
        dynamicHeight = 820;
        await new Promise((resolve) => setTimeout(resolve, 120));
        expect(listReopened.scrollTop).toBe(120);

        root.querySelector<HTMLButtonElement>('.table-modal-close-btn')!.click();
        root.querySelector<HTMLButtonElement>('.table-chrome-chat')!.click();
        const listReopenedAgain =
          root.querySelector<HTMLElement>('.chat-messages-list')!;
        expect(listReopenedAgain.scrollTop).toBe(820);
      } finally {
        if (origClientHeightDesc) {
          Object.defineProperty(
            HTMLElement.prototype,
            'clientHeight',
            origClientHeightDesc,
          );
        } else {
          delete (HTMLElement.prototype as unknown as Record<string, unknown>)
            .clientHeight;
        }
      }
    } finally {
      if (origScrollHeightDesc) {
        Object.defineProperty(
          HTMLElement.prototype,
          'scrollHeight',
          origScrollHeightDesc,
        );
      } else {
        delete (HTMLElement.prototype as unknown as Record<string, unknown>)
          .scrollHeight;
      }
    }
  });

  it('対局中にチャットを送ると送信プレイヤーのアイコンから吹き出しが出て一定時間後に消える', async () => {
    vi.useFakeTimers();
    localStorage.clear();
    fakePeerRegistry.clear();

    bootApp();
    await loadMain();

    const root = document.getElementById('app') as HTMLElement;
    expect(clickByText(root, 'button', '部屋を作成')).toBe(true);
    await vi.advanceTimersByTimeAsync(20);

    const roomCode = root
      .querySelector('.room-code-value')!
      .textContent!.trim();
    const { roomCodeToPeerId } = await import('../../net/protocol');
    const hostPeer = fakePeerRegistry.get(roomCodeToPeerId(roomCode));
    expect(hostPeer).toBeDefined();

    // リモートプレイヤーを1人参加させて、残り2席をCPUで埋めて開始する
    const connHandlers: Record<string, Array<(...args: unknown[]) => void>> = {};
    const remoteConn = {
      peer: 'remote-peer-1',
      open: true,
      on(ev: string, cb: (...args: unknown[]) => void) {
        connHandlers[ev] = connHandlers[ev] ?? [];
        connHandlers[ev]!.push(cb);
      },
      send() {},
      close() {},
    };
    hostPeer!.emit('connection', remoteConn);
    connHandlers.open?.forEach((cb) => cb());
    connHandlers.data?.forEach((cb) =>
      cb({ kind: 'JOIN', playerName: 'ゲスト花子' }),
    );

    expect(clickByText(root, 'button', 'CPU を追加')).toBe(true);
    expect(clickByText(root, 'button', 'CPU を追加')).toBe(true);
    root.querySelector<HTMLButtonElement>('.lobby-start-btn')!.click();
    await vi.advanceTimersByTimeAsync(20);

    expect(root.querySelector('.table-stage.is-landscape')).not.toBeNull();

    // 自分がチャット送信 → 自分アイコン(.seat-orient-self .seat-card-top)から吹き出し出現
    root.querySelector<HTMLButtonElement>('.table-chrome-chat')!.click();
    expect(clickByText(root, '.chat-quick-btn', 'よろしく！')).toBe(true);

    const selfBubble = root.querySelector(
      '.seat-orient-self .seat-card-top .seat-chat-bubble',
    );
    expect(selfBubble).not.toBeNull();
    expect(selfBubble!.textContent).toBe('よろしく！');
    expect(selfBubble!.classList.contains('is-bubble-enter')).toBe(true);
    root.querySelector<HTMLButtonElement>('.table-modal-close-btn')!.click();

    // 他プレイヤー(ゲスト花子)がチャット送信 → 該当プレイヤーのアイコンから吹き出し出現
    connHandlers.data?.forEach((cb) =>
      cb({ kind: 'CHAT', text: 'お手柔らかに！' }),
    );
    const guestBubble = Array.from(
      root.querySelectorAll('.seat-card-top .seat-chat-bubble'),
    ).find((el) => el.textContent === 'お手柔らかに！');
    expect(guestBubble).not.toBeNull();
    expect(guestBubble!.classList.contains('is-bubble-enter')).toBe(true);

    // 同じ吹き出しの再描画時（例: チャットを開いて未読クリアで再render）は再アニメしない
    root.querySelector<HTMLButtonElement>('.table-chrome-chat')!.click();
    const guestBubbleAfter = Array.from(
      root.querySelectorAll('.seat-card-top .seat-chat-bubble'),
    ).find((el) => el.textContent === 'お手柔らかに！');
    expect(guestBubbleAfter).not.toBeNull();
    expect(guestBubbleAfter!.classList.contains('is-bubble-enter')).toBe(false);

    // 約4.2秒経過すると吹き出しが自動で消える
    await vi.advanceTimersByTimeAsync(4300);
    expect(root.querySelectorAll('.seat-card-top .seat-chat-bubble')).toHaveLength(
      0,
    );
  });

  it('開始前の待機ルームでもチャットでき、メッセージ受信時は画面上部に一定時間表示される', async () => {
    vi.useFakeTimers();
    localStorage.clear();
    fakePeerRegistry.clear();

    bootApp();
    await loadMain();

    const root = document.getElementById('app') as HTMLElement;
    expect(clickByText(root, 'button', '部屋を作成')).toBe(true);
    await vi.advanceTimersByTimeAsync(20);

    // ロビー画面にチャットボタンがある
    const lobbyChatBtn = root.querySelector<HTMLButtonElement>(
      '.waiting-room-chat-btn',
    );
    expect(lobbyChatBtn).not.toBeNull();

    const roomCode = root
      .querySelector('.room-code-value')!
      .textContent!.trim();
    const { roomCodeToPeerId } = await import('../../net/protocol');
    const hostPeer = fakePeerRegistry.get(roomCodeToPeerId(roomCode));

    const connHandlers: Record<string, Array<(...args: unknown[]) => void>> = {};
    const remoteConn = {
      peer: 'remote-lobby-1',
      open: true,
      on(ev: string, cb: (...args: unknown[]) => void) {
        connHandlers[ev] = connHandlers[ev] ?? [];
        connHandlers[ev]!.push(cb);
      },
      send() {},
      close() {},
    };
    hostPeer!.emit('connection', remoteConn);
    connHandlers.open?.forEach((cb) => cb());
    connHandlers.data?.forEach((cb) =>
      cb({ kind: 'JOIN', playerName: '待機さん' }),
    );

    // 待機室で相手がメッセージを送ると画面上部に一定時間トースト表示＆未読バッジが出る
    connHandlers.data?.forEach((cb) =>
      cb({ kind: 'CHAT', text: '少し待っててね！' }),
    );
    const toast = root.querySelector<HTMLButtonElement>(
      '.lobby-chat-toast-layer .lobby-chat-toast',
    );
    expect(toast).not.toBeNull();
    expect(toast!.textContent).toContain('待機さん');
    expect(toast!.textContent).toContain('少し待っててね！');
    expect(
      root.querySelector('.waiting-room-chat-btn .chat-unread-badge')?.textContent,
    ).toBe('1');

    // 一定時間（約4.2秒）後に上部の通知が自動で消える
    await vi.advanceTimersByTimeAsync(4300);
    expect(root.querySelector('.lobby-chat-toast')).toBeNull();

    // トーストをクリックすると未読が消えてチャットが開くことも確認
    connHandlers.data?.forEach((cb) =>
      cb({ kind: 'CHAT', text: '準備OK！' }),
    );
    const toast2 = root.querySelector<HTMLButtonElement>(
      '.lobby-chat-toast-layer .lobby-chat-toast',
    );
    expect(toast2).not.toBeNull();
    toast2!.click();
    expect(root.querySelector('.table-chat-modal')).not.toBeNull();
    expect(root.querySelector('.waiting-room-chat-btn .chat-unread-badge')).toBeNull();

    // チャットを開いたまま送信もでき、送信内容が履歴と上部トーストに反映される
    const input = root.querySelector<HTMLInputElement>('.chat-input')!;
    input.value = '大丈夫だよ〜';
    input.dispatchEvent(new Event('input'));
    root
      .querySelector<HTMLFormElement>('.chat-input-row')!
      .dispatchEvent(new Event('submit', { cancelable: true }));

    const listText = root.querySelector('.chat-messages-list')?.textContent ?? '';
    expect(listText).toContain('少し待っててね！');
    expect(listText).toContain('準備OK！');
    expect(listText).toContain('大丈夫だよ〜');
    // 自分が送った時も上部トーストが一時表示される
    expect(root.querySelector('.lobby-chat-toast')?.textContent).toContain(
      '大丈夫だよ〜',
    );
  });

  it('設定モーダルで3D麻雀卓表示ON/OFFと3D視点アングルを切り替え・保存できる', async () => {
    localStorage.clear();

    bootApp();
    await loadMain();

    const root = document.getElementById('app') as HTMLElement;
    expect(clickByText(root, 'button', 'CPU対局をはじめる')).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 40));

    root.querySelector<HTMLButtonElement>('.table-chrome-settings')!.click();
    const panel = root.querySelector<HTMLElement>('.table-settings-panel');
    expect(panel).not.toBeNull();

    const toggle3d = panel!.querySelector<HTMLButtonElement>(
      'button[aria-label="3D 麻雀卓"]',
    )!;
    expect(toggle3d).not.toBeNull();
    expect(toggle3d.getAttribute('aria-checked')).toBe('true');

    // 視点アングルボタンが表示されていること
    expect(clickByText(panel!, 'button', '見下ろし')).toBe(true);
    expect(localStorage.getItem('mahjong_3d_camera_preset')).toBe('high');
    expect(
      root
        .querySelector('.table-settings-panel .setting-camera-btn.is-active')
        ?.textContent?.trim(),
    ).toBe('見下ろし');

    // 3D OFF へ切り替え
    root
      .querySelector<HTMLButtonElement>('.table-settings-panel button[aria-label="3D 麻雀卓"]')!
      .click();
    expect(localStorage.getItem('mahjong_3d_table_enabled')).toBe('0');
    expect(
      root
        .querySelector<HTMLButtonElement>('.table-settings-panel button[aria-label="3D 麻雀卓"]')!
        .getAttribute('aria-checked'),
    ).toBe('false');
    // OFF の間は視点アングル行は隠れる
    expect(root.querySelector('.setting-camera-row')).toBeNull();

    // 再び ON に戻す
    root
      .querySelector<HTMLButtonElement>('.table-settings-panel button[aria-label="3D 麻雀卓"]')!
      .click();
    expect(localStorage.getItem('mahjong_3d_table_enabled')).toBe('1');
    expect(root.querySelector('.setting-camera-row')).not.toBeNull();
  });

  it('3Dモードで5巡以上連続打牌してもWebGL2コンテキストやcanvasを再作成せずホーム画面にも戻らず、退出時にloseContextで解放する', async () => {
    localStorage.clear();

    let webglCreateCount = 0;
    let webglLoseCount = 0;
    const noop = () => {};
    const glProxy = new Proxy(
      {
        createShader: () => ({}),
        createProgram: () => ({}),
        createBuffer: () => ({}),
        createVertexArray: () => ({}),
        createTexture: () => ({}),
        getShaderParameter: () => true,
        getProgramParameter: () => true,
        getUniformLocation: () => ({}),
        getAttribLocation: () => 0,
        getParameter: () => 1,
        getExtension: (name: string) =>
          name === 'WEBGL_lose_context'
            ? { loseContext: () => webglLoseCount++ }
            : null,
      } as Record<string | symbol, unknown>,
      {
        get(target, prop) {
          if (prop in target) return target[prop];
          if (typeof prop === 'string' && prop === prop.toUpperCase()) return 1;
          return noop;
        },
      },
    ) as unknown as WebGL2RenderingContext;

    const grad = { addColorStop: noop };
    const ctx2d = new Proxy(
      {
        measureText: () => ({ width: 20 }),
        createLinearGradient: () => grad,
        createRadialGradient: () => grad,
      } as Record<string | symbol, unknown>,
      {
        get(target, prop) {
          if (prop in target) return target[prop];
          return noop;
        },
      },
    ) as unknown as CanvasRenderingContext2D;

    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 1);
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
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
    const getCtxSpy = vi
      .spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockImplementation(
        function (this: HTMLCanvasElement, kind: string) {
          if (kind === 'webgl2') {
            webglCreateCount++;
            return glProxy;
          }
          if (kind === '2d') return ctx2d;
          return null;
        } as unknown as HTMLCanvasElement['getContext'],
      );

    try {
      bootApp();
      await loadMain();

      const root = document.getElementById('app') as HTMLElement;
      expect(clickByText(root, 'button', 'CPU対局をはじめる')).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 40));

      const initialFelt = root.querySelector('.table-felt.is-3d-table');
      const initialCanvas = root.querySelector<HTMLCanvasElement>('.table-3d-canvas');
      expect(initialFelt).not.toBeNull();
      expect(initialCanvas).not.toBeNull();
      expect(webglCreateCount).toBe(1);
      expect(webglLoseCount).toBe(0);

      let discardsDone = 0;
      for (let step = 0; step < 650 && discardsDone < 5; step++) {
        await new Promise((resolve) => setTimeout(resolve, 30));

        // 強制的にホーム画面に戻っていないことを毎フレーム確認
        expect(root.querySelector('.lobby-wrap')).toBeNull();
        expect(webglCreateCount).toBe(1);
        expect(webglLoseCount).toBe(0);

        if (root.querySelector('.round-end-modal')) {
          clickByText(root, '.round-end-modal button', '次へ');
          clickByText(root, '.round-end-modal button', '次の局へ');
          continue;
        }

        const felt = root.querySelector('.table-felt.is-3d-table');
        if (felt) {
          expect(root.querySelector('.table-3d-canvas')).toBe(initialCanvas);
        }

        clickByText(root, '.call-action-bar button', 'スルー');
        const clickable = root.querySelectorAll<HTMLElement>(
          '.seat-self .hand-area .mj-tile-clickable',
        );
        if (clickable.length > 0) {
          const beforeRiver = root.querySelectorAll('.seat-self .discard-river .mj-tile').length;
          const tile = clickable[clickable.length - 1]!;
          tile.click();
          tile.click();
          const afterRiver = root.querySelectorAll('.seat-self .discard-river .mj-tile').length;
          if (afterRiver > beforeRiver) {
            discardsDone++;
          } else {
            // 非同期反映が1マイクロタスク遅れた場合に備えて1ティック待機し確認
            await new Promise((resolve) => setTimeout(resolve, 10));
            if (root.querySelectorAll('.seat-self .discard-river .mj-tile').length > beforeRiver) {
              discardsDone++;
            }
          }
        }
      }

      expect(discardsDone).toBeGreaterThanOrEqual(5);
      expect(root.querySelector('.table-3d-canvas')).toBe(initialCanvas);
      expect(webglCreateCount).toBe(1);
      expect(webglLoseCount).toBe(0);

      // 設定モーダルで視点リセットしてもコンテキストが増えない
      root.querySelector<HTMLButtonElement>('.table-chrome-settings')!.click();
      expect(clickByText(root, '.table-settings-panel button', '視点リセット')).toBe(true);
      root.querySelector<HTMLButtonElement>('.table-modal-close-btn')!.click();
      expect(webglCreateCount).toBe(1);

      // 対局を離れてロビーに戻ると WebGL2 コンテキストを確実に解放する
      root.querySelector<HTMLButtonElement>('.table-chrome-leave')!.click();
      expect(clickByText(root, '.leave-confirm-modal button', 'ロビーに戻る')).toBe(true);
      expect(root.querySelector('.lobby-wrap')).not.toBeNull();
      expect(root.querySelector('.table-stage')).toBeNull();
      expect(webglCreateCount).toBe(1);
      expect(webglLoseCount).toBe(1);
    } finally {
      getCtxSpy.mockRestore();
      vi.restoreAllMocks();
    }
  }, 40000);

  it('ホスト移譲(onHostSelfDemoted)後に旧HostSessionが遅延でonStatusChange("closed")を呼んでも新ClientSessionの接続状態が未接続に上書きされない', async () => {
    vi.resetModules();
    const { createInitialGameState, reduce } = await import('../../engine/reducer');
    const { toStateView } = await import('../../engine/projection');
    let lobbyState = createInitialGameState({
      roomCode: 'DEMO01',
      hostPlayerId: 'p0',
      hostName: '旧ホスト',
      ruleConfig: { playerCount: 4, gameLength: 'tonpuu' },
    });
    lobbyState = reduce(lobbyState, {
      type: 'JOIN_PLAYER',
      playerId: 'p1',
      name: '次期ホスト',
    });
    const lobbyView = toStateView(lobbyState, 'p0', 0);

    let capturedHostCallbacks: Record<string, (...args: any[]) => void> | null = null;
    let clientStatusTextObserved = false;

    vi.doMock('../../net/host', () => {
      class MockHostSession {
        private readonly cb: Record<string, (...args: any[]) => void>;
        constructor(
          _name: string,
          _rule: unknown,
          callbacks: Record<string, (...args: any[]) => void>,
        ) {
          this.cb = callbacks;
          capturedHostCallbacks = callbacks;
        }
        start() {
          this.cb.onStatusChange?.('ready');
          this.cb.onViewChange?.(lobbyView);
        }
        getRoomCode() {
          return 'DEMO01';
        }
        isOffline() {
          return false;
        }
        getConnectedRemoteHumanIds() {
          return ['p1'];
        }
        transferHost() {
          this.cb.onHostSelfDemoted?.(
            { roomCode: 'DEMO01', hostEpoch: 1, newHostPeerId: 'peer-p1' },
            'tok-p0',
            'p0',
          );
          setTimeout(() => {
            this.cb.onStatusChange?.('closed');
            this.cb.onStatusChange?.('error', '旧ホストの遅延エラー');
          }, 20);
          return true;
        }
        destroy() {}
      }
      return { HostSession: MockHostSession };
    });

    vi.doMock('../../net/client', () => {
      class MockClientSession {
        private readonly cb: Record<string, (...args: any[]) => void>;
        constructor(
          _roomCode: string,
          _name: string,
          callbacks: Record<string, (...args: any[]) => void>,
        ) {
          this.cb = callbacks;
        }
        connect() {
          this.cb.onStatusChange?.('connected');
          clientStatusTextObserved = true;
        }
        destroy() {}
      }
      return { ClientSession: MockClientSession };
    });

    try {
      document.body.innerHTML = '<div id="app"></div>';
      await loadMain();
      const root = document.getElementById('app') as HTMLElement;

      expect(clickByText(root, 'button', '部屋を作成')).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(capturedHostCallbacks).not.toBeNull();

      // ホスト移譲を実行（内部で新 ClientSession に移行し、20ms 後に旧ホストが 'closed' / 'error' を発火する）
      expect(clickByText(root, 'button', 'ホストを譲る')).toBe(true);
      expect(clientStatusTextObserved).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 60));

      expect(root.querySelector('.error-banner')).toBeNull();
      expect(root.querySelector('.lobby-settings-panel')).not.toBeNull();
      expect(root.querySelector('.status-pill')).toBeNull();
    } finally {
      window.dispatchEvent(new Event('beforeunload'));
      vi.doUnmock('../../net/host');
      vi.doUnmock('../../net/client');
      vi.resetModules();
    }
  });

  it('対局中に離脱確認モーダルを開いた状態でロビーへ戻されたあと、次の対局開始時にモーダルが誤表示されない', async () => {
    vi.resetModules();
    const { createInitialGameState, reduce } = await import('../../engine/reducer');
    const { deriveRules } = await import('../../engine/rules');
    const { toStateView } = await import('../../engine/projection');
    const { buildSeededTestDeck } = await import('../../engine/__tests__/testHelpers');

    const ruleConfig = { playerCount: 4 as const, gameLength: 'tonpuu' as const };
    const rules = deriveRules(ruleConfig);
    let lobbyState = createInitialGameState({
      roomCode: 'GAME01',
      hostPlayerId: 'p0',
      hostName: 'P0',
      ruleConfig,
    });
    for (let i = 1; i < 4; i++) {
      lobbyState = reduce(lobbyState, {
        type: 'JOIN_PLAYER',
        playerId: `p${i}`,
        name: `P${i}`,
      });
    }
    const lobbyView = toStateView(lobbyState, 'p0', 0);
    const playingState = reduce(lobbyState, {
      type: 'START_GAME',
      shuffledDeck: buildSeededTestDeck(rules, 9999),
    });
    const playingView = toStateView(playingState, 'p0', 0);

    let emitView: ((view: typeof playingView) => void) | null = null;

    vi.doMock('../../net/host', () => {
      class MockHostSession {
        private readonly cb: Record<string, (...args: any[]) => void>;
        constructor(
          _name: string,
          _rule: unknown,
          callbacks: Record<string, (...args: any[]) => void>,
        ) {
          this.cb = callbacks;
          emitView = (v) => this.cb.onViewChange?.(v);
        }
        start() {
          this.cb.onStatusChange?.('ready');
          this.cb.onViewChange?.(playingView);
        }
        getRoomCode() {
          return 'GAME01';
        }
        isOffline() {
          return true;
        }
        getConnectedRemoteHumanIds() {
          return [];
        }
        destroy() {}
      }
      return { HostSession: MockHostSession };
    });

    try {
      document.body.innerHTML = '<div id="app"></div>';
      await loadMain();
      const root = document.getElementById('app') as HTMLElement;

      expect(clickByText(root, 'button', 'CPU対局をはじめる')).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 10));

      // 離脱ボタンを開いた状態で残す
      root.querySelector<HTMLButtonElement>('.table-chrome-leave')!.click();
      expect(root.querySelector('.leave-confirm-modal')).not.toBeNull();

      // ロビー状態へ遷移し、続いて再び対局開始する
      emitView!(lobbyView);
      expect(root.querySelector('.table-stage')).toBeNull();
      expect(root.querySelector('.lobby-settings-panel')).not.toBeNull();

      emitView!(playingView);
      expect(root.querySelector('.table-stage')).not.toBeNull();
      expect(root.querySelector('.leave-confirm-modal')).toBeNull();
    } finally {
      window.dispatchEvent(new Event('beforeunload'));
      vi.doUnmock('../../net/host');
      vi.resetModules();
    }
  });

  it('ホーム画面や待機ロビー（試合以外のページ）の右上に設定ボタンが表示され、開いて設定変更できる', async () => {
    bootApp();
    await loadMain();

    const root = document.getElementById('app') as HTMLElement;
    expect(root.querySelector('.top-bar .status-pill')).toBeNull();
    expect(root.querySelector('.top-bar .rotate-hint')).toBeNull();
    expect(root.querySelectorAll('.top-bar .top-bar-right > *')).toHaveLength(1);
    const homeSettingsBtn = root.querySelector<HTMLButtonElement>(
      '.top-bar .top-bar-right .top-bar-settings-btn',
    );
    expect(homeSettingsBtn).not.toBeNull();
    expect(homeSettingsBtn!.textContent).toContain('設定');

    // ホーム画面のまま右上設定ボタンからモーダルを開ける（試合外では視点リセットは出ない）
    homeSettingsBtn!.click();
    const homeModal = document.querySelector('.table-settings-modal');
    expect(homeModal).not.toBeNull();
    expect(homeModal!.querySelector('button[aria-label="効果音"]')).not.toBeNull();
    expect(homeModal!.querySelector('button[aria-label="3D 麻雀卓"]')).not.toBeNull();
    expect(homeModal!.querySelector('.setting-camera-reset-btn')).toBeNull();

    // 3D表示をOFFに切り替えて閉じる
    const toggle3d = homeModal!.querySelector<HTMLButtonElement>(
      'button[aria-label="3D 麻雀卓"]',
    )!;
    expect(toggle3d.getAttribute('aria-checked')).toBe('true');
    toggle3d.click();
    expect(
      document
        .querySelector('.table-settings-modal button[aria-label="3D 麻雀卓"]')!
        .getAttribute('aria-checked'),
    ).toBe('false');
    expect(clickByText(document.body, '.table-settings-modal button', '閉じる')).toBe(
      true,
    );
    expect(document.querySelector('.table-settings-modal')).toBeNull();

    // 「部屋を作成」で待機ロビーに遷移しても右上の設定ボタンからモーダルを開ける
    expect(clickByText(root, 'button', '部屋を作成')).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(root.querySelector('.lobby-settings-panel')).not.toBeNull();
    expect(root.querySelector('.top-bar .status-pill')).toBeNull();
    expect(root.querySelector('.top-bar .rotate-hint')).toBeNull();
    expect(root.querySelectorAll('.top-bar .top-bar-right > *')).toHaveLength(1);
    const lobbySettingsBtn = root.querySelector<HTMLButtonElement>(
      '.top-bar .top-bar-right .top-bar-settings-btn',
    );
    expect(lobbySettingsBtn).not.toBeNull();
    lobbySettingsBtn!.click();
    const lobbyModal = document.querySelector('.table-settings-modal');
    expect(lobbyModal).not.toBeNull();

    // 3D表示を再びONに戻しておく
    lobbyModal!
      .querySelector<HTMLButtonElement>('button[aria-label="3D 麻雀卓"]')!
      .click();
    expect(
      document
        .querySelector('.table-settings-modal button[aria-label="3D 麻雀卓"]')!
        .getAttribute('aria-checked'),
    ).toBe('true');
  });

  it('作成後の待機ロビーの詳細設定で赤ドラ・切り上げ満貫・初期点等を変更して開始でき、//cheat で裏設定画面が開き /peek・/luck コマンドは廃止されている', async () => {
    localStorage.clear();

    bootApp();
    await loadMain();

    const root = document.getElementById('app') as HTMLElement;

    // 部屋作成前の入口画面には詳細設定ボタンを出さない
    expect(root.querySelector('.lobby-advanced-details')).toBeNull();

    // 部屋を作成して待機ロビーへ入り、詳細設定から初期持ち点50000・赤ドラ全5・切り上げ満貫などを設定してCPU対局を開始
    expect(clickByText(root, 'button', '部屋を作成')).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(root.querySelector('.lobby-advanced-details')).not.toBeNull();
    const setAdv = (key: string, val: string) => {
      const sel = root.querySelector<HTMLSelectElement>(
        `select[data-adv-setting="${key}"]`,
      )!;
      expect(sel).not.toBeNull();
      sel.value = val;
      sel.dispatchEvent(new Event('change'));
    };
    setAdv('adv-red-dora', '4');
    setAdv('adv-kiriage-mangan', 'true');
    setAdv('adv-kazoe-yakuman', 'false');
    setAdv('adv-double-wind-fu', '2');
    setAdv('initialPoints', '50000');
    setAdv('notenPenaltyTotal', '0');
    setAdv('adv-response-timeout', '0');
    setAdv('adv-max-kans', '8');

    for (let i = 0; i < 3; i++) {
      expect(clickByText(root, 'button', 'CPU を追加')).toBe(true);
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
    root.querySelector<HTMLButtonElement>('.lobby-start-btn')!.click();
    await new Promise((resolve) => setTimeout(resolve, 40));

    // 持ち点50,000点が反映されている
    const scoreVals = Array.from(
      root.querySelectorAll<HTMLElement>('.console-score-val'),
    ).map((n) => n.textContent?.trim());
    expect(scoreVals).toEqual(['50000', '50000', '50000', '50000']);

    const submitViaChat = (text: string) => {
      if (!root.querySelector('.table-chat-modal')) {
        root.querySelector<HTMLButtonElement>('.table-chrome-chat')!.click();
      }
      const modal = root.querySelector<HTMLElement>('.table-chat-modal')!;
      expect(modal).not.toBeNull();
      expect(modal.querySelector('.chat-help-btn')).toBeNull();
      expect(modal.querySelector('.chat-cmd-suggestions')).toBeNull();
      // チャットモーダルに //cheat のヒント文言を出さない
      expect(modal.textContent).not.toContain('//cheat');
      const input = modal.querySelector<HTMLInputElement>('.chat-input')!;
      const form = modal.querySelector<HTMLFormElement>('.chat-input-row')!;
      input.value = text;
      input.dispatchEvent(new Event('input'));
      form.dispatchEvent(new Event('submit', { cancelable: true }));
    };

    // 廃止された /peek on・/luck god・/red on・通常発言はコマンド実行されず、そのまま通常チャットとして送信される
    submitViaChat('/peek on');
    expect(root.querySelector('.table-cheat-modal')).toBeNull();
    expect(root.querySelectorAll('.opponent-hand.is-revealed')).toHaveLength(0);

    submitViaChat('/luck god');
    expect(root.querySelector('.table-cheat-modal')).toBeNull();

    submitViaChat('/red on');
    submitViaChat('よろしく！');
    {
      const modal = root.querySelector<HTMLElement>('.table-chat-modal')!;
      const items = Array.from(modal.querySelectorAll('.chat-message-item')).map(
        (el) => el.textContent ?? '',
      );
      expect(items.some((t) => t.includes('/peek on'))).toBe(true);
      expect(items.some((t) => t.includes('/luck god'))).toBe(true);
      expect(items.some((t) => t.includes('/red on'))).toBe(true);
      expect(items.some((t) => t.includes('よろしく！'))).toBe(true);
      modal.querySelector<HTMLButtonElement>('.table-modal-close-btn')!.click();
    }

    // //cheat を送信するとチャット履歴には残らず、裏設定モーダルが開く
    submitViaChat('//cheat');
    expect(root.querySelector('.table-chat-modal')).toBeNull();
    let cheatModal = root.querySelector<HTMLElement>('.table-cheat-modal')!;
    expect(cheatModal).not.toBeNull();

    // 相手手牌の透視スイッチを ON にすると相手3人の手牌が即座に公開表示される
    // またスクロール途中位置を設定していても、Peek・Luck・全員通常など各種設定変更で一番上に戻らない
    const cheatPanel = cheatModal.querySelector<HTMLElement>('.table-cheat-panel')!;
    cheatPanel.scrollTop = 180;

    const peekSwitch = cheatModal.querySelector<HTMLButtonElement>(
      'button[aria-label="相手手牌の透視"]',
    )!;
    expect(peekSwitch.getAttribute('aria-checked')).toBe('false');
    peekSwitch.click();
    expect(cheatModal.querySelector('.table-cheat-panel')).toBe(cheatPanel);
    expect(cheatPanel.scrollTop).toBe(180);
    const revealedHands = root.querySelectorAll('.opponent-hand.is-revealed');
    expect(revealedHands).toHaveLength(3);
    for (const el of Array.from(revealedHands)) {
      const count = el.querySelectorAll('.mj-tile:not(.mj-tile-back)').length;
      expect(count).toBeGreaterThanOrEqual(13);
      expect(count).toBeLessThanOrEqual(14);
    }

    // プレイヤー別の配牌・ツモ運行が4人分表示されており、自分(豪運)と他プレイヤー/CPU(好運)を個別に設定できる
    cheatModal = root.querySelector<HTMLElement>('.table-cheat-modal')!;
    const playerRows = Array.from(
      cheatModal.querySelectorAll<HTMLElement>('.cheat-luck-player-row'),
    );
    expect(playerRows).toHaveLength(4);
    const selfPlayerId = playerRows[0]!.dataset.cheatPlayerId!;
    const otherPlayerId = playerRows[1]!.dataset.cheatPlayerId!;

    cheatModal
      .querySelector<HTMLButtonElement>(
        `button[data-luck-mode="god"][data-target-player-id="${selfPlayerId}"]`,
      )!
      .click();
    expect(cheatPanel.scrollTop).toBe(180);
    root
      .querySelector<HTMLButtonElement>(
        `.table-cheat-modal button[data-luck-mode="good"][data-target-player-id="${otherPlayerId}"]`,
      )!
      .click();
    expect(cheatPanel.scrollTop).toBe(180);
    expect(root.querySelector('.table-cheat-panel')).toBe(cheatPanel);

    expect(
      root
        .querySelector(
          `.table-cheat-modal button[data-luck-mode="god"][data-target-player-id="${selfPlayerId}"]`,
        )!
        .classList.contains('is-active'),
    ).toBe(true);
    expect(
      root
        .querySelector(
          `.table-cheat-modal button[data-luck-mode="good"][data-target-player-id="${otherPlayerId}"]`,
        )!
        .classList.contains('is-active'),
    ).toBe(true);

    root
      .querySelector<HTMLButtonElement>('.table-cheat-modal .table-modal-close-btn')!
      .click();
    expect(root.querySelector('.table-cheat-modal')).toBeNull();

    // もう一度チャットから //cheat で開くと ON / 自分豪運 / 他プレイヤー好運 の設定が保持されており、
    // 「全員通常」で一括リセットできること・透視OFFで解除されることも確認する
    submitViaChat('//cheat');
    cheatModal = root.querySelector<HTMLElement>('.table-cheat-modal')!;
    const reopenedCheatPanel =
      cheatModal.querySelector<HTMLElement>('.table-cheat-panel')!;
    reopenedCheatPanel.scrollTop = 160;
    expect(cheatModal).not.toBeNull();
    expect(
      cheatModal
        .querySelector<HTMLButtonElement>('button[aria-label="相手手牌の透視"]')!
        .getAttribute('aria-checked'),
    ).toBe('true');
    expect(
      cheatModal
        .querySelector<HTMLButtonElement>(
          `button[data-luck-mode="god"][data-target-player-id="${selfPlayerId}"]`,
        )!
        .classList.contains('is-active'),
    ).toBe(true);
    expect(
      cheatModal
        .querySelector<HTMLButtonElement>(
          `button[data-luck-mode="good"][data-target-player-id="${otherPlayerId}"]`,
        )!
        .classList.contains('is-active'),
    ).toBe(true);

    cheatModal
      .querySelector<HTMLButtonElement>('.cheat-luck-reset-btn')!
      .click();
    expect(reopenedCheatPanel.scrollTop).toBe(160);
    expect(
      root
        .querySelector(
          `.table-cheat-modal button[data-luck-mode="normal"][data-target-player-id="${selfPlayerId}"]`,
        )!
        .classList.contains('is-active'),
    ).toBe(true);
    expect(
      root
        .querySelector(
          `.table-cheat-modal button[data-luck-mode="normal"][data-target-player-id="${otherPlayerId}"]`,
        )!
        .classList.contains('is-active'),
    ).toBe(true);

    root
      .querySelector<HTMLButtonElement>(
        '.table-cheat-modal button[aria-label="相手手牌の透視"]',
      )!
      .click();
    expect(reopenedCheatPanel.scrollTop).toBe(160);
    expect(root.querySelectorAll('.opponent-hand.is-revealed')).toHaveLength(0);

    // インプレース更新後も同一ボタンを再度クリックすれば再び ON に戻せる
    root
      .querySelector<HTMLButtonElement>(
        '.table-cheat-modal button[aria-label="相手手牌の透視"]',
      )!
      .click();
    expect(reopenedCheatPanel.scrollTop).toBe(160);
    expect(root.querySelectorAll('.opponent-hand.is-revealed')).toHaveLength(3);
    root
      .querySelector<HTMLButtonElement>(
        '.table-cheat-modal button[aria-label="相手手牌の透視"]',
      )!
      .click();
    expect(root.querySelectorAll('.opponent-hand.is-revealed')).toHaveLength(0);

    // チャット履歴に //cheat 文字列が残っていないことも確認する
    root
      .querySelector<HTMLButtonElement>('.table-cheat-modal .table-modal-close-btn')!
      .click();
    root.querySelector<HTMLButtonElement>('.table-chrome-chat')!.click();
    const chatText =
      root.querySelector<HTMLElement>('.table-chat-modal .chat-messages-list')!
        .textContent ?? '';
    expect(chatText).not.toContain('//cheat');
  });

  it('オンライン参加クライアント(ClientSession)および待機ロビーでも //cheat で裏設定画面から自他の Peek/Luck を設定・同期でき、観戦時は無効化される', async () => {
    vi.resetModules();
    const { createInitialGameState, reduce } = await import('../../engine/reducer');
    const { deriveRules } = await import('../../engine/rules');
    const { toStateView } = await import('../../engine/projection');
    const { buildSeededTestDeck } = await import('../../engine/__tests__/testHelpers');

    const ruleConfig = { playerCount: 4 as const, gameLength: 'tonpuu' as const };
    const rules = deriveRules(ruleConfig);
    let lobbyState = createInitialGameState({
      roomCode: 'NET001',
      hostPlayerId: 'p0',
      hostName: 'ホスト',
      ruleConfig,
    });
    for (let i = 1; i < 4; i++) {
      lobbyState = reduce(lobbyState, {
        type: 'JOIN_PLAYER',
        playerId: `p${i}`,
        name: `P${i}`,
      });
    }
    const lobbyGuestView = toStateView(lobbyState, 'p1', 0);
    const playingState = reduce(lobbyState, {
      type: 'START_GAME',
      shuffledDeck: buildSeededTestDeck(rules, 777),
    });
    const playingGuestView = toStateView(playingState, 'p1', 0);
    const playingWithSpectator = {
      ...playingState,
      spectators: [
        { spectatorId: 'spec-1', name: '観戦者', joinedAt: 1, connected: true },
      ],
    };
    const playingSpectatorView = toStateView(playingWithSpectator, 'spec-1', 0);

    const secretCalls: Array<Record<string, unknown>> = [];
    let emitClientView: ((v: typeof lobbyGuestView) => void) | null = null;
    let emitSecretState:
      | ((s: { peek: boolean; luckByPlayer: Record<string, string> }) => void)
      | null = null;

    vi.doMock('../../net/client', () => {
      class MockClientSession {
        private readonly cb: Record<string, (...args: any[]) => void>;
        constructor(
          _roomCode: string,
          _name: string,
          callbacks: Record<string, (...args: any[]) => void>,
        ) {
          this.cb = callbacks;
          emitClientView = (v) => this.cb.onViewChange?.(v);
          emitSecretState = (s) => this.cb.onSecretState?.(s);
        }
        connect() {
          this.cb.onStatusChange?.('connected');
          this.cb.onViewChange?.(lobbyGuestView);
        }
        sendChat() {
          return true;
        }
        setSecretOption(opts: Record<string, unknown>) {
          secretCalls.push(opts);
          return true;
        }
        destroy() {}
      }
      return { ClientSession: MockClientSession };
    });

    try {
      document.body.innerHTML = '<div id="app"></div>';
      await loadMain();
      const root = document.getElementById('app') as HTMLElement;

      // ルームに参加してゲスト待機ロビーに入る
      const codeInput = root.querySelector<HTMLInputElement>('#room-code-input')!;
      codeInput.value = 'NET001';
      codeInput.dispatchEvent(new Event('input'));
      expect(clickByText(root, 'button', '参加する')).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 10));

      // 待機ロビーのチャットから //cheat で裏設定画面を開き、同期要求と他プレイヤーへの設定ができる
      root.querySelector<HTMLButtonElement>('.waiting-room-chat-btn')!.click();
      let chatModal = root.querySelector<HTMLElement>('.table-chat-modal')!;
      let chatInput = chatModal.querySelector<HTMLInputElement>('.chat-input')!;
      let chatForm = chatModal.querySelector<HTMLFormElement>('.chat-input-row')!;
      chatInput.value = '//cheat';
      chatInput.dispatchEvent(new Event('input'));
      chatForm.dispatchEvent(new Event('submit', { cancelable: true }));

      let cheatModal = root.querySelector<HTMLElement>('.table-cheat-modal')!;
      expect(cheatModal).not.toBeNull();
      expect(secretCalls).toEqual([{ requestSync: true }]);

      // ホストから既存設定（p0 が good）が同期されると表示へ即反映され、スクロール位置も維持される
      const guestCheatPanel =
        cheatModal.querySelector<HTMLElement>('.table-cheat-panel')!;
      guestCheatPanel.scrollTop = 140;
      emitSecretState!({
        peek: false,
        luckByPlayer: { p0: 'good', p1: 'normal', p2: 'normal', p3: 'normal' },
      });
      expect(guestCheatPanel.scrollTop).toBe(140);
      expect(
        root
          .querySelector(
            '.table-cheat-modal button[data-luck-mode="good"][data-target-player-id="p0"]',
          )!
          .classList.contains('is-active'),
      ).toBe(true);

      // 自分(p1)と他プレイヤー(p2)の luck をそれぞれ設定でき、スクロール位置も維持される
      root
        .querySelector<HTMLButtonElement>(
          '.table-cheat-modal button[data-luck-mode="good"][data-target-player-id="p1"]',
        )!
        .click();
      expect(guestCheatPanel.scrollTop).toBe(140);
      root
        .querySelector<HTMLButtonElement>(
          '.table-cheat-modal button[data-luck-mode="god"][data-target-player-id="p2"]',
        )!
        .click();
      expect(guestCheatPanel.scrollTop).toBe(140);
      expect(root.querySelector('.table-cheat-panel')).toBe(guestCheatPanel);
      expect(secretCalls).toEqual([
        { requestSync: true },
        { luck: 'good', luckTargetPlayerId: 'p1' },
        { luck: 'god', luckTargetPlayerId: 'p2' },
      ]);

      // 対局中画面へ遷移後、再度 //cheat を開いて Peek ON + 全員通常リセットを送信できる
      emitClientView!(playingGuestView);
      expect(root.querySelector('.table-cheat-modal')).toBeNull();

      root.querySelector<HTMLButtonElement>('.table-chrome-chat')!.click();
      chatModal = root.querySelector<HTMLElement>('.table-chat-modal')!;
      chatInput = chatModal.querySelector<HTMLInputElement>('.chat-input')!;
      chatForm = chatModal.querySelector<HTMLFormElement>('.chat-input-row')!;
      chatInput.value = '／／cheat';
      chatInput.dispatchEvent(new Event('input'));
      chatForm.dispatchEvent(new Event('submit', { cancelable: true }));

      cheatModal = root.querySelector<HTMLElement>('.table-cheat-modal')!;
      cheatModal
        .querySelector<HTMLButtonElement>('button[aria-label="相手手牌の透視"]')!
        .click();
      root
        .querySelector<HTMLButtonElement>('.table-cheat-modal .cheat-luck-reset-btn')!
        .click();
      expect(secretCalls).toEqual([
        { requestSync: true },
        { luck: 'good', luckTargetPlayerId: 'p1' },
        { luck: 'god', luckTargetPlayerId: 'p2' },
        { requestSync: true },
        { peek: true },
        { clearAllLuck: true },
      ]);

      // 観戦者ビューでは操作ボタンが無効化され、注意メッセージが表示される
      emitClientView!(playingSpectatorView);
      const specCheatModal = root.querySelector<HTMLElement>('.table-cheat-modal')!;
      expect(specCheatModal.querySelector('.cheat-spectator-note')).not.toBeNull();
      expect(
        specCheatModal.querySelector<HTMLButtonElement>(
          'button[aria-label="相手手牌の透視"]',
        )!.disabled,
      ).toBe(true);
      expect(
        specCheatModal.querySelector<HTMLButtonElement>(
          'button[data-luck-mode="god"][data-target-player-id="p2"]',
        )!.disabled,
      ).toBe(true);
    } finally {
      window.dispatchEvent(new Event('beforeunload'));
      vi.doUnmock('../../net/client');
      vi.resetModules();
    }
  });

  it('ホスト/ローカル対局でルール変更・CPU追加・//cheat の履歴を //check モーダルで閲覧でき、通常チャットには残らない', async () => {
    document.body.innerHTML = '<div id="app"></div>';
    await loadMain();
    const root = document.getElementById('app') as HTMLElement;

    expect(clickByText(root, 'button', '部屋を作成')).toBe(true);

    // ルーム作成後の待機ロビーでトビ設定・詳細設定（赤ドラ）・CPU追加を変更
    const tobiSwitch = root.querySelector<HTMLButtonElement>(
      'button[aria-label="トビ終了（0点未満で終局）"]',
    )!;
    tobiSwitch.click();

    const advDetails = root.querySelector<HTMLDetailsElement>(
      '.lobby-advanced-details',
    )!;
    advDetails.open = true;
    const redSelect = root.querySelector<HTMLSelectElement>('#adv-red-dora')!;
    redSelect.value = '4';
    redSelect.dispatchEvent(new Event('change'));

    for (let i = 0; i < 3; i++) {
      root.querySelector<HTMLButtonElement>('.lobby-cpu-add-btn')!.click();
    }
    expect(clickByText(root, 'button', '対局を開始する')).toBe(true);

    // 対局中に //cheat を開いて Peek ON + 自分へ豪運設定
    root.querySelector<HTMLButtonElement>('.table-chrome-chat')!.click();
    let chatModal = root.querySelector<HTMLElement>('.table-chat-modal')!;
    let chatInput = chatModal.querySelector<HTMLInputElement>('.chat-input')!;
    let chatForm = chatModal.querySelector<HTMLFormElement>('.chat-input-row')!;
    chatInput.value = '//cheat';
    chatInput.dispatchEvent(new Event('input'));
    chatForm.dispatchEvent(new Event('submit', { cancelable: true }));

    root
      .querySelector<HTMLButtonElement>(
        '.table-cheat-modal button[aria-label="相手手牌の透視"]',
      )!
      .click();
    root
      .querySelector<HTMLButtonElement>(
        '.table-cheat-modal button[data-luck-mode="god"]',
      )!
      .click();
    root
      .querySelector<HTMLButtonElement>('.table-cheat-modal .table-modal-close-btn')!
      .click();

    // チャットから //check を入力すると履歴チェックモーダルが開く
    root.querySelector<HTMLButtonElement>('.table-chrome-chat')!.click();
    chatModal = root.querySelector<HTMLElement>('.table-chat-modal')!;
    chatInput = chatModal.querySelector<HTMLInputElement>('.chat-input')!;
    chatForm = chatModal.querySelector<HTMLFormElement>('.chat-input-row')!;
    chatInput.value = '//check';
    chatInput.dispatchEvent(new Event('input'));
    chatForm.dispatchEvent(new Event('submit', { cancelable: true }));

    const checkModal = root.querySelector<HTMLElement>('.table-check-modal')!;
    expect(checkModal).not.toBeNull();
    expect(root.querySelector('.table-chat-modal')).toBeNull();
    expect(root.querySelector('.table-cheat-modal')).toBeNull();

    const items = Array.from(
      checkModal.querySelectorAll<HTMLElement>('.check-history-item'),
    );
    expect(items.length).toBeGreaterThanOrEqual(7);
    const allText = checkModal.textContent ?? '';
    expect(allText).toContain('ルール設定「トビ終了」');
    expect(allText).toContain('ルール設定「赤ドラ」');
    expect(allText).toContain('CPUの追加');
    expect(allText).toContain('相手手牌の透視（Peek）');
    expect(allText).toContain('配牌・ツモ運（Luck）');
    expect(allText).toContain('全5赤');
    expect(allText).toContain('豪運');

    // 種別フィルタで //cheat のみ・設定のみを切り替えられる
    checkModal
      .querySelector<HTMLButtonElement>('button[data-check-category-filter="cheat"]')!
      .click();
    const cheatOnlyItems = checkModal.querySelectorAll('.check-history-item');
    expect(cheatOnlyItems.length).toBe(2);

    checkModal
      .querySelector<HTMLButtonElement>('button[data-check-category-filter="settings"]')!
      .click();
    const settingsOnlyItems = checkModal.querySelectorAll('.check-history-item');
    expect(settingsOnlyItems.length).toBe(items.length - 2);

    // 閉じても通常チャット履歴に //check が残っていないことを確認
    checkModal
      .querySelector<HTMLButtonElement>('.table-modal-close-btn')!
      .click();
    expect(root.querySelector('.table-check-modal')).toBeNull();

    root.querySelector<HTMLButtonElement>('.table-chrome-chat')!.click();
    const chatText =
      root.querySelector<HTMLElement>('.table-chat-modal .chat-messages-list')!
        .textContent ?? '';
    expect(chatText).not.toContain('//check');
    expect(chatText).not.toContain('//cheat');
  });

  it('オンライン参加クライアントで //check により他プレイヤーの変更履歴確認・他プレイヤーフィルタ・リアルタイム更新時のスクロール保持・watch解除・観戦閲覧ができる', async () => {
    vi.resetModules();
    const { createInitialGameState, reduce } = await import('../../engine/reducer');
    const { deriveRules } = await import('../../engine/rules');
    const { toStateView } = await import('../../engine/projection');
    const { buildSeededTestDeck } = await import('../../engine/__tests__/testHelpers');

    const ruleConfig = { playerCount: 4 as const, gameLength: 'tonpuu' as const };
    const rules = deriveRules(ruleConfig);
    let lobbyState = createInitialGameState({
      roomCode: 'CHK001',
      hostPlayerId: 'p0',
      hostName: 'ホスト',
      ruleConfig,
    });
    for (let i = 1; i < 4; i++) {
      lobbyState = reduce(lobbyState, {
        type: 'JOIN_PLAYER',
        playerId: `p${i}`,
        name: `P${i}`,
      });
    }
    const playingState = reduce(lobbyState, {
      type: 'START_GAME',
      shuffledDeck: buildSeededTestDeck(rules, 888),
    });
    const playingGuestView = toStateView(playingState, 'p1', 0);
    const playingSpectatorView = toStateView(
      {
        ...playingState,
        spectators: [
          { spectatorId: 'spec-1', name: '観戦者', connected: true },
        ],
      },
      'spec-1',
      0,
    );

    const watchCalls: Array<boolean | undefined> = [];
    let emitClientView: ((v: typeof playingGuestView) => void) | null = null;
    let emitChangeHistory:
      | ((h: import('../../types/message').ChangeHistoryEntry[]) => void)
      | null = null;

    vi.doMock('../../net/client', () => {
      class MockClientSession {
        private readonly cb: Record<string, (...args: any[]) => void>;
        constructor(
          _roomCode: string,
          _name: string,
          callbacks: Record<string, (...args: any[]) => void>,
        ) {
          this.cb = callbacks;
          emitClientView = (v) => this.cb.onViewChange?.(v);
          emitChangeHistory = (h) => this.cb.onChangeHistory?.(h);
        }
        connect() {
          this.cb.onStatusChange?.('connected');
          this.cb.onViewChange?.(playingGuestView);
        }
        sendChat() {
          return true;
        }
        setSecretOption() {}
        requestChangeHistory(watch?: boolean) {
          watchCalls.push(watch);
        }
        destroy() {}
      }
      return { ClientSession: MockClientSession };
    });

    try {
      document.body.innerHTML = '<div id="app"></div>';
      await loadMain();
      const root = document.getElementById('app') as HTMLElement;

      const codeInput = root.querySelector<HTMLInputElement>('#room-code-input')!;
      codeInput.value = 'CHK001';
      codeInput.dispatchEvent(new Event('input'));
      expect(clickByText(root, 'button', '参加する')).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 10));

      // 全角スラッシュ混在 ／／check でも開ける
      root.querySelector<HTMLButtonElement>('.table-chrome-chat')!.click();
      let chatModal = root.querySelector<HTMLElement>('.table-chat-modal')!;
      let chatInput = chatModal.querySelector<HTMLInputElement>('.chat-input')!;
      let chatForm = chatModal.querySelector<HTMLFormElement>('.chat-input-row')!;
      chatInput.value = '／／check';
      chatInput.dispatchEvent(new Event('input'));
      chatForm.dispatchEvent(new Event('submit', { cancelable: true }));

      expect(watchCalls).toEqual([true]);
      const checkModal = root.querySelector<HTMLElement>('.table-check-modal')!;
      const checkPanel =
        checkModal.querySelector<HTMLElement>('.table-check-panel')!;
      const checkList =
        checkModal.querySelector<HTMLElement>('.check-history-list')!;

      // ホスト(p0)・別ゲスト(p2)・自分(p1) の変更履歴を受信して表示
      const baseHistory: import('../../types/message').ChangeHistoryEntry[] = [
        {
          id: 'chg-1',
          timestamp: 1700000001000,
          actorPlayerId: 'p0',
          actorName: 'ホスト',
          category: 'settings',
          kind: 'rule_config',
          phaseLabel: 'ロビー',
          settingLabel: 'ルール設定「赤ドラ」',
          beforeValue: '各1枚',
          afterValue: '全5赤',
        },
        {
          id: 'chg-2',
          timestamp: 1700000002000,
          actorPlayerId: 'p1',
          actorName: 'P1',
          category: 'cheat',
          kind: 'cheat_peek',
          phaseLabel: '東1局',
          settingLabel: '相手手牌の透視（Peek）',
          beforeValue: 'OFF',
          afterValue: 'ON',
        },
        {
          id: 'chg-3',
          timestamp: 1700000003000,
          actorPlayerId: 'p2',
          actorName: 'P2',
          category: 'cheat',
          kind: 'cheat_luck',
          phaseLabel: '東1局',
          targetName: 'P2',
          settingLabel: 'P2 の配牌・ツモ運（Luck）',
          beforeValue: '通常',
          afterValue: '豪運',
        },
      ];
      emitChangeHistory!(baseHistory);

      expect(
        checkModal.querySelector<HTMLElement>('.check-summary-text')!.textContent,
      ).toContain('全 3 件（うち他プレイヤー 2 件）');
      expect(
        checkList.querySelectorAll('.check-history-item.is-other-player'),
      ).toHaveLength(2);
      expect(
        checkList.querySelectorAll('.check-history-item.is-self'),
      ).toHaveLength(1);

      // リストを途中までスクロールした状態でリアルタイム更新が届いても、DOMノードと scrollTop が維持される
      checkList.scrollTop = 120;
      emitChangeHistory!([
        ...baseHistory,
        {
          id: 'chg-4',
          timestamp: 1700000004000,
          actorPlayerId: 'p0',
          actorName: 'ホスト',
          category: 'cheat',
          kind: 'cheat_peek',
          phaseLabel: '東1局',
          settingLabel: '相手手牌の透視（Peek）',
          beforeValue: 'OFF',
          afterValue: 'ON',
        },
      ]);
      expect(root.querySelector('.table-check-panel')).toBe(checkPanel);
      expect(root.querySelector('.check-history-list')).toBe(checkList);
      expect(checkList.scrollTop).toBe(120);
      expect(checkList.querySelectorAll('.check-history-item')).toHaveLength(4);

      // 「他プレイヤーのみ」フィルタで p1(あなた) を除いた 3 件だけが表示される
      checkModal
        .querySelector<HTMLButtonElement>('button[data-check-actor-filter="others"]')!
        .click();
      expect(checkList.querySelectorAll('.check-history-item')).toHaveLength(3);
      expect(checkList.querySelectorAll('.check-history-item.is-self')).toHaveLength(0);

      // モーダルを閉じると watch: false が送信される
      checkModal
        .querySelector<HTMLButtonElement>('.table-modal-close-btn')!
        .click();
      expect(watchCalls).toEqual([true, false]);
      expect(root.querySelector('.table-check-modal')).toBeNull();

      // 観戦者ビューでも //check で閲覧できる
      emitClientView!(playingSpectatorView);
      root.querySelector<HTMLButtonElement>('.table-chrome-chat')!.click();
      chatModal = root.querySelector<HTMLElement>('.table-chat-modal')!;
      chatInput = chatModal.querySelector<HTMLInputElement>('.chat-input')!;
      chatForm = chatModal.querySelector<HTMLFormElement>('.chat-input-row')!;
      chatInput.value = '//check';
      chatInput.dispatchEvent(new Event('input'));
      chatForm.dispatchEvent(new Event('submit', { cancelable: true }));
      expect(root.querySelector('.table-check-modal')).not.toBeNull();
      expect(watchCalls).toEqual([true, false, true]);
    } finally {
      window.dispatchEvent(new Event('beforeunload'));
      vi.doUnmock('../../net/client');
      vi.resetModules();
    }
  });

  it('ローカル/ホスト対局およびオンラインクライアントで //stop により全員の //cheat 効果が標準へリセットされ履歴にも残る', async () => {
    document.body.innerHTML = '<div id="app"></div>';
    await loadMain();
    const root = document.getElementById('app') as HTMLElement;

    expect(clickByText(root, 'button', 'CPU対局をはじめる')).toBe(true);

    // //cheat で Peek ON + 他CPUの Luck を豪運に設定
    root.querySelector<HTMLButtonElement>('.table-chrome-chat')!.click();
    let chatModal = root.querySelector<HTMLElement>('.table-chat-modal')!;
    let chatInput = chatModal.querySelector<HTMLInputElement>('.chat-input')!;
    let chatForm = chatModal.querySelector<HTMLFormElement>('.chat-input-row')!;
    chatInput.value = '//cheat';
    chatInput.dispatchEvent(new Event('input'));
    chatForm.dispatchEvent(new Event('submit', { cancelable: true }));

    root
      .querySelector<HTMLButtonElement>(
        '.table-cheat-modal button[aria-label="相手手牌の透視"]',
      )!
      .click();
    root
      .querySelector<HTMLButtonElement>(
        '.table-cheat-modal button[data-luck-mode="god"][data-target-player-id="cpu-1"]',
      )!
      .click();
    expect(root.querySelectorAll('.opponent-hand.is-revealed')).toHaveLength(3);
    root
      .querySelector<HTMLButtonElement>('.table-cheat-modal .table-modal-close-btn')!
      .click();

    // チャット欄で //stop を送信すると即座に透視と Luck が標準へ戻る
    root.querySelector<HTMLButtonElement>('.table-chrome-chat')!.click();
    chatModal = root.querySelector<HTMLElement>('.table-chat-modal')!;
    chatInput = chatModal.querySelector<HTMLInputElement>('.chat-input')!;
    chatForm = chatModal.querySelector<HTMLFormElement>('.chat-input-row')!;
    chatInput.value = '//stop';
    chatInput.dispatchEvent(new Event('input'));
    chatForm.dispatchEvent(new Event('submit', { cancelable: true }));

    expect(root.querySelector('.table-chat-modal')).toBeNull();
    expect(root.querySelectorAll('.opponent-hand.is-revealed')).toHaveLength(0);

    // 再度 //cheat を開くと Peek OFF・全員「通常」に戻っている
    root.querySelector<HTMLButtonElement>('.table-chrome-chat')!.click();
    chatModal = root.querySelector<HTMLElement>('.table-chat-modal')!;
    chatInput = chatModal.querySelector<HTMLInputElement>('.chat-input')!;
    chatForm = chatModal.querySelector<HTMLFormElement>('.chat-input-row')!;
    chatInput.value = '//cheat';
    chatInput.dispatchEvent(new Event('input'));
    chatForm.dispatchEvent(new Event('submit', { cancelable: true }));

    expect(
      root
        .querySelector<HTMLButtonElement>(
          '.table-cheat-modal button[aria-label="相手手牌の透視"]',
        )!
        .getAttribute('aria-checked'),
    ).toBe('false');
    expect(
      root
        .querySelector(
          '.table-cheat-modal button[data-luck-mode="normal"][data-target-player-id="cpu-1"]',
        )!
        .classList.contains('is-active'),
    ).toBe(true);
    root
      .querySelector<HTMLButtonElement>('.table-cheat-modal .table-modal-close-btn')!
      .click();

    // //check で //stop 履歴が確認でき、通常チャットには //stop が残っていない
    root.querySelector<HTMLButtonElement>('.table-chrome-chat')!.click();
    chatModal = root.querySelector<HTMLElement>('.table-chat-modal')!;
    chatInput = chatModal.querySelector<HTMLInputElement>('.chat-input')!;
    chatForm = chatModal.querySelector<HTMLFormElement>('.chat-input-row')!;
    chatInput.value = '//check';
    chatInput.dispatchEvent(new Event('input'));
    chatForm.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(
      root.querySelector<HTMLElement>('.table-check-modal')!.textContent ?? '',
    ).toContain('//stop');
    root
      .querySelector<HTMLButtonElement>('.table-check-modal .table-modal-close-btn')!
      .click();

    root.querySelector<HTMLButtonElement>('.table-chrome-chat')!.click();
    const chatText =
      root.querySelector<HTMLElement>('.table-chat-modal .chat-messages-list')!
        .textContent ?? '';
    expect(chatText).not.toContain('//stop');

    // オンライン参加クライアント側でも ／／stop が送信され、観戦時は送信されない
    vi.resetModules();
    const { createInitialGameState, reduce } = await import('../../engine/reducer');
    const { deriveRules } = await import('../../engine/rules');
    const { toStateView } = await import('../../engine/projection');
    const { buildSeededTestDeck } = await import('../../engine/__tests__/testHelpers');

    const ruleConfig = { playerCount: 4 as const, gameLength: 'tonpuu' as const };
    const rules = deriveRules(ruleConfig);
    let lobbyState = createInitialGameState({
      roomCode: 'STP001',
      hostPlayerId: 'p0',
      hostName: 'ホスト',
      ruleConfig,
    });
    for (let i = 1; i < 4; i++) {
      lobbyState = reduce(lobbyState, {
        type: 'JOIN_PLAYER',
        playerId: `p${i}`,
        name: `P${i}`,
      });
    }
    const playingState = reduce(lobbyState, {
      type: 'START_GAME',
      shuffledDeck: buildSeededTestDeck(rules, 999),
    });
    const playingGuestView = toStateView(playingState, 'p1', 0);
    const playingSpectatorView = toStateView(
      {
        ...playingState,
        spectators: [{ spectatorId: 'spec-1', name: '観戦者', connected: true }],
      },
      'spec-1',
      0,
    );

    const secretCalls: Array<Record<string, unknown>> = [];
    let emitClientView: ((v: typeof playingGuestView) => void) | null = null;
    vi.doMock('../../net/client', () => {
      class MockClientSession {
        private readonly cb: Record<string, (...args: any[]) => void>;
        constructor(
          _roomCode: string,
          _name: string,
          callbacks: Record<string, (...args: any[]) => void>,
        ) {
          this.cb = callbacks;
          emitClientView = (v) => this.cb.onViewChange?.(v);
        }
        connect() {
          this.cb.onStatusChange?.('connected');
          this.cb.onViewChange?.(playingGuestView);
        }
        sendChat() {
          return true;
        }
        setSecretOption(opts: Record<string, unknown>) {
          secretCalls.push(opts);
        }
        requestChangeHistory() {}
        destroy() {}
      }
      return { ClientSession: MockClientSession };
    });

    try {
      document.body.innerHTML = '<div id="app"></div>';
      await loadMain();
      const onlineRoot = document.getElementById('app') as HTMLElement;
      const codeInput =
        onlineRoot.querySelector<HTMLInputElement>('#room-code-input')!;
      codeInput.value = 'STP001';
      codeInput.dispatchEvent(new Event('input'));
      expect(clickByText(onlineRoot, 'button', '参加する')).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 10));

      onlineRoot.querySelector<HTMLButtonElement>('.table-chrome-chat')!.click();
      let oChatModal =
        onlineRoot.querySelector<HTMLElement>('.table-chat-modal')!;
      let oChatInput =
        oChatModal.querySelector<HTMLInputElement>('.chat-input')!;
      let oChatForm =
        oChatModal.querySelector<HTMLFormElement>('.chat-input-row')!;
      oChatInput.value = '／／stop';
      oChatInput.dispatchEvent(new Event('input'));
      oChatForm.dispatchEvent(new Event('submit', { cancelable: true }));
      expect(secretCalls).toEqual([{ clearAllCheat: true }]);

      // 観戦時は //stop を入力しても通常チャット漏洩も送信もしない
      emitClientView!(playingSpectatorView);
      onlineRoot.querySelector<HTMLButtonElement>('.table-chrome-chat')!.click();
      oChatModal = onlineRoot.querySelector<HTMLElement>('.table-chat-modal')!;
      oChatInput = oChatModal.querySelector<HTMLInputElement>('.chat-input')!;
      oChatForm = oChatModal.querySelector<HTMLFormElement>('.chat-input-row')!;
      oChatInput.value = '//stop';
      oChatInput.dispatchEvent(new Event('input'));
      oChatForm.dispatchEvent(new Event('submit', { cancelable: true }));
      expect(secretCalls).toEqual([{ clearAllCheat: true }]);
    } finally {
      window.dispatchEvent(new Event('beforeunload'));
      vi.doUnmock('../../net/client');
      vi.resetModules();
    }
  });
});
