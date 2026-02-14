// kktp/protocol/kktpProtocolFacade.js
import {
  discoveryValidator,
  responseValidator,
  sessionEndValidator,
} from "./integrity/validator.js";
import {
  canonicalize,
  prepareForSigning,
  toPlainJson as _toPlainJson,
  strictParseJson,
} from "./integrity/canonical.js";
import { KKTP_STATES } from "./sessions/stateMachine.js";
import { AnchorFactory } from "./integrity/anchorFactory.js";
import { bytesToHex } from "./utils/conversions.js";

/**
 * KKTPProtocol - Handles KKTP protocol operations (anchor creation, signing, intake)
 *
 * Requires a KaspaAdapter for network operations (via state machine).
 */
export class KKTPProtocol {
  /**
   * @param {import('./sessions/stateMachine.js').KKTPStateMachine} stateMachine - State machine with adapter
   */
  constructor(stateMachine) {
    this.sm = stateMachine;
    // AnchorFactory receives adapter from state machine
    this.anchorFactory = new AnchorFactory(stateMachine.adapter);
  }

  /**
   * PHASE 1: Create a Discovery Anchor
   * Delegates to factory for complex construction/VRF/Versioning.
   * Uses prederivedKeys if available (per-contact branch system), otherwise derives fresh.
   */
  async createDiscoveryAnchor(meta) {
    // Use pre-derived keys from branch system if available, otherwise derive fresh
    const keys = this.sm.kktp.prederivedKeys
      ? this.sm.kktp.prederivedKeys
      : await this.sm.adapter.generateIdentityKeys(this.sm.keyIndex);

    this.sm.kktp.myDhPriv = keys.dh.privateKey;
    this.sm.kktp.myPrivSig = keys.sig.privateKey; // Store for SessionEnd signing (§5.5)

    const discovery = await this.anchorFactory.createDiscovery({
      meta,
      sig: keys.sig,
      dh: keys.dh,
    });
    discovery.sig = await this.signAnchor(discovery, keys.sig.privateKey);
    discoveryValidator.validate(discovery);

    // Store for the Initiator's state
    this.sm.kktp.discoveryAnchor = discovery;

    return { discovery, dhPrivateKey: keys.dh.privateKey };
  }

  /**
   * PHASE 2: Create a Response Anchor
   * Uses prederivedKeys if available (per-contact branch system), otherwise derives fresh.
   */
  async createResponseAnchor(discovery) {
    // Use pre-derived keys from branch system if available, otherwise derive fresh
    const keys = this.sm.kktp.prederivedKeys
      ? this.sm.kktp.prederivedKeys
      : await this.sm.adapter.generateIdentityKeys(this.sm.keyIndex);

    this.sm.kktp.myDhPriv = keys.dh.privateKey;
    this.sm.kktp.myPrivSig = keys.sig.privateKey; // Store for SessionEnd signing (§5.5)

    const response = await this.anchorFactory.createResponse(discovery, {
      sig: keys.sig,
      dh: keys.dh,
    });
    response.sig_resp = await this.signAnchor(response, keys.sig.privateKey);
    responseValidator.validate(response);

    // Trigger State Machine connection immediately for Responder
    await this.sm.connect(discovery, response);

    return { response, dhPrivateKey: keys.dh.privateKey };
  }

  /**
   * PHASE 3: Communicate
   * Delegates to state machine for proper seq tracking (§6.6)
   */
  createMessageAnchor(plaintext) {
    if (this.sm.state !== KKTP_STATES.ACTIVE) {
      throw new Error("Cannot send message: Session not established.");
    }

    // Use state machine to ensure seq tracking + canonicalization (§5.4, §6.6)
    return this.sm.sendMessage(plaintext);
  }

