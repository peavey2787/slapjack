# KKTP Lobby Module

> ### 📍 Navigation
> * [🏠 Project Hub](../../README.md)
> * [🎮 KKGameEngine Guide](../README.md)
> * [🏛️ Kaspa Portal Guide](../engine/kaspa/FACADE_GUIDE.md)
> * [🔍 Intelligence Guide](../engine/kaspa/intelligence/README.md)
> * [📡 KKTP Protocol](../protocol/docs/KKTP_PROTOCOL.md)
> * [🎮 DAG Dasher Demo](../game/README.md)

Multi-party group sessions built on top of the 1:1 KKTP protocol.

## Overview

The Lobby module enables group communication with:
- **Host-managed lobbies** with discovery anchors
- **Encrypted group messaging** using XChaCha20-Poly1305
- **Automatic key rotation** every 10 minutes
- **Member management** (join, leave, kick)
- **State root commitments** for integrity verification
- **Self-contained message routing** - DM/group message routing handled internally
- **DM message buffering** - Handles race conditions when DMs arrive before session
- **Self-contained prefix subscriptions** - Manages its own scanner prefixes

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      LOBBY PROTOCOL                         │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  1. Host broadcasts Discovery Anchor with lobby=true        │
│     ↓                                                       │
│  2. Peer sees lobby, opens 1:1 DM with host                 │
│     ↓                                                       │
│  3. Peer sends join request via encrypted DM                │
│     ↓                                                       │
│  4. Host accepts → sends GroupKey_v1 via DM                 │
│     ↓                                                       │
│  5. All members encrypt group messages with GroupKey        │
│     ↓                                                       │
│  6. Key rotates every 10 minutes (host distributes via DMs) │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## Self-Contained Design

The lobby module is fully self-contained and can be used in any application. It manages:

1. **Prefix Subscriptions** - Automatically subscribes/unsubscribes from
  group mailbox and DM mailbox prefixes via the session adapter
2. **DM Buffering** - Handles race conditions where DMs arrive before sessions
3. **Message Routing** - Routes lobby-related DMs and group messages internally
4. **Key Management** - Handles key rotation, key vault, and epoch versioning

## Files

| File | Description |
|------|-------------|
| `lobbyFacade.js` | **Primary API** - Clean, stable interface for lobby operations |
| `lobbyManager.js` | Internal lobby lifecycle management (use LobbyFacade instead) |
| `lobbyMessageHandler.js` | Routes incoming messages to handlers |
| `lobbyCodec.js` | XChaCha20-Poly1305 encryption for group messages |
| `lobbySchemas.js` | Validation functions for all lobby messages |
| `index.js` | Module exports |

## Quick Start Integration

### Minimal Setup

```javascript
import { KaspaAdapter } from './kktp/adapters/kaspaAdapter.js';
import { SessionFacade } from './kktp/protocol/sessions/sessionFacade.js';
import { LobbyFacade, LOBBY_STATES } from './kktp/lobby/index.js';

const adapter = new KaspaAdapter();
await adapter.init();
await adapter.connect({ networkId: 'testnet-10' });
await adapter.createOrOpenWallet({
  password: 'pw',
  walletFilename: 'demo.wallet',
});

const session = new SessionFacade(adapter);

// Create lobby facade with session manager
const lobby = new LobbyFacade(session, {
  autoAcceptJoins: true,
});

// Set up event handlers
lobby.onMemberJoin((member) => console.log(`${member.displayName} joined!`));
lobby.onGroupMessage((msg) => console.log(`${msg.senderName}: ${msg.plaintext}`));
lobby.onLobbyClose((reason) => console.log(`Lobby closed: ${reason}`));

// Host a lobby
await lobby.hostLobby({
  lobbyName: "My Game Lobby",
  gameName: "Chess",
});

// Send messages to all members
await lobby.sendGroupMessage("Hello everyone!");
```

