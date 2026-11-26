import './ui/styles.css';
import './ui/refine.css';
import { isCpuPlayerId } from './cpu/player';
import {
  ClientSession,
  type ClientSessionCallbacks,
  type PromoteFromCheckpointParams,
} from './net/client';
import { HostSession, type HostSessionCallbacks } from './net/host';
import { normalizeRoomCode } from './net/protocol';
import {
  PermanentRoomWatcher,
  type PermanentRoomProbeState,
} from './net/roomProbe';
import {
  getPermanentRoom,
  type PermanentRoomId,
} from './net/rooms';
import {
  clearSavedSessionRecord,
  loadSavedSessionRecord,
  saveSessionRecord,
  type SavedSessionRecord,
} from './net/storage';
import type {
  ChangeHistoryCategory,
  ChangeHistoryEntry,
  ChatMessage,
  GameError,
  HostSnapshotPayload,
  StateView,
} from './types/message';
import { DEFAULT_CPU_LEVEL, type RuleConfig } from './types/rule';
import {
  renderLobbyEntry,
  renderPermanentRoomOccupancy,
  renderWaitingRoom,
  type LobbyFormState,
} from './ui/lobbyView';
import {
  captureDiscardOriginSnapshot,
  destroyTable3DScene,
  renderGameTable,
  resetTable3DCamera,
  type DiscardOriginSnapshot,
  type RoundEndStep,
  type SeatChatBubble,
  type Table3DCameraPreset,
} from './ui/tableView';
import { soundEngine } from './ui/sound';
import { prewarmTileSpriteSheet, waitForTileFonts } from './ui/tileTexture';
import {
  isCheatModalCommand,
  isCheckModalCommand,
  isStopCheatCommand,
  type LocalLuckMode,
} from './ui/chatCommands';
import {
  createRotateOverlay,
  enterLandscapeFullscreen,
  exitLandscapeFullscreen,
  isFullscreenActive,
  shouldBlockForOrientation,
  watchOrientation,
} from './ui/orientation';

type Session =
  | { role: 'host'; session: HostSession }
  | { role: 'client'; session: ClientSession };

interface WakeLockSentinelLike {
  released?: boolean;
  release(): Promise<void>;
  addEventListener?: (type: 'release', listener: () => void) => void;
}

const CHAT_BUBBLE_DURATION_MS = 4200;
const LOBBY_CHAT_TOAST_DURATION_MS = 4200;
const PREF_3D_TABLE_KEY = 'mahjong_3d_table_enabled';
const PREF_3D_CAMERA_KEY = 'mahjong_3d_camera_preset';

function load3dTablePreference(): boolean {
  try {
    const raw = localStorage.getItem(PREF_3D_TABLE_KEY);
    if (raw === '0' || raw === 'false') return false;
    return true;
  } catch {
    return true;
  }
}

function save3dTablePreference(enabled: boolean): void {
  try {
    localStorage.setItem(PREF_3D_TABLE_KEY, enabled ? '1' : '0');
  } catch {
    // ignore storage errors
  }
}

function load3dCameraPreference(): Table3DCameraPreset {
  try {
    const raw = localStorage.getItem(PREF_3D_CAMERA_KEY);
    if (raw === 'high' || raw === 'low' || raw === 'standard') return raw;
    return 'standard';
  } catch {
    return 'standard';
  }
}

function save3dCameraPreference(preset: Table3DCameraPreset): void {
  try {
    localStorage.setItem(PREF_3D_CAMERA_KEY, preset);
  } catch {
    // ignore storage errors
  }
}

interface ActiveChatBubbleEntry {
  message: ChatMessage;
  timer: ReturnType<typeof setTimeout>;
}

interface LobbyChatToastEntry {
  message: ChatMessage;
  timer: ReturnType<typeof setTimeout>;
}

class MahjongApp {
  private readonly root: HTMLElement;
  private readonly mainLayer: HTMLElement;
  private readonly chatToastLayer: HTMLElement;
  private readonly floatingLayer: HTMLElement;
  private gameShell: HTMLElement | null = null;
  private gameContent: HTMLElement | null = null;
  private cleaningUpSession = false;
  private sessionSeq = 0;
  private activeSession: Session | null = null;
  private currentView: StateView | null = null;
  private lastRenderedGameView: StateView | null = null;
  private lastRenderedPerspectiveSeatIndex = 0;
  private errorBanner: string | null = null;
  private busy = false;
  private actionInFlight = false;
  private riichiSelectingMode = false;
  private selectedDiscardTileId: string | null = null;
  private roundEndStep: RoundEndStep = 'details';
  private leaveConfirmPending = false;
  private settingsOpen = false;
  private cheatOpen = false;
  private checkOpen = false;
  private chatOpen = false;
  private chatPinnedToBottom = true;
  private chatAutoScrollCleanup: (() => void) | null = null;
  private chatMessages: ChatMessage[] = [];
  private changeHistory: ChangeHistoryEntry[] = [];
  private checkActorFilter: 'all' | 'others' = 'all';
  private checkCategoryFilter: 'all' | ChangeHistoryCategory = 'all';
  private secretPeekEnabled = false;
  private secretLuckByPlayer: Record<string, LocalLuckMode> = {};
  private unreadChatCount = 0;
  private chatDraft = '';
  private chatBubbles = new Map<string, ActiveChatBubbleEntry>();
  private animatedBubbleIds = new Set<string>();
  private lobbyChatToast: LobbyChatToastEntry | null = null;
  private fullscreenError: string | null = null;
  private autoTsumogiriEnabled = true;
  private autoAgariEnabled = false;
  private autoNoCallEnabled = false;
  private table3dEnabled = load3dTablePreference();
  private table3dCameraPreset: Table3DCameraPreset = load3dCameraPreference();
  private autoTsumogiriTimerId: ReturnType<typeof setTimeout> | null = null;
  private autoAssistTimerId: ReturnType<typeof setTimeout> | null = null;
  private countdownDeadline: number | null = null;
  private countdownTimerId: ReturnType<typeof setInterval> | null = null;
  private savedSession: SavedSessionRecord | null = null;
  private perspectiveSeatIndex = 0;
  private wakeLockSentinel: WakeLockSentinelLike | null = null;
  private wakeLockSyncSeq = 0;
  private hostTabWarning = false;
  private hostAway = false;
  private roomWatcher: PermanentRoomWatcher | null = null;
  private roomStatuses: Record<PermanentRoomId, PermanentRoomProbeState> = {
    BRONZE: { status: 'checking' },
    SILVER: { status: 'checking' },
    GOLD: { status: 'checking' },
  };
  private roomProbeRefreshing = false;
  private readonly handleFullscreenChange = () => {
    if (!this.root.isConnected) {
      document.removeEventListener('fullscreenchange', this.handleFullscreenChange);
      document.removeEventListener(
        'webkitfullscreenchange',
        this.handleFullscreenChange,
      );
      return;
    }
    this.syncOrientationOverlay();
    if (this.settingsOpen) {
      this.renderFloating();
    }
  };
  private readonly handleVisibilityChange = () => {
    if (!this.root.isConnected) {
      document.removeEventListener('visibilitychange', this.handleVisibilityChange);
      return;
    }
    const hidden = document.visibilityState === 'hidden';
    if (this.activeSession?.role === 'host') {
      const activeRoom =
        this.currentView !== null &&
        this.currentView.phase !== 'finished' &&
        (this.currentView.phase !== 'lobby' ||
          !this.activeSession.session.isOffline());
      this.hostTabWarning = hidden && activeRoom;
      this.activeSession.session.setHostAway(hidden);
      this.render();
    } else if (!hidden && !this.currentView && !this.busy) {
      this.roomWatcher?.refreshNow();
    }
    void this.syncWakeLock();
  };

  private readonly formState: LobbyFormState;
  /** 牌面スプライトシートの準備完了後に一度だけ再描画するためのフラグ */
  private tileFacesRefreshed = false;

  /**
   * 牌面スプライトシートの準備ができたタイミングで画面を作り直す。
   * 初回描画がテキスト牌で行われていても、ここで画像牌に差し替わる。
   */
  refreshTileFaces(): void {
    if (this.tileFacesRefreshed) return;
    this.tileFacesRefreshed = true;
    this.render();
  }

  constructor(root: HTMLElement) {
    this.root = root;
    this.mainLayer = document.createElement('div');
    this.mainLayer.className = 'app-main-layer';
    this.chatToastLayer = document.createElement('div');
    this.chatToastLayer.className = 'lobby-chat-toast-layer';
    this.floatingLayer = document.createElement('div');
    this.floatingLayer.className = 'app-floating-layer';
    this.root.innerHTML = '';
    this.root.append(this.mainLayer, this.chatToastLayer, this.floatingLayer);

    const params = new URLSearchParams(window.location.search);
    const roomFromUrl = params.get('room') ?? '';

    this.formState = {
      playerName: '',
      playerCount: 4,
      gameLength: 'tonpuu',
      tobi: true,
      tsumoLoss: false,
      allowKuitan: true,
      allowAtozuke: true,
      honbaBonus: true,
      joinCode: normalizeRoomCode(roomFromUrl),
      cpuCount: 0,
      cpuLevel: DEFAULT_CPU_LEVEL,
    };

    window.addEventListener('beforeunload', () => {
      this.stopRoomWatcher();
      this.cleanupSession();
    });
    document.addEventListener('fullscreenchange', this.handleFullscreenChange);
    document.addEventListener(
      'webkitfullscreenchange',
      this.handleFullscreenChange,
    );
    document.addEventListener('visibilitychange', this.handleVisibilityChange);

    const unlockAudioOnInteract = () => {
      soundEngine.unlock();
      if (!this.root.isConnected) {
        document.removeEventListener('pointerdown', unlockAudioOnInteract);
        document.removeEventListener('keydown', unlockAudioOnInteract);
      }
    };
    document.addEventListener('pointerdown', unlockAudioOnInteract, {
      passive: true,
    });
    document.addEventListener('keydown', unlockAudioOnInteract, {
      passive: true,
    });

    // 対局画面では横画面を必須にする（縦持ち時はローテーション案内で覆う）
    watchOrientation(() => this.syncOrientationOverlay());

    this.savedSession = loadSavedSessionRecord();
    this.render();
  }

  private buildHostCallbacks(
    getHost: () => HostSession,
    sessionSeq: number,
    options: { fixedRoomCode?: string } = {},
  ): HostSessionCallbacks {
    return {
      onViewChange: (view) => {
        if (sessionSeq !== this.sessionSeq) return;
        this.busy = false;
        this.actionInFlight = false;
        this.applyStateView(view);
      },
      onStatusChange: (status, detail) => {
        if (this.cleaningUpSession || sessionSeq !== this.sessionSeq) return;
        if (status === 'ready') {
          this.busy = false;
        } else if (status === 'error') {
          this.busy = false;
          this.errorBanner = detail ?? 'PeerJS接続エラーが発生しました。';
        } else if (status === 'closed') {
          this.busy = false;
        }
        this.render();
      },
      onError: (err) => {
        if (sessionSeq !== this.sessionSeq) return;
        this.handleGameError(err);
      },
      onChatMessage: (message) => {
        if (sessionSeq !== this.sessionSeq) return;
        this.handleIncomingChat(message);
      },
      onChatHistory: (messages) => {
        if (sessionSeq !== this.sessionSeq) return;
        this.handleChatHistory(messages);
      },
      onChangeHistory: (history) => {
        if (sessionSeq !== this.sessionSeq) return;
        this.changeHistory = [...history];
        if (this.checkOpen) {
          this.renderFloating();
        }
      },
      onSecretState: (secretState) => {
        if (sessionSeq !== this.sessionSeq) return;
        this.secretPeekEnabled = secretState.peek;
        this.secretLuckByPlayer = { ...secretState.luckByPlayer };
        if (this.cheatOpen) {
          this.renderFloating();
        }
      },
      onWelcome: (welcome) => {
        if (sessionSeq !== this.sessionSeq) return;
        const host = getHost();
        if (host.isOffline()) return;
        const record: SavedSessionRecord = {
          roomCode: welcome.roomCode,
          hostPeerId: welcome.hostPeerId,
          hostEpoch: welcome.hostEpoch,
          playerId: welcome.playerId,
          playerName: welcome.playerName,
          reconnectToken: welcome.reconnectToken,
          isSpectator: false,
          updatedAt: Date.now(),
        };
        this.savedSession = record;
        saveSessionRecord(record);
      },
      onPermanentRoomClaimConflict: (roomCode) => {
        if (sessionSeq !== this.sessionSeq) return;
        if (options.fixedRoomCode && roomCode === options.fixedRoomCode) {
          this.joinRoom(roomCode, this.formState.playerName);
        }
      },
      onHostSelfDemoted: (migration, localToken, localPlayerId) => {
        if (sessionSeq !== this.sessionSeq) return;
        this.transitionToClientAfterHandover(
          migration.roomCode,
          this.currentView?.players.find((p) => p.playerId === localPlayerId)
            ?.name ?? this.formState.playerName,
          localToken,
          migration.hostEpoch,
          migration.newHostPeerId,
        );
      },
    };
  }

