/**
 * AuditTrail.js - Audit/export data builder
 */

import { ANCHOR, BLOCKCHAIN, CODE_TO_ACTION } from "../../core/constants.js";
import { hexToBytes, bytesToHex } from "../../core/cryptoUtils.js";
import { parseHeartbeatHex as _sharedParseHB } from "../anchor/heartbeatParser.js";

export class AuditTrail {
  constructor({ kaspaLink, packer }) {
    this._kaspaLink = kaspaLink ?? null;
    this._packer = packer;
  }

  setKaspaLink(kaspaLink) {
    this._kaspaLink = kaspaLink;
  }

  getAuditData(options = {}, state = {}) {
    const { gameIdTagHex } = options || {};
    const {
      gameId,
      resolvedGameIdTagHex,
      sessionController,
      anchorState,
      vault,
      merkleManager,
      opponentMerkleManager,
      finalScore,
      coinsCollected,
      getBinaryAnchor,
      setBinaryAnchor,
    } = state;

    if (gameIdTagHex && resolvedGameIdTagHex && String(gameIdTagHex).toLowerCase() !== String(resolvedGameIdTagHex).toLowerCase()) {
      return null;
    }

    const vrfSeed = sessionController?.vrfSeed ?? null;
    const startBlockHashHex = sessionController?.getStartBlockHashHex?.() ?? null;
    const endBlockHashHex = sessionController?.getEndBlockHashHex?.() ?? null;
    const qrngPulses = sessionController?.qrngPulses ?? [];

    let binaryAnchor = getBinaryAnchor?.() ?? null;
    if (!binaryAnchor) {
      binaryAnchor = this._packer.packAnchorToBinary({
        gameId,
        sessionController,
        moveHistory: vault.getMoveHistory(),
        finalScore,
        coinsCollected,
      });
      setBinaryAnchor?.(binaryAnchor);
    }

    const anchorHex = this._packer.bytesToHex(binaryAnchor);
    const decodedMoves = this._packer.decodeMovesFromBinary(binaryAnchor);

    const anchorChain = anchorState?.anchorChain ?? [];
    const genesisEntropy = anchorState?.genesisEntropy ?? null;

    return {
      version: ANCHOR.VERSION,
      protocolVersion: "v5",
      gameId,
      playerId: anchorState?.playerId ?? null,
      anchorChain: {
        genesisTxId: anchorState?.genesisTxId ?? null,
        lastAnchorTxId: anchorState?.lastAnchorTxId ?? null,
        chain: anchorChain,
        chainLength: anchorChain.length,
      },
      genesisEntropy: genesisEntropy
        ? {
            hashedSeed: this._packer.bytesToHex(genesisEntropy.hashedSeed),
            btcBlockHashes: genesisEntropy.btcBlockHashes.map((h) => this._packer.bytesToHex(h)),
            nistPulseIndex: genesisEntropy.nistPulse?.pulseIndex,
            nistOutputHash: genesisEntropy.nistPulse?.outputHash
              ? this._packer.bytesToHex(genesisEntropy.nistPulse.outputHash)
              : null,
            nistSignature: genesisEntropy.nistPulse?.signature
              ? this._packer.bytesToHex(genesisEntropy.nistPulse.signature)
              : null,
            hasNistSignature: genesisEntropy.nistPulse?.signature?.some((b) => b !== 0) ?? false,
            startDaaScore: genesisEntropy.startDaaScore,
            endDaaScore: genesisEntropy.endDaaScore,
            binaryHex: genesisEntropy.anchorHex,
            binaryBytes: genesisEntropy.binaryAnchor?.length,
          }
        : null,
      binaryAnchor: anchorHex,
      binaryBytes: binaryAnchor.length,
      header: {
        version: ANCHOR.VERSION,
        gameId,
        gameIdTagHex: resolvedGameIdTagHex,
        startBlockHash: startBlockHashHex,
        endBlockHash: endBlockHashHex,
        vrfSeed,
        moveCount: Math.min(vault.getMoveCount(), ANCHOR.MAX_MOVES),
        qrngPulseCount: Math.min(qrngPulses.length, ANCHOR.MAX_QRNG_PULSES),
        finalScore,
        coinsCollected,
      },
      qrngPulses: qrngPulses.map((p) => ({
        pulseIndex: p.pulseIndex,
        pulseFragment: this._packer.bytesToHex(p.pulseValue),
        pulseValue: p.pulseValue,
        signature: p.signature || null,
      })),
      moves: decodedMoves,
      v4MoveHistory: vault.getMoveHistory().map((m) => {
        const entry = {
          sequence: m.sequence,
          action: m.action,
          timestamp: m.timestamp,
          timeDelta: m.timeDelta,
          vrfFragment: m.vrfFragment,
          vrfOutputHex: m.vrfOutput,
          kaspaBlockHashHex: m.kaspaBlockHashHex,
          leafHash: m.leafHash,
          entropySnapshot: m.entropySnapshot ?? null,
        };
        // v5: include x/y/z for MOVE actions, lane for standard
        if (m.x != null) { entry.x = m.x; entry.y = m.y; entry.z = m.z; }
        if (m.lane != null) entry.lane = m.lane;
        return entry;
      }),
      context: {
        playerId: anchorState?.playerId ?? null,
        opponentId: anchorState?.opponentId ?? null,
        merkleRoot: merkleManager.getRoot(),
        totalMoveCount: merkleManager.size,
        merkleLeaves: merkleManager.getLeaves?.() ?? [],
        rawMoveHistory: vault.getMoveHistory(),
      },
      vrfProofs: vault.getVrfProofArchive().map((p) => {
        const entry = {
          moveIndex: p.moveIndex,
          action: p.action,
          timestamp: p.timestamp,
          vrfOutput: p.vrfOutput,
          proof: p.proof,
          blockHash: p.blockHash,
          evidence: p.evidence,
        };
        if (p.x != null) { entry.x = p.x; entry.y = p.y; entry.z = p.z; }
        if (p.lane != null) entry.lane = p.lane;
        return entry;
      }),
      opponent: anchorState?.opponentId
        ? {
            merkleRoot: opponentMerkleManager.getRoot(),
            moveCount: opponentMerkleManager.size,
          }
        : null,
      verification: {
        instructions: [
          "1. Fetch genesis tx \u2192 extract BTC hashes, NIST sig, DAA bounds",
          "2. Follow prevTxId chain through heartbeats \u2192 verify move merkle proofs",
          "3. Check final tx \u2192 verify results match merkle tree",
          "4. Replay game deterministically from anchored data",
          "5. Verify each move VRF was computed with the stated Kaspa block hash",
        ],
        canonicalLeafHashFormula: "MOVE: simpleHashHex({action,x,y,z,timeDelta,vrfFragment}), Standard: simpleHashHex({action,lane,timeDelta,vrfFragment})",
      },
    };
  }

