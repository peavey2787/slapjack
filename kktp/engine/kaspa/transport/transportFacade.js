/**
 * TransportFacade: Thin wrapper for transport operations.
 * Delegates to specialized modules for business logic.
 */

import { connect } from "./kaspa_client.js";
import * as txBuilder from "./tx_builder.js";
import * as utxoManager from "./utxo_manager.js";
import * as utxoOps from "./utxo_operations.js";
import { runRpcCommand } from "./rpc_runner.js";
import { HeartbeatMonitor } from "./heartbeat.js";

export class TransportFacade {
  constructor() {
    this.client = null;
    this.networkId = null;
    this._utxoCache = new Map();
    this._utxoCacheTtlMs = 500;
    this._spentUtxos = new Set();
    this._heartbeat = new HeartbeatMonitor(this);
  }

  // ─────────────────────────────────────────────────────────────
  // Connection
  // ─────────────────────────────────────────────────────────────

  async connect(options = {}) {
    const { rpcUrl, networkId = "testnet-10", onDisconnect } = options || {};
    this.client = await connect({ rpcUrl, networkId, onDisconnect });
    this.networkId = networkId;
    return this.client;
  }

  async disconnect() {
    this._heartbeat.stop();
    if (this.client) {
      await this.client.disconnect();
      this.client = null;
    }
    this._utxoCache.clear();
    this._spentUtxos.clear();
  }

  get isConnected() {
    return !!(this.client && this.client.isConnected);
  }

  // ─────────────────────────────────────────────────────────────
  // UTXO Cache & Tracking
  // ─────────────────────────────────────────────────────────────

  async getUtxos(address, { useCache = false, excludeSpent = true } = {}) {
    this._checkConnected();

    if (useCache) {
      const cached = this._utxoCache.get(address);
      if (cached && Date.now() - cached.timestamp < this._utxoCacheTtlMs) {
        return excludeSpent ? this._filterSpentUtxos(cached.entries) : cached.entries;
      }
    }

    const entries = await utxoManager.getUtxosByAddress(this.client, address);
    this._utxoCache.set(address, { entries, timestamp: Date.now() });

    return excludeSpent ? this._filterSpentUtxos(entries) : entries;
  }

  /**
   * Fetch UTXOs for multiple addresses (e.g., receive + change).
   * Results are deduplicated and cached per-address.
   * @param {string[]} addresses - Array of addresses to query
   * @param {Object} [options] - { useCache, excludeSpent }
   * @returns {Promise<Array>} Deduplicated UTXO entries
   */
  async getUtxosForAddresses(addresses, { useCache = false, excludeSpent = true } = {}) {
    this._checkConnected();

    const validAddresses = (addresses || [])
      .filter(a => a != null && a !== '')
      .map(a => String(a));

    if (validAddresses.length === 0) {
      return [];
    }

    // For single address, use existing method
    if (validAddresses.length === 1) {
      return this.getUtxos(validAddresses[0], { useCache, excludeSpent });
    }

    // Check cache for all addresses
    if (useCache) {
      const now = Date.now();
      const allCached = validAddresses.every(addr => {
        const cached = this._utxoCache.get(addr);
        return cached && now - cached.timestamp < this._utxoCacheTtlMs;
      });

      if (allCached) {
        // Merge and deduplicate from cache
        const allEntries = [];
        const seen = new Set();
        for (const addr of validAddresses) {
          const cached = this._utxoCache.get(addr);
          for (const entry of cached.entries) {
            const key = utxoManager.getEntryKey(entry);
            if (!seen.has(key)) {
              seen.add(key);
              allEntries.push(entry);
            }
          }
        }
        return excludeSpent ? this._filterSpentUtxos(allEntries) : allEntries;
      }
    }

    // Fetch from RPC (single call with all addresses)
    const entries = await utxoManager.getUtxosByAddresses(this.client, validAddresses);

    // Update cache per-address (group entries by address for caching)
    const now = Date.now();
    // For multi-address fetch, we cache the combined result under a composite key
    // and also invalidate per-address caches since we have fresh data
    const compositeKey = validAddresses.sort().join('|');
    this._utxoCache.set(compositeKey, { entries, timestamp: now });

    // Clear individual address caches to prevent stale data
    for (const addr of validAddresses) {
      this._utxoCache.delete(addr);
    }

    return excludeSpent ? this._filterSpentUtxos(entries) : entries;
  }

  _filterSpentUtxos(entries) {
    return entries.filter((e) => !this._spentUtxos.has(utxoManager.getEntryKey(e)));
  }

  markUtxosAsSpent(entries) {
    for (const e of entries || []) {
      this._spentUtxos.add(utxoManager.getEntryKey(e));
    }
  }

