// utilities.js
import { Block } from "../models/Block.js";

/**
 * Safely convert BigInt to Number for comparison/display
 */
export function toNumber(val) {
  if (typeof val === "bigint") return Number(val);
  if (typeof val === "string") return parseInt(val, 10) || 0;
  return val ?? 0;
}

/**
 * Compare two values that may be BigInt or Number
 */
export function compareBigIntSafe(a, b) {
  const bigA = typeof a === "bigint" ? a : BigInt(a || 0);
  const bigB = typeof b === "bigint" ? b : BigInt(b || 0);
  if (bigA > bigB) return 1;
  if (bigA < bigB) return -1;
  return 0;
}

/**
 * Convert a block from the wrapper scanner format to VRF Block model
 * @param {Object} block - Block from wrapper scanner
 * @param {bigint|number} tipBlueScore - Current tip blue score for confirmation calculation
 * @returns {Block}
 */
export function scannerBlockToVrfBlock(block, tipBlueScore = null) {
  const hash = block?.header?.hash || block?.hash;
  const blueScoreRaw = block?.header?.blueScore || block?.blueScore;
  const timestampRaw =
    block?.header?.timestamp || block?.timestamp || block?.time;

  // Convert BigInt values safely
  const blueScore = toNumber(blueScoreRaw);
  const timestamp = toNumber(timestampRaw);
  const tipScore = toNumber(tipBlueScore);

  const confirms =
    tipScore && blueScore ? tipScore - blueScore + 1 : (block?.confirms ?? 0);

  return new Block({
    hash,
    height: blueScore,
    blueScore,
    time: timestamp,
    source: "kaspa",
    confirms,
  });
}
