import {
  CPU_PLAYER_ID_PREFIX,
  cpuDisplayName,
  isCpuPlayerId,
} from '../cpu/player';
import { deriveRules } from '../engine/rules';
import type { PublicPlayerView, RoundView, StateView } from '../types/message';
import type {
  AbortiveDrawReason,
  CallResponseChoice,
  Meld,
  RoundAgariWinner,
} from '../types/state';
import type { TileKind } from '../types/tile';
import {
  createTileBackElement,
  createTileElement,
  formatRoundName,
  formatTileLabel,
  windToJa,
} from './tileView';

/** 卓を囲む4方向（下=自分から見た相対位置） */
export type SeatSide = 'self' | 'top' | 'left' | 'right';

/** 席ごとの河・手牌の向き（CSS の data-seat と対応） */
const SEAT_CLASS: Record<SeatSide, string> = {
  self: 'seat-self',
  top: 'seat-top',
  left: 'seat-left',
  right: 'seat-right',
};

export interface TableHandlers {
  onDiscardTile: (tileId: string) => void;
  onCallResponse: (choice: CallResponseChoice) => void;
  onDeclareTsumo: () => void;
  onDeclareRiichi: (tileId: string) => void;
  onDeclareAnkan: (kind: TileKind) => void;
  onDeclareKakan: (tileId: string) => void;
  onDeclareKita: (tileId: string) => void;
  onDeclareKyuushuKyuuhai: () => void;
  onToggleRiichiMode?: (enabled: boolean) => void;
  onToggleAutoTsumogiri?: (enabled: boolean) => void;
  onToggleAutoAgari?: (enabled: boolean) => void;
  onToggleAutoNoCall?: (enabled: boolean) => void;
  onToggleSettings?: (open: boolean) => void;
  onAdvanceRound: () => void;
  onReturnToLobby: () => void;
  /** 対局中に卓上から部屋を離れる（トップバーを出さないため） */
  onLeaveGame?: () => void;
  /** 卓上に離脱ボタンを出すか */
  canLeaveGame?: boolean;
}

export interface TableUiState {
  riichiSelectingMode: boolean;
  autoTsumogiriEnabled: boolean;
  autoAgariEnabled?: boolean;
  autoNoCallEnabled?: boolean;
  settingsOpen?: boolean;
}

const DEFAULT_TABLE_UI_STATE: TableUiState = {
  riichiSelectingMode: false,
  autoTsumogiriEnabled: true,
  autoAgariEnabled: false,
  autoNoCallEnabled: false,
  settingsOpen: false,
};

const MELD_TYPE_LABELS: Record<Meld['type'], string> = {
  pon: 'ポン',
  chi: 'チー',
  daiminkan: '大明槓',
  kakan: '加槓',
  ankan: '暗槓',
};

const ABORTIVE_DRAW_META: Record<
  AbortiveDrawReason,
  { title: string; description: string }
> = {
  kyuushu_kyuuhai: {
    title: '九種九牌',
    description: '第1ツモ時に么九牌が9種以上あったため途中流局となりました。',
  },
  suufon_renda: {
    title: '四風連打',
    description: '1巡目に4人全員が同じ風牌を捨てたため途中流局となりました。',
  },
  suucha_riichi: {
    title: '四家立直',
    description: '4人全員がリーチを宣言したため途中流局となりました。',
  },
  suukanzu: {
    title: '四槓散了',
    description: '2人以上で合計4回の槓が行われたため途中流局となりました。',
  },
  sancha_hou: {
    title: '三家和',
    description: '3人同時にロン宣言が発生したため途中流局となりました。',
  },
};

/** 横向き画面（スマホ横持ち・PC）と縦向き画面の両対応を切り替える目印 */
function applyOrientationClass(element: HTMLElement): void {
  element.classList.add('is-landscape');
}

export function renderGameTable(
  container: HTMLElement,
  view: StateView,
  handlers: TableHandlers,
  uiState: TableUiState = DEFAULT_TABLE_UI_STATE,
): void {
  container.innerHTML = '';

  const rules = deriveRules(view.ruleConfig);
  const playerCount = view.players.length;
  const isHost = view.viewerPlayerId === view.hostPlayerId;

  if (view.phase === 'finished') {
    renderFinishedScreen(container, view, rules.initialPoints, handlers);
    return;
  }

  const wrapper = document.createElement('div');
  wrapper.className = 'table-stage';
  applyOrientationClass(wrapper);

  const felt = document.createElement('div');
  felt.className = 'table-felt';
  applyOrientationClass(felt);

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
    felt.appendChild(renderOpponentSeat('top', topPlayer, view));
  } else {
    const emptyTop = document.createElement('div');
    emptyTop.className = 'seat-top seat-empty';
    felt.appendChild(emptyTop);
  }

  if (leftPlayer) {
    felt.appendChild(renderOpponentSeat('left', leftPlayer, view));
  } else {
    const emptyLeft = document.createElement('div');
    emptyLeft.className = 'seat-left seat-empty';
    felt.appendChild(emptyLeft);
  }

  felt.appendChild(renderCenterHub(view));

  if (rightPlayer) {
    felt.appendChild(renderOpponentSeat('right', rightPlayer, view));
  } else {
    const emptyRight = document.createElement('div');
    emptyRight.className = 'seat-right seat-empty';
    felt.appendChild(emptyRight);
  }

  if (selfPlayer) {
    felt.appendChild(renderSelfSeat(view, selfPlayer, handlers, uiState));
  }

  // 対局中は雀卓だけを表示する（局情報・スコア・ドラは卓の中に集約）
  const chrome = renderTableChrome(view, handlers, uiState);
  if (chrome) {
    felt.appendChild(chrome);
  }

  felt.appendChild(renderLeftActionBar(handlers, uiState));

  const doraPanel = renderDoraPanel(view);
  if (doraPanel) {
    felt.appendChild(doraPanel);
  }

  wrapper.appendChild(felt);
  container.appendChild(wrapper);

  // 局終了オーバーレイ（和了 / 流局）
  if (view.phase === 'round_end' && view.round) {
    renderRoundEndOverlay(container, view, isHost, rules.initialPoints, handlers);
  }
}

function formatNextRoundDescription(view: StateView, round: RoundView): string {
  const decision = round.nextRoundDecision;
  const currentTitle = formatRoundName(round.roundWind, round.kyokuNumber);
  const rules = deriveRules(view.ruleConfig);
  if (!decision) {
    if (round.isTobiEnded) {
      return '持ち点が0点未満になったプレイヤーがいるため、トビ終了となります。';
    }
    return round.roundIndex + 1 >= round.totalRounds
      ? '規定局数がすべて終了しました。'
      : '次局へ進みます。';
  }

  if (decision.outcome === 'renchan') {
    switch (decision.reason) {
      case 'abortive_draw':
        return `途中流局のため親の連荘となり、${currentTitle} ${decision.nextHonba}本場へ進みます。`;
      case 'oya_agari':
        return `親の和了により連荘となり、${currentTitle} ${decision.nextHonba}本場へ進みます。`;
      case 'double_ron_with_oya':
        return `親と子の同時ダブロンのため親の連荘となり、${currentTitle} ${decision.nextHonba}本場へ進みます。`;
      case 'oya_tenpai_draw':
        return `親がテンパイで流局したため連荘となり、${currentTitle} ${decision.nextHonba}本場へ進みます。`;
      default:
        return `連荘となり、${currentTitle} ${decision.nextHonba}本場へ進みます。`;
    }
  }

  if (decision.outcome === 'oya_nagare') {
    const nextMeta = getRoundMetadataSafe(decision.nextRoundIndex, rules);
    const nextTitle = formatRoundName(
      nextMeta.roundWind,
      nextMeta.kyokuNumber,
      decision.nextHonba,
    );
    switch (decision.reason) {
      case 'ko_agari':
        return `子の和了により親流れとなり、${nextTitle}へ進みます。`;
      case 'oya_noten_draw':
        return `親がノーテンで流局したため親流れとなり、${nextTitle}へ進みます。`;
      default:
        return `親流れとなり、${nextTitle}へ進みます。`;
    }
  }

  // decision.outcome === 'game_end'
  switch (decision.reason) {
    case 'tobi':
      return '持ち点が0点未満になったプレイヤーがいるため、トビ終了となります。';
    case 'ko_agari':
      return 'オーラスで子が和了したため、対局終了（終局）となります。';
    case 'oya_noten_draw':
      return 'オーラスで親がノーテン流局となったため、対局終了（終局）となります。';
    default:
      return '規定局数が終了したため、対局終了（終局）となります。';
  }
}

