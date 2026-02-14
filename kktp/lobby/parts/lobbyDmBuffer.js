/**
 * LobbyDmBuffer - DM buffer and mailbox relevance management
 *
 * Handles race conditions where DM arrives before session is established.
 * Filters incoming DM messages to only process relevant mailboxes.
 *
 * @module kktp/lobby/parts/lobbyDmBuffer
 */

import { truncate } from "./lobbyUtils.js";
import { Logger, LogModule } from "../../core/logger.js";

const log = Logger.create(LogModule.lobby.parts.lobbyDmBuffer);

/**
 * Check if a mailbox ID is relevant to this lobby
 * Used to filter incoming DM messages - only process messages for:
 * - Pending join DM (while waiting for join response)
 * - Host's DM (for receiving key rotations/member events as member)
 * - Known member DMs (for host to receive join requests/messages)
 * @param {import("./lobbyContext.js").LobbyContext} ctx
 * @param {string} mailboxId
 * @returns {boolean}
 */
export function isRelevantMailbox(ctx, mailboxId) {
  if (!mailboxId) return false;

  // Check if it's our pending join DM (waiting for response from host)
  if (ctx.pendingJoinDmMailboxId && ctx.pendingJoinDmMailboxId === mailboxId) {
    return true;
  }

  // Check if it's the host's DM (for members receiving key rotations)
  if (ctx.hostDmMailboxId && ctx.hostDmMailboxId === mailboxId) {
    return true;
  }

  // Check if it's a known member's DM (for host)
  if (isKnownMemberMailbox(ctx, mailboxId)) {
    return true;
  }

  return false;
}

/**
 * Check if a mailbox ID belongs to a known lobby member
 * @param {import("./lobbyContext.js").LobbyContext} ctx
 * @param {string} mailboxId
 * @returns {boolean}
 */
export function isKnownMemberMailbox(ctx, mailboxId) {
  if (!mailboxId || !ctx.lobby?.members) return false;
  for (const member of ctx.lobby.members.values()) {
    if (member.dmMailboxId === mailboxId) return true;
  }
  return false;
}

/**
 * Buffer a DM message for later processing when session is established
 * Only buffers messages for mailboxes we know are relevant to this lobby.
 * @param {import("./lobbyContext.js").LobbyContext} ctx
 * @param {string} mailboxId - The DM mailbox ID
 * @param {string} payload - Raw payload to buffer
 * @param {number} [timestamp] - Message timestamp
 */
export function bufferDMMessage(ctx, mailboxId, payload, timestamp) {
  // Only buffer if this mailbox is relevant to our lobby
  if (!isRelevantMailbox(ctx, mailboxId)) {
    return;
  }

  const now = Date.now();

  if (!ctx.dmBuffer.has(mailboxId)) {
    ctx.dmBuffer.set(mailboxId, []);
  }

  const buffer = ctx.dmBuffer.get(mailboxId);

  // Limit buffer size per mailbox
  if (buffer.length >= ctx.config.dmBufferMaxPerMailbox) {
    log.warn("KKTP Lobby: DM buffer full, dropping oldest", {
      mailboxId: truncate(mailboxId),
    });
    buffer.shift();
  }

  buffer.push({ payload, timestamp, bufferedAt: now });

  log.info("KKTP Lobby: Buffered early DM message", {
    mailboxId: truncate(mailboxId),
    bufferSize: buffer.length,
  });

  startDMBufferCleanup(ctx);
}

/**
 * Check if there are buffered messages for a mailbox
 * @param {import("./lobbyContext.js").LobbyContext} ctx
 * @param {string} mailboxId
 * @returns {boolean}
 */
export function hasBufferedMessages(ctx, mailboxId) {
  const buffer = ctx.dmBuffer.get(mailboxId);
  return buffer && buffer.length > 0;
}

/**
 * Get and clear buffered messages for a mailbox
 * Called when session is established to process pending messages.
 * @param {import("./lobbyContext.js").LobbyContext} ctx
 * @param {string} mailboxId
 * @returns {Array<{ payload: string, timestamp: number }>}
 */
export function popBufferedMessages(ctx, mailboxId) {
  const buffer = ctx.dmBuffer.get(mailboxId);
  if (!buffer || buffer.length === 0) return [];

  const now = Date.now();
  const validMessages = buffer.filter(
    (msg) => now - msg.bufferedAt < ctx.config.dmBufferTtlMs,
  );

  ctx.dmBuffer.delete(mailboxId);
  return validMessages;
}

/**
 * Clear buffered messages for a mailbox (e.g., on session end)
 * @param {import("./lobbyContext.js").LobbyContext} ctx
 * @param {string} mailboxId
 */
export function clearBufferedMessages(ctx, mailboxId) {
  ctx.dmBuffer.delete(mailboxId);
}

/**
 * Start the DM buffer cleanup timer
 * @param {import("./lobbyContext.js").LobbyContext} ctx
 */
export function startDMBufferCleanup(ctx) {
  if (ctx.dmBufferCleanupTimer) return;
  ctx.dmBufferCleanupTimer = setInterval(
    () => cleanupExpiredBuffers(ctx),
    ctx.config.dmBufferCleanupIntervalMs,
  );
}

/**
 * Stop the DM buffer cleanup timer
 * @param {import("./lobbyContext.js").LobbyContext} ctx
 */
export function stopDMBufferCleanup(ctx) {
  if (ctx.dmBufferCleanupTimer) {
    clearInterval(ctx.dmBufferCleanupTimer);
    ctx.dmBufferCleanupTimer = null;
  }
}

/**
 * Clean up expired buffer entries
 * @param {import("./lobbyContext.js").LobbyContext} ctx
 */
export function cleanupExpiredBuffers(ctx) {
  const now = Date.now();

  for (const [mailboxId, buffer] of ctx.dmBuffer.entries()) {
    const validMessages = buffer.filter(
      (msg) => now - msg.bufferedAt < ctx.config.dmBufferTtlMs,
    );

    if (validMessages.length === 0) {
      ctx.dmBuffer.delete(mailboxId);
    } else if (validMessages.length < buffer.length) {
      ctx.dmBuffer.set(mailboxId, validMessages);
    }
  }

  // Stop cleanup timer if buffer is empty
  if (ctx.dmBuffer.size === 0 && ctx.dmBufferCleanupTimer) {
    clearInterval(ctx.dmBufferCleanupTimer);
    ctx.dmBufferCleanupTimer = null;
  }
}

/**
 * Clear all DM buffers and stop cleanup
 * @param {import("./lobbyContext.js").LobbyContext} ctx
 */
export function clearDmBuffer(ctx) {
  ctx.dmBuffer.clear();
  stopDMBufferCleanup(ctx);
}

/**
 * Clear all DM buffers and stop cleanup
 * @param {import("./lobbyContext.js").LobbyContext} ctx
 */
export function clearAllDMBuffers(ctx) {
  ctx.dmBuffer.clear();
  stopDMBufferCleanup(ctx);
}
