/**
 * LobbySchemas - Validation functions for lobby protocol messages
 *
 * Provides runtime validation for all lobby message types to ensure
 * protocol compliance and prevent malformed data from causing issues.
 *
 * @module kktp/lobby/lobbySchemas
 */

/**
 * Custom error for lobby validation failures
 */
export class LobbyValidationError extends Error {
  constructor(message, field) {
    super(`Lobby validation failed: ${message}${field ? ` at '${field}'` : ""}`);
    this.name = "LobbyValidationError";
    this.field = field;
  }
}

/**
 * Assert a condition or throw validation error
 * @private
 */
function assert(condition, message, field) {
  if (!condition) {
    throw new LobbyValidationError(message, field);
  }
}

/**
 * Check if value is a non-empty string
 * @private
 */
function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

/**
 * Check if value is a positive integer
 * @private
 */
function isPositiveInt(value) {
  return Number.isInteger(value) && value > 0;
}

/**
 * Check if value is a valid hex string
 * @private
 */
function isHexString(value) {
  return typeof value === "string" && /^[0-9a-f]+$/i.test(value);
}

/**
 * Validate lobby meta fields in discovery anchor
 * @param {Object} meta - Discovery meta object
 * @throws {LobbyValidationError}
 */
export function validateLobbyMeta(meta) {
  assert(meta && typeof meta === "object", "Meta must be an object", "meta");
  assert(isNonEmptyString(meta.game), "game must be a non-empty string", "meta.game");
  assert(isNonEmptyString(meta.version), "version must be a non-empty string", "meta.version");
  assert(
    isPositiveInt(meta.expected_uptime_seconds),
    "expected_uptime_seconds must be a positive integer",
    "meta.expected_uptime_seconds",
  );
  assert(meta.lobby === true, "lobby must be true for lobby discovery", "meta.lobby");
  assert(
    isNonEmptyString(meta.lobby_name),
    "lobby_name must be a non-empty string",
    "meta.lobby_name",
  );
  assert(
    isPositiveInt(meta.max_members),
    "max_members must be a positive integer",
    "meta.max_members",
  );
}

/**
 * Validate a join request message
 * @param {Object} request - Join request message
 * @throws {LobbyValidationError}
 */
export function validateJoinRequest(request) {
  assert(request && typeof request === "object", "Request must be an object");
  assert(
    request.type === "lobby_join_request",
    "type must be 'lobby_join_request'",
    "type",
  );
  assert(isPositiveInt(request.version), "version must be a positive integer", "version");
  assert(isHexString(request.lobbyId), "lobbyId must be a hex string", "lobbyId");
  assert(isHexString(request.pubSig), "pubSig must be a hex string", "pubSig");
  assert(
    isNonEmptyString(request.displayName),
    "displayName must be a non-empty string",
    "displayName",
  );
}

/**
 * Validate a join response message
 * @param {Object} response - Join response message
 * @throws {LobbyValidationError}
 */
export function validateJoinResponse(response) {
  assert(response && typeof response === "object", "Response must be an object");
  assert(
    response.type === "lobby_join_response",
    "type must be 'lobby_join_response'",
    "type",
  );
  assert(isPositiveInt(response.version), "version must be a positive integer", "version");
  assert(isHexString(response.lobbyId), "lobbyId must be a hex string", "lobbyId");
  assert(typeof response.accepted === "boolean", "accepted must be a boolean", "accepted");

  // If accepted, must include additional fields
  if (response.accepted) {
    assert(isHexString(response.groupKey), "groupKey must be a hex string", "groupKey");
    assert(
      response.groupKey.length === 64,
      "groupKey must be 32 bytes (64 hex chars)",
      "groupKey",
    );
    assert(
      isPositiveInt(response.keyVersion),
      "keyVersion must be a positive integer",
      "keyVersion",
    );
    assert(
      isHexString(response.groupMailboxId),
      "groupMailboxId must be a hex string",
      "groupMailboxId",
    );
    assert(Array.isArray(response.members), "members must be an array", "members");
  }
}

/**
 * Validate a group message
 * @param {Object} message - Encrypted group message
 * @throws {LobbyValidationError}
 */
export function validateGroupMessage(message) {
  assert(message && typeof message === "object", "Message must be an object");
  assert(message.type === "group_message", "type must be 'group_message'", "type");
  assert(isPositiveInt(message.version), "version must be a positive integer", "version");
  assert(isHexString(message.senderPubSig), "senderPubSig must be a hex string", "senderPubSig");
  assert(
    isPositiveInt(message.keyVersion),
    "keyVersion must be a positive integer",
    "keyVersion",
  );
  assert(isHexString(message.nonce), "nonce must be a hex string", "nonce");
  assert(message.nonce.length === 48, "nonce must be 24 bytes (48 hex chars)", "nonce");
  assert(isHexString(message.ciphertext), "ciphertext must be a hex string", "ciphertext");
}

