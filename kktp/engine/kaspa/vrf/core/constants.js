// API endpoints and parsing config for supported chains
import { Block } from "./models/Block.js";

import { CONFIG } from "./config.js";

export const API_CONFIG = {
  bitcoin: {
    endpoint: "https://mempool.space/api",
    latestBlockUrl: "/blocks/tip/height",
    blockByHeightUrl: "/block-height/",
    blockByHashUrl: "/block/",
    parseLatest: (data) => (typeof data === "number" ? data : parseInt(data)),
    parseBlock: (data) => {
      return new Block({
        hash: data.id,
        height: data.height,
        time: data.timestamp,
        source: "bitcoin",
        confirms: data.confirmations || 0,
      });
    },
  },
  kaspa: {
    endpoint: "https://api.kaspa.org",
    latestBlockUrl: "/blocks/head",
    blockByHashUrl: "/blocks/",
    blueScoreUrl: "/info/virtual-chain-blue-score",
    blocksFromBlueScoreUrl: "/blocks-from-bluescore",
    parseLatest: (data) => data.blockHashes?.[0] || data.blockHash,
    parseBlock: (data) => {
      return new Block({
        hash: data.hash,
        blueScore: data.blueScore,
        timestamp: data.timestamp,
        parents: data.parents,
        source: "kaspa",
        confirms: data.confirmations || 0,
      });
    },
  },
};

// Storage keys for randomness bitstrings
export const STORAGE_KEY = "randomness_cumulative_bits";
export const NIST_STORAGE_KEY = "nist_cumulative_bits";

// Default number of blocks to fetch for randomness

// Tunable block counts (from config)
export const KASPA_BLOCK_COUNT = CONFIG.KASPA_BLOCK_COUNT;
export const BTC_BLOCK_COUNT = CONFIG.BTC_BLOCK_COUNT;

// Core project-wide constants
// These are enforced to ensure only finalized blocks are used
// Finality (from config)
export const FINALITY = {
  bitcoin: { confirmations: CONFIG.BTC_FINALITY_CONFIRMATIONS },
  kaspa: { dagDepth: CONFIG.KASPA_FINALITY_DAG_DEPTH },
};
