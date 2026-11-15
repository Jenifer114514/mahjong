import { deriveRules } from '../engine/rules';
import type { PublicPlayerView, StateView } from '../types/message';
import {
  createTileBackElement,
  createTileElement,
  formatRoundName,
  windToJa,
} from './tileView';

export interface TableHandlers {
  onDiscardTile: (tileId: string) => void;
  onAdvanceRound: () => void;
  onReturnToLobby: () => void;
}

export function renderGameTable(
  container: HTMLElement,
  view: StateView,
  handlers: TableHandlers,
): void {
  container.innerHTML = '';

  const rules = deriveRules(view.ruleConfig);
  const playerCount = view.players.length;
  const isHost = view.viewerPlayerId === view.hostPlayerId;

  if (view.phase === 'finished') {
    renderFinishedScreen(container, view, rules.initialPoints, handlers);
    return;
  }

  const felt = document.createElement('div');
  felt.className = 'table-felt';

  // 相対座席の割り当て（下:自分、右:下家、上:対面(4人のみ)、左:上家）
  const selfPlayer = view.players.find((p) => p.seatIndex === view.viewerSeatIndex);
  const rightPlayer = view.players.find(
    (p) => p.seatIndex === (view.viewerSeatIndex + 1) % playerCount,
  );
  const topPlayer =
    playerCount === 4
      ? view.players.find(
          (p) => p.seatIndex === (view.viewerSeatIndex + 2) % playerCount,
        )
      : undefined;
  const leftPlayer =
    playerCount === 4
      ? view.players.find(
          (p) => p.seatIndex === (view.viewerSeatIndex + 3) % playerCount,
        )
      : view.players.find(
          (p) => p.seatIndex === (view.viewerSeatIndex + 2) % playerCount,
        );

  if (topPlayer) {
    felt.appendChild(renderOpponentSeat('seat-top', topPlayer));
  } else {
    const emptyTop = document.createElement('div');
    emptyTop.className = 'seat-top';
    felt.appendChild(emptyTop);
  }

  if (leftPlayer) {
    felt.appendChild(renderOpponentSeat('seat-left', leftPlayer));
  }

  felt.appendChild(renderCenterHub(view));

  if (rightPlayer) {
    felt.appendChild(renderOpponentSeat('seat-right', rightPlayer));
  }

  if (selfPlayer) {
    felt.appendChild(renderSelfSeat(view, selfPlayer, handlers));
  }

  container.appendChild(felt);

  // 流局バナー（第1段階はツモ→打牌ループのため牌山尽きで流局）
  if (view.phase === 'round_end' && view.round) {
    const overlay = document.createElement('div');
    overlay.className = 'overlay-panel';

    const heading = document.createElement('h2');
    heading.style.margin = '0';
    heading.style.color = 'var(--accent-gold)';
    heading.textContent = `${formatRoundName(view.round.roundWind, view.round.kyokuNumber)} 流局`;

    const desc = document.createElement('div');
    desc.className = 'hub-sub';
    desc.textContent =
      view.round.roundIndex + 1 >= view.round.totalRounds
        ? '牌山が尽きて流局しました。規定局数がすべて終了しました。'
        : '牌山が尽きて流局しました。次の局で親が次の席へ移ります。';

    overlay.append(heading, desc, buildScoreTable(view.players, rules.initialPoints));

    if (isHost) {
      const nextBtn = document.createElement('button');
      nextBtn.type = 'button';
      nextBtn.className = 'btn btn-primary';
      nextBtn.textContent =
        view.round.roundIndex + 1 >= view.round.totalRounds
          ? '結果を見る'
          : '次の局へ';
      nextBtn.addEventListener('click', handlers.onAdvanceRound);
      overlay.appendChild(nextBtn);
    } else {
      const waitMsg = document.createElement('div');
      waitMsg.className = 'hub-sub';
      waitMsg.textContent = 'ホストが次の局へ進めるのを待っています...';
      overlay.appendChild(waitMsg);
    }

    container.appendChild(overlay);
  }
}

