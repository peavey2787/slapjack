/**
 * chain.js - Anchor chain ordering utilities for cheating audit
 */

import { addReason, normalizeHex } from "./utils.js";

export function buildLinkedChain(
  finalTxId,
  genesisTxId,
  anchorsByTxId,
  parsedByTxId,
  reasons,
) {
  if (!finalTxId) return [];
  const chain = [];
  const visited = new Set();
  let currentTxId = finalTxId;

  while (currentTxId) {
    if (visited.has(currentTxId)) {
      addReason(reasons, "anchor_chain_loop_detected");
      break;
    }
    visited.add(currentTxId);
    const anchor = anchorsByTxId.get(currentTxId);
    if (!anchor) {
      addReason(reasons, "missing_prev_anchor");
      break;
    }
    chain.push(anchor);

    if (genesisTxId && currentTxId === genesisTxId) {
      break;
    }

    const parsed = parsedByTxId.get(currentTxId) || {};
    const prevTxId = normalizeHex(parsed.prevTxId);
    if (!prevTxId) {
      addReason(reasons, "missing_prev_txid");
      break;
    }
    if (genesisTxId && prevTxId === genesisTxId) {
      const genesisAnchor = anchorsByTxId.get(genesisTxId);
      if (genesisAnchor) chain.push(genesisAnchor);
      break;
    }
    currentTxId = prevTxId;
  }

  return chain.reverse();
}

export function pickNewest(anchors) {
  if (!Array.isArray(anchors) || anchors.length === 0) return null;
  return [...anchors].sort(
    (a, b) => (b?.timestamp ?? 0) - (a?.timestamp ?? 0),
  )[0];
}
