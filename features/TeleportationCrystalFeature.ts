import { kPrimaryPort, kSecondaryPort } from '@/config';
import { chatCommandPacket, closeWindowClientPacket, openWindowPacket, playerUseItemPacket } from '@/defined-packets.gen';
import { anonymousNbt, short, string, varInt } from '@/encoding/data-buffer';
import { registerCommand, syntax } from '@/feature-api/command';
import { defineFeature, FeatureHook, registerHook } from '@/feature-api/manager';
import p from '@/feature-api/paint';
import { log } from '@/logging';
import OnlinePlayersModule, { type OnlinePlayer } from '@/modules/OnlinePlayersModule';
import { writePacket } from '@/network/defined-packet';
import { onClientToServerPacket } from '@/network/packet-handlers';
import { getPlayerSocket, getServerSocket } from '@/network/proxy';
import { safeWrite } from '@/network/util';

const ITEM_ECHO_SHARD = 1320;
const ITEM_RED_BED = 1027;
const ITEM_GRASS_BLOCK = 27;
const ITEM_PLAYER_HEAD = 1156;
const ITEM_BEACON = 419;
const ITEM_WHITE_BANNER = 1185;
const ITEM_GLOBE_BANNER_PATTERN = 1250;
const ITEM_BARRIER = 466;
const ITEM_ENDER_EYE = 1055;
const ITEM_CHORUS_FRUIT = 1202;

const COMPONENT_CUSTOM_DATA = 0;
const COMPONENT_CUSTOM_NAME = 5;
const COMPONENT_LORE = 8;
const COMPONENT_ENCHANTMENT_GLINT = 18;

const PACKET_SET_SLOT_ID = 0x14;
const PACKET_SOUND_EFFECT_ID = 0x73;

const SOUND_COUNTDOWN_3 = 'block.amethyst_block.hit';
const SOUND_COUNTDOWN_2 = 'block.amethyst_block.chime';
const SOUND_COUNTDOWN_1 = 'block.amethyst_cluster.break';
const SOUND_TELEPORT = 'entity.enderman.teleport';
const SOUND_CANCEL = 'block.amethyst_block.fall';

const WINDOW_MAIN_MENU = 100;
const WINDOW_PLAYERS_MENU = 101;
const WINDOW_PLAYER_ACTION_MENU = 102;
const WINDOW_WORLD_SPAWN_MENU = 103;

const TELEPORT_DELAY_MS = 3000;
const TELEPORT_COOLDOWN_MS = 10000;
const TP_REQUEST_TIMEOUT_MS = 60000;
const MOVEMENT_CANCEL_THRESHOLD = 0.1;
const RANDOM_TP_RANGE = 30000;

const TIER_CONFIG = {
  1: { charges: 1, name: 'Tier 1', color: 'green' },
  2: { charges: 3, name: 'Tier 2', color: 'aqua' },
  3: { charges: 5, name: 'Tier 3', color: 'light_purple' },
} as const;

type CrystalTier = 1 | 2 | 3;

interface CrystalData {
  tier: CrystalTier;
  charges: number;
}

type MenuType = 'main' | 'players' | 'player_action' | 'world_spawn';

interface MenuState {
  type: MenuType;
  windowId: number;
  targetPlayerUuid?: string;
  playerList?: OnlinePlayer[];
}

interface TeleportCountdown {
  timer: ReturnType<typeof setTimeout>;
  tickTimer: ReturnType<typeof setInterval>;
  startPosition: { x: number; y: number; z: number };
  consumeCharge: boolean;
}

interface TpRequest {
  requesterUuid: string;
  targetUuid: string;
  direction: 'to_target' | 'target_to_me';
  timestamp: number;
  timeout: ReturnType<typeof setTimeout>;
}

const crystalData = new WeakMap<OnlinePlayer, CrystalData>();
const activeMenus = new WeakMap<OnlinePlayer, MenuState>();
const teleportCountdowns = new WeakMap<OnlinePlayer, TeleportCountdown>();
const cooldowns = new WeakMap<OnlinePlayer, number>();
const playerPositions = new WeakMap<OnlinePlayer, { x: number; y: number; z: number }>();
const tpRequests = new Map<string, TpRequest>();

