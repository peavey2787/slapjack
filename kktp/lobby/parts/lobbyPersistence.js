/**
 * @fileoverview Lobby persistence - export and restore lobby state.
 *
 * Provides serialization and deserialization of lobby state for session
 * persistence across page reloads or reconnections. Called by SessionVault.
 *
 * @module kktp/lobby/parts/lobbyPersistence
 */

import { LOBBY_STATES } from "./lobbyContext.js";
import { uint8ToHex, hexToUint8 } from "./lobbyUtils.js";
import { subscribePrefix } from "./lobbySubscriptions.js";
import { startKeyRotation } from "./lobbyKeys.js";
import { Logger, LogModule } from "../../core/logger.js";

const log = Logger.create(LogModule.lobby.parts.lobbyPersistence);

const SNAPSHOT_VERSION = 1;

/**
 * Export current lobby state as a serializable snapshot.
 * @param {Object} ctx - Lobby context
 * @returns {Object|null} Serialized snapshot or null if no active lobby
 */
export function exportLobbyState(ctx) {
  const { state, lobby, keyVault, subscriptions, callbacks, hostDmMailboxId } = ctx;

  if (!lobby || state === LOBBY_STATES.IDLE) {
    return null;
  }

  // Serialize members Map to array
  const membersArray = [];
  for (const [, member] of lobby.members.entries()) {
    membersArray.push({
      pubSig: member.pubSig,
      displayName: member.displayName,
      role: member.role,
      joinedAt: member.joinedAt,
      dmMailboxId: member.dmMailboxId || null,
    });
  }

  const snapshot = {
    version: SNAPSHOT_VERSION,
    state,
    lobby: {
      lobbyId: lobby.lobbyId,
      lobbyName: lobby.lobbyName,
      hostPubSig: lobby.hostPubSig,
      myPubSig: lobby.myPubSig || null,
      groupKey: uint8ToHex(lobby.groupKey),
      keyVersion: lobby.keyVersion,
      groupMailboxId: lobby.groupMailboxId,
      maxMembers: lobby.maxMembers,
      createdAt: lobby.createdAt,
      dmMailboxId: lobby.dmMailboxId || null,
      members: membersArray,
    },
    keyVault: {
      current: keyVault.current
        ? {
            key: uint8ToHex(keyVault.current.key),
            version: keyVault.current.version,
          }
        : null,
      previous: keyVault.previous
        ? {
            key: uint8ToHex(keyVault.previous.key),
            version: keyVault.previous.version,
          }
        : null,
    },
    subscribedPrefixes: [...subscriptions],
    hostDmMailboxId: hostDmMailboxId || null,
    savedAt: Date.now(),
  };

  log.info("KKTP Lobby: exportLobbyState", {
    state,
    lobbyId: lobby.lobbyId?.slice(0, 16),
    memberCount: membersArray.length,
    prefixCount: subscriptions.size,
  });

  return snapshot;
}

/**
 * Resubscribe to all saved prefixes after restore.
 * @param {Object} ctx - Lobby context
 * @param {string[]} prefixes - Array of prefix strings to resubscribe
 * @returns {Promise<void>}
 */
async function resubscribePrefixes(ctx, prefixes) {
  const { adapter, subscriptions } = ctx;

  if (!adapter) {
    log.warn("KKTP Lobby: No adapter available for prefix resubscription");
    return;
  }

  for (const prefix of prefixes) {
    try {
      await adapter.subscribeToPrefix(prefix);
      subscriptions.add(prefix);
    } catch (err) {
      log.warn(
        `KKTP Lobby: Failed to resubscribe to prefix ${prefix?.slice(0, 16)}...`,
        err?.message || err
      );
    }
  }

  log.info("KKTP Lobby: Resubscribed to prefixes", {
    count: subscriptions.size,
  });
}

/**
 * Restore lobby state from a previously exported snapshot.
 * Called by SessionVault.restoreSessions() after restoring 1:1 sessions.
 * @param {Object} ctx - Lobby context
 * @param {Object} snapshot - Previously exported lobby state
 * @returns {Promise<boolean>} True if restore succeeded
 */
export async function restoreLobbyState(ctx, snapshot) {
  const { state, subscriptions, callbacks } = ctx;

  if (!snapshot || !snapshot.lobby) {
    log.info("KKTP Lobby: No lobby state to restore");
    return false;
  }

  try {
    const {
      lobby: savedLobby,
      state: savedState,
      keyVault: savedKeyVault,
      subscribedPrefixes,
      hostDmMailboxId,
    } = snapshot;

    // Rebuild members Map from array
    const membersMap = new Map();
    if (Array.isArray(savedLobby.members)) {
      for (const m of savedLobby.members) {
        membersMap.set(m.pubSig, {
          pubSig: m.pubSig,
          displayName: m.displayName,
          role: m.role,
          joinedAt: m.joinedAt,
          dmMailboxId: m.dmMailboxId || null,
        });
      }
    }

    // Restore lobby object
    ctx.lobby = {
      lobbyId: savedLobby.lobbyId,
      lobbyName: savedLobby.lobbyName,
      hostPubSig: savedLobby.hostPubSig,
      myPubSig: savedLobby.myPubSig || null,
      members: membersMap,
      groupKey: hexToUint8(savedLobby.groupKey),
      keyVersion: savedLobby.keyVersion,
      groupMailboxId: savedLobby.groupMailboxId,
      maxMembers: savedLobby.maxMembers,
      createdAt: savedLobby.createdAt,
      state: savedState,
      dmMailboxId: savedLobby.dmMailboxId || null,
    };

    // Restore key vault
    ctx.keyVault = {
      current: savedKeyVault?.current
        ? {
            key: hexToUint8(savedKeyVault.current.key),
            version: savedKeyVault.current.version,
          }
        : null,
      previous: savedKeyVault?.previous
        ? {
            key: hexToUint8(savedKeyVault.previous.key),
            version: savedKeyVault.previous.version,
          }
        : null,
    };

    // Restore host DM mailbox ID (for members)
    ctx.hostDmMailboxId = hostDmMailboxId || null;

    // Set state
    ctx.state = savedState;

    // Re-subscribe to all prefixes
    if (Array.isArray(subscribedPrefixes) && subscribedPrefixes.length > 0) {
      await resubscribePrefixes(ctx, subscribedPrefixes);
    }

    // Restart key rotation timer if host
    if (savedState === LOBBY_STATES.HOSTING) {
      startKeyRotation(ctx);
    }

    log.info("KKTP Lobby: restoreLobbyState complete", {
      state: ctx.state,
      lobbyId: ctx.lobby.lobbyId?.slice(0, 16),
      memberCount: ctx.lobby.members.size,
      prefixCount: subscriptions.size,
      isHost: savedState === LOBBY_STATES.HOSTING,
    });

    // Emit state change event
    if (callbacks.onStateChange) {
      callbacks.onStateChange(savedState, LOBBY_STATES.IDLE);
    }

    return true;
  } catch (err) {
    log.error("KKTP Lobby: restoreLobbyState failed", err?.message || err);
    return false;
  }
}