  private buildClientCallbacks(
    _roomCode: string,
    sessionSeq: number,
  ): ClientSessionCallbacks {
    return {
      onViewChange: (view) => {
        if (sessionSeq !== this.sessionSeq) return;
        this.busy = false;
        this.actionInFlight = false;
        this.applyStateView(view);
      },
      onStatusChange: (status, detail) => {
        if (this.cleaningUpSession || sessionSeq !== this.sessionSeq) return;
        if (status === 'connected') {
          this.busy = false;
        } else if (status === 'error' || status === 'disconnected') {
          this.busy = false;
          this.errorBanner = detail ?? '接続が切断されました。';
        }
        this.render();
      },
      onError: (err) => {
        if (sessionSeq !== this.sessionSeq) return;
        this.handleGameError(err);
      },
      onChatMessage: (message) => {
        if (sessionSeq !== this.sessionSeq) return;
        this.handleIncomingChat(message);
      },
      onChatHistory: (messages) => {
        if (sessionSeq !== this.sessionSeq) return;
        this.handleChatHistory(messages);
      },
      onWelcome: (welcome) => {
        if (sessionSeq !== this.sessionSeq) return;
        const record: SavedSessionRecord = {
          roomCode: welcome.roomCode,
          hostPeerId: welcome.hostPeerId,
          hostEpoch: welcome.hostEpoch,
          playerId: welcome.playerId,
          playerName: welcome.playerName,
          reconnectToken: welcome.reconnectToken,
          isSpectator: welcome.isSpectator,
          updatedAt: Date.now(),
        };
        this.savedSession = record;
        saveSessionRecord(record);
      },
      onMigrated: (migration) => {
        if (sessionSeq !== this.sessionSeq) return;
        if (this.savedSession && this.savedSession.roomCode === migration.roomCode) {
          this.savedSession = {
            ...this.savedSession,
            hostEpoch: migration.hostEpoch,
            hostPeerId: migration.newHostPeerId,
            updatedAt: Date.now(),
          };
          saveSessionRecord(this.savedSession);
        }
      },
      onHostHandover: (snapshot) => {
        if (sessionSeq !== this.sessionSeq) return;
        this.promoteToHostFromSnapshot(snapshot);
      },
      onPromoteFromCheckpoint: (params) => {
        if (sessionSeq !== this.sessionSeq) return;
        this.promoteToHostFromCheckpoint(params);
      },
      onHostAwayChange: (away) => {
        if (sessionSeq !== this.sessionSeq) return;
        if (this.hostAway !== away) {
          this.hostAway = away;
          this.render();
        }
      },
      onSecretState: (secretState) => {
        if (sessionSeq !== this.sessionSeq) return;
        this.secretPeekEnabled = secretState.peek;
        this.secretLuckByPlayer = { ...secretState.luckByPlayer };
        if (this.cheatOpen) {
          this.renderFloating();
        }
      },
      onChangeHistory: (history) => {
        if (sessionSeq !== this.sessionSeq) return;
        this.changeHistory = [...history];
        if (this.checkOpen) {
          this.renderFloating();
        }
      },
    };
  }

  private createRoom(
    playerName: string,
    ruleConfig: RuleConfig,
    cpuCount = 0,
    offline = false,
    autoStart = false,
    fixedRoomCode?: string,
  ): void {
    this.cleanupSession();
    this.busy = true;
    this.errorBanner = null;
    this.render();

    const sessionSeq = ++this.sessionSeq;
    let host!: HostSession;
    host = new HostSession(
      playerName,
      ruleConfig,
      this.buildHostCallbacks(() => host, sessionSeq, { fixedRoomCode }),
      {
        cpuCount,
        cpuDelayMs: 650,
        offline,
        autoStart,
        fixedRoomCode,
      },
    );

    this.activeSession = { role: 'host', session: host };
    host.start();
  }

  /** 常設ルーム（銅・銀・金の間）への入室（既存部屋があれば参加/観戦、無人なら自動で立卓） */
  private joinPermanentRoom(roomId: PermanentRoomId, playerName: string): void {
    const def = getPermanentRoom(roomId);
    if (!def) return;

    const matchingSaved =
      this.savedSession && this.savedSession.roomCode === roomId
        ? this.savedSession
        : null;

    this.cleanupSession();
    this.busy = true;
    this.errorBanner = null;
    this.render();

    const sessionSeq = ++this.sessionSeq;
    const baseCallbacks = this.buildClientCallbacks(roomId, sessionSeq);
    const client = new ClientSession(
      roomId,
      playerName,
      {
        ...baseCallbacks,
        onNoHostAvailable: () => {
          if (sessionSeq !== this.sessionSeq) return;
          this.createRoom(
            playerName,
            { ...def.defaultRuleConfig },
            0,
            false,
            false,
            roomId,
          );
        },
      },
      {
        connectTimeoutMs: 4500,
        ...(matchingSaved
          ? {
              reconnectToken: matchingSaved.reconnectToken,
              initialHostEpoch: matchingSaved.hostEpoch,
              initialHostPeerId: matchingSaved.hostPeerId,
              preferSpectate: matchingSaved.isSpectator,
            }
          : {}),
      },
    );

    this.activeSession = { role: 'client', session: client };
    client.connect();
  }

  /** 保存されたセッション情報を使って再接続する */
  private reconnectSavedSession(): void {
    const saved = this.savedSession;
    if (!saved) return;
    this.joinRoom(saved.roomCode, saved.playerName, {
      reconnectToken: saved.reconnectToken,
      initialHostEpoch: saved.hostEpoch,
      initialHostPeerId: saved.hostPeerId,
      preferSpectate: saved.isSpectator,
    });
  }

  private discardSavedSession(): void {
    clearSavedSessionRecord();
    this.savedSession = null;
    this.render();
  }

  private promoteToHostFromSnapshot(snapshot: HostSnapshotPayload): void {
    this.activeSession = null;
    this.busy = false;
    this.errorBanner = null;
    const hostName =
      snapshot.state.players.find(
        (p) => p.playerId === snapshot.state.hostPlayerId,
      )?.name ?? 'ホスト';

    const sessionSeq = ++this.sessionSeq;
    let host!: HostSession;
    host = new HostSession(
      hostName,
      snapshot.state.ruleConfig,
      this.buildHostCallbacks(() => host, sessionSeq),
      {
        cpuDelayMs: 650,
        initialSnapshot: snapshot,
      },
    );

    this.activeSession = { role: 'host', session: host };
    if (this.secretPeekEnabled) host.setSecretPeek(true);
    for (const [pid, mode] of Object.entries(this.secretLuckByPlayer)) {
      if (mode !== 'normal') host.setSecretLuck(mode, pid);
    }
    this.changeHistory = host.getChangeHistory();
    host.start();
    if (this.checkOpen) {
      this.renderFloating();
    }
  }

  private promoteToHostFromCheckpoint(params: PromoteFromCheckpointParams): void {
    this.activeSession = null;
    this.busy = false;
    this.errorBanner = null;
    const hostName =
      params.latestView.players.find((p) => p.playerId === params.myPlayerId)
        ?.name ?? 'ホスト';

    const sessionSeq = ++this.sessionSeq;
    let host!: HostSession;
    host = new HostSession(
      hostName,
      params.latestView.ruleConfig,
      this.buildHostCallbacks(() => host, sessionSeq),
      {
        cpuDelayMs: 650,
        pendingTakeover: {
          hostEpoch: params.hostEpoch,
          seq: params.checkpoint.seq,
          ivBase64: params.checkpoint.ivBase64,
          ciphertextBase64: params.checkpoint.ciphertextBase64,
          localPlayerId: params.myPlayerId,
          localReconnectToken: params.myReconnectToken,
          fallbackView: {
            ...params.latestView,
            hostPlayerId: params.myPlayerId,
            hostEpoch: params.hostEpoch,
          },
          initialKeyBase64: params.initialKeyBase64,
        },
      },
    );

    this.activeSession = { role: 'host', session: host };
    if (this.secretPeekEnabled) host.setSecretPeek(true);
    for (const [pid, mode] of Object.entries(this.secretLuckByPlayer)) {
      if (mode !== 'normal') host.setSecretLuck(mode, pid);
    }
    host.start();
  }

  private transitionToClientAfterHandover(
    roomCode: string,
    playerName: string,
    reconnectToken: string,
    hostEpoch: number,
    hostPeerId: string,
  ): void {
    this.activeSession = null;
    this.busy = true;
    const sessionSeq = ++this.sessionSeq;
    const client = new ClientSession(
      roomCode,
      playerName,
      this.buildClientCallbacks(roomCode, sessionSeq),
      {
        reconnectToken,
        initialHostEpoch: hostEpoch,
        initialHostPeerId: hostPeerId,
      },
    );
    this.activeSession = { role: 'client', session: client };
    client.connect();
  }

  /** 通信なしの CPU 対局を開始する */
  private startLocalGame(
    playerName: string,
    ruleConfig: RuleConfig,
    cpuCount: number,
  ): void {
    this.createRoom(playerName, ruleConfig, cpuCount, true, true);
  }

  /** ロビーに CPU を後から追加する（ホストの HostSession のみ） */
  private addCpuToLobby(): void {
    if (this.activeSession?.role !== 'host') {
      this.errorBanner = 'CPU を追加できるのは部屋のホストだけです。';
      this.render();
      return;
    }
    if (!this.activeSession.session.addCpu()) {
      this.errorBanner = 'CPU を追加できませんでした（席が埋まっているか対局中です）。';
    }
    this.render();
  }

  /** ロビーから CPU を減らす */
  private removeCpuFromLobby(targetPlayerId?: string): void {
    if (this.activeSession?.role !== 'host') return;
    this.activeSession.session.removeCpu(targetPlayerId);
    this.render();
  }

  /** ルーム作成後にホストがルール設定を更新する */
  private updateLobbyRules(patch: Partial<RuleConfig>): void {
    if (this.activeSession?.role !== 'host') return;
    if (patch.playerCount !== undefined) this.formState.playerCount = patch.playerCount;
    if (patch.gameLength !== undefined) this.formState.gameLength = patch.gameLength;
    if (patch.tobi !== undefined) this.formState.tobi = patch.tobi;
    if (patch.tsumoLoss !== undefined) this.formState.tsumoLoss = patch.tsumoLoss;
    if (patch.allowKuitan !== undefined) this.formState.allowKuitan = patch.allowKuitan;
    if (patch.allowAtozuke !== undefined) this.formState.allowAtozuke = patch.allowAtozuke;
    if (patch.honbaBonus !== undefined) this.formState.honbaBonus = patch.honbaBonus;
    if (patch.cpuLevel !== undefined) this.formState.cpuLevel = patch.cpuLevel;
    this.activeSession.session.updateRuleConfig(patch);
  }

  /** 人数が揃った待機ロビーから対局を開始する */
  private startLobbyGame(): void {
    if (this.activeSession?.role !== 'host') return;
    this.activeSession.session.startGame();
  }

  private transferHostAndStay(targetPlayerId: string): void {
    if (this.activeSession?.role !== 'host') return;
    this.activeSession.session.transferHost(targetPlayerId, {
      stayAsClient: true,
    });
  }

  private transferHostAndLeave(): void {
    if (this.activeSession?.role === 'host') {
      this.activeSession.session.transferHost(undefined, {
        stayAsClient: false,
      });
    }
    this.returnToLobby({ skipTransfer: true });
  }

  private joinRoom(
    roomCode: string,
    playerName: string,
    overrides?: {
      reconnectToken?: string;
      initialHostEpoch?: number;
      initialHostPeerId?: string;
      preferSpectate?: boolean;
    },
  ): void {
    const normalized = normalizeRoomCode(roomCode);
    if (normalized.length === 0) {
      this.errorBanner = '部屋コードを入力してください。';
      this.render();
      return;
    }

    const matchingSaved =
      !overrides &&
      this.savedSession &&
      this.savedSession.roomCode === normalized
        ? this.savedSession
        : null;

    this.cleanupSession();
    this.busy = true;
    this.errorBanner = null;
    this.render();

    const sessionSeq = ++this.sessionSeq;
    const client = new ClientSession(
      normalized,
      playerName,
      this.buildClientCallbacks(normalized, sessionSeq),
      overrides ??
        (matchingSaved
          ? {
              reconnectToken: matchingSaved.reconnectToken,
              initialHostEpoch: matchingSaved.hostEpoch,
              initialHostPeerId: matchingSaved.hostPeerId,
              preferSpectate: matchingSaved.isSpectator,
            }
          : {}),
    );

    this.activeSession = { role: 'client', session: client };
    client.connect();
  }

  private applyStateView(view: StateView): void {
    const prevView = this.currentView;
    this.stopAutoTsumogiriTimer();
    this.stopAutoAssistTimer();
    this.riichiSelectingMode = false;
    this.selectedDiscardTileId = null;
    if (
      view.phase !== 'round_end' ||
      prevView?.phase !== 'round_end' ||
      prevView.round?.roundIndex !== view.round?.roundIndex
    ) {
      this.roundEndStep = 'details';
    }
    this.currentView = view;
    if (prevView?.phase === 'lobby' && view.phase !== 'lobby') {
      this.clearLobbyChatToast();
      if (this.cheatOpen || this.checkOpen) {
        this.cheatOpen = false;
        this.closeCheckModal();
        this.renderFloating();
      }
    } else if (view.phase === 'lobby') {
      this.leaveConfirmPending = false;
      if (prevView && prevView.phase !== 'lobby') {
        this.clearChatBubbles();
        this.settingsOpen = false;
        this.cheatOpen = false;
        this.closeCheckModal();
        this.renderFloating();
      }
    }
    if (
      (this.cheatOpen || this.checkOpen) &&
      (prevView?.isSpectator !== view.isSpectator ||
        prevView?.players.map((p) => p.playerId).join(',') !==
          view.players.map((p) => p.playerId).join(','))
    ) {
      this.renderFloating();
    }
    if (
      view.phase === 'awaiting_responses' &&
      view.myCallOptions !== null &&
      view.responseRemainingMs !== null
    ) {
      this.countdownDeadline = Date.now() + view.responseRemainingMs;
      this.startCountdownTicker();
    } else {
      this.stopCountdownTicker();
    }
    this.scheduleAutoAssistIfNeeded(view);
    this.scheduleAutoTsumogiriIfNeeded(view);
    void this.syncWakeLock();
    this.render();
  }

