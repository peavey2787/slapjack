/**
 * UtxoPool.js - Event-driven UTXO pool for zero-delay game start
 *
 * Single responsibility: track a pool of pre-split UTXOs in memory.
 * No network fetches during getAvailable() - pure in-memory lookup.
 *
 * States:
 * - available: UTXO ready to use
 * - reserved: UTXO claimed for a pending TX
 * - spent: TX confirmed, UTXO consumed
 *
 * @module kktp/blockchain/wallet/UtxoPool
 */

import { Logger, LogModule } from "../../core/logger.js";
import { BLOCKCHAIN } from "../../core/constants.js";

const log = Logger.create(LogModule.anchor.utxoPool);

/**
 * Entry states
 */
const UtxoState = {
  AVAILABLE: "available",
  RESERVED: "reserved",
  SPENT: "spent",
};

/**
 * Pool events
 */
export const PoolEvent = {
  POOL_READY: "poolReady",
  POOL_LOW: "poolLow",
  POOL_EMPTY: "poolEmpty",
  UTXO_RESERVED: "utxoReserved",
  UTXO_RELEASED: "utxoReleased",
  UTXO_SPENT: "utxoSpent",
  UTXO_ADDED: "utxoAdded",
};

export class UtxoPool {
  constructor({ minPoolSize = BLOCKCHAIN.UTXO_SPLIT_COUNT, lowThreshold = 3, onEvent } = {}) {
    /** @type {Map<string, {entry: Object, state: string, reservedAt: number|null}>} */
    this._pool = new Map();
    this._minPoolSize = minPoolSize;
    this._lowThreshold = lowThreshold;
    this._onEvent = typeof onEvent === "function" ? onEvent : () => {};
    this._privateKeys = null;
    this._address = null;
  }

  // ─────────────────────────────────────────────────────────────
  // Configuration
  // ─────────────────────────────────────────────────────────────

  /**
   * Store wallet credentials for pool operations
   */
  setCredentials({ address, privateKeys }) {
    this._address = address;
    this._privateKeys = privateKeys;
  }

  get address() {
    return this._address;
  }

  get privateKeys() {
    return this._privateKeys;
  }

  // ─────────────────────────────────────────────────────────────
  // Pool State
  // ─────────────────────────────────────────────────────────────

  /**
   * Count of available (not reserved/spent) UTXOs
   */
  get availableCount() {
    let count = 0;
    for (const item of this._pool.values()) {
      if (item.state === UtxoState.AVAILABLE) count++;
    }
    return count;
  }

  /**
   * Total pool size (all states)
   */
  get poolSize() {
    return this._pool.size;
  }

  /**
   * Check if pool is ready for gameplay
   */
  get isReady() {
    return this.availableCount >= 1;
  }

  /**
   * Check if pool is in degraded state (empty)
   */
  get isDegraded() {
    return this.availableCount === 0;
  }

  /**
   * Check if pool is running low
   */
  get isLow() {
    return this.availableCount <= this._lowThreshold && this.availableCount > 0;
  }

  /**
   * Get pool status for external consumers
   */
  getStatus() {
    return {
      available: this.availableCount,
      reserved: this._countByState(UtxoState.RESERVED),
      spent: this._countByState(UtxoState.SPENT),
      total: this._pool.size,
      isReady: this.isReady,
      isDegraded: this.isDegraded,
      isLow: this.isLow,
      minPoolSize: this._minPoolSize,
      lowThreshold: this._lowThreshold,
    };
  }

  _countByState(state) {
    let count = 0;
    for (const item of this._pool.values()) {
      if (item.state === state) count++;
    }
    return count;
  }

  // ─────────────────────────────────────────────────────────────
  // Pool Operations (No Network Calls)
  // ─────────────────────────────────────────────────────────────

  /**
   * Add a UTXO to the pool (called when split confirms or new UTXO detected)
   * @param {Object} entry - UTXO entry object
   * @returns {boolean} True if added (not duplicate)
   */
  add(entry) {
    const outpoint = this._getOutpoint(entry);
    if (!outpoint) {
      log.warn("Cannot add UTXO - missing outpoint", entry);
      return false;
    }

    if (this._pool.has(outpoint)) {
      return false; // Already tracked
    }

    this._pool.set(outpoint, {
      entry,
      state: UtxoState.AVAILABLE,
      reservedAt: null,
    });

    log.debug("UTXO added to pool", { outpoint, available: this.availableCount });
    this._onEvent(PoolEvent.UTXO_ADDED, { outpoint, available: this.availableCount });
    this._checkPoolState();
    return true;
  }

  /**
   * Add multiple UTXOs to the pool
   * @param {Array} entries - Array of UTXO entries
   * @returns {number} Count of newly added UTXOs
   */
  addBatch(entries) {
    let added = 0;
    for (const entry of entries || []) {
      if (this.add(entry)) added++;
    }
    return added;
  }