  async getAuditDataFromDag(options = {}, state = {}) {
    const {
      gameId,
      gameIdTagHex,
      genesisBlockHashHex,
      endBlockHashHex,
      maxSeconds,
      minTimestamp,
      debug,
      disablePrefixFilter,
    } = options || {};

    const { resolvedGameIdTagHex, computeGameIdTagHex } = state;

    if (!genesisBlockHashHex) {
      throw new Error("genesisBlockHashHex is required");
    }

    if (!this._kaspaLink?.walkDagRange) {
      throw new Error("KaspaAdapter does not support walkDagRange");
    }

    const tagHex =
      gameIdTagHex || resolvedGameIdTagHex || (gameId ? computeGameIdTagHex(gameId) : null);

    if (!tagHex) {
      throw new Error("gameId or gameIdTagHex is required");
    }

    const prefixGenesis = `${BLOCKCHAIN.PREFIX_GAME_START_HEX}${tagHex}`.toLowerCase();
    const prefixHeartbeat = `${BLOCKCHAIN.PREFIX_HEARTBEAT_HEX}${tagHex}`.toLowerCase();
    const prefixFinal = `${BLOCKCHAIN.PREFIX_GAME_END_HEX}${tagHex}`.toLowerCase();

    const chain = [];
    const seenTxIds = new Set();
    let genesisTxId = null;
    let lastAnchorTxId = null;

    const logFn = debug ? (...args) => console.log("[auditDag]", ...args) : () => {};

    logFn("scan start", {
      startHash: genesisBlockHashHex,
      endHash: endBlockHashHex || null,
      tagHex,
      maxSeconds: Number.isFinite(maxSeconds) ? maxSeconds : 30,
      minTimestamp: Number.isFinite(minTimestamp) ? minTimestamp : 0,
      disablePrefixFilter: !!disablePrefixFilter,
    });

    await this._kaspaLink.walkDagRange({
      startHash: genesisBlockHashHex,
      endHash: endBlockHashHex || null,
      prefixes: disablePrefixFilter ? [] : [prefixGenesis, prefixHeartbeat, prefixFinal],
      maxSeconds: Number.isFinite(maxSeconds) ? maxSeconds : 30,
      minTimestamp: Number.isFinite(minTimestamp) ? minTimestamp : 0,
      logFn,
      onMatch: (tx, block) => {
        const payload = String(tx?.payload || "")
          .toLowerCase()
          .replace(/^0x/, "");
        let type = null;
        let prefixHex = null;

        if (payload.startsWith(prefixGenesis)) {
          type = "genesis";
          prefixHex = prefixGenesis;
        } else if (payload.startsWith(prefixHeartbeat)) {
          type = "heartbeat";
          prefixHex = prefixHeartbeat;
        } else if (payload.startsWith(prefixFinal)) {
          type = "final";
          prefixHex = prefixFinal;
        }

        if (!type) return;

        const txId = tx?.txid || tx?.transactionId || null;
        if (!txId || seenTxIds.has(txId)) return;
        seenTxIds.add(txId);

        const anchorHex = payload.slice(prefixHex.length);
        const rawTimestamp = tx?.timestamp ?? block?.timestamp ?? null;
        const timestamp = typeof rawTimestamp === "bigint" ? Number(rawTimestamp) : rawTimestamp;
        const entry = {
          txId,
          type,
          timestamp,
          blockHash: tx?.blockHash ?? block?.hash ?? null,
          blockDaaScore: tx?.blockDaaScore ?? block?.daaScore ?? null,
          blockBlueScore: tx?.blueScore ?? block?.blueScore ?? null,
          anchorHex,
        };

        if (type === "genesis" && !genesisTxId) {
          genesisTxId = txId;
        }

        lastAnchorTxId = txId;
        chain.push(entry);
        logFn("match", { type, txId, blockHash: entry.blockHash });
      },
    });

    logFn("scan complete", { chainLength: chain.length });

    // Parse binary payloads and build full audit data structure
    return AuditTrail._buildFullAuditFromDag({
      chain,
      genesisTxId,
      lastAnchorTxId,
      gameId: gameId ?? state.gameId ?? null,
      gameIdTagHex: tagHex,
      genesisBlockHashHex,
      endBlockHashHex: endBlockHashHex ?? null,
      disablePrefixFilter: !!disablePrefixFilter,
    });
  }