function buildRawPacket(packetId: number, ...fields: Buffer[]): Buffer {
  const content = Buffer.concat([varInt(packetId), ...fields]);
  return Buffer.concat([varInt(content.length), content]);
}

function buildItemBuffer(
  itemId: number,
  name: string,
  nameColor: string,
  loreLines?: string[],
  glint = false,
  customData?: Record<string, unknown>
): Buffer {
  const parts: Buffer[] = [varInt(1), varInt(itemId)];

  let componentCount = 1;
  if (loreLines && loreLines.length > 0) componentCount++;
  if (glint) componentCount++;
  if (customData) componentCount++;

  parts.push(varInt(componentCount));
  parts.push(varInt(0));

  parts.push(varInt(COMPONENT_CUSTOM_NAME));
  parts.push(anonymousNbt({ text: name, color: nameColor, italic: false }));

  if (loreLines && loreLines.length > 0) {
    parts.push(varInt(COMPONENT_LORE));
    parts.push(varInt(loreLines.length));
    for (const line of loreLines) {
      parts.push(anonymousNbt({ text: line, color: 'gray', italic: false }));
    }
  }

  if (glint) {
    parts.push(varInt(COMPONENT_ENCHANTMENT_GLINT));
    parts.push(Buffer.from([0x01]));
  }

  if (customData) {
    parts.push(varInt(COMPONENT_CUSTOM_DATA));
    parts.push(anonymousNbt(customData));
  }

  return Buffer.concat(parts);
}

function buildCrystalItem(tier: CrystalTier, charges: number): Buffer {
  const config = TIER_CONFIG[tier];
  return buildItemBuffer(
    ITEM_ECHO_SHARD,
    `Teleportation Crystal (${config.name})`,
    config.color,
    [`Charges: ${charges}/${config.charges}`, 'Right-click to use'],
    true,
    { teleportation_crystal: 1, tier, charges }
  );
}

function sendSetSlot(player: OnlinePlayer, windowId: number, slotIndex: number, itemBuffer: Buffer): void {
  const socket = getPlayerSocket(player);
  if (!socket) return;
  const packet = buildRawPacket(PACKET_SET_SLOT_ID, varInt(windowId), varInt(0), short(slotIndex), itemBuffer);
  safeWrite(socket, packet);
}

function sendSoundEffect(player: OnlinePlayer, soundName: string, volume: number, pitch: number): void {
  const socket = getPlayerSocket(player);
  if (!socket) return;

  const pos = playerPositions.get(player);
  if (!pos) return;

  const parts: Buffer[] = [];

  parts.push(varInt(0));
  parts.push(string(soundName));
  parts.push(Buffer.from([0x00]));
  parts.push(varInt(7));

  const xBuf = Buffer.alloc(4);
  xBuf.writeInt32BE(Math.round(pos.x * 8));
  parts.push(xBuf);
  const yBuf = Buffer.alloc(4);
  yBuf.writeInt32BE(Math.round(pos.y * 8));
  parts.push(yBuf);
  const zBuf = Buffer.alloc(4);
  zBuf.writeInt32BE(Math.round(pos.z * 8));
  parts.push(zBuf);

  const volBuf = Buffer.alloc(4);
  volBuf.writeFloatBE(volume);
  parts.push(volBuf);
  const pitchBuf = Buffer.alloc(4);
  pitchBuf.writeFloatBE(pitch);
  parts.push(pitchBuf);

  const seedBuf = Buffer.alloc(8);
  seedBuf.writeBigInt64BE(BigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER)));
  parts.push(seedBuf);

  safeWrite(socket, buildRawPacket(PACKET_SOUND_EFFECT_ID, ...parts));
}

function closeActiveMenu(player: OnlinePlayer): void {
  const menu = activeMenus.get(player);
  if (menu) {
    const socket = getPlayerSocket(player);
    if (socket) {
      safeWrite(socket, writePacket(closeWindowClientPacket, { windowId: menu.windowId }));
    }
    activeMenus.delete(player);
  }
}

