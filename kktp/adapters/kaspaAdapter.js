// kktp/adapters/kaspaAdapter.js
// Network Adapter Interface - Bridges KKTP components to KaspaPortal
// This abstraction allows swapping the underlying network (e.g., Kaspa → another chain)

import { BLOCKCHAIN } from "../core/constants.js";
import { kaspaPortal } from "../engine/kaspa/kaspaPortal.js";

/**
 * KaspaAdapter - Bridge between KKTP protocol components and KaspaPortal.
 *
 * All KKTP components should use this adapter instead of importing
 * kaspaPortal directly. This provides:
 * - Clean separation of concerns
 * - Testability (can mock the adapter)
 * - Single integration point
 * - Network-agnostic KKTP layer (swap this adapter for another chain)
 *
 * @example
 * ```javascript
 * // In SessionFacade constructor:
 * const adapter = new KaspaAdapter(kaspaPortal);
 *
 * // Pass to internal services:
 * const keyDeriver = new KeyDeriver({ adapter, persistence });
 * ```
 */
export class KaspaAdapter {
  /**
   * @param {import('@/kktp/engine/kaspa/kaspaPortal.js').KaspaPortal} [portal]
   */
  constructor(portal = kaspaPortal) {
    if (!portal) {
      throw new Error("KaspaAdapter: portal instance is required");
    }
    this._portal = portal;
    this._heartbeatAnchorsEnabled = true;
  }

  /**
   * Enable or disable heartbeat anchor broadcasts.
   * @param {boolean} enabled
   */
  setHeartbeatAnchorsEnabled(enabled = true) {
    this._heartbeatAnchorsEnabled = enabled !== false;
  }

  // ═══════════════════════════════════════════════════════════════
  // LIFECYCLE & STATE
  // ═══════════════════════════════════════════════════════════════

  /**
   * Initialize the underlying portal (WASM).
   * @returns {Promise<void>}
   */
  async init() {
    if (typeof this._portal.init === "function") {
      await this._portal.init();
    }
  }

  /**
   * Connect to the network.
   * @param {Object} [options]
   * @returns {Promise<Object>}
   */
  async connect(options = {}) {
    if (typeof this._portal.connect === "function") {
      return await this._portal.connect(options);
    }
  }

  /**
   * Disconnect from the network.
   * @returns {Promise<void>}
   */
  async disconnect() {
    if (typeof this._portal.disconnect === "function") {
      await this._portal.disconnect();
    }
  }

  /**
   * Check if the underlying network is connected and ready.
   * @returns {boolean}
   */
  get isReady() {
    return this._portal.isReady;
  }

  /**
   * Get the current wallet address (sync getter).
   * @returns {string|null}
   */
  get address() {
    return this._portal.address;
  }

  /**
   * Get the current wallet address (async method for consistency).
   * @returns {Promise<string|null>}
   */
  async getAddress() {
    return this._portal.address;
  }

  /**
   * List all wallet filenames stored in browser storage.
   * @returns {Promise<Array>} Array of wallet descriptors
   */
  async getAllWallets() {
    return await this._portal.getAllWallets();
  }

  /**
   * Check if the wallet is initialized.
   * @returns {boolean}
   */
  get isWalletInitialized() {
    return this._portal.wallet?.walletInitialized ?? false;
  }

  /**
   * Create or open a wallet.
   * @param {Object} options
   * @returns {Promise<{address: string, mnemonic?: string}>}
   */
  async createOrOpenWallet(options) {
    return await this._portal.createOrOpenWallet(options);
  }

  /**
   * Get the wallet mnemonic phrase for the active wallet.
   * @returns {Promise<string>}
   */
  async getMnemonic() {
    return await this._portal.getMnemonic();
  }

  /**
   * Close the active wallet and clear sensitive data from memory.
   * @returns {Promise<void>}
   */
  async closeWallet() {
    return await this._portal.closeWallet();
  }

  /**
   * Delete a wallet from browser storage.
   * @param {string} filename
   * @returns {Promise<void>}
   */
  async deleteWallet(filename) {
    return await this._portal.deleteWallet(filename);
  }

  // ═══════════════════════════════════════════════════════════════
  // IDENTITY & KEY MANAGEMENT
  // ═══════════════════════════════════════════════════════════════