  clearSpentUtxos(entries) {
    if (entries) {
      for (const e of entries) {
        this._spentUtxos.delete(utxoManager.getEntryKey(e));
      }
    } else {
      this._spentUtxos.clear();
    }
  }

  invalidateUtxoCache(address) {
    if (!address) {
      this._utxoCache.clear();
    } else if (Array.isArray(address)) {
      for (const addr of address) {
        this._utxoCache.delete(String(addr));
      }
      // Also invalidate any composite keys containing these addresses
      for (const key of this._utxoCache.keys()) {
        if (key.includes('|') && address.some(a => key.includes(String(a)))) {
          this._utxoCache.delete(key);
        }
      }
    } else {
      this._utxoCache.delete(String(address));
      // Also invalidate any composite keys containing this address
      for (const key of this._utxoCache.keys()) {
        if (key.includes('|') && key.includes(String(address))) {
          this._utxoCache.delete(key);
        }
      }
    }
  }

  // ─────────────────────────────────────────────────────────────
  // UTXO Manager Proxies
  // ─────────────────────────────────────────────────────────────

  async getAccountUtxos(accountDescriptor) {
    this._checkConnected();
    return utxoManager.getAccountUtxos({ wallet: { rpc: this.client }, accountDescriptor });
  }

  selectUtxosLargestFirst(entries, options) {
    return utxoManager.selectUtxosLargestFirst(entries, options);
  }

  selectUtxoForEngine(entries, engineIndex, totalEngines, minAmount) {
    return utxoManager.selectUtxoForEngine(entries, engineIndex, totalEngines, minAmount);
  }

  calculateTotalBalance(entries) {
    return utxoManager.calculateTotalBalance(entries);
  }

  categorizeUtxos(entries) {
    return utxoManager.categorizeUtxos(entries);
  }

  getEntryAmount(entry) {
    return utxoManager.entryAmountSompi(entry);
  }

  // ─────────────────────────────────────────────────────────────
  // TX Builder Proxies
  // ─────────────────────────────────────────────────────────────

  async estimateTransaction(args) {
    return txBuilder.estimateTransaction(args);
  }

  estimateFee(inputCount, outputCount, payloadBytes = 0) {
    return txBuilder.estimateFee(inputCount, outputCount, payloadBytes);
  }

  async buildPendingTransaction(args) {
    return txBuilder.buildPendingTransaction(args);
  }

  async buildManualTransaction(options) {
    this._checkConnected();
    return txBuilder.buildManualTransaction({ ...options, networkId: this.networkId });
  }

  async buildSplitUtxoTransaction(options) {
    this._checkConnected();
    return txBuilder.buildSplitUtxoTransaction({ ...options, networkId: this.networkId });
  }

  async signPendingTransaction(pendingTx, privateKeys) {
    return txBuilder.signPendingTransaction(pendingTx, privateKeys);
  }

  async submitPendingTransaction(pendingTx, privateKeys = []) {
    this._checkConnected();
    return txBuilder.submitPendingTransaction({ pendingTx, privateKeys, client: this.client });
  }

  async buildSignSubmitTransaction(args) {
    this._checkConnected();
    return txBuilder.buildSignSubmitTransaction({ ...args, client: this.client });
  }

  // ─────────────────────────────────────────────────────────────
  // High-Level UTXO Operations (Delegate to utxo_operations.js)
  // ─────────────────────────────────────────────────────────────

  /**
   * Manually build and send a transaction with full control.
   * Supports janitor mode (dust sweeping).
   */
  async manualSend({
    fromAddress,
    toAddress,
    amount,
    payload,
    privateKeys,
    priorityFee = 0n,
    engineIndex,
    totalEngines,
    optimisticSpend = true,
    janitorMode = true,
    smallThreshold = 100000000n,
    maxSmallSweep = 5,
    addresses,
  } = {}) {
    this._checkConnected();

    if (!fromAddress) throw new Error("manualSend: fromAddress required.");
    if (!toAddress) throw new Error("manualSend: toAddress required.");
    if (amount === undefined || amount === null) throw new Error("manualSend: amount required.");

    const amountSompi = typeof amount === "bigint" ? amount : utxoManager.kasToSompi(amount);

    // Query UTXOs from all provided addresses (receive + change) to find funds
    const allAddresses = (Array.isArray(addresses) && addresses.length > 0)
      ? addresses.filter(a => a != null && a !== '').map(a => String(a))
      : null;

    let utxoEntries;
    if (allAddresses && allAddresses.length > 1) {
      utxoEntries = await this.getUtxosForAddresses(allAddresses, {
        useCache: true,
        excludeSpent: optimisticSpend,
      });
    } else {
      utxoEntries = await this.getUtxos(fromAddress, {
        useCache: true,
        excludeSpent: optimisticSpend,
      });
    }

    const result = await utxoOps.manualSend({
      client: this.client,
      networkId: this.networkId,
      fromAddress,
      toAddress,
      amountSompi,
      payload,
      privateKeys,
      priorityFee,
      engineIndex,
      totalEngines,
      utxoEntries,
      janitorMode,
      smallThreshold,
      maxSmallSweep,
    });

    // Mark spent optimistically
    if (optimisticSpend && result.usedEntries) {
      this.markUtxosAsSpent(result.usedEntries);
    }

    return result;
  }

