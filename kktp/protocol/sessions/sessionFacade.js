// kktp/protocol/sessions/sessionFacade.js
// Session Facade - Slim public API delegating to internal services

import { KKTPProtocol } from "../kktpProtocolFacade.js";
import { KKTPStateMachine } from "./stateMachine.js";
import { canonicalize, prepareForSigning } from "../integrity/canonical.js";
import { Logger, LogModule } from "../../core/logger.js";

// Internal Services
import {
  KeyDeriver,
  SessionVault,
  HandoverEngine,
  SessionPersistence,
  buildAnchorPayload,
  parseKKTPPayload,
  validateAnchorOrThrow,
} from "./index.js";

const log = Logger.create(LogModule.protocol.sessions.sessionFacade);

/**
 * SessionFacade - Clean public API for KKTP session management.
 * Delegates to internal services for modularity and testability.
 *
 * Uses KaspaAdapter as the bridge to the underlying transport, enabling network-agnostic
 * operation and easy swapping of the underlying transport layer.
 */
export class SessionFacade {
  /**
   * @param {import('../../adapters/kaspaAdapter.js').KaspaAdapter} adapter - KaspaAdapter instance
   */
  constructor(adapter) {
    if (!adapter) {
      throw new Error("SessionFacade: adapter instance is required");
    }

    this._adapter = adapter;

    // Initialize internal services with adapter
    this._persistence = new SessionPersistence();
    this._keyDeriver = new KeyDeriver({
      adapter: this._adapter,
      persistence: this._persistence,
    });
    this._vault = new SessionVault({
      adapter: this._adapter,
      persistence: this._persistence,
      keyDeriver: this._keyDeriver,
    });
    this._handover = new HandoverEngine({
      adapter: this._adapter,
      persistence: this._persistence,
      vault: this._vault,
    });

    // Wire up handover callbacks
    this._handover.setCallbacks({
      sendMessage: (mailboxId, plaintext, options) =>
        this.sendMessage(mailboxId, plaintext, options),
      connectToPeer: (discoveryAnchor, options) =>
        this.connectToPeer(discoveryAnchor, options),
    });
    this._handover.setMessageHandler((mailboxId, message) =>
      this._handleIncomingMessage(mailboxId, message),
    );
    this._handover.setAnchorHandler((anchor) =>
      this._handleIncomingAnchor(anchor),
    );

    // Protocol instance for signing/verification helpers (uses adapter via SM)
    const sm = new KKTPStateMachine(this._adapter, true, 0);
    this.kktpProtocol = new KKTPProtocol(sm);
  }

  /**
   * Get the adapter for advanced use cases or testing.
   * @returns {KaspaAdapter}
   */
  get adapter() {
    return this._adapter;
  }

  // ─────────────────────────────────────────────────────────────
  // KKTP Protocol Helpers
  // ─────────────────────────────────────────────────────────────

  async signAnchor(anchor) {
    if (!this._adapter.isWalletInitialized) {
      throw new Error("KKTP: Wallet must be initialized.");
    }
    const { sig } = await this._adapter.generateIdentityKeys(0);
    return await this.kktpProtocol.signAnchor(anchor, sig.privateKey);
  }

  prepareForVerification(anchor) {
    return this.kktpProtocol.prepareForVerification(anchor);
  }

  canonicalize(obj) {
    return this.kktpProtocol.canonicalize(obj);
  }

  toPlainJson(value) {
    return this.kktpProtocol.toPlainJson(value);
  }

  strictParseJson(value) {
    return KKTPProtocol.strictParseJson(value);
  }

  // ─────────────────────────────────────────────────────────────
  // Persistence Configuration
  // ─────────────────────────────────────────────────────────────

  configureResumePersistence(options) {
    return this._vault.configureResumePersistence(options);
  }

  forcePersistAllSessions() {
    this._vault.forcePersistAllSessions();
  }

  /**
   * Register a LobbyManager for including lobby state in session persistence.
   * Called automatically by LobbyFacade when created.
   * @param {Object} lobbyManager - LobbyManager instance
   */
  setLobbyManager(lobbyManager) {
    this._vault.setLobbyManager(lobbyManager);
  }

  // ─────────────────────────────────────────────────────────────
  // Session Lifecycle
  // ─────────────────────────────────────────────────────────────