function getRoundMetadataSafe(
  roundIndex: number,
  rules: ReturnType<typeof deriveRules>,
): { roundWind: 'E' | 'S' | 'W' | 'N'; kyokuNumber: number } {
  // 総局数超過時は最終局の表示にフォールバックする
  const clampedIndex = Math.min(roundIndex, rules.totalRounds - 1);
  const roundWindIndex = Math.floor(clampedIndex / rules.playerCount);
  const roundWind = rules.roundWinds[roundWindIndex] ?? 'E';
  return {
    roundWind,
    kyokuNumber: (clampedIndex % rules.playerCount) + 1,
  };
}

function renderRoundEndOverlay(
  container: HTMLElement,
  view: StateView,
  isHost: boolean,
  initialPoints: number,
  handlers: TableHandlers,
): void {
  const round = view.round!;
  const overlay = document.createElement('div');
  overlay.className = 'overlay-panel';
  applyOrientationClass(overlay);

  const heading = document.createElement('h2');
  heading.style.margin = '0';
  heading.style.color = 'var(--accent-gold)';

  const roundTitle = formatRoundName(round.roundWind, round.kyokuNumber, round.honba);
  const desc = document.createElement('div');
  desc.className = 'progression-reason-note';

  const isGameClosing = round.nextRoundDecision
    ? round.nextRoundDecision.outcome === 'game_end'
    : round.isTobiEnded || round.roundIndex + 1 >= round.totalRounds;

  if (round.agariResults.length > 0) {
    const first = round.agariResults[0]!;
    if (first.winType === 'tsumo') {
      heading.textContent = `${roundTitle} ツモ和了`;
    } else if (round.agariResults.length >= 2) {
      heading.textContent = `${roundTitle} ダブロン和了`;
    } else {
      heading.textContent = `${roundTitle} ロン和了`;
    }

    if (round.isTobiEnded) {
      const tobiTag = document.createElement('span');
      tobiTag.className = 'tobi-badge';
      tobiTag.textContent = 'トビ終了';
      heading.appendChild(tobiTag);
    }

    const cardsWrap = document.createElement('div');
    cardsWrap.className = 'agari-cards-list';
    for (const agari of round.agariResults) {
      cardsWrap.appendChild(renderAgariWinnerCard(agari, view.players, round.dealerIndex));
    }

    // 局と局の間は「何の役で和了ったか」を最上段で大きく見せる
    const yakuSummary = renderRoundYakuSummary(round, view.players);
    if (yakuSummary) {
      overlay.appendChild(yakuSummary);
    }

    if (round.uraDoraIndicators.length > 0) {
      const uraBox = document.createElement('div');
      uraBox.className = 'ura-dora-box';
      const uraLabel = document.createElement('span');
      uraLabel.className = 'hub-sub';
      uraLabel.textContent = '裏ドラ表示牌:';
      const uraRow = document.createElement('div');
      uraRow.className = 'dora-tiles-row';
      for (const indicator of round.uraDoraIndicators) {
        uraRow.appendChild(createTileElement(indicator, { small: true }));
      }
      uraBox.append(uraLabel, uraRow);
      cardsWrap.appendChild(uraBox);
    }

    if (round.kyotakuPointsAwarded > 0 && round.kyotakuWinnerPlayerId) {
      const kWinner = view.players.find(
        (p) => p.playerId === round.kyotakuWinnerPlayerId,
      );
      const kyotakuNote = document.createElement('div');
      kyotakuNote.className = 'kyotaku-award-note';
      kyotakuNote.textContent = `供託リーチ棒受取: ${kWinner?.name ?? round.kyotakuWinnerPlayerId} (+${round.kyotakuPointsAwarded.toLocaleString()}点)`;
      cardsWrap.appendChild(kyotakuNote);
    }

    desc.textContent = formatNextRoundDescription(view, round);
    overlay.append(heading, cardsWrap, desc);
  } else if (round.ronWinners.length > 0) {
    // テストフック用フォールバック表示
    heading.textContent = `${roundTitle} ロン和了`;
    const winnerList = document.createElement('div');
    winnerList.className = 'ron-winners-list';

    for (const winner of round.ronWinners) {
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

    desc.textContent = formatNextRoundDescription(view, round);
    overlay.append(heading, winnerList, desc);
  } else if (round.abortiveDrawReason) {
    const meta = ABORTIVE_DRAW_META[round.abortiveDrawReason];
    heading.textContent = `${roundTitle} 途中流局（${meta.title}）`;
    overlay.appendChild(heading);

    if (
      round.abortiveDrawReason === 'kyuushu_kyuuhai' &&
      round.abortiveDrawPlayerId &&
      round.revealedHands[round.abortiveDrawPlayerId]
    ) {
      const declarer = view.players.find(
        (p) => p.playerId === round.abortiveDrawPlayerId,
      );
      const revealCard = document.createElement('div');
      revealCard.className = 'agari-result-card';
      const who = document.createElement('div');
      who.className = 'agari-who';
      who.textContent = `${declarer?.name ?? round.abortiveDrawPlayerId} が九種九牌を宣言（開示手牌）`;
      const tilesRow = document.createElement('div');
      tilesRow.className = 'agari-tiles-row';
      for (const tile of round.revealedHands[round.abortiveDrawPlayerId]!) {
        tilesRow.appendChild(createTileElement(tile, { small: true }));
      }
      revealCard.append(who, tilesRow);
      overlay.appendChild(revealCard);
    }

    if (view.kyotakuCount > 0) {
      const rules = deriveRules(view.ruleConfig);
      const kyotakuNote = document.createElement('div');
      kyotakuNote.className = 'kyotaku-award-note';
      kyotakuNote.textContent = `供託リーチ棒 ${view.kyotakuCount}本（${(view.kyotakuCount * rules.riichiStickPoints).toLocaleString()}点）は次局へ持ち越されます。`;
      overlay.appendChild(kyotakuNote);
    }

    desc.textContent = `${meta.description} ${formatNextRoundDescription(view, round)}`;
    overlay.appendChild(desc);
  } else {
    heading.textContent = `${roundTitle} 流局（荒牌平局）`;
    if (round.isTobiEnded) {
      const tobiTag = document.createElement('span');
      tobiTag.className = 'tobi-badge';
      tobiTag.textContent = 'トビ終了';
      heading.appendChild(tobiTag);
    }
    overlay.appendChild(heading);

    // テンパイ／ノーテン判定とテンパイ者の手牌開示
    const tenpaiSet = new Set(round.tenpaiPlayerIds);
    const tenpaiWrap = document.createElement('div');
    tenpaiWrap.className = 'tenpai-cards-list';

    for (const p of view.players) {
      const isTenpai = tenpaiSet.has(p.playerId);
      const isOya = p.seatIndex === round.dealerIndex;
      const delta = round.roundScoreDeltas[p.playerId] ?? 0;
      const deltaStr =
        delta > 0
          ? `+${delta.toLocaleString()}点`
          : delta < 0
            ? `${delta.toLocaleString()}点`
            : '±0点';

      const card = document.createElement('div');
      card.className = 'agari-result-card';

      const header = document.createElement('div');
      header.className = 'agari-header';

      const who = document.createElement('div');
      who.className = 'agari-who';
      who.textContent = `${p.name}（${isOya ? '親' : '子'}）`;

      const statusGroup = document.createElement('div');
      statusGroup.style.display = 'flex';
      statusGroup.style.alignItems = 'center';
      statusGroup.style.gap = '8px';

      const badge = document.createElement('span');
      badge.className = isTenpai ? 'tenpai-badge' : 'noten-badge';
      badge.textContent = isTenpai ? 'テンパイ' : 'ノーテン';

      const deltaSpan = document.createElement('span');
      deltaSpan.className =
        delta > 0 ? 'delta-pos' : delta < 0 ? 'delta-neg' : 'hub-sub';
      deltaSpan.textContent = deltaStr;

      statusGroup.append(badge, deltaSpan);
      header.append(who, statusGroup);
      card.appendChild(header);

      const revealed = round.revealedHands[p.playerId];
      if (isTenpai && revealed) {
        const tilesRow = document.createElement('div');
        tilesRow.className = 'agari-tiles-row';
        for (const tile of revealed) {
          tilesRow.appendChild(createTileElement(tile, { small: true }));
        }
        for (const meld of p.melds) {
          tilesRow.appendChild(
            renderMeldGroup(meld, { ankanHidden: true, small: true }),
          );
        }
        if (p.kitaTiles.length > 0) {
          tilesRow.appendChild(renderKitaGroup(p.kitaTiles, true));
        }
        card.appendChild(tilesRow);
      } else {
        const hiddenNote = document.createElement('div');
        hiddenNote.className = 'hub-sub';
        hiddenNote.textContent = '手牌非公開';
        card.appendChild(hiddenNote);
      }

      tenpaiWrap.appendChild(card);
    }
    overlay.appendChild(tenpaiWrap);

    if (view.kyotakuCount > 0) {
      const rules = deriveRules(view.ruleConfig);
      const kyotakuNote = document.createElement('div');
      kyotakuNote.className = 'kyotaku-award-note';
      kyotakuNote.textContent = isGameClosing
        ? `供託リーチ棒 ${view.kyotakuCount}本（${(view.kyotakuCount * rules.riichiStickPoints).toLocaleString()}点）は終局時の最終トップに加算されます。`
        : `供託リーチ棒 ${view.kyotakuCount}本（${(view.kyotakuCount * rules.riichiStickPoints).toLocaleString()}点）は次局へ持ち越されます。`;
      overlay.appendChild(kyotakuNote);
    }

    desc.textContent = formatNextRoundDescription(view, round);
    overlay.appendChild(desc);
  }

  overlay.appendChild(
    buildScoreTable(
      view.players,
      initialPoints,
      false,
      round.roundScoreDeltas,
      view.initialDealerIndex,
    ),
  );

  if (isHost) {
    const nextBtn = document.createElement('button');
    nextBtn.type = 'button';
    nextBtn.className = 'btn btn-primary';
    nextBtn.textContent = isGameClosing ? '結果を見る' : '次の局へ';
    nextBtn.addEventListener('click', handlers.onAdvanceRound);
    overlay.appendChild(nextBtn);
  } else {
    const waitMsg = document.createElement('div');
    waitMsg.className = 'hub-sub';
    waitMsg.textContent = 'ホストが次へ進めるのを待っています...';
    overlay.appendChild(waitMsg);
  }

  const backdrop = document.createElement('div');
  backdrop.className = 'overlay-backdrop overlay-backdrop-modal';
  backdrop.appendChild(overlay);
  container.appendChild(backdrop);
}

function renderMeldGroup(
  meld: Meld,
  options: { ankanHidden?: boolean; small?: boolean } = {},
): HTMLElement {
  const small = options.small ?? true;
  const group = document.createElement('div');
  group.className = 'meld-group';

  const label = document.createElement('span');
  label.className = 'meld-label';
  label.textContent = MELD_TYPE_LABELS[meld.type];
  group.appendChild(label);

  const tiles = document.createElement('div');
  tiles.className = 'meld-tiles';

  if (meld.type === 'ankan' && meld.tiles.length === 4 && options.ankanHidden) {
    tiles.appendChild(createTileBackElement(small, true));
    tiles.appendChild(createTileElement(meld.tiles[1]!, { small }));
    tiles.appendChild(createTileElement(meld.tiles[2]!, { small }));
    tiles.appendChild(createTileBackElement(small, true));
  } else {
    for (const tile of meld.tiles) {
      const isCalled =
        meld.calledTile?.id === tile.id || meld.addedTile?.id === tile.id;
      tiles.appendChild(createTileElement(tile, { small, called: isCalled }));
    }
  }

  group.appendChild(tiles);
  return group;
}

function renderKitaGroup(kitaTiles: readonly { id: string; kind: TileKind }[], small = true): HTMLElement {
  const group = document.createElement('div');
  group.className = 'meld-group meld-group-kita';

  const label = document.createElement('span');
  label.className = 'meld-label';
  label.textContent = `抜北 ×${kitaTiles.length}`;
  group.appendChild(label);

  const tiles = document.createElement('div');
  tiles.className = 'meld-tiles';
  for (const tile of kitaTiles) {
    tiles.appendChild(
      createTileElement({ ...tile, isRed: false }, { small }),
    );
  }
  group.appendChild(tiles);
  return group;
}

/**
 * 局間（和了と次局のあいだ）に表示する役のまとめ。
 * どの役で和了ったかを一目で確認できるよう、和了者ごとに 1 行で並べる。
 */
function renderRoundYakuSummary(
  round: RoundView,
  players: readonly PublicPlayerView[],
): HTMLElement | null {
  if (round.agariResults.length === 0) return null;

  const box = document.createElement('div');
  box.className = 'round-yaku-summary';

  const title = document.createElement('div');
  title.className = 'round-yaku-title';
  title.textContent = '和了役';
  box.appendChild(title);

  for (const agari of round.agariResults) {
    const winner = players.find((p) => p.playerId === agari.playerId);
    const isOya = agari.seatIndex === round.dealerIndex;

    const row = document.createElement('div');
    row.className = 'round-yaku-row';

    const who = document.createElement('div');
    who.className = 'round-yaku-who';
    who.textContent = `${winner?.name ?? agari.playerId}（${isOya ? '親' : '子'}）`;

    const chips = document.createElement('div');
    chips.className = 'yaku-list round-yaku-chips';

    for (const y of agari.yaku) {
      const chip = document.createElement('span');
      chip.className = `yaku-chip round-yaku-chip${y.isYakuman ? ' is-yakuman' : ''}`;
      chip.textContent = y.isYakuman
        ? (y.yakumanMultiplier ?? 1) >= 2
          ? `${y.name} ダブル役満`
          : `${y.name} 役満`
        : `${y.name} ${y.han}翻`;
      chips.appendChild(chip);
    }

    if (!agari.isYakuman && agari.doraCount > 0) {
      const chip = document.createElement('span');
      chip.className = 'yaku-chip round-yaku-chip is-dora';
      chip.textContent = `ドラ ${agari.doraCount}翻`;
      chips.appendChild(chip);
    }
    if (!agari.isYakuman && agari.uraDoraCount > 0) {
      const chip = document.createElement('span');
      chip.className = 'yaku-chip round-yaku-chip is-dora';
      chip.textContent = `裏ドラ ${agari.uraDoraCount}翻`;
      chips.appendChild(chip);
    }
    if (!agari.isYakuman && agari.kitaCount > 0) {
      const chip = document.createElement('span');
      chip.className = 'yaku-chip round-yaku-chip is-dora';
      chip.textContent = `抜北 ${agari.kitaCount}翻`;
      chips.appendChild(chip);
    }

    const total = document.createElement('div');
    total.className = 'round-yaku-total';
    total.textContent = agari.isYakuman
      ? `${agari.scoreLabel} / ${agari.pointsAwarded.toLocaleString()}点`
      : `${agari.han}翻 ${agari.fu}符 ・ ${agari.scoreLabel} / ${agari.pointsAwarded.toLocaleString()}点`;

    row.append(who, chips, total);
    box.appendChild(row);
  }

  return box;
}

function renderAgariWinnerCard(
  agari: RoundAgariWinner,
  players: readonly PublicPlayerView[],
  dealerIndex: number,
): HTMLElement {
  const card = document.createElement('div');
  card.className = 'agari-result-card';

  const winnerPlayer = players.find((p) => p.playerId === agari.playerId);
  const loserPlayer =
    agari.fromSeatIndex !== null
      ? players.find((p) => p.seatIndex === agari.fromSeatIndex)
      : undefined;
  const isOya = agari.seatIndex === dealerIndex;

  const header = document.createElement('div');
  header.className = 'agari-header';

  const who = document.createElement('div');
  who.className = 'agari-who';
  const winSourceText =
    agari.winType === 'tsumo'
      ? 'ツモ和了'
      : `${loserPlayer?.name ?? ''} からロン`;
  who.textContent = `${winnerPlayer?.name ?? agari.playerId}（${isOya ? '親' : '子'}）— ${winSourceText}`;

  const scoreBadge = document.createElement('div');
  scoreBadge.className = 'agari-score-badge';
  scoreBadge.textContent =
    agari.honbaPointsAwarded > 0
      ? `${agari.scoreLabel} / ${agari.pointsAwarded.toLocaleString()}点 (+本場 ${agari.honbaPointsAwarded.toLocaleString()}点)`
      : `${agari.scoreLabel} / ${agari.pointsAwarded.toLocaleString()}点`;

  header.append(who, scoreBadge);
  card.appendChild(header);

  // 和了者の手牌＋和了牌＋副露＋抜北公開
  const tilesRow = document.createElement('div');
  tilesRow.className = 'agari-tiles-row';

  for (const tile of agari.hand) {
    tilesRow.appendChild(createTileElement(tile, { small: true }));
  }

  const winGap = document.createElement('div');
  winGap.className = 'drawn-gap';
  tilesRow.appendChild(winGap);

  tilesRow.appendChild(
    createTileElement(agari.winningTile, { small: true, called: true }),
  );

  for (const meld of agari.melds) {
    tilesRow.appendChild(
      renderMeldGroup(meld, { ankanHidden: true, small: true }),
    );
  }

  if (agari.kitaTiles.length > 0) {
    tilesRow.appendChild(renderKitaGroup(agari.kitaTiles, true));
  }

  card.appendChild(tilesRow);

  // 役一覧・ドラ・符翻サマリー
  const yakuList = document.createElement('div');
  yakuList.className = 'yaku-list';

  for (const y of agari.yaku) {
    const chip = document.createElement('span');
    chip.className = `yaku-chip${y.isYakuman ? ' is-yakuman' : ''}`;
    chip.textContent = y.isYakuman
      ? (y.yakumanMultiplier ?? 1) >= 2
        ? `${y.name} ダブル役満`
        : `${y.name} 役満`
      : `${y.name} ${y.han}翻`;
    yakuList.appendChild(chip);
  }

  if (!agari.isYakuman && agari.doraCount > 0) {
    const doraChip = document.createElement('span');
    doraChip.className = 'yaku-chip is-dora';
    doraChip.textContent = `ドラ ${agari.doraCount}翻`;
    yakuList.appendChild(doraChip);
  }

  if (!agari.isYakuman && agari.uraDoraCount > 0) {
    const uraChip = document.createElement('span');
    uraChip.className = 'yaku-chip is-dora';
    uraChip.textContent = `裏ドラ ${agari.uraDoraCount}翻`;
    yakuList.appendChild(uraChip);
  }

  if (!agari.isYakuman && agari.kitaCount > 0) {
    const kitaChip = document.createElement('span');
    kitaChip.className = 'yaku-chip is-dora';
    kitaChip.textContent = `抜北 ${agari.kitaCount}翻`;
    yakuList.appendChild(kitaChip);
  }

  card.appendChild(yakuList);

  const summary = document.createElement('div');
  summary.className = 'hub-sub';
  const totalWithHonba = agari.pointsAwarded + agari.honbaPointsAwarded;
  const honbaDetail =
    agari.honbaPointsAwarded > 0
      ? ` + 本場 ${agari.honbaPointsAwarded.toLocaleString()}点 = 計 ${totalWithHonba.toLocaleString()}点`
      : '';
  summary.textContent = agari.isYakuman
    ? `${agari.scoreLabel}（${agari.pointsAwarded.toLocaleString()}点${honbaDetail}）`
    : `${agari.han}翻 ${agari.fu}符 — ${agari.scoreLabel}（${agari.pointsAwarded.toLocaleString()}点${honbaDetail}）`;
  card.appendChild(summary);

  return card;
}

/**
 * 卓の左上に固定するドラ表示パネル（雀魂準拠）。
 * ドラ表示牌 5 枠 + リーチ棒・本場棒の集計 + 対局モード表記をコンパクトにまとめる。
 */
function renderDoraPanel(view: StateView): HTMLElement | null {
  const round = view.round;
  if (!round) return null;
  const rules = deriveRules(view.ruleConfig);

  const panel = document.createElement('div');
  panel.className = 'dora-panel';
  panel.setAttribute('aria-label', 'ドラ表示');

  const box = document.createElement('div');
  box.className = 'dora-panel-box';

  const tiles = document.createElement('div');
  tiles.className = 'dora-panel-tiles';
  for (let i = 0; i < rules.doraIndicatorCount; i++) {
    const indicator = round.doraIndicators[i];
    if (indicator) {
      tiles.appendChild(createTileElement(indicator, { small: true }));
    } else {
      const back = createTileBackElement(true, true);
      back.classList.add('dora-slot-back');
      tiles.appendChild(back);
    }
  }

  const sticks = document.createElement('div');
  sticks.className = 'dora-panel-sticks';

  const kyotakuItem = document.createElement('span');
  kyotakuItem.className = 'dora-stick-item';
  kyotakuItem.title = `供託リーチ棒 ${view.kyotakuCount}本 (${(view.kyotakuCount * rules.riichiStickPoints).toLocaleString()}点)`;
  kyotakuItem.innerHTML = `<span class="stick-icon stick-riichi" aria-hidden="true"></span><span>× ${view.kyotakuCount}</span>`;

  const honbaItem = document.createElement('span');
  honbaItem.className = 'dora-stick-item';
  honbaItem.title = `本場 ${round.honba}本場`;
  honbaItem.innerHTML = `<span class="stick-icon stick-honba" aria-hidden="true"></span><span>× ${round.honba}</span>`;

  sticks.append(kyotakuItem, honbaItem);

  if (round.kanCount > 0) {
    const kanTag = document.createElement('span');
    kanTag.className = 'dora-kan-tag';
    kanTag.textContent = `槓${round.kanCount}/${rules.maxKansPerRound}`;
    sticks.appendChild(kanTag);
  }

  box.append(tiles, sticks);

  const mode = document.createElement('div');
  mode.className = 'dora-panel-mode';
  const lengthJa = view.ruleConfig.gameLength === 'tonpuu' ? '東風戦' : '半荘戦';
  const roomLabel =
    view.roomCode === 'LOCAL' ? 'ローカルCPU戦' : `部屋 ${view.roomCode}`;
  mode.textContent = `${view.ruleConfig.playerCount}人${lengthJa}・${roomLabel}`;

  panel.append(box, mode);

  if (!rules.honbaBonus && round.honba > 0) {
    const honbaNote = document.createElement('div');
    honbaNote.className = 'honba-note';
    honbaNote.textContent = '本場加算なし';
    panel.appendChild(honbaNote);
  }

  return panel;
}

/** 卓の右上に置く操作ボタン（設定・退出） */
function renderTableChrome(
  view: StateView,
  handlers: TableHandlers,
  uiState: TableUiState,
): HTMLElement | null {
  const showLeave = Boolean(handlers.canLeaveGame && handlers.onLeaveGame);
  const showSettings = Boolean(handlers.onToggleSettings);
  if (!showLeave && !showSettings) {
    return null;
  }

  const bar = document.createElement('div');
  bar.className = 'table-chrome';

  if (showSettings) {
    const settingsBtn = document.createElement('button');
    settingsBtn.type = 'button';
    settingsBtn.className = `table-chrome-btn table-chrome-settings${
      uiState.settingsOpen ? ' is-open' : ''
    }`;
    settingsBtn.textContent = '設定';
    settingsBtn.title = '対局補助とルール確認';
    settingsBtn.addEventListener('click', () =>
      handlers.onToggleSettings?.(!uiState.settingsOpen),
    );
    bar.appendChild(settingsBtn);
  }

  if (showLeave) {
    const leave = document.createElement('button');
    leave.type = 'button';
    leave.className = 'table-chrome-btn table-chrome-leave';
    leave.textContent = '退出';
    leave.title = '対局を離れてロビーに戻る';
    leave.addEventListener('click', () => handlers.onLeaveGame?.());
    bar.appendChild(leave);
  }

  if (uiState.settingsOpen && showSettings) {
    const rules = deriveRules(view.ruleConfig);
    const pop = document.createElement('div');
    pop.className = 'table-settings-popover';

    const title = document.createElement('div');
    title.className = 'table-settings-title';
    title.textContent = '対局設定・ルール';
    pop.appendChild(title);

    const makeToggle = (
      label: string,
      active: boolean,
      onClick?: () => void,
    ): HTMLButtonElement => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `table-settings-toggle${active ? ' is-on' : ''}`;
      btn.textContent = `${label}: ${active ? 'ON' : 'OFF'}`;
      if (onClick) btn.addEventListener('click', onClick);
      return btn;
    };

    pop.append(
      makeToggle('自動和了 (和)', Boolean(uiState.autoAgariEnabled), () =>
        handlers.onToggleAutoAgari?.(!uiState.autoAgariEnabled),
      ),
      makeToggle('鳴き無し (鳴)', Boolean(uiState.autoNoCallEnabled), () =>
        handlers.onToggleAutoNoCall?.(!uiState.autoNoCallEnabled),
      ),
      makeToggle('自動ツモ切り (切)', uiState.autoTsumogiriEnabled, () =>
        handlers.onToggleAutoTsumogiri?.(!uiState.autoTsumogiriEnabled),
      ),
    );

    const ruleSummary = document.createElement('div');
    ruleSummary.className = 'table-settings-rules';
    ruleSummary.textContent = [
      `${rules.playerCount}人 ${rules.gameLength === 'tonpuu' ? '東風' : '半荘'}`,
      rules.allowKuitan ? '喰いタンあり' : '喰いタンなし',
      rules.allowAtozuke ? '後付けあり' : '先付け',
      rules.tobi ? 'トビあり' : 'トビなし',
    ].join(' / ');
    pop.appendChild(ruleSummary);
    bar.appendChild(pop);
  }

  return bar;
}

