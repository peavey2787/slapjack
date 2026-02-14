> ### 📍 Navigation
> * [🏠 Project Hub](../../../README.md)
> * [🏛️ Kaspa Portal Guide](./FACADE_GUIDE.md)
> * [🎮 KKGameEngine Guide](../../README.md)
> * [🔍 Intelligence Guide](./intelligence/README.md)
> * [🔍 Lobby Guide](../../lobby/README.md)
> * [📡 KKTP Protocol](../../protocol/docs/KKTP_PROTOCOL.md)
> * [🎮 DAG Dasher Demo](../../game/README.md)
---

# 🛠️ Kaspa Low-Level SDK Wrapper

> [!IMPORTANT]
> This document describes the granular primitives and direct WASM wrappers.
> For the simplified, production-ready interface used in our demos, please refer to the **[KaspaPortal Facade Guide](./FACADE_GUIDE.md)**.

## Overview
These modules provide raw access to the Kaspa WASM SDK, direct RPC command execution, and manual DAG traversal. Use these if you are building custom indexing logic or low-level cryptographic workflows.

### Client

1. **Connect to a Kaspa node:**

	```js
	import { connect } from './kktp/engine/kaspa/transport/kaspa_client.js';

	const client = await connect({ rpcUrl, networkId, onDisconnect });
	// rpcUrl: Node address (or null for resolver)
	// networkId: e.g. "mainnet", "testnet-10"
	// onDisconnect: Optional callback for disconnect events
	```

### Wallet Management

2. **Initialize the wallet:**

	```js
	import { init } from './kktp/engine/kaspa/identity/wallet_service.js';

	init({ rpcClient: client, networkId, balanceElementId, onBalanceChange });
	// rpcClient: The connected Kaspa client
	// networkId: Network string
	// balanceElementId: (optional) DOM element ID to update balance
	// onBalanceChange: (optional) callback for balance updates
	```

3. **Create/Import a wallet:**

	```js
	import { createWallet } from './kktp/engine/kaspa/identity/wallet_service.js';

	const { mnemonic, address } = await createWallet({
	  password,             // Wallet password
	  walletFilename,       // (optional) Wallet filename
	  userHint,             // (optional) User hint for wallet
	  mnemonic,             // (optional) Import mnemonic
	  storeMnemonic,        // (optional) Store mnemonic in storage
	  discoverAddresses     // (optional, default true) Scan for used addresses
	});
	```

4. **Send Kaspa:**

	```js
	import { send } from './kktp/engine/kaspa/identity/wallet_service.js';

	await send({ amount, toAddress, payload, priorityFeeKas });
	```

5. **Other wallet functions:**

	```js
	import { getSpendableBalance, generateNewAddress, getPrivateKeys } from './kktp/engine/kaspa/identity/wallet_service.js';

	const balance = await getSpendableBalance();
	const address = await generateNewAddress();
	const keys = await getPrivateKeys({ keyCount: 10, changeKeyCount: 5 });
	```

### Wallet File Management

6. **List all wallets:**

	```js
	import { getAllWallets } from './kktp/engine/kaspa/identity/wallet_service.js';

	const wallets = await getAllWallets();
	// wallets: Array of { filename, title, ... }
	```

7. **Delete a wallet by filename:**

	```js
	import { deleteWalletData } from './kktp/engine/kaspa/identity/storage.js';

	await deleteWalletData(filename); // filename: string
	```

### Block Scanner

8. **Block Scanner usage:**

	```js
	import { KaspaBlockScanner, SearchMode } from './kktp/engine/kaspa/intelligence/scanner.js';
	import { MatchMode } from './kktp/engine/kaspa/intelligence/indexer.js';

	// The scanner is coupled with an internal indexer at scanner.indexer
	const scanner = new KaspaBlockScanner(client, {
	  prefixes: ['test'],
	  mode: SearchMode.INCLUDES,
	  indexerOptions: {
	    ttlMinutes: 10,
	    flushInterval: 5000,
	    maxSize: 500,
	    matchMode: MatchMode.ALL,
	    onIndexerUpdate: (event) => {
	      // stream indexer events into your UI
	      // NOTE: *-cached events are batched per flush: event.data is an array.
	      // In-memory events provide a single entry.
	    }
	  }
	});

	// Start indexing when you want it (optional)
	scanner.indexer.start();

	await scanner.start((block, matches) => {
	  // block: full block object
	  // matches: array of match objects for this block
	});

	scanner.stop();
	scanner.indexer.stop();
	```

### Indexer (Standalone)

The indexer can also be used standalone (without the scanner). See `intelligence/README.md`.

### Walking the DAG

The DAG walker utilities live in `intelligence/dag_walk.js`.

```js
import { walkDagRange } from './kktp/engine/kaspa/intelligence/dag_walk.js';

await walkDagRange({
	client,
	startHash,
	endHash: null, // optional
	prefixes: ['KKTP:'],
	maxSeconds: 15,
	minTimestamp: 0,
	logFn: console.log,
	onMatch: (tx, block) => {
		// return true to stop walking early
	}
});
```

## Testing

Browser-based test dashboard for the DAG walker:

- `tests/walking-the-dag/tests.html`

Included tests:

- `tests/walking-the-dag/test_walk_forward_to_present.js`
- `tests/walking-the-dag/test_walk_forward_to_match.js` (supports auto payload discovery when match input is blank)
- `tests/walking-the-dag/test_walk_backward_to_match.js` (supports auto payload discovery when match input is blank)

To run them, serve the repo via a local web server (e.g. Laragon) and open `tests/walking-the-dag/tests.html` in your browser.

### RPC Commands

9. **Run arbitrary RPC commands:**

	```js
	import { runRpcCommand } from './kktp/engine/kaspa/transport/rpc_runner.js';

	const result = await runRpcCommand(client, '{"method":"getInfo","params":{}}');
	```

### Encryption

10. **Symmetric Encryption usage:**

	```js
	import { encryptMessage, decryptMessage } from './kktp/engine/kaspa/crypto/encryption.js';

	// Encrypt
	const encrypted = encryptMessage(plaintext, password);

	// Decrypt
	const decrypted = decryptMessage(encrypted, password);
	```

11. **Diffie–Hellman Encryption usage:**

	```js
	import { DHSession } from './kktp/engine/kaspa/crypto/dh_encryption.js';

	const dh = new DHSession();
	// Initiate handshake
	const handshakeMsg = dh.initiateHandshake(myPrivateKey, myPublicKey);
	// Respond to handshake
	const response = await dh.respondToHandshake(peerPublicKeyHex);
	// Encrypt
	const encrypted = dh.encrypt(message);
	// Decrypt
	const decrypted = dh.decrypt(encrypted);
	```
