/**
 * LobbyManager - Group session management on top of KKTP
 *
 * Architecture:
 * - Host broadcasts a KKTP discovery anchor with lobby=true
 * - Peers join via private 1:1 KKTP DM with join request
 * - Host distributes GroupKey_vN via encrypted 1:1 DMs
 * - All group messages encrypted with XChaCha20-Poly1305 using groupKey
 * - Key rotation every 10 minutes with state root commitment
 *
 * Refactored orchestrator - delegates to parts/ modules for SRP compliance.
 *
 * @module kktp/lobby/lobbyManager
 */

import { LobbyCodec } from "./lobbyCodec.js";
import { LobbyMessageHandler } from "./lobbyMessageHandler.js";
import {
  validateLobbyMeta,
  validateJoinResponse
} from "./lobbySchemas.js";
import { Logger, LogModule } from "../core/logger.js";

const log = Logger.create(LogModule.lobby.lobbyManager);

// Import from parts/ modules
import {
  LOBBY_STATES,
  MEMBER_ROLES,
  DEFAULT_CONFIG,
  createLobbyContext,
  resetLobbyContext,
} from "./parts/lobbyContext.js";

import {
  uint8ToHex,
  hexToUint8,
  generateGroupKey,
  deriveGroupMailboxId
} from "./parts/lobbyUtils.js";

import {
  subscribePrefix,
  unsubscribePrefix,
  subscribeToGroupMailbox,
  unsubscribeFromGroupMailbox,
  subscribeToDMMailbox,
  unsubscribeFromDMMailbox,
  unsubscribeAllPrefixes,
} from "./parts/lobbySubscriptions.js";

import {
  isRelevantMailbox,
  bufferDMMessage,
  popBufferedMessages,
  startDMBufferCleanup,
  stopDMBufferCleanup,
  clearDmBuffer,
} from "./parts/lobbyDmBuffer.js";

import {
  waitForUtxoRefresh,
  sendWithRetry
} from "./parts/lobbyUtxo.js";

import {
  parseGroupPayload,
  isInLobby,
  isGroupPayloadForThisLobby,
} from "./parts/lobbyRouting.js";

import {
  sendGroupMessage as _sendGroupMessage,
  processGroupMessage as _processGroupMessage,
  processBufferedFutureMessages as _processBufferedFutureMessages,
} from "./parts/lobbyMessaging.js";

import {
  initKeyVault,
  startKeyRotation,
  stopKeyRotation,
  rotateKey as _rotateKey,
  handleKeyRotation,
} from "./parts/lobbyKeys.js";

import {
  addMember,
  removeMember,
  createMember,
  broadcastMemberEvent,
  handleMemberEvent,
  exportMemberList,
} from "./parts/lobbyRoster.js";

import {
  handleJoinRequest as _handleJoinRequest,
  acceptPendingJoin as _acceptPendingJoin,
  rejectPendingJoin as _rejectPendingJoin,
  handleJoinResponse as _handleJoinResponse
} from "./parts/lobbyJoins.js";

import {
  waitForJoinCode as _waitForJoinCode,
  resolveJoinCode,
  discoverLobby as _discoverLobby,
} from "./parts/lobbyDiscovery.js";

import {
  exportLobbyState as _exportLobbyState,
  restoreLobbyState as _restoreLobbyState,
} from "./parts/lobbyPersistence.js";

import {
  endDMSession
} from "./parts/lobbySessionEnd.js";

// Re-export state constants for consumers
export { LOBBY_STATES, MEMBER_ROLES };

// Constants
const LOBBY_DISCOVERY_PREFIX = "KKTP:ANCHOR:";
const LOBBY_VERSION = 1;

/**
 * LobbyManager orchestrator class.
 * Coordinates lobby operations by delegating to focused modules.
 */
