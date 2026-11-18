/**
 * 強制横画面モード。
 * スマホ縦持ちのときは「端末を横向きにしてください」オーバーレイで対局画面を覆い、
 * 横持ち（または PC）では通常の雀卓を表示する。
 * また Android Chrome 等向けに Fullscreen API + Screen Orientation API による
 * 横画面ロック（requestFullscreen + screen.orientation.lock('landscape')）を提供する。
 */

const LANDSCAPE_LOCK_STORAGE_KEY = 'arena-mahjong:landscape-lock:v1';

interface ScreenOrientationWithLock {
  lock?: (
    orientation:
      | 'any'
      | 'natural'
      | 'landscape'
      | 'portrait'
      | 'portrait-primary'
      | 'portrait-secondary'
      | 'landscape-primary'
      | 'landscape-secondary',
  ) => Promise<void>;
  unlock?: () => void;
  addEventListener?: (type: 'change', listener: () => void) => void;
  removeEventListener?: (type: 'change', listener: () => void) => void;
}

interface DocumentWithWebkitFullscreen extends Document {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
}

interface ElementWithWebkitFullscreen extends HTMLElement {
  webkitRequestFullscreen?: () => Promise<void> | void;
}

export interface LandscapeFullscreenResult {
  fullscreen: boolean;
  orientationLocked: boolean;
  error: string | null;
}

export interface RotateOverlayOptions {
  onRequestLandscapeLock?: () => Promise<LandscapeFullscreenResult | void>;
}

function getStorage(): Storage | null {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      return window.localStorage;
    }
  } catch {
    // ignore storage access restrictions
  }
  return null;
}

export function loadLandscapeLockPreference(): boolean {
  const storage = getStorage();
  if (!storage) return false;
  try {
    return storage.getItem(LANDSCAPE_LOCK_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

export function saveLandscapeLockPreference(enabled: boolean): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    if (enabled) {
      storage.setItem(LANDSCAPE_LOCK_STORAGE_KEY, 'true');
    } else {
      storage.removeItem(LANDSCAPE_LOCK_STORAGE_KEY);
    }
  } catch {
    // ignore quota errors
  }
}

export function isFullscreenActive(doc: Document = document): boolean {
  if (typeof document === 'undefined') return false;
  const d = doc as DocumentWithWebkitFullscreen;
  return Boolean(d.fullscreenElement ?? d.webkitFullscreenElement);
}

export async function enterLandscapeFullscreen(): Promise<LandscapeFullscreenResult> {
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    return { fullscreen: false, orientationLocked: false, error: null };
  }

  const rootEl = document.documentElement as ElementWithWebkitFullscreen | null;
  if (!rootEl) {
    return {
      fullscreen: false,
      orientationLocked: false,
      error: 'フル画面表示の要素が見つかりません。',
    };
  }

  if (!isFullscreenActive(document)) {
    try {
      if (typeof rootEl.requestFullscreen === 'function') {
        await rootEl.requestFullscreen();
      } else if (typeof rootEl.webkitRequestFullscreen === 'function') {
        await rootEl.webkitRequestFullscreen();
      } else {
        return {
          fullscreen: false,
          orientationLocked: false,
          error:
            'お使いのブラウザではフル画面・横画面固定に対応していません（Android Chrome 等でご利用ください）。',
        };
      }
    } catch {
      return {
        fullscreen: false,
        orientationLocked: false,
        error:
          'フル画面表示に切り替えられませんでした。ブラウザの設定をご確認ください。',
      };
    }
  }

  const orientation = window.screen?.orientation as
    | ScreenOrientationWithLock
    | undefined;
  if (orientation && typeof orientation.lock === 'function') {
    try {
      await orientation.lock('landscape');
      return { fullscreen: true, orientationLocked: true, error: null };
    } catch {
      return {
        fullscreen: true,
        orientationLocked: false,
        error: isCoarsePointer()
          ? 'フル画面表示にしましたが、この端末・ブラウザでは横画面ロックに非対応のため端末を横向きにしてご利用ください。'
          : null,
      };
    }
  }

  return {
    fullscreen: true,
    orientationLocked: false,
    error: isCoarsePointer()
      ? 'フル画面表示にしましたが、この端末・ブラウザでは横画面ロックに非対応のため端末を横向きにしてご利用ください。'
      : null,
  };
}

export async function exitLandscapeFullscreen(): Promise<{ error: string | null }> {
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    return { error: null };
  }

  const orientation = window.screen?.orientation as
    | ScreenOrientationWithLock
    | undefined;
  if (orientation && typeof orientation.unlock === 'function') {
    try {
      orientation.unlock();
    } catch {
      // ignore unlock errors when not locked
    }
  }

  if (!isFullscreenActive(document)) {
    return { error: null };
  }

  const doc = document as DocumentWithWebkitFullscreen;
  try {
    if (typeof doc.exitFullscreen === 'function') {
      await doc.exitFullscreen();
    } else if (typeof doc.webkitExitFullscreen === 'function') {
      await doc.webkitExitFullscreen();
    }
    return { error: null };
  } catch {
    return { error: 'フル画面表示の解除に失敗しました。' };
  }
}

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

export function createRotateOverlay(options: RotateOverlayOptions = {}): HTMLElement {
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
  hint.textContent =
    '※ 画面の回転ロックがかかっている場合は、端末の設定から自動回転をオンにしてください。';

  overlay.append(icon, title, body, hint);

  if (options.onRequestLandscapeLock) {
    const lockBtn = document.createElement('button');
    lockBtn.type = 'button';
    lockBtn.className = 'btn btn-primary rotate-overlay-lock-btn';
    lockBtn.textContent = '横画面に固定する（Android・フル画面）';

    const errorEl = document.createElement('div');
    errorEl.className = 'rotate-overlay-error';
    errorEl.hidden = true;

    lockBtn.addEventListener('click', () => {
      lockBtn.disabled = true;
      errorEl.hidden = true;
      errorEl.textContent = '';
      void Promise.resolve(options.onRequestLandscapeLock?.())
        .then((res) => {
          if (res && typeof res === 'object' && 'error' in res && res.error) {
            errorEl.textContent = res.error;
            errorEl.hidden = false;
          }
        })
        .finally(() => {
          lockBtn.disabled = false;
        });
    });

    overlay.append(lockBtn, errorEl);
  }

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
