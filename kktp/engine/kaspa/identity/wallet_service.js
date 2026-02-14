// wallet_service.js
import {
  Wallet,
  Resolver,
  kaspaToSompi,
  sompiToKaspaString,
  AccountsDiscoveryKind,
  Generator,
  XPrv,
  Mnemonic,
  PrivateKeyGenerator,
} from "../kas-wasm/kaspa.js";
import { storeWalletData, loadWalletData } from "./storage.js";
import * as utilities from "../utilities/utilities.js";
import { Logger, LogModule } from "../../../core/logger.js";

const DEFAULT_FILENAME = "default_wallet";
const defaultLogger = Logger.create(LogModule.identity.walletService);
let wallet = null;
let walletInitialized = false;
let walletSecret = null;
let accountId = null;
let filename = DEFAULT_FILENAME;
let currentNetworkId = null;
let currentAccountIndex = 0;
let currentReceivingAddress = null;
let log = (...args) => defaultLogger.log(...args);
let warn = (...args) => defaultLogger.warn(...args);
// Mutable balance callback – can be (re-)set after init via setOnBalanceChange()
let _onBalanceChange = null;
// State flags
let walletOpened = false;
let walletConnected = false;
let walletStarted = false;

/**
 * Get internal wallet context for advanced flows (UTXO selection, WASM tx builder, etc.)
 */
export function getWalletContext() {
  if (!wallet) return null;

  return {
    ...wallet, // Spread all properties/methods from the Wallet instance
    walletInitialized,
    accountId,
    filename,
    currentNetworkId,
    currentAccountIndex,
    currentReceivingAddress,
    log
  };
}

/** Get the current receiving address for the active account */
export function getReceivingAddress() {
  return currentReceivingAddress;
}

/**
 * Get the active account's receive and change addresses.
 * @returns {Promise<{ receiveAddress: string|null, changeAddress: string|null }>}
 */
export async function getActiveAccountAddresses() {
  if (!walletInitialized || !wallet) {
    return { receiveAddress: currentReceivingAddress || null, changeAddress: null };
  }

  try {
    const accounts = await wallet.accountsEnumerate({});
    if (!accounts?.accountDescriptors?.length) {
      return { receiveAddress: currentReceivingAddress || null, changeAddress: null };
    }

    const activeAccount = accounts.accountDescriptors[currentAccountIndex || 0];
    return {
      receiveAddress: activeAccount.receiveAddress ? String(activeAccount.receiveAddress) : null,
      changeAddress: activeAccount.changeAddress ? String(activeAccount.changeAddress) : null,
    };
  } catch (err) {
    warn("[WalletService] getActiveAccountAddresses failed:", err.message);
    // Fallback to cached receive address
    return { receiveAddress: currentReceivingAddress || null, changeAddress: null };
  }
}

/** Get the current wallet secret (password)
 * @returns {string|null} walletSecret
 */
export function getWalletSecret() {
  return walletSecret;
}

/**
 * Get a list of all wallet files/descriptors available.
 * @returns {Promise<Array>} Array of wallet descriptors (each has filename, title, etc.)
 */
export async function getAllWallets() {
  if (!wallet) {
    throw new Error("Wallet not initialized. Call init() first.");
  }
  try {
    const result = await wallet.walletEnumerate({});
    return result.walletDescriptors || [];
  } catch (err) {
    throw new Error(
      "Failed to enumerate wallets: " +
        (err && err.message ? err.message : err),
    );
  }
}

/**
 * Get the mnemonic phrase from storage for the given wallet filename and password.
 * @param {string} filename - Wallet filename.
 * @param {string} password - Password to decrypt wallet data.
 * @returns {Promise<string>} - The mnemonic phrase.
 */
export async function getMnemonic({ theFilename = "", password = "" } = {}) {
  if (theFilename.length === 0) {
    theFilename = filename;
  }
  if (password.length === 0) {
    password = walletSecret;
  }
  const walletData = await loadWalletData(theFilename, password);
  return walletData.mnemonic;
}

/**
 * Get the extended private key (XPrv) for the current wallet.
 * @returns {Promise<string>} - The XPrv as a string.
 */
