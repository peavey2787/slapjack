/**
 * LobbyMessageHandler - Routes incoming messages to appropriate lobby handlers
 *
 * Responsible for:
 * - Parsing incoming lobby-related messages
 * - Routing to appropriate LobbyManager methods
 * - Handling both 1:1 DM messages and group messages
 *
 * @module kktp/lobby/lobbyMessageHandler
 */

import { Logger, LogModule } from "../core/logger.js";

const log = Logger.create(LogModule.lobby.lobbyMessageHandler);

const LOBBY_MESSAGE_TYPES = {
  JOIN_REQUEST: "lobby_join_request",
  JOIN_RESPONSE: "lobby_join_response",
  MEMBER_EVENT: "lobby_member_event",
  KEY_ROTATION: "key_rotation",
  LOBBY_LEAVE: "lobby_leave",
  LOBBY_KICKED: "lobby_kicked",
  LOBBY_CLOSE: "lobby_close",
  GROUP_MESSAGE: "group_message",
};

export class LobbyMessageHandler {
  /**
   * @param {import('./lobbyManager.js').LobbyManager} lobbyManager
   */
  constructor(lobbyManager) {
    this.lobbyManager = lobbyManager;
  }

  /**
   * Process an incoming DM message that may be lobby-related
   * @param {string} dmMailboxId - The DM mailbox ID
   * @param {string} plaintextJson - The decrypted message content
   * @returns {boolean} - True if message was handled as lobby message
   */
  processDMMessage(dmMailboxId, plaintextJson) {
    let msg;
    try {
      msg = JSON.parse(plaintextJson);
    } catch {
      // Not JSON, not a lobby message
      return false;
    }

    if (!msg || typeof msg.type !== "string") {
      return false;
    }

    log.info("LobbyMessageHandler: Processing DM message", {
      dmMailboxId: dmMailboxId?.slice(0, 16),
      msgType: msg.type,
      lobbyState: this.lobbyManager?.state,
      isHost: this.lobbyManager?.isHost ?? false,
    });

    // Route based on message type
    switch (msg.type) {
      case LOBBY_MESSAGE_TYPES.JOIN_REQUEST:
        log.info("LobbyMessageHandler: Routing JOIN_REQUEST", {
          pubSig: msg.pubSig?.slice(0, 16),
          displayName: msg.displayName,
          lobbyId: msg.lobbyId?.slice(0, 16),
        });
        this._handleJoinRequest(dmMailboxId, msg);
        return true;

      case LOBBY_MESSAGE_TYPES.JOIN_RESPONSE:
        log.info("LobbyMessageHandler: Routing JOIN_RESPONSE", {
          accepted: msg.accepted,
          reason: msg.reason,
          hasGroupKey: !!msg.groupKey,
          keyVersion: msg.keyVersion,
          memberCount: msg.members?.length,
        });
        this._handleJoinResponse(dmMailboxId, msg);
        return true;

      case LOBBY_MESSAGE_TYPES.MEMBER_EVENT:
        log.info("LobbyMessageHandler: Routing MEMBER_EVENT", {
          eventType: msg.eventType,
          pubSig: msg.pubSig?.slice(0, 16),
        });
        this._handleMemberEvent(msg);
        return true;

      case LOBBY_MESSAGE_TYPES.KEY_ROTATION:
        log.info("LobbyMessageHandler: Routing KEY_ROTATION", {
          keyVersion: msg.keyVersion,
          reason: msg.reason,
        });
        this._handleKeyRotation(msg);
        return true;

      case LOBBY_MESSAGE_TYPES.LOBBY_LEAVE:
        log.info("LobbyMessageHandler: Routing LOBBY_LEAVE", {
          pubSig: msg.pubSig?.slice(0, 16),
          reason: msg.reason,
        });
        this._handleMemberLeave(dmMailboxId, msg);
        return true;

      case LOBBY_MESSAGE_TYPES.LOBBY_KICKED:
        log.info("LobbyMessageHandler: Routing LOBBY_KICKED", {
          reason: msg.reason,
        });
        this._handleKicked(msg);
        return true;

      case LOBBY_MESSAGE_TYPES.LOBBY_CLOSE:
        log.info("LobbyMessageHandler: Routing LOBBY_CLOSE", {
          reason: msg.reason,
        });
        this._handleLobbyClose(msg);
        return true;

      default:
        log.debug("LobbyMessageHandler: Unrecognized lobby message type", {
          type: msg.type,
        });
        return false;
    }
  }

