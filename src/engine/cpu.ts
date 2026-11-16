import type { Action } from '../types/message';
import type { CpuLevel, DerivedRules } from '../types/rule';
import type {
  CallOptions,
  CallResponseChoice,
  GameState,
  Meld,
  PlayerState,
} from '../types/state';
import { ALL_TILE_KINDS, type Tile, type TileKind } from '../types/tile';
import { getTenpaiWaitKinds } from './agari';
import { computeChiKuikaeKinds, getSelfTurnActions } from './calls';
import { getActiveDoraKinds, getRevealedDoraIndicators } from './dora';
import { getSeatWind } from './rules';
import { isTerminalOrHonorKind } from './yaku';

const KIND_TO_INDEX = new Map<TileKind, number>(
  ALL_TILE_KINDS.map((k, idx) => [k, idx]),
);

const KOKUSHI_INDICES: readonly number[] = [
  0, 8, // 1m, 9m
  9, 17, // 1p, 9p
  18, 26, // 1s, 9s
  27, 28, 29, 30, 31, 32, 33, // 1z..7z
];

function kindsToCounts(kinds: readonly TileKind[]): number[] {
  const counts = new Array<number>(ALL_TILE_KINDS.length).fill(0);
  for (const kind of kinds) {
    const idx = KIND_TO_INDEX.get(kind);
    if (idx !== undefined) {
      counts[idx] = counts[idx]! + 1;
    }
  }
  return counts;
}

function calculateStandardShanten(
  counts: number[],
  openMeldCount: number,
  totalClosedTiles: number,
): number {
  let best = 8 - 2 * openMeldCount;
  const maxMentsu = 4 - openMeldCount;

  function scanTaatsu(
    idx: number,
    mentsu: number,
    taatsu: number,
    hasPair: boolean,
    remTiles: number,
  ): void {
    const effTaatsu = Math.min(taatsu, maxMentsu - mentsu);
    const cur =
      8 - 2 * (openMeldCount + mentsu) - effTaatsu - (hasPair ? 1 : 0);
    if (cur < best) best = cur;

    if (mentsu + effTaatsu >= maxMentsu) return;

    const maxPossibleTaatsu = Math.min(
      maxMentsu - mentsu,
      effTaatsu + Math.floor(remTiles / 2),
    );
    const lowerBound =
      8 - 2 * (openMeldCount + mentsu) - maxPossibleTaatsu - (hasPair ? 1 : 0);
    if (lowerBound >= best) return;

    while (idx < 34 && counts[idx] === 0) idx++;
    if (idx >= 34) return;

    const c = counts[idx]!;

    if (c >= 2) {
      counts[idx] = c - 2;
      scanTaatsu(idx, mentsu, taatsu + 1, hasPair, remTiles - 2);
      counts[idx] = c;
    }
    if (idx < 27 && idx % 9 <= 7 && counts[idx + 1]! > 0) {
      counts[idx] = c - 1;
      counts[idx + 1]!--;
      scanTaatsu(idx, mentsu, taatsu + 1, hasPair, remTiles - 2);
      counts[idx] = c;
      counts[idx + 1]!++;
    }
    if (idx < 27 && idx % 9 <= 6 && counts[idx + 2]! > 0) {
      counts[idx] = c - 1;
      counts[idx + 2]!--;
      scanTaatsu(idx, mentsu, taatsu + 1, hasPair, remTiles - 2);
      counts[idx] = c;
      counts[idx + 2]!++;
    }

    scanTaatsu(idx + 1, mentsu, taatsu, hasPair, remTiles - c);
  }

  function scanMentsu(
    idx: number,
    mentsu: number,
    hasPair: boolean,
    remTiles: number,
  ): void {
    const maxAdditionalMentsu = Math.min(
      maxMentsu - mentsu,
      Math.floor(remTiles / 3),
    );
    const maxRemAfterMentsu = remTiles - maxAdditionalMentsu * 3;
    const optimisticTaatsu = Math.min(
      maxMentsu - mentsu - maxAdditionalMentsu,
      Math.floor(maxRemAfterMentsu / 2),
    );
    const lowerBound =
      8 -
      2 * (openMeldCount + mentsu + maxAdditionalMentsu) -
      optimisticTaatsu -
      (hasPair ? 1 : 0);
    if (lowerBound >= best) return;

    while (idx < 34 && counts[idx] === 0) idx++;
    if (idx >= 34) {
      let leftover = 0;
      for (let i = 0; i < 34; i++) leftover += counts[i]!;
      scanTaatsu(0, mentsu, 0, hasPair, leftover);
      return;
    }

    if (counts[idx]! >= 3) {
      counts[idx]! -= 3;
      scanMentsu(idx, mentsu + 1, hasPair, remTiles - 3);
      counts[idx]! += 3;
    }
    if (
      idx < 27 &&
      idx % 9 <= 6 &&
      counts[idx + 1]! > 0 &&
      counts[idx + 2]! > 0
    ) {
      counts[idx]!--;
      counts[idx + 1]!--;
      counts[idx + 2]!--;
      scanMentsu(idx, mentsu + 1, hasPair, remTiles - 3);
      counts[idx]!++;
      counts[idx + 1]!++;
      counts[idx + 2]!++;
    }
    scanMentsu(idx + 1, mentsu, hasPair, remTiles);
  }

  scanMentsu(0, 0, false, totalClosedTiles);
  for (let i = 0; i < 34; i++) {
    if (counts[i]! >= 2) {
      counts[i]! -= 2;
      scanMentsu(0, 0, true, totalClosedTiles - 2);
      counts[i]! += 2;
    }
  }

  return best;
}

