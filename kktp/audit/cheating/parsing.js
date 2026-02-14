/**
 * parsing.js - Anchor payload parsing for cheating audit
 */

import { ANCHOR, MOVE_ACTION_CODE, decodeCoord14, movePacketSize } from "../../core/constants.js";
import { bytesToHex, hexToBytes } from "../../core/cryptoUtils.js";
import { readBigUint64BE, readUint32BE } from "./utils.js";

export function parseAnchorByType(type, anchorHex) {
  if (!anchorHex) {
    return { error: "missing_anchor_payload" };
  }
  try {
    if (type === "genesis") return parseGenesisAnchor(anchorHex);
    if (type === "heartbeat") return parseHeartbeatAnchor(anchorHex);
    if (type === "final") return parseFinalAnchor(anchorHex);
    return { error: "unknown_anchor_type" };
  } catch (err) {
    return { error: "anchor_payload_parse_failed" };
  }
}

export function parseGenesisAnchor(anchorHex) {
  const bytes = hexToBytes(anchorHex);
  if (bytes.length < ANCHOR.GENESIS_BASE_SIZE) {
    return { error: "genesis_payload_too_short" };
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
  offset += 512;

  return {
    version,
    anchorType,
    gameIdHash,
    hashedSeed,
    btcBlockHashes,
    startDaaScore,
    endDaaScore,
    nistPulseIndex,
    nistOutputHash,
    nistSignature,
  };
}

export function parseHeartbeatAnchor(anchorHex) {
  const bytes = hexToBytes(anchorHex);

  // Need at least the v4 header to check version
  if (bytes.length < ANCHOR.HEARTBEAT_HEADER_SIZE_V4) {
    return { error: "heartbeat_payload_too_short" };
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

  // v5: read movesSectionLength (uint16 BE)
  let movesSectionLength = null;
  if (version >= 5) {
    if (bytes.length < ANCHOR.HEARTBEAT_HEADER_SIZE) {
      return { error: "heartbeat_v5_header_too_short" };
    }
    movesSectionLength = (bytes[offset] << 8) | bytes[offset + 1];
    offset += 2;
  }

  const moves = [];

  for (let i = 0; i < moveCount; i++) {
    if (offset >= bytes.length) break;

    const actionByte = bytes[offset];
    const actionCode = (actionByte >> 4) & 0x0f;

    if (version >= 5 && actionCode === MOVE_ACTION_CODE) {
      // ── Extended 16-byte MOVE packet ──
      const pktSize = ANCHOR.MOVE_PACKET_SIZE_EXTENDED;
      if (offset + pktSize > bytes.length) break;

      const timeDelta = bytes[offset + 1];
      const xRaw = (bytes[offset + 2] << 8) | bytes[offset + 3];
      const yRaw = (bytes[offset + 4] << 8) | bytes[offset + 5];
      const zRaw = (bytes[offset + 6] << 8) | bytes[offset + 7];
      const vrfFragment = bytesToHex(bytes.slice(offset + 8, offset + 12));
      const value = (bytes[offset + 12] << 8) | bytes[offset + 13];

      moves.push({
        actionCode,
        timeDelta,
        vrfFragment,
        x: decodeCoord14(xRaw),
        y: decodeCoord14(yRaw),
        z: decodeCoord14(zRaw),
        xRaw, yRaw, zRaw,
        value,
      });

      offset += pktSize;
    } else {
      // ── Standard 8-byte packet ──
      if (offset + ANCHOR.MOVE_PACKET_SIZE > bytes.length) break;

      const lane = actionByte & 0x0f;
      const timeDelta = bytes[offset + 1];
      const vrfFragment = bytesToHex(bytes.slice(offset + 2, offset + 6));
      const coinsTotal = (bytes[offset + 6] << 8) | bytes[offset + 7];

      moves.push({ actionCode, lane, timeDelta, vrfFragment, coinsTotal, value: coinsTotal });

      offset += ANCHOR.MOVE_PACKET_SIZE;
    }
  }

  let btcDeltaHash = null;
  let nistDelta = null;

  if (deltaFlags & ANCHOR.DELTA_FLAG_BTC) {
    if (offset + ANCHOR.HEARTBEAT_DELTA_BTC_SIZE <= bytes.length) {
      btcDeltaHash = bytesToHex(bytes.slice(offset, offset + 32));
      offset += 32;
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
      nistDelta = { pulseIndex, outputHash, signature };
    }
  }

  return {
    version,
    anchorType,
    merkleRoot,
    prevTxId,
    deltaFlags,
    moveCount,
    movesSectionLength,
    moves,
    btcDeltaHash,
    nistDelta,
  };
}

export function parseFinalAnchor(anchorHex) {
  const bytes = hexToBytes(anchorHex);
  if (bytes.length < ANCHOR.FINAL_SIZE) {
    return { error: "final_payload_too_short" };
  }

  const anchorType = bytes[1];
  return {
    anchorType,
    merkleRoot: bytesToHex(bytes.slice(2, 34)),
    genesisTxId: bytesToHex(bytes.slice(34, 66)),
    prevTxId: bytesToHex(bytes.slice(66, 98)),
    resultLeafHash: bytesToHex(bytes.slice(98, 130)),
    finalScore: readUint32BE(bytes, 130),
    coinsCollected: readUint32BE(bytes, 134),
    raceTimeMs: readUint32BE(bytes, 138),
    outcomeCode: bytes[142],
    totalMoves: bytes[143],
  };
}
