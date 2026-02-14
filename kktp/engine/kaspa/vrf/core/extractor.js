import { getBitFromHash } from "./crypto.js";
import { logError } from "./logs/logger.js";
import { FoldingExtractionError } from "./errors.js";

// Extract bits from blocks at given positions
// Accepts optional opts: { iteration }
export async function extractBits(blocks, positions, logAnomaly, opts = {}) {
  const outputBits = [];
  const auditTrail = [];
  const anomalyBuffer = [];
  for (let i = 0; i < positions.length; i++) {
    const block = blocks[i % blocks.length];
    const pos = positions[i];
    let bit = null;
    let anomaly = null;
    // Only extract if block is final and valid
    if (!block || !block.hash || typeof block.hash !== "string") {
      anomaly = "missing_or_malformed_block";
      anomalyBuffer.push({ type: anomaly, index: i, block });
      logError(anomaly, { index: i, block });
      continue;
    }
    if (!/^[0-9a-fA-F]{64}$/.test(block.hash)) {
      anomaly = "invalid_hash_format";
      anomalyBuffer.push({ type: anomaly, index: i, block });
      logError(anomaly, { index: i, block });
      continue;
    }
    if (!block.isFinal) {
      anomaly = "block_not_final";
      anomalyBuffer.push({ type: anomaly, index: i, block });
      logError(anomaly, { index: i, block });
      continue;
    }
    try {
      bit = getBitFromHash(block.hash, pos);
      if (bit === "0" || bit === "1") {
        outputBits.push(bit);
      } else {
        anomaly = "invalid_bit";
        anomalyBuffer.push({ type: anomaly, index: i, block, bit });
        logError(anomaly, { index: i, block, bit });
        // Do not push anything if invalid
      }
    } catch (e) {
      anomaly = "extraction_failed";
      anomalyBuffer.push({ type: anomaly, index: i, block, error: e.message });
      logError(anomaly, { index: i, block, error: e.message });
      // Do not push anything on error
    }
    auditTrail.push({
      blockIndex: i % blocks.length,
      blockHash: block ? block.hash : null,
      bitPosition: pos,
      bitValue: bit,
      extractionIndex: i,
      anomaly,
    });
  }
  const bitstring = outputBits.join("");
  if (anomalyBuffer.length > 0) {
    await logError(anomalyBuffer);
  }
  if (bitstring.length === 0) {
    await logError([{ type: "fatal_no_bits_extracted", blocks, positions }]);
    // Throw FoldingExtractionError with meta for upstream error handling
    const meta = { blocks, positions };
    if (typeof opts.iteration !== "undefined") meta.iteration = opts.iteration;
    throw new FoldingExtractionError(
      "No bits could be extracted: all blocks or hashes invalid",
      meta,
    );
  }
  return { bitstring, auditTrail };
}