  /**
   * Reserve a UTXO for a pending transaction (instant, no network)
   * @returns {{entry: Object, outpoint: string}|null} Reserved UTXO or null if none available
   */
  reserve() {
    for (const [outpoint, item] of this._pool.entries()) {
      if (item.state === UtxoState.AVAILABLE) {
        item.state = UtxoState.RESERVED;
        item.reservedAt = Date.now();

        log.debug("UTXO reserved", { outpoint, remaining: this.availableCount });
        this._onEvent(PoolEvent.UTXO_RESERVED, { outpoint, remaining: this.availableCount });
        this._checkPoolState();

        return { entry: item.entry, outpoint };
      }
    }

    log.warn("No available UTXOs to reserve");
    this._onEvent(PoolEvent.POOL_EMPTY, { available: 0 });
    return null;
  }

  /**
   * Release a reserved UTXO back to available (TX failed)
   * @param {string} outpoint
   * @returns {boolean} True if released
   */
  release(outpoint) {
    const item = this._pool.get(outpoint);
    if (!item) return false;

    if (item.state === UtxoState.RESERVED) {
      item.state = UtxoState.AVAILABLE;
      item.reservedAt = null;

      log.debug("UTXO released", { outpoint, available: this.availableCount });
      this._onEvent(PoolEvent.UTXO_RELEASED, { outpoint, available: this.availableCount });
      return true;
    }
    return false;
  }

  /**
   * Mark a UTXO as spent (TX confirmed)
   * @param {string} outpoint
   * @returns {boolean} True if marked spent
   */
  markSpent(outpoint) {
    const item = this._pool.get(outpoint);
    if (!item) return false;

    item.state = UtxoState.SPENT;
    item.reservedAt = null;

    log.debug("UTXO marked spent", { outpoint, available: this.availableCount });
    this._onEvent(PoolEvent.UTXO_SPENT, { outpoint, available: this.availableCount });
    this._checkPoolState();
    return true;
  }

  /**
   * Remove spent UTXOs from the pool (cleanup)
   * @returns {number} Count of removed UTXOs
   */
  pruneSpent() {
    let pruned = 0;
    for (const [outpoint, item] of this._pool.entries()) {
      if (item.state === UtxoState.SPENT) {
        this._pool.delete(outpoint);
        pruned++;
      }
    }
    if (pruned > 0) {
      log.debug("Pruned spent UTXOs", { pruned, remaining: this._pool.size });
    }
    return pruned;
  }

  /**
   * Get all available UTXOs (for operations that need multiple)
   * @returns {Array<{entry: Object, outpoint: string}>}
   */
  getAvailable() {
    const available = [];
    for (const [outpoint, item] of this._pool.entries()) {
      if (item.state === UtxoState.AVAILABLE) {
        available.push({ entry: item.entry, outpoint });
      }
    }
    return available;
  }

  /**
   * Reset the pool (game end cleanup)
   */
  clear() {
    this._pool.clear();
    log.debug("Pool cleared");
  }

  /**
   * Release all reserved UTXOs that are stale (> 30s)
   * Called periodically to recover from failed TXs that didn't release
   */
  releaseStaleReservations(maxAgeMs = 30000) {
    const now = Date.now();
    let released = 0;

    for (const [outpoint, item] of this._pool.entries()) {
      if (item.state === UtxoState.RESERVED && item.reservedAt) {
        if (now - item.reservedAt > maxAgeMs) {
          item.state = UtxoState.AVAILABLE;
          item.reservedAt = null;
          released++;
          log.warn("Released stale reservation", { outpoint, ageMs: now - item.reservedAt });
        }
      }
    }

    return released;
  }

  // ─────────────────────────────────────────────────────────────
  // Internal Helpers
  // ─────────────────────────────────────────────────────────────

  _getOutpoint(entry) {
    // Handle various UTXO entry formats
    const outpoint = entry?.outpoint || entry?.entry?.outpoint;
    if (!outpoint) return null;

    const txId = outpoint.transactionId || outpoint.txId || outpoint.transaction_id;
    const index = outpoint.index ?? outpoint.outputIndex ?? 0;

    if (!txId) return null;
    return `${txId}:${index}`;
  }

  _checkPoolState() {
    const available = this.availableCount;

    if (available === 0) {
      this._onEvent(PoolEvent.POOL_EMPTY, { available: 0 });
    } else if (available <= this._lowThreshold) {
      this._onEvent(PoolEvent.POOL_LOW, { available, threshold: this._lowThreshold });
    } else if (available >= this._minPoolSize) {
      this._onEvent(PoolEvent.POOL_READY, { available });
    }
  }
}

export default UtxoPool;
