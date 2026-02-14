// storage.js
import { encryptMessage, decryptMessage } from "../crypto/encryption.js";

const DB_NAME = "KaspaWalletDB";
const STORE_NAME = "MetaDataStore";
const DB_VERSION = 2;

/**
 * Initialize IndexedDB
 */
function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "filename" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Store wallet data securely in IndexedDB
 * @param {object} walletData - { filename, mnemonic, xprv }
 * @param {string} masterPassword - encryption key
 */
export async function storeWalletData(walletData, masterPassword) {
  const db = await openDB();
  const tx = db.transaction(STORE_NAME, "readwrite");
  const store = tx.objectStore(STORE_NAME);

  const encryptedPayload = encryptMessage(
    JSON.stringify(walletData),
    masterPassword,
  );

  store.put({
    filename: walletData.filename,
    payload: encryptedPayload,
  });

  return tx.complete;
}

/**
 * Load and decrypt wallet data from IndexedDB
 * @param {string} filename - key for the stored wallet
 * @param {string} masterPassword - decryption key
 * @returns {object} walletData
 */
export async function loadWalletData(filename, masterPassword) {
  const db = await openDB();
  const tx = db.transaction(STORE_NAME, "readonly");
  const store = tx.objectStore(STORE_NAME);

  return new Promise((resolve, reject) => {
    const request = store.get(filename);
    request.onsuccess = () => {
      const record = request.result;
      if (!record) {
        return reject(new Error(`No wallet found for filename: ${filename}`));
      }
      try {
        const plaintext = decryptMessage(record.payload, masterPassword);
        resolve(JSON.parse(plaintext));
      } catch (err) {
        reject(new Error(`Failed to decrypt wallet data: ${err.message}`));
      }
    };
    request.onerror = () => reject(request.error);
  });
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