function calculateChiitoitsuShanten(counts: readonly number[]): number {
  let pairs = 0;
  let distinct = 0;
  for (let i = 0; i < 34; i++) {
    const c = counts[i]!;
    if (c >= 1) distinct++;
    if (c >= 2) pairs++;
  }
  return 6 - pairs + Math.max(0, 7 - distinct);
}

function calculateKokushiShanten(counts: readonly number[]): number {
  let unique = 0;
  let hasPair = false;
  for (const idx of KOKUSHI_INDICES) {
    const c = counts[idx]!;
    if (c >= 1) unique++;
    if (c >= 2) hasPair = true;
  }
  return 13 - unique - (hasPair ? 1 : 0);
}

/**
 * 現在の手牌（13枚系でも14枚系でも可）と副露から向聴数を計算する。
 * -1: 和了形, 0: 聴牌, 1: 一向聴 ...
 */
export function calculateShanten(
  handKinds: readonly TileKind[],
  melds: readonly Meld[],
): number {
  const counts = kindsToCounts(handKinds);
  let best = calculateStandardShanten(counts, melds.length, handKinds.length);
  if (melds.length === 0) {
    best = Math.min(
      best,
      calculateChiitoitsuShanten(counts),
      calculateKokushiShanten(counts),
    );
  }
  return best;
}

/**
 * 視点プレイヤーから見える全ての牌の残枚数（見えていない山+他家手牌の残数）を返す
 */
function buildRemainingCounts(
  state: GameState,
  viewer: PlayerState,
  rules: DerivedRules,
): Map<TileKind, number> {
  const visible = new Map<TileKind, number>();
  const addTile = (kind: TileKind) => {
    visible.set(kind, (visible.get(kind) ?? 0) + 1);
  };

  for (const t of viewer.hand) addTile(t.kind);
  if (viewer.drawnTile) addTile(viewer.drawnTile.kind);

  for (const p of state.players) {
    for (const d of p.discards) addTile(d.tile.kind);
    for (const m of p.melds) {
      for (const t of m.tiles) addTile(t.kind);
    }
    for (const t of p.kitaTiles) addTile(t.kind);
  }

  if (state.round) {
    for (const ind of getRevealedDoraIndicators(state.round.deadWall)) {
      addTile(ind.kind);
    }
  }

  const remaining = new Map<TileKind, number>();
  for (const kind of rules.allowedTileKinds) {
    const used = visible.get(kind) ?? 0;
    remaining.set(kind, Math.max(0, rules.tileSet.copiesPerKind - used));
  }
  return remaining;
}

