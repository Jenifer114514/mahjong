// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type { StateView } from '../../types/message';
import {
  renderLobbyEntry,
  renderWaitingRoom,
  type LobbyFormState,
  type LobbyHandlers,
} from '../lobbyView';

// HostSession は peerjs を読み込むためスタブ化する（オフライン対局だけを使う）
vi.mock('peerjs', () => {
  class FakePeer {
    on() {}
    destroy() {}
    destroyed = false;
  }
  return { default: FakePeer };
});

const { HostSession } = await import('../../net/host');

function lobbySession(cpuCount: number): {
  session: InstanceType<typeof HostSession>;
  latest: () => StateView;
} {
  let current: StateView | null = null;
  const session = new HostSession(
    'ホスト',
    { playerCount: 4, gameLength: 'tonpuu' },
    {
      onViewChange: (view) => {
        current = view;
      },
      onStatusChange: () => {},
      onError: () => {},
    },
    { cpuCount, offline: true, cpuScheduler: () => {}, cpuDelayMs: 0 },
  );
  return {
    session,
    latest: () => current!,
  };
}

function clickByText(root: HTMLElement, text: string): boolean {
  const button = [...root.querySelectorAll('button')].find((btn) =>
    btn.textContent?.includes(text),
  );
  if (!button) return false;
  button.click();
  return true;
}

