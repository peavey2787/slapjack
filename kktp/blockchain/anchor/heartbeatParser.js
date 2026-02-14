/**
 * heartbeatParser.js - Parse inbound heartbeat anchor payloads (v4 + v5 Union Protocol)
 *
 * Pure-function module: no side-effects, no state, no imports beyond constants.
 * Extracts the same logic that AuditTrail._parseHeartbeatHex uses, so both
 * live-gameplay and post-game audit share one canonical parser.
 *
 * v5 heartbeats use a union-style layout:
 *   - Action code 1 (MOVE): 16-byte extended packet with X/Y/Z
 *   - All other action codes: 8-byte standard packet
 *
 * @module heartbeatParser
 */

import {
  ANCHOR, CODE_TO_ACTION, BLOCKCHAIN,
  MOVE_ACTION_CODE, decodeCoord14, movePacketSize,
} from "../../core/constants.js";
import { hexToBytes, bytesToHex } from "../../core/cryptoUtils.js";

// ─────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────

/**
 * Parse a raw heartbeat payload hex string into a structured object.
 *
 * @param {string} payloadHex - The full tx.payload hex (prefix + tag + anchor binary).
 * @param {Object}  ctx
 * @param {string}  ctx.prefixHex - Expected prefix (e.g. BLOCKCHAIN.PREFIX_HEARTBEAT_HEX).
 * @param {string}  ctx.tagHex   - Game-ID tag hex (8 hex chars / 4 bytes).
 * @param {boolean} [ctx.allowNoPrefix=false] - If true, try parsing raw anchor hex when prefix/tag mismatch.
 * @param {Object}  [ctx.codeToAction] - Optional custom code→action map for resolving action strings.
 * @returns {{ header: HeartbeatHeader, moves: ParsedMove[] } | null}
 */
export function parseHeartbeatHex(payloadHex, { prefixHex, tagHex, allowNoPrefix = false, codeToAction } = {}) {
  if (!payloadHex || typeof payloadHex !== "string") return null;

  const resolver = codeToAction ?? CODE_TO_ACTION;

  // Strip prefix + tag to isolate the binary anchor portion
  const expectedStart = ((prefixHex ?? "") + (tagHex ?? "")).toLowerCase();
  const payloadLower = payloadHex.toLowerCase();
  
  if (expectedStart && payloadLower.startsWith(expectedStart)) {
    const anchorHex = payloadHex.slice(expectedStart.length);
    return _parseAnchorHex(anchorHex, resolver);
  }
  
  if (allowNoPrefix) {
    return _parseAnchorHex(payloadHex, resolver);
  }
  
  return null;
}

/**
 * Enrich raw parsed moves with session context (moveId, playerId, sessionTimeMs).
 *
 * Uses a TimeAccumulator so cumulative time persists across heartbeat batches:
 *   Heartbeat #1 ends at 500 ms → Heartbeat #2 move-0 starts at 550 ms.
 *
 * @param {Object}   parsed       - Output of parseHeartbeatHex().
 * @param {Object}   ctx
 * @param {string}   ctx.txId     - The transaction ID that carried this heartbeat.
 * @param {string}   ctx.playerId - Contextual player ID (opponent resolved by caller).
 * @param {{ value: number }} ctx.timeAccumulator
 * @returns {EnrichedMove[]}
 */
export function enrichMoves(parsed, { txId, playerId, timeAccumulator }) {
  if (!parsed?.moves?.length) return [];

  const enriched = [];
  for (let i = 0; i < parsed.moves.length; i++) {
    const m = parsed.moves[i];
    timeAccumulator.value += m.timeDeltaMs;

    const base = {
      moveId: `${txId}-${i}`,
      playerId,
      action: m.action,
      actionCode: m.actionCode,
      timeDeltaMs: m.timeDeltaMs,
      rawDelta: m.rawDelta,
      vrfFragment: m.vrfFragment,
      sessionTimeMs: timeAccumulator.value,
      sequence: i,
      txId,
    };

    if (m.actionCode === MOVE_ACTION_CODE) {
      // Extended MOVE — forward x, y, z
      base.x = m.x;
      base.y = m.y;
      base.z = m.z;
      base.xRaw = m.xRaw;
      base.yRaw = m.yRaw;
      base.zRaw = m.zRaw;
      base.value = m.value;
    } else {
      // Standard — forward lane and value/coinsTotal
      base.lane = m.lane;
      base.coinsTotal = m.coinsTotal;
      base.value = m.value;
    }

    enriched.push(base);
  }
  return enriched;
}

