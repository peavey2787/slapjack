// kktp-core/handshake.js
import {
  discoveryValidator,
  responseValidator,
} from "../integrity/validator.js";
import { canonicalize, prepareForSigning } from "../integrity/canonical.js";
import { bytesToHex, hexToBytes } from "../utils/conversions.js";
import { blake2b } from "https://esm.sh/@noble/hashes@1.3.0/blake2b";
import { hkdf } from "https://esm.sh/@noble/hashes@1.3.0/hkdf";

/**
 * Computes VRF input hash per §6.1: H(pub_sig || pub_dh || sid)
 * Hashing prevents canonicalization attacks from string concatenation.
 * @param {...string} hexStrings - Hex-encoded key components
 * @returns {Uint8Array} 32-byte Blake2b hash
 */
function computeVrfInputHash(...hexStrings) {
  // Calculate total byte length
  const totalLen = hexStrings.reduce((sum, h) => sum + h.length / 2, 0);
  const combined = new Uint8Array(totalLen);

  let offset = 0;
  for (const hex of hexStrings) {
    const bytes = hexToBytes(hex);
    combined.set(bytes, offset);
    offset += bytes.length;
  }

  // H(pub_sig || pub_dh || sid) - commits to structure, prevents key-substitution
  return blake2b(combined, { dkLen: 32 });
}

/**
 * Establishes a session with mandatory VRF binding verification.
 * Follows KKTP Spec Sections 6.1, 6.2, 6.3, and 7.3.
 *
 * @param {import('../../adapters/kaspaAdapter.js').KaspaAdapter} adapter - Network adapter
 * @param {Object} discovery - Discovery anchor
 * @param {Object} response - Response anchor
 * @param {number} keyIndex - Key derivation index
 * @param {string|null} dhPrivateKey - DH private key
 * @param {boolean} isInitiator - Whether this party initiated
 */
