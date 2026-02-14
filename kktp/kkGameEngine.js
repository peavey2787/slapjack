/**
 * kkGameEngine.js - Simple Game Engine Facade for Kaspa-Backed Games
 *
 * This is the single entry point for game developers. It abstracts away all
 * blockchain complexity (DAGs, UTXOs, anchors, VRF, etc.) and provides a
 * simple API that any game developer can use.
 *
 * Requirements for users:
 * - Password
 * - Wallet filename
 *
 * That's it! Everything else is handled automatically.
 *
 * @example
 * ```javascript
 * import { KKGameEngine } from './kktp/kkGameEngine.js';
 *
 * const game = new KKGameEngine();
 *
 * // Initialize once
 * await game.init({
 *   password: 'myPassword123',
 *   walletName: 'my-game-wallet',
 * });
 *
 * // Start a game session
 * await game.startGame({
 *   gameId: 'match-123',
 *   playerId: 'player-1',
 * });
 *
 * // Record player moves (automatically generates provable randomness)
 * const move = await game.recordMove('jump', { lane: 1 });
 * console.log('Random value:', move.randomValue);
 *
 * // Get provable random number for game logic
 * const random = await game.getRandom();
 *
 * // End the game and anchor final state
 * const result = await game.endGame({ score: 1500, coins: 42 });
 * ```
 */

import { KaspaAdapter } from "./adapters/kaspaAdapter.js";
import { KaspaAnchorFacade } from "./blockchain/kaspaAnchorFacade.js";
import { auditCheating } from "./audit/auditCheating.js";
import { parseAnchor } from "./blockchain/anchorParser.js";
import { SessionFacade } from "./protocol/sessions/sessionFacade.js";
import { LobbyFacade, LOBBY_STATES } from "./lobby/lobbyFacade.js";
import { MoveEvent } from "./blockchain/moveProcessor.js";
import { parseHeartbeatHex, enrichMoves } from "./blockchain/anchor/heartbeatParser.js";
import { Logger, LogModule } from "./core/logger.js";
import { BLOCKCHAIN } from "./core/constants.js";

const log = Logger.create(LogModule.kktp.kkGameEngine);

/**
 * Default timeout values for network operations (ms).
 * Conservative values for low-end machines and unreliable networks.
 */
const TIMEOUTS = Object.freeze({
  INIT: 5000,
  CONNECT: 30000,
  WALLET: 30000,
  BALANCE: 10000,
  VRF: 5000,
  BLOCK_FETCH: 10000,
  QRNG: 15000,
  LOBBY_CREATE: 30000,
  LOBBY_JOIN: 3000,
  DISCONNECT: 5000,
});

/**
 * Game engine states
 */
export const GameState = {
  UNINITIALIZED: "uninitialized",
  INITIALIZING: "initializing",
  READY: "ready",
  IN_GAME: "in_game",
  ENDING: "ending",
  ERROR: "error",
};

/**
 * Game engine events
 */
export const GameEvent = {
  // Lifecycle
  INITIALIZED: "initialized",
  GAME_STARTED: "gameStarted",
  GAME_ENDED: "gameEnded",

  // Game Readiness (UTXO pool ready - instant game start)
  GAME_READY: "gameReady",
  POOL_LOW: "poolLow",

  // Moves
  MOVE_RECORDED: "moveRecorded",

  // Randomness
  RANDOM_GENERATED: "randomGenerated",

  // Wallet
  BALANCE_CHANGED: "balanceChanged",
  LOW_FUNDS: "lowFunds",

  // Multiplayer
  PLAYER_JOINED: "playerJoined",
  PLAYER_LEFT: "playerLeft",
  MESSAGE_RECEIVED: "messageReceived",
  CHAT_MESSAGE: "chatMessage",
  LOBBY_UPDATED: "lobbyUpdated",
  LOBBY_CLOSED: "lobbyClosed",
  GAME_START: "gameStart",
  READY_STATE: "readyState",

  // Anchoring
  ANCHOR_SENT: "anchorSent",
  ANCHOR_FAILED: "anchorFailed",

  // Opponent heartbeat pipeline
  OPPONENT_HEARTBEAT: "opponentHeartbeat",
  OPPONENT_MOVE_ANCHORED: "opponentMoveAnchored",

  // Errors
  ERROR: "error",
};

/**
 * KKGameEngine - Simple game engine for provably fair blockchain-backed games
 *
 * Hides all blockchain complexity from game developers.
 */
export class KKGameEngine {
  constructor() {
    this._state = GameState.UNINITIALIZED;
    this._adapter = null;
    this._anchor = null;
    this._session = null;
    this._lobby = null;
    this._walletName = null;

    this._gameId = null;
    this._playerId = null;
    this._genesisBlockHashHex = null;

    this._listeners = new Map();
    this._blockHandlers = [];
    this._blockStreamActive = false;
    this._blockUnsubscribe = null;
    this._balanceKas = 0;
    this._address = null;

    this._incomingRouterActive = false;
    this._incomingUnsubscribe = null;

    this._anchorPrefixHexes = [];

    // Cached audit data snapshot (captured before stop() wipes vault)
    this._cachedAuditData = null;

    // Track initialization promise to prevent double-init
    this._initPromise = null;

    // ── Graceful shutdown: track in-flight operations ──
    this._activeOperations = new Set();
    this._shuttingDown = false;

    // ── Logging mode tracker (for this instance API surface) ──
    // NOTE: logging() now controls GLOBAL logger settings.
    this._logModuleFilter = null;

    // ── Opponent heartbeat tracking ──
    // Per-opponent time accumulators keyed by playerId
    // Each value is { value: number } (high-water-mark in ms)
    this._opponentTimeAccumulators = new Map();
    // Set of our own anchor txIds so we can skip self-echoes
    this._ownAnchorTxIds = new Set();

    // ── N-player anchor chain tracking ──
    // Map<playerId, Set<txId>> - tracks each player's anchor chain
    // Used to identify which player sent a heartbeat via prevTxId linkage
    this._playerAnchorChains = new Map();

    // ── v5 custom action maps (set via startGame options) ──
    this._customActionMap = null;
    this._customAbilitiesMap = null;
    this._customActionsMap = null;
    this._customItemsMap = null;
    this._customStatusMap = null;
    this._customEmotesMap = null;
    this._customSystemMap = null;
  }

  /**
   * Control GLOBAL logging behavior.
   *
   * This method updates Logger's global switches so all modules follow
   * one policy:
   * - false: disable all logs
   * - true: enable all logs
   * - string / { root }: enable logs only for that module tree
   *
   * @param {boolean|string|Object} enabled - Logging configuration
   *   - false: Disable all logs globally
   *   - true: Enable all logs globally
   *   - string: Enable only the specified module tree globally
   *   - { root: string }: Enable only the specified module tree globally
   * @returns {KKGameEngine} For chaining
   */
  logging(enabled = false) {
    if (enabled === false) {
      this._logModuleFilter = "__disabled__";
      Logger.resetModules();
      Logger.setEnabled(false);
      return this;
    }

    if (typeof enabled === "string") {
      this._logModuleFilter = enabled;
      Logger.resetModules();
      Logger.setEnabled(false);
      Logger.enableModule(enabled);
      return this;
    }

    if (enabled && typeof enabled === "object") {
      const moduleName = enabled.root ?? null;
      if (moduleName) {
        this._logModuleFilter = moduleName;
        Logger.resetModules();
        Logger.setEnabled(false);
        Logger.enableModule(moduleName);
        return this;
      }
    }

    // enabled === true: show all logs globally
    this._logModuleFilter = null;
    Logger.resetModules();
    Logger.setEnabled(true);
    return this;
  }

  /**
   * Parse an anchor payload into a human-readable string.
   * @param {Object} anchorItem
   * @returns {string}
   */
  parseAnchor(anchorItem) {
    return parseAnchor(anchorItem);
  }

