import './ui/styles.css';
import { ClientSession } from './net/client';
import { HostSession } from './net/host';
import { normalizeRoomCode } from './net/protocol';
import type { GameError, StateView } from './types/message';
import type { RuleConfig } from './types/rule';
import {
  renderLobbyEntry,
  renderWaitingRoom,
  type LobbyFormState,
} from './ui/lobbyView';
import { renderGameTable } from './ui/tableView';

type Session =
  | { role: 'host'; session: HostSession }
  | { role: 'client'; session: ClientSession };

class MahjongApp {
  private readonly root: HTMLElement;
  private activeSession: Session | null = null;
  private currentView: StateView | null = null;
  private statusText = '未接続';
  private statusKind: 'normal' | 'ok' | 'err' = 'normal';
  private errorBanner: string | null = null;
  private busy = false;
  private actionInFlight = false;
  private riichiSelectingMode = false;
  private autoTsumogiriEnabled = true;
  private autoTsumogiriTimerId: ReturnType<typeof setTimeout> | null = null;
  private countdownDeadline: number | null = null;
  private countdownTimerId: ReturnType<typeof setInterval> | null = null;

  private readonly formState: LobbyFormState;

  constructor(root: HTMLElement) {
    this.root = root;
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
    };

    window.addEventListener('beforeunload', () => {
      this.cleanupSession();
    });

    this.render();
  }

  private createRoom(playerName: string, ruleConfig: RuleConfig): void {
    this.cleanupSession();
    this.busy = true;
    this.errorBanner = null;
    this.statusText = '部屋を作成中...';
    this.statusKind = 'normal';
    this.render();

    const host = new HostSession(playerName, ruleConfig, {
      onViewChange: (view) => {
        this.busy = false;
        this.actionInFlight = false;
        this.applyStateView(view);
      },
      onStatusChange: (status, detail) => {
        if (status === 'ready') {
          this.busy = false;
          this.statusKind = 'ok';
          this.statusText = `ホスト稼働中 (${host.getRoomCode()})`;
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
    });

    this.activeSession = { role: 'host', session: host };
    host.start();
  }

  private joinRoom(roomCode: string, playerName: string): void {
    const normalized = normalizeRoomCode(roomCode);
    if (normalized.length === 0) {
      this.errorBanner = '部屋コードを入力してください。';
      this.render();
      return;
    }

    this.cleanupSession();
    this.busy = true;
    this.errorBanner = null;
    this.statusText = `部屋 ${normalized} に接続中...`;
    this.statusKind = 'normal';
    this.render();

    const client = new ClientSession(normalized, playerName, {
      onViewChange: (view) => {
        this.busy = false;
        this.actionInFlight = false;
        this.applyStateView(view);
      },
      onStatusChange: (status, detail) => {
        if (status === 'connected') {
          this.busy = false;
          this.statusKind = 'ok';
          this.statusText = `部屋 ${normalized} に接続中`;
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
    });

    this.activeSession = { role: 'client', session: client };
    client.connect();
  }

  private applyStateView(view: StateView): void {
    this.stopAutoTsumogiriTimer();
    this.riichiSelectingMode = false;
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
    this.scheduleAutoTsumogiriIfNeeded(view);
    this.render();
  }

  private scheduleAutoTsumogiriIfNeeded(view: StateView): void {
    if (!this.autoTsumogiriEnabled || !this.activeSession || this.actionInFlight) {
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
    this.riichiSelectingMode = false;
    this.actionInFlight = false;
    this.errorBanner = err.message;
    this.render();
  }

  private returnToLobby(): void {
    this.cleanupSession();
    this.currentView = null;
    this.busy = false;
    this.actionInFlight = false;
    this.riichiSelectingMode = false;
    this.errorBanner = null;
    this.statusText = '未接続';
    this.statusKind = 'normal';
    this.render();
  }

  private cleanupSession(): void {
    this.stopAutoTsumogiriTimer();
    this.stopCountdownTicker();
    if (!this.activeSession) return;
    this.activeSession.session.destroy();
    this.activeSession = null;
  }

  private dispatchAction(fn: (session: HostSession | ClientSession) => void): void {
    if (!this.activeSession || this.actionInFlight) return;
    this.actionInFlight = true;
    this.errorBanner = null;
    fn(this.activeSession.session);
  }

  private render(): void {
    this.root.innerHTML = '';

    const shell = document.createElement('div');
    shell.className = 'app-shell';

    // Top bar
    const topBar = document.createElement('header');
    topBar.className = 'top-bar';

    const title = document.createElement('div');
    title.className = 'app-title';
    title.textContent = 'PeerJS 対戦リーチ麻雀（第4段階）';

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

    topBar.append(title, rightControls);
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

    const content = document.createElement('main');
    shell.appendChild(content);

    const view = this.currentView;
    const lobbyHandlers = {
      onCreateRoom: (name: string, ruleConfig: RuleConfig) =>
        this.createRoom(name, ruleConfig),
      onJoinRoom: (code: string, name: string) => this.joinRoom(code, name),
      onLeaveLobby: () => this.returnToLobby(),
    };

    if (!view) {
      renderLobbyEntry(content, this.formState, lobbyHandlers, this.busy);
    } else if (view.phase === 'lobby') {
      renderWaitingRoom(content, view, lobbyHandlers);
    } else {
      renderGameTable(
        content,
        view,
        {
          onDiscardTile: (tileId) => {
            this.stopAutoTsumogiriTimer();
            this.dispatchAction((s) => s.discardTile(tileId));
          },
          onCallResponse: (choice) =>
            this.dispatchAction((s) => s.respondToCall(choice)),
          onDeclareTsumo: () => {
            this.stopAutoTsumogiriTimer();
            this.dispatchAction((s) => s.declareTsumo());
          },
          onDeclareRiichi: (tileId) => {
            this.stopAutoTsumogiriTimer();
            this.riichiSelectingMode = false;
            this.dispatchAction((s) => s.declareRiichi(tileId));
          },
          onDeclareAnkan: (kind) => {
            this.stopAutoTsumogiriTimer();
            this.dispatchAction((s) => s.declareAnkan(kind));
          },
          onDeclareKakan: (tileId) => {
            this.stopAutoTsumogiriTimer();
            this.dispatchAction((s) => s.declareKakan(tileId));
          },
          onDeclareKita: (tileId) => {
            this.stopAutoTsumogiriTimer();
            this.dispatchAction((s) => s.declareKita(tileId));
          },
          onDeclareKyuushuKyuuhai: () => {
            this.stopAutoTsumogiriTimer();
            this.dispatchAction((s) => s.declareKyuushuKyuuhai());
          },
          onToggleRiichiMode: (enabled) => {
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
        },
      );
    }

    this.root.appendChild(shell);
  }
}

const rootEl = document.getElementById('app');
if (!rootEl) {
  throw new Error('#app element not found');
}
new MahjongApp(rootEl);
