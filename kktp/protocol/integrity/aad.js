// kktp-core/protocol/aad.js
import { hexToBytes } from "../utils/conversions.js";

/**
 * Constructs the Associated Data (AAD) buffer for XChaCha20-Poly1305.
 * Following KKTP Spec Section 6.6: AAD = mailbox_id || direction || seq
 * @param {string|Uint8Array} mailboxId - The raw hash bytes or hex string of the mailbox ID.
 * @param {string} direction - MUST be exactly "AtoB" or "BtoA".
 * @param {number|bigint} seq - The current sequence number (Unsigned 64-bit).
 * @returns {Uint8Array} The concatenated AAD buffer.
 */
export function constructAAD(mailboxId, direction, seq) {
  // 1. Validate Direction (Section 3 & 6.6)
  if (direction !== "AtoB" && direction !== "BtoA") {
    throw new Error(
      `Invalid KKTP direction: ${direction}. Must be "AtoB" or "BtoA".`,
    );
  }

  // 2. Normalize Mailbox ID to Raw Bytes
  const mailboxBytes =
    typeof mailboxId === "string" ? hexToBytes(mailboxId) : mailboxId;

  if (mailboxBytes.length !== 32) {
    throw new Error("Invalid mailbox_id length. Expected 32-byte hash output.");
  }

  // 3. Encode Direction (UTF-8)
  const dirBytes = new TextEncoder().encode(direction);

  // 4. Encode Sequence (u64BE) - Section 6.6
  const seqBig = BigInt(seq);
  if (seqBig < 0n || seqBig > 18446744073709551615n) {
    throw new Error(
      "Sequence number out of range for unsigned 64-bit integer.",
    );
  }

  const seqBytes = new Uint8Array(8);
  const view = new DataView(seqBytes.buffer);
  view.setBigUint64(0, seqBig, false); // false = Big Endian per Spec

  // 5. Final Assembly
  // Total = 32 (ID) + 4 (Dir) + 8 (Seq) = 44 bytes
  const aad = new Uint8Array(
    mailboxBytes.length + dirBytes.length + seqBytes.length,
  );

  aad.set(mailboxBytes, 0);
  aad.set(dirBytes, mailboxBytes.length);
  aad.set(seqBytes, mailboxBytes.length + dirBytes.length);

  return aad;
}
