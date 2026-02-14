/** Non-overlapping Template Matching Test (NIST SP 800-22) */
export function nonOverlappingTemplateTest(bits, template) {
  // bits: string of '0' and '1'
  // template: string of '0'/'1' with 2 <= m <= 25
  const n = bits.length;
  const m = template?.length ?? 0;

  if (n === 0 || !template || m < 2 || m > 25) {
    return {
      testName: "Non-overlapping Template Matching Test",
      passed: false,
      statistic: null,
      pValue: null,
      threshold: 0.01,
      details: {
        error:
          n === 0
            ? "Invalid input: empty bitstring."
            : "Invalid template: must be a 2–25 bit pattern.",
      },
    };
  }

  // Choose number of blocks N for chi-squared stability (N ≥ 16 recommended)
  const N = Math.max(16, Math.min(64, Math.floor(n / Math.max(m + 1, 1000))));
  const M = Math.floor(n / N); // block size
  if (M < m) {
    return {
      testName: "Non-overlapping Template Matching Test",
      passed: false,
      statistic: null,
      pValue: null,
      threshold: 0.01,
      details: {
        n,
        m,
        N,
        M,
        error:
          "Bitstring too short: block size M must be >= template length m.",
      },
    };
  }

  // Count non-overlapping matches in each block
  const counts = new Array(N).fill(0);
  for (let b = 0; b < N; b++) {
    const start = b * M;
    const end = start + M;
    let j = start;
    while (j + m <= end) {
      // Check match at j..j+m-1
      let match = true;
      for (let k = 0; k < m; k++) {
        if (bits[j + k] !== template[k]) {
          match = false;
          break;
        }
      }
      if (match) {
        counts[b]++;
        j += m; // non-overlapping: advance by m
      } else {
        j += 1;
      }
    }
  }

  // Expected mean per block (Poisson assumption)
  const lambda = (M - m + 1) / Math.pow(2, m);

  // Chi-squared over N blocks: sum (W_i - λ)^2 / λ
  let chiSquared = 0;
  for (let i = 0; i < N; i++) {
    chiSquared += Math.pow(counts[i] - lambda, 2) / lambda;
  }

  // p-value via upper incomplete gamma: df = N
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

  // Diagnostics
  const meanCount = counts.reduce((a, b) => a + b, 0) / N;
  const varCount =
    counts.reduce((a, b) => a + Math.pow(b - meanCount, 2), 0) / N;

  return {
    testName: "Non-overlapping Template Matching Test",
    passed,
    statistic: chiSquared,
    pValue,
    threshold: 0.01,
    details: {
      n,
      m,
      N,
      M,
      lambda,
      chiSquared,
      pValue,
      gammaQError,
      meanCount,
      varCount,
      countsPreview: counts.slice(0, 8),
      interpretation: passed
        ? "Passes randomness criteria"
        : "Fails randomness criteria",
    },
  };
}

/** Overlapping Template Matching Test (NIST SP 800-22, strict: template = '111...1') */
export function overlappingTemplateTest(bits, template) {
  // bits: string of '0' and '1'
  // template: must be all ones per NIST (e.g., '111111' for m=6), with 2 <= m <= 25
  const n = bits.length;
  const m = template?.length ?? 0;

  if (n === 0 || !template || m < 2 || m > 25) {
    return {
      testName: "Overlapping Template Matching Test",
      passed: false,
      statistic: null,
      pValue: null,
      threshold: 0.01,
      details: {
        error:
          n === 0
            ? "Invalid input: empty bitstring."
            : "Invalid template: must be 2–25 bits long.",
      },
    };
  }

  // Strict NIST: template must be all ones
  for (let i = 0; i < m; i++) {
    if (template[i] !== "1") {
      return {
        testName: "Overlapping Template Matching Test",
        passed: false,
        statistic: null,
        pValue: null,
        threshold: 0.01,
        details: {
          m,
          error:
            "Unsupported template: NIST defines overlapping test for template '111...1' only.",
        },
      };
    }
  }

  // Count overlapping occurrences across the entire sequence
  let W = 0;
  for (let i = 0; i + m <= n; i++) {
    let match = true;
    for (let k = 0; k < m; k++) {
      if (bits[i + k] !== "1") {
        match = false;
        break;
      }
    }
    if (match) W++;
  }

  // Probability of template at any position: p = 1 / 2^m
  const p = 1 / Math.pow(2, m);

  // Mean and variance (normal approximation per NIST for all-ones template)
  // μ = (n - m + 1) * p
  // σ² ≈ n * ( p - (2m - 1) * p^2 )
  const mu = (n - m + 1) * p;
  const sigma2 = n * (p - (2 * m - 1) * p * p);
  const sigma = Math.sqrt(Math.max(sigma2, 0));

  // Complementary error function (Abramowitz & Stegun 7.1.26)
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

  // z-score and p-value (two-sided normal tail)
  let pValue, erfcError, z;
  if (sigma === 0) {
    // Degenerate case: variance ~ 0 (e.g., extremely large m vs n)
    z = 0;
    pValue = 1;
  } else {
    try {
      z = Math.abs(W - mu) / (Math.SQRT2 * sigma);
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
  }

  const passed = pValue !== null && pValue >= 0.01;

  return {
    testName: "Overlapping Template Matching Test",
    passed,
    statistic: z,
    pValue,
    threshold: 0.01,
    details: {
      n,
      m,
      W,
      mu,
      sigma2,
      z,
      pValue,
      erfcError,
      interpretation: passed
        ? "Passes randomness criteria"
        : "Fails randomness criteria",
    },
  };
}