  /**
   * PHASE 4: Terminate (§5.5, §7.7)
   */
  async createEndAnchor(reason = "finished") {
    let priv = this.sm.kktp.myPrivSig;
    let pub = this.sm.kktp.myPubSig;

    // Normalize or re-derive if missing/invalid
    if (!priv || (typeof priv !== "string" && !(priv instanceof Uint8Array))) {
      const keys = this.sm.kktp.prederivedKeys
        ? this.sm.kktp.prederivedKeys
        : await this.sm.adapter.generateIdentityKeys(this.sm.keyIndex);
      priv = keys.sig.privateKey;
      pub = keys.sig.publicKey;
    }

    if (priv instanceof Uint8Array) {
      priv = bytesToHex(priv);
    }

    this.sm.kktp.myPrivSig = priv;
    this.sm.kktp.myPubSig = pub;

    const anchor = await this.anchorFactory.createSessionEndAnchor(
      this.sm.kktp.sid,
      this.sm.kktp.myPubSig,
      reason,
    );

    anchor.sig = await this.signAnchor(anchor, this.sm.kktp.myPrivSig);

    sessionEndValidator.validate(anchor);
    this.sm.terminate();

    return anchor;
  }

  /**
   * THE INTAKE: Process any incoming KKTP object
   */
  async processIncoming(anchor) {
    switch (anchor.type) {
      case "discovery":
        // §6.1: Discovery is the start. Schema is already verified by Adapter.
        return { type: "DISCOVERY_RECEIVED", data: anchor };

      case "response":
        // §6.1: Handshake logic
        const discoveryRef = this.sm.kktp.discoveryAnchor;
        if (!discoveryRef)
          throw new Error("No active discovery to respond to.");

        await this.sm.connect(discoveryRef, anchor);
        return {
          type: "HANDSHAKE_COMPLETE",
          mailboxId: this.sm.kktp.mailboxId,
        };

      case "msg":
        // §6.6: Encrypted payload path
        const messages = this.sm.receiveMessage(anchor);
        return { type: "MESSAGES_READY", data: messages };

      case "session_end":
        // §7.4 & §7.7: Identity + Termination
        // We don't need verifyMessage() here because the ADAPTER just did it!
        // We only check: Is the signer actually the Peer or Me?
        const isFromMe = anchor.pub_sig === this.sm.kktp.myPubSig;
        const isFromPeer = anchor.pub_sig === this.sm.kktp.peerPubSig;

        if (!isFromMe && !isFromPeer) {
          throw new Error(
            "Unauthorized SessionEnd: Signer is not a session participant.",
          );
        }

        this.sm.terminate();
        return { type: "SESSION_CLOSED", data: anchor.reason };

      default:
        throw new Error(`Unknown KKTP type: ${anchor.type}`);
    }
  }

  /**
   * Utility: Sign a KKTP Anchor
   */
  async signAnchor(anchor, privateKeyHex) {
    const isResponse = anchor.type === "response";
    const omitKeys = isResponse ? ["sig_resp"] : ["sig"];

    const body = canonicalize(
      prepareForSigning(anchor, { omitKeys, excludeMeta: true }),
    );

    // The protocol calls the adapter for the raw signature
    return await this.sm.adapter.signMessage(privateKeyHex, body);
  }

  /**
   * EXPOSED FOR AUDITORS:
   * Formats any object according to the RFC 8785 (JCS) strict rules.
   */
  canonicalize(obj) {
    return canonicalize(obj);
  }

  /**
   * EXPOSED FOR AUDITORS:
   * Strips the signature and non-signed metadata to prepare for hash verification.
   */
  prepareForVerification(anchor) {
    const isResponse = anchor.type === "response";
    const omitKeys = isResponse ? ["sig_resp"] : ["sig"];
    // Note: excludeMeta: true is critical as per §5.4
    return prepareForSigning(anchor, { omitKeys, excludeMeta: true });
  }

  /**
   * EXPOSED FOR AUDITORS:
   * Converts an object to plain JSON (no methods, no prototypes)
   */
  toPlainJson(value) {
    return _toPlainJson(value);
  }

  /** EXPOSED FOR AUDITORS:
   * Strict JSON parsing that rejects non-JSON types.
   * @param {string} value - JSON string to parse
   * @returns {any} Parsed JSON object
   */
  strictParseJson(value) {
    return strictParseJson(value);
  }
}
