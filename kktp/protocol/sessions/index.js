// kktp/protocol/sessions/index.js
// Barrel export for session management modules

// Core Services
export { KeyDeriver } from "./keyDeriver.js";
export { SessionVault } from "./sessionVault.js";
export { HandoverEngine } from "./handoverEngine.js";

// Persistence
export { SessionPersistence } from "./sessionPersistence.js";

// Helpers
export {
  normalizeEpochMs,
  getExpectedEndMs,
  buildAnchorPayload,
  parseKKTPPayload,
  validateAnchorOrThrow,
  extractResumeState,
  deriveSeqFromMessages,
  applyResumeState,
  zeroOutSessionKey,
} from "./smHelpers.js";
