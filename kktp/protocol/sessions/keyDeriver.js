// kktp/protocol/sessions/keyDeriver.js
// Per-Contact BaseIndex Allocation (Deterministic PFS)
// Branch layout: N = Contact Identity, N+1 = TX Key, N+2 = RX Key

import { Logger, LogModule } from "../../core/logger.js";

const log = Logger.create(LogModule.protocol.sessions.keyDeriver);

/**
 * Handles deterministic key derivation for KKTP sessions.
 * Manages per-contact baseIndex allocation with Perfect Forward Secrecy (PFS).
 */
export class KeyDeriver {
  /**
   * @param {Object} options
  * @param {import('../../adapters/kaspaAdapter.js').KaspaAdapter} options.adapter - Network adapter for key generation
   * @param {Object} options.persistence - SessionPersistence instance for storage
   * @param {number} [options.startIndex=100] - Starting baseIndex (avoid legacy conflicts)
   */
  constructor({ adapter, persistence, startIndex = 100 } = {}) {
    if (!adapter) throw new Error("KeyDeriver: adapter is required");
    if (!persistence) throw new Error("KeyDeriver: persistence is required");

    this._adapter = adapter;
    this._persistence = persistence;
    this._nextBaseIndex = startIndex;
    this._nextBaseIndexLoaded = false;
  }

  // ─────────────────────────────────────────────────────────────
  // BaseIndex Allocation
  // ─────────────────────────────────────────────────────────────

  /**
   * Allocate a new baseIndex for a contact (increments by 3 for next contact).
   * Persists the counter to IndexedDB for deterministic resumption.
   * @returns {Promise<number>} The allocated baseIndex
   */
  async allocateBaseIndex() {
    // Load persisted counter on first use
    if (!this._nextBaseIndexLoaded) {
      const stored = await this._persistence.getMeta("nextBaseIndex");
      if (typeof stored === "number" && stored >= this._nextBaseIndex) {
        this._nextBaseIndex = stored;
      }
      this._nextBaseIndexLoaded = true;
    }

    const baseIndex = this._nextBaseIndex;
    this._nextBaseIndex += 3; // Reserve N, N+1, N+2
    await this._persistence.setMeta("nextBaseIndex", this._nextBaseIndex);
    return baseIndex;
  }

  // ─────────────────────────────────────────────────────────────
  // Peer Record Management
  // ─────────────────────────────────────────────────────────────

  /**
   * Ensure a peer record exists; allocate baseIndex if new contact.
   * @param {string} peerPubSig - The peer's public signing key
   * @returns {Promise<Object>} - { peerPubSig, baseIndex, usedBranches, ... }
   */
  async ensurePeerRecord(peerPubSig) {
    if (!peerPubSig) throw new Error("peerPubSig required for peer record");

    let record = await this._persistence.getPeerRecord(peerPubSig);
    if (record) return record;

    // New contact: allocate a fresh baseIndex branch
    const baseIndex = await this.allocateBaseIndex();
    record = {
      peerPubSig,
      baseIndex,
      usedBranches: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await this._persistence.upsertPeerRecord(record);
    log.info(
      `KKTP: allocated baseIndex=${baseIndex} for peer=${peerPubSig.slice(0, 8)}...`,
    );
    return record;
  }

  /**
   * Get an existing peer record without creating one.
   * @param {string} peerPubSig - The peer's public signing key
   * @returns {Promise<Object|null>} The peer record or null
   */
  async getPeerRecord(peerPubSig) {
    if (!peerPubSig) return null;
    return await this._persistence.getPeerRecord(peerPubSig);
  }

  // ─────────────────────────────────────────────────────────────
  // Key Branch Preparation
  // ─────────────────────────────────────────────────────────────

  /**
   * Prepare a key branch for a session with a specific peer.
   * For initiator: uses baseIndex+1 (TX), expects peer to use baseIndex+2 (RX)
   * For responder: uses baseIndex+2 (RX), expects peer to use baseIndex+1 (TX)
   * @param {string} peerPubSig - The peer's public signing key
   * @param {boolean} isInitiator - Whether this is the initiating party
   * @returns {Promise<{ keyIndex: number, baseIndex: number, prederivedKeys: Object }>}
   */
  async prepareKeyBranch(peerPubSig, isInitiator) {
    const record = await this.ensurePeerRecord(peerPubSig);
    const base = record.baseIndex;

    // Branch layout: N = identity, N+1 = initiator TX, N+2 = responder RX
    const keyIndex = isInitiator ? base + 1 : base + 2;

    // Pre-derive keys for this branch
    const keys = await this._adapter.generateIdentityKeys(keyIndex);

    // Mark as used for PFS
    await this._persistence.markPeerBranchUsed(peerPubSig, keyIndex);

    log.info(
      `KKTP: prepared branch keyIndex=${keyIndex} (base=${base}) initiator=${isInitiator}`,
    );

    return {
      keyIndex,
      baseIndex: base,
      prederivedKeys: keys, // { sig: { publicKey, privateKey }, dh: { publicKey, privateKey } }
    };
  }

  /**
   * Derive keys for a specific branch index.
   * Used for session restoration.
   * @param {number} keyIndex - The branch index to derive keys for
   * @returns {Promise<Object>} - { sig: { publicKey, privateKey }, dh: { publicKey, privateKey } }
   */
  async deriveKeysForIndex(keyIndex) {
    return await this._adapter.generateIdentityKeys(keyIndex);
  }

  /**
   * Calculate the key index for a given peer and role.
   * @param {number} baseIndex - The peer's baseIndex
   * @param {boolean} isInitiator - Whether this is the initiating party
   * @returns {number} The calculated keyIndex
   */
  calculateKeyIndex(baseIndex, isInitiator) {
    return isInitiator ? baseIndex + 1 : baseIndex + 2;
  }
}
