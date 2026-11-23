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
});
