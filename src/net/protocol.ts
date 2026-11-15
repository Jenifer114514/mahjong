import type { PeerOptions } from 'peerjs';
import type { ClientMessage, GameError, HostMessage, StateView } from '../types/message';
import type { CallResponseChoice } from '../types/state';
import { ALL_TILE_KINDS, type TileKind } from '../types/tile';

export const PEER_ID_PREFIX = 'arena-mj-';
const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ROOM_CODE_LENGTH = 6;
const VALID_TILE_KINDS = new Set<string>(ALL_TILE_KINDS);

export const PEER_OPTIONS: PeerOptions = {
  debug: 1,
  config: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
    ],
  },
};

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

  if (raw.kind === 'JOIN') {
    if (typeof raw.playerName !== 'string') {
      return null;
    }
    return {
      kind: 'JOIN',
      playerName: raw.playerName,
    };
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