function getYakuhaiKinds(state: GameState, player: PlayerState, rules: DerivedRules): Set<TileKind> {
  const result = new Set<TileKind>(['5z', '6z', '7z']);
  const round = state.round;
  if (!round) return result;
  const windToKind: Record<string, TileKind> = {
    E: '1z',
    S: '2z',
    W: '3z',
    N: '4z',
  };
  const roundWindKind = windToKind[round.roundWind];
  const seatWindKind = windToKind[
    getSeatWind(player.seatIndex, round.dealerIndex, rules.seatWinds)
  ];
  if (roundWindKind) result.add(roundWindKind);
  if (seatWindKind) result.add(seatWindKind);
  return result;
}

function tileIsolationPriority(
  kind: TileKind,
  handCounts: Map<TileKind, number>,
  yakuhaiKinds: Set<TileKind>,
  doraKinds: Set<TileKind>,
): number {
  let score = 0;
  const count = handCounts.get(kind) ?? 0;

  // ドラは温存しやすい
  if (doraKinds.has(kind)) score -= 35;

  if (kind[1] === 'z') {
    if (yakuhaiKinds.has(kind)) {
      score += count >= 2 ? -28 : 8;
    } else {
      score += count >= 2 ? -10 : 28;
    }
    return score;
  }

  const rank = Number(kind[0]);
  const suit = kind[1]!;
  const hasPrev1 = (handCounts.get(`${rank - 1}${suit}` as TileKind) ?? 0) > 0;
  const hasNext1 = (handCounts.get(`${rank + 1}${suit}` as TileKind) ?? 0) > 0;
  const hasPrev2 = (handCounts.get(`${rank - 2}${suit}` as TileKind) ?? 0) > 0;
  const hasNext2 = (handCounts.get(`${rank + 2}${suit}` as TileKind) ?? 0) > 0;

  if (count >= 2) score -= 18;
  if (hasPrev1) score -= 14;
  if (hasNext1) score -= 14;
  if (hasPrev2) score -= 7;
  if (hasNext2) score -= 7;

  // 中張牌は孤立していても伸びやすいので切りにくくする
  if (rank === 1 || rank === 9) score += 16;
  else if (rank === 2 || rank === 8) score += 8;
  else if (rank >= 3 && rank <= 7) score -= 6;

  return score;
}

interface DiscardCandidateEval {
  tile: Tile;
  nextShanten: number;
  ukeire: number;
  waitKinds: TileKind[];
  isFuritenWait: boolean;
  safetyScore: number;
  isolationScore: number;
  score: number;
}

function getGenbutsuKindsForPlayer(opponent: PlayerState): Set<TileKind> {
  const safe = new Set<TileKind>();
  for (const d of opponent.discards) {
    safe.add(d.tile.kind);
  }
  return safe;
}

function estimateDangerAgainstRiichi(
  kind: TileKind,
  riichiPlayers: readonly PlayerState[],
  remainingCounts: Map<TileKind, number>,
): number {
  if (riichiPlayers.length === 0) return 0;

  let allGenbutsu = true;
  let someGenbutsu = false;
  for (const rp of riichiPlayers) {
    const genbutsu = getGenbutsuKindsForPlayer(rp);
    if (genbutsu.has(kind)) {
      someGenbutsu = true;
    } else {
      allGenbutsu = false;
    }
  }

  if (allGenbutsu) return 1000;
  if (someGenbutsu) return 200;

  const rem = remainingCounts.get(kind) ?? 0;
  // 自分の手や場から全部見えている字牌・1・9は安全度が高い
  if (kind[1] === 'z') {
    if (rem === 0) return 850;
    if (rem === 1) return 420;
    return 180;
  }
  const rank = Number(kind[0]);
  if (rank === 1 || rank === 9) {
    return rem <= 1 ? 240 : 110;
  }
  if (rank === 2 || rank === 8) return 50;
  return 0;
}

