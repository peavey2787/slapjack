/**
 * toast.js — Toast notification system.
 *
 * Shows brief feedback messages at bottom-right.
 */

import { el, $ } from '../utils/dom.js';

const DURATION = 3500;

/**
 * Show a toast notification.
 *
 * @param {string} message
 * @param {'info'|'success'|'warning'|'error'} [type='info']
 */
export function showToast(message, type = 'info') {
  const container = $('#toast-container');
  if (!container) return;

  const toast = el('div', { className: `toast ${type}`, textContent: message });
  container.append(toast);

  setTimeout(() => {
    toast.style.animation = 'toastOut var(--dur-base) var(--ease-out) forwards';
    toast.addEventListener('animationend', () => toast.remove());
  }, DURATION);
}
