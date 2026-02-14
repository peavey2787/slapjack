// encryption.js
import {
  encryptXChaCha20Poly1305,
  decryptXChaCha20Poly1305,
} from "../kas-wasm/kaspa.js";

/**
 * Enterprise-grade encryption wrapper using Kaspa WASM XChaCha20-Poly1305
 * @param {string} plaintext - The message to encrypt
 * @param {string} password - The password/key material
 * @returns {object} { version, cipherText }
 */
export function encryptMessage(plaintext, password) {
  if (typeof plaintext !== "string" || typeof password !== "string") {
    throw new TypeError("encryptMessage requires string inputs");
  }

  try {
    const cipherText = encryptXChaCha20Poly1305(plaintext, password);
    return {
      version: 1, // bump if you change format later
      cipherText,
    };
  } catch (err) {
    throw new Error(`Encryption failed: ${err.message}`);
  }
}

/**
 * Enterprise-grade decryption wrapper using Kaspa WASM XChaCha20-Poly1305
 * @param {object|string} payload - Either raw cipherText string or {version, cipherText}
 * @param {string} password - The password/key material
 * @returns {string} plaintext
 */
export function decryptMessage(payload, password) {
  if (!password || typeof password !== "string") {
    throw new TypeError("decryptMessage requires a string password");
  }

  let cipherText;
  if (typeof payload === "string") {
    cipherText = payload;
  } else if (payload && typeof payload === "object" && payload.cipherText) {
    if (payload.version !== 1) {
      throw new Error(`Unsupported payload version: ${payload.version}`);
    }
    cipherText = payload.cipherText;
  } else {
    throw new TypeError(
      "decryptMessage requires a cipherText string or payload object",
    );
  }

  try {
    return decryptXChaCha20Poly1305(cipherText, password);
  } catch (err) {
    let msg = err && err.message ? err.message : String(err);
    // Check for the specific "Unable to decrypt" failure
    if (msg.includes("Unable to decrypt")) {
      msg += " (likely due to the wrong password or corrupted data)";
    }
    throw new Error(`Decryption failed: ${msg}`);
  }
}
