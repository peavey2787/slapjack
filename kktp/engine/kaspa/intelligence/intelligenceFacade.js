import { walkDagRange } from "./dag_walk.js";
import { KaspaBlockScanner, SearchMode } from "./scanner.js";
import {
  IndexerEventType,
  MatchMode,
  EvictionReason,
  IndexerStore,
} from "./indexer.js";
import { Logger, LogModule } from "../../../core/logger.js";

const log = Logger.create(LogModule.intelligence.intelligenceFacade);

// Re-export indexer enums
export {
  IndexerEventType,
  MatchMode,
  EvictionReason,
  IndexerStore,
  SearchMode,
};

export class IntelligenceFacade {
  /**
   * @param {Object} client - Kaspa RPC client
   * @param {Object} scannerOptions - { prefix, addresses, mode }
   * @param {Object} indexerOptions - { dbName, matchMode, onIndexerUpdate, ttlMinutes, etc. }
   */
  constructor(client, scannerOptions = {}, indexerOptions = {}) {
    this.client = client;
    this._subscribers = new Map();

    const onIndexerUpdate = (event) => {
      this._handleIndexerUpdate(event);
    };

    // The Scanner is the "Worker" - it creates and owns the Indexer
    // We pass the indexerOptions straight through as the scanner expects.
    this.scanner = new KaspaBlockScanner(client, {
      ...scannerOptions,
      indexerOptions: { ...indexerOptions, onIndexerUpdate },
    });

    // Expose the indexer for direct queries (getMetrics, getAllCachedBlocks, etc.)
    this.indexer = this.scanner.indexer;

    this._activeTasks = new AbortController();
  }

  _handleIndexerUpdate = (event) => {
    const { type, data } = event;

    switch (type) {
      case IndexerEventType.TRANSACTION_IN_MEMORY:
        this._trigger("onNewTransaction", data);
        break;
      case IndexerEventType.MATCHING_TRANSACTION_IN_MEMORY:
        this._trigger("onNewTransactionMatch", data);
        break;
      case IndexerEventType.BLOCK_IN_MEMORY:
        this._trigger("onNewBlock", data);
        break;
      case IndexerEventType.TRANSACTION_CACHED:
        this._trigger("onCachedTransaction", data);
        break;
      case IndexerEventType.MATCHING_TRANSACTION_CACHED:
        this._trigger("onCachedTransactionMatch", data);
        break;
      case IndexerEventType.BLOCK_CACHED:
        this._trigger("onCachedBlock", data);
        break;
      case IndexerEventType.FLUSH_COMPLETED:
        this._trigger("onFlushCompleted", data);
        break;
      case IndexerEventType.EVICT_CYCLE_COMPLETED:
        this._trigger("onEvictCycleCompleted", data);
        break;
      case IndexerEventType.EVICT:
        // Differentiate between cache evictions and full evictions
        if (
          data?.reason === EvictionReason.TTL ||
          data?.reason === EvictionReason.SIZE
        ) {
          this._trigger("onCacheEvict", data);
        } else {
          this._trigger("onEvict", data);
        }
        break;
      default:
        log.warn("IntelligenceFacade: Unknown event type:", type);
    }
  };

  _trigger(name, data) {
    const subs = this._subscribers.get(name);
    if (!subs || subs.size === 0) return;
    for (const cb of subs) {
      try {
        cb(data);
      } catch (err) {
        log.error(`IntelligenceFacade ${name} subscriber error`, err);
      }
    }
  }

  _getSubscriberSet(name) {
    if (!this._subscribers.has(name)) {
      this._subscribers.set(name, new Set());
    }
    return this._subscribers.get(name);
  }

  _addSubscriber(name, cb) {
    if (typeof cb !== "function") return () => {};
    const set = this._getSubscriberSet(name);
    set.add(cb);
    return () => set.delete(cb);
  }

  onNewBlock(cb) {
    // Now only registers once.
    // Fires when Indexer confirms it has the block in memory.
    return this._addSubscriber("onNewBlock", cb);
  }
  onNewTransaction(cb) {
    return this._addSubscriber("onNewTransaction", cb);
  }
  onNewTransactionMatch(cb) {
    return this._addSubscriber("onNewTransactionMatch", cb);
  }
  onCachedBlock(cb) {
    return this._addSubscriber("onCachedBlock", cb);
  }
  onCachedTransaction(cb) {
    return this._addSubscriber("onCachedTransaction", cb);
  }
  onCachedTransactionMatch(cb) {
    return this._addSubscriber("onCachedTransactionMatch", cb);
  }
  onEvict(cb) {
    return this._addSubscriber("onEvict", cb);
  }
  onCacheEvict(cb) {
    return this._addSubscriber("onCacheEvict", cb);
  }

  async init() {
    await this.indexer.initDB();
  }