export class LobbyManager {
  /**
   * @param {Object} sessionManager - KKTP SessionManager instance
   * @param {Object} options - Configuration options
   * @param {number} [options.maxMembers=16] - Default max members
   * @param {number} [options.keyRotationMs=600000] - Key rotation interval
   * @param {boolean} [options.autoAcceptJoins=true] - Automatically accept join requests
   */
  constructor(sessionManager, options = {}) {
    this.sm = sessionManager;
    this.codec = new LobbyCodec();
    this.handler = new LobbyMessageHandler(this);

    // Build config from options
    this._config = {
      ...DEFAULT_CONFIG,
      maxMembers: options.maxMembers ?? DEFAULT_CONFIG.maxMembers,
      keyRotationMs: options.keyRotationMs ?? DEFAULT_CONFIG.keyRotationMs,
      autoAcceptJoins: options.autoAcceptJoins ?? DEFAULT_CONFIG.autoAcceptJoins,
    };

    // Create the internal context
    this._ctx = createLobbyContext(sessionManager, this._config);

    // Bind callbacks to context
    this._ctx.callbacks = {
      onMemberJoin: null,
      onMemberLeave: null,
      onGroupMessage: null,
      onKeyRotation: null,
      onLobbyClose: null,
      onStateChange: null,
      onJoinRequest: null,
    };

    // Pending join state (member side)
    this._pendingJoin = null;
  }

  // ─────────────────────────────────────────────────────────────
  // Context Accessors
  // ─────────────────────────────────────────────────────────────

  /** @returns {string} Current lobby state */
  get state() {
    return this._ctx.state;
  }

  /** @returns {Object|null} Current lobby info */
  get lobby() {
    return this._ctx.lobby;
  }

  /** @returns {boolean} Whether this client is the lobby host */
  get isHost() {
    return this._ctx.state === LOBBY_STATES.HOSTING;
  }

  /** @returns {boolean} Whether auto-accept is enabled */
  get autoAcceptJoins() {
    return this._config.autoAcceptJoins;
  }

  /** Set auto-accept mode */
  set autoAcceptJoins(value) {
    this._config.autoAcceptJoins = Boolean(value);
    this._ctx.config.autoAcceptJoins = Boolean(value);
  }

  /** @returns {number} Max members default */
  get maxMembersDefault() {
    return this._config.maxMembers;
  }

  /** @returns {Array<Object>} Pending join requests (host only) */
  get pendingJoinRequests() {
    return Array.from(this._ctx.pendingJoins.entries()).map(([pubSig, data]) => ({
      pubSig,
      displayName: data.request.displayName,
      receivedAt: data.receivedAt,
    }));
  }

  // ─────────────────────────────────────────────────────────────
  // Event Registration
  // ─────────────────────────────────────────────────────────────

  onMemberJoin(callback) {
    this._ctx.callbacks.onMemberJoin = callback;
  }

  onMemberLeave(callback) {
    this._ctx.callbacks.onMemberLeave = callback;
  }

  onGroupMessage(callback) {
    this._ctx.callbacks.onGroupMessage = callback;
  }

  onKeyRotation(callback) {
    this._ctx.callbacks.onKeyRotation = callback;
  }

  onLobbyClose(callback) {
    this._ctx.callbacks.onLobbyClose = callback;
  }

  onStateChange(callback) {
    this._ctx.callbacks.onStateChange = callback;
  }

  onJoinRequest(callback) {
    this._ctx.callbacks.onJoinRequest = callback;
  }

  // ─────────────────────────────────────────────────────────────
  // State Management
  // ─────────────────────────────────────────────────────────────

