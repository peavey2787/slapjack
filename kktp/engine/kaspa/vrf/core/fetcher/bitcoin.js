// bitcoin.js
// Bitcoin block fetching logic with Cache and Throttle integration
import { BTC_BLOCK_COUNT } from "../constants.js";
import { CONFIG } from "../config.js";
import { Block } from "../models/Block.js";
import { getBtcBlockCache, setBtcBlockCache } from "./cache.js";
import { logInfo, logError } from "../logs/logger.js";

// --- Constants ---
const PROXY = "https://api.allorigins.win/raw?url=";
const API_URL = "https://mempool.space/api/v1/blocks";

// State variable for throttling
let lastBtcApiCall = 0;

/**
 * Fetch N recent Bitcoin blocks using a one-shot proxy call + local caching.
 * @param {number} n - Number of blocks to fetch (defaults to BTC_BLOCK_COUNT)
 * @returns {Promise<Object[]>} - Array of universal Block objects
 */
export async function getBitcoinBlocks(n = BTC_BLOCK_COUNT) {
  if (!Number.isInteger(n) || n <= 0)
    throw new Error("BTC block count must be a positive integer");

  const now = Date.now();
  const cache = getBtcBlockCache();

  // 1. Check Cache Validity
  if (
    cache &&
    now - cache.timestamp < CONFIG.BTC_CACHE_DURATION &&
    cache.blocks.length >= n
  ) {
    logInfo("BTC block cache hit", { n });
    return cache.blocks.slice(0, n);
  }

  // 2. Check Throttle State
  // If we're inside the throttle window, return cache (even if stale) or throw.
  if (now - lastBtcApiCall < CONFIG.BTC_API_THROTTLE) {
    if (cache && cache.blocks && cache.blocks.length >= n) {
      logInfo("BTC API throttled, returning cached data (stale allowed)", {
        n,
      });
      return cache.blocks.slice(0, n);
    }
    const waitTime = Math.ceil(
      (CONFIG.BTC_API_THROTTLE - (now - lastBtcApiCall)) / 1000,
    );
    throw new Error(`BTC API throttled and no cached data: wait ${waitTime}s`);
  }

  // Auto-retry with exponential backoff (production-ready)
  const MAX_RETRIES = 3;
  let lastErr = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      // Set throttle timestamp before the call to prevent double-firing
      lastBtcApiCall = Date.now();
      logInfo(`Requesting BTC blocks via Proxy (attempt ${attempt}/${MAX_RETRIES})...`);

      // 3. The Working "One-Shot" Fetch
      const response = await fetch(`${PROXY}${encodeURIComponent(API_URL)}`);

      if (!response.ok)
        throw new Error(
          `Proxy/API Error: ${response.status} ${response.statusText}`,
        );

      const latestBatch = await response.json();

      if (!Array.isArray(latestBatch) || latestBatch.length === 0)
        throw new Error("Invalid or empty data format from Mempool");

      const latestHeight = latestBatch[0].height;

      // 4. Map to Universal Block Model
      // We only take the first 'n' blocks from the batch
      const blocks = latestBatch.slice(0, n).map((b) => {
        return new Block({
          hash: b.id,
          height: b.height,
          time: b.timestamp,
          source: "mempool.space",
          confirms: latestHeight - b.height + 1,
        });
      });

      // 5. Update Cache and Return
      setBtcBlockCache(blocks);
      logInfo("BTC blocks successfully fetched and cached", {
        count: blocks.length,
      });
      return blocks;
    } catch (err) {
      lastErr = err;
      lastBtcApiCall = 0; // Reset throttle to allow immediate retry
      logError(`BTC fetch error (attempt ${attempt}/${MAX_RETRIES})`, { n, error: err.message });

      if (attempt < MAX_RETRIES) {
        const delay = 1000 * Math.pow(2, attempt - 1); // 1s, 2s
        logInfo(`Retrying BTC fetch in ${delay}ms...`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  // All retries exhausted — return stale cache if available
  const staleCache = getBtcBlockCache();
  if (staleCache?.blocks?.length >= n) {
    logInfo("All BTC fetch retries failed, returning stale cache", {
      n,
      cacheAge: Math.round((Date.now() - staleCache.timestamp) / 1000) + "s",
    });
    return staleCache.blocks.slice(0, n);
  }

  throw lastErr;
}

// Helper: Convert BTC API block to universal Block
export function btcApiToBlock(block, latestHeight) {
  const confirms = latestHeight - block.height + 1;
  return new Block({
    hash: block.id,
    height: block.height,
    time: block.timestamp,
    source: "bitcoin",
    confirms,
  });
}
