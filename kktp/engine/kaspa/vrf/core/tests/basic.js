import { gammaQ } from "./gamma.js";
import { erfc } from "./utilities.js";

// Basic NIST SP 800-22 tests: Frequency (Monobit), Block Frequency, Runs, Longest Run of Ones, Serial, Approximate Entropy, Cumulative Sums

/** Frequency (Monobit) Test */
export function frequencyMonobitTest(bits) {
  // NIST SP 800-22 Frequency (Monobit) Test
  // bits: string of '0' and '1'
  const n = bits.length;
  if (n === 0) {
    return {
      testName: "Frequency (Monobit) Test",
      passed: false,
      statistic: null,
      pValue: null,
      threshold: 0.01,
      details: { error: "Input bitstring is empty." },
    };
  }
  // Convert bits to +1/-1 and sum
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += bits[i] === "1" ? 1 : -1;
  }
  const sObs = Math.abs(sum) / Math.sqrt(n);
  // Compute p-value using robust erfc with error handling
  let pValue, erfcError;
  try {
    pValue = erfc(sObs / Math.sqrt(2));
    if (!isFinite(pValue) || isNaN(pValue)) {
      erfcError = "erfc returned non-finite pValue.";
      pValue = null;
    }
  } catch (err) {
    erfcError =
      "erfc threw: " + (err && err.message ? err.message : String(err));
    pValue = null;
  }
  const passed = pValue !== null && pValue >= 0.01;
  // Diagnostics: proportion of ones and zeros
  const ones = bits.split("").filter((b) => b === "1").length;
  const zeros = n - ones;
  const propOnes = n > 0 ? ones / n : 0;
  const propZeros = n > 0 ? zeros / n : 0;
  return {
    testName: "Frequency (Monobit) Test",
    passed,
    statistic: sObs,
    pValue,
    threshold: 0.01,
    details: {
      n,
      sum,
      sObs,
      pValue,
      erfcError,
      ones,
      zeros,
      propOnes,
      propZeros,
      interpretation: passed
        ? "Passes randomness criteria"
        : "Fails randomness criteria",
    },
  };
}

/** Block Frequency Test */
export function blockFrequencyTest(bits, blockSize) {
  // NIST SP 800-22 Block Frequency Test
  // bits: string of '0' and '1', blockSize: recommended 128 or 512
  const n = bits.length;
  if (n === 0 || blockSize <= 0 || blockSize > n) {
    return {
      testName: "Block Frequency Test",
      passed: false,
      statistic: null,
      pValue: null,
      threshold: 0.01,
      details: {
        error: "Invalid input: empty bitstring or blockSize out of range.",
      },
    };
  }
  const N = Math.floor(n / blockSize); // Number of complete blocks
  if (N === 0) {
    return {
      testName: "Block Frequency Test",
      passed: false,
      statistic: null,
      pValue: null,
      threshold: 0.01,
      details: { error: "Bitstring too short for even one block." },
    };
  }
  let sum = 0;
  const proportions = [];
  for (let i = 0; i < N; i++) {
    const block = bits.slice(i * blockSize, (i + 1) * blockSize);
    const ones = block.split("").filter((b) => b === "1").length;
    const pi = ones / blockSize;
    proportions.push(pi);
    sum += Math.pow(pi - 0.5, 2);
  }
  const chiSquared = 4 * blockSize * sum;
  // Compute p-value using robust gammaQ with error handling
  let pValue, gammaQError;
  try {
    pValue = gammaQ(N / 2, chiSquared / 2);
    if (!isFinite(pValue) || isNaN(pValue)) {
      gammaQError = "gammaQ returned non-finite pValue.";
      pValue = null;
    }
  } catch (err) {
    gammaQError =
      "gammaQ threw: " + (err && err.message ? err.message : String(err));
    pValue = null;
  }
  const passed = pValue !== null && pValue >= 0.01;
  // Diagnostics: mean, variance, min, and max of block proportions
  const meanProportion = proportions.length
    ? proportions.reduce((a, b) => a + b, 0) / proportions.length
    : 0;
  const varianceProportion = proportions.length
    ? proportions.reduce((a, b) => a + Math.pow(b - meanProportion, 2), 0) /
      proportions.length
    : 0;
  const minProportion = proportions.length ? Math.min(...proportions) : 0;
  const maxProportion = proportions.length ? Math.max(...proportions) : 0;
  return {
    testName: "Block Frequency Test",
    passed,
    statistic: chiSquared,
    pValue,
    threshold: 0.01,
    details: {
      n,
      blockSize,
      N,
      chiSquared,
      pValue,
      gammaQError,
      proportionsPreview: proportions.slice(0, 5), // Show first 5 for brevity
      meanProportion,
      varianceProportion,
      minProportion,
      maxProportion,
      interpretation: passed
        ? "Passes randomness criteria"
        : "Fails randomness criteria",
    },
  };
}