  _setState(newState) {
    const oldState = this._ctx.state;
    if (oldState !== newState) {
      this._ctx.state = newState;
      this._ctx.callbacks.onStateChange?.(newState, oldState);
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Host Operations
  // ─────────────────────────────────────────────────────────────

  /**
   * Host a new lobby.
   * @param {Object} params - Lobby parameters
   * @returns {Promise<Object>} Lobby info including joinCode
   */
  async hostLobby({ lobbyName, gameName, maxMembers, displayName, uptimeSeconds = 3600 }) {
    if (this._ctx.state !== LOBBY_STATES.IDLE) {
      throw new Error(`Cannot host lobby in state: ${this._ctx.state}`);
    }

    if (!lobbyName || typeof lobbyName !== "string") {
      throw new Error("lobbyName is required and must be a string");
    }
    if (!gameName || typeof gameName !== "string") {
      throw new Error("gameName is required and must be a string");
    }

    maxMembers = maxMembers ?? this._config.maxMembers;
    this._setState(LOBBY_STATES.HOSTING);

    try {
      // Build lobby meta
      const meta = {
        game: gameName,
        version: "1.0.0",
        expected_uptime_seconds: uptimeSeconds,
        lobby: true,
        lobby_name: lobbyName,
        max_members: maxMembers,
      };

      validateLobbyMeta(meta);

      // Subscribe to discovery prefix
      subscribePrefix(this._ctx, LOBBY_DISCOVERY_PREFIX);

      // Broadcast discovery with lobby flag
      const result = await this.sm.broadcastDiscovery(meta);
      const discovery = result?.discovery;

      if (!discovery?.sid || !discovery?.pub_sig) {
        throw new Error("Failed to broadcast discovery");
      }

      const lobbyId = discovery.sid;

      // Narrow subscription to our specific discovery
      const specificPrefix = `${LOBBY_DISCOVERY_PREFIX}${lobbyId}`;
      subscribePrefix(this._ctx, specificPrefix);

      // Start scanner if available
      const adapter = this._ctx.adapter;
      if (adapter?.startScanner) {
        try {
          await adapter.startScanner();
        } catch { /* ignore */ }
      }

      // Wait for join code (block hash)
      const joinCode = await _waitForJoinCode(this._ctx, lobbyId, discovery.pub_sig);

      // Generate initial group key
      const groupKey = await generateGroupKey();
      const groupMailboxId = deriveGroupMailboxId(lobbyId);

      // Initialize lobby state
      this._ctx.lobby = {
        lobbyId,
        lobbyName,
        hostPubSig: discovery.pub_sig,
        myPubSig: discovery.pub_sig,
        members: new Map(),
        groupKey,
        keyVersion: 1,
        groupMailboxId,
        maxMembers,
        createdAt: Date.now(),
        state: LOBBY_STATES.HOSTING,
        discovery,
      };

      // Initialize key vault
      initKeyVault(this._ctx, groupKey, 1);

      // Add self as host
      const hostDisplayName = displayName || `${lobbyName} (Host)`;
      const hostMember = createMember(discovery.pub_sig, hostDisplayName, MEMBER_ROLES.HOST);
      addMember(this._ctx, hostMember);

      // Subscribe to group mailbox
      subscribeToGroupMailbox(this._ctx, groupMailboxId);

      // Start key rotation timer – use bound rotateKey so the scheduled
      // rotation also drains buffered future messages after each cycle.
      startKeyRotation(this._ctx, (reason) => this.rotateKey(reason));

      // Start DM buffer cleanup
      startDMBufferCleanup(this._ctx);

      return { lobbyId, discovery, groupMailboxId, joinCode };
    } catch (err) {
      this._setState(LOBBY_STATES.IDLE);
      throw err;
    }
  }

  /**
   * Wait for join code (block hash) for our discovery anchor.
   */
  async waitForJoinCode(sid, pubSig) {
    return _waitForJoinCode(this._ctx, sid, pubSig);
  }

  /**
   * Discover lobbies by scanning live transactions.
   */
  async discoverLobby(options = {}) {
    return _discoverLobby(this._ctx, options);
  }

  /**
   * Handle an incoming join request (host only).
   */
  async handleJoinRequest(dmMailboxId, request) {
    // Self-echo filter
    if (this._ctx.state === LOBBY_STATES.JOINING && this._pendingJoin) {
      if (request.pubSig === this._pendingJoin.myPubSig) {
        return false;
      }
    }
    return _handleJoinRequest(this._ctx, dmMailboxId, request);
  }

  /**
   * Accept a pending join request manually (host only).
   */
  async acceptPendingJoin(pubSig) {
    return _acceptPendingJoin(this._ctx, pubSig);
  }

  /**
   * Reject a pending join request manually (host only).
   */
  async rejectPendingJoin(pubSig, reason = "Rejected by host") {
    return _rejectPendingJoin(this._ctx, pubSig, reason);
  }

  /**
   * Kick a member from the lobby (host only).
   */
  async kickMember(pubSig, reason = "Kicked by host") {
    if (this._ctx.state !== LOBBY_STATES.HOSTING) {
      throw new Error("Only host can kick members");
    }

    const { lobby, adapter } = this._ctx;
    if (!lobby) throw new Error("No active lobby");

    const member = lobby.members.get(pubSig);
    if (!member) {
      throw new Error("Member not found");
    }

    if (member.role === MEMBER_ROLES.HOST) {
      throw new Error("Cannot kick the host");
    }

    log.info("KKTP Lobby: Kicking member", {
      pubSig: pubSig?.slice(0, 16),
      displayName: member.displayName,
      reason,
    });

    // Build kick message
    const kickMsg = {
      type: "lobby_kick",
      version: LOBBY_VERSION,
      lobbyId: lobby.lobbyId,
      pubSig,
      reason,
      timestamp: Date.now(),
    };

    // Send via DM if available
    if (member.dmMailboxId) {
      try {
        await sendWithRetry(this._ctx, member.dmMailboxId, JSON.stringify(kickMsg), 2);
      } catch (err) {
        log.warn("KKTP Lobby: Failed to send kick message via DM", err.message);
      }
    }

    // Broadcast to group
    await broadcastMemberEvent(this._ctx, "leave", member, reason);

    // End DM session
    if (member.dmMailboxId) {
      await endDMSession(this._ctx, member.dmMailboxId, reason);
    }

    // Remove from roster
    removeMember(this._ctx, pubSig, reason);
  }

  /**
   * Rotate the group encryption key (host only).
   * After updating the local key vault, drains any buffered future
   * messages that peers may have sent with the new key version before
   * the host finished its own rotation.
   */
  async rotateKey(reason = "Scheduled rotation") {
    const result = await _rotateKey(this._ctx, reason);

    // Drain messages that arrived encrypted with the new key while
    // the host was still on the old version.
    try {
      await _processBufferedFutureMessages(this._ctx, this.codec);
    } catch (err) {
      log.warn("KKTP Lobby: Failed to process buffered messages after key rotation", err);
    }

    return result;
  }

  /**
   * Close the lobby (host only).
   */
  async closeLobby(reason = "Lobby closed by host") {
    if (this._ctx.state !== LOBBY_STATES.HOSTING) {
      throw new Error("Only host can close lobby");
    }

    const { lobby, adapter } = this._ctx;
    if (!lobby?.groupMailboxId) {
      throw new Error("No lobby to close");
    }

    log.info("KKTP Lobby: Closing lobby", {
      lobbyId: lobby.lobbyId?.slice(0, 16),
      reason,
    });

    // Stop key rotation
    stopKeyRotation(this._ctx);

    // Build close notification
    const closeMsg = {
      type: "lobby_close",
      version: LOBBY_VERSION,
      lobbyId: lobby.lobbyId,
      hostPubSig: lobby.hostPubSig,
      reason,
      timestamp: Date.now(),
    };

    // Broadcast to group mailbox
    try {
      const payload = `KKTP:GROUP:${lobby.groupMailboxId}:${JSON.stringify(closeMsg)}`;
      const address = await adapter.getAddress();
      await adapter.send({ toAddress: address, amount: "1", payload });
    } catch (err) {
      log.warn("KKTP Lobby: Failed to broadcast close", err.message);
    }

    await waitForUtxoRefresh(this._ctx);

    // Emit event before cleanup
    this._ctx.callbacks.onLobbyClose?.(reason);

    // Cleanup
    this._cleanup();
  }

  // ─────────────────────────────────────────────────────────────
  // Member Operations
  // ─────────────────────────────────────────────────────────────

  /**
   * Request to join a lobby.
   */
  async joinLobby(joinCodeOrDiscovery, displayName) {
    let lobbyDiscovery = joinCodeOrDiscovery;

    // Resolve join code to discovery anchor
    if (typeof joinCodeOrDiscovery === "string") {
      lobbyDiscovery = await resolveJoinCode(this._ctx, joinCodeOrDiscovery);
      if (!lobbyDiscovery) {
        throw new Error("No discovery anchor found for join code");
      }
    }

    // Unwrap search-result wrapper (discoverLobby returns { discovery: anchor, ... })
    if (lobbyDiscovery?.discovery && !lobbyDiscovery.sid) {
      lobbyDiscovery = lobbyDiscovery.discovery;
    }

    if (this._ctx.state !== LOBBY_STATES.IDLE) {
      throw new Error(`Cannot join lobby in state: ${this._ctx.state}`);
    }

    if (!lobbyDiscovery?.meta?.lobby) {
      throw new Error("Discovery is not a lobby anchor");
    }
    if (!lobbyDiscovery.sid || !lobbyDiscovery.pub_sig) {
      throw new Error("Invalid lobby discovery");
    }

    displayName = displayName || "Unknown Kaspian";
    this._setState(LOBBY_STATES.JOINING);

    try {
      // Connect to host
      const connectResult = await this.sm.connectToPeer(lobbyDiscovery);
      if (!connectResult?.mailboxId) {
        throw new Error("Failed to connect to lobby host");
      }

      const dmMailboxId = connectResult.mailboxId;
      const myPubSig = connectResult.response?.pub_sig_resp;
      if (!myPubSig) {
        throw new Error("Failed to get identity from response anchor");
      }

      await waitForUtxoRefresh(this._ctx);

      // Build join request
      const joinRequest = {
        type: "lobby_join_request",
        version: LOBBY_VERSION,
        lobbyId: lobbyDiscovery.sid,
        pubSig: myPubSig,
        displayName,
        timestamp: Date.now(),
      };

      await sendWithRetry(this._ctx, dmMailboxId, JSON.stringify(joinRequest), 3);

      // Store pending state
      this._pendingJoin = {
        lobbyDiscovery,
        dmMailboxId,
        myPubSig,
        displayName,
        lobbyId: lobbyDiscovery.sid,
        hostPubSig: lobbyDiscovery.pub_sig,
        sentAt: Date.now(),
      };

      this._ctx.pendingJoinDmMailboxId = dmMailboxId;

      log.info("KKTP Lobby: Join request sent", {
        lobbyId: lobbyDiscovery.sid?.slice(0, 16),
        dmMailboxId: dmMailboxId?.slice(0, 16),
      });

      return { pending: true, lobbyId: lobbyDiscovery.sid, dmMailboxId, lobbyName: lobbyDiscovery?.meta?.lobby_name ?? null };
    } catch (err) {
      this._setState(LOBBY_STATES.IDLE);
      this._pendingJoin = null;
      throw err;
    }
  }

  /**
   * Handle join response from host.
   */
  async handleJoinResponse(dmMailboxId, response) {
    if (this._ctx.state !== LOBBY_STATES.JOINING) {
      return;
    }

    try {
      validateJoinResponse(response);
    } catch (err) {
      log.warn("KKTP Lobby: Invalid join response", err.message);
      return;
    }

    if (!response.accepted) {
      log.warn("KKTP Lobby: Join rejected", response.reason);
      this._setState(LOBBY_STATES.IDLE);
      this._pendingJoin = null;
      return;
    }

    const { groupKey, keyVersion, groupMailboxId, members, lobbyId, lobbyName } = response;

    if (!this._pendingJoin) {
      log.error("KKTP Lobby: No pending join data");
      this._setState(LOBBY_STATES.IDLE);
      return;
    }

    // Initialize lobby state as member
    const membersMap = new Map();
    if (Array.isArray(members)) {
      for (const m of members) {
        membersMap.set(m.pubSig, {
          ...m,
          dmMailboxId: m.dmMailboxId || null,
        });
      }
    }

    const pendingJoin = this._pendingJoin;
    if (!pendingJoin) {
      log.error("KKTP Lobby: Pending join data cleared before response handling");
      this._setState(LOBBY_STATES.IDLE);
      return;
    }

    this._ctx.lobby = {
      lobbyId,
      lobbyName,
      hostPubSig: pendingJoin.hostPubSig,
      myPubSig: pendingJoin.myPubSig,
      members: membersMap,
      groupKey: hexToUint8(groupKey),
      keyVersion,
      groupMailboxId,
      maxMembers: response.maxMembers ?? this._config.maxMembers,
      createdAt: response.createdAt ?? Date.now(),
      state: LOBBY_STATES.MEMBER,
      dmMailboxId: pendingJoin.dmMailboxId,
    };

    // Initialize key vault
    initKeyVault(this._ctx, this._ctx.lobby.groupKey, keyVersion);

    // Subscribe to group mailbox
    subscribeToGroupMailbox(this._ctx, groupMailboxId);

    // Track host DM mailbox for receiving key rotations
    this._ctx.hostDmMailboxId = pendingJoin.dmMailboxId;
    subscribeToDMMailbox(this._ctx, pendingJoin.dmMailboxId);

    // Clear pending join tracking
    this._ctx.pendingJoinDmMailboxId = null;
    this._pendingJoin = null;

    this._setState(LOBBY_STATES.MEMBER);

    // Emit member join for self
    const selfPubSig = response.yourPubSig || pendingJoin.myPubSig;
    const selfMember = this._ctx.lobby.members.get(selfPubSig);
    if (selfMember) {
      this._ctx.callbacks.onMemberJoin?.(selfMember);
    }

    // Start DM buffer cleanup
    startDMBufferCleanup(this._ctx);
  }

  /**
   * Handle being kicked from the lobby.
   */
  async handleKicked(kickMsg) {
    if (!isInLobby(this._ctx)) return;

    log.info("KKTP Lobby: Kicked from lobby", {
      reason: kickMsg.reason,
    });

    const hostDmMailboxId = this._ctx.hostDmMailboxId;
    if (hostDmMailboxId) {
      await endDMSession(this._ctx, hostDmMailboxId, kickMsg.reason);
    }

    this._ctx.callbacks.onLobbyClose?.(kickMsg.reason);
    this._cleanup();
  }

  /**
   * Handle lobby close notification.
   */
  async handleLobbyClose(closeMsg) {
    if (!isInLobby(this._ctx)) return;

    log.info("KKTP Lobby: Lobby closed", {
      reason: closeMsg.reason,
    });

    const hostDmMailboxId = this._ctx.hostDmMailboxId;
    if (hostDmMailboxId) {
      await endDMSession(this._ctx, hostDmMailboxId, closeMsg.reason);
    }

    this._ctx.callbacks.onLobbyClose?.(closeMsg.reason);
    this._cleanup();
  }

  /**
   * Leave the lobby voluntarily (member only).
   */
  async leaveLobby(reason = "Left voluntarily") {
    if (!isInLobby(this._ctx)) {
      throw new Error("Not in a lobby");
    }

    const { lobby, adapter } = this._ctx;
    const hostDmMailboxId = this._ctx.hostDmMailboxId;

    log.info("KKTP Lobby: Leaving lobby", {
      lobbyId: lobby.lobbyId?.slice(0, 16),
      reason,
    });

    // Notify host via DM
    if (hostDmMailboxId) {
      const leaveMsg = {
        type: "lobby_leave",
        version: LOBBY_VERSION,
        lobbyId: lobby.lobbyId,
        reason,
        timestamp: Date.now(),
      };

      try {
        await sendWithRetry(this._ctx, hostDmMailboxId, JSON.stringify(leaveMsg), 2);
      } catch { /* ignore */ }

      await endDMSession(this._ctx, hostDmMailboxId, reason);
    }

    this._cleanup();
  }

  // ─────────────────────────────────────────────────────────────
  // Messaging
  // ─────────────────────────────────────────────────────────────

  /**
   * Send a group message to all lobby members.
   */
  async sendGroupMessage(plaintext) {
    return _sendGroupMessage(this._ctx, this.codec, plaintext);
  }

  /**
   * Process an incoming encrypted group message.
   */
  async processGroupMessage(encrypted) {
    return _processGroupMessage(this._ctx, this.codec, encrypted);
  }

  /**
   * Handle incoming key rotation message.
   */
  async handleKeyRotation(keyRotationMsg) {
    return handleKeyRotation(this._ctx, this.codec, keyRotationMsg);
  }

  /**
   * Handle incoming member event.
   */
  async handleMemberEvent(event) {
    return handleMemberEvent(this._ctx, event);
  }

  // ─────────────────────────────────────────────────────────────
  // Payload Routing
  // ─────────────────────────────────────────────────────────────

  /**
   * Process a raw group payload.
   */
  async processGroupPayload(rawPayload) {
    const parsed = parseGroupPayload(rawPayload);
    if (!parsed) return null;

    if (!isGroupPayloadForThisLobby(this._ctx, parsed.groupMailboxId)) {
      return null;
    }

    return this.routeGroupMessage(parsed.groupMailboxId, parsed.encrypted);
  }

  /**
   * Route an encrypted group message by type.
   */
  async routeGroupMessage(groupMailboxId, encrypted) {
    if (!encrypted || typeof encrypted !== "object") {
      return null;
    }

    switch (encrypted.type) {
      case "group_message":
        return this.processGroupMessage(encrypted);
      case "key_rotation":
        return this.handleKeyRotation(encrypted);
      case "member_event":
        return this.handleMemberEvent(encrypted);
      case "lobby_kick":
        return this.handleKicked(encrypted);
      case "lobby_close":
        return this.handleLobbyClose(encrypted);
      case "lobby_leave":
        if (this._ctx.state === LOBBY_STATES.HOSTING) {
          const pubSig = encrypted.pubSig;
          if (pubSig) {
            removeMember(this._ctx, pubSig, encrypted.reason);
          }
        }
        return encrypted;
      default:
        log.debug("KKTP Lobby: Unknown group message type", encrypted.type);
        return null;
    }
  }

  // ─────────────────────────────────────────────────────────────
  // DM Buffer
  // ─────────────────────────────────────────────────────────────

  isRelevantMailbox(mailboxId) {
    return isRelevantMailbox(this._ctx, mailboxId);
  }

  bufferDMMessage(mailboxId, payload) {
    return bufferDMMessage(this._ctx, mailboxId, payload);
  }

  popBufferedMessages(mailboxId) {
    return popBufferedMessages(this._ctx, mailboxId);
  }

  // ─────────────────────────────────────────────────────────────
  // Subscriptions
  // ─────────────────────────────────────────────────────────────

  _subscribePrefix(prefix) {
    subscribePrefix(this._ctx, prefix);
  }

  _unsubscribePrefix(prefix) {
    unsubscribePrefix(this._ctx, prefix);
  }

  _subscribeToGroupMailbox(groupMailboxId) {
    subscribeToGroupMailbox(this._ctx, groupMailboxId);
  }

  _unsubscribeFromGroupMailbox(groupMailboxId) {
    unsubscribeFromGroupMailbox(this._ctx, groupMailboxId);
  }

  subscribeToDMMailbox(dmMailboxId) {
    subscribeToDMMailbox(this._ctx, dmMailboxId);
  }

  unsubscribeFromDMMailbox(dmMailboxId) {
    unsubscribeFromDMMailbox(this._ctx, dmMailboxId);
  }

  // ─────────────────────────────────────────────────────────────
  // Persistence
  // ─────────────────────────────────────────────────────────────

  exportLobbyState() {
    return _exportLobbyState(this._ctx);
  }

  async restoreLobbyState(snapshot) {
    return _restoreLobbyState(this._ctx, snapshot);
  }

  // ─────────────────────────────────────────────────────────────
  // Utilities
  // ─────────────────────────────────────────────────────────────

  _uint8ToHex(bytes) {
    return uint8ToHex(bytes);
  }

  _hexToUint8(hex) {
    return hexToUint8(hex);
  }

  async _getMyPubSig() {
    return this.sm?.getMyPubSig?.() || null;
  }

  getMessageHistory() {
    return [...this._ctx.messageHistory];
  }

  getMemberList() {
    return exportMemberList(this._ctx);
  }

  // ─────────────────────────────────────────────────────────────
  // Cleanup
  // ─────────────────────────────────────────────────────────────

  _cleanup() {
    stopKeyRotation(this._ctx);
    stopDMBufferCleanup(this._ctx);
    unsubscribeAllPrefixes(this._ctx);
    clearDmBuffer(this._ctx);
    resetLobbyContext(this._ctx);
    this._pendingJoin = null;
    this._setState(LOBBY_STATES.IDLE);
  }
}
