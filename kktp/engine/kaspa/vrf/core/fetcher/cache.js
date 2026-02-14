// cache.js
// Unified cache for BTC blocks and QRNG (in-memory + persistent)
import { logInfo, logError } from "../logs/logger.js";

const BTC_KEY = "btc_block_cache";
const QRNG_KEY = "qrng_cache";

// In-memory cache
let btcBlockCache = { blocks: [], timestamp: 0 };
let qrngCache = { provider: null, length: null, result: null, timestamp: 0 };

// --- BTC Block Cache ---

export function getBtcBlockCache() {
  try {
    const raw = localStorage.getItem(BTC_KEY);
    if (raw) {
      const data = JSON.parse(raw);
      btcBlockCache = data;
      logInfo("Read BTC block cache", { BTC_KEY });
      return data;
    }
  } catch (err) {
    logError("Failed to read BTC block cache", { BTC_KEY, error: err.message });
  }
  return btcBlockCache;
}

export function setBtcBlockCache(blocks) {
  const cacheObj = { blocks, timestamp: Date.now() };
  btcBlockCache = cacheObj;
  try {
    localStorage.setItem(BTC_KEY, JSON.stringify(cacheObj));
    logInfo("Wrote BTC block cache", { BTC_KEY });
  } catch (err) {
    logError("Failed to write BTC block cache", { BTC_KEY, error: err.message });
  }
}

// --- QRNG Cache ---

export function getQrngCache() {
  try {
    const raw = localStorage.getItem(QRNG_KEY);
    if (raw) {
      const data = JSON.parse(raw);
      qrngCache = data;
      logInfo("Read QRNG cache", { QRNG_KEY });
      return data;
    }
  } catch (err) {
    logError("Failed to read QRNG cache", { QRNG_KEY, error: err.message });
  }
  return qrngCache;
}

export function setQrngCache(provider, length, result) {
  const cacheObj = { provider, length, result, timestamp: Date.now() };
  qrngCache = cacheObj;
  try {
    localStorage.setItem(QRNG_KEY, JSON.stringify(cacheObj));
    logInfo("Wrote QRNG cache", { QRNG_KEY });
  } catch (err) {
    logError("Failed to write QRNG cache", { QRNG_KEY, error: err.message });
  }
}