export async function getXprv() {
  if (!walletInitialized || !wallet) {
    throw new Error("Wallet not initialized. Call init() first.");
  }
  const walletData = await loadWalletData(filename, walletSecret);
  const xPrv = XPrv.fromXPrv(walletData.xprv);
  return xPrv.toString();
}

/**
 * Get private keys for signing transactions.
 * This derives private keys from the wallet's xprv for the active account.
 * @param {number} [keyCount=10] - Number of receive keys to generate.
 * @param {number} [changeKeyCount=5] - Number of change keys to generate.
 * @returns {Promise<Array>} - Array of PrivateKey objects (WASM).
 */
export async function getPrivateKeys({ keyCount = 10, changeKeyCount = 5 } = {}) {
  if (!walletInitialized || !wallet) {
    throw new Error("Wallet not initialized. Call init() first.");
  }
  const walletData = await loadWalletData(filename, walletSecret);
  if (!walletData?.xprv) {
    throw new Error("No xprv found in wallet data. Cannot derive private keys.");
  }

  const xPrv = XPrv.fromXPrv(walletData.xprv);
  const keyGen = new PrivateKeyGenerator(xPrv, false, BigInt(currentAccountIndex), null);

  const keys = [];
  // Generate receive keys
  for (let i = 0; i < keyCount; i++) {
    keys.push(keyGen.receiveKey(i));
  }
  // Generate change keys
  for (let i = 0; i < changeKeyCount; i++) {
    keys.push(keyGen.changeKey(i));
  }

  return keys;
}

/**
 * Get the spendable (mature) balance for the current wallet account.
 * @returns {Promise<BigInt>} - The spendable balance in sompi (BigInt).
 */
export async function getSpendableBalance() {
  const res = await wallet.accountsGet({ accountId });

  let bal = null;

  if (res.account?.balance) {
    bal = res.account.balance;
  } else if (res.accounts?.[0]?.balance) {
    bal = res.accounts[0].balance;
  } else if (res.accountDescriptor?.balance) {
    bal = res.accountDescriptor.balance;
  }

  if (!bal || !bal.mature) {
    return 0n;
  }

  return BigInt(bal.mature);
}

/**
 * Initialize the Kaspa wallet with the given RPC client and network.
 * The provided rpcClient must already be connected.
 * Adds a balance event listener for UI/callback updates.
 * @param {Object} params
 * @param {Object} params.rpcClient - The Kaspa RPC client instance (must be connected).
 * @param {string} params.networkId - Network ID (e.g., 'mainnet', 'testnet-10').
 * @param {string|null} [params.balanceElementId] - Optional DOM element ID to update balance.
 * @param {function|null} [params.onBalanceChange] - Optional callback to receive balance updates.
 */
export function init({
  rpcClient,
  networkId,
  balanceElementId = null,
  onBalanceChange = null,
  logger = null,
} = {}) {
  if (walletInitialized) return walletInitialized;

  // Use the provided logger, or the module logger if not supplied
  if (typeof logger === "function") {
    log = logger;
    warn = logger;
  } else {
    log = (...args) => defaultLogger.log(...args);
    warn = (...args) => defaultLogger.warn(...args);
  }

  // Store the initial callback (if any) in the module-level variable
  if (typeof onBalanceChange === "function") {
    _onBalanceChange = onBalanceChange;
  }

  currentNetworkId = networkId;

  // 1. Construct wallet with proper options (use own Resolver in resolver mode to avoid cross-module class mismatch)
  wallet = new Wallet({
    resident: false,
    networkId,
    url: rpcClient?.url || undefined,
    resolver: rpcClient?.url ? undefined : new Resolver(),
  });

  if (rpcClient?.url) {
    log("Initializing wallet with direct connect to RPC URL:", rpcClient.url);
  } else {
    log("Initializing wallet with public node using RPC resolver.");
  }

  // 2. Add the balance event listener to update balance on changes.
  //    Uses the module-level _onBalanceChange so it always calls
  //    the latest registered callback (even if set after init).
  wallet.addEventListener("balance", (event) => {
    const bal = event?.data?.balance;

    if (bal && typeof bal.mature !== "undefined") {
      const matureBalance = sompiToKaspaString(bal.mature);

      // You can update your UI or call a callback here
      log("Balance changed:", matureBalance, "KAS");

      try {
        // Example: update a DOM element
        let balanceResult = null;
        if (balanceElementId) {
          balanceResult = document.getElementById(balanceElementId);
          balanceResult.textContent = `Balance:\n${matureBalance} KAS`;
        }
      } catch (err) {
        log("Error updating balance element:", err);
      }

      if (typeof _onBalanceChange === "function") {
        _onBalanceChange(matureBalance);
      }
    }
  });

  walletInitialized = true;
  return walletInitialized;
}