function openMainMenu(player: OnlinePlayer): void {
  closeActiveMenu(player);

  const socket = getPlayerSocket(player);
  if (!socket) return;

  safeWrite(
    socket,
    writePacket(openWindowPacket, { windowId: WINDOW_MAIN_MENU, inventoryType: 0, windowTitle: { text: '✦ Teleportation Crystal' } })
  );
  activeMenus.set(player, { type: 'main', windowId: WINDOW_MAIN_MENU });

  const crystal = crystalData.get(player);
  const chargeText = crystal ? `${crystal.charges}/${TIER_CONFIG[crystal.tier].charges}` : '0';

  sendSetSlot(
    player,
    WINDOW_MAIN_MENU,
    0,
    buildItemBuffer(ITEM_RED_BED, 'Bed Spawn', 'yellow', ['Teleport to your spawn point', `Charges: ${chargeText}`])
  );
  sendSetSlot(
    player,
    WINDOW_MAIN_MENU,
    1,
    buildItemBuffer(ITEM_GRASS_BLOCK, 'Random Teleport', 'green', ['Safe random teleport', '30,000 x 30,000 range', `Charges: ${chargeText}`])
  );
  sendSetSlot(
    player,
    WINDOW_MAIN_MENU,
    2,
    buildItemBuffer(ITEM_PLAYER_HEAD, 'Player Teleport', 'aqua', ['Teleport to or summon', 'an online player'])
  );
  sendSetSlot(player, WINDOW_MAIN_MENU, 3, buildItemBuffer(ITEM_BEACON, 'World Spawn', 'gold', ['Teleport to a world spawn']));
  sendSetSlot(player, WINDOW_MAIN_MENU, 4, buildItemBuffer(ITEM_WHITE_BANNER, 'Embassy', 'light_purple', ['Will soon be implemented']));
  sendSetSlot(
    player,
    WINDOW_MAIN_MENU,
    5,
    buildItemBuffer(ITEM_GLOBE_BANNER_PATTERN, 'Switch Server', 'white', ['Shortcut for /switch', 'Does not consume charges'])
  );

  for (let i = 6; i < 9; i++) {
    sendSetSlot(player, WINDOW_MAIN_MENU, i, buildItemBuffer(ITEM_BARRIER, ' ', 'dark_gray'));
  }
}

function openPlayersMenu(player: OnlinePlayer): void {
  closeActiveMenu(player);

  const onlinePlayers = OnlinePlayersModule.api.getOnlinePlayers().filter((op) => op.uuid !== player.uuid);
  if (onlinePlayers.length === 0) {
    player.sendMessage(p.error`No other players are online`);
    return;
  }

  const socket = getPlayerSocket(player);
  if (!socket) return;

  const rows = Math.min(Math.ceil(onlinePlayers.length / 9), 6);
  const inventoryType = Math.max(0, rows - 1);
  safeWrite(socket, writePacket(openWindowPacket, { windowId: WINDOW_PLAYERS_MENU, inventoryType, windowTitle: { text: '✦ Online Players' } }));
  activeMenus.set(player, { type: 'players', windowId: WINDOW_PLAYERS_MENU, playerList: onlinePlayers });

  for (let i = 0; i < onlinePlayers.length && i < rows * 9; i++) {
    const target = onlinePlayers[i]!;
    sendSetSlot(player, WINDOW_PLAYERS_MENU, i, buildItemBuffer(ITEM_PLAYER_HEAD, target.username, 'green', ['Click to send a TP request']));
  }
}

