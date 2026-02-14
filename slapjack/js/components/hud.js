/**
 * hud.js — Top bar HUD component.
 *
 * Shows wallet balance (live-updating) and a copy-to-clipboard
 * address button so users can fund their wallet.
 */

import { el, $, truncateAddress, formatKas } from '../utils/dom.js';
import { on, AppEvent } from '../utils/events.js';
import { getAddress, getBalance } from '../engine/bridge.js';

let _hudEl    = null;
let _balEl    = null;
let _addrBtn  = null;
let _mounted  = false;

/**
 * Mount the HUD into the existing #hud element.
 */
export function mountHud() {
  _hudEl = $('#hud');
  if (!_hudEl || _mounted) return;
  _mounted = true;

  const address = getAddress();
  const balance = getBalance();

  // Balance display
  _balEl = el('div', { className: 'balance' },
    el('span', { textContent: '💰' }),
    el('span', { className: 'bal-value', textContent: `${formatKas(balance)} KAS` }),
  );

  // Copy address button
  _addrBtn = el('button', {
    className: 'address-btn',
    title: 'Click to copy wallet address',
    onClick: _copyAddress,
  },
    el('span', { className: 'addr-text', textContent: truncateAddress(address) }),
    el('span', { textContent: '📋' }),
  );

  _hudEl.append(_balEl, _addrBtn);
  _hudEl.classList.remove('hidden');

  // Live balance updates
  on(AppEvent.BALANCE_UPDATE, _onBalanceUpdate);
}

/**
 * Update displayed balance.
 * @param {{ balance: number }} data
 */
function _onBalanceUpdate(data) {
  if (!_balEl) return;
  const valEl = $('.bal-value', _balEl);
  if (valEl) valEl.textContent = `${formatKas(data.balance)} KAS`;
}

/**
 * Copy the full wallet address to clipboard with visual feedback.
 */
async function _copyAddress() {
  const address = getAddress();
  if (!address) return;

  try {
    await navigator.clipboard.writeText(address);
    _addrBtn.classList.add('copied');
    const textEl = $('.addr-text', _addrBtn);
    const original = textEl.textContent;
    textEl.textContent = 'Copied!';

    setTimeout(() => {
      _addrBtn.classList.remove('copied');
      textEl.textContent = original;
    }, 2000);
  } catch {
    // Fallback for insecure contexts
    _fallbackCopy(address);
  }
}

function _fallbackCopy(text) {
  const ta = el('textarea', { style: { position: 'fixed', opacity: '0' } });
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  ta.remove();

  const textEl = $('.addr-text', _addrBtn);
  textEl.textContent = 'Copied!';
  setTimeout(() => {
    textEl.textContent = truncateAddress(text);
  }, 2000);
}
