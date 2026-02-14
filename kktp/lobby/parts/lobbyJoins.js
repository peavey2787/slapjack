/**
 * LobbyJoins - Join request handling and queue management
 *
 * Handles join request queue processing, acceptance/rejection,
 * and join response sending. Serializes joins to prevent UTXO contention.
 *
 * @module kktp/lobby/parts/lobbyJoins
 */

import { LOBBY_STATES, LOBBY_VERSION, MEMBER_ROLES } from "./lobbyContext.js";
import { truncate, exportGroupKey } from "./lobbyUtils.js";
import { waitForUtxoRefresh, sendWithRetry } from "./lobbyUtxo.js";
import { addMember, createMember, exportMemberList, broadcastMemberEvent, isMember, isLobbyFull } from "./lobbyRoster.js";
import { validateJoinRequest, validateJoinResponse } from "../lobbySchemas.js";
import { Logger, LogModule } from "../../core/logger.js";

const log = Logger.create(LogModule.lobby.parts.lobbyJoins);

/**
 * Get pending join requests (host only)
 * @param {import("./lobbyContext.js").LobbyContext} ctx
 * @returns {Array<Object>} Array of { pubSig, displayName, receivedAt }
 */
export function getPendingJoinRequests(ctx) {
  return Array.from(ctx.pendingJoins.entries()).map(([pubSig, data]) => ({
    pubSig,
    displayName: data.request.displayName,
    receivedAt: data.receivedAt,
  }));
}

/**
 * Check if a join request is already queued or pending
 * @param {import("./lobbyContext.js").LobbyContext} ctx
 * @param {string} pubSig
 * @returns {boolean}
 */
export function isJoinPending(ctx, pubSig) {
  const alreadyQueued = ctx.joinRequestQueue.some(
    (item) => item.request.pubSig === pubSig
  );
  return alreadyQueued || ctx.pendingJoins.has(pubSig);
}

/**
 * Send join response to a peer
 * @param {import("./lobbyContext.js").LobbyContext} ctx
 * @param {string} dmMailboxId
 * @param {boolean} accepted
 * @param {string} reason
 * @param {Object} [extras={}] - Extra fields (groupKey, keyVersion, etc.)
 */
export async function sendJoinResponse(ctx, dmMailboxId, accepted, reason, extras = {}) {
  const response = {
    type: "lobby_join_response",
    version: LOBBY_VERSION,
    lobbyId: ctx.lobby.lobbyId,
    accepted,
    reason,
    timestamp: Date.now(),
    ...extras,
  };

  log.info("KKTP Lobby: Sending join response", {
    dmMailboxId: truncate(dmMailboxId),
    accepted,
    reason,
    hasGroupKey: !!extras.groupKey,
    keyVersion: extras.keyVersion,
    memberCount: extras.members?.length,
  });

  try {
    await sendWithRetry(ctx, dmMailboxId, JSON.stringify(response), 3);
    log.info("KKTP Lobby: Join response sent successfully", {
      dmMailboxId: truncate(dmMailboxId),
      accepted,
    });
  } catch (err) {
    log.error("KKTP Lobby: Failed to send join response", {
      dmMailboxId: truncate(dmMailboxId),
      accepted,
      error: err.message,
    });
    throw err;
  }
}

/**
 * Accept a join request and add member to lobby
 * Called from the serialized queue processor to prevent UTXO contention.
 * @param {import("./lobbyContext.js").LobbyContext} ctx
 * @param {string} dmMailboxId
 * @param {Object} request
 * @returns {Promise<boolean>}
 */
export async function acceptJoinRequest(ctx, dmMailboxId, request) {
  const { pubSig, displayName } = request;

  // Create member entry BEFORE sending response
  const member = createMember(pubSig, displayName, MEMBER_ROLES.MEMBER, dmMailboxId);

  // Add to roster first (so response includes correct member count)
  addMember(ctx, member);

  // Prepare member list for response (includes the new member)
  const memberList = exportMemberList(ctx);

  // Send join response with group key
  try {
    await sendJoinResponse(ctx, dmMailboxId, true, "Welcome", {
      groupKey: exportGroupKey(ctx.lobby.groupKey),
      keyVersion: ctx.lobby.keyVersion,
      groupMailboxId: ctx.lobby.groupMailboxId,
      lobbyId: ctx.lobby.lobbyId,
      lobbyName: ctx.lobby.lobbyName,
      hostPubSig: ctx.lobby.hostPubSig,
      maxMembers: ctx.lobby.maxMembers,
      members: memberList,
    });
  } catch (err) {
    // Rollback if we fail to send response
    log.error("KKTP Lobby: Failed to send join response, removing member", {
      pubSig: truncate(pubSig),
      error: err.message,
    });
    ctx.lobby.members.delete(pubSig);
    throw err;
  }

  // Wait for UTXO refresh before broadcasting member event
  await waitForUtxoRefresh(ctx);

  // Broadcast member join to existing members (excluding the new member)
  try {
    await broadcastMemberEvent(ctx, "join", member);
  } catch (err) {
    log.warn("KKTP Lobby: Failed to broadcast member event (non-fatal)", {
      pubSig: truncate(pubSig),
      error: err.message,
    });
  }

  // Emit event
  ctx.callbacks.onMemberJoin?.(member);

  log.info("KKTP Lobby: Member joined", {
    pubSig: truncate(pubSig),
    displayName: member.displayName,
    memberCount: ctx.lobby.members.size,
  });

  return true;
}

