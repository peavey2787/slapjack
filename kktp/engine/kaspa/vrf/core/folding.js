// Folding logic for VRF randomness extraction
import { FoldingValidationError, FoldingExtractionError } from "./errors.js";
import { extractBits } from "./extractor.js";
import { sha256Hash, hexToBytes, bytesToPositions } from "./crypto.js";
import { logInfo, logError } from "./logs/logger.js";

/**
 * SHA-256 Folding Rule
 * Hash the previous output to generate new positions
 * @param {string} previousOutput - Previous bitstring output
 * @param {number} numPositions - Number of positions needed
 * @returns {Promise<number[]>} - New position array
 */
export async function sha256FoldingRule(previousOutput, numPositions) {
  // Input validation
  if (
    typeof previousOutput !== "string" ||
    !/^[01]+$/.test(previousOutput) ||
    previousOutput.length < 8
  ) {
    logError({
      msg: "sha256FoldingRule: Invalid previousOutput",
      previousOutput,
      numPositions,
    });
    throw new Error(
      "sha256FoldingRule: previousOutput must be a non-empty bitstring",
    );
  }
  if (
    typeof numPositions !== "number" ||
    numPositions <= 0 ||
    numPositions > 4096
  ) {
    logError({ msg: "sha256FoldingRule: Invalid numPositions", numPositions });
    throw new Error(
      "sha256FoldingRule: numPositions must be a positive integer <= 4096",
    );
  }
  // Hash the previous output repeatedly to get enough bytes
  let hashInput = previousOutput;
  let hashLength = 0;
  let bytesNeeded = numPositions;
  let hashBytes = [];
  try {
    // Pre-allocate for performance
    while (hashBytes.length < bytesNeeded) {
      const hash = await sha256Hash(hashInput);
      const chunk = Array.from(hexToBytes(hash));
      if (!hashLength) hashLength = chunk.length * 8;
      for (let b of chunk) hashBytes.push(b);
      hashInput = hash; // chain hashes
    }
  } catch (e) {
    try {
      logError({
        msg: "sha256FoldingRule: sha256Hash failed",
        error: e,
        previousOutput,
        numPositions,
      });
    } catch {}
    throw new FoldingExtractionError("sha256FoldingRule: sha256Hash failed", {
      cause: e,
      previousOutput,
      numPositions,
    });
  }
  const positions = bytesToPositions(hashBytes, numPositions);
  try {
    logInfo({ previousOutput, rule: "sha256", positions });
  } catch {} // fire-and-forget, robust
  return positions;
}

/**
 * Get initial positions (before first folding)
 * @param {number} numPositions - Number of positions needed
 * @param {string} seed - Optional seed for deterministic generation
 * @returns {number[]} - Initial position array
 */
export async function getInitialPositions(numPositions, seed = "beacon") {
  if (
    typeof numPositions !== "number" ||
    numPositions <= 0 ||
    numPositions > 4096
  ) {
    logError({
      msg: "getInitialPositions: Invalid numPositions",
      numPositions,
    });
    throw new FoldingValidationError(
      "getInitialPositions: numPositions must be a positive integer <= 4096",
      { numPositions },
    );
  }
  if (typeof seed !== "string" || seed.length < 1 || seed.length > 128) {
    logError({ msg: "getInitialPositions: Invalid seed", seed });
    throw new FoldingValidationError(
      "getInitialPositions: seed must be a non-empty string <= 128 chars",
      { seed },
    );
  }
  let hash, bytes;
  try {
    hash = await sha256Hash(seed);
    bytes = Array.from(hexToBytes(hash));
  } catch (e) {
    try {
      logError({
        msg: "getInitialPositions: sha256Hash failed",
        error: e,
        seed,
      });
    } catch {}
    throw new FoldingExtractionError("getInitialPositions: sha256Hash failed", {
      cause: e,
      seed,
    });
  }
  const positions = [];
  for (let i = 0; i < numPositions; i++) {
    positions.push(bytes[i % bytes.length]);
  }
  try {
    logInfo({ seed, rule: "initial", positions });
  } catch {} // fire-and-forget
  return positions;
}

/**
 * Main folding function - applies the selected rule
 * @param {string} previousOutput - Previous bitstring output (null for first iteration)
 * @param {string} rule - Folding rule: 'sha256' only
 * @param {number} numPositions - Number of positions needed
 * @returns {Promise<number[]>} - New position array
 */
export async function updatePositions(previousOutput, rule, numPositions) {
  // First iteration - use initial positions
  if (!previousOutput) {
    return getInitialPositions(numPositions);
  }
  if (rule !== "sha256") {
    try {
      logError({ msg: "updatePositions: Unsupported folding rule", rule });
    } catch {}
    throw new FoldingValidationError("Only sha256 folding rule is supported.", {
      rule,
    });
  }
  return await sha256FoldingRule(previousOutput, numPositions);
}