function renderCenterHub(view: StateView): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'seat-center';

  const hub = document.createElement('div');
  hub.className = 'center-hub';

  const round = view.round;
  const roundLabel = document.createElement('div');
  roundLabel.className = 'round-label';
  roundLabel.textContent = round
    ? formatRoundName(round.roundWind, round.kyokuNumber)
    : '対局';

  const wallCounter = document.createElement('div');
  wallCounter.className = 'wall-counter';
  wallCounter.textContent = round
    ? `残り牌数: ${round.remainingWallCount} 枚`
    : '';

  const sub = document.createElement('div');
  sub.className = 'hub-sub';
  const lengthJa = view.ruleConfig.gameLength === 'tonpuu' ? '東風戦' : '半荘戦';
  sub.textContent = round
    ? `${view.ruleConfig.playerCount}人 ${lengthJa} (${round.roundIndex + 1} / ${round.totalRounds}局) ・ 部屋 ${view.roomCode}`
    : '';

  hub.append(roundLabel, wallCounter, sub);
  wrap.appendChild(hub);
  return wrap;
}

function renderSeatHeader(player: PublicPlayerView, isSelf: boolean): HTMLElement {
  const header = document.createElement('div');
  header.className = 'seat-header';

  const identity = document.createElement('div');
  identity.className = 'seat-identity';

  if (player.seatWind) {
    const windBadge = document.createElement('span');
    windBadge.className = `wind-badge${player.isDealer ? ' is-dealer' : ''}`;
    windBadge.textContent = windToJa(player.seatWind);
    identity.appendChild(windBadge);
  }

  const nameSpan = document.createElement('span');
  nameSpan.textContent = isSelf ? `${player.name}（あなた）` : player.name;
  identity.appendChild(nameSpan);

  if (player.isDealer) {
    const oya = document.createElement('span');
    oya.className = 'hub-sub';
    oya.textContent = '親';
    identity.appendChild(oya);
  }

  if (player.isCurrentTurn) {
    const turn = document.createElement('span');
    turn.className = 'turn-tag';
    turn.textContent = '手番';
    identity.appendChild(turn);
  }

  if (!player.connected) {
    const dc = document.createElement('span');
    dc.className = 'disconnect-tag';
    dc.textContent = '切断';
    identity.appendChild(dc);
  }

  const score = document.createElement('div');
  score.className = 'seat-score';
  score.textContent = `${player.score.toLocaleString()}点`;

  header.append(identity, score);
  return header;
}

function renderDiscardRiver(player: PublicPlayerView): HTMLElement {
  const river = document.createElement('div');
  river.className = 'discard-river';

  player.discards.forEach((entry, idx) => {
    const isLatest = idx === player.discards.length - 1;
    river.appendChild(
      createTileElement(entry.tile, {
        small: true,
        tsumogiri: entry.isTsumogiri,
        latestDiscard: isLatest,
      }),
    );
  });

  return river;
}

function renderOpponentSeat(
  areaClass: string,
  player: PublicPlayerView,
): HTMLElement {
  const box = document.createElement('div');
  box.className = `seat-box ${areaClass}${player.isCurrentTurn ? ' is-turn' : ''}`;

  box.appendChild(renderSeatHeader(player, false));

  const backs = document.createElement('div');
  backs.className = 'opponent-back-row';
  const totalVisibleBacks = player.handCount + (player.hasDrawnTile ? 1 : 0);
  for (let i = 0; i < totalVisibleBacks; i++) {
    backs.appendChild(createTileBackElement(true));
  }
  box.appendChild(backs);
  box.appendChild(renderDiscardRiver(player));
  return box;
}

