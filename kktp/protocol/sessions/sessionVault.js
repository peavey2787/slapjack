// kktp/protocol/sessions/sessionVault.js
// Session Map Management, Persistence Timers, Export/Restore Logic

import { bytesToHex } from "../utils/conversions.js";
import {
  extractResumeState,
  applyResumeState,
  deriveSeqFromMessages,
  getExpectedEndMs,
  zeroOutSessionKey,
} from "./smHelpers.js";
import { KKTPProtocol } from "../kktpProtocolFacade.js";
import { KKTPStateMachine, KKTP_STATES } from "./stateMachine.js";
import { Logger, LogModule } from "../../core/logger.js";

const log = Logger.create(LogModule.protocol.sessions.sessionVault);

/**
 * Manages the session store (Map) and persistence layer.
 * Handles export, restore, and scheduled persistence operations.
 */
export class SessionVault {
  /**
   * @param {Object} options
  * @param {import('../../adapters/kaspaAdapter.js').KaspaAdapter} options.adapter - Network adapter
   * @param {Object} options.persistence - SessionPersistence instance
   * @param {Object} options.keyDeriver - KeyDeriver instance
   */
  constructor({ adapter, persistence, keyDeriver } = {}) {
    if (!adapter) throw new Error("SessionVault: adapter is required");
    if (!persistence) throw new Error("SessionVault: persistence is required");
    if (!keyDeriver) throw new Error("SessionVault: keyDeriver is required");

    this._adapter = adapter;
    this._persistence = persistence;
    this._keyDeriver = keyDeriver;

    // Session storage
    this._sessions = new Map();
    this._pendingDiscoveries = new Map();
    this._orphanResponses = new Map();
    this._keyIndex = 0;

    // Persistence
    this._persistConfig = null;
    this._persistQueue = new Set();
    this._persistTimer = null;

    // Lobby manager reference (set by setLobbyManager)
    this._lobbyManager = null;
  }

  // ─────────────────────────────────────────────────────────────
  // Lobby Manager Integration
  // ─────────────────────────────────────────────────────────────

  /**
   * Set the lobby manager reference for including lobby state in exports.
   * Called by SessionFacade when a LobbyFacade is created.
   * @param {Object} lobbyManager - LobbyManager instance with exportLobbyState/restoreLobbyState
   */
  setLobbyManager(lobbyManager) {
    this._lobbyManager = lobbyManager;
    log.info("SessionVault: Lobby manager registered for persistence");
  }

  // ─────────────────────────────────────────────────────────────
  // Session Access
  // ─────────────────────────────────────────────────────────────

  get sessions() {
    return this._sessions;
  }

  get pendingDiscoveries() {
    return this._pendingDiscoveries;
  }

  get orphanResponses() {
    return this._orphanResponses;
  }

  getSession(mailboxId) {
    return this._sessions.get(mailboxId);
  }

  setSession(mailboxId, session) {
    this._sessions.set(mailboxId, session);
    this._schedulePersist(mailboxId);
  }

  deleteSession(mailboxId) {
    const session = this._sessions.get(mailboxId);
    if (session) {
      void this._removeResumeState(session);
      this._sessions.delete(mailboxId);
    }
    return !!session;
  }

  getPendingDiscovery(sid) {
    return this._pendingDiscoveries.get(sid);
  }

  setPendingDiscovery(sid, pending) {
    this._pendingDiscoveries.set(sid, pending);
  }

  deletePendingDiscovery(sid) {
    this._pendingDiscoveries.delete(sid);
  }

  getOrphanResponse(sid) {
    return this._orphanResponses.get(sid);
  }

  setOrphanResponse(sid, response) {
    this._orphanResponses.set(sid, response);
  }

  deleteOrphanResponse(sid) {
    this._orphanResponses.delete(sid);
  }

  // ─────────────────────────────────────────────────────────────
  // Context Factory
  // ─────────────────────────────────────────────────────────────