  private scheduleAutoAssistIfNeeded(view: StateView): void {
    if (!this.activeSession || this.actionInFlight || view.isSpectator) return;
    if (this.autoAgariEnabled) {
      if (view.phase === 'awaiting_responses' && view.myCallOptions?.canRon) {
        this.autoAssistTimerId = setTimeout(() => {
          this.autoAssistTimerId = null;
          if (
            !this.autoAgariEnabled ||
            !this.activeSession ||
            this.actionInFlight ||
            this.currentView !== view
          ) {
            return;
          }
          this.dispatchAction((s) => s.respondToCall({ type: 'ron' }));
        }, 200);
        return;
      }
      const selfPlayer = view.players.find(
        (p) => p.seatIndex === view.viewerSeatIndex,
      );
      if (
        view.phase === 'playing' &&
        selfPlayer?.isCurrentTurn &&
        view.mySelfActions?.canTsumo
      ) {
        this.autoAssistTimerId = setTimeout(() => {
          this.autoAssistTimerId = null;
          if (
            !this.autoAgariEnabled ||
            !this.activeSession ||
            this.actionInFlight ||
            this.currentView !== view
          ) {
            return;
          }
          this.dispatchAction((s) => s.declareTsumo());
        }, 200);
        return;
      }
    }
    if (
      this.autoNoCallEnabled &&
      view.phase === 'awaiting_responses' &&
      view.myCallOptions !== null &&
      !view.myCallOptions.canRon
    ) {
      this.autoAssistTimerId = setTimeout(() => {
        this.autoAssistTimerId = null;
        if (
          !this.autoNoCallEnabled ||
          !this.activeSession ||
          this.actionInFlight ||
          this.currentView !== view
        ) {
          return;
        }
        this.dispatchAction((s) => s.respondToCall({ type: 'pass' }));
      }, 180);
    }
  }

  private stopAutoAssistTimer(): void {
    if (this.autoAssistTimerId !== null) {
      clearTimeout(this.autoAssistTimerId);
      this.autoAssistTimerId = null;
    }
  }

  private scheduleAutoTsumogiriIfNeeded(view: StateView): void {
    if (
      !this.autoTsumogiriEnabled ||
      !this.activeSession ||
      this.actionInFlight ||
      view.isSpectator
    ) {
      return;
    }
    if (view.phase !== 'playing') return;
    const selfPlayer = view.players.find(
      (p) => p.seatIndex === view.viewerSeatIndex,
    );
    if (!selfPlayer?.isCurrentTurn || !selfPlayer.isRiichi) return;
    if (!view.myDrawnTile) return;
    const actions = view.mySelfActions;
    if (
      actions?.canTsumo ||
      (actions?.canAnkanKinds.length ?? 0) > 0 ||
      (actions?.canKitaTileIds.length ?? 0) > 0
    ) {
      return;
    }
    const drawnId = view.myDrawnTile.id;
    this.autoTsumogiriTimerId = setTimeout(() => {
      this.autoTsumogiriTimerId = null;
      if (
        !this.autoTsumogiriEnabled ||
        !this.activeSession ||
        this.actionInFlight ||
        this.currentView !== view
      ) {
        return;
      }
      this.dispatchAction((s) => s.discardTile(drawnId));
    }, 450);
  }

  private stopAutoTsumogiriTimer(): void {
    if (this.autoTsumogiriTimerId !== null) {
      clearTimeout(this.autoTsumogiriTimerId);
      this.autoTsumogiriTimerId = null;
    }
  }

  private startCountdownTicker(): void {
    if (this.countdownTimerId !== null) return;
    this.countdownTimerId = setInterval(() => {
      if (this.countdownDeadline === null) return;
      const secs = Math.max(
        0,
        Math.ceil((this.countdownDeadline - Date.now()) / 1000),
      );
      const nodes = this.root.querySelectorAll('[data-countdown-ms]');
      nodes.forEach((node) => {
        node.textContent = String(secs);
      });
    }, 250);
  }

  private stopCountdownTicker(): void {
    this.countdownDeadline = null;
    if (this.countdownTimerId !== null) {
      clearInterval(this.countdownTimerId);
      this.countdownTimerId = null;
    }
  }

  private handleGameError(err: GameError): void {
    this.stopAutoTsumogiriTimer();
    this.stopAutoAssistTimer();
    this.riichiSelectingMode = false;
    this.selectedDiscardTileId = null;
    this.actionInFlight = false;
    this.errorBanner = err.message;
    this.render();
  }

  private returnToLobby(options: { skipTransfer?: boolean } = {}): void {
    if (
      !options.skipTransfer &&
      this.activeSession?.role === 'host' &&
      !this.activeSession.session.isOffline() &&
      this.activeSession.session.getConnectedRemoteHumanIds().length > 0
    ) {
      this.activeSession.session.transferHost(undefined, { stayAsClient: false });
      this.activeSession = null;
    }
    clearSavedSessionRecord();
    this.savedSession = null;
    this.currentView = null;
    this.cleanupSession();
    this.busy = false;
    this.actionInFlight = false;
    this.riichiSelectingMode = false;
    this.selectedDiscardTileId = null;
    this.roundEndStep = 'details';
    this.leaveConfirmPending = false;
    this.perspectiveSeatIndex = 0;
    this.errorBanner = null;
    this.render();
  }

  private isActiveGameForWakeLock(): boolean {
    return (
      Boolean(this.activeSession) &&
      this.currentView !== null &&
      this.currentView.phase !== 'lobby' &&
      this.currentView.phase !== 'finished'
    );
  }

  private async releaseWakeLock(): Promise<void> {
    this.wakeLockSyncSeq++;
    const current = this.wakeLockSentinel;
    this.wakeLockSentinel = null;
    if (current) {
      await current.release().catch(() => {});
    }
  }

  private async syncWakeLock(): Promise<void> {
    const seq = ++this.wakeLockSyncSeq;
    const shouldHold =
      this.isActiveGameForWakeLock() && document.visibilityState === 'visible';
    if (shouldHold) {
      if (this.wakeLockSentinel && !this.wakeLockSentinel.released) return;
      const nav = navigator as Navigator & {
        wakeLock?: { request(type: 'screen'): Promise<WakeLockSentinelLike> };
      };
      if (!nav.wakeLock || typeof nav.wakeLock.request !== 'function') return;
      try {
        const sentinel = await nav.wakeLock.request('screen');
        if (
          seq !== this.wakeLockSyncSeq ||
          !this.isActiveGameForWakeLock() ||
          document.visibilityState !== 'visible'
        ) {
          await sentinel.release().catch(() => {});
          return;
        }
        this.wakeLockSentinel = sentinel;
        sentinel.addEventListener?.('release', () => {
          if (this.wakeLockSentinel === sentinel) {
            this.wakeLockSentinel = null;
          }
        });
      } catch {
        // Wake Lock API 非対応や権限拒否時はそのまま続行
      }
      return;
    }

    const current = this.wakeLockSentinel;
    this.wakeLockSentinel = null;
    if (current) {
      await current.release().catch(() => {});
    }
  }

  private getHostStatusBannerText(): string | null {
    if (this.activeSession?.role === 'client' && this.hostAway) {
      return 'ホストが画面を離れています';
    }
    if (this.activeSession?.role === 'host' && this.hostTabWarning) {
      return '警告: タブが背面になっています。対局中はホスト画面を開いたままにしてください（通信やCPU進行が停止する場合があります）。';
    }
    return null;
  }

  private stopRoomWatcher(): void {
    if (this.roomWatcher) {
      this.roomWatcher.stop();
      this.roomWatcher = null;
    }
    this.roomProbeRefreshing = false;
  }

  private syncRoomWatcher(): void {
    const shouldWatch =
      this.root.isConnected && !this.currentView && !this.busy;
    if (!shouldWatch) {
      this.stopRoomWatcher();
      return;
    }
    if (this.roomWatcher) return;
    this.roomWatcher = new PermanentRoomWatcher({
      shouldContinue: () =>
        this.root.isConnected && !this.currentView && !this.busy,
      onRoomUpdate: (roomId, state) => {
        this.roomStatuses[roomId] = state;
        if (!this.currentView) {
          const slot = this.mainLayer.querySelector<HTMLElement>(
            `[data-room-occupancy="${roomId}"]`,
          );
          if (slot) {
            renderPermanentRoomOccupancy(slot, state);
          }
        }
      },
      onScanningChange: (scanning) => {
        this.roomProbeRefreshing = scanning;
        const refreshBtn = this.mainLayer.querySelector<HTMLButtonElement>(
          '.permanent-rooms-refresh-btn',
        );
        if (refreshBtn) {
          refreshBtn.disabled = scanning;
          refreshBtn.textContent = scanning ? '確認中...' : '状況を更新';
        }
      },
    });
    this.roomWatcher.start();
  }

  private cleanupSession(): void {
    if (this.cleaningUpSession) return;
    this.cleaningUpSession = true;
    this.sessionSeq++;
    try {
      this.stopRoomWatcher();
      if (this.gameContent) {
        destroyTable3DScene(this.gameContent);
        this.gameContent = null;
      }
      this.gameShell = null;
      this.lastRenderedGameView = null;
      this.lastRenderedPerspectiveSeatIndex = 0;
      this.stopAutoTsumogiriTimer();
      this.stopAutoAssistTimer();
      this.stopCountdownTicker();
      this.leaveConfirmPending = false;
      this.settingsOpen = false;
      this.cheatOpen = false;
      this.checkOpen = false;
      this.chatOpen = false;
      this.chatPinnedToBottom = true;
      this.cleanupChatAutoScroll();
      this.chatMessages = [];
      this.changeHistory = [];
      this.checkActorFilter = 'all';
      this.checkCategoryFilter = 'all';
      this.secretPeekEnabled = false;
      this.secretLuckByPlayer = {};
      this.unreadChatCount = 0;
      this.chatDraft = '';
      this.clearChatOverlays();
      this.fullscreenError = null;
      this.hostAway = false;
      this.hostTabWarning = false;
      void this.releaseWakeLock();
      this.renderFloating();
      const sessionToDestroy = this.activeSession;
      this.activeSession = null;
      sessionToDestroy?.session.destroy();
    } finally {
      this.cleaningUpSession = false;
    }
  }

  private clearChatBubbles(): void {
    for (const entry of this.chatBubbles.values()) {
      clearTimeout(entry.timer);
    }
    this.chatBubbles.clear();
    this.animatedBubbleIds.clear();
  }

  private clearLobbyChatToast(): void {
    if (this.lobbyChatToast) {
      clearTimeout(this.lobbyChatToast.timer);
      this.lobbyChatToast = null;
    }
    this.renderChatToast();
  }

  private clearChatOverlays(): void {
    this.clearChatBubbles();
    this.clearLobbyChatToast();
  }

  private showSeatChatBubble(message: ChatMessage): void {
    const existing = this.chatBubbles.get(message.senderId);
    if (existing) {
      clearTimeout(existing.timer);
    }
    const timer = setTimeout(() => {
      const current = this.chatBubbles.get(message.senderId);
      if (current && current.message.id === message.id) {
        this.chatBubbles.delete(message.senderId);
        if (this.currentView && this.currentView.phase !== 'lobby') {
          this.render();
        }
      }
    }, CHAT_BUBBLE_DURATION_MS);
    this.chatBubbles.set(message.senderId, { message, timer });
  }

  private showLobbyChatToast(message: ChatMessage): void {
    if (this.lobbyChatToast) {
      clearTimeout(this.lobbyChatToast.timer);
    }
    const timer = setTimeout(() => {
      if (this.lobbyChatToast?.message.id === message.id) {
        this.lobbyChatToast = null;
        this.renderChatToast();
      }
    }, LOBBY_CHAT_TOAST_DURATION_MS);
    this.lobbyChatToast = { message, timer };
    this.renderChatToast();
  }

  private buildActiveChatBubbles(): Record<string, SeatChatBubble> | undefined {
    if (this.chatBubbles.size === 0) return undefined;
    const record: Record<string, SeatChatBubble> = {};
    for (const [senderId, entry] of this.chatBubbles.entries()) {
      const animate = !this.animatedBubbleIds.has(entry.message.id);
      this.animatedBubbleIds.add(entry.message.id);
      record[senderId] = {
        messageId: entry.message.id,
        senderId,
        senderName: entry.message.senderName,
        text: entry.message.text,
        animate,
      };
    }
    return record;
  }

