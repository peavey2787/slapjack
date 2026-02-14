// Utility functions for spectral DFT and related tests

// Check if a number is a power of two
export function isPowerOfTwo(m) {
  return (m & (m - 1)) === 0;
}

// Iterative in-place radix-2 Cooley–Tukey FFT
export function fftRadix2(re, im) {
  const N = re.length;
  // Bit-reversal permutation
  let j = 0;
  for (let i = 0; i < N; i++) {
    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
    let m = N >> 1;
    while (m && j & m) {
      j &= ~m;
      m >>= 1;
    }
    j |= m;
  }
  // Stages
  for (let len = 2; len <= N; len <<= 1) {
    const halfLen = len >> 1;
    const theta = (-2 * Math.PI) / len;
    const wpr = Math.cos(theta);
    const wpi = Math.sin(theta);
    for (let start = 0; start < N; start += len) {
      let wr = 1,
        wi = 0;
      for (let k = 0; k < halfLen; k++) {
        const i0 = start + k;
        const i1 = i0 + halfLen;
        const tr = wr * re[i1] - wi * im[i1];
        const ti = wr * im[i1] + wi * re[i1];
        re[i1] = re[i0] - tr;
        im[i1] = im[i0] - ti;
        re[i0] = re[i0] + tr;
        im[i0] = im[i0] + ti;
        // rotate twiddle
        const tmpWr = wr * wpr - wi * wpi;
        wi = wr * wpi + wi * wpr;
        wr = tmpWr;
      }
    }
  }
}

// Naive DFT magnitudes (O(n^2), correct for arbitrary n)
export function dftMagnitudesNaive(realSeq) {
  const N = realSeq.length;
  const mags = new Array(N);
  for (let k = 0; k < N; k++) {
    let re = 0,
      im = 0;
    const angBase = (-2 * Math.PI * k) / N;
    for (let t = 0; t < N; t++) {
      const ang = angBase * t;
      const c = Math.cos(ang);
      const s = Math.sin(ang);
      re += realSeq[t] * c;
      im += realSeq[t] * s;
    }
    mags[k] = Math.hypot(re, im);
  }
  return mags;
}

// Complementary error function (Abramowitz & Stegun 7.1.26)
export function erfc(x) {
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