function openPlayerActionMenu(player: OnlinePlayer, target: OnlinePlayer): void {
  closeActiveMenu(player);

  const socket = getPlayerSocket(player);
  if (!socket) return;

  safeWrite(
    socket,
    writePacket(openWindowPacket, { windowId: WINDOW_PLAYER_ACTION_MENU, inventoryType: 0, windowTitle: { text: `✦ Teleport — ${target.username}` } })
  );
  activeMenus.set(player, { type: 'player_action', windowId: WINDOW_PLAYER_ACTION_MENU, targetPlayerUuid: target.uuid });

  sendSetSlot(
    player,
    WINDOW_PLAYER_ACTION_MENU,
    3,
    buildItemBuffer(ITEM_ENDER_EYE, 'Request TP to them', 'green', [`Teleport to ${target.username}`])
  );
  sendSetSlot(
    player,
    WINDOW_PLAYER_ACTION_MENU,
    5,
    buildItemBuffer(ITEM_CHORUS_FRUIT, 'Request they TP to me', 'aqua', [`Ask ${target.username} to come to you`])
  );

  for (const i of [0, 1, 2, 4, 6, 7, 8]) {
    sendSetSlot(player, WINDOW_PLAYER_ACTION_MENU, i, buildItemBuffer(ITEM_BARRIER, ' ', 'dark_gray'));
  }
}

function openWorldSpawnMenu(player: OnlinePlayer): void {
  closeActiveMenu(player);

  const socket = getPlayerSocket(player);
  if (!socket) return;

  safeWrite(socket, writePacket(openWindowPacket, { windowId: WINDOW_WORLD_SPAWN_MENU, inventoryType: 0, windowTitle: { text: '✦ World Spawn' } }));
  activeMenus.set(player, { type: 'world_spawn', windowId: WINDOW_WORLD_SPAWN_MENU });

  sendSetSlot(player, WINDOW_WORLD_SPAWN_MENU, 3, buildItemBuffer(ITEM_GRASS_BLOCK, 'Primary World', 'green', ['Teleport to Primary spawn']));
  sendSetSlot(player, WINDOW_WORLD_SPAWN_MENU, 5, buildItemBuffer(ITEM_BEACON, 'Secondary World', 'aqua', ['Teleport to Secondary spawn']));

  for (const i of [0, 1, 2, 4, 6, 7, 8]) {
    sendSetSlot(player, WINDOW_WORLD_SPAWN_MENU, i, buildItemBuffer(ITEM_BARRIER, ' ', 'dark_gray'));
  }
}

function handleMenuClick(player: OnlinePlayer, packetData: Buffer): void {
  const menu = activeMenus.get(player);
  if (!menu) return;

  const windowIdInfo = varInt.readWithBytesCount(packetData);
  if (windowIdInfo.value !== menu.windowId) return;

  const stateIdInfo = varInt.readWithBytesCount(packetData.subarray(windowIdInfo.bytesRead));
  const slotOffset = windowIdInfo.bytesRead + stateIdInfo.bytesRead;
  const clickedSlot = packetData.readInt16BE(slotOffset);

  switch (menu.type) {
    case 'main':
      handleMainMenuClick(player, clickedSlot);
      break;
    case 'players':
      handlePlayersMenuClick(player, clickedSlot);
      break;
    case 'player_action':
      handlePlayerActionClick(player, clickedSlot);
      break;
    case 'world_spawn':
      handleWorldSpawnClick(player, clickedSlot);
      break;
  }
}

function handleMainMenuClick(player: OnlinePlayer, clickedSlot: number): void {
  closeActiveMenu(player);

  switch (clickedSlot) {
    case 0:
      initiateTeleport(player, 'bed');
      break;
    case 1:
      initiateTeleport(player, 'random');
      break;
    case 2:
      openPlayersMenu(player);
      break;
    case 3:
      openWorldSpawnMenu(player);
      break;
    case 4:
      // TODO: Embassy teleport
      player.sendMessage(p.gray`Will soon be implemented`);
      break;
    case 5:
      handleSwitchShortcut(player);
      break;
  }
}

function handlePlayersMenuClick(player: OnlinePlayer, clickedSlot: number): void {
  const menu = activeMenus.get(player);
  if (!menu?.playerList) return;

  const target = menu.playerList[clickedSlot];
  if (!target?.isOnline) {
    closeActiveMenu(player);
    player.sendMessage(p.error`That player is no longer online`);
    return;
  }

  openPlayerActionMenu(player, target);
}

