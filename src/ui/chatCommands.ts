export type LocalLuckMode = 'normal' | 'good' | 'god';

/**
 * チャット欄の隠しコマンド `//cheat`（前後空白・全角スラッシュ・大文字小文字許容）のみを判定する。
 * `/peek` や `/luck` などの個別コマンドは廃止済みのため、すべて通常チャットとして扱う。
 */
export function isCheatModalCommand(raw: string): boolean {
  const normalized = raw.trim().replace(/／/g, '/').toLowerCase();
  return normalized === '//cheat';
}

/**
 * チャット欄の隠しコマンド `//check`（前後空白・全角スラッシュ・大文字小文字許容）を判定する。
 */
export function isCheckModalCommand(raw: string): boolean {
  const normalized = raw.trim().replace(/／/g, '/').toLowerCase();
  return normalized === '//check';
}

/**
 * チャット欄の隠しコマンド `//stop`（前後空白・全角スラッシュ・大文字小文字許容）を判定する。
 */
export function isStopCheatCommand(raw: string): boolean {
  const normalized = raw.trim().replace(/／/g, '/').toLowerCase();
  return normalized === '//stop';
}