/** 卓の左端に置く縦型クイック補助バー（理 / 和 / 鳴 / 切） */
function renderLeftActionBar(
  handlers: TableHandlers,
  uiState: TableUiState,
): HTMLElement {
  const bar = document.createElement('div');
  bar.className = 'table-left-actions';

  const makeTab = (
    char: string,
    title: string,
    active: boolean,
    onClick?: () => void,
  ): HTMLButtonElement => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `left-action-tab${active ? ' is-active' : ''}`;
    btn.textContent = char;
    btn.title = title;
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    if (onClick) {
      btn.addEventListener('click', onClick);
    }
    return btn;
  };

  bar.append(
    makeTab('理', '自動理牌（有効）', true),
    makeTab(
      '和',
      '自動和了（ONでツモ・ロンを自動実行）',
      Boolean(uiState.autoAgariEnabled),
      () => handlers.onToggleAutoAgari?.(!uiState.autoAgariEnabled),
    ),
    makeTab(
      '鳴',
      '鳴き無し（ONでポン・チー・カンを自動パス）',
      Boolean(uiState.autoNoCallEnabled),
      () => handlers.onToggleAutoNoCall?.(!uiState.autoNoCallEnabled),
    ),
    makeTab(
      '切',
      'リーチ後ツモ切り（ONで自動ツモ切り）',
      uiState.autoTsumogiriEnabled,
      () => handlers.onToggleAutoTsumogiri?.(!uiState.autoTsumogiriEnabled),
    ),
  );

  return bar;
}