function handlePlayerActionClick(player: OnlinePlayer, clickedSlot: number): void {
  const menu = activeMenus.get(player);
  if (!menu?.targetPlayerUuid) return;

  const target = OnlinePlayersModule.api.getOnlinePlayer(menu.targetPlayerUuid);
  if (!target) {
    closeActiveMenu(player);
    player.sendMessage(p.error`That player is no longer online`);
    return;
  }

  closeActiveMenu(player);

  if (clickedSlot === 3) {
    sendTpRequest(player, target, 'to_target');
  } else if (clickedSlot === 5) {
    sendTpRequest(player, target, 'target_to_me');
  }
}

function handleWorldSpawnClick(player: OnlinePlayer, clickedSlot: number): void {
  closeActiveMenu(player);

  if (clickedSlot === 3) {
    initiateTeleport(player, 'primary_spawn');
  } else if (clickedSlot === 5) {
    initiateTeleport(player, 'secondary_spawn');
  }
}

async function handleSwitchShortcut(player: OnlinePlayer): Promise<void> {
  const currentPort = player.currentServerPort || kPrimaryPort;
  const newPort = currentPort === kPrimaryPort ? kSecondaryPort : kPrimaryPort;
  const serverName = newPort === kPrimaryPort ? 'Primary' : 'Secondary';

  try {
    player.sendMessage(p.gray`Switching to ${p.green(serverName)}...`);
    await player.switchServer(newPort);
  } catch (error) {
    player.sendMessage(p.error`Failed to switch server: ${error}`);
  }
}

type TeleportDestination = 'bed' | 'random' | 'primary_spawn' | 'secondary_spawn' | { type: 'player'; uuid: string };

function initiateTeleport(player: OnlinePlayer, destination: TeleportDestination): void {
  const crystal = crystalData.get(player);
  if (!crystal || crystal.charges <= 0) {
    player.sendMessage(p.error`Your crystal has no charges remaining`);
    return;
  }

  const lastTp = cooldowns.get(player);
  if (lastTp) {
    const remaining = TELEPORT_COOLDOWN_MS - (Date.now() - lastTp);
    if (remaining > 0) {
      player.sendMessage(p.error`Teleportation on cooldown: ${Math.ceil(remaining / 1000)}s remaining`);
      return;
    }
  }

  startTeleportCountdown(player, destination, true);
}

function startTeleportCountdown(player: OnlinePlayer, destination: TeleportDestination, consumeCharge: boolean): void {
  cancelTeleportCountdown(player);

  const pos = playerPositions.get(player);
  if (!pos) {
    player.sendMessage(p.error`Could not determine your position. Try moving first.`);
    return;
  }

  player.sendMessage(p.gray`Teleporting in ${p.green('3')} seconds... Don't move!`);
  sendSoundEffect(player, SOUND_COUNTDOWN_3, 1.0, 0.5);

  let remainingSeconds = 3;

  const tickTimer = setInterval(() => {
    remainingSeconds--;
    if (!teleportCountdowns.has(player)) {
      clearInterval(tickTimer);
      return;
    }

    if (remainingSeconds === 2) {
      player.sendMessage(p.gray`Teleporting in ${p.yellow('2')} seconds...`);
      sendSoundEffect(player, SOUND_COUNTDOWN_2, 1.0, 0.8);
    } else if (remainingSeconds === 1) {
      player.sendMessage(p.gray`Teleporting in ${p.red('1')} second...`);
      sendSoundEffect(player, SOUND_COUNTDOWN_1, 1.0, 1.2);
    }
  }, 1000);

  const timer = setTimeout(() => {
    const countdown = teleportCountdowns.get(player);
    if (!countdown) return;
    clearInterval(countdown.tickTimer);
    teleportCountdowns.delete(player);
    executeTeleport(player, destination, consumeCharge);
  }, TELEPORT_DELAY_MS);

  teleportCountdowns.set(player, { timer, tickTimer, startPosition: { ...pos }, consumeCharge });
}

function cancelTeleportCountdown(player: OnlinePlayer): void {
  const countdown = teleportCountdowns.get(player);
  if (countdown) {
    clearTimeout(countdown.timer);
    clearInterval(countdown.tickTimer);
    teleportCountdowns.delete(player);
  }
}