  // ──────────────────────────────────────────────────────────────
  // Static: DAG anchor parsing
  // ──────────────────────────────────────────────────────────────

  /**
   * Build a full audit data structure from parsed DAG chain entries.
   * Mirrors the shape returned by getAuditData() (in-memory mode)
   * so the UI components (RawDataSection, NistSection, AuditVerifier)
   * receive the same data structure regardless of source.
   * @private
   */
  static _buildFullAuditFromDag({ chain, genesisTxId, lastAnchorTxId, gameId, gameIdTagHex, genesisBlockHashHex, endBlockHashHex, disablePrefixFilter }) {
    let genesis = null;
    const heartbeats = [];
    let final = null;

    for (const entry of chain) {
      if (entry.type === "genesis") {
        genesis = AuditTrail._parseGenesisHex(entry.anchorHex);
      } else if (entry.type === "heartbeat") {
        const hb = AuditTrail._parseHeartbeatHex(entry.anchorHex);
        if (hb) {
          hb._txId = entry.txId;
          hb._timestamp = entry.timestamp;
          hb._blockHash = entry.blockHash ?? entry.blockHashHex ?? entry.block_hash ?? null;
          hb._blockBlueScore = entry.blockBlueScore ?? entry.blueScore ?? entry.blockBlueScoreHex ?? null;
          heartbeats.push(hb);
        }
      } else if (entry.type === "final") {
        final = AuditTrail._parseFinalHex(entry.anchorHex);
        if (final) {
          final._txId = entry.txId;
        }
      }
    }

    // ── genesisEntropy ──
    const genesisEntropy = genesis
      ? {
          hashedSeed: genesis.hashedSeed,
          gameIdHash: genesis.gameIdHash,
          btcBlockHashes: genesis.btcBlockHashes,
          nistPulseIndex: genesis.nistPulseIndex,
          nistOutputHash: genesis.nistOutputHash,
          nistSignature: genesis.nistSignature,
          hasNistSignature: genesis.hasNistSignature,
          startDaaScore: genesis.startDaaScore,
          endDaaScore: genesis.endDaaScore,
        }
      : null;

    // ── Aggregate moves from heartbeats ──
    const allMoves = [];
    let globalIdx = 0;
    let currentBtcHash =
      Array.isArray(genesis?.btcBlockHashes) && genesis.btcBlockHashes.length > 0
        ? genesis.btcBlockHashes[0]
        : null;
    let currentNistOutputHash = genesis?.nistOutputHash ?? null;
    let sessionTimeMs = 0;
    for (const hb of heartbeats) {
      if (hb.deltaBtcHash) currentBtcHash = hb.deltaBtcHash;
      if (hb.deltaNistPulse?.outputHash) currentNistOutputHash = hb.deltaNistPulse.outputHash;

      const kaspaBlockHashHex = hb._blockHash ?? null;
      const kaspaBlockBlueScore = hb._blockBlueScore ?? null;

      for (const m of hb.moves || []) {
        const rawDelta = Number.isFinite(m.rawDelta) ? m.rawDelta : null;
        const timeDelta = Number.isFinite(rawDelta)
          ? rawDelta
          : Number.isFinite(m.timeDeltaMs)
            ? Math.floor(m.timeDeltaMs / ANCHOR.TIME_DELTA_SCALE)
            : 0;
        const timeDeltaMs = Number.isFinite(m.timeDeltaMs)
          ? m.timeDeltaMs
          : timeDelta * ANCHOR.TIME_DELTA_SCALE;

        sessionTimeMs += timeDeltaMs;

        const moveEntry = {
          moveIndex: globalIdx,
          sequence: globalIdx,
          action: m.action,
          actionCode: m.actionCode,
          timeDelta,
          timeDeltaMs,
          rawDelta,
          vrfFragment: m.vrfFragment,
          vrfOutputHex: m.vrfFragment,
          timestamp: hb._timestamp ?? null,
          sessionTimeMs,
          leafHash: m.leafHash ?? null,
          kaspaBlockHashHex,
          kaspaBlockBlueScore,
          entropySnapshot: {
            kaspaBlockHash: kaspaBlockHashHex,
            kaspaBlockBlueScore,
            btcHash: currentBtcHash,
            nistOutputHash: currentNistOutputHash,
            isGenesisReinforced: !!genesisTxId && globalIdx === 0,
          },
        };
        // v5: forward coordinate or lane data
        if (m.x != null) { moveEntry.x = m.xRaw ?? m.x; moveEntry.y = m.yRaw ?? m.y; moveEntry.z = m.zRaw ?? m.z; }
        if (m.lane != null) moveEntry.lane = m.lane;
        allMoves.push(moveEntry);
        globalIdx++;
      }
    }

    // ── VRF proofs from moves ──
    const vrfProofs = allMoves.map((m) => {
      const vp = {
        moveIndex: m.moveIndex,
        action: m.action,
        vrfOutput: m.vrfFragment,
        vrfOutputHex: m.vrfFragment,
        timeDeltaMs: m.timeDeltaMs,
        rawDelta: m.rawDelta,
        timestamp: m.timestamp,
        sessionTimeMs: m.sessionTimeMs,
        kaspaBlockHashHex: m.kaspaBlockHashHex,
        kaspaBlockBlueScore: m.kaspaBlockBlueScore,
      };
      if (m.x != null) { vp.x = m.x; vp.y = m.y; vp.z = m.z; }
      if (m.lane != null) vp.lane = m.lane;
      return vp;
    });

    const v4MoveHistory = allMoves.map((m) => {
      const mh = {
        sequence: m.sequence,
        action: m.action,
        timestamp: m.timestamp,
        timeDelta: m.timeDelta,
        timeDeltaMs: m.timeDeltaMs,
        rawDelta: m.rawDelta,
        vrfFragment: m.vrfFragment,
        vrfOutputHex: m.vrfOutputHex,
        kaspaBlockHashHex: m.kaspaBlockHashHex,
        kaspaBlockBlueScore: m.kaspaBlockBlueScore,
        sessionTimeMs: m.sessionTimeMs,
        leafHash: m.leafHash,
        entropySnapshot: m.entropySnapshot ?? null,
      };
      if (m.x != null) { mh.x = m.x; mh.y = m.y; mh.z = m.z; }
      if (m.lane != null) mh.lane = m.lane;
      return mh;
    });

    // ── Merkle checkpoints from heartbeats ──
    const merkleLeaves = [];
    heartbeats.forEach((hb, idx) => {
      if (hb.merkleRoot) {
        merkleLeaves.push({
          hash: hb.merkleRoot,
          label: `Heartbeat #${idx + 1} (${hb.moveCount || 0} moves)`,
        });
      }
    });

    // Final merkle root (from final anchor or last heartbeat)
    let merkleRoot = final?.finalMerkleRoot || null;
    if (!merkleRoot && merkleLeaves.length > 0) {
      merkleRoot = merkleLeaves[merkleLeaves.length - 1].hash;
    }

    // ── NIST QRNG pulses: genesis + heartbeat deltas ──
    const qrngPulses = [];
    if (genesis?.nistPulseIndex) {
      qrngPulses.push({
        pulseIndex: genesis.nistPulseIndex,
        pulseValue: genesis.nistOutputHash,
        pulseFragment: genesis.nistOutputHash,
        signature: genesis.nistSignature,
        isFragment: false,
        source: "genesis",
      });
    }
    for (const hb of heartbeats) {
      if (hb.deltaNistPulse) {
        qrngPulses.push({
          pulseIndex: hb.deltaNistPulse.pulseIndex,
          pulseValue: hb.deltaNistPulse.outputHash,
          pulseFragment: hb.deltaNistPulse.outputHash,
          signature: hb.deltaNistPulse.signature,
          isFragment: false,
          source: "heartbeat-delta",
        });
      }
    }

    // ── Anchor counts ──
    const genesisCount = genesis ? 1 : 0;
    const heartbeatCount = heartbeats.length;
    const finalCount = final ? 1 : 0;

    // ── Game results from final anchor ──
    const totalMoves = final?.totalMoves ?? allMoves.length;

    return {
      version: ANCHOR.VERSION,
      protocolVersion: "v5",
      source: "blockchain",
      gameId,
      timestamp: new Date().toISOString(),
      anchorChain: {
        genesisTxId,
        lastAnchorTxId,
        chain,
        chainLength: chain.length,
      },
      genesisEntropy,
      anchorCounts: {
        total: genesisCount + heartbeatCount + finalCount,
        genesis: genesisCount,
        heartbeats: heartbeatCount,
        final: finalCount,
      },
      header: {
        moveCount: totalMoves,
        finalScore: final?.finalScore ?? 0,
        coinsCollected: final?.coinsCollected ?? 0,
        raceTimeMs: final?.raceTimeMs ?? 0,
        gameIdTagHex,
      },
      gameResults: {
        score: final?.finalScore ?? 0,
        coins: final?.coinsCollected ?? 0,
        progress: final ? 1 : 0,
        endReason: final?.outcomeLabel ?? "unknown",
      },
      context: {
        merkleRoot,
        totalMoveCount: totalMoves,
        merkleLeaves,
        rawMoveHistory: v4MoveHistory,
      },
      merkle: {
        root: merkleRoot,
        leaves: merkleLeaves,
        leafCount: merkleLeaves.length,
      },
      moves: allMoves,
      v4MoveHistory,
      vrfProofs,
      qrngPulses,
      dagScan: {
        gameId,
        gameIdTagHex,
        startBlockHash: genesisBlockHashHex,
        endBlockHash: endBlockHashHex ?? null,
        disablePrefixFilter: !!disablePrefixFilter,
      },
      errors: [],
    };
  }

