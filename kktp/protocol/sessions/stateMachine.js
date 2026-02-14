// kktp/protocol/sessions/stateMachine.js
import { establishSession } from "../integrity/handshake.js";
import { pack, unpack } from "../utils/kktpCodec.js";

export const KKTP_STATES = {
  INIT: "INIT",
  ACTIVE: "ACTIVE",
  FAULTED: "FAULTED", // Section 6.8
  CLOSED: "CLOSED", // Section 7.7
};

/**
 * KKTPStateMachine - Manages KKTP session state transitions.
 *
 * Requires a KaspaAdapter for network operations.
 */
export class KKTPStateMachine {
  /**
  * @param {import('../../adapters/kaspaAdapter.js').KaspaAdapter} adapter - Network adapter
   * @param {boolean} isInitiator - Whether this party initiated the session
   * @param {number} keyIndex - Key derivation index
   */
  constructor(adapter, isInitiator = true, keyIndex = 0) {
    if (!adapter) {
      throw new Error("KKTPStateMachine: adapter is required");
    }
    this.adapter = adapter;
    this.isInitiator = isInitiator;
    this.keyIndex = keyIndex;
    this.state = KKTP_STATES.INIT;

    this.kktp = {
      session: null, // K_session + metadata
      sessionKey: null, // 32-byte K_session for AEAD
      mailboxId: null, // Derived via Section 6.3
      sid: null,
      myPubSig: null, // Our identity for SessionEnd
      myPrivSig: null, // Our private signing key for SessionEnd (§5.5)
      peerPubSig: null, // Peer identity for verification

      // Section 6.6: Independent counters per direction (MUST start at 0)
      outboundSeq: 0,
      inboundSeq: {
        AtoB: 0,
        BtoA: 0,
      },

      // Section 7.2: Reassembly buffers per direction
      buffer: {
        AtoB: [],
        BtoA: [],
      },
      maxBufferSize: 100, // Protection against DoS memory exhaustion

      // Section 7.1: Nonce replay protection per direction
      nonceCache: {
        AtoB: new Set(),
        BtoA: new Set(),
      },
      nonceQueue: {
        AtoB: [],
        BtoA: [],
      },
      pendingNonces: {
        AtoB: new Set(),
        BtoA: new Set(),
      },
      maxNonceCache: 1000,

      // Section 7.2: Gap timeout tracking (ms)
      gapSince: {
        AtoB: null,
        BtoA: null,
      },
      gapTimeoutMs: 60000,
    };
  }

  /**
   * Transition: INIT -> ACTIVE (Section 6.1 & 6.2)
   */
  async connect(discovery, response) {
    try {

      const dhPriv = this.kktp?.myDhPriv;
      if (!dhPriv) {
        throw new Error("Missing DH private key for session establishment.");
      }

      const { session, mailboxId, sessionKey } = await establishSession(
        this.adapter,
        discovery,
        response,
        this.keyIndex,
        dhPriv,
        this.isInitiator
      );

      this.kktp.session = session;
      this.kktp.sessionKey = sessionKey;
      this.kktp.mailboxId = mailboxId;
      this.kktp.sid = discovery.sid;

      // Map identities for Section 7.4 Signature Verification
      this.kktp.myPubSig = this.isInitiator
        ? discovery.pub_sig
        : response.pub_sig_resp;
      this.kktp.peerPubSig = this.isInitiator
        ? response.pub_sig_resp
        : discovery.pub_sig;

      this.state = KKTP_STATES.ACTIVE;
      return true;
    } catch (err) {
      this.state = KKTP_STATES.FAULTED;
      throw err;
    }
  }

  /**
   * Records a nonce to prevent replay attacks (§7.1)
   * @returns {boolean} true if nonce was new and recorded, false if duplicate
   */
  _recordNonce(direction, nonceHex) {
    const cache = this.kktp.nonceCache[direction];
    const queue = this.kktp.nonceQueue[direction];

    if (cache.has(nonceHex)) return false;

    cache.add(nonceHex);
    queue.push(nonceHex);

    // Evict oldest nonces if cache exceeds limit
    if (queue.length > this.kktp.maxNonceCache) {
      const oldest = queue.shift();
      cache.delete(oldest);
    }
    return true;
  }

  /**
   * Sends a message (Section 6.6)
   * Per §6.6: Sequence numbers MUST start at 0 and increment after use
   */
  sendMessage(plaintext) {
    if (this.state !== KKTP_STATES.ACTIVE)
      throw new Error(`Cannot send in state: ${this.state}`);

    const direction = this.isInitiator ? "AtoB" : "BtoA";
    const seq = this.kktp.outboundSeq;

    // Increment AFTER use (first message has seq=0)
    this.kktp.outboundSeq++;

    return pack(this.kktp, plaintext, direction, seq);
  }

