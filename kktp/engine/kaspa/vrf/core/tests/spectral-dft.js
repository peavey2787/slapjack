import {
  isPowerOfTwo,
  fftRadix2,
  dftMagnitudesNaive,
  erfc,
} from "./utilities.js";

/** Discrete Fourier Transform (Spectral) Test — NIST SP 800-22 */
export function spectralDFTTest(bits) {
  // bits: string of '0' and '1'
  // NIST checks periodic features in the sequence via DFT magnitudes.
  const n = bits.length;
  if (n === 0) {
    return {
      testName: "Discrete Fourier Transform (Spectral) Test",
      passed: false,
      statistic: null,
      pValue: null,
      threshold: 0.01,
      details: { error: "Invalid input: empty bitstring." },
    };
  }
  // NIST recommends n ≥ 1000 for reliability
  if (n < 1000) {
    return {
      testName: "Discrete Fourier Transform (Spectral) Test",
      passed: false,
      statistic: null,
      pValue: null,
      threshold: 0.01,
      details: {
        n,
        error: "Bitstring too short for reliable DFT test (n < 1000).",
      },
    };
  }

  // Convert bits to ±1 sequence (mean ~ 0)
  const x = new Array(n);
  for (let i = 0; i < n; i++) x[i] = bits[i] === "1" ? 1 : -1;

  // Compute DFT magnitudes |F_k|. Use radix-2 FFT if n is a power of two; else fallback to O(n^2) DFT.
  let magnitudes;
  if (isPowerOfTwo(n)) {
    const re = x.slice();
    const im = new Array(n).fill(0);
    fftRadix2(re, im); // in-place FFT
    magnitudes = new Array(n);
    for (let k = 0; k < n; k++) magnitudes[k] = Math.hypot(re[k], im[k]);
  } else {
    // Naive DFT fallback for arbitrary n (heavier but correct)
    magnitudes = dftMagnitudesNaive(x);
  }

  // NIST counts peaks in first n/2 frequencies (excluding DC). Threshold:
  // T = sqrt( ln(1/0.05) * n )
  const half = Math.floor(n / 2);
  const T = Math.sqrt(Math.log(1 / 0.05) * n);

  // Count number of peaks below threshold in first half (excluding k=0)
  let N1 = 0;
  for (let k = 1; k < half; k++) {
    if (magnitudes[k] < T) N1++;
  }

  // Expected count and variance
  // N0 = 0.95 * n / 2
  // var = n * 0.95 * 0.05 / 4
  const N0 = (0.95 * n) / 2;
  const variance = (n * 0.95 * 0.05) / 4;
  const d = (N1 - N0) / Math.sqrt(variance);

  // P-value via complementary error function (two-sided normal tail)
  let pValue, erfcError;
  try {
    pValue = erfc(Math.abs(d) / Math.SQRT2);
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

  // Diagnostics: preview top magnitudes (indices and values) from first half
  const previewCount = Math.min(10, half - 1);
  const preview = [];
  for (let k = 1; k <= previewCount; k++) {
    preview.push({ k, magnitude: magnitudes[k] });
  }

  return {
    testName: "Discrete Fourier Transform (Spectral) Test",
    passed,
    statistic: d,
    pValue,
    threshold: 0.01,
    details: {
      n,
      T,
      N1,
      N0,
      variance,
      d,
      pValue,
      erfcError,
      magnitudesPreview: preview,
      interpretation: passed
        ? "Passes randomness criteria"
        : "Fails randomness criteria",
    },
  };
}
