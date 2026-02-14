/**
 * dom.js — Lightweight DOM helper utilities.
 *
 * Keeps templates out of business logic and provides a tiny
 * jQuery-style API for the game UI.
 */

/**
 * Create a DOM element with optional attributes and children.
 * @param {string} tag
 * @param {Object} [attrs] - className, id, textContent, dataset, events, style…
 * @param  {...(Node|string)} children
 * @returns {HTMLElement}
 */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);

  for (const [key, val] of Object.entries(attrs)) {
    if (key === 'className')       node.className = val;
    else if (key === 'textContent') node.textContent = val;
    else if (key === 'innerHTML')  node.innerHTML = val;
    else if (key === 'dataset')    Object.assign(node.dataset, val);
    else if (key === 'style' && typeof val === 'object')
      Object.assign(node.style, val);
    else if (key.startsWith('on') && typeof val === 'function')
      node.addEventListener(key.slice(2).toLowerCase(), val);
    else node.setAttribute(key, val);
  }

  for (const child of children) {
    if (child == null) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

/**
 * Shorthand query selector.
 * @param {string} sel
 * @param {Element} [root=document]
 * @returns {Element|null}
 */
export const $ = (sel, root = document) => root.querySelector(sel);

/**
 * Shorthand query selector all → array.
 * @param {string} sel
 * @param {Element} [root=document]
 * @returns {Element[]}
 */
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/**
 * Remove all children from a node.
 * @param {Element} node
 */
export function clearChildren(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/**
 * Set inner content safely (clears first).
 * @param {Element} node
 * @param  {...(Node|string)} children
 */
export function setContent(node, ...children) {
  clearChildren(node);
  for (const c of children) {
    if (c == null) continue;
    node.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
}

/**
 * Truncate a Kaspa address for display. e.g. kaspa:qz…1abc
 * @param {string} addr
 * @param {number} [chars=6]
 * @returns {string}
 */
export function truncateAddress(addr) {
  if (!addr) return '—';
  if (addr.length <= 20) return addr;
  return `${addr.slice(0, 12)}…${addr.slice(-5)}`;
}

/**
 * Format KAS balance with up to 4 decimal places.
 * @param {number} kas
 * @returns {string}
 */
export function formatKas(kas) {
  return Number(kas ?? 0).toFixed(4);
}
