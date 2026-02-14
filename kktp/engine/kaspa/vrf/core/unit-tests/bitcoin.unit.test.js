// bitcoin.unit.test.js
// Enterprise-grade unit tests for core/fetcher/bitcoin.js
import { getBitcoinBlocks } from "../fetcher/bitcoin.js";
import { setBtcBlockCache } from "../fetcher/cache.js"; // Use unified cache.js

export async function runTests() {
  let passed = true;
  let details = [];

  try {
    // 1. Returns array of blocks with correct length
    setBtcBlockCache(Array(6).fill({ isFinal: true }));
    const blocks = await getBitcoinBlocks(6);
    if (!Array.isArray(blocks)) {
      passed = false;
      details.push("getBitcoinBlocks does not return array");
    }
    if (blocks.length !== 6) {
      passed = false;
      details.push(`getBitcoinBlocks returns wrong length: ${blocks.length}`);
    }

    // 2. Throws on invalid count
    let threw = false;
    try {
      await getBitcoinBlocks(0);
    } catch (e) {
      threw = true;
    }
    if (!threw) {
      passed = false;
      details.push("getBitcoinBlocks does not throw on invalid count");
    }

    // 3. Returns cached data if throttled
    setBtcBlockCache(Array(6).fill({ isFinal: true }));
    const blocks2 = await getBitcoinBlocks(6);
    if (!Array.isArray(blocks2)) {
      passed = false;
      details.push("throttled getBitcoinBlocks does not return array");
    }
  } catch (err) {
    passed = false;
    details.push("Exception: " + (err.message || err.toString()));
  }

  if (passed) details.push("All bitcoin.js unit tests passed.");
  return { passed, details: details.join("\n") };
}
