// dh_encryption.js
import {
  encryptXChaCha20Poly1305,
  decryptXChaCha20Poly1305,
} from "../kas-wasm/kaspa.js";
import * as utilities from "../utilities/utilities.js";
import * as secp from "https://esm.sh/@noble/secp256k1";

/**
 * Diffie–Hellman Session Manager
 * Handles handshake, shared secret derivation, and message encryption/decryption.
 */
export class DHSession {
  constructor() {
    this.myPrivateKeyHex = null;
    this.myPublicKeyHex = null;
    this.myPrivateKeyBytes = null;
    this.myPublicKeyBytes = null;
    this.sharedSecretBytes = null;
    this.sessionKey = null;
    this.peerPublicKeyHex = null;
    this.peerPublicKeyBytes = null;
  }

  /**
   * Initiate handshake: send your public key to peer
   */
  initiateHandshake(privateKeyHex, publicKeyHex) {
    if (!privateKeyHex) {
      throw new Error("initiateHandshake requires privateKeyHex");
    }
    this.myPrivateKeyHex = privateKeyHex;

    // Ensure public key consistency using utilities
    if (publicKeyHex) {
      this.myPublicKeyHex = publicKeyHex;
    } else {
      this.myPublicKeyHex = utilities.getPublicKeyHex(privateKeyHex);
    }

    this.myPrivateKeyBytes = utilities.hexToBytes(privateKeyHex);
    this.myPublicKeyBytes = utilities.hexToBytes(this.myPublicKeyHex);

    return {
      type: "DH_INIT",
      publicKey: this.myPublicKeyHex,
      timestamp: Date.now(),
    };
  }

  /**
   * Respond to handshake: accept peer public key and derive shared secret
   */
  async respondToHandshake(peerPublicKeyHex) {
    this.peerPublicKeyHex = peerPublicKeyHex;
    this.peerPublicKeyBytes = utilities.hexToBytes(peerPublicKeyHex);

    // Derive shared secret using noble
    this.sharedSecretBytes = secp.getSharedSecret(
      this.myPrivateKeyBytes,
      this.peerPublicKeyBytes,
      true,
    );

    // Derive session key (hash the shared secret)
    const digest = await window.crypto.subtle.digest(
      "SHA-256",
      this.sharedSecretBytes,
    );
    const sessionKey = new Uint8Array(digest);
    this.sessionKey = sessionKey;

    return {
      type: "DH_ACK",
      publicKey: this.myPublicKeyHex,
      timestamp: Date.now(),
    };
  }

  /**
   * Derives the raw shared secret (for KKTP HKDF).
   */
  deriveSharedSecret(peerPublicKeyHex) {
    this.peerPublicKeyHex = peerPublicKeyHex;
    this.peerPublicKeyBytes = utilities.hexToBytes(peerPublicKeyHex);
    this.sharedSecretBytes = secp.getSharedSecret(
      this.myPrivateKeyBytes,
      this.peerPublicKeyBytes,
      true,
    );
    return this.sharedSecretBytes;
  }

  setSessionKey(key) {
    this.sessionKey = key;
  }

  /**
   * Encrypt a message with the session key
   */
  encryptMessage(plaintext) {
    if (!this.sessionKey) throw new Error("Session not established");
    const sessionKeyHex = utilities.bytesToHex(this.sessionKey);
    return encryptXChaCha20Poly1305(plaintext, sessionKeyHex);
  }

  /**
   * Decrypt a message with the session key
   */
  decryptMessage(cipherText) {
    if (!this.sessionKey) throw new Error("Session not established");
    const sessionKeyHex = utilities.bytesToHex(this.sessionKey);
    return decryptXChaCha20Poly1305(cipherText, sessionKeyHex);
  }
}
