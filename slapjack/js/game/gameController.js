/**
 * gameController.js — Orchestrates a Slap Jack match.
 *
 * Glues rules, VRF judge, and engine bridge together.
 * Emits app events so the game screen can react.
 */

import * as Rules from './slapjackRules.js';
import { createDeck, dealHands, localShuffle } from './deck.js';
import * as Judge from '../engine/slapJudge.js';
import * as Bridge from '../engine/bridge.js';
import { emit, on, AppEvent } from '../utils/events.js';

let _state    = null;
let _localId  = null;
let _remoteId = null;
let _gameId   = null;
let _unsubs   = [];
let _seenRemoteActions = new Set();

function _reshuffleLeaderId() {
  if (!_state?.players?.length) return _localId;
  return [..._state.players].sort((a, b) => a.localeCompare(b))[0];
}

function _remoteActionKey(type, data = {}) {
  const actorId = data?.playerId ?? data?.senderId ?? 'unknown';
  const cardId = data?.card?.id ?? 'none';
  const valid = typeof data?.valid === 'boolean' ? String(data.valid) : 'na';
  const ts = data?.timestamp ?? 'no-ts';
  return `${type}|${actorId}|${cardId}|${valid}|${ts}`;
}

function _isDuplicateRemoteAction(type, data = {}) {
  const key = _remoteActionKey(type, data);
  if (_seenRemoteActions.has(key)) return true;
  _seenRemoteActions.add(key);
  if (_seenRemoteActions.size > 500) {
    const first = _seenRemoteActions.values().next().value;
    if (first) _seenRemoteActions.delete(first);
  }
  return false;
}

function _buildDeckFromIds(deckIds) {
  if (!Array.isArray(deckIds) || deckIds.length === 0) return null;
  const byId = new Map(createDeck().map((card) => [card.id, card]));
  const deck = deckIds
    .map((id) => byId.get(id))
    .filter(Boolean)
    .map((card) => ({ ...card }));
  return deck.length === 52 ? deck : null;
}

function _applyReshuffleDeck(deckIds) {
  const deck = _buildDeckFromIds(deckIds);
  if (!deck || !_state) return false;

  const [hand1, hand2] = dealHands(deck, 2);
  const players = [..._state.players].sort((a, b) => a.localeCompare(b));
  const previousTurn = _state.currentTurn;

  _state.hands = {
    [players[0]]: hand1,
    [players[1]]: hand2,
  };
  _state.pile = [];
  _state.phase = Rules.Phase.PLAYING;
  _state.slapTimestamps = {};

  const previousTurnHasCards = previousTurn && (_state.hands[previousTurn]?.length ?? 0) > 0;
  _state.currentTurn = previousTurnHasCards ? previousTurn : players[0];
  return true;
}

async function _generateReshuffleDeckIds() {
  let deck;
  try {
    deck = await Bridge.shuffle(createDeck());
  } catch {
    deck = localShuffle(createDeck());
  }

  try {
    const random = await Bridge.getRandom(`slapjack-reshuffle-${_gameId}-${Date.now()}-${Math.random()}`);
    const hex = typeof random?.value === 'string' ? random.value.slice(0, 8) : '';
    const rotateBy = (parseInt(hex || '0', 16) || 0) % deck.length;
    if (rotateBy > 0) {
      deck = [...deck.slice(rotateBy), ...deck.slice(0, rotateBy)];
    }
  } catch {
  }

  return deck.map((card) => card.id);
}

async function _maybeReshuffleIfNeeded(reason = 'empty_hands') {
  if (!_state || Rules.getWinner(_state)) return false;

  const allEmpty = _state.players.every((playerId) => (Rules.handSize(_state, playerId) ?? 0) === 0);
  if (!allEmpty) return false;

  if (_localId !== _reshuffleLeaderId()) return false;

  const deckIds = await _generateReshuffleDeckIds();
  const applied = _applyReshuffleDeck(deckIds);
  if (!applied) return false;

  try {
    await Bridge.sendGameAction({
      type: 'reshuffle',
      playerId: _localId,
      deckIds,
      reason,
      timestamp: Date.now(),
    });
  } catch {
  }

  emit(AppEvent.CARD_FLIPPED, {
    card: null,
    isJack: false,
    flipper: _localId,
    state: snapshot(),
  });

  return true;
}

// ───────────────────────────────────────────────────────
// Public API
// ───────────────────────────────────────────────────────

/**
 * Initialise and start a new match.
 *
 * @param {Object} opts
 * @param {string} opts.localId  - This player's id
 * @param {string} opts.remoteId - Opponent's id
 * @param {string} [opts.gameId]
 * @param {number} [opts.winTarget=5]
 * @returns {Promise<Object>} Initial game state snapshot
 */