/** Runs Test */
export function runsTest(bits) {
  // NIST SP 800-22 Runs Test
  // bits: string of '0' and '1'
  const n = bits.length;
  if (n === 0) {
    return {
      testName: "Runs Test",
      passed: false,
      statistic: null,
      pValue: null,
      threshold: 0.01,
      details: { error: "Input bitstring is empty." },
    };
  }
  // Proportion of ones
  const pi = bits.split("").filter((b) => b === "1").length / n;
  // Test only valid if pi is not too far from 0.5
  if (Math.abs(pi - 0.5) >= 2 / Math.sqrt(n)) {
    return {
      testName: "Runs Test",
      passed: false,
      statistic: null,
      pValue: null,
      threshold: 0.01,
      details: {
        n,
        pi,
        error: "Proportion of ones too far from 0.5 for Runs Test to be valid.",
      },
    };
  }
  // Count runs
  let runs = 1;
  for (let i = 1; i < n; i++) {
    if (bits[i] !== bits[i - 1]) runs++;
  }
  // Expected number of runs
  const expectedRuns = 2 * n * pi * (1 - pi);
  // NIST variance and standard deviation
  // Var(R) = 2n(4pi(1-pi)-1)/(n-1)
  const variance = (2 * n * (4 * pi * (1 - pi) - 1)) / (n - 1);
  const stddev = Math.sqrt(variance);
  // Test statistic (Z)
  const z = Math.abs(runs - expectedRuns) / stddev;
  // P-value using erfc, with error handling
  let pValue, erfcError;
  try {
    pValue = erfc(z / Math.sqrt(2));
    if (!isFinite(pValue) || isNaN(pValue)) {
      erfcError = "erfc returned non-finite pValue.";
      pValue = null;
    }
  } catch (err) {
    erfcError =
      "erfc threw: " + (err && err.message ? err.message : String(err));
    pValue = null;
  }
  const passed = pValue !== null && pValue >= 0.01;
  // Preview of the run sequence (first 20 bits)
  let runSequencePreview = [];
  if (n > 0) {
    let current = bits[0],
      count = 1;
    for (let i = 1; i < Math.min(n, 20); i++) {
      if (bits[i] === current) {
        count++;
      } else {
        runSequencePreview.push({ bit: current, length: count });
        current = bits[i];
        count = 1;
      }
    }
    runSequencePreview.push({ bit: current, length: count });
  }
  return {
    testName: "Runs Test",
    passed,
    statistic: z,
    pValue,
    threshold: 0.01,
    details: {
      n,
      pi,
      runs,
      expectedRuns,
      stddev,
      variance,
      z,
      pValue,
      erfcError,
      runSequencePreview,
      interpretation: passed
        ? "Passes randomness criteria"
        : "Fails randomness criteria",
    },
  };
}

