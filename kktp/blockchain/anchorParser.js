/**
 * anchorParser.js - Decode anchor payloads into human-readable output
 */

import { ANCHOR, CODE_TO_ACTION, MOVE_ACTION_CODE, decodeCoord14, movePacketSize } from "../core/constants.js";

export function parseAnchor(anchorItem) {
  return formatAnchorPayload(anchorItem);
}

export function parseAnchorPayload(type, bytes) {
  if (!bytes || bytes.length === 0) {
    return { lines: ["parseError: empty payload"] };
  }
  if (type === "genesis") {
    return parseGenesisPayload(bytes);
  }
  if (type === "heartbeat") {
    return parseHeartbeatPayload(bytes);
  }
  if (type === "final") {
    return parseFinalPayload(bytes);
  }
  return { lines: ["parseError: unknown anchor type"] };
}

export function parseGenesisPayload(bytes) {
  const lines = [];
  if (bytes.length < ANCHOR.GENESIS_BASE_SIZE) {
    return { lines: ["parseError: payload too short for genesis"] };
  }
  let offset = 0;
  const version = bytes[offset++];
  const anchorType = bytes[offset++];
  const gameIdHash = bytesToHex(bytes.slice(offset, offset + 32));
  offset += 32;
  const hashedSeed = bytesToHex(bytes.slice(offset, offset + 32));
  offset += 32;

  const btcBlockHashes = [];
  for (let i = 0; i < ANCHOR.BTC_BLOCK_COUNT; i++) {
    btcBlockHashes.push(bytesToHex(bytes.slice(offset, offset + 32)));
    offset += 32;
  }

  const startDaaScore = readBigUint64BE(bytes, offset);
  offset += 8;
  const endDaaScore = readBigUint64BE(bytes, offset);
  offset += 8;
  const nistPulseIndex = readBigUint64BE(bytes, offset);
  offset += 8;
  const nistOutputHash = bytesToHex(bytes.slice(offset, offset + 64));
  offset += 64;
  const nistSignature = bytesToHex(bytes.slice(offset, offset + 512));

  lines.push(`version: ${version}`);
  lines.push(`anchorType: ${anchorType}`);
  lines.push(`gameIdHash: ${gameIdHash}`);
  lines.push(`hashedSeed: ${hashedSeed}`);
  for (let i = 0; i < btcBlockHashes.length; i++) {
    lines.push(`btcBlockHash[${i}]: ${btcBlockHashes[i]}`);
  }
  lines.push(`startDaaScore: ${startDaaScore}`);
  lines.push(`endDaaScore: ${endDaaScore}`);
  lines.push(`nistPulseIndex: ${nistPulseIndex}`);
  lines.push(`nistOutputHash: ${nistOutputHash}`);
  lines.push(
    `nistSignature: ${truncateHex(nistSignature, 64)} (len=${nistSignature.length})`,
  );

  return { lines };
}

