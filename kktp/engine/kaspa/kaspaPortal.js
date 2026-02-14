import { TransportFacade } from "./transport/transportFacade.js";
import { IdentityFacade } from "./identity/identityFacade.js";
import {
  IntelligenceFacade,
  IndexerEventType,
  MatchMode,
  EvictionReason,
  IndexerStore,
  SearchMode,
} from "./intelligence/intelligenceFacade.js";
import { CryptoFacade } from "./crypto/cryptoFacade.js";
import { VRFFacade } from "./vrf/vrfFacade.js";
import initKaspa from "./kas-wasm/kaspa.js";
import { Logger, LogModule } from "../../core/logger.js";

let wasmInitialized = false;
let wasmInitPromise = null;
const log = Logger.create(LogModule.kktp.kaspaPortal);

// Re-export enums for convenience
export {
  SearchMode,
  IndexerEventType,
  MatchMode,
  EvictionReason,
  IndexerStore,
};

/**
 * KaspaPortal - The Master Facade for Kaspa blockchain interactions.
 *
 * Provides a unified API for wallet management, transactions, real-time
 * blockchain monitoring, encrypted messaging (KKTP), and multiplayer lobbies.
 *
 * @example
 * ```javascript
 * import { kaspaPortal } from './kaspaPortal.js';
 *
 * // Initialize and connect
 * await kaspaPortal.init();
 * await kaspaPortal.connect({ networkId: 'testnet-10' });
 * await kaspaPortal.createOrOpenWallet({ password: 'myPassword' });
 *
 * // Send a transaction
 * await kaspaPortal.send({ toAddress: 'kaspa:...', amount: '1.5' });
 *
 *
 * Architecture:
 * ```
 * ┌─────────────────────────────────────────────────────────────┐
 * │                       KaspaPortal                           │
 * ├─────────────────────────────────────────────────────────────┤
 * │  Transport    │ Identity   │ Intelligence │ Crypto │ VRF    │
 * ├─────────────────────────────────────────────────────────────┤
 */
export class KaspaPortal {
  constructor() {
    this._isReady = false;
    this._connectPromise = null;

    // Core sub-facades (always available)
    this.transport = new TransportFacade();
    this.identity = new IdentityFacade();
    this.crypto = new CryptoFacade();
    this.vrf = new VRFFacade(false);

    // Initialized on connect()
    this.intelligence = null;
  }

  // ═══════════════════════════════════════════════════════════════
  // SECTION 1: LIFECYCLE
  // ═══════════════════════════════════════════════════════════════

  /**
   * Initialize the Kaspa WebAssembly module.
   * Call this once before using any other methods.
   *
   * @returns {Promise<void>}
   * @example
   * await kaspaPortal.init();
   */
  async init() {
    if (wasmInitialized) return;
    if (wasmInitPromise) return wasmInitPromise;

    wasmInitPromise = (async () => {
      await initKaspa();
      wasmInitialized = true;
    })();

    try {
      await wasmInitPromise;
    } catch (err) {
      wasmInitialized = false;
      throw err;
    } finally {
      if (wasmInitialized) {
        wasmInitPromise = null;
      }
    }
  }

  /**
   * Connect to the Kaspa network and initialize all services.
   *
   * @param {Object} [options] - Connection options
   * @param {string} [options.rpcUrl] - WebSocket URL (uses public resolver if omitted)
   * @param {string} [options.networkId='testnet-10'] - Network to connect to
   * @param {Function} [options.onDisconnect] - Called when connection is lost
   * @param {string} [options.balanceElementId] - DOM element ID for auto-updating balance display
   * @param {Function} [options.onBalanceChange] - Called when wallet balance changes
   * @param {boolean} [options.startIntelligence=true] - Start blockchain scanner automatically
   * @param {Object} [options.scannerOptions] - Scanner configuration
   * @param {Object} [options.indexerOptions] - Indexer configuration
   * @returns {Promise<Object>} The RPC client instance
   *
   * @example
   * await kaspaPortal.connect({
   *   networkId: 'testnet-10',
   *   onBalanceChange: (balance) => console.log('Balance:', balance)
   * });
   */
  async connect({
    rpcUrl,
    networkId = "testnet-10",
    onDisconnect,
    balanceElementId,
    onBalanceChange,
    startIntelligence = true,
    scannerOptions = {},
    indexerOptions = {},
  } = {}) {
    if (this._isReady) {
      // Already connected — but if a new balance callback was provided,
      // register it so callers that connect late still receive updates.
      if (typeof onBalanceChange === "function") {
        this.identity.setOnBalanceChange(onBalanceChange);
      }
      return this.transport.client;
    }
    if (this._connectPromise) return this._connectPromise;

    this._connectPromise = (async () => {
      await this.transport.connect({ rpcUrl, networkId, onDisconnect });

      await this.identity.init({
        client: this.transport.client,
        networkId,
        balanceElementId,
        onBalanceChange,
      });

      this.intelligence = new IntelligenceFacade(
        this.transport.client,
        scannerOptions,
        indexerOptions,
      );
      await this.intelligence.init();

      if (startIntelligence) {
        await this.intelligence.start();
      }

      // KKTP facades are lazy-initialized on first access via getters
      // This avoids initializing KKTP for demos that don't need it

      this._isReady = true;
      return this.transport.client;
    })();

    try {
      return await this._connectPromise;
    } finally {
      this._connectPromise = null;
    }
  }

