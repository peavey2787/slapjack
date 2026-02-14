/**
 * LobbyKeys - Key management and rotation
 *
 * Handles key vault management, key rotation (host), and key rotation
 * handling (member). Uses epoch versioning to handle race conditions.
 *
 * @module kktp/lobby/parts/lobbyKeys
 */

import { LOBBY_STATES, LOBBY_VERSION, MEMBER_ROLES } from "./lobbyContext.js";
import { generateGroupKey, uint8ToHex, hexToUint8, computeStateRoot, truncate } from "./lobbyUtils.js";
import { waitForUtxoRefresh, sendWithRetry } from "./lobbyUtxo.js";
import { processBufferedFutureMessages } from "./lobbyMessaging.js";
import { validateKeyRotation } from "../lobbySchemas.js";
import { Logger, LogModule } from "../../core/logger.js";

const log = Logger.create(LogModule.lobby.parts.lobbyKeys);

/**
 * Initialize the key vault with a new key
 * @param {import("./lobbyContext.js").LobbyContext} ctx
 * @param {Uint8Array} key
 * @param {number} version
 */
export function initKeyVault(ctx, key, version) {
  ctx.keyVault = {
    current: { key, version },
    previous: null,
  };
  ctx.futureMessageBuffer = [];
}

/**
 * Update the key vault with a new key (rotates current to previous)
 * @param {import("./lobbyContext.js").LobbyContext} ctx
 * @param {Uint8Array} newKey
 * @param {number} newVersion
 */
export function updateKeyVault(ctx, newKey, newVersion) {
  ctx.keyVault.previous = ctx.keyVault.current;
  ctx.keyVault.current = {
    key: newKey,
    version: newVersion,
  };
}

/**
 * Start the key rotation timer (host only)
 * @param {import("./lobbyContext.js").LobbyContext} ctx
 * @param {function} rotateKeyFn - Function to call for rotation
 */
export function startKeyRotation(ctx, rotateKeyFn = null) {
  if (ctx.keyRotationTimer) return;

  const rotationFn =
    typeof rotateKeyFn === "function"
      ? rotateKeyFn
      : (reason) => rotateKey(ctx, reason);

  ctx.keyRotationTimer = setInterval(async () => {
    try {
      await rotationFn("Scheduled rotation");
    } catch (err) {
      log.error("KKTP Lobby: Key rotation failed", err);
    }
  }, ctx.config.keyRotationMs);
}

/**
 * Stop the key rotation timer
 * @param {import("./lobbyContext.js").LobbyContext} ctx
 */
export function stopKeyRotation(ctx) {
  if (ctx.keyRotationTimer) {
    clearInterval(ctx.keyRotationTimer);
    ctx.keyRotationTimer = null;
  }
}

/**
 * Rotate the group key (host only)
 * Distributes new key to ALL members before updating local state.
 * Uses Key Vault to keep previous key for receiving late messages.
 * @param {import("./lobbyContext.js").LobbyContext} ctx
 * @param {string} [reason="Scheduled rotation"]
 */
