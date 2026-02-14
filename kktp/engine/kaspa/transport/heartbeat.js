/**
 * Heartbeat: Automatic UTXO monitoring and replenishment.
 *
 * CRITICAL: Monitors USABLE UTXOs (large enough for sends), not just total count.
 * This prevents the "2000 small UTXOs, no large ones" problem where the wallet
 * has plenty of total UTXOs but none are large enough for actual transactions.
 *
 * Two-priority system:
 * 1. CONSOLIDATE if too many small UTXOs (prevents fragmentation)
 * 2. SPLIT if not enough usable UTXOs (ensures parallel engine availability)
 *
 * MULTI-ADDRESS SUPPORT:
 * Monitors both receive and change addresses since funds often end up in change
 * outputs after transactions. Pass `addresses` array or `address` + `changeAddress`.
 */

import * as utxoManager from "./utxo_manager.js";
import { Logger, LogModule } from "../../../core/logger.js";

const log = Logger.create(LogModule.transport.heartbeat);

// Default minimum UTXO size to be considered "usable" for rapid sends
// Must be larger than send amount + fees (0.5 KAS send + ~0.01 fees = ~0.6 KAS minimum)
const DEFAULT_USABLE_THRESHOLD = 100000000n; // 1 KAS

/**
 * HeartbeatMonitor class for UTXO health monitoring.
 * Designed as a standalone module to keep TransportFacade thin.
 */
export class HeartbeatMonitor {
  /**
   * @param {Object} facade - TransportFacade instance for UTXO operations
   */
  constructor(facade) {
    this._facade = facade;
    this._timer = null;
    this._config = null;
    this._checkInProgress = false;
  }

  /**
   * Start the heartbeat monitor.
   *
   * @param {Object} options
   * @param {string} [options.address] - Primary address to monitor (receive address)
   * @param {string} [options.changeAddress] - Change address to also monitor
   * @param {string[]} [options.addresses] - Alternative: array of all addresses to monitor
   * @param {Array} options.privateKeys - Private keys for splitting/consolidating
   * @param {number} [options.intervalMs=15000] - Check interval (default 15s for fast response)
   * @param {number} [options.targetUtxoCount=10] - Minimum USABLE UTXO count threshold
   * @param {number} [options.splitCount=15] - Number of UTXOs to create when splitting
   * @param {bigint} [options.priorityFee=0n] - Priority fee for transactions
   * @param {bigint} [options.usableThreshold=1 KAS] - Minimum amount for a UTXO to be "usable"
   * @param {boolean} [options.autoConsolidate=true] - Auto-consolidate when too many small UTXOs
   * @param {number} [options.maxSmallUtxos=50] - Trigger consolidation when small count exceeds this
   * @param {function} [options.onCheck] - Callback on each check
   * @param {function} [options.onSplit] - Callback when split is triggered
   * @param {function} [options.onConsolidate] - Callback when consolidation is triggered
   * @param {function} [options.onError] - Callback on error
   */
  start({
    address,
    changeAddress,
    addresses,
    privateKeys,
    intervalMs = 15000,
    targetUtxoCount = 10,
    splitCount = 15,
    priorityFee = 0n,
    usableThreshold = DEFAULT_USABLE_THRESHOLD,
    autoConsolidate = true,
    maxSmallUtxos = 50,
    onCheck,
    onSplit,
    onConsolidate,
    onError,
  } = {}) {
    // Build addresses array from various input options
    let allAddresses = [];
    if (Array.isArray(addresses) && addresses.length > 0) {
      allAddresses = addresses
        .filter(a => a != null && a !== '')
        .map(a => String(a));
    } else {
      if (address) allAddresses.push(String(address));
      if (changeAddress && String(changeAddress) !== String(address)) {
        allAddresses.push(String(changeAddress));
      }
    }

    if (allAddresses.length === 0) {
      throw new Error("HeartbeatMonitor: at least one address required.");
    }
    if (!privateKeys?.length) {
      throw new Error("HeartbeatMonitor: privateKeys required.");
    }

    // Stop any existing heartbeat first
    this.stop();

    this._config = {
      addresses: allAddresses,
      address: allAddresses[0], // Primary address for operations
      privateKeys,
      intervalMs,
      targetUtxoCount,
      splitCount,
      priorityFee,
      usableThreshold,
      autoConsolidate,
      maxSmallUtxos,
      onCheck,
      onSplit,
      onConsolidate,
      onError,
    };

    const usableKas = utxoManager.sompiToKas(usableThreshold);
    const addrDisplay = allAddresses.length > 1
      ? `${allAddresses.length} addresses (${allAddresses[0].slice(0, 16)}... + ${allAddresses.length - 1} more)`
      : allAddresses[0].slice(0, 24) + '...';

    log.log(
      `[Heartbeat] Starting: check every ${intervalMs / 1000}s, ` +
      `monitoring ${addrDisplay}, ` +
      `threshold=${targetUtxoCount} USABLE UTXOs (>= ${usableKas} KAS), ` +
      `split into ${splitCount}, autoConsolidate=${autoConsolidate} (max ${maxSmallUtxos} small)`
    );

    // Run first check immediately, then set interval
    this._runCheck();
    this._timer = setInterval(() => this._runCheck(), intervalMs);
  }

