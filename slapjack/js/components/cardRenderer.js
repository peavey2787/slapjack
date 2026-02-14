/**
 * cardRenderer.js — Renders a Card object into a DOM element.
 *
 * Pure rendering — no game logic.
 */

import { el } from '../utils/dom.js';

/**
 * Create a visual card element.
 *
 * @param {Object} card - { rank, suit, isRed, id }
 * @param {Object} [opts]
 * @param {boolean} [opts.faceDown=false]
 * @param {string}  [opts.size] - 'card-lg' for larger size
 * @returns {HTMLElement}
 */
export function renderCard(card, opts = {}) {
  const faceDown = opts.faceDown ?? false;
  const sizeClass = opts.size ?? '';

  const isRed = card.isRed;
  const isJ = card.rank === 'J';

  const front = el('div', {
    className: `card-face card-front${isRed ? ' red' : ''}`,
  },
    el('span', { className: 'card-corner top-left', innerHTML: `${card.rank}<br>${card.suit}` }),
    el('span', { className: 'card-rank', textContent: card.rank }),
    el('span', { className: 'card-suit', textContent: card.suit }),
    el('span', { className: 'card-corner bottom-right', innerHTML: `${card.rank}<br>${card.suit}` }),
  );

  const back = el('div', { className: 'card-face card-back' });

  const cardEl = el('div', {
    className: `card ${faceDown ? 'face-down' : 'face-up'} ${sizeClass} ${isJ ? 'is-jack' : ''}`.trim(),
    dataset: { cardId: card.id },
  }, front, back);

  return cardEl;
}

/**
 * Create a face-down card (deck back).
 *
 * @param {Object} [opts]
 * @param {string} [opts.size]
 * @returns {HTMLElement}
 */
export function renderCardBack(opts = {}) {
  const sizeClass = opts.size ?? '';
  const back = el('div', { className: 'card-face card-back' });
  return el('div', { className: `card face-down ${sizeClass}`.trim() }, back);
}

/**
 * Create a deck stack visual (3 stacked face-down cards).
 *
 * @param {number} count - Number of cards in the deck (shown as label)
 * @param {Object} [opts]
 * @returns {HTMLElement}
 */
export function renderDeckStack(count, opts = {}) {
  const size = opts.size ?? '';
  const stack = el('div', { className: 'deck-stack' });

  // Show up to 3 stacked cards
  const visible = Math.min(count, 3);
  for (let i = 0; i < visible; i++) {
    stack.append(renderCardBack({ size }));
  }

  if (count > 0) {
    const badge = el('span', {
      className: 'badge badge-accent',
      textContent: String(count),
      style: {
        position: 'absolute',
        bottom: '-8px',
        right: '-8px',
        zIndex: '10',
      },
    });
    stack.append(badge);
  }

  return stack;
}