  async broadcastDiscovery(meta, options = {}) {
    const { amount = "1", toAddress, peerPubSig } = options;

    // Create context for discovery
    const ctx = this._vault.createContext(true);

    // If we know the target peer, prepare their branch
    if (peerPubSig) {
      const branch = await this._keyDeriver.prepareKeyBranch(peerPubSig, true);
      ctx.keyIndex = branch.keyIndex;
      ctx.baseIndex = branch.baseIndex;
      ctx.sm.keyIndex = branch.keyIndex;
      ctx.sm.kktp.prederivedKeys = branch.prederivedKeys;
    }

    const { discovery } = await ctx.protocol.createDiscoveryAnchor(meta);

    this._vault.setPendingDiscovery(discovery.sid, {
      ...ctx,
      discovery,
      createdAt: Date.now(),
    });

    log.info(
      `KKTP: pending discovery sid=${discovery.sid?.slice(0, 8)}... pending=${this._vault.pendingDiscoveries.size}`,
    );

    const payload = buildAnchorPayload(discovery);
    const address = toAddress ?? (await this._adapter.getAddress());

    const fromAddress = await this._adapter.getAddressWithLargestUtxo();
    const privateKeys = await this._adapter.getPrivateKeys({
      keyCount: 10,
      changeKeyCount: 10,
    });

    await this._adapter.manualSend({
      fromAddress,
      toAddress: address,
      amount,
      payload,
      privateKeys,
    });

    return { discovery, payload };
  }

  async connectToPeer(discoveryAnchor, options = {}) {
    const { amount = "1", toAddress } = options;

    // Prepare branch for this specific peer (responder role)
    const peerPubSig = discoveryAnchor.pub_sig;
    const branch = await this._keyDeriver.prepareKeyBranch(peerPubSig, false);

    const ctx = this._vault.createContext(false, branch.keyIndex);
    ctx.baseIndex = branch.baseIndex;
    ctx.sm.kktp.prederivedKeys = branch.prederivedKeys;

    log.info(
      `KKTP: connectToPeer peer=${peerPubSig.slice(0, 8)}... base=${branch.baseIndex} keyIndex=${branch.keyIndex}`,
    );

    const { response } =
      await ctx.protocol.createResponseAnchor(discoveryAnchor);

    const mailboxId = ctx.protocol.sm.kktp.mailboxId;
    this._vault.setSession(mailboxId, {
      ...ctx,
      discovery: discoveryAnchor,
      response,
      messages: [],
      peerPubSig: discoveryAnchor.pub_sig,
      isInitiator: false,
      createdAt: Date.now(),
    });

    const payload = buildAnchorPayload(response);
    const address = toAddress ?? (await this._adapter.getAddress());

    const fromAddress = await this._adapter.getAddressWithLargestUtxo();
    const privateKeys = await this._adapter.getPrivateKeys({
      keyCount: 10,
      changeKeyCount: 10,
    });

    await this._adapter.manualSend({
      fromAddress,
      toAddress: address,
      amount,
      payload,
      privateKeys,
    });

    // CRITICAL: Subscribe to DM mailbox IMMEDIATELY after session is created
    // This ensures we can receive responses from the initiator without race conditions
    const dmPrefix = `KKTP:${mailboxId}:`;
    this._adapter.addPrefix(dmPrefix);
    log.info(
      `KKTP: Subscribed to DM mailbox (responder) prefix=${dmPrefix.slice(0, 32)}...`,
    );

    return { response, mailboxId, payload };
  }

  async sendMessage(mailboxId, plaintext, options = {}) {
    const { amount = "1", toAddress } = options;

    const session = this._vault.getSession(mailboxId);
    if (!session) {
      throw new Error(`KKTP: No session found for mailboxId ${mailboxId}`);
    }

    const canonicalMessage = session.protocol.createMessageAnchor(plaintext);
    const payload = `KKTP:${mailboxId}:${canonicalMessage}`;

    const address = toAddress ?? (await this._adapter.getAddress());
    const fromAddress = await this._adapter.getAddressWithLargestUtxo();
    const privateKeys = await this._adapter.getPrivateKeys({
      keyCount: 10,
      changeKeyCount: 10,
    });

    await this._adapter.manualSend({
      fromAddress,
      toAddress: address,
      amount,
      payload,
      privateKeys
    });

    session.messages = session.messages || [];
    session.messages.push({
      id: crypto.randomUUID(),
      direction: session.sm.isInitiator ? "AtoB" : "BtoA",
      plaintext,
      timestamp: Date.now(),
      status: "pending",
      isOutbound: true,
    });

    this._vault.schedulePersist(mailboxId);

    return { payload };
  }

  // ─────────────────────────────────────────────────────────────
  // Incoming Payload Processing
  // ─────────────────────────────────────────────────────────────

  async processIncomingPayload(rawPayload) {
    const parsed = parseKKTPPayload(rawPayload);
    if (!parsed) return null;

    if (parsed.type === "anchor") {
      return await this._handleIncomingAnchor(parsed.anchor);
    }

    if (parsed.type === "message") {
      return this._handleIncomingMessage(parsed.mailboxId, parsed.message);
    }

    return null;
  }

