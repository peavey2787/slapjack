/**
 * LobbyContext - Context object creation and state initialization
 *
 * The ctx object is the shared state container passed to all lobby module functions.
 * LobbyManager holds the master state; modules operate on ctx references.
 *
 * @module kktp/lobby/parts/lobbyContext
 */

import { Logger, LogModule } from "../../core/logger.js";

const log = Logger.create(LogModule.lobby.parts.lobbyContext);

/**
 * Lobby states
 */
export const LOBBY_STATES = {
  IDLE: "IDLE",
  HOSTING: "HOSTING",
  JOINING: "JOINING",
  MEMBER: "MEMBER",
  CLOSED: "CLOSED",
};

/**
 * Member roles
 */
export const MEMBER_ROLES = {
  HOST: "host",
  MEMBER: "member",
};

/**
 * Protocol constants
 */
export const LOBBY_VERSION = 1;
export const LOBBY_DISCOVERY_PREFIX = "KKTP:ANCHOR:";

/**
 * Default configuration values
 */
export const DEFAULT_CONFIG = {
  maxMembers: 16,
  keyRotationMs: 10 * 60 * 1000, // 10 minutes
  autoAcceptJoins: true,
  maxHistorySize: 1000,
  dmBufferTtlMs: 30_000,
  dmBufferMaxPerMailbox: 5,
  dmBufferCleanupIntervalMs: 10_000,
  futureBufferMaxSize: 20,
  futureBufferTtlMs: 60_000,
};

/**
 * @typedef {Object} LobbyConfig
 * @property {number} maxMembers - Maximum members allowed
 * @property {number} keyRotationMs - Key rotation interval in ms
 * @property {boolean} autoAcceptJoins - Auto-accept join requests
 * @property {number} maxHistorySize - Max message history size
 * @property {number} dmBufferTtlMs - DM buffer TTL in ms
 * @property {number} dmBufferMaxPerMailbox - Max buffered DMs per mailbox
 * @property {number} dmBufferCleanupIntervalMs - DM buffer cleanup interval
 * @property {number} futureBufferMaxSize - Max future messages to buffer
 * @property {number} futureBufferTtlMs - Future message buffer TTL
 */

/**
 * @typedef {Object} LobbyCallbacks
 * @property {function|null} onMemberJoin - Member join callback
 * @property {function|null} onMemberLeave - Member leave callback
 * @property {function|null} onGroupMessage - Group message callback
 * @property {function|null} onKeyRotation - Key rotation callback
 * @property {function|null} onLobbyClose - Lobby close callback
 * @property {function|null} onStateChange - State change callback
 * @property {function|null} onJoinRequest - Join request callback (host only)
 */

/**
 * @typedef {Object} KeyVault
 * @property {{ key: Uint8Array, version: number }|null} current - Current key
 * @property {{ key: Uint8Array, version: number }|null} previous - Previous key (for late messages)
 */

/**
 * @typedef {Object} LobbyContext
 * @property {Object} sm - Session manager
 * @property {Object} adapter - Blockchain adapter (sm.adapter shortcut)
 * @property {string} state - Current lobby state
 * @property {Object|null} lobby - Active lobby object
 * @property {KeyVault} keyVault - Key vault for current/previous keys
 * @property {Set<string>} subscriptions - Subscribed prefixes
 * @property {Array} messageHistory - Message history
 * @property {LobbyConfig} config - Configuration
 * @property {LobbyCallbacks} callbacks - Event callbacks
 * @property {Map} dmBuffer - DM message buffer
 * @property {Array} futureMessageBuffer - Future key version messages
 * @property {Map} pendingJoins - Pending join requests (host only)
 * @property {Array} joinRequestQueue - Join request queue
 * @property {boolean} isProcessingJoinQueue - Queue processing flag
 * @property {number|null} keyRotationTimer - Key rotation timer ID
 * @property {number|null} dmBufferCleanupTimer - DM buffer cleanup timer ID
 * @property {Object|null} pendingJoin - Pending join data (member only)
 * @property {string|null} pendingJoinDmMailboxId - Pending join DM mailbox
 * @property {string|null} hostDmMailboxId - Host DM mailbox (member only)
 */