### Simplified Message Routing

```javascript
// In your blockchain payload handler:
async function handleBlockchainPayload(rawPayload) {
  if (rawPayload.startsWith('KKTP:GROUP:')) {
    await lobby.processGroupPayload(rawPayload);
    return;
  }

  const event = await session.processIncomingPayload(rawPayload);
  if (event?.type === 'messages') {
    for (const msg of event.messages || []) {
      lobby.routeDMMessage(event.mailboxId, msg.plaintext ?? msg);
    }
  }
}
```

### Managing DM Subscriptions

When a session is established, subscribe to receive DMs:

```javascript
// When session is established (e.g., after processIncomingPayload)
const event = await session.processIncomingPayload(rawPayload);
if (event?.type === 'session_established') {
  lobby.subscribeToDMMailbox(event.mailboxId);
}
```

## Usage

### Hosting a Lobby

```javascript
import { KaspaAdapter } from './kktp/adapters/kaspaAdapter.js';
import { SessionFacade } from './kktp/protocol/sessions/sessionFacade.js';
import { LobbyFacade, LOBBY_STATES } from './kktp/lobby/index.js';

const adapter = new KaspaAdapter();
await adapter.init();
await adapter.connect({ networkId: 'testnet-10' });
await adapter.createOrOpenWallet({
  password: 'pw',
  walletFilename: 'demo.wallet',
});

const session = new SessionFacade(adapter);

const lobby = new LobbyFacade(session, {
  autoAcceptJoins: true,
});

// Set up event handlers
lobby.onMemberJoin((member) => {
  console.log(`${member.displayName} joined!`);
});

lobby.onGroupMessage((msg) => {
  console.log(`${msg.senderName}: ${msg.plaintext}`);
});

// Host a lobby
const { lobbyId, discovery } = await lobby.hostLobby({
  lobbyName: "My Game Lobby",
  gameName: "Chess",
  maxMembers: 8,
  uptimeSeconds: 3600,
});
```

### Joining a Lobby

```javascript
// Find a lobby in discovered peers
const lobbyDiscovery = discoveredPeers.find(p => p.meta?.lobby);

// Join it
await lobby.joinLobby(lobbyDiscovery, "PlayerName");
```

### Sending Group Messages

```javascript
// Send to all members
await lobby.sendGroupMessage("Hello everyone!");
```

### Routing Incoming Messages

The lobby facade provides APIs for routing incoming messages. Call these
from your event handler when processing blockchain payloads:

```javascript
// Route DM messages - returns true if handled as lobby message
const handled = lobby.routeDMMessage(mailboxId, plaintextJson);

// Parse and route group messages
await lobby.processGroupPayload(rawPayload);
```
```

### DM Message Buffering

Handle race conditions where DM arrives before session is established:

```javascript
// Buffer a DM for later processing
lobby.bufferDMMessage(mailboxId, payload, timestamp);

// When session is established, pop buffered messages
const buffered = lobby.popBufferedMessages(mailboxId);
for (const { payload, timestamp } of buffered) {
  // Process the buffered payload
}
```

### Managing Members (Host Only)

```javascript
// Kick a member
await lobby.kickMember(memberPubSig, "Reason");

// Rotate key manually
await lobby.rotateKey("Security refresh");

