# Slap Jack (Kaspa Kinesis Demo)

Slap Jack is a **demo game** built with the **KKGameEngine (Kaspa Kinesis game engine facade)** in this repository.
It showcases a browser-based multiplayer card game with lobby/chat flow, on-chain move recording, and VRF-assisted fairness.

---

## What this demo is

- A vanilla JS + CSS browser game mounted from `index.html` (repo root) and `slapjack/js/app.js`.
- A practical integration sample for `kktp/kkGameEngine.js` through a thin app bridge (`slapjack/js/engine/bridge.js`).
- A 2-player Slap Jack rules implementation with:
  - turn-based flips,
  - slap window handling,
  - wrong-slap penalties,
  - VRF tie-breaking.

## What this demo is not

- Not a production wallet/login UX (credentials are hardcoded for demo auto-login).
- Not generalized beyond current game assumptions (current match flow is 2-player).

---

## Engine framing (Kaspa Kinesis / KKGameEngine)

The game does **not** call low-level blockchain logic directly.
It uses `slapjack/js/engine/bridge.js` as the integration boundary, which wraps `KKGameEngine` and exposes only the methods this game needs:

- Engine init/lifecycle (`initEngine`, `shutdown`)
- Wallet state (`getAddress`, `getBalance`, `refreshBalance`)
- Lobby flow (`createLobby`, `joinLobby`, `leaveLobby`, `sendChat`, `signalReady`, `signalGameStart`)
- Game anchoring (`startGame`, `recordMove`, `endGame`)
- Randomness (`getRandom`, `shuffle`)

Bridge event forwarding maps engine events to app events in `slapjack/js/utils/events.js`.

---

## Current runtime defaults (as implemented)

From `slapjack/js/engine/bridge.js`:

- `DEFAULT_PASSWORD = "slapjack2024!"`
- `DEFAULT_WALLET = "slapjack2"`
- `NETWORK = "testnet-10"`

Import path currently used by the bridge:

- `import { KKGameEngine, GameEvent } from '/finalTest/kktp/kkGameEngine.js';`

That absolute path must resolve in your web server context for the demo to run unchanged.

---

## Gameplay rules implemented

Defined in `slapjack/js/game/slapjackRules.js` + `slapjack/js/engine/slapJudge.js`:

- Deck: standard 52 cards.
- Match type: 2-player state machine.
- Win target: first to **5 rounds** (`winTarget = 5` in game startup).
- Turn flow:
  - players alternate flipping one card to the pile,
  - if card is Jack, phase opens for slaps.
- Valid slap: top pile card is Jack.
- Wrong slap: player pays **2-card penalty** from their hand to pile bottom.
- Tie logic:
  - simultaneous slap window = **400ms**,
  - ties resolved with VRF (`breakTie`) seeded by pile/player state.

---

## Multiplayer and synchronization behavior

Implemented in `slapjack/js/game/gameController.js`:

- Local actions (`flip`, `slap`) are:
  1. applied to local rules state,
  2. recorded via `Bridge.recordMove(...)`,
  3. broadcast via lobby game-action messages.
- Opponent actions are accepted through both:
  - raw message channel parsing (`MESSAGE_RECEIVED`), and
  - anchored opponent move events (`OPPONENT_MOVE_ANCHORED`).
- Duplicate remote actions are deduped with a bounded key cache.

### Deck synchronization

- Host sends `deckIds` in game start payload.
- `startMatch(...)` prefers host-provided `deckIds`; otherwise shuffles locally/engine-side.

### Reshuffle behavior

When both players run out of cards:

- lexicographically smallest player id becomes reshuffle leader,
- leader generates reshuffle deck ids,
- reshuffle action is broadcast,
- both clients rehydrate hands from that shared deck order.

---

## Lobby behavior in this demo

Implemented in `slapjack/js/screens/lobbyScreen.js`:

- Create flow calls `createLobby('Slap Jack', 4)`.
- Join flow uses join code + display name.
- Chat panel sends `type: 'chat'` lobby messages.
- Ready toggles send `type: 'ready_state'`.
- Start game sends `type: 'game_start'` payload with:
  - `gameId`,
  - `playerIds`,
  - `hostId`, `guestId`,
  - `firstTurnId` (host),
  - `deckIds`.

> Note: lobby max is set to 4, but game state and start config currently assume a head-to-head match.

---

## UI architecture

- `slapjack/js/app.js` — boot, engine init, screen navigation
- `slapjack/js/screens/menuScreen.js` — create/join entry and rules blurb
- `slapjack/js/screens/lobbyScreen.js` — member list, chat, ready/start, join code
- `slapjack/js/screens/gameScreen.js` — table, pile, deck counters, flip/slap controls
- `slapjack/js/screens/resultsScreen.js` — final result screen + end-game anchor
- `slapjack/js/components/*` — reusable HUD/chat/toast/card rendering
- `slapjack/css/*` — tokens, layout, components, cards, animation

---

## Running the demo

1. Serve repository root (`index.html`) from an HTTP server.
2. Ensure the engine import path in `slapjack/js/engine/bridge.js` resolves:
   - `/finalTest/kktp/kkGameEngine.js`
3. Open:
   - `http://<your-host>/index.html`
4. Use two browser sessions/clients to validate multiplayer flow.

---

## Known demo constraints

- Hardcoded auto-login credentials (demo convenience).
- Current in-game rules/state are 2-player.
- Start button visibility is host-based; readiness logic is simple and event-driven.
- `endMatch()` is attempted from the results screen; failures are swallowed as non-fatal UI behavior.

---

## Why this is useful as a Kaspa Kinesis demo

This project demonstrates how to keep game logic/UI clean while delegating blockchain duties to Kaspa Kinesis (`KKGameEngine`):

- fairness primitives (VRF random / tie-breaks),
- move anchoring lifecycle (`startGame` → `recordMove` → `endGame`),
- lobby/session messaging,
- wallet and balance visibility.

It is a concise reference implementation for integrating a real-time browser game with the engine facade in `kktp/`.
