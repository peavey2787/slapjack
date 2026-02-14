/** Linear Complexity Test (Berlekamp–Massey, strict NIST M=500) */
export function linearComplexityTest(bits, blockSize) {
  // NIST SP 800-22 Linear Complexity Test (strict NIST configuration)
  // bits: string of '0' and '1'
  // blockSize: must be exactly 500 (strict NIST)
  const n = bits.length;
  if (n === 0 || blockSize !== 500) {
    return {
      testName: "Linear Complexity Test",
      passed: false,
      statistic: null,
      pValue: null,
      threshold: 0.01,
      details: {
        error:
          blockSize !== 500
            ? "Unsupported blockSize. Strict NIST requires blockSize = 500."
            : "Invalid input: empty bitstring.",
      },
    };
  }

  const M = 500;
  const N = Math.floor(n / M); // number of blocks
  if (N === 0) {
    return {
      testName: "Linear Complexity Test",
      passed: false,
      statistic: null,
      pValue: null,
      threshold: 0.01,
      details: { error: "Bitstring too short for even one 500-bit block." },
    };
  }

  // Expected mean μ per NIST:
  // μ = M/2 + ( (−1)^(M+1) + 9 ) / 36
  // For M = 500 (even), (−1)^(M+1) = −1, so μ = M/2 + 2/9
  const mu = M / 2 + 2 / 9;

  // Berlekamp–Massey over GF(2) to compute linear complexity L for a 500-bit block
  function berlekampMasseyGF2(seq) {
    const C = new Array(M).fill(0);
    C[0] = 1; // connection polynomial
    const B = new Array(M).fill(0);
    B[0] = 1; // previous C
    let L = 0; // current linear complexity
    let m = -1; // last update index

    for (let n = 0; n < M; n++) {
      // Discrepancy d = s[n] XOR sum_{i=1..L} C[i] * s[n - i] (mod 2)
      let d = seq[n];
      for (let i = 1; i <= L; i++) {
        d ^= C[i] & seq[n - i];
      }
      if (d === 1) {
        const T = C.slice();
        const shift = n - m;
        // C = C XOR (B << shift)
        for (let i = 0; i + shift < M; i++) {
          C[i + shift] ^= B[i];
        }
        if (L <= n / 2) {
          L = n + 1 - L;
          // B = T, m = n
          for (let i = 0; i < M; i++) B[i] = T[i];
          m = n;
        }
      }
    }
    return L;
  }

  // Convert bits to numeric sequence and process blocks
  const counts = new Array(7).fill(0);
  for (let b = 0; b < N; b++) {
    const start = b * M;
    const blockBits = bits.slice(start, start + M);
    const seq = new Array(M);
    for (let i = 0; i < M; i++) seq[i] = blockBits[i] === "1" ? 1 : 0;

    const L = berlekampMasseyGF2(seq);

    // NIST normalization and binning:
    // T = (−1)^M * (L − μ) + 2/9
    // With M even, (−1)^M = +1, so T = (L − μ) + 2/9
    const T = L - mu + 2 / 9;

    // Bin edges (7 bins): (-∞, -2.5], (-2.5, -1.5], (-1.5, -0.5], (-0.5, 0.5],
    // (0.5, 1.5], (1.5, 2.5], (2.5, ∞)
    if (T <= -2.5)
      counts[0]++; // v0
    else if (T <= -1.5)
      counts[1]++; // v1
    else if (T <= -0.5)
      counts[2]++; // v2
    else if (T <= 0.5)
      counts[3]++; // v3
    else if (T <= 1.5)
      counts[4]++; // v4
    else if (T <= 2.5)
      counts[5]++; // v5
    else counts[6]++; // v6
  }

  // NIST π probabilities for M=500 (7 bins)
  // π = [1/96, 1/32, 1/8, 1/2, 1/4, 1/16, 1/48]
  const pi = [1 / 96, 1 / 32, 1 / 8, 1 / 2, 1 / 4, 1 / 16, 1 / 48];

  // Chi-squared statistic over 7 bins
  let chiSquared = 0;
  const expected = new Array(7);
  for (let i = 0; i < 7; i++) {
    expected[i] = pi[i] * N;
    chiSquared += Math.pow(counts[i] - expected[i], 2) / expected[i];
  }

  // Degrees of freedom: k - 1 = 6 → shape = df/2 = 3
  let pValue, gammaQError;
  try {
    pValue = gammaQ(3, chiSquared / 2);
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

  return {
    testName: "Linear Complexity Test",
    passed,
    statistic: chiSquared,
    pValue,
    threshold: 0.01,
    details: {
      n,
      blockSize: M,
      N,
      mu,
      counts,
      expected,
      pi,
      chiSquared,
      pValue,
      gammaQError,
      interpretation: passed
        ? "Passes randomness criteria"
        : "Fails randomness criteria",
    },
  };
}