export async function startMatch({ localId, remoteId, gameId, firstTurnId, deckIds, winTarget = 5 }) {
  // Ensure we don't stack subscriptions across restarts/rejoins.
  _unsubs.forEach((fn) => fn());
  _unsubs = [];
  _seenRemoteActions = new Set();

  _localId  = localId;
  _remoteId = remoteId;
  _gameId   = gameId || `sj-${Date.now()}`;

  const orderedPlayers = [_localId, _remoteId]
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
  const [playerA, playerB] = orderedPlayers;

  // Prefer host-provided shared deck for deterministic multiplayer sync.
  let deck = _buildDeckFromIds(deckIds);

  // Fallback: Shuffle with VRF when possible, local otherwise.
  if (!deck) {
    try {
      deck = await Bridge.shuffle(createDeck());
    } catch {
      deck = localShuffle(createDeck());
    }
  }

  const [hand1, hand2] = dealHands(deck, 2);

  _state = Rules.createGameState({
    hand1,
    hand2,
    player1Id: playerA,
    player2Id: playerB,
  });
  const players = [playerA, playerB].filter(Boolean);
  _state.currentTurn = players.includes(firstTurnId) ? firstTurnId : (playerA || _localId);
  if (!players.includes(_state.currentTurn)) {
    _state.currentTurn = players[0] || _localId;
  }
  _state.winTarget = winTarget;

  // Start blockchain game session
  try {
    await Bridge.startGame(_gameId, _localId);
  } catch (e) {
    console.warn('[GameController] Engine startGame failed:', e.message);
  }

  _wireOpponentEvents();

  return snapshot();
}

/**
 * Local player flips a card (their turn).
 * @returns {Promise<Object|null>} { card, isJack } or null if not your turn
 */
export async function flip() {
  if (!_state || !Rules.canFlip(_state, _localId)) return null;

  const result = Rules.flipCard(_state);
  if (!result?.card) {
    await _maybeReshuffleIfNeeded('flip_no_card');
    emit(AppEvent.CARD_FLIPPED, {
      card: null,
      isJack: false,
      flipper: _localId,
      state: snapshot(),
    });
    return null;
  }

  // Record on chain
  try {
    await Bridge.recordMove('flip', { cardId: result.card?.id });
  } catch { /* non-critical */ }

  // Broadcast to opponent
  try {
    await Bridge.sendGameAction({
      type: 'flip',
      playerId: _localId,
      card: result.card,
      timestamp: Date.now(),
    });
  } catch { /* non-critical */ }

  emit(AppEvent.CARD_FLIPPED, {
    card: result.card,
    isJack: result.isJack,
    flipper: _localId,
    state: snapshot(),
  });

  return result;
}

/**
 * Local player slaps.
 * @returns {Promise<Object>} Slap result
 */
export async function slap() {
  if (!_state) return { valid: false };

  const result = Rules.recordSlap(_state, _localId);

  // Record on chain
  try {
    await Bridge.recordMove('slap', { valid: result.valid });
  } catch { /* non-critical */ }

  // Broadcast to opponent
  try {
    await Bridge.sendGameAction({
      type: 'slap',
      playerId: _localId,
      valid: result.valid,
      timestamp: Date.now(),
    });
  } catch { /* non-critical */ }

  if (!result.valid) {
    emit(AppEvent.SLAP_RESULT, {
      playerId: _localId,
      valid: false,
      penalty: true,
      state: snapshot(),
    });
    return result;
  }

  // Valid slap — resolve (check for tie)
  await _resolveSlap(_localId);
  return result;
}

/**
 * End the current match and anchor final state.
 * @returns {Promise<Object|null>} endGame result
 */
export async function endMatch() {
  if (!_state) return null;

  const winner = Rules.getWinner(_state) ?? _localId;
  const result  = _state.scores;

  // Unsubscribe
  _unsubs.forEach(fn => fn());
  _unsubs = [];

  try {
    const endResult = await Bridge.endGame({
      result: winner === _localId ? 'win' : 'lose',
      score: result[_localId],
      opponentScore: result[_remoteId],
    });
    return endResult;
  } catch (e) {
    console.warn('[GameController] endGame error:', e.message);
    return null;
  }
}

/**
 * Get a snapshot of current game state for UI.
 * @returns {Object}
 */