/**
 * Normalize input into a canonical 64-char hex hash.
 * Accepts: 64-char hex, binary string, or arbitrary hex.
 */
export async function ensureCanonicalHash(input) {
  if (typeof input === "string" && /^[0-9a-fA-F]{64}$/.test(input)) {
    return input;
  }
  if (typeof input === "string" && /^[01]+$/.test(input)) {
    const padded = input.padEnd(256, "0").slice(0, 256);
    let hex = "";
    for (let i = 0; i < 256; i += 4) {
      hex += parseInt(padded.slice(i, i + 4), 2).toString(16);
    }
    return await sha256Hash(hex);
  }
  if (typeof input === "string" && /^[0-9a-fA-F]+$/.test(input)) {
    return await sha256Hash(input);
  }
  throw new Error("Invalid input for canonical hash");
}

/**
 * Explicit Bit Rotation
 * Maps raw positions to the available entropy space (hashLength)
 * This is the "shuffling" phase of the VRF.
 */
export function rotatePositions(positions, hashLength) {
  if (!Array.isArray(positions)) {
    throw new Error("Positions must be an array");
  }
  if (typeof hashLength !== "number" || hashLength <= 0) {
    throw new Error("hashLength must be a positive number");
  }

  const rotated = positions.map((pos) => pos % hashLength);
  try {
    logInfo({ msg: "Positions rotated", count: rotated.length, hashLength });
  } catch {}
  return rotated;
}

/**
 * Final Whitening
 * Ensures the final bitstring is statistically uniform via a final SHA-256 pass.
 */
export async function whitenEntropy(bitstring) {
  if (typeof bitstring !== "string" || !/^[01]+$/.test(bitstring)) {
    throw new Error("bitstring must be a binary string");
  }
  const hash = await sha256Hash(bitstring);
  const bytes = hexToBytes(hash);
  const whitened = Array.from(bytes)
    .map((b) => b.toString(2).padStart(8, "0"))
    .join("");

  try {
    logInfo({ msg: "Final whitening complete", originalLength: bitstring.length });
  } catch {}
  return whitened;
}

/**
 * Canonical recursive folding: at each round, update positions and re-extract bits
 * @param {Object[]} blocks - Array of block info objects (must have .hash)
 * @param {string} initialOutput - Initial extracted bitstring
 * @param {string} rule - Folding rule to apply ('sha256' recommended)
 * @param {number} iterations - Number of folding iterations
 * @param {number} numPositions - Number of positions for each iteration
 * @returns {Promise<Object>} - { finalPositions, finalOutput, history }
 */
