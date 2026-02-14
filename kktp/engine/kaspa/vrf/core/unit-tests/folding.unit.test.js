// Enterprise-grade unit tests for core/folding.js
import {
  sha256FoldingRule,
  getInitialPositions,
  updatePositions,
  recursiveFolding,
  getFoldingStats,
} from "../folding.js";
import { FoldingValidationError, FoldingExtractionError } from "../errors.js";
import { Block } from "../models/Block.js";

// --- Deterministic Test Fixtures ---
function makeBlock({
  hash,
  source = "bitcoin",
  confirms = 6,
  header = "",
  height = 0,
  time = 1234567890,
  isFinal,
} = {}) {
  const block = new Block({ hash, source, confirms, header, height, time });
  if (typeof isFinal === "boolean") block.isFinal = isFinal;
  return block;
}
const FIXED_BITSTRING = "1010101010101010";
const FIXED_LONG_BITSTRING =
  "1010100110110000011010100101100011001001101010111001001010111011010000000010101101000001000011000110000001001010110100101000001010000010101011000101001001101010100010101001001100100000011010000011101010110010000010100010011000000101101100000110111001101000";

// --- Exported Test Runner ---
export async function runTests() {
  let passed = true;
  let details = [];

  try {
    // 1. Deterministic positions for known seed
    const seed = "test-seed";
    const numPositions = 8;
    const positions1 = await getInitialPositions(numPositions, seed);
    const positions2 = await getInitialPositions(numPositions, seed);
    if (JSON.stringify(positions1) !== JSON.stringify(positions2)) {
      passed = false;
      details.push("getInitialPositions should be deterministic");
    }

    // 2. sha256FoldingRule deterministic
    const prevOut = FIXED_BITSTRING;
    const posA = await sha256FoldingRule(prevOut, 8);
    const posB = await sha256FoldingRule(prevOut, 8);
    if (JSON.stringify(posA) !== JSON.stringify(posB)) {
      passed = false;
      details.push("sha256FoldingRule should be deterministic");
    }

    // 3. updatePositions: rule validation (custom error)
    let threw = false;
    try {
      await updatePositions(FIXED_BITSTRING, "unsupported", 8);
    } catch (e) {
      threw = e instanceof FoldingValidationError && e.meta && e.meta.rule === "unsupported";
    }
    if (!threw) {
      passed = false;
      details.push("updatePositions should throw FoldingValidationError for bad rule");
    }

    // 4. recursiveFolding: error on malformed blocks (custom error)
    threw = false;
    try {
      await recursiveFolding([], FIXED_BITSTRING, "sha256", 2, 8);
    } catch (e) {
      threw = e instanceof FoldingValidationError && e.meta && e.meta.blocks;
    }
    if (!threw) {
      passed = false;
      details.push("recursiveFolding should throw FoldingValidationError for bad blocks");
    }

    // 5. recursiveFolding: anomaly aggregation with real block hashes (all finalized)
    const realBlocks = [
      makeBlock({
        hash: "5492228dc5993c981310028db4c72628cabd41fd2c6c2e5a530a908d6d2b0cef",
        source: "bitcoin",
        confirms: 6,
        qrng: true,
      }),
      makeBlock({
        hash: "d9cdaeb7524294ffc99c0d549f886c8524b36c686c3c98003238af7c690b68ba",
        source: "kaspa",
        confirms: 60,
      }),
      makeBlock({
        hash: "000000000000000000004628d23eb858fde8a615b464d4e9b63752b85d250afe",
        source: "bitcoin",
        confirms: 6,
      }),
    ];
    const initialOutput = FIXED_LONG_BITSTRING;
    const result = await recursiveFolding(
      realBlocks,
      initialOutput,
      "sha256",
      2,
      8,
    );
    if (!Array.isArray(result.anomalies)) {
      passed = false;
      details.push("recursiveFolding should return anomalies array");
    }
    if (result.history.length !== 3) {
      passed = false;
      details.push("history length should be iterations + 1");
    }
    if (
      !result.history.every(
        (h) =>
          h.iteration !== undefined &&
          h.output &&
          h.positions &&
          Array.isArray(h.audit),
      )
    ) {
      passed = false;
      details.push("history entries should have required fields");
    }

    // 6. getFoldingStats: correct stats shape and dynamic hash length
    const stats = getFoldingStats(result);
    if (stats.iterations !== 2) {
      passed = false;
      details.push("getFoldingStats should return correct iterations");
    }
    if (typeof stats.coverage !== "string") {
      passed = false;
      details.push("getFoldingStats should return coverage as string");
    }

    // 7. Error class propagation: getInitialPositions (custom error)
    threw = false;
    try {
      await getInitialPositions(0, "seed");
    } catch (e) {
      threw = e instanceof FoldingValidationError;
    }
    if (!threw) {
      passed = false;
      details.push("getInitialPositions should throw FoldingValidationError for invalid numPositions");
    }

    // 8. Boundary: numPositions min/max
    if ((await getInitialPositions(1, seed)).length !== 1) {
      passed = false;
      details.push("getInitialPositions(1) should return 1 position");
    }
    if ((await getInitialPositions(4096, seed)).length !== 4096) {
      passed = false;
      details.push("getInitialPositions(4096) should return 4096 positions");
    }

    // 9. Boundary: iterations min/max
    const minIter = await recursiveFolding(
      realBlocks,
      initialOutput,
      "sha256",
      1,
      8,
    );
    if (minIter.history.length !== 2) {
      passed = false;
      details.push("min iterations history length should be 2");
    }
    const maxIter = await recursiveFolding(
      realBlocks,
      initialOutput,
      "sha256",
      2,
      8,
    );
    if (maxIter.history.length !== 3) {
      passed = false;
      details.push("max iterations history length should be 3");
    }

    // 10. Boundary: blocks.length min/max
    const oneBlock = [
      makeBlock({
        hash: "000000000000000000004628d23eb858fde8a615b464d4e9b63752b85d250afe",
        source: "bitcoin",
        confirms: 6,
      }),
    ];
    const minBlock = await recursiveFolding(
      oneBlock,
      initialOutput,
      "sha256",
      1,
      8,
    );
    if (minBlock.history.length !== 2) {
      passed = false;
      details.push("min block count should work");
    }
    const blocks32 = Array.from({ length: 32 }, (_, i) =>
      makeBlock({
        hash: "000000000000000000004628d23eb858fde8a615b464d4e9b63752b85d250afe",
        source: "bitcoin",
        confirms: 6,
        height: i,
      }),
    );
    const maxBlock = await recursiveFolding(
      blocks32,
      initialOutput,
      "sha256",
      1,
      8,
    );
    if (maxBlock.history.length !== 2) {
      passed = false;
      details.push("max block count should work");
    }

    // 11. Invalid hash format
    threw = false;
    try {
      await recursiveFolding(
        [makeBlock({ hash: "notAHex", source: "bitcoin", confirms: 6 })],
        initialOutput,
        "sha256",
        1,
        8,
      );
    } catch (e) {
      threw = e instanceof FoldingValidationError;
    }
    if (!threw) {
      passed = false;
      details.push("invalid hash format should throw FoldingValidationError");
    }

    // 12. Empty or too-short initialOutput
    threw = false;
    try {
      await recursiveFolding(realBlocks, "", "sha256", 1, 8);
    } catch (e) {
      threw = e instanceof FoldingValidationError;
    }
    if (!threw) {
      passed = false;
      details.push("empty initialOutput should throw FoldingValidationError");
    }

    // 13. Empty output at an iteration (force all blocks invalid)
    threw = false;
    try {
      await recursiveFolding(
        [
          makeBlock({
            hash: "a".repeat(64),
            source: "bitcoin",
            confirms: 0,
            isFinal: false,
          }),
        ],
        initialOutput,
        "sha256",
        1,
        8,
      );
    } catch (e) {
      threw = e instanceof FoldingExtractionError && e.meta && typeof e.meta.iteration !== "undefined";
    }
    if (!threw) {
      passed = false;
      details.push("empty output at iteration should throw FoldingExtractionError");
    }

    // 14. Determinism: recursiveFolding identical outputs for same inputs
    const run1 = await recursiveFolding(
      realBlocks,
      initialOutput,
      "sha256",
      2,
      8,
    );
    const run2 = await recursiveFolding(
      realBlocks,
      initialOutput,
      "sha256",
      2,
      8,
    );
    if (JSON.stringify(run1.finalOutput) !== JSON.stringify(run2.finalOutput)) {
      passed = false;
      details.push("recursiveFolding should be deterministic");
    }
    if (JSON.stringify(run1.finalPositions) !== JSON.stringify(run2.finalPositions)) {
      passed = false;
      details.push("finalPositions should be deterministic");
    }

    // 15. Dynamic hash length: coverage denominator adapts
    const stats256 = getFoldingStats({
      history: [{}, {}],
      finalPositions: [0, 1, 2],
    });
    const stats512 = getFoldingStats({
      history: [{}, {}],
      finalPositions: Array(512).fill(0),
    });
    if (
      !stats256.coverage.endsWith("%") ||
      stats256.coverage === stats512.coverage
    ) {
      passed = false;
      details.push("coverage should adapt for hash length");
    }

    // 16. Performance/safety: enforce limits
    threw = false;
    try {
      await getInitialPositions(4097, seed);
    } catch (e) {
      threw = e instanceof Error;
    }
    if (!threw) {
      passed = false;
      details.push("getInitialPositions(4097) should throw");
    }
    threw = false;
    try {
      await recursiveFolding(realBlocks, initialOutput, "sha256", 33, 8);
    } catch (e) {
      threw = e instanceof FoldingValidationError;
    }
    if (!threw) {
      passed = false;
      details.push("iterations=33 should throw");
    }
    threw = false;
    try {
      await recursiveFolding(
        Array(33).fill(realBlocks[0]),
        initialOutput,
        "sha256",
        1,
        8,
      );
    } catch (e) {
      threw = e instanceof FoldingValidationError;
    }
    if (!threw) {
      passed = false;
      details.push("blocks.length=33 should throw");
    }
  } catch (err) {
    passed = false;
    details.push("Exception: " + (err.message || err.toString()));
  }

  if (passed) details.push("All folding.js enterprise-grade unit tests passed.");
  return { passed, details: details.join("\n") };
}