function getSeatPlayersMap(view: StateView): Map<SeatSide, PublicPlayerView> {
  const playerCount = view.players.length;
  const bySide = new Map<SeatSide, PublicPlayerView>();
  const selfPlayer = view.players.find((p) => p.seatIndex === view.viewerSeatIndex);
  if (selfPlayer) bySide.set('self', selfPlayer);
  const right = view.players.find(
    (p) => p.seatIndex === (view.viewerSeatIndex + 1) % playerCount,
  );
  if (right) bySide.set('right', right);
  const leftSide =
    view.players.find(
      (p) =>
        p.seatIndex ===
        (view.viewerSeatIndex + (playerCount === 4 ? 3 : 2)) % playerCount,
    ) ?? undefined;
  if (leftSide) bySide.set('left', leftSide);
  if (playerCount === 4) {
    const top = view.players.find(
      (p) => p.seatIndex === (view.viewerSeatIndex + 2) % playerCount,
    );
    if (top) bySide.set('top', top);
  }
  return bySide;
}

function renderCenterHub(view: StateView): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'seat-center';

  const hub = document.createElement('div');
  hub.className = 'center-hub';

  const round = view.round;
  const bySide = getSeatPlayersMap(view);

  hub.appendChild(renderCompass(view, bySide));

  const scoresLayer = document.createElement('div');
  scoresLayer.className = 'console-scores';
  for (const side of ['top', 'right', 'self', 'left'] as const) {
    const player = bySide.get(side);
    const cell = document.createElement('div');
    cell.className = `console-score console-score-${side}${
      player?.isCurrentTurn ? ' is-turn' : ''
    }${player?.isRiichi ? ' is-riichi' : ''}${!player ? ' is-empty' : ''}`;
    if (player) {
      const val = document.createElement('span');
      val.className = 'console-score-val';
      val.textContent = String(player.score);
      cell.appendChild(val);
    }
    scoresLayer.appendChild(cell);
  }
  hub.appendChild(scoresLayer);

  const core = document.createElement('div');
  core.className = 'console-core';

  const roundLabel = document.createElement('div');
  roundLabel.className = 'round-label';
  roundLabel.textContent = round
    ? formatRoundName(round.roundWind, round.kyokuNumber)
    : '対局';

  const wallCounter = document.createElement('div');
  wallCounter.className = 'wall-counter';
  wallCounter.textContent = round ? `余 ${round.remainingWallCount}` : '';

  core.append(roundLabel, wallCounter);

  if (round && round.honba > 0) {
    const honbaTag = document.createElement('div');
    honbaTag.className = 'console-honba';
    honbaTag.textContent = `${round.honba}本場`;
    core.appendChild(honbaTag);
  }

  hub.appendChild(core);
  wrap.appendChild(hub);
  return wrap;
}

