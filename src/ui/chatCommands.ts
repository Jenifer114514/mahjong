export type LocalLuckMode = 'normal' | 'good' | 'god';

/**
 * チャット欄の隠しコマンド `//cheat`（前後空白・全角スラッシュ・大文字小文字許容）のみを判定する。
 * `/peek` や `/luck` などの個別コマンドは廃止済みのため、すべて通常チャットとして扱う。
 */
export function isCheatModalCommand(raw: string): boolean {
  const normalized = raw.trim().replace(/／/g, '/').toLowerCase();
  return normalized === '//cheat';
}
