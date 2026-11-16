import { rankPlayers } from '../engine/roundProgression';
import { deriveRules, getRoundMetadata } from '../engine/rules';
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
  onAdvanceRound: () => void;
  onReturnToLobby: () => void;
}

export interface TableUiState {
  riichiSelectingMode: boolean;
  autoTsumogiriEnabled: boolean;
}

const DEFAULT_TABLE_UI_STATE: TableUiState = {
  riichiSelectingMode: false,
  autoTsumogiriEnabled: true,
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
    felt.appendChild(renderSelfSeat(view, selfPlayer, handlers, uiState));
  }

  container.appendChild(felt);

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
    const nextMeta = getRoundMetadata(
      decision.nextRoundIndex,
      view.initialDealerIndex,
      rules,
    );
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
          const meldGroup = document.createElement('div');
          meldGroup.className = 'meld-group';
          const label = document.createElement('span');
          label.className = 'meld-label';
          label.textContent = MELD_TYPE_LABELS[meld.type];
          meldGroup.appendChild(label);
          const meldTiles = document.createElement('div');
          meldTiles.className = 'meld-tiles';
          if (meld.type === 'ankan' && meld.tiles.length === 4) {
            meldTiles.appendChild(createTileBackElement(true, true));
            meldTiles.appendChild(createTileElement(meld.tiles[1]!, { small: true }));
            meldTiles.appendChild(createTileElement(meld.tiles[2]!, { small: true }));
            meldTiles.appendChild(createTileBackElement(true, true));
          } else {
            for (const tile of meld.tiles) {
              meldTiles.appendChild(createTileElement(tile, { small: true }));
            }
          }
          meldGroup.appendChild(meldTiles);
          tilesRow.appendChild(meldGroup);
        }
        if (p.kitaTiles.length > 0) {
          const kitaGroup = document.createElement('div');
          kitaGroup.className = 'meld-group meld-group-kita';
          const label = document.createElement('span');
          label.className = 'meld-label';
          label.textContent = `抜北 ×${p.kitaTiles.length}`;
          kitaGroup.appendChild(label);
          const kitaTiles = document.createElement('div');
          kitaTiles.className = 'meld-tiles';
          for (const tile of p.kitaTiles) {
            kitaTiles.appendChild(createTileElement(tile, { small: true }));
          }
          kitaGroup.appendChild(kitaTiles);
          tilesRow.appendChild(kitaGroup);
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

  container.appendChild(overlay);
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
    const meldGroup = document.createElement('div');
    meldGroup.className = 'meld-group';
    const label = document.createElement('span');
    label.className = 'meld-label';
    label.textContent = MELD_TYPE_LABELS[meld.type];
    meldGroup.appendChild(label);

    const meldTiles = document.createElement('div');
    meldTiles.className = 'meld-tiles';
    if (meld.type === 'ankan' && meld.tiles.length === 4) {
      meldTiles.appendChild(createTileBackElement(true, true));
      meldTiles.appendChild(createTileElement(meld.tiles[1]!, { small: true }));
      meldTiles.appendChild(createTileElement(meld.tiles[2]!, { small: true }));
      meldTiles.appendChild(createTileBackElement(true, true));
    } else {
      for (const tile of meld.tiles) {
        meldTiles.appendChild(createTileElement(tile, { small: true }));
      }
    }
    meldGroup.appendChild(meldTiles);
    tilesRow.appendChild(meldGroup);
  }

  if (agari.kitaTiles.length > 0) {
    const kitaGroup = document.createElement('div');
    kitaGroup.className = 'meld-group meld-group-kita';
    const label = document.createElement('span');
    label.className = 'meld-label';
    label.textContent = `抜北 ×${agari.kitaTiles.length}`;
    kitaGroup.appendChild(label);
    const kitaTiles = document.createElement('div');
    kitaTiles.className = 'meld-tiles';
    for (const tile of agari.kitaTiles) {
      kitaTiles.appendChild(createTileElement(tile, { small: true }));
    }
    kitaGroup.appendChild(kitaTiles);
    tilesRow.appendChild(kitaGroup);
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
    ? formatRoundName(round.roundWind, round.kyokuNumber, round.honba)
    : '対局';

  const wallCounter = document.createElement('div');
  wallCounter.className = 'wall-counter';
  wallCounter.textContent = round
    ? `残り牌数: ${round.remainingWallCount} 枚`
    : '';

  hub.append(roundLabel, wallCounter);

  if (round && !rules.honbaBonus && round.honba > 0) {
    const honbaNote = document.createElement('div');
    honbaNote.className = 'honba-note';
    honbaNote.textContent = '本場加算なしルール';
    hub.appendChild(honbaNote);
  }

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

    const kyotakuBadge = document.createElement('div');
    kyotakuBadge.className = 'kyotaku-badge';
    kyotakuBadge.textContent = `供託: ${view.kyotakuCount}本 (${(view.kyotakuCount * rules.riichiStickPoints).toLocaleString()}点)`;
    hub.appendChild(kyotakuBadge);

    if (round.kanCount > 0) {
      const kanBadge = document.createElement('div');
      kanBadge.className = 'hub-sub';
      kanBadge.textContent = `カン回数: ${round.kanCount} / ${rules.maxKansPerRound}`;
      hub.appendChild(kanBadge);
    }
  }

  if (view.phase === 'awaiting_responses' && view.myCallOptions !== null) {
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

function renderSeatHeader(
  player: PublicPlayerView,
  isSelf: boolean,
  isSelfFuriten = false,
): HTMLElement {
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
        riichiDeclaration: Boolean(entry.isRiichiDeclaration),
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
  player: PublicPlayerView,
  handlers: TableHandlers,
  uiState: TableUiState,
  canDiscardNow: boolean,
): HTMLElement | null {
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
  label.textContent = player.isRiichi && !hasTurnAction ? 'リーチ中:' : '手番アクション:';
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

function renderSelfSeat(
  view: StateView,
  player: PublicPlayerView,
  handlers: TableHandlers,
  uiState: TableUiState,
): HTMLElement {
  const box = document.createElement('div');
  box.className = `seat-box seat-self${player.isCurrentTurn ? ' is-turn' : ''}`;

  box.appendChild(renderSeatHeader(player, true, view.isFuriten));

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
  const canDiscardNow =
    isMyTurn && (view.myDrawnTile !== null || view.myHand.length % 3 === 2);
  const canRiichiIds = view.mySelfActions?.canRiichiTileIds ?? [];
  const inRiichiMode =
    canDiscardNow && uiState.riichiSelectingMode && canRiichiIds.length > 0;
  const riichiCandidateSet = new Set(canRiichiIds);

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
  } else if (view.phase === 'awaiting_responses' && view.myCallOptions !== null) {
    prompt.textContent = '相手の打牌に対して鳴き・ロンを選択できます';
  } else if (inRiichiMode) {
    prompt.textContent =
      'リーチ宣言: 聴牌を維持できる牌を選んでください（ハイライト表示）';
  } else if (canDiscardNow) {
    if (view.mySelfActions?.canTsumo) {
      prompt.textContent =
        'ツモ和了が可能です！「ツモ和了」を押すか、切る牌を選んでください';
    } else if (player.isRiichi) {
      prompt.textContent = 'リーチ中です — ツモ牌のみ切れます';
    } else if (view.kuikaeForbiddenKinds.length > 0) {
      prompt.textContent =
        'あなたの手番です — 切る牌を選んでください（喰い替え禁止牌は選択不可）';
    } else {
      prompt.textContent = 'あなたの手番です — 切る牌をタップしてください';
    }
  } else if (isMyTurn) {
    prompt.textContent = '待機中...';
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

  const selfActionsBar = renderSelfTurnActionsBar(
    view,
    player,
    handlers,
    uiState,
    canDiscardNow,
  );
  if (selfActionsBar) {
    controls.appendChild(selfActionsBar);
  }

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

  controls.appendChild(handArea);
  box.appendChild(controls);
  return box;
}

function buildScoreTable(
  players: PublicPlayerView[],
  initialPoints: number,
  ranked = false,
  roundScoreDeltas?: Record<string, number>,
  initialDealerIndex = 0,
): HTMLElement {
  const list = ranked ? rankPlayers(players, initialDealerIndex) : players;

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
  container.appendChild(panel);
}
