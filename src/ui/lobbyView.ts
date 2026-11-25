import { CPU_PLAYER_ID_PREFIX, isCpuPlayerId, maxCpuCount } from '../cpu/player';
import { deriveRules } from '../engine/rules';
import type { PermanentRoomProbeState } from '../net/roomProbe';
import {
  PERMANENT_ROOMS,
  formatRoomDisplayName,
  getPermanentRoom,
  type PermanentRoomId,
} from '../net/rooms';
import type { SavedSessionRecord } from '../net/storage';
import type { StateView } from '../types/message';
import {
  DEFAULT_CPU_LEVEL,
  type CpuLevel,
  type GameLength,
  type PlayerCount,
  type RuleConfig,
} from '../types/rule';

export interface LobbyHandlers {
  onCreateRoom: (playerName: string, ruleConfig: RuleConfig, cpuCount: number) => void;
  /** 通信を使わず CPU だけで遊ぶローカル対局を開始する */
  onStartLocalGame: (playerName: string, ruleConfig: RuleConfig, cpuCount: number) => void;
  onJoinRoom: (roomCode: string, playerName: string) => void;
  onLeaveLobby: () => void;
  /** 常設ルーム（銅・銀・金の間）へ入室する（空きならホスト化・開催中なら参加/観戦） */
  onJoinPermanentRoom?: (roomId: PermanentRoomId, playerName: string) => void;
  /** 保存された前回セッションへ再接続する */
  onReconnectSession?: () => void;
  /** 保存された前回セッション履歴を破棄する */
  onDiscardSavedSession?: () => void;
  /** ロビーに CPU を 1 体追加する（ホストのみ） */
  onAddCpu?: () => void;
  /** ロビーから CPU を 1 体減らす（ホストのみ） */
  onRemoveCpu?: () => void;
  /** ルーム作成後にルール設定を変更する（ホストのみ） */
  onUpdateRuleConfig?: (patch: Partial<RuleConfig>) => void;
  /** 人数が揃っているロビーから対局を開始する（ホストのみ） */
  onStartGame?: () => void;
  /** 他の接続中プレイヤーへホスト権限を委譲する */
  onTransferHost?: (targetPlayerId: string) => void;
  /** ホストを他の参加者へ譲って自分は退出する */
  onTransferHostAndLeave?: () => void;
  /** 常設ルームの参加状況を手動で再取得する */
  onRefreshRoomStatuses?: () => void;
  /** 待機ロビーでチャットを開く */
  onOpenChat?: () => void;
}

export interface LobbyEntryOptions {
  savedSession?: SavedSessionRecord | null;
  roomStatuses?: Partial<Record<PermanentRoomId, PermanentRoomProbeState>>;
  roomRefreshing?: boolean;
}

export interface WaitingRoomOptions {
  unreadChatCount?: number;
}

export interface LobbyFormState {
  playerName: string;
  playerCount: PlayerCount;
  gameLength: GameLength;
  tobi: boolean;
  tsumoLoss: boolean;
  allowKuitan: boolean;
  allowAtozuke: boolean;
  honbaBonus: boolean;
  joinCode: string;
  /** 追加する CPU の人数（部屋作成時は 0 でロビーへ入る） */
  cpuCount: number;
  /** CPU の強さ（既定: 'normal'） */
  cpuLevel?: CpuLevel;
  /** 赤ドラ枚数（5牌あたり: 0=なし, 1=各1枚, 4=全5赤） */
  redDoraPerFive?: 0 | 1 | 4;
  /** 切り上げ満貫 */
  kiriageMangan?: boolean;
  /** 数え役満 */
  allowKazoeYakuman?: boolean;
  /** 連風牌アタマの符 (2 | 4) */
  doubleWindPairFu?: 2 | 4;
  /** 初期持ち点カスタム（undefined で人数ごとの標準） */
  initialPoints?: number;
  /** 流局時ノーテン罰符合計 */
  notenPenaltyTotal?: number;
  /** 鳴き応答制限時間(ms、0で無制限) */
  responseTimeoutMs?: number;
  /** 1局の最大カン回数 */
  maxKansPerRound?: number;
}

const ADVANCED_DETAILS_OPEN_BY_CONTAINER = new WeakMap<HTMLElement, boolean>();

const INITIAL_POINTS_PRESETS = [10000, 20000, 25000, 30000, 35000, 50000, 100000] as const;
const NOTEN_PENALTY_PRESETS = [0, 1500, 3000, 6000, 12000] as const;
const TIMEOUT_PRESETS_MS = [5000, 10000, 15000, 30000, 60000, 0] as const;
const MAX_KAN_PRESETS = [1, 2, 4, 8, 12, 16] as const;

interface AdvancedRuleValues {
  playerCount: PlayerCount;
  redDoraPerFive: 0 | 1 | 4;
  kiriageMangan: boolean;
  allowKazoeYakuman: boolean;
  doubleWindPairFu: 2 | 4;
  initialPoints: number | undefined;
  notenPenaltyTotal: number;
  responseTimeoutMs: number;
  maxKansPerRound: number;
}