  private renderChatToast(): void {
    this.chatToastLayer.innerHTML = '';
    if (!this.lobbyChatToast || !this.currentView) return;

    const { message } = this.lobbyChatToast;
    const toast = document.createElement('button');
    toast.type = 'button';
    toast.className = 'lobby-chat-toast';
    toast.setAttribute('role', 'status');
    toast.setAttribute(
      'aria-label',
      `チャット ${message.senderName}: ${message.text}`,
    );

    const tag = document.createElement('span');
    tag.className = 'lobby-chat-toast-tag';
    tag.textContent = 'チャット';

    const sender = document.createElement('span');
    sender.className = 'lobby-chat-toast-sender';
    sender.textContent = message.senderName;

    const text = document.createElement('span');
    text.className = 'lobby-chat-toast-text';
    text.textContent = message.text;

    toast.append(tag, sender, text);
    toast.addEventListener('click', () => {
      this.chatOpen = true;
      this.settingsOpen = false;
      this.cheatOpen = false;
      this.closeCheckModal();
      this.clearLobbyChatToast();
      if (this.unreadChatCount > 0) {
        this.unreadChatCount = 0;
        this.render();
      }
      this.renderFloating();
    });
    this.chatToastLayer.appendChild(toast);
  }

  private handleIncomingChat(message: ChatMessage): void {
    if (this.chatMessages.some((m) => m.id === message.id)) return;
    this.chatMessages = [...this.chatMessages.slice(-49), message];

    const view = this.currentView;
    const isLobby = view?.phase === 'lobby';
    const isInGame = Boolean(view && view.phase !== 'lobby');
    const isSeatedPlayer = Boolean(
      view?.players.some((p) => p.playerId === message.senderId),
    );

    if (isLobby) {
      this.showLobbyChatToast(message);
    } else if (isInGame && isSeatedPlayer) {
      this.showSeatChatBubble(message);
    } else if (isInGame) {
      // 卓上に席を持たない観戦者の発言は上部のチャット通知に出す
      this.showLobbyChatToast(message);
    }

    if (this.chatOpen) {
      this.unreadChatCount = 0;
      const list = this.floatingLayer.querySelector<HTMLElement>('.chat-messages-list');
      if (list) {
        this.populateChatMessagesList(list);
      } else {
        this.renderFloating();
      }
      if (isInGame && isSeatedPlayer) {
        this.render();
      }
      return;
    }
    this.unreadChatCount += 1;
    this.render();
  }

  private handleChatHistory(messages: ChatMessage[]): void {
    const existingIds = new Set(this.chatMessages.map((m) => m.id));
    const merged = [...this.chatMessages];
    for (const msg of messages) {
      if (!existingIds.has(msg.id)) {
        existingIds.add(msg.id);
        merged.push(msg);
      }
    }
    this.chatMessages = merged.slice(-50);
    if (this.chatOpen) {
      const list = this.floatingLayer.querySelector<HTMLElement>('.chat-messages-list');
      if (list) {
        this.populateChatMessagesList(list);
      } else {
        this.renderFloating();
      }
    }
  }

  private closeCheckModal(options: { notifyRemote?: boolean } = {}): void {
    if (!this.checkOpen) return;
    this.checkOpen = false;
    if (
      options.notifyRemote !== false &&
      this.activeSession?.role === 'client'
    ) {
      const client = this.activeSession.session as ClientSession & {
        requestChangeHistory?: (watch?: boolean) => void;
      };
      if (typeof client.requestChangeHistory === 'function') {
        client.requestChangeHistory(false);
      }
    }
  }

  private syncChangeHistory(options: { watch?: boolean } = {}): void {
    if (!this.activeSession) return;
    if (this.activeSession.role === 'host') {
      const host = this.activeSession.session as HostSession & {
        getChangeHistory?: () => ChangeHistoryEntry[];
      };
      if (typeof host.getChangeHistory === 'function') {
        this.changeHistory = host.getChangeHistory();
      }
      return;
    }
    const client = this.activeSession.session as ClientSession & {
      requestChangeHistory?: (watch?: boolean) => void;
    };
    if (typeof client.requestChangeHistory === 'function') {
      client.requestChangeHistory(options.watch);
    }
  }

  private sendChatMessage(text: string): boolean {
    if (isCheatModalCommand(text)) {
      this.chatDraft = '';
      this.chatOpen = false;
      this.settingsOpen = false;
      this.closeCheckModal();
      this.cheatOpen = true;
      if (
        this.activeSession?.role === 'client' &&
        !this.currentView?.isSpectator
      ) {
        this.activeSession.session.setSecretOption({ requestSync: true });
      }
      soundEngine.playSelect();
      this.renderFloating();
      return true;
    }
    if (isCheckModalCommand(text)) {
      this.chatDraft = '';
      this.chatOpen = false;
      this.settingsOpen = false;
      this.cheatOpen = false;
      this.checkOpen = true;
      this.syncChangeHistory({ watch: true });
      soundEngine.playSelect();
      this.renderFloating();
      return true;
    }
    if (isStopCheatCommand(text)) {
      this.chatDraft = '';
      this.chatOpen = false;
      this.settingsOpen = false;
      this.cheatOpen = false;
      this.closeCheckModal();
      if (this.activeSession && !this.currentView?.isSpectator) {
        if (this.activeSession.role === 'host') {
          const host = this.activeSession.session as HostSession & {
            stopAllSecretEffects?: () => boolean;
          };
          if (typeof host.stopAllSecretEffects === 'function') {
            host.stopAllSecretEffects();
          }
        } else {
          this.activeSession.session.setSecretOption({ clearAllCheat: true });
        }
        this.secretPeekEnabled = false;
        const resetLuck: Record<string, LocalLuckMode> = {};
        for (const p of this.currentView?.players ?? []) {
          resetLuck[p.playerId] = 'normal';
        }
        this.secretLuckByPlayer = resetLuck;
      }
      soundEngine.playSelect();
      this.renderFloating();
      return true;
    }
    if (!this.activeSession) return false;
    const ok = this.activeSession.session.sendChat(text);
    if (ok) {
      this.chatDraft = '';
      this.chatPinnedToBottom = true;
    }
    return ok;
  }

  private getCurrentSecretPeek(): boolean {
    if (this.activeSession?.role === 'host') {
      const host = this.activeSession.session as HostSession & {
        getSecretPeek?: () => boolean;
      };
      if (typeof host.getSecretPeek === 'function') {
        return host.getSecretPeek();
      }
    }
    return this.secretPeekEnabled;
  }

  private getCurrentSecretLuckByPlayer(): Record<string, LocalLuckMode> {
    if (this.activeSession?.role === 'host') {
      const host = this.activeSession.session as HostSession & {
        getSecretLuckByPlayer?: () => Record<string, LocalLuckMode>;
        getSecretLuck?: (targetId?: string) => LocalLuckMode;
      };
      if (typeof host.getSecretLuckByPlayer === 'function') {
        return host.getSecretLuckByPlayer();
      }
      if (typeof host.getSecretLuck === 'function') {
        const out: Record<string, LocalLuckMode> = { ...this.secretLuckByPlayer };
        for (const p of this.currentView?.players ?? []) {
          out[p.playerId] = host.getSecretLuck(p.playerId);
        }
        return out;
      }
    }
    return { ...this.secretLuckByPlayer };
  }

  private setCheatPeek(enabled: boolean): void {
    if (!this.activeSession || this.currentView?.isSpectator) return;
    if (this.activeSession.role === 'host') {
      const applied = this.activeSession.session.setSecretPeek(enabled);
      this.secretPeekEnabled = applied;
    } else {
      this.secretPeekEnabled = enabled;
      this.activeSession.session.setSecretOption({ peek: enabled });
    }
    soundEngine.playSelect();
    this.renderFloating();
  }

  private setCheatLuck(mode: LocalLuckMode, targetPlayerId: string): void {
    if (!this.activeSession || this.currentView?.isSpectator) return;
    if (this.activeSession.role === 'host') {
      const host = this.activeSession.session as HostSession & {
        setSecretLuck: (mode: LocalLuckMode, targetId?: string) => boolean;
      };
      host.setSecretLuck(mode, targetPlayerId);
      this.secretLuckByPlayer = this.getCurrentSecretLuckByPlayer();
    } else {
      this.secretLuckByPlayer = {
        ...this.secretLuckByPlayer,
        [targetPlayerId]: mode,
      };
      this.activeSession.session.setSecretOption({
        luck: mode,
        luckTargetPlayerId: targetPlayerId,
      });
    }
    soundEngine.playSelect();
    this.renderFloating();
  }

  private resetAllCheatLuck(): void {
    if (!this.activeSession || this.currentView?.isSpectator) return;
    if (this.activeSession.role === 'host') {
      const host = this.activeSession.session as HostSession & {
        clearAllSecretLuck?: () => boolean;
        setSecretLuck: (mode: LocalLuckMode, targetId?: string) => boolean;
      };
      if (typeof host.clearAllSecretLuck === 'function') {
        host.clearAllSecretLuck();
      } else {
        for (const p of this.currentView?.players ?? []) {
          host.setSecretLuck('normal', p.playerId);
        }
      }
      this.secretLuckByPlayer = this.getCurrentSecretLuckByPlayer();
    } else {
      const next: Record<string, LocalLuckMode> = {};
      for (const p of this.currentView?.players ?? []) {
        next[p.playerId] = 'normal';
      }
      this.secretLuckByPlayer = next;
      this.activeSession.session.setSecretOption({ clearAllLuck: true });
    }
    soundEngine.playSelect();
    this.renderFloating();
  }

  private async setFullscreenEnabled(enabled: boolean): Promise<void> {
    this.fullscreenError = null;
    try {
      if (enabled) {
        const res = await enterLandscapeFullscreen();
        if (!res.fullscreen) {
          this.fullscreenError =
            res.error ?? 'フル画面表示に切り替えられませんでした。';
        } else if (res.error) {
          this.fullscreenError = res.error;
        }
        return;
      }

      const res = await exitLandscapeFullscreen();
      if (res.error) {
        this.fullscreenError = res.error;
      }
    } finally {
      this.syncOrientationOverlay();
      if (this.settingsOpen) {
        this.renderFloating();
      }
    }
  }

  private dispatchAction(fn: (session: HostSession | ClientSession) => void): void {
    if (!this.activeSession || this.actionInFlight) return;
    this.actionInFlight = true;
    this.errorBanner = null;
    fn(this.activeSession.session);
  }

  /** 対局中に卓上から部屋を抜ける（誤タップ防止のためアプリ内ダイアログで確認する） */
  private confirmLeaveGame(): void {
    if (this.currentView?.phase === 'finished') {
      this.returnToLobby();
      return;
    }
    this.leaveConfirmPending = true;
    this.render();
  }

  private renderLeaveConfirmModal(): HTMLElement {
    const backdrop = document.createElement('div');
    backdrop.className = 'overlay-backdrop overlay-backdrop-modal leave-confirm-modal';
    backdrop.setAttribute('role', 'dialog');
    backdrop.setAttribute('aria-modal', 'true');

    const panel = document.createElement('div');
    panel.className = 'overlay-panel';
    panel.style.maxWidth = '420px';

    const isSpectator = Boolean(this.currentView?.isSpectator);
    const hasHandoverTarget =
      this.activeSession?.role === 'host' &&
      !this.activeSession.session.isOffline() &&
      this.activeSession.session.getConnectedRemoteHumanIds().length > 0;

    const title = document.createElement('h3');
    title.style.margin = '0';
    title.style.color = 'var(--accent-gold)';
    title.textContent = isSpectator
      ? '観戦を終了しますか？'
      : '対局を離れますか？';

    const desc = document.createElement('p');
    desc.className = 'hub-sub';
    desc.style.margin = '0';
    desc.textContent = isSpectator
      ? 'ロビーに戻ります（途中から再度観戦することもできます）。'
      : hasHandoverTarget
        ? '退出すると、ホスト権限が自動的に他の参加者へ引き継がれて対局が続行されます。'
        : 'ロビーに戻ると、現在の対局の進行状況は失われます。';

    const actions = document.createElement('div');
    actions.style.display = 'flex';
    actions.style.justifyContent = 'flex-end';
    actions.style.gap = '8px';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'btn btn-secondary';
    cancelBtn.textContent = isSpectator ? '観戦を続ける' : '対局を続ける';
    cancelBtn.addEventListener('click', () => {
      this.leaveConfirmPending = false;
      this.render();
    });

    const leaveBtn = document.createElement('button');
    leaveBtn.type = 'button';
    leaveBtn.className = 'btn btn-danger';
    leaveBtn.textContent = hasHandoverTarget
      ? 'ホストを譲って退出'
      : 'ロビーに戻る';
    leaveBtn.addEventListener('click', () => this.returnToLobby());

    actions.append(cancelBtn, leaveBtn);
    panel.append(title, desc, actions);
    backdrop.appendChild(panel);
    return backdrop;
  }

  /** 縦持ち時に対局画面をローテーション案内で覆う（ロビーでは表示しない） */
  private syncOrientationOverlay(): void {
    const existing = document.querySelector('.rotate-overlay');
    const needsOverlay =
      Boolean(this.currentView) &&
      this.currentView!.phase !== 'lobby' &&
      shouldBlockForOrientation();

    if (needsOverlay && !existing) {
      document.body.appendChild(createRotateOverlay());
      document.body.classList.add('is-orientation-blocked');
      return;
    }
    if (!needsOverlay && existing) {
      existing.remove();
      document.body.classList.remove('is-orientation-blocked');
    }
  }