/** Longest Run of Ones in a Block Test */
export function longestRunOfOnesTest(bits, blockSize) {
  // NIST SP 800-22 Longest Run of Ones in a Block Test
  // bits: string of '0' and '1', blockSize: recommended 128 or 512
  const n = bits.length;
  if (n === 0 || blockSize <= 0 || blockSize > n) {
    return {
      testName: "Longest Run of Ones in a Block Test",
      passed: false,
      statistic: null,
      pValue: null,
      threshold: 0.01,
      details: {
        error: "Invalid input: empty bitstring or blockSize out of range.",
      },
    };
  }
  const N = Math.floor(n / blockSize); // Number of complete blocks
  if (N === 0) {
    return {
      testName: "Longest Run of Ones in a Block Test",
      passed: false,
      statistic: null,
      pValue: null,
      threshold: 0.01,
      details: { error: "Bitstring too short for even one block." },
    };
  }
  // NIST SP 800-22 parameters for supported block sizes
  // See Table 4 in NIST SP 800-22rev1a
  let v, pi;
  if (blockSize === 8) {
    v = [1, 2, 3, 4];
    pi = [0.2148, 0.3672, 0.2305, 0.1875];
  } else if (blockSize === 128) {
    v = [4, 5, 6, 7];
    pi = [0.1174, 0.243, 0.2493, 0.3903];
  } else if (blockSize === 512) {
    v = [10, 11, 12, 13, 14, 15, 16];
    pi = [0.0882, 0.2092, 0.2483, 0.1933, 0.1208, 0.0675, 0.0727];
  } else {
    return {
      testName: "Longest Run of Ones in a Block Test",
      passed: false,
      statistic: null,
      pValue: null,
      threshold: 0.01,
      details: { error: "Unsupported blockSize. Supported: 8, 128, 512." },
    };
  }
  const counts = Array(v.length).fill(0);
  for (let i = 0; i < N; i++) {
    const block = bits.slice(i * blockSize, (i + 1) * blockSize);
    let maxRun = 0,
      run = 0;
    for (let j = 0; j < block.length; j++) {
      if (block[j] === "1") {
        run++;
        if (run > maxRun) maxRun = run;
      } else {
        run = 0;
      }
    }
    // Bin the maxRun into v categories
    let binned = false;
    for (let k = 0; k < v.length - 1; k++) {
      if (maxRun <= v[k]) {
        counts[k]++;
        binned = true;
        break;
      }
    }
    if (!binned) counts[v.length - 1]++;
  }
  // Chi-squared statistic
  let chiSquared = 0;
  for (let i = 0; i < v.length; i++) {
    const expected = pi[i] * N;
    chiSquared += Math.pow(counts[i] - expected, 2) / expected;
  }
  // Degrees of freedom: k - 1
  const df = v.length - 1;
  let pValue, gammaQError;
  try {
    pValue = gammaQ(df / 2, chiSquared / 2);
    if (!isFinite(pValue) || isNaN(pValue)) {
      gammaQError = "gammaQ returned non-finite pValue.";
      pValue = null;
    }
  } catch (err) {
    gammaQError =
      "gammaQ threw: " + (err && err.message ? err.message : String(err));
    pValue = null;
  }
  const passed = pValue !== null && pValue >= 0.01;
  // Find the category with the largest deviation from expected
  let maxDeviation = -Infinity,
    maxDeviationIndex = -1;
  for (let i = 0; i < v.length; i++) {
    const expected = pi[i] * N;
    const deviation = Math.abs(counts[i] - expected);
    if (deviation > maxDeviation) {
      maxDeviation = deviation;
      maxDeviationIndex = i;
    }
  }
  // Build array of observed/expected for all categories
  const categoryDiagnostics = v.map((val, i) => ({
    index: i,
    v: val,
    observed: counts[i],
    expected: pi[i] * N,
    deviation: counts[i] - pi[i] * N,
  }));
  const details = {
    n,
    blockSize,
    N,
    chiSquared,
    pValue,
    counts,
    v,
    pi,
    df,
    gammaQError,
    categoryDiagnostics,
    maxDeviationCategory:
      maxDeviationIndex >= 0
        ? {
            index: maxDeviationIndex,
            v: v[maxDeviationIndex],
            observed: counts[maxDeviationIndex],
            expected: pi[maxDeviationIndex] * N,
            deviation: maxDeviation,
          }
        : undefined,
    interpretation: passed
      ? "Passes randomness criteria"
      : "Fails randomness criteria",
  };
  return {
    testName: "Longest Run of Ones in a Block Test",
    passed,
    statistic: chiSquared,
    pValue,
    threshold: 0.01,
    details,
  };
}