function checkMovementCancel(player: OnlinePlayer, newPos: { x: number; y: number; z: number }): void {
  const countdown = teleportCountdowns.get(player);
  if (!countdown) return;

  const dx = newPos.x - countdown.startPosition.x;
  const dy = newPos.y - countdown.startPosition.y;
  const dz = newPos.z - countdown.startPosition.z;

  if (Math.sqrt(dx * dx + dy * dy + dz * dz) > MOVEMENT_CANCEL_THRESHOLD) {
    cancelTeleportCountdown(player);
    sendSoundEffect(player, SOUND_CANCEL, 0.8, 0.5);
    player.sendMessage(p.error`Teleport cancelled — you moved!`);
  }
}

function executeTeleport(player: OnlinePlayer, destination: TeleportDestination, consumeCharge: boolean): void {
  if (consumeCharge) {
    const crystal = crystalData.get(player);
    if (!crystal || crystal.charges <= 0) {
      player.sendMessage(p.error`No charges remaining`);
      return;
    }
    crystal.charges--;
    if (crystal.charges <= 0) {
      crystalData.delete(player);
      player.sendMessage(p.gray`Your Teleportation Crystal has been consumed`);
    } else {
      updateCrystalInHand(player);
    }
  }

  cooldowns.set(player, Date.now());
  sendSoundEffect(player, SOUND_TELEPORT, 1.0, 1.0);

  if (destination === 'bed') {
    sendServerCommand(player, 'teleport @s 0 ~1 0');
    player.sendMessage(p.gray`Teleporting to bed spawn...`);
  } else if (destination === 'random') {
    const x = Math.floor(Math.random() * RANDOM_TP_RANGE) - RANDOM_TP_RANGE / 2;
    const z = Math.floor(Math.random() * RANDOM_TP_RANGE) - RANDOM_TP_RANGE / 2;
    sendServerCommand(player, `spreadplayers ${x} ${z} 0 5 false @s`);
    player.sendMessage(p.success`Teleported to random location!`);
  } else if (destination === 'primary_spawn') {
    if (player.currentServerPort === kPrimaryPort) {
      sendServerCommand(player, 'tp @s 0 ~1 0');
      player.sendMessage(p.success`Teleported to Primary world spawn`);
    } else {
      player.sendMessage(p.gray`Switching to Primary server...`);
      player.switchServer(kPrimaryPort).catch((e) => {
        player.sendMessage(p.error`Failed to switch: ${e}`);
      });
    }
  } else if (destination === 'secondary_spawn') {
    if (player.currentServerPort === kSecondaryPort) {
      sendServerCommand(player, 'tp @s 0 ~1 0');
      player.sendMessage(p.success`Teleported to Secondary world spawn`);
    } else {
      player.sendMessage(p.gray`Switching to Secondary server...`);
      player.switchServer(kSecondaryPort).catch((e) => {
        player.sendMessage(p.error`Failed to switch: ${e}`);
      });
    }
  } else if (typeof destination === 'object' && destination.type === 'player') {
    const target = OnlinePlayersModule.api.getOnlinePlayer(destination.uuid);
    if (!target) {
      player.sendMessage(p.error`Target player is no longer online`);
      return;
    }
    if (target.currentServerPort !== player.currentServerPort) {
      player.sendMessage(p.gray`Switching to ${target.username}'s server...`);
      player
        .switchServer(target.currentServerPort)
        .then(() => {
          sendServerCommand(player, `tp @s ${target.username}`);
          player.sendMessage(p.success`Teleported to ${p.green(target.username)}!`);
        })
        .catch((e) => {
          player.sendMessage(p.error`Failed to teleport: ${e}`);
        });
    } else {
      sendServerCommand(player, `tp @s ${target.username}`);
      player.sendMessage(p.success`Teleported to ${p.green(target.username)}!`);
    }
  }
}

function sendServerCommand(player: OnlinePlayer, command: string): void {
  const serverSocket = getServerSocket(player);
  if (!serverSocket) {
    log.for('TeleportCrystal').warn('No server socket for %s', player.username);
    return;
  }
  safeWrite(serverSocket, writePacket(chatCommandPacket, { command }));
}

