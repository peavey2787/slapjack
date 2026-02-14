// kktp-core/messenger.js
import { constructAAD } from "../integrity/aad.js";
import { mailboxMessageValidator } from "../integrity/validator.js";
import { canonicalize } from "../integrity/canonical.js";
import { bytesToHex, hexToBytes, normalizeKey } from "./conversions.js";
import { xchacha20poly1305 } from "https://esm.sh/@noble/ciphers/chacha";

/**
 * Packs a plaintext message into a protocol-compliant Mailbox Message (Section 5.4)
 */
export function pack(kktpState, plaintext, direction, seq) {
  const { sessionKey, mailboxId, sid } = kktpState;

  // 1. Section 4 & 6.6: Generate a 192-bit (24-byte) CSPRNG Nonce
  const nonceBytes = crypto.getRandomValues(new Uint8Array(24));
  const nonceHex = bytesToHex(nonceBytes);

  // 2. Section 6.6: Construct AAD
  // AAD = mailbox_id (raw) || direction (UTF-8) || seq (u64BE)
  const aad = constructAAD(mailboxId, direction, seq);

  // 3. Encrypt using XChaCha20-Poly1305 (Section 4)
  // The session wrapper must handle the actual AEAD primitive

  // Normalize
  const keyBytes = normalizeKey(sessionKey);
  if (!(keyBytes instanceof Uint8Array) || keyBytes.length !== 32) {
    throw new Error(
      `Invalid sessionKey length: expected 32, got ${keyBytes?.length}`,
    );
  }

  const chacha = xchacha20poly1305(keyBytes, nonceBytes, aad);
  const plaintextBytes = new TextEncoder().encode(plaintext);

  // Encrypt only takes the plaintext (and an optional output buffer)
  const ciphertext = chacha.encrypt(plaintextBytes);

  // 4. Construct object per Section 5.4
  const msgObj = {
    type: "msg",
    version: 1,
    sid: sid,
    mailbox_id: mailboxId,
    direction: direction,
    seq: seq,
    nonce: nonceHex,
    ciphertext: bytesToHex(ciphertext),
  };

  // 5. CANONICAL OUTPUT (Section 7.9 & 6.4)
  // We return the canonical string so the Adapter doesn't have to guess.
  return canonicalize(msgObj);
}

/**
 * Unpacks and verifies an incoming message (Section 6.6 & 7.5)
 */
export function unpack(kktpState, msg) {
  // 1. Validation: Ensure the object matches the schema before processing
  mailboxMessageValidator.validate(msg);

  const { sessionKey, mailboxId, sid } = kktpState;

  // 2. Filter: Ignore if it doesn't belong to this mailbox or session (§7.6)
  if (msg.mailbox_id !== mailboxId) return null;
  if (msg.sid !== sid) return null;

  // 3. Reconstruction: Build AAD for decryption/integrity check
  const aad = constructAAD(mailboxId, msg.direction, msg.seq);
  const nonceBytes = hexToBytes(msg.nonce);
  const ciphertextBytes = hexToBytes(msg.ciphertext);

  // 3b. Validate nonce length (§4: XChaCha20 requires 192-bit / 24-byte nonce)
  if (nonceBytes.length !== 24) {
    throw new Error("Invalid nonce length: expected 24 bytes.");
  }

  // 4. Section 6.6: Decryption Hardening
  // Verify authentication tag + decrypt in one step (AEAD)

  // Normalize
  const keyBytes = normalizeKey(sessionKey);

  if (!(keyBytes instanceof Uint8Array) || keyBytes.length !== 32) {
    throw new Error(
      `Invalid sessionKey length: expected 32, got ${keyBytes?.length}`,
    );
  }

  try {
    // 1. Bind AAD here, just like in pack()
    const chacha = xchacha20poly1305(keyBytes, nonceBytes, aad);

    // 2. Decrypt only takes the ciphertext
    const plaintextBytes = chacha.decrypt(ciphertextBytes);

    return new TextDecoder().decode(plaintextBytes);
  } catch (e) {
    // Section 7.5: Decryption failures are protocol violations
    throw new Error(`KKTP Integrity Violation: ${e.message}`);
  }
}
