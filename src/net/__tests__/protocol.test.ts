import { describe, expect, it } from 'vitest';
import {
  generateRoomCode,
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
          ruleConfig: { playerCount: 4, gameLength: 'tonpuu' },
          phase: 'lobby',
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

    expect(parseHostMessage({ kind: 'UNKNOWN' })).toBeNull();
    expect(parseHostMessage({ kind: 'ERROR', payload: { code: 1 } })).toBeNull();
  });
});
