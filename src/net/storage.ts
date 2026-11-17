export interface SavedSessionRecord {
  roomCode: string;
  hostPeerId: string;
  hostEpoch: number;
  playerId: string;
  playerName: string;
  reconnectToken: string;
  isSpectator: boolean;
  updatedAt: number;
}

const STORAGE_KEY = 'arena-mahjong:saved-session:v1';
const MAX_SESSION_AGE_MS = 6 * 60 * 60 * 1000; // 6時間

function getStorage(): Storage | null {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      return window.localStorage;
    }
  } catch {
    // ignore storage access restrictions
  }
  return null;
}

export function saveSessionRecord(record: SavedSessionRecord): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(record));
  } catch {
    // ignore quota errors
  }
}

export function loadSavedSessionRecord(
  now = Date.now(),
): SavedSessionRecord | null {
  const storage = getStorage();
  if (!storage) return null;
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SavedSessionRecord>;
    if (
      typeof parsed.roomCode !== 'string' ||
      typeof parsed.hostPeerId !== 'string' ||
      typeof parsed.hostEpoch !== 'number' ||
      typeof parsed.playerId !== 'string' ||
      typeof parsed.playerName !== 'string' ||
      typeof parsed.reconnectToken !== 'string' ||
      typeof parsed.isSpectator !== 'boolean' ||
      typeof parsed.updatedAt !== 'number'
    ) {
      return null;
    }
    if (parsed.roomCode === 'LOCAL') {
      return null;
    }
    if (now - parsed.updatedAt > MAX_SESSION_AGE_MS) {
      storage.removeItem(STORAGE_KEY);
      return null;
    }
    return parsed as SavedSessionRecord;
  } catch {
    return null;
  }
}

export function clearSavedSessionRecord(): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