function evaluateDiscardCandidates(
  state: GameState,
  player: PlayerState,
  legalTiles: readonly Tile[],
  rules: DerivedRules,
  cpuLevel: CpuLevel,
): DiscardCandidateEval[] {
  const round = state.round!;
  const allTiles = player.drawnTile
    ? [...player.hand, player.drawnTile]
    : [...player.hand];
  const remainingCounts = buildRemainingCounts(state, player, rules);
  const doraKinds = new Set<TileKind>(
    getActiveDoraKinds(getRevealedDoraIndicators(round.deadWall), rules),
  );
  if (rules.allowKita) doraKinds.add('4z');
  const yakuhaiKinds = getYakuhaiKinds(state, player, rules);
  const discardedSet = new Set(player.discardedKinds);

  const otherRiichiPlayers = state.players.filter(
    (p) => p.playerId !== player.playerId && p.isRiichi,
  );
  const hasThreatRiichi = otherRiichiPlayers.length > 0;
  const minHandShanten = calculateShanten(
    allTiles.map((t) => t.kind),
    player.melds,
  );

  // Deduplicate evaluation by TileKind
  const evalByKind = new Map<TileKind, Omit<DiscardCandidateEval, 'tile'>>();
  const evals: DiscardCandidateEval[] = [];

  for (const tile of legalTiles) {
    const cached = evalByKind.get(tile.kind);
    if (cached) {
      evals.push({ tile, ...cached });
      continue;
    }

    const idx = allTiles.findIndex((t) => t.id === tile.id);
    const remainingHand = allTiles.filter((_, i) => i !== idx);
    const remainingKinds = remainingHand.map((t) => t.kind);

    let nextShanten = calculateShanten(remainingKinds, player.melds);
    let waitKinds: TileKind[] = [];
    let ukeire = 0;

    if (nextShanten <= 0) {
      waitKinds = getTenpaiWaitKinds(remainingHand, player.melds, rules);
      if (waitKinds.length === 0) {
        // 空聴（4枚持ち等）の場合は実質1向聴以下に扱う
        nextShanten = 1;
      } else {
        for (const w of waitKinds) {
          ukeire += remainingCounts.get(w) ?? 0;
        }
      }
    } else if (cpuLevel === 'normal') {
      // 1向聴・2向聴では受け入れ枚数を計算
      if (nextShanten <= 2) {
        for (const drawKind of rules.allowedTileKinds) {
          const rem = remainingCounts.get(drawKind) ?? 0;
          if (rem <= 0) continue;
          const afterDrawShanten = calculateShanten(
            [...remainingKinds, drawKind],
            player.melds,
          );
          if (afterDrawShanten < nextShanten) {
            ukeire += rem;
          }
        }
      }
    }

    const isFuritenWait =
      waitKinds.length > 0 && waitKinds.some((w) => discardedSet.has(w));
    const handCounts = new Map<TileKind, number>();
    for (const k of remainingKinds) {
      handCounts.set(k, (handCounts.get(k) ?? 0) + 1);
    }

    const isolationScore = tileIsolationPriority(
      tile.kind,
      handCounts,
      yakuhaiKinds,
      doraKinds,
    );
    const safetyScore = estimateDangerAgainstRiichi(
      tile.kind,
      otherRiichiPlayers,
      remainingCounts,
    );

    // 総合評価スコア（高いほど切りたい牌）
    let score = -nextShanten * 10000 + ukeire * 80 + isolationScore;
    if (isFuritenWait && nextShanten === 0) {
      score -= 600;
    }

    if (cpuLevel === 'normal' && hasThreatRiichi) {
      if (nextShanten >= 2 || (minHandShanten >= 1 && round.wall.length < 30)) {
        // ベタオリ・回し打ち寄り
        score = safetyScore * 15 - nextShanten * 300 + isolationScore;
      } else if (nextShanten === 1) {
        score += safetyScore * 2.5;
      } else if (nextShanten === 0 && ukeire <= 2) {
        score += safetyScore * 3;
      }
    }

    const result = {
      nextShanten,
      ukeire,
      waitKinds,
      isFuritenWait,
      safetyScore,
      isolationScore,
      score,
    };
    evalByKind.set(tile.kind, result);
    evals.push({ tile, ...result });
  }

  evals.sort((a, b) => b.score - a.score);
  return evals;
}

/**
 * CPUの手番行動を決定する（純粋関数）
 */