function createAdvancedRuleDetails(params: {
  containerKey?: HTMLElement;
  values: AdvancedRuleValues;
  onPatch: (patch: Partial<RuleConfig>) => void;
}): HTMLDetailsElement {
  const { containerKey, values, onPatch } = params;
  const details = document.createElement('details');
  details.className = 'lobby-advanced-details';
  if (containerKey && ADVANCED_DETAILS_OPEN_BY_CONTAINER.get(containerKey)) {
    details.open = true;
  }
  details.addEventListener('toggle', () => {
    if (containerKey) {
      ADVANCED_DETAILS_OPEN_BY_CONTAINER.set(containerKey, details.open);
    }
  });

  const summary = document.createElement('summary');
  summary.className = 'lobby-advanced-summary';
  summary.textContent = '詳細設定';

  const grid = document.createElement('div');
  grid.className = 'advanced-setting-grid';

  const addSelectRow = (
    id: string,
    labelText: string,
    options: Array<{ value: string; label: string }>,
    currentValue: string,
    onChange: (val: string) => void,
  ) => {
    const row = document.createElement('div');
    row.className = 'advanced-setting-row';
    const lbl = document.createElement('label');
    lbl.htmlFor = id;
    lbl.textContent = labelText;
    const select = document.createElement('select');
    select.id = id;
    select.className = 'advanced-select';
    select.dataset.advSetting = id;
    for (const opt of options) {
      const o = document.createElement('option');
      o.value = opt.value;
      o.textContent = opt.label;
      select.appendChild(o);
    }
    select.value = currentValue;
    select.addEventListener('change', () => onChange(select.value));
    row.append(lbl, select);
    grid.appendChild(row);
    return { row, select };
  };

  // 1. 赤ドラ
  addSelectRow(
    'adv-red-dora',
    '赤ドラ',
    [
      { value: '0', label: 'なし（標準）' },
      { value: '1', label: 'あり（各5に1枚）' },
      { value: '4', label: '全5が赤ドラ' },
    ],
    String(values.redDoraPerFive),
    (val) => {
      const next: 0 | 1 | 4 = val === '4' ? 4 : val === '1' ? 1 : 0;
      onPatch({ redDoraPerFive: next });
    },
  );

  // 2. 切り上げ満貫
  addSelectRow(
    'adv-kiriage-mangan',
    '切り上げ満貫',
    [
      { value: 'false', label: 'なし（標準）' },
      { value: 'true', label: 'あり（4翻30符・3翻60符→満貫）' },
    ],
    String(values.kiriageMangan),
    (val) => onPatch({ kiriageMangan: val === 'true' }),
  );

  // 3. 数え役満
  addSelectRow(
    'adv-kazoe-yakuman',
    '数え役満',
    [
      { value: 'true', label: 'あり（13翻〜・標準）' },
      { value: 'false', label: 'なし（上限三倍満）' },
    ],
    String(values.allowKazoeYakuman),
    (val) => onPatch({ allowKazoeYakuman: val === 'true' }),
  );

  // 4. 連風牌アタマの符
  addSelectRow(
    'adv-double-wind-fu',
    '連風牌アタマの符',
    [
      { value: '4', label: '4符（標準）' },
      { value: '2', label: '2符' },
    ],
    String(values.doubleWindPairFu),
    (val) => onPatch({ doubleWindPairFu: val === '2' ? 2 : 4 }),
  );

  // 5. 初期持ち点
  {
    const curPoints = values.initialPoints;
    const isDefault = curPoints === undefined;
    const isPreset =
      curPoints !== undefined &&
      (INITIAL_POINTS_PRESETS as readonly number[]).includes(curPoints);
    const selectVal = isDefault ? 'default' : isPreset ? String(curPoints) : 'custom';

    const row = document.createElement('div');
    row.className = 'advanced-setting-row';
    const lbl = document.createElement('label');
    lbl.htmlFor = 'adv-initial-points';
    lbl.textContent = '初期持ち点';

    const control = document.createElement('div');
    control.className = 'advanced-inline-control';

    const select = document.createElement('select');
    select.id = 'adv-initial-points';
    select.className = 'advanced-select';
    select.dataset.advSetting = 'initialPoints';

    const stdLabel =
      values.playerCount === 3 ? '標準（35,000点）' : '標準（25,000点）';
    const opts = [
      { value: 'default', label: stdLabel },
      ...INITIAL_POINTS_PRESETS.map((n) => ({
        value: String(n),
        label: `${n.toLocaleString()}点`,
      })),
      { value: 'custom', label: 'カスタム入力' },
    ];
    for (const opt of opts) {
      const o = document.createElement('option');
      o.value = opt.value;
      o.textContent = opt.label;
      select.appendChild(o);
    }
    select.value = selectVal;

    const numInput = document.createElement('input');
    numInput.type = 'number';
    numInput.className = 'text-input advanced-number-input';
    numInput.min = '1000';
    numInput.max = '1000000';
    numInput.step = '100';
    numInput.dataset.advSetting = 'initialPointsCustom';
    numInput.value = String(curPoints ?? (values.playerCount === 3 ? 35000 : 25000));
    numInput.hidden = selectVal !== 'custom';

    select.addEventListener('change', () => {
      if (select.value === 'default') {
        numInput.hidden = true;
        onPatch({ initialPoints: undefined });
      } else if (select.value === 'custom') {
        numInput.hidden = false;
        const parsed = Math.max(
          1000,
          Math.min(1000000, Math.round((Number(numInput.value) || 25000) / 100) * 100),
        );
        numInput.value = String(parsed);
        onPatch({ initialPoints: parsed });
      } else {
        numInput.hidden = true;
        onPatch({ initialPoints: Number(select.value) });
      }
    });

    numInput.addEventListener('change', () => {
      const raw = Number(numInput.value);
      if (!Number.isFinite(raw)) return;
      const clamped = Math.max(
        1000,
        Math.min(1000000, Math.round(raw / 100) * 100),
      );
      numInput.value = String(clamped);
      onPatch({ initialPoints: clamped });
    });

    control.append(select, numInput);
    row.append(lbl, control);
    grid.appendChild(row);
  }

  // 6. ノーテン罰符（合計）
  {
    const curNoten = values.notenPenaltyTotal;
    const isPreset = (NOTEN_PENALTY_PRESETS as readonly number[]).includes(curNoten);
    const selectVal = isPreset ? String(curNoten) : 'custom';

    const row = document.createElement('div');
    row.className = 'advanced-setting-row';
    const lbl = document.createElement('label');
    lbl.htmlFor = 'adv-noten-penalty';
    lbl.textContent = 'ノーテン罰符（合計）';

    const control = document.createElement('div');
    control.className = 'advanced-inline-control';

    const select = document.createElement('select');
    select.id = 'adv-noten-penalty';
    select.className = 'advanced-select';
    select.dataset.advSetting = 'notenPenaltyTotal';
    const opts = [
      ...NOTEN_PENALTY_PRESETS.map((n) => ({
        value: String(n),
        label:
          n === 3000
            ? '3,000点（標準）'
            : n === 0
              ? '0点（罰符なし）'
              : `${n.toLocaleString()}点`,
      })),
      { value: 'custom', label: 'カスタム入力' },
    ];
    for (const opt of opts) {
      const o = document.createElement('option');
      o.value = opt.value;
      o.textContent = opt.label;
      select.appendChild(o);
    }
    select.value = selectVal;

    const numInput = document.createElement('input');
    numInput.type = 'number';
    numInput.className = 'text-input advanced-number-input';
    numInput.min = '0';
    numInput.max = '12000';
    numInput.step = '100';
    numInput.dataset.advSetting = 'notenPenaltyTotalCustom';
    numInput.value = String(curNoten);
    numInput.hidden = selectVal !== 'custom';

    select.addEventListener('change', () => {
      if (select.value === 'custom') {
        numInput.hidden = false;
        const parsed = Math.max(
          0,
          Math.min(12000, Math.round((Number(numInput.value) || 0) / 100) * 100),
        );
        numInput.value = String(parsed);
        onPatch({ notenPenaltyTotal: parsed });
      } else {
        numInput.hidden = true;
        onPatch({ notenPenaltyTotal: Number(select.value) });
      }
    });

    numInput.addEventListener('change', () => {
      const raw = Number(numInput.value);
      if (!Number.isFinite(raw)) return;
      const clamped = Math.max(0, Math.min(12000, Math.round(raw / 100) * 100));
      numInput.value = String(clamped);
      onPatch({ notenPenaltyTotal: clamped });
    });

    control.append(select, numInput);
    row.append(lbl, control);
    grid.appendChild(row);
  }

  // 7. 鳴き制限時間
  {
    const timeoutOpts = TIMEOUT_PRESETS_MS.map((ms) => ({
      value: String(ms),
      label:
        ms === 0
          ? '無制限'
          : ms === 15000
            ? '15秒（標準）'
            : `${Math.round(ms / 1000)}秒`,
    }));
    const currentStr = String(values.responseTimeoutMs);
    if (!timeoutOpts.some((o) => o.value === currentStr)) {
      timeoutOpts.unshift({
        value: currentStr,
        label: `${Math.round(values.responseTimeoutMs / 1000)}秒`,
      });
    }
    addSelectRow(
      'adv-response-timeout',
      '鳴き制限時間',
      timeoutOpts,
      currentStr,
      (val) => onPatch({ responseTimeoutMs: Number(val) }),
    );
  }

  // 8. 1局のカン上限
  {
    const kanOpts = MAX_KAN_PRESETS.map((n) => ({
      value: String(n),
      label: n === 4 ? '4回（標準）' : `${n}回`,
    }));
    const currentStr = String(values.maxKansPerRound);
    if (!kanOpts.some((o) => o.value === currentStr)) {
      kanOpts.unshift({ value: currentStr, label: `${currentStr}回` });
    }
    addSelectRow(
      'adv-max-kans',
      '1局のカン上限',
      kanOpts,
      currentStr,
      (val) => onPatch({ maxKansPerRound: Number(val) }),
    );
  }

  details.append(summary, grid);
  return details;
}

