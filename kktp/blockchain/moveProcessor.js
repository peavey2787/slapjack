/**
 * moveProcessor.js - Orchestrates moves, crypto, wallet, and anchor strategy
 */

import { EventEmitter } from "../core/eventEmitter.js";
import { Logger, LogModule } from "../core/logger.js";
import { bytesToHex, hexToBytes } from "../core/cryptoUtils.js";
import {
  MSG_TYPE, ACTION_TO_CODE, ACTION_CODE, ANCHOR,
  MOVE_ACTION_CODE, encodeCoord14, buildActionMaps,
} from "../core/constants.js";
import { KaspaLink } from "./wallet/KaspaLink.js";
import { UtxoManager } from "./wallet/UtxoManager.js";
import { EntropyProvider } from "./crypto/EntropyProvider.js";
import { VrfManager } from "./crypto/VrfManager.js";
import { BinaryPacker } from "./protocol/BinaryPacker.js";
import { MerkleManager } from "./protocol/MerkleManager.js";
import { MoveVault } from "./protocol/MoveVault.js";
import { StateSerializer } from "./protocol/StateSerializer.js";
import { AuditTrail } from "./protocol/AuditTrail.js";
import { AnchorStrategy } from "./anchor/AnchorStrategy.js";

const log = Logger.create(LogModule.anchor.moveProcessor);

export const MoveEvent = {
  MOVE_PROCESSED: "moveProcessed",
  ANCHOR_SENT: "anchorSent",
  ANCHOR_FAILED: "anchorFailed",
  MOVE_RECEIVED: "moveReceived",
  VRF_GENERATED: "vrfGenerated",
  VRF_SYNC_WAIT: "vrfSyncWait",
  VRF_SYNC_RESOLVED: "vrfSyncResolved",
  VALIDATION_FAILED: "validationFailed",
  LOW_FUNDS_WARNING: "lowFundsWarning",
  UTXO_READY: "utxoReady",
  UTXO_REFRESHING: "utxoRefreshing",
  UTXO_REFRESH_COMPLETE: "utxoRefreshComplete",
  ANCHOR_COMPLETE: "anchorComplete",
  ANCHOR_BINARY_READY: "anchorBinaryReady",
  ANCHOR_RETRY_NEEDED: "anchorRetryNeeded",
  GENESIS_ANCHORED: "genesisAnchored",
  GENESIS_ANCHOR_FAILED: "genesisAnchorFailed",
  HEARTBEAT_ANCHORED: "heartbeatAnchored",
  DELTA_ENTROPY_DETECTED: "deltaEntropyDetected",
};

export class MoveProcessor extends EventEmitter {
  constructor(options = {}) {
    super();

    this._adapter = options.adapter ?? options.kaspaAdapter ?? null;
    this._sessionController = options.sessionController ?? null;

    // Build merged action maps from custom overrides
    this._actionMaps = buildActionMaps({
      actionMap:     options.customActionMap,
      abilitiesMap:  options.customAbilitiesMap,
      actionsMap:    options.customActionsMap,
      itemsMap:      options.customItemsMap,
      statusMap:     options.customStatusMap,
      emotesMap:     options.customEmotesMap,
      systemMap:     options.customSystemMap,
    });

    this._kaspaLink = new KaspaLink(this._adapter);
    this._vault = new MoveVault();
    this._packer = new BinaryPacker({ actionMaps: this._actionMaps });
    this._merkleManager = new MerkleManager();
    this._opponentMerkleManager = new MerkleManager();
    this._entropyProvider = new EntropyProvider({
      kaspaLink: this._kaspaLink,
      sessionController: this._sessionController,
    });
    this._vrf = new VrfManager({
      kaspaLink: this._kaspaLink,
      entropyProvider: this._entropyProvider,
      onDeltaEntropy: (payload) => this.emit(MoveEvent.DELTA_ENTROPY_DETECTED, payload),
    });
    this._wallet = new UtxoManager({
      kaspaLink: this._kaspaLink,
      onEvent: (event, payload) => this.emit(event, payload),
    });
    this._anchorStrategy = new AnchorStrategy({
      kaspaLink: this._kaspaLink,
      wallet: this._wallet,
      packer: this._packer,
      merkleManager: this._merkleManager,
      vault: this._vault,
      vrf: this._vrf,
      onEvent: (event, payload) => this.emit(event, payload),
    });
    this._auditTrail = new AuditTrail({ kaspaLink: this._kaspaLink, packer: this._packer });
    this._stateSerializer = new StateSerializer();

    this._gameId = null;
    this._gameIdTagHex = null;
    this._playerId = null;
    this._opponentId = null;
    this._lobbyId = null;

    this._moveSequence = 0;
    this._prevMoveTimestamp = 0;
    this._opponentPrevTimestamp = 0;

    this._finalScore = 0;
    this._coinsCollected = 0;

    this._binaryAnchor = null;

    this._vrfSyncWait = false;
    this._isActive = false;

    if (this._adapter) {
      this.setAdapter(this._adapter);
    }
  }