  // ─────────────────────────────────────────────────────────────
  // Session Query & Management
  // ─────────────────────────────────────────────────────────────

  getSessions() {
    return this._vault.getSessions();
  }

  getSession(mailboxId) {
    return this._vault.getSession(mailboxId);
  }

  closeSession(mailboxId) {
    return this._vault.closeSession(mailboxId);
  }

  exportSessions(options) {
    return this._vault.exportSessions(options);
  }

  async restoreSessions(snapshot, options) {
    return await this._vault.restoreSessions(snapshot, options);
  }

  pruneExpiredSessions(nowMs) {
    return this._vault.pruneExpiredSessions(nowMs);
  }

  isSessionExpired(mailboxId, nowMs) {
    return this._vault.isSessionExpired(mailboxId, nowMs);
  }

  // ─────────────────────────────────────────────────────────────
  // Sovereign Resume
  // ─────────────────────────────────────────────────────────────

  async resumeSession(options) {
    return await this._handover.resumeSession(options);
  }

  // ─────────────────────────────────────────────────────────────
  // Internal Helpers
  // ─────────────────────────────────────────────────────────────

  async _verifyAnchorSignature(anchor) {
    const isResponse = anchor.type === "response";
    const sigField = isResponse ? "sig_resp" : "sig";
    const pubKeyField = isResponse ? "pub_sig_resp" : "pub_sig";

    const signature = anchor[sigField];
    const pubKey = anchor[pubKeyField];

    if (!signature || !pubKey) return false;

    const body = canonicalize(
      prepareForSigning(anchor, {
        omitKeys: [sigField],
        excludeMeta: anchor.type === "discovery",
      }),
    );

    return await this._adapter.verifyMessage(pubKey, body, signature);
  }

