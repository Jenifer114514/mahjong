// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { toStateView } from '../../engine/projection';
import { applyAction, createInitialGameState, reduce } from '../../engine/reducer';
import { deriveRules } from '../../engine/rules';
import { buildSeededTestDeck } from '../../engine/__tests__/testHelpers';
import { migratedHostPeerId, parseClientMessage, parseHostMessage } from '../protocol';
import {
  decryptCheckpoint,
  encryptCheckpoint,
  generateReconnectToken,
} from '../recovery';
import {
  PERMANENT_ROOMS,
  PERMANENT_ROOM_DEFAULT_RULE_CONFIG,
  formatRoomDisplayName,
  getPermanentRoom,
  isPermanentRoomCode,
} from '../rooms';
import {
  clearSavedSessionRecord,
  loadSavedSessionRecord,
  saveSessionRecord,
} from '../storage';

describe('常設ルーム定義・暗号化チェックポイント・保存セッション', () => {
  it('銅・銀・金の間が定義されており、表示名と判定が正しく動作する', () => {
    expect(PERMANENT_ROOMS.map((r) => r.id)).toEqual(['BRONZE', 'SILVER', 'GOLD']);
    expect(isPermanentRoomCode('bronze')).toBe(true);
    expect(isPermanentRoomCode('SILVER')).toBe(true);
    expect(isPermanentRoomCode('GOLD')).toBe(true);
    expect(isPermanentRoomCode('ABC123')).toBe(false);

    expect(getPermanentRoom('GOLD')?.defaultRuleConfig).toEqual(
      PERMANENT_ROOM_DEFAULT_RULE_CONFIG,
    );
    expect(getPermanentRoom('SILVER')?.defaultRuleConfig).toEqual(
      PERMANENT_ROOM_DEFAULT_RULE_CONFIG,
    );
    expect(getPermanentRoom('BRONZE')?.defaultRuleConfig).toEqual(
      PERMANENT_ROOM_DEFAULT_RULE_CONFIG,
    );
    expect(new Set(PERMANENT_ROOMS.map((r) => r.tierLabel)).size).toBe(1);
    expect(formatRoomDisplayName('BRONZE')).toBe('銅の間 (BRONZE)');
    expect(formatRoomDisplayName('LOCAL')).toBe('ローカルCPU戦');
    expect(formatRoomDisplayName('XYZ999')).toBe('部屋 XYZ999');
    expect(migratedHostPeerId('BRONZE', 0)).toBe('arena-mj-BRONZE');
    expect(migratedHostPeerId('BRONZE', 2)).toBe('arena-mj-BRONZE-H2');
  });

  it('暗号化チェックポイントの暗号化・復号・改ざん検知が正しく動作する', () => {
    const payload = JSON.stringify({ room: 'BRONZE', secretHand: ['1m', '9p'] });
    const enc = encryptCheckpoint(payload);
    expect(enc.ciphertextBase64).not.toContain('secretHand');
    expect(
      decryptCheckpoint(enc.ivBase64, enc.ciphertextBase64, enc.keyBase64),
    ).toBe(payload);

    // 鍵が違うと復号できない
    const other = encryptCheckpoint('other');
    expect(
      decryptCheckpoint(enc.ivBase64, enc.ciphertextBase64, other.keyBase64),
    ).toBeNull();

    // 暗号文改ざんでタグ不一致となり null を返す
    const tampered =
      (enc.ciphertextBase64.startsWith('A') ? 'B' : 'A') +
      enc.ciphertextBase64.slice(1);
    expect(decryptCheckpoint(enc.ivBase64, tampered, enc.keyBase64)).toBeNull();
    expect(generateReconnectToken().length).toBeGreaterThanOrEqual(16);
  });

  it('localStorage への再接続セッション保存・期限切れ・クリアが動作する', () => {
    clearSavedSessionRecord();
    expect(loadSavedSessionRecord()).toBeNull();

    saveSessionRecord({
      roomCode: 'BRONZE',
      hostPeerId: 'arena-mj-BRONZE-H1',
      hostEpoch: 1,
      playerId: 'p1',
      playerName: 'たろう',
      reconnectToken: 'tok-123',
      isSpectator: false,
      updatedAt: 1_000_000,
    });

    expect(loadSavedSessionRecord(1_001_000)?.roomCode).toBe('BRONZE');
    // 6時間超過で自動失効する
    expect(loadSavedSessionRecord(1_000_000 + 7 * 60 * 60 * 1000)).toBeNull();

    saveSessionRecord({
      roomCode: 'LOCAL',
      hostPeerId: 'local',
      hostEpoch: 0,
      playerId: 'p0',
      playerName: 'ローカル',
      reconnectToken: 'tok',
      isSpectator: false,
      updatedAt: 2_000_000,
    });
    expect(loadSavedSessionRecord(2_001_000)).toBeNull();
  });

  it('観戦者と引き継ぎ用の新プロトコルメッセージをパースできる', () => {
    expect(
      parseClientMessage({
        kind: 'JOIN',
        playerName: '観戦太郎',
        reconnectToken: 'tok-1',
        preferSpectate: true,
      }),
    ).toEqual({
      kind: 'JOIN',
      playerName: '観戦太郎',
      reconnectToken: 'tok-1',
      preferSpectate: true,
    });

    expect(
      parseClientMessage({
        kind: 'CHECKPOINT_KEY_SHARE',
        hostEpoch: 1,
        seq: 5,
        keyBase64: 'abc=',
      }),
    ).toEqual({
      kind: 'CHECKPOINT_KEY_SHARE',
      hostEpoch: 1,
      seq: 5,
      keyBase64: 'abc=',
    });

    expect(
      parseHostMessage({
        kind: 'HOST_REDIRECT',
        payload: {
          roomCode: 'BRONZE',
          hostPeerId: 'arena-mj-BRONZE-H1',
          hostEpoch: 1,
        },
      }),
    ).toMatchObject({ kind: 'HOST_REDIRECT' });

    expect(
      parseHostMessage({
        kind: 'SESSION_WELCOME',
        payload: {
          roomCode: 'BRONZE',
          playerId: 'p2',
          playerName: '花子',
          reconnectToken: 'tok-2',
          isSpectator: true,
          hostEpoch: 0,
          hostPeerId: 'arena-mj-BRONZE',
        },
      }),
    ).toMatchObject({ kind: 'SESSION_WELCOME', payload: { isSpectator: true } });

    expect(parseClientMessage({ kind: 'PROBE_ROOM' })).toEqual({
      kind: 'PROBE_ROOM',
    });
    expect(
      parseHostMessage({
        kind: 'ROOM_STATUS',
        payload: {
          roomCode: 'BRONZE',
          phase: 'lobby',
          maxPlayers: 4,
          players: [
            { name: 'ホスト', isCpu: false, connected: true, isHost: true },
            { name: 'CPU 1', isCpu: true, connected: true, isHost: false },
          ],
          spectatorNames: ['観戦者A'],
        },
      }),
    ).toMatchObject({
      kind: 'ROOM_STATUS',
      payload: { roomCode: 'BRONZE', maxPlayers: 4 },
    });
    expect(
      parseHostMessage({
        kind: 'ROOM_STATUS',
        payload: { roomCode: 'BRONZE', phase: 'invalid' },
      }),
    ).toBeNull();
  });

  it('観戦者視点の StateView は全員の非公開手牌・山牌・鳴き候補を一切含まない', () => {
    const ruleConfig = { playerCount: 4 as const, gameLength: 'tonpuu' as const };
    const rules = deriveRules(ruleConfig);
    let state = createInitialGameState({
      roomCode: 'BRONZE',
      hostPlayerId: 'p0',
      hostName: 'P0',
      ruleConfig,
    });
    for (let i = 1; i < 4; i++) {
      state = reduce(state, { type: 'JOIN_PLAYER', playerId: `p${i}`, name: `P${i}` });
    }
    state = reduce(state, {
      type: 'START_GAME',
      shuffledDeck: buildSeededTestDeck(rules, 777),
    });
    state = reduce(state, {
      type: 'JOIN_SPECTATOR',
      spectatorId: 'spec-1',
      name: '観戦者',
    });

    const specView = toStateView(state, 'spec-1', 0, {
      perspectiveSeatIndex: 2,
      hostEpoch: 1,
    });
    expect(specView.isSpectator).toBe(true);
    expect(specView.viewerSeatIndex).toBe(2);
    expect(specView.hostEpoch).toBe(1);
    expect(specView.myHand).toEqual([]);
    expect(specView.myDrawnTile).toBeNull();
    expect(specView.myCallOptions).toBeNull();
    expect(specView.mySelfActions).toBeNull();

    const serialized = JSON.stringify(specView);
    for (const p of state.players) {
      for (const t of p.hand) {
        expect(serialized).not.toContain(`"${t.id}"`);
      }
      if (p.drawnTile) {
        expect(serialized).not.toContain(`"${p.drawnTile.id}"`);
      }
    }
    for (const t of state.round!.wall) {
      expect(serialized).not.toContain(`"${t.id}"`);
    }
  });

  it('TRANSFER_HOST と RESET_TO_LOBBY が正しく状態遷移する', () => {
    const ruleConfig = { playerCount: 3 as const, gameLength: 'tonpuu' as const };
    let state = createInitialGameState({
      roomCode: 'SILVER',
      hostPlayerId: 'p0',
      hostName: 'P0',
      ruleConfig,
    });
    state = reduce(state, { type: 'JOIN_PLAYER', playerId: 'p1', name: 'P1' });
    state = reduce(state, { type: 'JOIN_PLAYER', playerId: 'cpu-1', name: 'CPU1' });

    const invalidCpuTransfer = applyAction(state, {
      type: 'TRANSFER_HOST',
      newHostPlayerId: 'cpu-1',
    });
    expect(invalidCpuTransfer.error?.code).toBe('UNAUTHORIZED_ACTION');

    state = reduce(state, { type: 'TRANSFER_HOST', newHostPlayerId: 'p1' });
    expect(state.hostPlayerId).toBe('p1');

    // 終局状態から RESET_TO_LOBBY でロビーに戻せる
    state = {
      ...state,
      phase: 'finished',
      round: null,
      players: state.players.map((p) => ({ ...p, score: 40000 })),
    };
    state = reduce(state, { type: 'RESET_TO_LOBBY', playerId: 'p1' });
    expect(state.phase).toBe('lobby');
    expect(state.players.every((p) => p.score === 35000)).toBe(true);
  });
});
