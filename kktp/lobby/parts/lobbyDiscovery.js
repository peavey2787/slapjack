/**
 * LobbyDiscovery - Lobby discovery and join code resolution
 *
 * Handles discovering lobbies via scanning, waiting for join codes,
 * and resolving join codes to discovery anchors.
 *
 * Join Code Format: {blockHash}:{txIdPrefix}
 * - blockHash: 64-char hex - required for walkDagRange start point
 * - txIdPrefix: 8-char hex - disambiguates multiple discoveries in same block
 *
 * @module kktp/lobby/parts/lobbyDiscovery
 */

import { LOBBY_DISCOVERY_PREFIX } from "./lobbyContext.js";
import { truncate } from "./lobbyUtils.js";
import { subscribePrefix, unsubscribePrefix } from "./lobbySubscriptions.js";
import { validateLobbyMeta } from "../lobbySchemas.js";
import {
  parseKKTPPayload,
  getExpectedEndMs,
  validateAnchorOrThrow,
} from "../../protocol/sessions/index.js";
import { Logger, LogModule } from "../../core/logger.js";

const log = Logger.create(LogModule.lobby.parts.lobbyDiscovery);

/**
 * Join code format constants
 */
const JOIN_CODE_SEPARATOR = ":";
const TXID_PREFIX_LENGTH = 8;

/**
 * Build a join code from block hash and transaction ID
 * @param {string} blockHash - 64-char hex block hash
 * @param {string} txId - Full transaction ID
 * @returns {string} Join code in format "blockHash:txIdPrefix"
 */
export function buildJoinCode(blockHash, txId) {
  if (!blockHash || blockHash.length !== 64) {
    log.warn("Invalid block hash for join code", { blockHash: truncate(blockHash, 16) });
    return blockHash || "";
  }
  const txIdPrefix = txId ? txId.slice(0, TXID_PREFIX_LENGTH) : "";
  return txIdPrefix ? `${blockHash}${JOIN_CODE_SEPARATOR}${txIdPrefix}` : blockHash;
}

/**
 * Parse a join code into block hash and txId prefix
 * @param {string} joinCode - Join code string
 * @returns {{ blockHash: string, txIdPrefix: string|null }}
 */
export function parseJoinCode(joinCode) {
  if (!joinCode || typeof joinCode !== "string") {
    return { blockHash: "", txIdPrefix: null };
  }
  const separatorIndex = joinCode.indexOf(JOIN_CODE_SEPARATOR);
  if (separatorIndex === -1) {
    return { blockHash: joinCode, txIdPrefix: null };
  }
  return {
    blockHash: joinCode.slice(0, separatorIndex),
    txIdPrefix: joinCode.slice(separatorIndex + 1) || null,
  };
}

/**
 * Wait for the block hash containing our discovery anchor (join code)
 * @param {import("./lobbyContext.js").LobbyContext} ctx
 * @param {string} sid - Session ID
 * @param {string} pubSig - Public signing key
 * @returns {Promise<string|null>} Join code (blockHash:txIdPrefix) or null
 */
export async function waitForJoinCode(ctx, sid, pubSig) {
  if (!ctx.adapter?.onNewTransactionMatch) return null;

  return new Promise((resolve) => {
    let unsubscribeMatch = null;

    const timeout = setTimeout(() => {
      if (unsubscribeMatch) unsubscribeMatch();
      resolve(null);
    }, 5000);

    const handler = (match) => {
      log.debug("[LobbyDiscovery] Discovery match received:", match);
      const rawPayload = match?.decodedPayload;
      if (!rawPayload || !rawPayload.startsWith(LOBBY_DISCOVERY_PREFIX)) return;

      const parsed = parseKKTPPayload(rawPayload);
      if (!parsed || parsed.type !== "anchor") return;

      const anchor = parsed.anchor;
      if (!anchor || anchor.type !== "discovery") return;
      if (anchor.sid !== sid) return;
      if (anchor.pub_sig !== pubSig) return;

      const blockHash = match?.blockHash;
      const txId = match?.txid || match?.txId || match?.transactionId;

      if (blockHash) {
        clearTimeout(timeout);
        if (unsubscribeMatch) unsubscribeMatch();
        const joinCode = buildJoinCode(blockHash, txId);
        log.info("Join code generated", {
          blockHash: truncate(blockHash, 16),
          txIdPrefix: txId?.slice(0, TXID_PREFIX_LENGTH),
        });
        resolve(joinCode);
      }
    };

    unsubscribeMatch = ctx.adapter.onNewTransactionMatch(handler) || null;
  });
}

/**
 * Resolve a join code to a discovery anchor
 * @param {import("./lobbyContext.js").LobbyContext} ctx
 * @param {string} joinCode - Join code (blockHash or blockHash:txIdPrefix)
 * @returns {Promise<Object>} Discovery anchor
 */