export function snapshot() {
  if (!_state) return null;
  return {
    phase: _state.phase,
    pile: [..._state.pile],
    topCard: Rules.topCard(_state),
    scores: { ..._state.scores },
    currentTurn: _state.currentTurn,
    isMyTurn: _state.currentTurn === _localId,
    myHandSize: Rules.handSize(_state, _localId),
    opponentHandSize: Rules.handSize(_state, _remoteId),
    isSlapOpen: Rules.isSlapOpen(_state),
    localId: _localId,
    remoteId: _remoteId,
    winner: Rules.getWinner(_state),
  };
}

// ───────────────────────────────────────────────────────
// Opponent events
// ───────────────────────────────────────────────────────

function _wireOpponentEvents() {
  _unsubs.push(
    on(AppEvent.OPPONENT_FLIP, _handleOpponentFlip),
    on(AppEvent.OPPONENT_SLAP, _handleOpponentSlap),
    on(AppEvent.OPPONENT_RESHUFFLE, _handleOpponentReshuffle),
  );
}

function _handleOpponentFlip(data) {
  if ((data?.senderId && data.senderId === _localId) || data?.playerId === _localId) return;
  if (!_state || !data?.card) return;
  if (_isDuplicateRemoteAction('flip', data)) return;

  const actorId = data?.playerId ?? _remoteId;
  if (!_state.players.includes(actorId)) return;

  // Apply the flip to our state using authoritative actor id.
  if (_state.phase === Rules.Phase.PLAYING && _state.currentTurn !== actorId) {
    _state.currentTurn = actorId;
  }

  if (Rules.canFlip(_state, actorId)) {
    Rules.flipCard(_state);
  }

  emit(AppEvent.CARD_FLIPPED, {
    card: data.card,
    isJack: data.card?.rank === 'J',
    flipper: actorId,
    state: snapshot(),
  });

  void _maybeReshuffleIfNeeded('after_opponent_flip');
}

async function _handleOpponentSlap(data) {
  if ((data?.senderId && data.senderId === _localId) || data?.playerId === _localId) return;
  if (!_state) return;
  if (_isDuplicateRemoteAction('slap', data)) return;

  const actorId = data?.playerId ?? _remoteId;
  if (!_state.players.includes(actorId)) return;

  if (!data?.valid) {
    // Opponent made a wrong slap — apply penalty on our copy
    Rules.recordSlap(_state, actorId);
    emit(AppEvent.SLAP_RESULT, {
      playerId: actorId,
      valid: false,
      penalty: true,
      state: snapshot(),
    });
    return;
  }

  // Opponent valid slap — record and resolve
  Rules.recordSlap(_state, actorId);
  await _resolveSlap(actorId);
}

function _handleOpponentReshuffle(data) {
  if ((data?.senderId && data.senderId === _localId) || data?.playerId === _localId) return;
  if (!_state) return;
  if (_isDuplicateRemoteAction('reshuffle', data)) return;

  const applied = _applyReshuffleDeck(data?.deckIds);
  if (!applied) return;

  emit(AppEvent.CARD_FLIPPED, {
    card: null,
    isJack: false,
    flipper: data?.playerId ?? _remoteId,
    state: snapshot(),
  });
}

// ───────────────────────────────────────────────────────
// Slap resolution with VRF tie-breaking
// ───────────────────────────────────────────────────────

async function _resolveSlap(slapperId) {
  const timestamps = _state.slapTimestamps;
  const otherPlayer = _state.players.find(p => p !== slapperId);

  // Check for simultaneous slap (tie window)
  if (timestamps[otherPlayer] &&
      Judge.isWithinTieWindow(timestamps[slapperId], timestamps[otherPlayer])) {
    // TIE! Use VRF
    _state.phase = Rules.Phase.RESOLVING;
    const pileHash = _state.pile.map(c => c.id).join(',');

    const tie = await Judge.breakTie(pileHash, _state.players[0], _state.players[1]);

    const award = Rules.awardPile(_state, tie.winnerId);

    emit(AppEvent.ROUND_WON, {
      winnerId: tie.winnerId,
      wasTie: true,
      vrfNumber: tie.vrfNumber,
      state: snapshot(),
    });

    if (award.gameOver) {
      emit(AppEvent.GAME_OVER, { winnerId: tie.winnerId, scores: { ..._state.scores } });
    }
    return;
  }

  // Solo slap — slapper wins
  const award = Rules.awardPile(_state, slapperId);

  emit(AppEvent.ROUND_WON, {
    winnerId: slapperId,
    wasTie: false,
    state: snapshot(),
  });

  if (award.gameOver) {
    emit(AppEvent.GAME_OVER, { winnerId: slapperId, scores: { ..._state.scores } });
  } else {
    await _maybeReshuffleIfNeeded('after_round');
  }
}
