/**
 * AnchorStrategy.js - Three-anchor orchestration
 */

import { Logger, LogModule } from "../../core/logger.js";
import { bytesToHex, hexToBytes, sha256 } from "../../core/cryptoUtils.js";
import {
  BLOCKCHAIN, ANCHOR, ACTION_TO_CODE, ACTION_CODE,
  MOVE_ACTION_CODE, encodeCoord14, movePacketSize,
} from "../../core/constants.js";

const log = Logger.create(LogModule.anchor.anchorHeartbeat);

export class AnchorStrategy {
  constructor({ kaspaLink, wallet, packer, merkleManager, vault, vrf, onEvent } = {}) {
    this._kaspaLink = kaspaLink ?? null;
    this._wallet = wallet ?? null;
    this._packer = packer;
    this._merkleManager = merkleManager;
    this._vault = vault;
    this._vrf = vrf;
    this._onEvent = typeof onEvent === "function" ? onEvent : () => {};

    this._gameId = null;
    this._gameIdTagHex = null;
    this._isActive = false;

    this._anchorTimerId = null;
    this._anchorBackoffTimeoutId = null;
    this._isSending = false;
    this._heartbeatDisabled = false;
    this._lastAnchorTime = 0;
    this._lastAnchoredMoveCount = 0;
    this._anchorFailCount = 0;
    this._consecutiveFailures = 0;

    this._genesisTxId = null;
    this._lastAnchorTxId = null;
    this._anchorChain = [];
    this._genesisEntropy = null;

    this._binaryAnchor = null;
  }

  setKaspaLink(kaspaLink) {
    this._kaspaLink = kaspaLink;
  }

  setWallet(wallet) {
    this._wallet = wallet;
  }

  setGameContext({ gameId, gameIdTagHex }) {
    this._gameId = gameId ?? null;
    this._gameIdTagHex = gameIdTagHex ?? null;
  }

  start() {
    this._isActive = true;
    this._heartbeatDisabled = true;
    this._kaspaLink?.setHeartbeatAnchorsEnabled?.(true);

    this._lastAnchorTime = Date.now();
    this._lastAnchoredMoveCount = 0;
    this._anchorFailCount = 0;
    this._consecutiveFailures = 0;

    this._genesisTxId = null;
    this._lastAnchorTxId = null;
    this._anchorChain = [];
    this._genesisEntropy = null;
    this._binaryAnchor = null;
  }

  stop() {
    this._isActive = false;
    this._heartbeatDisabled = true;
    this._kaspaLink?.setHeartbeatAnchorsEnabled?.(false);

    if (this._anchorTimerId) {
      clearInterval(this._anchorTimerId);
      this._anchorTimerId = null;
    }

    if (this._anchorBackoffTimeoutId) {
      clearTimeout(this._anchorBackoffTimeoutId);
      this._anchorBackoffTimeoutId = null;
    }

    this._wallet?.stopHeartbeat?.();
  }

  getAnchorState() {
    return {
      genesisTxId: this._genesisTxId,
      lastAnchorTxId: this._lastAnchorTxId,
      anchorChain: [...this._anchorChain],
      genesisEntropy: this._genesisEntropy,
    };
  }

  getBinaryAnchor() {
    return this._binaryAnchor;
  }

  get isSending() {
    return this._isSending;
  }

  get lastAnchoredMoveCount() {
    return this._lastAnchoredMoveCount;
  }

  _buildAnchorPayload(prefixHex, anchorHex) {
    return `${prefixHex}${this._gameIdTagHex ?? ""}${anchorHex}`;
  }

  _startHeartbeatTimer() {
    if (!this._isActive || this._heartbeatDisabled) return;
    if (this._anchorTimerId) clearInterval(this._anchorTimerId);

    this._anchorTimerId = setInterval(() => {
      if (this._isActive && !this._isSending) {
        this.sendHeartbeatAnchor();
      }
    }, BLOCKCHAIN.ANCHOR_BATCH_MS);

    log.debug("Anchor heartbeat started", { intervalMs: BLOCKCHAIN.ANCHOR_BATCH_MS });
  }

