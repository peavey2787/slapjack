import { logError } from "./logs/logger.js";
// Core cryptographic and conversion helpers for the beacon

// Throws on error, never silently falls back
export async function sha256Hash(input) {
  // Accepts: string (hex or utf8) or Uint8Array
  let data;
  if (typeof input === "string") {
    // If hex string, convert to bytes
    if (/^[0-9a-fA-F]+$/.test(input) && input.length % 2 === 0) {
      data = hexToBytes(input);
    } else {
      data = new TextEncoder().encode(input);
    }
  } else if (input instanceof Uint8Array) {
    data = input;
  } else {
    throw new Error("sha256Hash: input must be string or Uint8Array");
  }
  // Browser only: use Web Crypto API
  if (
    typeof window !== "undefined" &&
    window.crypto &&
    window.crypto.subtle &&
    window.crypto.subtle.digest
  ) {
    try {
      const hashBuffer = await window.crypto.subtle.digest("SHA-256", data);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
    } catch (e) {
      logError({ msg: "sha256Hash (browser) failed", error: e });
      throw e;
    }
  }
  throw new Error(
    "sha256Hash: No supported crypto backend found (browser only)",
  );
}

// Convert hex string to byte array (validates input)
export function hexToBytes(hex) {
  if (
    typeof hex !== "string" ||
    hex.length % 2 !== 0 ||
    !/^[0-9a-fA-F]+$/.test(hex)
  ) {
    logError({ msg: "hexToBytes: Invalid hex input", hex });
    throw new Error("hexToBytes: Input must be even-length hex string");
  }
  const bytes = [];
  for (let i = 0; i < hex.length; i += 2) {
    const byte = parseInt(hex.substr(i, 2), 16);
    if (isNaN(byte)) {
      logError({
        msg: "hexToBytes: Invalid byte",
        index: i,
        byte: hex.substr(i, 2),
      });
      throw new Error("hexToBytes: Invalid byte");
    }
    bytes.push(byte);
  }
  return new Uint8Array(bytes);
}

// Convert byte array to position array
export function bytesToPositions(bytes, count) {
  const positions = [];
  for (let i = 0; i < count && i < bytes.length; i++) {
    positions.push(bytes[i]);
  }
  while (positions.length < count) {
    const index = positions.length % bytes.length;
    const offset = Math.floor(positions.length / bytes.length);
    positions.push((bytes[index] + offset * 17) % 256);
  }
  return positions;
}

// Convert hex to binary string (4 bits per hex char)
export function hexToBinary(hex) {
  return hex
    .split("")
    .map((char) => {
      return parseInt(char, 16).toString(2).padStart(4, "0");
    })
    .join("");
}

// Convert binary string to hex
export function binaryToHex(bin) {
  let hex = "";
  for (let i = 0; i < bin.length; i += 4) {
    const nibble = bin.substr(i, 4);
    hex += parseInt(nibble, 2).toString(16);
  }
  return hex;
}

/**
 * Extract a single bit from a hex hash at a given position (0-255)
 * Bit ordering: 0 = most significant bit (MSB), 255 = least significant bit (LSB)
 * @param {string} hexHash - 64-char hex string (256 bits)
 * @param {number} pos - Bit position (0 = MSB, 255 = LSB)
 * @returns {'0'|'1'}
 */
export function getBitFromHash(hexHash, pos) {
  if (
    typeof hexHash !== "string" ||
    hexHash.length !== 64 ||
    !/^[0-9a-fA-F]+$/.test(hexHash)
  ) {
    logError({ msg: "getBitFromHash: Invalid hexHash", hexHash });
    throw new Error("getBitFromHash: hexHash must be 64-char hex string");
  }
  if (typeof pos !== "number" || pos < 0 || pos > 255) {
    logError({ msg: "getBitFromHash: Invalid pos", pos });
    throw new Error("getBitFromHash: pos must be 0-255");
  }
  const bytes = hexToBytes(hexHash);
  const bitIndex = pos % (bytes.length * 8);
  const byteIndex = Math.floor(bitIndex / 8);
  const bitOffset = 7 - (bitIndex % 8); // MSB first
  const byte = bytes[byteIndex];
  return ((byte >> bitOffset) & 1).toString();
}
// --- Test vectors for SHA-256 correctness ---
export async function runSha256TestVectors() {
  const vectors = [
    {
      input: "",
      expected:
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    },
    {
      input: "abc",
      expected:
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    },
    {
      input: "The quick brown fox jumps over the lazy dog",
      expected:
        "d7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592",
    },
    {
      input: "The quick brown fox jumps over the lazy dog.",
      expected:
        "ef537f25c895bfa782526529a9b63d97aa631564d5d789c2b765448c8635fb6c",
    },
  ];
  for (const v of vectors) {
    const actual = await sha256Hash(v.input);
    if (actual !== v.expected) {
      logError({
        msg: "SHA-256 test vector failed",
        input: v.input,
        expected: v.expected,
        got: actual,
      });
      throw new Error("SHA-256 test vector failed");
    }
  }
  LogInfo({ msg: "SHA-256 test vectors passed" });
}

// Convert byte array to hex string
export function bytesToHex(bytes) {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
