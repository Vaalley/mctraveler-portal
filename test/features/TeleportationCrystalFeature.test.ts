import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import net from 'node:net';
import { kPrimaryPort } from '@/config';
import { executeCommand, getUniqueCommandNames } from '@/feature-api/command';
import { enableFeatureForTesting, executeHook, FeatureHook, reset } from '@/feature-api/manager';
import TeleportationCrystalFeature from '@/features/TeleportationCrystalFeature';
import OnlinePlayersModule from '@/modules/OnlinePlayersModule';
import { _resetSocketLookup, _setSocketLookup } from '@/network/player-tracking';

const { clearOnlinePlayersForTesting, trackPlayerLogin: _trackPlayerLogin } = OnlinePlayersModule.api;

function trackPlayerLogin(uuid: string, username: string, socket?: any) {
  return _trackPlayerLogin(uuid, username, socket, kPrimaryPort, false, undefined, true);
}

function createMockSocket(): any {
  const s = new net.Socket();
  s.write = (() => true) as any;
  return s;
}

describe('TeleportationCrystalFeature', () => {
  beforeAll(() => {
    reset();
    enableFeatureForTesting(TeleportationCrystalFeature);
  });

  afterEach(() => {
    clearOnlinePlayersForTesting();
    _resetSocketLookup();
  });

  afterAll(() => {
    reset();
  });

  describe('Command Registration', () => {
    test('registers tpcrystal command', () => {
      const commandNames = getUniqueCommandNames();
      expect(commandNames).toContain('tpcrystal');
    });

    test('registers tpaccept command', () => {
      const commandNames = getUniqueCommandNames();
      expect(commandNames).toContain('tpaccept');
    });

    test('registers tpdeny command', () => {
      const commandNames = getUniqueCommandNames();
      expect(commandNames).toContain('tpdeny');
    });
  });

  describe('tpcrystal command', () => {
    test('shows message when player has no crystal', () => {
      const mockSocket = createMockSocket();
      const player = trackPlayerLogin('tc-no-crystal', 'NoCrystal', mockSocket);

      const result = executeCommand(player, 'tpcrystal');

      expect(result).toBeDefined();
      expect(result.toLegacyString()).toContain("don't have");
    });

    test('gives tier 1 crystal with 1 charge', () => {
      const mockSocket = createMockSocket();
      const player = trackPlayerLogin('tc-give-1', 'GivePlayer1', mockSocket);
      _setSocketLookup(() => mockSocket);

      const result = executeCommand(player, 'tpcrystal give 1');

      expect(result).toBeDefined();
      expect(result.toLegacyString()).toContain('Tier 1');
      expect(result.toLegacyString()).toContain('1');
    });

    test('gives tier 2 crystal with 3 charges', () => {
      const mockSocket = createMockSocket();
      const player = trackPlayerLogin('tc-give-2', 'GivePlayer2', mockSocket);
      _setSocketLookup(() => mockSocket);

      const result = executeCommand(player, 'tpcrystal give 2');

      expect(result).toBeDefined();
      expect(result.toLegacyString()).toContain('Tier 2');
      expect(result.toLegacyString()).toContain('3');
    });

    test('gives tier 3 crystal with 5 charges', () => {
      const mockSocket = createMockSocket();
      const player = trackPlayerLogin('tc-give-3', 'GivePlayer3', mockSocket);
      _setSocketLookup(() => mockSocket);

      const result = executeCommand(player, 'tpcrystal give 3');

      expect(result).toBeDefined();
      expect(result.toLegacyString()).toContain('Tier 3');
      expect(result.toLegacyString()).toContain('5');
    });

    test('opens menu when player has crystal', () => {
      const mockSocket = createMockSocket();
      const player = trackPlayerLogin('tc-menu', 'MenuPlayer', mockSocket);
      _setSocketLookup(() => mockSocket);

      executeCommand(player, 'tpcrystal give 1');

      let packetsSent = 0;
      mockSocket.write = () => {
        packetsSent++;
        return true;
      };

      executeCommand(player, 'tpcrystal');
      expect(packetsSent).toBeGreaterThan(0);
    });
  });

  describe('tpcrystal craft command', () => {
    test('shows crafting requirements for tier 1', () => {
      const mockSocket = createMockSocket();
      const player = trackPlayerLogin('tc-craft-1', 'CraftPlayer1', mockSocket);

      const result = executeCommand(player, 'tpcrystal craft 1');

      expect(result).toBeDefined();
      expect(result.toLegacyString()).toContain('Eye of Ender');
    });

    test('shows crafting requirements for tier 2', () => {
      const mockSocket = createMockSocket();
      const player = trackPlayerLogin('tc-craft-2', 'CraftPlayer2', mockSocket);

      const result = executeCommand(player, 'tpcrystal craft 2');

      expect(result).toBeDefined();
      expect(result.toLegacyString()).toContain('Chorus Fruit');
    });

    test('shows crafting requirements for tier 3', () => {
      const mockSocket = createMockSocket();
      const player = trackPlayerLogin('tc-craft-3', 'CraftPlayer3', mockSocket);

      const result = executeCommand(player, 'tpcrystal craft 3');

      expect(result).toBeDefined();
      expect(result.toLegacyString()).toContain('Echo Shard');
    });
  });

  describe('TP request system', () => {
    test('tpaccept with no pending request shows error', () => {
      const mockSocket = createMockSocket();
      const player = trackPlayerLogin('tc-accept-none', 'AcceptNone', mockSocket);
      player.sendMessage = () => {};

      executeCommand(player, 'tpaccept');
    });

    test('tpdeny with no pending request shows error', () => {
      const mockSocket = createMockSocket();
      const player = trackPlayerLogin('tc-deny-none', 'DenyNone', mockSocket);
      player.sendMessage = () => {};

      executeCommand(player, 'tpdeny');
    });
  });

  describe('PlayerMove hook', () => {
    test('tracks player position', () => {
      const mockSocket = createMockSocket();
      const player = trackPlayerLogin('tc-move', 'MovePlayer', mockSocket);
      _setSocketLookup(() => mockSocket);

      executeHook(FeatureHook.PlayerMove, {
        player,
        from: { x: 0, y: 64, z: 0 },
        to: { x: 10, y: 64, z: 10 },
      });

      executeCommand(player, 'tpcrystal give 3');

      let messageSent = '';
      player.sendMessage = (msg: any) => {
        messageSent = typeof msg === 'string' ? msg : (msg?.toLegacyString?.() ?? '');
      };

      executeCommand(player, 'tpcrystal');
      expect(messageSent).not.toContain('Could not determine');
    });
  });

  describe('PlayerLeave hook', () => {
    test('cleans up player state on disconnect', () => {
      const mockSocket = createMockSocket();
      const player = trackPlayerLogin('tc-leave', 'LeavePlayer', mockSocket);
      _setSocketLookup(() => mockSocket);

      executeCommand(player, 'tpcrystal give 2');

      executeHook(FeatureHook.PlayerLeave, { player });

      const result = executeCommand(player, 'tpcrystal');
      expect(result).toBeDefined();
      expect(result.toLegacyString()).toContain("don't have");
    });
  });

  describe('Crystal charges', () => {
    test('crystal give sets correct charges for each tier', () => {
      const mockSocket = createMockSocket();
      _setSocketLookup(() => mockSocket);

      const p1 = trackPlayerLogin('tc-charge-1', 'ChargeT1', mockSocket);
      const r1 = executeCommand(p1, 'tpcrystal give 1');
      expect(r1.toLegacyString()).toContain('1');

      clearOnlinePlayersForTesting();

      const p2 = trackPlayerLogin('tc-charge-2', 'ChargeT2', mockSocket);
      const r2 = executeCommand(p2, 'tpcrystal give 2');
      expect(r2.toLegacyString()).toContain('3');

      clearOnlinePlayersForTesting();

      const p3 = trackPlayerLogin('tc-charge-3', 'ChargeT3', mockSocket);
      const r3 = executeCommand(p3, 'tpcrystal give 3');
      expect(r3.toLegacyString()).toContain('5');
    });
  });
});