/**
 * 卓の中央に置く方位表示（四隅の自風＋手番＋リーチ表示）。
 */
function renderCompass(
  view: StateView,
  bySide: Map<SeatSide, PublicPlayerView> = getSeatPlayersMap(view),
): HTMLElement {
  const ring = document.createElement('div');
  ring.className = 'table-compass';

  const positions: Array<{ side: SeatSide; label: string }> = [
    { side: 'top', label: '対面' },
    { side: 'right', label: '下家' },
    { side: 'left', label: '上家' },
    { side: 'self', label: '自分' },
  ];

  for (const { side } of positions) {
    const player = bySide.get(side);
    const slot = document.createElement('div');
    slot.className = `compass-slot compass-${side}${
      player?.isCurrentTurn ? ' is-turn' : ''
    }`;
    if (!player) {
      slot.classList.add('is-empty');
      ring.appendChild(slot);
      continue;
    }
    if (player.seatWind) {
      const wind = document.createElement('span');
      wind.className = `compass-wind${player.isDealer ? ' is-dealer' : ''}`;
      wind.textContent = windToJa(player.seatWind);
      slot.appendChild(wind);
    }
    if (player.isRiichi) {
      const riichi = document.createElement('span');
      riichi.className = 'compass-riichi';
      riichi.textContent = 'リーチ';
      slot.appendChild(riichi);
    }
    ring.appendChild(slot);
  }

  return ring;
}

