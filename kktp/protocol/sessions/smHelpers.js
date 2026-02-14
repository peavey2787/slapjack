// kktp/protocol/sessions/smHelpers.js
// Session Manager Helper Functions

import {
  canonicalize,
  strictParseJson,
} from "../integrity/canonical.js";
import {
  discoveryValidator,
  responseValidator,
  sessionEndValidator,
} from "../integrity/validator.js";
import {
  bytesToHex,
  hexToBytes,
} from "../utils/conversions.js";

/**
 * Normalize epoch milliseconds from various formats.
 * @param {number|string} value
 * @returns {number|null}
 */
export function normalizeEpochMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return n > 1e12 ? n : n * 1000;
}

/**
 * Calculate expected session end time from anchor metadata.
 * @param {Object} anchor
 * @param {number} createdAtMs
 * @returns {number|null}
 */
export function getExpectedEndMs(anchor, createdAtMs) {
  if (!anchor) return null;
  const meta = anchor.meta || {};
  const uptimeSeconds = Number(meta.expected_uptime_seconds);
  if (!Number.isFinite(uptimeSeconds) || uptimeSeconds <= 0) return null;

  const base =
    normalizeEpochMs(anchor.timestamp || anchor.time) ||
    normalizeEpochMs(createdAtMs) ||
    null;

  if (!base) return null;
  return base + uptimeSeconds * 1000;
}

/**
 * Build a KKTP anchor payload string.
 * @param {Object} anchor
 * @returns {string}
 */
export function buildAnchorPayload(anchor) {
  return `KKTP:ANCHOR:${canonicalize(anchor)}`;
}

/**
 * Parse a raw KKTP payload string.
 * @param {string} rawPayload
 * @returns {{ type: string, anchor?: Object, mailboxId?: string, message?: Object }|null}
 */
export function parseKKTPPayload(rawPayload) {
  if (!rawPayload || !rawPayload.startsWith("KKTP:")) return null;

  if (rawPayload.startsWith("KKTP:ANCHOR:")) {
    const jsonStr = rawPayload.substring("KKTP:ANCHOR:".length);
    try {
      const anchor = strictParseJson(jsonStr);
      return { type: "anchor", anchor };
    } catch {
      return null;
    }
  }

  const parts = rawPayload.split(":");
  if (parts.length >= 3) {
    const mailboxId = parts[1];
    const jsonStr = parts.slice(2).join(":");
    try {
      const message = strictParseJson(jsonStr);
      return { type: "message", mailboxId, message };
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Validate an anchor object against its schema.
 * @param {Object} anchor
 * @throws {Error} If anchor is invalid
 */
export function validateAnchorOrThrow(anchor) {
  if (!anchor?.type) {
    throw new Error("Invalid anchor: missing type");
  }
  if (anchor.type === "discovery") {
    discoveryValidator.validate(anchor);
    return;
  }
  if (anchor.type === "response") {
    responseValidator.validate(anchor);
    return;
  }
  if (anchor.type === "session_end") {
    sessionEndValidator.validate(anchor);
    return;
  }
  throw new Error(`Unknown anchor type: ${anchor.type}`);
}

/**
 * Extract resume state from a session object.
 * @param {Object} session
 * @returns {Object} Resume state for persistence
 */
export function extractResumeState(session) {
  const kktp = session?.sm?.kktp || {};

  // Serialize sessionKey (Uint8Array) to hex for JSON persistence
  let sessionKeyHex = null;
  const rawKey = kktp.sessionKey;
  if (rawKey instanceof Uint8Array && rawKey.length > 0) {
    sessionKeyHex = bytesToHex(rawKey);
  } else if (typeof rawKey === "string" && rawKey.length > 0) {
    sessionKeyHex = rawKey;
  }

  // Extract sequence numbers
  const outboundSeq = kktp.outboundSeq ?? 0;
  const inboundSeqAtoB = kktp.inboundSeq?.AtoB ?? 0;
  const inboundSeqBtoA = kktp.inboundSeq?.BtoA ?? 0;

  return {
    mailbox_id: kktp.mailboxId || session?.mailboxId || "",
    K_session: sessionKeyHex,
    outboundSeq,
    inboundSeq_AtoB: inboundSeqAtoB,
    inboundSeq_BtoA: inboundSeqBtoA,
    keyIndex: session?.keyIndex ?? null,
    remote_pub_sig: session?.peerPubSig || null,
    isInitiator: !!session?.isInitiator,
    createdAt: session?.createdAt || Date.now(),
    discovery: session?.discovery || null,
    response: session?.response || null,
    messages: session?.messages || [],
  };
}

/**
 * Derive sequence numbers from message history.
 * @param {Array} messages
 * @returns {{ outboundSeq: number, inboundSeq_AtoB: number, inboundSeq_BtoA: number }}
 */
export function deriveSeqFromMessages(messages = []) {
  const outboundSeq = messages.filter((m) => m?.isOutbound).length;

  const inboundSeqAtoB = messages.filter(
    (m) => m?.direction === "AtoB" && m?.status === "confirmed",
  ).length;

  const inboundSeqBtoA = messages.filter(
    (m) => m?.direction === "BtoA" && m?.status === "confirmed",
  ).length;

  return {
    outboundSeq,
    inboundSeq_AtoB: inboundSeqAtoB,
    inboundSeq_BtoA: inboundSeqBtoA,
  };
}

/**
 * Apply resume state to a session context.
 * @param {Object} ctx - Session context with sm property
 * @param {Object} resume - Resume state object
 */
export function applyResumeState(ctx, resume) {
  const kktp = ctx?.sm?.kktp;
  if (!kktp) return;

  // Restore SID
  if (resume.sid) kktp.sid = resume.sid;

  // Restore mailboxId
  if (resume.mailbox_id) kktp.mailboxId = resume.mailbox_id;

  // Deserialize K_session from hex string back to Uint8Array
  if (resume.K_session) {
    if (resume.K_session instanceof Uint8Array) {
      kktp.sessionKey = resume.K_session;
    } else if (typeof resume.K_session === "string") {
      kktp.sessionKey = hexToBytes(resume.K_session);
    }
  }

  // Restore sequence numbers
  if (resume.outboundSeq != null) kktp.outboundSeq = resume.outboundSeq;
  if (resume.inboundSeq_AtoB != null || resume.inboundSeq_BtoA != null) {
    kktp.inboundSeq = kktp.inboundSeq || { AtoB: 0, BtoA: 0 };
    if (resume.inboundSeq_AtoB != null) {
      kktp.inboundSeq.AtoB = resume.inboundSeq_AtoB;
    }
    if (resume.inboundSeq_BtoA != null) {
      kktp.inboundSeq.BtoA = resume.inboundSeq_BtoA;
    }
  }

  // Restore identity keys if present
  if (resume.my_pub_sig) kktp.myPubSig = resume.my_pub_sig;
  if (resume.remote_pub_sig) kktp.peerPubSig = resume.remote_pub_sig;
}

/**
 * Securely zero out a session's key material.
 * @param {Object} session
 */
export function zeroOutSessionKey(session) {
  const kktp = session?.sm?.kktp;
  if (!kktp) return;
  // Securely zeroize the sessionKey
  if (kktp.sessionKey instanceof Uint8Array) {
    kktp.sessionKey.fill(0);
  }
  kktp.sessionKey = null;
}
