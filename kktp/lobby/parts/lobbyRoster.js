/**
 * LobbyRoster - Member management and events
 *
 * Handles member roster operations, member events (join/leave),
 * and member event broadcasting.
 *
 * @module kktp/lobby/parts/lobbyRoster
 */

import { LOBBY_STATES, LOBBY_VERSION, MEMBER_ROLES } from "./lobbyContext.js";
import { truncate } from "./lobbyUtils.js";
import { waitForUtxoRefresh, sendWithRetry } from "./lobbyUtxo.js";
import { validateMemberEvent } from "../lobbySchemas.js";
import { Logger, LogModule } from "../../core/logger.js";

const log = Logger.create(LogModule.lobby.parts.lobbyRoster);

/**
 * Add a member to the lobby roster
 * @param {import("./lobbyContext.js").LobbyContext} ctx
 * @param {Object} member - Member object
 */
export function addMember(ctx, member) {
  ctx.lobby.members.set(member.pubSig, member);
}

/**
 * Remove a member from the lobby roster
 * @param {import("./lobbyContext.js").LobbyContext} ctx
 * @param {string} pubSig - Member's public signing key
 */
export function removeMember(ctx, pubSig) {
  ctx.lobby.members.delete(pubSig);
}

/**
 * Get a member by public signing key
 * @param {import("./lobbyContext.js").LobbyContext} ctx
 * @param {string} pubSig
 * @returns {Object|undefined}
 */
export function getMember(ctx, pubSig) {
  return ctx.lobby?.members?.get(pubSig);
}

/**
 * Check if a public key is already a member
 * @param {import("./lobbyContext.js").LobbyContext} ctx
 * @param {string} pubSig
 * @returns {boolean}
 */
export function isMember(ctx, pubSig) {
  return ctx.lobby?.members?.has(pubSig) ?? false;
}

/**
 * Get member count
 * @param {import("./lobbyContext.js").LobbyContext} ctx
 * @returns {number}
 */
export function getMemberCount(ctx) {
  return ctx.lobby?.members?.size ?? 0;
}

/**
 * Check if lobby is at capacity
 * @param {import("./lobbyContext.js").LobbyContext} ctx
 * @returns {boolean}
 */
export function isLobbyFull(ctx) {
  if (!ctx.lobby) return true;
  return ctx.lobby.members.size >= ctx.lobby.maxMembers;
}

/**
 * Export member list as a serializable array
 * @param {import("./lobbyContext.js").LobbyContext} ctx
 * @returns {Array<Object>}
 */
export function exportMemberList(ctx) {
  if (!ctx.lobby?.members) return [];
  return Array.from(ctx.lobby.members.values()).map((m) => ({
    pubSig: m.pubSig,
    displayName: m.displayName,
    role: m.role,
    joinedAt: m.joinedAt,
  }));
}

/**
 * Import member list from an array
 * @param {import("./lobbyContext.js").LobbyContext} ctx
 * @param {Array<Object>} members
 */
export function importMemberList(ctx, members) {
  if (!Array.isArray(members)) return;
  for (const m of members) {
    ctx.lobby.members.set(m.pubSig, m);
  }
  log.info("KKTP Lobby: Imported member list", {
    memberCount: ctx.lobby.members.size,
    members: members.map((m) => m.displayName || truncate(m.pubSig, 8)),
  });
}

/**
 * Create a new member object
 * @param {string} pubSig
 * @param {string} displayName
 * @param {string} role
 * @param {string|null} dmMailboxId
 * @returns {Object}
 */
export function createMember(pubSig, displayName, role, dmMailboxId = null) {
  return {
    pubSig,
    displayName: displayName || `Peer ${pubSig.slice(0, 8)}`,
    role,
    joinedAt: Date.now(),
    dmMailboxId,
  };
}

/**
 * Broadcast a member event to all other members
 * Serializes sends with UTXO refresh between each to prevent contention
 * @param {import("./lobbyContext.js").LobbyContext} ctx
 * @param {string} eventType - 'join' or 'leave'
 * @param {Object} member - Member info (pubSig, displayName, role, etc.)
 */
export async function broadcastMemberEvent(ctx, eventType, member) {
  if (!ctx.lobby || ctx.state !== LOBBY_STATES.HOSTING) return;

  const event = {
    type: "lobby_member_event",
    version: LOBBY_VERSION,
    lobbyId: ctx.lobby.lobbyId,
    eventType,
    pubSig: member.pubSig,
    displayName: member.displayName,
    role: member.role,
    joinedAt: member.joinedAt,
    reason: member.reason,
    timestamp: Date.now(),
  };

  const eventJson = JSON.stringify(event);

  // Collect recipients (exclude host and the member in question)
  const recipients = [];
  for (const [pubSig, m] of ctx.lobby.members) {
    if (m.role === MEMBER_ROLES.HOST) continue;
    if (pubSig === member.pubSig) continue;
    if (!m.dmMailboxId) continue;
    recipients.push({ pubSig, dmMailboxId: m.dmMailboxId });
  }

  if (recipients.length === 0) {
    log.debug("KKTP Lobby: No recipients for member event broadcast");
    return;
  }

  log.info("KKTP Lobby: Broadcasting member event", {
    eventType,
    memberPubSig: truncate(member.pubSig),
    recipientCount: recipients.length,
  });

  // Send to each recipient serially with UTXO refresh between
  for (let i = 0; i < recipients.length; i++) {
    const { pubSig, dmMailboxId } = recipients[i];

    try {
      await sendWithRetry(ctx, dmMailboxId, eventJson, 3);
      log.debug("KKTP Lobby: Member event sent", {
        eventType,
        to: truncate(pubSig),
      });
    } catch (err) {
      log.warn("KKTP Lobby: Failed to send member event", {
        to: truncate(pubSig),
        error: err.message,
      });
    }

    // Wait for UTXO refresh before next send (except for last recipient)
    if (i < recipients.length - 1) {
      await waitForUtxoRefresh(ctx);
    }
  }
}

/**
 * Handle member event (join/leave) from host (member only)
 * @param {import("./lobbyContext.js").LobbyContext} ctx
 * @param {Object} event - Member event
 */
export function handleMemberEvent(ctx, event) {
  if (ctx.state !== LOBBY_STATES.MEMBER) return;

  try {
    validateMemberEvent(event);
  } catch (err) {
    log.warn("KKTP Lobby: Invalid member event", err.message);
    return;
  }

  if (event.lobbyId !== ctx.lobby.lobbyId) return;

  if (event.eventType === "join") {
    const member = {
      pubSig: event.pubSig,
      displayName: event.displayName,
      role: MEMBER_ROLES.MEMBER,
      joinedAt: event.timestamp,
    };
    ctx.lobby.members.set(member.pubSig, member);
    ctx.callbacks.onMemberJoin?.(member);
    log.info("KKTP Lobby: Member joined", {
      displayName: member.displayName,
    });
  } else if (event.eventType === "leave") {
    ctx.lobby.members.delete(event.pubSig);
    ctx.callbacks.onMemberLeave?.(event.pubSig, event.reason);
    log.info("KKTP Lobby: Member left", {
      pubSig: truncate(event.pubSig),
    });
  }
}
