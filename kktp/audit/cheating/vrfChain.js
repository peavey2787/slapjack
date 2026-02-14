/**
 * vrfChain.js - VRF chain replay verifier for cheating audit
 *
 * Replays the deterministic VRF chain from genesis to final move,
 * computing each VRF_n independently and comparing the 4-byte vrfFragment
 * against the on-chain heartbeat data.
 *
 * Formula:
 *   VRF_n = SHA256( fold( HMAC-SHA256(Key=VRF_{n-1}, Data=MoveData+Entropy),
 *                   EntropyHash, {seed} ) )
 *
 * The auditor strictly uses the per-move entropySnapshot stored in the audit data,
 * even if values are zero-filled. This ensures determinism regardless of when
 * external entropy became available to the game client.
 */

import { sha256, hmacSha256, hexToBytes, bytesToHex } from "../../core/cryptoUtils.js";
import { ACTION_TO_CODE, ANCHOR, MOVE_ACTION_CODE } from "../../core/constants.js";
import { fold } from "../../engine/kaspa/vrf/core/folding.js";
import { addReason, addWarning } from "./utils.js";

/** Size constants — must match VrfManager.js exactly */
const VRF_STATE_SIZE = 32;
const NIST_SIZE = 32;
const BTC_SIZE = 32;
const KASPA_SIZE = 32;

/** Standard buffer: VRF(32) + ActionCode(1) + Lane(1) + TimeDelta(1) + entropy(96) = 131 */
const DATA_BUFFER_SIZE_STANDARD = VRF_STATE_SIZE + 1 + 1 + 1 + NIST_SIZE + BTC_SIZE + KASPA_SIZE; // 131

/** Extended MOVE buffer: VRF(32) + ActionCode(1) + X(2) + Y(2) + Z(2) + TimeDelta(1) + entropy(96) = 136 */
const DATA_BUFFER_SIZE_EXTENDED = VRF_STATE_SIZE + 1 + 2 + 2 + 2 + 1 + NIST_SIZE + BTC_SIZE + KASPA_SIZE; // 136

/**
 * Pad or truncate a Uint8Array to exactly the target length.
 */
function padOrTruncate(bytes, targetLength) {
  if (bytes.length === targetLength) return bytes;
  const result = new Uint8Array(targetLength);
  result.set(bytes.subarray(0, Math.min(bytes.length, targetLength)));
  return result;
}

/**
 * Normalize hex input from strings or Uint8Array into a lowercase hex string.
 */
function normalizeHexInput(value) {
  if (!value) return "";
  if (value instanceof Uint8Array) return bytesToHex(value);
  if (typeof value === "string") {
    return value.toLowerCase().replace(/^0x/, "");
  }
  return "";
}

/**
 * Safely convert a hex string to Uint8Array, returning zero-filled buffer on failure.
 */
function safeHexToBytes(hex, size) {
  if (!hex || typeof hex !== "string") return new Uint8Array(size);
  try {
    return padOrTruncate(hexToBytes(hex), size);
  } catch {
    return new Uint8Array(size);
  }
}

/**
 * Replay and verify the entire VRF chain for a game session.
 *
 * @param {Object} params
 * @param {Array} params.moveHistory - v4MoveHistory array from audit data (sorted by sequence)
 * @param {string|null} params.genesisTxId - Genesis anchor transaction ID
 * @param {string} params.playerId - Player ID used for lazy seed
 * @param {string} params.gameId - Game ID used for lazy seed
 * @param {Object|null} params.genesisEntropy - Genesis entropy data (btcBlockHashes, nistOutputHash)
 * @param {Array} params.reasons - Mutable array to push failure reasons
 * @param {Array} params.warnings - Mutable array to push warnings
 * @returns {Promise<Object>} - { verified: boolean, matchCount, mismatchCount, totalMoves }
 */
