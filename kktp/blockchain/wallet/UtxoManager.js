/**
 * UtxoManager.js - Event-driven UTXO management with pre-split pool
 *
 * Key design principles:
 * - ZERO network fetches during prepareForGame() - instant check
 * - Pool is populated during lobby join (before game start)
 * - Degraded mode only when pool is truly empty
 * - Wallet events add new UTXOs to pool automatically
 */

import { Logger, LogModule } from "../../core/logger.js";
import { BLOCKCHAIN } from "../../core/constants.js";
import { UtxoPool, PoolEvent } from "./UtxoPool.js";

const log = Logger.create(LogModule.anchor.utxoManager);

export class UtxoManager {
  constructor({ kaspaLink, onEvent } = {}) {
    this._kaspaLink = kaspaLink ?? null;
    this._onEvent = typeof onEvent === "function" ? onEvent : () => {};

    this._address = null;
    this._privateKeys = null;

    // Pool-based state (replaces balance-based checks)
    this._pool = new UtxoPool({
      minPoolSize: BLOCKCHAIN.UTXO_SPLIT_COUNT,
      lowThreshold: BLOCKCHAIN.UTXO_LOW_THRESHOLD ?? 3,
      onEvent: (event, data) => this._handlePoolEvent(event, data),
    });

    this._poolReady = false;
    this._splitInProgress = false;
    this._balanceKas = 0;
    this._backgroundHeartbeatActive = false;
  }

  setKaspaLink(kaspaLink) {
    this._kaspaLink = kaspaLink;
  }

  // ─────────────────────────────────────────────────────────────
  // Public Getters
  // ─────────────────────────────────────────────────────────────

  get isDegradedMode() {
    return this._pool.isDegraded;
  }

  get isUtxoReady() {
    return this._pool.isReady;
  }

  get balanceKas() {
    return this._balanceKas;
  }

  get runwayMoves() {
    // Runway = available UTXOs (each can send ~1 anchor)
    return this._pool.availableCount;
  }

  /**
   * Get pool reference for direct access (AnchorStrategy uses this)
   */
  get pool() {
    return this._pool;
  }

  getWalletInfo() {
    const status = this._pool.getStatus();
    return {
      address: this._address,
      privateKeys: this._privateKeys,
      utxoReady: status.isReady,
      degradedMode: status.isDegraded,
      balanceKas: this._balanceKas,
      runwayMoves: status.available,
      poolStatus: status,
    };
  }

  getPoolStatus() {
    return this._pool.getStatus();
  }

  // ─────────────────────────────────────────────────────────────
  // Lobby Phase: Ensure Pool Ready (Async, Called During Lobby Join)
  // ─────────────────────────────────────────────────────────────

  /**
   * Ensure UTXO pool is ready for gameplay.
   * Called during lobby join/create - has time to complete before game starts.
   * This is the ONLY place that fetches from network.
   *
   * @param {Object} options
   * @param {boolean} [options.skipIfReady=true] - Skip split if pool already has UTXOs
   * @returns {Promise<{success: boolean, poolStatus: Object}>}
   */
  async ensurePoolReady(options = {}) {
    const { skipIfReady = true } = options;

    if (!this._kaspaLink) {
      throw new Error("KaspaLink not set");
    }

    await this._ensureCredentials({ requirePrivateKeys: true });

    // If pool already has UTXOs, we're good
    if (skipIfReady && this._pool.availableCount >= BLOCKCHAIN.UTXO_SPLIT_COUNT) {
      log.info("Pool already ready", { available: this._pool.availableCount });
      this._poolReady = true;
      return { success: true, poolStatus: this._pool.getStatus() };
    }

    // Fetch current UTXOs and populate pool
    try {
      const utxos = await this._kaspaLink.getUtxos(this._address);
      const usableUtxos = this._filterUsableUtxos(utxos);

      if (usableUtxos.length > 0) {
        const added = this._pool.addBatch(usableUtxos);
        log.info("Existing UTXOs added to pool", { found: usableUtxos.length, added });
      }

      // If we have enough UTXOs, no need to split
      if (this._pool.availableCount >= BLOCKCHAIN.UTXO_SPLIT_COUNT) {
        log.info("Pool ready from existing UTXOs", { available: this._pool.availableCount });
        this._poolReady = true;
        this._onEvent("gameReady", { poolStatus: this._pool.getStatus() });
        return { success: true, poolStatus: this._pool.getStatus() };
      }

      // Need to split - do it now during lobby phase
      return await this._splitUtxosIntoPool();
    } catch (e) {
      log.error("Failed to ensure pool ready", e);
      return { success: false, poolStatus: this._pool.getStatus(), error: e.message };
    }
  }