function createOnOffToggleField(params: {
  label: string;
  value: boolean;
  onSub: string;
  offSub: string;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}): HTMLElement {
  const field = document.createElement('div');
  field.className = 'field rule-toggle-field';

  const meta = document.createElement('div');
  meta.className = 'rule-toggle-meta';

  const lbl = document.createElement('span');
  lbl.className = 'rule-toggle-label';
  lbl.textContent = params.label;

  const subSpan = document.createElement('span');
  subSpan.className = 'seg-sub rule-toggle-sub';
  subSpan.textContent = params.value ? params.onSub : params.offSub;

  meta.append(lbl, subSpan);

  const toggleBtn = document.createElement('button');
  toggleBtn.type = 'button';
  toggleBtn.className = `toggle-switch${params.value ? ' is-on' : ''}`;
  toggleBtn.setAttribute('role', 'switch');
  toggleBtn.setAttribute('aria-checked', params.value ? 'true' : 'false');
  toggleBtn.setAttribute('aria-label', params.label);
  toggleBtn.disabled = Boolean(params.disabled);

  const track = document.createElement('span');
  track.className = 'toggle-track';
  track.setAttribute('aria-hidden', 'true');
  const thumb = document.createElement('span');
  thumb.className = 'toggle-thumb';
  track.appendChild(thumb);

  const stateText = document.createElement('span');
  stateText.className = 'toggle-state-text';
  stateText.textContent = params.value ? 'ON' : 'OFF';

  toggleBtn.append(track, stateText);
  toggleBtn.addEventListener('click', () => {
    params.onChange(!params.value);
  });

  field.append(meta, toggleBtn);
  return field;
}

export function renderPermanentRoomOccupancy(
  target: HTMLElement,
  state: PermanentRoomProbeState = { status: 'checking' },
): void {
  target.innerHTML = '';

  if (state.status === 'checking') {
    const line = document.createElement('div');
    line.className = 'permanent-room-status-line is-checking';
    line.textContent = '参加状況を確認中...';
    target.appendChild(line);
    return;
  }

  if (state.status === 'empty') {
    const line = document.createElement('div');
    line.className = 'permanent-room-status-line is-empty';
    line.textContent = '空き（現在 0人）';
    target.appendChild(line);
    return;
  }

  if (state.status === 'error') {
    const line = document.createElement('div');
    line.className = 'permanent-room-status-line is-err';
    line.textContent = '状況を取得できませんでした';
    target.appendChild(line);
    return;
  }

  const info = state.info;
  const phaseLabel =
    info.phase === 'lobby'
      ? '待機中'
      : info.phase === 'finished'
        ? '終局'
        : '対局中';

  const statusLine = document.createElement('div');
  statusLine.className = 'permanent-room-status-line is-occupied';

  const phaseBadge = document.createElement('span');
  phaseBadge.className = `permanent-room-phase-badge${
    info.phase === 'lobby' ? ' is-lobby' : ' is-playing'
  }`;
  phaseBadge.textContent = phaseLabel;

  const countText = document.createElement('span');
  countText.textContent =
    info.spectatorNames.length > 0
      ? `${info.players.length}/${info.maxPlayers}人 ・ 観戦 ${info.spectatorNames.length}人`
      : `${info.players.length}/${info.maxPlayers}人`;

  statusLine.append(phaseBadge, countText);
  target.appendChild(statusLine);

  if (info.players.length > 0) {
    const members = document.createElement('div');
    members.className = 'permanent-room-members';
    for (const p of info.players) {
      const chip = document.createElement('span');
      chip.className = `permanent-room-member${p.isCpu ? ' is-cpu' : ''}${
        !p.connected ? ' is-disconnected' : ''
      }`;
      const tags: string[] = [];
      if (p.isHost) tags.push('ホスト');
      if (p.isCpu) tags.push('CPU');
      if (!p.connected) tags.push('切断');
      chip.textContent =
        tags.length > 0 ? `${p.name} (${tags.join('/')})` : p.name;
      members.appendChild(chip);
    }
    target.appendChild(members);
  }

  if (info.spectatorNames.length > 0) {
    const specLine = document.createElement('div');
    specLine.className = 'permanent-room-spectators';
    specLine.textContent = `観戦: ${info.spectatorNames.join('、')}`;
    target.appendChild(specLine);
  }
}