export function decideCpuTurnAction(
  state: GameState,
  cpuPlayer: PlayerState,
  rules: DerivedRules,
): Action {
  const round = state.round!;
  const cpuLevel: CpuLevel = cpuPlayer.cpuLevel ?? rules.cpuLevel;
  const actions = getSelfTurnActions(cpuPlayer, round, rules);

  // 1. ツモ和了できるなら即和了
  if (actions.canTsumo) {
    return {
      type: 'DECLARE_TSUMO',
      playerId: cpuPlayer.playerId,
    };
  }

  // 2. 九種九牌（標準CPUは4向聴以上のとき流局を選ぶ）
  if (actions.canKyuushuKyuuhai && cpuLevel === 'normal') {
    const allKinds = [
      ...cpuPlayer.hand,
      ...(cpuPlayer.drawnTile ? [cpuPlayer.drawnTile] : []),
    ].map((t) => t.kind);
    if (calculateShanten(allKinds, []) >= 4) {
      return {
        type: 'DECLARE_KYUUSHU_KYUUHAI',
        playerId: cpuPlayer.playerId,
      };
    }
  }

  // 3. 三麻の北抜き（基本的に抜いてドラを増やす）
  if (actions.canKitaTileIds.length > 0) {
    return {
      type: 'DECLARE_KITA',
      playerId: cpuPlayer.playerId,
      tileId: actions.canKitaTileIds[0]!,
    };
  }

  // 4. リーチ宣言
  if (actions.canRiichiTileIds.length > 0) {
    const allowedSet = new Set(actions.canRiichiTileIds);
    const legalCandidates = [
      ...cpuPlayer.hand,
      ...(cpuPlayer.drawnTile ? [cpuPlayer.drawnTile] : []),
    ].filter((t) => allowedSet.has(t.id));

    if (legalCandidates.length > 0) {
      const evaluated = evaluateDiscardCandidates(
        state,
        cpuPlayer,
        legalCandidates,
        rules,
        'normal',
      ).filter((e) => e.nextShanten === 0 && e.waitKinds.length > 0);

      const best = evaluated[0];
      if (best) {
        const shouldRiichi =
          cpuLevel === 'normal'
            ? !best.isFuritenWait || best.ukeire >= 4
            : !best.isFuritenWait && best.ukeire >= 4;

        if (shouldRiichi) {
          return {
            type: 'DECLARE_RIICHI',
            playerId: cpuPlayer.playerId,
            tileId: best.tile.id,
          };
        }
      }
    }
  }

  // 5. 暗槓・加槓（標準CPUのみ、他家リーチがない時またはリーチ中の安全暗槓）
  if (cpuLevel === 'normal') {
    const anyOtherRiichi = state.players.some(
      (p) => p.playerId !== cpuPlayer.playerId && p.isRiichi,
    );
    if (actions.canAnkanKinds.length > 0 && (cpuPlayer.isRiichi || !anyOtherRiichi)) {
      const targetKind = actions.canAnkanKinds[0]!;
      if (cpuPlayer.isRiichi) {
        return {
          type: 'DECLARE_ANKAN',
          playerId: cpuPlayer.playerId,
          kind: targetKind,
        };
      }
      const allTiles = [
        ...cpuPlayer.hand,
        ...(cpuPlayer.drawnTile ? [cpuPlayer.drawnTile] : []),
      ];
      const beforeShanten = calculateShanten(
        allTiles.map((t) => t.kind),
        cpuPlayer.melds,
      );
      const nextHandKinds = allTiles
        .filter((t) => t.kind !== targetKind)
        .map((t) => t.kind);
      const ankanMeld: Meld = {
        type: 'ankan',
        tiles: allTiles.filter((t) => t.kind === targetKind),
        calledTile: null,
        fromSeatIndex: null,
        addedTile: null,
      };
      const afterShanten = calculateShanten(nextHandKinds, [
        ...cpuPlayer.melds,
        ankanMeld,
      ]);
      if (afterShanten <= beforeShanten) {
        return {
          type: 'DECLARE_ANKAN',
          playerId: cpuPlayer.playerId,
          kind: targetKind,
        };
      }
    }

    if (
      actions.canKakanTileIds.length > 0 &&
      !anyOtherRiichi &&
      !cpuPlayer.isRiichi
    ) {
      const kakanTileId = actions.canKakanTileIds[0]!;
      const allTiles = [
        ...cpuPlayer.hand,
        ...(cpuPlayer.drawnTile ? [cpuPlayer.drawnTile] : []),
      ];
      const kakanTile = allTiles.find((t) => t.id === kakanTileId);
      if (kakanTile) {
        const remainingKinds = allTiles
          .filter((t) => t.id !== kakanTileId)
          .map((t) => t.kind);
        if (calculateShanten(remainingKinds, [...cpuPlayer.melds]) <= 1) {
          return {
            type: 'DECLARE_KAKAN',
            playerId: cpuPlayer.playerId,
            tileId: kakanTileId,
          };
        }
      }
    }
  }

  // 6. 打牌選択
  if (cpuPlayer.isRiichi && cpuPlayer.drawnTile) {
    return {
      type: 'DISCARD_TILE',
      playerId: cpuPlayer.playerId,
      tileId: cpuPlayer.drawnTile.id,
    };
  }

  const allPool = [
    ...cpuPlayer.hand,
    ...(cpuPlayer.drawnTile ? [cpuPlayer.drawnTile] : []),
  ];
  const forbiddenKinds = rules.forbidKuikae
    ? new Set(round.kuikaeForbiddenKinds)
    : new Set<TileKind>();
  const legalTiles = allPool.filter((t) => !forbiddenKinds.has(t.kind));
  const candidates = legalTiles.length > 0 ? legalTiles : allPool;

  const evaluated = evaluateDiscardCandidates(
    state,
    cpuPlayer,
    candidates,
    rules,
    cpuLevel,
  );

  let chosen = evaluated[0]!.tile;

  if (cpuLevel === 'easy' && evaluated.length >= 2) {
    // やさしめCPU: 聴牌に取れる時は素直に取るが、それ以外は2〜3番手候補も混ぜて緩めに打つ
    if (evaluated[0]!.nextShanten > 0) {
      const distinctKinds: DiscardCandidateEval[] = [];
      const seen = new Set<TileKind>();
      for (const item of evaluated) {
        if (!seen.has(item.tile.kind)) {
          seen.add(item.tile.kind);
          distinctKinds.push(item);
        }
      }
      if (distinctKinds.length >= 2) {
        const pickIdx =
          (round.turnCount + cpuPlayer.seatIndex) % 3 === 0
            ? Math.min(2, distinctKinds.length - 1)
            : (round.turnCount + cpuPlayer.seatIndex) % 2;
        chosen = distinctKinds[pickIdx]!.tile;
      }
    }
  }

  return {
    type: 'DISCARD_TILE',
    playerId: cpuPlayer.playerId,
    tileId: chosen.id,
  };
}

