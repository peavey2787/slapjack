/**
 * KKTP Lobby Module - Group sessions on top of KKTP
 *
 * This module provides lobby/group session functionality built on top of
 * the 1:1 KKTP protocol. It enables multi-party communication with:
 *
 * - Host-managed lobbies with discovery anchors
 * - Encrypted group messaging using XChaCha20-Poly1305
 * - Automatic key rotation every 10 minutes
 * - Member management (join, leave, kick)
 * - State root commitments for integrity
 *
 * Architecture:
 * - Host broadcasts a KKTP discovery anchor with lobby=true
 * - Peers join via private 1:1 KKTP DM with join request
 * - Host distributes GroupKey_vN via encrypted 1:1 DMs
 * - All group messages encrypted with group key and broadcast to group mailbox
 *
 * Usage:
 * ```js
 * import { LobbyFacade, LOBBY_STATES } from 'kktp/lobby';
 *
 * const lobby = new LobbyFacade(sessionManager, { autoAcceptJoins: true });
 *
 * // Host a lobby
 * await lobby.hostLobby({ lobbyName: 'My Lobby', gameName: 'KKTP Chat' });
 *
 * // Route incoming messages
 * lobby.routeDMMessage(mailboxId, plaintext);
 * lobby.routeGroupMessage(groupMailboxId, encrypted);
 * ```
 *
 * @module kktp/lobby
 */

// Primary API - Use LobbyFacade for clean, stable interface
export { LobbyFacade, LOBBY_STATES, MEMBER_ROLES } from "./lobbyFacade.js";

// Internal - Only use if you need low-level access
export { LobbyManager } from "./lobbyManager.js";
export { LobbyMessageHandler, LOBBY_MESSAGE_TYPES } from "./lobbyMessageHandler.js";
export { LobbyCodec } from "./lobbyCodec.js";

// Validation utilities
export {
  LobbyValidationError,
  validateLobbyMeta,
  validateJoinRequest,
  validateJoinResponse,
  validateGroupMessage,
  validateKeyRotation,
  validateMemberEvent,
  validateLeaveMessage,
  validateKickMessage,
  validateCloseMessage,
  isLobbyDiscovery,
  extractLobbyInfo,
} from "./lobbySchemas.js";
