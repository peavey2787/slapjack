import * as walletService from "./wallet_service.js";
import * as storage from "./storage.js";

export class IdentityFacade {
  constructor() {
    // Expose the raw service and storage modules for advanced usage
    this.walletService = walletService;
    this.storage = storage;
  }

  /**
   * Initialize the wallet service with an RPC client.
   * @param {Object} options
   * @param {Object} options.client - The Kaspa RPC client.
   * @param {string} [options.networkId] - Network ID (e.g. 'testnet-10').
   * @param {string} [options.balanceElementId] - Optional DOM ID for auto-updating balance.
   * @param {function} [options.onBalanceChange] - Optional callback for balance changes.
   * @returns {Promise<void>}
   */
  async init({ client, networkId, balanceElementId, onBalanceChange } = {}) {
    // Map 'client' to 'rpcClient' as expected by wallet_service
    return await walletService.init({
      rpcClient: client,
      networkId,
      balanceElementId,
      onBalanceChange,
    });
  }

  /**
   * Update (or set) the balance-change callback after init.
   * @param {Function|null} cb
   */
  setOnBalanceChange(cb) {
    walletService.setOnBalanceChange(cb);
  }

  /**
   * Create a new wallet or open an existing one.
   * @param {Object} options
   * @param {string} options.password - Wallet password.
   * @param {string} [options.walletFilename] - Filename to save/load.
   * @param {string} [options.mnemonic] - Mnemonic to import (optional).
   * @param {boolean} [options.storeMnemonic] - Whether to store the mnemonic (default false).
   * @returns {Promise<{address: string, mnemonic: string}>}
   */
  async createOrOpenWallet(options) {
    return await walletService.createWallet(options);
  }

  /** Close the active wallet.
   * @returns {Promise<void>}
   */
  async closeWallet() {
    return await walletService.closeWallet();
  }

  /** Set the active account by index.
   * @param {number} index - Account index to activate.
   * @returns {Promise<void>}
   */
  async setActiveAccount(index) {
    return await walletService.activateAccount(index);
  }

  /** Generate a new receive address for the current wallet.
   * @returns {Promise<string>} New address.
   */
  async generateNewAddress() {
    return await walletService.generateNewAddress();
  }

  /** Estimate transaction fee.
   * @param {number|string} amount - Amount in KAS.
   * @param {string} toAddress - Recipient address.
   * @param {string} [payload] - Optional transaction payload.
   * @param {number} [priorityFeeKas] - Priority fee in KAS.
   * @returns {Promise<number>} Estimated fee in KAS.
   */
  async estimateTransactionFee(amount, toAddress, payload, priorityFeeKas) {
    return await walletService.estimateTransactionFee(
      amount,
      toAddress,
      payload,
      priorityFeeKas,
    );
  }

  /**
   * Send a transaction.
   * @param {Object} options
   * @param {string} options.toAddress - Recipient address.
   * @param {number|string} options.amount - Amount in KAS.
   * @param {string} [options.payload] - Optional transaction payload.
   * @param {string} [options.password] - Wallet password (if required by service).
   * @param {number} [options.priorityFeeKas] - Priority fee in KAS.
   * @returns {Promise<Object>} Transaction result.
   */
  async send(options) {
    return await walletService.send(options);
  }

  /**
   * Delete a wallet from storage.
   * @param {string} filename
   */
  async deleteWallet(filename) {
    return await storage.deleteWalletData(filename);
  }

  /** Get the extended private key (XPrv) of the active wallet.
   * @returns {Promise<string>} XPrv as hex string.
   */
  async getXprv() {
    return await walletService.getXprv();
  }

  /**
   * Get private keys for signing transactions manually.
   * Derives keys from the wallet's xprv for the active account.
   * @param {Object} [options] - Options
   * @param {number} [options.keyCount=10] - Number of receive keys
   * @param {number} [options.changeKeyCount=5] - Number of change keys
   * @returns {Promise<Array>} Array of PrivateKey objects
   */
  async getPrivateKeys(options) {
    return await walletService.getPrivateKeys(options);
  }

  /**
   * Access the mnemonic of the active wallet.
   */
  async getMnemonic() {
    return await walletService.getMnemonic();
  }

  /**
   * Access the spendable balance of the active wallet.
   */
  async getSpendableBalance() {
    return await walletService.getSpendableBalance();
  }

  /**
   * Access the active wallet instance if exposed by the service.
   */
  async getAllWallets() {
    return await walletService.getAllWallets();
  }

  /**
   * Access the Wallet class definition if available.
   * This allows advanced users to instantiate Wallet directly if needed.
   */
  get wallet() {
    return walletService.getWalletContext();
  }

  /** Access the receiving address of the active wallet. */
  get address() {
    return walletService.getReceivingAddress();
  }

  /**
   * Get the active account descriptor with receive and change addresses.
   * @returns {Promise<{ receiveAddress: string|null, changeAddress: string|null }>}
   */
  async getActiveAccount() {
    return await walletService.getActiveAccountAddresses();
  }

  /**
   * Access the wallet secret of the active wallet.
   */
  get walletSecret() {
    return walletService.getWalletSecret();
  }
}
