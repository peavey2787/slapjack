// index.js
// Main fetcher interface
import { getBitcoinBlocks, btcApiToBlock } from "./bitcoin.js";
import {
  getKaspaBlocks,
  subscribeToBlocks,
  unsubscribeFromBlocks,
  getBlockBuffer,
  clearBlockBuffer,
  hasEnoughBlocks
} from "./kaspa.js";
import { getQRNG } from "./qrng.js";

// Registry for extensible randomness sources
const RANDOMNESS_FETCHERS = {
  bitcoin: getBitcoinBlocks,
  kaspa: getKaspaBlocks,
  qrng: getQRNG,
};

export async function fetchBlocks(source, n) {
  if (source === "hybrid") {
    return {
      bitcoin: await getBitcoinBlocks(n),
      kaspa: await getKaspaBlocks(n),
    };
  }
  const fetcher = RANDOMNESS_FETCHERS[source];
  if (!fetcher) throw new Error(`Unknown source: ${source}`);
  return { [source]: await fetcher(n) };
}

export {
  getBitcoinBlocks,
  getKaspaBlocks,
  getQRNG,
  btcApiToBlock,
  subscribeToBlocks,
  unsubscribeFromBlocks,
  getBlockBuffer,
  clearBlockBuffer,
  hasEnoughBlocks,
};
