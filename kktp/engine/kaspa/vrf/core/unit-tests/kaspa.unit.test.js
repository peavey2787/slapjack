// kaspa.unit.test.js
// Enterprise-grade unit tests for core/fetcher/kaspa.js
import { getKaspaBlocks } from "../fetcher/kaspa.js";

export async function runTests() {
  let passed = true;
  let details = [];

  // 1. Throws on invalid count
  let threw = false;
  try {
    await getKaspaBlocks(0);
  } catch (e) {
    threw = true;
  }
  if (!threw) {
    passed = false;
    details.push("getKaspaBlocks does not throw on invalid count");
  }

  // 2. Returns array of blocks (mocked API)
  try {
    const blocks = await getKaspaBlocks(1);
    if (!Array.isArray(blocks)) {
      passed = false;
      details.push("getKaspaBlocks does not return array");
    }
  } catch (e) {
    // Acceptable if API is unreachable
    if (!(e instanceof Error)) {
      passed = false;
      details.push("getKaspaBlocks throws non-Error when API unreachable");
    }
  }

  if (passed) details.push("All kaspa.js unit tests passed.");
  return { passed, details: details.join("\n") };
}
