// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  loadSoundEnabledPreference,
  saveSoundEnabledPreference,
  soundEngine,
} from '../sound';

describe('soundEngine', () => {
  beforeEach(() => {
    localStorage.clear();
    soundEngine.setEnabled(true);
  });

  afterEach(() => {
    soundEngine.cancelScheduled();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('効果音設定の保存と読み込みができる', () => {
    expect(loadSoundEnabledPreference()).toBe(true);
    saveSoundEnabledPreference(false);
    expect(loadSoundEnabledPreference()).toBe(false);
    saveSoundEnabledPreference(true);
    expect(loadSoundEnabledPreference()).toBe(true);
  });

  it('AudioContext 未対応環境でも全サウンドメソッドが例外を投げない', () => {
    vi.stubGlobal('AudioContext', undefined);
    vi.stubGlobal('webkitAudioContext', undefined);
    expect(() => {
      soundEngine.unlock();
      soundEngine.playSelect();
      soundEngine.playDraw(0);
      soundEngine.playDiscard(0);
      soundEngine.playRiichi(0);
      soundEngine.playMeld();
      soundEngine.playDoraFlip();
      soundEngine.playAgari(true);
      soundEngine.playAgari(false);
      soundEngine.playDrawRound();
      soundEngine.playRoundStart();
    }).not.toThrow();
  });

  it('OFF にすると AudioContext を呼ばず、タイマー予定もキャンセルされる', () => {
    const startSpy = vi.fn();
    const createOsc = vi.fn(() => ({
      type: 'sine',
      frequency: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
      connect: vi.fn(),
      start: startSpy,
      stop: vi.fn(),
    }));
    const createGain = vi.fn(() => ({
      gain: { setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
      connect: vi.fn(),
    }));
    const FakeAudioContext = vi.fn(function (this: unknown) {
      return {
        currentTime: 0,
        sampleRate: 44100,
        state: 'running',
        destination: {},
        resume: vi.fn(async () => {}),
        createOscillator: createOsc,
        createGain,
        createBuffer: vi.fn(() => ({ getChannelData: () => new Float32Array(1024) })),
        createBufferSource: vi.fn(() => ({
          buffer: null,
          connect: vi.fn(),
          start: vi.fn(),
          stop: vi.fn(),
        })),
        createBiquadFilter: vi.fn(() => ({
          type: 'bandpass',
          frequency: { setValueAtTime: vi.fn() },
          Q: { setValueAtTime: vi.fn() },
          connect: vi.fn(),
        })),
      };
    });
    vi.stubGlobal('AudioContext', FakeAudioContext);

    soundEngine.setEnabled(false);
    soundEngine.playSelect();
    soundEngine.playDiscard(0);
    soundEngine.playAgari(true);
    expect(startSpy).not.toHaveBeenCalled();
  });

  it('AudioContext 対応環境かつ ON 時にオシレーターで効果音を再生できる', () => {
    const startSpy = vi.fn();
    const createOsc = vi.fn(() => ({
      type: 'sine',
      frequency: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
      connect: vi.fn(),
      start: startSpy,
      stop: vi.fn(),
    }));
    const createGain = vi.fn(() => ({
      gain: { setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
      connect: vi.fn(),
    }));
    const FakeAudioContext = vi.fn(function (this: unknown) {
      return {
        currentTime: 0,
        sampleRate: 44100,
        state: 'running',
        destination: {},
        resume: vi.fn(async () => {}),
        createOscillator: createOsc,
        createGain,
        createBuffer: vi.fn(() => ({ getChannelData: () => new Float32Array(1024) })),
        createBufferSource: vi.fn(() => ({
          buffer: null,
          connect: vi.fn(),
          start: vi.fn(),
          stop: vi.fn(),
        })),
        createBiquadFilter: vi.fn(() => ({
          type: 'bandpass',
          frequency: { setValueAtTime: vi.fn() },
          Q: { setValueAtTime: vi.fn() },
          connect: vi.fn(),
        })),
      };
    });
    vi.stubGlobal('AudioContext', FakeAudioContext);

    soundEngine.setEnabled(true);
    soundEngine.playSelect();
    soundEngine.playDiscard(0);
    soundEngine.playRiichi(0);
    soundEngine.playMeld();
    soundEngine.playDoraFlip();
    soundEngine.playAgari(true);
    soundEngine.playRoundStart();

    expect(startSpy.mock.calls.length).toBeGreaterThanOrEqual(8);
  });
});
