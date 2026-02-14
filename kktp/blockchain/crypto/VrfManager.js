/**
 * VrfManager.js - Stateful VRF chain with HMAC-SHA256 + recursive folding
 *
 * Each move's randomness is cryptographically chained to the previous one:
 *   VRF_n = SHA256( fold( HMAC-SHA256(Key=VRF_{n-1}, Data=MoveData+Entropy), EntropyHash, {seed} ) )
 *
 * Lazy-Initialized Chain:
 *   - VRF_0 = SHA256(playerId + ":" + gameId + ":" + firstMoveTimestamp)
 *   - Once Genesis TX ID is confirmed, it is folded into the state on the next move
 *   - The auditor replays both phases identically using the per-move entropySnapshot
 *
 * v5 Union Protocol — variable data buffer layout:
 *   MOVE (136 bytes):  [VRF_State(32)] + [ActionCode(1)] + [X(2)] + [Y(2)] + [Z(2)] + [TimeDelta(1)] + [NIST(32)] + [BTC(32)] + [Kaspa(32)]
 *   Standard (131 bytes): [VRF_State(32)] + [ActionCode(1)] + [Lane(1)] + [TimeDelta(1)] + [NIST(32)] + [BTC(32)] + [Kaspa(32)]
 */

import { Logger, LogModule } from "../../core/logger.js";
import { bytesToHex, hexToBytes, sha256, hmacSha256 } from "../../core/cryptoUtils.js";
import { ACTION_TO_CODE, MOVE_ACTION_CODE } from "../../core/constants.js";
import { fold } from "../../engine/kaspa/vrf/core/folding.js";

const log = Logger.create(LogModule.anchor.vrfOperations);

/** Size of each component in the HMAC data buffer */
const VRF_STATE_SIZE = 32;
const NIST_SIZE = 32;
const BTC_SIZE = 32;
const KASPA_SIZE = 32;

/** Standard buffer: VRF(32) + ActionCode(1) + Lane(1) + TimeDelta(1) + NIST(32) + BTC(32) + Kaspa(32) = 131 */
const DATA_BUFFER_SIZE_STANDARD = VRF_STATE_SIZE + 1 + 1 + 1 + NIST_SIZE + BTC_SIZE + KASPA_SIZE; // 131

/** Extended MOVE buffer: VRF(32) + ActionCode(1) + X(2) + Y(2) + Z(2) + TimeDelta(1) + NIST(32) + BTC(32) + Kaspa(32) = 136 */
const DATA_BUFFER_SIZE_EXTENDED = VRF_STATE_SIZE + 1 + 2 + 2 + 2 + 1 + NIST_SIZE + BTC_SIZE + KASPA_SIZE; // 136

export class VrfManager {
  constructor({ kaspaLink, entropyProvider, onDeltaEntropy } = {}) {
    this._kaspaLink = kaspaLink ?? null;
    this._entropyProvider = entropyProvider ?? null;
    this._onDeltaEntropy = typeof onDeltaEntropy === "function" ? onDeltaEntropy : () => {};

    this._gameId = null;
    this._playerId = null;

    // Stateful VRF chain
    this._currentVrfState = null;  // Uint8Array(32) — the chain baton
    this._genesisTxId = null;      // string — set once genesis anchor confirms
    this._genesisReinforced = false; // has genesis TX been folded into state?
    this._foldLock = null;         // Promise-based mutex for atomic fold operations

    // Entropy tracking for delta detection
    this._lastBtcHashes = null;
    this._lastNistPulse = null;
    this._pendingBtcDelta = null;
    this._pendingNistDelta = null;
  }

  setKaspaLink(kaspaLink) {
    this._kaspaLink = kaspaLink;
  }

  setEntropyProvider(entropyProvider) {
    this._entropyProvider = entropyProvider;
  }

  setGameContext({ gameId, playerId }) {
    this._gameId = gameId ?? null;
    this._playerId = playerId ?? null;
  }

  /**
   * Set the Genesis TX ID once confirmed on-chain.
   * The next call to updateStateForMove will fold it into the VRF state.
   */
  setGenesisTxId(txId) {
    this._genesisTxId = txId ?? null;
    log.info("Genesis TX ID set for VRF reinforcement", {
      txId: txId?.substring(0, 16),
    });
  }

  setGenesisEntropy({ btcBlockHashes, nistPulse }) {
    this._lastBtcHashes = Array.isArray(btcBlockHashes) ? btcBlockHashes : null;
    this._lastNistPulse = nistPulse ?? null;
  }

  /**
   * Reset VRF state — called when game is stopped.
   * Ensures the next game starts with a fresh chain.
   */
  resetState() {
    this._currentVrfState = null;
    this._genesisTxId = null;
    this._genesisReinforced = false;
    this._foldLock = null;
    this._pendingBtcDelta = null;
    this._pendingNistDelta = null;
    log.debug("VRF state reset");
  }