  /**
   * Receives, reorders, and enforces strict contiguous delivery (Section 7.1 & 7.2)
   * Per-direction replay protection, nonce tracking, gap timeout, and buffering
   */
  receiveMessage(msg) {
    if (this.state !== KKTP_STATES.ACTIVE) return [];

    // §7.6: Enforce session uniqueness - reject messages with wrong sid
    if (msg.sid !== this.kktp.sid) return [];

    const direction = msg.direction;
    if (direction !== "AtoB" && direction !== "BtoA") {
      throw new Error(`Invalid direction: ${direction}`);
    }

    const expectedSeq = this.kktp.inboundSeq[direction];
    const buffer = this.kktp.buffer[direction];
    const now = Date.now();

    // 1. Replay Protection: Discard old or duplicate sequences (§7.1)
    if (msg.seq < expectedSeq) return [];

    // 1b. Nonce reuse protection (§7.1) - reject if nonce already seen
    if (this.kktp.nonceCache[direction].has(msg.nonce)) return [];
    if (this.kktp.pendingNonces[direction].has(msg.nonce)) return [];

    // 2. Gap timeout handling (§7.2) - fault if gap exceeds timeout
    if (msg.seq > expectedSeq) {
      if (this.kktp.gapSince[direction] === null) {
        this.kktp.gapSince[direction] = now;
      } else if (now - this.kktp.gapSince[direction] > this.kktp.gapTimeoutMs) {
        this.state = KKTP_STATES.FAULTED;
        throw new Error("Gap timeout: missing sequence exceeded timeout.");
      }
    }

    // 3. Buffer Limit: Prevent memory DoS (§7.2)
    if (buffer.length >= this.kktp.maxBufferSize) {
      this.state = KKTP_STATES.FAULTED;
      throw new Error("Buffer overflow: Potential DoS or massive gap.");
    }

    // 4. Add to reassembly buffer (dedupe) and sort
    if (!buffer.find((m) => m.seq === msg.seq)) {
      buffer.push(msg);
      this.kktp.pendingNonces[direction].add(msg.nonce);
      buffer.sort((a, b) => a.seq - b.seq);
    }

    const readyPlaintexts = [];

    // 5. Strict contiguous processing (§7.2)
    while (
      buffer.length > 0 &&
      buffer[0].seq === this.kktp.inboundSeq[direction]
    ) {
      const next = buffer.shift();
      this.kktp.pendingNonces[direction].delete(next.nonce);

      try {
        // Section 6.6: AAD must include direction and seq
        const plain = unpack(this.kktp, next);
        if (plain) {
          readyPlaintexts.push(plain);
          this._recordNonce(direction, next.nonce);
        }
        this.kktp.inboundSeq[direction]++;
      } catch (e) {
        // Section 7.11: AEAD failure marks session as FAULTED
        this.state = KKTP_STATES.FAULTED;
        throw new Error("Integrity violation: AEAD decryption failed.");
      }
    }

    // Clear gap timer if contiguous or caught up
    if (
      buffer.length === 0 ||
      buffer[0].seq === this.kktp.inboundSeq[direction]
    ) {
      this.kktp.gapSince[direction] = null;
    }

    return readyPlaintexts;
  }

  /**
   * Section 7.7: Secure Termination
   */
  terminate() {
    this.state = KKTP_STATES.CLOSED;

    // ZEROIZE: Securely erase keys from memory (§7.7)
    if (this.kktp.session?.zeroize) {
      this.kktp.session.zeroize();
    }
    this.kktp.session = null;

    // Zeroize session key
    if (this.kktp.sessionKey instanceof Uint8Array) {
      this.kktp.sessionKey.fill(0);
    }
    this.kktp.sessionKey = null;

    // Clear DH private key
    this.kktp.myDhPriv = null;
    this.kktp.myPrivSig = null;

    // Clear buffers and nonce caches
    this.kktp.buffer = { AtoB: [], BtoA: [] };
    this.kktp.nonceCache = { AtoB: new Set(), BtoA: new Set() };
    this.kktp.nonceQueue = { AtoB: [], BtoA: [] };
    this.kktp.pendingNonces = { AtoB: new Set(), BtoA: new Set() };
    this.kktp.gapSince = { AtoB: null, BtoA: null };
  }
}
