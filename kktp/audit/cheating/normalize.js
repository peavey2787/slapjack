/**
 * normalize.js - Input normalization helpers for cheating audit
 */

export function normalizeAuditInput(input) {
  return {
    chain: normalizeChain(input),
    v4MoveHistory:
      input?.v4MoveHistory ??
      input?.moves ??
      input?.context?.rawMoveHistory ??
      null,
    vrfProofs: input?.vrfProofs ?? input?.vrfProofArchive ?? null,
  };
}

export function normalizeChain(input) {
  if (!input) return null;
  if (Array.isArray(input)) return input;
  if (Array.isArray(input.chain)) return input.chain;
  if (Array.isArray(input.anchorChain?.chain)) return input.anchorChain.chain;
  return null;
}

export function normalizeMoveHistory(audit) {
  if (Array.isArray(audit.v4MoveHistory)) return audit.v4MoveHistory;
  if (Array.isArray(audit.moves)) return audit.moves;
  if (Array.isArray(audit.context?.rawMoveHistory)) {
    return audit.context.rawMoveHistory;
  }
  return null;
}

export function normalizeVrfProofs(audit) {
  if (Array.isArray(audit.vrfProofs)) return audit.vrfProofs;
  if (Array.isArray(audit.vrfProofArchive)) return audit.vrfProofArchive;
  return null;
}
