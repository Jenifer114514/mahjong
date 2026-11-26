import type { PeerOptions } from 'peerjs';
import type {
  ChangeHistoryCategory,
  ChangeHistoryEntry,
  ChangeHistoryKind,
  ChatMessage,
  CheckpointKeyPayload,
  ClientMessage,
  GameError,
  HostCheckpointPayload,
  HostMessage,
  HostMigratingPayload,
  HostRedirectPayload,
  HostSnapshotPayload,
  RoomOccupancyPlayer,
  RoomStatusPayload,
  SecretLuckMode,
  SessionWelcomePayload,
  StateView,
} from '../types/message';
import type { GamePhase } from '../types/state';
import type { CallResponseChoice } from '../types/state';
import { ALL_TILE_KINDS, type TileKind } from '../types/tile';

export const PEER_ID_PREFIX = 'arena-mj-';
const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ROOM_CODE_LENGTH = 6;
const VALID_TILE_KINDS = new Set<string>(ALL_TILE_KINDS);

export interface TurnEnv {
  VITE_TURN_URL?: string;
  VITE_TURN_USERNAME?: string;
  VITE_TURN_CREDENTIAL?: string;
}

const DEFAULT_STUN_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

export function readDefaultTurnEnv(): TurnEnv {
  const hasMetaEnv = typeof import.meta !== 'undefined' && Boolean(import.meta.env);
  if (!hasMetaEnv) return {};
  const url = import.meta.env.VITE_TURN_URL;
  const username = import.meta.env.VITE_TURN_USERNAME;
  const credential = import.meta.env.VITE_TURN_CREDENTIAL;
  return {
    VITE_TURN_URL: typeof url === 'string' ? url : undefined,
    VITE_TURN_USERNAME: typeof username === 'string' ? username : undefined,
    VITE_TURN_CREDENTIAL: typeof credential === 'string' ? credential : undefined,
  };
}

function parseTurnUrls(rawUrl: string | undefined): string[] {
  if (!rawUrl) return [];
  return rawUrl
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function hasTurnConfig(env: TurnEnv = readDefaultTurnEnv()): boolean {
  return parseTurnUrls(env.VITE_TURN_URL).length > 0;
}

export function buildPeerOptions(env: TurnEnv = readDefaultTurnEnv()): PeerOptions {
  const iceServers: RTCIceServer[] = [...DEFAULT_STUN_SERVERS];
  const turnUrls = parseTurnUrls(env.VITE_TURN_URL);
  if (turnUrls.length > 0) {
    const turnEntry: RTCIceServer = {
      urls: turnUrls.length === 1 ? turnUrls[0]! : turnUrls,
    };
    const username = env.VITE_TURN_USERNAME?.trim();
    const credential = env.VITE_TURN_CREDENTIAL?.trim();
    if (username) {
      turnEntry.username = username;
    }
    if (credential) {
      turnEntry.credential = credential;
    }
    iceServers.push(turnEntry);
  }
  return {
    debug: 1,
    config: {
      iceServers,
    },
  };
}

export const PEER_OPTIONS: PeerOptions = buildPeerOptions();

export function generateRoomCode(): string {
  const chars: string[] = [];
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const buf = new Uint32Array(ROOM_CODE_LENGTH);
    crypto.getRandomValues(buf);
    for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
      const idx = buf[i]! % ROOM_CODE_ALPHABET.length;
      chars.push(ROOM_CODE_ALPHABET[idx]!);
    }
  } else {
    for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
      const idx = Math.floor(Math.random() * ROOM_CODE_ALPHABET.length);
      chars.push(ROOM_CODE_ALPHABET[idx]!);
    }
  }
  return chars.join('');
}

export function normalizeRoomCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function roomCodeToPeerId(roomCode: string): string {
  return `${PEER_ID_PREFIX}${normalizeRoomCode(roomCode)}`;
}

