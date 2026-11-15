import type { PeerOptions } from 'peerjs';
import type { ClientMessage, GameError, HostMessage, StateView } from '../types/message';

export const PEER_ID_PREFIX = 'arena-mj-';
const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ROOM_CODE_LENGTH = 6;

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

export function createRandomSeed(): number {
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const buf = new Uint32Array(1);
    crypto.getRandomValues(buf);
    return buf[0]! || 1;
  }
  return Math.floor(Math.random() * 0xffffffff) || 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
    if (raw.action.type === 'DISCARD_TILE') {
      if (typeof raw.action.tileId !== 'string' || raw.action.tileId.length === 0) {
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
    if (raw.action.type === 'ADVANCE_ROUND') {
      return {
        kind: 'ACTION',
        action: {
          type: 'ADVANCE_ROUND',
        },
      };
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
