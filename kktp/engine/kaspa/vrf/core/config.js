// config.js
// Centralized configuration for tunable parameters and endpoints

export const CONFIG = {
  // Tunable block counts
  BTC_BLOCK_COUNT: 6, // default, can be overridden
  KASPA_BLOCK_COUNT: 6, // default, can be overridden

  // Finality
  BTC_FINALITY_CONFIRMATIONS: 6,
  KASPA_FINALITY_DAG_DEPTH: 60,

  // Cache durations (ms)
  BTC_CACHE_DURATION: 10 * 60 * 1000, // 10 minutes
  QRNG_CACHE_DURATION: 60 * 1000, // 1 minute

  // API call throttling (ms)
  BTC_API_THROTTLE: 2000, // 2 seconds between calls
  QRNG_API_THROTTLE: 60000, // 1 minute between calls
};
