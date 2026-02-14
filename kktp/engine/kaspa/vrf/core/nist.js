// nist.js
// Full NIST SP 800-22 randomness test suite
import {
  frequencyMonobitTest,
  blockFrequencyTest,
  runsTest,
  longestRunOfOnesTest,
  serialTest,
  approximateEntropyTest,
  cumulativeSumsTest,
} from "./tests/basic.js";
import { binaryMatrixRankTest } from "./tests/binary-matrix-rank.js";
import { linearComplexityTest } from "./tests/linear-complexity.js";
import {
  nonOverlappingTemplateTest,
  overlappingTemplateTest,
} from "./tests/template-matching.js";
import { spectralDFTTest } from "./tests/spectral-dft.js";
import { maurerUniversalTest } from "./tests/maurer-universal.js";
import {
  randomExcursionsTest,
  randomExcursionsVariantTest,
} from "./tests/random-excursions.js";

/**
 * Run the full NIST SP 800-22 test suite on a bitstring
 * @param {string} bits - Binary string (10,000+ bits recommended)
 * @param {function} [onProgress] - Optional callback for UI updates after each test
 * @returns {Promise<Object[]>} - Array of test result objects
 */
export async function runNistSuite(bits, onProgress) {
  // List of test functions and their arguments
  const tests = [
    { fn: frequencyMonobitTest, args: [bits] },
    { fn: blockFrequencyTest, args: [bits, 128] },
    { fn: runsTest, args: [bits] },
    { fn: longestRunOfOnesTest, args: [bits, 128] },
    { fn: binaryMatrixRankTest, args: [bits, 32] },
    { fn: spectralDFTTest, args: [bits] },
    { fn: nonOverlappingTemplateTest, args: [bits, "000000001"] },
    { fn: overlappingTemplateTest, args: [bits, "000000001"] },
    { fn: maurerUniversalTest, args: [bits, 6] },
    { fn: linearComplexityTest, args: [bits, 500] },
    { fn: serialTest, args: [bits, 2] },
    { fn: serialTest, args: [bits, 3] },
    { fn: approximateEntropyTest, args: [bits, 2] },
    { fn: approximateEntropyTest, args: [bits, 3] },
    { fn: cumulativeSumsTest, args: [bits, "forward"] },
    { fn: cumulativeSumsTest, args: [bits, "backward"] },
    { fn: randomExcursionsTest, args: [bits] },
    { fn: randomExcursionsVariantTest, args: [bits] },
  ];
  const results = [];
  for (let i = 0; i < tests.length; i++) {
    const { fn, args } = tests[i];
    // Only include tests that are implemented (not all return a result)
    let result;
    try {
      result = fn(...args);
    } catch (e) {
      result = {
        testName: fn.name,
        passed: false,
        statistic: null,
        pValue: null,
        threshold: null,
        details: { error: e.message },
      };
    }
    // Only show tests that return a non-null result and are implemented
    if (
      result &&
      (result.passed !== null ||
        result.statistic !== null ||
        result.pValue !== null)
    ) {
      results.push(result);
      if (onProgress) onProgress([...results]);
      // Wait a bit for UI update (simulate cycling)
      // eslint-disable-next-line no-await-in-loop
      await new Promise((res) => setTimeout(res, 350));
    }
  }
  return results;
}
