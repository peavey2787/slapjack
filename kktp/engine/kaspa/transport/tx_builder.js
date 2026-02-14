import {
  createTransactions,
  Generator,
  PrivateKey,
  sompiToKaspaString,
  kaspaToSompi,
  UtxoEntries,
} from "../kas-wasm/kaspa.js";
import { payloadToHex } from "../utilities/utilities.js";
import { entryAmountSompi, calculateTotalBalance } from "./utxo_manager.js";
import { Logger, LogModule } from "../../../core/logger.js";

// ─────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────
const log = Logger.create(LogModule.transport.txBuilder);

// Minimum output amount (dust threshold) in sompi
const MIN_OUTPUT_SOMPI = 10000n; // 0.0001 KAS

// Estimated fee per input/output in sompi (conservative estimate)
const ESTIMATED_FEE_PER_INPUT = 3000n;
const ESTIMATED_FEE_PER_OUTPUT = 3000n;
const ESTIMATED_BASE_FEE = 5000n;

// ─────────────────────────────────────────────────────────────
// Fee Estimation
// ─────────────────────────────────────────────────────────────

/**
 * Estimate transaction fee based on inputs/outputs count.
 * This is a conservative estimate; actual fees depend on mass.
 * @param {number} inputCount - Number of inputs
 * @param {number} outputCount - Number of outputs
 * @param {number} [payloadBytes=0] - Payload size in bytes
 * @returns {bigint} Estimated fee in sompi
 */
export function estimateFee(inputCount, outputCount, payloadBytes = 0) {
  const inputFee = BigInt(inputCount) * ESTIMATED_FEE_PER_INPUT;
  const outputFee = BigInt(outputCount) * ESTIMATED_FEE_PER_OUTPUT;
  const payloadFee = BigInt(payloadBytes) * 10n; // ~10 sompi per byte
  return ESTIMATED_BASE_FEE + inputFee + outputFee + payloadFee;
}

/**
 * Estimate mass/fees for a prospective transaction using the WASM Generator.
 * Generic + reusable: caller provides UTXO entries + outputs + changeAddress.
 */