/** Serial Test */
export function serialTest(bits, m) {
  // NIST SP 800-22 Serial Test
  // bits: string of '0' and '1', m: pattern length (2 or 3)
  // Performance note: For large n and m, patternCounts is O(n·m). For very large inputs, consider optimizing or limiting m.
  const n = bits.length;
  if (n === 0 || m < 1 || m > 16) {
    return {
      testName: "Serial Test",
      passed: false,
      statistic: null,
      pValue: null,
      threshold: 0.01,
      details: {
        error: "Invalid input: empty bitstring or pattern length out of range.",
      },
    };
  }
  // Helper: count occurrences of all m-bit patterns (with wraparound)
  function patternCounts(bits, m) {
    const counts = {};
    const n = bits.length;
    for (let i = 0; i < n; i++) {
      let pattern = "";
      for (let j = 0; j < m; j++) {
        pattern += bits[(i + j) % n];
      }
      counts[pattern] = (counts[pattern] || 0) + 1;
    }
    return counts;
  }
  // Psi2 for m, m-1, m-2
  function psi2(bits, m) {
    const n = bits.length;
    const counts = patternCounts(bits, m);
    let sum = 0;
    for (const k in counts) {
      sum += counts[k] * counts[k];
    }
    return (sum * Math.pow(2, m)) / n - n;
  }
  const psi2_m = psi2(bits, m);
  const psi2_m1 = psi2(bits, m - 1);
  const psi2_m2 = psi2(bits, m - 2);
  // Test statistics
  const delta1 = psi2_m - psi2_m1;
  const delta2 = psi2_m - 2 * psi2_m1 + psi2_m2;
  // Degrees of freedom per NIST: df1 = 2^(m-1), df2 = 2^(m-2)
  const df1 = Math.pow(2, m - 1);
  const df2 = Math.pow(2, m - 2);
  let pValue1, pValue2, gammaQError1, gammaQError2;
  try {
    pValue1 = gammaQ(df1, delta1 / 2);
    if (!isFinite(pValue1) || isNaN(pValue1)) {
      gammaQError1 = "gammaQ returned non-finite pValue1.";
      pValue1 = null;
    }
  } catch (err) {
    gammaQError1 =
      "gammaQ threw for pValue1: " +
      (err && err.message ? err.message : String(err));
    pValue1 = null;
  }
  try {
    pValue2 = gammaQ(df2, delta2 / 2);
    if (!isFinite(pValue2) || isNaN(pValue2)) {
      gammaQError2 = "gammaQ returned non-finite pValue2.";
      pValue2 = null;
    }
  } catch (err) {
    gammaQError2 =
      "gammaQ threw for pValue2: " +
      (err && err.message ? err.message : String(err));
    pValue2 = null;
  }
  const passed =
    pValue1 !== null && pValue1 >= 0.01 && pValue2 !== null && pValue2 >= 0.01;
  let interpretation;
  if (passed) {
    interpretation = "Passes randomness criteria";
  } else {
    const fail1 = pValue1 === null || pValue1 < 0.01;
    const fail2 = pValue2 === null || pValue2 < 0.01;
    if (fail1 && fail2) {
      interpretation =
        "Fails randomness criteria (both Δ1 and Δ2 subtests failed)";
    } else if (fail1) {
      interpretation = "Fails randomness criteria (Δ1 subtest failed)";
    } else if (fail2) {
      interpretation = "Fails randomness criteria (Δ2 subtest failed)";
    } else {
      interpretation = "Fails randomness criteria";
    }
  }
  const details = {
    n,
    m,
    psi2_m,
    psi2_m1,
    psi2_m2,
    delta1,
    delta2,
    pValue1,
    pValue2,
    df1,
    df2,
    gammaQError1,
    gammaQError2,
    interpretation,
  };
  return {
    testName: "Serial Test",
    passed,
    statistic: { delta1, delta2 },
    pValue: { pValue1, pValue2 },
    threshold: 0.01,
    details,
  };
}

