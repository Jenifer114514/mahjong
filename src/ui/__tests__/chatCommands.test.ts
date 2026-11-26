import { describe, expect, it } from 'vitest';
import {
  isCheatModalCommand,
  isCheckModalCommand,
  isStopCheatCommand,
} from '../chatCommands';

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

  it('//check（前後空白・全角スラッシュ・大文字小文字許容）を履歴チェックコマンドとして判定する', () => {
    expect(isCheckModalCommand('//check')).toBe(true);
    expect(isCheckModalCommand('  //check  ')).toBe(true);
    expect(isCheckModalCommand('//CHECK')).toBe(true);
    expect(isCheckModalCommand('／／check')).toBe(true);
    expect(isCheckModalCommand('/／Check')).toBe(true);

    const nonChecks = [
      '/check',
      '//check on',
      '//cheat',
      'check',
      'よろしく！',
      '',
    ];
    for (const input of nonChecks) {
      expect(isCheckModalCommand(input)).toBe(false);
    }
  });

  it('//stop（前後空白・全角スラッシュ・大文字小文字許容）をチート停止コマンドとして判定する', () => {
    expect(isStopCheatCommand('//stop')).toBe(true);
    expect(isStopCheatCommand('  //stop  ')).toBe(true);
    expect(isStopCheatCommand('//STOP')).toBe(true);
    expect(isStopCheatCommand('／／stop')).toBe(true);
    expect(isStopCheatCommand('/／Stop')).toBe(true);

    const nonStops = [
      '/stop',
      '//stop all',
      '//cheat',
      '//check',
      'stop',
      'ストップ',
      '',
    ];
    for (const input of nonStops) {
      expect(isStopCheatCommand(input)).toBe(false);
    }
  });
});