  /**
   * Split UTXOs and add to pool
   * @private
   */
  async _splitUtxosIntoPool() {
    if (this._splitInProgress) {
      log.debug("Split already in progress, waiting...");
      // Wait for existing split to complete
      await new Promise((r) => setTimeout(r, 100));
      return { success: this._pool.isReady, poolStatus: this._pool.getStatus() };
    }

    this._splitInProgress = true;

    try {
      log.info("Splitting UTXOs into pool...", { target: BLOCKCHAIN.UTXO_SPLIT_COUNT });

      await this._kaspaLink.splitUtxos({
        address: this._address,
        splitCount: BLOCKCHAIN.UTXO_SPLIT_COUNT,
        privateKeys: this._privateKeys,
        priorityFee: 0n,
      });

      log.info("UTXO split complete, fetching new UTXOs...");

      // Fetch the newly created UTXOs
      const utxos = await this._kaspaLink.getUtxos(this._address);
      const usableUtxos = this._filterUsableUtxos(utxos);
      const added = this._pool.addBatch(usableUtxos);

      log.info("Split UTXOs added to pool", { added, available: this._pool.availableCount });

      this._poolReady = this._pool.isReady;

      if (this._poolReady) {
        this._onEvent("gameReady", { poolStatus: this._pool.getStatus() });
      }

      return { success: this._poolReady, poolStatus: this._pool.getStatus() };
    } catch (e) {
      log.error("UTXO split failed", e);
      return { success: false, poolStatus: this._pool.getStatus(), error: e.message };
    } finally {
      this._splitInProgress = false;
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Game Phase: Instant Check (No Network Calls)
  // ─────────────────────────────────────────────────────────────

  /**
   * Prepare for game - INSTANT, no network calls.
   * Pool should already be populated from ensurePoolReady() during lobby.
   *
   * @returns {boolean} True if ready to play
   */
  async prepareForGame() {
    log.info("Preparing UTXOs for game...");

    const status = this._pool.getStatus();

    // Instant check - no network calls
    if (status.available > 0) {
      log.info("UTXOs ready (instant)", { available: status.available });
      this._onEvent("utxoReady", { poolStatus: status });
      return true;
    }

    // Pool empty - try quick recovery from wallet
    // This is a fallback; normally pool should be populated during lobby
    log.warn("Pool empty at game start, attempting recovery...");

    if (this._address) {
      try {
        const utxos = await this._kaspaLink.getUtxos(this._address);
        const usableUtxos = this._filterUsableUtxos(utxos);
        if (usableUtxos.length > 0) {
          this._pool.addBatch(usableUtxos);
          log.info("Recovered UTXOs to pool", { added: usableUtxos.length });
        }
      } catch (e) {
        log.warn("UTXO recovery failed", e.message);
      }
    }

    const finalStatus = this._pool.getStatus();
    if (finalStatus.available > 0) {
      this._onEvent("utxoReady", { poolStatus: finalStatus });
      return true;
    }

    // Truly degraded - no UTXOs available
    log.warn("Entering degraded mode - no UTXOs in pool");
    this._onEvent("lowFundsWarning", {
      message: "No UTXOs available - moves will not be anchored",
      poolStatus: finalStatus,
    });

    // Start background replenishment
    this._startBackgroundReplenishment();

    return false;
  }

  // ─────────────────────────────────────────────────────────────
  // Pool Operations (Called by AnchorStrategy)
  // ─────────────────────────────────────────────────────────────

  /**
   * Reserve a UTXO for sending (instant, from pool)
   * @returns {{entry: Object, outpoint: string}|null}
   */
  reserveUtxo() {
    return this._pool.reserve();
  }

  /**
   * Release a reserved UTXO (TX failed)
   * @param {string} outpoint
   */
  releaseUtxo(outpoint) {
    return this._pool.release(outpoint);
  }

  /**
   * Mark a UTXO as spent (TX confirmed)
   * @param {string} outpoint
   */
  markUtxoSpent(outpoint) {
    return this._pool.markSpent(outpoint);
  }

  /**
   * Add UTXO to pool (new change output detected)
   * @param {Object} entry
   */
  addUtxoToPool(entry) {
    return this._pool.add(entry);
  }

  /**
   * Refresh pool from current wallet UTXOs.
   * Call after TX sends to sync pool with actual wallet state.
   * Does NOT trigger replenishment - just updates pool view.
   */
  async refreshPool() {
    if (!this._kaspaLink || !this._address) return;

    try {
      const utxos = await this._kaspaLink.getUtxos(this._address);
      const usableUtxos = this._filterUsableUtxos(utxos);

      // Clear stale entries and re-add current UTXOs
      this._pool.pruneSpent();
      this._pool.releaseStaleReservations(10000); // 10s stale threshold

      // Add any new UTXOs
      this._pool.addBatch(usableUtxos);

      log.debug("Pool refreshed", { available: this._pool.availableCount });
    } catch (e) {
      log.warn("Pool refresh failed", e.message);
    }
  }

  /**
   * Notify pool that a TX was attempted.
   * On success, schedules a refresh to pick up change output.
   * On failure, does nothing (UTXO still available).
   * @param {boolean} success
   */
  notifyTxResult(success) {
    if (success) {
      // Refresh pool after a short delay to allow change output to appear
      setTimeout(() => this.refreshPool(), 200);
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Background Replenishment (Only When Pool Low/Empty)
  // ─────────────────────────────────────────────────────────────

  _startBackgroundReplenishment() {
    if (this._backgroundHeartbeatActive) return;
    if (!this._kaspaLink) return;

    this._ensureCredentials({ requirePrivateKeys: true })
      .then((ready) => {
        if (!ready) {
          log.warn("Cannot start background replenishment - missing credentials");
          return;
        }

        this._backgroundHeartbeatActive = true;

        log.info("Starting background UTXO replenishment");

        this._kaspaLink.startHeartbeat({
          address: this._address,
          privateKeys: this._privateKeys,
          intervalMs: BLOCKCHAIN.UTXO_HEARTBEAT_MS || 2000,
          targetUtxoCount: BLOCKCHAIN.UTXO_SPLIT_COUNT,
          splitCount: BLOCKCHAIN.UTXO_SPLIT_COUNT,
          priorityFee: 0n,
          usableThreshold: BigInt(Math.floor((BLOCKCHAIN.UTXO_USABLE_THRESHOLD_KAS || 0.5) * 100000000)),
          firstCheckDelayMs: 0,
          onCheck: ({ totalBalance }) => {
            this._balanceKas = Number(totalBalance) / 100000000;
          },
          onSplit: async () => {
            // Fetch new UTXOs and add to pool
            try {
              const utxos = await this._kaspaLink.getUtxos(this._address);
              const usableUtxos = this._filterUsableUtxos(utxos);
              this._pool.addBatch(usableUtxos);
              log.info("Heartbeat split complete, pool updated", { available: this._pool.availableCount });

              // Stop heartbeat if pool is healthy
              if (this._pool.availableCount >= BLOCKCHAIN.UTXO_SPLIT_COUNT) {
                this.stopHeartbeat();
              }
            } catch (e) {
              log.warn("Failed to update pool after split", e.message);
            }
          },
          onError: ({ type, error }) => {
            log.warn("Background replenishment error", { type, error: error?.message });
          },
        });
      })
      .catch((e) => {
        log.warn("Background replenishment setup failed", e.message);
      });
  }

  stopHeartbeat() {
    if (!this._kaspaLink) return;
    try {
      this._kaspaLink.stopHeartbeat();
      this._backgroundHeartbeatActive = false;
    } catch (e) {
      log.warn("Failed to stop heartbeat", e);
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Pool Event Handler
  // ─────────────────────────────────────────────────────────────

  _handlePoolEvent(event, data) {
    switch (event) {
      case PoolEvent.POOL_READY:
        this._poolReady = true;
        this._onEvent("gameReady", { poolStatus: this._pool.getStatus() });
        break;

      case PoolEvent.POOL_LOW:
        this._onEvent("poolLow", data);
        // Start background replenishment if not already running
        if (!this._backgroundHeartbeatActive) {
          this._startBackgroundReplenishment();
        }
        break;

      case PoolEvent.POOL_EMPTY:
        this._onEvent("poolEmpty", data);
        this._onEvent("lowFundsWarning", {
          message: "UTXO pool empty",
          poolStatus: this._pool.getStatus(),
        });
        break;

      default:
        // Forward other events
        this._onEvent(event, data);
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────

  /**
   * Filter UTXOs that are large enough for anchor operations
   * @private
   */
  _filterUsableUtxos(utxos) {
    const minAmount = BigInt(Math.floor((BLOCKCHAIN.UTXO_USABLE_THRESHOLD_KAS || 0.5) * 100000000));
    const entries = Array.isArray(utxos) ? utxos : utxos?.entries || [];

    return entries.filter((entry) => {
      const amount = this._getEntryAmount(entry);
      return amount >= minAmount;
    });
  }

  _getEntryAmount(entry) {
    // Handle various UTXO entry formats
    try {
      if (entry?.entry?.amount !== undefined) {
        return BigInt(entry.entry.amount);
      }
      if (entry?.amount !== undefined) {
        return BigInt(entry.amount);
      }
      // WASM format
      if (typeof entry?.getEntry === "function") {
        return BigInt(entry.getEntry().amount);
      }
    } catch {
      // Ignore
    }
    return 0n;
  }

  async _ensureCredentials({ requirePrivateKeys = false } = {}) {
    if (!this._kaspaLink) {
      throw new Error("KaspaLink not set");
    }

    if (!this._address) {
      this._address = this._kaspaLink.address;
      if (!this._address) {
        throw new Error("No wallet address available");
      }
    }

    if (requirePrivateKeys && !this._privateKeys) {
      log.debug("Fetching private keys...");
      this._privateKeys = await this._kaspaLink.getPrivateKeys({
        keyCount: BLOCKCHAIN.UTXO_KEY_COUNT,
      });

      if (!this._privateKeys?.length) {
        throw new Error("Failed to get private keys from wallet");
      }

      log.info("Private keys obtained", { count: this._privateKeys.length });
    }

    this._pool.setCredentials({
      address: this._address,
      privateKeys: this._privateKeys,
    });

    return true;
  }

  /**
   * Cleanup for game end
   */
  cleanup() {
    this.stopHeartbeat();
    this._pool.pruneSpent();
    this._pool.releaseStaleReservations();
  }

  /**
   * Full reset
   */
  reset() {
    this.stopHeartbeat();
    this._pool.clear();
    this._poolReady = false;
    this._splitInProgress = false;
  }
}

export default UtxoManager;
