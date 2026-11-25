/**
 * 対局中の効果音を Web Audio API で合成する軽量サウンドエンジン。
 * 外部音声アセットやネットワークに依存せず、オフライン・モバイルブラウザ・テスト環境でも安全に動作する。
 */

const SOUND_ENABLED_STORAGE_KEY = 'arena-mahjong:sound-enabled:v1';

export function loadSoundEnabledPreference(): boolean {
  try {
    if (typeof localStorage === 'undefined') return true;
    const raw = localStorage.getItem(SOUND_ENABLED_STORAGE_KEY);
    if (raw === '0' || raw === 'false') return false;
    return true;
  } catch {
    return true;
  }
}

export function saveSoundEnabledPreference(enabled: boolean): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(SOUND_ENABLED_STORAGE_KEY, enabled ? '1' : '0');
  } catch {
    // ストレージ無効環境では無視
  }
}

type AudioContextCtor = new () => AudioContext;

function getAudioContextConstructor(): AudioContextCtor | null {
  if (typeof window === 'undefined') return null;
  const win = window as Window & {
    AudioContext?: AudioContextCtor;
    webkitAudioContext?: AudioContextCtor;
  };
  return win.AudioContext ?? win.webkitAudioContext ?? null;
}

class MahjongSoundEngine {
  private ctx: AudioContext | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private enabled = loadSoundEnabledPreference();
  private scheduledTimers = new Set<ReturnType<typeof setTimeout>>();

  isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    saveSoundEnabledPreference(enabled);
    if (!enabled) {
      this.cancelScheduled();
    } else {
      this.unlock();
    }
  }

  cancelScheduled(): void {
    for (const id of this.scheduledTimers) {
      clearTimeout(id);
    }
    this.scheduledTimers.clear();
  }

  /** ユーザー操作時に呼び出し、ブラウザの再生ロックを解除する */
  unlock(): void {
    if (!this.enabled) return;
    const ctx = this.ensureContext();
    if (!ctx) return;
    if (ctx.state === 'suspended') {
      void ctx.resume().catch(() => {});
    }
  }

  private ensureContext(): AudioContext | null {
    if (this.ctx) return this.ctx;
    const Ctor = getAudioContextConstructor();
    if (!Ctor) return null;
    try {
      this.ctx = new Ctor();
      return this.ctx;
    } catch {
      return null;
    }
  }

  private getNoiseBuffer(ctx: AudioContext): AudioBuffer | null {
    if (this.noiseBuffer) return this.noiseBuffer;
    try {
      const length = Math.floor(ctx.sampleRate * 0.25);
      const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < length; i++) {
        data[i] = Math.random() * 2 - 1;
      }
      this.noiseBuffer = buffer;
      return buffer;
    } catch {
      return null;
    }
  }

  private runWithDelay(delayMs: number, fn: (ctx: AudioContext) => void): void {
    if (!this.enabled) return;
    if (delayMs <= 0) {
      const ctx = this.ensureContext();
      if (!ctx) return;
      if (ctx.state === 'suspended') {
        void ctx.resume().catch(() => {});
      }
      fn(ctx);
      return;
    }
    const timer = setTimeout(() => {
      this.scheduledTimers.delete(timer);
      if (!this.enabled) return;
      const ctx = this.ensureContext();
      if (!ctx) return;
      if (ctx.state === 'suspended') {
        void ctx.resume().catch(() => {});
      }
      fn(ctx);
    }, delayMs);
    this.scheduledTimers.add(timer);
  }

  private playTone(
    ctx: AudioContext,
    options: {
      type?: OscillatorType;
      freqStart: number;
      freqEnd?: number;
      startOffset?: number;
      duration: number;
      gain: number;
    },
  ): void {
    const now = ctx.currentTime + (options.startOffset ?? 0);
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = options.type ?? 'triangle';
    osc.frequency.setValueAtTime(options.freqStart, now);
    if (options.freqEnd !== undefined && options.freqEnd !== options.freqStart) {
      osc.frequency.exponentialRampToValueAtTime(
        Math.max(20, options.freqEnd),
        now + options.duration,
      );
    }
    g.gain.setValueAtTime(0.0001, now);
    g.gain.linearRampToValueAtTime(options.gain, now + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, now + options.duration);
    osc.connect(g);
    g.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + options.duration + 0.02);
  }

  private playNoiseBurst(
    ctx: AudioContext,
    options: {
      filterType: BiquadFilterType;
      freq: number;
      q?: number;
      startOffset?: number;
      duration: number;
      gain: number;
    },
  ): void {
    const buffer = this.getNoiseBuffer(ctx);
    if (!buffer) return;
    const now = ctx.currentTime + (options.startOffset ?? 0);
    const src = ctx.createBufferSource();
    src.buffer = buffer;

    const filter = ctx.createBiquadFilter();
    filter.type = options.filterType;
    filter.frequency.setValueAtTime(options.freq, now);
    if (options.q !== undefined) {
      filter.Q.setValueAtTime(options.q, now);
    }

    const g = ctx.createGain();
    g.gain.setValueAtTime(options.gain, now);
    g.gain.exponentialRampToValueAtTime(0.0001, now + options.duration);

    src.connect(filter);
    filter.connect(g);
    g.connect(ctx.destination);
    src.start(now);
    src.stop(now + options.duration + 0.01);
  }

  /** 牌をタップして選択したときの軽いクリック音 */
  playSelect(): void {
    this.runWithDelay(0, (ctx) => {
      this.playNoiseBurst(ctx, {
        filterType: 'bandpass',
        freq: 2600,
        q: 2.2,
        duration: 0.028,
        gain: 0.09,
      });
      this.playTone(ctx, {
        type: 'sine',
        freqStart: 640,
        freqEnd: 420,
        duration: 0.032,
        gain: 0.05,
      });
    });
  }

  /** 山からツモったときの軽く滑らかな牌擦れ音 */
  playDraw(delayMs = 90): void {
    this.runWithDelay(delayMs, (ctx) => {
      this.playNoiseBurst(ctx, {
        filterType: 'bandpass',
        freq: 1900,
        q: 1.4,
        duration: 0.055,
        gain: 0.06,
      });
      this.playTone(ctx, {
        type: 'triangle',
        freqStart: 320,
        freqEnd: 220,
        startOffset: 0.035,
        duration: 0.04,
        gain: 0.045,
      });
    });
  }

  /** 河に牌をパチッと置く音（着地アニメに合わせてデフォルト ~195ms 後） */
  playDiscard(delayMs = 195): void {
    this.runWithDelay(delayMs, (ctx) => {
      // 硬質な牌の衝撃（パチッ）
      this.playNoiseBurst(ctx, {
        filterType: 'bandpass',
        freq: 2250,
        q: 1.9,
        duration: 0.045,
        gain: 0.22,
      });
      // 卓マットの軽い胴鳴り（コツン）
      this.playTone(ctx, {
        type: 'triangle',
        freqStart: 250,
        freqEnd: 88,
        duration: 0.065,
        gain: 0.16,
      });
      this.playTone(ctx, {
        type: 'sine',
        freqStart: 920,
        freqEnd: 460,
        duration: 0.028,
        gain: 0.07,
      });
    });
  }

  /** リーチ宣言音（鋭い打牌音＋リーチ告知ベル＋点棒を置く音） */
  playRiichi(delayMs = 160): void {
    this.runWithDelay(0, (ctx) => {
      // 宣告アクセント
      this.playTone(ctx, {
        type: 'triangle',
        freqStart: 784,
        freqEnd: 1175,
        duration: 0.16,
        gain: 0.12,
      });
      this.playTone(ctx, {
        type: 'sine',
        freqStart: 1568,
        duration: 0.28,
        startOffset: 0.05,
        gain: 0.08,
      });
    });
    // 着地にあわせた強い打牌音＋点棒配置
    this.runWithDelay(delayMs, (ctx) => {
      this.playNoiseBurst(ctx, {
        filterType: 'bandpass',
        freq: 2500,
        q: 2.1,
        duration: 0.052,
        gain: 0.26,
      });
      this.playTone(ctx, {
        type: 'triangle',
        freqStart: 290,
        freqEnd: 92,
        duration: 0.075,
        gain: 0.19,
      });
      // 千点棒を置く軽い音
      this.playTone(ctx, {
        type: 'sine',
        freqStart: 1420,
        freqEnd: 980,
        startOffset: 0.12,
        duration: 0.05,
        gain: 0.07,
      });
    });
  }

  /** ポン・チー・カンの鳴き音 */
  playMeld(): void {
    this.runWithDelay(0, (ctx) => {
      this.playNoiseBurst(ctx, {
        filterType: 'bandpass',
        freq: 2900,
        q: 2.4,
        duration: 0.04,
        gain: 0.18,
      });
      this.playTone(ctx, {
        type: 'triangle',
        freqStart: 440,
        freqEnd: 220,
        duration: 0.06,
        gain: 0.14,
      });
      this.playTone(ctx, {
        type: 'sine',
        freqStart: 880,
        freqEnd: 660,
        startOffset: 0.06,
        duration: 0.11,
        gain: 0.09,
      });
    });
  }

  /** ドラ表示牌がめくられる音 */
  playDoraFlip(): void {
    this.runWithDelay(70, (ctx) => {
      this.playNoiseBurst(ctx, {
        filterType: 'highpass',
        freq: 3200,
        duration: 0.04,
        gain: 0.08,
      });
      this.playTone(ctx, {
        type: 'sine',
        freqStart: 1046,
        freqEnd: 1318,
        duration: 0.14,
        gain: 0.08,
      });
    });
  }

  /** ロン和了時の重厚な衝撃＋和風ファンファーレ音 */
  playRon(
    options: {
      ronCount?: number;
      isYakuman?: boolean;
      isHighHand?: boolean;
    } = {},
  ): void {
    const ronCount = options.ronCount ?? 1;
    const isHeavy =
      ronCount >= 2 || Boolean(options.isYakuman) || Boolean(options.isHighHand);

    this.runWithDelay(0, (ctx) => {
      // 1. 稲妻・斬撃の鋭い衝撃アタック（ドンッ＋バシィッ）
      this.playTone(ctx, {
        type: 'sine',
        freqStart: 138,
        freqEnd: 42,
        duration: 0.26,
        gain: 0.25,
      });
      this.playNoiseBurst(ctx, {
        filterType: 'bandpass',
        freq: 3300,
        q: 1.5,
        duration: 0.085,
        gain: 0.26,
      });
      this.playTone(ctx, {
        type: 'triangle',
        freqStart: 1760,
        freqEnd: 880,
        duration: 0.09,
        gain: 0.13,
      });

      // 2. 決着の力強い和了ファンファーレ和音
      const baseNotes = isHeavy
        ? [587.33, 739.99, 880, 1174.66, 1479.98]
        : [587.33, 783.99, 987.77, 1174.66];
      baseNotes.forEach((freq, idx) => {
        const isLast = idx === baseNotes.length - 1;
        this.playTone(ctx, {
          type: isLast ? 'triangle' : 'sine',
          freqStart: freq,
          startOffset: 0.12 + idx * 0.062,
          duration: isLast ? 0.56 : 0.22,
          gain: isLast ? 0.14 : 0.11,
        });
      });

      if (ronCount >= 2 || options.isYakuman) {
        // ダブロン・役満時の厚いオクターブ下支え
        this.playTone(ctx, {
          type: 'triangle',
          freqStart: 293.66,
          startOffset: 0.18,
          duration: 0.52,
          gain: 0.12,
        });
      }
    });
  }

  /** ロン・ツモ和了音 */
  playAgari(isTsumo: boolean): void {
    this.runWithDelay(0, (ctx) => {
      // 重厚な和風アクセント
      this.playNoiseBurst(ctx, {
        filterType: 'bandpass',
        freq: 2400,
        q: 1.8,
        duration: 0.06,
        gain: 0.22,
      });
      const notes = isTsumo
        ? [523.25, 659.25, 783.99, 1046.5]
        : [587.33, 783.99, 987.77, 1174.66];
      notes.forEach((freq, idx) => {
        this.playTone(ctx, {
          type: idx === notes.length - 1 ? 'triangle' : 'sine',
          freqStart: freq,
          startOffset: idx * 0.075,
          duration: idx === notes.length - 1 ? 0.45 : 0.19,
          gain: idx === notes.length - 1 ? 0.13 : 0.1,
        });
      });
    });
  }

  /** 流局音 */
  playDrawRound(): void {
    this.runWithDelay(0, (ctx) => {
      this.playTone(ctx, {
        type: 'triangle',
        freqStart: 392,
        freqEnd: 330,
        duration: 0.22,
        gain: 0.1,
      });
      this.playTone(ctx, {
        type: 'sine',
        freqStart: 293.66,
        startOffset: 0.12,
        duration: 0.28,
        gain: 0.08,
      });
    });
  }

  /** 局開始の合図音 */
  playRoundStart(): void {
    this.runWithDelay(0, (ctx) => {
      this.playTone(ctx, {
        type: 'sine',
        freqStart: 196,
        freqEnd: 110,
        duration: 0.18,
        gain: 0.11,
      });
      this.playTone(ctx, {
        type: 'triangle',
        freqStart: 587.33,
        startOffset: 0.04,
        duration: 0.16,
        gain: 0.06,
      });
    });
  }
}

export const soundEngine = new MahjongSoundEngine();
