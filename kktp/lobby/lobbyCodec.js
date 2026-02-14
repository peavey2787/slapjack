/**
 * LobbyCodec - Encryption/Decryption for group messages
 *
 * Uses XChaCha20-Poly1305 with AAD for authenticated encryption:
 * - AAD = groupMailboxId || keyVersion (domain separation)
 * - Nonce: 24 bytes random per message
 *
 * @module kktp/lobby/lobbyCodec
 */

import { xchacha20poly1305 } from "https://esm.sh/v135/@noble/ciphers/chacha";

/**
 * @typedef {Object} EncryptedGroupMessage
 * @property {string} type - Always "group_message"
 * @property {number} version - Protocol version
 * @property {string} senderPubSig - Sender's public signing key
 * @property {number} keyVersion - Key version used for encryption
 * @property {string} nonce - 24-byte nonce (hex)
 * @property {string} ciphertext - Encrypted message (hex)
 * @property {number} timestamp - Message timestamp
 */

export class LobbyCodec {
  constructor() {
    this.version = 1;
  }

  /**
   * Encrypt a message for the group
   * @param {string} plaintext - Message to encrypt
   * @param {Uint8Array} groupKey - 32-byte group key
   * @param {string} groupMailboxId - Group mailbox ID (for AAD)
   * @param {number} keyVersion - Current key version (for AAD)
   * @param {string} senderPubSig - Sender's public signing key
   * @returns {Promise<EncryptedGroupMessage>}
   */
  async encryptGroupMessage(
    plaintext,
    groupKey,
    groupMailboxId,
    keyVersion,
    senderPubSig,
  ) {
    // Validate key
    if (!(groupKey instanceof Uint8Array) || groupKey.length !== 32) {
      throw new Error("Group key must be 32 bytes");
    }

    // Generate random nonce (24 bytes for XChaCha20)
    const nonce = crypto.getRandomValues(new Uint8Array(24));

    // Construct AAD for domain separation
    // AAD = groupMailboxId || keyVersion
    const aad = this._constructAAD(groupMailboxId, keyVersion);

    // Encrypt
    const chacha = xchacha20poly1305(groupKey, nonce, aad);
    const plaintextBytes = new TextEncoder().encode(plaintext);
    const ciphertext = chacha.encrypt(plaintextBytes);

    return {
      type: "group_message",
      version: this.version,
      senderPubSig,
      keyVersion,
      nonce: this._bytesToHex(nonce),
      ciphertext: this._bytesToHex(ciphertext),
      timestamp: Date.now(),
    };
  }

  /**
   * Decrypt a group message
   * @param {EncryptedGroupMessage} encrypted - Encrypted message object
   * @param {Uint8Array} groupKey - 32-byte group key
   * @param {string} groupMailboxId - Group mailbox ID (for AAD)
   * @returns {Promise<string>} - Decrypted plaintext
   */
  async decryptGroupMessage(encrypted, groupKey, groupMailboxId) {
    // Validate key
    if (!(groupKey instanceof Uint8Array) || groupKey.length !== 32) {
      throw new Error("Group key must be 32 bytes");
    }

    // Validate message structure
    if (
      !encrypted ||
      encrypted.type !== "group_message" ||
      !encrypted.nonce ||
      !encrypted.ciphertext
    ) {
      throw new Error("Invalid encrypted message structure");
    }

    // Reconstruct AAD
    const aad = this._constructAAD(groupMailboxId, encrypted.keyVersion);

    // Parse nonce and ciphertext
    const nonce = this._hexToBytes(encrypted.nonce);
    const ciphertext = this._hexToBytes(encrypted.ciphertext);

    if (nonce.length !== 24) {
      throw new Error("Invalid nonce length");
    }

    // Decrypt
    const chacha = xchacha20poly1305(groupKey, nonce, aad);
    const plaintext = chacha.decrypt(ciphertext);

    return new TextDecoder().decode(plaintext);
  }

  /**
   * Construct AAD for authenticated encryption
   * Format: groupMailboxId (raw bytes) || keyVersion (u32 BE)
   * @private
   */
  _constructAAD(groupMailboxId, keyVersion) {
    const mailboxBytes = this._hexToBytes(groupMailboxId);
    const versionBytes = new Uint8Array(4);
    new DataView(versionBytes.buffer).setUint32(0, keyVersion, false); // big-endian

    const aad = new Uint8Array(mailboxBytes.length + 4);
    aad.set(mailboxBytes, 0);
    aad.set(versionBytes, mailboxBytes.length);

    return aad;
  }

  /**
   * Convert bytes to hex string
   * @private
   */
  _bytesToHex(bytes) {
    return Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  /**
   * Convert hex string to bytes
   * @private
   */
  _hexToBytes(hex) {
    if (typeof hex !== "string" || hex.length % 2 !== 0) {
      throw new Error("Invalid hex string");
    }
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
      bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
    }
    return bytes;
  }
}
