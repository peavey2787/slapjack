import {
  stringToHex,
  hexToString,
  dehydrateTx,
  dehydrateBlock,
} from "../utilities/utilities.js";
import { KaspaIndexer, MatchMode } from "./indexer.js";
import { Logger, LogModule } from "../../../core/logger.js";

const log = Logger.create(LogModule.intelligence.scanner);

export const BlockScannerEvent = Object.freeze({
  BLOCK_ADDED: "block-added",
});

export const SearchMode = Object.freeze({
  INCLUDES: "includes",
  STARTS_WITH: "startsWith",
  EXACT: "exact",
  ENDS_WITH: "endsWith",
});

export class KaspaBlockScanner {
  #prefixes = new Set();
  #blockSubscribers = new Set();
  #matchSubscribers = new Set();
  #blockListener = null;
  #reconnectHandler = null;
  #lastBlockTime = null;
  #pendingBlockEnrichment = new Set();
  indexer = null;

  constructor(
    client,
    {
      prefixes = [],
      addresses = [],
      mode = SearchMode.INCLUDES,
      indexerOptions = {},
      onMatch = null,
      onBlock = null,
    } = {},
  ) {
    this.client = client;
    this.scanning = false;

    if (typeof onBlock === "function") this.#blockSubscribers.add(onBlock);
    if (typeof onMatch === "function") this.#matchSubscribers.add(onMatch);

    if (Array.isArray(prefixes)) {
      prefixes.forEach((p) => this.addPrefix(p));
    } else if (prefixes) {
      this.addPrefix(prefixes);
    }

    this.addresses = Array.isArray(addresses) ? addresses : [];
    this.searchMode = Object.values(SearchMode).includes(mode)
      ? mode
      : SearchMode.INCLUDES;

    this.indexer = new KaspaIndexer(indexerOptions);
    // Async DB init with callback binding
    this.indexer.initDB().then(() => {
      if (typeof indexerOptions.onIndexerUpdate === "function") {
        this.indexer.onIndexerUpdate = indexerOptions.onIndexerUpdate;
      }
    });
  }

