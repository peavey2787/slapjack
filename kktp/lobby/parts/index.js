/**
 * @fileoverview Lobby parts module barrel export.
 *
 * Re-exports all lobby module functions for convenient importing.
 * Import from './parts' or './parts/index.js' to get all exports.
 *
 * @module kktp/lobby/parts
 */

// Context and constants
export {
  LOBBY_STATES,
  MEMBER_ROLES,
  LOBBY_VERSION,
  LOBBY_DISCOVERY_PREFIX,
  DEFAULT_CONFIG,
  createLobbyContext,
  resetLobbyContext,
} from "./lobbyContext.js";

// Utility functions
export {
  uint8ToHex,
  hexToUint8,
  generateGroupKey,
  deriveGroupMailboxId,
  computeStateRoot,
} from "./lobbyUtils.js";

// Subscription management
export {
  subscribePrefix,
  unsubscribePrefix,
  subscribeToGroupMailbox,
  unsubscribeFromGroupMailbox,
  subscribeToDMMailbox,
  unsubscribeFromDMMailbox,
  unsubscribeAllPrefixes,
} from "./lobbySubscriptions.js";

// DM buffer
export {
  isRelevantMailbox,
  bufferDMMessage,
  popBufferedMessages,
  startDMBufferCleanup,
  stopDMBufferCleanup,
  clearDmBuffer,
} from "./lobbyDmBuffer.js";

// UTXO utilities
export {
  waitForUtxoRefresh,
  sendWithRetry,
  isUtxoError,
} from "./lobbyUtxo.js";

// Payload routing
export {
  parseGroupPayload,
  categorizePayload,
  isInLobby,
  isGroupPayloadForThisLobby,
} from "./lobbyRouting.js";

// Messaging
export {
  sendGroupMessage,
  processGroupMessage,
  addToHistory,
  bufferFutureMessage,
  decryptAndProcessMessage,
} from "./lobbyMessaging.js";

// Key management
export {
  initKeyVault,
  updateKeyVault,
  startKeyRotation,
  stopKeyRotation,
  rotateKey,
  handleKeyRotation,
} from "./lobbyKeys.js";

// Roster management
export {
  addMember,
  removeMember,
  createMember,
  broadcastMemberEvent,
  handleMemberEvent,
  exportMemberList,
} from "./lobbyRoster.js";

// Join handling
export {
  handleJoinRequest,
  processJoinQueue,
  acceptPendingJoin,
  rejectPendingJoin,
  sendJoinResponse,
  handleJoinResponse,
} from "./lobbyJoins.js";

// Discovery
export {
  waitForJoinCode,
  resolveJoinCode,
  discoverLobby,
} from "./lobbyDiscovery.js";

// Persistence
export {
  exportLobbyState,
  restoreLobbyState,
} from "./lobbyPersistence.js";

// Session end
export {
  endDMSession,
  endAllMemberDMSessions,
} from "./lobbySessionEnd.js";