describe('renderWaitingRoom（空席・CPU席ごとの追加/削除ボタン）', () => {
  it('ホストには空席ごとに CPU 追加ボタン、CPU 席ごとに削除ボタンが出て、押すとハンドラが呼ばれる', () => {
    const { session, latest } = lobbySession(1);
    session.start();

    const handlers: LobbyHandlers = {
      onCreateRoom: () => {},
      onJoinRoom: () => {},
      onStartLocalGame: () => {},
      onLeaveLobby: () => {},
      onAddCpu: vi.fn(),
      onRemoveCpu: vi.fn(),
    };

    const root = document.createElement('div');
    renderWaitingRoom(root, latest(), handlers);

    expect(root.querySelector('.lobby-cpu-controls')).toBeNull();
    const emptySlots = root.querySelectorAll('.player-slot.is-empty');
    expect(emptySlots).toHaveLength(2);
    const addBtns = root.querySelectorAll<HTMLButtonElement>('.lobby-cpu-add-btn');
    expect(addBtns).toHaveLength(2);
    addBtns[1]!.click();
    expect(handlers.onAddCpu).toHaveBeenCalledTimes(1);

    const removeBtns = root.querySelectorAll<HTMLButtonElement>('.lobby-cpu-remove-btn');
    expect(removeBtns).toHaveLength(1);
    expect(removeBtns[0]!.closest('.player-slot')?.textContent).toContain('CPU');
    removeBtns[0]!.click();
    expect(handlers.onRemoveCpu).toHaveBeenCalledTimes(1);
    expect(handlers.onRemoveCpu).toHaveBeenCalledWith(
      latest().players[1]!.playerId,
    );

    session.destroy();
  });

  it('ゲスト（ホスト以外）には空席・CPU席の追加/削除ボタンを出さない', () => {
    const { session, latest } = lobbySession(1);
    session.start();

    const view = latest();
    const guestView: StateView = {
      ...view,
      viewerPlayerId: view.players[1]!.playerId,
    };

    const root = document.createElement('div');
    renderWaitingRoom(root, guestView, {
      onCreateRoom: () => {},
      onJoinRoom: () => {},
      onStartLocalGame: () => {},
      onLeaveLobby: () => {},
      onAddCpu: () => {},
      onRemoveCpu: () => {},
    });

    expect(root.querySelector('.lobby-cpu-add-btn')).toBeNull();
    expect(root.querySelector('.lobby-cpu-remove-btn')).toBeNull();

    session.destroy();
  });

  it('席が埋まっているときは空席と追加ボタンが消え、各 CPU 席に削除ボタンが出る', () => {
    const { session, latest } = lobbySession(3);
    session.start();

    const root = document.createElement('div');
    renderWaitingRoom(root, latest(), {
      onCreateRoom: () => {},
      onJoinRoom: () => {},
      onStartLocalGame: () => {},
      onLeaveLobby: () => {},
      onAddCpu: () => {},
      onRemoveCpu: () => {},
    });

    // CPU 3 体で 4 人ぶんが埋まる
    expect(latest().players).toHaveLength(4);
    expect(root.querySelectorAll('.player-slot.is-empty')).toHaveLength(0);
    expect(root.querySelectorAll('.lobby-cpu-add-btn')).toHaveLength(0);
    expect(root.querySelectorAll('.lobby-cpu-remove-btn')).toHaveLength(3);

    session.destroy();
  });

  it('ロビー入口では4人麻雀/3人麻雀と東風戦/半荘戦の選択のみを表示し、部屋作成時はCPU0体で作成する', () => {
    const onCreateRoom = vi.fn();
    const onStartLocalGame = vi.fn();
    const formState: LobbyFormState = {
      playerName: 'テスト',
      playerCount: 4,
      gameLength: 'tonpuu',
      tobi: true,
      tsumoLoss: false,
      allowKuitan: true,
      allowAtozuke: true,
      honbaBonus: true,
      joinCode: '',
      cpuCount: 0,
      cpuLevel: 'normal',
    };

    const root = document.createElement('div');
    renderLobbyEntry(
      root,
      formState,
      {
        onCreateRoom,
        onJoinRoom: () => {},
        onStartLocalGame,
        onLeaveLobby: () => {},
      },
      false,
    );

    // 入口に詳細トグルや CPU 強さ設定を出さない
    expect(root.querySelector('.rule-toggle-field')).toBeNull();
    expect(root.querySelectorAll('.seg-btn')).toHaveLength(4);
    expect(root.textContent).not.toContain('CPU の強さ');
    expect(root.textContent).not.toContain('CPU の人数');

    expect(clickByText(root, '3人麻雀')).toBe(true);
    expect(clickByText(root, '半荘戦')).toBe(true);
    expect(clickByText(root, '部屋を作成')).toBe(true);
    expect(onCreateRoom).toHaveBeenCalledWith(
      'テスト',
      expect.objectContaining({ playerCount: 3, gameLength: 'hanchan' }),
      0,
    );

    expect(clickByText(root, 'CPU対局をはじめる')).toBe(true);
    expect(onStartLocalGame).toHaveBeenCalledWith(
      'テスト',
      expect.objectContaining({ playerCount: 3, gameLength: 'hanchan' }),
      2,
    );
  });

  it('ルーム作成後のロビーではホストが4人/3人・東風/半荘と各種ON/OFF設定を変更できる（ゲストには編集UIを出さない）', () => {
    const { session, latest } = lobbySession(1);
    session.start();

    const onUpdateRuleConfig = vi.fn();
    const root = document.createElement('div');
    renderWaitingRoom(root, latest(), {
      onCreateRoom: () => {},
      onJoinRoom: () => {},
      onStartLocalGame: () => {},
      onLeaveLobby: () => {},
      onUpdateRuleConfig,
    });

    expect(root.querySelector('.lobby-settings-panel')).not.toBeNull();
    expect(clickByText(root, '3人麻雀')).toBe(true);
    expect(onUpdateRuleConfig).toHaveBeenCalledWith({ playerCount: 3 });

    expect(clickByText(root, '半荘戦')).toBe(true);
    expect(onUpdateRuleConfig).toHaveBeenCalledWith({ gameLength: 'hanchan' });

    // ON/OFF トグルスイッチ群（トビ終了・喰いタン・後付け・本場加算・ダブロン・喰い替え禁止・CPUやさしめ）
    const switches = [...root.querySelectorAll<HTMLButtonElement>('[role="switch"].toggle-switch')];
    expect(switches.length).toBeGreaterThanOrEqual(7);
    expect(switches[1]!.getAttribute('aria-checked')).toBe('true');
    switches[1]!.click(); // 喰いタン ON -> OFF
    expect(onUpdateRuleConfig).toHaveBeenCalledWith({ allowKuitan: false });

    // ゲスト視点では設定パネルを出さない
    const guestRoot = document.createElement('div');
    const view = latest();
    renderWaitingRoom(
      guestRoot,
      { ...view, viewerPlayerId: view.players[1]!.playerId },
      {
        onCreateRoom: () => {},
        onJoinRoom: () => {},
        onStartLocalGame: () => {},
        onLeaveLobby: () => {},
        onUpdateRuleConfig,
      },
    );
    expect(guestRoot.querySelector('.lobby-settings-panel')).toBeNull();

    session.destroy();
  });

  it('ホストの開始ボタンは人数不足で無効・人数充足で有効になり、ゲストには表示しない', () => {
    const onStartGame = vi.fn();
    const { session: sPartial, latest: latestPartial } = lobbySession(1);
    sPartial.start();

    const partialRoot = document.createElement('div');
    renderWaitingRoom(partialRoot, latestPartial(), {
      onCreateRoom: () => {},
      onJoinRoom: () => {},
      onStartLocalGame: () => {},
      onLeaveLobby: () => {},
      onStartGame,
    });
    const partialStart = partialRoot.querySelector<HTMLButtonElement>('.lobby-start-btn')!;
    expect(partialStart).not.toBeNull();
    expect(partialStart.disabled).toBe(true);

    const { session: sFull, latest: latestFull } = lobbySession(3);
    sFull.start();
    const fullRoot = document.createElement('div');
    renderWaitingRoom(fullRoot, latestFull(), {
      onCreateRoom: () => {},
      onJoinRoom: () => {},
      onStartLocalGame: () => {},
      onLeaveLobby: () => {},
      onStartGame,
    });
    const fullStart = fullRoot.querySelector<HTMLButtonElement>('.lobby-start-btn')!;
    expect(fullStart.disabled).toBe(false);
    fullStart.click();
    expect(onStartGame).toHaveBeenCalledTimes(1);

    const guestRoot = document.createElement('div');
    const view = latestFull();
    renderWaitingRoom(
      guestRoot,
      { ...view, viewerPlayerId: view.players[1]!.playerId },
      {
        onCreateRoom: () => {},
        onJoinRoom: () => {},
        onStartLocalGame: () => {},
        onLeaveLobby: () => {},
        onStartGame,
      },
    );
    expect(guestRoot.querySelector('.lobby-start-btn')).toBeNull();

    sPartial.destroy();
    sFull.destroy();
  });

  it('常設ルーム（銅・銀・金の間）と保存済み再接続バナーを表示・操作できる', () => {
    const onJoinPermanentRoom = vi.fn();
    const onReconnectSession = vi.fn();
    const onDiscardSavedSession = vi.fn();
    const formState: LobbyFormState = {
      playerName: 'テスト',
      playerCount: 4,
      gameLength: 'tonpuu',
      tobi: true,
      tsumoLoss: false,
      allowKuitan: true,
      allowAtozuke: true,
      honbaBonus: true,
      joinCode: '',
      cpuCount: 0,
      cpuLevel: 'normal',
    };

    const root = document.createElement('div');
    renderLobbyEntry(
      root,
      formState,
      {
        onCreateRoom: () => {},
        onJoinRoom: () => {},
        onStartLocalGame: () => {},
        onLeaveLobby: () => {},
        onJoinPermanentRoom,
        onReconnectSession,
        onDiscardSavedSession,
      },
      false,
      {
        savedSession: {
          roomCode: 'SILVER',
          hostPeerId: 'arena-mj-SILVER',
          hostEpoch: 0,
          playerId: 'p1',
          playerName: 'テスト',
          reconnectToken: 'tok-1',
          isSpectator: false,
          updatedAt: Date.now(),
        },
      },
    );

    expect(root.querySelector('.reconnect-card')).not.toBeNull();
    expect(root.textContent).toContain('銀の間');
    expect(root.querySelectorAll('.permanent-room-item')).toHaveLength(3);
    expect(clickByText(root, '銀の間に入る')).toBe(true);
    expect(onJoinPermanentRoom).toHaveBeenCalledWith('SILVER', 'テスト');

    expect(clickByText(root, '再接続する')).toBe(true);
    expect(onReconnectSession).toHaveBeenCalledTimes(1);

    expect(clickByText(root, '履歴を消す')).toBe(true);
    expect(onDiscardSavedSession).toHaveBeenCalledTimes(1);
  });

  it('待機ロビーではゲストへの「ホストを譲る」ボタンや観戦者バナーを表示する', () => {
    const onTransferHost = vi.fn();
    const onTransferHostAndLeave = vi.fn();
    const view: StateView = {
      roomCode: 'GOLD',
      hostPlayerId: 'p0',
      viewerPlayerId: 'p0',
      viewerSeatIndex: 0,
      phase: 'lobby',
      ruleConfig: { playerCount: 4, gameLength: 'hanchan' },
      round: null,
      players: [
        {
          playerId: 'p0',
          name: 'ホスト',
          seatIndex: 0,
          seatWind: 'E',
          score: 25000,
          isRiichi: false,
          isDoubleRiichi: false,
          discards: [],
          melds: [],
          kitaTiles: [],
          handCount: 0,
          hasDrawnTile: false,
          connected: true,
          isCurrentTurn: false,
          isDealer: true,
        },
        {
          playerId: 'p1',
          name: 'ゲスト',
          seatIndex: 1,
          seatWind: 'S',
          score: 25000,
          isRiichi: false,
          isDoubleRiichi: false,
          discards: [],
          melds: [],
          kitaTiles: [],
          handCount: 0,
          hasDrawnTile: false,
          connected: true,
          isCurrentTurn: false,
          isDealer: false,
        },
      ],
      spectators: [{ spectatorId: 'sp1', name: '観戦太郎', connected: true }],
      initialDealerIndex: 0,
      kyotakuCount: 0,
      finalKyotakuAward: null,
      myHand: [],
      myDrawnTile: null,
      myCallOptions: null,
      mySelfActions: null,
      isFuriten: false,
      kuikaeForbiddenKinds: [],
      responseRemainingMs: null,
    };

    const root = document.createElement('div');
    renderWaitingRoom(root, view, {
      onCreateRoom: () => {},
      onJoinRoom: () => {},
      onStartLocalGame: () => {},
      onLeaveLobby: () => {},
      onTransferHost,
      onTransferHostAndLeave,
    });

    expect(root.textContent).toContain('金の間 (GOLD)');
    expect(root.textContent).toContain('観戦待機 (1人): 観戦太郎');
    expect(clickByText(root, 'ホストを譲る')).toBe(true);
    expect(onTransferHost).toHaveBeenCalledWith('p1');
    expect(clickByText(root, 'ホストを譲って退出')).toBe(true);
    expect(onTransferHostAndLeave).toHaveBeenCalledTimes(1);

    const specRoot = document.createElement('div');
    renderWaitingRoom(
      specRoot,
      { ...view, viewerPlayerId: 'sp1', isSpectator: true },
      {
        onCreateRoom: () => {},
        onJoinRoom: () => {},
        onStartLocalGame: () => {},
        onLeaveLobby: () => {},
      },
    );
    expect(specRoot.querySelector('.spectator-lobby-banner')).not.toBeNull();
  });

  it('ホーム画面と待機ロビーにフル画面表示・横画面固定カードを置かない', () => {
    const formState: LobbyFormState = {
      playerName: 'テスト',
      playerCount: 4,
      gameLength: 'tonpuu',
      tobi: true,
      tsumoLoss: false,
      allowKuitan: true,
      allowAtozuke: true,
      honbaBonus: true,
      joinCode: '',
      cpuCount: 0,
      cpuLevel: 'normal',
    };

    const entryRoot = document.createElement('div');
    renderLobbyEntry(
      entryRoot,
      formState,
      {
        onCreateRoom: () => {},
        onJoinRoom: () => {},
        onStartLocalGame: () => {},
        onLeaveLobby: () => {},
      },
      false,
    );

    expect(entryRoot.querySelector('.landscape-lock-card')).toBeNull();
    expect(entryRoot.querySelector('.landscape-lock-switch')).toBeNull();
    expect(entryRoot.querySelector('.lobby-entry-top-grid')).toBeNull();
    expect(entryRoot.querySelector('.rule-toggle-field')).toBeNull();
    expect(entryRoot.querySelectorAll('.seg-btn')).toHaveLength(4);

    const { session, latest } = lobbySession(1);
    session.start();
    const waitRoot = document.createElement('div');
    renderWaitingRoom(waitRoot, latest(), {
      onCreateRoom: () => {},
      onJoinRoom: () => {},
      onStartLocalGame: () => {},
      onLeaveLobby: () => {},
    });
    expect(waitRoot.querySelector('.landscape-lock-box')).toBeNull();
    expect(waitRoot.querySelector('.landscape-lock-switch')).toBeNull();
    session.destroy();
  });

  it('ホーム画面の不要な説明文・サブ表記が削除され、常設ルームの参加状況と更新ボタンを表示できる', () => {
    const onRefreshRoomStatuses = vi.fn();
    const formState: LobbyFormState = {
      playerName: '',
      playerCount: 4,
      gameLength: 'tonpuu',
      tobi: true,
      tsumoLoss: false,
      allowKuitan: true,
      allowAtozuke: true,
      honbaBonus: true,
      joinCode: '',
      cpuCount: 0,
      cpuLevel: 'normal',
    };

    const root = document.createElement('div');
    renderLobbyEntry(
      root,
      formState,
      {
        onCreateRoom: () => {},
        onJoinRoom: () => {},
        onStartLocalGame: () => {},
        onLeaveLobby: () => {},
        onRefreshRoomStatuses,
      },
      false,
      {
        roomStatuses: {
          BRONZE: {
            status: 'occupied',
            info: {
              roomCode: 'BRONZE',
              phase: 'lobby',
              maxPlayers: 4,
              players: [
                { name: 'たろう', isCpu: false, connected: true, isHost: true },
                { name: '花子', isCpu: false, connected: false, isHost: false },
                { name: 'CPU1', isCpu: true, connected: true, isHost: false },
              ],
              spectatorNames: ['観戦太郎'],
            },
          },
          SILVER: { status: 'empty' },
          GOLD: { status: 'error' },
        },
      },
    );

    const text = root.textContent ?? '';
    // 赤線で指定された文言・追加削除指定文言がすべて消えていること
    for (const removed of [
      '136枚 / 25,000点',
      '108枚(2〜8萬抜き) / 35,000点',
      '全4局（東場のみ）',
      '全8局（東・南場）',
      '詳細ルールの ON / OFF',
      '部屋を作る（ホスト）',
      '部屋に参加する（ゲスト）',
      'いますぐCPUと対局（通信なし）',
      '部屋コードの共有なしで',
      '開いている卓があれば参加',
      '気軽に参加できる4人東風戦',
      '標準ルールの4人半荘戦',
      '頭ハネ（ダブロンなし）を採用',
    ]) {
      expect(text).not.toContain(removed);
    }
    expect(
      Array.from(root.querySelectorAll('label')).some(
        (l) => l.textContent === '人数' || l.textContent === '長さ',
      ),
    ).toBe(false);
    expect(text).toContain('部屋を作る');
    expect(text).toContain('部屋に参加する');
    expect(text).toContain('いますぐCPUと対局');

    // 金銀銅の間のバッジが統一されていること
    const tiers = Array.from(root.querySelectorAll('.permanent-room-tier')).map(
      (el) => el.textContent,
    );
    expect(new Set(tiers).size).toBe(1);

    // 銅の間・銀の間・金の間の参加者状況が表示されること
    const bronzeBox = root.querySelector('[data-room-occupancy="BRONZE"]')!;
    expect(bronzeBox.textContent).toContain('待機中');
    expect(bronzeBox.textContent).toContain('3/4人');
    expect(bronzeBox.textContent).toContain('観戦 1人');
    expect(bronzeBox.textContent).toContain('たろう (ホスト)');
    expect(bronzeBox.textContent).toContain('花子 (切断)');
    expect(bronzeBox.textContent).toContain('CPU1 (CPU)');
    expect(bronzeBox.textContent).toContain('観戦: 観戦太郎');

    const silverBox = root.querySelector('[data-room-occupancy="SILVER"]')!;
    expect(silverBox.textContent).toContain('空き（現在 0人）');

    const goldBox = root.querySelector('[data-room-occupancy="GOLD"]')!;
    expect(goldBox.textContent).toContain('状況を取得できませんでした');

    root
      .querySelector<HTMLButtonElement>('.permanent-rooms-refresh-btn')!
      .click();
    expect(onRefreshRoomStatuses).toHaveBeenCalledTimes(1);
  });

  it('待機ロビーにチャットボタンと未読バッジが表示され、クリックでハンドラが呼ばれる', () => {
    const { session, latest } = lobbySession(0);
    session.start();

    const onOpenChat = vi.fn();
    const root = document.createElement('div');
    renderWaitingRoom(
      root,
      latest(),
      {
        onCreateRoom: () => {},
        onJoinRoom: () => {},
        onStartLocalGame: () => {},
        onLeaveLobby: () => {},
        onOpenChat,
      },
      { unreadChatCount: 3 },
    );

    const chatBtn = root.querySelector<HTMLButtonElement>('.waiting-room-chat-btn')!;
    expect(chatBtn).not.toBeNull();
    expect(chatBtn.classList.contains('has-unread')).toBe(true);
    expect(chatBtn.querySelector('.chat-unread-badge')?.textContent).toBe('3');

    chatBtn.click();
    expect(onOpenChat).toHaveBeenCalledTimes(1);

    // 10件以上なら 9+ 表記
    renderWaitingRoom(
      root,
      latest(),
      {
        onCreateRoom: () => {},
        onJoinRoom: () => {},
        onStartLocalGame: () => {},
        onLeaveLobby: () => {},
        onOpenChat,
      },
      { unreadChatCount: 12 },
    );
    expect(
      root.querySelector('.waiting-room-chat-btn .chat-unread-badge')?.textContent,
    ).toBe('9+');

    session.destroy();
  });

  it('トップロビーにプレイヤー名コンパクトカード(.lobby-name-card / .lobby-name-field)を描画する', () => {
    const root = document.createElement('div');
    const formState: LobbyFormState = {
      playerName: '雀士テスト',
      playerCount: 4,
      gameLength: 'tonpuu',
      tobi: true,
      tsumoLoss: false,
      allowKuitan: true,
      allowAtozuke: true,
      honbaBonus: true,
      joinCode: '',
      cpuCount: 0,
      cpuLevel: 'normal',
    };
    renderLobbyEntry(
      root,
      formState,
      {
        onCreateRoom: () => {},
        onJoinRoom: () => {},
        onStartLocalGame: () => {},
        onLeaveLobby: () => {},
      },
      false,
    );

    const card = root.querySelector('.lobby-name-card');
    const field = root.querySelector('.lobby-name-card .lobby-name-field');
    const input = field?.querySelector<HTMLInputElement>('input');
    expect(card).not.toBeNull();
    expect(field).not.toBeNull();
    expect(input?.value).toBe('雀士テスト');
  });

  it('部屋作成時には詳細設定を出さず、作成後の待機ロビーの「詳細設定」から赤ドラ・切り上げ満貫・数え役満・連風牌符・初期点・ノーテン罰符・制限時間・カン上限を変更できる', () => {
    const onCreateRoom = vi.fn();
    const formState: LobbyFormState = {
      playerName: 'ホスト',
      playerCount: 4,
      gameLength: 'tonpuu',
      tobi: true,
      tsumoLoss: false,
      allowKuitan: true,
      allowAtozuke: true,
      honbaBonus: true,
      joinCode: '',
      cpuCount: 0,
      cpuLevel: 'normal',
    };

    const entryRoot = document.createElement('div');
    renderLobbyEntry(
      entryRoot,
      formState,
      {
        onCreateRoom,
        onJoinRoom: () => {},
        onStartLocalGame: () => {},
        onLeaveLobby: () => {},
      },
      false,
    );

    // 部屋作成入口画面には詳細設定UIを表示しない
    expect(entryRoot.querySelector('.lobby-advanced-details')).toBeNull();
    expect(entryRoot.querySelector('.lobby-entry-advanced-slot')).toBeNull();

    expect(clickByText(entryRoot, '部屋を作成')).toBe(true);
    expect(onCreateRoom).toHaveBeenCalledWith(
      'ホスト',
      expect.objectContaining({
        playerCount: 4,
        gameLength: 'tonpuu',
      }),
      0,
    );

    const setSelect = (root: HTMLElement, key: string, value: string) => {
      const sel = root.querySelector<HTMLSelectElement>(
        `select[data-adv-setting="${key}"]`,
      )!;
      expect(sel).not.toBeNull();
      sel.value = value;
      sel.dispatchEvent(new Event('change'));
    };

    // 作成後の待機ロビーでは「詳細設定」が表示され、8項目すべてを変更できる
    const { session, latest } = lobbySession(1);
    session.start();
    const onUpdateRuleConfig = vi.fn();
    const waitRoot = document.createElement('div');
    renderWaitingRoom(waitRoot, latest(), {
      onCreateRoom: () => {},
      onJoinRoom: () => {},
      onStartLocalGame: () => {},
      onLeaveLobby: () => {},
      onUpdateRuleConfig,
    });
    const details = waitRoot.querySelector<HTMLDetailsElement>(
      '.lobby-advanced-details',
    );
    expect(details).not.toBeNull();
    expect(details!.querySelector('.lobby-advanced-summary')?.textContent).toBe(
      '詳細設定',
    );
    expect(waitRoot.textContent).toContain('赤ドラあり');
    expect(
      waitRoot.querySelector<HTMLSelectElement>('select[data-adv-setting="adv-red-dora"]')!
        .value,
    ).toBe('1');
    setSelect(waitRoot, 'adv-red-dora', '0');
    expect(onUpdateRuleConfig).toHaveBeenCalledWith({ redDoraPerFive: 0 });
    setSelect(waitRoot, 'adv-red-dora', '4');
    expect(onUpdateRuleConfig).toHaveBeenCalledWith({ redDoraPerFive: 4 });
    setSelect(waitRoot, 'adv-kiriage-mangan', 'true');
    expect(onUpdateRuleConfig).toHaveBeenCalledWith({ kiriageMangan: true });
    setSelect(waitRoot, 'adv-kazoe-yakuman', 'false');
    expect(onUpdateRuleConfig).toHaveBeenCalledWith({ allowKazoeYakuman: false });
    setSelect(waitRoot, 'adv-double-wind-fu', '2');
    expect(onUpdateRuleConfig).toHaveBeenCalledWith({ doubleWindPairFu: 2 });
    setSelect(waitRoot, 'initialPoints', '50000');
    expect(onUpdateRuleConfig).toHaveBeenCalledWith({ initialPoints: 50000 });
    setSelect(waitRoot, 'notenPenaltyTotal', '0');
    expect(onUpdateRuleConfig).toHaveBeenCalledWith({ notenPenaltyTotal: 0 });
    setSelect(waitRoot, 'adv-response-timeout', '0');
    expect(onUpdateRuleConfig).toHaveBeenCalledWith({ responseTimeoutMs: 0 });
    setSelect(waitRoot, 'adv-max-kans', '8');
    expect(onUpdateRuleConfig).toHaveBeenCalledWith({ maxKansPerRound: 8 });
    session.destroy();
  });
});

