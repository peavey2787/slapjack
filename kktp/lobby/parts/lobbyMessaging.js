/**
 * LobbyMessaging - Group messaging and message history
 *
 * Handles sending/receiving group messages, deduplication,
 * and epoch versioning for key rotation race conditions.
 *
 * @module kktp/lobby/parts/lobbyMessaging
 */

import { LOBBY_STATES } from "./lobbyContext.js";
import { truncate } from "./lobbyUtils.js";
import { validateGroupMessage } from "../lobbySchemas.js";
import { Logger, LogModule } from "../../core/logger.js";

const log = Logger.create(LogModule.lobby.parts.lobbyMessaging);

/**
 * Add a message to history
 * @param {import("./lobbyContext.js").LobbyContext} ctx
 * @param {Object} msg - Message to add
 */
export function addToHistory(ctx, msg) {
  ctx.messageHistory.push(msg);
  if (ctx.messageHistory.length > ctx.config.maxHistorySize) {
    ctx.messageHistory.shift();
  }
}

/**
 * Check if a message is a duplicate based on senderPubSig and nonce
 * @param {import("./lobbyContext.js").LobbyContext} ctx
 * @param {string} senderPubSig
 * @param {string} nonce
 * @returns {boolean}
 */
export function isDuplicateMessage(ctx, senderPubSig, nonce) {
  return ctx.messageHistory.some(
    (m) => m.senderPubSig === senderPubSig && m.nonce === nonce
  );
}

/**
 * Send a message to the lobby group
 * @param {import("./lobbyContext.js").LobbyContext} ctx
 * @param {Object} codec - LobbyCodec instance
 * @param {string} plaintext - Message content
 * @returns {Promise<Object>} - { txid }
 */
export async function sendGroupMessage(ctx, codec, plaintext) {
  if (ctx.state !== LOBBY_STATES.HOSTING && ctx.state !== LOBBY_STATES.MEMBER) {
    throw new Error("Not in an active lobby");
  }

  if (!ctx.lobby?.groupKey || !ctx.lobby?.groupMailboxId) {
    throw new Error("Lobby not initialized or missing group key");
  }

  if (!plaintext || typeof plaintext !== "string") {
    throw new Error("plaintext must be a non-empty string");
  }

  let senderPubSig = ctx.lobby?.myPubSig || null;
  if (!senderPubSig) {
    const myKeys = await ctx.adapter.generateIdentityKeys(0);
    if (!myKeys?.sig?.publicKey) {
      throw new Error("Failed to get identity keys");
    }
    senderPubSig = myKeys.sig.publicKey;
  }

  // Encrypt with group key
  const encrypted = await codec.encryptGroupMessage(
    plaintext,
    ctx.lobby.groupKey,
    ctx.lobby.groupMailboxId,
    ctx.lobby.keyVersion,
    senderPubSig
  );

  // Broadcast to group mailbox
  const payload = `KKTP:GROUP:${ctx.lobby.groupMailboxId}:${JSON.stringify(encrypted)}`;

  // Get address for self-send
  const address = await ctx.adapter.getAddress();
  const result = await ctx.adapter.send({
    toAddress: address,
    amount: "1",
    payload,
  });

  // Add to local history with nonce for deduplication
  addToHistory(ctx, {
    type: "outbound",
    senderPubSig,
    plaintext,
    timestamp: Date.now(),
    txid: result?.txid,
    nonce: encrypted.nonce,
  });

  return result;
}

/**
 * Decrypt a group message with a specific key and emit the result
 * @param {import("./lobbyContext.js").LobbyContext} ctx
 * @param {Object} codec - LobbyCodec instance
 * @param {Object} encrypted - The encrypted message
 * @param {Uint8Array} key - The key to use for decryption
 */
export async function decryptAndProcessMessage(ctx, codec, encrypted, key) {
  try {
    const decrypted = await codec.decryptGroupMessage(
      encrypted,
      key,
      ctx.lobby.groupMailboxId
    );

    // Add to history with nonce for potential future deduplication
    addToHistory(ctx, {
      type: "inbound",
      senderPubSig: encrypted.senderPubSig,
      plaintext: decrypted,
      timestamp: encrypted.timestamp || Date.now(),
      nonce: encrypted.nonce,
      keyVersion: encrypted.keyVersion,
    });

    // Emit event
    ctx.callbacks.onGroupMessage?.({
      senderPubSig: encrypted.senderPubSig,
      plaintext: decrypted,
      timestamp: encrypted.timestamp,
      senderName: ctx.lobby.members.get(encrypted.senderPubSig)?.displayName,
    });
  } catch (err) {
    log.warn("KKTP Lobby: Failed to decrypt group message", {
      error: err.message,
      keyVersion: encrypted.keyVersion,
      senderPubSig: truncate(encrypted.senderPubSig),
    });
  }
}

/**
 * Buffer a message with a future key version for later processing
 * Called when we receive a message before the key rotation DM.
 * @param {import("./lobbyContext.js").LobbyContext} ctx
 * @param {Object} encrypted - The encrypted message to buffer
 */
export function bufferFutureMessage(ctx, encrypted) {
  const now = Date.now();

  // Clean up expired messages first
  ctx.futureMessageBuffer = ctx.futureMessageBuffer.filter(
    (entry) => now - entry.receivedAt < ctx.config.futureBufferTtlMs
  );

  // Enforce size limit
  if (ctx.futureMessageBuffer.length >= ctx.config.futureBufferMaxSize) {
    log.warn("KKTP Lobby: Future message buffer full, dropping oldest");
    ctx.futureMessageBuffer.shift();
  }

  ctx.futureMessageBuffer.push({
    encrypted,
    receivedAt: now,
  });

  log.debug("KKTP Lobby: Buffered future message", {
    bufferSize: ctx.futureMessageBuffer.length,
    keyVersion: encrypted.keyVersion,
    senderPubSig: truncate(encrypted.senderPubSig),
  });
}

