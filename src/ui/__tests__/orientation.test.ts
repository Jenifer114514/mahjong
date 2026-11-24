// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('peerjs', () => {
  class FakePeer {
    destroyed = false;
    on() {}
    destroy() {}
  }
  return { default: FakePeer };
});

function setViewport(width: number, height: number, coarse = true): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
  window.matchMedia = ((query: string) => ({
    matches: coarse && query.includes('pointer: coarse'),
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

async function boot(): Promise<HTMLElement> {
  document.body.innerHTML = '<div id="app"></div>';
  document.body.className = '';
  vi.resetModules();
  await import('../../main');
  return document.getElementById('app') as HTMLElement;
}

function clickText(root: HTMLElement, selector: string, text: string): boolean {
  const el = Array.from(root.querySelectorAll<HTMLElement>(selector)).find((e) =>
    (e.textContent ?? '').includes(text),
  );
  if (!el) return false;
  el.click();
  return true;
}

describe('強制横画面', () => {
  beforeEach(() => {
    localStorage.clear();
    setViewport(1280, 800, false);
    Object.defineProperty(document, 'fullscreenElement', {
      configurable: true,
      get: () => null,
    });
    Object.defineProperty(document.documentElement, 'requestFullscreen', {
      configurable: true,
      writable: true,
      value: undefined,
    });
    Object.defineProperty(document.documentElement, 'webkitRequestFullscreen', {
      configurable: true,
      writable: true,
      value: undefined,
    });
    Object.defineProperty(document, 'exitFullscreen', {
      configurable: true,
      writable: true,
      value: undefined,
    });
    Object.defineProperty(window.screen, 'orientation', {
      configurable: true,
      writable: true,
      value: undefined,
    });
  });

  it('ロビーでは縦持ちでもオーバーレイを出さない', async () => {
    setViewport(390, 844, true);
    const root = await boot();
    expect(root.querySelector('.app-shell')).not.toBeNull();
    expect(document.querySelector('.rotate-overlay')).toBeNull();
  });

  it('縦持ちスマホで対局を始めると横向き案内で覆われる', async () => {
    setViewport(390, 844, true);
    const root = await boot();
    expect(clickText(root, 'button', 'CPU対局をはじめる')).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 60));

    const overlay = document.querySelector('.rotate-overlay');
    expect(overlay).not.toBeNull();
    expect(overlay!.textContent).toContain('端末を横向きにしてください');
    expect(document.body.classList.contains('is-orientation-blocked')).toBe(true);
  });

  it('端末を横向きにすると案内が消えて雀卓が見える', async () => {
    setViewport(390, 844, true);
    const root = await boot();
    clickText(root, 'button', 'CPU対局をはじめる');
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(document.querySelector('.rotate-overlay')).not.toBeNull();

    // 端末を回転
    setViewport(844, 390, true);
    window.dispatchEvent(new Event('resize'));
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(document.querySelector('.rotate-overlay')).toBeNull();
    expect(document.body.classList.contains('is-orientation-blocked')).toBe(false);
    expect(root.querySelector('.table-felt.is-landscape')).not.toBeNull();
    expect(root.querySelector('.table-compass')).not.toBeNull();
  });

  it('PC（縦長ウィンドウでも）はオーバーレイを出さずに卓を表示する', async () => {
    setViewport(900, 1200, false);
    const root = await boot();
    clickText(root, 'button', 'CPU対局をはじめる');
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(document.querySelector('.rotate-overlay')).toBeNull();
    expect(root.querySelector('.table-felt.is-landscape')).not.toBeNull();
  });

  it('ホーム画面・待機ロビー・回転オーバーレイにフルスクリーンボタンを出さず、対局開始で自動フルスクリーン化しない', async () => {
    setViewport(390, 844, true);
    localStorage.setItem('arena-mahjong:landscape-lock:v1', 'true');

    let fsEl: Element | null = null;
    Object.defineProperty(document, 'fullscreenElement', {
      configurable: true,
      get: () => fsEl,
    });
    const reqFs = vi.fn(async () => {
      fsEl = document.documentElement;
      document.dispatchEvent(new Event('fullscreenchange'));
    });
    document.documentElement.requestFullscreen = reqFs;

    const root = await boot();
    expect(root.querySelector('.landscape-lock-card')).toBeNull();
    expect(root.querySelector('.landscape-lock-switch')).toBeNull();
    expect(root.querySelector('.landscape-lock-apply-btn')).toBeNull();

    expect(clickText(root, 'button', 'CPU対局をはじめる')).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(reqFs).not.toHaveBeenCalled();
    const overlay = document.querySelector('.rotate-overlay');
    expect(overlay).not.toBeNull();
    expect(overlay!.querySelector('.rotate-overlay-lock-btn')).toBeNull();
  });

  it('設定モーダルのフル画面表示スイッチでのみ requestFullscreen / screen.orientation.lock("landscape") を切り替え、OFF で解除する', async () => {
    setViewport(390, 844, true);

    const calls: string[] = [];
    let fsEl: Element | null = null;
    Object.defineProperty(document, 'fullscreenElement', {
      configurable: true,
      get: () => fsEl,
    });
    document.documentElement.requestFullscreen = vi.fn(async () => {
      calls.push('requestFullscreen');
      fsEl = document.documentElement;
      document.dispatchEvent(new Event('fullscreenchange'));
    });
    document.exitFullscreen = vi.fn(async () => {
      calls.push('exitFullscreen');
      fsEl = null;
      document.dispatchEvent(new Event('fullscreenchange'));
    });

    const lockMock = vi.fn(async (mode: string) => {
      calls.push(`lock:${mode}`);
      setViewport(844, 390, true);
      window.dispatchEvent(new Event('resize'));
    });
    const unlockMock = vi.fn(() => {
      calls.push('unlock');
    });
    Object.defineProperty(window.screen, 'orientation', {
      configurable: true,
      value: {
        lock: lockMock,
        unlock: unlockMock,
        addEventListener: () => {},
        removeEventListener: () => {},
      },
    });

    const root = await boot();

    // ホーム画面の「設定」ボタンから設定モーダルを開く
    const topSettingsBtn = root.querySelector<HTMLButtonElement>('.top-bar-settings-btn');
    expect(topSettingsBtn).not.toBeNull();
    topSettingsBtn!.click();

    const homeModalSwitch = document.querySelector<HTMLButtonElement>(
      '.table-settings-modal button[aria-label="フル画面表示"]',
    )!;
    expect(homeModalSwitch).not.toBeNull();
    expect(homeModalSwitch.getAttribute('aria-checked')).toBe('false');

    homeModalSwitch.click();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(calls).toEqual(['requestFullscreen', 'lock:landscape']);
    expect(
      document
        .querySelector<HTMLButtonElement>(
          '.table-settings-modal button[aria-label="フル画面表示"]',
        )!
        .getAttribute('aria-checked'),
    ).toBe('true');

    // モーダルを閉じて対局を開始しても横画面のためオーバーレイは出ない
    expect(clickText(document.body, '.table-settings-modal button', '閉じる')).toBe(
      true,
    );
    expect(clickText(root, 'button', 'CPU対局をはじめる')).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(document.querySelector('.rotate-overlay')).toBeNull();

    // 対局中の設定モーダルから OFF にすると unlock + exitFullscreen が呼ばれる
    root.querySelector<HTMLButtonElement>('.table-chrome-settings')!.click();
    const gameModalSwitch = document.querySelector<HTMLButtonElement>(
      '.table-settings-modal button[aria-label="フル画面表示"]',
    )!;
    expect(gameModalSwitch.getAttribute('aria-checked')).toBe('true');
    gameModalSwitch.click();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(calls).toEqual([
      'requestFullscreen',
      'lock:landscape',
      'unlock',
      'exitFullscreen',
    ]);
    expect(
      document
        .querySelector<HTMLButtonElement>(
          '.table-settings-modal button[aria-label="フル画面表示"]',
        )!
        .getAttribute('aria-checked'),
    ).toBe('false');
  });

  it('非対応ブラウザで設定モーダルのフル画面表示を ON にするとモーダル内にエラーを表示し OFF のままにする', async () => {
    setViewport(390, 844, true);
    Object.defineProperty(document, 'fullscreenElement', {
      configurable: true,
      get: () => null,
    });
    Object.defineProperty(document.documentElement, 'requestFullscreen', {
      configurable: true,
      writable: true,
      value: undefined,
    });
    Object.defineProperty(document.documentElement, 'webkitRequestFullscreen', {
      configurable: true,
      writable: true,
      value: undefined,
    });

    const root = await boot();
    root.querySelector<HTMLButtonElement>('.top-bar-settings-btn')!.click();
    document
      .querySelector<HTMLButtonElement>(
        '.table-settings-modal button[aria-label="フル画面表示"]',
      )!
      .click();
    await new Promise((resolve) => setTimeout(resolve, 20));

    const err = document.querySelector('.table-settings-modal .fullscreen-error-note');
    expect(err).not.toBeNull();
    expect(err!.textContent).toContain('対応していません');
    expect(
      document
        .querySelector<HTMLButtonElement>(
          '.table-settings-modal button[aria-label="フル画面表示"]',
        )!
        .getAttribute('aria-checked'),
    ).toBe('false');
  });
});
