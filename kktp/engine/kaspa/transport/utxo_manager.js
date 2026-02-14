import { kaspaToSompi } from "../kas-wasm/kaspa.js";

// ─────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────

const SOMPI_PER_KAS = 100000000n;
const DUST_THRESHOLD = 100000n; // 0.001 KAS
const SMALL_THRESHOLD = 100000000n; // 1 KAS
const MEDIUM_THRESHOLD = 10000000000n; // 100 KAS

// ─────────────────────────────────────────────────────────────
// Normalization Helpers
// ─────────────────────────────────────────────────────────────

/**
 * Normalize UTXO result to a flat array of entries.
 * Wallet RPC commonly returns either:
 *  - Array<entry>
 *  - { entries: Array<entry> }
 */
export function normalizeUtxoEntries(utxoResult) {
  if (Array.isArray(utxoResult)) return utxoResult;
  if (Array.isArray(utxoResult?.entries)) return utxoResult.entries;
  if (Array.isArray(utxoResult?.utxoEntries)) return utxoResult.utxoEntries;
  return [];
}

/**
 * Extract amount in sompi from various UTXO entry formats.
 * Handles nested 'entry' wrapper from RPC responses AND WASM UtxoEntryReference objects.
 *
 * WASM objects use getter-based property access which may throw if accessed incorrectly.
 * This function uses try/catch to safely extract amounts from all known formats.
 *
 * @param {Object} entry - UTXO entry object (RPC response or WASM UtxoEntryReference)
 * @returns {bigint} Amount in sompi
 */
export function entryAmountSompi(entry) {
  if (!entry) return 0n;

  // Try direct access patterns with try/catch for WASM getter safety
  const tryGetAmount = (obj) => {
    if (!obj) return null;
    try {
      // Direct amount property (most common)
      if (typeof obj.amount === "bigint") return obj.amount;
      if (typeof obj.amount === "number") return BigInt(Math.trunc(obj.amount));
      if (typeof obj.amount === "string" && obj.amount.trim() !== "") return BigInt(obj.amount);
    } catch { /* WASM getter may throw */ }
    return null;
  };

  // 1. Try the entry directly (e.g., { amount: 100n })
  let result = tryGetAmount(entry);
  if (result !== null) return result;

  // 2. Handle nested 'entry' wrapper from RPC (e.g., { entry: { amount: 100n } })
  try {
    if (entry.entry) {
      result = tryGetAmount(entry.entry);
      if (result !== null) return result;
    }
  } catch { /* WASM getter may throw */ }

  // 3. Handle WASM UtxoEntryReference with .utxoEntry.amount
  try {
    if (entry.utxoEntry) {
      result = tryGetAmount(entry.utxoEntry);
      if (result !== null) return result;
    }
  } catch { /* WASM getter may throw */ }

  // 4. Handle nested entry.utxoEntry (from RPC wrapper)
  try {
    if (entry.entry?.utxoEntry) {
      result = tryGetAmount(entry.entry.utxoEntry);
      if (result !== null) return result;
    }
  } catch { /* WASM getter may throw */ }

  // 5. Handle .utxo.amount pattern
  try {
    if (entry.utxo) {
      result = tryGetAmount(entry.utxo);
      if (result !== null) return result;
    }
  } catch { /* WASM getter may throw */ }

  // 6. Handle .output.amount pattern
  try {
    if (entry.output) {
      result = tryGetAmount(entry.output);
      if (result !== null) return result;
    }
  } catch { /* WASM getter may throw */ }

  return 0n;
}

/**
 * Get the outpoint (txid + index) from a UTXO entry.
 * Handles various WASM/RPC formats including nested 'entry' wrapper.
 * @param {Object} entry - UTXO entry object
 * @returns {{ transactionId: string, index: number }|null}
 */
export function getEntryOutpoint(entry) {
  // Handle nested 'entry' wrapper from RPC (e.g., { entry: { outpoint, ... } })
  const inner = entry?.entry ?? entry;

  // Various WASM/RPC formats
  const outpoint =
    inner?.outpoint ||
    inner?.utxoEntry?.outpoint ||
    inner?.utxo?.outpoint ||
    null;

  if (outpoint) {
    return {
      transactionId: outpoint.transactionId || outpoint.txid || outpoint.txId,
      index: outpoint.index ?? outpoint.outputIndex ?? 0,
    };
  }

  // Flat format
  if (inner?.transactionId || inner?.txid) {
    return {
      transactionId: inner.transactionId || inner.txid || inner.txId,
      index: inner.index ?? inner.outputIndex ?? 0,
    };
  }

  return null;
}