export async function verifyVrfChain({
  moveHistory,
  genesisTxId,
  playerId,
  gameId,
  genesisEntropy,
  reasons,
  warnings,
}) {
  if (!Array.isArray(moveHistory) || moveHistory.length === 0) {
    addWarning(warnings, "vrf_chain_no_move_history");
    return { verified: false, matchCount: 0, mismatchCount: 0, totalMoves: 0 };
  }

  if (!playerId || !gameId) {
    addWarning(warnings, "vrf_chain_missing_player_or_game_id");
    return { verified: false, matchCount: 0, mismatchCount: 0, totalMoves: moveHistory.length };
  }

  // Sort by sequence to ensure correct replay order
  const sorted = [...moveHistory].sort((a, b) => {
    const seqA = Number.isFinite(a?.sequence) ? a.sequence : 0;
    const seqB = Number.isFinite(b?.sequence) ? b.sequence : 0;
    return seqA - seqB;
  });

  // Filter to only VRF-bearing moves (skip game events with no vrfFragment)
  const vrfMoves = sorted.filter(
    (m) => m.vrfFragment || m.vrfOutputHex || m.entropySnapshot,
  );

  if (vrfMoves.length === 0) {
    addWarning(warnings, "vrf_chain_no_vrf_moves");
    return { verified: false, matchCount: 0, mismatchCount: 0, totalMoves: 0 };
  }

  let matchCount = 0;
  let mismatchCount = 0;
  let vrfState = null;
  let genesisReinforced = false;

  // Genesis entropy fallback values (used when a move has no entropySnapshot)
  const fallbackNistHex = normalizeHexInput(genesisEntropy?.nistOutputHash);
  const fallbackBtcHex = normalizeHexInput(
    Array.isArray(genesisEntropy?.btcBlockHashes) && genesisEntropy.btcBlockHashes.length > 0
      ? genesisEntropy.btcBlockHashes[0]
      : "",
  );

  for (const move of vrfMoves) {
    const snapshot = move.entropySnapshot ?? {};
    const sequence = move.sequence ?? 0;
    const action = move.action ?? "none";
    const lane = Number.isFinite(move.lane) ? move.lane : 0;
    const timeDeltaRaw = Number.isFinite(move.timeDelta)
      ? move.timeDelta
      : Number.isFinite(move.timeDeltaMs)
        ? Math.floor(move.timeDeltaMs / ANCHOR.TIME_DELTA_SCALE)
        : Number.isFinite(move.rawDelta)
          ? move.rawDelta
          : 0;
    const timeDelta = Math.max(0, Math.min(255, timeDeltaRaw));
    const timestamp = move.timestamp ?? 0;

    // ── Step 1: Lazy initialization (same as VrfManager) ──
    if (vrfState === null) {
      // Use initTimestamp from first move's snapshot, or the move's own timestamp
      const initTs = snapshot.initTimestamp ?? timestamp;
      const seedString = `${playerId}:${gameId}:${initTs}`;
      vrfState = await sha256(new TextEncoder().encode(seedString));
    }

    // ── Step 2: Genesis reinforcement ──
    const shouldReinforce =
      genesisTxId && !genesisReinforced && snapshot.isGenesisReinforced === true;
    if (shouldReinforce) {
      const txIdBytes = hexToBytes(genesisTxId);
      const combined = new Uint8Array(VRF_STATE_SIZE + txIdBytes.length);
      combined.set(vrfState);
      combined.set(txIdBytes, VRF_STATE_SIZE);
      vrfState = await sha256(combined);
      genesisReinforced = true;
    }

    // ── Step 3: Gather entropy from snapshot (strictly use snapshot data) ──
    const nistHashHex = normalizeHexInput(snapshot.nistOutputHash) || fallbackNistHex;
    const nistBytes = nistHashHex
      ? await sha256(safeHexToBytes(nistHashHex, 64))
      : new Uint8Array(32);

    const btcHex = normalizeHexInput(snapshot.btcHash) || fallbackBtcHex;
    const btcBytes = btcHex
      ? padOrTruncate(safeHexToBytes(btcHex, 32), BTC_SIZE)
      : new Uint8Array(32);

    const kaspaHex =
      normalizeHexInput(snapshot.kaspaBlockHash) ||
      normalizeHexInput(move.kaspaBlockHashHex) ||
      "";
    if (!kaspaHex) {
      addReason(reasons, "vrf_chain_missing_kaspa_entropy");
    }
    const kaspaBytes = kaspaHex
      ? padOrTruncate(safeHexToBytes(kaspaHex, 32), KASPA_SIZE)
      : new Uint8Array(32);

    // ── Step 4: Build deterministic data buffer (v5 union protocol) ──
    const actionCode = (ACTION_TO_CODE[action] ?? 0) & 0xff;
    const isMove = actionCode === MOVE_ACTION_CODE;
    const bufferSize = isMove ? DATA_BUFFER_SIZE_EXTENDED : DATA_BUFFER_SIZE_STANDARD;
    const dataBuffer = new Uint8Array(bufferSize);
    let offset = 0;

    dataBuffer.set(vrfState, offset);
    offset += VRF_STATE_SIZE;

    dataBuffer[offset++] = actionCode;

    if (isMove) {
      // Extended: [ActionCode(1)] + [X(2)] + [Y(2)] + [Z(2)] + [TimeDelta(1)]
      const xVal = (move.x ?? 0) & 0xFFFF;
      dataBuffer[offset++] = (xVal >> 8) & 0xff;
      dataBuffer[offset++] = xVal & 0xff;
      const yVal = (move.y ?? 0) & 0xFFFF;
      dataBuffer[offset++] = (yVal >> 8) & 0xff;
      dataBuffer[offset++] = yVal & 0xff;
      const zVal = (move.z ?? 0) & 0xFFFF;
      dataBuffer[offset++] = (zVal >> 8) & 0xff;
      dataBuffer[offset++] = zVal & 0xff;
      dataBuffer[offset++] = timeDelta & 0xff;
    } else {
      // Standard: [ActionCode(1)] + [Lane(1)] + [TimeDelta(1)]
      dataBuffer[offset++] = lane & 0xff;
      dataBuffer[offset++] = timeDelta & 0xff;
    }

    dataBuffer.set(nistBytes, offset);
    offset += NIST_SIZE;

    dataBuffer.set(btcBytes, offset);
    offset += BTC_SIZE;

    dataBuffer.set(kaspaBytes, offset);

    // ── Step 5: HMAC-SHA256 ──
    const hmacResult = await hmacSha256(vrfState, dataBuffer);

    // ── Step 6: Entropy hash for fold() ──
    const entropyConcat = new Uint8Array(KASPA_SIZE + NIST_SIZE + BTC_SIZE);
    entropyConcat.set(kaspaBytes, 0);
    entropyConcat.set(nistBytes, KASPA_SIZE);
    entropyConcat.set(btcBytes, KASPA_SIZE + NIST_SIZE);
    const entropyHash = await sha256(entropyConcat);
    const entropyHex = bytesToHex(entropyHash);

    // ── Step 7: Recursive fold ──
    const foldSeed = genesisTxId || gameId || "kktp";
    const foldBitstring = await fold(bytesToHex(hmacResult), entropyHex, { seed: foldSeed });

    // ── Step 8: Final VRF output ──
    const vrfOutputBytes = await sha256(new TextEncoder().encode(foldBitstring));
    const computedFragment = bytesToHex(vrfOutputBytes.slice(0, 4));

    // ── Step 9: Compare fragment ──
    const expectedFragment = normalizeHexInput(
      move.vrfFragment || move.vrfOutputHex || move.vrfOutput || "",
    ).slice(0, 8);

    if (computedFragment === expectedFragment) {
      matchCount++;
    } else {
      mismatchCount++;
      addReason(reasons, `vrf_chain_mismatch_at_move_${sequence}`);
    }

    // ── Step 10: Advance state ──
    vrfState = vrfOutputBytes;
  }

  const verified = mismatchCount === 0 && matchCount > 0;

  if (verified) {
    // No warning needed — chain is cryptographically verified
  } else if (mismatchCount > 0) {
    addReason(reasons, "vrf_chain_integrity_failed");
  }

  return {
    verified,
    matchCount,
    mismatchCount,
    totalMoves: vrfMoves.length,
  };
}