export async function establishSession(
  adapter,
  discovery,
  response,
  keyIndex = 0,
  dhPrivateKey = null,
  isInitiator = true,
) {
  // 1. Schema & Signature Validation
  discoveryValidator.validate(discovery);
  responseValidator.validate(response);

  // 1.1 Verify Response echoes Initiator's keys (§5.3 - Cryptographic Binding)
  // This prevents Session Hijacking and Reflection attacks
  if (response.initiator_pub_sig !== discovery.pub_sig) {
    throw new Error(
      "Handshake Failed: Response initiator_pub_sig does not match Discovery pub_sig.",
    );
  }
  if (response.initiator_pub_dh !== discovery.pub_dh) {
    throw new Error(
      "Handshake Failed: Response initiator_pub_dh does not match Discovery pub_dh.",
    );
  }

  const discBody = canonicalize(
    prepareForSigning(discovery, { omitKeys: ["sig"], excludeMeta: true }),
  );
  const respBody = canonicalize(
    prepareForSigning(response, { omitKeys: ["sig_resp"] }),
  );

  const [isDValid, isRValid] = await Promise.all([
    adapter.verifyMessage(
      discovery.pub_sig,
      discBody,
      discovery.sig,
    ),
    adapter.verifyMessage(
      response.pub_sig_resp,
      respBody,
      response.sig_resp,
    ),
  ]);

  if (!isDValid || !isRValid)
    throw new Error("Handshake Failed: Invalid Signatures");

  // 2. VRF Binding Verification (§6.1, §7.3)
  // VRF is OPTIONAL per deployment - only verify if present
  // VRF input MUST be H(pub_sig || pub_dh || sid) to prevent canonicalization attacks
  const initiatorVrfInputHash = computeVrfInputHash(
    discovery.pub_sig,
    discovery.pub_dh,
    discovery.sid,
  );

  const responderVrfInputHash = computeVrfInputHash(
    discovery.pub_sig,
    discovery.pub_dh,
    response.pub_sig_resp,
    response.pub_dh_resp,
    discovery.sid,
  );

  // VRF fields must be consistently null or non-null (value/proof pair)
  const hasInitiatorVrf =
    discovery.vrf_value !== null && discovery.vrf_proof !== null;
  const hasResponderVrf =
    response.vrf_value !== null && response.vrf_proof !== null;

  // Validate VRF field consistency (both null or both present)
  if (
    (discovery.vrf_value === null) !== (discovery.vrf_proof === null) ||
    (response.vrf_value === null) !== (response.vrf_proof === null)
  ) {
    throw new Error("Handshake Failed: VRF value/proof mismatch.");
  }

  // Only verify VRF if initiator provided it
  if (hasInitiatorVrf) {
    const isInitiatorVrfValid = await adapter.verify(
      discovery.vrf_value,
      discovery.vrf_proof,
      bytesToHex(initiatorVrfInputHash),
    );
    if (!isInitiatorVrfValid) {
      throw new Error("Handshake Failed: Initiator VRF Binding Mismatch.");
    }
  }

  // Only verify VRF if responder provided it
  if (hasResponderVrf) {
    const isResponderVrfValid = await adapter.verify(
      response.vrf_value,
      response.vrf_proof,
      bytesToHex(responderVrfInputHash),
    );
    if (!isResponderVrfValid) {
      throw new Error("Handshake Failed: Responder VRF Binding Mismatch.");
    }
  }

  // 3. DH Shared Secret Derivation
  const session = await adapter.startSession(keyIndex, dhPrivateKey);

  // Per KKTP §6.2: Initiator uses responder DH; responder uses initiator DH
  const peerDH = isInitiator ? response.pub_dh_resp : discovery.pub_dh;
  if (!peerDH) {
    throw new Error("Handshake Failed: Missing peer DH public key.");
  }

  const rawSharedSecret = session.deriveSharedSecret(peerDH);

  // Ensure rawSharedSecret is Uint8Array
  const sharedSecretBytes =
    typeof rawSharedSecret === "string"
      ? hexToBytes(rawSharedSecret)
      : rawSharedSecret;

  // 4. Session Key Derivation (§6.2)
  // K_session = HKDF-Expand(HKDF-Extract(salt=sid, IKM=K), info=pub_sig_A||pub_sig_B, L=32)
  const pubSigA = hexToBytes(discovery.pub_sig);
  const pubSigB = hexToBytes(response.pub_sig_resp);
  const sidBytes = hexToBytes(discovery.sid);

  // Construct info = pub_sig_A || pub_sig_B (raw bytes, not hex strings)
  const info = new Uint8Array(pubSigA.length + pubSigB.length);
  info.set(pubSigA, 0);
  info.set(pubSigB, pubSigA.length);

  // HKDF with Blake2b: Extract phase uses sid as salt, Expand uses info
  // @noble/hashes hkdf(hash, salt, ikm, info, length) handles Extract+Expand
  const kSessionBytes = hkdf(blake2b, sidBytes, sharedSecretBytes, info, 32);

  // Validate output is exactly 32 bytes (256-bit key)
  if (!(kSessionBytes instanceof Uint8Array) || kSessionBytes.length !== 32) {
    throw new Error(
      `Invalid K_session: expected 32-byte Uint8Array, got ${typeof kSessionBytes} of length ${kSessionBytes?.length}`,
    );
  }

  if (!(kSessionBytes instanceof Uint8Array) || kSessionBytes.length !== 32) {
    throw new Error(
      `Invalid K_session length: expected 32, got ${kSessionBytes?.length}`,
    );
  }

  session.setSessionKey(kSessionBytes);

  // 5. Mailbox ID Derivation
  const mailboxInput = new Uint8Array(
    pubSigA.length + pubSigB.length + sidBytes.length,
  );
  mailboxInput.set(pubSigA, 0);
  mailboxInput.set(pubSigB, pubSigA.length);
  mailboxInput.set(sidBytes, pubSigA.length + pubSigB.length);

  const mailboxId = bytesToHex(blake2b(mailboxInput, { dkLen: 32 }));

  return { session, mailboxId, sessionKey: kSessionBytes };
}
