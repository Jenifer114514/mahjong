import { deriveRules } from '../engine/rules';
import type { StateView } from '../types/message';
import type { GameLength, PlayerCount, RuleConfig } from '../types/rule';

export interface LobbyHandlers {
  onCreateRoom: (playerName: string, ruleConfig: RuleConfig) => void;
  onJoinRoom: (roomCode: string, playerName: string) => void;
  onLeaveLobby: () => void;
}

export interface LobbyFormState {
  playerName: string;
  playerCount: PlayerCount;
  gameLength: GameLength;
  joinCode: string;
}

export function renderLobbyEntry(
  container: HTMLElement,
  formState: LobbyFormState,
  handlers: LobbyHandlers,
  busy: boolean,
): void {
  container.innerHTML = '';

  const wrap = document.createElement('div');
  wrap.className = 'lobby-wrap';

  // Player name card
  const nameCard = document.createElement('div');
  nameCard.className = 'card';
  const nameField = document.createElement('div');
  nameField.className = 'field';
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

  const grid = document.createElement('div');
  grid.className = 'lobby-grid';

  // Create room card
  const createCard = document.createElement('div');
  createCard.className = 'card';
  const createTitle = document.createElement('h2');
  createTitle.textContent = '部屋を作る（ホスト）';
  createCard.appendChild(createTitle);

  // Player count selector
  const countField = document.createElement('div');
  countField.className = 'field';
  const countLabel = document.createElement('label');
  countLabel.textContent = '人数';
  const countSeg = document.createElement('div');
  countSeg.className = 'segmented';

  const countOptions: Array<{ value: PlayerCount; title: string; sub: string }> = [
    { value: 4, title: '4人麻雀', sub: '136枚 / 25,000点' },
    { value: 3, title: '3人麻雀', sub: '108枚(2〜8萬抜き) / 35,000点' },
  ];

  // Length selector references updated dynamically
  const lengthField = document.createElement('div');
  lengthField.className = 'field';
  const lengthLabel = document.createElement('label');
  lengthLabel.textContent = '長さ';
  const lengthSeg = document.createElement('div');
  lengthSeg.className = 'segmented';

  const renderRuleButtons = () => {
    countSeg.innerHTML = '';
    for (const opt of countOptions) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `seg-btn${formState.playerCount === opt.value ? ' is-active' : ''}`;
      btn.innerHTML = `${opt.title}<span class="seg-sub">${opt.sub}</span>`;
      btn.addEventListener('click', () => {
        formState.playerCount = opt.value;
        renderRuleButtons();
      });
      countSeg.appendChild(btn);
    }

    lengthSeg.innerHTML = '';
    const tonpuuRules = deriveRules({
      playerCount: formState.playerCount,
      gameLength: 'tonpuu',
    });
    const hanchanRules = deriveRules({
      playerCount: formState.playerCount,
      gameLength: 'hanchan',
    });

    const lengthOptions: Array<{ value: GameLength; title: string; sub: string }> = [
      { value: 'tonpuu', title: '東風戦', sub: `全${tonpuuRules.totalRounds}局（東場のみ）` },
      { value: 'hanchan', title: '半荘戦', sub: `全${hanchanRules.totalRounds}局（東・南場）` },
    ];

    for (const opt of lengthOptions) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `seg-btn${formState.gameLength === opt.value ? ' is-active' : ''}`;
      btn.innerHTML = `${opt.title}<span class="seg-sub">${opt.sub}</span>`;
      btn.addEventListener('click', () => {
        formState.gameLength = opt.value;
        renderRuleButtons();
      });
      lengthSeg.appendChild(btn);
    }
  };

  renderRuleButtons();
  countField.append(countLabel, countSeg);
  lengthField.append(lengthLabel, lengthSeg);

  const createBtn = document.createElement('button');
  createBtn.type = 'button';
  createBtn.className = 'btn btn-primary';
  createBtn.style.width = '100%';
  createBtn.disabled = busy;
  createBtn.textContent = busy ? '接続中...' : '部屋を作成';
  createBtn.addEventListener('click', () => {
    handlers.onCreateRoom(formState.playerName, {
      playerCount: formState.playerCount,
      gameLength: formState.gameLength,
    });
  });

  createCard.append(countField, lengthField, createBtn);

  // Join room card
  const joinCard = document.createElement('div');
  joinCard.className = 'card';
  const joinTitle = document.createElement('h2');
  joinTitle.textContent = '部屋に参加する（ゲスト）';

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

  const joinBtn = document.createElement('button');
  joinBtn.type = 'button';
  joinBtn.className = 'btn btn-primary';
  joinBtn.style.width = '100%';
  joinBtn.disabled = busy;
  joinBtn.textContent = busy ? '接続中...' : '参加する';
  joinBtn.addEventListener('click', () => {
    handlers.onJoinRoom(formState.joinCode, formState.playerName);
  });

  joinCard.append(joinTitle, codeField, joinBtn);

  grid.append(createCard, joinCard);
  wrap.appendChild(grid);
  container.appendChild(wrap);
}

export function renderWaitingRoom(
  container: HTMLElement,
  view: StateView,
  handlers: LobbyHandlers,
): void {
  container.innerHTML = '';
  const rules = deriveRules(view.ruleConfig);
  const isHost = view.viewerPlayerId === view.hostPlayerId;

  const card = document.createElement('div');
  card.className = 'card';

  const title = document.createElement('h2');
  title.textContent = isHost ? '対局ロビー（ホスト待機中）' : '対局ロビー（待機中）';
  card.appendChild(title);

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
  card.appendChild(codeBox);

  // Rules summary
  const ruleSummary = document.createElement('div');
  ruleSummary.className = 'hub-sub';
  const lengthLabel = view.ruleConfig.gameLength === 'tonpuu' ? '東風戦' : '半荘戦';
  ruleSummary.textContent = `ルール: ${rules.playerCount}人麻雀 / ${lengthLabel}（全${rules.totalRounds}局・${rules.totalTiles}枚・初期持ち点 ${rules.initialPoints.toLocaleString()}点・赤ドラなし）`;
  card.appendChild(ruleSummary);

  // Slots
  const slots = document.createElement('div');
  slots.className = 'player-slots';

  for (let i = 0; i < rules.playerCount; i++) {
    const player = view.players[i];
    const slot = document.createElement('div');
    slot.className = player ? 'player-slot' : 'player-slot is-empty';

    if (player) {
      const badge = player.playerId === view.hostPlayerId ? ' [ホスト]' : '';
      const selfTag = player.playerId === view.viewerPlayerId ? ' (あなた)' : '';
      slot.innerHTML = `<div><strong>${escapeHtml(player.name)}</strong>${badge}${selfTag}</div><div class="hub-sub">参加済み</div>`;
    } else {
      slot.textContent = `空席（参加待ち ${i + 1}/${rules.playerCount}）`;
    }
    slots.appendChild(slot);
  }
  card.appendChild(slots);

  const info = document.createElement('p');
  info.className = 'hub-sub';
  info.textContent = `参加人数（${view.players.length} / ${rules.playerCount}人）が揃うと自動的に対局が始まります。`;
  card.appendChild(info);

  const leaveBtn = document.createElement('button');
  leaveBtn.type = 'button';
  leaveBtn.className = 'btn btn-danger';
  leaveBtn.textContent = isHost ? '部屋を閉じる' : '退室する';
  leaveBtn.addEventListener('click', handlers.onLeaveLobby);
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
