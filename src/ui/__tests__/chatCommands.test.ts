import { describe, expect, it } from 'vitest';
import { isCheatModalCommand } from '../chatCommands';

describe('chatCommands (//cheat 専用・/peek や /luck は廃止)', () => {
  it('//cheat（前後空白・全角スラッシュ・大文字小文字許容）のみ裏設定モーダル起動コマンドとして判定する', () => {
    expect(isCheatModalCommand('//cheat')).toBe(true);
    expect(isCheatModalCommand('  //cheat  ')).toBe(true);
    expect(isCheatModalCommand('//CHEAT')).toBe(true);
    expect(isCheatModalCommand('／／cheat')).toBe(true);
    expect(isCheatModalCommand('/／Cheat')).toBe(true);
  });

  it('廃止された /peek・/luck や旧コマンド・通常チャットはすべて false を返す', () => {
    const nonCommands = [
      '/peek',
      '/peek on',
      '/peek off',
      '／peek off',
      '!透視 on',
      '/luck',
      '/luck normal',
      '/luck good',
      '！luck god',
      '/豪運 豪運',
      '/cheat',
      '//cheat on',
      '//peek',
      '//luck',
      '/red on',
      '/kiriage on',
      '/kazoe off',
      '/renpu 2',
      '/points 50000',
      '/noten 0',
      '/timeout 30',
      '/kanlimit 8',
      '/help',
      '/status',
      '/',
      '//',
      'よろしく！',
    ];
    for (const input of nonCommands) {
      expect(isCheatModalCommand(input)).toBe(false);
    }
  });
});