  /**
   * Generate signing and DH key pairs for KKTP identity.
   * @param {number} index - Derivation index
   * @returns {Promise<{sig: {publicKey: string, privateKey: string}, dh: {publicKey: string, privateKey: string}}>}
   */
  async generateIdentityKeys(index) {
    return await this._portal.generateIdentityKeys(index);
  }

  // ═══════════════════════════════════════════════════════════════
  // CRYPTOGRAPHY
  // ═══════════════════════════════════════════════════════════════

  /**
   * Sign a message with a private key.
   * @param {string} privateKeyHex - Private key as hex string
   * @param {string} message - Message to sign
   * @returns {Promise<string>} Signature
   */
  async signMessage(privateKeyHex, message) {
    return await this._portal.signMessage(privateKeyHex, message);
  }

  /**
   * Verify a message signature.
   * @param {string} publicKey - Public key
   * @param {string} body - Original message
   * @param {string} signature - Signature to verify
   * @returns {Promise<boolean>} True if valid
   */
  async verifyMessage(publicKey, body, signature) {
    return await this._portal.verifyMessage(publicKey, body, signature);
  }

  /**
   * Start a Diffie-Hellman session for encrypted communication.
   * @param {number} keyIndex - Derivation index
   * @param {string} [privateKey] - Existing private key (optional)
   * @returns {Promise<Object>} DH session with deriveSharedSecret method
   */
  async startSession(keyIndex, privateKey) {
    return await this._portal.startSession(keyIndex, privateKey);
  }

  // ═══════════════════════════════════════════════════════════════
  // VRF & RANDOMNESS
  // ═══════════════════════════════════════════════════════════════

  /**
   * Initialize VRF (must be called before using VRF features).
   */
  async initVRF() {
    if (typeof this._portal.initVRF === "function") {
      await this._portal.initVRF();
    }
  }

  /**
   * Generate high-quality randomness from QRNG, Bitcoin, and Kaspa.
   * @returns {Promise<string>} 64-character hex string
   */
  async generateFullRandomness() {
    return await this._portal.generateFullRandomness();
  }

  /**
   * Generate randomness from Bitcoin and Kaspa only (no QRNG).
   * Use as fallback when QRNG is unavailable.
   * @returns {Promise<string>} 64-character hex string
   */
  async generatePartialRandomness() {
    return await this._portal.generatePartialRandomness();
  }

  /**
   * Generate a verifiable random proof using blockchain entropy.
   * @param {Object} options - VRF options
   * @param {string} options.seedInput - Seed value
   * @returns {Promise<{finalOutput: string, proof: Object}>}
   */
  async prove(options) {
    return await this._portal.prove(options);
  }

  /**
   * Verify a VRF proof.
   * @param {string|Object} valueOrResult - Value or result object to verify
   * @param {Object} [optionalProof] - Proof if not included in first param
   * @param {string} [expectedInput] - Expected VRF input for validation
   * @returns {Promise<boolean>} True if valid
   */
  async verify(valueOrResult, optionalProof, expectedInput) {
    return await this._portal.verify(valueOrResult, optionalProof);
  }

  /**
   * Shuffle an array using VRF randomness.
   * @param {Array} array - Array to shuffle
   * @returns {Promise<Array>} Shuffled array
   */
  async shuffle(array) {
    return await this._portal.shuffle(array);
  }

  /**
   * Fetch recent Kaspa block hashes for entropy.
   * @param {number} n - Number of blocks
   * @returns {Promise<Array>}
   */
  async getKaspaBlocks(n) {
    return await this._portal.getKaspaBlocks(n);
  }

  /**
   * Fetch recent Bitcoin block hashes for entropy.
   * @param {number} n - Number of blocks
   * @returns {Promise<Array>}
   */
  async getBitcoinBlocks(n) {
    return await this._portal.getBitcoinBlocks(n);
  }

  /**
   * Fetch quantum random numbers from a QRNG provider.
   * @param {string} provider - 'nist', 'anu', or 'qrandom'
   * @param {number} length - Number of bytes
   * @returns {Promise<Array>}
   */
  async getQRNG(provider, length) {
    return await this._portal.getQRNG(provider, length);
  }

  // ═══════════════════════════════════════════════════════════════
  // TRANSACTION & BROADCASTING
  // ═══════════════════════════════════════════════════════════════

