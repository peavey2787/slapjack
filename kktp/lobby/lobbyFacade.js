// LobbyFacade - Single entry point for lobby operations
import { LobbyManager, LOBBY_STATES, MEMBER_ROLES } from "./lobbyManager.js";

/**
 * LobbyFacade
 * Provides a clean, stable API for hosting/joining lobbies,
 * routing DM/group messages, and accessing lobby state.
 *
 * This is the primary API for lobby operations.
 */
export class LobbyFacade {
  /**
   * @param {import("../protocol/sessions/sessionFacade.js").SessionFacade} sessionManager
   * @param {Object} [options]
   */
  constructor(sessionManager, options = {}) {
    this._manager = new LobbyManager(sessionManager, options);

    // Register lobby manager with session manager for persistence
    sessionManager.setLobbyManager?.(this._manager);
  }

  // ─────────────────────────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────────────────────────

  async hostLobby(options) {
    return await this._manager.hostLobby(options);
  }

  async joinLobby(lobbyDiscovery, displayName) {
    return await this._manager.joinLobby(lobbyDiscovery, displayName);
  }

  async leaveLobby(reason) {
    return await this._manager.leaveLobby(reason);
  }

  async closeLobby(reason) {
    return await this._manager.closeLobby(reason);
  }

  async discoverLobby(options) {
    return await this._manager.discoverLobby(options);
  }

  async sendGroupMessage(plaintext) {
    return await this._manager.sendGroupMessage(plaintext);
  }

  // ─────────────────────────────────────────────────────────────
  // Incoming Message Routing - Primary API for message handling
  // ─────────────────────────────────────────────────────────────

  /**
   * Route a decrypted DM plaintext to the lobby handler.
   * Call this when you receive a DM message to check if it's lobby-related.
   * @param {string} mailboxId - The DM mailbox ID
   * @param {string} plaintext - The decrypted message content
   * @returns {boolean} True if message was handled as lobby message
   */
  routeDMMessage(mailboxId, plaintext) {
    return this._manager.handler.processDMMessage(mailboxId, plaintext);
  }

  /**
   * Process a group message payload for this lobby.
   * Handles the full flow: parse, validate, decrypt, and emit event.
   * @param {string} rawPayload - Raw KKTP:GROUP payload
   * @returns {Promise<{ handled: boolean, message?: Object, error?: string }|null>}
   */
  async processGroupPayload(rawPayload) {
    return await this._manager.processGroupPayload(rawPayload);
  }

  /**
   * Process an encrypted group message for this lobby.
   * @param {string} groupMailboxId - The group mailbox ID
   * @param {Object} encrypted - The encrypted group message object
   * @returns {Promise<boolean>} True if handled successfully
   */
  async routeGroupMessage(groupMailboxId, encrypted) {
    return await this._manager.routeGroupMessage(groupMailboxId, encrypted);
  }

  /**
   * Check if a mailbox ID is relevant to this lobby.
   * Used to filter incoming DM messages before processing/buffering.
   * @param {string} mailboxId - The DM mailbox ID
   * @returns {boolean}
   */
  isRelevantMailbox(mailboxId) {
    return this._manager.isRelevantMailbox(mailboxId);
  }

  // ─────────────────────────────────────────────────────────────
  // Prefix Subscription Management
  // ─────────────────────────────────────────────────────────────

  /**
   * Subscribe to a DM mailbox for receiving 1:1 messages.
   * @param {string} mailboxId - The DM mailbox ID
   */
  subscribeToDMMailbox(mailboxId) {
    this._manager.subscribeToDMMailbox(mailboxId);
  }

  /**
   * Unsubscribe from a DM mailbox.
   * @param {string} mailboxId - The DM mailbox ID
   */
  unsubscribeFromDMMailbox(mailboxId) {
    this._manager.unsubscribeFromDMMailbox(mailboxId);
  }

  // ─────────────────────────────────────────────────────────────
  // DM Buffer Management
  // ─────────────────────────────────────────────────────────────

  /**
   * Buffer a DM message for later processing when session is established.
   * @param {string} mailboxId - The DM mailbox ID
   * @param {string} payload - Raw payload to buffer
   */
  bufferDMMessage(mailboxId, payload) {
    this._manager.bufferDMMessage(mailboxId, payload);
  }

  /**
   * Get and clear buffered messages for a mailbox.
   * @param {string} mailboxId
   * @returns {Array<{ payload: string, timestamp: number }>}
   */
  popBufferedMessages(mailboxId) {
    return this._manager.popBufferedMessages(mailboxId);
  }

  // ─────────────────────────────────────────────────────────────
  // Events (pass-through)
  // ─────────────────────────────────────────────────────────────

  onMemberJoin(cb) { this._manager.onMemberJoin(cb); }
  onMemberLeave(cb) { this._manager.onMemberLeave(cb); }
  onGroupMessage(cb) { this._manager.onGroupMessage(cb); }
  onKeyRotation(cb) { this._manager.onKeyRotation(cb); }
  onLobbyClose(cb) { this._manager.onLobbyClose(cb); }
  onStateChange(cb) { this._manager.onStateChange(cb); }
  onJoinRequest(cb) { this._manager.onJoinRequest(cb); }

  // ─────────────────────────────────────────────────────────────
  // State accessors
  // ─────────────────────────────────────────────────────────────

  get currentState() { return this._manager.state; }
  get lobbyInfo() { return this._manager.lobby; }
  get members() { return this._manager.getMemberList(); }
  get messageHistory() { return this._manager.getMessageHistory(); }
  get isHost() { return this._manager.state === LOBBY_STATES.HOSTING; }
  get pendingJoinRequests() { return this._manager.pendingJoinRequests; }

  /**
   * Check if we are currently in a lobby (hosting or member).
   * @returns {boolean}
   */
  isInLobby() {
    return (
      this._manager.state === LOBBY_STATES.HOSTING ||
      this._manager.state === LOBBY_STATES.MEMBER
    );
  }

  /**
   * Get the current lobby's group mailbox ID.
   * @returns {string|null}
   */
  getGroupMailboxId() {
    return this._manager.lobby?.groupMailboxId ?? null;
  }

  // ─────────────────────────────────────────────────────────────
  // Member Management (Host only)
  // ─────────────────────────────────────────────────────────────

  async acceptPendingJoin(pubSig) {
    return await this._manager.acceptPendingJoin(pubSig);
  }

  async rejectPendingJoin(pubSig, reason) {
    return await this._manager.rejectPendingJoin(pubSig, reason);
  }

  async kickMember(pubSig, reason) {
    return await this._manager.kickMember(pubSig, reason);
  }

  async rotateKey(reason) {
    return await this._manager.rotateKey(reason);
  }

  // Expose enums for convenience
  static get STATES() { return LOBBY_STATES; }
  static get ROLES() { return MEMBER_ROLES; }
}

export { LOBBY_STATES, MEMBER_ROLES };