  /**
   * Create a new KKTP context (state machine + protocol).
   * @param {boolean} isInitiator
   * @param {number|null} keyIndex
   * @returns {{ sm: KKTPStateMachine, protocol: KKTPProtocol, keyIndex: number }}
   */
  createContext(isInitiator, keyIndex = null) {
    const idx =
      Number.isInteger(keyIndex) && keyIndex >= 0
        ? keyIndex
        : this._keyIndex++;
    if (idx >= this._keyIndex) this._keyIndex = idx + 1;

    const sm = new KKTPStateMachine(this._adapter, isInitiator, idx);
    const protocol = new KKTPProtocol(sm);
    return { sm, protocol, keyIndex: idx };
  }

  // ─────────────────────────────────────────────────────────────
  // Persistence Configuration
  // ─────────────────────────────────────────────────────────────

  configureResumePersistence({
    storageKeyPrefix = "kktp_resume_",
    encryptFn = null,
    throttleMs = 250,
    includeMessages = true,
  } = {}) {
    this._persistConfig = {
      storageKeyPrefix,
      encryptFn,
      throttleMs,
      includeMessages,
    };
    return this._persistConfig;
  }

  get persistConfig() {
    return this._persistConfig;
  }

  forcePersistAllSessions() {
    if (!this._persistConfig) return;
    for (const mailboxId of this._sessions.keys()) {
      this._persistQueue.add(mailboxId);
    }
    void this._flushPersistQueue();
  }

  // ─────────────────────────────────────────────────────────────
  // Session Query
  // ─────────────────────────────────────────────────────────────

  getSessions() {
    return Array.from(this._sessions.entries()).map(([mailboxId, session]) => ({
      mailboxId,
      ...session,
    }));
  }

  findSessionByDiscoverySid(sid) {
    for (const [mailboxId, session] of this._sessions.entries()) {
      if (session?.discovery?.sid === sid) return { mailboxId, session };
    }
    return null;
  }

  /**
   * Find a session by peer's public signing key.
   * Used for lobby mode to check if we already have a session with a specific peer.
   * @param {string} peerPubSig - The peer's public signing key
   * @returns {{ mailboxId: string, session: Object }|null}
   */
  findSessionByPeerPubSig(peerPubSig) {
    if (!peerPubSig) return null;
    for (const [mailboxId, session] of this._sessions.entries()) {
      if (session?.peerPubSig === peerPubSig) {
        return { mailboxId, session };
      }
    }
    return null;
  }

  isSessionExpired(mailboxId, nowMs = Date.now()) {
    const s = this._sessions.get(mailboxId);
    if (!s) return true;
    const expectedEndMs = getExpectedEndMs(s.discovery, s.createdAt);
    if (!expectedEndMs) return false;
    return nowMs > expectedEndMs;
  }