  /**
   * Split UTXOs into multiple equal outputs for parallel transactions.
   * Supports multi-address mode: pass `addresses` array to fetch from all addresses.
   * @param {Object} options
   * @param {string} [options.address] - Primary address (for single-address mode)
   * @param {string[]} [options.addresses] - Array of addresses (for multi-address mode)
   * @param {number} options.splitCount - Number of outputs to create
   * @param {Array} options.privateKeys - Private keys for signing
   * @param {bigint} [options.priorityFee=0n] - Priority fee
   * @param {bigint} [options.minUtxoAmount] - Minimum UTXO amount to include (filters small UTXOs)
   */
  async splitUtxos({ address, addresses, splitCount, privateKeys, priorityFee = 0n, minUtxoAmount = 0n } = {}) {
    this._checkConnected();

    // Build addresses array
    const allAddresses = Array.isArray(addresses) && addresses.length > 0
      ? addresses.filter(a => a != null && a !== '').map(a => String(a))
      : (address ? [String(address)] : []);

    if (allAddresses.length === 0) throw new Error("splitUtxos: address or addresses required.");
    if (!splitCount || splitCount < 2 || splitCount > 100) {
      throw new Error("splitUtxos: splitCount must be 2-100.");
    }
    if (!privateKeys?.length) throw new Error("splitUtxos: privateKeys required.");

    const primaryAddress = allAddresses[0];

    this.clearSpentUtxos();
    this.invalidateUtxoCache(allAddresses);

    // Fetch UTXOs from all addresses
    let entries;
    if (allAddresses.length > 1) {
      entries = await this.getUtxosForAddresses(allAddresses, { useCache: false, excludeSpent: false });
    } else {
      entries = await this.getUtxos(primaryAddress, { useCache: false, excludeSpent: false });
    }

    if (entries.length === 0) throw new Error("No UTXOs available to split.");

    // Filter to only usable UTXOs if minUtxoAmount is specified
    let usableEntries = entries;
    if (minUtxoAmount > 0n) {
      usableEntries = entries.filter(e => utxoManager.entryAmountSompi(e) >= minUtxoAmount);
      if (usableEntries.length === 0) {
        const totalBalance = this.calculateTotalBalance(entries);
        throw new Error(
          `No usable UTXOs (>= ${utxoManager.sompiToKas(minUtxoAmount)} KAS). ` +
          `Have ${entries.length} UTXOs totaling ${utxoManager.sompiToKas(totalBalance)} KAS but all are too small.`
        );
      }
    }

    // Validate split is worthwhile
    const totalUsable = this.calculateTotalBalance(usableEntries);
    const feeEstimate = 1000000n * BigInt(splitCount); // ~0.01 KAS per output
    const amountPerOutput = (totalUsable - feeEstimate) / BigInt(splitCount);
    if (amountPerOutput < 50000000n) { // 0.5 KAS minimum per output
      throw new Error(
        `Split would create outputs too small (${utxoManager.sompiToKas(amountPerOutput)} KAS each). ` +
        `Need more funds or fewer splits.`
      );
    }

    const result = await utxoOps.splitUtxos({
      client: this.client,
      networkId: this.networkId,
      address: primaryAddress,
      privateKeys,
      entries: usableEntries,
      splitCount,
      priorityFee,
    });

    this.clearSpentUtxos();
    this.invalidateUtxoCache(allAddresses);

    return result;
  }