/**
 * Update (or set for the first time) the balance-change callback.
 * This is safe to call before or after init(). If the wallet is already
 * initialized the existing event listener will start calling the new callback
 * immediately on the next balance event.
 *
 * @param {Function|null} cb - The new callback, or null to clear it.
 */
export function setOnBalanceChange(cb) {
  _onBalanceChange = typeof cb === "function" ? cb : null;
}

/**
 * Close the wallet and reset internal state.
 */
export async function closeWallet() {
  try {
    await wallet.walletClose();
  } catch (err) {
    log("Error closing wallet:", err);
    throw err;
  }
  wallet = null;
  walletInitialized = false;
  walletSecret = null;
  accountId = null;
  currentAccountIndex = 0;
  filename = DEFAULT_FILENAME;
  log = () => {};
  walletOpened = false;
  walletConnected = false;
  walletStarted = false;
}

/**
 * Create a new wallet or import from mnemonic. Stores wallet data securely.
 * @param {Object} params
 * @param {string} params.password - Password to encrypt wallet data.
 * @param {string} [params.filename] - Optional wallet filename.
 * @param {string} [params.userHint] - Optional user hint for wallet.
 * @param {string|null} [params.mnemonic] - Optional mnemonic phrase to import.
 * @param {boolean} [params.storeMnemonic] - Whether to store mnemonic in storage.
 * @param {boolean} [params.discoverAddresses] - Whether to perform address discovery.
 * @returns {Promise<{mnemonic: string, address: string}>} - The mnemonic and receiving address.
 */
export async function createWallet({
  password,
  walletFilename = DEFAULT_FILENAME,
  userHint = "",
  mnemonic = null,
  storeMnemonic = false,
  discoverAddresses = true,
}) {
  if (!walletInitialized) {
    throw new Error("Wallet not initialized. Call init() first.");
  }

  // 1. Set wallet secret and filename
  walletSecret = password;
  filename = walletFilename || DEFAULT_FILENAME;

  // 2. Try to open the wallet (if it exists)
  try {
    if (!walletOpened) {
      log("Opening wallet...");
      const descriptors = await wallet.walletOpen({
        accountDescriptors: true,
        filename,
        walletSecret,
      });
      log("Wallet accounts:", descriptors);
      if (descriptors) {
        walletOpened = true;
        log("Wallet opened.");
      }
    }

    if (!walletConnected) {
      // 3. Connect and start wallet
      log("Connecting wallet...");
      await wallet.connect();
      walletConnected = true;
      log("Wallet connected.");
    }

    if (!walletStarted) {
      log("Starting wallet...");
      await wallet.start();
      walletStarted = true;
      log("Wallet started.");
    }

    // 4. Activate the account to get events like balance changes
    const address = await activateAccount();

    return { address: address.toString() };
  } catch (err) {
    // If wallet doesn't exist, create a new one
    return await _createNewWallet({
      password,
      walletFilename,
      userHint,
      mnemonic,
      storeMnemonic,
      discoverAddresses,
    });
  }
}

/**
 * Internal function to create a new wallet.
 * @param {Object} params
 * @param {string} params.password - Password to encrypt wallet data.
 * @param {string} params.filename - Wallet filename.
 * @param {string} params.userHint - User hint for wallet.
 * @param {string|null} params.mnemonic - Mnemonic phrase to import.
 * @param {boolean} params.storeMnemonic - Whether to store mnemonic in storage.
 * @param {boolean} params.discoverAddresses - Whether to perform address discovery.
 * @returns {Promise<{mnemonic: string, address: string}>} - The mnemonic and receiving address.
 */
