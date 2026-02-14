/**
 * kaspaAnchorFacade.js - High-level facade for Kaspa anchoring
 *
 * Single responsibility:
 * - Provide a clean, app-agnostic API over MoveProcessor
 * - Hide internal mixin complexity from consumers
 */

import MoveProcessor from './moveProcessor.js';

/**
 * Facade for Kaspa anchoring and audit operations
 */
export class KaspaAnchorFacade {
  /**
   * @param {Object} options
     * @param {Object} [options.adapter] - KaspaAdapter instance
     * @param {Object} [options.kaspaAdapter] - KaspaAdapter instance (alias)
   * @param {Object} [options.sessionController] - SessionController instance
   * @param {Object} [options.moveProcessorOptions] - Additional MoveProcessor options
   */
  constructor(options = {}) {
      const {
        adapter, kaspaAdapter, sessionController, moveProcessorOptions,
        // v5 custom action maps — forwarded to MoveProcessor
        customActionMap, customAbilitiesMap, customActionsMap,
        customItemsMap, customStatusMap, customEmotesMap, customSystemMap,
      } = options;
      const resolvedAdapter = adapter ?? kaspaAdapter ?? null;

    this._processor = new MoveProcessor({
        adapter: resolvedAdapter,
      sessionController,
      customActionMap,
      customAbilitiesMap,
      customActionsMap,
      customItemsMap,
      customStatusMap,
      customEmotesMap,
      customSystemMap,
      ...(moveProcessorOptions || {}),
    });
  }

  /**
   * Access to the underlying MoveProcessor (advanced use)
   */
  get processor() {
    return this._processor;
  }

  get isUtxoReady() {
    return this._processor?.isUtxoReady ?? false;
  }

  // ──────────────────────────────────────────────────────────────
  // Initialization / Lifecycle
  // ──────────────────────────────────────────────────────────────

  setAdapter(adapter) {
    this._processor.setAdapter(adapter);
  }

  setKaspaAdapter(adapter) {
    this.setAdapter(adapter);
  }

  setSessionController(sessionController) {
    this._processor.setSessionController(sessionController);
  }

  /**
   * Start a new game session
   * @param {Object} options
   */
  startGame(options) {
    this._processor.start(options);
  }

  /**
   * Stop current session
   */
  async stopGame() {
    return this._processor.stop();
  }

  /**
   * Destroy facade and cleanup
   */
  destroy() {
    this._processor.destroy();
  }

  // ──────────────────────────────────────────────────────────────
  // Core Gameplay Anchoring
  // ──────────────────────────────────────────────────────────────

  /**
   * Process a local move (VRF + Merkle + archive)
   */
  async processMove(action, data = {}) {
    return this._processor.processLocalMove(action, data);
  }

  /**
   * Process a game event for spectator anchoring
   */
  processGameEvent(eventType, data = {}) {
    return this._processor.processGameEvent(eventType, data);
  }

  /**
   * Receive and validate an opponent move
   */
  async receiveOpponentMove(moveData) {
    return this._processor.receiveOpponentMove(moveData);
  }

  // ──────────────────────────────────────────────────────────────
  // Anchors (Genesis → Heartbeat(s) → Final)
  // ──────────────────────────────────────────────────────────────

  /**
   * Anchor genesis seed (entropy capture + chain start)
   */
  async anchorGenesisSeed(options = {}) {
    return this._processor.anchorGenesisSeed(options);
  }

  /**
   * Force a heartbeat anchor immediately (optional manual trigger)
   */
  async anchorHeartbeatNow(options = {}) {
    if (typeof this._processor._sendHeartbeatAnchor === 'function') {
      return this._processor._sendHeartbeatAnchor(options);
    }
    return { success: false, error: 'Heartbeat anchor method not available' };
  }

  /**
   * Anchor final state (chain completion)
   */
  async anchorFinalState(endState, options = {}) {
    return this._processor.anchorFinalState(endState, options);
  }

  // ──────────────────────────────────────────────────────────────
  // UTXO / Wallet Helpers
  // ──────────────────────────────────────────────────────────────

  async prepareForGame() {
    return this._processor.prepareForGame();
  }

  async ensureUtxoPoolReady(options = {}) {
    return this._processor.ensureUtxoPoolReady(options);
  }

  getPoolStatus() {
    return this._processor.getPoolStatus();
  }

  async getRunway() {
    return this._processor.getRunway();
  }

  async getBalanceKas() {
    return this._processor.getBalanceKas();
  }

  // ──────────────────────────────────────────────────────────────
  // Audit / Merkle Access
  // ──────────────────────────────────────────────────────────────

  getAuditData(options = {}) {
    return this._processor.getAuditData(options);
  }

  async getAuditDataFromDag(options = {}) {
    return await this._processor.getAuditDataFromDag(options);
  }

  getMerkleRoot() {
    return this._processor.getMerkleRoot();
  }

  getMerkleProof(index) {
    return this._processor.getMerkleProof(index);
  }

  getMoveHistory() {
    return this._processor.getMoveHistory();
  }

  getMoveCount() {
    return this._processor.getMoveCount();
  }

  getMerkleLeaves() {
    return this._processor.getMerkleLeaves();
  }

  // ──────────────────────────────────────────────────────────────
  // Event Helpers
  // ──────────────────────────────────────────────────────────────

  on(eventName, handler) {
    this._processor.on(eventName, handler);
    return this;
  }

  off(eventName, handler) {
    this._processor.off(eventName, handler);
    return this;
  }
}

export default KaspaAnchorFacade;