  /**
   * Starts the system.
   * The scanner will listen to the network, feed the indexer,
   * and the indexer will fire the 'onIndexerUpdate' events.
   */
  async start() {
    await this.indexer.initDB();
    this.indexer.start();

    // Start the scanner. We don't need a separate callback here because
    // the user is listening via the indexer's onIndexerUpdate events.
    await this.scanner.start();
  }

  getIndexerTimings() {
    return {
      ttlMs: this.indexer?.ttlMs ?? null,
      flushInterval: this.indexer?.flushInterval ?? null,
    };
  }

  async startIndexer() {
    await this.init();
    this.indexer.start();
    return this.getIndexerTimings();
  }

  stopIndexer() {
    this.indexer.stop();
  }

  setSearchMode(mode) {
    if (this.scanner) this.scanner.searchMode = mode;
  }

  async startScanner(onBlock) {
    return this.scanner.start(onBlock);
  }

  stopScanner() {
    this.scanner.stop();
  }

  async getCachedSnapshot() {
    const [allTxs, matchingTxs, blocks] = await Promise.all([
      this.indexer.getAllCachedTransactions(),
      this.indexer.getAllCachedMatchingTransactions(),
      this.indexer.getAllCachedBlocks(),
    ]);
    return { allTxs, matchingTxs, blocks };
  }

  getInMemorySnapshot() {
    return {
      allTxs: this.indexer.getAllTransactions(),
      matchingTxs: this.indexer.getAllMatchingTransactions(),
      blocks: this.indexer.getAllBlocks(),
    };
  }

  async clearIndexerStore(storeName) {
    return this.indexer.clearStore(storeName);
  }

  /** Walk the DAG from startHash to endHash (or present).
   * @param {Object} options
   * @param {string} options.startHash - Block hash to start from
   * @param {string} [options.endHash] - Optional block hash to end at
   * @param {Array<string>} [options.prefixes] - Optional payload prefixes to match
   * @param {function} options.onMatch - Callback for each matching transaction
   * @param {number} [options.maxSeconds] - Max seconds to run (default 30)
   * @param {number} [options.minTimestamp] - Min timestamp to consider (default 0)
   * @param {function} [options.logFn] - Optional logging function
   * @returns {Promise<void>}
   */
  async walkDagRange(options) {
    return await walkDagRange({ client: this.client, ...options });
  }

  /**
   * Add an address to the watch list
   * @param {string} address - Kaspa address to watch
   */
  addAddress(address) {
    this.scanner?.addAddress(address);
  }

  /** Remove an address from the watch list
   * @param {string} address - Kaspa address to remove
   */
  removeAddress(address) {
    this.scanner?.removeAddress(address);
  }

  /** Set the list of addresses to watch
   * @param {Array<string>|string} addresses - Array of addresses or single address
   */
  setAddresses(addresses) {
    if (!this.scanner) return;
    // Remove all current addresses
    if (Array.isArray(this.scanner.addresses)) {
      for (const addr of [...this.scanner.addresses]) {
        this.scanner.removeAddress(addr);
      }
    }
    // Add new addresses
    const addrs = Array.isArray(addresses) ? addresses : [addresses];
    for (const addr of addrs) {
      this.scanner.addAddress(addr);
    }
  }

  /** Add a payload prefix to the watch list
   * @param {string} prefix - Payload prefix to add
   */
  addPrefix(prefix) {
    this.scanner?.addPrefix(prefix);
  }

  /** Add a hex payload prefix to the watch list
   * @param {string} prefixHex - Hex prefix to add
   */
  addPrefixHex(prefixHex) {
    this.scanner?.addPrefixHex?.(prefixHex);
  }

  /** Remove a payload prefix from the watch list
   * @param {string} prefix - Payload prefix to remove
   */
  removePrefix(prefix) {
    this.scanner?.removePrefix(prefix);
  }

  /** Remove a hex payload prefix from the watch list
   * @param {string} prefixHex - Hex prefix to remove
   */
  removePrefixHex(prefixHex) {
    this.scanner?.removePrefixHex?.(prefixHex);
  }

  /** Set the list of payload prefixes to watch
   * @param {Array<string>|string} prefixes - Array of prefixes or single prefix
   */
  setPrefixes(prefixes) {
    if (!this.scanner) return;
    // Remove all current prefixes
    if (Array.isArray(this.scanner.prefixes)) {
      for (const prefix of [...this.scanner.prefixes]) {
        this.scanner.removePrefix(prefix);
      }
    }
    // Add new prefixes
    const pfxs = Array.isArray(prefixes) ? prefixes : [prefixes];
    for (const prefix of pfxs) {
      this.scanner.addPrefix(prefix);
    }
  }

  shutdown() {
    this._activeTasks.abort();
    this.scanner.stop();
    this.indexer.stop();
    for (const set of this._subscribers.values()) {
      set.clear();
    }
    this._subscribers.clear();
  }
}