  /**
   * Parse a genesis anchor payload (hex after prefix+tag).
   * Layout: version(1) + type(1) + gameIdHash(32) + hashedSeed(32)
   *       + btcHashes(6×32) + startDaa(8) + endDaa(8) + nistIndex(8)
   *       + nistOutputHash(64) + nistSignature(512) = 858 bytes
   * @private
   */
  static _parseGenesisHex(hex) {
    if (!hex) return null;
    try {
      const bytes = hexToBytes(hex);
      if (bytes.length < ANCHOR.GENESIS_BASE_SIZE) return null;

      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      let off = 0;

      const version = bytes[off++];
      const anchorType = bytes[off++];
      if (anchorType !== ANCHOR.TYPE_GENESIS) return null;

      const gameIdHash = bytesToHex(bytes.slice(off, off + 32)); off += 32;
      const hashedSeed = bytesToHex(bytes.slice(off, off + 32)); off += 32;

      const btcBlockHashes = [];
      for (let i = 0; i < ANCHOR.BTC_BLOCK_COUNT; i++) {
        const h = bytesToHex(bytes.slice(off, off + 32));
        if (h !== "0".repeat(64)) btcBlockHashes.push(h);
        off += 32;
      }

      const startDaaScore = Number(view.getBigUint64(off, false)); off += 8;
      const endDaaScore = Number(view.getBigUint64(off, false)); off += 8;
      const nistPulseIndex = Number(view.getBigUint64(off, false)); off += 8;

      const nistOutputHash = bytesToHex(bytes.slice(off, off + 64)); off += 64;
      const nistSignature = bytesToHex(bytes.slice(off, off + 512)); off += 512;
      const hasNistSignature = nistSignature !== "0".repeat(1024);

      return {
        version, gameIdHash, hashedSeed, btcBlockHashes,
        startDaaScore, endDaaScore,
        nistPulseIndex, nistOutputHash, nistSignature, hasNistSignature,
      };
    } catch { return null; }
  }

