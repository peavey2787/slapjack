/**
 * deck.js — Card model, deck creation, and suit/rank constants.
 *
 * Pure data module — no DOM, no engine dependency.
 */

export const SUITS  = ['♠', '♥', '♦', '♣'];
export const RANKS  = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

/**
 * @typedef {Object} Card
 * @property {string} rank  - 'A', '2'–'10', 'J', 'Q', 'K'
 * @property {string} suit  - '♠', '♥', '♦', '♣'
 * @property {string} id    - Unique identifier e.g. 'J♠'
 * @property {boolean} isRed - True for hearts/diamonds
 */

/**
 * Create a fresh 52-card deck (unshuffled).
 * @returns {Card[]}
 */
export function createDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({
        rank,
        suit,
        id: `${rank}${suit}`,
        isRed: suit === '♥' || suit === '♦',
      });
    }
  }
  return deck;
}

/**
 * Check if a card is a Jack.
 * @param {Card} card
 * @returns {boolean}
 */
export function isJack(card) {
  return card?.rank === 'J';
}

/**
 * Split a deck array into N roughly-equal hands.
 * @param {Card[]} deck
 * @param {number} n - Number of players
 * @returns {Card[][]}
 */
export function dealHands(deck, n) {
  const hands = Array.from({ length: n }, () => []);
  deck.forEach((card, i) => hands[i % n].push(card));
  return hands;
}

/**
 * Local Fisher-Yates shuffle (fallback when VRF unavailable).
 * @param {Card[]} deck
 * @returns {Card[]}
 */
export function localShuffle(deck) {
  const a = [...deck];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