/**
 * Validate a key rotation message
 * @param {Object} rotation - Key rotation message
 * @throws {LobbyValidationError}
 */
export function validateKeyRotation(rotation) {
  assert(rotation && typeof rotation === "object", "Rotation must be an object");
  assert(rotation.type === "key_rotation", "type must be 'key_rotation'", "type");
  assert(isPositiveInt(rotation.version), "version must be a positive integer", "version");
  assert(isHexString(rotation.lobbyId), "lobbyId must be a hex string", "lobbyId");
  assert(
    isPositiveInt(rotation.keyVersion),
    "keyVersion must be a positive integer",
    "keyVersion",
  );
  assert(isHexString(rotation.groupKey), "groupKey must be a hex string", "groupKey");
  assert(
    rotation.groupKey.length === 64,
    "groupKey must be 32 bytes (64 hex chars)",
    "groupKey",
  );
}

/**
 * Validate a member event message
 * @param {Object} event - Member event message
 * @throws {LobbyValidationError}
 */
export function validateMemberEvent(event) {
  assert(event && typeof event === "object", "Event must be an object");
  assert(
    event.type === "lobby_member_event",
    "type must be 'lobby_member_event'",
    "type",
  );
  assert(isPositiveInt(event.version), "version must be a positive integer", "version");
  assert(isHexString(event.lobbyId), "lobbyId must be a hex string", "lobbyId");
  assert(
    event.eventType === "join" || event.eventType === "leave",
    "eventType must be 'join' or 'leave'",
    "eventType",
  );
  assert(isHexString(event.pubSig), "pubSig must be a hex string", "pubSig");

  if (event.eventType === "join") {
    assert(
      isNonEmptyString(event.displayName),
      "displayName must be a non-empty string for join events",
      "displayName",
    );
  }
}

/**
 * Validate a leave message
 * @param {Object} leave - Leave message
 * @throws {LobbyValidationError}
 */
export function validateLeaveMessage(leave) {
  assert(leave && typeof leave === "object", "Leave must be an object");
  assert(leave.type === "lobby_leave", "type must be 'lobby_leave'", "type");
  assert(isPositiveInt(leave.version), "version must be a positive integer", "version");
  assert(isHexString(leave.lobbyId), "lobbyId must be a hex string", "lobbyId");
  assert(isHexString(leave.pubSig), "pubSig must be a hex string", "pubSig");
}

/**
 * Validate a kick message
 * @param {Object} kick - Kick message
 * @throws {LobbyValidationError}
 */
export function validateKickMessage(kick) {
  assert(kick && typeof kick === "object", "Kick must be an object");
  assert(kick.type === "lobby_kicked", "type must be 'lobby_kicked'", "type");
  assert(isPositiveInt(kick.version), "version must be a positive integer", "version");
  assert(isHexString(kick.lobbyId), "lobbyId must be a hex string", "lobbyId");
}

/**
 * Validate a lobby close message
 * @param {Object} close - Close message
 * @throws {LobbyValidationError}
 */
export function validateCloseMessage(close) {
  assert(close && typeof close === "object", "Close must be an object");
  assert(close.type === "lobby_close", "type must be 'lobby_close'", "type");
  assert(isPositiveInt(close.version), "version must be a positive integer", "version");
  assert(isHexString(close.lobbyId), "lobbyId must be a hex string", "lobbyId");
}

/**
 * Check if a discovery anchor is a lobby
 * @param {Object} discovery - Discovery anchor
 * @returns {boolean}
 */
export function isLobbyDiscovery(discovery) {
  return discovery?.meta?.lobby === true;
}

/**
 * Extract lobby info from a discovery anchor
 * @param {Object} discovery - Discovery anchor
 * @returns {Object|null} - Lobby info or null if not a lobby
 */
export function extractLobbyInfo(discovery) {
  if (!isLobbyDiscovery(discovery)) return null;

  return {
    lobbyId: discovery.sid,
    lobbyName: discovery.meta.lobby_name,
    hostPubSig: discovery.pub_sig,
    maxMembers: discovery.meta.max_members,
    game: discovery.meta.game,
    uptimeSeconds: discovery.meta.expected_uptime_seconds,
  };
}