  setAdapter(adapter) {
    this._adapter = adapter;
    this._kaspaLink.setAdapter(adapter);
    this._entropyProvider.setKaspaLink(this._kaspaLink);
    this._entropyProvider.subscribeToBlocks();
    this._vrf.setKaspaLink(this._kaspaLink);
    this._wallet.setKaspaLink(this._kaspaLink);
    this._anchorStrategy.setKaspaLink(this._kaspaLink);
    this._auditTrail.setKaspaLink(this._kaspaLink);
    log.debug("KaspaAdapter set");
  }

  setSessionController(sessionController) {
    this._sessionController = sessionController;
    this._entropyProvider.setSessionController(sessionController);
    log.debug("SessionController set");
  }

  get isDegradedMode() {
    return this._wallet.isDegradedMode;
  }

  get isUtxoReady() {
    return this._wallet.isUtxoReady;
  }

  get balanceKas() {
    return this._wallet.balanceKas;
  }

  get runwayMoves() {
    return this._wallet.runwayMoves;
  }

  getPoolStatus() {
    return this._wallet.getPoolStatus();
  }

  async ensureUtxoPoolReady(options = {}) {
    return this._wallet.ensurePoolReady(options);
  }

  get binaryAnchor() {
    return this._binaryAnchor;
  }

  get genesisTxId() {
    return this._anchorStrategy.getAnchorState().genesisTxId;
  }

  get lastAnchorTxId() {
    return this._anchorStrategy.getAnchorState().lastAnchorTxId;
  }

  get anchorChain() {
    return this._anchorStrategy.getAnchorState().anchorChain;
  }

  get genesisEntropy() {
    return this._anchorStrategy.getAnchorState().genesisEntropy;
  }

  get isGenesisAnchored() {
    return this.genesisTxId !== null;
  }

  get gameIdTagHex() {
    return this._gameIdTagHex;
  }