// ─────────────────────────────────────────────────────────────
// Internal
// ─────────────────────────────────────────────────────────────

/**
 * Parse the binary anchor hex (everything after prefix+tag).
 *
 * v4 layout: fixed 8-byte packets, 68-byte header
 * v5 layout: union 8/16-byte packets, 70-byte header (movesSectionLength added)
 *
 * @param {string} hex
 * @param {Object} codeToAction - code → action string map
 * @returns {{ header: HeartbeatHeader, moves: ParsedMove[] } | null}
 * @private
 */
function _parseAnchorHex(hex, codeToAction) {
  if (!hex) return null;
  try {
    const bytes = hexToBytes(hex);

    // Need at least the v4 header size to check version
    if (bytes.length < ANCHOR.HEARTBEAT_HEADER_SIZE_V4) return null;

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const version = bytes[0];

    if (version >= 5) {
      return _parseV5(bytes, view, codeToAction);
    }
    return _parseV4(bytes, view, codeToAction);
  } catch {
    return null;
  }
}

/**
 * v4 parser — fixed 8-byte packets, 68-byte header (backward compat).
 */
function _parseV4(bytes, view, codeToAction) {
  let off = 0;

  const version = bytes[off++];
  const anchorType = bytes[off++];
  if (anchorType !== ANCHOR.TYPE_HEARTBEAT) return null;

  const merkleRoot = bytesToHex(bytes.slice(off, off + 32)); off += 32;
  const prevTxId   = bytesToHex(bytes.slice(off, off + 32)); off += 32;
  const deltaFlags = bytes[off++];
  const moveCount  = bytes[off++];

  const moves = [];
  for (let i = 0; i < moveCount && off + ANCHOR.MOVE_PACKET_SIZE <= bytes.length; i++) {
    const actionLane = bytes[off++];
    const timeDelta  = bytes[off++];
    const vrfFragment = bytesToHex(bytes.slice(off, off + ANCHOR.VRF_FRAGMENT_BYTES));
    off += ANCHOR.VRF_FRAGMENT_BYTES;
    const coinsTotal = (bytes[off] << 8) | bytes[off + 1];
    off += 2;

    const actionCode = (actionLane >> 4) & 0x0f;
    const lane       = actionLane & 0x0f;

    moves.push({
      action: codeToAction[actionCode] || `unknown_${actionCode}`,
      actionCode,
      lane,
      timeDeltaMs: timeDelta * ANCHOR.TIME_DELTA_SCALE,
      rawDelta: timeDelta,
      vrfFragment,
      coinsTotal,
      value: coinsTotal,
    });
  }

  const deltas = _parseDeltas(bytes, off, deltaFlags, view);

  return {
    header: { version, merkleRoot, prevTxId, deltaFlags, moveCount, ...deltas },
    moves,
  };
}

/**
 * v5 parser — union 8/16-byte packets, 70-byte header.
 */