  /**
   * Audit a game session for cheating.
   *
   * If called with no arguments (or null), audits the most recent game
   * by scanning the DAG from genesisBlockHashHex using the current
   * gameIdTagHex. This is the recommended usage.
   *
   * Can also accept pre-collected audit data / anchor chain.
   *
   * @param {Object|Array|null} [auditDataOrChain] - Audit data, anchor chain, or null for auto
   * @returns {Promise<Object>} Audit verdict with passed/failed/reasons
   */
  async auditCheating(auditDataOrChain = null) {
    // Auto-fetch from DAG if no data provided
    if (!auditDataOrChain) {
      const dagData = await this.getAuditData();
      if (!dagData) {
        return {
          passed: false,
          verdict: "fail",
          reasons: ["no_audit_data_available"],
          warnings: [],
        };
      }
      return auditCheating(dagData);
    }

    // If passed an object with DAG scan params, fetch from DAG first
    if (auditDataOrChain && typeof auditDataOrChain === "object") {
      const hasDagParams =
        auditDataOrChain.gameId && auditDataOrChain.genesisBlockHashHex;
      if (hasDagParams) {
        const dagAudit = await this.getAuditData(auditDataOrChain);
        const merged = dagAudit
          ? {
              ...dagAudit,
              ...auditDataOrChain,
              anchorChain: dagAudit.anchorChain,
            }
          : auditDataOrChain;
        return auditCheating(merged);
      }
    }

    return auditCheating(auditDataOrChain);
  }

  // ═══════════════════════════════════════════════════════════════
  // LIFECYCLE - Init, Start, End
  // ═══════════════════════════════════════════════════════════════

  /**
   * Initialize the game engine with wallet credentials.
   *
   * Call this once when your game loads. After this, you can start games,
   * record moves, and use all other features.
   *
   * @param {Object} options - Configuration options
   * @param {string} options.password - Wallet password (user provides this)
   * @param {string} options.walletName - Wallet filename (user provides this)
   * @param {string} [options.rpcUrl] - Optional custom RPC URL for Kaspa node
   * @param {string} [options.network='testnet-10'] - Network to connect to
   * @param {Function} [options.onBalanceChange] - Called when wallet balance changes
   * @returns {Promise<{address: string, balance: number}>} Wallet info
   *
   * @example
   * const { address, balance } = await game.init({
   *   password: 'user-password',
   *   walletName: 'my-game-wallet',
   * });
   */
  async init(options = {}) {
    const {
      password,
      walletName,
      network = "testnet-10",
      rpcUrl,
      onBalanceChange,
    } = options;

    if (!password || !walletName) {
      throw new Error("KKGameEngine: password and walletName are required");
    }

    // Prevent double initialization
    if (this._initPromise) {
      return this._initPromise;
    }

    if (this._state === GameState.READY || this._state === GameState.IN_GAME) {
      return { address: this._address, balance: this._balanceKas };
    }

    this._state = GameState.INITIALIZING;

    this._initPromise = this._trackOperation((async () => {
      this._ensureNotShuttingDown();

      try {
        if (!this._adapter) {
          this._adapter = new KaspaAdapter();
        }

        // 1. Initialize WebAssembly
        await this._withTimeout(
          this._adapter.init(),
          TIMEOUTS.INIT,
          "WASM initialization timed out"
        );

        // 2. Connect to network
        await this._withTimeout(
          this._adapter.connect({
            networkId: network,
            rpcUrl,
            onBalanceChange: (balance) => {
              this._balanceKas = balance;
              this._emit(GameEvent.BALANCE_CHANGED, {
                balance: this._balanceKas,
              });
              onBalanceChange?.(this._balanceKas);

              // Warn if funds are low
              if (this._balanceKas < 1) {
                this._emit(GameEvent.LOW_FUNDS, { balance: this._balanceKas });
              }
            },
          }),
          TIMEOUTS.CONNECT,
          "Network connection timed out"
        );

        // 3. Open/create wallet
        this._walletName = walletName;
        const walletResult = await this._withTimeout(
          this._adapter.createOrOpenWallet({
            password,
            walletFilename: walletName,
          }),
          TIMEOUTS.WALLET,
          "Wallet initialization timed out. Check your network and try again.",
        );
        this._address = walletResult.address;

        // 4. Create anchor facade (handles move recording + blockchain proofs)
        // Custom action maps can be provided later via startGame()
        this._anchor = new KaspaAnchorFacade({
          adapter: this._adapter,
          customActionMap:     this._customActionMap,
          customAbilitiesMap:  this._customAbilitiesMap,
          customActionsMap:    this._customActionsMap,
          customItemsMap:      this._customItemsMap,
          customStatusMap:     this._customStatusMap,
          customEmotesMap:     this._customEmotesMap,
          customSystemMap:     this._customSystemMap,
        });

        // 5. Create session facade (for multiplayer messaging)
        this._session = new SessionFacade(this._adapter);

        // 6. Setup internal event forwarding
        this._setupEventForwarding();
        this._startIncomingPayloadRouter();

        // 7. Get initial balance
        const balanceSompi = await this._withTimeout(
          this._adapter.getBalance(),
          TIMEOUTS.BALANCE,
          "Balance fetch timed out"
        );
        this._balanceKas = Number(balanceSompi) / 100_000_000;

        // 8. Initialize VRF
        await this._withTimeout(
          this._adapter.initVRF(),
          TIMEOUTS.VRF,
          "VRF initialization timed out"
        );

        this._state = GameState.READY;
        this._emit(GameEvent.INITIALIZED, {
          address: this._address,
          balance: this._balanceKas,
        });

        return { address: this._address, balance: this._balanceKas };
      } catch (error) {
        this._state = GameState.ERROR;
        this._emit(GameEvent.ERROR, { error: error.message, phase: "init" });
        throw error;
      } finally {
        this._initPromise = null;
      }
    })());

    return this._initPromise;
  }

  /**
   * Set the game-layer SessionController so that the anchor processor
   * (AuditTrail, EntropyProvider) can read vrfSeed, block hashes, etc.
   * Called automatically by SessionController.setDependencies().
   * @param {Object} sessionController
   */
  setSessionController(sessionController) {
    this._anchor?.setSessionController?.(sessionController);
  }