/** Approximate Entropy Test */
export function approximateEntropyTest(bits, m) {
  // NIST SP 800-22 Approximate Entropy Test
  // bits: string of '0' and '1', m: block size (2 or 3 recommended)
  // NIST recommends m = 2 or 3; accuracy degrades for m > 5.
  // Degrees of freedom (df) = 2^(m-1) as per NIST.
  // Chi-squared formula: 2 * n * (log(2) - apEn), where apEn = φ(m) − φ(m+1)
  const n = bits.length;
  if (n === 0 || m < 1 || m > 16) {
    return {
      testName: "Approximate Entropy Test",
      passed: false,
      statistic: null,
      pValue: null,
      threshold: 0.01,
      details: {
        error: "Invalid input: empty bitstring or block size out of range.",
      },
    };
  }
  let warning = undefined;
  if (m > 5) {
    warning = "NIST recommends m ≤ 5; accuracy may degrade for larger m.";
  }
  // Helper: count occurrences of all m-bit patterns (with wraparound)
  // For large n and m, this can be expensive (O(n*m)); optimize with precomputed substrings if needed.
  function patternCounts(bits, m) {
    // Only observed patterns are counted; unobserved patterns (count=0) are excluded to avoid log(0).
    const counts = {};
    const n = bits.length;
    for (let i = 0; i < n; i++) {
      let pattern = "";
      for (let j = 0; j < m; j++) {
        pattern += bits[(i + j) % n];
      }
      counts[pattern] = (counts[pattern] || 0) + 1;
    }
    return counts;
  }
  // Compute phi for m and m+1
  function phi(bits, m) {
    // Sums only over observed patterns (count > 0)
    const n = bits.length;
    const counts = patternCounts(bits, m);
    let sum = 0;
    for (const k in counts) {
      const c = counts[k];
      sum += c * Math.log(c / n);
    }
    return sum / n;
  }
  const phi_m = phi(bits, m);
  const phi_m1 = phi(bits, m + 1);
  const apEn = phi_m - phi_m1; // apEn = φ(m) − φ(m+1)
  // Test statistic: chiSquared = 2 * n * (log(2) - apEn)
  const chiSquared = 2 * n * (Math.log(2) - apEn);
  // Degrees of freedom per NIST: df = 2^(m-1)
  const df = Math.pow(2, m - 1);
  let pValue, gammaQError;
  try {
    pValue = gammaQ(df, chiSquared / 2);
    if (!isFinite(pValue) || isNaN(pValue)) {
      gammaQError = "gammaQ returned non-finite pValue.";
      pValue = null;
    }
  } catch (err) {
    gammaQError =
      "gammaQ threw: " + (err && err.message ? err.message : String(err));
    pValue = null;
  }
  const passed = pValue !== null && pValue >= 0.01;
  // Only include warning in details if present
  const details = {
    n,
    m,
    phi_m,
    phi_m1,
    apEn,
    chiSquared,
    pValue,
    df,
    gammaQError,
    interpretation: passed
      ? "Passes randomness criteria"
      : "Fails randomness criteria",
  };
  if (warning) details.warning = warning;
  return {
    testName: "Approximate Entropy Test",
    passed,
    statistic: chiSquared,
    pValue,
    threshold: 0.01,
    details,
  };
}