export function renderLobbyEntry(
  container: HTMLElement,
  formState: LobbyFormState,
  handlers: LobbyHandlers,
  busy: boolean,
  options: LobbyEntryOptions = {},
): void {
  container.innerHTML = '';

  const wrap = document.createElement('div');
  wrap.className = 'lobby-wrap';

  // 再接続バナー（前回のオンライン対局履歴が残っている場合のみ表示）
  const saved = options.savedSession;
  if (saved && handlers.onReconnectSession) {
    const reconnectCard = document.createElement('div');
    reconnectCard.className = 'card reconnect-card';

    const rcInfo = document.createElement('div');
    rcInfo.className = 'reconnect-info';

    const rcTitle = document.createElement('h2');
    rcTitle.textContent = '前回の対局に再接続できます';

    const rcSub = document.createElement('p');
    rcSub.className = 'hub-sub';
    rcSub.style.margin = '0';
    rcSub.textContent = `${formatRoomDisplayName(saved.roomCode)} / ${saved.playerName}${saved.isSpectator ? '（観戦）' : ''}`;

    rcInfo.append(rcTitle, rcSub);

    const rcActions = document.createElement('div');
    rcActions.className = 'reconnect-actions';

    const reconnectBtn = document.createElement('button');
    reconnectBtn.type = 'button';
    reconnectBtn.className = 'btn btn-primary reconnect-btn';
    reconnectBtn.disabled = busy;
    reconnectBtn.textContent = busy ? '接続中...' : '再接続する';
    reconnectBtn.addEventListener('click', () => handlers.onReconnectSession?.());

    const discardBtn = document.createElement('button');
    discardBtn.type = 'button';
    discardBtn.className = 'btn btn-secondary reconnect-discard-btn';
    discardBtn.disabled = busy;
    discardBtn.textContent = '履歴を消す';
    discardBtn.addEventListener('click', () => handlers.onDiscardSavedSession?.());

    rcActions.append(reconnectBtn, discardBtn);
    reconnectCard.append(rcInfo, rcActions);
    wrap.appendChild(reconnectCard);
  }

  // Player name card
  const nameCard = document.createElement('div');
  nameCard.className = 'card lobby-name-card';
  const nameField = document.createElement('div');
  nameField.className = 'field lobby-name-field';
  nameField.style.marginBottom = '0';

  const nameLabel = document.createElement('label');
  nameLabel.htmlFor = 'player-name-input';
  nameLabel.textContent = 'プレイヤー名（任意）';

  const nameInput = document.createElement('input');
  nameInput.id = 'player-name-input';
  nameInput.className = 'text-input';
  nameInput.type = 'text';
  nameInput.maxLength = 20;
  nameInput.placeholder = '例: たろう（未入力なら自動命名）';
  nameInput.value = formState.playerName;
  nameInput.addEventListener('input', () => {
    formState.playerName = nameInput.value;
  });

  nameField.append(nameLabel, nameInput);
  nameCard.appendChild(nameField);
  wrap.appendChild(nameCard);

  // 常設ルーム（銅の間 / 銀の間 / 金の間）
  const permCard = document.createElement('div');
  permCard.className = 'card permanent-rooms-card';

  const permHeader = document.createElement('div');
  permHeader.className = 'permanent-rooms-header';

  const permTitleRow = document.createElement('div');
  permTitleRow.className = 'permanent-rooms-title-row';

  const permTitle = document.createElement('h2');
  permTitle.style.margin = '0';
  permTitle.textContent = '常設ルーム（銅の間・銀の間・金の間）';

  permTitleRow.appendChild(permTitle);
  if (handlers.onRefreshRoomStatuses) {
    const refreshBtn = document.createElement('button');
    refreshBtn.type = 'button';
    refreshBtn.className = 'btn btn-secondary permanent-rooms-refresh-btn';
    refreshBtn.disabled = Boolean(options.roomRefreshing);
    refreshBtn.textContent = options.roomRefreshing ? '確認中...' : '状況を更新';
    refreshBtn.addEventListener('click', () =>
      handlers.onRefreshRoomStatuses?.(),
    );
    permTitleRow.appendChild(refreshBtn);
  }

  permHeader.append(permTitleRow);

  const permGrid = document.createElement('div');
  permGrid.className = 'permanent-rooms-grid';

  for (const room of PERMANENT_ROOMS) {
    const item = document.createElement('div');
    item.className = `permanent-room-item ${room.badgeClass}`;
    item.dataset.roomId = room.id;

    const topRow = document.createElement('div');
    topRow.className = 'permanent-room-top';

    const tierBadge = document.createElement('span');
    tierBadge.className = `permanent-room-tier ${room.badgeClass}`;
    tierBadge.textContent = room.tierLabel;

    const codeBadge = document.createElement('span');
    codeBadge.className = 'permanent-room-code';
    codeBadge.textContent = room.id;

    topRow.append(tierBadge, codeBadge);

    const roomTitle = document.createElement('h3');
    roomTitle.className = 'permanent-room-name';
    roomTitle.textContent = room.name;

    const occupancy = document.createElement('div');
    occupancy.className = 'permanent-room-occupancy';
    occupancy.dataset.roomOccupancy = room.id;
    renderPermanentRoomOccupancy(occupancy, options.roomStatuses?.[room.id]);

    const enterBtn = document.createElement('button');
    enterBtn.type = 'button';
    enterBtn.className = 'btn btn-primary permanent-room-enter-btn';
    enterBtn.disabled = busy;
    enterBtn.textContent = busy ? '接続中...' : `${room.name}に入る`;
    enterBtn.addEventListener('click', () => {
      if (handlers.onJoinPermanentRoom) {
        handlers.onJoinPermanentRoom(room.id, formState.playerName);
      } else {
        handlers.onJoinRoom(room.id, formState.playerName);
      }
    });

    item.append(topRow, roomTitle, occupancy, enterBtn);
    permGrid.appendChild(item);
  }

  permCard.append(permHeader, permGrid);
  wrap.appendChild(permCard);

  const grid = document.createElement('div');
  grid.className = 'lobby-grid';

  // Create room card: 4人/3人 と 東風/半荘 の選択のみ
  const createCard = document.createElement('div');
  createCard.className = 'card';
  const createTitle = document.createElement('h2');
  createTitle.textContent = '部屋を作る';
  createCard.appendChild(createTitle);

  const countField = document.createElement('div');
  countField.className = 'field';
  const countSeg = document.createElement('div');
  countSeg.className = 'segmented';

  const countOptions: Array<{ value: PlayerCount; title: string }> = [
    { value: 4, title: '4人麻雀' },
    { value: 3, title: '3人麻雀' },
  ];

  const lengthField = document.createElement('div');
  lengthField.className = 'field';
  const lengthSeg = document.createElement('div');
  lengthSeg.className = 'segmented';

  const lengthOptions: Array<{ value: GameLength; title: string }> = [
    { value: 'tonpuu', title: '東風戦' },
    { value: 'hanchan', title: '半荘戦' },
  ];

  const renderRuleButtons = () => {
    countSeg.innerHTML = '';
    for (const opt of countOptions) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `seg-btn${formState.playerCount === opt.value ? ' is-active' : ''}`;
      btn.textContent = opt.title;
      btn.addEventListener('click', () => {
        formState.playerCount = opt.value;
        renderRuleButtons();
      });
      countSeg.appendChild(btn);
    }

    lengthSeg.innerHTML = '';
    for (const opt of lengthOptions) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `seg-btn${formState.gameLength === opt.value ? ' is-active' : ''}`;
      btn.textContent = opt.title;
      btn.addEventListener('click', () => {
        formState.gameLength = opt.value;
        renderRuleButtons();
      });
      lengthSeg.appendChild(btn);
    }
  };

  renderRuleButtons();
  countField.append(countSeg);
  lengthField.append(lengthSeg);

  const buildBaseRuleConfig = (): RuleConfig => ({
    playerCount: formState.playerCount,
    gameLength: formState.gameLength,
    tobi: formState.tobi,
    tsumoLoss: formState.playerCount === 3 ? formState.tsumoLoss : false,
    allowKuitan: formState.allowKuitan,
    allowAtozuke: formState.allowAtozuke,
    honbaBonus: formState.honbaBonus,
    cpuLevel: formState.cpuLevel ?? DEFAULT_CPU_LEVEL,
    ...(formState.redDoraPerFive !== undefined
      ? { redDoraPerFive: formState.redDoraPerFive }
      : {}),
    ...(formState.kiriageMangan !== undefined
      ? { kiriageMangan: formState.kiriageMangan }
      : {}),
    ...(formState.allowKazoeYakuman !== undefined
      ? { allowKazoeYakuman: formState.allowKazoeYakuman }
      : {}),
    ...(formState.doubleWindPairFu !== undefined
      ? { doubleWindPairFu: formState.doubleWindPairFu }
      : {}),
    ...(formState.initialPoints !== undefined
      ? { initialPoints: formState.initialPoints }
      : {}),
    ...(formState.notenPenaltyTotal !== undefined
      ? { notenPenaltyTotal: formState.notenPenaltyTotal }
      : {}),
    ...(formState.responseTimeoutMs !== undefined
      ? { responseTimeoutMs: formState.responseTimeoutMs }
      : {}),
    ...(formState.maxKansPerRound !== undefined
      ? { maxKansPerRound: formState.maxKansPerRound }
      : {}),
  });

  const entryAdvancedSlot = document.createElement('div');
  entryAdvancedSlot.className = 'lobby-entry-advanced-slot';
  const renderEntryAdvanced = () => {
    const prevDetails = entryAdvancedSlot.querySelector<HTMLDetailsElement>(
      '.lobby-advanced-details',
    );
    const wasOpen = prevDetails?.open ?? false;
    entryAdvancedSlot.innerHTML = '';
    const details = createAdvancedRuleDetails({
      values: {
        playerCount: formState.playerCount,
        redDoraPerFive: formState.redDoraPerFive ?? 0,
        kiriageMangan: formState.kiriageMangan ?? false,
        allowKazoeYakuman: formState.allowKazoeYakuman ?? true,
        doubleWindPairFu: formState.doubleWindPairFu ?? 4,
        initialPoints: formState.initialPoints,
        notenPenaltyTotal: formState.notenPenaltyTotal ?? 3000,
        responseTimeoutMs: formState.responseTimeoutMs ?? 15000,
        maxKansPerRound: formState.maxKansPerRound ?? 4,
      },
      onPatch: (patch) => {
        if ('redDoraPerFive' in patch) {
          formState.redDoraPerFive = patch.redDoraPerFive;
        }
        if ('kiriageMangan' in patch) {
          formState.kiriageMangan = patch.kiriageMangan;
        }
        if ('allowKazoeYakuman' in patch) {
          formState.allowKazoeYakuman = patch.allowKazoeYakuman;
        }
        if ('doubleWindPairFu' in patch) {
          formState.doubleWindPairFu = patch.doubleWindPairFu;
        }
        if ('initialPoints' in patch) {
          formState.initialPoints = patch.initialPoints;
        }
        if ('notenPenaltyTotal' in patch) {
          formState.notenPenaltyTotal = patch.notenPenaltyTotal;
        }
        if ('responseTimeoutMs' in patch) {
          formState.responseTimeoutMs = patch.responseTimeoutMs;
        }
        if ('maxKansPerRound' in patch) {
          formState.maxKansPerRound = patch.maxKansPerRound;
        }
      },
    });
    if (wasOpen) {
      details.open = true;
    }
    entryAdvancedSlot.appendChild(details);
  };
  renderEntryAdvanced();

  // 人数切替時に初期持ち点「標準」ラベルも連動更新する
  countSeg.addEventListener('click', () => {
    renderEntryAdvanced();
  });

  const createBtn = document.createElement('button');
  createBtn.type = 'button';
  createBtn.className = 'btn btn-primary';
  createBtn.style.width = '100%';
  createBtn.disabled = busy;
  createBtn.textContent = busy ? '接続中...' : '部屋を作成';
  createBtn.addEventListener('click', () => {
    handlers.onCreateRoom(formState.playerName, buildBaseRuleConfig(), 0);
  });

  createCard.append(countField, lengthField, entryAdvancedSlot, createBtn);

  // Local (CPU only) game card
  const localCard = document.createElement('div');
  localCard.className = 'card card-local';

  const localTitle = document.createElement('h2');
  localTitle.textContent = 'いますぐCPUと対局';

  const localBtn = document.createElement('button');
  localBtn.type = 'button';
  localBtn.className = 'btn btn-primary';
  localBtn.style.width = '100%';
  localBtn.disabled = busy;
  localBtn.textContent = busy ? '接続中...' : 'CPU対局をはじめる';
  localBtn.addEventListener('click', () => {
    handlers.onStartLocalGame(
      formState.playerName,
      buildBaseRuleConfig(),
      maxCpuCount(formState.playerCount),
    );
  });

  localCard.append(localTitle, localBtn);

  // Join room card
  const joinCard = document.createElement('div');
  joinCard.className = 'card';
  const joinTitle = document.createElement('h2');
  joinTitle.textContent = '部屋に参加する';

  const codeField = document.createElement('div');
  codeField.className = 'field';
  const codeLabel = document.createElement('label');
  codeLabel.htmlFor = 'room-code-input';
  codeLabel.textContent = '部屋コード';

  const codeInput = document.createElement('input');
  codeInput.id = 'room-code-input';
  codeInput.className = 'text-input code-input';
  codeInput.type = 'text';
  codeInput.maxLength = 12;
  codeInput.placeholder = '例: ABC123';
  codeInput.value = formState.joinCode;
  codeInput.addEventListener('input', () => {
    formState.joinCode = codeInput.value.toUpperCase();
    codeInput.value = formState.joinCode;
  });

  codeField.append(codeLabel, codeInput);

  const joinNote = document.createElement('p');
  joinNote.className = 'hub-sub';
  joinNote.style.margin = '0 0 12px';
  joinNote.textContent =
    '待機中ならプレイヤーとして参加、対局中や満席時は観戦として入室します。';

  const joinBtn = document.createElement('button');
  joinBtn.type = 'button';
  joinBtn.className = 'btn btn-primary';
  joinBtn.style.width = '100%';
  joinBtn.disabled = busy;
  joinBtn.textContent = busy ? '接続中...' : '参加する';
  joinBtn.addEventListener('click', () => {
    handlers.onJoinRoom(formState.joinCode, formState.playerName);
  });

  joinCard.append(joinTitle, codeField, joinNote, joinBtn);

  grid.append(createCard, joinCard, localCard);
  wrap.appendChild(grid);
  container.appendChild(wrap);
}

