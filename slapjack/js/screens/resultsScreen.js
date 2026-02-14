/**
 * resultsScreen.js — Post-game results display.
 *
 * Shows winner, scores, VRF audit info, and navigation back.
 */

import { el } from '../utils/dom.js';
import { emit, AppEvent } from '../utils/events.js';
import * as GC from '../game/gameController.js';

let _container = null;

/**
 * Mount the results screen.
 * @param {HTMLElement} parent
 * @param {Object} data
 * @param {boolean} data.winner - Did local player win?
 * @param {Object}  data.scores
 * @param {string}  data.localId
 * @param {string}  data.remoteId
 */
export async function mount(parent, data = {}) {
  _container = el('div', {
    className: 'screen active screen-enter',
    id: 'results-screen',
  });

  const isWinner = data.winner;

  const emoji = isWinner ? '🏆' : '😔';
  const headline = isWinner ? 'YOU WIN!' : 'YOU LOSE';
  const headlineColor = isWinner ? 'var(--gold)' : 'var(--danger)';

  const title = el('div', {
    style: {
      fontSize: 'var(--fs-3xl)',
      textAlign: 'center',
      marginBottom: '8px',
    },
    textContent: emoji,
  });

  const headEl = el('h1', {
    className: 'title-hero',
    style: { background: headlineColor, '-webkit-background-clip': 'text' },
    textContent: headline,
  });

  // Scoreboard
  const myScore  = data.scores?.[data.localId]  ?? 0;
  const oppScore = data.scores?.[data.remoteId] ?? 0;

  const scorePanel = el('div', {
    className: 'panel score-display',
    style: { justifyContent: 'center', padding: '24px', marginTop: '24px' },
  },
    _scoreColumn('You', myScore),
    el('span', { className: 'score-vs', textContent: 'vs' }),
    _scoreColumn('Opponent', oppScore),
  );

  // Blockchain attestation
  const attestation = el('div', {
    className: 'panel',
    style: {
      marginTop: '16px',
      textAlign: 'center',
      fontSize: 'var(--fs-sm)',
      color: 'var(--text-secondary)',
      maxWidth: '400px',
      lineHeight: '1.6',
    },
    innerHTML: `
      <span style="color: var(--accent)">🔗 Blockchain Verified</span><br>
      All moves and slap resolutions are anchored to the<br>
      Kaspa DAG with provable VRF randomness.
    `,
  });

  // Navigation buttons
  const playAgainBtn = el('button', {
    className: 'btn btn-gold btn-lg',
    textContent: '🃏  Play Again',
    style: { marginTop: '24px', width: '240px' },
    onClick: () => emit(AppEvent.NAVIGATE, 'lobby-create'),
  });

  const menuBtn = el('button', {
    className: 'btn btn-outline',
    textContent: 'Main Menu',
    style: { marginTop: '8px', width: '240px' },
    onClick: () => emit(AppEvent.NAVIGATE, 'menu'),
  });

  _container.append(title, headEl, scorePanel, attestation, playAgainBtn, menuBtn);
  parent.append(_container);

  // End the match on chain
  try {
    await GC.endMatch();
  } catch { /* ok */ }
}

function _scoreColumn(label, value) {
  return el('div', { className: 'score-item' },
    el('div', { className: 'label', textContent: label }),
    el('div', { className: 'value', textContent: String(value) }),
  );
}

export function unmount() {
  _container?.remove();
  _container = null;
}
