/**
 * gameScreen.js — In-game UI for Slap Jack.
 *
 * Renders the card table, scores, pile, and slap button.
 * Reacts to game events from gameController.
 */

import { el, $, clearChildren, setContent } from '../utils/dom.js';
import { on, emit, AppEvent } from '../utils/events.js';
import { renderCard, renderDeckStack } from '../components/cardRenderer.js';
import { showToast } from '../components/toast.js';
import * as GC from '../game/gameController.js';

let _container = null;
let _pileArea  = null;
let _scoreArea = null;
let _slapBtn   = null;
let _flipBtn   = null;
let _myDeck    = null;
let _oppDeck   = null;
let _turnLabel = null;
let _unsubs    = [];

/**
 * Mount the game screen and start a match.
 * @param {HTMLElement} parent
 * @param {Object} [opts]
 */
export async function mount(parent, opts = {}) {
  _container = el('div', {
    className: 'screen active screen-enter',
    id: 'game-screen',
    style: { paddingTop: '56px' },
  });

  const localId  = opts.localId  || 'me';
  const remoteId = opts.remoteId || 'opponent';
  const gameId   = opts.gameId   || `sj-${Date.now()}`;

  // Build table layout
  const table = el('div', { className: 'game-table' });

  // Opponent zone (top)
  _oppDeck = el('div', {
    id: 'opp-deck',
    style: {
      position: 'absolute',
      top: '12px',
      left: '50%',
      transform: 'translateX(-50%)',
    },
  });

  // Center pile
  _pileArea = el('div', {
    id: 'pile-area',
    style: {
      position: 'absolute',
      top: '50%',
      left: '50%',
      transform: 'translate(-50%, -50%)',
      width: '130px',
      height: '182px',
    },
  });

  // My zone (bottom)
  _myDeck = el('div', {
    id: 'my-deck',
    style: {
      position: 'absolute',
      bottom: '12px',
      left: '50%',
      transform: 'translateX(-50%)',
    },
  });

  // Turn indicator
  _turnLabel = el('div', {
    id: 'turn-label',
    style: {
      position: 'absolute',
      top: '50%',
      right: '16px',
      transform: 'translateY(-50%)',
      color: 'var(--text-muted)',
      fontSize: 'var(--fs-sm)',
      textAlign: 'right',
    },
  });

  table.append(_oppDeck, _pileArea, _myDeck, _turnLabel);

  // Score bar
  _scoreArea = el('div', {
    className: 'score-display',
    style: { marginTop: '16px', justifyContent: 'center' },
  });

  // Controls
  _flipBtn = el('button', {
    className: 'btn btn-primary btn-lg',
    textContent: '🃏 Flip',
    style: { marginTop: '12px' },
    onClick: _onFlip,
  });

  _slapBtn = el('button', {
    className: 'btn-slap',
    textContent: 'SLAP!',
    style: { marginTop: '12px' },
    onClick: _onSlap,
  });

  const controls = el('div', {
    style: { display: 'flex', gap: '24px', alignItems: 'center', justifyContent: 'center', flexWrap: 'wrap' },
  }, _flipBtn, _slapBtn);

  _container.append(table, _scoreArea, controls);
  parent.append(_container);

  // Wire events
  _unsubs.push(
    on(AppEvent.CARD_FLIPPED, _onCardFlipped),
    on(AppEvent.SLAP_RESULT, _onSlapResult),
    on(AppEvent.ROUND_WON, _onRoundWon),
    on(AppEvent.GAME_OVER, _onGameOver),
  );

  // Start the match
  try {
    const snap = await GC.startMatch({
      localId,
      remoteId,
      gameId,
      firstTurnId: opts.firstTurnId,
      deckIds: opts.deckIds,
      winTarget: 5,
    });
    _render(snap);
    showToast('Game started! Flip cards or SLAP a Jack!', 'success');
  } catch (err) {
    showToast(`Game start error: ${err.message}`, 'error');
  }
}

// ── Event handlers ──

async function _onFlip() {
  _flipBtn.disabled = true;
  await GC.flip();
  _flipBtn.disabled = false;
}