function createSeatAvatar(
  player: PublicPlayerView,
  isSelf: boolean,
): HTMLElement {
  const frame = document.createElement('div');
  frame.className = `seat-avatar${isSelf ? ' is-self' : ''}${
    player.isCurrentTurn ? ' is-turn' : ''
  }`;
  frame.setAttribute('aria-hidden', 'true');

  const palettes: Record<string, { bg1: string; bg2: string; accent: string }> = {
    E: { bg1: '#5d1c24', bg2: '#2d0c12', accent: '#f3cb68' },
    S: { bg1: '#1b4d40', bg2: '#0d2620', accent: '#7ce8b8' },
    W: { bg1: '#1d3a68', bg2: '#0d1b36', accent: '#82c5ff' },
    N: { bg1: '#3d255e', bg2: '#1b102d', accent: '#d8b4fe' },
  };
  const pal = palettes[player.seatWind ?? 'E'] ?? palettes.E!;
  const initial = Array.from(player.name.trim())[0] ?? (isSelf ? '自' : '家');

  frame.innerHTML = `<svg viewBox="0 0 40 40" class="seat-avatar-svg"><defs><linearGradient id="av-${player.seatIndex}" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="${pal.bg1}"/><stop offset="100%" stop-color="${pal.bg2}"/></linearGradient></defs><rect width="40" height="40" rx="4" fill="url(#av-${player.seatIndex})"/><circle cx="20" cy="16" r="7.5" fill="${pal.accent}" fill-opacity="0.26" stroke="${pal.accent}" stroke-width="1.2"/><path d="M9 36c1.5-6.5 6-10 11-10s9.5 3.5 11 10" fill="${pal.accent}" fill-opacity="0.24" stroke="${pal.accent}" stroke-width="1.1"/><text x="20" y="20" text-anchor="middle" font-size="11" font-weight="800" fill="#f7f4ea">${escapeSvgText(initial)}</text></svg>`;

  return frame;
}

function escapeSvgText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function renderSeatHeader(
  player: PublicPlayerView,
  isSelf: boolean,
  isSelfFuriten = false,
): HTMLElement {
  const header = document.createElement('div');
  header.className = `seat-header${player.isCurrentTurn ? ' is-turn' : ''}`;

  const cardTop = document.createElement('div');
  cardTop.className = 'seat-card-top';
  cardTop.appendChild(createSeatAvatar(player, isSelf));

  if (player.seatWind) {
    const windBadge = document.createElement('span');
    windBadge.className = `wind-badge${player.isDealer ? ' is-dealer' : ''}`;
    windBadge.textContent = windToJa(player.seatWind);
    cardTop.appendChild(windBadge);
  }

  const info = document.createElement('div');
  info.className = 'seat-card-info';

  const identity = document.createElement('div');
  identity.className = 'seat-identity';

  const nameSpan = document.createElement('span');
  nameSpan.className = 'seat-name';
  nameSpan.textContent = isSelf ? `${player.name}（あなた）` : player.name;
  identity.appendChild(nameSpan);

  if (isCpuPlayerId(player.playerId)) {
    const cpuBadge = document.createElement('span');
    cpuBadge.className = 'cpu-badge';
    cpuBadge.textContent = 'CPU';
    identity.appendChild(cpuBadge);
  }

  if (player.isDealer) {
    const oya = document.createElement('span');
    oya.className = 'oya-tag';
    oya.textContent = '親';
    identity.appendChild(oya);
  }

  if (player.isDoubleRiichi || player.isRiichi) {
    const riichiTag = document.createElement('span');
    riichiTag.className = 'riichi-badge';
    riichiTag.textContent = player.isDoubleRiichi ? 'Wリーチ' : 'リーチ';
    identity.appendChild(riichiTag);
  }

  if (player.isCurrentTurn) {
    const turn = document.createElement('span');
    turn.className = 'turn-tag';
    turn.textContent = '手番';
    identity.appendChild(turn);
  }

  if (isSelf && isSelfFuriten) {
    const furiten = document.createElement('span');
    furiten.className = 'furiten-badge';
    furiten.textContent = 'フリテン（ロン不可）';
    identity.appendChild(furiten);
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

  info.append(identity, score);
  header.append(cardTop, info);
  return header;
}

/**
 * 河（捨て牌）を再現する。
 * 実物の麻雀と同じく、中央のデジタル盤の周囲に各席の河を6枚折り返しで配置する。
 */
function renderDiscardRiver(
  player: PublicPlayerView,
  options: {
    side?: SeatSide;
    limit?: number;
    latestOnly?: boolean;
    compact?: boolean;
    label?: string | null;
  } = {},
): HTMLElement {
  const side = options.side ?? 'self';
  const wrap = document.createElement('div');
  wrap.className = `river-zone river-${side}`;
  wrap.dataset.seat = side;

  if (options.label) {
    const label = document.createElement('span');
    label.className = 'river-label';
    label.textContent = options.label;
    wrap.appendChild(label);
  }

  const river = document.createElement('div');
  river.className = `discard-river river-${side} river-rows-6${
    options.compact ? ' is-compact' : ''
  }`;

  const limit = options.limit ?? player.discards.length;
  const start =
    options.latestOnly && player.discards.length > limit
      ? Math.max(0, player.discards.length - limit)
      : 0;
  const visible = player.discards.slice(start);
  const lastIndex = player.discards.length - 1;

  if (visible.length === 0) {
    const empty = document.createElement('span');
    empty.className = 'river-empty';
    empty.setAttribute('aria-hidden', 'true');
    river.appendChild(empty);
  }

  visible.forEach((entry, idx) => {
    const absoluteIndex = start + idx;
    const isLatest = absoluteIndex === lastIndex;
    river.appendChild(
      createTileElement(entry.tile, {
        small: true,
        tsumogiri: entry.isTsumogiri,
        latestDiscard: isLatest,
        riichiDeclaration: Boolean(entry.isRiichiDeclaration),
      }),
    );
  });

  wrap.appendChild(river);
  return wrap;
}

function renderMeldsAndKita(
  player: PublicPlayerView,
  side: SeatSide = 'self',
): HTMLElement | null {
  if (player.melds.length === 0 && player.kitaTiles.length === 0) {
    return null;
  }

  const row = document.createElement('div');
  row.className = `meld-kita-row meld-orient-${side}`;

  for (const meld of player.melds) {
    row.appendChild(renderMeldGroup(meld, { ankanHidden: true, small: true }));
  }

  if (player.kitaTiles.length > 0) {
    row.appendChild(renderKitaGroup(player.kitaTiles, true));
  }

  return row;
}

function renderOpponentSeat(
  side: Exclude<SeatSide, 'self'>,
  player: PublicPlayerView,
  _view: StateView,
): HTMLElement {
  const box = document.createElement('div');
  box.className = `seat-box ${SEAT_CLASS[side]} seat-orient-${side}${
    player.isCurrentTurn ? ' is-turn' : ''
  }`;
  box.dataset.seat = side;

  // 席情報（名前・自風・持ち点）は卓の外周側に置く
  box.appendChild(renderSeatHeader(player, false));

  // 外周（手牌）→ 副露 → 中央（河）の順に並べる入れ物
  const body = document.createElement('div');
  body.className = `seat-body seat-body-${side}`;

  // 手牌（裏向き）は卓の外周を向く。実物同様、左家は縦、対面は逆さになる。
  const handRow = document.createElement('div');
  handRow.className = `opponent-hand hand-orient-${side}`;
  const totalVisibleBacks = player.handCount + (player.hasDrawnTile ? 1 : 0);
  for (let i = 0; i < totalVisibleBacks; i++) {
    handRow.appendChild(createTileBackElement(true));
  }
  body.appendChild(handRow);

  const meldsEl = renderMeldsAndKita(player, side);
  if (meldsEl) {
    body.appendChild(meldsEl);
  }

  // 河は中央に向かって積まれる（全牌を表示・6枚折り返し）
  body.appendChild(renderDiscardRiver(player, { side }));

  box.appendChild(body);
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
  player: PublicPlayerView,
  handlers: TableHandlers,
  uiState: TableUiState,
  canDiscardNow: boolean,
): HTMLElement | null {
  if (view.phase !== 'playing') {
    return null;
  }
  const actions = canDiscardNow ? view.mySelfActions : null;
  const hasTurnAction = Boolean(
    actions &&
      (actions.canTsumo ||
        actions.canRiichiTileIds.length > 0 ||
        actions.canAnkanKinds.length > 0 ||
        actions.canKakanTileIds.length > 0 ||
        actions.canKitaTileIds.length > 0 ||
        actions.canKyuushuKyuuhai),
  );
  if (!hasTurnAction && !player.isRiichi) {
    return null;
  }

  const bar = document.createElement('div');
  bar.className = 'self-action-bar';

  const label = document.createElement('span');
  label.className = 'hub-sub';
  label.textContent =
    player.isRiichi && !hasTurnAction ? 'リーチ待機中:' : '手番アクション:';
  bar.appendChild(label);

  const btns = document.createElement('div');
  btns.className = 'action-buttons-row';

  if (actions?.canTsumo) {
    const tsumoBtn = document.createElement('button');
    tsumoBtn.type = 'button';
    tsumoBtn.className = 'btn btn-ron';
    tsumoBtn.textContent = 'ツモ和了';
    tsumoBtn.addEventListener('click', handlers.onDeclareTsumo);
    btns.appendChild(tsumoBtn);
  }

  if (actions && actions.canRiichiTileIds.length > 0) {
    const riichiBtn = document.createElement('button');
    riichiBtn.type = 'button';
    riichiBtn.className = uiState.riichiSelectingMode
      ? 'btn btn-secondary'
      : 'btn btn-riichi';
    riichiBtn.textContent = uiState.riichiSelectingMode
      ? 'リーチ宣言キャンセル'
      : 'リーチ';
    riichiBtn.addEventListener('click', () => {
      handlers.onToggleRiichiMode?.(!uiState.riichiSelectingMode);
    });
    btns.appendChild(riichiBtn);
  }

  if (actions) {
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

    if (actions.canKyuushuKyuuhai) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-abortive';
      btn.textContent = '九種九牌（流局）';
      btn.addEventListener('click', handlers.onDeclareKyuushuKyuuhai);
      btns.appendChild(btn);
    }
  }

  if (player.isRiichi) {
    const autoBtn = document.createElement('button');
    autoBtn.type = 'button';
    autoBtn.className = uiState.autoTsumogiriEnabled
      ? 'btn btn-call'
      : 'btn btn-secondary';
    autoBtn.textContent = `自動ツモ切り: ${uiState.autoTsumogiriEnabled ? 'ON' : 'OFF'}`;
    autoBtn.addEventListener('click', () => {
      handlers.onToggleAutoTsumogiri?.(!uiState.autoTsumogiriEnabled);
    });
    btns.appendChild(autoBtn);
  }

  bar.appendChild(btns);
  return bar;
}

