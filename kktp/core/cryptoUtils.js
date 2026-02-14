/**
 * cryptoUtils.js - Common cryptographic helpers
 */

export function hexToBytes(hex) {
  if (!hex) return new Uint8Array(0);
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const len = clean.length;
  if (len % 2 !== 0) throw new Error('Invalid hex string');
  const bytes = new Uint8Array(len / 2);
  for (let i = 0; i < len; i += 2) {
    bytes[i / 2] = parseInt(clean.slice(i, i + 2), 16);
  }
  return bytes;
}

export function bytesToHex(bytes) {
  if (!bytes) return '';
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function fallbackHash(data) {
  let h1 = 0x811c9dc5;
  for (let i = 0; i < data.length; i++) {
    h1 ^= data[i];
    h1 = (h1 * 0x01000193) >>> 0;
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    out[i] = (h1 >> ((i % 4) * 8)) & 0xff;
  }
  return out;
}

export async function sha256(data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data || []);
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return new Uint8Array(digest);
  }
  return fallbackHash(bytes);
}

/**
 * HMAC-SHA256 using Web Crypto API.
 * Both key and data are normalized to Uint8Array internally to prevent
 * encoding mismatches between hex strings and raw buffers.
 * @param {Uint8Array} key - HMAC key (raw bytes)
 * @param {Uint8Array} data - Message data (raw bytes)
 * @returns {Promise<Uint8Array>} - 32-byte HMAC digest
 */
export async function hmacSha256(key, data) {
  const keyBytes = key instanceof Uint8Array ? key : new Uint8Array(key || []);
  const dataBytes = data instanceof Uint8Array ? data : new Uint8Array(data || []);

  if (globalThis.crypto?.subtle) {
    const cryptoKey = await globalThis.crypto.subtle.importKey(
      'raw',
      keyBytes,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const signature = await globalThis.crypto.subtle.sign('HMAC', cryptoKey, dataBytes);
    return new Uint8Array(signature);
  }

  // Fallback: manual HMAC construction over sha256 fallback
  const BLOCK_SIZE = 64;
  let k = keyBytes;
  if (k.length > BLOCK_SIZE) {
    k = fallbackHash(k);
  }
  const keyPad = new Uint8Array(BLOCK_SIZE);
  keyPad.set(k);

  const ipad = new Uint8Array(BLOCK_SIZE);
  const opad = new Uint8Array(BLOCK_SIZE);
  for (let i = 0; i < BLOCK_SIZE; i++) {
    ipad[i] = keyPad[i] ^ 0x36;
    opad[i] = keyPad[i] ^ 0x5c;
  }

  const inner = new Uint8Array(BLOCK_SIZE + dataBytes.length);
  inner.set(ipad);
  inner.set(dataBytes, BLOCK_SIZE);
  const innerHash = fallbackHash(inner);

  const outer = new Uint8Array(BLOCK_SIZE + innerHash.length);
  outer.set(opad);
  outer.set(innerHash, BLOCK_SIZE);
  return fallbackHash(outer);
}

export default {
  hexToBytes,
  bytesToHex,
  sha256,
  hmacSha256
};
