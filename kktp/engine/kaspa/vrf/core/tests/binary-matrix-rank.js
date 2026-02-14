/** Binary Matrix Rank Test */
export function binaryMatrixRankTest(bits, matrixSize) {
  // NIST SP 800-22 Binary Matrix Rank Test
  // bits: string of '0' and '1'
  // matrixSize: typically 32 or 64 (square matrix dimension)

  const n = bits.length;
  if (n === 0 || matrixSize <= 0 || matrixSize > n) {
    return {
      testName: "Binary Matrix Rank Test",
      passed: false,
      statistic: null,
      pValue: null,
      threshold: 0.01,
      details: {
        error: "Invalid input: empty bitstring or matrixSize out of range.",
      },
    };
  }

  const blockSize = matrixSize * matrixSize;
  const N = Math.floor(n / blockSize); // number of matrices
  if (N === 0) {
    return {
      testName: "Binary Matrix Rank Test",
      passed: false,
      statistic: null,
      pValue: null,
      threshold: 0.01,
      details: { error: "Bitstring too short for even one matrix." },
    };
  }

  // Helper: compute rank of binary matrix over GF(2)
  function computeRank(matrix, size) {
    let rank = 0;
    let row = 0;
    for (let col = 0; col < size && row < size; col++) {
      // Find pivot
      let pivot = -1;
      for (let i = row; i < size; i++) {
        if (matrix[i][col] === 1) {
          pivot = i;
          break;
        }
      }
      if (pivot === -1) continue;
      // Swap rows
      if (pivot !== row) {
        const tmp = matrix[pivot];
        matrix[pivot] = matrix[row];
        matrix[row] = tmp;
      }
      // Eliminate below
      for (let i = row + 1; i < size; i++) {
        if (matrix[i][col] === 1) {
          for (let j = col; j < size; j++) {
            matrix[i][j] ^= matrix[row][j];
          }
        }
      }
      rank++;
      row++;
    }
    return rank;
  }

  // Count ranks
  let fullRankCount = 0;
  let fullRankMinus1Count = 0;
  let otherRankCount = 0;

  for (let k = 0; k < N; k++) {
    const block = bits.slice(k * blockSize, (k + 1) * blockSize);
    // Build matrix
    const matrix = [];
    for (let i = 0; i < matrixSize; i++) {
      const row = [];
      for (let j = 0; j < matrixSize; j++) {
        row.push(block[i * matrixSize + j] === "1" ? 1 : 0);
      }
      matrix.push(row);
    }
    const rank = computeRank(matrix, matrixSize);
    if (rank === matrixSize) fullRankCount++;
    else if (rank === matrixSize - 1) fullRankMinus1Count++;
    else otherRankCount++;
  }

  // Expected probabilities (NIST SP 800-22 Table 7)
  // For square matrices, probabilities are known asymptotically.
  // Example for 32x32: P_full ≈ 0.2888, P_full-1 ≈ 0.5776, P_other ≈ 0.1336
  // Example for 64x64: P_full ≈ 0.2888, P_full-1 ≈ 0.5776, P_other ≈ 0.1336
  // (Values are the same for 32 and 64 per NIST)
  const pi = [0.2888, 0.5776, 0.1336];
  const counts = [fullRankCount, fullRankMinus1Count, otherRankCount];

  // Chi-squared statistic
  let chiSquared = 0;
  for (let i = 0; i < 3; i++) {
    const expected = pi[i] * N;
    chiSquared += Math.pow(counts[i] - expected, 2) / expected;
  }

  // Degrees of freedom = categories - 1 = 2
  let pValue, gammaQError;
  try {
    pValue = gammaQ(2 / 2, chiSquared / 2); // shape = df/2
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
    testName: "Binary Matrix Rank Test",
    passed,
    statistic: chiSquared,
    pValue,
    threshold: 0.01,
    details: {
      n,
      matrixSize,
      N,
      counts,
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