export function parseHeartbeatPayload(bytes) {
  const lines = [];
  const minHeader = Math.min(ANCHOR.HEARTBEAT_HEADER_SIZE, ANCHOR.HEARTBEAT_HEADER_SIZE_V4);
  if (bytes.length < minHeader) {
    return { lines: ["parseError: payload too short for heartbeat"] };
  }
  let offset = 0;
  const version = bytes[offset++];
  const anchorType = bytes[offset++];
  const merkleRoot = bytesToHex(bytes.slice(offset, offset + 32));
  offset += 32;
  const prevTxId = bytesToHex(bytes.slice(offset, offset + 32));
  offset += 32;
  const deltaFlags = bytes[offset++];
  const moveCount = bytes[offset++];

  lines.push(`version: ${version}`);
  lines.push(`anchorType: ${anchorType}`);
  lines.push(`merkleRoot: ${merkleRoot}`);
  lines.push(`prevTxId: ${prevTxId}`);
  lines.push(`deltaFlags: ${deltaFlags} (${formatDeltaFlags(deltaFlags)})`);
  lines.push(`moveCount: ${moveCount}`);

  // v5: read movesSectionLength
  let movesSectionLength = null;
  if (version >= 5) {
    movesSectionLength = (bytes[offset] << 8) | bytes[offset + 1];
    offset += 2;
    lines.push(`movesSectionLength: ${movesSectionLength}`);
  }

  for (let i = 0; i < moveCount; i++) {
    if (offset >= bytes.length) {
      lines.push(`move[${i}]: parseError (payload too short)`);
      break;
    }

    const actionByte = bytes[offset];
    const actionCode = (actionByte >> 4) & 0x0f;
    const pktSize = (version >= 5) ? movePacketSize(actionCode) : ANCHOR.MOVE_PACKET_SIZE;

    if (offset + pktSize > bytes.length) {
      lines.push(`move[${i}]: parseError (payload too short for ${pktSize}-byte packet)`);
      break;
    }

    const actionName = CODE_TO_ACTION[actionCode] ?? "unknown";

    if (version >= 5 && actionCode === MOVE_ACTION_CODE) {
      // Extended 16-byte MOVE packet
      const timeDelta = bytes[offset + 1];
      const xRaw = (bytes[offset + 2] << 8) | bytes[offset + 3];
      const yRaw = (bytes[offset + 4] << 8) | bytes[offset + 5];
      const zRaw = (bytes[offset + 6] << 8) | bytes[offset + 7];
      const vrfFragment = bytesToHex(bytes.slice(offset + 8, offset + 12));
      const value = (bytes[offset + 12] << 8) | bytes[offset + 13];
      const timeDeltaMs = timeDelta * ANCHOR.TIME_DELTA_SCALE;
      const x = decodeCoord14(xRaw);
      const y = decodeCoord14(yRaw);
      const z = decodeCoord14(zRaw);
      lines.push(
        `move[${i}]: actionCode=${actionCode} (${actionName}) x=${x} y=${y} z=${z} timeDeltaMs=${timeDeltaMs} vrfFragment=${vrfFragment} value=${value}`,
      );
    } else {
      // Standard 8-byte packet
      const lane = actionByte & 0x0f;
      const timeDelta = bytes[offset + 1];
      const vrfFragment = bytesToHex(bytes.slice(offset + 2, offset + 6));
      const value = (bytes[offset + 6] << 8) | bytes[offset + 7];
      const timeDeltaMs = timeDelta * ANCHOR.TIME_DELTA_SCALE;
      lines.push(
        `move[${i}]: actionCode=${actionCode} (${actionName}) lane=${lane} timeDeltaMs=${timeDeltaMs} vrfFragment=${vrfFragment} value=${value}`,
      );
    }

    offset += pktSize;
  }

  if (deltaFlags & ANCHOR.DELTA_FLAG_BTC) {
    if (offset + ANCHOR.HEARTBEAT_DELTA_BTC_SIZE <= bytes.length) {
      const btcDelta = bytesToHex(bytes.slice(offset, offset + 32));
      offset += 32;
      lines.push(`btcDeltaHash: ${btcDelta}`);
    } else {
      lines.push("btcDeltaHash: parseError (payload too short)");
    }
  }

  if (deltaFlags & ANCHOR.DELTA_FLAG_NIST) {
    if (offset + ANCHOR.HEARTBEAT_DELTA_NIST_SIZE <= bytes.length) {
      const pulseIndex = readBigUint64BE(bytes, offset);
      offset += 8;
      const outputHash = bytesToHex(bytes.slice(offset, offset + 64));
      offset += 64;
      const signature = bytesToHex(bytes.slice(offset, offset + 512));
      offset += 512;
      lines.push(`nistPulseIndex: ${pulseIndex}`);
      lines.push(`nistOutputHash: ${outputHash}`);
      lines.push(
        `nistSignature: ${truncateHex(signature, 64)} (len=${signature.length})`,
      );
    } else {
      lines.push("nistDelta: parseError (payload too short)");
    }
  }

  return { lines };
}

