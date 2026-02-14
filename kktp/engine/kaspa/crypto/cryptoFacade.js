import { encryptMessage, decryptMessage } from "./encryption.js";
import { DHSession } from "./dh_encryption.js";
import {
  signMessageWithPrivateKeyHex,
  verifyMessageWithPublicKeyHex,
  deriveChildKeyPair,
} from "../utilities/utilities.js";

export class CryptoFacade {

  // Symmetric Encryption (Standard)
  encrypt(text, password) {
    return encryptMessage(text, password);
  }

  decrypt(encrypted, password) {
    return decryptMessage(encrypted, password);
  }

  /**
   * Create DH Session.
   */
  createDHSession(privateKey, publicKey) {
    if(!privateKey && !publicKey) {
      throw new Error("Cannot create DH session without private key and public key");
    }
    const session = new DHSession();
    if (privateKey) {
      session.initiateHandshake(privateKey, publicKey);
    }
    return session;
  }

  /**
   * Generates KKTP Identity Keys (Branch 0 and 100).
   */
  async generateIdentityKeys(xprvHex, index) {
    const sigRaw = await deriveChildKeyPair({ xprvHex, branch: 0, index });
    const dhRaw = await deriveChildKeyPair({ xprvHex, branch: 100, index });
    return {
      sig: { privateKey: sigRaw.privateKey, publicKey: sigRaw.publicKey },
      dh: { privateKey: dhRaw.privateKey, publicKey: dhRaw.publicKey },
    };
  }

  // --- Signing & Verification ---

  async signMessage(privateKeyHex, message) {
    return await signMessageWithPrivateKeyHex(privateKeyHex, message);
  }

  async verifyMessage(publicKeyHex, message, signatureHex) {
    return await verifyMessageWithPublicKeyHex(
      publicKeyHex,
      message,
      signatureHex,
    );
  }
}
