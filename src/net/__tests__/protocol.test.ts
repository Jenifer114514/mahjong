import { describe, expect, it } from 'vitest';
import { formatConnectionFailureMessage } from '../client';
import {
  buildPeerOptions,
  generateRoomCode,
  hasTurnConfig,
  normalizeRoomCode,
  parseClientMessage,
  parseHostMessage,
  roomCodeToPeerId,
} from '../protocol';

describe('net/protocol', () => {
  it('部屋コードの生成・正規化・PeerID変換が正しく動作する', () => {
    const code = generateRoomCode();
    expect(code).toMatch(/^[A-Z0-9]{6}$/);
    expect(normalizeRoomCode(' ab-c 123 ')).toBe('ABC123');
    expect(roomCodeToPeerId(' ab12cd ')).toBe('arena-mj-AB12CD');
  });

  it('ClientMessage の妥当なメッセージを受理し、不正なメッセージを拒否する', () => {
    expect(
      parseClientMessage({ kind: 'JOIN', playerName: 'たろう' }),
    ).toEqual({ kind: 'JOIN', playerName: 'たろう' });

    expect(
      parseClientMessage({
        kind: 'ACTION',
        action: { type: 'DISCARD_TILE', tileId: '1m-0' },
      }),
    ).toEqual({
      kind: 'ACTION',
      action: { type: 'DISCARD_TILE', tileId: '1m-0' },
    });

    expect(
      parseClientMessage({
        kind: 'ACTION',
        action: { type: 'ADVANCE_ROUND' },
      }),
    ).toEqual({
      kind: 'ACTION',
      action: { type: 'ADVANCE_ROUND' },
    });

    // Stage 2 actions
    expect(
      parseClientMessage({
        kind: 'ACTION',
        action: { type: 'CALL_RESPONSE', choice: { type: 'pass' } },
      }),
    ).toEqual({
      kind: 'ACTION',
      action: { type: 'CALL_RESPONSE', choice: { type: 'pass' } },
    });

    expect(
      parseClientMessage({
        kind: 'ACTION',
        action: {
          type: 'CALL_RESPONSE',
          choice: { type: 'chi', tileIds: ['2m-0', '3m-0'] },
        },
      }),
    ).toEqual({
      kind: 'ACTION',
      action: {
        type: 'CALL_RESPONSE',
        choice: { type: 'chi', tileIds: ['2m-0', '3m-0'] },
      },
    });

    expect(
      parseClientMessage({
        kind: 'ACTION',
        action: { type: 'DECLARE_ANKAN', kind: '1m' },
      }),
    ).toEqual({
      kind: 'ACTION',
      action: { type: 'DECLARE_ANKAN', kind: '1m' },
    });

    expect(
      parseClientMessage({
        kind: 'ACTION',
        action: { type: 'DECLARE_KAKAN', tileId: '1z-2' },
      }),
    ).toEqual({
      kind: 'ACTION',
      action: { type: 'DECLARE_KAKAN', tileId: '1z-2' },
    });

    expect(
      parseClientMessage({
        kind: 'ACTION',
        action: { type: 'DECLARE_KITA', tileId: '4z-0' },
      }),
    ).toEqual({
      kind: 'ACTION',
      action: { type: 'DECLARE_KITA', tileId: '4z-0' },
    });

    // Stage 3A action
    expect(
      parseClientMessage({
        kind: 'ACTION',
        action: { type: 'DECLARE_TSUMO' },
      }),
    ).toEqual({
      kind: 'ACTION',
      action: { type: 'DECLARE_TSUMO' },
    });

    // Stage 3B action
    expect(
      parseClientMessage({
        kind: 'ACTION',
        action: { type: 'DECLARE_RIICHI', tileId: '1z-0' },
      }),
    ).toEqual({
      kind: 'ACTION',
      action: { type: 'DECLARE_RIICHI', tileId: '1z-0' },
    });
    expect(
      parseClientMessage({
        kind: 'ACTION',
        action: { type: 'DECLARE_RIICHI', tileId: '' },
      }),
    ).toBeNull();
    expect(
      parseClientMessage({
        kind: 'ACTION',
        action: { type: 'DECLARE_KYUUSHU_KYUUHAI' },
      }),
    ).toEqual({
      kind: 'ACTION',
      action: { type: 'DECLARE_KYUUSHU_KYUUHAI' },
    });

    // Invalid cases
    expect(parseClientMessage(null)).toBeNull();
    expect(parseClientMessage({ kind: 'JOIN', playerName: 123 })).toBeNull();
    expect(
      parseClientMessage({
        kind: 'ACTION',
        action: { type: 'DISCARD_TILE', tileId: '' },
      }),
    ).toBeNull();
    expect(
      parseClientMessage({
        kind: 'ACTION',
        action: { type: 'START_GAME', shuffledDeck: [] },
      }),
    ).toBeNull();
    expect(
      parseClientMessage({
        kind: 'ACTION',
        action: { type: 'DECLARE_ANKAN', kind: '9z' },
      }),
    ).toBeNull();
    expect(
      parseClientMessage({
        kind: 'ACTION',
        action: { type: 'CALL_RESPONSE', choice: { type: 'chi', tileIds: ['only-one'] } },
      }),
    ).toBeNull();

    expect(
      parseClientMessage({ kind: 'CHAT', text: '  よろしく！  ' }),
    ).toEqual({ kind: 'CHAT', text: 'よろしく！' });
    expect(parseClientMessage({ kind: 'CHAT', text: '   ' })).toBeNull();
    expect(parseClientMessage({ kind: 'CHAT', text: 'a'.repeat(201) })).toBeNull();
  });

  it('HostMessage の妥当なメッセージとエラーを受理し、不正なメッセージを拒否する', () => {
    expect(
      parseHostMessage({
        kind: 'ERROR',
        payload: { code: 'NOT_YOUR_TURN', message: 'あなたの手番ではありません。' },
      }),
    ).toEqual({
      kind: 'ERROR',
      payload: { code: 'NOT_YOUR_TURN', message: 'あなたの手番ではありません。' },
    });

    expect(
      parseHostMessage({
        kind: 'STATE_VIEW',
        payload: {
          roomCode: 'ABC123',
          hostPlayerId: 'h1',
          viewerPlayerId: 'h1',
          viewerSeatIndex: 0,
          ruleConfig: { playerCount: 4, gameLength: 'tonpuu', honbaBonus: true },
          phase: 'lobby',
          initialDealerIndex: 0,
          finalKyotakuAward: null,
          players: [],
          myHand: [],
          myDrawnTile: null,
          myCallOptions: null,
          mySelfActions: null,
          kuikaeForbiddenKinds: [],
          responseRemainingMs: null,
          round: null,
        },
      }),
    ).not.toBeNull();

    expect(
      parseHostMessage({
        kind: 'STATE_VIEW',
        payload: {
          roomCode: 'ABC123',
          hostPlayerId: 'h1',
          viewerPlayerId: 'h1',
          viewerSeatIndex: 0,
          ruleConfig: { playerCount: 4, gameLength: 'tonpuu', honbaBonus: true },
          phase: 'finished',
          initialDealerIndex: 0,
          finalKyotakuAward: { playerId: 'h1', points: 1000 },
          players: [],
          myHand: [],
          myDrawnTile: null,
          myCallOptions: null,
          mySelfActions: null,
          kuikaeForbiddenKinds: [],
          responseRemainingMs: null,
          round: null,
        },
      }),
    ).toMatchObject({
      kind: 'STATE_VIEW',
      payload: {
        finalKyotakuAward: { playerId: 'h1', points: 1000 },
      },
    });

    expect(parseHostMessage({ kind: 'UNKNOWN' })).toBeNull();
    expect(parseHostMessage({ kind: 'ERROR', payload: { code: 1 } })).toBeNull();

    expect(
      parseHostMessage({
        kind: 'CHAT_MESSAGE',
        payload: {
          id: 'chat-1',
          senderId: 'h1',
          senderName: 'ホスト',
          text: 'よろしく！',
          timestamp: 12345,
        },
      }),
    ).toEqual({
      kind: 'CHAT_MESSAGE',
      payload: {
        id: 'chat-1',
        senderId: 'h1',
        senderName: 'ホスト',
        text: 'よろしく！',
        timestamp: 12345,
      },
    });
    expect(parseHostMessage({ kind: 'CHAT_MESSAGE', payload: { id: '' } })).toBeNull();

    expect(
      parseHostMessage({ kind: 'HOST_STATUS', payload: { away: true } }),
    ).toEqual({ kind: 'HOST_STATUS', payload: { away: true } });
    expect(
      parseHostMessage({ kind: 'HOST_STATUS', payload: { away: 'yes' } }),
    ).toBeNull();
  });

  it('TURN 環境変数の有無に応じて iceServers と接続失敗案内メッセージを切り替える', () => {
    expect(hasTurnConfig({})).toBe(false);
    const stunOnly = buildPeerOptions({});
    expect(stunOnly.config?.iceServers).toEqual([
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
    ]);

    const envWithTurn = {
      VITE_TURN_URL: 'turn:turn.example.com:3478, turns:turn.example.com:5349',
      VITE_TURN_USERNAME: 'u1',
      VITE_TURN_CREDENTIAL: 'p1',
    };
    expect(hasTurnConfig(envWithTurn)).toBe(true);
    const withTurn = buildPeerOptions(envWithTurn);
    expect(withTurn.config?.iceServers).toEqual([
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      {
        urls: ['turn:turn.example.com:3478', 'turns:turn.example.com:5349'],
        username: 'u1',
        credential: 'p1',
      },
    ]);

    expect(formatConnectionFailureMessage('タイムアウトしました。', false)).toContain(
      'TURN',
    );
    expect(formatConnectionFailureMessage('タイムアウトしました。', true)).toBe(
      'タイムアウトしました。',
    );
  });

  it('SECRET_OPTION と SECRET_STATE メッセージを正しくパースし不正値を拒否する', () => {
    expect(
      parseClientMessage({ kind: 'SECRET_OPTION', peek: true }),
    ).toEqual({ kind: 'SECRET_OPTION', peek: true });
    expect(
      parseClientMessage({ kind: 'SECRET_OPTION', luck: 'god' }),
    ).toEqual({ kind: 'SECRET_OPTION', luck: 'god' });
    expect(
      parseClientMessage({
        kind: 'SECRET_OPTION',
        luck: 'god',
        luckTargetPlayerId: 'cpu-1',
      }),
    ).toEqual({
      kind: 'SECRET_OPTION',
      luck: 'god',
      luckTargetPlayerId: 'cpu-1',
    });
    expect(
      parseClientMessage({ kind: 'SECRET_OPTION', clearAllLuck: true }),
    ).toEqual({ kind: 'SECRET_OPTION', clearAllLuck: true });
    expect(
      parseClientMessage({ kind: 'SECRET_OPTION', requestSync: true }),
    ).toEqual({ kind: 'SECRET_OPTION', requestSync: true });
    expect(
      parseClientMessage({ kind: 'SECRET_OPTION', peek: false, luck: 'normal' }),
    ).toEqual({ kind: 'SECRET_OPTION', peek: false, luck: 'normal' });

    expect(parseClientMessage({ kind: 'SECRET_OPTION' })).toBeNull();
    expect(
      parseClientMessage({ kind: 'SECRET_OPTION', peek: 'yes' }),
    ).toBeNull();
    expect(
      parseClientMessage({ kind: 'SECRET_OPTION', luck: 'ultra' }),
    ).toBeNull();
    expect(
      parseClientMessage({ kind: 'SECRET_OPTION', luckTargetPlayerId: 'cpu-1' }),
    ).toBeNull();
    expect(
      parseClientMessage({
        kind: 'SECRET_OPTION',
        luck: 'good',
        luckTargetPlayerId: '',
      }),
    ).toBeNull();

    expect(
      parseHostMessage({
        kind: 'SECRET_STATE',
        payload: { peek: true, luckByPlayer: { p0: 'god', 'cpu-1': 'normal' } },
      }),
    ).toEqual({
      kind: 'SECRET_STATE',
      payload: { peek: true, luckByPlayer: { p0: 'god', 'cpu-1': 'normal' } },
    });
    expect(
      parseHostMessage({
        kind: 'SECRET_STATE',
        payload: { peek: 'yes', luckByPlayer: {} },
      }),
    ).toBeNull();
    expect(
      parseHostMessage({
        kind: 'SECRET_STATE',
        payload: { peek: false, luckByPlayer: { p0: 'cheat' } },
      }),
    ).toBeNull();
  });

  it('REQUEST_CHANGE_HISTORY と CHANGE_HISTORY メッセージを正しくパースし不正値を拒否する', () => {
    expect(parseClientMessage({ kind: 'REQUEST_CHANGE_HISTORY' })).toEqual({
      kind: 'REQUEST_CHANGE_HISTORY',
    });
    expect(
      parseClientMessage({ kind: 'REQUEST_CHANGE_HISTORY', watch: true }),
    ).toEqual({
      kind: 'REQUEST_CHANGE_HISTORY',
      watch: true,
    });
    expect(
      parseClientMessage({ kind: 'REQUEST_CHANGE_HISTORY', watch: false }),
    ).toEqual({
      kind: 'REQUEST_CHANGE_HISTORY',
      watch: false,
    });
    expect(
      parseClientMessage({ kind: 'REQUEST_CHANGE_HISTORY', watch: 'yes' }),
    ).toBeNull();

    const validEntry = {
      id: 'chg-1',
      timestamp: 1700000000000,
      actorPlayerId: 'p1',
      actorName: 'ゲスト1',
      category: 'cheat' as const,
      kind: 'cheat_peek' as const,
      phaseLabel: '東1局',
      settingLabel: '相手手牌の透視（Peek）',
      beforeValue: 'OFF',
      afterValue: 'ON',
    };

    expect(
      parseHostMessage({
        kind: 'CHANGE_HISTORY',
        payload: [validEntry],
      }),
    ).toEqual({
      kind: 'CHANGE_HISTORY',
      payload: [validEntry],
    });
    expect(
      parseHostMessage({
        kind: 'CHANGE_HISTORY',
        payload: [],
      }),
    ).toEqual({
      kind: 'CHANGE_HISTORY',
      payload: [],
    });

    expect(
      parseHostMessage({
        kind: 'CHANGE_HISTORY',
        payload: 'invalid',
      }),
    ).toBeNull();
    expect(
      parseHostMessage({
        kind: 'CHANGE_HISTORY',
        payload: [{ ...validEntry, category: 'unknown' }],
      }),
    ).toBeNull();
    expect(
      parseHostMessage({
        kind: 'CHANGE_HISTORY',
        payload: [{ ...validEntry, kind: 'unknown_kind' }],
      }),
    ).toBeNull();
    expect(
      parseHostMessage({
        kind: 'CHANGE_HISTORY',
        payload: [{ ...validEntry, id: '' }],
      }),
    ).toBeNull();

    expect(
      parseClientMessage({ kind: 'SECRET_OPTION', clearAllCheat: true }),
    ).toEqual({ kind: 'SECRET_OPTION', clearAllCheat: true });
    expect(
      parseClientMessage({ kind: 'SECRET_OPTION', clearAllCheat: 'yes' }),
    ).toBeNull();
    expect(
      parseHostMessage({
        kind: 'CHANGE_HISTORY',
        payload: [{ ...validEntry, kind: 'cheat_stop' }],
      }),
    ).toEqual({
      kind: 'CHANGE_HISTORY',
      payload: [{ ...validEntry, kind: 'cheat_stop' }],
    });
  });
});