function buildTurnPrompt(view: StateView, canDiscardNow: boolean): HTMLElement {
  const prompt = document.createElement('div');
  prompt.className = `turn-prompt${canDiscardNow ? ' is-my-turn' : ''}`;

  if (view.phase === 'round_end') {
    const hasAgari =
      view.round &&
      (view.round.agariResults.length > 0 || view.round.ronWinners.length > 0);
    if (hasAgari) {
      const winType = view.round!.agariResults[0]?.winType;
      prompt.textContent =
        winType === 'tsumo' ? 'ツモ和了が発生しました' : 'ロン和了が発生しました';
    } else if (view.round?.abortiveDrawReason) {
      prompt.textContent = `途中流局（${ABORTIVE_DRAW_META[view.round.abortiveDrawReason].title}）が発生しました`;
    } else {
      prompt.textContent = '流局しました';
    }
    return prompt;
  }

  if (view.phase === 'awaiting_responses' && view.myCallOptions !== null) {
    prompt.textContent = '相手の打牌に対して鳴き・ロンを選択できます';
    return prompt;
  }

  if (canDiscardNow) {
    if (view.mySelfActions?.canTsumo) {
      prompt.textContent =
        'ツモ和了が可能です！「ツモ和了」を押すか、切る牌を選んでください';
    } else if (view.players.find((p) => p.playerId === view.viewerPlayerId)?.isRiichi) {
      prompt.textContent = 'リーチ中です — ツモ牌のみ切れます';
    } else if (view.kuikaeForbiddenKinds.length > 0) {
      prompt.textContent =
        'あなたの手番です — 切る牌を選んでください（喰い替え禁止牌は選択不可）';
    } else {
      prompt.textContent = 'あなたの手番です — 切る牌をタップしてください';
    }
    return prompt;
  }

  const current = view.players.find((p) => p.isCurrentTurn);
  if (current?.playerId === view.viewerPlayerId) {
    prompt.textContent = '待機中...';
  } else if (current) {
    prompt.textContent = `${current.name} の打牌を待っています...`;
  } else {
    prompt.textContent = '待機中...';
  }
  return prompt;
}

