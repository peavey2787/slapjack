/**
 * slapjackRules.js — Pure game rules for Slap Jack.
 *
 * Manages the state machine: whose turn, pile, hands, scores.
 * No DOM, no engine calls — just logic.
 */

import { isJack } from './deck.js';

/** Game phases */
export const Phase = {
  WAITING:   'waiting',
  PLAYING:   'playing',
  SLAP_OPEN: 'slapOpen',   // Jack revealed, awaiting slaps
  RESOLVING: 'resolving',  // Tie-break or slap winner chosen
  ROUND_END: 'roundEnd',
  GAME_OVER: 'gameOver',
};

/**
 * Create initial game state for a 2-player Slap Jack match.
 *
 * @param {Object} opts
 * @param {Array}  opts.hand1 - Player 1's dealt cards
 * @param {Array}  opts.hand2 - Player 2's dealt cards
 * @param {string} opts.player1Id
 * @param {string} opts.player2Id
 * @returns {Object} state
 */
export function createGameState({ hand1, hand2, player1Id, player2Id }) {
  return {
    phase: Phase.PLAYING,
    pile: [],
    hands: {
      [player1Id]: [...hand1],
      [player2Id]: [...hand2],
    },
    scores: {
      [player1Id]: 0,
      [player2Id]: 0,
    },
    currentTurn: player1Id,
    players: [player1Id, player2Id],
    slapTimestamps: {},   // playerId → timestamp of slap
    lastFlipTime: 0,
    penaltyCards: 2,      // penalty for wrong slap
    winTarget: 5,         // rounds to win
  };
}

/**
 * Flip the top card of the current player's hand onto the pile.
 *
 * @param {Object} state
 * @returns {{ card: Object|null, isJack: boolean }}
 */
export function flipCard(state) {
  const playerId = state.currentTurn;
  const hand = state.hands[playerId];

  if (!hand || hand.length === 0) {
    return { card: null, isJack: false };
  }

  const card = hand.shift();
  state.pile.push(card);
  state.lastFlipTime = Date.now();

  if (isJack(card)) {
    state.phase = Phase.SLAP_OPEN;
    state.slapTimestamps = {};
  } else {
    // Advance turn
    _advanceTurn(state);
  }

  return { card, isJack: isJack(card) };
}

/**
 * Record a slap attempt.
 *
 * @param {Object} state
 * @param {string} playerId
 * @returns {{ valid: boolean, penalty: boolean }}
 */
export function recordSlap(state, playerId) {
  const topCard = state.pile[state.pile.length - 1];

  if (!isJack(topCard)) {
    // Wrong slap — penalty: give cards from hand to pile
    _applyPenalty(state, playerId);
    return { valid: false, penalty: true };
  }

  // Valid slap
  state.slapTimestamps[playerId] = Date.now();
  return { valid: true, penalty: false };
}

/**
 * Award the pile to the winner after slap resolution.
 *
 * @param {Object} state
 * @param {string} winnerId
 * @returns {{ roundOver: boolean, gameOver: boolean, winnerId: string }}
 */
export function awardPile(state, winnerId) {
  state.scores[winnerId] += 1;
  state.pile = [];
  state.phase = Phase.PLAYING;
  state.slapTimestamps = {};

  // Next turn goes to the winner
  state.currentTurn = winnerId;

  const gameOver = state.scores[winnerId] >= state.winTarget;
  if (gameOver) {
    state.phase = Phase.GAME_OVER;
  }

  return { roundOver: true, gameOver, winnerId };
}

/**
 * Get the current top card of the pile (the visible one).
 * @param {Object} state
 * @returns {Object|null}
 */
export function topCard(state) {
  return state.pile.length > 0 ? state.pile[state.pile.length - 1] : null;
}

/**
 * Check if the game is in a slappable state.
 * @param {Object} state
 * @returns {boolean}
 */
export function isSlapOpen(state) {
  return state.phase === Phase.SLAP_OPEN;
}

/**
 * Check if a player can flip (it's their turn and phase is PLAYING).
 * @param {Object} state
 * @param {string} playerId
 * @returns {boolean}
 */
export function canFlip(state, playerId) {
  return state.phase === Phase.PLAYING && state.currentTurn === playerId;
}

/**
 * Get winner if game is over.
 * @param {Object} state
 * @returns {string|null}
 */
export function getWinner(state) {
  if (state.phase !== Phase.GAME_OVER) return null;
  return state.players.reduce((a, b) =>
    state.scores[a] >= state.scores[b] ? a : b
  );
}

/**
 * Count remaining cards for a player.
 * @param {Object} state
 * @param {string} playerId
 * @returns {number}
 */
export function handSize(state, playerId) {
  return state.hands[playerId]?.length ?? 0;
}

// ── Private ──

function _advanceTurn(state) {
  const idx = state.players.indexOf(state.currentTurn);
  state.currentTurn = state.players[(idx + 1) % state.players.length];
}

function _applyPenalty(state, playerId) {
  const hand = state.hands[playerId];
  if (!hand) return;
  const count = Math.min(state.penaltyCards, hand.length);
  for (let i = 0; i < count; i++) {
    const card = hand.shift();
    if (card) state.pile.unshift(card); // penalty cards go to bottom of pile
  }
}