/**
 * Create a unique key for a UTXO entry (for deduplication and tracking).
 * @param {Object} entry - UTXO entry object
 * @returns {string}
 */
export function getEntryKey(entry) {
  const outpoint = getEntryOutpoint(entry);
  if (!outpoint) return `unknown_${Math.random().toString(36).slice(2)}`;
  return `${outpoint.transactionId}:${outpoint.index}`;
}

// ─────────────────────────────────────────────────────────────
// UTXO Fetching
// ─────────────────────────────────────────────────────────────

/**
 * Fetch UTXOs for an account's receive+change addresses using wallet.rpc.getUtxosByAddresses(addresses).
 * @returns {Promise<{ receiveAddress: string, changeAddress: string, entries: Array }>}
 */
export async function getAccountUtxos({
  wallet,
  accountDescriptor,
  logger,
} = {}) {
  if (!wallet) throw new Error("getAccountUtxos: wallet is required.");
  if (!accountDescriptor)
    throw new Error("getAccountUtxos: accountDescriptor is required.");
  if (!wallet.rpc?.getUtxosByAddresses)
    throw new Error(
      "getAccountUtxos: wallet.rpc.getUtxosByAddresses not available.",
    );

  const log = typeof logger === "function" ? logger : () => {};

  const receiveAddress = String(accountDescriptor.receiveAddress || "");
  const changeAddress = String(accountDescriptor.changeAddress || "");

  const addresses = [receiveAddress, changeAddress].filter(Boolean);
  if (addresses.length === 0)
    throw new Error("No receive/change address available for this account.");

  log(`Fetching UTXOs for: ${addresses.join(", ")}`);
  const utxoResult = await wallet.rpc.getUtxosByAddresses(addresses);
  const entries = normalizeUtxoEntries(utxoResult);

  return { receiveAddress, changeAddress, entries };
}

/**
 * Fetch UTXOs directly via RPC client for a single address.
 * @param {Object} client - Kaspa RPC client
 * @param {string} address - Address to fetch UTXOs for
 * @returns {Promise<Array>} Array of UTXO entries
 */
export async function getUtxosByAddress(client, address) {
  if (!client?.getUtxosByAddresses) {
    throw new Error("getUtxosByAddress: client.getUtxosByAddresses not available.");
  }
  if (!address) {
    throw new Error("getUtxosByAddress: address is required.");
  }

  const result = await client.getUtxosByAddresses([address]);
  return normalizeUtxoEntries(result);
}

/**
 * Fetch UTXOs directly via RPC client for multiple addresses.
 * Deduplicates entries by outpoint to avoid double-counting.
 * @param {Object} client - Kaspa RPC client
 * @param {string[]} addresses - Addresses to fetch UTXOs for
 * @returns {Promise<Array>} Array of UTXO entries (deduplicated)
 */
export async function getUtxosByAddresses(client, addresses) {
  if (!client?.getUtxosByAddresses) {
    throw new Error("getUtxosByAddresses: client.getUtxosByAddresses not available.");
  }
  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw new Error("getUtxosByAddresses: addresses array is required.");
  }

  // Filter out empty/null addresses and convert to strings
  const validAddresses = addresses
    .filter(a => a != null && a !== '')
    .map(a => String(a));

  if (validAddresses.length === 0) {
    return [];
  }

  const result = await client.getUtxosByAddresses(validAddresses);
  const entries = normalizeUtxoEntries(result);

  // Deduplicate by outpoint key (same UTXO shouldn't appear twice)
  const seen = new Set();
  const deduplicated = [];
  for (const entry of entries) {
    const key = getEntryKey(entry);
    if (!seen.has(key)) {
      seen.add(key);
      deduplicated.push(entry);
    }
  }

  return deduplicated;
}

// ─────────────────────────────────────────────────────────────
// UTXO Selection Strategies
// ─────────────────────────────────────────────────────────────

/**
 * Largest-first selection: minimizes number of inputs (usually best for mass).
 * Note: This does NOT account for fees; use Generator/estimate or try-build loop.
 * @param {Array} entries - Array of UTXO entries
 * @param {Object} options - Selection options
 * @param {bigint} [options.targetSompi=0n] - Target amount to select
 * @param {number} [options.maxInputs=50] - Maximum number of inputs
 * @returns {{ selected: Array, total: bigint }}
 */