function renderSelfSeat(
  view: StateView,
  player: PublicPlayerView,
  handlers: TableHandlers,
): HTMLElement {
  const box = document.createElement('div');
  box.className = `seat-box seat-self${player.isCurrentTurn ? ' is-turn' : ''}`;

  box.appendChild(renderSeatHeader(player, true));

  const controls = document.createElement('div');
  controls.className = 'self-controls';

  const riverLabel = document.createElement('div');
  riverLabel.className = 'hub-sub';
  riverLabel.textContent = 'あなたの捨て牌';
  controls.append(riverLabel, renderDiscardRiver(player));

  const isMyTurn = view.phase === 'playing' && player.isCurrentTurn;
  const prompt = document.createElement('div');
  prompt.className = `turn-prompt${isMyTurn ? ' is-my-turn' : ''}`;
  if (view.phase === 'round_end') {
    prompt.textContent = '流局しました';
  } else if (isMyTurn) {
    prompt.textContent = 'あなたの手番です — 切る牌をタップしてください';
  } else {
    const current = view.players.find((p) => p.isCurrentTurn);
    prompt.textContent = current
      ? `${current.name} の打牌を待っています...`
      : '待機中...';
  }
  controls.appendChild(prompt);

  const handArea = document.createElement('div');
  handArea.className = 'hand-area';

  for (const tile of view.myHand) {
    handArea.appendChild(
      createTileElement(tile, {
        clickable: isMyTurn,
        onClick: () => handlers.onDiscardTile(tile.id),
      }),
    );
  }

  if (view.myDrawnTile) {
    const gap = document.createElement('div');
    gap.className = 'drawn-gap';
    handArea.appendChild(gap);
    handArea.appendChild(
      createTileElement(view.myDrawnTile, {
        clickable: isMyTurn,
        onClick: () => handlers.onDiscardTile(view.myDrawnTile!.id),
      }),
    );
  }

  controls.appendChild(handArea);
  box.appendChild(controls);
  return box;
}

function buildScoreTable(
  players: PublicPlayerView[],
  initialPoints: number,
  ranked = false,
): HTMLElement {
  const list = ranked
    ? [...players].sort((a, b) => b.score - a.score || a.seatIndex - b.seatIndex)
    : players;

  const table = document.createElement('table');
  table.className = 'score-table';
  const thead = document.createElement('thead');
  thead.innerHTML = `<tr>${ranked ? '<th>順位</th>' : ''}<th>プレイヤー</th><th class="num">持ち点</th><th class="num">収支</th></tr>`;
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  list.forEach((p, idx) => {
    const diff = p.score - initialPoints;
    const diffStr = diff > 0 ? `+${diff.toLocaleString()}` : diff.toLocaleString();
    const tr = document.createElement('tr');
    if (ranked) {
      const rankTd = document.createElement('td');
      rankTd.textContent = `${idx + 1}位`;
      tr.appendChild(rankTd);
    }
    const nameTd = document.createElement('td');
    nameTd.textContent = p.name;
    const scoreTd = document.createElement('td');
    scoreTd.className = 'num';
    scoreTd.textContent = `${p.score.toLocaleString()}点`;
    const diffTd = document.createElement('td');
    diffTd.className = 'num';
    diffTd.textContent = diffStr;
    tr.append(nameTd, scoreTd, diffTd);
    tbody.appendChild(tr);
  });

  table.appendChild(tbody);
  return table;
}

function renderFinishedScreen(
  container: HTMLElement,
  view: StateView,
  initialPoints: number,
  handlers: TableHandlers,
): void {
  const panel = document.createElement('div');
  panel.className = 'overlay-panel';

  const title = document.createElement('h2');
  title.style.margin = '0';
  title.style.color = 'var(--accent-gold)';
  const lengthJa = view.ruleConfig.gameLength === 'tonpuu' ? '東風戦' : '半荘戦';
  title.textContent = `終局 — ${view.ruleConfig.playerCount}人 ${lengthJa} 最終結果`;

  const table = buildScoreTable(view.players, initialPoints, true);

  const backBtn = document.createElement('button');
  backBtn.type = 'button';
  backBtn.className = 'btn btn-primary';
  backBtn.style.alignSelf = 'flex-start';
  backBtn.textContent = 'ロビーに戻る';
  backBtn.addEventListener('click', handlers.onReturnToLobby);

  panel.append(title, table, backBtn);
  container.appendChild(panel);
}
