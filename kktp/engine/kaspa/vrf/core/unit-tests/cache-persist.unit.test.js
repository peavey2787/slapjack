// cache-persist.unit.test.js
// Enterprise-grade unit tests for core/fetcher/cache.js
import {
  getBtcBlockCache,
  setBtcBlockCache,
  getQrngCache,
  setQrngCache,
} from "../fetcher/cache.js";

export async function runTests() {
  let passed = true;
  let details = [];

  try {
    // 1. BTC cache: write and read
    setBtcBlockCache([{ hash: "abc", isFinal: true }]);
    const btcCache = getBtcBlockCache();
    if (!Array.isArray(btcCache.blocks)) {
      passed = false;
      details.push("BTC cache does not return blocks array");
    }
    if (btcCache.blocks[0].hash !== "abc") {
      passed = false;
      details.push("BTC cache does not return correct block");
    }

    // 2. QRNG cache: write and read
    setQrngCache("anu", 16, { data: [1, 2, 3], length: 3, provider: "anu" });
    const qrngCache = getQrngCache();
    if (qrngCache.provider !== "anu") {
      passed = false;
      details.push("QRNG cache does not return correct provider");
    }
    if (!Array.isArray(qrngCache.result.data)) {
      passed = false;
      details.push("QRNG cache does not return data array");
    }

    // 3. BTC cache: returns default if missing
    // (simulate by clearing localStorage)
    localStorage.removeItem("btc_block_cache");
    const btcCacheDefault = getBtcBlockCache();
    if (!btcCacheDefault.blocks) {
      passed = false;
      details.push("BTC cache does not return default if missing");
    }

    // 4. QRNG cache: returns default if missing
    localStorage.removeItem("qrng_cache");
    const qrngCacheDefault = getQrngCache();
    if (!qrngCacheDefault.result) {
      passed = false;
      details.push("QRNG cache does not return default if missing");
    }
  } catch (err) {
    passed = false;
    details.push("Exception: " + (err.message || err.toString()));
  }

  if (passed) details.push("All cache-persist.js unit tests passed.");
  return { passed, details: details.join("\n") };
}