async function _createNewWallet({
  password,
  walletFilename = DEFAULT_FILENAME,
  userHint = "",
  mnemonic = null,
  storeMnemonic = false,
  discoverAddresses = true,
}) {
  log("Creating new wallet...");

  // 1. Create or import mnemonic
  const mnemonicPhrase = mnemonic || _generateMnemonic(24);

  // 2. Create wallet file
  filename = walletFilename;
  try {
    const descriptor = await wallet.walletCreate({
      filename,
      overwriteWalletStorage: false,
      title: filename,
      userHint,
      walletSecret: password,
    });
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    if (msg.includes("Wallet already exists")) {
      // Suppress this specific error, do nothing
    } else {
      // Propogate the unknown error
      throw new Error("Error creating wallet: " + msg);
    }
  }

  // 3. Open wallet
  if (!walletOpened) {
    log("Opening newly created wallet...");
    await wallet.walletOpen({ filename, walletSecret });
    walletOpened = true;
    log("Wallet opened.");
  }

  // 4. Insert mnemonic key
  let prvKeyData = await wallet.prvKeyDataCreate({
    walletSecret,
    kind: "mnemonic",
    mnemonic: mnemonicPhrase,
  });

  // 5. Create account
  let account = await wallet.accountsCreate({
    walletSecret,
    type: "bip32",
    accountName: "Account-B",
    prvKeyDataId: prvKeyData.prvKeyDataId,
  });

  accountId = account.accountDescriptor.accountId;

  // 6. Get extended private key for address derivation and diffie-hellman encryption
  const xprv = await _getXPrv(mnemonicPhrase);
  const xPrvString = xprv.toString();

  // 7. Store XPrv and optionally mnemonic securely in IndexedDB
  if (storeMnemonic) {
    await storeWalletData(
      { filename, mnemonic: mnemonicPhrase, xprv: xPrvString },
      password,
    );
  } else {
    await storeWalletData({ filename, xprv: xPrvString }, password);
  }

  // 8. Connect and start wallet
  if (!walletConnected) {
    log("Connecting wallet...");
    await wallet.connect();
    walletConnected = true;
    log("Wallet connected.");
  }

  if (!walletStarted) {
    log("Starting wallet...");
    await wallet.start();
    walletStarted = true;
    log("Wallet started.");
  }

  // 9. Optionally, perform accounts discovery to sync with network
  // if you are importing existing wallet
  if (discoverAddresses) {
    log("Performing accounts discovery...");
    const results = await wallet.accountsDiscovery({
      accountScanExtent: 10, // scan first 10 accounts
      addressScanExtent: 50, // scan first 50 addresses per account
      bip39_mnemonic: mnemonicPhrase,
      discoveryKind: AccountsDiscoveryKind.BIP44,
    });
    log("Accounts discovery completed.");
  }

  // 10. Activate the account to get events like balance changes
  const address = await activateAccount();

  log("Wallet created and data stored securely.");

  return { address: address.toString(), mnemonic: mnemonicPhrase };
}

/**
 * Activate the specified account index (default 0) to enable balance tracking.
 * @param {number} [accountIndex=0] - The account index to activate.
 * @returns {Promise<string>} - The receiving address of the activated account.
 */
export async function activateAccount(accountIndex = 0) {
  // 10. Activate account to enable balance tracking
  log("Activating account...");
  currentAccountIndex = accountIndex;
  const accounts = await wallet.accountsEnumerate();
  accountId = accounts.accountDescriptors[accountIndex].accountId;
  const address = accounts.accountDescriptors[accountIndex].receiveAddress;
  await wallet.accountsActivate({ accountId });
  log("Account activated. Receiving address:", address);
  currentReceivingAddress = address.toString();
  return address;
}

/**
 * Estimate the transaction fee for a send operation.
 * Uses the SDK's Generator to calculate accurate mass and fees based on actual UTXOs.
 * @param {Object} params
 * @param {string} params.amount - Amount in KAS to send
 * @param {string} params.toAddress - Destination address
 * @param {string} [params.payload] - Optional payload (hex string or UTF-8 text)
 * @param {string} [params.priorityFeeKas] - Optional priority fee in KAS (extra on top of base fee)
 * @returns {Promise<{ mass: bigint, fees: bigint, feesKas: string, priorityFee: bigint, baseFee: bigint }>}
 */
