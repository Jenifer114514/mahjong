import { DEFAULT_CPU_LEVEL, type RuleConfig } from '../types/rule';

export type PermanentRoomId = 'BRONZE' | 'SILVER' | 'GOLD';

export interface PermanentRoomDefinition {
  id: PermanentRoomId;
  name: string;
  tierLabel: string;
  badgeClass: string;
  defaultRuleConfig: RuleConfig;
}

export const PERMANENT_ROOM_DEFAULT_RULE_CONFIG: Readonly<RuleConfig> = {
  playerCount: 4,
  gameLength: 'hanchan',
  tobi: true,
  tsumoLoss: false,
  allowKuitan: true,
  allowAtozuke: true,
  honbaBonus: true,
  doubleRon: true,
  forbidKuikae: true,
  cpuLevel: DEFAULT_CPU_LEVEL,
};

export const PERMANENT_ROOMS: readonly PermanentRoomDefinition[] = [
  {
    id: 'BRONZE',
    name: '銅の間',
    tierLabel: '標準ルール',
    badgeClass: 'is-bronze',
    defaultRuleConfig: { ...PERMANENT_ROOM_DEFAULT_RULE_CONFIG },
  },
  {
    id: 'SILVER',
    name: '銀の間',
    tierLabel: '標準ルール',
    badgeClass: 'is-silver',
    defaultRuleConfig: { ...PERMANENT_ROOM_DEFAULT_RULE_CONFIG },
  },
  {
    id: 'GOLD',
    name: '金の間',
    tierLabel: '標準ルール',
    badgeClass: 'is-gold',
    defaultRuleConfig: { ...PERMANENT_ROOM_DEFAULT_RULE_CONFIG },
  },
] as const;

export function getPermanentRoom(
  roomCode: string,
): PermanentRoomDefinition | undefined {
  const normalized = roomCode.trim().toUpperCase();
  return PERMANENT_ROOMS.find((room) => room.id === normalized);
}

export function isPermanentRoomCode(roomCode: string): boolean {
  return getPermanentRoom(roomCode) !== undefined;
}

export function formatRoomDisplayName(roomCode: string): string {
  if (roomCode === 'LOCAL') {
    return 'ローカルCPU戦';
  }
  const perm = getPermanentRoom(roomCode);
  if (perm) {
    return `${perm.name} (${perm.id})`;
  }
  return `部屋 ${roomCode}`;
}
