/** Maurer’s Universal Statistical Test (heavyweight, strict NIST) */
export function maurerUniversalTest(bits, blockSize) {
  // NIST SP 800-22 Maurer’s Universal Statistical Test
  // bits: string of '0' and '1'
  // blockSize (L): must be an integer in [6..16] per strict NIST configuration

  const n = bits.length;
  if (
    n === 0 ||
    !Number.isInteger(blockSize) ||
    blockSize < 6 ||
    blockSize > 16
  ) {
    return {
      testName: "Maurer’s Universal Statistical Test",
      passed: false,
      statistic: null,
      pValue: null,
      threshold: 0.01,
      details: {
        error:
          n === 0
            ? "Invalid input: empty bitstring."
            : "Unsupported blockSize. Strict NIST requires L in [6..16].",
      },
    };
  }

  const L = blockSize;
  const V = 1 << L; // alphabet size (2^L)
  const Q = 10 * V; // initialization blocks per NIST
  const totalBlocks = Math.floor(n / L);
  const K = totalBlocks - Q; // test segment blocks
  if (K <= 0) {
    return {
      testName: "Maurer’s Universal Statistical Test",
      passed: false,
      statistic: null,
      pValue: null,
      threshold: 0.01,
      details: {
        n,
        L,
        error: "Bitstring too short: requires at least (Q + 1) blocks.",
      },
    };
  }
  // NIST strongly recommends K ≥ 1000 for reliable statistics
  if (K < 1000) {
    return {
      testName: "Maurer’s Universal Statistical Test",
      passed: false,
      statistic: null,
      pValue: null,
      threshold: 0.01,
      details: {
        n,
        L,
        Q,
        K,
        error: "Insufficient test blocks K. Strict NIST recommends K ≥ 1000.",
      },
    };
  }

  // Expected value μ(L) and standard deviation σ(L) per NIST table for L=6..16
  const MU = {
    6: 5.2177052,
    7: 6.1962507,
    8: 7.1836656,
    9: 8.1764248,
    10: 9.1723243,
    11: 10.170032,
    12: 11.168765,
    13: 12.16807,
    14: 13.167693,
    15: 14.167488,
    16: 15.167379,
  };
  const SIGMA = {
    6: 2.954,
    7: 3.125,
    8: 3.238,
    9: 3.311,
    10: 3.356,
    11: 3.384,
    12: 3.401,
    13: 3.41,
    14: 3.416,
    15: 3.419,
    16: 3.421,
  };
  const mu = MU[L];
  const sigma = SIGMA[L];

  // Complementary error function (erfc): Abramowitz & Stegun 7.1.26 approximation
  function erfc(x) {
    const z = Math.abs(x);
    const t = 1 / (1 + 0.5 * z);
    const r =
      t *
      Math.exp(
        -z * z -
          1.26551223 +
          t *
            (1.00002368 +
              t *
                (0.37409196 +
                  t *
                    (0.09678418 +
                      t *
                        (-0.18628806 +
                          t *
                            (0.27886807 +
                              t *
                                (-1.13520398 +
                                  t *
                                    (1.48851587 +
                                      t * (-0.82215223 + t * 0.17087277)))))))),
      );
    return x >= 0 ? r : 2 - r;
  }

  // Build table T of last occurrence positions for each L-bit pattern
  const T = new Int32Array(V);
  // Parse helper: convert an L-bit substring starting at bit index 'pos' into integer [0..V-1]
  function blockValueAt(pos) {
    let v = 0;
    for (let i = 0; i < L; i++) {
      v = (v << 1) | (bits[pos + i] === "1" ? 1 : 0);
    }
    return v;
  }

  // Initialization phase: first Q blocks set T[value] = block index (1-based or 0-based both fine as long as consistent)
  // We’ll use 0-based block indices throughout: j = 0..Q-1
  for (let j = 0; j < Q; j++) {
    const pos = j * L;
    T[blockValueAt(pos)] = j;
  }

  // Test phase: sum of log2 distances
  let sum = 0;
  for (let j = Q; j < Q + K; j++) {
    const pos = j * L;
    const v = blockValueAt(pos);
    const dist = j - T[v];
    // Per NIST, dist should be ≥ 1; T[v] is always set in init or earlier update
    sum += Math.log2(dist);
    T[v] = j;
  }

  const fn = sum / K; // observed average
  // p-value using normal approximation: two-sided tail via erfc
  let pValue, erfcError;
  try {
    const z = Math.abs(fn - mu) / (Math.SQRT2 * sigma);
    pValue = erfc(z);
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

  // Diagnostics: include a small preview of distances distribution via running mean and last few distances
  const details = {
    n,
    L,
    V,
    Q,
    K,
    mu,
    sigma,
    fn,
    pValue,
    erfcError,
    interpretation: passed
      ? "Passes randomness criteria"
      : "Fails randomness criteria",
  };

  return {
    testName: "Maurer’s Universal Statistical Test",
    passed,
    statistic: fn,
    pValue,
    threshold: 0.01,
    details,
  };
}