/**
 * Create default callbacks object
 * @returns {LobbyCallbacks}
 */
export function createDefaultCallbacks() {
  return {
    onMemberJoin: null,
    onMemberLeave: null,
    onGroupMessage: null,
    onKeyRotation: null,
    onLobbyClose: null,
    onStateChange: null,
    onJoinRequest: null,
  };
}

/**
 * Create default key vault
 * @returns {KeyVault}
 */
export function createDefaultKeyVault() {
  return {
    current: null,
    previous: null,
  };
}

/**
 * Create a lobby context object
 * @param {Object} sessionManager - KKTP session manager
 * @param {Partial<LobbyConfig>} [options] - Configuration overrides
 * @returns {LobbyContext}
 */
export function createLobbyContext(sessionManager, options = {}) {
  const config = {
    ...DEFAULT_CONFIG,
    maxMembers: options.maxMembers ?? DEFAULT_CONFIG.maxMembers,
    keyRotationMs: options.keyRotationMs ?? DEFAULT_CONFIG.keyRotationMs,
    autoAcceptJoins: options.autoAcceptJoins ?? DEFAULT_CONFIG.autoAcceptJoins,
  };

  return {
    // Core dependencies
    sm: sessionManager,
    adapter: sessionManager?.adapter ?? null,

    // State
    state: LOBBY_STATES.IDLE,
    lobby: null,

    // Key management
    keyVault: createDefaultKeyVault(),

    // Subscriptions
    subscriptions: new Set(),

    // Message handling
    messageHistory: [],
    futureMessageBuffer: [],

    // DM buffer for race conditions
    dmBuffer: new Map(),
    dmBufferCleanupTimer: null,

    // Join management
    pendingJoins: new Map(),
    joinRequestQueue: [],
    isProcessingJoinQueue: false,
    pendingJoin: null,
    pendingJoinDmMailboxId: null,
    hostDmMailboxId: null,

    // Timers
    keyRotationTimer: null,

    // Configuration
    config,

    // Callbacks
    callbacks: createDefaultCallbacks(),
  };
}

/**
 * Reset lobby context to idle state
 * Clears all lobby-specific state while preserving configuration and callbacks.
 * @param {LobbyContext} ctx
 */
export function resetLobbyContext(ctx) {
  // Stop timers
  if (ctx.keyRotationTimer) {
    clearInterval(ctx.keyRotationTimer);
    ctx.keyRotationTimer = null;
  }
  if (ctx.dmBufferCleanupTimer) {
    clearInterval(ctx.dmBufferCleanupTimer);
    ctx.dmBufferCleanupTimer = null;
  }

  // Clear state
  ctx.state = LOBBY_STATES.IDLE;
  ctx.lobby = null;
  ctx.keyVault = createDefaultKeyVault();
  ctx.subscriptions.clear();
  ctx.messageHistory = [];
  ctx.futureMessageBuffer = [];
  ctx.dmBuffer.clear();
  ctx.pendingJoins.clear();
  ctx.joinRequestQueue = [];
  ctx.isProcessingJoinQueue = false;
  ctx.pendingJoin = null;
  ctx.pendingJoinDmMailboxId = null;
  ctx.hostDmMailboxId = null;
}

/**
 * Set lobby state with callback notification
 * @param {LobbyContext} ctx
 * @param {string} newState - New state from LOBBY_STATES
 */
export function setState(ctx, newState) {
  const oldState = ctx.state;
  if (oldState === newState) return;

  ctx.state = newState;

  log.info("KKTP Lobby: State transition", {
    oldState,
    newState,
    isHost: ctx.state === LOBBY_STATES.HOSTING,
    lobbyId: ctx.lobby?.lobbyId?.slice(0, 16),
    memberCount: ctx.lobby?.members?.size,
  });

  ctx.callbacks.onStateChange?.(newState, oldState);
}