function isSimpleTanyaoKind(kind: TileKind): boolean {
  return !isTerminalOrHonorKind(kind);
}

function hasGuaranteedOpenYaku(
  remainingHand: readonly Tile[],
  nextMelds: readonly Meld[],
  state: GameState,
  player: PlayerState,
  rules: DerivedRules,
): boolean {
  const yakuhaiKinds = getYakuhaiKinds(state, player, rules);
  for (const m of nextMelds) {
    if (
      (m.type === 'pon' ||
        m.type === 'ankan' ||
        m.type === 'daiminkan' ||
        m.type === 'kakan') &&
      m.tiles[0] &&
      yakuhaiKinds.has(m.tiles[0].kind)
    ) {
      return true;
    }
  }

  const allKinds = [
    ...remainingHand.map((t) => t.kind),
    ...nextMelds.flatMap((m) => m.tiles.map((t) => t.kind)),
  ];

  // 喰いタン可で全牌が中張牌ならタンヤオ確定
  if (rules.allowKuitan && allKinds.every(isSimpleTanyaoKind)) {
    return true;
  }

  // 混一色・清一色狙い（数牌が1色のみ）
  const suits = new Set(
    allKinds.filter((k) => k[1] !== 'z').map((k) => k[1]!),
  );
  if (suits.size <= 1) {
    return true;
  }

  return false;
}

/**
 * 鳴き・ロン応答の判断を行う（純粋関数）
 */