export async function resolveJoinCode(ctx, joinCode) {
  if (!ctx.adapter?.walkDagRange) {
    throw new Error("KKTP Lobby: walkDagRange not available on adapter");
  }

  const { blockHash, txIdPrefix } = parseJoinCode(joinCode);

  if (!blockHash || blockHash.length !== 64) {
    throw new Error(`Invalid join code: block hash must be 64 hex chars, got ${blockHash?.length || 0}`);
  }

  log.info("Resolving join code", {
    blockHash: truncate(blockHash, 16),
    txIdPrefix: txIdPrefix || "(none)",
  });

  let foundDiscovery = null;

  await ctx.adapter.walkDagRange({
    startHash: blockHash,
    endHash: blockHash,
    prefixes: [LOBBY_DISCOVERY_PREFIX],
    onMatch: (match) => {
      if (foundDiscovery) return;

      const matchTxId = match?.txid || match?.txId || match?.transactionId || "";
      if (txIdPrefix && !matchTxId.startsWith(txIdPrefix)) {
        log.debug("Skipping match - txId prefix mismatch", {
          expected: txIdPrefix,
          got: matchTxId.slice(0, TXID_PREFIX_LENGTH),
        });
        return;
      }

      const rawPayload = match?.decodedPayload;
      if (!rawPayload || !rawPayload.startsWith(LOBBY_DISCOVERY_PREFIX)) return;

      const parsed = parseKKTPPayload(rawPayload);
      if (!parsed || parsed.type !== "anchor") return;

      const anchor = parsed.anchor;
      if (!anchor || anchor.type !== "discovery") return;

      foundDiscovery = anchor;
      log.info("Discovery anchor resolved", {
        sid: truncate(anchor.sid, 16),
        txId: truncate(matchTxId, 16),
      });
    },
    maxSeconds: 30,
  });

  if (!foundDiscovery) {
    throw new Error(
      txIdPrefix
        ? `No discovery anchor found in block with txId prefix ${txIdPrefix}`
        : "No discovery anchor found in block for this join code."
    );
  }

  return foundDiscovery;
}

/**
 * Discover lobbies by scanning live matching transactions
 *
 * @param {import("./lobbyContext.js").LobbyContext} ctx
 * @param {Object} [options]
 * @param {string} [options.gameName] - Filter by meta.game
 * @param {boolean} [options.includeExpired=false] - Include expired lobbies
 * @param {boolean} [options.autoStartScanner=true] - Start scanner if needed
 * @param {string} [options.prefix] - Override payload prefix to scan
 * @param {Function} [options.onLobby] - Callback for each discovered lobby
 * @param {Function} [options.onError] - Callback for discovery errors
 * @returns {Promise<{ stop: Function, getResults: Function }>} Controller
 */
export async function discoverLobby(ctx, options = {}) {
  const {
    gameName,
    includeExpired = false,
    autoStartScanner = true,
    prefix = LOBBY_DISCOVERY_PREFIX,
    onLobby,
    onError,
  } = options;

  if (!ctx.adapter?.addPrefix || !ctx.adapter?.onNewTransactionMatch) {
    throw new Error("KKTP Lobby: Scanner adapter is not available");
  }

  const seen = new Map();

  const handleMatch = (match) => {
    try {
      const rawPayload = match?.decodedPayload;
      if (!rawPayload || !rawPayload.startsWith(prefix)) return;

      const parsed = parseKKTPPayload(rawPayload);
      if (!parsed || parsed.type !== "anchor") return;

      const anchor = parsed.anchor;
      validateAnchorOrThrow(anchor);
      if (anchor.type !== "discovery") return;

      const meta = anchor.meta || {};
      if (meta.lobby !== true) return;
      try {
        validateLobbyMeta(meta);
      } catch {
        return;
      }
      if (gameName && meta.game !== gameName) return;

      if (!includeExpired) {
        const expectedEndMs = getExpectedEndMs(anchor, match?.timestamp);
        if (expectedEndMs && Date.now() > expectedEndMs) return;
      }

      const lobbyId = anchor.sid;
      if (!lobbyId || seen.has(lobbyId)) return;

      const blockHash = match?.blockHash || match?.hash;
      const txId = match?.txid || match?.txId || match?.transactionId;

      const info = {
        lobbyId,
        lobbyName: meta.lobby_name,
        game: meta.game,
        maxMembers: meta.max_members,
        discovery: anchor,
        meta,
        match,
        joinCode: buildJoinCode(blockHash, txId),
      };

      seen.set(lobbyId, info);
      onLobby?.(info);
    } catch (err) {
      onError?.(err);
    }
  };

  const unsubscribe = ctx.adapter.onNewTransactionMatch(handleMatch);
  subscribePrefix(ctx, prefix);

  if (autoStartScanner && ctx.adapter.startScanner) {
    try {
      await ctx.adapter.startScanner();
    } catch (err) {
      onError?.(err);
    }
  }

  return {
    stop: () => {
      if (typeof unsubscribe === "function") {
        unsubscribe();
      }
      unsubscribePrefix(ctx, prefix);
    },
    getResults: () => Array.from(seen.values()),
  };
}