function renderSelfSeat(
  view: StateView,
  player: PublicPlayerView,
  handlers: TableHandlers,
  uiState: TableUiState,
): HTMLElement {
  const box = document.createElement('div');
  box.className = `seat-box seat-self seat-orient-self${
    player.isCurrentTurn ? ' is-turn' : ''
  }`;
  box.dataset.seat = 'self';

  const isMyTurn = view.phase === 'playing' && player.isCurrentTurn;
  const canDiscardNow =
    isMyTurn && (view.myDrawnTile !== null || view.myHand.length % 3 === 2);
  const canRiichiIds = view.mySelfActions?.canRiichiTileIds ?? [];
  const inRiichiMode =
    canDiscardNow && uiState.riichiSelectingMode && canRiichiIds.length > 0;
  const riichiCandidateSet = new Set(canRiichiIds);

  const controls = document.createElement('div');
  controls.className = 'self-controls';

  const topBar = document.createElement('div');
  topBar.className = 'self-top-bar';
  topBar.appendChild(renderSeatHeader(player, true, view.isFuriten));

  const actionDock = document.createElement('div');
  actionDock.className = 'self-action-dock';
  actionDock.appendChild(buildTurnPrompt(view, canDiscardNow));

  const callBar = renderCallResponseBar(view, handlers);
  if (callBar) {
    actionDock.appendChild(callBar);
  }

  const selfActionsBar = renderSelfTurnActionsBar(
    view,
    player,
    handlers,
    uiState,
    canDiscardNow,
  );
  if (selfActionsBar) {
    actionDock.appendChild(selfActionsBar);
  }

  if (
    view.phase === 'awaiting_responses' &&
    view.myCallOptions !== null &&
    view.responseRemainingMs !== null
  ) {
    const secs = Math.ceil(view.responseRemainingMs / 1000);
    const timer = document.createElement('div');
    timer.className = 'table-timer-digits';
    timer.innerHTML = `<span data-countdown-ms>${secs}</span>`;
    actionDock.appendChild(timer);
  }

  topBar.appendChild(actionDock);
  controls.appendChild(topBar);

  const forbiddenSet = new Set(canDiscardNow ? view.kuikaeForbiddenKinds : []);
  const handArea = document.createElement('div');
  handArea.className = 'hand-area';

  for (const tile of view.myHand) {
    if (inRiichiMode) {
      const isCandidate = riichiCandidateSet.has(tile.id);
      handArea.appendChild(
        createTileElement(tile, {
          clickable: isCandidate,
          disabled: !isCandidate,
          riichiCandidate: isCandidate,
          disabledReason: isCandidate
            ? undefined
            : 'この牌を切っても聴牌にならないためリーチできません',
          onClick: () => handlers.onDeclareRiichi(tile.id),
        }),
      );
    } else {
      const lockedByRiichi = canDiscardNow && player.isRiichi;
      const blockedByKuikae = forbiddenSet.has(tile.kind);
      const blocked = lockedByRiichi || blockedByKuikae;
      handArea.appendChild(
        createTileElement(tile, {
          clickable: canDiscardNow && !blocked,
          disabled: canDiscardNow && blocked,
          disabledReason: lockedByRiichi
            ? 'リーチ後は手牌を入れ替えられません'
            : blockedByKuikae
              ? '喰い替え禁止のため切れません'
              : undefined,
          onClick: () => handlers.onDiscardTile(tile.id),
        }),
      );
    }
  }

  if (view.myDrawnTile) {
    const drawn = view.myDrawnTile;
    const gap = document.createElement('div');
    gap.className = 'drawn-gap';
    handArea.appendChild(gap);
    if (inRiichiMode) {
      const isCandidate = riichiCandidateSet.has(drawn.id);
      handArea.appendChild(
        createTileElement(drawn, {
          clickable: isCandidate,
          disabled: !isCandidate,
          riichiCandidate: isCandidate,
          disabledReason: isCandidate
            ? undefined
            : 'この牌を切っても聴牌にならないためリーチできません',
          onClick: () => handlers.onDeclareRiichi(drawn.id),
        }),
      );
    } else {
      const blocked = forbiddenSet.has(drawn.kind);
      handArea.appendChild(
        createTileElement(drawn, {
          clickable: canDiscardNow && !blocked,
          disabled: canDiscardNow && blocked,
          disabledReason: blocked ? '喰い替え禁止のため切れません' : undefined,
          onClick: () => handlers.onDiscardTile(drawn.id),
        }),
      );
    }
  }

  const handDock = document.createElement('div');
  handDock.className = 'self-hand-dock';

  const meldsSlot = document.createElement('div');
  meldsSlot.className = 'self-melds-dock';
  const meldsEl = renderMeldsAndKita(player, 'self');
  if (meldsEl) {
    meldsSlot.appendChild(meldsEl);
  }

  const rightSpacer = document.createElement('div');
  rightSpacer.className = 'self-hand-spacer';

  handDock.append(meldsSlot, handArea, rightSpacer);
  controls.appendChild(handDock);

  box.appendChild(controls);

  // 自分の河は手牌より中央側（卓の内側）に置き、実物と同じ並びにする
  box.appendChild(renderDiscardRiver(player, { side: 'self' }));
  return box;
}

function buildScoreTable(
  players: PublicPlayerView[],
  initialPoints: number,
  ranked = false,
  roundScoreDeltas?: Record<string, number>,
  initialDealerIndex = 0,
): HTMLElement {
  const list = ranked ? rankPlayersByScore(players, initialDealerIndex) : players;

  const hasRoundDelta =
    roundScoreDeltas !== undefined && Object.keys(roundScoreDeltas).length > 0;

  const table = document.createElement('table');
  table.className = 'score-table';
  const thead = document.createElement('thead');
  thead.innerHTML = `<tr>${ranked ? '<th>順位</th>' : ''}<th>プレイヤー</th>${hasRoundDelta ? '<th class="num">今局増減</th>' : ''}<th class="num">持ち点</th><th class="num">通算収支</th></tr>`;
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
    tr.appendChild(nameTd);

    if (hasRoundDelta) {
      const delta = roundScoreDeltas![p.playerId] ?? 0;
      const deltaTd = document.createElement('td');
      deltaTd.className = `num${delta > 0 ? ' delta-pos' : delta < 0 ? ' delta-neg' : ''}`;
      deltaTd.textContent =
        delta > 0
          ? `+${delta.toLocaleString()}`
          : delta < 0
            ? delta.toLocaleString()
            : '±0';
      tr.appendChild(deltaTd);
    }

    const scoreTd = document.createElement('td');
    scoreTd.className = 'num';
    scoreTd.textContent = `${p.score.toLocaleString()}点`;

    const diffTd = document.createElement('td');
    diffTd.className = `num${diff > 0 ? ' delta-pos' : diff < 0 ? ' delta-neg' : ''}`;
    diffTd.textContent = diffStr;
    tr.append(scoreTd, diffTd);
    tbody.appendChild(tr);
  });

  table.appendChild(tbody);
  return table;
}

/** 席順の起家からの距離 → 持ち点の順で並べる（同点は起家に近い席が上位） */
function rankPlayersByScore<T extends { seatIndex: number; score: number }>(
  players: readonly T[],
  initialDealerIndex: number,
): T[] {
  const count = players.length;
  return [...players].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const distA = ((a.seatIndex - initialDealerIndex) % count + count) % count;
    const distB = ((b.seatIndex - initialDealerIndex) % count + count) % count;
    return distA - distB;
  });
}

function renderFinishedScreen(
  container: HTMLElement,
  view: StateView,
  initialPoints: number,
  handlers: TableHandlers,
): void {
  const panel = document.createElement('div');
  panel.className = 'overlay-panel';
  applyOrientationClass(panel);

  const title = document.createElement('h2');
  title.style.margin = '0';
  title.style.color = 'var(--accent-gold)';
  const lengthJa = view.ruleConfig.gameLength === 'tonpuu' ? '東風戦' : '半荘戦';
  const hasTobi = view.players.some((p) => p.score < 0);
  title.textContent = `終局 — ${view.ruleConfig.playerCount}人 ${lengthJa} 最終結果${hasTobi ? '（トビ終了）' : ''}`;

  const table = buildScoreTable(
    view.players,
    initialPoints,
    true,
    undefined,
    view.initialDealerIndex,
  );
  panel.append(title, table);

  if (view.finalKyotakuAward) {
    const awardPlayer = view.players.find(
      (p) => p.playerId === view.finalKyotakuAward!.playerId,
    );
    const awardNote = document.createElement('div');
    awardNote.className = 'kyotaku-award-note';
    awardNote.textContent = `終局時残供託加算: ${awardPlayer?.name ?? view.finalKyotakuAward.playerId} に +${view.finalKyotakuAward.points.toLocaleString()}点 を加算しました（同点時は起家に近い席が上位）。`;
    panel.appendChild(awardNote);
  }

  if (view.kyotakuCount > 0) {
    const rules = deriveRules(view.ruleConfig);
    const leftover = document.createElement('div');
    leftover.className = 'hub-sub';
    leftover.textContent = `場に残った供託リーチ棒: ${view.kyotakuCount}本（${(view.kyotakuCount * rules.riichiStickPoints).toLocaleString()}点）`;
    panel.appendChild(leftover);
  }

  const backBtn = document.createElement('button');
  backBtn.type = 'button';
  backBtn.className = 'btn btn-primary';
  backBtn.style.alignSelf = 'flex-start';
  backBtn.textContent = 'ロビーに戻る';
  backBtn.addEventListener('click', handlers.onReturnToLobby);

  panel.appendChild(backBtn);
  const backdrop = document.createElement('div');
  backdrop.className = 'overlay-backdrop overlay-backdrop-finished';
  backdrop.appendChild(panel);
  container.appendChild(backdrop);
}

/** CPU 名のラベル（ロビー表示用の再エクスポート） */
export { cpuDisplayName, CPU_PLAYER_ID_PREFIX };