/** Cumulative Sums (Cusum) Test */
export function cumulativeSumsTest(bits, mode) {
  // NIST SP 800-22 Cumulative Sums (Cusum) Test
  // bits: string of '0' and '1', mode: 'forward' or 'backward'
  // Returns: { testName, passed, statistic, pValue, threshold, details }
  const n = bits.length;
  if (n === 0 || (mode !== "forward" && mode !== "backward")) {
    return {
      testName: `Cumulative Sums (Cusum) Test [${mode}]`,
      passed: false,
      statistic: null,
      pValue: null,
      threshold: 0.01,
      details: { error: "Invalid input: empty bitstring or invalid mode." },
    };
  }
  // Convert bits to +1/-1
  const x = bits.split("").map((b) => (b === "1" ? 1 : -1));
  // Compute the cumulative sum sequence
  let S = [];
  if (mode === "forward") {
    // Loop: i = 0 to n-1 (forward)
    let sum = 0;
    for (let i = 0; i < n; i++) {
      sum += x[i];
      S.push(sum);
    }
  } else {
    // backward
    // Loop: i = n-1 down to 0 (backward)
    let sum = 0;
    for (let i = n - 1; i >= 0; i--) {
      sum += x[i];
      S.push(sum);
    }
  }
  // Compute the maximum absolute value of the cumulative sum
  const z = Math.max(...S.map(Math.abs));
  // Compute p-value
  // NIST formula: p = 1 - sum_{k} [Phi((4k+1)z/sqrt(n)) - Phi((4k-1)z/sqrt(n))] + sum_{k} [Phi((4k+3)z/sqrt(n)) - Phi((4k+1)z/sqrt(n))]
  // where Phi(x) = CDF of standard normal distribution
  function cdfNormal(x) {
    // Standard normal CDF
    return 0.5 * (1 + erf(x / Math.sqrt(2)));
  }
  function erf(x) {
    // Approximation of error function (erf)
    // Abramowitz and Stegun formula 7.1.26
    // Accurate to ~1e-7, sufficient for NIST SP 800-22 but not for cryptographic or arbitrary-precision use.
    const sign = x >= 0 ? 1 : -1;
    const a1 = 0.254829592,
      a2 = -0.284496736,
      a3 = 1.421413741;
    const a4 = -1.453152027,
      a5 = 1.061405429,
      p = 0.3275911;
    const absx = Math.abs(x);
    const t = 1 / (1 + p * absx);
    const y =
      1 -
      ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) *
        t *
        Math.exp(-absx * absx);
    return sign * y;
  }
  let pValue = null;
  let sum1 = 0,
    sum2 = 0;
  // Allow EPS and ITMAX to be overridden for performance tuning
  const EPS =
    typeof cumulativeSumsTest.EPS === "number" ? cumulativeSumsTest.EPS : 1e-12;
  // ITMAX: maximum number of loop iterations per sum (diagnostic/performance cap)
  // For very large n and small z, the theoretical loop bounds may exceed ITMAX; increase if full sum is required.
  const ITMAX =
    typeof cumulativeSumsTest.ITMAX === "number"
      ? cumulativeSumsTest.ITMAX
      : 10000;
  // negligibleCount1/2 are purely informational diagnostics (number of negligible terms encountered, not used in logic)
  let negligibleCount1 = 0,
    negligibleCount2 = 0;
  if (z === 0) {
    // Guard: if z is zero, all cumulative sums are zero, so p-value is 1.0 (perfectly balanced)
    pValue = 1.0;
  } else {
    // Loop bounds for k are derived from NIST spec:
    // sum1: k = ceil((-n/z + 1)/4) to floor((n/z - 1)/4)
    // sum2: k = ceil((-n/z - 3)/4) to floor((n/z - 1)/4)
    const sqrtN = Math.sqrt(n);
    const k1Start = Math.ceil((-n / z + 1) / 4);
    const k1End = Math.floor((n / z - 1) / 4);
    const k2Start = Math.ceil((-n / z - 3) / 4);
    const k2End = Math.floor((n / z - 1) / 4);
    // sum1 (diagnostic: negligibleCount1 is informational only)
    let iters1 = 0;
    for (let k = k1Start; k <= k1End && iters1 < ITMAX; k++, iters1++) {
      const arg1 = ((4 * k + 1) * z) / sqrtN;
      const arg2 = ((4 * k - 1) * z) / sqrtN;
      const term = cdfNormal(arg1) - cdfNormal(arg2);
      sum1 += term;
      if (Math.abs(term) < EPS) negligibleCount1++;
    }
    // sum2 (diagnostic: negligibleCount2 is informational only)
    let iters2 = 0;
    for (let k = k2Start; k <= k2End && iters2 < ITMAX; k++, iters2++) {
      const arg1 = ((4 * k + 3) * z) / sqrtN;
      const arg2 = ((4 * k + 1) * z) / sqrtN;
      const term = cdfNormal(arg1) - cdfNormal(arg2);
      sum2 += term;
      if (Math.abs(term) < EPS) negligibleCount2++;
    }
    pValue = 1 - sum1 + sum2;
  }
  const passed = pValue >= 0.01;
  // Compute mean and stddev efficiently
  const mean = S.length ? S.reduce((a, b) => a + b, 0) / S.length : 0;
  const S_stddev = S.length
    ? Math.sqrt(S.reduce((a, b) => a + (b - mean) ** 2, 0) / S.length)
    : 0;
  return {
    testName: `Cumulative Sums (Cusum) Test [${mode}]`,
    passed,
    statistic: z,
    pValue,
    threshold: 0.01,
    details: {
      n,
      mode,
      z,
      pValue,
      threshold: 0.01,
      interpretation: passed
        ? "Passes randomness criteria"
        : "Fails randomness criteria",
      S_preview: S.slice(0, 10), // Show first 10 cumulative sums for reference
      S_min: S.length ? Math.min(...S) : 0,
      S_max: S.length ? Math.max(...S) : 0,
      S_mean: mean,
      S_stddev,
      sum1,
      sum2,
      z_is_zero: z === 0,
      EPS,
      ITMAX,
      negligibleCount1, // Purely informational: number of negligible terms in sum1 (not used in logic)
      negligibleCount2, // Purely informational: number of negligible terms in sum2 (not used in logic)
    },
  };
}