  private buildTopBar(inGame: boolean): HTMLElement {
    const topBar = document.createElement('header');
    topBar.className = inGame ? 'top-bar is-hidden-in-game' : 'top-bar';

    const title = document.createElement('div');
    title.className = 'app-title';
    title.textContent = 'PeerJS 対戦リーチ麻雀';

    const rightControls = document.createElement('div');
    rightControls.className = 'top-bar-right';

    if (this.activeSession && this.currentView && this.currentView.phase !== 'lobby') {
      const resetBtn = document.createElement('button');
      resetBtn.type = 'button';
      resetBtn.className = 'btn btn-secondary';
      resetBtn.style.padding = '4px 10px';
      resetBtn.style.fontSize = '0.8rem';
      resetBtn.textContent = 'ロビーに戻る';
      resetBtn.addEventListener('click', () => this.returnToLobby());
      rightControls.appendChild(resetBtn);
    }

    if (!inGame) {
      const settingsBtn = document.createElement('button');
      settingsBtn.type = 'button';
      settingsBtn.className = 'btn btn-secondary top-bar-settings-btn';
      settingsBtn.setAttribute('aria-label', '設定');
      settingsBtn.title = '表示・音声設定を開く';
      settingsBtn.innerHTML =
        '<span class="top-bar-settings-icon" aria-hidden="true">⚙</span><span>設定</span>';
      settingsBtn.addEventListener('click', () => {
        this.settingsOpen = !this.settingsOpen;
        if (this.settingsOpen) {
          this.chatOpen = false;
          this.cheatOpen = false;
          this.closeCheckModal();
          this.fullscreenError = null;
        }
        this.renderFloating();
      });
      rightControls.appendChild(settingsBtn);
    }

    topBar.append(title, rightControls);
    return topBar;
  }

  private buildErrorBanner(): HTMLElement {
    const banner = document.createElement('div');
    banner.className = 'error-banner';

    const msg = document.createElement('span');
    msg.textContent = this.errorBanner ?? '';

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'btn btn-secondary';
    close.style.padding = '4px 10px';
    close.textContent = '閉じる';
    close.addEventListener('click', () => {
      this.errorBanner = null;
      this.render();
    });

    banner.append(msg, close);
    return banner;
  }

  private render(): void {
    if (!this.root.isConnected) {
      this.cleanupSession();
      return;
    }

    // 対局中は「雀卓だけ」を表示する（トップバーやサイドパネルを出さない）
    const inGame =
      this.currentView !== null && this.currentView.phase !== 'lobby';

    const discardOriginSnapshot: DiscardOriginSnapshot | null =
      inGame &&
      this.currentView!.phase !== 'finished' &&
      this.lastRenderedGameView !== null &&
      this.lastRenderedGameView !== this.currentView &&
      this.gameContent
        ? captureDiscardOriginSnapshot(this.gameContent)
        : null;

    const hostStatusBannerText = this.getHostStatusBannerText();
    let content: HTMLElement;

    if (!inGame) {
      if (this.gameContent) {
        destroyTable3DScene(this.gameContent);
        this.gameContent = null;
      }
      this.gameShell = null;
      this.mainLayer.innerHTML = '';

      const shell = document.createElement('div');
      shell.className = 'app-shell';
      shell.appendChild(this.buildTopBar(false));

      if (this.errorBanner) {
        shell.appendChild(this.buildErrorBanner());
      }
      if (hostStatusBannerText) {
        const awayBanner = document.createElement('div');
        awayBanner.className = 'host-away-banner';
        awayBanner.setAttribute('role', 'alert');
        awayBanner.textContent = hostStatusBannerText;
        shell.appendChild(awayBanner);
      }

      content = document.createElement('main');
      shell.appendChild(content);
      this.mainLayer.appendChild(shell);
    } else {
      const canReuseGameShell = Boolean(
        this.gameShell &&
          this.gameContent &&
          this.gameShell.isConnected &&
          this.gameShell.parentElement === this.mainLayer,
      );

      if (!canReuseGameShell || !this.gameShell || !this.gameContent) {
        if (this.gameContent) {
          destroyTable3DScene(this.gameContent);
        }
        this.mainLayer.innerHTML = '';
        const shell = document.createElement('div');
        shell.className = 'app-shell app-shell-table-only';
        shell.appendChild(this.buildTopBar(true));

        content = document.createElement('main');
        content.className = 'table-only-main';
        shell.appendChild(content);
        this.mainLayer.appendChild(shell);

        this.gameShell = shell;
        this.gameContent = content;
      } else {
        content = this.gameContent;
        const existingTopBar = Array.from(this.gameShell.children).find((el) =>
          el.classList.contains('top-bar'),
        );
        const nextTopBar = this.buildTopBar(true);
        if (existingTopBar) {
          existingTopBar.replaceWith(nextTopBar);
        } else {
          this.gameShell.insertBefore(nextTopBar, content);
        }
      }

      // 対局中は 3D 卓 DOM (this.gameContent) を保持したままエラーバナーのみ差分更新
      for (const oldBanner of Array.from(
        this.gameShell.querySelectorAll('.error-banner'),
      )) {
        oldBanner.remove();
      }
      if (this.errorBanner) {
        this.gameShell.insertBefore(this.buildErrorBanner(), content);
      }

      for (const oldLeave of Array.from(
        this.mainLayer.querySelectorAll('.leave-confirm-modal'),
      )) {
        oldLeave.remove();
      }
    }

    const view = this.currentView;
    const lobbyHandlers = {
      onCreateRoom: (name: string, ruleConfig: RuleConfig, cpuCount: number) =>
        this.createRoom(name, ruleConfig, cpuCount),
      onJoinRoom: (code: string, name: string) => this.joinRoom(code, name),
      onStartLocalGame: (name: string, ruleConfig: RuleConfig, cpuCount: number) =>
        this.startLocalGame(name, ruleConfig, cpuCount),
      onJoinPermanentRoom: (roomId: PermanentRoomId, name: string) =>
        this.joinPermanentRoom(roomId, name),
      onReconnectSession: () => this.reconnectSavedSession(),
      onDiscardSavedSession: () => this.discardSavedSession(),
      onLeaveLobby: () => this.returnToLobby(),
      onAddCpu: () => this.addCpuToLobby(),
      onRemoveCpu: (playerId?: string) => this.removeCpuFromLobby(playerId),
      onUpdateRuleConfig: (patch: Partial<RuleConfig>) =>
        this.updateLobbyRules(patch),
      onStartGame: () => this.startLobbyGame(),
      onTransferHost: (targetPlayerId: string) =>
        this.transferHostAndStay(targetPlayerId),
      onTransferHostAndLeave: () => this.transferHostAndLeave(),
      onRefreshRoomStatuses: () => {
        this.roomWatcher?.refreshNow();
      },
      onOpenChat: () => {
        this.chatOpen = !this.chatOpen;
        this.settingsOpen = false;
        this.cheatOpen = false;
        this.closeCheckModal();
        if (this.chatOpen && this.unreadChatCount > 0) {
          this.unreadChatCount = 0;
          this.render();
        }
        this.renderFloating();
      },
    };

    if (!view) {
      this.lastRenderedGameView = null;
      renderLobbyEntry(content, this.formState, lobbyHandlers, this.busy, {
        savedSession: this.savedSession,
        roomStatuses: this.roomStatuses,
        roomRefreshing: this.roomProbeRefreshing,
      });
    } else if (view.phase === 'lobby') {
      this.lastRenderedGameView = null;
      renderWaitingRoom(content, view, lobbyHandlers, {
        unreadChatCount: this.unreadChatCount,
      });
    } else {
      renderGameTable(
        content,
        view,
        {
          // 対局中はトップバーを出さないので、離脱・設定・チャットは卓上に置く
          canLeaveGame: Boolean(this.activeSession),
          onLeaveGame: () => this.confirmLeaveGame(),
          onOpenSettings: () => {
            this.settingsOpen = !this.settingsOpen;
            this.chatOpen = false;
            this.cheatOpen = false;
            this.closeCheckModal();
            this.fullscreenError = null;
            this.renderFloating();
          },
          onOpenChat: () => {
            this.chatOpen = !this.chatOpen;
            this.settingsOpen = false;
            this.cheatOpen = false;
            this.closeCheckModal();
            if (this.chatOpen && this.unreadChatCount > 0) {
              this.unreadChatCount = 0;
              this.render();
            }
            this.renderFloating();
          },
          onSelectTile: (tileId) => {
            this.selectedDiscardTileId = tileId;
          },
          onChangeRoundEndStep: (step) => {
            this.roundEndStep = step;
          },
          onChangePerspective: (seatIndex) => {
            this.perspectiveSeatIndex = seatIndex;
            this.render();
          },
          onResetToLobby: () => {
            if (this.activeSession?.role === 'host' && !this.actionInFlight) {
              this.activeSession.session.resetToLobby();
            }
          },
          onDiscardTile: (tileId) => {
            this.selectedDiscardTileId = null;
            this.stopAutoTsumogiriTimer();
            this.dispatchAction((s) => s.discardTile(tileId));
          },
          onCallResponse: (choice) =>
            this.dispatchAction((s) => s.respondToCall(choice)),
          onDeclareTsumo: () => {
            this.selectedDiscardTileId = null;
            this.stopAutoTsumogiriTimer();
            this.dispatchAction((s) => s.declareTsumo());
          },
          onDeclareRiichi: (tileId) => {
            this.selectedDiscardTileId = null;
            this.stopAutoTsumogiriTimer();
            this.riichiSelectingMode = false;
            this.dispatchAction((s) => s.declareRiichi(tileId));
          },
          onDeclareAnkan: (kind) => {
            this.selectedDiscardTileId = null;
            this.stopAutoTsumogiriTimer();
            this.dispatchAction((s) => s.declareAnkan(kind));
          },
          onDeclareKakan: (tileId) => {
            this.selectedDiscardTileId = null;
            this.stopAutoTsumogiriTimer();
            this.dispatchAction((s) => s.declareKakan(tileId));
          },
          onDeclareKita: (tileId) => {
            this.selectedDiscardTileId = null;
            this.stopAutoTsumogiriTimer();
            this.dispatchAction((s) => s.declareKita(tileId));
          },
          onDeclareKyuushuKyuuhai: () => {
            this.selectedDiscardTileId = null;
            this.stopAutoTsumogiriTimer();
            this.dispatchAction((s) => s.declareKyuushuKyuuhai());
          },
          onToggleRiichiMode: (enabled) => {
            this.selectedDiscardTileId = null;
            this.riichiSelectingMode = enabled;
            this.render();
          },
          onToggleAutoTsumogiri: (enabled) => {
            this.autoTsumogiriEnabled = enabled;
            this.stopAutoTsumogiriTimer();
            if (this.currentView && enabled) {
              this.scheduleAutoTsumogiriIfNeeded(this.currentView);
            }
            this.render();
          },
          onToggleAutoAgari: (enabled) => {
            this.autoAgariEnabled = enabled;
            this.stopAutoAssistTimer();
            if (this.currentView && enabled) {
              this.scheduleAutoAssistIfNeeded(this.currentView);
            }
            this.render();
          },
          onToggleAutoNoCall: (enabled) => {
            this.autoNoCallEnabled = enabled;
            this.stopAutoAssistTimer();
            if (this.currentView && enabled) {
              this.scheduleAutoAssistIfNeeded(this.currentView);
            }
            this.render();
          },
          onAdvanceRound: () => {
            if (this.activeSession?.role === 'host' && !this.actionInFlight) {
              this.actionInFlight = true;
              this.errorBanner = null;
              this.activeSession.session.advanceRound();
            }
          },
          onReturnToLobby: () => this.returnToLobby(),
        },
        {
          riichiSelectingMode: this.riichiSelectingMode,
          autoTsumogiriEnabled: this.autoTsumogiriEnabled,
          autoAgariEnabled: this.autoAgariEnabled,
          autoNoCallEnabled: this.autoNoCallEnabled,
          selectedTileId: this.selectedDiscardTileId,
          roundEndStep: this.roundEndStep,
          unreadChatCount: this.unreadChatCount,
          perspectiveSeatIndex: this.perspectiveSeatIndex,
          hostStatusBanner: hostStatusBannerText,
          prevView: this.lastRenderedGameView,
          prevPerspectiveSeatIndex: this.lastRenderedPerspectiveSeatIndex,
          discardOriginSnapshot,
          chatBubbles: this.buildActiveChatBubbles(),
          enable3dTable: this.table3dEnabled,
          cameraPreset: this.table3dCameraPreset,
        },
      );
      this.lastRenderedGameView = view;
      this.lastRenderedPerspectiveSeatIndex = this.perspectiveSeatIndex;
    }

    if (this.leaveConfirmPending && inGame) {
      this.mainLayer.appendChild(this.renderLeaveConfirmModal());
    }
    this.syncOrientationOverlay();
    this.syncRoomWatcher();
  }