// Close lobby
await lobby.closeLobby("Game ended");
```

## Message Types

| Type | Direction | Description |
|------|-----------|-------------|
| `lobby_join_request` | Peer → Host | Request to join lobby |
| `lobby_join_response` | Host → Peer | Accept/reject with group key |
| `lobby_member_event` | Host → All | Member joined/left notification |
| `key_rotation` | Host → All | New group key distribution |
| `lobby_leave` | Peer → Host | Voluntary leave notification |
| `lobby_kicked` | Host → Peer | Kick notification |
| `lobby_close` | Host → All | Lobby shutdown |
| `group_message` | Any → Group | Encrypted group message |

## Security

### Encryption
- **Group Messages**: XChaCha20-Poly1305 with 24-byte random nonce
- **AAD**: `groupMailboxId || keyVersion` (domain separation)
- **Key Size**: 32 bytes (256-bit)

### Key Rotation
- Automatic every 10 minutes
- Manual rotation on member kick (forward secrecy)
- State root commitment for roster integrity

### Trust Model
- Host is trusted for key distribution
- All DM channels use KKTP's existing encryption
- Members cannot impersonate each other (signed messages)

## Discovery Schema Extension

The lobby extends the KKTP discovery anchor with:

```json
{
  "meta": {
    "game": "string",
    "version": "string",
    "expected_uptime_seconds": 3600,
    "lobby": true,
    "lobby_name": "My Lobby",
    "max_members": 16
  }
}
```

## States

| State | Description |
|-------|-------------|
| `IDLE` | Not in any lobby |
| `HOSTING` | Hosting a lobby as host |
| `JOINING` | Sent join request, waiting for response |
| `MEMBER` | Active lobby member |
| `CLOSED` | Lobby was closed |

## Events

```javascript
lobby.onMemberJoin((member) => { });
lobby.onMemberLeave((pubSig, reason) => { });
lobby.onGroupMessage((msg) => { });
lobby.onKeyRotation((version) => { });
lobby.onLobbyClose((reason) => { });
lobby.onStateChange((newState, oldState) => { });
```

## Configuration

```javascript
const lobby = new LobbyFacade(sessionManager, {
  maxMembers: 16,          // Default max members
  keyRotationMs: 600000,   // 10 minutes
  autoAcceptJoins: true,   // Auto-accept join requests
});
```

## API Reference

### LobbyFacade Methods

#### Lifecycle

| Method | Description |
|--------|-------------|
| `hostLobby(options)` | Host a new lobby |
| `joinLobby(discovery, name)` | Join an existing lobby |
| `leaveLobby(reason)` | Leave lobby (member) |
| `closeLobby(reason)` | Close lobby (host) |
| `sendGroupMessage(text)` | Send message to lobby group |

#### Message Routing

| Method | Description |
|--------|-------------|
| `processGroupPayload(payload)` | Process raw group payload (full flow) |
| `routeDMMessage(id, text)` | Route decrypted DM, returns true if handled |
| `routeGroupMessage(id, enc)` | Process encrypted group message |
| `isRelevantMailbox(id)` | Check if DM mailbox is relevant to lobby |

#### Prefix Subscription (Self-contained)

| Method | Description |
|--------|-------------|
| `subscribeToDMMailbox(id)` | Subscribe to DM mailbox for receiving messages |
| `unsubscribeFromDMMailbox(id)` | Unsubscribe from DM mailbox |

#### DM Buffering

| Method | Description |
|--------|-------------|
| `bufferDMMessage(id, payload)` | Buffer DM for later processing |
| `popBufferedMessages(id)` | Get and clear buffered messages |

#### State Accessors

| Property/Method | Description |
|-----------------|-------------|
| `currentState` | Current lobby state (IDLE, HOSTING, etc.) |
| `lobbyInfo` | Current lobby information |
| `members` | Array of lobby members |
| `messageHistory` | Array of group messages |
| `isHost` | True if hosting the lobby |
| `isInLobby()` | Check if in a lobby |
| `getGroupMailboxId()` | Get current group mailbox ID |
| `pendingJoinRequests` | Pending join requests (host only) |

#### Member Management (Host Only)

| Method | Description |
|--------|-------------|
| `acceptPendingJoin(pubSig)` | Accept a pending join request |
| `rejectPendingJoin(pubSig, reason)` | Reject a pending join request |
| `kickMember(pubSig, reason)` | Kick a member from the lobby |
| `rotateKey(reason)` | Manually rotate the group key |

## License

See main project LICENSE.