  /**
   * Consolidate all UTXOs into a target number of equal outputs.
   * Supports multi-address mode: pass `addresses` array to fetch from all addresses.
   * @param {Object} options
   * @param {string} [options.address] - Primary address (for single-address mode)
   * @param {string[]} [options.addresses] - Array of addresses (for multi-address mode)
   * @param {Array} options.privateKeys - Private keys for signing
   * @param {number} [options.targetCount=5] - Target number of output UTXOs
   * @param {bigint} [options.priorityFee=0n] - Priority fee
   * @param {number} [options.maxInputsPerTx=80] - Maximum inputs per transaction
   * @param {function} [options.onProgress] - Progress callback
   */
  async consolidateUtxos({
    address,
    addresses,
    privateKeys,
    targetCount = 5,
    priorityFee = 0n,
    maxInputsPerTx = 80,
    onProgress,
  } = {}) {
    this._checkConnected();

    // Build addresses array
    const allAddresses = Array.isArray(addresses) && addresses.length > 0
      ? addresses.filter(a => a != null && a !== '').map(a => String(a))
      : (address ? [String(address)] : []);

    if (allAddresses.length === 0) throw new Error("consolidateUtxos: address or addresses required.");
    if (!privateKeys?.length) throw new Error("consolidateUtxos: privateKeys required.");
    if (targetCount < 1 || targetCount > 100) {
      throw new Error("consolidateUtxos: targetCount must be 1-100.");
    }

    const primaryAddress = allAddresses[0];

    this.clearSpentUtxos();
    this.invalidateUtxoCache(allAddresses);

    // Fetch UTXOs from all addresses
    let entries;
    if (allAddresses.length > 1) {
      entries = await this.getUtxosForAddresses(allAddresses, { useCache: false, excludeSpent: false });
    } else {
      entries = await this.getUtxos(primaryAddress, { useCache: false, excludeSpent: false });
    }

    if (entries.length === 0) throw new Error("No UTXOs available to consolidate.");

    const result = await utxoOps.consolidateUtxos({
      client: this.client,
      networkId: this.networkId,
      address: primaryAddress,
      privateKeys,
      entries,
      targetCount,
      priorityFee,
      maxInputsPerTx,
      onProgress,
    });

    // Update spent tracking from consolidation
    if (result.spentKeys) {
      for (const key of result.spentKeys) {
        this._spentUtxos.add(key);
      }
    }

    this.clearSpentUtxos();
    this.invalidateUtxoCache(allAddresses);

    // Wait for settlement then fetch final state
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Fetch from all addresses to get accurate final count
    let finalEntries;
    if (allAddresses.length > 1) {
      finalEntries = await this.getUtxosForAddresses(allAddresses, { useCache: false, excludeSpent: false });
    } else {
      finalEntries = await this.getUtxos(primaryAddress, { useCache: false, excludeSpent: false });
    }
    const finalBalance = this.calculateTotalBalance(finalEntries);

    return {
      ...result,
      outputCount: finalEntries.length,
      finalUtxoCount: finalEntries.length,
      totalInput: finalBalance,
      totalInputKas: utxoManager.sompiToKas(finalBalance),
      amountPerOutput: utxoManager.sompiToKas(
        finalBalance / BigInt(Math.max(1, finalEntries.length))
      ),
    };
  }

  /**
   * Get UTXO analysis for an address.
   */
  async analyzeUtxos(address) {
    this._checkConnected();

    const entries = await this.getUtxos(address, { useCache: false, excludeSpent: false });
    const categories = this.categorizeUtxos(entries);
    const totalBalance = this.calculateTotalBalance(entries);

    return {
      address,
      totalBalance,
      totalBalanceKas: utxoManager.sompiToKas(totalBalance),
      utxoCount: entries.length,
      pendingSpent: this._spentUtxos.size,
      categories: {
        dust: { count: categories.dust.length, total: this.calculateTotalBalance(categories.dust) },
        small: { count: categories.small.length, total: this.calculateTotalBalance(categories.small) },
        medium: { count: categories.medium.length, total: this.calculateTotalBalance(categories.medium) },
        large: { count: categories.large.length, total: this.calculateTotalBalance(categories.large) },
      },
      entries,
    };
  }

  // ─────────────────────────────────────────────────────────────
  // RPC
  // ─────────────────────────────────────────────────────────────

  async runRpcCommand(cmdText) {
    return runRpcCommand(this.client, cmdText);
  }

  // ─────────────────────────────────────────────────────────────
  // Heartbeat Proxies (delegates to HeartbeatMonitor)
  // ─────────────────────────────────────────────────────────────

  startHeartbeat(options) {
    return this._heartbeat.start(options);
  }

  stopHeartbeat() {
    return this._heartbeat.stop();
  }

  get isHeartbeatRunning() {
    return this._heartbeat.isRunning;
  }

  get heartbeatConfig() {
    return this._heartbeat.config;
  }

  async triggerHeartbeat() {
    return await this._heartbeat.trigger();
  }

  _checkConnected() {
    if (!this.client) throw new Error("TransportFacade: Not connected to Kaspa node.");
  }
}
