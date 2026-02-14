/**
 * LobbySubscriptions - Prefix subscription management
 *
 * Manages KKTP prefix subscriptions for group and DM mailboxes.
 * Tracks subscriptions internally for proper cleanup.
 *
 * @module kktp/lobby/parts/lobbySubscriptions
 */

import { truncate } from "./lobbyUtils.js";
import { Logger, LogModule } from "../../core/logger.js";

const log = Logger.create(LogModule.lobby.parts.lobbySubscriptions);

/**
 * Subscribe to a KKTP prefix
 * @param {import("./lobbyContext.js").LobbyContext} ctx
 * @param {string} prefix - Full KKTP prefix (e.g., 'KKTP:{mailboxId}:')
 */
export function subscribePrefix(ctx, prefix) {
  if (!prefix) return;

  if (ctx.subscriptions.has(prefix)) {
    log.debug("KKTP Lobby: Already subscribed to prefix", {
      prefix: truncate(prefix, 32),
    });
    return;
  }

  if (!ctx.adapter?.addPrefix) {
    log.warn("KKTP Lobby: Cannot subscribe - adapter.addPrefix not available");
    return;
  }

  try {
    ctx.adapter.addPrefix(prefix);
    ctx.subscriptions.add(prefix);
    log.info("KKTP Lobby: Subscribed to prefix", {
      prefix: truncate(prefix, 32),
      totalSubscriptions: ctx.subscriptions.size,
    });
  } catch (err) {
    log.error("KKTP Lobby: Failed to subscribe to prefix", {
      prefix: truncate(prefix, 32),
      error: err.message,
    });
  }
}

/**
 * Unsubscribe from a KKTP prefix
 * @param {import("./lobbyContext.js").LobbyContext} ctx
 * @param {string} prefix - Full KKTP prefix to unsubscribe from
 */
export function unsubscribePrefix(ctx, prefix) {
  if (!prefix) return;

  if (!ctx.subscriptions.has(prefix)) {
    return;
  }

  if (!ctx.adapter?.removePrefix) {
    log.debug("KKTP Lobby: Cannot unsubscribe - adapter.removePrefix not available");
    ctx.subscriptions.delete(prefix);
    return;
  }

  try {
    ctx.adapter.removePrefix(prefix);
    ctx.subscriptions.delete(prefix);
    log.info("KKTP Lobby: Unsubscribed from prefix", {
      prefix: truncate(prefix, 32),
      remainingSubscriptions: ctx.subscriptions.size,
    });
  } catch (err) {
    log.warn("KKTP Lobby: Failed to unsubscribe from prefix", {
      prefix: truncate(prefix, 32),
      error: err.message,
    });
    ctx.subscriptions.delete(prefix);
  }
}

/**
 * Unsubscribe from all tracked prefixes
 * Called during cleanup to ensure no leaked subscriptions.
 * @param {import("./lobbyContext.js").LobbyContext} ctx
 */
export function unsubscribeAllPrefixes(ctx) {
  if (ctx.subscriptions.size === 0) return;

  log.info("KKTP Lobby: Unsubscribing from all prefixes", {
    count: ctx.subscriptions.size,
  });

  const prefixes = [...ctx.subscriptions];
  for (const prefix of prefixes) {
    unsubscribePrefix(ctx, prefix);
  }
}

/**
 * Subscribe to the group mailbox for incoming group messages
 * @param {import("./lobbyContext.js").LobbyContext} ctx
 * @param {string} groupMailboxId - The group mailbox ID to watch
 */
export function subscribeToGroupMailbox(ctx, groupMailboxId) {
  if (!groupMailboxId) {
    log.warn("KKTP Lobby: Cannot subscribe - no groupMailboxId");
    return;
  }
  const prefix = `KKTP:GROUP:${groupMailboxId}:`;
  subscribePrefix(ctx, prefix);
}

/**
 * Unsubscribe from the group mailbox
 * @param {import("./lobbyContext.js").LobbyContext} ctx
 * @param {string} groupMailboxId - The group mailbox ID to stop watching
 */
export function unsubscribeFromGroupMailbox(ctx, groupMailboxId) {
  if (!groupMailboxId) return;
  const prefix = `KKTP:GROUP:${groupMailboxId}:`;
  unsubscribePrefix(ctx, prefix);
}

/**
 * Subscribe to a DM mailbox for receiving 1:1 messages
 * @param {import("./lobbyContext.js").LobbyContext} ctx
 * @param {string} mailboxId - The DM mailbox ID
 */
export function subscribeToDMMailbox(ctx, mailboxId) {
  if (!mailboxId) {
    log.warn("KKTP Lobby: Cannot subscribe - no mailboxId");
    return;
  }
  const prefix = `KKTP:${mailboxId}:`;
  subscribePrefix(ctx, prefix);
}

/**
 * Unsubscribe from a DM mailbox
 * @param {import("./lobbyContext.js").LobbyContext} ctx
 * @param {string} mailboxId - The DM mailbox ID
 */
export function unsubscribeFromDMMailbox(ctx, mailboxId) {
  if (!mailboxId) return;
  const prefix = `KKTP:${mailboxId}:`;
  unsubscribePrefix(ctx, prefix);
}

/**
 * Re-subscribe to an array of prefixes after restoration
 * @param {import("./lobbyContext.js").LobbyContext} ctx
 * @param {string[]} prefixes - Array of KKTP prefixes to subscribe to
 */
export async function resubscribePrefixes(ctx, prefixes) {
  if (!ctx.adapter) {
    log.warn("KKTP Lobby: No adapter available for prefix resubscription");
    return;
  }

  for (const prefix of prefixes) {
    try {
      if (ctx.adapter.subscribeToPrefix) {
        await ctx.adapter.subscribeToPrefix(prefix);
      } else if (ctx.adapter.addPrefix) {
        ctx.adapter.addPrefix(prefix);
      }
      ctx.subscriptions.add(prefix);
    } catch (err) {
      log.warn(`KKTP Lobby: Failed to resubscribe to prefix`, {
        prefix: truncate(prefix, 16),
        error: err?.message || err,
      });
    }
  }

  log.info("KKTP Lobby: Resubscribed to prefixes", {
    count: ctx.subscriptions.size,
  });
}

/**
 * Get all currently subscribed prefixes
 * @param {import("./lobbyContext.js").LobbyContext} ctx
 * @returns {string[]} Array of subscribed KKTP prefixes
 */
export function getSubscribedPrefixes(ctx) {
  return [...ctx.subscriptions];
}