  async anchorGenesisSeed(options = {}) {
    if (!this._kaspaLink) {
      throw new Error("KaspaLink not set");
    }

    if (this._genesisTxId) {
      log.warn("Genesis anchor already sent", { txId: this._genesisTxId });
      if (this._isActive && this._heartbeatDisabled) {
        this._heartbeatDisabled = false;
        this._startHeartbeatTimer();
      }
      return { success: true, txId: this._genesisTxId, alreadySent: true };
    }

    const { vrfSeed, startDaaScore, endDaaScore, prefetchedData, retryCount } = options;

    log.info("Preparing genesis anchor...", {
      startDaaScore,
      endDaaScore,
      hasPrefetchedData: !!prefetchedData,
    });

    let btcBlockHashes = [];
    try {
      const btcBlocks = prefetchedData?.btcBlocks ?? (await this._kaspaLink.getBitcoinBlocks?.());
      if (btcBlocks && Array.isArray(btcBlocks)) {
        btcBlockHashes = btcBlocks.slice(0, ANCHOR.BTC_BLOCK_COUNT).map((block) => {
          if (typeof block.hash === "string") {
            return hexToBytes(block.hash);
          }
          return block.hash instanceof Uint8Array ? block.hash : new Uint8Array(32);
        });
      }
    } catch (e) {
      log.warn("Failed to get BTC blocks", e);
    }

    while (btcBlockHashes.length < ANCHOR.BTC_BLOCK_COUNT) {
      btcBlockHashes.push(new Uint8Array(32));
    }

    let nistPulse = {
      pulseIndex: 0,
      outputHash: new Uint8Array(64),
      signature: new Uint8Array(512),
    };
    try {
      const qrng = prefetchedData?.qrng ?? (await this._kaspaLink.getQRNG?.());
      if (qrng) {
        nistPulse.pulseIndex = qrng.pulseIndex ?? 0;

        const outputHex =
          typeof qrng.outputValue === "string"
            ? qrng.outputValue
            : typeof qrng.outputHash === "string"
              ? qrng.outputHash
              : typeof qrng.hash === "string"
                ? qrng.hash
                : null;

        if (outputHex) {
          nistPulse.outputHash = hexToBytes(outputHex);
        } else if (qrng.outputValue instanceof Uint8Array) {
          nistPulse.outputHash = qrng.outputValue;
        } else if (qrng.outputHash instanceof Uint8Array) {
          nistPulse.outputHash = qrng.outputHash;
        } else if (qrng.hash instanceof Uint8Array) {
          nistPulse.outputHash = qrng.hash;
        }

        const signatureHex =
          typeof qrng.signatureValue === "string"
            ? qrng.signatureValue
            : typeof qrng.signature === "string"
              ? qrng.signature
              : null;

        if (signatureHex) {
          nistPulse.signature = hexToBytes(signatureHex);
        } else if (qrng.signatureValue instanceof Uint8Array) {
          nistPulse.signature = qrng.signatureValue;
        } else if (qrng.signature instanceof Uint8Array) {
          nistPulse.signature = qrng.signature;
        }
      }
    } catch (e) {
      log.warn("Failed to get NIST QRNG", e);
    }

    const seedBytes = new TextEncoder().encode(vrfSeed ?? `${this._gameId}:genesis`);
    const hashedSeed = await sha256(seedBytes);

    const gameIdBytes = new TextEncoder().encode(this._gameId ?? "unknown");
    const gameIdHash = await sha256(gameIdBytes);

    const genesisBuffer = new ArrayBuffer(ANCHOR.GENESIS_BASE_SIZE);
    const genesisView = new DataView(genesisBuffer);
    const genesisBytes = new Uint8Array(genesisBuffer);

    let offset = 0;
    genesisBytes[offset++] = ANCHOR.VERSION;
    genesisBytes[offset++] = ANCHOR.TYPE_GENESIS;
    genesisBytes.set(gameIdHash.slice(0, 32), offset);
    offset += 32;
    genesisBytes.set(hashedSeed.slice(0, 32), offset);
    offset += 32;

    for (let i = 0; i < ANCHOR.BTC_BLOCK_COUNT; i++) {
      const hash = btcBlockHashes[i] ?? new Uint8Array(32);
      genesisBytes.set(hash.slice(0, 32), offset);
      offset += 32;
    }

    const startDaa = BigInt(startDaaScore ?? 0);
    genesisView.setBigUint64(offset, startDaa, false);
    offset += 8;

    const endDaa = BigInt(endDaaScore ?? 0);
    genesisView.setBigUint64(offset, endDaa, false);
    offset += 8;

    genesisView.setBigUint64(offset, BigInt(nistPulse.pulseIndex), false);
    offset += 8;

    const outputHashPadded = new Uint8Array(64);
    outputHashPadded.set(nistPulse.outputHash.slice(0, 64), 0);
    genesisBytes.set(outputHashPadded, offset);
    offset += 64;

    const signaturePadded = new Uint8Array(512);
    signaturePadded.set(nistPulse.signature.slice(0, 512), 0);
    genesisBytes.set(signaturePadded, offset);
    offset += 512;

    const genesisHex = bytesToHex(genesisBytes);

    log.info("Genesis anchor built", {
      bytes: genesisBytes.length,
      btcBlocks: btcBlockHashes.length,
      nistPulseIndex: nistPulse.pulseIndex,
      hasSignature: nistPulse.signature.some((b) => b !== 0),
    });

    this._genesisEntropy = {
      gameIdHash,
      hashedSeed,
      btcBlockHashes,
      nistPulse,
      startDaaScore: Number(startDaa),
      endDaaScore: Number(endDaa),
      binaryAnchor: genesisBytes,
      anchorHex: genesisHex,
    };

    this._vrf?.setGenesisEntropy({ btcBlockHashes, nistPulse });

    const result = { success: false, txId: null, genesisData: this._genesisEntropy };
    const walletInfo = this._wallet?.getWalletInfo?.() ?? {};

    if (!walletInfo.degradedMode && walletInfo.utxoReady && walletInfo.address && walletInfo.privateKeys) {
      const maxAttempts = Number.isFinite(retryCount) ? Math.max(1, retryCount) : 5;
      const baseDelay = 1500;
      const sendTimeoutMs = 30000;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          log.info(`Sending genesis anchor (attempt ${attempt}/${maxAttempts})...`);

          if (attempt > 1) {
            const delay = Math.min(baseDelay * Math.pow(1.5, attempt - 1), 10000);
            await new Promise((r) => setTimeout(r, delay));
          }

          const message = this._buildAnchorPayload(BLOCKCHAIN.PREFIX_GAME_START_HEX, genesisHex);

          const sendPromise = this._kaspaLink.manualSend({
            fromAddress: walletInfo.address,
            toAddress: walletInfo.address,
            amount: BLOCKCHAIN.ANCHOR_AMOUNT,
            privateKeys: walletInfo.privateKeys,
            priorityFee: 0n,
            payload: message,
            janitorMode: false,
          });

          const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error("manualSend timeout after 30s")), sendTimeoutMs),
          );

          const sendResult = await Promise.race([sendPromise, timeoutPromise]);

          const txId = sendResult?.transactionId || sendResult?.txId;

          if (txId) {
            log.info("Genesis anchor sent successfully", { txId, attempt });

            this._genesisTxId = txId;
            this._lastAnchorTxId = txId;

            this._anchorChain.push({
              txId,
              type: "genesis",
              timestamp: Date.now(),
              moveCount: 0,
            });

            result.success = true;
            result.txId = txId;
            result.attempts = attempt;

            this._onEvent("genesisAnchored", {
              txId,
              genesisHex,
              sizeBytes: genesisBytes.length,
              btcBlocks: btcBlockHashes.length,
              nistPulseIndex: nistPulse.pulseIndex,
            });

            // Notify pool of successful TX for refresh
            this._wallet?.notifyTxResult?.(true);

            if (this._isActive) {
              this._heartbeatDisabled = false;
              this._startHeartbeatTimer();
            }

            break;
          }
          throw new Error("No transaction ID returned");
        } catch (e) {
          log.error(`Genesis anchor attempt ${attempt} failed`, e);
          this._wallet?.notifyTxResult?.(false);

          if (attempt === maxAttempts) {
            this._onEvent("genesisAnchorFailed", {
              error: e.message,
              attempts: attempt,
            });
          }
        }
      }
    } else {
      log.warn("Cannot send genesis anchor - degraded mode or no UTXOs ready");
      this._onEvent("genesisAnchorFailed", {
        error: "Degraded mode or UTXOs not ready",
        degradedMode: walletInfo.degradedMode,
        utxoReady: walletInfo.utxoReady,
      });
    }

    return result;
  }

  async sendHeartbeatAnchor(options = {}) {
    if (!this._isActive || this._heartbeatDisabled) return;

    const walletInfo = this._wallet?.getWalletInfo?.() ?? {};
    if (this._isSending || walletInfo.degradedMode || !walletInfo.utxoReady) return;
    if (!walletInfo.address || !walletInfo.privateKeys) return;

    const maxAttempts = Number.isFinite(options?.retryCount) ? Math.max(1, options.retryCount) : 1;
    const retryDelayMs = Number.isFinite(options?.retryDelayMs) ? Math.max(0, options.retryDelayMs) : 1000;

    if (!this._genesisTxId) {
      log.debug("Skipping heartbeat - genesis not yet anchored");
      return;
    }

    let lastError = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      this._isSending = true;

      try {
        const moveHistory = this._vault.getMoveHistory();
        const newMoves = moveHistory.slice(this._lastAnchoredMoveCount);
        const moveCount = Math.min(newMoves.length, ANCHOR.MAX_MOVES);

        const pending = this._vrf?.getPendingDeltas?.() ?? {};
        let deltaFlags = ANCHOR.DELTA_FLAG_NONE;
        if (pending.btc) deltaFlags |= ANCHOR.DELTA_FLAG_BTC;
        if (pending.nist) deltaFlags |= ANCHOR.DELTA_FLAG_NIST;

        // v5: compute variable-length moves section
        const actionMaps = this._packer?._actionToCode ?? ACTION_TO_CODE;
        let movesSectionLength = 0;
        for (let i = 0; i < moveCount; i++) {
          const ac = actionMaps[newMoves[i].action] ?? ACTION_CODE.NONE;
          movesSectionLength += movePacketSize(ac);
        }

        let totalSize = ANCHOR.HEARTBEAT_HEADER_SIZE + movesSectionLength;
        if (deltaFlags & ANCHOR.DELTA_FLAG_BTC) totalSize += ANCHOR.HEARTBEAT_DELTA_BTC_SIZE;
        if (deltaFlags & ANCHOR.DELTA_FLAG_NIST) totalSize += ANCHOR.HEARTBEAT_DELTA_NIST_SIZE;

        const heartbeatBuffer = new ArrayBuffer(totalSize);
        const heartbeatView = new DataView(heartbeatBuffer);
        const heartbeatBytes = new Uint8Array(heartbeatBuffer);

        let offset = 0;
        heartbeatBytes[offset++] = ANCHOR.VERSION;          // byte 0
        heartbeatBytes[offset++] = ANCHOR.TYPE_HEARTBEAT;   // byte 1

        const merkleRoot = this._packer.getMerkleRootBytes(this._merkleManager.getRoot());
        heartbeatBytes.set(merkleRoot, offset);
        offset += 32;                                        // bytes 2-33

        const prevTxIdBytes = this._packer.txIdToBytes(this._lastAnchorTxId);
        heartbeatBytes.set(prevTxIdBytes, offset);
        offset += 32;                                        // bytes 34-65

        heartbeatBytes[offset++] = deltaFlags;               // byte 66
        heartbeatBytes[offset++] = moveCount;                // byte 67

        // v5: movesSectionLength (uint16 BE) — bytes 68-69
        heartbeatBytes[offset++] = (movesSectionLength >> 8) & 0xff;
        heartbeatBytes[offset++] = movesSectionLength & 0xff;

        let prevTimestamp =
          moveHistory[this._lastAnchoredMoveCount - 1]?.timestamp ?? Date.now();

        for (let i = 0; i < moveCount; i++) {
          const move = newMoves[i];
          const actionCode = actionMaps[move.action] ?? ACTION_CODE.NONE;

          const deltaMs = Math.max(0, move.timestamp - prevTimestamp);
          const timeDelta = Math.min(255, Math.floor(deltaMs / ANCHOR.TIME_DELTA_SCALE));
          prevTimestamp = move.timestamp;

          if (actionCode === MOVE_ACTION_CODE) {
            // ── Extended 16-byte MOVE packet ──
            heartbeatBytes[offset++] = ((actionCode & 0x0f) << 4) | 0; // byte 0: action + flags
            heartbeatBytes[offset++] = timeDelta;                        // byte 1

            // Bytes 2-7: X, Y, Z (uint16 BE each, 14-bit signed)
            const xRaw = encodeCoord14(move.x);
            heartbeatBytes[offset++] = (xRaw >> 8) & 0xff;
            heartbeatBytes[offset++] = xRaw & 0xff;
            const yRaw = encodeCoord14(move.y);
            heartbeatBytes[offset++] = (yRaw >> 8) & 0xff;
            heartbeatBytes[offset++] = yRaw & 0xff;
            const zRaw = encodeCoord14(move.z);
            heartbeatBytes[offset++] = (zRaw >> 8) & 0xff;
            heartbeatBytes[offset++] = zRaw & 0xff;

            // Bytes 8-11: VRF fragment (4 bytes)
            if (move.vrfOutputBytes && move.vrfOutputBytes.length >= 4) {
              heartbeatBytes.set(move.vrfOutputBytes.slice(0, 4), offset);
            }
            offset += 4;

            // Bytes 12-13: value (coins / reserved)
            const coinsClamped = Math.min(Math.max(move.coinsTotal ?? 65535, 0), 65535);
            heartbeatBytes[offset++] = (coinsClamped >> 8) & 0xff;
            heartbeatBytes[offset++] = coinsClamped & 0xff;

            // Bytes 14-15: reserved
            heartbeatBytes[offset++] = 0;
            heartbeatBytes[offset++] = 0;
          } else {
            // ── Standard 8-byte packet ──
            const lane = move.lane ?? 0;
            heartbeatBytes[offset++] = ((actionCode & 0x0f) << 4) | (lane & 0x0f);
            heartbeatBytes[offset++] = timeDelta;

            if (move.vrfOutputBytes && move.vrfOutputBytes.length >= 4) {
              heartbeatBytes.set(move.vrfOutputBytes.slice(0, 4), offset);
            }
            offset += 4;

            // Bytes 6-7: value / subId
            const isGameEvent = move.isGameEvent === true || move.eventData != null;
            const coinsTotal = isGameEvent
              ? (move.eventData?.total ??
                move.eventData?.coinsRemaining ??
                move.coinsTotal ??
                move.coinsRemaining ??
                0)
              : (move.subId ?? 65535);
            const coinsClamped = Math.min(Math.max(coinsTotal ?? 0, 0), 65535);
            heartbeatBytes[offset++] = (coinsClamped >> 8) & 0xff;
            heartbeatBytes[offset++] = coinsClamped & 0xff;
          }
        }

        if (deltaFlags & ANCHOR.DELTA_FLAG_BTC) {
          heartbeatBytes.set(pending.btc.slice(0, 32), offset);
          offset += 32;
          log.info("Including BTC delta in heartbeat");
        }

        if (deltaFlags & ANCHOR.DELTA_FLAG_NIST) {
          heartbeatView.setBigUint64(offset, BigInt(pending.nist.pulseIndex), false);
          offset += 8;

          const outputHash = pending.nist.outputHash;
          if (typeof outputHash === "string") {
            const hashBytes = hexToBytes(outputHash);
            heartbeatBytes.set(hashBytes.slice(0, 64), offset);
          } else if (outputHash instanceof Uint8Array) {
            heartbeatBytes.set(outputHash.slice(0, 64), offset);
          }
          offset += 64;

          const signature = pending.nist.signature;
          if (typeof signature === "string") {
            const sigBytes = hexToBytes(signature);
            heartbeatBytes.set(sigBytes.slice(0, 512), offset);
          } else if (signature instanceof Uint8Array) {
            heartbeatBytes.set(signature.slice(0, 512), offset);
          }
          offset += 512;

          log.info("Including NIST delta in heartbeat", { pulseIndex: pending.nist.pulseIndex });
        }

        const heartbeatHex = bytesToHex(heartbeatBytes);
        const message = this._buildAnchorPayload(BLOCKCHAIN.PREFIX_HEARTBEAT_HEX, heartbeatHex);

        log.log("Sending v5 heartbeat anchor", {
          moveCount,
          deltaFlags,
          bytes: heartbeatBytes.length,
        });

        const result = await this._kaspaLink.manualSend({
          fromAddress: walletInfo.address,
          toAddress: walletInfo.address,
          amount: BLOCKCHAIN.ANCHOR_AMOUNT,
          privateKeys: walletInfo.privateKeys,
          priorityFee: 0n,
          payload: message,
        });

        const txId = result?.transactionId || result?.txId;

        if (txId) {
          this._lastAnchorTxId = txId;
          this._lastAnchorTime = Date.now();
          this._lastAnchoredMoveCount = moveHistory.length;
          this._consecutiveFailures = 0;

          this._vrf?.clearPendingDeltas?.();

          this._anchorChain.push({
            txId,
            type: "heartbeat",
            timestamp: Date.now(),
            moveCount,
            deltaFlags,
          });

          this._onEvent("heartbeatAnchored", {
            txId,
            moveCount,
            deltaFlags,
            prevTxId: prevTxIdBytes ? bytesToHex(prevTxIdBytes) : null,
          });
          this._onEvent("anchorSent", { txId, moveCount: moveHistory.length });

          // Notify pool of successful TX for refresh
          this._wallet?.notifyTxResult?.(true);

          log.log("V4 heartbeat anchor sent", { txId, moveCount, deltaFlags });
          return { success: true, txId, moveCount, deltaFlags, attempt };
        }

        throw new Error("No transaction ID returned");
      } catch (e) {
        this._consecutiveFailures++;
        this._anchorFailCount++;
        lastError = e?.message ?? String(e);

        // Notify pool of failed TX
        this._wallet?.notifyTxResult?.(false);

        log.warn("Heartbeat anchor failed", {
          error: e?.message,
          consecutiveFailures: this._consecutiveFailures,
          totalFailures: this._anchorFailCount,
        });

        if (this._consecutiveFailures >= 5) {
          log.error("Too many anchor failures, backing off for 1s");
          if (this._anchorTimerId) {
            clearInterval(this._anchorTimerId);
            this._anchorTimerId = null;
          }
          if (this._anchorBackoffTimeoutId) {
            clearTimeout(this._anchorBackoffTimeoutId);
          }
          this._anchorBackoffTimeoutId = setTimeout(() => {
            this._anchorBackoffTimeoutId = null;
            if (this._isActive && !this._heartbeatDisabled) {
              this._consecutiveFailures = 0;
              this._startHeartbeatTimer();
            }
          }, 500);
        }

        this._onEvent("anchorFailed", {
          error: lastError,
          failCount: this._anchorFailCount,
        });
        if (attempt < maxAttempts && retryDelayMs > 0) {
          await new Promise((r) => setTimeout(r, retryDelayMs));
        }
      } finally {
        this._isSending = false;
      }
    }

    return { success: false, error: lastError ?? "heartbeat_failed" };
  }

  async anchorFinalState(endState, options = {}) {
    if (!this._kaspaLink) {
      throw new Error("KaspaLink not set");
    }

    this._heartbeatDisabled = true;
    this._kaspaLink.setHeartbeatAnchorsEnabled?.(false);

    if (this._anchorTimerId) {
      clearInterval(this._anchorTimerId);
      this._anchorTimerId = null;
    }

    if (this._anchorBackoffTimeoutId) {
      clearTimeout(this._anchorBackoffTimeoutId);
      this._anchorBackoffTimeoutId = null;
    }

    this._wallet?.stopHeartbeat?.();

    if (this._isSending) {
      log.info("Waiting for pending heartbeat to complete...");
      await new Promise((r) => setTimeout(r, 2000));
    }

    const finalScore = endState?.score ?? 0;
    const coinsCollected = endState?.coins ?? endState?.coinsCollected ?? 0;
    const raceTimeMs = endState?.raceTimeMs ?? 0;
    const outcome = this._packer.mapOutcome(endState?.outcome ?? "complete");
    const totalMoves = Math.min(this._vault.getMoveCount(), 255);

    const finalBuffer = new ArrayBuffer(ANCHOR.FINAL_SIZE);
    const finalView = new DataView(finalBuffer);
    const finalBytes = new Uint8Array(finalBuffer);

    let offset = 0;
    finalBytes[offset++] = ANCHOR.VERSION;
    finalBytes[offset++] = ANCHOR.TYPE_FINAL;

    const merkleRootBytes = this._packer.getMerkleRootBytes(this._merkleManager.getRoot());
    finalBytes.set(merkleRootBytes, offset);
    offset += 32;

    const genesisTxIdBytes = this._packer.txIdToBytes(this._genesisTxId);
    finalBytes.set(genesisTxIdBytes, offset);
    offset += 32;

    const prevTxIdBytes = this._packer.txIdToBytes(this._lastAnchorTxId);
    finalBytes.set(prevTxIdBytes, offset);
    offset += 32;

    const resultString = `RESULT:${finalScore}:${coinsCollected}:${outcome}:${raceTimeMs}`;
    const resultBytes = new TextEncoder().encode(resultString);
    const resultLeafHash = await sha256(resultBytes);
    finalBytes.set(resultLeafHash, offset);
    offset += 32;

    finalView.setUint32(offset, finalScore >>> 0, false);
    offset += 4;
    finalView.setUint32(offset, coinsCollected >>> 0, false);
    offset += 4;
    finalView.setUint32(offset, raceTimeMs >>> 0, false);
    offset += 4;

    finalBytes[offset++] = outcome;
    finalBytes[offset++] = totalMoves;

    const anchorHex = bytesToHex(finalBytes);
    this._binaryAnchor = finalBytes;

    log.info("V4 Final anchor built", {
      bytes: finalBytes.length,
      score: finalScore,
      coins: coinsCollected,
      raceTimeMs,
      outcome,
      totalMoves,
      genesisTxId: this._genesisTxId?.substring(0, 16),
      prevTxId: this._lastAnchorTxId?.substring(0, 16),
    });

    this._onEvent("anchorBinaryReady", {
      binaryAnchor: this._binaryAnchor,
      anchorHex,
      sizeBytes: this._binaryAnchor.length,
      version: ANCHOR.VERSION,
    });

    const result = {
      success: false,
      txId: null,
      binaryAnchor: this._binaryAnchor,
      anchorHex,
      genesisTxId: this._genesisTxId,
      anchorChain: this._anchorChain,
    };

    const walletInfo = this._wallet?.getWalletInfo?.() ?? {};
    if (!walletInfo.degradedMode && walletInfo.utxoReady && walletInfo.address && walletInfo.privateKeys) {
      const maxAttempts = Number.isFinite(options?.retryCount) ? Math.max(1, options.retryCount) : 10;
      const baseDelay = 2000;
      let lastError = null;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          log.info(`Sending v4 final anchor (attempt ${attempt}/${maxAttempts})...`);

          if (attempt > 1) {
            const delay = Math.min(baseDelay * Math.pow(1.5, attempt - 1), 15000);
            log.info(`Waiting ${delay}ms for mempool to clear...`);
            await new Promise((r) => setTimeout(r, delay));
          }

          const message = this._buildAnchorPayload(BLOCKCHAIN.PREFIX_GAME_END_HEX, anchorHex);

          const sendResult = await this._kaspaLink.manualSend({
            fromAddress: walletInfo.address,
            toAddress: walletInfo.address,
            amount: BLOCKCHAIN.ANCHOR_AMOUNT,
            privateKeys: walletInfo.privateKeys,
            priorityFee: 0n,
            payload: message,
            janitorMode: false,
          });

          const txId = sendResult?.transactionId || sendResult?.txId;

          if (txId) {
            log.info("V4 Final anchor sent successfully", { txId, attempt });

            this._anchorChain.push({
              txId,
              type: "final",
              timestamp: Date.now(),
              score: finalScore,
              coins: coinsCollected,
              outcome,
            });

            result.success = true;
            result.txId = txId;
            result.attempts = attempt;
            result.anchorChain = this._anchorChain;

            this._onEvent("anchorComplete", {
              txId,
              anchorHex,
              sizeBytes: this._binaryAnchor.length,
              attempts: attempt,
              genesisTxId: this._genesisTxId,
              anchorChain: this._anchorChain,
            });

            // Notify pool of successful TX
            this._wallet?.notifyTxResult?.(true);

            break;
          }
          throw new Error("No transaction ID returned");
        } catch (e) {
          lastError = e?.message || String(e);
          log.warn(`Final anchor attempt ${attempt} failed: ${lastError}`);

          // Notify pool of failed TX
          this._wallet?.notifyTxResult?.(false);

          const isMempoolConflict =
            lastError.includes("already spent") ||
            lastError.includes("mempool") ||
            lastError.includes("double spend");

          const isFundsIssue = lastError.includes("insufficient") || lastError.includes("not enough");

          if (isFundsIssue) {
            log.error("Insufficient funds for final anchor");
            result.error = lastError;
            result.reason = "insufficient_funds";
            this._onEvent("anchorRetryNeeded", {
              error: lastError,
              reason: "insufficient_funds",
              binaryAnchor: this._binaryAnchor,
              anchorHex,
            });
            break;
          }

          if (!isMempoolConflict && attempt >= 3) {
            log.error("Final anchor failed with non-recoverable error");
            break;
          }
        }
      }

      if (!result.success && !result.reason) {
        log.error("Final anchor failed after all attempts", { attempts: maxAttempts, lastError });
        result.error = lastError;
        result.reason = "max_retries_exceeded";
        result.attempts = maxAttempts;

        this._onEvent("anchorRetryNeeded", {
          error: lastError,
          reason: "max_retries_exceeded",
          binaryAnchor: this._binaryAnchor,
          anchorHex,
        });
      }

      if (result.success) {
        let utxoCountBefore = null;
        try {
          const utxos = await this._kaspaLink.getUtxos(walletInfo.address);
          utxoCountBefore = Array.isArray(utxos) ? utxos.length : null;
        } catch (e) {
          log.warn("Failed to fetch UTXO count before consolidation", e);
        }

        const maxConsolidateAttempts = Number.isFinite(options?.consolidateRetryCount)
          ? Math.max(1, options.consolidateRetryCount)
          : 3;
        const consolidateDelayMs = Number.isFinite(options?.consolidateRetryDelayMs)
          ? Math.max(0, options.consolidateRetryDelayMs)
          : 500;

        for (let attempt = 1; attempt <= maxConsolidateAttempts; attempt++) {
          try {
            if (attempt > 1 && consolidateDelayMs > 0) {
              await new Promise((r) => setTimeout(r, consolidateDelayMs));
            }

            log.info("Consolidating UTXOs...", { attempt, maxConsolidateAttempts });
            await this._kaspaLink.consolidateUtxos({
              address: walletInfo.address,
              privateKeys: walletInfo.privateKeys,
              targetCount: 1,
              priorityFee: 0n,
            });

            let utxoCountAfter = null;
            try {
              const utxos = await this._kaspaLink.getUtxos(walletInfo.address);
              utxoCountAfter = Array.isArray(utxos) ? utxos.length : null;
            } catch (e) {
              log.warn("Failed to fetch UTXO count after consolidation", e);
            }

            const consolidatedCount =
              Number.isFinite(utxoCountBefore) && Number.isFinite(utxoCountAfter)
                ? Math.max(0, utxoCountBefore - utxoCountAfter)
                : null;

            log.info("UTXOs consolidated", {
              targetCount: 1,
              utxoCountBefore,
              utxoCountAfter,
              consolidatedCount,
            });
            break;
          } catch (e) {
            const message = e?.message ?? String(e);
            const isMempoolConflict =
              message.includes("already spent") || message.includes("mempool") || message.includes("double spend");

            if (attempt >= maxConsolidateAttempts || !isMempoolConflict) {
              log.warn("Failed to consolidate UTXOs", e);
              break;
            }

            log.warn("Consolidate UTXOs failed (mempool), retrying...", {
              attempt,
              maxConsolidateAttempts,
            });
          }
        }
      }
    } else {
      log.warn("Skipping blockchain anchor - degraded mode or UTXOs not ready");
      result.skipped = true;
    }

    return result;
  }

  async retryFinalAnchor() {
    if (!this._binaryAnchor) {
      return { success: false, error: "No binary anchor to retry" };
    }

    const walletInfo = this._wallet?.getWalletInfo?.() ?? {};
    if (!this._kaspaLink || !walletInfo.address || !walletInfo.privateKeys) {
      return { success: false, error: "Wallet not available" };
    }

    const anchorHex = bytesToHex(this._binaryAnchor);

    log.info("Retrying final anchor (user-initiated)...");

    try {
      await new Promise((r) => setTimeout(r, 3000));

      const message = this._buildAnchorPayload(BLOCKCHAIN.PREFIX_GAME_END_HEX, anchorHex);

      const sendResult = await this._kaspaLink.manualSend({
        fromAddress: walletInfo.address,
        toAddress: walletInfo.address,
        amount: BLOCKCHAIN.ANCHOR_AMOUNT,
        privateKeys: walletInfo.privateKeys,
        priorityFee: 0n,
        payload: message,
        janitorMode: false,
      });

      const txId = sendResult?.transactionId || sendResult?.txId;

      if (txId) {
        log.info("Final anchor retry succeeded", { txId });

        this._onEvent("anchorComplete", {
          txId,
          anchorHex,
          sizeBytes: this._binaryAnchor.length,
          isRetry: true,
        });

        return { success: true, txId };
      }
      throw new Error("No transaction ID returned");
    } catch (e) {
      const error = e?.message || String(e);
      log.error("Final anchor retry failed", error);
      return { success: false, error };
    }
  }
}

export default AnchorStrategy;