  private renderFloating(): void {
    const existingSettingsPanel =
      this.floatingLayer.querySelector<HTMLElement>('.table-settings-panel');
    const savedSettingsScrollTop = existingSettingsPanel?.scrollTop ?? 0;

    const existingCheatModal =
      this.floatingLayer.querySelector<HTMLElement>('.table-cheat-modal');
    const existingCheatPanel =
      existingCheatModal?.querySelector<HTMLElement>('.table-cheat-panel') ?? null;
    const savedCheatPanelScrollTop = existingCheatPanel?.scrollTop ?? 0;
    const savedCheatBackdropScrollTop = existingCheatModal?.scrollTop ?? 0;

    const existingCheckModal =
      this.floatingLayer.querySelector<HTMLElement>('.table-check-modal');
    const existingCheckPanel =
      existingCheckModal?.querySelector<HTMLElement>('.table-check-panel') ?? null;
    const existingCheckList =
      existingCheckModal?.querySelector<HTMLElement>('.check-history-list') ?? null;
    const savedCheckPanelScrollTop = existingCheckPanel?.scrollTop ?? 0;
    const savedCheckListScrollTop = existingCheckList?.scrollTop ?? 0;
    const savedCheckBackdropScrollTop = existingCheckModal?.scrollTop ?? 0;

    if (
      !this.settingsOpen &&
      this.currentView &&
      this.cheatOpen &&
      existingCheatModal &&
      existingCheatModal.dataset.cheatStructureKey ===
        this.buildCheatModalStructureKey()
    ) {
      this.cleanupChatAutoScroll();
      this.updateCheatModal(existingCheatModal);
      return;
    }

    if (
      !this.settingsOpen &&
      !this.cheatOpen &&
      this.currentView &&
      this.checkOpen &&
      existingCheckModal &&
      existingCheckModal.dataset.checkStructureKey ===
        this.buildCheckModalStructureKey()
    ) {
      this.cleanupChatAutoScroll();
      this.updateCheckModal(existingCheckModal);
      return;
    }

    this.cleanupChatAutoScroll();
    this.floatingLayer.innerHTML = '';

    if (this.settingsOpen) {
      const modal = this.renderSettingsModal();
      this.floatingLayer.appendChild(modal);
      if (existingSettingsPanel && savedSettingsScrollTop > 0) {
        const newPanel = modal.querySelector<HTMLElement>('.table-settings-panel');
        if (newPanel) {
          newPanel.scrollTop = savedSettingsScrollTop;
        }
      }
      return;
    }

    if (!this.currentView) return;

    if (this.cheatOpen) {
      const modal = this.renderCheatModal();
      this.floatingLayer.appendChild(modal);
      if (existingCheatModal) {
        const newPanel = modal.querySelector<HTMLElement>('.table-cheat-panel');
        const restoreCheatScroll = () => {
          if (newPanel && savedCheatPanelScrollTop > 0) {
            newPanel.scrollTop = savedCheatPanelScrollTop;
          }
          if (savedCheatBackdropScrollTop > 0) {
            modal.scrollTop = savedCheatBackdropScrollTop;
          }
        };
        restoreCheatScroll();
        if (typeof requestAnimationFrame === 'function') {
          requestAnimationFrame(() => {
            if (!modal.isConnected) return;
            restoreCheatScroll();
          });
        }
      }
      return;
    }

    if (this.checkOpen) {
      const modal = this.renderCheckModal();
      this.floatingLayer.appendChild(modal);
      if (existingCheckModal) {
        const newPanel = modal.querySelector<HTMLElement>('.table-check-panel');
        const newList = modal.querySelector<HTMLElement>('.check-history-list');
        const restoreCheckScroll = () => {
          if (newPanel && savedCheckPanelScrollTop > 0) {
            newPanel.scrollTop = savedCheckPanelScrollTop;
          }
          if (newList && savedCheckListScrollTop > 0) {
            newList.scrollTop = savedCheckListScrollTop;
          }
          if (savedCheckBackdropScrollTop > 0) {
            modal.scrollTop = savedCheckBackdropScrollTop;
          }
        };
        restoreCheckScroll();
        if (typeof requestAnimationFrame === 'function') {
          requestAnimationFrame(() => {
            if (!modal.isConnected) return;
            restoreCheckScroll();
          });
        }
      }
      return;
    }

    if (this.chatOpen) {
      const modal = this.renderChatModal();
      this.floatingLayer.appendChild(modal);
      const list = modal.querySelector<HTMLElement>('.chat-messages-list');
      if (list) {
        this.scrollChatMessagesToBottom(list, { resetPin: true });
      }
    }
  }

  private buildCheatModalStructureKey(): string {
    const view = this.currentView;
    if (!view) return '';
    const playersKey = view.players
      .map(
        (p) =>
          `${p.playerId}:${p.name}:${p.playerId === view.viewerPlayerId ? 1 : 0}:${p.playerId === view.hostPlayerId ? 1 : 0}`,
      )
      .join('|');
    return `${view.isSpectator ? '1' : '0'}#${playersKey}`;
  }

  private updateCheatModal(modal: HTMLElement): void {
    const isSpectator = Boolean(this.currentView?.isSpectator);
    const peekOn = this.getCurrentSecretPeek();

    const peekBtn = modal.querySelector<HTMLButtonElement>('.cheat-peek-switch');
    if (peekBtn) {
      peekBtn.classList.toggle('is-on', peekOn);
      peekBtn.setAttribute('aria-checked', peekOn ? 'true' : 'false');
      peekBtn.disabled = isSpectator;
      const stateText = peekBtn.querySelector<HTMLElement>('.toggle-state-text');
      if (stateText) {
        stateText.textContent = peekOn ? 'ON' : 'OFF';
      }
    }

    const luckByPlayer = this.getCurrentSecretLuckByPlayer();
    const players = this.currentView?.players ?? [];
    const hasCustomLuck = players.some(
      (p) => (luckByPlayer[p.playerId] ?? 'normal') !== 'normal',
    );

    const resetAllBtn = modal.querySelector<HTMLButtonElement>(
      '.cheat-luck-reset-btn',
    );
    if (resetAllBtn) {
      resetAllBtn.disabled = isSpectator || !hasCustomLuck;
    }

    const rows = modal.querySelectorAll<HTMLElement>('.cheat-luck-player-row');
    for (const row of Array.from(rows)) {
      const pid = row.dataset.cheatPlayerId;
      if (!pid) continue;
      const playerLuck = luckByPlayer[pid] ?? 'normal';
      row.classList.toggle('is-luck-good', playerLuck === 'good');
      row.classList.toggle('is-luck-god', playerLuck === 'god');
      const btns = row.querySelectorAll<HTMLButtonElement>('.cheat-luck-btn');
      for (const btn of Array.from(btns)) {
        const mode = btn.dataset.luckMode as LocalLuckMode | undefined;
        if (!mode) continue;
        const active = playerLuck === mode;
        btn.className = `btn btn-secondary cheat-luck-btn${
          active ? ` is-active is-mode-${mode}` : ''
        }`;
        btn.setAttribute('aria-pressed', active ? 'true' : 'false');
        btn.disabled = isSpectator;
      }
    }
  }