  /**
   * Process an incoming group message from the DAG
   * Handles both encrypted chat messages and unencrypted control messages.
   * @param {string} groupMailboxId - The group mailbox ID
   * @param {Object} payload - The group message object (encrypted or control)
   * @returns {boolean} - True if message was handled
   */
  async processGroupMessage(groupMailboxId, payload) {
    // Verify this is for our lobby
    if (!this.lobbyManager.lobby) {
      return false;
    }

    if (groupMailboxId !== this.lobbyManager.lobby.groupMailboxId) {
      return false;
    }

    // ─────────────────────────────────────────────────────────────
    // Check for unencrypted control messages (lobby_close, etc.)
    // These are broadcast by the host as single-shot notifications
    // ─────────────────────────────────────────────────────────────
    if (payload && typeof payload.type === "string") {
      switch (payload.type) {
        case LOBBY_MESSAGE_TYPES.LOBBY_CLOSE:
          log.info("LobbyMessageHandler: Received LOBBY_CLOSE via group mailbox", {
            lobbyId: payload.lobbyId?.slice(0, 16),
            reason: payload.reason,
          });
          await this._handleLobbyClose(payload);
          return true;

        case LOBBY_MESSAGE_TYPES.LOBBY_KICKED:
          // Could support targeted kick via group in future
          log.info("LobbyMessageHandler: Received LOBBY_KICKED via group mailbox", {
            reason: payload.reason,
          });
          await this._handleKicked(payload);
          return true;

        default:
          // Not a recognized control message, fall through to encrypted handling
          break;
      }
    }

    // ─────────────────────────────────────────────────────────────
    // Encrypted group chat message
    // ─────────────────────────────────────────────────────────────
    await this.lobbyManager.processGroupMessage(payload);
    return true;
  }

  /**
   * Check if a raw payload is a group message for our lobby
   * @param {string} rawPayload - Raw KKTP payload
   * @returns {{ isGroup: boolean, groupMailboxId?: string, encrypted?: Object }}
   */
  parseGroupPayload(rawPayload) {
    if (!rawPayload.startsWith("KKTP:GROUP:")) {
      return { isGroup: false };
    }

    // Format: KKTP:GROUP:{groupMailboxId}:{json}
    const parts = rawPayload.split(":");
    if (parts.length < 4) {
      return { isGroup: false };
    }

    const groupMailboxId = parts[2];
    const jsonStr = parts.slice(3).join(":");

    try {
      const encrypted = JSON.parse(jsonStr);
      return { isGroup: true, groupMailboxId, encrypted };
    } catch {
      return { isGroup: false };
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Private Handlers
  // ─────────────────────────────────────────────────────────────

  async _handleJoinRequest(dmMailboxId, msg) {
    try {
      await this.lobbyManager.handleJoinRequest(dmMailboxId, msg);
    } catch (err) {
      log.error("LobbyMessageHandler: Failed to handle join request", err);
    }
  }

  async _handleJoinResponse(dmMailboxId, msg) {
    try {
      await this.lobbyManager.handleJoinResponse(dmMailboxId, msg);
    } catch (err) {
      log.error("LobbyMessageHandler: Failed to handle join response", err);
    }
  }

  _handleMemberEvent(msg) {
    try {
      this.lobbyManager.handleMemberEvent(msg);
    } catch (err) {
      log.error("LobbyMessageHandler: Failed to handle member event", err);
    }
  }

  _handleKeyRotation(msg) {
    try {
      this.lobbyManager.handleKeyRotation(msg);
    } catch (err) {
      log.error("LobbyMessageHandler: Failed to handle key rotation", err);
    }
  }

  async _handleMemberLeave(dmMailboxId, msg) {
    // Host receives this when a member leaves voluntarily
    if (!this.lobbyManager.isHost) return;

    const { pubSig, reason } = msg;
    if (!pubSig) return;

    const member = this.lobbyManager.lobby?.members.get(pubSig);
    if (!member) return;

    // Remove from roster
    this.lobbyManager.lobby.members.delete(pubSig);

    // Notify other members
    try {
      await this.lobbyManager._broadcastMemberEvent("leave", { pubSig, reason });
    } catch (err) {
      log.warn("LobbyMessageHandler: Failed to broadcast member leave", err);
    }

    // Emit event
    this.lobbyManager._onMemberLeave?.(pubSig, reason || "Left voluntarily");

    log.info("LobbyMessageHandler: Member left", {
      pubSig: pubSig.slice(0, 16),
      reason,
    });
  }

  async _handleKicked(msg) {
    try {
      await this.lobbyManager.handleKicked(msg);
    } catch (err) {
      log.error("LobbyMessageHandler: Failed to handle kicked", err);
    }
  }

  async _handleLobbyClose(msg) {
    try {
      await this.lobbyManager.handleLobbyClose(msg);
    } catch (err) {
      log.error("LobbyMessageHandler: Failed to handle lobby close", err);
    }
  }
}

export { LOBBY_MESSAGE_TYPES };