  async _handleIncomingAnchor(anchor) {
    validateAnchorOrThrow(anchor);

    const isValidSig = await this._verifyAnchorSignature(anchor);
    if (!isValidSig) {
      throw new Error("Invalid anchor signature");
    }

    if (anchor.type === "discovery") {
      log.info(`KKTP: discovery anchor sid=${anchor.sid?.slice(0, 8)}...`);
      return { type: "discovery", anchor };
    }

    if (anchor.type === "response") {
      const responderPubSig = anchor.pub_sig_resp;

      log.info(`KKTP: response anchor sid=${anchor.sid?.slice(0, 8)}...`);
      log.info(
        `KKTP: pending discoveries=${this._vault.pendingDiscoveries.size}`,
      );

      const pending = this._vault.getPendingDiscovery(anchor.sid);
      if (!pending || anchor.initiator_pub_sig !== pending.discovery.pub_sig) {
        // No matching pending discovery - buffer as orphan
        this._vault.setOrphanResponse(anchor.sid, anchor);
        log.info(
          `KKTP: buffered response for sid ${anchor.sid.slice(0, 8)}...`,
        );
        return { type: "response_orphan", anchor };
      }

      // Check if this is a lobby discovery (supports multiple responders)
      const isLobbyDiscovery = pending.discovery?.meta?.lobby === true;

      // Check if we already have a session with this specific responder
      const existingWithPeer =
        this._vault.findSessionByPeerPubSig(responderPubSig);
      if (existingWithPeer) {
        log.info(
          `KKTP: session already exists with peer ${responderPubSig?.slice(0, 8)}...`,
        );
        return {
          type: "response_duplicate",
          mailboxId: existingWithPeer.mailboxId,
        };
      }

      // For lobby mode: create a fresh context for EACH responder but COPY the original
      // DH private key from the pending discovery. The host's discovery anchor was created
      // with specific DH keys, and ALL responders must handshake using those same keys.
      // For 1:1 mode: reuse the pending context directly (original behavior)
      let ctx;
      if (isLobbyDiscovery) {
        // Extract the original crypto material from when discovery was created
        const originalDhPriv = pending.sm?.kktp?.myDhPriv;
        const originalPrivSig = pending.sm?.kktp?.myPrivSig;
        const originalPrederivedKeys = pending.sm?.kktp?.prederivedKeys;

        if (!originalDhPriv) {
          log.error(
            "KKTP: Missing DH private key in pending lobby context",
            {
              sid: anchor.sid?.slice(0, 8),
              hasSm: !!pending.sm,
              hasKktp: !!pending.sm?.kktp,
            },
          );
          return { type: "error", reason: "Missing DH private key for lobby" };
        }

        // Create a FRESH state machine context (so each responder gets independent state)
        // but use the SAME keyIndex as the original discovery
        ctx = this._vault.createContext(true, pending.keyIndex);

        // CRITICAL: Copy the original crypto material - don't generate new keys!
        // The discovery anchor was signed with these keys, responders expect them
        ctx.sm.kktp.myDhPriv = originalDhPriv;
        ctx.sm.kktp.myPrivSig = originalPrivSig;
        ctx.sm.kktp.prederivedKeys = originalPrederivedKeys;
        ctx.sm.kktp.discoveryAnchor = pending.discovery;

        log.info(
          `KKTP: lobby mode - cloned context for peer ${responderPubSig?.slice(0, 8)}...`,
          { keyIndex: pending.keyIndex, hasOriginalDhPriv: !!originalDhPriv },
        );
      } else {
        // Standard 1:1 mode - use the pending context directly
        ctx = pending;
        if (!ctx.sm.kktp.discoveryAnchor) {
          ctx.sm.kktp.discoveryAnchor = pending.discovery;
        }
      }

      // Complete the handshake - calls sm.connect() which uses myDhPriv
      await ctx.sm.connect(pending.discovery, anchor);

      const mailboxId = ctx.sm.kktp.mailboxId;
      this._vault.setSession(mailboxId, {
        ...ctx,
        discovery: pending.discovery,
        response: anchor,
        messages: [],
        peerPubSig: responderPubSig,
        isInitiator: true,
        createdAt: Date.now(),
      });

      // For 1:1 sessions, remove the pending discovery (only one response expected)
      // For lobbies, keep it active so more peers can join
      if (!isLobbyDiscovery) {
        this._vault.deletePendingDiscovery(anchor.sid);
      }

      // CRITICAL: Subscribe to DM mailbox IMMEDIATELY after session is created
      // This ensures we can receive DM messages from the responder in the same block
      // without race conditions (e.g., lobby join requests)
      const dmPrefix = `KKTP:${mailboxId}:`;
      this._adapter.addPrefix(dmPrefix);
      log.info(
        `KKTP: Subscribed to DM mailbox (initiator) prefix=${dmPrefix.slice(0, 32)}...`,
      );

      log.info(
        `KKTP: session established mailbox=${mailboxId?.slice(0, 8)}...`,
        { isLobby: isLobbyDiscovery, peer: responderPubSig?.slice(0, 8) },
      );
      return { type: "session_established", mailboxId, response: anchor };
    }

    if (anchor.type === "session_end") {
      const sessions = this._vault.sessions;
      const sessionEntry = Array.from(sessions.entries()).find(
        ([, s]) => s?.discovery?.sid === anchor.sid,
      );

      if (sessionEntry) {
        const [mailboxId, session] = sessionEntry;
        session.sm.terminate();
        this._vault.deleteSession(mailboxId);
        return {
          type: "session_end",
          mailboxId,
          reason: anchor.reason,
          sid: anchor.sid,
          pub_sig: anchor.pub_sig,
        };
      }

      return {
        type: "session_end",
        mailboxId: null,
        reason: anchor.reason,
        sid: anchor.sid,
        pub_sig: anchor.pub_sig,
      };
    }

    return null;
  }

  _handleIncomingMessage(mailboxId, msgObject) {
    const session = this._vault.getSession(mailboxId);
    if (!session) {
      return { type: "message_ignored", mailboxId };
    }

    const plaintexts = session.sm.receiveMessage(msgObject);
    if (plaintexts && plaintexts.length > 0) {
      session.messages = session.messages || [];

      for (const plaintext of plaintexts) {
        // If this is our own outbound message confirming, upgrade the pending entry
        const pendingIndex = session.messages.findIndex(
          (m) =>
            m.isOutbound === true &&
            m.status === "pending" &&
            m.plaintext === plaintext &&
            m.direction === msgObject.direction,
        );

        if (pendingIndex >= 0) {
          const pending = session.messages[pendingIndex];
          session.messages[pendingIndex] = {
            ...pending,
            status: "confirmed",
            timestamp: pending.timestamp || Date.now(),
          };
          continue;
        }

        // Otherwise, add as a new inbound message
        session.messages.push({
          id: crypto.randomUUID(),
          direction: msgObject.direction,
          plaintext,
          timestamp: Date.now(),
          status: "confirmed",
          isOutbound: false,
        });
      }

      this._vault.schedulePersist(mailboxId);
    }

    return { type: "messages", mailboxId, messages: plaintexts || [] };
  }

  // ─────────────────────────────────────────────────────────────
  // Expose Internal Services (for advanced use cases)
  // ─────────────────────────────────────────────────────────────

  get keyDeriver() {
    return this._keyDeriver;
  }

  get vault() {
    return this._vault;
  }

  get persistence() {
    return this._persistence;
  }

  get handover() {
    return this._handover;
  }
}
