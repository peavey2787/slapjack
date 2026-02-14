// kaspa.js
// Kaspa block fetching logic - Uses live block subscription (no API during gameplay)

import { KASPA_BLOCK_COUNT } from "../constants.js";
import { Block } from "../models/Block.js";
import { logInfo } from "../logs/logger.js";
import { kaspaPortal } from "../../../kaspaPortal.js";
// Rolling buffer of recent blocks (newest first)
const BUFFER_SIZE = 20;
let _blockBuffer = [];
let _subscribed = false;
let _unsubscribe = null;

/**
 * Subscribe to live blocks from kaspaPortal
 * Call this once during initialization
 * @param {Object} kaspaPortal - The kaspaPortal singleton
 */
export async function subscribeToBlocks() {
  if (_subscribed) {
    logInfo("Already subscribed to Kaspa blocks");
    return;
  }

  _unsubscribe = await kaspaPortal?.onNewBlock((block) => {
    _addBlockToBuffer(block);
  });

  _subscribed = true;
  logInfo("Subscribed to Kaspa blocks for VRF entropy", {
    bufferSize: BUFFER_SIZE,
  });
}

/**
 * Unsubscribe from live blocks
 */
export function unsubscribeFromBlocks() {
  if (_unsubscribe && typeof _unsubscribe === "function") {
    _unsubscribe();
    _unsubscribe = null;
  }
  _subscribed = false;
  logInfo("Unsubscribed from Kaspa blocks");
}

/**
 * Add a block to the rolling buffer
 * @param {Object} cleanBlock - Already dehydrated block from scanner
 */
function _addBlockToBuffer(cleanBlock) {
  if (!cleanBlock || !cleanBlock.hash) return;

  // Check for duplicates (Simple check)
  if (_blockBuffer.length > 0 && _blockBuffer[0].hash === cleanBlock.hash) {
    return;
  }

  // Since cleanBlock is already a flat JS object,
  // we just wrap it in our Model for VRF helper methods.
  const vrfBlock = new Block(cleanBlock);

  // Set defaults for live buffer
  vrfBlock.isFinal = true;
  vrfBlock.confirms = 1;

  // Add to front, remove from back (O(1) operations)
  _blockBuffer.unshift(vrfBlock);
  if (_blockBuffer.length > BUFFER_SIZE) {
    _blockBuffer.pop();
  }

  // Optional: only update if you really need the 'confirms' property updated in real-time
  _updateConfirmations();
}

/**
 * Update confirmation counts based on buffer position
 */
function _updateConfirmations() {
  for (let i = 0; i < _blockBuffer.length; i++) {
    _blockBuffer[i].confirms = i + 1;
  }
}

/**
 * Get the current block buffer (for debugging)
 * @returns {Block[]}
 */
export function getBlockBuffer() {
  return [..._blockBuffer];
}

/**
 * Clear the block buffer (for testing)
 */
export function clearBlockBuffer() {
  _blockBuffer = [];
}

/**
 * Check if we have enough blocks in buffer
 * @param {number} n - Number of blocks needed
 * @returns {boolean}
 */
export function hasEnoughBlocks(n) {
  return _blockBuffer.length >= n;
}

/**
 * Fetch N recent Kaspa block hashes
 * Priority: 1) Rolling buffer (preferred - no API calls) 2) API fallback
 * @param {number} n - Number of blocks to fetch (defaults to KASPA_BLOCK_COUNT)
 * @returns {Promise<Object[]>} - Array of block info objects
 */
export async function getKaspaBlocks(n = KASPA_BLOCK_COUNT) {
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error("Kaspa block count must be a positive integer");
  }

  // 1. Try rolling buffer first (preferred always fresh)
  if (_blockBuffer.length >= n) {
    const blocks = _blockBuffer.slice(0, n);
    logInfo("Kaspa blocks from buffer", {
      count: blocks.length,
      tipBlueScore: blocks[0]?.blueScore,
      bufferSize: _blockBuffer.length,
    });
    return blocks;
  }

  // 2. If buffer insufficient but has some blocks, use what we have
  if (_blockBuffer.length > 0) {
    logInfo("Buffer has partial blocks, returning partial buffer", {
      have: _blockBuffer.length,
      need: n,
    });

    return _blockBuffer.slice(0, Math.min(n, _blockBuffer.length));
  }

  // 3. No buffer
  logInfo("No buffer available");
  throw new Error(
    "No Kaspa blocks, you likely forgot to connect to a Kaspa node first.",
  );
}