export async function rotateKey(ctx, reason = "Scheduled rotation") {
  if (ctx.state !== LOBBY_STATES.HOSTING) {
    throw new Error("Only host can rotate keys");
  }

  // Generate new key
  const newKey = await generateGroupKey();
  const newVersion = ctx.lobby.keyVersion + 1;

  // Compute state root for integrity
  const stateRoot = computeStateRoot(ctx.lobby);

  // Distribute new key to all members via their DM channels
  const distribution = {
    type: "key_rotation",
    version: LOBBY_VERSION,
    lobbyId: ctx.lobby.lobbyId,
    keyVersion: newVersion,
    groupKey: uint8ToHex(newKey),
    stateRoot,
    reason,
    timestamp: Date.now(),
  };

  const distributionJson = JSON.stringify(distribution);

  // Collect all members that need the key (excluding host)
  const membersToNotify = [];
  for (const [pubSig, member] of ctx.lobby.members) {
    if (member.role === MEMBER_ROLES.HOST) continue;
    if (!member.dmMailboxId) {
      log.warn("KKTP Lobby: Member missing dmMailboxId, skipping", {
        pubSig: truncate(pubSig),
      });
      continue;
    }
    membersToNotify.push({ pubSig, member });
  }

  log.info("KKTP Lobby: Starting key rotation distribution", {
    keyVersion: newVersion,
    memberCount: membersToNotify.length,
    reason,
  });

  // Track delivery results
  let successCount = 0;
  let failCount = 0;
  const failedMembers = [];

  // Send to ALL members BEFORE updating local state
  // CRITICAL: Serialize sends with UTXO refresh between each
  for (let i = 0; i < membersToNotify.length; i++) {
    const { pubSig, member } = membersToNotify[i];

    if (i > 0) {
      await waitForUtxoRefresh(ctx);
    }

    try {
      await sendWithRetry(ctx, member.dmMailboxId, distributionJson, 3);
      successCount++;
      log.info("KKTP Lobby: Key rotation sent to member", {
        pubSig: truncate(pubSig),
        keyVersion: newVersion,
        dmMailboxId: truncate(member.dmMailboxId),
      });
    } catch (err) {
      failCount++;
      failedMembers.push(pubSig);
      log.error("KKTP Lobby: Failed to send key rotation to member", {
        pubSig: truncate(pubSig),
        dmMailboxId: truncate(member.dmMailboxId),
        error: err.message,
      });
    }
  }

  // If ALL failed, abort rotation
  if (successCount === 0 && membersToNotify.length > 0) {
    log.error("KKTP Lobby: Key rotation aborted - no members received new key", {
      attemptedCount: membersToNotify.length,
    });
    throw new Error("Key rotation failed: no members received new key");
  }

  // Update key vault
  updateKeyVault(ctx, newKey, newVersion);

  // Update lobby state
  ctx.lobby.groupKey = newKey;
  ctx.lobby.keyVersion = newVersion;

  // Emit event
  ctx.callbacks.onKeyRotation?.(newVersion);

  log.info("KKTP Lobby: Key rotated", {
    version: newVersion,
    previousVersion: ctx.keyVault.previous?.version ?? "none",
    reason,
    memberCount: ctx.lobby.members.size,
    successCount,
    failCount,
    failedMembers: failedMembers.map((p) => truncate(p)),
  });

  if (failedMembers.length > 0) {
    log.warn("KKTP Lobby: Some members missed key rotation", {
      failedMembers: failedMembers.map((p) => truncate(p)),
    });
  }
}

/**
 * Handle key rotation from host (member only)
 * Uses Key Vault to keep previous key for receiving late messages.
 * @param {import("./lobbyContext.js").LobbyContext} ctx
 * @param {Object} codec - LobbyCodec instance
 * @param {Object} rotation - Key rotation message
 */
export async function handleKeyRotation(ctx, codec, rotation) {
  if (ctx.state !== LOBBY_STATES.MEMBER) {
    log.warn("KKTP Lobby: Received key rotation but not a member");
    return;
  }

  try {
    validateKeyRotation(rotation);
  } catch (err) {
    log.warn("KKTP Lobby: Invalid key rotation", err.message);
    return;
  }

  if (rotation.lobbyId !== ctx.lobby.lobbyId) {
    log.warn("KKTP Lobby: Key rotation for wrong lobby");
    return;
  }

  // Verify version progression
  if (rotation.keyVersion <= ctx.lobby.keyVersion) {
    log.warn("KKTP Lobby: Stale key rotation ignored", {
      current: ctx.lobby.keyVersion,
      received: rotation.keyVersion,
    });
    return;
  }

  const newKey = hexToUint8(rotation.groupKey);
  const newVersion = rotation.keyVersion;

  // Update key vault
  updateKeyVault(ctx, newKey, newVersion);

  // Update lobby state
  ctx.lobby.groupKey = newKey;
  ctx.lobby.keyVersion = newVersion;

  // Emit event
  ctx.callbacks.onKeyRotation?.(newVersion);

  log.info("KKTP Lobby: Key updated", {
    version: newVersion,
    previousVersion: ctx.keyVault.previous?.version ?? "none",
    reason: rotation.reason,
  });

  // Process any buffered future messages that were waiting for this key
  await processBufferedFutureMessages(ctx, codec);
}
