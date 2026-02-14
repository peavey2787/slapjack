/**
 * app.js — Application orchestrator.
 *
 * Boots the engine, mounts screens, and handles navigation.
 * This is the single entry-point loaded by index.html.
 */

import { $, clearChildren } from './utils/dom.js';
import { on, AppEvent } from './utils/events.js';
import { initEngine, getAddress } from './engine/bridge.js';
import { mountHud } from './components/hud.js';
import { showToast } from './components/toast.js';

import * as MenuScreen    from './screens/menuScreen.js';
import * as LobbyScreen   from './screens/lobbyScreen.js';
import * as GameScreen    from './screens/gameScreen.js';
import * as ResultsScreen from './screens/resultsScreen.js';

// ── State ──
let _currentScreen = null;
let _app           = null;

// ── Screen registry (SRP: each screen owns its mount/unmount) ──
const SCREENS = {
  menu:    MenuScreen,
  lobby:   LobbyScreen,
  game:    GameScreen,
  results: ResultsScreen,
};

// ═══════════════════════════════════════════════════════════
// Boot
// ═══════════════════════════════════════════════════════════

async function boot() {
  _app = $('#app');
  const overlay  = $('#loading-overlay');
  const loadText = $('#loading-text');

  // Step 1 — Init engine (auto-login)
  loadText.textContent = 'Initialising Kaspa WASM…';

  try {
    await initEngine();
  } catch (err) {
    loadText.textContent = `Error: ${err.message}`;
    console.error('[App] Engine init failed:', err);
    return;
  }

  // Step 2 — Mount HUD
  loadText.textContent = 'Wallet ready!';
  mountHud();

  // Step 3 — Fade out loading overlay
  overlay.classList.add('done');
  setTimeout(() => overlay.remove(), 600);

  // Step 4 — Navigate to menu
  _navigate('menu');
}

// ═══════════════════════════════════════════════════════════
// Navigation
// ═══════════════════════════════════════════════════════════

function _navigate(target) {
  // Unmount current screen
  if (_currentScreen && SCREENS[_currentScreen]) {
    SCREENS[_currentScreen].unmount();
  }
  clearChildren(_app);

  // Parse target
  let screenName = typeof target === 'string' ? target : target?.screen;
  const opts = typeof target === 'object' ? target : {};

  // Lobby shorthand routing
  if (screenName === 'lobby-create') {
    screenName = 'lobby';
    opts.mode = 'create';
  } else if (screenName === 'lobby-join') {
    screenName = 'lobby';
    opts.mode = 'join';
  }

  // Resolve player IDs for game screen
  if (screenName === 'game' && !opts.localId) {
    opts.localId  = getAddress() || 'me';
    opts.remoteId = opts.remoteId || 'opponent';
    opts.gameId   = opts.gameId || `sj-${Date.now()}`;
  }

  const screen = SCREENS[screenName];
  if (!screen) {
    console.error(`[App] Unknown screen: ${screenName}`);
    return;
  }

  _currentScreen = screenName;
  screen.mount(_app, opts);
}

// ═══════════════════════════════════════════════════════════
// Global event wiring
// ═══════════════════════════════════════════════════════════

on(AppEvent.NAVIGATE, _navigate);

on(AppEvent.ENGINE_ERROR, (err) => {
  showToast(`Engine error: ${err?.message || err}`, 'error');
});

// ═══════════════════════════════════════════════════════════
// Start
// ═══════════════════════════════════════════════════════════

boot();
