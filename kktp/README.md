# KKGameEngine Guide

> ### 📍 Navigation
> * [🏠 Project Hub](../README.md)
> * [🏛️ Kaspa Portal Guide](./engine/kaspa/FACADE_GUIDE.md)
> * [🔍 Intelligence Guide](./engine/kaspa/intelligence/README.md)
> * [🔍 Lobby Guide](./lobby/README.md)
> * [🔍 Low Level Guide](./engine/kaspa/LOW_LEVEL_SDK.md)
> * [📡 KKTP Protocol](./protocol/docs/KKTP_PROTOCOL.md)
> * [🎮 DAG Dasher Demo](./game/README.md)

The KKGameEngine is the single entry point for game developers. It hides DAG,
UTXO, and anchor mechanics behind a simple API for gameplay, randomness, and
auditing.

## Quick Start

```js
import { KKGameEngine } from './kktp/kkGameEngine.js';

const game = new KKGameEngine();

await game.init({
  password: 'user-password',
  walletName: 'my-game-wallet',
  network: 'testnet-10',
});

await game.startGame({
  gameId: 'match-123',
  playerId: 'player-1',
});
```


## Record Moves and Events

```js
const move = await game.recordMove('jump', { lane: 1 });
console.log('Random value:', move.randomValue);

game.recordEvent('coin_collected', { lane: 2, value: 10 });
```js

```js
const move = await game.recordMove('jump', { lane: 1 });
console.log('Random value:', move.randomValue);


```

## Listening for Opponent Moves (Multiplayer)

To react to opponent moves or heartbeats in real time, subscribe to the engine's event system:

```js
// Listen for opponent moves anchored to the blockchain
game.on('opponentMoveAnchored', (move) => {
  console.log('Opponent move:', move);
  // Update your game state/UI here
});

// Listen for opponent heartbeats (for real-time presence or sync)
game.on('opponentHeartbeat', (heartbeat) => {
  console.log('Opponent heartbeat:', heartbeat);
});
```

**Tip:** Always use the event-driven API for multiplayer updates. Do not poll or call internal validation methods directly.

```

## Lobbies and Messaging

```js
const lobby = await game.createLobby({
  name: 'My Room',
  maxPlayers: 4,
});

console.log('Join code:', lobby.joinCode);

await game.joinLobby(lobby.joinCode, 'PlayerTwo');

await game.sendLobbyMessage('Welcome!');

// Or send an object (will be JSON.stringified)
await game.sendLobbyMessage({ type: 'hello', text: 'Welcome!' });

await game.leaveLobby('Game ended');
```

**Tip:** Sometimes the initial genesis anchor send is blocked by degradedMode/utxoReady, and there currently isn't any auto retries for the genesis anchor after UTXOs recover. To avoid this, it is recommended to call prepareUtxoPool() on lobby join/host.

## Custom Action/Ability/Status Mappings

KKGameEngine supports **dynamic mappings** for actions, abilities, items, statuses, emotes, and system events.
This lets you use your own game-specific names (e.g. `fireball`, `shield`, `energy`, `hp`) instead of the defaults (`armor`, `stamina`, `health`, etc.).

### How to Use Custom Mappings

Pass your custom maps when initializing the engine:

```js
const game = new KKGameEngine();

await game.init({
  password: 'user-password',
  walletName: 'my-game-wallet',
  // Custom mappings:
  customActionMap:   { fireball: 1, shield: 2, heal: 3 },
  customAbilitiesMap:{ energy: 1, hp: 2 },
  customStatusMap:   { frozen: 1, burning: 2 },
  customItemsMap:    { potion: 1, bomb: 2 },
  customEmotesMap:   { wave: 1, laugh: 2 },
  customSystemMap:   { pause: 1, resume: 2 },
});
```

**Tip:**
- All engine methods (`recordMove`, `recordEvent`, etc.) will use your mappings.
- The audit and anchor chain will reflect your custom names and codes.

## Logger

KKGameEngine exposes a structured logger with module-level filtering so you can
turn on only the logs you need.

```js
import { Logger, LogModule } from './kktp/core/logger.js';

Logger.setEnabled(true);

// Enable high-level engine logs
Logger.enableModule(LogModule.kktp.kkGameEngine);

// Enable low-level transport logs
Logger.enableModule(LogModule.transport.root);

// Disable a noisy sub-module
Logger.disableModule(LogModule.transport.txBuilder);

const log = Logger.create(LogModule.kktp.kkGameEngine);
log.info('Engine initialized and ready.');
```

## Shutdown

```js
await game.shutdown();
```
## Anti-Cheat

```js
const auditData = game.getAuditData();
const verdict = await game.auditCheating(auditData);
console.log('Audit verdict:', verdict.verdict);

const parsed = game.parseAnchor(auditData.anchorChain?.chain?.[0]);
console.log('Parsed anchor:', parsed);
```

## Facade Overview

- `kktpProtocolFacade`: Protocol primitives for anchors, signing, canonicalization, and verification.
- `SessionFacade`: Session lifecycle (discovery, response, message flow), built on the protocol facade.
- `LobbyFacade`: Group sessions, key rotation, and routing on top of sessions.
- `KaspaAnchorFacade`: Game anchoring API (genesis, heartbeats, final) and audit data access.
- `KaspaAdapter`: Bridge to the Kaspa transport layer and wallet operations.

## Architecture (High Level)

KKGameEngine orchestrates gameplay and delegates to internal facades:

- Anchors and audit data flow through `KaspaAnchorFacade` and its `MoveProcessor`.
- Multiplayer sessions are managed by `SessionFacade` and lobbies build on that via `LobbyFacade`.
- All network and wallet operations go through `KaspaAdapter`.

<img width="996" height="897" alt="Image" src="https://github.com/user-attachments/assets/cdf552d8-6f96-42d1-87cd-44900cc2912d" />

## UTXO and Anchor Strategy

- `prepareForGame()` calculates runway using `MOVE_COST_KAS` and `MOVE_INTERVAL_MS`, then splits UTXOs into `UTXO_SPLIT_COUNT` outputs for parallel sends.
- If balance is below `FULL_RACE_COST_KAS`, the engine runs a 500ms UTXO heartbeat (`UTXO_HEARTBEAT_MS`) to keep the runway topped up.
- Anchoring follows the GHF pattern: Genesis -> Heartbeat(s) -> Final. Heartbeats run every 500ms (`ANCHOR_BATCH_MS`).
- Anchor sends use `manualSend` under the hood with janitor mode enabled, which sweeps small UTXOs while sending.

<img width="1023" height="472" alt="Image" src="https://github.com/user-attachments/assets/5896f3b1-acaf-4bac-bb38-973bd6da4de3" />

## Facades

- Game engine: [kkGameEngine.js](kkGameEngine.js)
- KKTP protocol core: [protocol/kktpProtocolFacade.js](protocol/kktpProtocolFacade.js)
- Sessions: [protocol/sessions/sessionFacade.js](protocol/sessions/sessionFacade.js)
- Lobbies: [lobby/lobbyFacade.js](lobby/lobbyFacade.js)
- Anchoring: [blockchain/kaspaAnchorFacade.js](blockchain/kaspaAnchorFacade.js)
- Adapter: [adapters/kaspaAdapter.js](adapters/kaspaAdapter.js)

For lower-level Kaspa operations, see the KaspaPortal guide:
[engine/kaspa/FACADE_GUIDE.md](engine/kaspa/FACADE_GUIDE.md)
