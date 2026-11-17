/**
 * 強制横画面モード。
 * スマホ縦持ちのときは「端末を横向きにしてください」オーバーレイで対局画面を覆い、
 * 横持ち（または PC）では通常の雀卓を表示する。
 */

function isLandscapeViewport(): boolean {
  if (typeof window === 'undefined') return true;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  // 正方形に近い場合は横向き扱い（PCの小窓など）
  return vw > vh * 0.95;
}

function isCoarsePointer(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia('(pointer: coarse)').matches;
}

/**
 * 縦持ちスマホのときだけオーバーレイを出す。
 * PC の縦長ウィンドウではレイアウトが成立するため出さない。
 */
export function shouldBlockForOrientation(): boolean {
  if (typeof window === 'undefined') return false;
  return !isLandscapeViewport() && isCoarsePointer();
}

export function createRotateOverlay(): HTMLElement {
  const overlay = document.createElement('div');
  overlay.className = 'rotate-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-live', 'polite');

  const icon = document.createElement('div');
  icon.className = 'rotate-overlay-icon';
  icon.textContent = '📱';

  const title = document.createElement('div');
  title.className = 'rotate-overlay-title';
  title.textContent = '端末を横向きにしてください';

  const body = document.createElement('div');
  body.className = 'rotate-overlay-body';
  body.textContent =
    '雀卓を4方向から囲むレイアウトのため、横向きでのプレイに対応しています。端末を90度回転すると対局が始まります。';

  const hint = document.createElement('div');
  hint.className = 'rotate-overlay-hint';
  hint.textContent = '※ 画面の回転ロックがかかっている場合は、端末の設定から自動回転をオンにしてください。';

  overlay.append(icon, title, body, hint);
  return overlay;
}

/** 画面回転を監視する（戻り値は解除関数） */
export function watchOrientation(onChange: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const handler = () => onChange();
  window.addEventListener('resize', handler);
  window.addEventListener('orientationchange', handler);

  const orientation = window.screen?.orientation;
  if (orientation && typeof orientation.addEventListener === 'function') {
    orientation.addEventListener('change', handler);
  }

  return () => {
    window.removeEventListener('resize', handler);
    window.removeEventListener('orientationchange', handler);
    if (orientation && typeof orientation.removeEventListener === 'function') {
      orientation.removeEventListener('change', handler);
    }
  };
}