export async function estimateTransactionFee({
  amount,
  toAddress,
  payload,
  priorityFeeKas,
}) {
  // Validate inputs
  if (toAddress == null || toAddress === "") {
    throw new Error("Invalid address: " + toAddress);
  }
  if (amount == null || isNaN(Number(amount))) {
    throw new Error(amount, " Kas, Amount must be >= MIN_KAS_AMOUNT");
  }

  // Get account info
  const accounts = await wallet.accountsEnumerate({});
  if (!accounts.accountDescriptors?.length) {
    throw new Error("No accounts found in wallet.");
  }
  const activeAccount = accounts.accountDescriptors[currentAccountIndex];
  const changeAddress = activeAccount.changeAddress;
  const receiveAddress = activeAccount.receiveAddress;

  // Validate addresses but keep them as strings to avoid cross-WASM-instance class mismatches.
  utilities.validateAddress(changeAddress);
  utilities.validateAddress(toAddress);

  // Get UTXOs for the account addresses
  log("Fetching UTXOs for addresses...");
  const addresses = [receiveAddress, changeAddress].filter(Boolean);
  const utxoResult = await wallet.rpc.getUtxosByAddresses(addresses);
  const utxoEntries = Array.isArray(utxoResult)
    ? utxoResult
    : Array.isArray(utxoResult?.entries)
      ? utxoResult.entries
      : [];

  if (utxoEntries.length === 0) throw new Error("No UTXOs...");

  // Match the official SDK example: sort by amount ascending.
  utxoEntries.sort((a, b) => (a.amount > b.amount ? 1 : -1));

  log(`UTXOs fetched: ${utxoEntries.length} entries.`);

  // Build output
  const amountSompi = kaspaToSompi(amount);
  const outputs = [
    {
      // Pass as string (validated above)
      address: String(toAddress),
      amount: amountSompi,
    },
  ];

  // Priority fee (extra on top of base network fee)
  let priorityFee = 0n;
  if (priorityFeeKas != null && priorityFeeKas !== "") {
    priorityFee = kaspaToSompi(priorityFeeKas);
  }

  // Prepare payload if provided
  let payloadHex = undefined;
  if (payload) {
    // Check if it's already hex or needs conversion
    if (/^[0-9a-fA-F]*$/.test(payload) && payload.length % 2 === 0) {
      payloadHex = payload;
    } else {
      // Convert UTF-8 to hex
      payloadHex = utilities.stringToHex(payload);
    }
  }

  const settings = {
    entries: utxoEntries,
    utxoEntries: utxoEntries,
    outputs,
    changeAddress: String(changeAddress),
    priorityFee,
    payload: payloadHex,
    networkId: currentNetworkId,
  };

  let estimate;
  try {
    const generator = new Generator(settings);
    estimate = await generator.estimate();
    try {
      generator.free();
    } catch {
      /* ignore */
    }
    log("Generator estimate completed.");
  } catch (err) {
    throw new Error(
      "Generator estimate failed: " +
        (err && err.message ? err.message : String(err)),
    );
  }

  // estimate contains: { mass, fees, ... } from GeneratorSummary
  const totalFees = estimate.fees ?? 0n;
  const mass = estimate.mass ?? 0n;
  const baseFee = totalFees - priorityFee;

  return {
    mass,
    fees: totalFees,
    feesKas: sompiToKaspaString(totalFees),
    priorityFee,
    baseFee,
    utxos: utxoEntries,
  };
}

/**
 * Send a transaction from the wallet.
 * @param {Object} params
 * @param {string|number|BigInt} params.amount - Amount in KAS to send.
 * @param {string|Object} params.toAddress - Destination address (string or Address object).
 * @param {string} [params.payload] - Optional payload string (will be hex encoded).
 * @param {string|number|BigInt} [params.priorityFeeKas] - Optional extra priority fee in KAS.
 * @returns {Promise<Object>} - The transaction result.
 */
