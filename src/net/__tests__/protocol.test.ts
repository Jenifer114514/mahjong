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
        action: { type: 'START_GAME', seed: 1 },
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
          round: null,
        },
      }),
    ).not.toBeNull();

    expect(parseHostMessage({ kind: 'UNKNOWN' })).toBeNull();
    expect(parseHostMessage({ kind: 'ERROR', payload: { code: 1 } })).toBeNull();
  });
});
