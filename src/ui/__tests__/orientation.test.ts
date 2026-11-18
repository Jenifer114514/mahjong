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

  it('ホーム画面で横画面固定を有効化すると requestFullscreen と screen.orientation.lock("landscape") を呼び、OFF で解除する', async () => {
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
    const lockSwitch = root.querySelector<HTMLButtonElement>('.landscape-lock-switch');
    expect(lockSwitch).not.toBeNull();
    expect(lockSwitch!.getAttribute('aria-checked')).toBe('false');
    expect(root.textContent).toContain('横画面固定（Android・フル画面）');

    lockSwitch!.click();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(calls).toEqual(['requestFullscreen', 'lock:landscape']);
    expect(localStorage.getItem('arena-mahjong:landscape-lock:v1')).toBe('true');

    const updatedSwitch = root.querySelector<HTMLButtonElement>('.landscape-lock-switch')!;
    expect(updatedSwitch.getAttribute('aria-checked')).toBe('true');
    expect(updatedSwitch.textContent).toContain('ON');
    expect(root.textContent).toContain('フル画面表示で横向きに固定しています');

    // ON のまま対局開始しても横画面のためオーバーレイは出ない
    expect(clickText(root, 'button', 'CPU対局をはじめる')).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(document.querySelector('.rotate-overlay')).toBeNull();

    // 設定モーダルから OFF にすると unlock + exitFullscreen が呼ばれ、設定も OFF に戻る
    root.querySelector<HTMLButtonElement>('.table-chrome-settings')!.click();
    const settingsSwitch = root.querySelector<HTMLButtonElement>(
      '.table-settings-modal [role="switch"]',
    )!;
    expect(settingsSwitch.getAttribute('aria-checked')).toBe('true');
    settingsSwitch.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toEqual([
      'requestFullscreen',
      'lock:landscape',
      'unlock',
      'exitFullscreen',
    ]);
    expect(localStorage.getItem('arena-mahjong:landscape-lock:v1')).toBeNull();
  });

  it('ホーム画面で横画面固定を有効化した記憶がある場合、次回起動時に「今すぐ横画面」が出て対局開始時にも自動適用される', async () => {
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
    const lockMock = vi.fn(async () => {
      setViewport(844, 390, true);
      window.dispatchEvent(new Event('resize'));
    });
    Object.defineProperty(window.screen, 'orientation', {
      configurable: true,
      value: {
        lock: lockMock,
        unlock: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
      },
    });

    const root = await boot();
    const applyBtn = root.querySelector<HTMLButtonElement>('.landscape-lock-apply-btn');
    expect(applyBtn).not.toBeNull();
    expect(applyBtn!.textContent).toContain('今すぐ横画面');

    // 今すぐ横画面を押さずそのまま CPU 対局を開始しても自動適用される
    expect(clickText(root, 'button', 'CPU対局をはじめる')).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(reqFs).toHaveBeenCalledTimes(1);
    expect(lockMock).toHaveBeenCalledWith('landscape');
    expect(document.querySelector('.rotate-overlay')).toBeNull();
  });

  it('非対応ブラウザでホーム画面の横画面固定を ON にするとエラーを表示し OFF に戻す', async () => {
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
    root.querySelector<HTMLButtonElement>('.landscape-lock-switch')!.click();
    await new Promise((resolve) => setTimeout(resolve, 20));

    const msg = root.querySelector('.landscape-lock-message.is-err');
    expect(msg).not.toBeNull();
    expect(msg!.textContent).toContain('対応していません');
    expect(
      root
        .querySelector<HTMLButtonElement>('.landscape-lock-switch')!
        .getAttribute('aria-checked'),
    ).toBe('false');
  });

  it('縦持ちオーバーレイ上の「横画面に固定する」ボタンから Android 横画面固定へ復帰できる', async () => {
    setViewport(390, 844, true);

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
    const lockMock = vi.fn(async () => {
      setViewport(844, 390, true);
      window.dispatchEvent(new Event('resize'));
    });
    Object.defineProperty(window.screen, 'orientation', {
      configurable: true,
      value: {
        lock: lockMock,
        unlock: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
      },
    });

    const root = await boot();
    expect(clickText(root, 'button', 'CPU対局をはじめる')).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const lockBtn = document.querySelector<HTMLButtonElement>('.rotate-overlay-lock-btn');
    expect(lockBtn).not.toBeNull();
    lockBtn!.click();
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(reqFs).toHaveBeenCalledTimes(1);
    expect(lockMock).toHaveBeenCalledWith('landscape');
    expect(document.querySelector('.rotate-overlay')).toBeNull();
  });

  it('モバイル端末で requestFullscreen 成功後に orientation.lock が失敗した場合、オーバーレイ上に案内エラーを出す', async () => {
    setViewport(390, 844, true);

    let fsEl: Element | null = null;
    Object.defineProperty(document, 'fullscreenElement', {
      configurable: true,
      get: () => fsEl,
    });
    document.documentElement.requestFullscreen = vi.fn(async () => {
      fsEl = document.documentElement;
      document.dispatchEvent(new Event('fullscreenchange'));
    });
    Object.defineProperty(window.screen, 'orientation', {
      configurable: true,
      writable: true,
      value: {
        lock: vi.fn(async () => {
          throw new Error('NotSupportedError');
        }),
        unlock: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
      },
    });

    const root = await boot();
    expect(clickText(root, 'button', 'CPU対局をはじめる')).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const lockBtn = document.querySelector<HTMLButtonElement>('.rotate-overlay-lock-btn')!;
    expect(lockBtn).not.toBeNull();
    lockBtn.click();
    await new Promise((resolve) => setTimeout(resolve, 30));

    const errEl = document.querySelector<HTMLElement>('.rotate-overlay-error');
    expect(errEl).not.toBeNull();
    expect(errEl!.hidden).toBe(false);
    expect(errEl!.textContent).toContain('横画面ロックに非対応');
  });
});
