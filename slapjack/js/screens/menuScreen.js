/**
 * menuScreen.js — Main menu UI.
 *
 * Provides Create Lobby, Join Lobby, and a title display.
 */

import { el, $ } from '../utils/dom.js';
import { emit, AppEvent } from '../utils/events.js';
import { showToast } from '../components/toast.js';

let _container = null;

/**
 * Render the menu screen into the app container.
 * @param {HTMLElement} parent - #app mount point
 */
export function mount(parent) {
  _container = el('div', { className: 'screen active screen-enter', id: 'menu-screen' });

  const title = el('h1', { className: 'title-hero', textContent: 'SLAP JACK' });
  const subtitle = el('p', {
    className: 'subtitle',
    style: { marginTop: '8px', marginBottom: '32px' },
    textContent: 'Provably fair on the Kaspa blockchain',
  });

  const createBtn = el('button', {
    className: 'btn btn-gold btn-lg',
    textContent: '🃏  Create Lobby',
    style: { width: '280px' },
    onClick: () => emit(AppEvent.NAVIGATE, 'lobby-create'),
  });

  const joinInput = el('input', {
    className: 'input',
    type: 'text',
    placeholder: 'Enter join code…',
    style: { width: '280px', textAlign: 'center' },
  });

  const joinBtn = el('button', {
    className: 'btn btn-primary',
    textContent: 'Join Lobby',
    style: { width: '280px' },
    onClick: () => {
      const code = joinInput.value.trim();
      if (!code) {
        showToast('Enter a join code first', 'warning');
        return;
      }
      emit(AppEvent.NAVIGATE, { screen: 'lobby-join', code });
    },
  });

  joinInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') joinBtn.click();
  });

  const divider = el('div', {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: '12px',
      width: '280px',
      margin: '8px 0',
      color: 'var(--text-muted)',
      fontSize: 'var(--fs-sm)',
    },
  },
    el('div', { style: { flex: '1', height: '1px', background: 'var(--border)' } }),
    'or',
    el('div', { style: { flex: '1', height: '1px', background: 'var(--border)' } }),
  );

  const column = el('div', {
    style: {
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: '12px',
    },
  }, title, subtitle, createBtn, divider, joinInput, joinBtn);

  // Rules blurb
  const rules = el('div', {
    className: 'panel',
    style: {
      maxWidth: '400px',
      marginTop: '32px',
      textAlign: 'center',
      fontSize: 'var(--fs-sm)',
      color: 'var(--text-secondary)',
      lineHeight: '1.6',
    },
    innerHTML: `
      <strong style="color: var(--gold)">How to Play</strong><br>
      Take turns flipping cards onto the pile.<br>
      When a <strong>Jack</strong> appears — <strong>SLAP IT!</strong><br>
      First to slap wins the round. Simultaneous slaps are
      broken by <span style="color: var(--accent)">VRF randomness</span>.<br>
      Wrong slap = 2-card penalty. First to 5 rounds wins!
    `,
  });

  column.append(rules);
  _container.append(column);
  parent.append(_container);
}

/**
 * Clean up the menu screen.
 */
export function unmount() {
  _container?.remove();
  _container = null;
}