export function decideCpuCallResponse(
  state: GameState,
  cpuPlayer: PlayerState,
  options: CallOptions,
  rules: DerivedRules,
): CallResponseChoice {
  // 1. ロンは難易度に関わらず最優先で和了する
  if (options.canRon) {
    return { type: 'ron' };
  }

  const cpuLevel: CpuLevel = cpuPlayer.cpuLevel ?? rules.cpuLevel;
  if (cpuLevel === 'easy') {
    return { type: 'pass' };
  }

  const round = state.round;
  if (!round || cpuPlayer.isRiichi) {
    return { type: 'pass' };
  }

  const curShanten = calculateShanten(
    cpuPlayer.hand.map((t) => t.kind),
    cpuPlayer.melds,
  );
  const anyOtherRiichi = state.players.some(
    (p) => p.playerId !== cpuPlayer.playerId && p.isRiichi,
  );

  // 他家リーチ中に2向聴以上からわざわざ鳴かない
  if (anyOtherRiichi && curShanten >= 2) {
    return { type: 'pass' };
  }

  // 2. ポン判定
  if (options.canPon) {
    const calledTile = options.discardedTile;
    const matching = cpuPlayer.hand.filter((t) => t.kind === calledTile.kind);
    if (matching.length >= 2) {
      const pairIds = new Set([matching[0]!.id, matching[1]!.id]);
      const remaining = cpuPlayer.hand.filter((t) => !pairIds.has(t.id));
      const forbidden = rules.forbidKuikae
        ? new Set<TileKind>([calledTile.kind])
        : new Set<TileKind>();
      const discardable = remaining.filter((t) => !forbidden.has(t.kind));

      if (discardable.length > 0) {
        const nextMelds: Meld[] = [
          ...cpuPlayer.melds,
          {
            type: 'pon',
            tiles: [matching[0]!, matching[1]!, calledTile],
            calledTile,
            fromSeatIndex: options.discarderSeatIndex,
            addedTile: null,
          },
        ];

        const bestAfterPon = Math.min(
          ...discardable.map((d) =>
            calculateShanten(
              remaining.filter((t) => t.id !== d.id).map((t) => t.kind),
              nextMelds,
            ),
          ),
        );

        const yakuhai = getYakuhaiKinds(state, cpuPlayer, rules).has(
          calledTile.kind,
        );
        const yakuSafe =
          yakuhai ||
          hasGuaranteedOpenYaku(remaining, nextMelds, state, cpuPlayer, rules);

        if (bestAfterPon < curShanten && yakuSafe) {
          return { type: 'pon', tileIds: [matching[0]!.id, matching[1]!.id] };
        }
        // 役牌ポンで向聴数が悪化しないなら基本鳴く
        if (yakuhai && bestAfterPon <= curShanten) {
          return { type: 'pon', tileIds: [matching[0]!.id, matching[1]!.id] };
        }
      }
    }
  }

  // 3. チー判定（4人麻雀のみ、役が確保でき向聴数が進む場合）
  if (options.chiOptions.length > 0 && (!anyOtherRiichi || curShanten <= 1)) {
    let bestChi: {
      tileIds: [string, string];
      shanten: number;
    } | null = null;

    for (const chiOpt of options.chiOptions) {
      const [t1, t2] = chiOpt.tiles;
      const usedIds = new Set([t1.id, t2.id]);
      const remaining = cpuPlayer.hand.filter((t) => !usedIds.has(t.id));
      const forbidden = rules.forbidKuikae
        ? new Set(
            computeChiKuikaeKinds(
              options.discardedTile.kind,
              t1.kind,
              t2.kind,
            ),
          )
        : new Set<TileKind>();
      const discardable = remaining.filter((t) => !forbidden.has(t.kind));
      if (discardable.length === 0) continue;

      const nextMelds: Meld[] = [
        ...cpuPlayer.melds,
        {
          type: 'chi',
          tiles: [t1, t2, options.discardedTile],
          calledTile: options.discardedTile,
          fromSeatIndex: options.discarderSeatIndex,
          addedTile: null,
        },
      ];

      for (const d of discardable) {
        const afterHand = remaining.filter((t) => t.id !== d.id);
        const sh = calculateShanten(
          afterHand.map((t) => t.kind),
          nextMelds,
        );
        if (
          sh < curShanten &&
          hasGuaranteedOpenYaku(afterHand, nextMelds, state, cpuPlayer, rules)
        ) {
          if (!bestChi || sh < bestChi.shanten) {
            bestChi = { tileIds: [t1.id, t2.id], shanten: sh };
          }
        }
      }
    }

    if (bestChi) {
      return { type: 'chi', tileIds: bestChi.tileIds };
    }
  }

  return { type: 'pass' };
}
