/**
 * auditCheating.js - On-chain cheating audit orchestrator
 */

import { ANCHOR } from "../core/constants.js";
import { buildLinkedChain, pickNewest } from "./cheating/chain.js";
import { verifyDaaScores } from "./cheating/daa.js";
import { verifyEntropySources } from "./cheating/entropy.js";
import { verifyFinalResultHash } from "./cheating/finalResult.js";
import { verifyMerkleAndMoves } from "./cheating/merkle.js";
import {
  normalizeAuditInput,
  normalizeMoveHistory,
} from "./cheating/normalize.js";
import { formatOutcome } from "./cheating/outcome.js";
import { parseAnchorByType } from "./cheating/parsing.js";
import { addReason, addWarning, normalizeHex } from "./cheating/utils.js";
import { verifyVrfChain } from "./cheating/vrfChain.js";

export async function auditCheating(input) {
  if (input?.source !== "blockchain") {
    return {
      passed: false,
      verdict: "fail",
      reasons: ["audit_source_not_blockchain"],
      warnings: [],
    };
  }

  const audit = normalizeAuditInput(input);
  const chain = audit.chain;
  if (!Array.isArray(chain) || chain.length === 0) {
    return {
      passed: false,
      verdict: "fail",
      reasons: ["missing_anchor_chain"],
      warnings: [],
    };
  }

  const reasons = [];
  const warnings = [];

  const anchorsByTxId = new Map();
  const parsedByTxId = new Map();
  const genesisAnchors = [];
  const finalAnchors = [];
  const heartbeatAnchors = [];

  for (const anchor of chain) {
    const txId = normalizeHex(anchor?.txId);
    if (!txId) {
      addWarning(warnings, "anchor_missing_txid");
      continue;
    }
    anchorsByTxId.set(txId, anchor);

    const type = String(anchor?.type || "").toLowerCase();
    if (type === "genesis") genesisAnchors.push(anchor);
    if (type === "final") finalAnchors.push(anchor);
    if (type === "heartbeat") heartbeatAnchors.push(anchor);

    const parsed = parseAnchorByType(type, anchor?.anchorHex || "");
    if (parsed.error) {
      addReason(reasons, parsed.error);
    }
    if (
      type === "genesis" &&
      parsed.anchorType &&
      parsed.anchorType !== ANCHOR.TYPE_GENESIS
    ) {
      addReason(reasons, "genesis_anchor_type_mismatch");
    }
    if (
      type === "heartbeat" &&
      parsed.anchorType &&
      parsed.anchorType !== ANCHOR.TYPE_HEARTBEAT
    ) {
      addReason(reasons, "heartbeat_anchor_type_mismatch");
    }
    if (
      type === "final" &&
      parsed.anchorType &&
      parsed.anchorType !== ANCHOR.TYPE_FINAL
    ) {
      addReason(reasons, "final_anchor_type_mismatch");
    }
    parsedByTxId.set(txId, parsed);
  }

  if (genesisAnchors.length === 0) {
    addReason(reasons, "missing_genesis_anchor");
  }
  if (finalAnchors.length === 0) {
    addReason(reasons, "missing_final_anchor");
  }

  const genesisAnchor = pickNewest(genesisAnchors);
  const finalAnchor = pickNewest(finalAnchors);
  const finalTxId = normalizeHex(finalAnchor?.txId);
  const genesisTxId = normalizeHex(genesisAnchor?.txId);
  const finalData = parsedByTxId.get(finalTxId) || {};

  if (finalData.anchorType && finalData.anchorType !== ANCHOR.TYPE_FINAL) {
    addReason(reasons, "final_anchor_type_mismatch");
  }
  if (
    genesisTxId &&
    finalData.genesisTxId &&
    finalData.genesisTxId !== genesisTxId
  ) {
    addReason(reasons, "final_genesis_txid_mismatch");
  }

  const chainOrder = buildLinkedChain(
    finalTxId,
    genesisTxId,
    anchorsByTxId,
    parsedByTxId,
    reasons,
  );

  if (chainOrder.length > 0) {
    const orphaned = chain.filter((anchor) => {
      const txId = normalizeHex(anchor?.txId);
      return (
        txId && !chainOrder.some((item) => normalizeHex(item?.txId) === txId)
      );
    });
    if (orphaned.length > 0) {
      addWarning(warnings, "unlinked_anchors_detected");
    }
  }

  const orderedHeartbeats = chainOrder.filter(
    (anchor) => String(anchor?.type || "").toLowerCase() === "heartbeat",
  );

  const genesisData = parsedByTxId.get(genesisTxId) || {};
  await verifyEntropySources({
    genesisData,
    heartbeats: orderedHeartbeats,
    parsedByTxId,
    reasons,
    warnings,
  });
  verifyDaaScores({
    genesisAnchor,
    finalAnchor,
    genesisData,
    reasons,
    warnings,
  });

  const heartbeatMoveSum = orderedHeartbeats.reduce((sum, anchor) => {
    const parsed = parsedByTxId.get(normalizeHex(anchor?.txId)) || {};
    return sum + (Number.isFinite(parsed.moveCount) ? parsed.moveCount : 0);
  }, 0);

  if (Number.isFinite(finalData.totalMoves)) {
    if (heartbeatMoveSum > finalData.totalMoves) {
      addReason(reasons, "heartbeat_moves_exceed_final_total");
    } else if (heartbeatMoveSum < finalData.totalMoves) {
      addWarning(warnings, "final_moves_not_fully_anchored");
    }
  } else {
    addReason(reasons, "final_total_moves_missing");
  }

  if (finalData.outcomeCode === ANCHOR.OUTCOME_CHEAT) {
    addReason(reasons, "final_outcome_cheat");
  }

  if (finalData.resultLeafHash) {
    const resultCheck = await verifyFinalResultHash(finalData);
    if (!resultCheck.ok) {
      addReason(reasons, resultCheck.reason);
    }
  } else {
    addReason(reasons, "final_result_hash_missing");
  }

  const moveHistory = normalizeMoveHistory(audit);
  const merkleCheck = verifyMerkleAndMoves({
    moveHistory,
    heartbeats: orderedHeartbeats,
    parsedByTxId,
    finalData,
    warnings,
  });

  for (const reason of merkleCheck.reasons) {
    addReason(reasons, reason);
  }

  // ── VRF Chain Replay Verification ──
  // Extract player/game identity from audit input for chain replay
  const playerId =
    input?.playerId ??
    input?.context?.playerId ??
    null;
  const gameId =
    input?.gameId ??
    input?.header?.gameId ??
    null;

  if (moveHistory && genesisTxId) {
    const vrfChainResult = await verifyVrfChain({
      moveHistory,
      genesisTxId,
      playerId,
      gameId,
      genesisEntropy: genesisData,
      reasons,
      warnings,
    });

    if (vrfChainResult.verified) {
      // VRF chain is cryptographically verified — no action needed
    }
  } else if (moveHistory && moveHistory.length > 0 && !genesisTxId) {
    addWarning(warnings, "vrf_chain_skipped_no_genesis_txid");
  }

  const verdict =
    reasons.length > 0 ? "fail" : warnings.length > 0 ? "incomplete" : "pass";

  return {
    passed: verdict === "pass",
    verdict,
    reasons,
    warnings,
    finalOutcomeCode: finalData.outcomeCode ?? null,
    finalOutcomeName: formatOutcome(finalData.outcomeCode),
    finalTxId: finalAnchor?.txId || null,
    summary: {
      totalAnchors: chain.length,
      heartbeatCount: orderedHeartbeats.length,
      heartbeatMoveSum,
      finalTotalMoves: finalData.totalMoves ?? null,
      linkedChainLength: chainOrder.length,
    },
  };
}
