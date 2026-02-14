import { bytesToHex, hexToBytes } from "../utils/conversions.js";
import { constructAAD } from "./aad.js";
import { xchacha20poly1305 } from "https://esm.sh/v135/@noble/ciphers/chacha";
import { blake2b } from "https://esm.sh/@noble/hashes@1.3.0/blake2b";

/**
 * Computes VRF input hash per §6.1: H(pub_sig || pub_dh || sid)
 * Hashing prevents canonicalization attacks from string concatenation.
 * @param {...string} hexStrings - Hex-encoded key components
 * @returns {string} Hex-encoded 32-byte Blake2b hash
 */
function computeVrfInputHash(...hexStrings) {
  const totalLen = hexStrings.reduce((sum, h) => sum + h.length / 2, 0);
  const combined = new Uint8Array(totalLen);

  let offset = 0;
  for (const hex of hexStrings) {
    const bytes = hexToBytes(hex);
    combined.set(bytes, offset);
    offset += bytes.length;
  }

  return bytesToHex(blake2b(combined, { dkLen: 32 }));
}

/**
 * AnchorFactory - Creates KKTP protocol anchors (Discovery, Response, Message, SessionEnd)
 *
 * Requires a KaspaAdapter instance for VRF/randomness operations.
 */
export class AnchorFactory {
  /**
  * @param {import('../../adapters/kaspaAdapter.js').KaspaAdapter} adapter - Network adapter for crypto operations
   */
  constructor(adapter) {
    if (!adapter) {
      throw new Error("AnchorFactory: adapter is required");
    }
    this._adapter = adapter;
  }

  /**
   * Section 6.1: Discovery Anchor
   * Per §6.1: VRF is optional
   */
  async createDiscovery({ meta, sig, dh }) {

    // Primary entropy: VRF via adapter
    let sid = null;
    try {
      const vrfHex = await this._adapter.generateFullRandomness();
      if (typeof vrfHex === "string" && vrfHex.length >= 64) {
        sid = vrfHex.slice(0, 64).toLowerCase();
      }
    } catch {
      // ignore
    }

    // Secondary entropy: partial VRF via adapter
    if (!sid) {
      try {
        const vrfHex = await this._adapter.generatePartialRandomness();
        if (typeof vrfHex === "string" && vrfHex.length >= 64) {
          sid = vrfHex.slice(0, 64).toLowerCase();
        }
      } catch {
        // ignore
      }
    }

    // Fallback: randomUUID hashed to 32 bytes
    if (!sid) {
      const uuid = crypto.randomUUID();
      sid = bytesToHex(
        blake2b(new TextEncoder().encode(uuid), { dkLen: 32 }),
      );
    }

    // 1. Build the base object with null VRF placeholders
    // Normalize meta and preserve lobby fields if present
    const normalizedMeta = {
      game: meta.game || "Unknown",
      version: meta.version || "1.0.0",
      expected_uptime_seconds: meta.expected_uptime_seconds || meta.upTime || 3600,
    };

    // Preserve lobby fields (lobby, lobby_name, max_members) for group sessions
    if (meta.lobby) {
      normalizedMeta.lobby = true;
      normalizedMeta.lobby_name = meta.lobby_name || "Unnamed Lobby";
      normalizedMeta.max_members = meta.max_members || 16;
    }

    const anchor = {
      type: "discovery",
      version: 1,
      sid: sid,
      pub_sig: sig.publicKey,
      pub_dh: dh.publicKey,
      vrf_value: null,
      vrf_proof: null,
      meta: normalizedMeta,
      sig: null, // Set by kktpProtocol.signAnchor()
    };

    // 2. Optionally compute VRF binding
    const vrfInputHash = computeVrfInputHash(sig.publicKey, dh.publicKey, sid);
    try {
      const vrfData = await this._adapter.prove({ seedInput: vrfInputHash });
      anchor.vrf_value = vrfData.finalOutput;
      anchor.vrf_proof = bytesToHex(
        new TextEncoder().encode(JSON.stringify(vrfData.proof)),
      );
    } catch {
      // VRF is optional per §6.1 - proceed without it
      anchor.vrf_value = null;
      anchor.vrf_proof = null;
    }

    // NOTE: sig is set by kktpProtocol.signAnchor() which uses
    // prepareForSigning with proper excludeMeta and omitKeys handling
    return anchor;
  }

  /**
   * Section 6.2: Response Anchor
   * Per §5.3: Response anchors do NOT include meta
   * Per §5.3: Response MUST echo initiator's keys for cryptographic binding
   */
  async createResponse(discovery, { sig, dh }) {
    const response = {
      type: "response",
      version: 1,
      sid: discovery.sid,
      initiator_pub_sig: discovery.pub_sig,
      initiator_pub_dh: discovery.pub_dh,
      pub_sig_resp: sig.publicKey,
      pub_dh_resp: dh.publicKey,
      vrf_value: null,
      vrf_proof: null,
      sig_resp: null, // Set by kktpProtocol.signAnchor()
    };

    const vrfInputHash = computeVrfInputHash(
      discovery.pub_sig,
      discovery.pub_dh,
      sig.publicKey,
      dh.publicKey,
      discovery.sid,
    );

    try {
      const vrfData = await this._adapter.prove({ seedInput: vrfInputHash });
      response.vrf_value = vrfData.finalOutput;
      response.vrf_proof = bytesToHex(
        new TextEncoder().encode(JSON.stringify(vrfData.proof)),
      );
    } catch {
      response.vrf_value = null;
      response.vrf_proof = null;
    }

    // NOTE: sig_resp is set by kktpProtocol.signAnchor() which uses
    // prepareForSigning with proper excludeMeta and omitKeys handling
    return response;
  }

  /**
   * Section 6.5: Message Object
   * Per §5.4: Message anchors MUST include sid
   */
  async createMessage(sid, mailboxId, direction, seq, plaintext, sessionKey) {
    const nonce = window.crypto.getRandomValues(new Uint8Array(24));
    const aad = constructAAD(mailboxId, direction, seq);
    const chacha = xchacha20poly1305(sessionKey, nonce, aad);
    const ciphertext = chacha.encrypt(new TextEncoder().encode(plaintext));

    return {
      type: "msg",
      version: 1,
      sid: sid,
      mailbox_id: mailboxId,
      direction: direction,
      seq: Number(seq),
      nonce: bytesToHex(nonce),
      ciphertext: bytesToHex(ciphertext),
    };
  }

  /**
   * Section 5.5 / 7.7: Session End Anchor
   * Uses the session's existing pub_sig (not new keys)
   */
  async createSessionEndAnchor(
    sid,
    pubSig,
    reason = "Session terminated by user",
  ) {
    const anchor = {
      type: "session_end",
      version: 1,
      sid: sid,
      pub_sig: pubSig,
      reason: reason,
    };
    return anchor;
  }
}