  pruneExpiredSessions(nowMs = Date.now()) {
    for (const [mailboxId, s] of this._sessions.entries()) {
      const expectedEndMs = getExpectedEndMs(s.discovery, s.createdAt);
      if (expectedEndMs && nowMs > expectedEndMs) {
        void this._removeResumeState(s);
        this._sessions.delete(mailboxId);
      }
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Export Sessions
  // ─────────────────────────────────────────────────────────────

  exportSessions({ includeMessages = true } = {}) {
    const toHexIfBytes = (value) => {
      if (typeof value === "string") return value;
      if (value instanceof Uint8Array) return bytesToHex(value);
      return null;
    };

    const sessions = [];

    // Export active sessions
    for (const [mailboxId, s] of this._sessions.entries()) {
      const kktp = s?.sm?.kktp || {};
      const myDhPriv = toHexIfBytes(kktp.myDhPriv);
      const myPrivSig = toHexIfBytes(kktp.myPrivSig);
      const resumeState = extractResumeState(s);

      sessions.push({
        mailboxId,
        keyIndex: s.keyIndex,
        baseIndex: s.baseIndex ?? null,
        isInitiator: !!s.isInitiator,
        createdAt: s.createdAt || Date.now(),
        discovery: s.discovery || null,
        response: s.response || null,
        peerPubSig: s.peerPubSig || null,
        messages: includeMessages ? s.messages || [] : [],
        myDhPriv,
        myPrivSig,
        resumeState,
      });
    }

    // Export pending discoveries
    for (const [sid, pending] of this._pendingDiscoveries.entries()) {
      const alreadyExported = sessions.some(
        (entry) => entry.discovery?.sid === sid,
      );
      if (alreadyExported) continue;

      const kktp = pending?.sm?.kktp || {};
      const myDhPriv = toHexIfBytes(kktp.myDhPriv);
      const myPrivSig = toHexIfBytes(kktp.myPrivSig);

      sessions.push({
        mailboxId: null,
        keyIndex: pending.keyIndex ?? null,
        baseIndex: pending.baseIndex ?? null,
        isInitiator: true,
        createdAt: pending.createdAt || Date.now(),
        discovery: pending.discovery || null,
        response: null,
        peerPubSig: null,
        messages: [],
        myDhPriv,
        myPrivSig,
      });
    }

    log.info(
      "KKTP: exportSessions",
      JSON.stringify({
        activeCount: this._sessions.size,
        pendingCount: this._pendingDiscoveries.size,
        totalCount: sessions.length,
        includeMessages,
      }),
    );

    // Export lobby state if lobby manager is registered
    const lobbyState = this._lobbyManager?.exportLobbyState?.() || null;
    if (lobbyState) {
      log.info("KKTP: exportSessions includes lobbyState", {
        lobbyId: lobbyState.lobby?.lobbyId?.slice(0, 16),
        state: lobbyState.state,
      });
    }

    return {
      version: 1,
      savedAt: Date.now(),
      sessions,
      lobbyState,
    };
  }

  // ─────────────────────────────────────────────────────────────
  // Restore Sessions
  // ─────────────────────────────────────────────────────────────

  async restoreSessions(snapshot, { skipExpired = true } = {}) {
    if (!snapshot || !Array.isArray(snapshot.sessions)) return;

    log.info(`KKTP: restoreSessions count=${snapshot.sessions.length}`);

    for (const s of snapshot.sessions) {
      if (!s || !s.discovery) continue;

      const expectedEndMs = getExpectedEndMs(s.discovery, s.createdAt);
      if (skipExpired && expectedEndMs && Date.now() > expectedEndMs) continue;

      const sid = s.discovery?.sid || s.response?.sid || null;
      let resumeState = s.resumeState || null;

      if (!resumeState && sid) {
        resumeState = await this._loadResumeStateForSid(sid);
        if (resumeState) {
          log.info("KKTP: loaded resume state from blob");
        }
      }

      // --- Deterministic key derivation using peer registry ---
      const peerPubSig = s.peerPubSig || s.discovery?.pub_sig;
      let keyIndex = s.keyIndex;
      let baseIndex = s.baseIndex;

      if (peerPubSig && (keyIndex == null || baseIndex == null)) {
        try {
          const peerRecord = await this._keyDeriver.getPeerRecord(peerPubSig);
          if (peerRecord) {
            baseIndex = peerRecord.baseIndex;
            keyIndex = s.isInitiator ? baseIndex + 1 : baseIndex + 2;
            log.info(
              `KKTP: restore using peerRecord baseIndex=${baseIndex} keyIndex=${keyIndex}`,
            );
          }
        } catch (err) {
          log.warn(`KKTP: failed to lookup peer record: ${err?.message}`);
        }
      }

      const ctx = this.createContext(!!s.isInitiator, keyIndex);
      ctx.baseIndex = baseIndex;

      if (s.myDhPriv) ctx.sm.kktp.myDhPriv = s.myDhPriv;
      if (s.myPrivSig) ctx.sm.kktp.myPrivSig = s.myPrivSig;

      // Re-derive keys if missing
      if (!ctx.sm.kktp.myDhPriv || !ctx.sm.kktp.myPrivSig) {
        const fallbackIndex = Number.isInteger(keyIndex)
          ? keyIndex
          : s.isInitiator
            ? 0
            : 1;
        try {
          const keys = await this._keyDeriver.deriveKeysForIndex(fallbackIndex);
          ctx.sm.kktp.myDhPriv = ctx.sm.kktp.myDhPriv || keys.dh.privateKey;
          ctx.sm.kktp.myPrivSig = ctx.sm.kktp.myPrivSig || keys.sig.privateKey;
          log.info(
            `KKTP: re-derived keys for restore (idx=${fallbackIndex})`,
          );
        } catch (err) {
          log.warn(
            `KKTP: failed to re-derive keys for restore: ${err?.message || err}`,
          );
        }
      }

      if (s.isInitiator) {
        await this._restoreInitiatorSession(s, ctx, resumeState);
      } else {
        await this._restoreResponderSession(s, ctx, resumeState);
      }
    }

    log.info(
      `KKTP: restoreSessions complete sessions=${this._sessions.size} pending=${this._pendingDiscoveries.size} orphans=${this._orphanResponses.size}`,
    );

    // Restore lobby state if present and lobby manager is registered
    if (snapshot.lobbyState && this._lobbyManager?.restoreLobbyState) {
      const lobbyRestored = await this._lobbyManager.restoreLobbyState(
        snapshot.lobbyState
      );
      if (lobbyRestored) {
        log.info("KKTP: Lobby state restored successfully");
      }
    }
  }

  async _restoreInitiatorSession(s, ctx, resumeState) {
    log.info(
      `KKTP: restore initiator sid=${s.discovery.sid?.slice(0, 8)}...`,
    );

    // CRITICAL: Ensure the state machine knows this is an initiator session
    ctx.sm.isInitiator = true;

    if (!ctx.sm.kktp.discoveryAnchor) {
      ctx.sm.kktp.discoveryAnchor = s.discovery;
    }

    this._pendingDiscoveries.set(s.discovery.sid, {
      ...ctx,
      discovery: s.discovery,
      createdAt: s.createdAt || Date.now(),
    });

    // Check for orphan response
    const orphan = this._orphanResponses.get(s.discovery.sid);
    if (orphan && !s.response) {
      log.info(
        `KKTP: applying orphan response sid=${s.discovery.sid?.slice(0, 8)}...`,
      );
      s.response = orphan;
      this._orphanResponses.delete(s.discovery.sid);
    }

    if (s.response) {
      // If we have valid resume state with session key, use it directly
      if (resumeState?.K_session) {
        applyResumeState(ctx, resumeState);

        // Restore SID from discovery if not in resume state
        if (!ctx.sm.kktp.sid && s.discovery?.sid) {
          ctx.sm.kktp.sid = s.discovery.sid;
        }

        // Restore identity mappings for initiator:
        // - myPubSig = our discovery pub_sig
        // - peerPubSig = responder's pub_sig_resp
        if (!ctx.sm.kktp.myPubSig && s.discovery?.pub_sig) {
          ctx.sm.kktp.myPubSig = s.discovery.pub_sig;
        }
        if (!ctx.sm.kktp.peerPubSig && s.response?.pub_sig_resp) {
          ctx.sm.kktp.peerPubSig = s.response.pub_sig_resp;
        }

        // CRITICAL: Set state to ACTIVE since we have valid session keys
        ctx.sm.state = KKTP_STATES.ACTIVE;

        log.info("KKTP: applied resume state (initiator)", {
          hasSessionKey: !!ctx.sm.kktp.sessionKey,
          state: ctx.sm.state,
          isInitiator: ctx.sm.isInitiator,
        });
      } else {
        // No resume state - need to re-derive via protocol processing
        try {
          await ctx.protocol.processIncoming(s.response);
        } catch (err) {
          log.warn(
            `KKTP: restore failed response sid=${s.discovery.sid?.slice(0, 8)}...`,
            err?.message || err,
          );
          return;
        }

        // Derive seq from messages if available
        if (Array.isArray(s.messages) && s.messages.length > 0) {
          const derived = deriveSeqFromMessages(s.messages);
          ctx.sm.kktp.outboundSeq = derived.outboundSeq;
          ctx.sm.kktp.inboundSeq = {
            AtoB: derived.inboundSeq_AtoB,
            BtoA: derived.inboundSeq_BtoA,
          };
          log.info(
            `KKTP: derived seq (initiator) out=${derived.outboundSeq} AtoB=${derived.inboundSeq_AtoB} BtoA=${derived.inboundSeq_BtoA}`,
          );
        }
      }

      const mailboxId = ctx.sm?.kktp?.mailboxId || s.mailboxId;
      if (!mailboxId) {
        log.warn("KKTP: restore initiator failed - no mailboxId");
        return;
      }

      this._sessions.set(mailboxId, {
        ...ctx,
        discovery: s.discovery,
        response: s.response,
        messages: s.messages || [],
        peerPubSig: s.peerPubSig || s.response?.pub_sig_resp || null,
        isInitiator: true,
        createdAt: s.createdAt || Date.now(),
      });

      this._pendingDiscoveries.delete(s.discovery.sid);
      log.info(
        `KKTP: restored session mailbox=${mailboxId?.slice(0, 8)}...`,
      );
    }
  }

  async _restoreResponderSession(s, ctx, resumeState) {
    try {
      log.info(
        `KKTP: restore responder sid=${s.discovery.sid?.slice(0, 8)}...`,
      );

      // CRITICAL: Ensure the state machine knows this is a responder session
      ctx.sm.isInitiator = false;

      if (!ctx.sm.kktp.discoveryAnchor) {
        ctx.sm.kktp.discoveryAnchor = s.discovery;
      }

      // If we have valid resume state with session key, use it directly
      // This avoids re-deriving keys which may fail or produce wrong results
      if (resumeState?.K_session) {
        applyResumeState(ctx, resumeState);

        // Restore SID from discovery if not in resume state
        if (!ctx.sm.kktp.sid && s.discovery?.sid) {
          ctx.sm.kktp.sid = s.discovery.sid;
        }

        // Restore identity mappings for responder:
        // - myPubSig = our response pub_sig_resp
        // - peerPubSig = initiator's pub_sig from discovery
        if (!ctx.sm.kktp.myPubSig && s.response?.pub_sig_resp) {
          ctx.sm.kktp.myPubSig = s.response.pub_sig_resp;
        }
        if (!ctx.sm.kktp.peerPubSig && s.discovery?.pub_sig) {
          ctx.sm.kktp.peerPubSig = s.discovery.pub_sig;
        }

        // CRITICAL: Set state to ACTIVE since we have valid session keys
        // Without this, sendMessage() will throw "Cannot send in state: INIT"
        ctx.sm.state = KKTP_STATES.ACTIVE;

        log.info("KKTP: applied resume state (responder)", {
          hasSessionKey: !!ctx.sm.kktp.sessionKey,
          state: ctx.sm.state,
          isInitiator: ctx.sm.isInitiator,
        });
      } else {
        // No resume state - need to re-derive via protocol processing
        await ctx.protocol.processIncoming(s.discovery);
        if (s.response) {
          await ctx.protocol.processIncoming(s.response);
        }

        // Derive seq from messages if available
        if (Array.isArray(s.messages) && s.messages.length > 0) {
          const derived = deriveSeqFromMessages(s.messages);
          ctx.sm.kktp.outboundSeq = derived.outboundSeq;
          ctx.sm.kktp.inboundSeq = {
            AtoB: derived.inboundSeq_AtoB,
            BtoA: derived.inboundSeq_BtoA,
          };
          log.info(
            `KKTP: derived seq (responder) out=${derived.outboundSeq} AtoB=${derived.inboundSeq_AtoB} BtoA=${derived.inboundSeq_BtoA}`,
          );
        }
      }
    } catch (err) {
      log.warn(
        `KKTP: restore responder failed sid=${s.discovery.sid?.slice(0, 8)}...`,
        err?.message || err,
      );
      return;
    }

    const mailboxId = s.mailboxId || ctx.sm?.kktp?.mailboxId;
    if (!mailboxId) {
      log.warn("KKTP: restore responder failed - no mailboxId");
      return;
    }

    this._sessions.set(mailboxId, {
      ...ctx,
      discovery: s.discovery,
      response: s.response || null,
      messages: s.messages || [],
      peerPubSig: s.peerPubSig || s.discovery?.pub_sig || null,
      isInitiator: false,
      createdAt: s.createdAt || Date.now(),
    });

    log.info(
      `KKTP: restored responder mailbox=${mailboxId?.slice(0, 8)}...`,
    );
  }

  // ─────────────────────────────────────────────────────────────
  // Scheduled Persistence
  // ─────────────────────────────────────────────────────────────

  schedulePersist(mailboxId, { force = false } = {}) {
    this._schedulePersist(mailboxId, { force });
  }

  _schedulePersist(mailboxId, { force = false } = {}) {
    if (!this._persistConfig || !mailboxId) return;

    this._persistQueue.add(mailboxId);

    if (force) {
      this._flushPersistQueue().catch(() => {});
      return;
    }

    if (this._persistTimer) return;
    const delay = Number(this._persistConfig.throttleMs) || 0;
    this._persistTimer = setTimeout(() => {
      this._flushPersistQueue().catch(() => {});
    }, delay);
  }

  async _flushPersistQueue() {
    if (!this._persistConfig) return;
    if (this._persistTimer) {
      clearTimeout(this._persistTimer);
      this._persistTimer = null;
    }

    const mailboxIds = Array.from(this._persistQueue);
    this._persistQueue.clear();

    for (const mailboxId of mailboxIds) {
      await this._persistSessionState(mailboxId);
    }
  }

  async _persistSessionState(mailboxId) {
    if (!this._persistConfig) return;
    if (typeof indexedDB === "undefined") return;

    const session = this._sessions.get(mailboxId);
    if (!session) return;

    const { storageKeyPrefix, encryptFn, includeMessages } =
      this._persistConfig;

    const resumeState = extractResumeState(session);
    if (!includeMessages) {
      resumeState.messages = [];
    }

    const sid =
      session?.discovery?.sid ||
      session?.response?.sid ||
      resumeState?.discovery?.sid ||
      null;
    if (!sid) return;

    const savedAt = Date.now();
    const payload = {
      savedAt,
      sid,
      ...resumeState,
    };

    let raw = JSON.stringify(payload);
    if (encryptFn) {
      raw = await encryptFn(raw);
    }

    await this._persistence.putResumeRecord({
      sid,
      prefix: storageKeyPrefix,
      savedAt,
      data: raw,
    });
  }

  async _removeResumeState(session) {
    if (!this._persistConfig || !session) return;
    if (typeof indexedDB === "undefined") return;

    const sid =
      session?.discovery?.sid ||
      session?.response?.sid ||
      session?.discovery?.sid ||
      null;
    if (!sid) return;

    await this._persistence.deleteResumeRecord(sid);
  }

  async _loadResumeStateForSid(sid) {
    if (!sid || !this._persistConfig?.storageKeyPrefix) return null;
    try {
      const rec = await this._persistence.getResumeRecord(
        this._persistConfig.storageKeyPrefix,
        sid,
      );
      if (!rec?.data || typeof rec.data !== "string") return null;

      let parsed = null;
      try {
        const { strictParseJson } = await import("../integrity/canonical.js");
        parsed = strictParseJson(rec.data);
      } catch {
        try {
          parsed = JSON.parse(rec.data);
        } catch {
          parsed = null;
        }
      }

      if (parsed?.K_session || parsed?.mailbox_id) return parsed;
    } catch {
      // no-op
    }
    return null;
  }

  // ─────────────────────────────────────────────────────────────
  // Session Cleanup
  // ─────────────────────────────────────────────────────────────

  closeSession(mailboxId) {
    const session = this._sessions.get(mailboxId);
    if (!session) return false;

    void this._removeResumeState(session);
    session.sm.terminate();
    this._sessions.delete(mailboxId);
    return true;
  }

  zeroOutAndDelete(mailboxId) {
    const session = this._sessions.get(mailboxId);
    if (session) {
      zeroOutSessionKey(session);
    }
    this._sessions.delete(mailboxId);
  }
}
