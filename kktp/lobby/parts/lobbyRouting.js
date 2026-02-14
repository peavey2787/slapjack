/**
 * LobbyRouting - Payload categorization and routing utilities
 *
 * Pure functions for categorizing and parsing KKTP payloads.
 * Determines message type and relevance without processing.
 *
 * @module kktp/lobby/parts/lobbyRouting
 */

import { LOBBY_STATES } from "./lobbyContext.js";
import { isRelevantMailbox } from "./lobbyDmBuffer.js";

/**
 * Parse a raw KKTP payload to check if it's a group message
 * @param {string} rawPayload - Raw KKTP payload string
 * @returns {{ isGroup: boolean, groupMailboxId?: string, encrypted?: Object }}
 */
export function parseGroupPayload(rawPayload) {
  if (!rawPayload || typeof rawPayload !== "string") {
    return { isGroup: false };
  }

  // Group messages: KKTP:GROUP:{groupMailboxId}:{json}
  if (!rawPayload.startsWith("KKTP:GROUP:")) {
    return { isGroup: false };
  }

  // Find the second colon after "KKTP:GROUP:"
  const afterPrefix = rawPayload.slice(11); // len("KKTP:GROUP:") = 11
  const colonIdx = afterPrefix.indexOf(":");

  if (colonIdx === -1) {
    return { isGroup: false };
  }

  const groupMailboxId = afterPrefix.slice(0, colonIdx);
  const jsonPart = afterPrefix.slice(colonIdx + 1);

  try {
    const encrypted = JSON.parse(jsonPart);
    return { isGroup: true, groupMailboxId, encrypted };
  } catch {
    return { isGroup: false };
  }
}

/**
 * Check if we are currently in a lobby (either hosting or as member)
 * @param {import("./lobbyContext.js").LobbyContext} ctx
 * @returns {boolean}
 */
export function isInLobby(ctx) {
  return ctx.state === LOBBY_STATES.HOSTING || ctx.state === LOBBY_STATES.MEMBER;
}

/**
 * Get the current lobby's group mailbox ID (if in a lobby)
 * @param {import("./lobbyContext.js").LobbyContext} ctx
 * @returns {string|null}
 */
export function getGroupMailboxId(ctx) {
  return ctx.lobby?.groupMailboxId ?? null;
}

/**
 * Check if a group payload belongs to this lobby
 * @param {import("./lobbyContext.js").LobbyContext} ctx
 * @param {string} groupMailboxId - The group mailbox ID from the payload
 * @returns {boolean}
 */
export function isGroupPayloadForThisLobby(ctx, groupMailboxId) {
  if (!isInLobby(ctx) || !ctx.lobby?.groupMailboxId) return false;
  return ctx.lobby.groupMailboxId === groupMailboxId;
}

/**
 * Categorize a raw KKTP payload to determine how to process it
 * Returns categorization info for routing decisions.
 *
 * This is a pure categorization method - it doesn't process the message,
 * just tells you what type it is and provides parsed components.
 *
 * @param {import("./lobbyContext.js").LobbyContext} ctx
 * @param {string} rawPayload - Raw KKTP payload string
 * @returns {{
 *   type: 'anchor' | 'group' | 'dm' | 'unknown',
 *   mailboxId?: string,
 *   groupMailboxId?: string,
 *   encrypted?: Object,
 *   isRelevant?: boolean
 * }}
 */
export function categorizePayload(ctx, rawPayload) {
  if (!rawPayload || typeof rawPayload !== "string") {
    return { type: "unknown" };
  }

  // Anchor messages (discovery, response, etc.)
  if (rawPayload.startsWith("KKTP:ANCHOR:")) {
    return { type: "anchor" };
  }

  // Group messages
  if (rawPayload.startsWith("KKTP:GROUP:")) {
    const parsed = parseGroupPayload(rawPayload);
    if (parsed.isGroup) {
      return {
        type: "group",
        groupMailboxId: parsed.groupMailboxId,
        encrypted: parsed.encrypted,
        isRelevant: isGroupPayloadForThisLobby(ctx, parsed.groupMailboxId),
      };
    }
    return { type: "unknown" };
  }

  // DM messages: KKTP:{mailboxId}:{encrypted}
  if (rawPayload.startsWith("KKTP:")) {
    const colonIdx = rawPayload.indexOf(":", 5); // After "KKTP:"
    if (colonIdx > 5) {
      const mailboxId = rawPayload.slice(5, colonIdx);
      return {
        type: "dm",
        mailboxId,
        isRelevant: isRelevantMailbox(ctx, mailboxId),
      };
    }
  }

  return { type: "unknown" };
}
