/** Random Excursions Test (NIST SP 800-22) */
export function randomExcursionsTest(bits) {
  const n = bits.length;
  if (n === 0) {
    return {
      testName: "Random Excursions Test",
      passed: false,
      statistic: null,
      pValue: null,
      threshold: 0.01,
      details: { error: "Input bitstring is empty." },
    };
  }

  // Convert bits to ±1 sequence
  const seq = new Array(n);
  for (let i = 0; i < n; i++) seq[i] = bits[i] === "1" ? 1 : -1;

  // Cumulative sum (random walk)
  const S = [0];
  for (let i = 0; i < n; i++) S.push(S[i] + seq[i]);

  // Identify cycles: positions where cumulative sum returns to 0
  const cycleIndices = [];
  for (let i = 1; i <= n; i++) {
    if (S[i] === 0) cycleIndices.push(i);
  }
  if (S[n] !== 0) cycleIndices.push(n);

  const J = cycleIndices.length; // number of cycles
  if (J < 500) {
    return {
      testName: "Random Excursions Test",
      passed: false,
      statistic: null,
      pValue: null,
      threshold: 0.01,
      details: { error: "Insufficient cycles (J < 500). Test not applicable." },
    };
  }

  // States to test: x ∈ {±1, ±2, ±3, ±4}
  const states = [-4, -3, -2, -1, 1, 2, 3, 4];
  const results = [];

  for (const x of states) {
    // Count visits to state x in each cycle
    const counts = new Array(J).fill(0);
    let cycleStart = 0;
    for (let j = 0; j < J; j++) {
      const cycleEnd = cycleIndices[j];
      for (let k = cycleStart + 1; k <= cycleEnd; k++) {
        if (S[k] === x) counts[j]++;
      }
      cycleStart = cycleEnd;
    }

    // Distribution categories k = 0..5 (≥5 grouped)
    const nu = new Array(6).fill(0);
    for (const c of counts) {
      if (c >= 5) nu[5]++;
      else nu[c]++;
    }

    // Expected probabilities π_k(x) per NIST Table 4
    const piTable = {
      "-4": [0.5, 0.25, 0.125, 0.0625, 0.03125, 0.03125],
      "-3": [0.5, 0.25, 0.125, 0.0625, 0.03125, 0.03125],
      "-2": [0.5, 0.25, 0.125, 0.0625, 0.03125, 0.03125],
      "-1": [0.5, 0.25, 0.125, 0.0625, 0.03125, 0.03125],
      1: [0.5, 0.25, 0.125, 0.0625, 0.03125, 0.03125],
      2: [0.5, 0.25, 0.125, 0.0625, 0.03125, 0.03125],
      3: [0.5, 0.25, 0.125, 0.0625, 0.03125, 0.03125],
      4: [0.5, 0.25, 0.125, 0.0625, 0.03125, 0.03125],
    };
    const pi = piTable[x.toString()];

    // Chi-squared statistic
    let chiSquared = 0;
    for (let k = 0; k < 6; k++) {
      const expected = J * pi[k];
      chiSquared += Math.pow(nu[k] - expected, 2) / expected;
    }

    // p-value with df = 5
    let pValue, gammaQError;
    try {
      pValue = gammaQ(5 / 2, chiSquared / 2);
      if (!isFinite(pValue) || isNaN(pValue)) {
        gammaQError = "gammaQ returned non-finite pValue.";
        pValue = null;
      }
    } catch (err) {
      gammaQError =
        "gammaQ threw: " + (err && err.message ? err.message : String(err));
      pValue = null;
    }

    results.push({ state: x, chiSquared, pValue, nu, pi, gammaQError });
  }

  const passed = results.every((r) => r.pValue !== null && r.pValue >= 0.01);

  return {
    testName: "Random Excursions Test",
    passed,
    statistic: results.map((r) => r.chiSquared),
    pValue: results.map((r) => r.pValue),
    threshold: 0.01,
    details: {
      n,
      J,
      results,
      interpretation: passed
        ? "Passes randomness criteria"
        : "Fails randomness criteria",
    },
  };
}

/** Random Excursions Variant Test (NIST SP 800-22) */
export function randomExcursionsVariantTest(bits) {
  const n = bits.length;
  if (n === 0) {
    return {
      testName: "Random Excursions Variant Test",
      passed: false,
      statistic: null,
      pValue: null,
      threshold: 0.01,
      details: { error: "Input bitstring is empty." },
    };
  }

  // Convert bits to ±1 sequence
  const seq = new Array(n);
  for (let i = 0; i < n; i++) seq[i] = bits[i] === "1" ? 1 : -1;

  // Cumulative sum (random walk)
  const S = [0];
  for (let i = 0; i < n; i++) S.push(S[i] + seq[i]);

  // Identify cycles (returns to zero)
  const cycleIndices = [];
  for (let i = 1; i <= n; i++) {
    if (S[i] === 0) cycleIndices.push(i);
  }
  if (S[n] !== 0) cycleIndices.push(n);

  const J = cycleIndices.length;
  if (J < 500) {
    return {
      testName: "Random Excursions Variant Test",
      passed: false,
      statistic: null,
      pValue: null,
      threshold: 0.01,
      details: { error: "Insufficient cycles (J < 500). Test not applicable." },
    };
  }

  // States to test: x ∈ {±1..±9}
  const states = [];
  for (let i = -9; i <= 9; i++) if (i !== 0) states.push(i);

  const results = [];
  for (const x of states) {
    // Count total visits to state x across all cycles
    let totalVisits = 0;
    let cycleStart = 0;
    for (let j = 0; j < J; j++) {
      const cycleEnd = cycleIndices[j];
      for (let k = cycleStart + 1; k <= cycleEnd; k++) {
        if (S[k] === x) totalVisits++;
      }
      cycleStart = cycleEnd;
    }

    // Expected mean visits: J / (2 * |x|)
    const mean = J / (2 * Math.abs(x));
    const variance = J * (1 / (4 * x * x));
    const sigma = Math.sqrt(variance);

    // Complementary error function (Abramowitz & Stegun 7.1.26)
    function erfc(val) {
      const z = Math.abs(val);
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
                                        t *
                                          (-0.82215223 + t * 0.17087277)))))))),
        );
      return val >= 0 ? r : 2 - r;
    }

    // z-score and p-value
    let pValue, erfcError, z;
    if (sigma === 0) {
      z = 0;
      pValue = 1;
    } else {
      try {
        z = Math.abs(totalVisits - mean) / (Math.SQRT2 * sigma);
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

    results.push({
      state: x,
      totalVisits,
      mean,
      variance,
      z,
      pValue,
      erfcError,
    });
  }

  const passed = results.every((r) => r.pValue !== null && r.pValue >= 0.01);

  return {
    testName: "Random Excursions Variant Test",
    passed,
    statistic: results.map((r) => r.z),
    pValue: results.map((r) => r.pValue),
    threshold: 0.01,
    details: {
      n,
      J,
      results,
      interpretation: passed
        ? "Passes randomness criteria"
        : "Fails randomness criteria",
    },
  };
}