  /**
   * Start a new game session.
   *
   * Call this when a player starts a match. After this, you can record moves.
   *
   * @param {Object} options - Game options
   * @param {string} [options.gameId] - Unique game ID (auto-generated if not provided)
   * @param {string} [options.playerId] - Player ID (auto-generated if not provided)
   * @param {string} [options.opponentId] - Opponent ID for multiplayer (optional)
   * @param {number} [options.delay] - Seconds to offset start DAA score into the future
   * @param {number} [options.gameLength] - Expected game duration in seconds
   * @returns {Promise<{gameId: string, playerId: string, genesisAnchor: Object}>}
   *
   * @example
   * const { gameId, playerId } = await game.startGame({
   *   gameId: 'match-abc123',
   *   playerId: 'player-1',
   * });
   */
  async startGame(options = {}) {
    this._ensureReady();

    const gameId =
      options.gameId ??
      `game-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const playerId =
      options.playerId ?? `player-${Math.random().toString(36).slice(2, 10)}`;
    const opponentId = options.opponentId ?? null;
    const delaySeconds = Number.isFinite(options.delay)
      ? Math.max(0, options.delay)
      : 0;
    const gameLengthSeconds = Number.isFinite(options.gameLength)
      ? Math.max(0, options.gameLength)
      : 0;

    this._gameId = gameId;
    this._playerId = playerId;
    this._genesisBlockHashHex = null;
    this._cachedAuditData = null; // Clear stale audit cache for new game

    // v5: Store custom action maps if provided
    if (options.customActionMap)    this._customActionMap    = options.customActionMap;
    if (options.customAbilitiesMap) this._customAbilitiesMap = options.customAbilitiesMap;
    if (options.customActionsMap)   this._customActionsMap   = options.customActionsMap;
    if (options.customItemsMap)     this._customItemsMap     = options.customItemsMap;
    if (options.customStatusMap)    this._customStatusMap    = options.customStatusMap;
    if (options.customEmotesMap)    this._customEmotesMap    = options.customEmotesMap;
    if (options.customSystemMap)    this._customSystemMap    = options.customSystemMap;

    // If custom maps were provided, update the packer's maps
    if (options.customActionMap || options.customAbilitiesMap || options.customActionsMap) {
      const { buildActionMaps } = await import("./core/constants.js");
      const maps = buildActionMaps({
        actionMap:     this._customActionMap,
        abilitiesMap:  this._customAbilitiesMap,
        actionsMap:    this._customActionsMap,
        itemsMap:      this._customItemsMap,
        statusMap:     this._customStatusMap,
        emotesMap:     this._customEmotesMap,
        systemMap:     this._customSystemMap,
      });
      this._anchor?.processor?._packer?.setActionMaps?.(maps);
    }

    // Start the anchor processor (handles merkle tree, VRF, etc.)
    this._anchor.startGame({
      gameId,
      playerId,
      opponentId,
    });

    this._subscribeAnchorPrefixes();

    let latestBlock = null;
    try {
      const blocks = await this._withTimeout(
        this._adapter.getKaspaBlocks(1),
        TIMEOUTS.BLOCK_FETCH,
        "Block fetch timed out"
      );
      latestBlock = blocks?.[0] ?? null;
      const blockHash = latestBlock?.hash ?? null;
      this._genesisBlockHashHex =
        typeof blockHash === "string" ? blockHash : null;
    } catch (e) {
      throw new Error(
        `KKGameEngine: Failed to fetch latest Kaspa block for DAA bounds (${e?.message ?? e})`,
      );
    }

    const baseDaaScore = Number(latestBlock?.daaScore ?? 0);
    if (!Number.isFinite(baseDaaScore) || baseDaaScore <= 0) {
      throw new Error(
        "KKGameEngine: Missing DAA score from latest Kaspa block",
      );
    }

    const startDaaScore = Math.floor(baseDaaScore + delaySeconds * 10);
    const endDaaScore = Math.floor(startDaaScore + gameLengthSeconds * 10);

    let prefetchedQrng = null;
    try {
      prefetchedQrng = await this._withTimeout(
        this._adapter.getQRNG("nist", 32),
        TIMEOUTS.QRNG,
        "QRNG fetch timed out"
      );
    } catch (e) {
      throw new Error(
        `KKGameEngine: Failed to fetch NIST QRNG (${e?.message ?? e})`,
      );
    }

    if (!prefetchedQrng || !Number.isFinite(prefetchedQrng.pulseIndex)) {
      throw new Error("KKGameEngine: Missing NIST pulse data");
    }

    // Prepare UTXOs for rapid transactions
    try {
      await this._anchor.prepareForGame();
    } catch (e) {
      log.warn(
        "KKGameEngine: Could not prepare UTXOs (may have low funds)",
        e.message,
      );
    }

    // Anchor genesis seed (captures initial randomness from blockchain)
    let genesisResult = null;
    try {
      genesisResult = await this._anchor.anchorGenesisSeed({
        startDaaScore,
        endDaaScore,
        prefetchedData: {
          qrng: prefetchedQrng,
        },
      });
    } catch (e) {
      log.warn("KKGameEngine: Genesis anchor failed", e.message);
      throw e;
    }

    this._state = GameState.IN_GAME;
    this._emit(GameEvent.GAME_STARTED, {
      gameId,
      playerId,
      genesis: genesisResult,
      genesisBlockHashHex: this._genesisBlockHashHex,
      startDaaScore,
      endDaaScore,
    });

    return {
      gameId,
      gameIdTagHex: this._anchor?.processor?.gameIdTagHex ?? null,
      genesisBlockHashHex: this._genesisBlockHashHex,
      playerId,
      genesisAnchor: genesisResult,
    };
  }

  /**
   * End the current game and anchor final state to blockchain.
   *
   * Call this when the game is over. This creates an immutable on-chain
   * record of the game result that can be verified by anyone.
   *
   * @param {Object} [endState] - Final game state
   * @param {number} [endState.score] - Final score
   * @param {number} [endState.coins] - Coins collected
   * @param {string} [endState.result] - 'win', 'lose', 'draw', etc.
   * @param {Object} [endState.metadata] - Any additional data
   * @returns {Promise<{success: boolean, txId: string|null, auditData: Object}>}
   *
   * @example
   * const result = await game.endGame({
   *   score: 1500,
   *   coins: 42,
   *   result: 'win',
   * });
   */
  async endGame(endState = {}) {
    if (this._state !== GameState.IN_GAME) {
      log.warn("KKGameEngine: No active game to end");
      return { success: false, txId: null, auditData: null };
    }

    this._state = GameState.ENDING;

    let result = { success: false, txId: null, auditData: null };

    try {
      // Anchor final state to blockchain before stopping processors
      const anchorResult = await this._anchor.anchorFinalState(endState);

      // CRITICAL: Get audit data BEFORE stopping - stop() wipes the vault
      const auditData = this._anchor.getAuditData();

      // Cache the audit snapshot so getAuditData() returns it after stop
      this._cachedAuditData = auditData;

      // Stop the anchor processor after collecting audit data
      await this._anchor.stopGame();

      result = {
        success: anchorResult?.success ?? true,
        txId: anchorResult?.txId ?? null,
        auditData,
      };

      this._emit(GameEvent.GAME_ENDED, {
        gameId: this._gameId,
        endState,
        ...result,
      });
    } catch (error) {
      result = {
        success: false,
        txId: null,
        auditData: null,
        error: error.message,
      };
      this._emit(GameEvent.ERROR, { error: error.message, phase: "endGame" });
    }

    this._clearAnchorPrefixes();
    this._opponentTimeAccumulators.clear();
    this._ownAnchorTxIds.clear();
    this._playerAnchorChains.clear();

    this._state = GameState.READY;
    this._gameId = null;
    this._playerId = null;

    return result;
  }

  /**
   * Completely shutdown the game engine.
   *
   * Call this when the user exits the game entirely. Closes wallet,
   * disconnects from network, and releases all resources.
   *
   * Implements graceful shutdown:
   * 1. Signals shutdown intent (rejects new operations)
   * 2. Drains all in-flight async operations
   * 3. Cleans up all resources to prevent memory leaks
   * 4. Nulls references only after everything is settled
   */
  async shutdown() {
    // Signal shutdown intent - new operations will be rejected
    this._shuttingDown = true;

    // End any active game first
    if (this._state === GameState.IN_GAME) {
      try {
        await this.endGame();
      } catch (e) {
        log.warn("KKGameEngine: Error ending game during shutdown", e?.message);
      }
    }

    // ── Drain active operations ──
    // Wait for all in-flight promises to settle (success or failure)
    if (this._activeOperations.size > 0) {
      log.debug("KKGameEngine: Draining active operations", {
        count: this._activeOperations.size,
      });
      await Promise.allSettled([...this._activeOperations]);
    }

    // ── Clean up block stream (prevent memory leak) ──
    if (this._blockUnsubscribe) {
      try {
        this._blockUnsubscribe();
      } catch (e) {
        log.warn("KKGameEngine: Error unsubscribing block stream", e?.message);
      }
    }
    this._blockUnsubscribe = null;
    this._blockHandlers = [];
    this._blockStreamActive = false;

    // ── Clean up anchor prefixes ──
    this._clearAnchorPrefixes();

    // ── Clean up incoming router ──
    if (typeof this._incomingUnsubscribe === "function") {
      try {
        this._incomingUnsubscribe();
      } catch (e) {
        log.warn("KKGameEngine: Error unsubscribing incoming router", e?.message);
      }
    }
    this._incomingUnsubscribe = null;
    this._incomingRouterActive = false;

    // ── Destroy subsystems ──
    try {
      this._anchor?.destroy();
    } catch (e) {
      log.warn("KKGameEngine: Error destroying anchor", e?.message);
    }

    // ── Disconnect adapter with timeout ──
    if (this._adapter) {
      try {
        await this._withTimeout(
          this._adapter.disconnect(),
          TIMEOUTS.DISCONNECT,
          "Disconnect timed out"
        );
      } catch (e) {
        log.warn("KKGameEngine: Error disconnecting adapter", e?.message);
      }
    }

    // ── Clear all tracking state ──
    this._opponentTimeAccumulators.clear();
    this._ownAnchorTxIds.clear();
    this._playerAnchorChains.clear();
    this._listeners.clear();
    this._activeOperations.clear();

    // ── Null references LAST (after all async work is done) ──
    this._adapter = null;
    this._anchor = null;
    this._session = null;
    this._lobby = null;
    this._initPromise = null;
    this._cachedAuditData = null;

    this._state = GameState.UNINITIALIZED;
    this._shuttingDown = false;
  }

  // ═══════════════════════════════════════════════════════════════
  // MOVES - Record and receive game actions
  // ═══════════════════════════════════════════════════════════════

  /**
   * Record a player move with provable randomness.
   *
   * This is the core method for recording game actions. Each move:
   * - Gets a cryptographically verifiable random number
   * - Is added to a tamper-proof merkle tree
   * - Can later be anchored to the blockchain
   *
   * @param {string} action - Move type (e.g., 'jump', 'attack', 'use_item')
   * @param {Object} [data] - Additional move data
   * @param {number} [data.lane] - Lane/position (for lane-based games)
   * @param {*} [data.*] - Any other game-specific data
   * @returns {Promise<{moveId: string, sequence: number, randomValue: string, randomNumber: number}>}
   *
   * @example
   * // Simple move
   * const move = await game.recordMove('jump');
   *
   * // Move with data
   * const move = await game.recordMove('attack', {
   *   lane: 2,
   *   targetId: 'enemy-1',
   * });
   *
   * // Use the random value for game logic
   * const damage = Math.floor(move.randomNumber * 50) + 10; // 10-60 damage
   */
  async recordMove(action, data = {}) {
    this._ensureInGame();

    const move = await this._anchor.processMove(action, data);

    // Extract random value from VRF output (32 bytes = 64 hex chars)
    const randomValue = move.vrfOutput ?? "";
    // Convert first 8 hex chars to a 0-1 float for convenience
    const randomNumber = randomValue
      ? parseInt(randomValue.slice(0, 8), 16) / 0xffffffff
      : Math.random();

    const result = {
      moveId: move.moveId,
      sequence: move.sequence,
      randomValue,
      randomNumber,
      timestamp: move.timestamp,
      merkleRoot: move.merkleRoot,
    };

    // v5: forward x/y/z for MOVE actions so the caller can see them
    if (data.x != null || data.y != null || data.z != null) {
      result.x = data.x;
      result.y = data.y;
      result.z = data.z;
    }

    this._emit(GameEvent.MOVE_RECORDED, result);
    this._emit(GameEvent.RANDOM_GENERATED, { randomValue, randomNumber });

    return result;
  }

  /**
   * Record a game event (coins, collisions, powerups, etc.)
   *
   * Use this for non-move events that should be part of the game record.
   *
   * @param {string} eventType - Event type ('coin_collected', 'collision', 'powerup', etc.)
   * @param {Object} [data] - Event data
   * @returns {Object} Event record
   *
   * @example
   * game.recordEvent('coin_collected', { lane: 1, value: 10 });
   * game.recordEvent('powerup_collected', { type: 'shield', duration: 5000 });
   */
  recordEvent(eventType, data = {}) {
    this._ensureInGame();
    return this._anchor.processGameEvent(eventType, data);
  }

  /**
   * Receive and validate an opponent's move (multiplayer).
   *
   * @param {Object} moveData - Move data received from opponent
   * @returns {Promise<{valid: boolean, move: Object, reason?: string}>}
   */
  async receiveOpponentMove(moveData) {
    this._ensureInGame();

    const result = await this._anchor.receiveOpponentMove(moveData);

    return result;
  }

  // ═══════════════════════════════════════════════════════════════
  // RANDOMNESS - Get provable random numbers
  // ═══════════════════════════════════════════════════════════════

  /**
   * Subscribe to live Kaspa block stream.
   * @param {Function} handler - Called with each new block
   */
  onBlock(handler) {
    this._blockHandlers.push(handler);
    if (!this._blockStreamActive) {
      // Start the underlying kaspaPortal stream only once
      this._blockStreamActive = true;
      this._blockUnsubscribe = this._adapter.onNewBlock((block) => {
        for (const cb of this._blockHandlers) {
          try {
            cb(block);
          } catch (e) {
            log.warn("KKGameEngine: onBlock handler error", e);
          }
        }
      });
    }
  }

  /**
   * Unsubscribe a handler from the live Kaspa block stream.
   * @param {Function} handler - Handler to remove
   */
  offBlock(handler) {
    if (handler) {
      // Remove all instances of the given handler
      this._blockHandlers = this._blockHandlers.filter((cb) => cb !== handler);
    } else {
      // Remove the most recently added handler
      this._blockHandlers.pop();
    }
    if (this._blockHandlers.length === 0 && this._blockUnsubscribe) {
      this._blockUnsubscribe();
      this._blockStreamActive = false;
      this._blockUnsubscribe = null;
    }
  }

  async getKaspaBlocks(n) {
    this._ensureReady();
    return await this._withTimeout(
      this._adapter.getKaspaBlocks(n),
      TIMEOUTS.BLOCK_FETCH,
      "Block fetch timed out"
    );
  }

  /**
   * Fetch quantum random numbers through the engine facade.
   * @param {string} [provider='nist'] - QRNG provider
   * @param {number} [length=32] - Number of bytes
   * @returns {Promise<Object>}
   */
  async getQRNG(provider = "nist", length = 32) {
    this._ensureReady();

    if (!this._adapter?.getQRNG) {
      throw new Error("KKGameEngine: QRNG provider unavailable");
    }

    const result = await this._withTimeout(
      this._adapter.getQRNG(provider, length),
      TIMEOUTS.QRNG,
      "QRNG fetch timed out"
    );
    const pulse = result?.pulse ?? result;
    if (!pulse?.pulseIndex) {
      return result;
    }

    const outputValue =
      typeof pulse.outputValue === "string"
        ? pulse.outputValue
        : (pulse.outputValue?.value ??
          pulse.outputValue?.outputValue ??
          pulse.outputValue?.output ??
          "");

    const signatureValue =
      typeof pulse.signatureValue === "string"
        ? pulse.signatureValue
        : (pulse.signatureValue?.value ??
          pulse.signatureValue?.signatureValue ??
          pulse.signatureValue?.signature ??
          "");

    return {
      ...pulse,
      outputValue,
      signatureValue,
    };
  }

  /**
   * Get a provable random number.
   *
   * This generates cryptographically secure randomness using blockchain
   * entropy. The randomness can be independently verified by anyone.
   *
   * @param {Object} [options] - Options
   * @param {string} [options.seed] - Additional seed input
   * @returns {Promise<{value: string, number: number, proof: Object}>}
   *
   * @example
   * // Get random for game logic
   * const random = await game.getRandom();
   * const diceRoll = Math.floor(random.number * 6) + 1; // 1-6
   *
   * // Get random with custom seed
   * const random = await game.getRandom({ seed: 'turn-5-attack' });
   */
  async getRandom(options = {}) {
    this._ensureReady();

    const seed = options.seed ?? `rand-${Date.now()}-${Math.random()}`;

    const result = await this._withTimeout(
      this._adapter.prove({ seedInput: seed }),
      TIMEOUTS.VRF,
      "VRF prove operation timed out"
    );

    const value = result.finalOutput ?? "";
    const number = value
      ? parseInt(value.slice(0, 8), 16) / 0xffffffff
      : Math.random();

    const output = {
      value,
      number,
      proof: result.proof,
    };

    this._emit(GameEvent.RANDOM_GENERATED, {
      randomValue: value,
      randomNumber: number,
    });

    return output;
  }

  /**
   * Shuffle an array using provable randomness.
   *
   * @param {Array} array - Array to shuffle
   * @returns {Promise<Array>} New shuffled array
   *
   * @example
   * const deck = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
   * const shuffled = await game.shuffle(deck);
   */
  async shuffle(array) {
    this._ensureReady();
    return await this._withTimeout(
      this._adapter.shuffle(array),
      TIMEOUTS.VRF,
      "Shuffle operation timed out"
    );
  }

  // ═══════════════════════════════════════════════════════════════
  // GAME READINESS - UTXO pool for instant game start
  // ═══════════════════════════════════════════════════════════════

  /**
   * Subscribe to game readiness events.
   *
   * Use this to know when the game is ready for instant start.
   * The handler is called when UTXO pool is ready for rapid transactions.
   *
   * @param {Function} handler - Called with { poolStatus } when game is ready
   * @returns {Function} Unsubscribe function
   *
   * @example
   * const unsubscribe = game.onGameReady((data) => {
   *   console.log('Game ready!', data.poolStatus);
   *   enableStartButton();
   * });
   */
  onGameReady(handler) {
    return this.on(GameEvent.GAME_READY, handler);
  }

  /**
   * Get current UTXO pool status.
   *
   * Use this to check if the game is ready before starting,
   * or to show pool health in the UI.
   *
   * @returns {{available: number, reserved: number, isReady: boolean, isDegraded: boolean}}
   *
   * @example
   * const status = game.getPoolStatus();
   * if (status.isReady) {
   *   startGame();
   * } else if (status.isDegraded) {
   *   showWarning('Low funds - game may have issues');
   * }
   */
  getPoolStatus() {
    if (!this._anchor?.getPoolStatus) {
      return { available: 0, reserved: 0, isReady: false, isDegraded: true };
    }
    return this._anchor.getPoolStatus();
  }

  /**
   * Prepare UTXO pool for instant game start.
   *
   * Call this during lobby join/create to pre-split UTXOs.
   * This ensures game start is instant with no network delays.
   *
   * The GAME_READY event fires when preparation completes.
   *
   * @returns {Promise<{success: boolean, poolStatus: Object}>}
   *
   * @example
   * // In lobby UI, after joining:
   * await game.prepareUtxoPool();
   * // Now game.startGame() will be instant
   */
  async prepareUtxoPool() {
    this._ensureReady();

    if (!this._anchor?.ensureUtxoPoolReady) {
      throw new Error("Anchor facade not initialized");
    }

    const result = await this._anchor.ensureUtxoPoolReady();

    if (result.success) {
      this._emit(GameEvent.GAME_READY, { poolStatus: result.poolStatus });
    }

    return result;
  }

  // ═══════════════════════════════════════════════════════════════
  // MULTIPLAYER - Lobbies and messaging
  // ═══════════════════════════════════════════════════════════════

  /**
   * Create a multiplayer lobby.
   *
   * @param {Object} options - Lobby options
   * @param {string} [options.name] - Lobby name
   * @param {string} [options.game] - Game name
   * @param {number} [options.maxPlayers] - Maximum players allowed
   * @param {string} [options.displayName] - Your display name in the lobby
   * @returns {Promise<{lobbyId: string, joinCode: string}>}
   *
   * @example
   * const lobby = await game.createLobby({
   *   name: 'My Game Room',
   *   game: 'Slap Jack',
   *   maxPlayers: 4,
   *   displayName: 'Player1',
   * });
   * console.log('Share this code:', lobby.joinCode);
   */
  async createLobby(options = {}) {
    this._ensureReady();
    this._ensureNotShuttingDown();
    this._ensureLobby();

    const lobbyName = options.lobbyName ?? options.name ?? "KKTP Lobby";
    const gameName = options.gameName ?? options.game ?? "KKTP Game";
    const maxMembers = options.maxMembers ?? options.maxPlayers ?? 2;
    const displayName = options.displayName ?? undefined;

    const result = await this._withTimeout(
      this._lobby.hostLobby({
        ...options,
        lobbyName,
        gameName,
        maxMembers,
        displayName,
      }),
      TIMEOUTS.LOBBY_CREATE,
      "Lobby creation timed out"
    );

    return {
      lobbyId: result.lobbyId ?? this._lobby.getGroupMailboxId(),
      joinCode: result.joinCode,
    };
  }

  /**
   * Join an existing lobby.
   *
   * @param {string|Object} lobbyOrCode - Join code or lobby discovery anchor
   * @param {string} [displayName] - Your display name in the lobby
   * @returns {Promise<{success: boolean, lobbyId: string}>}
   */
  async joinLobby(lobbyOrCode, displayName) {
    this._ensureReady();
    this._ensureNotShuttingDown();
    this._ensureLobby();

    const result = await this._lobby.joinLobby(lobbyOrCode, displayName);

    return {
      success: true,
      lobbyId: this._lobby.getGroupMailboxId(),
      ...result,
    };
  }

  /**
   * Discover lobbies with a callback.
   *
   * @param {Function} onLobby - Callback for each discovered lobby
   * @param {string|null} [prefix] - Optional payload prefix override
   * @returns {Function} Unsubscribe function
   */
  searchLobbies(onLobby, prefix = null) {
    this._ensureReady();
    this._ensureLobby();

    let stopped = false;
    let controller = null;

    const start = async () => {
      try {
        controller = await this._lobby.discoverLobby({
          prefix:
            typeof prefix === "string" && prefix.length > 0
              ? prefix
              : undefined,
          onLobby,
        });

        if (stopped) {
          controller?.stop?.();
        }
      } catch (err) {
        this._emit(GameEvent.ERROR, {
          error: err?.message || String(err),
          phase: "lobby_search",
        });
      }
    };

    void start();

    return () => {
      stopped = true;
      controller?.stop?.();
    };
  }

  /**
   * Leave the current lobby.
   *
   * @param {string} [reason] - Reason for leaving
   */
  async leaveLobby(reason) {
    if (this._lobby) {
      await this._lobby.leaveLobby(reason);
    }
  }

  /**
   * Close the current lobby (host only).
   *
   * @param {string} [reason] - Reason for closing
   */
  async closeLobby(reason) {
    this._ensureLobby();
    if (this._lobby) {
      await this._lobby.closeLobby(reason);
    }
  }

  /**
   * Send a message to everyone in the lobby.
   *
   * @param {string|Object} message - Message to send
   */
  async sendLobbyMessage(message) {
    this._ensureLobby();
    if (this._lobby?.currentState === LOBBY_STATES.JOINING) {
      const joined = await this._waitForLobbyState(LOBBY_STATES.MEMBER, 15000);
      if (!joined) {
        throw new Error("Lobby join not completed yet");
      }
    }
    const text =
      typeof message === "string" ? message : JSON.stringify(message);
    await this._lobby.sendGroupMessage(text);
  }

  /**
   * Get current lobby members.
   *
   * @returns {Array<{id: string, name: string, isHost: boolean}>}
   */
  getLobbyMembers() {
    const members = this._lobby?.members ?? [];
    return members.map((member) => ({
      id: member?.pubSig ?? member?.id ?? null,
      name: member?.displayName ?? member?.name ?? null,
      isHost: member?.role === "host" || member?.isHost === true,
    }));
  }

  /**
   * Check if we are the lobby host.
   *
   * @returns {boolean}
   */
  get isLobbyHost() {
    return this._lobby?.isHost ?? false;
  }

  /**
   * Check if we are currently in a lobby.
   * @returns {boolean}
   */
  isInLobby() {
    return this._lobby?.isInLobby?.() ?? false;
  }

  /**
   * Get current lobby info.
   * @returns {Object|null}
   */
  get lobbyInfo() {
    return this._lobby?.lobbyInfo ?? null;
  }

  // ═══════════════════════════════════════════════════════════════
  // WALLET - Balance and address info
  // ═══════════════════════════════════════════════════════════════

  /**
   * Get the wallet address.
   *
   * @returns {string|null}
   */
  get address() {
    return this._address;
  }

  /**
   * Get the current balance in KAS.
   *
   * @returns {number}
   */
  get balance() {
    return this._balanceKas;
  }

  /**
   * Refresh and get current balance.
   *
   * @returns {Promise<number>} Balance in KAS
   */
  async getBalance() {
    this._ensureReady();
    const sompi = await this._withTimeout(
      this._adapter.getBalance(),
      TIMEOUTS.BALANCE,
      "Balance fetch timed out"
    );
    this._balanceKas = Number(sompi) / 100_000_000;
    return this._balanceKas;
  }

  /**
   * Get the wallet mnemonic after password verification.
   * @param {Object} options
   * @param {string} options.password
   * @returns {Promise<string>}
   */
  async getMnemonic(options = {}) {
    this._ensureReady();
    const password = options.password ?? "";
    const walletName = this._walletName;

    if (!walletName) {
      throw new Error("KKGameEngine: wallet not initialized");
    }
    if (!password) {
      throw new Error("KKGameEngine: password is required");
    }

    const walletResult = await this._withTimeout(
      this._adapter.createOrOpenWallet({
        password,
        walletFilename: walletName,
      }),
      TIMEOUTS.WALLET,
      "Wallet open timed out"
    );
    if (walletResult?.address) {
      this._address = walletResult.address;
    }

    return await this._withTimeout(
      this._adapter.getMnemonic(),
      TIMEOUTS.WALLET,
      "Mnemonic fetch timed out"
    );
  }

  /**
   * Delete a wallet from browser storage after password verification.
   * @param {Object} options
   * @param {string} options.password
   * @param {string} [options.walletName]
   * @returns {Promise<void>}
   */
  async deleteWallet(options = {}) {
    this._ensureReady();
    const password = options.password ?? "";
    const walletName = options.walletName ?? this._walletName;

    if (!walletName) {
      throw new Error("KKGameEngine: wallet not initialized");
    }
    if (!password) {
      throw new Error("KKGameEngine: password is required");
    }

    await this._withTimeout(
      this._adapter.createOrOpenWallet({
        password,
        walletFilename: walletName,
      }),
      TIMEOUTS.WALLET,
      "Wallet open timed out"
    );
    if (this._adapter.closeWallet) {
      await this._withTimeout(
        this._adapter.closeWallet(),
        TIMEOUTS.WALLET,
        "Wallet close timed out"
      );
    }
    await this._withTimeout(
      this._adapter.deleteWallet(walletName),
      TIMEOUTS.WALLET,
      "Wallet delete timed out"
    );

    if (walletName === this._walletName) {
      this._walletName = null;
      this._address = null;
      this._balanceKas = 0;
    }
  }

  /**
   * List all wallet filenames stored in browser storage.
   * Does not require an active wallet — only needs WASM + adapter init.
   *
   * @returns {Promise<Array>} Array of wallet descriptors
   *
   * @example
   * const wallets = await game.getAllWallets();
   * wallets.forEach(w => console.log(w.filename ?? w.title));
   */
  async getAllWallets() {
    if (!this._adapter) {
      this._adapter = new KaspaAdapter();
      await this._withTimeout(
        this._adapter.init(),
        TIMEOUTS.INIT,
        "WASM initialization timed out",
      );
    }

    try {
      const wallets = await this._adapter.getAllWallets();
      if (Array.isArray(wallets) && wallets.length > 0) {
        return wallets;
      }
    } catch (err) {
      // Some environments require full wallet service initialization
      // before walletEnumerate() works. Fall back to IndexedDB listing.
      log.debug("KKGameEngine.getAllWallets adapter enumerate failed; using IndexedDB fallback", err?.message ?? err);
    }

    return await this._listWalletsFromIndexedDb();
  }

  /**
   * Fallback wallet listing from the encrypted wallet metadata store.
   * @returns {Promise<Array<{filename: string, title: string}>>}
   */
  async _listWalletsFromIndexedDb() {
    if (typeof indexedDB === "undefined") return [];

    return await new Promise((resolve) => {
      const req = indexedDB.open("KaspaWalletDB", 2);

      req.onerror = () => resolve([]);
      req.onupgradeneeded = () => {
        // DB newly created / upgraded with no existing wallet entries.
        resolve([]);
      };
      req.onsuccess = () => {
        try {
          const db = req.result;
          if (!db.objectStoreNames.contains("MetaDataStore")) {
            resolve([]);
            return;
          }

          const tx = db.transaction("MetaDataStore", "readonly");
          const store = tx.objectStore("MetaDataStore");
          const keysReq = store.getAllKeys();

          keysReq.onerror = () => resolve([]);
          keysReq.onsuccess = () => {
            const keys = Array.isArray(keysReq.result) ? keysReq.result : [];
            const wallets = keys
              .map((key) => String(key ?? "").trim())
              .filter((name) => name.length > 0)
              .map((name) => ({ filename: name, title: name }));
            resolve(wallets);
          };
        } catch {
          resolve([]);
        }
      };
    });
  }

  /**
   * Send KAS to an address.
   *
   * @param {Object} options - Transaction options
   * @param {string} options.toAddress - Recipient Kaspa address
   * @param {string|number} options.amount - Amount in KAS (e.g., '1.5')
   * @param {string} [options.payload] - Optional OP_RETURN message
   * @param {number} [options.priorityFeeKas] - Priority fee in KAS
   * @returns {Promise<Object>} Transaction result with txid
   *
   * @example
   * await game.send({ toAddress: 'kaspa:qz...', amount: '2.5' });
   */
  async send(options = {}) {
    this._ensureReady();
    if (!options.toAddress || !options.amount) {
      throw new Error("KKGameEngine: toAddress and amount are required");
    }
    return await this._adapter.send(options);
  }

  /**
   * Check if the engine has enough funds for gameplay.
   *
   * @returns {boolean}
   */
  get hasSufficientFunds() {
    return this._balanceKas >= 0.5;
  }

  // ═══════════════════════════════════════════════════════════════
  // STATE - Current engine state
  // ═══════════════════════════════════════════════════════════════

  /**
   * Get current engine state.
   *
   * @returns {GameState}
   */
  get state() {
    return this._state;
  }

  /**
   * Check if engine is initialized and ready.
   *
   * @returns {boolean}
   */
  get isReady() {
    return this._state === GameState.READY || this._state === GameState.IN_GAME;
  }

  /**
   * Check if a game is currently active.
   *
   * @returns {boolean}
   */
  get isInGame() {
    return this._state === GameState.IN_GAME;
  }

  /**
   * Get current game ID.
   *
   * @returns {string|null}
   */
  get gameId() {
    return this._gameId;
  }

  /**
   * Get current player ID.
   *
   * @returns {string|null}
   */
  get playerId() {
    return this._playerId;
  }

  // ═══════════════════════════════════════════════════════════════
  // AUDIT - Get proof and verification data
  // ═══════════════════════════════════════════════════════════════

  /**
   * Get all audit data for the current game.
   *
   * Use this to verify game integrity or share proof of gameplay.
   *
   * @param {Object|string} [options] - Options or gameId for DAG scanning
   * @param {string} [genesisBlockHashHex] - Required when passing gameId
   * @returns {Object|Promise<Object>|null} Audit data including merkle proofs
   */
  getAuditData(options = {}, genesisBlockHashHex = null) {
    // Return cached snapshot if available (after endGame() wipes the vault)
    if (
      !options ||
      (typeof options === "object" &&
        !options.gameId &&
        !options.genesisBlockHashHex)
    ) {
      if (this._cachedAuditData) {
        return this._cachedAuditData;
      }
    }

    if (typeof options === "string") {
      const gameId = options;
      if (!genesisBlockHashHex) {
        throw new Error(
          "KKGameEngine: genesisBlockHashHex is required for DAG audit",
        );
      }
      return (
        this._anchor?.getAuditDataFromDag({
          gameId,
          genesisBlockHashHex,
        }) ?? null
      );
    }
    if (
      options &&
      typeof options === "object" &&
      options.gameId &&
      options.genesisBlockHashHex
    ) {
      return this._anchor?.getAuditDataFromDag(options) ?? null;
    }
    return this._anchor?.getAuditData(options) ?? null;
  }

  /**
   * Get the genesis anchor transaction ID.
   * @returns {string|null}
   */
  get genesisTxId() {
    return this._anchor?.processor?.genesisTxId ?? null;
  }

  /**
   * Get the last anchor transaction ID.
   * @returns {string|null}
   */
  get lastAnchorTxId() {
    return this._anchor?.processor?.lastAnchorTxId ?? null;
  }

  /**
   * Get the hex-encoded game ID tag used for on-chain prefix matching.
   * @returns {string|null}
   */
  get gameIdTagHex() {
    return this._anchor?.processor?.gameIdTagHex ?? null;
  }

  /**
   * Get the genesis block hash hex used for DAG scanning bounds.
   * @returns {string|null}
   */
  get genesisBlockHashHex() {
    return this._genesisBlockHashHex;
  }

  /**
   * Get the merkle root (fingerprint of all moves).
   *
   * @returns {string|null}
   */
  getMerkleRoot() {
    return this._anchor?.getMerkleRoot() ?? null;
  }

  /**
   * Get complete move history with proofs.
   *
   * @returns {Array}
   */
  getMoveHistory() {
    return this._anchor?.getMoveHistory() ?? [];
  }

  /**
   * Get total move count in current game.
   *
   * @returns {number}
   */
  getMoveCount() {
    return this._anchor?.getMoveCount() ?? 0;
  }

  // ═══════════════════════════════════════════════════════════════
  // EVENTS - Subscribe to game events
  // ═══════════════════════════════════════════════════════════════

  /**
   * Subscribe to a game event.
   *
   * @param {string} event - Event name from GameEvent
   * @param {Function} handler - Event handler
   * @returns {this} For chaining
   *
   * @example
   * game.on(GameEvent.MOVE_RECORDED, (move) => {
   *   console.log('Move recorded:', move);
   * });
   *
   * game.on(GameEvent.BALANCE_CHANGED, (data) => {
   *   console.log('Balance:', data.balance, 'KAS');
   * });
   */
  on(event, handler) {
    if (!this._listeners.has(event)) {
      this._listeners.set(event, new Set());
    }
    this._listeners.get(event).add(handler);
    return this;
  }

  /**
   * Unsubscribe from a game event.
   *
   * @param {string} event - Event name
   * @param {Function} handler - Handler to remove
   * @returns {this}
   */
  off(event, handler) {
    this._listeners.get(event)?.delete(handler);
    return this;
  }

  /**
   * Subscribe to an event for one occurrence only.
   *
   * @param {string} event - Event name
   * @param {Function} handler - Event handler
   * @returns {this}
   */
  once(event, handler) {
    const wrapper = (...args) => {
      this.off(event, wrapper);
      handler(...args);
    };
    return this.on(event, wrapper);
  }

  // ═══════════════════════════════════════════════════════════════
  // OPPONENT HEARTBEAT - Convenience subscriptions
  // ═══════════════════════════════════════════════════════════════

  /**
   * Subscribe to opponent heartbeat batches.
   *
   * Fires once per inbound heartbeat TX with the full parsed batch.
   *
   * @param {Function} handler - Receives { txId, playerId, header, moveCount, moves, timestamp }
   * @returns {this}
   *
   * @example
   * game.onOpponentHeartbeat((hb) => {
   *   console.log(`Opponent sent ${hb.moveCount} moves in tx ${hb.txId}`);
   * });
   */
  onOpponentHeartbeat(handler) {
    return this.on(GameEvent.OPPONENT_HEARTBEAT, handler);
  }

  /**
   * Subscribe to individual opponent moves extracted from heartbeats.
   *
   * Fires once per move across all heartbeats. Each move carries a unique
   * `moveId` (`${txId}-${sequenceIndex}`) and a cumulative `sessionTimeMs`.
   *
   * @param {Function} handler - Receives { moveId, playerId, action, lane,
   *   timeDeltaMs, rawDelta, vrfFragment, sessionTimeMs, sequence, txId }
   * @returns {this}
   *
   * @example
   * game.onOpponentMoveAnchored((move) => {
   *   console.log(`Opponent ${move.action} lane ${move.lane} at ${move.sessionTimeMs}ms`);
   * });
   */
  onOpponentMoveAnchored(handler) {
    return this.on(GameEvent.OPPONENT_MOVE_ANCHORED, handler);
  }

  /**
   * Manually register a txId as "ours" so the heartbeat router skips it.
   * Normally this is automatic via ANCHOR_SENT events, but callers that
   * send anchors outside the standard pipeline can use this.
   *
   * @param {string} txId
   */
  registerOwnAnchorTxId(txId) {
    if (txId) this._ownAnchorTxIds.add(txId);
  }

  // ═══════════════════════════════════════════════════════════════
  // INTERNAL HELPERS
  // ═══════════════════════════════════════════════════════════════

  /** @private */
  _emit(event, data) {
    const handlers = this._listeners.get(event);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(data);
        } catch (e) {
          log.error(`KKGameEngine: Error in ${event} handler:`, e);
        }
      }
    }
  }

  /** @private */
  _ensureReady() {
    if (this._state === GameState.UNINITIALIZED) {
      throw new Error("KKGameEngine: Call init() first");
    }
    if (this._state === GameState.INITIALIZING) {
      throw new Error("KKGameEngine: Still initializing, please wait");
    }
    if (this._state === GameState.ERROR) {
      throw new Error(
        "KKGameEngine: Engine is in error state, call init() again",
      );
    }
  }

  /** @private */
  _ensureInGame() {
    this._ensureReady();
    if (this._state !== GameState.IN_GAME) {
      throw new Error("KKGameEngine: Call startGame() first");
    }
  }

  get anchorProcessor() {
    return this._anchor?.processor ?? null;
  }

  get isUtxoReady() {
    return this._anchor?.isUtxoReady ?? false;
  }

  /** @private */
  _subscribeAnchorPrefixes() {
    if (
      !this._adapter?.addPrefixHex ||
      !this._anchor?.processor?.gameIdTagHex
    ) {
      return;
    }

    this._clearAnchorPrefixes();

    const tagHex = this._anchor.processor.gameIdTagHex;
    const prefixes = [
      `${BLOCKCHAIN.PREFIX_GAME_START_HEX}${tagHex}`,
      `${BLOCKCHAIN.PREFIX_HEARTBEAT_HEX}${tagHex}`,
      `${BLOCKCHAIN.PREFIX_GAME_END_HEX}${tagHex}`,
    ];

    for (const prefixHex of prefixes) {
      this._adapter.addPrefixHex(prefixHex);
    }

    this._anchorPrefixHexes = prefixes;
  }

  /** @private */
  _clearAnchorPrefixes() {
    if (
      !this._adapter?.removePrefixHex ||
      this._anchorPrefixHexes.length === 0
    ) {
      this._anchorPrefixHexes = [];
      return;
    }

    for (const prefixHex of this._anchorPrefixHexes) {
      this._adapter.removePrefixHex(prefixHex);
    }

    this._anchorPrefixHexes = [];
  }

  /** @private */
  _ensureLobby() {
    if (!this._lobby && this._session) {
      this._lobby = new LobbyFacade(this._session);

      // Forward lobby events
      this._lobby.onMemberJoin?.((member) => {
        this._emit(GameEvent.PLAYER_JOINED, {
          ...member,
          id: member?.pubSig ?? member?.id ?? null,
          name: member?.displayName ?? member?.name ?? null,
        });
      });
      this._lobby.onMemberLeave?.((member) => {
        this._emit(GameEvent.PLAYER_LEFT, {
          ...member,
          id: member?.pubSig ?? member?.id ?? null,
          name: member?.displayName ?? member?.name ?? null,
        });
      });
      this._lobby.onGroupMessage?.((msg) => {
        const plaintext = msg?.plaintext ?? msg?.text ?? msg;
        const senderId = msg?.senderId ?? msg?.senderPubSig ?? null;
        const senderName = msg?.senderName ?? null;
        let parsed = null;

        if (typeof plaintext === "string") {
          try {
            parsed = JSON.parse(plaintext);
          } catch {
            parsed = null;
          }
        }

        if (
          parsed &&
          typeof parsed === "object" &&
          typeof parsed.type === "string"
        ) {
          if (parsed.type === "chat") {
            this._emit(GameEvent.CHAT_MESSAGE, {
              sender: senderName ?? "Player",
              senderId,
              text: parsed.text ?? "",
              timestamp: parsed.timestamp ?? msg?.timestamp ?? Date.now(),
            });
          } else if (parsed.type === "game_start") {
            this._emit(GameEvent.GAME_START, parsed);
          } else if (parsed.type === "ready_state") {
            this._emit(GameEvent.READY_STATE, {
              senderId,
              senderName: senderName ?? "Player",
              isReady: parsed.isReady,
              timestamp: parsed.timestamp ?? Date.now(),
            });
          }
        }

        this._emit(GameEvent.MESSAGE_RECEIVED, {
          ...msg,
          text: plaintext,
          senderId,
          senderName,
        });
      });
      this._lobby.onLobbyClose?.((reason) => {
        this._emit(GameEvent.LOBBY_CLOSED, { reason });
      });
      this._lobby.onStateChange?.((state) => {
        this._emit(GameEvent.LOBBY_UPDATED, {
          state,
          lobby: this._lobby?.lobbyInfo ?? null,
        });
      });
    }
  }

  /** @private */
  _startIncomingPayloadRouter() {
    if (this._incomingRouterActive || !this._adapter || !this._session) {
      return;
    }

    this._incomingRouterActive = true;

    const handleMatch = async (match) => {
      // ── 1. Try anchor/heartbeat hex path first ──
      const hexPayload = match?.payload;
      if (typeof hexPayload === "string" && this._state === GameState.IN_GAME) {
        if (this._handleHeartbeatMatch(match)) return;
      }

      // ── 2. Fall through to KKTP text protocol ──
      const rawPayload = match?.decodedPayload || hexPayload;
      if (!rawPayload || typeof rawPayload !== "string") return;

      if (rawPayload.startsWith("KKTP:GROUP:")) {
        if (this._lobby) {
          try {
            await this._lobby.processGroupPayload(rawPayload);
          } catch (err) {
            log.debug("KKGameEngine: Failed to process group payload", err);
          }
        }
        return;
      }

      const event = await this._session.processIncomingPayload(rawPayload);
      if (
        !event ||
        event.type !== "messages" ||
        !this._lobby ||
        !event.mailboxId
      ) {
        return;
      }

      for (const msg of event.messages || []) {
        const plaintext = msg?.plaintext ?? msg;
        if (typeof plaintext === "string") {
          this._lobby.routeDMMessage(event.mailboxId, plaintext);
        }
      }
    };

    if (this._adapter.onNewTransactionMatch) {
      this._incomingUnsubscribe = this._adapter.onNewTransactionMatch(
        (match) => {
          void handleMatch(match);
        },
      );
    }

    if (this._adapter.startScanner) {
      this._adapter.startScanner().catch(() => {});
    }
  }

  /**
   * Handle a single scanner match that may be an opponent heartbeat.
   *
   * Returns true if the match was consumed (heartbeat), false otherwise
   * so the caller falls through to the KKTP text path.
   *
   * @param {Object} match - Scanner match object { txid, payload, timestamp, … }
   * @returns {boolean}
   * @private
   */
  _handleHeartbeatMatch(match) {
    const hexPayload = match?.payload;
    if (!hexPayload) return false;

    const tagHex = this._anchor?.processor?.gameIdTagHex;
    if (!tagHex) return false;

    // NOTE: Scanner already validated prefix match before callback fired.
    // We keep prefixHex only for parseHeartbeatHex offset calculation.
    const prefixHex = BLOCKCHAIN.PREFIX_HEARTBEAT_HEX;

    // ── Filter own transactions ──
    const txId = match.txid ?? match.txId;
    if (txId && this._ownAnchorTxIds.has(txId)) {
      return true; // consumed but ignored (our own echo)
    }
    const anchorChain = this._anchor?.processor?.anchorChain;
    if (Array.isArray(anchorChain) && txId && anchorChain.includes(txId)) {
      this._ownAnchorTxIds.add(txId);
      return true;
    }

    // ── Parse (use original hexPayload for correct binary parsing) ──
    const parsed = parseHeartbeatHex(hexPayload, { prefixHex, tagHex });
    if (!parsed) return false;

    // ── Resolve player via anchor chain tracking (N-player ready) ──
    const playerId = this._resolvePlayerFromHeartbeat(parsed, txId);

    // Time accumulator persists across heartbeats per opponent
    if (!this._opponentTimeAccumulators.has(playerId)) {
      this._opponentTimeAccumulators.set(playerId, { value: 0 });
    }
    const timeAccumulator = this._opponentTimeAccumulators.get(playerId);

    // Enrich moves with session context
    const moves = enrichMoves(parsed, { txId, playerId, timeAccumulator });

    // ── Emit batch-level event ──
    this._emit(GameEvent.OPPONENT_HEARTBEAT, {
      txId,
      playerId,
      header: parsed.header,
      moveCount: moves.length,
      moves,
      timestamp: match.timestamp ?? Date.now(),
    });

    // ── Emit per-move events ──
    for (const move of moves) {
      this._emit(GameEvent.OPPONENT_MOVE_ANCHORED, move);
    }

    log.debug("KKGameEngine: Opponent heartbeat processed", {
      txId,
      playerId,
      moveCount: moves.length,
      hwm: timeAccumulator.value,
    });

    return true;
  }

  /**
   * Resolve player ID from a heartbeat via anchor chain tracking.
   *
   * For N-player multiplayer, each player's anchor chain is tracked:
   * - Genesis tx registers the player's chain
   * - Subsequent heartbeats link via prevTxId
   * - We trace prevTxId to identify which player sent the heartbeat
   *
   * @param {Object} parsed - Parsed heartbeat from parseHeartbeatHex()
   * @param {string} txId - Transaction ID of this heartbeat
   * @returns {string} Player ID
   * @private
   */
  _resolvePlayerFromHeartbeat(parsed, txId) {
    const prevTxId = parsed?.header?.prevTxId;

    // Check if prevTxId is in any known player's chain
    for (const [playerId, chainTxIds] of this._playerAnchorChains) {
      if (chainTxIds.has(prevTxId)) {
        // Found the player - add this txId to their chain for future lookups
        chainTxIds.add(txId);
        return playerId;
      }
    }

    // ── Genesis case or first heartbeat from unknown player ──
    // Check MoveProcessor for explicitly set opponentId
    const fromProcessor = this._anchor?.processor?._opponentId;
    if (fromProcessor) {
      // Initialize their chain with this tx
      if (!this._playerAnchorChains.has(fromProcessor)) {
        this._playerAnchorChains.set(fromProcessor, new Set());
      }
      this._playerAnchorChains.get(fromProcessor).add(txId);
      return fromProcessor;
    }

    // ── Lobby fallback: find any peer who isn't me ──
    const lobbyMembers = this._lobby?.members ?? this._lobby?.lobbyInfo?.members;
    if (Array.isArray(lobbyMembers)) {
      // Find lobby members who don't have a tracked chain yet
      for (const member of lobbyMembers) {
        const memberId = member?.pubSig ?? member?.id;
        if (!memberId || memberId === this._playerId) continue;

        // If this member doesn't have a chain yet, assume it's them
        if (!this._playerAnchorChains.has(memberId)) {
          this._playerAnchorChains.set(memberId, new Set([txId]));
          return memberId;
        }
      }

      // All members have chains; find one whose chain includes prevTxId or is smallest
      const peer = lobbyMembers.find((m) => {
        const id = m?.pubSig ?? m?.id;
        return id && id !== this._playerId;
      });
      if (peer) {
        const peerId = peer.pubSig ?? peer.id;
        if (!this._playerAnchorChains.has(peerId)) {
          this._playerAnchorChains.set(peerId, new Set());
        }
        this._playerAnchorChains.get(peerId).add(txId);
        return peerId;
      }
    }

    // Ultimate fallback
    return "opponent";
  }

  /**
   * Register a player's genesis anchor txId to initialize their chain.
   *
   * Call this when a player broadcasts their genesis anchor in multiplayer.
   * Enables proper attribution of subsequent heartbeats in N-player games.
   *
   * @param {string} playerId - Player identifier (pubSig or custom ID)
   * @param {string} genesisTxId - Transaction ID of their genesis anchor
   */
  registerPlayerAnchorChain(playerId, genesisTxId) {
    if (!playerId || !genesisTxId) return;

    if (!this._playerAnchorChains.has(playerId)) {
      this._playerAnchorChains.set(playerId, new Set());
    }
    this._playerAnchorChains.get(playerId).add(genesisTxId);

    log.debug("KKGameEngine: Registered player anchor chain", {
      playerId,
      genesisTxId,
    });
  }

  /** @private */
  async _waitForLobbyState(targetState, timeoutMs = 15000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (this._lobby?.currentState === targetState) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return false;
  }

  /** @private */
  _setupEventForwarding() {
    if (!this._anchor) return;

    // Forward anchor events + track own txIds for self-echo filtering
    this._anchor.on(MoveEvent.ANCHOR_SENT, (data) => {
      if (data?.txId) {
        this._ownAnchorTxIds.add(data.txId);
        // Also add to our own anchor chain for completeness
        if (this._playerId && !this._playerAnchorChains.has(this._playerId)) {
          this._playerAnchorChains.set(this._playerId, new Set());
        }
        if (this._playerId) {
          this._playerAnchorChains.get(this._playerId)?.add(data.txId);
        }
      }
      this._emit(GameEvent.ANCHOR_SENT, data);
    });

    this._anchor.on(MoveEvent.ANCHOR_FAILED, (data) => {
      this._emit(GameEvent.ANCHOR_FAILED, data);
    });

    this._anchor.on(MoveEvent.LOW_FUNDS_WARNING, (data) => {
      this._emit(GameEvent.LOW_FUNDS, data);
    });

    // Forward pool events for game readiness
    this._anchor.on("gameReady", (data) => {
      this._emit(GameEvent.GAME_READY, data);
    });

    this._anchor.on("poolLow", (data) => {
      this._emit(GameEvent.POOL_LOW, data);
    });
  }

  /**
   * Track an async operation for graceful shutdown draining.
   * @param {Promise} promise - Promise to track
   * @returns {Promise} Same promise (for chaining)
   * @private
   */
  _trackOperation(promise) {
    this._activeOperations.add(promise);
    const cleanup = () => this._activeOperations.delete(promise);
    promise.then(cleanup, cleanup);
    return promise;
  }

  /**
   * Guard method - throws if engine is shutting down.
   * @private
   */
  _ensureNotShuttingDown() {
    if (this._shuttingDown) {
      throw new Error("KKGameEngine is shutting down - operation rejected");
    }
  }

  /** @private */
  _withTimeout(promise, timeoutMs, message) {
    return Promise.race([
      promise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(message)), timeoutMs),
      ),
    ]);
  }
}

// Convenience singleton for simple use cases
export const kkGame = new KKGameEngine();

export default KKGameEngine;
