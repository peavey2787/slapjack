/**
 * @fileoverview Lobby session end - DM session termination utilities.
 *
 * Handles graceful termination of DM sessions with lobby members,
 * broadcasting session_end anchors and cleaning up subscriptions.
 *
 * @module kktp/lobby/parts/lobbySessionEnd
 */

import { buildAnchorPayload } from "../../protocol/sessions/index.js";
import { unsubscribeFromDMMailbox } from "./lobbySubscriptions.js";
import { waitForUtxoRefresh } from "./lobbyUtxo.js";
import { Logger, LogModule } from "../../core/logger.js";

const log = Logger.create(LogModule.lobby.parts.lobbySessionEnd);

/**
 * End a single DM session with a member.
 * Broadcasts session_end anchor and cleans up subscription.
 *
 * @param {Object} ctx - Lobby context
 * @param {string} dmMailboxId - DM mailbox ID to end
 * @param {string} [reason="lobby_closed"] - Reason for ending session
 * @returns {Promise<boolean>} True if session ended successfully
 */
export async function endDMSession(ctx, dmMailboxId, reason = "lobby_closed") {
  const { sm, adapter } = ctx;

  if (!dmMailboxId) {
    log.debug("KKTP Lobby: endDMSession - no dmMailboxId provided");
    return false;
  }

  log.info("KKTP Lobby: Ending DM session", {
    dmMailboxId: dmMailboxId.slice(0, 16),
    reason,
  });

  try {
    // Step 1: Get the session from the vault
    const session = sm.getSession(dmMailboxId);
    if (!session) {
      log.info("KKTP Lobby: DM session not found, already closed", {
        dmMailboxId: dmMailboxId.slice(0, 16),
      });
      // Still unsubscribe from the mailbox prefix
      unsubscribeFromDMMailbox(ctx, dmMailboxId);
      return false;
    }

    // Step 2: Create session_end anchor
    if (!session.protocol?.createEndAnchor) {
      log.warn(
        "KKTP Lobby: Session protocol unavailable for session_end",
        { dmMailboxId: dmMailboxId.slice(0, 16) }
      );
      // Force close locally without broadcasting
      sm.closeSession(dmMailboxId);
      unsubscribeFromDMMailbox(ctx, dmMailboxId);
      return false;
    }

    const endAnchor = await session.protocol.createEndAnchor(reason);
    const payload = buildAnchorPayload(endAnchor);

    // Step 3: Broadcast the session_end to the ledger
    const address = await adapter.getAddress();
    if (!address) {
      log.error("KKTP Lobby: No wallet address for session_end broadcast");
      sm.closeSession(dmMailboxId);
      unsubscribeFromDMMailbox(ctx, dmMailboxId);
      return false;
    }

    await adapter.send({
      toAddress: address,
      amount: "1",
      payload,
    });

    log.info("KKTP Lobby: Session_end broadcast successful", {
      dmMailboxId: dmMailboxId.slice(0, 16),
      reason,
    });

    // Step 4: Close the session locally (if not already closed by createEndAnchor)
    // Note: createEndAnchor calls sm.terminate() which may already close it
    if (sm.getSession(dmMailboxId)) {
      sm.closeSession(dmMailboxId);
    }

    // Step 5: Unsubscribe from the DM mailbox
    unsubscribeFromDMMailbox(ctx, dmMailboxId);

    return true;
  } catch (err) {
    log.error("KKTP Lobby: Failed to end DM session", {
      dmMailboxId: dmMailboxId.slice(0, 16),
      reason,
      error: err.message,
    });

    // Best-effort cleanup even on failure
    try {
      sm.closeSession(dmMailboxId);
    } catch {
      /* ignore */
    }
    unsubscribeFromDMMailbox(ctx, dmMailboxId);

    return false;
  }
}

/**
 * End all DM sessions with lobby members.
 * Used by the host when closing the lobby.
 *
 * @param {Object} ctx - Lobby context
 * @param {string} [reason="lobby_closed"] - Reason for ending sessions
 * @returns {Promise<void>}
 */
export async function endAllMemberDMSessions(ctx, reason = "lobby_closed") {
  const { lobby } = ctx;

  if (!lobby?.members) {
    log.debug("KKTP Lobby: No members to end DM sessions with");
    return;
  }

  const memberSessions = Array.from(lobby.members.values())
    .filter((m) => m.dmMailboxId)
    .map((m) => ({ pubSig: m.pubSig, dmMailboxId: m.dmMailboxId }));

  if (memberSessions.length === 0) {
    log.debug("KKTP Lobby: No DM sessions to end");
    return;
  }

  log.info("KKTP Lobby: Ending all member DM sessions", {
    count: memberSessions.length,
    reason,
  });

  // End sessions sequentially with UTXO refresh between each
  for (let i = 0; i < memberSessions.length; i++) {
    const { pubSig, dmMailboxId } = memberSessions[i];
    try {
      await endDMSession(ctx, dmMailboxId, reason);
      // Wait for UTXO refresh between session ends (except for last)
      if (i < memberSessions.length - 1) {
        await waitForUtxoRefresh(ctx);
      }
    } catch (err) {
      log.warn("KKTP Lobby: Failed to end DM session with member", {
        pubSig: pubSig?.slice(0, 16),
        dmMailboxId: dmMailboxId?.slice(0, 16),
        error: err.message,
      });
      // Continue with next member
    }
  }

  log.info("KKTP Lobby: Finished ending all member DM sessions");
}