export function renderWaitingRoom(
  container: HTMLElement,
  view: StateView,
  handlers: LobbyHandlers,
  options: WaitingRoomOptions = {},
): void {
  container.innerHTML = '';
  const rules = deriveRules(view.ruleConfig);
  const isSpectator = Boolean(view.isSpectator);
  const isHost = !isSpectator && view.viewerPlayerId === view.hostPlayerId;
  // ローカル対局（CPU戦）では部屋コードを表示しない
  const isLocalGame = view.roomCode === 'LOCAL';
  const permRoom = getPermanentRoom(view.roomCode);

  const card = document.createElement('div');
  card.className = 'card waiting-room-card';

  const headerRow = document.createElement('div');
  headerRow.className = 'waiting-room-header';

  const title = document.createElement('h2');
  title.textContent = isLocalGame
    ? 'ローカル対局（CPU戦）'
    : permRoom
      ? `${permRoom.name} (${permRoom.id}) — ${isHost ? 'ホスト待機中' : isSpectator ? '観戦待機中' : '待機中'}`
      : isHost
        ? '対局ロビー（ホスト待機中）'
        : isSpectator
          ? '対局ロビー（観戦待機中）'
          : '対局ロビー（待機中）';
  headerRow.appendChild(title);

  if (handlers.onOpenChat) {
    const unread = options.unreadChatCount ?? 0;
    const chatBtn = document.createElement('button');
    chatBtn.type = 'button';
    chatBtn.className = `btn btn-secondary waiting-room-chat-btn${
      unread > 0 ? ' has-unread' : ''
    }`;
    chatBtn.textContent = 'チャット';
    chatBtn.title = 'ロビーチャットを開く';
    if (unread > 0) {
      const badge = document.createElement('span');
      badge.className = 'chat-unread-badge';
      badge.textContent = unread > 9 ? '9+' : String(unread);
      chatBtn.appendChild(badge);
    }
    chatBtn.addEventListener('click', () => handlers.onOpenChat?.());
    headerRow.appendChild(chatBtn);
  }

  card.appendChild(headerRow);

  if (isSpectator) {
    const specNotice = document.createElement('div');
    specNotice.className = 'spectator-lobby-banner';
    specNotice.textContent =
      '現在は満席のため「観戦」として入室しています。対局が始まると観戦画面に切り替わります。';
    card.appendChild(specNotice);
  }

  // Room code box
  const codeBox = document.createElement('div');
  codeBox.className = 'room-code-box';

  const left = document.createElement('div');
  const codeCaption = document.createElement('div');
  codeCaption.className = 'hub-sub';
  codeCaption.textContent = '部屋コード（他の参加者に共有）';
  const codeVal = document.createElement('div');
  codeVal.className = 'room-code-value';
  codeVal.textContent = view.roomCode;
  left.append(codeCaption, codeVal);

  const actions = document.createElement('div');
  actions.className = 'room-code-actions';

  const copyCodeBtn = document.createElement('button');
  copyCodeBtn.type = 'button';
  copyCodeBtn.className = 'btn btn-secondary';
  copyCodeBtn.textContent = 'コードをコピー';
  copyCodeBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(view.roomCode);
      copyCodeBtn.textContent = 'コピーしました';
      setTimeout(() => {
        copyCodeBtn.textContent = 'コードをコピー';
      }, 1500);
    } catch {
      copyCodeBtn.textContent = view.roomCode;
    }
  });

  const copyUrlBtn = document.createElement('button');
  copyUrlBtn.type = 'button';
  copyUrlBtn.className = 'btn btn-secondary';
  copyUrlBtn.textContent = '招待URLをコピー';
  copyUrlBtn.addEventListener('click', async () => {
    const url = new URL(window.location.href);
    url.searchParams.set('room', view.roomCode);
    try {
      await navigator.clipboard.writeText(url.toString());
      copyUrlBtn.textContent = 'URLをコピーしました';
      setTimeout(() => {
        copyUrlBtn.textContent = '招待URLをコピー';
      }, 1500);
    } catch {
      copyUrlBtn.textContent = 'コピー不可';
    }
  });

  actions.append(copyCodeBtn, copyUrlBtn);
  codeBox.append(left, actions);
  if (!isLocalGame) {
    card.appendChild(codeBox);
  }

  // Rules summary
  const ruleSummary = document.createElement('div');
  ruleSummary.className = 'hub-sub';
  const lengthLabel = view.ruleConfig.gameLength === 'tonpuu' ? '東風戦' : '半荘戦';
  const redDoraLabel =
    rules.redDoraPerFive === 4
      ? '赤ドラ全5'
      : rules.redDoraPerFive === 1
        ? '赤ドラあり'
        : '赤ドラなし';
  const localDetails = [
    `トビ:${rules.tobi ? 'ON' : 'OFF'}`,
    `喰いタン:${rules.allowKuitan ? 'ON' : 'OFF'}`,
    `後付け:${rules.allowAtozuke ? 'ON' : 'OFF'}`,
    `本場加算:${rules.honbaBonus ? `ON(${rules.honbaPointsPerStick}点)` : 'OFF'}`,
    `ダブロン:${rules.doubleRon ? 'ON' : 'OFF(頭ハネ)'}`,
    `喰い替え禁止:${rules.forbidKuikae ? 'ON' : 'OFF'}`,
    `CPUやさしめ:${rules.cpuLevel === 'easy' ? 'ON' : 'OFF'}`,
    ...(rules.kiriageMangan ? ['切り上げ満貫:ON'] : []),
    ...(!rules.allowKazoeYakuman ? ['数え役満:OFF'] : []),
    ...(rules.doubleWindPairFu !== 4 ? [`連風牌:${rules.doubleWindPairFu}符`] : []),
    ...(rules.notenPenaltyTotal !== 3000
      ? [`ノーテン罰符:${rules.notenPenaltyTotal.toLocaleString()}点`]
      : []),
    ...(rules.responseTimeoutMs !== 15000
      ? [
          `鳴き時間:${rules.responseTimeoutMs === 0 ? '無制限' : `${Math.round(rules.responseTimeoutMs / 1000)}秒`}`,
        ]
      : []),
    ...(rules.maxKansPerRound !== 4 ? [`カン上限:${rules.maxKansPerRound}回`] : []),
    ...(rules.playerCount === 3
      ? [`ツモ損:${rules.tsumoLoss ? 'ON' : 'OFF'}`]
      : []),
  ].join(' / ');
  ruleSummary.textContent = `ルール: ${rules.playerCount}人麻雀 / ${lengthLabel}（全${rules.totalRounds}局・${rules.totalTiles}枚・初期持ち点 ${rules.initialPoints.toLocaleString()}点・${redDoraLabel}・${localDetails}）`;
  card.appendChild(ruleSummary);

  // ルーム作成後の設定編集（ホストのみ操作可）
  if (isHost && handlers.onUpdateRuleConfig) {
    const settingsPanel = document.createElement('div');
    settingsPanel.className = 'lobby-settings-panel';

    const settingsTitle = document.createElement('div');
    settingsTitle.className = 'lobby-settings-title';
    settingsTitle.textContent = 'ルーム設定（作成後も変更できます）';
    settingsPanel.appendChild(settingsTitle);

    const basicGrid = document.createElement('div');
    basicGrid.className = 'rule-toggle-grid';

    // 人数（4人麻雀 / 3人麻雀）
    const countField = document.createElement('div');
    countField.className = 'field rule-toggle-field';
    const countLbl = document.createElement('label');
    countLbl.textContent = '人数';
    const countSeg = document.createElement('div');
    countSeg.className = 'segmented';

    const countOpts: Array<{ value: PlayerCount; title: string; sub: string }> = [
      { value: 4, title: '4人麻雀', sub: '136枚 / 25,000点' },
      { value: 3, title: '3人麻雀', sub: '108枚 / 35,000点' },
    ];
    for (const opt of countOpts) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `seg-btn seg-btn-sm${rules.playerCount === opt.value ? ' is-active' : ''}`;
      btn.disabled = opt.value === 3 && view.players.length > 3;
      btn.innerHTML = `${opt.title}<span class="seg-sub">${opt.sub}</span>`;
      btn.addEventListener('click', () => {
        if (rules.playerCount === opt.value) return;
        handlers.onUpdateRuleConfig?.({ playerCount: opt.value });
      });
      countSeg.appendChild(btn);
    }
    countField.append(countLbl, countSeg);
    if (view.players.length > 3) {
      const note = document.createElement('div');
      note.className = 'hub-sub';
      note.textContent = '※ 参加者が4人のため3人麻雀へ変更できません（人数を減らすと変更できます）';
      countField.appendChild(note);
    }

    // 長さ（東風戦 / 半荘戦）
    const lengthField = document.createElement('div');
    lengthField.className = 'field rule-toggle-field';
    const lengthLbl = document.createElement('label');
    lengthLbl.textContent = '長さ';
    const lengthSeg = document.createElement('div');
    lengthSeg.className = 'segmented';

    const tonpuuRounds = deriveRules({
      playerCount: rules.playerCount,
      gameLength: 'tonpuu',
    }).totalRounds;
    const hanchanRounds = deriveRules({
      playerCount: rules.playerCount,
      gameLength: 'hanchan',
    }).totalRounds;

    const lengthOpts: Array<{ value: GameLength; title: string; sub: string }> = [
      { value: 'tonpuu', title: '東風戦', sub: `全${tonpuuRounds}局（東場のみ）` },
      { value: 'hanchan', title: '半荘戦', sub: `全${hanchanRounds}局（東・南場）` },
    ];
    for (const opt of lengthOpts) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `seg-btn seg-btn-sm${rules.gameLength === opt.value ? ' is-active' : ''}`;
      btn.innerHTML = `${opt.title}<span class="seg-sub">${opt.sub}</span>`;
      btn.addEventListener('click', () => {
        if (rules.gameLength === opt.value) return;
        handlers.onUpdateRuleConfig?.({ gameLength: opt.value });
      });
      lengthSeg.appendChild(btn);
    }
    lengthField.append(lengthLbl, lengthSeg);

    basicGrid.append(countField, lengthField);
    settingsPanel.appendChild(basicGrid);

    // それ以外の設定（すべて ON / OFF）
    const togglesGrid = document.createElement('div');
    togglesGrid.className = 'rule-toggle-grid rule-toggle-grid-switches';
    togglesGrid.style.marginBottom = '0';

    togglesGrid.appendChild(
      createOnOffToggleField({
        label: 'トビ終了（0点未満で終局）',
        value: rules.tobi,
        onSub: 'あり（0点は続行）',
        offSub: 'なし（飛び無し）',
        onChange: (next) => handlers.onUpdateRuleConfig?.({ tobi: next }),
      }),
    );

    togglesGrid.appendChild(
      createOnOffToggleField({
        label: '喰いタン（鳴いた断幺九）',
        value: rules.allowKuitan,
        onSub: '鳴きタンヤオ有効',
        offSub: '門前のみ',
        onChange: (next) => handlers.onUpdateRuleConfig?.({ allowKuitan: next }),
      }),
    );

    togglesGrid.appendChild(
      createOnOffToggleField({
        label: '後付け（片上がり・役後確定）',
        value: rules.allowAtozuke,
        onSub: '後付けあり',
        offSub: '先付けのみ',
        onChange: (next) => handlers.onUpdateRuleConfig?.({ allowAtozuke: next }),
      }),
    );

    togglesGrid.appendChild(
      createOnOffToggleField({
        label: '本場加算（積み棒ボーナス）',
        value: rules.honbaBonus,
        onSub: rules.playerCount === 3 ? '1本場 1,000点' : '1本場 300点',
        offSub: '本場表示のみ',
        onChange: (next) => handlers.onUpdateRuleConfig?.({ honbaBonus: next }),
      }),
    );

    togglesGrid.appendChild(
      createOnOffToggleField({
        label: 'ダブロン（複数人同時ロン）',
        value: rules.doubleRon,
        onSub: '複数人同時和了あり',
        offSub: '頭ハネ（上家優先）',
        onChange: (next) => handlers.onUpdateRuleConfig?.({ doubleRon: next }),
      }),
    );

    togglesGrid.appendChild(
      createOnOffToggleField({
        label: '喰い替え禁止',
        value: rules.forbidKuikae,
        onSub: '喰い替え禁止',
        offSub: '喰い替えあり',
        onChange: (next) => handlers.onUpdateRuleConfig?.({ forbidKuikae: next }),
      }),
    );

    togglesGrid.appendChild(
      createOnOffToggleField({
        label: 'CPUやさしめ（手加減モード）',
        value: rules.cpuLevel === 'easy',
        onSub: '鳴き・リーチ控えめ',
        offSub: '標準（積極的）',
        onChange: (next) =>
          handlers.onUpdateRuleConfig?.({ cpuLevel: next ? 'easy' : 'normal' }),
      }),
    );

    if (rules.playerCount === 3) {
      togglesGrid.appendChild(
        createOnOffToggleField({
          label: 'ツモ損（3人麻雀専用）',
          value: rules.tsumoLoss,
          onSub: '4麻と同額支払い',
          offSub: '北の分を2人で折半',
          onChange: (next) => handlers.onUpdateRuleConfig?.({ tsumoLoss: next }),
        }),
      );
    }

    settingsPanel.appendChild(togglesGrid);

    settingsPanel.appendChild(
      createAdvancedRuleDetails({
        containerKey: container,
        values: {
          playerCount: rules.playerCount,
          redDoraPerFive: rules.redDoraPerFive,
          kiriageMangan: rules.kiriageMangan,
          allowKazoeYakuman: rules.allowKazoeYakuman,
          doubleWindPairFu: rules.doubleWindPairFu === 2 ? 2 : 4,
          initialPoints: view.ruleConfig.initialPoints,
          notenPenaltyTotal: rules.notenPenaltyTotal,
          responseTimeoutMs: rules.responseTimeoutMs,
          maxKansPerRound: rules.maxKansPerRound,
        },
        onPatch: (patch) => handlers.onUpdateRuleConfig?.(patch),
      }),
    );

    card.appendChild(settingsPanel);
  }

  // Slots
  const slots = document.createElement('div');
  slots.className = 'player-slots';

  for (let i = 0; i < rules.playerCount; i++) {
    const player = view.players[i];
    const slot = document.createElement('div');
    slot.className = player ? 'player-slot' : 'player-slot is-empty';

    if (player) {
      const badge = player.playerId === view.hostPlayerId ? ' [ホスト]' : '';
      const selfTag =
        !isSpectator && player.playerId === view.viewerPlayerId ? ' (あなた)' : '';
      const statusLabel = player.connected ? '参加済み' : '切断（再接続待ち）';
      const headerDiv = document.createElement('div');
      headerDiv.innerHTML = `<div><strong>${escapeHtml(player.name)}</strong>${badge}${selfTag}</div><div class="hub-sub">${statusLabel}</div>`;
      slot.appendChild(headerDiv);

      if (
        isHost &&
        player.playerId !== view.hostPlayerId &&
        !isCpuPlayerId(player.playerId) &&
        player.connected &&
        handlers.onTransferHost
      ) {
        const transferBtn = document.createElement('button');
        transferBtn.type = 'button';
        transferBtn.className = 'btn btn-secondary lobby-transfer-btn';
        transferBtn.textContent = 'ホストを譲る';
        transferBtn.addEventListener('click', () => {
          handlers.onTransferHost?.(player.playerId);
        });
        slot.appendChild(transferBtn);
      }
    } else {
      slot.textContent = `空席（参加待ち ${i + 1}/${rules.playerCount}）`;
    }
    slots.appendChild(slot);
  }
  card.appendChild(slots);

  const connectedSpectators = (view.spectators ?? []).filter((s) => s.connected);
  if (connectedSpectators.length > 0) {
    const specLine = document.createElement('div');
    specLine.className = 'hub-sub lobby-spectators-line';
    specLine.textContent = `観戦待機 (${connectedSpectators.length}人): ${connectedSpectators.map((s) => s.name).join('、')}`;
    card.appendChild(specLine);
  }

  const cpuPlayers = view.players.filter((p) => p.playerId.startsWith(CPU_PLAYER_ID_PREFIX));
  const otherConnectedHumans = view.players.filter(
    (p) =>
      p.playerId !== view.hostPlayerId &&
      !isCpuPlayerId(p.playerId) &&
      p.connected,
  );
  const isFull = view.players.length === rules.playerCount;
  const info = document.createElement('p');
  info.className = 'hub-sub';
  info.textContent = isFull
    ? isHost
      ? '参加人数が揃っています。「対局を開始する」を押すと対局が始まります。'
      : '参加人数が揃いました。ホストが「対局を開始する」を押すのをお待ちください。'
    : cpuPlayers.length > 0
      ? `参加人数（${view.players.length} / ${rules.playerCount}人・うち CPU ${cpuPlayers.length}体）が揃ったら、ホストが「対局を開始する」を押して対局を始めます。`
      : `参加人数（${view.players.length} / ${rules.playerCount}人）が揃ったら、ホストが「対局を開始する」を押して対局を始めます。`;
  card.appendChild(info);

  // ホストは人数が揃った状態で開始ボタンを押して対局を開始する
  if (isHost && handlers.onStartGame) {
    const startBtn = document.createElement('button');
    startBtn.type = 'button';
    startBtn.className = 'btn btn-primary lobby-start-btn';
    startBtn.style.marginBottom = '10px';
    startBtn.disabled = !isFull;
    startBtn.textContent = '対局を開始する';
    startBtn.addEventListener('click', () => handlers.onStartGame?.());
    card.appendChild(startBtn);
  }

  // ホストはロビーにいる間、CPU を後から足し引きできる
  if (isHost && (handlers.onAddCpu || handlers.onRemoveCpu)) {
    const cpuControls = document.createElement('div');
    cpuControls.className = 'lobby-cpu-controls';

    const cpuCaption = document.createElement('div');
    cpuCaption.className = 'hub-sub';
    const remains = Math.max(0, rules.playerCount - view.players.length);
    cpuCaption.textContent =
      remains > 0
        ? `CPU を追加して人数を埋められます（あと ${remains} 席）`
        : '席がすべて埋まりました';

    const btnRow = document.createElement('div');
    btnRow.className = 'lobby-cpu-buttons';

    const addCpuBtn = document.createElement('button');
    addCpuBtn.type = 'button';
    addCpuBtn.className = 'btn btn-secondary';
    addCpuBtn.textContent = '＋ CPU を追加';
    addCpuBtn.disabled = remains <= 0;
    addCpuBtn.addEventListener('click', () => handlers.onAddCpu?.());

    const removeCpuBtn = document.createElement('button');
    removeCpuBtn.type = 'button';
    removeCpuBtn.className = 'btn btn-secondary';
    removeCpuBtn.textContent = '− CPU を減らす';
    removeCpuBtn.disabled = cpuPlayers.length === 0;
    removeCpuBtn.addEventListener('click', () => handlers.onRemoveCpu?.());

    btnRow.append(addCpuBtn, removeCpuBtn);
    cpuControls.append(cpuCaption, btnRow);
    card.appendChild(cpuControls);
  }

  const leaveBtn = document.createElement('button');
  leaveBtn.type = 'button';
  leaveBtn.className = 'btn btn-danger';
  if (isHost && otherConnectedHumans.length > 0 && handlers.onTransferHostAndLeave) {
    leaveBtn.textContent = 'ホストを譲って退出';
    leaveBtn.addEventListener('click', () => handlers.onTransferHostAndLeave?.());
  } else {
    leaveBtn.textContent = isHost ? '部屋を閉じる' : '退室する';
    leaveBtn.addEventListener('click', handlers.onLeaveLobby);
  }
  card.appendChild(leaveBtn);

  container.appendChild(card);
}

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