export async function estimateTransaction({
  entries,
  outputs,
  priorityFee = 0n,
  changeAddress,
  networkId,
  payload, // string (utf8 or hex)
} = {}) {
  if (!Array.isArray(entries) || entries.length === 0)
    throw new Error("estimateTransaction: entries required.");
  if (!Array.isArray(outputs) || outputs.length === 0)
    throw new Error("estimateTransaction: outputs required.");
  if (!changeAddress)
    throw new Error("estimateTransaction: changeAddress required.");
  if (!networkId) throw new Error("estimateTransaction: networkId required.");

  const payloadHex = payloadToHex(payload);

  // Convert entries to WASM if needed (same logic as buildPendingTransaction)
  let wasmEntries = entries;
  if (entries.length > 0) {
    const e = entries[0];
    const isWasmObject = e.__wbg_ptr !== undefined;
    if (!isWasmObject) {
      // Plain JS objects from RPC - wrap in UtxoEntries to convert to WASM
      const utxoEntriesWrapper = new UtxoEntries(entries);
      wasmEntries = utxoEntriesWrapper.items;
    }
  }

  const settings = {
    // SDK examples commonly use utxoEntries; some wrappers also pass entries.
    utxoEntries: wasmEntries,
    entries: wasmEntries,
    outputs,
    changeAddress: String(changeAddress),
    priorityFee,
    payload: payloadHex,
    networkId,
  };

  let generator;
  try {
    generator = new Generator(settings);
    const summary = await generator.estimate();

    const fees = summary?.fees ?? 0n;
    const mass = summary?.mass ?? 0n;
    const finalAmount = summary?.finalAmount;
    const txCount = summary?.transactions ?? 0;
    const utxoCount = summary?.utxos ?? 0;
    const finalTransactionId = summary?.finalTransactionId;

    // free WASM summary if available
    try {
      summary?.free?.();
    } catch {
      /* ignore */
    }

    const baseFee = fees - (priorityFee ?? 0n);

    return {
      mass,
      fees,
      feesKas: sompiToKaspaString(fees),
      priorityFee,
      baseFee,
      baseFeeKas: sompiToKaspaString(baseFee),
      finalAmount,
      finalAmountKas:
        finalAmount != null ? sompiToKaspaString(finalAmount) : null,
      transactions: txCount,
      utxos: utxoCount,
      finalTransactionId: finalTransactionId ?? null,
      payloadBytes: payloadHex ? Math.floor(payloadHex.length / 2) : 0,
    };
  } finally {
    try {
      generator?.free?.();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Attempt to sign a PendingTransaction with keys.
 * Some builds accept WASM PrivateKey objects, others accept strings.
 */
export async function signPendingTransaction(pendingTx, privateKeys) {
  if (!pendingTx?.sign)
    throw new Error("PendingTransaction.sign is not available.");

  const keys = Array.isArray(privateKeys) ? privateKeys : [];
  if (keys.length === 0)
    throw new Error("No private keys provided for signing.");

  // Prefer WASM PrivateKey objects
  try {
    const wasmKeys = keys.map((k) =>
      k instanceof PrivateKey ? k : new PrivateKey(String(k)),
    );
    await pendingTx.sign(wasmKeys);
    return;
  } catch {
    // Fallback: try hex strings
    await pendingTx.sign(keys.map((k) => String(k)));
  }
}

/**
 * Build transactions via WASM createTransactions.
 * Returns the first PendingTransaction (common case).
 */
export async function buildPendingTransaction({
  entries,
  outputs,
  priorityFee = 0n,
  changeAddress,
  networkId,
  payload, // string (utf8 or hex)
} = {}) {
  if (!Array.isArray(entries) || entries.length === 0)
    throw new Error("buildPendingTransaction: entries required.");
  if (!Array.isArray(outputs) || outputs.length === 0)
    throw new Error("buildPendingTransaction: outputs required.");
  if (!changeAddress)
    throw new Error("buildPendingTransaction: changeAddress required.");
  if (!networkId)
    throw new Error("buildPendingTransaction: networkId required.");

  const payloadHex = payloadToHex(payload);

  // Log entry info for debugging
  log.log("[buildPendingTransaction] Calling SDK createTransactions with:", {
    entriesCount: entries.length,
    outputsCount: outputs.length,
    changeAddress: String(changeAddress),
    networkId,
    priorityFee,
    payloadHex: payloadHex?.slice(0, 40),
  });

  // Check if entries need conversion to WASM UtxoEntries
  // RPC returns plain JS objects or UtxoEntryReference objects that need proper handling
  let wasmEntries;
  if (entries.length > 0) {
    const e = entries[0];
    const isWasmObject = e.__wbg_ptr !== undefined;
    const hasEntryGetter = typeof e.entry === 'object' || typeof Object.getOwnPropertyDescriptor(Object.getPrototypeOf(e) || {}, 'entry')?.get === 'function';

    // Detailed debug: extract actual values from the entry
    let entryAmount, entryOutpoint, entryAddress;
    try {
      entryAmount = e.amount;
    } catch { entryAmount = "error"; }
    try {
      const op = e.outpoint;
      entryOutpoint = op ? { txId: op.transactionId?.slice(0, 16), idx: op.index } : "null";
    } catch { entryOutpoint = "error"; }
    try {
      entryAddress = e.address?.toString?.() || String(e.address);
    } catch { entryAddress = "error"; }

    log.log("[buildPendingTransaction] Entry analysis:", {
      isWasmObject,
      hasEntryGetter,
      hasOutpoint: typeof e.outpoint !== 'undefined',
      protoName: e?.constructor?.name,
      amount: entryAmount,
      outpoint: entryOutpoint,
      address: entryAddress?.slice(0, 30),
    });

    // If entries are UtxoEntryReference WASM objects, the SDK should handle them directly
    // If they're plain JS objects, wrap them in UtxoEntries
    if (isWasmObject) {
      // Already WASM objects - pass directly
      wasmEntries = entries;
    } else {
      // Plain JS objects from RPC - wrap in UtxoEntries to convert to WASM
      log.log("[buildPendingTransaction] Converting plain JS entries to WASM UtxoEntries");
      wasmEntries = new UtxoEntries(entries);
      // Get the items array from UtxoEntries
      wasmEntries = wasmEntries.items;
    }
  } else {
    wasmEntries = entries;
  }

  // Log outputs for debugging
  log.log("[buildPendingTransaction] Outputs:", outputs.map(o => ({
    address: String(o.address)?.slice(0, 30),
    amount: o.amount,
    amountType: typeof o.amount,
  })));

  let result;
  try {
    result = await createTransactions({
      // SDK expects 'entries' for Generator settings
      entries: wasmEntries,
      outputs,
      priorityFee,
      changeAddress: String(changeAddress),
      networkId,
      payload: payloadHex,
    });
  } catch (err) {
    log.error("[buildPendingTransaction] SDK createTransactions error:", err.message || err);
    throw err;
  }

  const { transactions } = result;

  if (!transactions || transactions.length === 0) {
    throw new Error("Failed to create transactions (empty result).");
  }

  return transactions[0];
}

/**
 * Sign + submit a pending transaction.
 * Returns a normalized result with txid if available.
 */
export async function submitPendingTransaction({
  pendingTx,
  privateKeys,
  client,
} = {}) {
  if (!pendingTx)
    throw new Error("submitPendingTransaction: pendingTx required.");
  if (!client) throw new Error("submitPendingTransaction: client required.");

  if (privateKeys && privateKeys.length > 0) {
    await signPendingTransaction(pendingTx, privateKeys);
  }

  if (typeof pendingTx.submit !== "function") {
    throw new Error(
      "PendingTransaction.submit is not available in this WASM build.",
    );
  }

  const submitRes = await pendingTx.submit(client);
  const txid =
    pendingTx.id ?? submitRes?.transactionId ?? submitRes?.txid ?? null;

  return { txid, submitRes, pendingTx };
}

/**
 * One-shot convenience: build + sign + submit.
 */
export async function buildSignSubmitTransaction({
  entries,
  outputs,
  priorityFee = 0n,
  changeAddress,
  networkId,
  payload,
  privateKeys,
  client,
} = {}) {
  const pendingTx = await buildPendingTransaction({
    entries,
    outputs,
    priorityFee,
    changeAddress,
    networkId,
    payload,
  });

  return await submitPendingTransaction({ pendingTx, privateKeys, client });
}

// ─────────────────────────────────────────────────────────────
// Manual Transaction Building (with explicit change handling)
// ─────────────────────────────────────────────────────────────

/**
 * Build a transaction with explicit outputs including change.
 *
 * CRITICAL: This function properly handles change outputs to prevent
 * losing funds to miners. If you have a 10 KAS UTXO and send 1 KAS,
 * the remaining ~9 KAS (minus fees) is sent back to your change address.
 *
 * @param {Object} options
 * @param {Array} options.entries - UTXO entries to spend
 * @param {Array} options.outputs - Output specifications [{ address, amount }]
 * @param {string} options.changeAddress - Address for change output
 * @param {string} options.networkId - Network ID
 * @param {string} [options.payload] - Optional payload string
 * @param {bigint} [options.priorityFee=0n] - Priority fee in sompi
 * @param {boolean} [options.autoChange=true] - Automatically add change output
 * @returns {Promise<Object>} Transaction details
 */
export async function buildManualTransaction({
  entries,
  outputs,
  changeAddress,
  networkId,
  payload,
  priorityFee = 0n,
  autoChange = true,
} = {}) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error("buildManualTransaction: entries required.");
  }
  if (!Array.isArray(outputs) || outputs.length === 0) {
    throw new Error("buildManualTransaction: outputs required.");
  }
  if (!changeAddress) {
    throw new Error("buildManualTransaction: changeAddress required.");
  }
  if (!networkId) {
    throw new Error("buildManualTransaction: networkId required.");
  }

  // Calculate total input value
  const totalInput = calculateTotalBalance(entries);

  log.log(`[buildManualTransaction] entries=${entries.length}, totalInput=${totalInput}`);

  // Calculate total output value
  let totalOutput = 0n;
  for (const out of outputs) {
    const amt = typeof out.amount === "bigint"
      ? out.amount
      : kaspaToSompi(String(out.amount));
    totalOutput += amt;
  }

  // Estimate fee
  const payloadBytes = payload ? new TextEncoder().encode(payload).length : 0;
  const outputCount = autoChange ? outputs.length + 1 : outputs.length;
  const estimatedFee = estimateFee(entries.length, outputCount, payloadBytes) + priorityFee;

  // Calculate change
  const change = totalInput - totalOutput - estimatedFee;

  log.log(`[buildManualTransaction] totalOutput=${totalOutput}, estimatedFee=${estimatedFee}, change=${change}`);

  if (change < 0n) {
    throw new Error(
      `Insufficient funds: input=${totalInput}, output=${totalOutput}, fee=${estimatedFee}, shortfall=${-change}`
    );
  }

  // Build final outputs array (just the actual outputs, NOT change)
  // The SDK's createTransactions will compute and add change automatically
  const finalOutputs = outputs.map((out) => ({
    address: String(out.address),
    amount: typeof out.amount === "bigint"
      ? out.amount
      : kaspaToSompi(String(out.amount)),
  }));

  // Note: We do NOT add change output here - createTransactions handles it via changeAddress
  // The change calculation above is just for validation and return value

  // Build the transaction using the SDK
  const pendingTx = await buildPendingTransaction({
    entries,
    outputs: finalOutputs,
    changeAddress,
    networkId,
    payload,
    priorityFee,
  });

  return {
    pendingTx,
    totalInput,
    totalOutput,
    estimatedFee,
    change: autoChange ? change : 0n,
    outputs: finalOutputs,
    inputCount: entries.length,
    outputCount: finalOutputs.length,
  };
}

/**
 * Build a UTXO split transaction.
 * Takes all available UTXOs and splits them into N equal outputs.
 * This is essential for rapid-fire transactions to avoid UTXO contention.
 *
 * @param {Object} options
 * @param {Array} options.entries - UTXO entries to consolidate and split
 * @param {string} options.address - Address for all outputs (usually your own)
 * @param {number} options.splitCount - Number of outputs to create (2-100)
 * @param {string} options.networkId - Network ID
 * @param {bigint} [options.priorityFee=0n] - Priority fee in sompi
 * @returns {Promise<Object>} Split transaction details
 */
export async function buildSplitUtxoTransaction({
  entries,
  address,
  splitCount,
  networkId,
  priorityFee = 0n,
} = {}) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error("buildSplitUtxoTransaction: entries required.");
  }
  if (!address) {
    throw new Error("buildSplitUtxoTransaction: address required.");
  }
  if (!splitCount || splitCount < 2 || splitCount > 100) {
    throw new Error("buildSplitUtxoTransaction: splitCount must be 2-100.");
  }
  if (!networkId) {
    throw new Error("buildSplitUtxoTransaction: networkId required.");
  }

  // Calculate total input value
  const totalInput = calculateTotalBalance(entries);

  // Estimate fee for this transaction
  const estimatedFee = estimateFee(entries.length, splitCount, 0) + priorityFee;

  // Calculate available balance after fees
  const availableBalance = totalInput - estimatedFee;

  if (availableBalance < MIN_OUTPUT_SOMPI * BigInt(splitCount)) {
    throw new Error(
      `Insufficient funds to split into ${splitCount} outputs. ` +
      `Available: ${availableBalance}, minimum needed: ${MIN_OUTPUT_SOMPI * BigInt(splitCount)}`
    );
  }

  // Calculate equal split amount
  const splitAmount = availableBalance / BigInt(splitCount);

  // Handle remainder (add to first output to ensure all funds are used)
  const remainder = availableBalance % BigInt(splitCount);

  // Build outputs - all going to the same address
  const outputs = [];
  for (let i = 0; i < splitCount; i++) {
    outputs.push({
      address: String(address),
      amount: i === 0 ? splitAmount + remainder : splitAmount,
    });
  }

  // Build the transaction (no additional change needed - we're using all funds)
  const pendingTx = await buildPendingTransaction({
    entries,
    outputs,
    changeAddress: address, // Required but won't create extra output
    networkId,
    priorityFee,
  });

  return {
    pendingTx,
    totalInput,
    estimatedFee,
    splitAmount,
    remainder,
    outputs,
    inputCount: entries.length,
    outputCount: splitCount,
  };
}
