/**
 * BinaryPacker.js - Binary anchor packing/unpacking utilities (v5 Union Protocol)
 *
 * Action code 1 (MOVE) → 16-byte extended packet with X/Y/Z.
 * All other action codes → 8-byte standard packet.
 */

import { bytesToHex, hexToBytes } from "../../core/cryptoUtils.js";
import {
  ANCHOR,
  ACTION_TO_CODE,
  CODE_TO_ACTION,
  MOVE_ACTION_CODE,
  encodeCoord14,
  decodeCoord14,
  movePacketSize,
} from "../../core/constants.js";

export class BinaryPacker {
  /**
   * @param {Object} [options]
   * @param {Object} [options.actionMaps] - Merged maps from buildActionMaps()
   */
  constructor(options = {}) {
    this._actionToCode = options.actionMaps?.actionToCode ?? ACTION_TO_CODE;
    this._codeToAction = options.actionMaps?.codeToAction ?? CODE_TO_ACTION;
    this._subMaps      = options.actionMaps?.subMaps ?? {};
    this._reverseSubMaps = options.actionMaps?.reverseSubMaps ?? {};
  }

  /** Update action maps at runtime (e.g. when game starts with custom maps). */
  setActionMaps(actionMaps) {
    if (!actionMaps) return;
    this._actionToCode   = actionMaps.actionToCode ?? this._actionToCode;
    this._codeToAction   = actionMaps.codeToAction ?? this._codeToAction;
    this._subMaps        = actionMaps.subMaps ?? this._subMaps;
    this._reverseSubMaps = actionMaps.reverseSubMaps ?? this._reverseSubMaps;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Legacy v4-compatible full-anchor packing (genesis binary format)
  // ──────────────────────────────────────────────────────────────────────────

  packAnchorToBinary({ gameId, sessionController, moveHistory, finalScore, coinsCollected }) {
    const vrfSeed = sessionController?.vrfSeed ?? "";
    const startBlockHash = sessionController?.startBlockHash ?? new Uint8Array(32);
    const endBlockHash = sessionController?.endBlockHash ?? new Uint8Array(32);
    const qrngPulses = sessionController?.qrngPulses ?? [];

    const packedMoves = this.packMovesToBinary(moveHistory ?? []);
    // packedMoves is variable-length now; compute moveCount from the packed array
    const moveCount = Math.min(this._lastPackedMoveCount ?? 0, ANCHOR.MAX_MOVES);
    const qrngPulseCount = Math.min(qrngPulses.length, ANCHOR.MAX_QRNG_PULSES);

    const totalSize =
      ANCHOR.HEADER_SIZE +
      qrngPulseCount * ANCHOR.QRNG_PULSE_SIZE +
      packedMoves.length;

    const buffer = new Uint8Array(totalSize);
    let offset = 0;

    buffer[offset++] = ANCHOR.VERSION;

    const gameIdBytes = this.hashToBytes(gameId ?? "", ANCHOR.GAME_ID_BYTES);
    buffer.set(gameIdBytes, offset);
    offset += ANCHOR.GAME_ID_BYTES;

    buffer.set(startBlockHash.slice(0, ANCHOR.BLOCK_HASH_BYTES), offset);
    offset += ANCHOR.BLOCK_HASH_BYTES;

    buffer.set(endBlockHash.slice(0, ANCHOR.BLOCK_HASH_BYTES), offset);
    offset += ANCHOR.BLOCK_HASH_BYTES;

    const vrfSeedBytes = this.hexToBytes(vrfSeed, ANCHOR.VRF_SEED_BYTES);
    buffer.set(vrfSeedBytes, offset);
    offset += ANCHOR.VRF_SEED_BYTES;

    buffer[offset++] = moveCount;
    buffer[offset++] = qrngPulseCount;

    const score = Math.min(finalScore ?? 0, 65535);
    buffer[offset++] = (score >> 8) & 0xff;
    buffer[offset++] = score & 0xff;

    const coins = Math.min(coinsCollected ?? 0, 65535);
    buffer[offset++] = (coins >> 8) & 0xff;
    buffer[offset++] = coins & 0xff;

    for (let i = 0; i < qrngPulseCount; i++) {
      const pulse = qrngPulses[i];
      const idx = pulse.pulseIndex ?? 0;
      buffer[offset++] = (idx >> 24) & 0xff;
      buffer[offset++] = (idx >> 16) & 0xff;
      buffer[offset++] = (idx >> 8) & 0xff;
      buffer[offset++] = idx & 0xff;

      const fragment = pulse.pulseValue ?? new Uint8Array(8);
      buffer.set(fragment.slice(0, ANCHOR.QRNG_PULSE_FRAGMENT_BYTES), offset);
      offset += ANCHOR.QRNG_PULSE_FRAGMENT_BYTES;
    }

    buffer.set(packedMoves, offset);

    return buffer;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Move packing (variable-length: 16 bytes for MOVE, 8 bytes for others)
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Pack a move history array into a contiguous binary buffer.
   * Returns a Uint8Array of variable length (each move is 8 or 16 bytes).
   */
  packMovesToBinary(moveHistory) {
    const moves = Array.isArray(moveHistory) ? moveHistory : [];
    if (moves.length === 0) {
      this._lastPackedMoveCount = 0;
      return new Uint8Array(0);
    }

    const packedMoves = [];
    let prevTimestamp = moves[0].timestamp;

    for (let i = 0; i < moves.length && packedMoves.length < ANCHOR.MAX_MOVES; i++) {
      const move = moves[i];
      let timeDelta = i === 0 ? 0 : move.timestamp - prevTimestamp;

      // Insert NOP padding for large time gaps
      while (timeDelta > ANCHOR.NOP_HEARTBEAT_MS && packedMoves.length < ANCHOR.MAX_MOVES) {
        packedMoves.push(
          this.packSingleMove({
            action: "none",
            lane: 0,
            timeDelta: ANCHOR.TIME_DELTA_MAX,
            vrfOutput: null,
          }),
        );
        timeDelta -= ANCHOR.NOP_HEARTBEAT_MS;
      }

      if (packedMoves.length < ANCHOR.MAX_MOVES) {
        const scaledDelta = Math.min(
          Math.floor(timeDelta / ANCHOR.TIME_DELTA_SCALE),
          ANCHOR.TIME_DELTA_MAX,
        );
        const isGameEvent = move.isGameEvent === true;
        const coinsTotal = isGameEvent
          ? (move.eventData?.total ?? move.coinsTotal ?? 0)
          : 65535;
        packedMoves.push(
          this.packSingleMove({
            action: move.action,
            lane: move.lane ?? 0,
            timeDelta: scaledDelta,
            vrfOutput: move.vrfOutput,
            coinsTotal,
            x: move.x,
            y: move.y,
            z: move.z,
            subId: move.subId,
          }),
        );
      }

      prevTimestamp = move.timestamp;
    }

    this._lastPackedMoveCount = packedMoves.length;

    // Concatenate all packets (variable sizes)
    let totalBytes = 0;
    for (const p of packedMoves) totalBytes += p.length;

    const result = new Uint8Array(totalBytes);
    let off = 0;
    for (const p of packedMoves) {
      result.set(p, off);
      off += p.length;
    }

    return result;
  }

  /**
   * Pack a single move into either a 16-byte (MOVE) or 8-byte (standard) packet.
   */
  packSingleMove(move) {
    const actionCode = this._actionToCode[move.action] ?? this._actionToCode.none ?? 0;

    if (actionCode === MOVE_ACTION_CODE) {
      return this._packExtendedMove(move, actionCode);
    }
    return this._packStandardMove(move, actionCode);
  }

  /** 16-byte extended MOVE packet. */
  _packExtendedMove(move, actionCode) {
    const packet = new Uint8Array(ANCHOR.MOVE_PACKET_SIZE_EXTENDED);

    // Byte 0: (actionCode << 4) | flags
    packet[0] = ((actionCode & 0x0f) << 4) | (0 & 0x0f);

    // Byte 1: timeDelta
    packet[1] = Math.min(move.timeDelta ?? 0, ANCHOR.TIME_DELTA_MAX);

    // Bytes 2-3: X (14-bit signed fixed-point)
    const xRaw = encodeCoord14(move.x);
    packet[2] = (xRaw >> 8) & 0xff;
    packet[3] = xRaw & 0xff;

    // Bytes 4-5: Y
    const yRaw = encodeCoord14(move.y);
    packet[4] = (yRaw >> 8) & 0xff;
    packet[5] = yRaw & 0xff;

    // Bytes 6-7: Z
    const zRaw = encodeCoord14(move.z);
    packet[6] = (zRaw >> 8) & 0xff;
    packet[7] = zRaw & 0xff;

    // Bytes 8-11: VRF fragment (4 bytes)
    const vrfFragment = this.hexToBytes(move.vrfOutput ?? "", ANCHOR.VRF_FRAGMENT_BYTES);
    packet.set(vrfFragment, 8);

    // Bytes 12-13: value (coins / reserved)
    const value = Math.min(Math.max(move.coinsTotal ?? 65535, 0), 65535);
    packet[12] = (value >> 8) & 0xff;
    packet[13] = value & 0xff;

    // Bytes 14-15: reserved
    packet[14] = 0;
    packet[15] = 0;

    return packet;
  }

  /** 8-byte standard packet. */
  _packStandardMove(move, actionCode) {
    const packet = new Uint8Array(ANCHOR.MOVE_PACKET_SIZE);

    const lane = Math.min(Math.max((move.lane ?? 0) + 1, 0), 15);
    packet[0] = ((actionCode & 0x0f) << 4) | (lane & 0x0f);

    packet[1] = Math.min(move.timeDelta ?? 0, ANCHOR.TIME_DELTA_MAX);

    const vrfFragment = this.hexToBytes(move.vrfOutput ?? "", ANCHOR.VRF_FRAGMENT_BYTES);
    packet.set(vrfFragment, 2);

    // Bytes 6-7: value/subId (uint16 BE)
    const value = Math.min(Math.max(move.subId ?? move.coinsTotal ?? 0, 0), 65535);
    packet[6] = (value >> 8) & 0xff;
    packet[7] = value & 0xff;

    return packet;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Move unpacking (v4 legacy format — header-based binary anchor)
  // ──────────────────────────────────────────────────────────────────────────

  decodeMovesFromBinary(buffer) {
    if (!buffer || buffer.length < ANCHOR.HEADER_SIZE) return [];

    const version = buffer[0];
    const moveCount = buffer[49];
    const qrngPulseCount = buffer[50];
    const movesOffset = ANCHOR.HEADER_SIZE + qrngPulseCount * ANCHOR.QRNG_PULSE_SIZE;

    const moves = [];
    let off = movesOffset;

    for (let i = 0; i < moveCount; i++) {
      if (off >= buffer.length) break;

      const actionLane = buffer[off];
      const actionCode = (actionLane >> 4) & 0x0f;
      const pktSize = (version >= 5) ? movePacketSize(actionCode) : ANCHOR.MOVE_PACKET_SIZE;

      if (off + pktSize > buffer.length) break;

      if (version >= 5 && actionCode === MOVE_ACTION_CODE) {
        // Extended 16-byte MOVE packet
        const timeDelta = buffer[off + 1];
        const xRaw = (buffer[off + 2] << 8) | buffer[off + 3];
        const yRaw = (buffer[off + 4] << 8) | buffer[off + 5];
        const zRaw = (buffer[off + 6] << 8) | buffer[off + 7];
        const vrfFragment = bytesToHex(buffer.slice(off + 8, off + 12));
        const value = (buffer[off + 12] << 8) | buffer[off + 13];

        moves.push({
          index: i,
          action: this._codeToAction[actionCode] ?? "move",
          actionCode,
          x: decodeCoord14(xRaw),
          y: decodeCoord14(yRaw),
          z: decodeCoord14(zRaw),
          xRaw, yRaw, zRaw,
          timeDeltaScaled: timeDelta,
          timeDeltaMs: timeDelta * ANCHOR.TIME_DELTA_SCALE,
          vrfFragment,
          value,
          isNopHeartbeat: false,
        });
      } else {
        // Standard 8-byte packet
        const lane = (actionLane & 0x0f) - 1;
        const timeDelta = buffer[off + 1];
        const vrfFragment = bytesToHex(buffer.slice(off + 2, off + 6));
        const value = (buffer[off + 6] << 8) | buffer[off + 7];

        moves.push({
          index: i,
          action: this._codeToAction[actionCode] ?? "unknown",
          actionCode,
          lane,
          timeDeltaScaled: timeDelta,
          timeDeltaMs: timeDelta * ANCHOR.TIME_DELTA_SCALE,
          vrfFragment,
          value,
          coinsTotal: value,
          isNopHeartbeat: actionCode === 0,
        });
      }

      off += pktSize;
    }

    return moves;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Utility helpers
  // ──────────────────────────────────────────────────────────────────────────

  hexToBytes(hex, targetLength) {
    const result = new Uint8Array(targetLength);
    if (!hex || typeof hex !== "string") return result;

    const bytes = hexToBytes(hex);
    result.set(bytes.slice(0, targetLength), 0);
    return result;
  }

  hashToBytes(str, targetLength) {
    const result = new Uint8Array(targetLength);
    if (!str) return result;

    const bytes = new TextEncoder().encode(str);
    for (let i = 0; i < targetLength && i < bytes.length; i++) {
      result[i] = bytes[i];
    }
    return result;
  }

  bytesToHex(bytes) {
    return bytesToHex(bytes);
  }

  getMerkleRootBytes(root) {
    if (typeof root === "string" && root.length >= 64) {
      return hexToBytes(root).slice(0, 32);
    }
    return new Uint8Array(32);
  }

  txIdToBytes(txId) {
    if (!txId) return new Uint8Array(32);
    if (typeof txId === "string" && txId.length >= 64) {
      return hexToBytes(txId).slice(0, 32);
    }
    return new Uint8Array(32);
  }

  mapOutcome(outcome) {
    const outcomeMap = {
      complete: ANCHOR.OUTCOME_COMPLETE,
      completed: ANCHOR.OUTCOME_COMPLETE,
      finished: ANCHOR.OUTCOME_COMPLETE,
      forfeit: ANCHOR.OUTCOME_FORFEIT,
      forfeited: ANCHOR.OUTCOME_FORFEIT,
      timeout: ANCHOR.OUTCOME_TIMEOUT,
      timed_out: ANCHOR.OUTCOME_TIMEOUT,
      disconnect: ANCHOR.OUTCOME_TIMEOUT,
      cheat: ANCHOR.OUTCOME_CHEAT,
      cheated: ANCHOR.OUTCOME_CHEAT,
      invalid: ANCHOR.OUTCOME_CHEAT,
    };
    return outcomeMap[outcome?.toLowerCase?.()] ?? ANCHOR.OUTCOME_COMPLETE;
  }
}

export default BinaryPacker;