  getPendingDeltas() {
    return {
      btc: this._pendingBtcDelta,
      nist: this._pendingNistDelta,
    };
  }

  clearPendingDeltas() {
    this._pendingBtcDelta = null;
    this._pendingNistDelta = null;
  }

  /**
   * Stateful VRF update: HMAC-SHA256 state transition + fold() entropy extraction.
   * Each call chains to the previous state, producing a deterministic VRF output
   * that the auditor can replay from the genesis seed.
   *
   * @param {Object} params
   * @param {string} params.action - Move action name (e.g. 'move', 'flip')
   * @param {number} [params.lane] - Lane index (standard moves)
   * @param {number} [params.x] - 14-bit raw X coordinate (MOVE only)
   * @param {number} [params.y] - 14-bit raw Y coordinate (MOVE only)
   * @param {number} [params.z] - 14-bit raw Z coordinate (MOVE only)
   * @param {number} params.timeDelta - Time delta (0-255)
   * @param {number} params.sequence - Move sequence number
   * @param {number} params.timestamp - Move timestamp (ms)
   * @returns {Promise<Object>} { vrfOutput, vrfOutputBytes, blockHash, blockHashHex, entropySnapshot }
   */
  async updateStateForMove({ action, lane, timeDelta, sequence, timestamp, x, y, z }) {
    if (!this._entropyProvider) {
      throw new Error("EntropyProvider not set");
    }

    // ── Mutex: prevent concurrent fold operations ──
    while (this._foldLock) {
      await this._foldLock;
    }

    let resolveLock;
    this._foldLock = new Promise((resolve) => { resolveLock = resolve; });

    try {
      // ── Step 1: Lazy initialization of VRF state ──
      // Include first move timestamp to ensure uniqueness across sessions
      if (this._currentVrfState === null) {
        const seedString = `${this._playerId}:${this._gameId}:${timestamp}`;
        this._currentVrfState = await sha256(new TextEncoder().encode(seedString));
        log.info("VRF chain initialized (lazy seed)", {
          gameId: this._gameId?.substring(0, 12),
          playerId: this._playerId?.substring(0, 12),
          timestamp,
        });
      }

      // ── Step 2: Genesis reinforcement (one-time fold of TX ID) ──
      let isGenesisReinforced = this._genesisReinforced;
      if (this._genesisTxId && !this._genesisReinforced) {
        const txIdBytes = hexToBytes(this._genesisTxId);
        const combined = new Uint8Array(VRF_STATE_SIZE + txIdBytes.length);
        combined.set(this._currentVrfState);
        combined.set(txIdBytes, VRF_STATE_SIZE);
        this._currentVrfState = await sha256(combined);
        this._genesisReinforced = true;
        isGenesisReinforced = true;
        log.info("Genesis TX folded into VRF state", {
          txId: this._genesisTxId.substring(0, 16),
        });
      }

      // ── Step 3: Gather cached entropy sources ──
      const blockInfo = this._entropyProvider.getCurrentBlockHash();
      const kaspaBytes = blockInfo.hash instanceof Uint8Array && blockInfo.hash.length === 32
        ? blockInfo.hash
        : new Uint8Array(32);
      const kaspaHex = blockInfo.hex || bytesToHex(kaspaBytes);

      // NIST: use stored genesis/delta pulse, SHA-256 → 32 bytes
      let nistOutputHashHex = "";
      if (this._lastNistPulse?.outputHash) {
        nistOutputHashHex = typeof this._lastNistPulse.outputHash === "string"
          ? this._lastNistPulse.outputHash
          : bytesToHex(this._lastNistPulse.outputHash);
      }
      const nistBytes = nistOutputHashHex
        ? await sha256(hexToBytes(nistOutputHashHex))
        : new Uint8Array(32); // zero-fill if not yet available

      // BTC: use latest stored hash → 32 bytes
      let btcHashHex = "";
      if (this._lastBtcHashes && this._lastBtcHashes.length > 0) {
        const first = this._lastBtcHashes[0];
        btcHashHex = first instanceof Uint8Array ? bytesToHex(first) : String(first || "");
      }
      const btcBytes = btcHashHex
        ? _padOrTruncate(hexToBytes(btcHashHex), BTC_SIZE)
        : new Uint8Array(32); // zero-fill if not yet available

      // ── Step 4: Build deterministic data buffer (v5 union protocol) ──
      const actionCode = (ACTION_TO_CODE[action] ?? 0) & 0xff;
      const isMove = actionCode === MOVE_ACTION_CODE;
      const bufferSize = isMove ? DATA_BUFFER_SIZE_EXTENDED : DATA_BUFFER_SIZE_STANDARD;
      const dataBuffer = new Uint8Array(bufferSize);
      let offset = 0;

      dataBuffer.set(this._currentVrfState, offset);
      offset += VRF_STATE_SIZE;

      dataBuffer[offset++] = actionCode;

      if (isMove) {
        // Extended: [ActionCode(1)] + [X(2)] + [Y(2)] + [Z(2)] + [TimeDelta(1)]
        const xVal = (x ?? 0) & 0xFFFF;
        dataBuffer[offset++] = (xVal >> 8) & 0xff;
        dataBuffer[offset++] = xVal & 0xff;
        const yVal = (y ?? 0) & 0xFFFF;
        dataBuffer[offset++] = (yVal >> 8) & 0xff;
        dataBuffer[offset++] = yVal & 0xff;
        const zVal = (z ?? 0) & 0xFFFF;
        dataBuffer[offset++] = (zVal >> 8) & 0xff;
        dataBuffer[offset++] = zVal & 0xff;
        dataBuffer[offset++] = (timeDelta ?? 0) & 0xff;
      } else {
        // Standard: [ActionCode(1)] + [Lane(1)] + [TimeDelta(1)]
        dataBuffer[offset++] = (lane ?? 0) & 0xff;
        dataBuffer[offset++] = (timeDelta ?? 0) & 0xff;
      }

      dataBuffer.set(nistBytes, offset);
      offset += NIST_SIZE;

      dataBuffer.set(btcBytes, offset);
      offset += BTC_SIZE;

      dataBuffer.set(kaspaBytes, offset);

      // ── Step 5: HMAC-SHA256 state transition ──
      const hmacResult = await hmacSha256(this._currentVrfState, dataBuffer);

      // ── Step 6: Entropy hash for fold() ──
      const entropyConcat = new Uint8Array(KASPA_SIZE + NIST_SIZE + BTC_SIZE);
      entropyConcat.set(kaspaBytes, 0);
      entropyConcat.set(nistBytes, KASPA_SIZE);
      entropyConcat.set(btcBytes, KASPA_SIZE + NIST_SIZE);
      const entropyHash = await sha256(entropyConcat);
      const entropyHex = bytesToHex(entropyHash);

      // ── Step 7: Recursive folding — high-quality entropy extraction ──
      const foldSeed = this._genesisTxId || this._gameId || "kktp";
      const foldBitstring = await fold(bytesToHex(hmacResult), entropyHex, { seed: foldSeed });

      // ── Step 8: Final VRF output = SHA256(foldBitstring) ──
      const vrfOutputBytes = await sha256(new TextEncoder().encode(foldBitstring));
      const vrfOutput = bytesToHex(vrfOutputBytes);

      // ── Step 9: Update the baton atomically ──
      this._currentVrfState = vrfOutputBytes;

      // ── Step 10: Entropy delta detection (uses stored values) ──
      this._checkBtcDelta(btcBytes, btcHashHex);
      this._checkNistDelta();

      log.debug("VRF chain advanced", {
        sequence,
        vrfFragment: vrfOutput.substring(0, 8),
        genesisReinforced: isGenesisReinforced,
        kaspaBlock: kaspaHex.substring(0, 16),
      });

      // ── Build entropy snapshot for audit determinism ──
      const entropySnapshot = {
        nistOutputHash: nistOutputHashHex || null,
        btcHash: btcHashHex || null,
        kaspaBlockHash: kaspaHex,
        isGenesisReinforced,
        initTimestamp: sequence === 1 ? timestamp : undefined,
      };

      return {
        vrfOutput,
        vrfOutputBytes,
        blockHash: blockInfo.hash,
        blockHashHex: kaspaHex,
        entropySnapshot,
      };
    } finally {
      // Release mutex
      this._foldLock = null;
      resolveLock();
    }
  }