export async function recursiveFolding(
  blocks,
  initialOutput,
  rule,
  iterations,
  numPositions,
) {
  // Input validation
  if (
    !Array.isArray(blocks) ||
    blocks.length === 0 ||
    blocks.length > 32 ||
    !blocks.every(
      (b) =>
        b && typeof b.hash === "string" && /^[0-9a-fA-F]{64}$/.test(b.hash),
    )
  ) {
    try {
      logError({ msg: "recursiveFolding: Invalid blocks", blocks });
    } catch {}
    throw new FoldingValidationError(
      "recursiveFolding: blocks must be array of 1-32 objects with 64-char hex .hash",
      { blocks },
    );
  }
  if (
    typeof initialOutput !== "string" ||
    !/^[01]+$/.test(initialOutput) ||
    initialOutput.length < 8
  ) {
    try {
      logError({
        msg: "recursiveFolding: Invalid initialOutput",
        initialOutput,
      });
    } catch {}
    throw new FoldingValidationError(
      "recursiveFolding: initialOutput must be a non-empty bitstring",
      { initialOutput },
    );
  }
  if (typeof iterations !== "number" || iterations < 1 || iterations > 32) {
    try {
      logError({ msg: "recursiveFolding: Invalid iterations", iterations });
    } catch {}
    throw new FoldingValidationError(
      "recursiveFolding: iterations must be 1-32",
      { iterations },
    );
  }
  if (
    typeof numPositions !== "number" ||
    numPositions <= 0 ||
    numPositions > 4096
  ) {
    try {
      logError({ msg: "recursiveFolding: Invalid numPositions", numPositions });
    } catch {}
    throw new FoldingValidationError(
      "recursiveFolding: numPositions must be a positive integer <= 4096",
      { numPositions },
    );
  }
  let currentOutput = initialOutput;
  let positions = await getInitialPositions(numPositions);
  let hashLength = 256; // fallback, will be updated
  const history = [
    {
      iteration: 0,
      output: initialOutput,
      positions: positions.slice(),
      rule: "initial",
      audit: [],
    },
  ];
  let allAnomalies = [];
  for (let i = 1; i <= iterations; i++) {
    try {
      positions = await updatePositions(currentOutput, rule, numPositions);
      // Dynamically determine hash length from first block
      if (blocks[0] && typeof blocks[0].hash === "string") {
        hashLength = blocks[0].hash.length * 4;
      }
      const safePositions = rotatePositions(positions, hashLength);
      // Extract new bits using safe positions
      // Always pass iteration in opts to extractBits
      const { bitstring, auditTrail } = await extractBits(
        blocks,
        safePositions,
        (anomaly, details) => {
          try {
            logInfo({ anomaly, ...details });
          } catch {}
        },
        { iteration: i },
      );
      try {
        logInfo({ iteration: i, positions: safePositions.slice(), bitstring });
      } catch {} // fire-and-forget, robust
      if (!bitstring || bitstring.length === 0) {
        try {
          logError({
            msg: "recursiveFolding: No bits extracted",
            iteration: i,
            positions: safePositions,
            blocks,
          });
        } catch {}
        // Always include iteration in meta for FoldingExtractionError
        throw new FoldingExtractionError(
          "recursiveFolding: No bits extracted at iteration " + i,
          { iteration: i, positions: safePositions, blocks },
        );
      }
      currentOutput = bitstring;
      history.push({
        iteration: i,
        output: currentOutput,
        positions: safePositions.slice(),
        rule,
        audit: auditTrail,
      });
      // Aggregate anomalies from auditTrail
      allAnomalies.push(...auditTrail.filter((a) => a.anomaly));
    } catch (e) {
      try {
        logError({
          msg: "recursiveFolding: Error in iteration",
          error: e,
          iteration: i,
          rule,
          numPositions,
        });
      } catch {}
      // Always set meta.iteration for FoldingExtractionError
      if (e instanceof FoldingExtractionError) {
        e.meta = { ...(e.meta || {}), iteration: i };
      }
      throw e;
    }
  }
  return {
    finalPositions: positions,
    finalOutput: currentOutput,
    history,
    anomalies: allAnomalies,
  };
}

/**
 * Get folding statistics
 * @param {Object} foldingResult - Result from recursiveFolding
 * @returns {Object} - Statistics about the folding process
 */
export function getFoldingStats(foldingResult) {
  const { history, finalPositions } = foldingResult;
  // Use dynamic hash length if available
  let hashLength = 256;
  if (
    finalPositions &&
    finalPositions.length > 0 &&
    foldingResult.finalPositions
  ) {
    // Try to infer from max position value
    const maxPos = Math.max(...finalPositions);
    hashLength = Math.max(256, Math.ceil((maxPos + 1) / 64) * 64); // round up to next 64
  }
  const unique = new Set(finalPositions).size;
  const distribution = finalPositions.reduce((acc, pos) => {
    const bucket = Math.floor(pos / 64); // 4 buckets
    acc[bucket] = (acc[bucket] || 0) + 1;
    return acc;
  }, {});
  return {
    iterations: history.length - 1,
    totalPositions: finalPositions.length,
    uniquePositions: unique,
    coverage: ((unique / hashLength) * 100).toFixed(2) + "%",
    distribution: distribution,
  };
}

/**
 * High-level fold function to combine two randomness sources
 * @param {string} randA - First source (hex or binary string)
 * @param {string} randB - Second source (hex or binary string)
 * @param {Object} options - { iterations, numPositions }
 * @returns {Promise<string>} - Final folded bitstring
 */
export async function fold(randA, randB, options = {}) {
  // randA, randB: hex or binary strings
  // Default: 2 rounds, 256 positions, sha256 folding
  const hashA = await ensureCanonicalHash(randA);
  const hashB = await ensureCanonicalHash(randB);
  const blocks = [
    { hash: hashA, isFinal: true },
    { hash: hashB, isFinal: true },
  ];
  // Initial extraction: derive positions from seed if provided,
  // otherwise use static sequential positions (backwards-compatible)
  const positions = options.seed
    ? await getInitialPositions(
        256,
        typeof options.seed === "string" && options.seed.length > 0
          ? options.seed.slice(0, 128)
          : "beacon",
      )
    : Array.from({ length: 256 }, (_, i) => i);
  const { bitstring: initialBits } = await extractBits(blocks, positions);
  const foldingResult = await recursiveFolding(
    blocks,
    initialBits,
    "sha256",
    options.iterations || 2,
    options.numPositions || 256,
  );
  return await whitenEntropy(foldingResult.finalOutput);
}