  /**
   * Stop the heartbeat monitor.
   */
  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
      log.log("[Heartbeat] Stopped.");
    }
    this._config = null;
  }

  /**
   * Check if heartbeat is currently running.
   * @returns {boolean}
   */
  get isRunning() {
    return this._timer !== null;
  }

  /**
   * Get current heartbeat configuration (safe copy).
   * @returns {Object|null}
   */
  get config() {
    if (!this._config) return null;
    // Return copy without privateKeys for security
    const { privateKeys, ...safeConfig } = this._config;
    return { ...safeConfig, hasPrivateKeys: !!privateKeys?.length };
  }

  /**
   * Manually trigger a heartbeat check.
   * @returns {Promise<void>}
   */
  async trigger() {
    if (!this._config) {
      throw new Error("Heartbeat not configured. Call start() first.");
    }
    await this._runCheck();
  }

  /**
   * Internal: Run a single heartbeat check.
   * @private
   */
  async _runCheck() {
    // Guard: prevent concurrent checks
    if (!this._config || this._checkInProgress) return;

    // Guard: ensure connected
    if (!this._facade.isConnected) {
      log.warn("[Heartbeat] Skipping check - not connected.");
      return;
    }

    const {
      addresses,
      address, // Primary address for operations
      privateKeys,
      targetUtxoCount,
      splitCount,
      priorityFee,
      usableThreshold,
      autoConsolidate,
      maxSmallUtxos,
      onCheck,
      onSplit,
      onConsolidate,
      onError,
    } = this._config;

    this._checkInProgress = true;

    try {
      // Fetch fresh UTXO data for ALL addresses (exclude spent from cache)
      let entries;
      if (addresses.length > 1) {
        entries = await this._facade.getUtxosForAddresses(addresses, {
          useCache: false,
          excludeSpent: true,
        });
      } else {
        entries = await this._facade.getUtxos(addresses[0], {
          useCache: false,
          excludeSpent: true,
        });
      }

      const totalCount = entries.length;
      const totalBalance = this._facade.calculateTotalBalance(entries);

      // Categorize UTXOs by usability
      let usableCount = 0;
      let usableBalance = 0n;
      let smallCount = 0;
      let smallBalance = 0n;

      for (const entry of entries) {
        const amt = utxoManager.entryAmountSompi(entry);
        if (amt >= usableThreshold) {
          usableCount++;
          usableBalance += amt;
        } else {
          smallCount++;
          smallBalance += amt;
        }
      }

      const addrInfo = addresses.length > 1 ? ` (across ${addresses.length} addresses)` : '';
      log.log(
        `[Heartbeat] Check: ${usableCount} usable (>= ${utxoManager.sompiToKas(usableThreshold)} KAS), ` +
        `${smallCount} small, total: ${utxoManager.sompiToKas(totalBalance)} KAS${addrInfo}`
      );

      // Invoke onCheck callback with detailed info
      if (typeof onCheck === "function") {
        try {
          onCheck({
            totalCount,
            usableCount,
            smallCount,
            targetUtxoCount,
            totalBalance,
            usableBalance,
            smallBalance,
            entries,
            addresses,
          });
        } catch (cbErr) {
          log.warn("[Heartbeat] onCheck callback error:", cbErr);
        }
      }

      // ─────────────────────────────────────────────────────────────
      // PRIORITY 1: Emergency - NO usable UTXOs
      // This is critical - wallet is effectively unusable for sends
      // ─────────────────────────────────────────────────────────────
      if (usableCount === 0 && totalCount > 0) {
        log.warn(
          `[Heartbeat] 🚨 CRITICAL: No usable UTXOs! Have ${totalCount} small UTXOs ` +
          `(${utxoManager.sompiToKas(totalBalance)} KAS). Checking options...`
        );

        // Can we consolidate? Need at least 2 UTXOs to merge
        if (totalCount >= 2 && autoConsolidate) {
          log.log(`[Heartbeat] 🔧 Attempting emergency consolidation: ${totalCount} UTXOs → 1`);
          await this._doConsolidate({
            address,
            addresses, // Multi-address support
            privateKeys,
            targetCount: 1, // Merge ALL into 1 to maximize the single output
            priorityFee,
            onConsolidate,
            onError,
            emergency: true,
          });
        } else if (totalCount === 1) {
          // Only 1 UTXO and it's too small - nothing we can do
          log.warn(
            `[Heartbeat] ⚠️ Only 1 small UTXO (${utxoManager.sompiToKas(totalBalance)} KAS). ` +
            `Cannot consolidate or split. Need more funds or wait for confirmations.`
          );
          // Notify via error callback so UI can show status
          this._invokeErrorCallback(onError, "insufficient_utxos", new Error(
            `Only 1 small UTXO (${utxoManager.sompiToKas(totalBalance)} KAS). Need more funds.`
          ), true);
        }

        // Exit early - don't also try to split in same cycle
        this._checkInProgress = false;
        return;
      }

      // ─────────────────────────────────────────────────────────────
      // PRIORITY 2: Consolidate if too many small UTXOs (fragmentation)
      // Prevents the "2000 small UTXOs" problem
      // ─────────────────────────────────────────────────────────────
      if (autoConsolidate && smallCount > maxSmallUtxos) {
        log.log(
          `[Heartbeat] ⚠️ Fragmentation detected: ${smallCount} small UTXOs (> ${maxSmallUtxos}). ` +
          `Consolidating to prevent wallet degradation...`
        );

        await this._doConsolidate({
          address,
          addresses, // Multi-address support
          privateKeys,
          targetCount: splitCount,
          priorityFee,
          onConsolidate,
          onError,
          emergency: false,
        });

        // Exit early - let next cycle check if more action needed
        this._checkInProgress = false;
        return;
      }

      // ─────────────────────────────────────────────────────────────
      // PRIORITY 3: Split if not enough USABLE UTXOs for parallel engines
      //
      // SAFEGUARDS:
      // 1. Only split if usableCount < targetUtxoCount (we need more)
      // 2. Only split if we can create MORE UTXOs than we currently have
      // 3. Only split if resulting UTXOs will still be >= usableThreshold
      // 4. Calculate optimal splitCount to reach targetUtxoCount
      // ─────────────────────────────────────────────────────────────
      if (usableCount > 0 && usableCount < targetUtxoCount) {
        // Calculate how many UTXOs we can create while keeping each >= usableThreshold
        // Account for fees: ~0.01 KAS per output
        const feePerOutput = 1000000n; // 0.01 KAS conservative estimate
        const totalFees = feePerOutput * BigInt(targetUtxoCount);
        const availableForSplit = usableBalance - totalFees;

        // Maximum outputs we can create while keeping each >= usableThreshold
        const maxPossibleOutputs = availableForSplit > 0n
          ? Number(availableForSplit / usableThreshold)
          : 0;

        // Target: create enough UTXOs to reach targetUtxoCount, but not more than we can afford
        const desiredOutputs = Math.min(targetUtxoCount, maxPossibleOutputs);

        // Check if splitting would actually increase our usable UTXO count
        const wouldIncreaseCount = desiredOutputs > usableCount;

        // Calculate what each output would be worth
        const amountPerOutput = desiredOutputs > 0
          ? (usableBalance - totalFees) / BigInt(desiredOutputs)
          : 0n;

        // Final check: outputs must be >= usableThreshold to be worth creating
        const outputsWillBeUsable = amountPerOutput >= usableThreshold;

        if (wouldIncreaseCount && outputsWillBeUsable && desiredOutputs >= 2) {
          log.log(
            `[Heartbeat] ⚡ Low usable UTXO count (${usableCount} < ${targetUtxoCount}). ` +
            `Splitting ${usableCount} UTXOs into ${desiredOutputs} @ ~${utxoManager.sompiToKas(amountPerOutput)} KAS each...`
          );

          await this._doSplit({
            address,
            addresses, // Multi-address support
            privateKeys,
            splitCount: desiredOutputs, // Use calculated count, not config splitCount
            priorityFee,
            minUtxoAmount: usableThreshold, // Only split usable UTXOs
            previousCount: usableCount,
            onSplit,
            onError,
          });
        } else if (!wouldIncreaseCount) {
          // Already have as many UTXOs as we can create - nothing to do
          log.log(
            `[Heartbeat] ℹ️ Have ${usableCount} usable UTXOs (target: ${targetUtxoCount}). ` +
            `Can only create ${maxPossibleOutputs} from current balance - skipping split.`
          );
        } else if (!outputsWillBeUsable) {
          // UTXOs would be too small to be usable
          log.log(
            `[Heartbeat] ℹ️ Have ${usableCount} usable UTXOs (target: ${targetUtxoCount}). ` +
            `Splitting would create outputs of ${utxoManager.sompiToKas(amountPerOutput)} KAS ` +
            `(below ${utxoManager.sompiToKas(usableThreshold)} KAS threshold) - skipping.`
          );
        } else {
          log.log(
            `[Heartbeat] ℹ️ Have ${usableCount} usable UTXOs (target: ${targetUtxoCount}). ` +
            `Insufficient balance to split further.`
          );
        }
      }

    } catch (err) {
      log.error(`[Heartbeat] Check failed: ${err?.message || err}`);
      this._invokeErrorCallback(onError, "check", err);
    } finally {
      this._checkInProgress = false;
    }
  }

  /**
   * Internal: Perform UTXO consolidation.
   * @private
   */
  async _doConsolidate({
    address,
    addresses,
    privateKeys,
    targetCount,
    priorityFee,
    onConsolidate,
    onError,
    emergency = false,
  }) {
    const prefix = emergency ? "🚨 EMERGENCY" : "🧹";

    try {
      const result = await this._facade.consolidateUtxos({
        address,
        addresses, // Pass addresses array for multi-address fetching
        privateKeys,
        targetCount,
        priorityFee,
      });

      // Handle no-op result (already at or below target)
      if (result.noOpReason) {
        log.log(`[Heartbeat] ${prefix} Consolidation skipped: ${result.noOpReason}`);
        if (typeof onConsolidate === "function") {
          try {
            onConsolidate({
              previousCount: result.previousUtxoCount,
              newCount: result.finalUtxoCount,
              transactionId: null,
              result,
              emergency,
              noOpReason: result.noOpReason,
            });
          } catch (cbErr) {
            log.warn("[Heartbeat] onConsolidate callback error:", cbErr);
          }
        }
        return;
      }

      log.log(
        `[Heartbeat] ${prefix} Consolidation complete: ` +
        `${result.previousUtxoCount} → ${result.finalUtxoCount} UTXOs`
      );

      if (typeof onConsolidate === "function") {
        try {
          onConsolidate({
            previousCount: result.previousUtxoCount,
            newCount: result.finalUtxoCount,
            transactionId: result.transactionId,
            result,
            emergency,
          });
        } catch (cbErr) {
          log.warn("[Heartbeat] onConsolidate callback error:", cbErr);
        }
      }

    } catch (err) {
      log.error(`[Heartbeat] ${prefix} Consolidation failed: ${err?.message || err}`);
      this._invokeErrorCallback(onError, "consolidate", err, emergency);
    }
  }

  /**
   * Internal: Perform UTXO split.
   * @private
   */
  async _doSplit({
    address,
    addresses,
    privateKeys,
    splitCount,
    priorityFee,
    minUtxoAmount,
    previousCount,
    onSplit,
    onError,
  }) {
    try {
      const result = await this._facade.splitUtxos({
        address,
        addresses, // Pass addresses array for multi-address fetching
        splitCount,
        privateKeys,
        priorityFee,
        minUtxoAmount, // Filter to only usable UTXOs
      });

      log.log(
        `[Heartbeat] ✓ Split complete: txid=${result.transactionId?.slice(0, 16)}…, ` +
        `created ${result.splitCount} UTXOs @ ${result.amountPerOutput} KAS each`
      );

      if (typeof onSplit === "function") {
        try {
          onSplit({
            previousCount,
            newCount: splitCount,
            transactionId: result.transactionId,
            result,
          });
        } catch (cbErr) {
          log.warn("[Heartbeat] onSplit callback error:", cbErr);
        }
      }

    } catch (err) {
      log.error(`[Heartbeat] Split failed: ${err?.message || err}`);
      this._invokeErrorCallback(onError, "split", err);
    }
  }

  /**
   * Internal: Safely invoke error callback.
   * @private
   */
  _invokeErrorCallback(onError, type, error, emergency = false) {
    if (typeof onError === "function") {
      try {
        onError({ type, error, emergency });
      } catch (cbErr) {
        log.warn("[Heartbeat] onError callback error:", cbErr);
      }
    }
  }
}