  private renderCheatModal(): HTMLElement {
    const backdrop = document.createElement('div');
    backdrop.className = 'overlay-backdrop overlay-backdrop-modal table-cheat-modal';
    backdrop.dataset.cheatStructureKey = this.buildCheatModalStructureKey();
    backdrop.setAttribute('role', 'dialog');
    backdrop.setAttribute('aria-modal', 'true');
    backdrop.setAttribute('aria-label', '裏設定');
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) {
        this.cheatOpen = false;
        this.renderFloating();
      }
    });

    const panel = document.createElement('div');
    panel.className = 'overlay-panel table-cheat-panel';

    const header = document.createElement('div');
    header.className = 'table-modal-header';

    const titleWrap = document.createElement('div');
    titleWrap.className = 'cheat-modal-title-wrap';

    const title = document.createElement('h3');
    title.textContent = '裏設定';

    const badge = document.createElement('span');
    badge.className = 'cheat-secret-badge';
    badge.textContent = 'SECRET';

    titleWrap.append(title, badge);

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'btn btn-secondary table-modal-close-btn';
    closeBtn.textContent = '閉じる';
    closeBtn.addEventListener('click', () => {
      this.cheatOpen = false;
      this.renderFloating();
    });

    header.append(titleWrap, closeBtn);
    panel.appendChild(header);

    const isSpectator = Boolean(this.currentView?.isSpectator);
    if (isSpectator) {
      const note = document.createElement('div');
      note.className = 'cheat-spectator-note';
      note.textContent =
        '観戦中は裏設定を変更できません（対局参加中のプレイヤー本人のみ有効です）。';
      panel.appendChild(note);
    }

    // 1. Peek（相手手牌透視）
    const peekRow = document.createElement('div');
    peekRow.className = 'setting-toggle-row cheat-setting-row';

    const peekLabel = document.createElement('div');
    peekLabel.className = 'setting-toggle-label';
    peekLabel.innerHTML =
      '<strong>相手手牌の透視（Peek）</strong><span class="hub-sub">対局中、他家の手牌とツモ牌を自分だけに公開表示します</span>';

    const peekOn = this.getCurrentSecretPeek();
    const peekBtn = document.createElement('button');
    peekBtn.type = 'button';
    peekBtn.className = `toggle-switch setting-toggle-controls cheat-peek-switch${peekOn ? ' is-on' : ''}`;
    peekBtn.setAttribute('role', 'switch');
    peekBtn.setAttribute('aria-checked', peekOn ? 'true' : 'false');
    peekBtn.setAttribute('aria-label', '相手手牌の透視');
    peekBtn.disabled = isSpectator;

    const peekTrack = document.createElement('span');
    peekTrack.className = 'toggle-track';
    peekTrack.setAttribute('aria-hidden', 'true');
    const peekThumb = document.createElement('span');
    peekThumb.className = 'toggle-thumb';
    peekTrack.appendChild(peekThumb);

    const peekStateText = document.createElement('span');
    peekStateText.className = 'toggle-state-text';
    peekStateText.textContent = peekOn ? 'ON' : 'OFF';

    peekBtn.append(peekTrack, peekStateText);
    peekBtn.addEventListener('click', () => {
      this.setCheatPeek(!this.getCurrentSecretPeek());
    });

    peekRow.append(peekLabel, peekBtn);
    panel.appendChild(peekRow);

    // 2. Luck（プレイヤー別 配牌・ツモ運ブースト）
    const luckSection = document.createElement('div');
    luckSection.className = 'setting-camera-row cheat-luck-section';

    const luckHeaderRow = document.createElement('div');
    luckHeaderRow.className = 'cheat-luck-header-row';

    const luckLabel = document.createElement('div');
    luckLabel.className = 'setting-toggle-label';
    luckLabel.innerHTML =
      '<strong>プレイヤー別 配牌・ツモ運（Luck）</strong><span class="hub-sub">自分・他プレイヤー・CPUごとに配牌とツモ運を切り替えられます</span>';

    const luckByPlayer = this.getCurrentSecretLuckByPlayer();
    const players = this.currentView?.players ?? [];
    const hasCustomLuck = players.some(
      (p) => (luckByPlayer[p.playerId] ?? 'normal') !== 'normal',
    );

    const resetAllBtn = document.createElement('button');
    resetAllBtn.type = 'button';
    resetAllBtn.className = 'btn btn-secondary cheat-luck-reset-btn';
    resetAllBtn.textContent = '全員通常';
    resetAllBtn.disabled = isSpectator || !hasCustomLuck;
    resetAllBtn.addEventListener('click', () => {
      this.resetAllCheatLuck();
    });

    luckHeaderRow.append(luckLabel, resetAllBtn);

    const playerList = document.createElement('div');
    playerList.className = 'cheat-luck-player-list';

    const luckOptions: ReadonlyArray<{ mode: LocalLuckMode; label: string }> = [
      { mode: 'normal', label: '通常' },
      { mode: 'good', label: '好運' },
      { mode: 'god', label: '豪運' },
    ];

    const viewerId = this.currentView?.viewerPlayerId;
    const hostId = this.currentView?.hostPlayerId;

    for (const player of players) {
      const isSelf = player.playerId === viewerId;
      const isCpu = isCpuPlayerId(player.playerId);
      const isHost = player.playerId === hostId;
      const playerLuck = luckByPlayer[player.playerId] ?? 'normal';

      const row = document.createElement('div');
      row.className = `cheat-luck-player-row${isSelf ? ' is-self' : ''}${
        playerLuck !== 'normal' ? ` is-luck-${playerLuck}` : ''
      }`;
      row.dataset.cheatPlayerId = player.playerId;

      const meta = document.createElement('div');
      meta.className = 'cheat-luck-player-meta';

      const nameEl = document.createElement('span');
      nameEl.className = 'cheat-luck-player-name';
      nameEl.textContent = player.name;
      meta.appendChild(nameEl);

      if (isSelf) {
        const tag = document.createElement('span');
        tag.className = 'cheat-player-tag is-self';
        tag.textContent = 'あなた';
        meta.appendChild(tag);
      } else if (isCpu) {
        const tag = document.createElement('span');
        tag.className = 'cheat-player-tag is-cpu';
        tag.textContent = 'CPU';
        meta.appendChild(tag);
      } else if (isHost) {
        const tag = document.createElement('span');
        tag.className = 'cheat-player-tag is-host';
        tag.textContent = 'ホスト';
        meta.appendChild(tag);
      }

      const btns = document.createElement('div');
      btns.className = 'cheat-luck-player-btns';

      for (const opt of luckOptions) {
        const btn = document.createElement('button');
        btn.type = 'button';
        const active = playerLuck === opt.mode;
        btn.className = `btn btn-secondary cheat-luck-btn${
          active ? ` is-active is-mode-${opt.mode}` : ''
        }`;
        btn.dataset.luckMode = opt.mode;
        btn.dataset.targetPlayerId = player.playerId;
        btn.setAttribute('aria-pressed', active ? 'true' : 'false');
        btn.setAttribute('aria-label', `${player.name}の運を${opt.label}に設定`);
        btn.disabled = isSpectator;
        btn.textContent = opt.label;
        btn.addEventListener('click', () => {
          this.setCheatLuck(opt.mode, player.playerId);
        });
        btns.appendChild(btn);
      }

      row.append(meta, btns);
      playerList.appendChild(row);
    }

    const luckDesc = document.createElement('div');
    luckDesc.className = 'cheat-luck-desc';
    luckDesc.textContent =
      '通常: 牌山順 / 好運: 配牌優遇＋一部山から好ツモ / 豪運: 最良配牌＋全山から最強ツモ（ツモ運は次巡から即反映）';

    luckSection.append(luckHeaderRow, playerList, luckDesc);
    panel.appendChild(luckSection);

    backdrop.appendChild(panel);
    return backdrop;
  }

  private buildCheckModalStructureKey(): string {
    const view = this.currentView;
    if (!view) return '';
    return `${view.viewerPlayerId}|${view.hostPlayerId}|${view.isSpectator ? '1' : '0'}`;
  }

  private computeCheckHistorySummary(): {
    allCount: number;
    othersCount: number;
    cheatCount: number;
    settingsCount: number;
    filtered: ChangeHistoryEntry[];
  } {
    const viewerId = this.currentView?.viewerPlayerId ?? '';
    const all = this.changeHistory;
    const othersCount = all.filter((e) => e.actorPlayerId !== viewerId).length;
    const actorFiltered =
      this.checkActorFilter === 'others'
        ? all.filter((e) => e.actorPlayerId !== viewerId)
        : all;
    const cheatCount = actorFiltered.filter(
      (e) => e.category === 'cheat',
    ).length;
    const settingsCount = actorFiltered.filter(
      (e) => e.category === 'settings',
    ).length;
    const categoryFiltered =
      this.checkCategoryFilter === 'all'
        ? actorFiltered
        : actorFiltered.filter((e) => e.category === this.checkCategoryFilter);
    return {
      allCount: all.length,
      othersCount,
      cheatCount,
      settingsCount,
      filtered: [...categoryFiltered].reverse(),
    };
  }

  private updateCheckModal(modal: HTMLElement): void {
    const { allCount, othersCount, cheatCount, settingsCount, filtered } =
      this.computeCheckHistorySummary();

    const summaryEl = modal.querySelector<HTMLElement>('.check-summary-text');
    if (summaryEl) {
      summaryEl.textContent = `全 ${allCount} 件（うち他プレイヤー ${othersCount} 件）`;
    }

    const actorBtns = modal.querySelectorAll<HTMLButtonElement>(
      'button[data-check-actor-filter]',
    );
    for (const btn of Array.from(actorBtns)) {
      const mode = btn.dataset.checkActorFilter as 'all' | 'others' | undefined;
      if (!mode) continue;
      const active = this.checkActorFilter === mode;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
      btn.textContent =
        mode === 'all'
          ? `すべて (${allCount})`
          : `他プレイヤーのみ (${othersCount})`;
    }

    const catBtns = modal.querySelectorAll<HTMLButtonElement>(
      'button[data-check-category-filter]',
    );
    for (const btn of Array.from(catBtns)) {
      const cat = btn.dataset.checkCategoryFilter as
        | 'all'
        | ChangeHistoryCategory
        | undefined;
      if (!cat) continue;
      const active = this.checkCategoryFilter === cat;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
      if (cat === 'all') {
        btn.textContent = '全種別';
      } else if (cat === 'cheat') {
        btn.textContent = `//cheat (${cheatCount})`;
      } else {
        btn.textContent = `設定 (${settingsCount})`;
      }
    }

    const list = modal.querySelector<HTMLElement>('.check-history-list');
    if (list) {
      this.populateCheckHistoryList(list, filtered, allCount);
    }
  }

  private populateCheckHistoryList(
    list: HTMLElement,
    filtered: ChangeHistoryEntry[],
    allCount: number,
  ): void {
    const prevScrollTop = list.scrollTop;
    list.innerHTML = '';

    if (filtered.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'check-empty-state';
      if (allCount === 0) {
        empty.textContent = 'まだ //cheat や設定の変更履歴はありません。';
      } else if (this.checkActorFilter === 'others') {
        empty.textContent =
          '他プレイヤーによる該当の変更履歴はありません。';
      } else {
        empty.textContent = '該当する変更履歴はありません。';
      }
      list.appendChild(empty);
      return;
    }

    const viewerId = this.currentView?.viewerPlayerId ?? '';
    const hostId = this.currentView?.hostPlayerId ?? '';

    for (const entry of filtered) {
      const isSelf = entry.actorPlayerId === viewerId;
      const isHostActor = entry.actorPlayerId === hostId;

      const item = document.createElement('div');
      item.className = `check-history-item${
        isSelf ? ' is-self' : ' is-other-player'
      } is-cat-${entry.category}`;
      item.dataset.entryId = entry.id;
      item.dataset.actorId = entry.actorPlayerId;

      const topRow = document.createElement('div');
      topRow.className = 'check-item-top';

      const badges = document.createElement('div');
      badges.className = 'check-item-badges';

      const catBadge = document.createElement('span');
      catBadge.className = `check-cat-badge is-${entry.category}`;
      catBadge.textContent = entry.category === 'cheat' ? '//cheat' : '設定';

      const actorName = document.createElement('span');
      actorName.className = 'check-actor-name';
      actorName.textContent = entry.actorName;

      const actorTag = document.createElement('span');
      actorTag.className = `check-actor-tag ${isSelf ? 'is-self' : 'is-other'}`;
      actorTag.textContent = isSelf ? 'あなた' : '他プレイヤー';

      badges.append(catBadge, actorName, actorTag);
      if (isHostActor && !isSelf) {
        const hostTag = document.createElement('span');
        hostTag.className = 'check-actor-tag is-host';
        hostTag.textContent = 'ホスト';
        badges.appendChild(hostTag);
      }

      const meta = document.createElement('div');
      meta.className = 'check-item-meta';

      const phasePill = document.createElement('span');
      phasePill.className = 'check-phase-pill';
      phasePill.textContent = entry.phaseLabel;

      const timeEl = document.createElement('span');
      timeEl.className = 'check-time-text';
      timeEl.textContent = formatCheckTimestamp(entry.timestamp);

      meta.append(phasePill, timeEl);
      topRow.append(badges, meta);

      const labelEl = document.createElement('div');
      labelEl.className = 'check-item-label';
      labelEl.textContent = entry.settingLabel;

      item.append(topRow, labelEl);

      if (entry.beforeValue !== undefined || entry.afterValue !== undefined) {
        const diffRow = document.createElement('div');
        diffRow.className = 'check-item-diff';
        if (entry.beforeValue !== undefined) {
          const beforeEl = document.createElement('span');
          beforeEl.className = 'check-diff-before';
          beforeEl.textContent = entry.beforeValue;
          diffRow.appendChild(beforeEl);
        }
        if (entry.beforeValue !== undefined && entry.afterValue !== undefined) {
          const arrowEl = document.createElement('span');
          arrowEl.className = 'check-diff-arrow';
          arrowEl.textContent = '→';
          diffRow.appendChild(arrowEl);
        }
        if (entry.afterValue !== undefined) {
          const afterEl = document.createElement('span');
          afterEl.className = 'check-diff-after';
          afterEl.textContent = entry.afterValue;
          diffRow.appendChild(afterEl);
        }
        item.appendChild(diffRow);
      }

      list.appendChild(item);
    }

    if (prevScrollTop > 0) {
      list.scrollTop = prevScrollTop;
    }
  }

  private renderCheckModal(): HTMLElement {
    const backdrop = document.createElement('div');
    backdrop.className = 'overlay-backdrop overlay-backdrop-modal table-check-modal';
    backdrop.dataset.checkStructureKey = this.buildCheckModalStructureKey();
    backdrop.setAttribute('role', 'dialog');
    backdrop.setAttribute('aria-modal', 'true');
    backdrop.setAttribute('aria-label', '変更履歴チェック');
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) {
        this.closeCheckModal();
        this.renderFloating();
      }
    });

    const panel = document.createElement('div');
    panel.className = 'overlay-panel table-check-panel';

    const header = document.createElement('div');
    header.className = 'table-modal-header';

    const titleWrap = document.createElement('div');
    titleWrap.className = 'check-modal-title-wrap';

    const title = document.createElement('h3');
    title.textContent = '変更履歴チェック';

    const badge = document.createElement('span');
    badge.className = 'check-audit-badge';
    badge.textContent = 'AUDIT';

    titleWrap.append(title, badge);

    const headerActions = document.createElement('div');
    headerActions.className = 'check-header-actions';

    const refreshBtn = document.createElement('button');
    refreshBtn.type = 'button';
    refreshBtn.className = 'btn btn-secondary check-refresh-btn';
    refreshBtn.textContent = '更新';
    refreshBtn.addEventListener('click', () => {
      this.syncChangeHistory({ watch: true });
      soundEngine.playSelect();
      this.renderFloating();
    });

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'btn btn-secondary table-modal-close-btn';
    closeBtn.textContent = '閉じる';
    closeBtn.addEventListener('click', () => {
      this.closeCheckModal();
      this.renderFloating();
    });

    headerActions.append(refreshBtn, closeBtn);
    header.append(titleWrap, headerActions);

    const summaryBar = document.createElement('div');
    summaryBar.className = 'check-summary-bar';
    const summaryText = document.createElement('span');
    summaryText.className = 'check-summary-text';
    summaryBar.appendChild(summaryText);

    const filterBar = document.createElement('div');
    filterBar.className = 'check-filter-bar';

    const actorGroup = document.createElement('div');
    actorGroup.className = 'check-filter-group';
    actorGroup.setAttribute('role', 'group');
    actorGroup.setAttribute('aria-label', '変更者フィルタ');

    for (const mode of ['all', 'others'] as const) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-secondary check-filter-btn';
      btn.dataset.checkActorFilter = mode;
      btn.addEventListener('click', () => {
        this.checkActorFilter = mode;
        this.updateCheckModal(backdrop);
      });
      actorGroup.appendChild(btn);
    }

    const catGroup = document.createElement('div');
    catGroup.className = 'check-filter-group';
    catGroup.setAttribute('role', 'group');
    catGroup.setAttribute('aria-label', '変更種別フィルタ');

    for (const cat of ['all', 'cheat', 'settings'] as const) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-secondary check-filter-btn';
      btn.dataset.checkCategoryFilter = cat;
      btn.addEventListener('click', () => {
        this.checkCategoryFilter = cat;
        this.updateCheckModal(backdrop);
      });
      catGroup.appendChild(btn);
    }

    filterBar.append(actorGroup, catGroup);

    const list = document.createElement('div');
    list.className = 'check-history-list';

    panel.append(header, summaryBar, filterBar, list);
    backdrop.appendChild(panel);
    this.updateCheckModal(backdrop);
    return backdrop;
  }

  private renderSettingsModal(): HTMLElement {
    const backdrop = document.createElement('div');
    backdrop.className = 'overlay-backdrop overlay-backdrop-modal table-settings-modal';
    backdrop.setAttribute('role', 'dialog');
    backdrop.setAttribute('aria-modal', 'true');
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) {
        this.settingsOpen = false;
        this.renderFloating();
      }
    });

    const panel = document.createElement('div');
    panel.className = 'overlay-panel table-settings-panel';

    const header = document.createElement('div');
    header.className = 'table-modal-header';

    const title = document.createElement('h3');
    title.textContent = '設定';

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'btn btn-secondary table-modal-close-btn';
    closeBtn.textContent = '閉じる';
    closeBtn.addEventListener('click', () => {
      this.settingsOpen = false;
      this.renderFloating();
    });

    header.append(title, closeBtn);

    const row = document.createElement('div');
    row.className = 'setting-toggle-row';

    const label = document.createElement('div');
    label.className = 'setting-toggle-label';
    label.innerHTML =
      '<strong>フル画面表示（横画面固定）</strong><span class="hub-sub">画面全体を広く使い、対応端末では横向きに固定します</span>';

    const active = isFullscreenActive();
    const toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = `toggle-switch setting-toggle-controls${active ? ' is-on' : ''}`;
    toggleBtn.setAttribute('role', 'switch');
    toggleBtn.setAttribute('aria-checked', active ? 'true' : 'false');
    toggleBtn.setAttribute('aria-label', 'フル画面表示');

    const track = document.createElement('span');
    track.className = 'toggle-track';
    track.setAttribute('aria-hidden', 'true');
    const thumb = document.createElement('span');
    thumb.className = 'toggle-thumb';
    track.appendChild(thumb);

    const stateText = document.createElement('span');
    stateText.className = 'toggle-state-text';
    stateText.textContent = active ? 'ON' : 'OFF';

    toggleBtn.append(track, stateText);
    toggleBtn.addEventListener('click', () => {
      void this.setFullscreenEnabled(!active);
    });

    row.append(label, toggleBtn);

    const soundRow = document.createElement('div');
    soundRow.className = 'setting-toggle-row';

    const soundLabel = document.createElement('div');
    soundLabel.className = 'setting-toggle-label';
    soundLabel.innerHTML =
      '<strong>効果音</strong><span class="hub-sub">打牌・ツモ・リーチ・鳴き・和了などの音を再生します</span>';

    const soundActive = soundEngine.isEnabled();
    const soundToggleBtn = document.createElement('button');
    soundToggleBtn.type = 'button';
    soundToggleBtn.className = `toggle-switch setting-toggle-controls${soundActive ? ' is-on' : ''}`;
    soundToggleBtn.setAttribute('role', 'switch');
    soundToggleBtn.setAttribute('aria-checked', soundActive ? 'true' : 'false');
    soundToggleBtn.setAttribute('aria-label', '効果音');

    const soundTrack = document.createElement('span');
    soundTrack.className = 'toggle-track';
    soundTrack.setAttribute('aria-hidden', 'true');
    const soundThumb = document.createElement('span');
    soundThumb.className = 'toggle-thumb';
    soundTrack.appendChild(soundThumb);

    const soundStateText = document.createElement('span');
    soundStateText.className = 'toggle-state-text';
    soundStateText.textContent = soundActive ? 'ON' : 'OFF';

    soundToggleBtn.append(soundTrack, soundStateText);
    soundToggleBtn.addEventListener('click', () => {
      soundEngine.setEnabled(!soundActive);
      if (!soundActive) {
        soundEngine.playSelect();
      }
      this.renderFloating();
    });

    soundRow.append(soundLabel, soundToggleBtn);

    const table3dRow = document.createElement('div');
    table3dRow.className = 'setting-toggle-row';

    const table3dLabel = document.createElement('div');
    table3dLabel.className = 'setting-toggle-label';
    table3dLabel.innerHTML =
      '<strong>3D 麻雀卓（立体ビュー）</strong><span class="hub-sub">立牌・河・牌山を立体表示します（非対応環境では自動で2D表示になります）</span>';

    const table3dActive = this.table3dEnabled;
    const table3dBtn = document.createElement('button');
    table3dBtn.type = 'button';
    table3dBtn.className = `toggle-switch setting-toggle-3d-table${table3dActive ? ' is-on' : ''}`;
    table3dBtn.setAttribute('role', 'switch');
    table3dBtn.setAttribute('aria-checked', table3dActive ? 'true' : 'false');
    table3dBtn.setAttribute('aria-label', '3D 麻雀卓');

    const table3dTrack = document.createElement('span');
    table3dTrack.className = 'toggle-track';
    table3dTrack.setAttribute('aria-hidden', 'true');
    const table3dThumb = document.createElement('span');
    table3dThumb.className = 'toggle-thumb';
    table3dTrack.appendChild(table3dThumb);

    const table3dStateText = document.createElement('span');
    table3dStateText.className = 'toggle-state-text';
    table3dStateText.textContent = table3dActive ? 'ON' : 'OFF';

    table3dBtn.append(table3dTrack, table3dStateText);
    table3dBtn.addEventListener('click', () => {
      this.table3dEnabled = !this.table3dEnabled;
      save3dTablePreference(this.table3dEnabled);
      soundEngine.playSelect();
      this.render();
      this.renderFloating();
    });

    table3dRow.append(table3dLabel, table3dBtn);

    panel.append(header, row, soundRow, table3dRow);

    if (this.table3dEnabled) {
      const cameraRow = document.createElement('div');
      cameraRow.className = 'setting-camera-row';

      const cameraLabel = document.createElement('div');
      cameraLabel.className = 'setting-toggle-label';
      cameraLabel.innerHTML =
        '<strong>3D 視点アングル</strong><span class="hub-sub">卓をドラッグして見渡すこともできます（ダブルクリックで正面に戻ります）</span>';

      const cameraBtns = document.createElement('div');
      cameraBtns.className = 'setting-camera-btns';
      const presets: Array<{ id: Table3DCameraPreset; label: string }> = [
        { id: 'standard', label: '標準' },
        { id: 'high', label: '見下ろし' },
        { id: 'low', label: '迫力' },
      ];
      for (const preset of presets) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = `btn btn-secondary setting-camera-btn${
          this.table3dCameraPreset === preset.id ? ' is-active' : ''
        }`;
        b.textContent = preset.label;
        b.addEventListener('click', () => {
          this.table3dCameraPreset = preset.id;
          save3dCameraPreference(preset.id);
          resetTable3DCamera(this.gameContent ?? this.mainLayer);
          soundEngine.playSelect();
          this.render();
          this.renderFloating();
        });
        cameraBtns.appendChild(b);
      }

      const inGame =
        this.currentView !== null && this.currentView.phase !== 'lobby';
      if (inGame) {
        const resetBtn = document.createElement('button');
        resetBtn.type = 'button';
        resetBtn.className = 'btn btn-secondary setting-camera-reset-btn';
        resetBtn.textContent = '視点リセット';
        resetBtn.addEventListener('click', () => {
          resetTable3DCamera(this.gameContent ?? this.mainLayer);
          soundEngine.playSelect();
        });
        cameraBtns.appendChild(resetBtn);
      }

      cameraRow.append(cameraLabel, cameraBtns);
      panel.appendChild(cameraRow);
    }

    if (
      this.activeSession?.role === 'host' &&
      !this.activeSession.session.isOffline() &&
      this.currentView
    ) {
      const candidates = this.activeSession.session.getConnectedRemoteHumanIds();
      if (candidates.length > 0) {
        const handoverBox = document.createElement('div');
        handoverBox.className = 'setting-handover-box';

        const handoverTitle = document.createElement('strong');
        handoverTitle.textContent = 'ホスト権限の引き継ぎ';

        const handoverSub = document.createElement('span');
        handoverSub.className = 'hub-sub';
        handoverSub.textContent = '他のオンライン参加者へホスト権限を譲ります';

        const btnRow = document.createElement('div');
        btnRow.className = 'setting-handover-btns';
        for (const pid of candidates) {
          const p = this.currentView.players.find((pl) => pl.playerId === pid);
          if (!p) continue;
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'btn btn-secondary';
          b.textContent = `${p.name} に譲る`;
          b.addEventListener('click', () => {
            this.settingsOpen = false;
            this.renderFloating();
            this.transferHostAndStay(pid);
          });
          btnRow.appendChild(b);
        }
        handoverBox.append(handoverTitle, handoverSub, btnRow);
        panel.appendChild(handoverBox);
      }
    }

    if (this.fullscreenError) {
      const note = document.createElement('div');
      note.className = 'fullscreen-error-note';
      note.textContent = this.fullscreenError;
      panel.appendChild(note);
    }

    backdrop.appendChild(panel);
    return backdrop;
  }

  private renderChatModal(): HTMLElement {
    const backdrop = document.createElement('div');
    backdrop.className = 'overlay-backdrop overlay-backdrop-modal table-chat-modal';
    backdrop.setAttribute('role', 'dialog');
    backdrop.setAttribute('aria-modal', 'true');
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) {
        this.chatOpen = false;
        this.renderFloating();
      }
    });

    const panel = document.createElement('div');
    panel.className = 'overlay-panel table-chat-panel';

    const header = document.createElement('div');
    header.className = 'table-modal-header';

    const title = document.createElement('h3');
    title.textContent = 'チャット';

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'btn btn-secondary table-modal-close-btn';
    closeBtn.textContent = '閉じる';
    closeBtn.addEventListener('click', () => {
      this.chatOpen = false;
      this.renderFloating();
    });

    header.append(title, closeBtn);

    const list = document.createElement('div');
    list.className = 'chat-messages-list';
    this.populateChatMessagesList(list, { scrollToBottom: false });

    const quickBar = document.createElement('div');
    quickBar.className = 'chat-quick-bar';
    for (const phrase of ['よろしく！', 'ありがとう！', 'お見事！', 'もう1回！']) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'btn btn-secondary chat-quick-btn';
      chip.textContent = phrase;
      chip.addEventListener('click', () => {
        this.sendChatMessage(phrase);
      });
      quickBar.appendChild(chip);
    }

    const form = document.createElement('form');
    form.className = 'chat-input-row';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'input chat-input';
    input.placeholder = 'メッセージを入力...';
    input.maxLength = 200;
    input.value = this.chatDraft;
    input.addEventListener('input', () => {
      this.chatDraft = input.value;
    });

    const sendBtn = document.createElement('button');
    sendBtn.type = 'submit';
    sendBtn.className = 'btn btn-primary chat-send-btn';
    sendBtn.textContent = '送信';

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (this.sendChatMessage(input.value)) {
        input.value = '';
      }
    });

    form.append(input, sendBtn);
    panel.append(header, list, quickBar, form);
    backdrop.appendChild(panel);
    return backdrop;
  }

  private populateChatMessagesList(
    list: HTMLElement,
    options: { scrollToBottom?: boolean } = {},
  ): void {
    const shouldScroll = options.scrollToBottom ?? true;
    const prevScrollTop = list.scrollTop;

    list.innerHTML = '';
    if (this.chatMessages.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'hub-sub chat-empty';
      empty.textContent = 'メッセージはまだありません';
      list.appendChild(empty);
      return;
    }

    const viewerId = this.currentView?.viewerPlayerId ?? '';
    for (const msg of this.chatMessages) {
      const item = document.createElement('div');
      item.className = `chat-message-item${msg.senderId === viewerId ? ' is-self' : ''}`;

      const sender = document.createElement('span');
      sender.className = 'chat-message-sender';
      sender.textContent = msg.senderName;

      const text = document.createElement('span');
      text.className = 'chat-message-text';
      text.textContent = msg.text;

      item.append(sender, text);
      list.appendChild(item);
    }

    if (shouldScroll) {
      if (this.chatPinnedToBottom) {
        this.scrollChatMessagesToBottom(list);
      } else {
        list.scrollTop = prevScrollTop;
      }
    }
  }

  private cleanupChatAutoScroll(): void {
    if (this.chatAutoScrollCleanup) {
      this.chatAutoScrollCleanup();
      this.chatAutoScrollCleanup = null;
    }
  }

  private scrollChatMessagesToBottom(
    list: HTMLElement,
    options: { resetPin?: boolean } = {},
  ): void {
    this.cleanupChatAutoScroll();
    if (options.resetPin) {
      this.chatPinnedToBottom = true;
    }
    if (!this.chatPinnedToBottom) return;

    let disposed = false;
    let applyingProgramScroll = false;
    let userInteracted = false;
    const timerIds: Array<ReturnType<typeof setTimeout>> = [];
    const rafIds: number[] = [];
    let observer: ResizeObserver | null = null;

    const applyScroll = () => {
      if (
        disposed ||
        !list.isConnected ||
        !this.chatOpen ||
        !this.chatPinnedToBottom
      ) {
        return;
      }
      applyingProgramScroll = true;
      list.scrollTop = list.scrollHeight;
      if (typeof queueMicrotask === 'function') {
        queueMicrotask(() => {
          applyingProgramScroll = false;
        });
      } else {
        applyingProgramScroll = false;
      }
    };

    const markUserInteract = () => {
      userInteracted = true;
    };

    const onScroll = () => {
      if (disposed || applyingProgramScroll || !userInteracted) return;
      if (list.clientHeight <= 0 || list.scrollHeight <= list.clientHeight) {
        return;
      }
      const distanceFromBottom =
        list.scrollHeight - (list.scrollTop + list.clientHeight);
      this.chatPinnedToBottom = distanceFromBottom <= 8;
    };

    list.addEventListener('wheel', markUserInteract, { passive: true });
    list.addEventListener('touchstart', markUserInteract, { passive: true });
    list.addEventListener('pointerdown', markUserInteract, { passive: true });
    list.addEventListener('scroll', onScroll, { passive: true });

    applyScroll();

    if (typeof queueMicrotask === 'function') {
      queueMicrotask(applyScroll);
    }

    if (typeof requestAnimationFrame === 'function') {
      const id1 = requestAnimationFrame(() => {
        applyScroll();
        if (disposed || !list.isConnected) return;
        const id2 = requestAnimationFrame(() => {
          applyScroll();
        });
        rafIds.push(id2);
      });
      rafIds.push(id1);
    }

    for (const delayMs of [30, 100]) {
      const tid = setTimeout(() => {
        applyScroll();
      }, delayMs);
      timerIds.push(tid);
    }

    const fontsReady = (
      document as Document & { fonts?: { ready?: Promise<unknown> } }
    ).fonts?.ready;
    if (fontsReady && typeof fontsReady.then === 'function') {
      void fontsReady.then(() => {
        applyScroll();
      });
    }

    if (typeof ResizeObserver === 'function') {
      observer = new ResizeObserver(() => {
        applyScroll();
      });
      observer.observe(list);
      if (list.lastElementChild) {
        observer.observe(list.lastElementChild);
      }
    }

    this.chatAutoScrollCleanup = () => {
      disposed = true;
      list.removeEventListener('wheel', markUserInteract);
      list.removeEventListener('touchstart', markUserInteract);
      list.removeEventListener('pointerdown', markUserInteract);
      list.removeEventListener('scroll', onScroll);
      for (const tid of timerIds) {
        clearTimeout(tid);
      }
      if (typeof cancelAnimationFrame === 'function') {
        for (const rid of rafIds) {
          cancelAnimationFrame(rid);
        }
      }
      observer?.disconnect();
    };
  }
}

function formatCheckTimestamp(ts: number): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '--:--:--';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

const rootEl = document.getElementById('app');
if (!rootEl) {
  throw new Error('#app element not found');
}

const app = new MahjongApp(rootEl);

// 牌面のスプライトシートはフォント読み込み後に作る。
// 先に描くと CJK 非対応の serif にフォールバックした字形が焼き込まれてしまう。
// 失敗しても牌はテキスト描画にフォールバックするので、対局は止まらない。
void waitForTileFonts().then(() => {
  prewarmTileSpriteSheet();
  app.refreshTileFaces();
});
