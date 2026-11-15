import { deriveRules } from '../engine/rules';
import type { PublicPlayerView, StateView } from '../types/message';
import type { CallResponseChoice, Meld } from '../types/state';
import type { TileKind } from '../types/tile';
import {
  createTileBackElement,
  createTileElement,
  formatRoundName,
  formatTileLabel,
  windToJa,
} from './tileView';

export interface TableHandlers {
  onDiscardTile: (tileId: string) => void;
  onCallResponse: (choice: CallResponseChoice) => void;
  onDeclareAnkan: (kind: TileKind) => void;
  onDeclareKakan: (tileId: string) => void;
  onDeclareKita: (tileId: string) => void;
  onAdvanceRound: () => void;
  onReturnToLobby: () => void;
}

const MELD_TYPE_LABELS: Record<Meld['type'], string> = {
  pon: 'ポン',
  chi: 'チー',
  daiminkan: '大明槓',
  kakan: '加槓',
  ankan: '暗槓',
};

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

  // 局終了オーバーレイ（和了 / 流局）
  if (view.phase === 'round_end' && view.round) {
    const overlay = document.createElement('div');
    overlay.className = 'overlay-panel';

    const heading = document.createElement('h2');
    heading.style.margin = '0';
    heading.style.color = 'var(--accent-gold)';

    const roundTitle = formatRoundName(view.round.roundWind, view.round.kyokuNumber);
    const desc = document.createElement('div');
    desc.className = 'hub-sub';

    if (view.round.ronWinners.length > 0) {
      heading.textContent = `${roundTitle} ロン和了`;
      const winnerList = document.createElement('div');
      winnerList.className = 'ron-winners-list';

      for (const winner of view.round.ronWinners) {
        const winnerPlayer = view.players.find(
          (p) => p.playerId === winner.playerId,
        );
        const loserPlayer = view.players.find(
          (p) => p.seatIndex === winner.fromSeatIndex,
        );
        const item = document.createElement('div');
        item.className = 'ron-winner-item';

        const text = document.createElement('span');
        text.textContent = `${winnerPlayer?.name ?? winner.playerId}（${loserPlayer?.name ?? ''} からロン）`;

        item.append(text, createTileElement(winner.winningTile, { small: true }));
        winnerList.appendChild(item);
      }

      desc.textContent =
        view.round.roundIndex + 1 >= view.round.totalRounds
          ? '規定局数がすべて終了しました。'
          : '点棒計算は第3段階で実装予定です。次局へ進みます。';
      overlay.append(heading, winnerList, desc);
    } else {
      heading.textContent = `${roundTitle} 流局`;
      desc.textContent =
        view.round.roundIndex + 1 >= view.round.totalRounds
          ? '牌山が尽きて流局しました。規定局数がすべて終了しました。'
          : '牌山が尽きて流局しました。次の局で親が次の席へ移ります。';
      overlay.append(heading, desc);
    }

    overlay.appendChild(buildScoreTable(view.players, rules.initialPoints));

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
  const rules = deriveRules(view.ruleConfig);

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

  hub.append(roundLabel, wallCounter);

  if (round) {
    const doraWrap = document.createElement('div');
    doraWrap.className = 'dora-strip';

    const doraTitle = document.createElement('div');
    doraTitle.className = 'hub-sub';
    doraTitle.textContent = `ドラ表示 (${round.doraIndicators.length} / ${rules.doraIndicatorCount})`;

    const doraTiles = document.createElement('div');
    doraTiles.className = 'dora-tiles-row';
    for (let i = 0; i < rules.doraIndicatorCount; i++) {
      const indicator = round.doraIndicators[i];
      if (indicator) {
        doraTiles.appendChild(createTileElement(indicator, { small: true }));
      } else {
        doraTiles.appendChild(createTileBackElement(true, true));
      }
    }

    doraWrap.append(doraTitle, doraTiles);
    hub.appendChild(doraWrap);

    if (round.kanCount > 0) {
      const kanBadge = document.createElement('div');
      kanBadge.className = 'hub-sub';
      kanBadge.textContent = `カン回数: ${round.kanCount} / ${rules.maxKansPerRound}`;
      hub.appendChild(kanBadge);
    }
  }

  if (view.phase === 'awaiting_responses') {
    const waitBadge = document.createElement('div');
    waitBadge.className = 'response-wait-badge';
    const secs =
      view.responseRemainingMs !== null
        ? Math.ceil(view.responseRemainingMs / 1000)
        : null;
    waitBadge.innerHTML =
      secs !== null
        ? `鳴き・ロン応答待ち (残り <span data-countdown-ms>${secs}</span>秒)`
        : '鳴き・ロン応答待ち';
    hub.appendChild(waitBadge);
  }

  const sub = document.createElement('div');
  sub.className = 'hub-sub';
  const lengthJa = view.ruleConfig.gameLength === 'tonpuu' ? '東風戦' : '半荘戦';
  sub.textContent = round
    ? `${view.ruleConfig.playerCount}人 ${lengthJa} (${round.roundIndex + 1} / ${round.totalRounds}局) ・ 部屋 ${view.roomCode}`
    : '';

  hub.appendChild(sub);
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

function renderMeldsAndKita(player: PublicPlayerView): HTMLElement | null {
  if (player.melds.length === 0 && player.kitaTiles.length === 0) {
    return null;
  }

  const row = document.createElement('div');
  row.className = 'meld-kita-row';

  for (const meld of player.melds) {
    const group = document.createElement('div');
    group.className = 'meld-group';

    const label = document.createElement('span');
    label.className = 'meld-label';
    label.textContent = MELD_TYPE_LABELS[meld.type];
    group.appendChild(label);

    const tilesWrap = document.createElement('div');
    tilesWrap.className = 'meld-tiles';

    if (meld.type === 'ankan' && meld.tiles.length === 4) {
      tilesWrap.appendChild(createTileBackElement(true, true));
      tilesWrap.appendChild(createTileElement(meld.tiles[1]!, { small: true }));
      tilesWrap.appendChild(createTileElement(meld.tiles[2]!, { small: true }));
      tilesWrap.appendChild(createTileBackElement(true, true));
    } else {
      for (const tile of meld.tiles) {
        const isHighlighted =
          meld.calledTile?.id === tile.id || meld.addedTile?.id === tile.id;
        tilesWrap.appendChild(
          createTileElement(tile, {
            small: true,
            called: isHighlighted,
          }),
        );
      }
    }

    group.appendChild(tilesWrap);
    row.appendChild(group);
  }

  if (player.kitaTiles.length > 0) {
    const kitaGroup = document.createElement('div');
    kitaGroup.className = 'meld-group meld-group-kita';

    const label = document.createElement('span');
    label.className = 'meld-label';
    label.textContent = `抜北 ×${player.kitaTiles.length}`;
    kitaGroup.appendChild(label);

    const tilesWrap = document.createElement('div');
    tilesWrap.className = 'meld-tiles';
    for (const tile of player.kitaTiles) {
      tilesWrap.appendChild(createTileElement(tile, { small: true }));
    }
    kitaGroup.appendChild(tilesWrap);
    row.appendChild(kitaGroup);
  }

  return row;
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

  const meldsEl = renderMeldsAndKita(player);
  if (meldsEl) {
    box.appendChild(meldsEl);
  }

  box.appendChild(renderDiscardRiver(player));
  return box;
}

function renderCallResponseBar(
  view: StateView,
  handlers: TableHandlers,
): HTMLElement | null {
  const opts = view.myCallOptions;
  if (!opts) return null;

  const bar = document.createElement('div');
  bar.className = 'call-action-bar';

  const info = document.createElement('div');
  info.className = 'call-bar-info';

  const title = document.createElement('span');
  title.className = 'call-bar-title';
  title.textContent = '鳴き・ロン選択';

  const targetTileEl = createTileElement(opts.discardedTile, { small: true });

  info.append(title, targetTileEl);

  if (view.responseRemainingMs !== null) {
    const timer = document.createElement('span');
    timer.className = 'call-timer';
    const secs = Math.ceil(view.responseRemainingMs / 1000);
    timer.innerHTML = `残り <strong data-countdown-ms>${secs}</strong> 秒`;
    info.appendChild(timer);
  }

  const btns = document.createElement('div');
  btns.className = 'action-buttons-row';

  if (opts.canRon) {
    const ronBtn = document.createElement('button');
    ronBtn.type = 'button';
    ronBtn.className = 'btn btn-ron';
    ronBtn.textContent = 'ロン';
    ronBtn.addEventListener('click', () =>
      handlers.onCallResponse({ type: 'ron' }),
    );
    btns.appendChild(ronBtn);
  }

  if (opts.canPon) {
    const ponBtn = document.createElement('button');
    ponBtn.type = 'button';
    ponBtn.className = 'btn btn-call';
    ponBtn.textContent = `ポン (${formatTileLabel(opts.discardedTile.kind)})`;
    ponBtn.addEventListener('click', () =>
      handlers.onCallResponse({ type: 'pon' }),
    );
    btns.appendChild(ponBtn);
  }

  if (opts.canDaiminkan) {
    const kanBtn = document.createElement('button');
    kanBtn.type = 'button';
    kanBtn.className = 'btn btn-call';
    kanBtn.textContent = `大明槓 (${formatTileLabel(opts.discardedTile.kind)})`;
    kanBtn.addEventListener('click', () =>
      handlers.onCallResponse({ type: 'daiminkan' }),
    );
    btns.appendChild(kanBtn);
  }

  for (const chiOpt of opts.chiOptions) {
    const [t1, t2] = chiOpt.tiles;
    const chiBtn = document.createElement('button');
    chiBtn.type = 'button';
    chiBtn.className = 'btn btn-call';
    chiBtn.textContent = `チー (${formatTileLabel(t1.kind)}・${formatTileLabel(t2.kind)})`;
    chiBtn.addEventListener('click', () =>
      handlers.onCallResponse({
        type: 'chi',
        tileIds: [t1.id, t2.id],
      }),
    );
    btns.appendChild(chiBtn);
  }

  const passBtn = document.createElement('button');
  passBtn.type = 'button';
  passBtn.className = 'btn btn-secondary';
  passBtn.textContent = 'スルー';
  passBtn.addEventListener('click', () =>
    handlers.onCallResponse({ type: 'pass' }),
  );
  btns.appendChild(passBtn);

  bar.append(info, btns);
  return bar;
}

function renderSelfTurnActionsBar(
  view: StateView,
  handlers: TableHandlers,
): HTMLElement | null {
  const actions = view.mySelfActions;
  if (!actions) return null;

  const bar = document.createElement('div');
  bar.className = 'self-action-bar';

  const label = document.createElement('span');
  label.className = 'hub-sub';
  label.textContent = '手番アクション:';
  bar.appendChild(label);

  const btns = document.createElement('div');
  btns.className = 'action-buttons-row';

  for (const kind of actions.canAnkanKinds) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-call';
    btn.textContent = `暗槓 (${formatTileLabel(kind)})`;
    btn.addEventListener('click', () => handlers.onDeclareAnkan(kind));
    btns.appendChild(btn);
  }

  const allMyTiles = view.myDrawnTile
    ? [...view.myHand, view.myDrawnTile]
    : view.myHand;

  for (const tileId of actions.canKakanTileIds) {
    const tile = allMyTiles.find((t) => t.id === tileId);
    const tileLabel = tile ? formatTileLabel(tile.kind) : tileId;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-call';
    btn.textContent = `加槓 (${tileLabel})`;
    btn.addEventListener('click', () => handlers.onDeclareKakan(tileId));
    btns.appendChild(btn);
  }

  if (actions.canKitaTileIds.length > 0) {
    const firstKitaId = actions.canKitaTileIds[0]!;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-kita';
    btn.textContent = '抜北 (北)';
    btn.addEventListener('click', () => handlers.onDeclareKita(firstKitaId));
    btns.appendChild(btn);
  }

  bar.appendChild(btns);
  return bar;
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

  const selfMelds = renderMeldsAndKita(player);
  if (selfMelds) {
    controls.appendChild(selfMelds);
  }

  const isMyTurn = view.phase === 'playing' && player.isCurrentTurn;
  const prompt = document.createElement('div');
  prompt.className = `turn-prompt${isMyTurn ? ' is-my-turn' : ''}`;
  if (view.phase === 'round_end') {
    prompt.textContent =
      view.round && view.round.ronWinners.length > 0
        ? 'ロン和了が発生しました'
        : '流局しました';
  } else if (view.phase === 'awaiting_responses') {
    prompt.textContent = view.myCallOptions
      ? '相手の打牌に対して鳴き・ロンを選択できます'
      : '他のプレイヤーの鳴き応答を待っています...';
  } else if (isMyTurn) {
    prompt.textContent =
      view.kuikaeForbiddenKinds.length > 0
        ? 'あなたの手番です — 切る牌を選んでください（喰い替え禁止牌は選択不可）'
        : 'あなたの手番です — 切る牌をタップしてください';
  } else {
    const current = view.players.find((p) => p.isCurrentTurn);
    prompt.textContent = current
      ? `${current.name} の打牌を待っています...`
      : '待機中...';
  }
  controls.appendChild(prompt);

  const callBar = renderCallResponseBar(view, handlers);
  if (callBar) {
    controls.appendChild(callBar);
  }

  if (isMyTurn) {
    const selfActionsBar = renderSelfTurnActionsBar(view, handlers);
    if (selfActionsBar) {
      controls.appendChild(selfActionsBar);
    }
  }

  const forbiddenSet = new Set(isMyTurn ? view.kuikaeForbiddenKinds : []);
  const handArea = document.createElement('div');
  handArea.className = 'hand-area';

  for (const tile of view.myHand) {
    const blocked = forbiddenSet.has(tile.kind);
    handArea.appendChild(
      createTileElement(tile, {
        clickable: isMyTurn && !blocked,
        disabled: isMyTurn && blocked,
        disabledReason: blocked ? '喰い替え禁止のため切れません' : undefined,
        onClick: () => handlers.onDiscardTile(tile.id),
      }),
    );
  }

  if (view.myDrawnTile) {
    const gap = document.createElement('div');
    gap.className = 'drawn-gap';
    handArea.appendChild(gap);
    const blocked = forbiddenSet.has(view.myDrawnTile.kind);
    handArea.appendChild(
      createTileElement(view.myDrawnTile, {
        clickable: isMyTurn && !blocked,
        disabled: isMyTurn && blocked,
        disabledReason: blocked ? '喰い替え禁止のため切れません' : undefined,
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
