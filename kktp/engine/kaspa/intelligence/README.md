> ### 📍 Navigation
> * [🏠 Project Hub](../../../../README.md)
> * [🏛️ Kaspa Portal Guide](../FACADE_GUIDE.md)
> * [🎮 KKGameEngine Guide](../../../README.md)
> * [🔍 Lobby Guide](../../../lobby/README.md)
> * [🔍 Low Level Guide](../LOW_LEVEL_SDK.md)
> * [📡 KKTP Protocol](../../../protocol/docs/KKTP_PROTOCOL.md)
> * [🎮 DAG Dasher Demo](../../../game/README.md)
---

# Kaspa Intelligence Facade

## Overview

The `IntelligenceFacade` provides a high-level, event-driven interface for advanced Kaspa block and transaction scanning, indexing, and DAG traversal in the browser. It wraps the `KaspaBlockScanner`, `KaspaIndexer`, and DAG walk utilities, exposing a unified API for real-time analytics, historical search, and cache management.

## Features

- **Event-Driven Block & Transaction Scanning:**
  Real-time callbacks for new blocks, transactions, matches, and cache events.
- **Integrated Indexer:**
  In-memory and persistent (IndexedDB) caching with TTL, size-based eviction, and deduplication.
- **DAG Traversal:**
  Forward and backward DAG walking for historical and payload-based searches.
- **Flexible Subscription:**
  Register for only the events you care about.
- **Batch & Priority Eviction:**
  Efficient cache management for high-throughput environments.
- **Metrics & Observability:**
  Access indexer metrics and cache statistics.

---

## Initialization

```js
import { IntelligenceFacade, SearchMode } from './intelligenceFacade.js';
import { connect } from '../transport/kaspa_client.js';

const client = await connect({ rpcUrl, networkId: 'testnet-10' });

const intelligence = new IntelligenceFacade(
  client,
  {
    // scannerOptions (optional)
    prefixes: ['kaspa:'],
    addresses: [], // addresses to watch
    mode: SearchMode.INCLUDES,
  },
  {
    // indexerOptions (optional)
    dbName: 'kaspaIndexer',
    matchMode: 'ALL',
    ttlMinutes: 60,
    maxSize: 1000,
    onIndexerUpdate: (event) => {
      // Handle indexer events for UI updates
      // event.type, event.data
    }
  }
);
```

---

## Event Subscription

Register for real-time events using the provided methods:

```js
intelligence
  .onNewBlock(block => {
    // Called when a new block is scanned (in-memory)
  })
  .onNewTransaction(tx => {
    // Called for every new transaction (in-memory)
  })
  .onNewTransactionMatch(tx => {
    // Called for every matching transaction (in-memory)
  })
  .onCachedBlock(blocks => {
    // Called when blocks are flushed to IndexedDB (batched)
  })
  .onCachedTransaction(txs => {
    // Called when transactions are flushed to IndexedDB (batched)
  })
  .onCachedTransactionMatch(txs => {
    // Called when matching transactions are flushed to IndexedDB (batched)
  })
  .onEvict(eviction => {
    // Called when an item is evicted from cache (non-TTL/size)
  })
  .onCacheEvict(eviction => {
    // Called when an item is evicted due to TTL/size
  });
```

---

## Starting the Intelligence System

```js
await intelligence.start();
// The scanner and indexer are now active and emitting events.
```

---

## DAG Traversal & Search

### Walk the DAG with Prefix Matching

```js
await intelligence.walkDagRange({
  startHash,
  endHash: null,
  prefixes: ['KKTP:'],
  maxSeconds: 15,
  minTimestamp: 0,
  logFn: console.log,
  onMatch: (tx, block) => {
    // return true to stop early
  }
});
```

---

## Indexer & Scanner Access

You can access the underlying indexer and scanner for advanced queries:

```js
const indexer = intelligence.indexer;
const scanner = intelligence.scanner;

// Example: Get all cached blocks
const blocks = await indexer.getAllCachedBlocks();

// Example: Get indexer metrics
const metrics = indexer.getMetrics();
```

---

## Shutdown

Gracefully stop all scanning and indexing:

```js
intelligence.shutdown();
```

---

## Event Types

- `onNewBlock`: New block scanned (in-memory)
- `onNewTransaction`: New transaction scanned (in-memory)
- `onNewTransactionMatch`: New matching transaction (in-memory)
- `onCachedBlock`: Blocks flushed to IndexedDB (batched)
- `onCachedTransaction`: Transactions flushed to IndexedDB (batched)
- `onCachedTransactionMatch`: Matching transactions flushed to IndexedDB (batched)
- `onEvict`: Item evicted from cache (non-TTL/size)
- `onCacheEvict`: Item evicted due to TTL/size
- `onFlushCompleted`: Indexer flush completed
- `onEvictCycleCompleted`: Indexer eviction cycle completed

---

## Example: Full Usage

```js
import { IntelligenceFacade } from './intelligenceFacade.js';

const intelligence = new IntelligenceFacade(client);

intelligence
  .onNewBlock(block => console.log('Block:', block))
  .onNewTransaction(tx => console.log('Tx:', tx))
  .onCachedBlock(blocks => console.log('Blocks cached:', blocks));

await intelligence.start();

await intelligence.walkDagRange({
  startHash: '0000abc...',
  prefixes: ['KKTP:'],
  onMatch: (tx) => {
    console.log('Match:', tx);
  }
});

intelligence.shutdown();
```

---

## Contributing

- Keep event-driven patterns for UI consistency.
- Use the indexer for all cache and batch logic.
- Validate changes with metrics and event logs.

---

For questions, issues, or contributions, please open an issue or pull request.
