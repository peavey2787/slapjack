/**
 * bridge.js — Thin wrapper around KKGameEngine.
 *
 * Handles auto-login, default credentials, and re-exposes only the
 * methods the game needs. All blockchain complexity stays here.
 */

import { KKGameEngine, GameEvent } from '/finalTest/kktp/kkGameEngine.js';
import { emit, AppEvent } from '../utils/events.js';

/* ── Default credentials (auto-login, no password prompt) ── */
const DEFAULT_PASSWORD  = 'slapjack2024!';
const DEFAULT_WALLET    = 'slapjack2';
const NETWORK           = 'testnet-10';

/** Singleton engine instance */
const engine = new KKGameEngine();

/** Initialisation state */
let _ready    = false;
let _initTask = null;

// ───────────────────────────────────────────────────────
// Lifecycle
// ───────────────────────────────────────────────────────

/**
 * Auto-initialise the engine with hardcoded credentials.
 * Safe to call multiple times — deduplicates.
 * @returns {Promise<{address: string, balance: number}>}
 */
export async function initEngine() {
  if (_ready) return { address: engine.address, balance: engine.balance };
  if (_initTask) return _initTask;

  _initTask = (async () => {
    try {
      const result = await engine.init({
        password:  DEFAULT_PASSWORD,
        walletName: DEFAULT_WALLET,
        network:   NETWORK,
      });

      _wireEvents();
      _ready = true;
      emit(AppEvent.ENGINE_READY, result);
      return result;
    } catch (err) {
      emit(AppEvent.ENGINE_ERROR, err);
      throw err;
    } finally {
      _initTask = null;
    }
  })();

  return _initTask;
}

/** Forward engine events → app event bus */
function _wireEvents() {
  engine.on(GameEvent.BALANCE_CHANGED, (d) =>
    emit(AppEvent.BALANCE_UPDATE, d));

  engine.on(GameEvent.PLAYER_JOINED, (d) =>
    emit(AppEvent.LOBBY_MEMBERS, { type: 'joined', member: d }));

  engine.on(GameEvent.PLAYER_LEFT, (d) =>
    emit(AppEvent.LOBBY_MEMBERS, { type: 'left', member: d }));

  engine.on(GameEvent.CHAT_MESSAGE, (d) =>
    emit(AppEvent.LOBBY_CHAT, d));

  engine.on(GameEvent.LOBBY_CLOSED, (d) =>
    emit(AppEvent.LOBBY_CLOSED, d));

  engine.on(GameEvent.READY_STATE, (d) =>
    emit(AppEvent.LOBBY_READY, d));

  engine.on(GameEvent.GAME_START, (d) =>
    emit(AppEvent.GAME_START, d));

  engine.on(GameEvent.MESSAGE_RECEIVED, (d) => {
    _handleGameMessage(d);
  });

  engine.on(GameEvent.OPPONENT_MOVE_ANCHORED, (d) => {
    _handleOpponentMove(d);
  });
}

/** Route raw lobby messages that carry game actions */
function _handleGameMessage(msg) {
  const text = msg?.text;
  if (typeof text !== 'string') return;
  const senderId = msg?.senderId ?? null;
  const senderName = msg?.senderName ?? null;
  try {
    const parsed = JSON.parse(text);
    if (parsed.type === 'slap') {
      emit(AppEvent.OPPONENT_SLAP, { ...parsed, senderId, senderName });
    } else if (parsed.type === 'flip') {
      emit(AppEvent.OPPONENT_FLIP, { ...parsed, senderId, senderName });
    } else if (parsed.type === 'reshuffle') {
      emit(AppEvent.OPPONENT_RESHUFFLE, { ...parsed, senderId, senderName });
    }
  } catch { /* not json — ignore */ }
}

/** Handle opponent moves from anchor heartbeat pipeline */
function _handleOpponentMove(move) {
  if (move?.action === 'slap') emit(AppEvent.OPPONENT_SLAP, move);
  if (move?.action === 'flip') emit(AppEvent.OPPONENT_FLIP, move);
  if (move?.action === 'reshuffle') emit(AppEvent.OPPONENT_RESHUFFLE, move);
}

// ───────────────────────────────────────────────────────
// Wallet
// ───────────────────────────────────────────────────────

export function getAddress() { return engine.address; }
export function getBalance() { return engine.balance; }
export async function refreshBalance() { return engine.getBalance(); }

// ───────────────────────────────────────────────────────
// Lobby
// ───────────────────────────────────────────────────────

export async function createLobby(name = 'Slap Jack', maxPlayers = 2) {
  return engine.createLobby({ name, maxPlayers, gameName: 'SlapJack' });
}

export async function joinLobby(code, displayName) {
  return engine.joinLobby(code, displayName);
}

export async function leaveLobby() {
  return engine.leaveLobby('User left');
}

export async function sendChat(text) {
  return engine.sendLobbyMessage({ type: 'chat', text, timestamp: Date.now() });
}

export async function sendGameAction(action) {
  return engine.sendLobbyMessage(action);
}

export function getLobbyMembers() { return engine.getLobbyMembers(); }
export function isHost()         { return engine.isLobbyHost; }
export function isInLobby()      { return engine.isInLobby(); }

export async function signalReady(isReady) {
  return engine.sendLobbyMessage({
    type: 'ready_state',
    isReady,
    timestamp: Date.now(),
  });
}

export async function signalGameStart(gameConfig) {
  return engine.sendLobbyMessage({
    type: 'game_start',
    ...gameConfig,
    timestamp: Date.now(),
  });
}

// ───────────────────────────────────────────────────────
// Game session
// ───────────────────────────────────────────────────────

export async function startGame(gameId, playerId) {
  await engine.prepareUtxoPool();
  return engine.startGame({
    gameId,
    playerId,
    customActionMap: { flip: 1, slap: 2, win_pile: 3 },
  });
}

export async function recordMove(action, data = {}) {
  return engine.recordMove(action, data);
}

export async function endGame(endState) {
  return engine.endGame(endState);
}

// ───────────────────────────────────────────────────────
// VRF / Randomness
// ───────────────────────────────────────────────────────

export async function getRandom(seed) {
  return engine.getRandom({ seed });
}

export async function shuffle(array) {
  return engine.shuffle(array);
}

export async function shutdown() {
  await engine.shutdown();
  _ready = false;
}

/** Expose raw engine for advanced usage (debugging) */
export function rawEngine() { return engine; }
