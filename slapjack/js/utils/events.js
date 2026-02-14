/**
 * events.js — Tiny pub/sub event bus for cross-module communication.
 *
 * Used to decouple screens, components, and the game controller
 * without passing callbacks everywhere.
 */

const listeners = new Map();

/**
 * Subscribe to a named event.
 * @param {string} event
 * @param {Function} handler
 * @returns {Function} Unsubscribe function
 */
export function on(event, handler) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(handler);
  return () => off(event, handler);
}

/**
 * Unsubscribe from a named event.
 * @param {string} event
 * @param {Function} handler
 */
export function off(event, handler) {
  listeners.get(event)?.delete(handler);
}

/**
 * Emit a named event to all subscribers.
 * @param {string} event
 * @param {*} [data]
 */
export function emit(event, data) {
  const handlers = listeners.get(event);
  if (!handlers) return;
  for (const fn of handlers) {
    try { fn(data); }
    catch (e) { console.error(`[EventBus] Error in "${event}" handler:`, e); }
  }
}

/**
 * Subscribe to a named event for one call only.
 * @param {string} event
 * @param {Function} handler
 * @returns {Function} Unsubscribe function
 */
export function once(event, handler) {
  const wrapper = (data) => {
    off(event, wrapper);
    handler(data);
  };
  return on(event, wrapper);
}

/**
 * All app-level event names in one place.
 */
export const AppEvent = {
  // Navigation
  NAVIGATE:        'navigate',

  // Engine lifecycle
  ENGINE_READY:    'engine:ready',
  ENGINE_ERROR:    'engine:error',
  BALANCE_UPDATE:  'engine:balance',

  // Lobby
  LOBBY_CREATED:   'lobby:created',
  LOBBY_JOINED:    'lobby:joined',
  LOBBY_LEFT:      'lobby:left',
  LOBBY_CLOSED:    'lobby:closed',
  LOBBY_CHAT:      'lobby:chat',
  LOBBY_MEMBERS:   'lobby:members',
  LOBBY_READY:     'lobby:readyState',

  // Game
  GAME_START:      'game:start',
  CARD_FLIPPED:    'game:cardFlipped',
  SLAP_RESULT:     'game:slapResult',
  ROUND_WON:       'game:roundWon',
  GAME_OVER:       'game:over',
  OPPONENT_SLAP:   'game:opponentSlap',
  OPPONENT_FLIP:   'game:opponentFlip',
  OPPONENT_RESHUFFLE: 'game:opponentReshuffle',
};
