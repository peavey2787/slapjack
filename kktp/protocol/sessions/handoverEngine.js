// kktp/protocol/sessions/handoverEngine.js
// Sovereign Resume / Session Handover Logic

import { hexToString } from "../utils/conversions.js";
import { strictParseJson } from "../integrity/canonical.js";
import {
  parseKKTPPayload,
  extractResumeState,
  applyResumeState,
  zeroOutSessionKey,
} from "./smHelpers.js";

/**
 * Handles the complex resumeSession logic with syncFrom loops.
 * Manages handover negotiations between old and new sessions.
 */
export class HandoverEngine {
  /**
   * @param {Object} options
  * @param {import('../../adapters/kaspaAdapter.js').KaspaAdapter} options.adapter - Network adapter
   * @param {Object} options.persistence - SessionPersistence instance
   * @param {Object} options.vault - SessionVault instance
   */
  constructor({ adapter, persistence, vault } = {}) {
    if (!adapter) throw new Error("HandoverEngine: adapter is required");
    if (!persistence) throw new Error("HandoverEngine: persistence is required");
    if (!vault) throw new Error("HandoverEngine: vault is required");

    this._adapter = adapter;
    this._persistence = persistence;
    this._vault = vault;
  }

  /**
   * Set the sendMessage and connectToPeer callbacks.
   * These must be set by the facade after construction.
   * @param {{ sendMessage: Function, connectToPeer: Function }} callbacks
   */
  setCallbacks({ sendMessage, connectToPeer }) {
    this._sendMessage = sendMessage;
    this._connectToPeer = connectToPeer;
  }

  /**
   * Set the incoming message handler callback.
   * @param {Function} handler - Function to handle incoming messages
   */
  setMessageHandler(handler) {
    this._handleIncomingMessage = handler;
  }

  // ─────────────────────────────────────────────────────────────
  // Sovereign Resume
  // ─────────────────────────────────────────────────────────────

  /**
   * Resume a session using stored state, scanning the DAG for handover messages.
   * @param {Object} options
   * @param {string} [options.sid] - Session ID to resume
   * @param {string} [options.startHash] - Block hash to start scanning from
   * @param {number} [options.maxSeconds=30] - Maximum scan duration
   * @param {Function} [options.logFn] - Logging callback
   * @param {Function} [options.decryptFn] - Decryption function for stored state
   * @param {Function} [options.encryptFn] - Encryption function for new state
   * @param {string} [options.storageKeyPrefix="kktp_resume_"] - Storage key prefix
   * @param {Object} [options.meta={}] - Metadata for new discovery anchor
   * @returns {Promise<Object>} Resume result with status
   */
  async resumeSession({
    sid,
    startHash,
    maxSeconds = 30,
    logFn,
    decryptFn,
    encryptFn,
    storageKeyPrefix = "kktp_resume_",
    meta = {},
  } = {}) {
    logFn = typeof logFn === "function" ? logFn : () => {};

    // 1. Load resume record
    const record = sid
      ? await this._persistence.getResumeRecord(storageKeyPrefix, sid)
      : await this._persistence.findLatestResumeRecord(storageKeyPrefix);

    if (!record?.data) return { status: "no_resume_blob" };

    // 2. Decrypt and parse resume data
    const resumeData = await this._parseResumeData(record.data, decryptFn);
    if (!resumeData) return resumeData; // Returns error status

    if (!resumeData?.mailbox_id || !resumeData?.K_session) {
      return { status: "invalid_resume_blob" };
    }

    const oldMailboxId = resumeData.mailbox_id;
    const oldSid = resumeData.sid || sid || resumeData.discovery?.sid || "";
    const scanStartHash =
      startHash ||
      resumeData.startHash ||
      resumeData.last_block_hash ||
      resumeData.discovery_block_hash;

    if (!scanStartHash) {
      throw new Error("resumeSession: startHash is required");
    }

    // 3. Restore old session context
    const oldCtx = this._vault.createContext(
      resumeData.isInitiator ?? true,
      resumeData.keyIndex ?? null,
    );
    applyResumeState(oldCtx, resumeData);

    this._vault.sessions.set(oldMailboxId, {
      ...oldCtx,
      discovery: resumeData.discovery || null,
      response: resumeData.response || null,
      messages: resumeData.messages || [],
      peerPubSig: resumeData.remote_pub_sig || null,
      isInitiator: !!resumeData.isInitiator,
      createdAt: resumeData.createdAt || Date.now(),
    });

    // 4. Scan for peer handover
    const peerHandover = await this._scanForPeerHandover(
      oldMailboxId,
      scanStartHash,
      maxSeconds,
      logFn,
    );

    if (peerHandover?.new_anchor) {
      const { mailboxId } = await this._connectToPeer(peerHandover.new_anchor);
      return {
        status: "pivoted",
        mailboxId,
        newSid: peerHandover.new_sid || peerHandover.new_anchor?.sid,
      };
    }

    // 5. Create new discovery for handover
    const newCtx = this._vault.createContext(true);
    const { discovery } = await newCtx.protocol.createDiscoveryAnchor(meta);

    this._vault.pendingDiscoveries.set(discovery.sid, {
      ...newCtx,
      discovery,
      createdAt: Date.now(),
    });

    // 6. Scan for response to new discovery
    const responseAnchor = await this._scanForResponse(
      discovery.sid,
      scanStartHash,
      maxSeconds,
      logFn,
    );

    if (!responseAnchor) {
      // Send handover message on old session
      await this._sendMessage(
        oldMailboxId,
        JSON.stringify({
          intent: "handover",
          new_sid: discovery.sid,
          new_anchor: discovery,
        }),
      );

      return {
        status: "handover_pending",
        newSid: discovery.sid,
      };
    }

    // 7. Handle response and establish new session
    return await this._completeHandover({
      discovery,
      responseAnchor,
      oldMailboxId,
      oldSid,
      scanStartHash,
      maxSeconds,
      logFn,
      encryptFn,
      storageKeyPrefix,
    });
  }