  /**
   * Send a transaction with a payload.
   * @param {Object} options - Transaction options
   * @param {string} options.toAddress - Destination address
   * @param {string} [options.amount='1'] - Amount in KAS
   * @param {string} [options.payload] - OP_RETURN payload
   * @returns {Promise<Object>} Transaction result
   */
  async send(options) {
    return await this._portal.send(options);
  }

  /**
   * Get spendable wallet balance in sompi.
   * @returns {Promise<bigint>}
   */
  async getBalance() {
    return await this._portal.getBalance();
  }

  /**
   * Get private keys for manual transaction signing.
   * @param {Object} [options]
   * @returns {Promise<Array>}
   */
  async getPrivateKeys(options) {
    return await this._portal.getPrivateKeys(options);
  }

  /**
   * Send a transaction with full UTXO control.
   * @param {Object} options
   * @returns {Promise<Object>}
   */
  async manualSend(options) {
    const payload = options?.payload;
    const payloadStr = typeof payload === "string" ? payload : "";
    const payloadHex = payloadStr.startsWith("0x")
      ? payloadStr.slice(2)
      : payloadStr;
    const isHeartbeatPayload =
      payloadStr.startsWith(BLOCKCHAIN.PREFIX_HEARTBEAT) ||
      payloadHex.toLowerCase().startsWith(BLOCKCHAIN.PREFIX_HEARTBEAT_HEX);
    if (isHeartbeatPayload && !this._heartbeatAnchorsEnabled) {
      throw new Error("Heartbeat anchors disabled");
    }
    return await this._portal.manualSend(options);
  }

  /**
   * Split UTXOs into multiple outputs.
   * @param {Object} options
   * @returns {Promise<Object>}
   */
  async splitUtxos(options) {
    return await this._portal.splitUtxos(options);
  }

  /**
   * Consolidate many UTXOs into fewer outputs.
   * @param {Object} options
   * @returns {Promise<Object>}
   */
  async consolidateUtxos(options) {
    return await this._portal.consolidateUtxos(options);
  }

  /**
   * Build a transaction without broadcasting it.
   * @param {Object} options
   * @returns {Promise<Object>}
   */
  async buildManualTransaction(options) {
    return await this._portal.buildManualTransaction(options);
  }

  /**
   * Build a UTXO split transaction without broadcasting it.
   * @param {Object} options
   * @returns {Promise<Object>}
   */
  async buildSplitUtxoTransaction(options) {
    return await this._portal.buildSplitUtxoTransaction(options);
  }

  /**
   * Estimate transaction fee.
   * @param {number} inputCount
   * @param {number} outputCount
   * @param {number} [payloadBytes=0]
   * @returns {bigint}
   */
  estimateFee(inputCount, outputCount, payloadBytes = 0) {
    return this._portal.estimateFee(inputCount, outputCount, payloadBytes);
  }

  /**
   * Pick the address that has the single largest UTXO.
   * @param {Object} [options]
   * @returns {Promise<string>}
   */
  async getAddressWithLargestUtxo(options) {
    return await this._portal.getAddressWithLargestUtxo(options);
  }

  /**
   * Fetch UTXOs for an address.
   * @param {string} address
   * @param {Object} [options]
   * @returns {Promise<Array>}
   */
  async getUtxos(address, options) {
    return await this._portal.getUtxos(address, options);
  }

  /**
   * Analyze UTXOs for an address.
   * @param {string} address
   * @returns {Promise<Object>}
   */
  async analyzeUtxos(address) {
    return await this._portal.analyzeUtxos(address);
  }

  /**
   * Mark UTXOs as spent for optimistic UI updates.
   * @param {Array} entries
   */
  markUtxosAsSpent(entries) {
    this._portal.markUtxosAsSpent(entries);
  }

  /**
   * Clear spent UTXO tracking.
   * @param {Array} [entries]
   */
  clearSpentUtxos(entries) {
    this._portal.clearSpentUtxos(entries);
  }

  /**
   * Invalidate cached UTXOs to force a fresh fetch.
   * @param {string} [address]
   */
  invalidateUtxoCache(address) {
    this._portal.invalidateUtxoCache(address);
  }