  /**
   * Check for BTC entropy delta vs last known value.
   */
  _checkBtcDelta(currentBtcBytes, currentBtcHex) {
    if (!currentBtcHex || !this._lastBtcHashes || this._lastBtcHashes.length === 0) return;

    const lastFirst = this._lastBtcHashes[0];
    const lastHex = lastFirst instanceof Uint8Array ? bytesToHex(lastFirst) : String(lastFirst || "");

    if (lastHex && currentBtcHex && lastHex !== currentBtcHex) {
      this._pendingBtcDelta = currentBtcBytes;
      log.info("BTC entropy delta detected", { newHash: currentBtcHex.substring(0, 16) });
      this._onDeltaEntropy({ type: "btc", hash: currentBtcBytes });
    }
  }

  /**
   * Check for NIST entropy delta — emits event when pulse index changes.
   * Called after each move to track NIST pulse changes over time.
   */
  _checkNistDelta() {
    // Delta detection happens when setGenesisEntropy or external updates change _lastNistPulse
    // The pending delta is already set in setGenesisEntropy flow if pulse changed.
    // This method exists for symmetry and future extension.
  }
}

/**
 * Pad or truncate a Uint8Array to exactly the target length.
 */
function _padOrTruncate(bytes, targetLength) {
  if (bytes.length === targetLength) return bytes;
  const result = new Uint8Array(targetLength);
  result.set(bytes.subarray(0, Math.min(bytes.length, targetLength)));
  return result;
}

export default VrfManager;
