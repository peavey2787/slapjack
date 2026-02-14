/**
 * lobbyScreen.js — Lobby UI with member list, chat, and ready system.
 */

import { el, $, clearChildren, setContent } from '../utils/dom.js';
import { emit, on, AppEvent } from '../utils/events.js';
import { createChatPanel } from '../components/chat.js';
import { showToast } from '../components/toast.js';
import * as Bridge from '../engine/bridge.js';
import { createDeck, localShuffle } from '../game/deck.js';

let _container  = null;
let _chat       = null;
let _memberList = null;
let _readyBtn   = null;
let _startBtn   = null;
let _isReady    = false;
let _readyStates = {};  // senderId → boolean
let _unsubs     = [];
let _mode       = 'create'; // 'create' | 'join'
let _joinCode   = '';

/**
 * Mount the lobby screen.
 * @param {HTMLElement} parent
 * @param {Object} opts
 * @param {'create'|'join'} opts.mode
 * @param {string} [opts.code] - Join code (for join mode)
 * @param {string} [opts.displayName]
 */
export async function mount(parent, opts = {}) {
  _mode = opts.mode || 'create';
  _isReady = false;
  _readyStates = {};

  _container = el('div', {
    className: 'screen active screen-enter',
    id: 'lobby-screen',
    style: { paddingTop: '64px' },
  });

  const heading = el('h2', {
    style: { color: 'var(--gold)', marginBottom: '8px', textAlign: 'center' },
    textContent: _mode === 'create' ? 'Your Lobby' : 'Joining Lobby…',
  });

  // Join code display
  const codeDisplay = el('div', {
    className: 'panel',
    id: 'join-code-display',
    style: {
      textAlign: 'center',
      marginBottom: '16px',
      padding: '12px',
      fontFamily: 'var(--font-mono)',
      fontSize: 'var(--fs-lg)',
      cursor: 'pointer',
    },
    title: 'Click to copy join code',
  });

  // Split layout: left = members + controls, right = chat
  _memberList = el('ul', { className: 'member-list' });

  _readyBtn = el('button', {
    className: 'btn btn-outline',
    textContent: '✋ Ready',
    onClick: _toggleReady,
  });

  _startBtn = el('button', {
    className: 'btn btn-gold',
    textContent: '🎮 Start Game',
    style: { display: 'none' },
    onClick: _startGame,
  });

  const leaveBtn = el('button', {
    className: 'btn btn-danger btn-sm',
    textContent: 'Leave',
    style: { marginTop: '8px' },
    onClick: _leave,
  });

  const leftCol = el('div', {
    style: { display: 'flex', flexDirection: 'column', gap: '12px', overflow: 'auto' },
  },
    el('h3', { textContent: 'Players', style: { color: 'var(--text-secondary)', fontSize: 'var(--fs-sm)' } }),
    _memberList,
    el('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } }, _readyBtn, _startBtn),
    leaveBtn,
  );

  _chat = createChatPanel({ placeholder: 'Chat with lobby…' });

  const split = el('div', { className: 'split-layout' }, leftCol, _chat.element);

  _container.append(heading, codeDisplay, split);
  parent.append(_container);

  // Wire events
  _unsubs.push(
    on(AppEvent.LOBBY_MEMBERS, _onMemberChange),
    on(AppEvent.LOBBY_READY, _onReadyState),
    on(AppEvent.LOBBY_CLOSED, _onLobbyClosed),
    on(AppEvent.GAME_START, _onGameStart),
  );

  // Perform lobby action
  try {
    if (_mode === 'create') {
      const result = await Bridge.createLobby('Slap Jack', 4);
      _joinCode = result.joinCode;
      _renderJoinCode(codeDisplay);
      heading.textContent = 'Your Lobby';
      showToast('Lobby created! Share the join code.', 'success');
    } else {
      const code = opts.code;
      heading.textContent = 'Joining…';
      await Bridge.joinLobby(code, opts.displayName || 'Player');
      heading.textContent = 'Lobby';
      _joinCode = code;
      _renderJoinCode(codeDisplay);
      showToast('Joined lobby!', 'success');
    }
  } catch (err) {
    showToast(`Lobby error: ${err.message}`, 'error');
  }

  _refreshMembers();
}

function _renderJoinCode(container) {
  setContent(container,
    el('span', { style: { color: 'var(--text-muted)', fontSize: 'var(--fs-sm)' }, textContent: 'Join Code: ' }),
    el('span', { style: { color: 'var(--accent)' }, textContent: _joinCode || '—' }),
  );
  container.onclick = async () => {
    if (!_joinCode) return;
    try {
      await navigator.clipboard.writeText(_joinCode);
      showToast('Join code copied!', 'success');
    } catch {
      showToast(_joinCode, 'info');
    }
  };
}

function _refreshMembers() {
  clearChildren(_memberList);
  const members = Bridge.getLobbyMembers();
  for (const m of members) {
    const ready = _readyStates[m.id] ? ' ✅' : '';
    const host  = m.isHost ? ' 👑' : '';
    const item  = el('li', { className: 'member-item' },
      el('span', { className: 'member-dot' }),
      `${m.name || m.id?.slice(0, 8) || 'Player'}${host}${ready}`,
    );
    _memberList.append(item);
  }

  // Show start button only for host when opponent is ready
  const isHost = Bridge.isHost();
  _startBtn.style.display = isHost ? '' : 'none';
}

function _onMemberChange(data) {
  const action = data.type === 'joined' ? 'joined' : 'left';
  const name = data.member?.name || 'Player';
  _chat?.addSystem(`${name} ${action} the lobby`);
  _refreshMembers();
}

function _onReadyState(data) {
  _readyStates[data.senderId] = data.isReady;
  _chat?.addSystem(`${data.senderName} is ${data.isReady ? 'READY' : 'not ready'}`);
  _refreshMembers();
}

function _buildGameNavOpts(startData = {}) {
  const members = Bridge.getLobbyMembers();
  const hostMember = members.find((m) => m?.isHost);
  const nonHostMember = members.find((m) => !m?.isHost);
  const hostIdFromStart = startData.hostId || null;
  const guestIdFromStart = startData.guestId || null;
  const ids = Array.isArray(startData.playerIds)
    ? startData.playerIds.filter(Boolean)
    : members.map((m) => m.id).filter(Boolean);

  let localId = null;
  if (Bridge.isHost()) {
    localId = hostIdFromStart || hostMember?.id || ids[0] || 'me';
  } else {
    localId = guestIdFromStart || nonHostMember?.id || ids.find((id) => id !== (hostIdFromStart || hostMember?.id)) || ids[0] || 'me';
  }

  const remoteId = ids.find((id) => id !== localId) ||
    (Bridge.isHost() ? (guestIdFromStart || nonHostMember?.id) : (hostIdFromStart || hostMember?.id)) ||
    'opponent';

  return {
    screen: 'game',
    gameId: startData.gameId || `sj-${Date.now()}`,
    localId,
    remoteId,
    firstTurnId: startData.firstTurnId || hostIdFromStart || ids[0],
    deckIds: Array.isArray(startData.deckIds) ? startData.deckIds : undefined,
  };
}

async function _buildDeckIds(gameId) {
  let deck;
  try {
    deck = await Bridge.shuffle(createDeck());
  } catch {
    deck = localShuffle(createDeck());
  }

  try {
    const random = await Bridge.getRandom(`slapjack-deck-${gameId}-${Date.now()}-${Math.random()}`);
    const hex = typeof random?.value === 'string' ? random.value.slice(0, 8) : '';
    const rotateBy = (parseInt(hex || '0', 16) || 0) % deck.length;
    if (rotateBy > 0) {
      deck = [...deck.slice(rotateBy), ...deck.slice(0, rotateBy)];
    }
  } catch {
  }

  return deck.map((card) => card.id);
}

async function _toggleReady() {
  _isReady = !_isReady;
  _readyBtn.textContent = _isReady ? '✅ Ready!' : '✋ Ready';
  _readyBtn.className = _isReady
    ? 'btn btn-primary'
    : 'btn btn-outline';

  try {
    await Bridge.signalReady(_isReady);
  } catch { /* ignore */ }
}

async function _startGame() {
  try {
    const members = Bridge.getLobbyMembers();
    const hostMember = members.find((m) => m?.isHost);
    const guestMember = members.find((m) => !m?.isHost);
    const hostId = hostMember?.id;
    const guestId = guestMember?.id;
    const playerIds = [hostId, guestId].filter(Boolean);

    if (playerIds.length < 2) {
      showToast('Need 2 players to start', 'warning');
      return;
    }

    const gameId = `sj-${Date.now()}`;
    const deckIds = await _buildDeckIds(gameId);

    const gameConfig = {
      gameId,
      playerIds,
      hostId,
      guestId,
      firstTurnId: hostId,
      deckIds,
      timestamp: Date.now(),
    };

    await Bridge.signalGameStart(gameConfig);
    // Host navigates immediately; joiner via GAME_START event
    emit(AppEvent.NAVIGATE, _buildGameNavOpts(gameConfig));
  } catch (err) {
    showToast(`Start failed: ${err.message}`, 'error');
  }
}

function _onGameStart(data) {
  emit(AppEvent.NAVIGATE, _buildGameNavOpts(data));
}

function _onLobbyClosed(data) {
  showToast('Lobby was closed', 'warning');
  emit(AppEvent.NAVIGATE, 'menu');
}

async function _leave() {
  try { await Bridge.leaveLobby(); } catch { /* ok */ }
  emit(AppEvent.NAVIGATE, 'menu');
}

export function unmount() {
  _unsubs.forEach(fn => fn());
  _unsubs = [];
  _chat?.destroy();
  _chat = null;
  _container?.remove();
  _container = null;
}