  /**
   * Parse a heartbeat anchor payload (hex after prefix+tag).
   * Delegates to the shared heartbeatParser and flattens into
   * the legacy shape that audit callers expect.
   * @private
   */
  static _parseHeartbeatHex(hex) {
    // The shared parser expects a full payload (prefix+tag+anchor).
    // Audit callers pass just the anchor hex, so call it without prefix/tag.
    const result = _sharedParseHB(hex, {
      prefixHex: "",
      tagHex: "",
      allowNoPrefix: true,
    });
    if (!result) return null;

    // Flatten header into top-level for backward compatibility
    return {
      version: result.header.version,
      merkleRoot: result.header.merkleRoot,
      prevTxId: result.header.prevTxId,
      deltaFlags: result.header.deltaFlags,
      moveCount: result.header.moveCount,
      moves: result.moves,
      deltaBtcHash: result.header.deltaBtcHash,
      deltaNistPulse: result.header.deltaNistPulse,
    };
  }

  /**
   * Parse a final anchor payload (hex after prefix+tag).
   * Layout: version(1) + type(1) + finalMerkleRoot(32) + genesisTxId(32)
   *       + prevTxId(32) + resultLeafHash(32) + finalScore(4)
   *       + coinsCollected(4) + raceTimeMs(4) + outcome(1) + totalMoves(1) = 144
   * @private
   */
  static _parseFinalHex(hex) {
    if (!hex) return null;
    try {
      const bytes = hexToBytes(hex);
      if (bytes.length < ANCHOR.FINAL_SIZE) return null;

      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      let off = 0;

      const version = bytes[off++];
      const anchorType = bytes[off++];
      if (anchorType !== ANCHOR.TYPE_FINAL) return null;

      const finalMerkleRoot = bytesToHex(bytes.slice(off, off + 32)); off += 32;
      const genesisTxId = bytesToHex(bytes.slice(off, off + 32)); off += 32;
      const prevTxId = bytesToHex(bytes.slice(off, off + 32)); off += 32;
      const resultLeafHash = bytesToHex(bytes.slice(off, off + 32)); off += 32;

      const finalScore = view.getUint32(off, false); off += 4;
      const coinsCollected = view.getUint32(off, false); off += 4;
      const raceTimeMs = view.getUint32(off, false); off += 4;
      const outcome = bytes[off++];
      const totalMoves = bytes[off++];

      const outcomeLabels = {
        [ANCHOR.OUTCOME_COMPLETE]: "complete",
        [ANCHOR.OUTCOME_FORFEIT]: "forfeit",
        [ANCHOR.OUTCOME_TIMEOUT]: "timeout",
        [ANCHOR.OUTCOME_CHEAT]: "cheat",
      };

      return {
        version, finalMerkleRoot, genesisTxId, prevTxId, resultLeafHash,
        finalScore, coinsCollected, raceTimeMs,
        outcome, totalMoves,
        outcomeLabel: outcomeLabels[outcome] || "unknown",
      };
    } catch { return null; }
  }
}

export default AuditTrail;