export function selectUtxosLargestFirst(
  entries,
  { targetSompi = 0n, maxInputs = 50 } = {},
) {
  const sorted = [...(entries || [])].sort((a, b) => {
    const aa = entryAmountSompi(a);
    const bb = entryAmountSompi(b);
    return aa === bb ? 0 : aa > bb ? -1 : 1;
  });

  const selected = [];
  let total = 0n;

  for (const e of sorted) {
    if (selected.length >= maxInputs) break;
    const amt = entryAmountSompi(e);
    if (amt <= 0n) continue;
    selected.push(e);
    total += amt;
    if (total >= targetSompi) break;
  }

  return { selected, total };
}

/**
 * Round-robin UTXO selection for parallel transaction engines.
 * Assigns UTXOs to engines to avoid UTXO contention during rapid-fire sends.
 *
 * @param {Array} entries - Array of UTXO entries
 * @param {number} engineIndex - The engine index (0-based)
 * @param {number} totalEngines - Total number of engines
 * @param {bigint} [minAmount=0n] - Minimum UTXO amount to consider
 * @returns {{ entry: Object|null, amount: bigint }}
 */
export function selectUtxoForEngine(
  entries,
  engineIndex,
  totalEngines,
  minAmount = 0n,
) {
  // Filter to usable UTXOs and sort by amount (largest first)
  const usable = (entries || [])
    .map((e, idx) => ({ entry: e, amount: entryAmountSompi(e), originalIndex: idx }))
    .filter((x) => x.amount >= minAmount)
    .sort((a, b) => (a.amount > b.amount ? -1 : a.amount < b.amount ? 1 : 0));

  if (usable.length === 0) {
    return { entry: null, amount: 0n };
  }

  // Assign UTXOs to engines in round-robin fashion
  // Engine 0 gets indices 0, totalEngines, 2*totalEngines, ...
  // Engine 1 gets indices 1, totalEngines+1, 2*totalEngines+1, ...
  const myUtxos = usable.filter((_, idx) => idx % totalEngines === engineIndex);

  if (myUtxos.length === 0) {
    return { entry: null, amount: 0n };
  }

  // Return the largest UTXO assigned to this engine
  return { entry: myUtxos[0].entry, amount: myUtxos[0].amount };
}

// ─────────────────────────────────────────────────────────────
// Balance & Analysis
// ─────────────────────────────────────────────────────────────

/**
 * Calculate total balance from UTXO entries.
 * @param {Array} entries - Array of UTXO entries
 * @returns {bigint} Total balance in sompi
 */
export function calculateTotalBalance(entries) {
  let total = 0n;
  for (const e of entries || []) {
    total += entryAmountSompi(e);
  }
  return total;
}

/**
 * Group UTXOs by size category for analysis.
 * @param {Array} entries - Array of UTXO entries
 * @returns {{ dust: Array, small: Array, medium: Array, large: Array }}
 */
export function categorizeUtxos(entries) {
  const dust = [];
  const small = [];
  const medium = [];
  const large = [];

  for (const e of entries || []) {
    const amt = entryAmountSompi(e);
    if (amt < DUST_THRESHOLD) {
      dust.push(e);
    } else if (amt < SMALL_THRESHOLD) {
      small.push(e);
    } else if (amt < MEDIUM_THRESHOLD) {
      medium.push(e);
    } else {
      large.push(e);
    }
  }

  return { dust, small, medium, large };
}

// ─────────────────────────────────────────────────────────────
// Conversion Helpers
// ─────────────────────────────────────────────────────────────

/**
 * Convenience helper for parsing KAS string to sompi bigint.
 * @param {string|number} amountKas - Amount in KAS
 * @returns {bigint} Amount in sompi
 */
export function kasToSompi(amountKas) {
  return kaspaToSompi(String(amountKas));
}

/**
 * Convert sompi to KAS string with proper decimal handling.
 * @param {bigint} sompi - Amount in sompi
 * @param {number} [decimals=8] - Number of decimal places to show
 * @returns {string} Amount in KAS
 */
export function sompiToKas(sompi, decimals = 8) {
  if (typeof sompi !== "bigint") {
    sompi = BigInt(sompi || 0);
  }

  const whole = sompi / SOMPI_PER_KAS;
  const frac = sompi % SOMPI_PER_KAS;

  if (frac === 0n) {
    return whole.toString();
  }

  const fracStr = frac.toString().padStart(8, "0").slice(0, decimals);
  return `${whole}.${fracStr}`.replace(/\.?0+$/, "");
}