/**
 * Process any buffered future messages that can now be decrypted
 * Called after receiving a key rotation that might unlock buffered messages.
 * @param {import("./lobbyContext.js").LobbyContext} ctx
 * @param {Object} codec - LobbyCodec instance
 */
export async function processBufferedFutureMessages(ctx, codec) {
  if (ctx.futureMessageBuffer.length === 0) return;

  const currentVersion = ctx.keyVault.current?.version;
  const previousVersion = ctx.keyVault.previous?.version;
  const now = Date.now();

  log.info("KKTP Lobby: Processing buffered future messages", {
    bufferSize: ctx.futureMessageBuffer.length,
    currentVersion,
    previousVersion,
  });

  // Partition: process now vs keep vs drop
  const toProcess = [];
  const toKeep = [];

  for (const entry of ctx.futureMessageBuffer) {
    const { encrypted, receivedAt } = entry;

    // Drop expired entries
    if (now - receivedAt >= ctx.config.futureBufferTtlMs) {
      log.debug("KKTP Lobby: Dropping expired buffered message", {
        keyVersion: encrypted.keyVersion,
        ageMs: now - receivedAt,
      });
      continue;
    }

    // Can we decrypt now?
    if (encrypted.keyVersion === currentVersion) {
      toProcess.push({ encrypted, key: ctx.keyVault.current.key });
    } else if (
      previousVersion !== null &&
      encrypted.keyVersion === previousVersion
    ) {
      toProcess.push({ encrypted, key: ctx.keyVault.previous.key });
    } else if (encrypted.keyVersion > currentVersion) {
      // Still future, keep buffered
      toKeep.push(entry);
    } else {
      // Now expired (too old)
      log.debug("KKTP Lobby: Dropping now-expired buffered message", {
        msgVersion: encrypted.keyVersion,
        currentVersion,
        previousVersion,
      });
    }
  }

  // Update buffer
  ctx.futureMessageBuffer = toKeep;

  // Process unlocked messages
  for (const { encrypted, key } of toProcess) {
    log.info("KKTP Lobby: Processing previously-buffered message", {
      keyVersion: encrypted.keyVersion,
      senderPubSig: truncate(encrypted.senderPubSig),
    });
    await decryptAndProcessMessage(ctx, codec, encrypted, key);
  }

  log.info("KKTP Lobby: Finished processing buffered messages", {
    processed: toProcess.length,
    remaining: toKeep.length,
  });
}

/**
 * Process an incoming group message using Epoch Versioning
 *
 * Key matching strategy:
 * 1. Try current key (exact version match)
 * 2. Try previous key (for messages sent during rotation propagation)
 * 3. Buffer future versions (message arrived before key rotation DM)
 * 4. Drop expired versions (more than 1 behind previous)
 *
 * @param {import("./lobbyContext.js").LobbyContext} ctx
 * @param {Object} codec - LobbyCodec instance
 * @param {Object} encrypted - Encrypted group message
 */
export async function processGroupMessage(ctx, codec, encrypted) {
  if (ctx.state !== LOBBY_STATES.HOSTING && ctx.state !== LOBBY_STATES.MEMBER) {
    return;
  }

  try {
    validateGroupMessage(encrypted);
  } catch (err) {
    log.warn("KKTP Lobby: Invalid group message format", err.message);
    return;
  }

  // High-precision deduplication
  if (encrypted.senderPubSig && encrypted.nonce) {
    if (isDuplicateMessage(ctx, encrypted.senderPubSig, encrypted.nonce)) {
      log.debug("KKTP Lobby: Skipping duplicate message", {
        senderPubSig: truncate(encrypted.senderPubSig),
        nonce: truncate(encrypted.nonce),
      });
      return;
    }
  }

  const msgVersion = encrypted.keyVersion;
  const currentVersion = ctx.keyVault.current?.version ?? ctx.lobby.keyVersion;
  const previousVersion = ctx.keyVault.previous?.version ?? null;

  // Case 1: Current key (exact match)
  if (msgVersion === currentVersion && ctx.keyVault.current?.key) {
    log.debug("KKTP Lobby: Decrypting with current key", {
      keyVersion: msgVersion,
      senderPubSig: truncate(encrypted.senderPubSig),
    });
    await decryptAndProcessMessage(ctx, codec, encrypted, ctx.keyVault.current.key);
    return;
  }

  // Case 2: Previous key (message sent during rotation propagation)
  if (
    previousVersion !== null &&
    msgVersion === previousVersion &&
    ctx.keyVault.previous?.key
  ) {
    log.info("KKTP Lobby: Decrypting with previous key (rotation in progress)", {
      msgVersion,
      currentVersion,
      previousVersion,
      senderPubSig: truncate(encrypted.senderPubSig),
    });
    await decryptAndProcessMessage(ctx, codec, encrypted, ctx.keyVault.previous.key);
    return;
  }

  // Case 3: Future version (message arrived before key rotation DM)
  if (msgVersion > currentVersion) {
    log.info("KKTP Lobby: Buffering future message (awaiting key rotation)", {
      msgVersion,
      currentVersion,
      senderPubSig: truncate(encrypted.senderPubSig),
    });
    bufferFutureMessage(ctx, encrypted);
    return;
  }

  // Case 4: Expired version (too old to decrypt)
  log.warn("KKTP Lobby: Dropping expired message (key version too old)", {
    msgVersion,
    currentVersion,
    previousVersion,
    senderPubSig: truncate(encrypted.senderPubSig),
  });
}
