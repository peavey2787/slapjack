/**
 * daa.js - DAA score verification for cheating audit
 *
 * The genesis payload encodes startDaaScore / endDaaScore: the game-timing
 * window derived from the latest known block BEFORE the genesis TX is sent.
 * The anchor entries carry blockDaaScore: the DAA of the block that actually
 * confirmed the transaction (always >= the pre-computed values).
 *
 * These are inherently different quantities, so we do NOT compare them for
 * equality.  Instead we verify:
 *   1. startDaaScore & endDaaScore exist and are coherent (start <= end).
 *   2. Both anchors were confirmed on-chain (blockDaaScore is present).
 *   3. The genesis block was confirmed at or before the final block
 *      (genesisBlockDaa <= finalBlockDaa).
 *   4. The genesis block's DAA is >= the declared startDaaScore
 *      (the block can't have been mined before the value was computed).
 */

import { addReason, addWarning } from "./utils.js";

function parseDaa(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    return Number.isFinite(value) ? BigInt(Math.floor(value)) : null;
  }
  if (typeof value === "string") {
    try {
      return BigInt(value);
    } catch {
      return null;
    }
  }
  return null;
}

export function verifyDaaScores({
  genesisAnchor,
  finalAnchor,
  genesisData,
  reasons,
  warnings,
}) {
  /* ── 1. Genesis payload DAA values ── */
  const startDaa = parseDaa(genesisData?.startDaaScore);
  const endDaa = parseDaa(genesisData?.endDaaScore);

  if (startDaa === null || endDaa === null) {
    addReason(reasons, "genesis_daa_missing");
    return;
  }

  if (startDaa > endDaa) {
    addReason(reasons, "genesis_daa_window_inverted");
  }

  /* ── 2. Block-level DAA presence ── */
  const genesisBlockDaa = parseDaa(genesisAnchor?.blockDaaScore);
  const finalBlockDaa = parseDaa(finalAnchor?.blockDaaScore);

  if (genesisBlockDaa === null) {
    addWarning(warnings, "genesis_block_daa_missing");
  }
  if (finalBlockDaa === null) {
    addWarning(warnings, "final_block_daa_missing");
  }

  /* ── 3. Ordering: genesis confirmed before or at same time as final ── */
  if (genesisBlockDaa !== null && finalBlockDaa !== null) {
    if (genesisBlockDaa > finalBlockDaa) {
      addReason(reasons, "daa_ordering_violated");
    }
  }

  /* ── 4. Genesis block can't predate its own declared start ── */
  if (genesisBlockDaa !== null && startDaa !== null) {
    if (genesisBlockDaa < startDaa) {
      addWarning(warnings, "genesis_block_before_declared_start");
    }
  }
}