async function _onSlap() {
  _slapBtn.disabled = true;
  await GC.slap();
  setTimeout(() => { _slapBtn.disabled = false; }, 600);
}

function _onCardFlipped(data) {
  const applyFlipRender = () => {
    if (data.card) {
      _showCardOnPile(data.card, data.isJack);
    }
    _render(data.state);

    if (data.isJack) {
      _pileArea.classList.add('slap-flash');
      _slapBtn.classList.add('pulse');
      setTimeout(() => {
        _pileArea.classList.remove('slap-flash');
        _slapBtn.classList.remove('pulse');
      }, 1500);
    }
  };

  const localId = GC.snapshot()?.localId;
  if (data?.card && data?.flipper && localId && data.flipper === localId) {
    setTimeout(applyFlipRender, 500);
    return;
  }

  applyFlipRender();
}

function _onSlapResult(data) {
  if (!data.valid) {
    const who = data.playerId === GC.snapshot()?.localId ? 'You' : 'Opponent';
    showToast(`${who} slapped wrong! −2 cards penalty`, 'warning');
    if (data.playerId === GC.snapshot()?.localId) {
      _container.classList.add('shake');
      setTimeout(() => _container.classList.remove('shake'), 500);
    }
  }
  _render(data.state);
}

function _onRoundWon(data) {
  const snap = data.state;
  const isMe = data.winnerId === snap?.localId;
  const who = isMe ? 'You' : 'Opponent';
  const tieMsg = data.wasTie
    ? ` (tie broken by VRF: ${(data.vrfNumber * 100).toFixed(1)}%)`
    : '';

  showToast(`${who} won the round!${tieMsg}`, isMe ? 'success' : 'info');

  // Clear pile with animation
  const pileCards = _pileArea.querySelectorAll('.card');
  pileCards.forEach(c => c.classList.add('won'));
  setTimeout(() => {
    clearChildren(_pileArea);
    _render(snap);
  }, 600);
}

function _onGameOver(data) {
  const snap = GC.snapshot();
  const isWinner = data.winnerId === snap?.localId;

  setTimeout(() => {
    emit(AppEvent.NAVIGATE, {
      screen: 'results',
      winner: isWinner,
      winnerId: data.winnerId,
      scores: data.scores,
      localId: snap?.localId,
      remoteId: snap?.remoteId,
    });
  }, 1000);
}

// ── Rendering ──

function _render(snap) {
  if (!snap) return;

  // Scores
  setContent(_scoreArea,
    _scoreItem('You', snap.scores[snap.localId]),
    el('span', { className: 'score-vs', textContent: 'vs' }),
    _scoreItem('Opponent', snap.scores[snap.remoteId]),
  );

  // Deck stacks
  setContent(_myDeck, renderDeckStack(snap.myHandSize));
  setContent(_oppDeck, renderDeckStack(snap.opponentHandSize));

  // Turn label
  _turnLabel.textContent = snap.isMyTurn ? 'Your turn' : "Opponent's turn";
  _turnLabel.style.color = snap.isMyTurn ? 'var(--accent)' : 'var(--text-muted)';

  // Button states
  _flipBtn.disabled = !snap.isMyTurn || snap.isSlapOpen;
  _flipBtn.style.opacity = snap.isMyTurn && !snap.isSlapOpen ? '1' : '.4';
}

function _showCardOnPile(card, isJack) {
  const cardEl = renderCard(card, { size: 'card-lg' });
  cardEl.classList.add('pile-card', 'dealing');
  if (isJack) cardEl.classList.add('jack-glow');

  // Keep only latest + 2 for depth
  const existing = _pileArea.querySelectorAll('.pile-card');
  if (existing.length > 2) existing[0].remove();

  _pileArea.append(cardEl);
}

function _scoreItem(label, value) {
  return el('div', { className: 'score-item' },
    el('div', { className: 'label', textContent: label }),
    el('div', { className: 'value', textContent: String(value ?? 0) }),
  );
}

export function unmount() {
  _unsubs.forEach(fn => fn());
  _unsubs = [];
  _container?.remove();
  _container = null;
}