/**
 * Process the join request queue serially
 * Ensures only one join is processed at a time to prevent UTXO contention
 * @param {import("./lobbyContext.js").LobbyContext} ctx
 */
export async function processJoinQueue(ctx) {
  if (ctx.isProcessingJoinQueue) return;

  ctx.isProcessingJoinQueue = true;

  try {
    while (ctx.joinRequestQueue.length > 0) {
      const { dmMailboxId, request, resolve } = ctx.joinRequestQueue.shift();
      const { pubSig, displayName } = request;

      log.info("KKTP Lobby: Processing queued join request", {
        pubSig: truncate(pubSig),
        displayName,
        remainingInQueue: ctx.joinRequestQueue.length,
      });

      // Check if lobby state is still valid
      if (ctx.state !== LOBBY_STATES.HOSTING || !ctx.lobby) {
        log.warn("KKTP Lobby: Lobby closed while processing queue");
        resolve(false);
        continue;
      }

      // Re-check capacity
      if (isLobbyFull(ctx)) {
        log.warn("KKTP Lobby: Lobby full while processing queue");
        try {
          await sendJoinResponse(ctx, dmMailboxId, false, "Lobby is full");
        } catch (err) {
          log.warn("KKTP Lobby: Failed to send rejection", {
            error: err.message,
          });
        }
        resolve(false);
        continue;
      }

      // Re-check if already a member
      if (isMember(ctx, pubSig)) {
        log.warn("KKTP Lobby: Already member while processing queue");
        resolve(true);
        continue;
      }

      // Process based on autoAcceptJoins setting
      if (ctx.config.autoAcceptJoins) {
        try {
          const result = await acceptJoinRequest(ctx, dmMailboxId, request);
          resolve(result);
        } catch (err) {
          log.error("KKTP Lobby: Error accepting join request", {
            pubSig: truncate(pubSig),
            error: err.message,
          });
          resolve(false);
        }
      } else {
        // Store for manual approval
        ctx.pendingJoins.set(pubSig, {
          dmMailboxId,
          request,
          receivedAt: Date.now(),
        });

        // Emit event for UI to handle
        if (ctx.callbacks.onJoinRequest) {
          const acceptFn = () => acceptPendingJoin(ctx, pubSig);
          const rejectFn = (reason) => rejectPendingJoin(ctx, pubSig, reason);
          ctx.callbacks.onJoinRequest(request, acceptFn, rejectFn);
        }

        log.info("KKTP Lobby: Join request pending approval", {
          pubSig: truncate(pubSig),
          displayName,
        });

        resolve(true);
      }

      // Wait for UTXO refresh before processing next request
      if (ctx.joinRequestQueue.length > 0) {
        log.info("KKTP Lobby: Waiting for UTXO refresh before next join", {
          remainingInQueue: ctx.joinRequestQueue.length,
        });
        await waitForUtxoRefresh(ctx);
      }
    }
  } finally {
    ctx.isProcessingJoinQueue = false;
  }
}

/**
 * Accept a pending join request (host only)
 * Routes through the join queue to ensure proper UTXO serialization.
 * @param {import("./lobbyContext.js").LobbyContext} ctx
 * @param {string} pubSig
 * @returns {Promise<boolean>}
 */
export async function acceptPendingJoin(ctx, pubSig) {
  const pending = ctx.pendingJoins.get(pubSig);
  if (!pending) {
    log.warn("KKTP Lobby: No pending join for", truncate(pubSig));
    return false;
  }

  ctx.pendingJoins.delete(pubSig);

  return new Promise((resolve) => {
    ctx.joinRequestQueue.push({
      dmMailboxId: pending.dmMailboxId,
      request: pending.request,
      resolve,
      queuedAt: Date.now(),
    });

    log.info("KKTP Lobby: Manual approval queued for processing", {
      pubSig: truncate(pubSig),
      queueLength: ctx.joinRequestQueue.length,
    });

    processJoinQueue(ctx);
  });
}

/**
 * Reject a pending join request (host only)
 * @param {import("./lobbyContext.js").LobbyContext} ctx
 * @param {string} pubSig
 * @param {string} [reason="Rejected by host"]
 * @returns {Promise<boolean>}
 */