function updateCrystalInHand(player: OnlinePlayer): void {
  const crystal = crystalData.get(player);
  if (!crystal) return;
  sendSetSlot(player, 0, 36, buildCrystalItem(crystal.tier, crystal.charges));
}

function sendTpRequest(requester: OnlinePlayer, target: OnlinePlayer, direction: 'to_target' | 'target_to_me'): void {
  const crystal = crystalData.get(requester);
  if (!crystal || crystal.charges <= 0) {
    requester.sendMessage(p.error`Your crystal has no charges remaining`);
    return;
  }

  const lastTp = cooldowns.get(requester);
  if (lastTp) {
    const remaining = TELEPORT_COOLDOWN_MS - (Date.now() - lastTp);
    if (remaining > 0) {
      requester.sendMessage(p.error`Teleportation on cooldown: ${Math.ceil(remaining / 1000)}s remaining`);
      return;
    }
  }

  const existingRequest = tpRequests.get(target.uuid);
  if (existingRequest) {
    clearTimeout(existingRequest.timeout);
    tpRequests.delete(target.uuid);
  }

  const timeout = setTimeout(() => {
    tpRequests.delete(target.uuid);
    const req = OnlinePlayersModule.api.getOnlinePlayer(requester.uuid);
    if (req) {
      req.sendMessage(p.gray`Your teleport request to ${p.yellow(target.username)} has expired`);
    }
  }, TP_REQUEST_TIMEOUT_MS);

  tpRequests.set(target.uuid, {
    requesterUuid: requester.uuid,
    targetUuid: target.uuid,
    direction,
    timestamp: Date.now(),
    timeout,
  });

  if (direction === 'to_target') {
    requester.sendMessage(p.gray`Sent TP request to ${p.green(target.username)}`);
    target.sendMessage(
      p`${p.green(requester.username)} wants to teleport ${p.yellow('to you')}. Type ${p.green('/tpaccept')} or ${p.red('/tpdeny')}`
    );
  } else {
    requester.sendMessage(p.gray`Sent TP request to ${p.green(target.username)}`);
    target.sendMessage(
      p`${p.green(requester.username)} wants ${p.yellow('you to teleport to them')}. Type ${p.green('/tpaccept')} or ${p.red('/tpdeny')}`
    );
  }
}

function acceptTpRequest(player: OnlinePlayer): void {
  const request = tpRequests.get(player.uuid);
  if (!request) {
    player.sendMessage(p.error`You have no pending teleport requests`);
    return;
  }

  clearTimeout(request.timeout);
  tpRequests.delete(player.uuid);

  const requester = OnlinePlayersModule.api.getOnlinePlayer(request.requesterUuid);
  if (!requester) {
    player.sendMessage(p.error`The requesting player is no longer online`);
    return;
  }

  const crystal = crystalData.get(requester);
  if (!crystal || crystal.charges <= 0) {
    player.sendMessage(p.gray`The request was cancelled (no charges remaining)`);
    requester.sendMessage(p.error`Teleport cancelled — no charges remaining`);
    return;
  }

  player.sendMessage(p.success`Teleport request accepted!`);
  requester.sendMessage(p.success`${p.green(player.username)} accepted your teleport request!`);

  if (request.direction === 'to_target') {
    startTeleportCountdown(requester, { type: 'player', uuid: player.uuid }, true);
  } else {
    startTeleportCountdown(player, { type: 'player', uuid: requester.uuid }, false);
    crystal.charges--;
    if (crystal.charges <= 0) {
      crystalData.delete(requester);
      requester.sendMessage(p.gray`Your Teleportation Crystal has been consumed`);
    } else {
      updateCrystalInHand(requester);
    }
  }
}

function denyTpRequest(player: OnlinePlayer): void {
  const request = tpRequests.get(player.uuid);
  if (!request) {
    player.sendMessage(p.error`You have no pending teleport requests`);
    return;
  }

  clearTimeout(request.timeout);
  tpRequests.delete(player.uuid);

  const requester = OnlinePlayersModule.api.getOnlinePlayer(request.requesterUuid);
  player.sendMessage(p.gray`Teleport request denied`);
  if (requester) {
    requester.sendMessage(p.error`${p.red(player.username)} denied your teleport request`);
  }
}