  /**
   * Disconnect from the network and clean up all services.
   * Stops the scanner, indexer, and clears session/lobby state.
   *
   * @returns {Promise<void>}
   */
  async disconnect() {
    this._isReady = false;
    if (this.intelligence) {
      this.intelligence.shutdown();
      this.intelligence = null;
    }
    await this.transport.disconnect();
  }

  // ═══════════════════════════════════════════════════════════════
  // SECTION 2: STATE ACCESSORS
  // ═══════════════════════════════════════════════════════════════

  /**
   * Check if the portal is connected and ready to use.
   * @returns {boolean}
   */
  get isReady() {
    return this._isReady;
  }

  /**
   * Access the raw RPC client for advanced operations.
   * @returns {Object|null} The Kaspa RPC client
   */
  get client() {
    return this.transport.client;
  }

  /**
   * Access the active wallet instance.
   * @returns {Object|null} The wallet context
   */
  get wallet() {
    return this.identity.wallet;
  }

  /**
   * Get the wallet's primary receiving address.
   * @returns {string|null} The Kaspa address
   */
  get address() {
    return this.identity.address;
  }

  // ═══════════════════════════════════════════════════════════════
  // SECTION 3: WALLET (Identity Proxy)
  // ═══════════════════════════════════════════════════════════════

  /**
   * Create a new wallet or open an existing one.
   *
   * @param {Object} options - Wallet options
   * @param {string} options.password - Password to encrypt/decrypt the wallet
   * @param {string} [options.walletFilename] - Wallet filename (defaults to 'default')
   * @param {string} [options.mnemonic] - Import existing mnemonic (12 or 24 words)
   * @param {boolean} [options.storeMnemonic=false] - Store mnemonic in browser storage
   * @returns {Promise<{address: string, mnemonic?: string}>} Wallet info
   *
   * @example
   * const { address, mnemonic } = await kaspaPortal.createOrOpenWallet({
   *   password: 'securePassword123',
   *   walletFilename: 'my-wallet'
   * });
   */
  async createOrOpenWallet(options) {
    if (!this._isReady) {
      throw new Error("KaspaPortal: Call connect() before opening a wallet.");
    }
    return await this.identity.createOrOpenWallet(options);
  }

  /**
   * Send KAS to an address using the wallet's built-in transaction builder.
   *
   * @param {Object} options - Transaction options
   * @param {string} options.toAddress - Recipient Kaspa address
   * @param {string|number} options.amount - Amount in KAS (e.g., '1.5')
   * @param {string} [options.payload] - Optional OP_RETURN data
   * @param {number} [options.priorityFeeKas] - Priority fee in KAS
   * @returns {Promise<Object>} Transaction result with txid
   *
   * @example
   * const result = await kaspaPortal.send({
   *   toAddress: 'kaspa:qz...',
   *   amount: '2.5',
   *   payload: 'Hello Kaspa!'
   * });
   */
  async send(options) {
    return await this.identity.send(options);
  }

  /**
   * Get the wallet's spendable balance in sompi.
   * @returns {Promise<bigint>} Balance in sompi (1 KAS = 100,000,000 sompi)
   */
  async getBalance() {
    return await this.identity.getSpendableBalance();
  }

  /**
   * List all wallet filenames stored in browser storage.
   * @returns {Promise<string[]>} Array of wallet filenames
   */
  async getAllWallets() {
    return await this.identity.getAllWallets();
  }

  /**
   * Generate a new receiving address for the wallet.
   * @returns {Promise<string>} New Kaspa address
   */
  async generateNewAddress() {
    return await this.identity.generateNewAddress();
  }

  /**
   * Get private keys for manual transaction signing.
   * Required for `manualSend()` and `splitUtxos()`.
   *
   * @param {Object} [options] - Key derivation options
   * @param {number} [options.keyCount=10] - Number of receive address keys
   * @param {number} [options.changeKeyCount=5] - Number of change address keys
   * @returns {Promise<Array>} Array of PrivateKey objects
   */
  async getPrivateKeys(options) {
    return await this.identity.getPrivateKeys(options);
  }

  /**
   * Close the active wallet and clear sensitive data from memory.
   * @returns {Promise<void>}
   */
  async closeWallet() {
    return await this.identity.closeWallet();
  }

  /**
   * Switch to a different account within the wallet.
   * @param {number} index - Account index (0-based)
   * @returns {Promise<void>}
   */
  async setActiveAccount(index) {
    return await this.identity.setActiveAccount(index);
  }