  _computeGameIdTagHex(gameId) {
    if (!gameId) return "00000000";
    let hash = 0x811c9dc5;
    for (let i = 0; i < gameId.length; i++) {
      hash ^= gameId.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    const bytes = new Uint8Array(4);
    bytes[0] = (hash >>> 24) & 0xff;
    bytes[1] = (hash >>> 16) & 0xff;
    bytes[2] = (hash >>> 8) & 0xff;
    bytes[3] = hash & 0xff;
    return bytesToHex(bytes);
  }

  start(options) {
    this._gameId = options.gameId;
    this._playerId = options.playerId;
    this._opponentId = options.opponentId ?? null;
    this._lobbyId = options.lobbyId ?? null;
    this._gameIdTagHex = this._computeGameIdTagHex(this._gameId);

    this._moveSequence = 0;
    this._merkleManager.reset();
    this._opponentMerkleManager.reset();
    this._vault.resetForNewGame();
    this._prevMoveTimestamp = 0;
    this._opponentPrevTimestamp = 0;
    this._finalScore = 0;
    this._coinsCollected = 0;
    this._binaryAnchor = null;
    this._vrfSyncWait = false;

    this._vrf.setGameContext({ gameId: this._gameId, playerId: this._playerId });
    this._anchorStrategy.setGameContext({
      gameId: this._gameId,
      gameIdTagHex: this._gameIdTagHex,
    });
    this._anchorStrategy.start();

    // Listen for genesis confirmation to reinforce VRF chain
    this._genesisHandler = ({ txId }) => {
      this._vrf.setGenesisTxId(txId);
    };
    this.on(MoveEvent.GENESIS_ANCHORED, this._genesisHandler);

    this._isActive = true;

    log.info("MoveProcessor started", {
      gameId: this._gameId,
      playerId: this._playerId,
      opponentId: this._opponentId,
      degradedMode: this._wallet.isDegradedMode,
    });
  }

  async stop() {
    this._isActive = false;
    this._anchorStrategy.stop();
    this._entropyProvider.cleanup();
    this._vrf.resetState();

    // Remove genesis listener to prevent leaks
    if (this._genesisHandler) {
      this.off(MoveEvent.GENESIS_ANCHORED, this._genesisHandler);
      this._genesisHandler = null;
    }

    this._vault.clearForStop();

    this._merkleManager.clear();
    this._opponentMerkleManager.clear();

    this._binaryAnchor = null;
    this._vrfSyncWait = false;

    log.info("MoveProcessor stopped with full cleanup");
  }

  async processLocalMove(action, data = {}) {
    if (!this._isActive) {
      throw new Error("MoveProcessor not active");
    }

    if (!this.genesisTxId) {
      log.warn("Genesis anchor not yet sent - move will still be processed (lazy VRF seed)");
    }

    const timestamp = Date.now();
    const sequence = ++this._moveSequence;

    // ── Compute timeDelta BEFORE VRF call so it's part of the fold input ──
    const prevTimestamp =
      this._vault.getMoveHistory().length > 0
        ? this._vault.getMoveHistory()[this._vault.getMoveHistory().length - 1].timestamp
        : timestamp;
    const deltaMs = Math.max(0, timestamp - prevTimestamp);
    const timeDelta = Math.min(255, Math.floor(deltaMs / ANCHOR.TIME_DELTA_SCALE));

    let vrfOutput = null;
    let vrfOutputBytes = null;
    let currentBlockHash = null;
    let currentBlockHashHex = "";
    let entropySnapshot = null;

    const actionCode = this._actionMaps.actionToCode[action] ?? ACTION_CODE.NONE;
    const isMove = actionCode === MOVE_ACTION_CODE;

    // For MOVE actions, encode x/y/z as 14-bit raw integers
    const xRaw = isMove ? encodeCoord14(data.x) : undefined;
    const yRaw = isMove ? encodeCoord14(data.y) : undefined;
    const zRaw = isMove ? encodeCoord14(data.z) : undefined;

    try {
      const vrfResult = await this._vrf.updateStateForMove({
        action,
        lane: isMove ? undefined : (data.lane ?? 0),
        timeDelta,
        sequence,
        timestamp,
        // v5: pass coordinates for MOVE so they are folded into VRF chain
        x: xRaw,
        y: yRaw,
        z: zRaw,
      });

      vrfOutput = vrfResult.vrfOutput;
      vrfOutputBytes = vrfResult.vrfOutputBytes;
      currentBlockHash = vrfResult.blockHash;
      currentBlockHashHex = vrfResult.blockHashHex;
      entropySnapshot = vrfResult.entropySnapshot;

      this.emit(MoveEvent.VRF_GENERATED, { sequence, vrfOutput, currentBlockHashHex });

      if (this._vrfSyncWait) {
        this._vrfSyncWait = false;
        this.emit(MoveEvent.VRF_SYNC_RESOLVED, { sequence });
      }
    } catch (e) {
      const message = e?.message || "VRF REQUIRED: move proof failed";
      if (message.includes("VRF REQUIRED: no live block hash available")) {
        if (!this._vrfSyncWait) {
          this._vrfSyncWait = true;
          this.emit(MoveEvent.VRF_SYNC_WAIT, { sequence, error: message });
        }
      }
      throw e;
    }

    const vrfFragment =
      vrfOutputBytes && vrfOutputBytes.length >= 4
        ? bytesToHex(vrfOutputBytes.slice(0, 4))
        : "";

    const move = {
      type: MSG_TYPE.MOVE,
      gameId: this._gameId,
      playerId: this._playerId,
      action,
      sequence,
      timestamp,
      vrfOutput,
      currentBlockHash: currentBlockHashHex,
      ...data,
    };

    // Dual-path merkle leaf: MOVE uses { action, x, y, z, timeDelta, vrfFragment }
    const merkleLeaf = isMove
      ? { action, x: xRaw, y: yRaw, z: zRaw, timeDelta, vrfFragment }
      : { action, lane: data.lane ?? 0, timeDelta, vrfFragment };
    const merkleResult = this._merkleManager.addMove(merkleLeaf);

    move.merkleIndex = merkleResult.index;
    move.merkleHash = merkleResult.hash;
    move.moveId = merkleResult.moveId;
    move.merkleRoot = this._merkleManager.getRoot();

    this._vault.addProcessedMove(move.moveId, move);

    const vaultEntry = {
      sequence: this._vault.getMoveHistory().length,
      action,
      timestamp,
      timeDelta,
      vrfOutput: vrfOutput ?? null,
      vrfFragment,
      vrfOutputBytes: vrfOutputBytes ?? new Uint8Array(32),
      leafHash: merkleResult.hash,
      kaspaBlockHash: currentBlockHash,
      kaspaBlockHashHex: currentBlockHashHex,
      entropySnapshot: entropySnapshot ?? null,
    };

    if (isMove) {
      vaultEntry.x = xRaw;
      vaultEntry.y = yRaw;
      vaultEntry.z = zRaw;
    } else {
      vaultEntry.lane = data.lane ?? 0;
    }

    this._vault.addMove(vaultEntry);

    if (vrfOutput) {
      const vrfProofEntry = {
        moveIndex: sequence,
        action,
        timestamp,
        vrfOutput: vrfOutput ?? null,
        proof: null,
        blockHash: currentBlockHashHex,
        entropySnapshot: entropySnapshot ?? null,
      };
      if (isMove) {
        vrfProofEntry.x = xRaw;
        vrfProofEntry.y = yRaw;
        vrfProofEntry.z = zRaw;
      } else {
        vrfProofEntry.lane = data.lane ?? 0;
      }
      this._vault.addVrfProof(vrfProofEntry);
    }

    this._prevMoveTimestamp = timestamp;

    log.debug("Move processed (v5 union protocol)", {
      moveId: move.moveId,
      merkleIndex: move.merkleIndex,
      root: move.merkleRoot?.substring(0, 16),
      blockHash: currentBlockHashHex.substring(0, 16),
      genesisReinforced: entropySnapshot?.isGenesisReinforced ?? false,
    });

    this.emit(MoveEvent.MOVE_PROCESSED, move);
    return move;
  }

  processGameEvent(eventType, data = {}) {
    if (!this._isActive) {
      log.trace("MoveProcessor not active, skipping game event");
      return null;
    }

    const timestamp = Date.now();
    const sequence = this._vault.getMoveHistory().length;
    const eventCode = ACTION_TO_CODE[eventType] ?? ACTION_CODE.NONE;
    const currentBlock = this._entropyProvider.getCachedBlockHash();

    const event = {
      sequence,
      action: eventType,
      lane: data.lane ?? 0,
      timestamp,
      vrfOutput: null,
      vrfOutputBytes: new Uint8Array(32),
      vrfProof: null,
      leafHash: null,
      kaspaBlockHash: currentBlock.hash,
      kaspaBlockHashHex: currentBlock.hex,
      isGameEvent: true,
      eventType,
      eventData: {
        value: data.value ?? 0,
        total: data.total ?? data.coinsRemaining ?? 0,
        coinsLost: data.coinsLost ?? 0,
        coinsRemaining: data.coinsRemaining ?? data.total ?? 0,
        powerupType: data.type?.id ?? data.powerupType ?? null,
        duration: data.duration ?? 0,
      },
    };

    this._vault.addGameEvent(event);
    this._prevMoveTimestamp = timestamp;

    log.trace("Game event processed", {
      eventType,
      eventCode,
      lane: event.lane,
      sequence,
    });

    return event;
  }

  async receiveOpponentMove(moveData) {
    if (!this._isActive) {
      return { valid: false, reason: "not_active" };
    }

    log.debug("Receiving opponent move", {
      sequence: moveData.sequence,
      action: moveData.action,
    });

    if (!moveData.moveId || !moveData.action) {
      log.warn("Invalid opponent move format", moveData);
      this.emit(MoveEvent.VALIDATION_FAILED, {
        reason: "invalid_format",
        move: moveData,
      });
      return { valid: false, reason: "invalid_format" };
    }

    if (this._vault.hasProcessedMove(moveData.moveId)) {
      log.debug("Duplicate move ignored", { moveId: moveData.moveId });
      return { valid: false, reason: "duplicate" };
    }

    if (moveData.playerId !== this._opponentId) {
      log.warn("Move from wrong player", {
        expected: this._opponentId,
        got: moveData.playerId,
      });
      return { valid: false, reason: "wrong_player" };
    }

    const opponentTimestamp = Number.isFinite(moveData.timestamp) ? moveData.timestamp : Date.now();
    const opponentPrev = this._opponentPrevTimestamp || opponentTimestamp;
    const opponentDeltaMs = Math.max(0, opponentTimestamp - opponentPrev);
    const opponentTimeDelta = Math.min(255, Math.floor(opponentDeltaMs / ANCHOR.TIME_DELTA_SCALE));
    const opponentVrfFragment = typeof moveData.vrfOutput === "string" ? moveData.vrfOutput.slice(0, 8) : "";

    const oppActionCode = this._actionMaps.actionToCode[moveData.action] ?? ACTION_CODE.NONE;
    const oppIsMove = oppActionCode === MOVE_ACTION_CODE;

    const oppMerkleLeaf = oppIsMove
      ? {
          action: moveData.action,
          x: moveData.xRaw ?? (moveData.x != null ? encodeCoord14(moveData.x) : 0),
          y: moveData.yRaw ?? (moveData.y != null ? encodeCoord14(moveData.y) : 0),
          z: moveData.zRaw ?? (moveData.z != null ? encodeCoord14(moveData.z) : 0),
          timeDelta: opponentTimeDelta,
          vrfFragment: opponentVrfFragment,
        }
      : {
          action: moveData.action,
          lane: moveData.lane ?? 0,
          timeDelta: opponentTimeDelta,
          vrfFragment: opponentVrfFragment,
        };

    this._opponentMerkleManager.addMove(oppMerkleLeaf);

    this._opponentPrevTimestamp = opponentTimestamp;
    this._vault.addProcessedMove(moveData.moveId, moveData);

    log.debug("Opponent move validated", { moveId: moveData.moveId });
    this.emit(MoveEvent.MOVE_RECEIVED, moveData);

    return { valid: true, move: moveData };
  }

  getMerkleProof(index) {
    return this._merkleManager.getProof(index);
  }

  getMerkleRoot() {
    return this._merkleManager.getRoot();
  }

  getAllMoves() {
    return this._merkleManager.getAllMoves();
  }

  getMoveCount() {
    return this._merkleManager.size;
  }

  getMerkleLeaves() {
    return this._merkleManager.getLeaves();
  }

  getMoveHistory() {
    return this._vault.getMoveHistory();
  }

  serialize() {
    return this._stateSerializer.serialize({
      gameId: this._gameId,
      playerId: this._playerId,
      opponentId: this._opponentId,
      moveSequence: this._moveSequence,
      merkleManager: this._merkleManager,
      moveHistory: this._vault.getMoveHistory(),
    });
  }

  async anchorGenesisSeed(options = {}) {
    return await this._anchorStrategy.anchorGenesisSeed(options);
  }

  async _sendHeartbeatAnchor(options = {}) {
    return await this._anchorStrategy.sendHeartbeatAnchor(options);
  }

  async anchorFinalState(endState, options = {}) {
    this._finalScore = endState?.score ?? 0;
    this._coinsCollected = endState?.coins ?? endState?.coinsCollected ?? 0;

    const result = await this._anchorStrategy.anchorFinalState(endState, options);
    if (result?.binaryAnchor) {
      this._binaryAnchor = result.binaryAnchor;
    }
    return result;
  }

  async retryFinalAnchor() {
    return await this._anchorStrategy.retryFinalAnchor();
  }

  async prepareForGame() {
    return await this._wallet.prepareForGame();
  }

  async getRunway() {
    return await this._wallet.getRunway();
  }

  async getBalanceKas() {
    return await this._wallet.getBalanceKas();
  }

  getAuditData(options = {}) {
    return this._auditTrail.getAuditData(options, {
      gameId: this._gameId,
      resolvedGameIdTagHex: this._gameIdTagHex,
      sessionController: this._sessionController,
      anchorState: {
        ...this._anchorStrategy.getAnchorState(),
        playerId: this._playerId,
        opponentId: this._opponentId,
      },
      vault: this._vault,
      merkleManager: this._merkleManager,
      opponentMerkleManager: this._opponentMerkleManager,
      finalScore: this._finalScore,
      coinsCollected: this._coinsCollected,
      getBinaryAnchor: () => this._binaryAnchor,
      setBinaryAnchor: (anchor) => {
        this._binaryAnchor = anchor;
      },
    });
  }

  async getAuditDataFromDag(options = {}) {
    return await this._auditTrail.getAuditDataFromDag(options, {
      gameId: this._gameId,
      resolvedGameIdTagHex: this._gameIdTagHex,
      computeGameIdTagHex: (gameId) => this._computeGameIdTagHex(gameId),
    });
  }

  destroy() {
    this.stop();

    this._adapter = null;
    this._sessionController = null;
    this.removeAllListeners();

    log.info("MoveProcessor destroyed");
  }
}

export default MoveProcessor;
