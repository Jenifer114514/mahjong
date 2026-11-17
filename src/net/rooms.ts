import { DEFAULT_CPU_LEVEL, type RuleConfig } from '../types/rule';

export type PermanentRoomId = 'BRONZE' | 'SILVER' | 'GOLD';

export interface PermanentRoomDefinition {
  id: PermanentRoomId;
  name: string;
  tierLabel: string;
  badgeClass: string;
  description: string;
  rulesSummary: string;
  defaultRuleConfig: RuleConfig;
}

export const PERMANENT_ROOMS: readonly PermanentRoomDefinition[] = [
  {
    id: 'BRONZE',
    name: '銅の間',
    tierLabel: '入門・東風戦',
    badgeClass: 'is-bronze',
    description: '気軽に参加できる4人東風戦の卓です。空きがあればホストとして自動で部屋が開きます。',
    rulesSummary: '4人麻雀 / 東風戦 / トビあり / 喰いタン・後付けあり / CPUやさしめ',
    defaultRuleConfig: {
      playerCount: 4,
      gameLength: 'tonpuu',
      tobi: true,
      tsumoLoss: false,
      allowKuitan: true,
      allowAtozuke: true,
      honbaBonus: true,
      doubleRon: true,
      forbidKuikae: true,
      cpuLevel: 'easy',
    },
  },
  {
    id: 'SILVER',
    name: '銀の間',
    tierLabel: '標準・半荘戦',
    badgeClass: 'is-silver',
    description: '標準ルールの4人半荘戦の卓です。対局中に参加した場合は観戦として入室します。',
    rulesSummary: '4人麻雀 / 半荘戦 / トビあり / ダブロンあり / 標準CPU',
    defaultRuleConfig: {
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
    },
  },
  {
    id: 'GOLD',
    name: '金の間',
    tierLabel: '上級・頭ハネ',
    badgeClass: 'is-gold',
    description: '頭ハネ（ダブロンなし）を採用した真剣勝負の半荘戦卓です。',
    rulesSummary: '4人麻雀 / 半荘戦 / 頭ハネ（ダブロンなし） / 喰い替え禁止 / 標準CPU',
    defaultRuleConfig: {
      playerCount: 4,
      gameLength: 'hanchan',
      tobi: true,
      tsumoLoss: false,
      allowKuitan: true,
      allowAtozuke: true,
      honbaBonus: true,
      doubleRon: false,
      forbidKuikae: true,
      cpuLevel: DEFAULT_CPU_LEVEL,
    },
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
