/**
 * chat.js — Reusable chat panel component.
 *
 * Renders a scrolling message list and input row.
 * Used inside both the lobby screen and optionally in-game.
 */

import { el, $, clearChildren } from '../utils/dom.js';
import { on, AppEvent } from '../utils/events.js';
import { sendChat } from '../engine/bridge.js';

/**
 * Create a chat panel element.
 *
 * @param {Object} [opts]
 * @param {string} [opts.placeholder='Type a message…']
 * @returns {{ element: HTMLElement, addMessage: Function, addSystem: Function, destroy: Function }}
 */
export function createChatPanel(opts = {}) {
  const messages = el('div', { className: 'chat-messages' });
  const input    = el('input', {
    className: 'input',
    type: 'text',
    placeholder: opts.placeholder || 'Type a message…',
    maxLength: '200',
  });
  const sendBtn = el('button', {
    className: 'btn btn-primary btn-sm',
    textContent: 'Send',
  });

  const inputRow = el('div', { className: 'chat-input-row' }, input, sendBtn);
  const panel    = el('div', { className: 'chat-panel panel' }, messages, inputRow);

  // Send on click or Enter
  const doSend = async () => {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';

    addMessage({ sender: 'You', text, mine: true });

    try {
      await sendChat(text);
    } catch (e) {
      addSystem(`Send failed: ${e.message}`);
    }
  };

  sendBtn.addEventListener('click', doSend);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doSend();
  });

  // Listen to incoming chat
  const unsub = on(AppEvent.LOBBY_CHAT, (data) => {
    addMessage({ sender: data.sender ?? 'Player', text: data.text, mine: false });
  });

  /**
   * Append a chat message bubble.
   */
  function addMessage({ sender, text, mine = false }) {
    const senderEl = el('div', { className: 'sender', textContent: sender });
    const msg = el('div', { className: `chat-msg ${mine ? 'mine' : 'theirs'}` },
      mine ? null : senderEl,
      text,
    );
    messages.append(msg);
    messages.scrollTop = messages.scrollHeight;
  }

  /**
   * Add a system/info message.
   */
  function addSystem(text) {
    const msg = el('div', { className: 'chat-msg system', textContent: text });
    messages.append(msg);
    messages.scrollTop = messages.scrollHeight;
  }

  function destroy() {
    unsub();
    clearChildren(messages);
  }

  return { element: panel, addMessage, addSystem, destroy };
}
