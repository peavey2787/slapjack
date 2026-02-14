import * as secp from "https://esm.sh/@noble/secp256k1";
import {
  signMessage,
  verifyMessage,
  XPrv,
  PrivateKeyGenerator,
  PublicKeyGenerator,
  Address,
  NetworkType,
} from "../kas-wasm/kaspa.js";

const MAX_PAYLOAD_BYTES = 32 * 1024; // 32KB
const NETWORK = "testnet";

/** * Validate and normalize a Kaspa address.
 * @param {string|Address} address - The address to validate.
 * @returns {Address} The validated Address object.
 * @throws {Error} If the address is invalid.
 */
export function validateAddress(address) {
  if (address == null || address === "") {
    throw new Error("Invalid address: " + address);
  }
  if (typeof address === "string") {
    try {
      address = new Address(address);
      return address;
    } catch (err) {
      throw new Error("Invalid address format: " + address);
    }
  }
  return address;
}

/**
 * Validate a payload string for Kaspa transaction (must be string and <= 32KB).
 * @param {string} payload - The payload string to validate.
 * @returns {boolean} True if valid, false otherwise.
 */
export function validatePayload(payload) {
  if (typeof payload !== "string") return false;
  if (payload.length > MAX_PAYLOAD_BYTES * 2) return false;
  return true;
}

/**
 * Convert optional payload string to hex (or accept already-hex).
 * Returns undefined when no payload.
 */
export function payloadToHex(payload) {
  if (!payload) return undefined;

  let str = String(payload).trim();

  // ADD THIS: Handle the 0x prefix if the dev sends it
  if (str.startsWith("0x")) str = str.slice(2);

  // If already hex and even length, keep it
  if (/^[0-9a-fA-F]*$/.test(str) && str.length % 2 === 0)
    return str.toLowerCase();

  // Otherwise treat as UTF-8 text
  return stringToHex(str).toLowerCase();
}

/**
 * Convert a JS string to a hex-encoded byte string (UTF-8).
 * @param {string} str - The string to encode.
 * @returns {string} Hex-encoded string.
 */