  // ─────────────────────────────────────────────────────────────
  // Internal Helpers
  // ─────────────────────────────────────────────────────────────

  async _parseResumeData(raw, decryptFn) {
    try {
      if (decryptFn) {
        const decrypted = await decryptFn(raw);
        return strictParseJson(decrypted) || decrypted;
      } else {
        return strictParseJson(raw);
      }
    } catch (err) {
      return { status: "decrypt_failed", error: err.message };
    }
  }

  async _scanForPeerHandover(oldMailboxId, scanStartHash, maxSeconds, logFn) {
    let peerHandover = null;

    await this._adapter.walkDagRange({
      startHash: scanStartHash,
      maxSeconds,
      prefixes: [`KKTP:${oldMailboxId}:`],
      logFn,
      onMatch: ({ payload }) => {
        const payloadHex = payload || "";
        if (!payloadHex) return false;

        let rawPayload = "";
        try {
          rawPayload = hexToString(payloadHex);
        } catch {
          return false;
        }

        const parsed = parseKKTPPayload(rawPayload);
        if (parsed?.type !== "message") return false;

        const event = this._handleIncomingMessage(
          parsed.mailboxId,
          parsed.message,
        );
        const messages = event?.messages || [];
        for (const msg of messages) {
          const obj = JSON.parse(msg);
          if (obj?.intent === "handover" && obj?.new_anchor) {
            peerHandover = obj;
            return true;
          }
        }
        return false;
      },
    });

    return peerHandover;
  }

  async _scanForResponse(discoverySid, scanStartHash, maxSeconds, logFn) {
    let responseAnchor = null;

    await this._adapter.walkDagRange({
      startHash: scanStartHash,
      maxSeconds,
      prefixes: ["KKTP:ANCHOR:"],
      logFn,
      onMatch: ({ payload }) => {
        const payloadHex = payload || "";
        if (!payloadHex) return false;

        let rawPayload = "";
        try {
          rawPayload = hexToString(payloadHex);
        } catch {
          return false;
        }

        const parsed = parseKKTPPayload(rawPayload);
        if (
          parsed?.type === "anchor" &&
          parsed.anchor.type === "response" &&
          parsed.anchor.sid === discoverySid
        ) {
          responseAnchor = parsed.anchor;
          return true;
        }
        return false;
      },
    });

    return responseAnchor;
  }

  async _completeHandover({
    discovery,
    responseAnchor,
    oldMailboxId,
    oldSid,
    scanStartHash,
    maxSeconds,
    logFn,
    encryptFn,
    storageKeyPrefix,
  }) {
    // Process the response anchor
    // Note: _handleIncomingAnchor must be set by the facade
    if (this._handleIncomingAnchor) {
      await this._handleIncomingAnchor(responseAnchor);
    }

    const found = this._vault.findSessionByDiscoverySid(discovery.sid);
    if (!found) {
      return { status: "handover_failed", reason: "session_not_established" };
    }

    const newMailboxId = found.mailboxId;

    // Scan for lock confirmation
    const lockAchieved = await this._scanForLock(
      newMailboxId,
      scanStartHash,
      maxSeconds,
      logFn,
    );

    if (!lockAchieved) {
      return {
        status: "handover_no_lock",
        newMailboxId,
        newSid: discovery.sid,
      };
    }

    // Clean up old session
    const oldSession = this._vault.sessions.get(oldMailboxId);
    if (oldSession) zeroOutSessionKey(oldSession);
    this._vault.sessions.delete(oldMailboxId);

    // Persist new session state
    if (encryptFn) {
      const newState = extractResumeState(this._vault.sessions.get(newMailboxId));
      const encrypted = await encryptFn(
        JSON.stringify({
          savedAt: Date.now(),
          ...newState,
          sid: discovery.sid,
        }),
      );

      await this._persistence.putResumeRecord({
        sid: discovery.sid,
        prefix: storageKeyPrefix,
        savedAt: Date.now(),
        data: encrypted,
      });

      if (oldSid) {
        await this._persistence.deleteResumeRecord(oldSid);
      }
    }

    return {
      status: "handover_complete",
      newMailboxId,
      newSid: discovery.sid,
    };
  }

  async _scanForLock(newMailboxId, scanStartHash, maxSeconds, logFn) {
    let lockAchieved = false;

    await this._adapter.walkDagRange({
      startHash: scanStartHash,
      maxSeconds,
      prefixes: [`KKTP:${newMailboxId}:`],
      logFn,
      onMatch: ({ payload }) => {
        const payloadHex = payload || "";
        if (!payloadHex) return false;

        let rawPayload = "";
        try {
          rawPayload = hexToString(payloadHex);
        } catch {
          return false;
        }

        const parsed = parseKKTPPayload(rawPayload);
        if (parsed?.type !== "message") return false;

        const event = this._handleIncomingMessage(
          parsed.mailboxId,
          parsed.message,
        );
        if (event?.messages?.length > 0) {
          lockAchieved = true;
          return true;
        }
        return false;
      },
    });

    return lockAchieved;
  }

  /**
   * Set the anchor handler callback.
   * @param {Function} handler - Function to handle incoming anchors
   */
  setAnchorHandler(handler) {
    this._handleIncomingAnchor = handler;
  }
}