function getCraftingRequirements(tier: CrystalTier): string {
  switch (tier) {
    case 1:
      return '1x Eye of Ender';
    case 2:
      return '1x Tier 1 Crystal + 4x Chorus Fruit';
    case 3:
      return '1x Tier 2 Crystal + 4x Echo Shard';
  }
}

export default defineFeature({
  name: 'TeleportationCrystal',
  onEnable: () => {
    onClientToServerPacket((proxyPlayer, packetId, packetData) => {
      const player = OnlinePlayersModule.api.getOnlinePlayer(proxyPlayer.uuid);
      if (!player) return false;

      if (packetId === playerUseItemPacket.id && crystalData.has(player)) {
        openMainMenu(player);
        return true;
      }

      if (packetId === 0x10) {
        const menu = activeMenus.get(player);
        if (menu) {
          const windowIdValue = varInt.read(packetData);
          if (windowIdValue === menu.windowId) {
            handleMenuClick(player, packetData);
            return true;
          }
        }
      }

      if (packetId === 0x12) {
        const menu = activeMenus.get(player);
        if (menu) {
          const windowIdValue = varInt.read(packetData);
          if (windowIdValue === menu.windowId) {
            activeMenus.delete(player);
            return true;
          }
        }
      }

      return false;
    });

    registerHook(FeatureHook.PlayerMove, ({ player, to }) => {
      playerPositions.set(player, { x: to.x, y: to.y, z: to.z });
      checkMovementCancel(player, to);
    });

    registerHook(FeatureHook.PlayerLeave, ({ player }) => {
      cancelTeleportCountdown(player);
      activeMenus.delete(player);
      playerPositions.delete(player);
      crystalData.delete(player);
      cooldowns.delete(player);

      for (const [key, request] of tpRequests) {
        if (request.requesterUuid === player.uuid || request.targetUuid === player.uuid) {
          clearTimeout(request.timeout);
          tpRequests.delete(key);

          const otherUuid = request.requesterUuid === player.uuid ? request.targetUuid : request.requesterUuid;
          const other = OnlinePlayersModule.api.getOnlinePlayer(otherUuid);
          if (other) {
            other.sendMessage(p.gray`Teleport request cancelled — player disconnected`);
          }
        }
      }
    });

    registerCommand(syntax`tpcrystal give ${syntax.oneOf('tier', ['1', '2', '3'] as const)}`, ({ sender, args }) => {
      const tier = Number.parseInt(args.tier, 10) as CrystalTier;
      const config = TIER_CONFIG[tier];
      crystalData.set(sender, { tier, charges: config.charges });
      sendSetSlot(sender, 0, 36, buildCrystalItem(tier, config.charges));
      return p.success`Received a ${p.green(`Teleportation Crystal (${config.name})`)} with ${p.yellow(String(config.charges))} charges`;
    });

    registerCommand(syntax`tpcrystal`, ({ sender }) => {
      if (crystalData.has(sender)) {
        openMainMenu(sender);
        return;
      }
      return p.gray`You don't have a Teleportation Crystal. Use ${p.green('/tpcrystal give <1|2|3>')} to obtain one.`;
    });

    registerCommand(syntax`tpcrystal craft ${syntax.oneOf('tier', ['1', '2', '3'] as const)}`, ({ args }) => {
      const tier = Number.parseInt(args.tier, 10) as CrystalTier;
      // TODO: Validate player has required materials in inventory
      return p.gray`Crafting requires: ${p.yellow(getCraftingRequirements(tier))}. (Server-side crafting not yet implemented)`;
    });

    registerCommand(syntax`tpaccept`, ({ sender }) => {
      acceptTpRequest(sender);
    });

    registerCommand(syntax`tpdeny`, ({ sender }) => {
      denyTpRequest(sender);
    });

    log.for('TeleportCrystal').info('Teleportation Crystal feature enabled');
  },
});