export function stringToHex(str) {
  // Convert a JS string to a hex-encoded byte string (UTF-8)
  return Array.from(new TextEncoder().encode(str))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Convert a hex-encoded string (UTF-8) to a JS string.
 * @param {string} hex - The hex string to decode.
 * @returns {string} Decoded string.
 */
export function hexToString(hex) {
  // Remove optional "0x" prefix
  if (hex.startsWith("0x")) hex = hex.slice(2);

  // Convert hex → bytes → UTF‑8 string
  const bytes = new Uint8Array(
    hex.match(/.{1,2}/g).map((byte) => parseInt(byte, 16)),
  );

  return new TextDecoder().decode(bytes);
}

/**
 * Convert a Uint8Array or array of bytes to a hex string.
 * @param {Uint8Array|Array<number>} bytes - The bytes to convert.
 * @returns {string} Hex string.
 */
export function bytesToHex(bytes) {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Convert a hex string to a Uint8Array of bytes.
 * @param {string} hex - The hex string to convert.
 * @returns {Uint8Array} Byte array.
 */
export function hexToBytes(hex) {
  if (hex.startsWith("0x")) hex = hex.slice(2);
  if (hex.length !== 64 && hex.length !== 66) {
    throw new Error(
      "Key must be 32 bytes (64 hex chars) or compressed secp256k1 public key (66 hex chars)",
    );
  }
  const arr = new Uint8Array(hex.length / 2);
  for (let i = 0; i < arr.length; i++) {
    arr[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return arr;
}

/**
 * Convert a hex string to a UTF-8 string.
 * @param {string} hex
 * @returns {string}
 */
export function hexToUtf8(hex) {
  if (typeof hex !== "string" || hex.length === 0) return "";
  if (hex.length % 2 !== 0) throw new Error("Invalid hex string length");
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return new TextDecoder().decode(bytes);
}

/** Dehydrate a transaction object into a lightweight summary.
 * @param {Object} tx - The transaction object.
 * @param {Object} block - The block containing the transaction.
 * @return {Object} Dehydrated transaction summary.
 */
export function dehydrateTx({ tx, block, decodedPayload }) {
  if (!tx) {
    return null;
  }
  const txData = {
    txid: tx.verboseData.transactionId,
    timestamp: tx.verboseData.blockTime,
    payload: tx.payload,
  };
  if (decodedPayload) {
    txData.decodedPayload = decodedPayload;
  }
  if (block) {
    txData.blockHash = block.header.hash;
    txData.blueScore = block.header.blueScore;
    txData.blockDaaScore = block.header.daaScore;
  }
  return txData;
}

/** * Dehydrate a block object into a lightweight summary.
 * Ensures UI fields like hash, timestamp, and txCount are preserved
 * without carrying the massive transaction payload.
 * * @param {Object} block - The raw block object from RPC or Indexer.
 * @return {Object|null} Dehydrated block summary.
 */
export function dehydrateBlock(block) {
  if (!block) return null;

  // Use the header if it exists, otherwise the root
  const h = block.header || block;

  // OPTIMIZATION: Extract parents only if they exist at Level 0
  // Avoiding Array.from if possible saves allocation cycles
  // causes higher cpu usage
  /*const rawParents = h.parentsByLevel?.[0] || h.parents;
  const parentHashes = rawParents
    ? (Array.isArray(rawParents) ? rawParents : Array.from(rawParents)).map(
        (p) => p.toString(),
      )
    : [];
  */

  // Create a clean, flat object with NO references to the original WASM block
  const result = {
    hash: (h.hash || "").toString(),
    timestamp: Number(h.timestamp || 0),
    blueScore: Number(h.blueScore || 0),
    daaScore: Number(h.daaScore || 0),
    parents: [],
    txCount: Number(
      block.txCount ?? h.transactionCount ?? (block.transactions?.length || 0),
    ),
    isChainBlock: !!(block.isChainBlock || block.verboseData?.isChainBlock),
  };

  // HELP THE GARBAGE COLLECTOR:
  // We return the clean object. The original 'block' goes out of scope.
  return result;
}

/**
 * Get the compressed public key bytes from a private key hex string.
 * @param {string} prvKeyHex - Private key as hex string.
 * @returns {Uint8Array} Compressed public key bytes.
 */
export function getPublicKeyBytes(prvKeyHex) {
  const prvKeyBytes = hexToBytes(prvKeyHex);
  const pubKeyBytes = secp.getPublicKey(prvKeyBytes, true); // compressed
  return pubKeyBytes;
}

/**
 * Get the compressed public key as a hex string from a private key hex string.
 * @param {string} prvKeyHex - Private key as hex string.
 * @returns {string} Compressed public key as hex string.
 */
export function getPublicKeyHex(prvKeyHex) {
  const pubKeyBytes = getPublicKeyBytes(prvKeyHex);
  return bytesToHex(pubKeyBytes);
}

/**
 * Get the private key bytes from an XPrv instance or hex string.
 * @param {XPrv|string} xPrv - XPrv instance or hex string.
 * @returns {Uint8Array} Private key bytes.
 */
export function getPrivateKeyBytes(xPrv) {
  if (xPrv instanceof XPrv) {
    // xPrv.privateKey is a hex string
    return hexToBytes(xPrv.privateKey);
  }
  if (typeof xPrv === "string") {
    return hexToBytes(xPrv);
  }
  throw new TypeError(
    "getPrivateKeyBytes requires an XPrv instance or hex string",
  );
}

/**
 * Get the private key as a hex string from an XPrv, hex string, or Uint8Array.
 * @param {XPrv|string|Uint8Array} xPrv - XPrv, hex string, or byte array.
 * @returns {string} Private key as hex string.
 */
export function getPrivateKeyHex(xPrv) {
  if (xPrv instanceof XPrv) {
    return xPrv.privateKey;
  }
  if (typeof xPrv === "string") {
    return xPrv;
  }
  if (typeof xPrv === "Uint8Array") {
    return bytesToHex(xPrv);
  }
  throw new TypeError(
    "getPrivateKeyHex requires an XPrv instance, hex string, or Uint8Array",
  );
}

/**
 * Derive a receiving child key pair and address from an XPrv hex.
 * @param {Object} params
 * @param {string} params.xprvHex - Extended private key as hex string.
 * @param {string} [params.network=NETWORK] - Network name or ID.
 * @param {bigint} [params.accountIndex=0n] - Account index (BigInt).
 * @param {number} [params.index=0] - Child index.
 * @returns {Promise<{privateKey: string, publicKey: string, address: string}>} Key pair and address.
 */
export async function deriveReceivingChildKeyPair({
  xprvHex,
  network = NETWORK,
  accountIndex = 0n,
  index = 0,
  branch = 0,
}) {
  if (typeof index !== "number" || index < 0) {
    throw new Error("Index must be a non-negative integer");
  }

  // Generate private key
  const gen = new PrivateKeyGenerator(xprvHex, false, accountIndex);
  const privKey = gen.receiveKey(index);

  // Generate public key
  const pubKey = privKey.toPublicKey();

  // Generate address
  const pubGen = PublicKeyGenerator.fromMasterXPrv(
    xprvHex,
    false,
    accountIndex,
  );
  const addr = pubGen.receiveAddressAsString(network, index);

  return {
    privateKey: privKey.toString(),
    publicKey: pubKey.toString(),
    address: addr,
  };
}

/**
 * Manually derive keys using raw XPrv derivation.
 */
export async function deriveChildKeyPair({
  xprvHex,
  network = "testnet-10",
  accountIndex = 0n,
  branch = 0,
  index = 0,
}) {
  const masterXPrv = XPrv.fromXPrv(xprvHex);

  // Chain the derivation and free the intermediate objects
  const p = masterXPrv.deriveChild(44, true);
  const c = p.deriveChild(111111, true);
  const a = c.deriveChild(Number(accountIndex), true);
  const b = a.deriveChild(branch, false);
  const leaf = b.deriveChild(index, false);

  const privKey = leaf.toPrivateKey();
  const pubKey = privKey.toPublicKey();

  const networkType = network.includes("mainnet")
    ? NetworkType.Mainnet
    : NetworkType.Testnet;
  const address = privKey.toAddress(networkType).toString();

  const result = {
    privateKey: privKey.toString(),
    publicKey: pubKey.toString(),
    address: address,
  };

  // CLEANUP: Essential for WASM
  [masterXPrv, p, c, a, b, leaf].forEach((obj) => obj.free());

  return result;
}

/**
 * Sign a message with a private key hex string.
 * @param {string} privateKeyHex - Private key as hex string.
 * @param {string} message - Message to sign.
 * @returns {Promise<string>} Signature as hex string.
 */
export async function signMessageWithPrivateKeyHex(privateKeyHex, message) {
  const signature = await signMessage({ privateKey: privateKeyHex, message });
  return signature;
}

/**
 * Verify a message signature with a public key hex string.
 * @param {string} publicKeyHex - Public key as hex string.
 * @param {string} message - Message to verify.
 * @param {string} signatureHex - Signature as hex string.
 * @returns {Promise<boolean>} True if valid, false otherwise.
 */
export async function verifyMessageWithPublicKeyHex(
  publicKeyHex,
  message,
  signatureHex,
) {
  const isValid = await verifyMessage({
    publicKey: publicKeyHex,
    message,
    signature: signatureHex,
  });
  return isValid;
}