export async function send({ amount, toAddress, payload, priorityFeeKas }) {
  if (!walletInitialized || !wallet) {
    throw new Error("Wallet not initialized. Call init() first.");
  }

  // Normalize toAddress
  const toAddressObj = utilities.validateAddress(toAddress);

  // Determine priority fee:
  // - If custom fee provided: use it as extra priority fee on top of base network fee
  // - If no custom fee: use 0 (dust-floor / minimum required by network based on mass)
  // - Smallest amount I've seen send successfully is 0.0000019 KAS without any payload
  let priorityFeeSompi = 0n;
  if (priorityFeeKas > 0) {
    priorityFeeSompi = kaspaToSompi(priorityFeeKas);
  }

  // Convert amount to sompi and ensure BigInt
  let amountSompi;
  amountSompi = kaspaToSompi(amount.toString());
  if (amountSompi <= 0n) {
    throw new Error("Amount must be greater than zero.");
  }

  // Ensure priorityFeeSompi is BigInt
  let priorityFeeSompiChecked = priorityFeeSompi;
  if (typeof priorityFeeSompiChecked !== "bigint") {
    priorityFeeSompiChecked = BigInt(priorityFeeSompiChecked);
  }

  // Build request - priorityFeeSompi is extra fee on top of the base network fee
  const sendRequest = {
    walletSecret: walletSecret,
    accountId: accountId,
    priorityFeeSompi: priorityFeeSompiChecked,
    destination: [
      {
        address: toAddressObj,
        amount: amountSompi,
      },
    ],
  };

  // Payload
  if (payload) {
    if (!utilities.validatePayload(payload)) {
      throw new Error("Payload must be a string and <= 32KB");
    }
    const hex = utilities.stringToHex(payload);
    if (hex.length % 2 !== 0) {
      throw new Error("Invalid hex payload");
    }
    if (hex.length / 2 > 32 * 1024) {
      throw new Error("Payload too large");
    }
    sendRequest.payload = hex;
  }

  try {
    return await wallet.accountsSend(sendRequest);
  } catch (err) {
    const causeMsg = err && err.message ? err.message : String(err);
    throw new Error(`Transaction failed: ${causeMsg}`, { cause: err });
  }
}

/**
 * Generate a new receiving or change address for the current account.
 * @param {boolean} [change=false] - If true, generate a change address; otherwise, receiving address.
 * @returns {Promise<string>} - The new address as a string.
 */
export async function generateNewAddress(change = false) {
  const addr = await wallet.accountsCreateNewAddress({
    accountId: accountId,
    networkId: wallet.networkId,
    addressKind: change ? "change" : "receive",
  });
  return addr.address;
}

/**
 * Delete wallet data from IndexedDB by filename
 * @param {string} filename - key for the stored wallet
 * @returns {Promise<void>} Resolves when deletion is complete
 */
export async function deleteWalletData(filename) {
  // 1. Remove localStorage entries
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.includes(filename)) {
      localStorage.removeItem(key);
    }
  }

  // 2. Delete IndexedDB database used by Kaspa WASM
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase("kaspa_wallet_db");
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("Delete blocked"));
  });
}

/**
 * Generate a random BIP39 mnemonic phrase.
 * @param {number} [wordCount=24] - Number of words in the mnemonic.
 * @returns {string} The generated mnemonic phrase.
 */
function _generateMnemonic(wordCount = 24) {
  const mnemonic = Mnemonic.random(wordCount);
  return mnemonic.phrase;
}

/**
 * Derive an XPrv from a mnemonic phrase and optional passphrase.
 * @param {string} mnemonicPhrase - BIP39 mnemonic phrase.
 * @param {string|null} [passphrase=null] - Optional passphrase.
 * @returns {XPrv} The derived XPrv object.
 */
function _getXPrv(mnemonicPhrase, passphrase = null) {
  const seed = passphrase
    ? new Mnemonic(mnemonicPhrase).toSeed(passphrase)
    : new Mnemonic(mnemonicPhrase).toSeed();
  const xPrv = new XPrv(seed);
  return xPrv;
}
