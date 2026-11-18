import './ui/styles.css';
import './ui/refine.css';
import { CPU_PLAYER_ID_PREFIX } from './cpu/player';
import {
  ClientSession,
  type ClientSessionCallbacks,
  type PromoteFromCheckpointParams,
} from './net/client';
import { HostSession, type HostSessionCallbacks } from './net/host';
import { normalizeRoomCode } from './net/protocol';
import {
  formatRoomDisplayName,
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
  ChatMessage,
  GameError,
  HostSnapshotPayload,
  StateView,
} from './types/message';
import { DEFAULT_CPU_LEVEL, type RuleConfig } from './types/rule';
import {
  renderLobbyEntry,
  renderWaitingRoom,
  type LobbyFormState,
} from './ui/lobbyView';
import { renderGameTable, type RoundEndStep } from './ui/tableView';
import { prewarmTileSpriteSheet, waitForTileFonts } from './ui/tileTexture';
import {
  createRotateOverlay,
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

class MahjongApp {
  private readonly root: HTMLElement;
  private readonly mainLayer: HTMLElement;
  private readonly floatingLayer: HTMLElement;
  private activeSession: Session | null = null;
  private currentView: StateView | null = null;
  private statusText = '未接続';
  private statusKind: 'normal' | 'ok' | 'err' = 'normal';
  private errorBanner: string | null = null;
  private busy = false;
  private actionInFlight = false;
  private riichiSelectingMode = false;
  private selectedDiscardTileId: string | null = null;
  private roundEndStep: RoundEndStep = 'details';
  private leaveConfirmPending = false;
  private settingsOpen = false;
  private chatOpen = false;
  private chatMessages: ChatMessage[] = [];
  private unreadChatCount = 0;
  private chatDraft = '';
  private fullscreenError: string | null = null;
  private autoTsumogiriEnabled = true;
  private autoAgariEnabled = false;
  private autoNoCallEnabled = false;
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
  private readonly handleFullscreenChange = () => {
    if (!this.root.isConnected) {
      document.removeEventListener('fullscreenchange', this.handleFullscreenChange);
      document.removeEventListener(
        'webkitfullscreenchange',
        this.handleFullscreenChange,
      );
      return;
    }
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
    this.floatingLayer = document.createElement('div');
    this.floatingLayer.className = 'app-floating-layer';
    this.root.innerHTML = '';
    this.root.append(this.mainLayer, this.floatingLayer);

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
      this.cleanupSession();
    });
    document.addEventListener('fullscreenchange', this.handleFullscreenChange);
    document.addEventListener(
      'webkitfullscreenchange',
      this.handleFullscreenChange,
    );
    document.addEventListener('visibilitychange', this.handleVisibilityChange);

    // 対局画面では横画面を必須にする（縦持ち時はローテーション案内で覆う）
    watchOrientation(() => this.syncOrientationOverlay());

    this.savedSession = loadSavedSessionRecord();
    this.render();
  }

  private buildHostCallbacks(
    getHost: () => HostSession,
    options: { fixedRoomCode?: string } = {},
  ): HostSessionCallbacks {
    return {
      onViewChange: (view) => {
        this.busy = false;
        this.actionInFlight = false;
        this.applyStateView(view);
      },
      onStatusChange: (status, detail) => {
        const host = getHost();
        if (status === 'ready') {
          this.busy = false;
          this.statusKind = 'ok';
          this.statusText = host.isOffline()
            ? 'ローカル対局（CPU戦）'
            : `${formatRoomDisplayName(host.getRoomCode())} (ホスト)`;
        } else if (status === 'error') {
          this.busy = false;
          this.statusKind = 'err';
          this.statusText = '接続エラー';
          this.errorBanner = detail ?? 'PeerJS接続エラーが発生しました。';
        } else if (status === 'closed') {
          this.busy = false;
          this.statusKind = 'normal';
          this.statusText = '未接続';
        } else {
          this.statusKind = 'normal';
          this.statusText = detail ?? '接続中...';
        }
        this.render();
      },
      onError: (err) => {
        this.handleGameError(err);
      },
      onChatMessage: (message) => {
        this.handleIncomingChat(message);
      },
      onChatHistory: (messages) => {
        this.handleChatHistory(messages);
      },
      onWelcome: (welcome) => {
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
        if (options.fixedRoomCode && roomCode === options.fixedRoomCode) {
          this.joinRoom(roomCode, this.formState.playerName);
        }
      },
      onHostSelfDemoted: (migration, localToken, localPlayerId) => {
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

  private buildClientCallbacks(roomCode: string): ClientSessionCallbacks {
    const label = formatRoomDisplayName(roomCode);
    return {
      onViewChange: (view) => {
        this.busy = false;
        this.actionInFlight = false;
        this.applyStateView(view);
      },
      onStatusChange: (status, detail) => {
        if (status === 'connected') {
          this.busy = false;
          this.statusKind = 'ok';
          this.statusText = this.currentView?.isSpectator
            ? `${label}（観戦中）`
            : `${label} に接続中`;
        } else if (status === 'error' || status === 'disconnected') {
          this.busy = false;
          this.statusKind = 'err';
          this.statusText = status === 'disconnected' ? '切断' : 'エラー';
          this.errorBanner = detail ?? '接続が切断されました。';
        } else {
          this.statusKind = 'normal';
          this.statusText = detail ?? '接続中...';
        }
        this.render();
      },
      onError: (err) => {
        this.handleGameError(err);
      },
      onChatMessage: (message) => {
        this.handleIncomingChat(message);
      },
      onChatHistory: (messages) => {
        this.handleChatHistory(messages);
      },
      onWelcome: (welcome) => {
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
        this.promoteToHostFromSnapshot(snapshot);
      },
      onPromoteFromCheckpoint: (params) => {
        this.promoteToHostFromCheckpoint(params);
      },
      onHostAwayChange: (away) => {
        if (this.hostAway !== away) {
          this.hostAway = away;
          this.render();
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
    this.statusText = fixedRoomCode
      ? `${formatRoomDisplayName(fixedRoomCode)} を開設中...`
      : '部屋を作成中...';
    this.statusKind = 'normal';
    this.render();

    let host!: HostSession;
    host = new HostSession(
      playerName,
      ruleConfig,
      this.buildHostCallbacks(() => host, { fixedRoomCode }),
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
    this.statusText = `${def.name} に接続確認中...`;
    this.statusKind = 'normal';
    this.render();

    const baseCallbacks = this.buildClientCallbacks(roomId);
    const client = new ClientSession(
      roomId,
      playerName,
      {
        ...baseCallbacks,
        onNoHostAvailable: () => {
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

    let host!: HostSession;
    host = new HostSession(
      hostName,
      snapshot.state.ruleConfig,
      this.buildHostCallbacks(() => host),
      {
        cpuDelayMs: 650,
        initialSnapshot: snapshot,
      },
    );

    this.activeSession = { role: 'host', session: host };
    this.statusKind = 'ok';
    this.statusText = `${formatRoomDisplayName(snapshot.state.roomCode)} (ホスト引継)`;
    host.start();
  }

  private promoteToHostFromCheckpoint(params: PromoteFromCheckpointParams): void {
    this.activeSession = null;
    this.busy = false;
    this.errorBanner = null;
    const hostName =
      params.latestView.players.find((p) => p.playerId === params.myPlayerId)
        ?.name ?? 'ホスト';

    let host!: HostSession;
    host = new HostSession(
      hostName,
      params.latestView.ruleConfig,
      this.buildHostCallbacks(() => host),
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
    this.statusKind = 'ok';
    this.statusText = `${formatRoomDisplayName(params.latestView.roomCode)} (ホスト引継)`;
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
    const client = new ClientSession(
      roomCode,
      playerName,
      this.buildClientCallbacks(roomCode),
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
  private removeCpuFromLobby(): void {
    if (this.activeSession?.role !== 'host') return;
    this.activeSession.session.removeCpu();
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
    this.statusText = `${formatRoomDisplayName(normalized)} に接続中...`;
    this.statusKind = 'normal';
    this.render();

    const client = new ClientSession(
      normalized,
      playerName,
      this.buildClientCallbacks(normalized),
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
    this.cleanupSession();
    this.currentView = null;
    this.busy = false;
    this.actionInFlight = false;
    this.riichiSelectingMode = false;
    this.selectedDiscardTileId = null;
    this.roundEndStep = 'details';
    this.leaveConfirmPending = false;
    this.perspectiveSeatIndex = 0;
    this.errorBanner = null;
    this.statusText = '未接続';
    this.statusKind = 'normal';
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

  private cleanupSession(): void {
    this.stopAutoTsumogiriTimer();
    this.stopAutoAssistTimer();
    this.stopCountdownTicker();
    this.settingsOpen = false;
    this.chatOpen = false;
    this.chatMessages = [];
    this.unreadChatCount = 0;
    this.chatDraft = '';
    this.fullscreenError = null;
    this.hostAway = false;
    this.hostTabWarning = false;
    void this.releaseWakeLock();
    this.renderFloating();
    if (!this.activeSession) return;
    this.activeSession.session.destroy();
    this.activeSession = null;
  }

  private handleIncomingChat(message: ChatMessage): void {
    if (this.chatMessages.some((m) => m.id === message.id)) return;
    this.chatMessages = [...this.chatMessages.slice(-49), message];
    if (this.chatOpen) {
      this.unreadChatCount = 0;
      const list = this.floatingLayer.querySelector<HTMLElement>('.chat-messages-list');
      if (list) {
        this.populateChatMessagesList(list);
      } else {
        this.renderFloating();
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

  private sendChatMessage(text: string): boolean {
    if (!this.activeSession) return false;
    const ok = this.activeSession.session.sendChat(text);
    if (ok) {
      this.chatDraft = '';
    }
    return ok;
  }

  private isFullscreenActive(): boolean {
    const doc = document as Document & { webkitFullscreenElement?: Element | null };
    return Boolean(doc.fullscreenElement ?? doc.webkitFullscreenElement);
  }

  private async setFullscreen(enabled: boolean): Promise<void> {
    this.fullscreenError = null;
    const doc = document as Document & {
      webkitFullscreenElement?: Element | null;
      webkitExitFullscreen?: () => Promise<void> | void;
    };
    const rootEl = document.documentElement as HTMLElement & {
      webkitRequestFullscreen?: () => Promise<void> | void;
    };

    try {
      if (enabled) {
        if (!this.isFullscreenActive()) {
          if (typeof rootEl.requestFullscreen === 'function') {
            await rootEl.requestFullscreen();
          } else if (typeof rootEl.webkitRequestFullscreen === 'function') {
            await rootEl.webkitRequestFullscreen();
          } else {
            this.fullscreenError =
              'お使いのブラウザではフル画面表示に対応していません。';
          }
        }
      } else if (this.isFullscreenActive()) {
        if (typeof doc.exitFullscreen === 'function') {
          await doc.exitFullscreen();
        } else if (typeof doc.webkitExitFullscreen === 'function') {
          await doc.webkitExitFullscreen();
        }
      }
    } catch {
      this.fullscreenError = enabled
        ? 'フル画面表示に切り替えられませんでした。ブラウザの設定をご確認ください。'
        : 'フル画面表示の解除に失敗しました。';
    }
    this.renderFloating();
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

  private render(): void {
    this.mainLayer.innerHTML = '';

    // 対局中は「雀卓だけ」を表示する（トップバーやサイドパネルを出さない）
    const inGame =
      this.currentView !== null && this.currentView.phase !== 'lobby';

    const shell = document.createElement('div');
    shell.className = inGame ? 'app-shell app-shell-table-only' : 'app-shell';

    // Top bar（対局中は出さない）
    const topBar = document.createElement('header');
    topBar.className = inGame ? 'top-bar is-hidden-in-game' : 'top-bar';

    const title = document.createElement('div');
    title.className = 'app-title';
    title.textContent = 'PeerJS 対戦リーチ麻雀';

    const rightControls = document.createElement('div');
    rightControls.style.display = 'flex';
    rightControls.style.alignItems = 'center';
    rightControls.style.gap = '8px';

    const statusPill = document.createElement('div');
    statusPill.className = `status-pill${
      this.statusKind === 'ok'
        ? ' is-ok'
        : this.statusKind === 'err'
          ? ' is-err'
          : ''
    }`;
    statusPill.textContent = this.statusText;
    rightControls.appendChild(statusPill);

    if (
      this.currentView &&
      this.currentView.players.some((p) =>
        p.playerId.startsWith(CPU_PLAYER_ID_PREFIX),
      )
    ) {
      const cpuPill = document.createElement('div');
      cpuPill.className = 'status-pill is-cpu';
      cpuPill.textContent = `CPU ${
        this.currentView.players.filter((p) =>
          p.playerId.startsWith(CPU_PLAYER_ID_PREFIX),
        ).length
      }体`;
      rightControls.appendChild(cpuPill);
    }

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

    const rotateHint = document.createElement('div');
    rotateHint.className = 'rotate-hint';
    rotateHint.textContent = '横画面推奨';

    topBar.append(title, rotateHint, rightControls);
    shell.appendChild(topBar);

    // Error banner
    if (this.errorBanner) {
      const banner = document.createElement('div');
      banner.className = 'error-banner';

      const msg = document.createElement('span');
      msg.textContent = this.errorBanner;

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
      shell.appendChild(banner);
    }

    const hostStatusBannerText = this.getHostStatusBannerText();
    if (!inGame && hostStatusBannerText) {
      const awayBanner = document.createElement('div');
      awayBanner.className = 'host-away-banner';
      awayBanner.setAttribute('role', 'alert');
      awayBanner.textContent = hostStatusBannerText;
      shell.appendChild(awayBanner);
    }

    const content = document.createElement('main');
    if (inGame) content.className = 'table-only-main';
    shell.appendChild(content);

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
      onRemoveCpu: () => this.removeCpuFromLobby(),
      onUpdateRuleConfig: (patch: Partial<RuleConfig>) =>
        this.updateLobbyRules(patch),
      onStartGame: () => this.startLobbyGame(),
      onTransferHost: (targetPlayerId: string) =>
        this.transferHostAndStay(targetPlayerId),
      onTransferHostAndLeave: () => this.transferHostAndLeave(),
    };

    if (!view) {
      renderLobbyEntry(content, this.formState, lobbyHandlers, this.busy, {
        savedSession: this.savedSession,
      });
    } else if (view.phase === 'lobby') {
      renderWaitingRoom(content, view, lobbyHandlers);
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
            this.fullscreenError = null;
            this.renderFloating();
          },
          onOpenChat: () => {
            this.chatOpen = !this.chatOpen;
            this.settingsOpen = false;
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
        },
      );
    }

    this.mainLayer.appendChild(shell);
    if (this.leaveConfirmPending && inGame) {
      this.mainLayer.appendChild(this.renderLeaveConfirmModal());
    }
    this.syncOrientationOverlay();
  }

  private renderFloating(): void {
    this.floatingLayer.innerHTML = '';
    const inGame =
      this.currentView !== null && this.currentView.phase !== 'lobby';
    if (!inGame) return;

    if (this.settingsOpen) {
      this.floatingLayer.appendChild(this.renderSettingsModal());
    } else if (this.chatOpen) {
      this.floatingLayer.appendChild(this.renderChatModal());
    }
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
      '<strong>フル画面表示</strong><span class="hub-sub">画面全体を広く使って対局します</span>';

    const active = this.isFullscreenActive();
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
      void this.setFullscreen(!active);
    });

    row.append(label, toggleBtn);
    panel.append(header, row);

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
    this.populateChatMessagesList(list);

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

  private populateChatMessagesList(list: HTMLElement): void {
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
    list.scrollTop = list.scrollHeight;
  }
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