  // --- Getters & Setters ---
  get prefixes() {
    return Array.from(this.#prefixes);
  }
  set prefixes(values) {
    this.#prefixes.clear();
    const arr = Array.isArray(values) ? values : [values];
    arr.forEach((v) => this.addPrefix(v));
  }

  addPrefix(prefix) {
    if (prefix) this.#prefixes.add(stringToHex(prefix));
  }
  addPrefixHex(prefixHex) {
    const normalized = normalizeHexPrefix(prefixHex);
    if (normalized) this.#prefixes.add(normalized);
  }
  removePrefix(prefix) {
    this.#prefixes.delete(stringToHex(prefix));
  }
  removePrefixHex(prefixHex) {
    const normalized = normalizeHexPrefix(prefixHex);
    if (normalized) this.#prefixes.delete(normalized);
  }
  addAddress(address) {
    if (!this.addresses.includes(address)) this.addresses.push(address);
  }
  removeAddress(address) {
    this.addresses = this.addresses.filter((a) => a !== address);
  }

  // --- Subscription API ---
  subscribeBlock(fn) {
    if (typeof fn !== "function") return () => {};
    this.#blockSubscribers.add(fn);
    return () => this.#blockSubscribers.delete(fn);
  }

  subscribeMatch(fn) {
    if (typeof fn !== "function") return () => {};
    this.#matchSubscribers.add(fn);
    return () => this.#matchSubscribers.delete(fn);
  }

  // --- Health & Status ---
  checkHealth() {
    if (!this.scanning) return true;
    if (!this.#lastBlockTime) return false;
    return Date.now() - this.#lastBlockTime <= 60_000;
  }

  get status() {
    return {
      scanning: this.scanning,
      matchSubscribers: this.#matchSubscribers.size,
      blockSubscribers: this.#blockSubscribers.size,
      prefixes: this.#prefixes.size,
      lastBlockTime: this.#lastBlockTime,
      health: this.checkHealth(),
    };
  }

  async start(onBlock) {
    if (!this.client) throw new Error("Kaspa client required");
    if (this.scanning) return;
    this.scanning = true;
    this.#lastBlockTime = Date.now();

    if (onBlock && typeof onBlock === "function")
      this.#blockSubscribers.add(onBlock);

    // FIX: Guarded subscription
    const subscribeSafely = async () => {
      try {
        if (this.scanning) await this.client.subscribeBlockAdded();
      } catch (e) {
        log.warn("Scanner: Subscription failed.");
      }
    };

    await subscribeSafely();

    if (!this.#reconnectHandler) {
      this.#reconnectHandler = () => {
        if (this.scanning) subscribeSafely();
      };
      this.client.addEventListener("connect", this.#reconnectHandler);
    }

    this.#blockListener = (event) => {
      if (!this.scanning || !event?.data?.block) return;

      const rawBlock = event.data.block;
      this.#lastBlockTime = Date.now();

      // 1. DEHYDRATE: This converts WASM to JS. Still necessary for your stream.
      const cleanBlock = dehydrateBlock(rawBlock);

      // 2. CONDITIONAL TX PROCESSING:
      // Only loop through thousands of transactions if the Indexer is active
      // or if the user is actually searching for a prefix/address.
      const shouldScanTXs =
        this.#prefixes.size > 0 ||
        this.addresses.length > 0 ||
        this.indexer?.active;

      let matches = [];
      let txCount = 0;

      if (shouldScanTXs) {
        txCount = this._processBlockTransactions(rawBlock, matches);
        cleanBlock.txCount = txCount;
      } else {
        // If not scanning TXs, just grab the count from the header to save CPU
        cleanBlock.txCount = Number(rawBlock.header?.transactionCount || 0);
      }

      // 3. INDEXER: Only touches the DB if active
      if (this.indexer?.active) {
        this.indexer.addBlock(cleanBlock);
      }

      // 4. BROADCAST: Send the clean block to your VRF buffer
      for (const subscriber of this.#blockSubscribers) {
        try {
          subscriber(cleanBlock, matches);
        } catch (err) {
          log.error(err);
        }
      }
    };

    this.client.addEventListener(
      BlockScannerEvent.BLOCK_ADDED,
      this.#blockListener,
    );
  }

  _processBlockTransactions(rawBlock, matches) {
    const txs = rawBlock?.transactions;
    if (!txs) return null;

    const shouldMatch = this.#prefixes.size > 0 || this.addresses.length > 0;
    const indexerActive = !!this.indexer?.active;
    let txCount = 0;

    // Standardized iteration with mandatory cleanup
    for (const tx of txs) {
      txCount++;
      try {
        if (shouldMatch) {
          const { matchObj, isMatch } = this._analyzeTransaction(tx, rawBlock);
          if (isMatch) {
            matches.push(matchObj);
            this._indexMatchingTransactionIfNeeded(matchObj);
            for (const subscriber of this.#matchSubscribers) {
              try {
                subscriber(rawBlock, matchObj);
              } catch (err) {}
            }
          }
        }
        if (indexerActive) this._indexAllTransactionIfNeeded(tx, rawBlock);
      } finally {
        if (tx && typeof tx.free === "function") tx.free();
      }
    }
    return txCount;
  }

  _analyzeTransaction(tx, rawBlock) {
    const { payloadMatch, decodedPayload } = this._matchPayload(tx);
    const addressMatch = this._matchAddress(tx);
    const isMatch = payloadMatch || addressMatch;

    let matchObj = null;
    if (isMatch) {
      matchObj = this._buildMatchObject(
        tx,
        rawBlock,
        payloadMatch,
        addressMatch,
        decodedPayload,
      );
    }
    return { matchObj, isMatch };
  }

  _matchPayload(tx) {
    const payloadHex = tx.payload;
    if (this.#prefixes.size === 0 || !payloadHex)
      return { payloadMatch: false, decodedPayload: null };

    // Normalize payload to lowercase for case-insensitive matching
    // Prefixes are already normalized to lowercase in addPrefixHex
    const payloadLower = payloadHex.toLowerCase();

    let payloadMatch = false;
    for (const prefixHex of this.#prefixes) {
      if (this.searchMode === SearchMode.INCLUDES)
        payloadMatch = payloadLower.includes(prefixHex);
      else if (this.searchMode === SearchMode.STARTS_WITH)
        payloadMatch = payloadLower.startsWith(prefixHex);
      else if (this.searchMode === SearchMode.EXACT)
        payloadMatch = payloadLower === prefixHex;
      else if (this.searchMode === SearchMode.ENDS_WITH)
        payloadMatch = payloadLower.endsWith(prefixHex);
      if (payloadMatch) break;
    }

    let decodedPayload = null;
    if (payloadMatch) {
      try {
        decodedPayload = hexToString(payloadHex);
      } catch (e) {}
    }
    return { payloadMatch, decodedPayload };
  }

  _matchAddress(tx) {
    if (this.addresses.length === 0) return false;
    // Check outputs
    if (Array.isArray(tx.outputs)) {
      for (const out of tx.outputs) {
        if (this.addresses.includes(out.verboseData?.scriptPublicKeyAddress))
          return true;
      }
    }
    // Check inputs
    if (Array.isArray(tx.inputs)) {
      for (const input of tx.inputs) {
        if (this.addresses.includes(input.previousOutpointAddress)) return true;
      }
    }
    return false;
  }

  _buildMatchObject(tx, rawBlock, payloadMatch, addressMatch, decodedPayload) {
    // FIX: Passing rawBlock so dehydrateTx finds .hash
    const dehydratedTx = dehydrateTx({ tx, block: rawBlock, decodedPayload });
    dehydratedTx.payloadMatch = payloadMatch;
    dehydratedTx.addressMatch = addressMatch;
    return dehydratedTx;
  }

  _indexMatchingTransactionIfNeeded(matchObj) {
    if (!this.indexer.active) return;
    const mode = this.indexer.matchMode;
    if (
      mode === MatchMode.ALL ||
      mode === MatchMode.MATCHING ||
      (mode === MatchMode.CUSTOM && this.indexer.indexAllMatchingTransactions)
    ) {
      this.indexer.addTransaction(matchObj, true);
    }
  }

  _indexAllTransactionIfNeeded(tx, rawBlock) {
    if (!this.indexer.active) return;
    const mode = this.indexer.matchMode;
    if (
      mode === MatchMode.ALL ||
      mode === MatchMode.TRANSACTIONS ||
      (mode === MatchMode.CUSTOM && this.indexer.indexAllTransactions)
    ) {
      const obj = this._buildMatchObject(tx, rawBlock, false, false, null);
      this.indexer.addTransaction(obj, false);
    }
  }

  _indexBlockIfNeeded(rawBlock, txCountOverride = null) {
    if (!this.indexer.active) return;
    const mode = this.indexer.matchMode;

    if (
      mode === MatchMode.ALL ||
      mode === MatchMode.BLOCKS ||
      (mode === MatchMode.CUSTOM && this.indexer.indexAllBlocks)
    ) {
      const summary = dehydrateBlock(rawBlock);
      if (summary) {
        const headerCount = Number(
          rawBlock?.header?.transactionCount ?? rawBlock?.header?.txCount,
        );
        summary.txCount = Number.isFinite(txCountOverride)
          ? txCountOverride
          : headerCount;
        this.indexer.addBlock(summary);

        if (summary.hash && (!summary.txCount || summary.txCount <= 0)) {
          this._enrichBlockTxCount(summary.hash);
        }
      }
    }
  }

  async _enrichBlockTxCount(hash) {
    if (!hash || this.#pendingBlockEnrichment.has(hash)) return;
    this.#pendingBlockEnrichment.add(hash);
    try {
      const full = await this._fetchBlockWithTransactions(hash);
      if (full?.transactions) {
        const summary = dehydrateBlock(full);
        summary.txCount = full.transactions.length;
        this.indexer.addBlock(summary);
      }
    } catch (err) {
    } finally {
      this.#pendingBlockEnrichment.delete(hash);
    }
  }

  async _fetchBlockWithTransactions(hash) {
    try {
      if (typeof this.client.getBlock === "function")
        return await this.client.getBlock({ hash, includeTransactions: true });
    } catch {}
    return null;
  }

  stop() {
    this.scanning = false;
    if (this.#blockListener) {
      this.client.removeEventListener(
        BlockScannerEvent.BLOCK_ADDED,
        this.#blockListener,
      );
      this.#blockListener = null;
    }
    if (this.#reconnectHandler) {
      this.client.removeEventListener("connect", this.#reconnectHandler);
      this.#reconnectHandler = null;
    }
    try {
      this.client.unsubscribeBlockAdded();
    } catch (e) {}
    this.#blockSubscribers.clear();
    this.#matchSubscribers.clear();
    this.#prefixes = new Set();
    this.addresses = [];
  }
}

function normalizeHexPrefix(prefixHex) {
  if (!prefixHex) return null;
  if (typeof prefixHex !== "string") return null;
  const trimmed = prefixHex.trim();
  if (!trimmed) return null;
  const hex = trimmed.startsWith("0x") ? trimmed.slice(2) : trimmed;
  if (hex.length === 0 || hex.length % 2 !== 0) return null;
  if (!/^[0-9a-fA-F]+$/.test(hex)) return null;
  return hex.toLowerCase();
}
