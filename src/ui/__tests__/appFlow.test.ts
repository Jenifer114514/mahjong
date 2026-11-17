// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

// PeerJS はブラウザ専用のためスタブ化（ローカル対局では接続自体を行わない）
vi.mock('peerjs', () => {
  class FakePeer {
    destroyed = false;
    on() {}
    destroy() {}
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

  it('ロビーを描画し CPU 人数の選択肢を持つ', async () => {
    bootApp();
    await loadMain();

    const root = document.getElementById('app') as HTMLElement;
    expect(root.querySelector('.app-shell')).not.toBeNull();
    expect(root.textContent).toContain('部屋を作る（ホスト）');
    expect(root.textContent).toContain('いますぐCPUと対局');
    // 4人麻雀の既定は CPU 3 体
    expect(
      Array.from(root.querySelectorAll('.seg-btn')).some(
        (b) => (b.textContent ?? '').includes('3体') &&
          b.classList.contains('is-active'),
      ),
    ).toBe(true);
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

  it('手番になったら手牌をタップして打牌でき、捨て牌が増える', async () => {
    bootApp();
    await loadMain();

    const root = document.getElementById('app') as HTMLElement;
    clickByText(root, 'button', 'CPU対局をはじめる');

    // 自分の手番になるまで待つ（CPU 3体が打牌を終えるまで）
    let acted = false;
    let before = 0;
    for (let i = 0; i < 200 && !acted; i++) {
      await new Promise((resolve) => setTimeout(resolve, 40));
      const clickable = root.querySelectorAll<HTMLElement>(
        '.seat-self .hand-area .mj-tile-clickable',
      );
      if (clickable.length > 0) {
        before = root.querySelectorAll('.seat-self .discard-river .mj-tile')
          .length;
        clickable[0]!.click();
        // 再描画はマイクロタスク後。取りこぼしても次の周回で再試行する
        for (let j = 0; j < 20 && !acted; j++) {
          await new Promise((resolve) => setTimeout(resolve, 30));
          const after = root.querySelectorAll(
            '.seat-self .discard-river .mj-tile',
          ).length;
          if (after === before + 1) acted = true;
        }
      }
    }
    expect(acted, '自分の捨て牌が 1 枚増える').toBe(true);
  }, 30000);
});