export function migratedHostPeerId(roomCode: string, epoch: number): string {
  const base = roomCodeToPeerId(roomCode);
  return epoch <= 0 ? base : `${base}-H${epoch}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function parseTileIdPair(value: unknown): [string, string] | null {
  if (!Array.isArray(value) || value.length !== 2) {
    return null;
  }
  if (!isNonEmptyString(value[0]) || !isNonEmptyString(value[1])) {
    return null;
  }
  return [value[0], value[1]];
}

function parseCallResponseChoice(raw: unknown): CallResponseChoice | null {
  if (!isRecord(raw) || typeof raw.type !== 'string') {
    return null;
  }
  switch (raw.type) {
    case 'pass':
      return { type: 'pass' };
    case 'ron':
      return { type: 'ron' };
    case 'daiminkan':
      return { type: 'daiminkan' };
    case 'pon': {
      if (raw.tileIds === undefined) {
        return { type: 'pon' };
      }
      const pair = parseTileIdPair(raw.tileIds);
      if (!pair) return null;
      return { type: 'pon', tileIds: pair };
    }
    case 'chi': {
      const pair = parseTileIdPair(raw.tileIds);
      if (!pair) return null;
      return { type: 'chi', tileIds: pair };
    }
    default:
      return null;
  }
}

export function parseClientMessage(raw: unknown): ClientMessage | null {
  if (!isRecord(raw) || typeof raw.kind !== 'string') {
    return null;
  }

  if (raw.kind === 'PROBE_ROOM') {
    return { kind: 'PROBE_ROOM' };
  }

  if (raw.kind === 'JOIN') {
    if (typeof raw.playerName !== 'string') {
      return null;
    }
    const msg: ClientMessage = {
      kind: 'JOIN',
      playerName: raw.playerName,
    };
    if (isNonEmptyString(raw.reconnectToken)) {
      msg.reconnectToken = raw.reconnectToken;
    }
    if (raw.preferSpectate === true) {
      msg.preferSpectate = true;
    }
    return msg;
  }

  if (raw.kind === 'CHECKPOINT_KEY_SHARE') {
    if (
      typeof raw.hostEpoch !== 'number' ||
      !Number.isFinite(raw.hostEpoch) ||
      typeof raw.seq !== 'number' ||
      !Number.isFinite(raw.seq) ||
      !isNonEmptyString(raw.keyBase64)
    ) {
      return null;
    }
    return {
      kind: 'CHECKPOINT_KEY_SHARE',
      hostEpoch: raw.hostEpoch,
      seq: raw.seq,
      keyBase64: raw.keyBase64,
    };
  }

  if (raw.kind === 'CHAT') {
    if (typeof raw.text !== 'string') {
      return null;
    }
    const trimmed = raw.text.trim();
    if (trimmed.length === 0 || trimmed.length > 200) {
      return null;
    }
    return {
      kind: 'CHAT',
      text: trimmed,
    };
  }

  if (raw.kind === 'SECRET_OPTION') {
    const out: Extract<ClientMessage, { kind: 'SECRET_OPTION' }> = {
      kind: 'SECRET_OPTION',
    };
    let hasField = false;
    if (raw.peek !== undefined) {
      if (typeof raw.peek !== 'boolean') {
        return null;
      }
      out.peek = raw.peek;
      hasField = true;
    }
    if (raw.luck !== undefined) {
      if (raw.luck !== 'normal' && raw.luck !== 'good' && raw.luck !== 'god') {
        return null;
      }
      out.luck = raw.luck;
      hasField = true;
    }
    if (raw.luckTargetPlayerId !== undefined) {
      if (
        !isNonEmptyString(raw.luckTargetPlayerId) ||
        raw.luckTargetPlayerId.length > 64
      ) {
        return null;
      }
      out.luckTargetPlayerId = raw.luckTargetPlayerId;
      hasField = true;
    }
    if (raw.clearAllLuck !== undefined) {
      if (typeof raw.clearAllLuck !== 'boolean') {
        return null;
      }
      out.clearAllLuck = raw.clearAllLuck;
      hasField = true;
    }
    if (raw.clearAllCheat !== undefined) {
      if (typeof raw.clearAllCheat !== 'boolean') {
        return null;
      }
      out.clearAllCheat = raw.clearAllCheat;
      hasField = true;
    }
    if (raw.requestSync !== undefined) {
      if (typeof raw.requestSync !== 'boolean') {
        return null;
      }
      out.requestSync = raw.requestSync;
      hasField = true;
    }
    if (out.luckTargetPlayerId !== undefined && out.luck === undefined) {
      return null;
    }
    return hasField ? out : null;
  }

  if (raw.kind === 'REQUEST_CHANGE_HISTORY') {
    if (raw.watch !== undefined && typeof raw.watch !== 'boolean') {
      return null;
    }
    return raw.watch === undefined
      ? { kind: 'REQUEST_CHANGE_HISTORY' }
      : { kind: 'REQUEST_CHANGE_HISTORY', watch: raw.watch };
  }

  if (raw.kind === 'ACTION') {
    if (!isRecord(raw.action) || typeof raw.action.type !== 'string') {
      return null;
    }

    switch (raw.action.type) {
      case 'DISCARD_TILE': {
        if (!isNonEmptyString(raw.action.tileId)) {
          return null;
        }
        return {
          kind: 'ACTION',
          action: {
            type: 'DISCARD_TILE',
            tileId: raw.action.tileId,
          },
        };
      }
      case 'CALL_RESPONSE': {
        const choice = parseCallResponseChoice(raw.action.choice);
        if (!choice) {
          return null;
        }
        return {
          kind: 'ACTION',
          action: {
            type: 'CALL_RESPONSE',
            choice,
          },
        };
      }
      case 'DECLARE_TSUMO': {
        return {
          kind: 'ACTION',
          action: {
            type: 'DECLARE_TSUMO',
          },
        };
      }
      case 'DECLARE_RIICHI': {
        if (!isNonEmptyString(raw.action.tileId)) {
          return null;
        }
        return {
          kind: 'ACTION',
          action: {
            type: 'DECLARE_RIICHI',
            tileId: raw.action.tileId,
          },
        };
      }
      case 'DECLARE_ANKAN': {
        if (
          typeof raw.action.kind !== 'string' ||
          !VALID_TILE_KINDS.has(raw.action.kind)
        ) {
          return null;
        }
        return {
          kind: 'ACTION',
          action: {
            type: 'DECLARE_ANKAN',
            kind: raw.action.kind as TileKind,
          },
        };
      }
      case 'DECLARE_KAKAN': {
        if (!isNonEmptyString(raw.action.tileId)) {
          return null;
        }
        return {
          kind: 'ACTION',
          action: {
            type: 'DECLARE_KAKAN',
            tileId: raw.action.tileId,
          },
        };
      }
      case 'DECLARE_KITA': {
        if (!isNonEmptyString(raw.action.tileId)) {
          return null;
        }
        return {
          kind: 'ACTION',
          action: {
            type: 'DECLARE_KITA',
            tileId: raw.action.tileId,
          },
        };
      }
      case 'DECLARE_KYUUSHU_KYUUHAI': {
        return {
          kind: 'ACTION',
          action: {
            type: 'DECLARE_KYUUSHU_KYUUHAI',
          },
        };
      }
      case 'ADVANCE_ROUND': {
        return {
          kind: 'ACTION',
          action: {
            type: 'ADVANCE_ROUND',
          },
        };
      }
      default:
        return null;
    }
  }

  return null;
}

function parseChatMessage(raw: unknown): ChatMessage | null {
  if (!isRecord(raw)) return null;
  if (
    !isNonEmptyString(raw.id) ||
    !isNonEmptyString(raw.senderId) ||
    typeof raw.senderName !== 'string' ||
    !isNonEmptyString(raw.text) ||
    typeof raw.timestamp !== 'number' ||
    !Number.isFinite(raw.timestamp)
  ) {
    return null;
  }
  return {
    id: raw.id,
    senderId: raw.senderId,
    senderName: raw.senderName,
    text: raw.text,
    timestamp: raw.timestamp,
  };
}

export function parseHostMessage(raw: unknown): HostMessage | null {
  if (!isRecord(raw) || typeof raw.kind !== 'string') {
    return null;
  }

  if (raw.kind === 'STATE_VIEW') {
    if (!isRecord(raw.payload)) {
      return null;
    }
    const p = raw.payload;
    if (
      typeof p.roomCode !== 'string' ||
      typeof p.hostPlayerId !== 'string' ||
      typeof p.viewerPlayerId !== 'string' ||
      typeof p.viewerSeatIndex !== 'number' ||
      !isRecord(p.ruleConfig) ||
      typeof p.phase !== 'string' ||
      !Array.isArray(p.players) ||
      !Array.isArray(p.myHand)
    ) {
      return null;
    }
    return {
      kind: 'STATE_VIEW',
      payload: raw.payload as unknown as StateView,
    };
  }

  if (raw.kind === 'CHAT_MESSAGE') {
    const chat = parseChatMessage(raw.payload);
    if (!chat) return null;
    return {
      kind: 'CHAT_MESSAGE',
      payload: chat,
    };
  }

  if (raw.kind === 'CHAT_HISTORY') {
    if (!Array.isArray(raw.payload)) return null;
    const list: ChatMessage[] = [];
    for (const item of raw.payload) {
      const parsed = parseChatMessage(item);
      if (!parsed) return null;
      list.push(parsed);
    }
    return {
      kind: 'CHAT_HISTORY',
      payload: list,
    };
  }

  if (raw.kind === 'SESSION_WELCOME') {
    if (!isRecord(raw.payload)) return null;
    const w = raw.payload;
    if (
      !isNonEmptyString(w.roomCode) ||
      !isNonEmptyString(w.playerId) ||
      typeof w.playerName !== 'string' ||
      !isNonEmptyString(w.reconnectToken) ||
      typeof w.isSpectator !== 'boolean' ||
      typeof w.hostEpoch !== 'number' ||
      !Number.isFinite(w.hostEpoch) ||
      !isNonEmptyString(w.hostPeerId)
    ) {
      return null;
    }
    return {
      kind: 'SESSION_WELCOME',
      payload: raw.payload as unknown as SessionWelcomePayload,
    };
  }

  if (raw.kind === 'HOST_HANDOVER') {
    if (!isRecord(raw.payload)) return null;
    const h = raw.payload;
    if (
      !isRecord(h.state) ||
      !Array.isArray(h.chatMessages) ||
      typeof h.chatSeq !== 'number' ||
      !isRecord(h.playerTokens) ||
      !isRecord(h.spectatorTokens) ||
      typeof h.hostEpoch !== 'number' ||
      typeof h.permanentRoom !== 'boolean'
    ) {
      return null;
    }
    return {
      kind: 'HOST_HANDOVER',
      payload: raw.payload as unknown as HostSnapshotPayload,
    };
  }

  if (raw.kind === 'HOST_CHECKPOINT') {
    if (!isRecord(raw.payload)) return null;
    const c = raw.payload;
    if (
      typeof c.hostEpoch !== 'number' ||
      typeof c.seq !== 'number' ||
      !isNonEmptyString(c.backupPlayerId) ||
      !isNonEmptyString(c.ivBase64) ||
      !isNonEmptyString(c.ciphertextBase64) ||
      (c.inlineKeyBase64 !== undefined && !isNonEmptyString(c.inlineKeyBase64))
    ) {
      return null;
    }
    return {
      kind: 'HOST_CHECKPOINT',
      payload: raw.payload as unknown as HostCheckpointPayload,
    };
  }

  if (raw.kind === 'CHECKPOINT_KEY') {
    if (!isRecord(raw.payload)) return null;
    const k = raw.payload;
    if (
      typeof k.hostEpoch !== 'number' ||
      typeof k.seq !== 'number' ||
      !isNonEmptyString(k.keyBase64)
    ) {
      return null;
    }
    return {
      kind: 'CHECKPOINT_KEY',
      payload: raw.payload as unknown as CheckpointKeyPayload,
    };
  }

  if (raw.kind === 'HOST_MIGRATING') {
    if (!isRecord(raw.payload)) return null;
    const m = raw.payload;
    if (
      !isNonEmptyString(m.roomCode) ||
      !isNonEmptyString(m.newHostPlayerId) ||
      !isNonEmptyString(m.newHostPeerId) ||
      typeof m.hostEpoch !== 'number'
    ) {
      return null;
    }
    return {
      kind: 'HOST_MIGRATING',
      payload: raw.payload as unknown as HostMigratingPayload,
    };
  }

  if (raw.kind === 'HOST_REDIRECT') {
    if (!isRecord(raw.payload)) return null;
    const r = raw.payload;
    if (
      !isNonEmptyString(r.roomCode) ||
      !isNonEmptyString(r.hostPeerId) ||
      typeof r.hostEpoch !== 'number'
    ) {
      return null;
    }
    return {
      kind: 'HOST_REDIRECT',
      payload: raw.payload as unknown as HostRedirectPayload,
    };
  }

  if (raw.kind === 'HOST_STATUS') {
    if (!isRecord(raw.payload) || typeof raw.payload.away !== 'boolean') {
      return null;
    }
    return {
      kind: 'HOST_STATUS',
      payload: { away: raw.payload.away },
    };
  }

  if (raw.kind === 'ROOM_STATUS') {
    if (!isRecord(raw.payload)) return null;
    const rs = raw.payload;
    const validPhases: readonly GamePhase[] = [
      'lobby',
      'playing',
      'awaiting_responses',
      'round_end',
      'finished',
    ];
    if (
      !isNonEmptyString(rs.roomCode) ||
      typeof rs.phase !== 'string' ||
      !validPhases.includes(rs.phase as GamePhase) ||
      typeof rs.maxPlayers !== 'number' ||
      !Number.isFinite(rs.maxPlayers) ||
      !Array.isArray(rs.players) ||
      !Array.isArray(rs.spectatorNames)
    ) {
      return null;
    }
    const players: RoomOccupancyPlayer[] = [];
    for (const item of rs.players) {
      if (
        !isRecord(item) ||
        typeof item.name !== 'string' ||
        typeof item.isCpu !== 'boolean' ||
        typeof item.connected !== 'boolean' ||
        typeof item.isHost !== 'boolean'
      ) {
        return null;
      }
      players.push({
        name: item.name,
        isCpu: item.isCpu,
        connected: item.connected,
        isHost: item.isHost,
      });
    }
    const spectatorNames: string[] = [];
    for (const name of rs.spectatorNames) {
      if (typeof name !== 'string') return null;
      spectatorNames.push(name);
    }
    const payload: RoomStatusPayload = {
      roomCode: rs.roomCode,
      phase: rs.phase as GamePhase,
      maxPlayers: rs.maxPlayers,
      players,
      spectatorNames,
    };
    return {
      kind: 'ROOM_STATUS',
      payload,
    };
  }

  if (raw.kind === 'SECRET_STATE') {
    if (!isRecord(raw.payload)) return null;
    const p = raw.payload;
    if (typeof p.peek !== 'boolean' || !isRecord(p.luckByPlayer)) {
      return null;
    }
    const luckByPlayer: Record<string, SecretLuckMode> = {};
    for (const [pid, val] of Object.entries(p.luckByPlayer)) {
      if (!isNonEmptyString(pid)) return null;
      if (val !== 'normal' && val !== 'good' && val !== 'god') {
        return null;
      }
      luckByPlayer[pid] = val;
    }
    return {
      kind: 'SECRET_STATE',
      payload: {
        peek: p.peek,
        luckByPlayer,
      },
    };
  }

  if (raw.kind === 'CHANGE_HISTORY') {
    if (!Array.isArray(raw.payload)) {
      return null;
    }
    const entries: ChangeHistoryEntry[] = [];
    for (const item of raw.payload) {
      const parsed = parseChangeHistoryEntry(item);
      if (!parsed) return null;
      entries.push(parsed);
    }
    return {
      kind: 'CHANGE_HISTORY',
      payload: entries,
    };
  }

  if (raw.kind === 'ERROR') {
    if (!isRecord(raw.payload)) {
      return null;
    }
    const e = raw.payload;
    if (typeof e.code !== 'string' || typeof e.message !== 'string') {
      return null;
    }
    return {
      kind: 'ERROR',
      payload: raw.payload as unknown as GameError,
    };
  }

  return null;
}

const VALID_CHANGE_HISTORY_KINDS = new Set<ChangeHistoryKind>([
  'cheat_peek',
  'cheat_luck',
  'cheat_luck_reset',
  'cheat_stop',
  'rule_config',
  'cpu_seat',
  'host_transfer',
]);

function parseChangeHistoryEntry(raw: unknown): ChangeHistoryEntry | null {
  if (!isRecord(raw)) return null;
  if (
    !isNonEmptyString(raw.id) ||
    typeof raw.timestamp !== 'number' ||
    !Number.isFinite(raw.timestamp) ||
    !isNonEmptyString(raw.actorPlayerId) ||
    typeof raw.actorName !== 'string' ||
    (raw.category !== 'cheat' && raw.category !== 'settings') ||
    typeof raw.kind !== 'string' ||
    !VALID_CHANGE_HISTORY_KINDS.has(raw.kind as ChangeHistoryKind) ||
    typeof raw.phaseLabel !== 'string' ||
    !isNonEmptyString(raw.settingLabel)
  ) {
    return null;
  }
  if (raw.targetName !== undefined && typeof raw.targetName !== 'string') {
    return null;
  }
  if (raw.beforeValue !== undefined && typeof raw.beforeValue !== 'string') {
    return null;
  }
  if (raw.afterValue !== undefined && typeof raw.afterValue !== 'string') {
    return null;
  }
  return {
    id: raw.id,
    timestamp: raw.timestamp,
    actorPlayerId: raw.actorPlayerId,
    actorName: raw.actorName,
    category: raw.category as ChangeHistoryCategory,
    kind: raw.kind as ChangeHistoryKind,
    phaseLabel: raw.phaseLabel,
    settingLabel: raw.settingLabel,
    ...(raw.targetName !== undefined ? { targetName: raw.targetName } : {}),
    ...(raw.beforeValue !== undefined ? { beforeValue: raw.beforeValue } : {}),
    ...(raw.afterValue !== undefined ? { afterValue: raw.afterValue } : {}),
  };
}
