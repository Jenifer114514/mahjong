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
    setViewport(1280, 800, false);
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
});