export function parseFinalPayload(bytes) {
  const lines = [];
  if (bytes.length < ANCHOR.FINAL_SIZE) {
    return { lines: ["parseError: payload too short for final"] };
  }
  let offset = 0;
  const version = bytes[offset++];
  const anchorType = bytes[offset++];
  const merkleRoot = bytesToHex(bytes.slice(offset, offset + 32));
  offset += 32;
  const genesisTxId = bytesToHex(bytes.slice(offset, offset + 32));
  offset += 32;
  const prevTxId = bytesToHex(bytes.slice(offset, offset + 32));
  offset += 32;
  const resultLeafHash = bytesToHex(bytes.slice(offset, offset + 32));
  offset += 32;
  const finalScore = readUint32BE(bytes, offset);
  offset += 4;
  const coinsCollected = readUint32BE(bytes, offset);
  offset += 4;
  const raceTimeMs = readUint32BE(bytes, offset);
  offset += 4;
  const outcomeCode = bytes[offset++];
  const totalMoves = bytes[offset++];
  const outcomeName = formatOutcome(outcomeCode);

  lines.push(`version: ${version}`);
  lines.push(`anchorType: ${anchorType}`);
  lines.push(`merkleRoot: ${merkleRoot}`);
  lines.push(`genesisTxId: ${genesisTxId}`);
  lines.push(`prevTxId: ${prevTxId}`);
  lines.push(`resultLeafHash: ${resultLeafHash}`);
  lines.push(`finalScore: ${finalScore}`);
  lines.push(`coinsCollected: ${coinsCollected}`);
  lines.push(`raceTimeMs: ${raceTimeMs}`);
  lines.push(`outcomeCode: ${outcomeCode} (${outcomeName})`);
  lines.push(`totalMoves: ${totalMoves}`);

  return { lines };
}

function formatAnchorPayload(anchorItem) {
  const hex = String(anchorItem?.anchorHex || "");
  if (!hex) {
    return "No payload available.";
  }
  const bytes = hexToBytes(hex);
  const type = String(anchorItem?.type || "unknown").toLowerCase();
  const parsed = parseAnchorPayload(type, bytes);
  const groupedHex = groupHex(hex, 32);
  return [
    `type: ${anchorItem?.type || "unknown"}`,
    `txId: ${anchorItem?.txId || "unknown"}`,
    ...(parsed?.lines || ["parseError: unable to decode payload"]),
    "payloadHex:",
    groupedHex,
  ].join("\n");
}

function hexToBytes(hex) {
  const clean = hex.replace(/[^a-fA-F0-9]/g, "");
  const length = Math.floor(clean.length / 2);
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes) {
  const parts = [];
  for (const b of bytes) {
    parts.push(b.toString(16).padStart(2, "0"));
  }
  return parts.join("");
}

function readUint32BE(bytes, offset) {
  return (
    (bytes[offset] << 24) |
    (bytes[offset + 1] << 16) |
    (bytes[offset + 2] << 8) |
    bytes[offset + 3]
  ) >>> 0;
}

function readBigUint64BE(bytes, offset) {
  let result = 0n;
  for (let i = 0; i < 8; i++) {
    result = (result << 8n) | BigInt(bytes[offset + i]);
  }
  return result.toString();
}

function formatDeltaFlags(flags) {
  const parts = [];
  if (flags & ANCHOR.DELTA_FLAG_BTC) parts.push("btc");
  if (flags & ANCHOR.DELTA_FLAG_NIST) parts.push("nist");
  return parts.length ? parts.join(", ") : "none";
}

function formatOutcome(outcomeCode) {
  if (outcomeCode === ANCHOR.OUTCOME_COMPLETE) return "complete";
  if (outcomeCode === ANCHOR.OUTCOME_FORFEIT) return "forfeit";
  if (outcomeCode === ANCHOR.OUTCOME_TIMEOUT) return "timeout";
  if (outcomeCode === ANCHOR.OUTCOME_CHEAT) return "cheat";
  return "unknown";
}

function truncateHex(hex, maxChars) {
  if (hex.length <= maxChars) {
    return hex;
  }
  const head = hex.slice(0, maxChars / 2);
  const tail = hex.slice(-maxChars / 2);
  return `${head}...${tail}`;
}

function groupHex(hex, groupBytes) {
  const clean = hex.replace(/[^a-fA-F0-9]/g, "");
  const charsPerGroup = Math.max(2, groupBytes * 2);
  const chunks = [];
  for (let i = 0; i < clean.length; i += charsPerGroup) {
    chunks.push(clean.slice(i, i + charsPerGroup));
  }
  return chunks.join("\n");
}
