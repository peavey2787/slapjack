/**
 * Helper to convert hex strings to bytes (if not already in your wrapper utilities)
 */
export function hexToBytes(hex) {
  if (hex.length % 2 !== 0) throw new Error("Invalid hex string");
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

/**
 * Convert a Uint8Array or array of bytes to a lowercase hex string.
 * Per KKTP §5.1: All hex fields MUST be lowercase.
 * @param {Uint8Array|Array<number>} bytes - The bytes to convert.
 * @returns {string} Lowercase hex string.
 */
export function bytesToHex(bytes) {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0").toLowerCase())
    .join("");
}

/**
 * Validates and normalizes a hex string to lowercase.
 * Per KKTP §5.1: All hex fields MUST be lowercase.
 * @param {string} hex - The hex string to normalize.
 * @returns {string} Lowercase hex string.
 */
export function normalizeHex(hex) {
  if (typeof hex !== "string" || !/^[0-9a-fA-F]*$/.test(hex)) {
    throw new Error("Invalid hex string");
  }
  return hex.toLowerCase();
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

export function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export function normalizeKey(k) {
  if (k instanceof Uint8Array) {
    if (k.length === 32) return k;

    // handle Uint8Array of base64 text (length ~44)
    const asText = new TextDecoder().decode(k);
    if (/^[A-Za-z0-9+/=]+$/.test(asText)) {
      const b = base64ToBytes(asText);
      if (b.length === 32) return b;
    }
    return k;
  }

  if (typeof k === "string") {
    return /^[0-9a-f]+$/i.test(k) ? hexToBytes(k) : base64ToBytes(k);
  }

  return k;
}
