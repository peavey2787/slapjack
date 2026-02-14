/**
 * eventEmitter.js - Minimal event emitter for browser use
 */

import { Logger, LogModule } from "./logger.js";

const log = Logger.create(LogModule.core.eventEmitter);

export class EventEmitter {
  constructor() {
    this._listeners = new Map();
  }

  on(event, handler) {
    if (!this._listeners.has(event)) {
      this._listeners.set(event, new Set());
    }
    this._listeners.get(event).add(handler);
    return this;
  }

  off(event, handler) {
    this._listeners.get(event)?.delete(handler);
    return this;
  }

  once(event, handler) {
    const wrapper = (...args) => {
      this.off(event, wrapper);
      handler(...args);
    };
    return this.on(event, wrapper);
  }

  emit(event, ...args) {
    const handlers = this._listeners.get(event);
    if (!handlers) return false;
    for (const handler of handlers) {
      try {
        handler(...args);
      } catch (err) {
        log.error(`EventEmitter handler error for ${event}:`, err);
      }
    }
    return true;
  }

  removeAllListeners(event) {
    if (event) {
      this._listeners.delete(event);
    } else {
      this._listeners.clear();
    }
    return this;
  }
}

export default EventEmitter;