  /**
   * Start automatic UTXO monitoring and replenishment.
   * @param {Object} [options]
   * @returns {Promise<void>}
   */
  async startHeartbeat(options = {}) {
    return await this._portal.startHeartbeat(options);
  }

  /**
   * Stop the heartbeat monitor.
   */
  stopHeartbeat() {
    return this._portal.stopHeartbeat();
  }

  /**
   * Check if the heartbeat monitor is running.
   * @returns {boolean}
   */
  get isHeartbeatRunning() {
    return this._portal.isHeartbeatRunning;
  }

  /**
   * Get current heartbeat configuration (excludes private keys).
   * @returns {Object|null}
   */
  get heartbeatConfig() {
    return this._portal.heartbeatConfig;
  }

  /**
   * Manually trigger a heartbeat check.
   * @returns {Promise<void>}
   */
  async triggerHeartbeat() {
    return await this._portal.triggerHeartbeat();
  }

  // ═══════════════════════════════════════════════════════════════
  // SCANNER & PREFIX MANAGEMENT
  // ═══════════════════════════════════════════════════════════════

  /**
   * Add a payload prefix to watch for on the blockchain.
   * @param {string} prefix - Prefix to match (e.g., 'KKTP:abc123...')
   */
  addPrefix(prefix) {
    this._portal.addPrefix?.(prefix);
  }

  /**
   * Add a hex payload prefix to watch for on the blockchain.
   * @param {string} prefixHex - Hex prefix to match
   */
  addPrefixHex(prefixHex) {
    this._portal.addPrefixHex?.(prefixHex);
  }

  /**
   * Remove a prefix from the watch list.
   * @param {string} prefix - Prefix to stop watching
   */
  removePrefix(prefix) {
    this._portal.removePrefix?.(prefix);
  }

  /**
   * Remove a hex prefix from the watch list.
   * @param {string} prefixHex - Hex prefix to stop watching
   */
  removePrefixHex(prefixHex) {
    this._portal.removePrefixHex?.(prefixHex);
  }

  /**
   * Subscribe to a prefix (alias of addPrefix for compatibility).
   * @param {string} prefix - Prefix to match
   */
  async subscribeToPrefix(prefix) {
    this.addPrefix(prefix);
  }

  /**
   * Unsubscribe from a prefix (alias of removePrefix for compatibility).
   * @param {string} prefix - Prefix to remove
   */
  async unsubscribeFromPrefix(prefix) {
    this.removePrefix(prefix);
  }

  /**
   * Set a single scanner prefix.
   * @param {string} prefix - Prefix to match
   */
  setScannerPrefix(prefix) {
    this._portal.setScannerPrefix?.(prefix);
  }

  /**
   * Start the live blockchain scanner.
   * @param {Function} [onBlock] - Called for each new block
   * @returns {Promise<void>}
   */
  async startScanner(onBlock) {
    if (typeof this._portal.startScanner === "function") {
      return await this._portal.startScanner(onBlock);
    }
  }

  /**
   * Stop the live blockchain scanner.
   */
  stopScanner() {
    this._portal.stopScanner?.();
  }

  /**
   * Subscribe to new block events.
   * @param {Function} cb - Callback receiving block data
   * @returns {Function|undefined} Unsubscribe function if available
   */
  onNewBlock(cb) {
    if (typeof this._portal.onNewBlock === "function") {
      return this._portal.onNewBlock(cb);
    }
  }

  /**
   * Subscribe to matching transaction events from the scanner.
   * @param {Function} cb - Callback receiving match data
   * @returns {Function|undefined} Unsubscribe function if available
   */
  onNewTransactionMatch(cb) {
    if (this._portal?.intelligence?.onNewTransactionMatch) {
      return this._portal.intelligence.onNewTransactionMatch(cb);
    }
    if (typeof this._portal.onNewTransactionMatch === "function") {
      this._portal.onNewTransactionMatch(cb);
      return () => {};
    }
  }

  /**
   * Get the current scanner prefix.
   * @returns {string|null}
   */
  getScannerPrefix() {
    return this._portal.getScannerPrefix?.() || null;
  }

  // ═══════════════════════════════════════════════════════════════
  // BLOCKCHAIN SEARCH
  // ═══════════════════════════════════════════════════════════════

  /**
   * Walk the DAG from startHash to endHash (or present).
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
    return await this._portal.walkDagRange(options);
  }
}