function _parseV5(bytes, view, codeToAction) {
  let off = 0;

  const version = bytes[off++];
  const anchorType = bytes[off++];
  if (anchorType !== ANCHOR.TYPE_HEARTBEAT) return null;

  const merkleRoot = bytesToHex(bytes.slice(off, off + 32)); off += 32;
  const prevTxId   = bytesToHex(bytes.slice(off, off + 32)); off += 32;
  const deltaFlags = bytes[off++];
  const moveCount  = bytes[off++];
  const movesSectionLength = (bytes[off] << 8) | bytes[off + 1]; off += 2;

  const movesStart = off;
  const moves = [];

  for (let i = 0; i < moveCount; i++) {
    if (off >= bytes.length) break;

    const actionByte = bytes[off];
    const actionCode = (actionByte >> 4) & 0x0f;
    const pktSize = movePacketSize(actionCode);

    if (off + pktSize > bytes.length) break;

    if (actionCode === MOVE_ACTION_CODE) {
      // ── Extended 16-byte MOVE packet ──
      const timeDelta = bytes[off + 1];
      const xRaw = (bytes[off + 2] << 8) | bytes[off + 3];
      const yRaw = (bytes[off + 4] << 8) | bytes[off + 5];
      const zRaw = (bytes[off + 6] << 8) | bytes[off + 7];
      const vrfFragment = bytesToHex(bytes.slice(off + 8, off + 12));
      const value = (bytes[off + 12] << 8) | bytes[off + 13];

      moves.push({
        action: codeToAction[actionCode] || "move",
        actionCode,
        x: decodeCoord14(xRaw),
        y: decodeCoord14(yRaw),
        z: decodeCoord14(zRaw),
        xRaw, yRaw, zRaw,
        timeDeltaMs: timeDelta * ANCHOR.TIME_DELTA_SCALE,
        rawDelta: timeDelta,
        vrfFragment,
        value,
      });
    } else {
      // ── Standard 8-byte packet ──
      const lane = actionByte & 0x0f;
      const timeDelta = bytes[off + 1];
      const vrfFragment = bytesToHex(bytes.slice(off + 2, off + 6));
      const value = (bytes[off + 6] << 8) | bytes[off + 7];

      moves.push({
        action: codeToAction[actionCode] || `unknown_${actionCode}`,
        actionCode,
        lane,
        timeDeltaMs: timeDelta * ANCHOR.TIME_DELTA_SCALE,
        rawDelta: timeDelta,
        vrfFragment,
        coinsTotal: value,
        value,
      });
    }

    off += pktSize;
  }

  const deltas = _parseDeltas(bytes, off, deltaFlags, view);

  return {
    header: { version, merkleRoot, prevTxId, deltaFlags, moveCount, movesSectionLength, ...deltas },
    moves,
  };
}

/**
 * Parse optional BTC / NIST delta sections (shared by v4 and v5).
 */
function _parseDeltas(bytes, off, deltaFlags, view) {
  let deltaBtcHash = null;
  let deltaNistPulse = null;

  if (deltaFlags & ANCHOR.DELTA_FLAG_BTC) {
    if (off + 32 <= bytes.length) {
      deltaBtcHash = bytesToHex(bytes.slice(off, off + 32));
      off += 32;
    }
  }

  if (deltaFlags & ANCHOR.DELTA_FLAG_NIST) {
    if (off + ANCHOR.HEARTBEAT_DELTA_NIST_SIZE <= bytes.length) {
      const pulseIndex = Number(view.getBigUint64(off, false)); off += 8;
      const outputHash = bytesToHex(bytes.slice(off, off + 64)); off += 64;
      const signature  = bytesToHex(bytes.slice(off, off + 512)); off += 512;
      deltaNistPulse = { pulseIndex, outputHash, signature };
    }
  }

  return { deltaBtcHash, deltaNistPulse };
}

// ─────────────────────────────────────────────────────────────
// JSDoc typedefs
// ─────────────────────────────────────────────────────────────

/**
 * @typedef {Object} HeartbeatHeader
 * @property {number} version
 * @property {string} merkleRoot
 * @property {string} prevTxId
 * @property {number} deltaFlags
 * @property {number} moveCount
 * @property {number} [movesSectionLength] - v5 only
 * @property {string|null} deltaBtcHash
 * @property {Object|null} deltaNistPulse
 */

/**
 * @typedef {Object} ParsedMove
 * @property {string} action
 * @property {number} actionCode
 * @property {number} [lane]           - Standard packets only
 * @property {number} [x]              - MOVE packets only (decoded float)
 * @property {number} [y]              - MOVE packets only
 * @property {number} [z]              - MOVE packets only
 * @property {number} [xRaw]           - MOVE packets only (14-bit raw)
 * @property {number} [yRaw]           - MOVE packets only
 * @property {number} [zRaw]           - MOVE packets only
 * @property {number} timeDeltaMs
 * @property {number} rawDelta
 * @property {string} vrfFragment
 * @property {number} [coinsTotal]     - Standard packets
 * @property {number} [value]          - Raw uint16 value field
 */

/**
 * @typedef {Object} EnrichedMove
 * @property {string} moveId
 * @property {string} playerId
 * @property {string} action
 * @property {number} [lane]
 * @property {number} [x]
 * @property {number} [y]
 * @property {number} [z]
 * @property {number} timeDeltaMs
 * @property {number} rawDelta
 * @property {string} vrfFragment
 * @property {number} sessionTimeMs
 * @property {number} sequence
 * @property {string} txId
 */
