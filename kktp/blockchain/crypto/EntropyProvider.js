/**
 * EntropyProvider.js - Block hash subscription and entropy sources
 */

import { Logger, LogModule } from "../../core/logger.js";
import { bytesToHex, hexToBytes } from "../../core/cryptoUtils.js";

const log = Logger.create(LogModule.anchor.vrfOperations);

export class EntropyProvider {
  constructor({ kaspaLink, sessionController } = {}) {
    this._kaspaLink = kaspaLink ?? null;
    this._sessionController = sessionController ?? null;
    this._blockUnsubscribe = null;
    this._currentBlockHash = null;
    this._currentBlockHashHex = "";
  }

  setKaspaLink(kaspaLink) {
    this._kaspaLink = kaspaLink;
  }

  setSessionController(sessionController) {
    this._sessionController = sessionController;
  }

  subscribeToBlocks() {
    if (!this._kaspaLink) return;

    this._kaspaLink.startScanner?.()?.catch?.((e) => {
      log.warn("Scanner check:", e?.message ?? e);
    });

    if (this._blockUnsubscribe) {
      this._blockUnsubscribe();
      this._blockUnsubscribe = null;
    }

    this._currentBlockHash = null;
    this._currentBlockHashHex = "";

    this._blockUnsubscribe = this._kaspaLink.onNewBlock?.((block) => {
      const header = block?.header ?? block ?? {};
      const hash = header.hash ?? header.blockHash ?? header.headerHash;

      if (hash) {
        if (typeof hash === "string") {
          this._currentBlockHashHex = hash;
          try {
            this._currentBlockHash = hexToBytes(hash);
          } catch (e) {
            log.warn("Failed to parse block hash", e);
          }
        } else if (hash instanceof Uint8Array) {
          this._currentBlockHash = hash;
          this._currentBlockHashHex = bytesToHex(hash);
        }
      }
    });

    log.info("Subscribed to live block stream for move hashing");
  }

  cleanup() {
    if (this._blockUnsubscribe) {
      this._blockUnsubscribe();
      this._blockUnsubscribe = null;
      log.debug("Block subscription cleaned up");
    }
  }

  getCurrentBlockHash() {
    if (this._currentBlockHash?.length === 32) {
      return {
        hash: this._currentBlockHash,
        hex: this._currentBlockHashHex,
        source: "live",
      };
    }

    const session = this._sessionController;
    if (session) {
      const stream = session.blockHashStream;
      let bytes = null;

      if (Array.isArray(stream) && stream.length > 0) {
        bytes = stream[stream.length - 1];
      }

      if (!bytes && session.endBlockHash) {
        bytes = session.endBlockHash;
      }

      if (!bytes && session.startBlockHash) {
        bytes = session.startBlockHash;
      }

      if (bytes?.length === 32) {
        const hex = bytesToHex(bytes);
        this._currentBlockHash = bytes;
        this._currentBlockHashHex = hex;
        return { hash: bytes, hex, source: "session" };
      }
    }

    throw new Error("VRF REQUIRED: no live block hash available");
  }

  getCachedBlockHash() {
    if (this._currentBlockHash?.length === 32) {
      return {
        hash: this._currentBlockHash,
        hex: this._currentBlockHashHex,
      };
    }
    return {
      hash: new Uint8Array(32),
      hex: "0".repeat(64),
    };
  }
}

export default EntropyProvider;