export async function rejectPendingJoin(ctx, pubSig, reason = "Rejected by host") {
  const pending = ctx.pendingJoins.get(pubSig);
  if (!pending) {
    log.warn("KKTP Lobby: No pending join for", truncate(pubSig));
    return false;
  }

  ctx.pendingJoins.delete(pubSig);
  await sendJoinResponse(ctx, pending.dmMailboxId, false, reason);

  log.info("KKTP Lobby: Rejected join request", {
    pubSig: truncate(pubSig),
    reason,
  });

  return true;
}

/**
 * Process a join request from a peer (host only)
 * Queues requests to prevent UTXO contention when multiple peers join simultaneously.
 * @param {import("./lobbyContext.js").LobbyContext} ctx
 * @param {string} dmMailboxId
 * @param {Object} request
 * @returns {Promise<boolean>}
 */
export async function handleJoinRequest(ctx, dmMailboxId, request) {
  // Self-echo filter
  if (ctx.state === LOBBY_STATES.JOINING && ctx.pendingJoin) {
    if (request.pubSig === ctx.pendingJoin.myPubSig) {
      log.debug("KKTP Lobby: Ignoring own join request echo", {
        myPubSig: truncate(ctx.pendingJoin.myPubSig),
      });
      return false;
    }
  }

  if (ctx.state !== LOBBY_STATES.HOSTING) {
    log.warn("KKTP Lobby: Received join request but not hosting");
    return false;
  }

  try {
    validateJoinRequest(request);
  } catch (err) {
    log.warn("KKTP Lobby: Invalid join request", err.message);
    return false;
  }

  const { pubSig, displayName, lobbyId } = request;

  log.info("KKTP Lobby: Received join request", {
    pubSig: truncate(pubSig),
    displayName,
    lobbyId: truncate(lobbyId),
  });

  // Verify lobby ID matches
  if (lobbyId !== ctx.lobby.lobbyId) {
    log.warn("KKTP Lobby: Join request for wrong lobby", {
      expected: truncate(ctx.lobby.lobbyId),
      received: truncate(lobbyId),
    });
    await sendJoinResponse(ctx, dmMailboxId, false, "Lobby not found");
    return false;
  }

  // Check if already a member
  if (isMember(ctx, pubSig)) {
    log.warn("KKTP Lobby: Peer is already a member");
    return true;
  }

  // Check if already in queue or pending
  if (isJoinPending(ctx, pubSig)) {
    log.warn("KKTP Lobby: Join request already queued/pending", {
      pubSig: truncate(pubSig),
    });
    return true;
  }

  // Queue the join request for serialized processing
  return new Promise((resolve) => {
    ctx.joinRequestQueue.push({
      dmMailboxId,
      request,
      resolve,
      queuedAt: Date.now(),
    });

    log.info("KKTP Lobby: Join request queued", {
      pubSig: truncate(pubSig),
      displayName,
      queueLength: ctx.joinRequestQueue.length,
    });

    processJoinQueue(ctx);
  });
}

/**
 * Handle join response from host (member only)
 * @param {import("./lobbyContext.js").LobbyContext} ctx
 * @param {string} dmMailboxId
 * @param {Object} response
 * @param {function} onSuccess - Callback on successful join
 */
export async function handleJoinResponse(ctx, dmMailboxId, response, onSuccess) {
  log.info("KKTP Lobby: Received join response", {
    dmMailboxId: truncate(dmMailboxId),
    currentState: ctx.state,
    accepted: response?.accepted,
    reason: response?.reason,
    hasGroupKey: !!response?.groupKey,
    keyVersion: response?.keyVersion,
    memberCount: response?.members?.length,
  });

  if (ctx.state !== LOBBY_STATES.JOINING) {
    log.debug("KKTP Lobby: Ignoring join response (not in JOINING state)", {
      currentState: ctx.state,
    });
    return;
  }

  try {
    validateJoinResponse(response);
  } catch (err) {
    log.warn("KKTP Lobby: Invalid join response", {
      error: err.message,
      response: JSON.stringify(response).slice(0, 200),
    });
    return;
  }

  if (!response.accepted) {
    log.warn("KKTP Lobby: Join request rejected", {
      reason: response.reason,
      lobbyId: truncate(ctx.pendingJoin?.lobbyDiscovery?.sid),
    });
    // onSuccess will handle state reset
    onSuccess(false, response.reason);
    return;
  }

  if (!ctx.pendingJoin) {
    log.error("KKTP Lobby: No pending join data when processing response");
    onSuccess(false, "No pending join data");
    return;
  }

  // Pass response to coordinator for full initialization
  onSuccess(true, null, {
    response,
    dmMailboxId,
    pendingJoin: ctx.pendingJoin,
  });

  log.info("KKTP Lobby: Join response processed successfully", {
    lobbyId: truncate(ctx.pendingJoin.lobbyDiscovery.sid),
    accepted: response.accepted,
  });
}