  /**
   * Delete a wallet from browser storage.
   * @param {string} filename - Wallet filename to delete
   * @returns {Promise<void>}
   */
  async deleteWallet(filename) {
    return await this.identity.deleteWallet(filename);
  }

  /**
   * Get the wallet's mnemonic phrase (12 or 24 words).
   * @returns {Promise<string>} Space-separated mnemonic words
   */
  async getMnemonic() {
    return await this.identity.getMnemonic();
  }

  /**
   * Get the wallet's change address.
   * @returns {Promise<string|null>} Change address or null
   */
  async getChangeAddress() {
    try {
      const account = await this.identity?.getActiveAccount();
      return account?.changeAddress || null;
    } catch {
      return null;
    }
  }

  /**
   * Get both receive and change addresses for the wallet.
   * @returns {Promise<{receiveAddress: string|null, changeAddress: string|null}>}
   */
  async getWalletAddresses() {
    try {
      const account = await this.identity?.getActiveAccount();
      return {
        receiveAddress:
          account?.receiveAddress || this.identity?.address || null,
        changeAddress: account?.changeAddress || null,
      };
    } catch {
      return {
        receiveAddress: this.identity?.address || null,
        changeAddress: null,
      };
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // SECTION 4: TRANSACTIONS (Transport Proxy)
  // ═══════════════════════════════════════════════════════════════

  /**
   * Execute a raw RPC command against the Kaspa node.
   *
   * @param {string|Object} cmd - RPC command as JSON string or object
   * @returns {Promise<any>} RPC response
   *
   * @example
   * const info = await kaspaPortal.runRpcCommand({ method: 'getBlockDagInfo' });
   */
  async runRpcCommand(cmd) {
    if (!this.transport?.client) throw new Error("Not connected");
    const cmdText = typeof cmd === "string" ? cmd : JSON.stringify(cmd);
    return await this.transport.runRpcCommand(cmdText);
  }

  /**
   * Send a transaction with full UTXO control.
   * Use this for rapid-fire transactions or when you need precise UTXO selection.
   *
   * @param {Object} options - Transaction options
   * @param {string} options.fromAddress - Source address
   * @param {string} options.toAddress - Destination address
   * @param {string|bigint} options.amount - Amount in KAS or sompi
   * @param {string} [options.payload] - OP_RETURN payload
   * @param {Array} options.privateKeys - Keys from `getPrivateKeys()`
   * @param {bigint} [options.priorityFee=0n] - Priority fee in sompi
   * @returns {Promise<Object>} Transaction result
   *
   * @example
   * const keys = await kaspaPortal.getPrivateKeys();
   * await kaspaPortal.manualSend({
   *   fromAddress: kaspaPortal.address,
   *   toAddress: 'kaspa:qz...',
   *   amount: '1',
   *   privateKeys: keys
   * });
   */
  async manualSend(options) {
    // Auto-inject change address so UTXOs on the change address are included
    if (options?.fromAddress && !options?.addresses) {
      try {
        const { receiveAddress, changeAddress } =
          await this.getWalletAddresses();
        const addrs = [options.fromAddress];
        if (changeAddress && changeAddress !== options.fromAddress) {
          addrs.push(changeAddress);
        }
        if (
          receiveAddress &&
          receiveAddress !== options.fromAddress &&
          !addrs.includes(receiveAddress)
        ) {
          addrs.push(receiveAddress);
        }
        if (addrs.length > 1) {
          options = { ...options, addresses: addrs };
        }
      } catch {
        /* proceed with single address */
      }
    }
    return await this.transport.manualSend(options);
  }

  /**
   * Split UTXOs into multiple equal outputs for parallel transactions.
   * Call this before rapid-fire sends to prevent UTXO contention.
   *
   * @param {Object} options - Split options
   * @param {string} options.address - Address containing UTXOs
   * @param {number} options.splitCount - Number of outputs (2-100)
   * @param {Array} options.privateKeys - Keys from `getPrivateKeys()`
   * @param {bigint} [options.priorityFee=0n] - Priority fee
   * @returns {Promise<Object>} Split result with txid
   *
   * @example
   * await kaspaPortal.splitUtxos({
   *   address: kaspaPortal.address,
   *   splitCount: 10,
   *   privateKeys: await kaspaPortal.getPrivateKeys()
   * });
   */
  async splitUtxos(options) {
    // Auto-inject change address so UTXOs on the change address are included
    if (options?.address && !options?.addresses) {
      try {
        const { receiveAddress, changeAddress } =
          await this.getWalletAddresses();
        const addrs = [options.address];
        if (changeAddress && changeAddress !== options.address) {
          addrs.push(changeAddress);
        }
        if (
          receiveAddress &&
          receiveAddress !== options.address &&
          !addrs.includes(receiveAddress)
        ) {
          addrs.push(receiveAddress);
        }
        if (addrs.length > 1) {
          options = { ...options, addresses: addrs };
        }
      } catch {
        /* proceed with single address */
      }
    }
    return await this.transport.splitUtxos(options);
  }

  /**
   * Consolidate many UTXOs into fewer, larger ones.
   * Reduces wallet fragmentation and prepares for larger transactions.
   *
   * @param {Object} options - Consolidation options
   * @param {string} options.address - Address to consolidate
   * @param {Array} options.privateKeys - Keys from `getPrivateKeys()`
   * @param {number} [options.targetCount=5] - Target number of output UTXOs
   * @param {bigint} [options.priorityFee=0n] - Priority fee
   * @returns {Promise<Object>} Consolidation result
   */
  async consolidateUtxos(options) {
    return await this.transport.consolidateUtxos(options);
  }

  /**
   * Build a transaction without broadcasting it.
   * @param {Object} options - Transaction options
   * @returns {Promise<Object>} Unsigned transaction
   */
  async buildManualTransaction(options) {
    return await this.transport.buildManualTransaction(options);
  }

  /**
   * Build a UTXO split transaction without broadcasting it.
   * @param {Object} options - Split options
   * @returns {Promise<Object>} Unsigned split transaction
   */
  async buildSplitUtxoTransaction(options) {
    return await this.transport.buildSplitUtxoTransaction(options);
  }

  /**
   * Estimate transaction fee based on input/output counts.
   *
   * @param {number} inputCount - Number of inputs
   * @param {number} outputCount - Number of outputs
   * @param {number} [payloadBytes=0] - Payload size in bytes
   * @returns {bigint} Estimated fee in sompi
   */
  estimateFee(inputCount, outputCount, payloadBytes = 0) {
    return this.transport.estimateFee(inputCount, outputCount, payloadBytes);
  }

  // ═══════════════════════════════════════════════════════════════
  // SECTION 5: UTXO MANAGEMENT (Transport Proxy)
  // ═══════════════════════════════════════════════════════════════

  /**
   * Fetch UTXOs for an address.
   *
   * @param {string} address - Kaspa address
   * @param {Object} [options] - Fetch options
   * @param {boolean} [options.useCache=false] - Use cached UTXOs if available
   * @param {boolean} [options.excludeSpent=true] - Filter out optimistically spent UTXOs
   * @returns {Promise<Array>} Array of UTXO entries
   */
  async getUtxos(address, options) {
    return await this.transport.getUtxos(address, options);
  }

  /**
   * Analyze UTXOs for an address - count, categories, and totals.
   *
   * @param {string} address - Kaspa address
   * @returns {Promise<Object>} Analysis with dust/small/medium/large counts
   */
  async analyzeUtxos(address) {
    return await this.transport.analyzeUtxos(address);
  }

  /**
   * Mark UTXOs as spent for optimistic UI updates.
   * Prevents double-spending during rapid transactions.
   * @param {Array} entries - UTXO entries that were spent
   */
  markUtxosAsSpent(entries) {
    this.transport.markUtxosAsSpent(entries);
  }

  /**
   * Clear spent UTXO tracking (after confirmation or on refresh).
   * @param {Array} [entries] - Specific entries to clear, or all if omitted
   */
  clearSpentUtxos(entries) {
    this.transport.clearSpentUtxos(entries);
  }

  /**
   * Invalidate cached UTXOs to force a fresh fetch.
   * @param {string} [address] - Specific address or all if omitted
   */
  invalidateUtxoCache(address) {
    this.transport.invalidateUtxoCache(address);
  }

  /**
   * Pick the address that has the single largest UTXO.
   * Uses only existing portal methods.
   *
   * @param {Object} [options]
   * @param {string} [options.preferredAddress]
   * @returns {Promise<string|null>}
   */
  async getAddressWithLargestUtxo({ preferredAddress } = {}) {
    const { receiveAddress, changeAddress } = await this.getWalletAddresses();
    const candidates = [receiveAddress, changeAddress, preferredAddress].filter(
      Boolean,
    );

    if (candidates.length === 0) return null;

    let best = { address: candidates[0], amount: 0n };

    for (const addr of candidates) {
      const utxos = await this.getUtxos(addr, {
        useCache: true,
        excludeSpent: true,
      });
      for (const e of utxos || []) {
        const v =
          e?.amount ?? e?.utxoEntry?.amount ?? e?.utxoEntry?.value ?? 0n;
        const a =
          typeof v === "bigint"
            ? v
            : typeof v === "number"
              ? BigInt(v)
              : BigInt(v || 0);
        if (a > best.amount) best = { address: addr, amount: a };
      }
    }

    return best.address;
  }

  // ═══════════════════════════════════════════════════════════════
  // SECTION 6: HEARTBEAT (Transport Proxy)
  // ═══════════════════════════════════════════════════════════════

  /**
   * Start automatic UTXO monitoring and replenishment.
   * Ensures you always have enough UTXOs for rapid transactions.
   *
   * @param {Object} [options] - Heartbeat options
   * @param {string} [options.address] - Address to monitor (auto-detected if omitted)
   * @param {Array} options.privateKeys - Keys for auto-split transactions
   * @param {number} [options.intervalMs=30000] - Check interval in milliseconds
   * @param {number} [options.targetUtxoCount=10] - Minimum UTXO count to maintain
   * @param {Function} [options.onCheck] - Called on each heartbeat check
   * @param {Function} [options.onSplit] - Called when auto-split occurs
   * @returns {Promise<void>}
   *
   * @example
   * await kaspaPortal.startHeartbeat({
   *   privateKeys: await kaspaPortal.getPrivateKeys(),
   *   targetUtxoCount: 5,
   *   onCheck: ({ utxoCount }) => console.log('UTXOs:', utxoCount)
   * });
   */
  async startHeartbeat(options = {}) {
    const { includeChangeAddress = true, ...restOptions } = options;

    if (
      !restOptions.addresses &&
      (!restOptions.address ||
        (includeChangeAddress && !restOptions.changeAddress))
    ) {
      try {
        const walletAddresses = await this.getWalletAddresses();
        if (!restOptions.address && walletAddresses.receiveAddress) {
          restOptions.address = walletAddresses.receiveAddress;
        }
        if (
          includeChangeAddress &&
          !restOptions.changeAddress &&
          walletAddresses.changeAddress
        ) {
          restOptions.changeAddress = walletAddresses.changeAddress;
        }
      } catch (err) {
        log.warn(
          "[KaspaPortal] Failed to auto-detect wallet addresses:",
          err.message,
        );
      }
    }

    return this.transport.startHeartbeat(restOptions);
  }

  /**
   * Stop the heartbeat monitor.
   */
  stopHeartbeat() {
    return this.transport.stopHeartbeat();
  }

  /**
   * Check if the heartbeat monitor is running.
   * @returns {boolean}
   */
  get isHeartbeatRunning() {
    return this.transport.isHeartbeatRunning;
  }

  /**
   * Get current heartbeat configuration (excludes private keys).
   * @returns {Object|null}
   */
  get heartbeatConfig() {
    return this.transport.heartbeatConfig;
  }

  /**
   * Manually trigger a heartbeat check.
   * @returns {Promise<void>}
   */
  async triggerHeartbeat() {
    return await this.transport.triggerHeartbeat();
  }

  // ═══════════════════════════════════════════════════════════════
  // SECTION 7: INTELLIGENCE - Scanner (Intelligence Proxy)
  // ═══════════════════════════════════════════════════════════════

  /** @private */
  _ensureIntelligence() {
    if (!this.intelligence) {
      throw new Error(
        "KaspaPortal: Intelligence not initialized. Call connect().",
      );
    }
  }

  /**
   * Add an address to the scanner's watch list.
   * Transactions involving this address will trigger events.
   * @param {string} address - Kaspa address to watch
   */
  addAddress(address) {
    this.intelligence?.addAddress(address);
  }

  /**
   * Remove an address from the watch list.
   * @param {string} address - Address to stop watching
   */
  removeAddress(address) {
    this.intelligence?.removeAddress(address);
  }

  /**
   * Replace the watch list with a new set of addresses.
   * @param {string|string[]} addresses - Address or array of addresses
   */
  setAddresses(addresses) {
    this.intelligence?.setAddresses(addresses);
  }

  /**
   * Add a payload prefix to watch for.
   * Transactions with matching OP_RETURN data will trigger events.
   * @param {string} prefix - Prefix to match (e.g., 'KKTP:')
   */
  addPrefix(prefix) {
    this.intelligence?.addPrefix(prefix);
  }

  /**
   * Add a hex payload prefix to watch for.
   * @param {string} prefixHex - Hex prefix to match
   */
  addPrefixHex(prefixHex) {
    this.intelligence?.addPrefixHex?.(prefixHex);
  }

  /**
   * Remove a prefix from the watch list.
   * @param {string} prefix - Prefix to stop watching
   */
  removePrefix(prefix) {
    this.intelligence?.removePrefix(prefix);
  }

  /**
   * Remove a hex prefix from the watch list.
   * @param {string} prefixHex - Hex prefix to stop watching
   */
  removePrefixHex(prefixHex) {
    this.intelligence?.removePrefixHex?.(prefixHex);
  }

  /**
   * Replace the prefix list with a new set.
   * @param {string|string[]} prefixes - Prefix or array of prefixes
   */
  setPrefixes(prefixes) {
    this.intelligence?.setPrefixes(prefixes);
  }

  /**
   * Set the scanner's search mode.
   * @param {SearchMode} mode - Search mode enum value
   */
  setSearchMode(mode) {
    this.intelligence?.setSearchMode(mode);
  }

  /**
   * Set a single scanner prefix (convenience method).
   * @param {string} prefix - Prefix to match
   */
  setScannerPrefix(prefix) {
    this._ensureIntelligence();
    if (this.intelligence.scanner) {
      this.intelligence.scanner.prefix = prefix;
    }
  }

  /**
   * Get the current scanner prefix.
   * @returns {string|null}
   */
  getScannerPrefix() {
    return this.intelligence?.scanner?.prefix || null;
  }

  /**
   * Start the live blockchain scanner.
   * @param {Function} [onBlock] - Called for each new block
   * @returns {Promise<void>}
   */
  async startScanner(onBlock) {
    return this.intelligence?.startScanner(onBlock);
  }

  /**
   * Stop the live blockchain scanner.
   */
  stopScanner() {
    this.intelligence?.stopScanner();
  }

  // ═══════════════════════════════════════════════════════════════
  // SECTION 8: INTELLIGENCE - Indexer (Intelligence Proxy)
  // ═══════════════════════════════════════════════════════════════

  /**
   * Get indexer timing configuration.
   * @returns {{ttlMs: number, flushInterval: number}}
   */
  getIndexerTimings() {
    this._ensureIntelligence();
    return this.intelligence.getIndexerTimings();
  }

  /**
   * Start the indexer for caching transactions to IndexedDB.
   * @returns {Promise<Object>} Indexer timing info
   */
  async startIndexer() {
    this._ensureIntelligence();
    return await this.intelligence.startIndexer();
  }

  /**
   * Stop the indexer.
   */
  stopIndexer() {
    this._ensureIntelligence();
    this.intelligence.stopIndexer();
  }

  /**
   * Shutdown the entire Intelligence layer (scanner + indexer).
   */
  shutdownIntelligence() {
    if (this.intelligence) {
      this.intelligence.shutdown();
    }
  }

  /**
   * Get all cached data from IndexedDB.
   * @returns {Promise<{allTxs: Array, matchingTxs: Array, blocks: Array}>}
   */
  async getCachedSnapshot() {
    this._ensureIntelligence();
    return await this.intelligence.getCachedSnapshot();
  }

  /**
   * Get all in-memory data (not yet persisted).
   * @returns {{allTxs: Array, matchingTxs: Array, blocks: Array}}
   */
  getInMemorySnapshot() {
    this._ensureIntelligence();
    return this.intelligence.getInMemorySnapshot();
  }

  /**
   * Clear a specific IndexedDB store.
   * @param {IndexerStore} storeName - Store to clear
   * @returns {Promise<void>}
   */
  async clearIndexerStore(storeName) {
    this._ensureIntelligence();
    return await this.intelligence.clearIndexerStore(storeName);
  }

  /**
   * Get all matching transactions from memory.
   * @returns {Array} Transactions matching your prefix/address filters
   */
  getAllMatchingTransactions() {
    this._ensureIntelligence();
    return this.intelligence.indexer?.getAllMatchingTransactions() || [];
  }

  /**
   * Get all matching transactions from IndexedDB cache.
   * @returns {Promise<Array>}
   */
  async getAllCachedMatchingTransactions() {
    this._ensureIntelligence();
    return await (this.intelligence.indexer?.getAllCachedMatchingTransactions() ||
      Promise.resolve([]));
  }

  // ═══════════════════════════════════════════════════════════════
  // SECTION 9: INTELLIGENCE - Search & Sync (Intelligence Proxy)
  // ═══════════════════════════════════════════════════════════════

  /**
   * Fetch a specific block by its hash.
   *
   * @param {string} blockHash - 64-character hex block hash
   * @returns {Promise<Object|null>} Block data with transactions, or null if not found
   *
   * @example
   * const block = await kaspaPortal.fetchBlockByHash('abc123...');
   * console.log('Transactions:', block.transactions.length);
   */
  async fetchBlockByHash(blockHash) {
    if (!this.transport?.client) {
      throw new Error("KaspaPortal: Not connected to network.");
    }
    if (!blockHash || blockHash.length !== 64) {
      throw new Error(
        "KaspaPortal: Invalid block hash (must be 64 hex characters).",
      );
    }

    try {
      // Kaspa WASM RPC expects IGetBlockRequest: { hash, includeTransactions }
      const response = await this.transport.client.getBlock({
        hash: blockHash,
        includeTransactions: true,
      });
      return response?.block || null;
    } catch (err) {
      log.warn(
        `KaspaPortal: Failed to fetch block ${blockHash.slice(0, 16)}...`,
        err?.message || err,
      );
      return null;
    }
  }

  /** Walk the DAG from startHash to endHash (or present).
   * @param {Object} options
   * @param {string} options.startHash - Block hash to start from
   * @param {string} [options.endHash] - Optional block hash to end at
   * @param {Array<string>} [options.prefixes] - Optional payload prefixes to match
   * @param {function} options.onMatch - Callback for each matching transaction
   * @param {number} [options.maxSeconds] - Max seconds to run (default 30)
   * @param {number} [options.minTimestamp] - Min timestamp to consider (default 0)
   * @param {function} [options.logFn] - Optional logging function
   * @returns {Promise<void>}
   */
  async walkDagRange(options) {
    if (!this.intelligence)
      throw new Error(
        "KaspaPortal: Intelligence not initialized. Call connect().",
      );
    return await this.intelligence.walkDagRange({ ...options });
  }

  // ═══════════════════════════════════════════════════════════════
  // SECTION 10: INTELLIGENCE - Event Subscriptions
  // ═══════════════════════════════════════════════════════════════

  /**
   * Subscribe to new block events.
   * @param {Function} cb - Callback receiving block data
   * @returns {this} For chaining
   */
  onNewBlock(cb) {
    this._ensureIntelligence();
    return this.intelligence.onNewBlock(cb);
  }

  /**
   * Subscribe to all new transaction events.
   * @param {Function} cb - Callback receiving transaction data
   * @returns {this} For chaining
   */
  onNewTransaction(cb) {
    this._ensureIntelligence();
    return this.intelligence.onNewTransaction(cb);
  }

  /**
   * Subscribe to transactions matching your filters (prefix/address).
   * This is the primary event for KKTP message detection.
   *
   * @param {Function} cb - Callback receiving match data
   * @returns {this} For chaining
   *
   * @example
   * kaspaPortal.onNewTransactionMatch((match) => {
   *   console.log('KKTP payload found:', match.payload);
   * });
   */
  onNewTransactionMatch(cb) {
    this._ensureIntelligence();
    return this.intelligence.onNewTransactionMatch(cb);
  }

  /**
   * Subscribe to blocks being cached to IndexedDB.
   * @param {Function} cb - Callback
   * @returns {this} For chaining
   */
  onCachedBlock(cb) {
    this._ensureIntelligence();
    return this.intelligence.onCachedBlock(cb);
  }

  /**
   * Subscribe to transactions being cached.
   * @param {Function} cb - Callback
   * @returns {this} For chaining
   */
  onCachedTransaction(cb) {
    this._ensureIntelligence();
    return this.intelligence.onCachedTransaction(cb);
  }

  /**
   * Subscribe to matching transactions being cached.
   * @param {Function} cb - Callback
   * @returns {this} For chaining
   */
  onCachedTransactionMatch(cb) {
    this._ensureIntelligence();
    return this.intelligence.onCachedTransactionMatch(cb);
  }

  /**
   * Subscribe to eviction events (memory cleanup).
   * @param {Function} cb - Callback
   * @returns {this} For chaining
   */
  onEvict(cb) {
    this._ensureIntelligence();
    return this.intelligence.onEvict(cb);
  }

  /**
   * Subscribe to cache eviction events (IndexedDB cleanup).
   * @param {Function} cb - Callback
   * @returns {this} For chaining
   */
  onCacheEvict(cb) {
    this._ensureIntelligence();
    return this.intelligence.onCacheEvict(cb);
  }

  // ═══════════════════════════════════════════════════════════════
  // SECTION 11: CRYPTOGRAPHY (Crypto Proxy)
  // ═══════════════════════════════════════════════════════════════

  /**
   * Encrypt text with a password using AES-256.
   * @param {string} text - Plaintext to encrypt
   * @param {string} password - Encryption password
   * @returns {string} Encrypted string (base64)
   */
  encrypt(text, password) {
    return this.crypto.encrypt(text, password);
  }

  /**
   * Decrypt text with a password.
   * @param {string} encrypted - Encrypted string
   * @param {string} password - Decryption password
   * @returns {string} Decrypted plaintext
   */
  decrypt(encrypted, password) {
    return this.crypto.decrypt(encrypted, password);
  }

  /**
   * Sign a message with a private key.
   * @param {string} privateKeyHex - Private key as hex string
   * @param {string} message - Message to sign
   * @returns {Promise<string>} Signature
   */
  async signMessage(privateKeyHex, message) {
    return await this.crypto.signMessage(privateKeyHex, message);
  }

  /**
   * Verify a message signature.
   * @param {string} publicKey - Public key
   * @param {string} body - Original message
   * @param {string} sig - Signature to verify
   * @returns {Promise<boolean>} True if valid
   */
  async verifyMessage(publicKey, body, sig) {
    return await this.crypto.verifyMessage(publicKey, body, sig);
  }

  /**
   * Generate signing and Diffie-Hellman key pairs for KKTP identity.
   *
   * @param {number} index - Derivation index
   * @returns {Promise<{sig: {publicKey, privateKey}, dh: {publicKey, privateKey}}>}
   * @throws {Error} If wallet is not initialized
   */
  async generateIdentityKeys(index) {
    if (!this.identity.wallet?.walletInitialized) {
      throw new Error("KaspaPortal: Wallet must be initialized.");
    }
    const xprv = await this.identity.getXprv();
    if (typeof xprv !== "string") {
      throw new Error(`Expected xprv string, got ${typeof xprv}`);
    }
    return await this.crypto.generateIdentityKeys(xprv, index);
  }

  /**
   * Start a Diffie-Hellman session for encrypted communication.
   *
   * @param {number} index - Derivation index
   * @param {string} [privateKey] - Existing private key (optional)
   * @returns {Promise<Object>} DH session with computeSharedSecret method
   */
  async startSession(index, privateKey) {
    if (!this.identity.wallet?.walletInitialized) {
      throw new Error(
        "KaspaPortal: Wallet must be initialized before starting a session.",
      );
    }
    if (privateKey) {
      return this.crypto.createDHSession(privateKey);
    }
    const { dh } = await this.generateIdentityKeys(index);
    return this.crypto.createDHSession(dh.privateKey, dh.publicKey);
  }

  // ═══════════════════════════════════════════════════════════════
  // SECTION 12: VRF & RANDOMNESS (VRF Proxy)
  // ═══════════════════════════════════════════════════════════════

  /** Initialize the VRF module */
  async initVRF() {
    if (this.vrf) {
      await this.vrf.init();
    }
  }

  /**
   * Generate a verifiable random proof using blockchain entropy.
   *
   * @param {Object} options - VRF options
   * @param {string} options.seedInput - Seed value
   * @param {number} [options.btcBlocks=6] - Bitcoin blocks to use
   * @param {number} [options.kasBlocks=12] - Kaspa blocks to use
   * @returns {Promise<{finalOutput: string, proof: Object}>}
   */
  async prove(options) {
    return await this.vrf.prove(options);
  }

  /**
   * Verify a VRF proof.
   *
   * @param {string|Object} valueOrResult - Value or result object to verify
   * @param {Object} [optionalProof] - Proof if not included in first param
   * @returns {Promise<boolean>} True if valid
   */
  async verify(valueOrResult, optionalProof) {
    return await this.vrf.verify(valueOrResult, optionalProof);
  }

  /**
   * Fetch recent Kaspa block hashes for entropy.
   * @param {number} n - Number of blocks
   * @returns {Promise<Array>}
   */
  async getKaspaBlocks(n) {
    return await this.vrf.getKaspaBlocks(n);
  }

  /**
   * Fetch recent Bitcoin block hashes for entropy.
   * @param {number} n - Number of blocks
   * @returns {Promise<Array>}
   */
  async getBitcoinBlocks(n) {
    return await this.vrf.getBitcoinBlocks(n);
  }

  /**
   * Fetch quantum random numbers from a QRNG provider.
   * @param {string} provider - 'nist', 'anu', or 'qrandom'
   * @param {number} length - Number of bytes
   * @returns {Promise<Array>}
   */
  async getQRNG(provider, length) {
    return await this.vrf.getQRNG(provider, length);
  }

  /**
   * Fold two entropy sources together.
   * @param {string} data1 - First hex string
   * @param {string} data2 - Second hex string
   * @param {Object} [options] - Folding options
   * @returns {Promise<string>} Folded result
   */
  async fold(data1, data2, options) {
    return await this.vrf.fold(data1, data2, options);
  }

  /**
   * Shuffle an array using VRF randomness.
   * @param {Array} array - Array to shuffle
   * @returns {Promise<Array>} Shuffled array
   */
  async shuffle(array) {
    return await this.vrf.shuffle(array);
  }

  /**
   * Run the full NIST SP 800-22 randomness test suite.
   * @param {string} bits - Binary string to test
   * @returns {Promise<Array>} Test results
   */
  async fullNIST(bits) {
    return await this.vrf.fullNIST(bits);
  }

  /**
   * Run basic NIST randomness tests (subset).
   * @param {string} bits - Binary string to test
   * @returns {Promise<Array>} Test results
   */
  async basicNIST(bits) {
    return await this.vrf.basicNIST(bits);
  }

  /**
   * Verify a NIST beacon signature.
   * @param {Object} proof - Proof containing NIST data
   * @returns {Promise<boolean>}
   */
  async isValidNistSignature(proof) {
    return await this.vrf.isValidNistSignature(proof);
  }

  /**
   * Generate high-quality randomness from QRNG, Bitcoin, and Kaspa.
   * @returns {Promise<string>} 64-character hex string
   */
  async generateFullRandomness() {
    const result = await this.vrf.generateFoldedEntropy({
      btcBlocks: 1,
      kasBlocks: 1,
      iterations: 2,
    });
    return result.finalOutput;
  }

  /**
   * Generate randomness from Bitcoin and Kaspa only (no QRNG).
   * Use as fallback when QRNG is unavailable.
   * @returns {Promise<string>} 64-character hex string
   */
  async generatePartialRandomness() {
    const result = await this.vrf.generatePartialEntropy({
      btcBlocks: 3,
      kasBlocks: 6,
      iterations: 3,
    });
    return result.finalOutput;
  }
}

// Singleton instance
export const kaspaPortal = new KaspaPortal();
