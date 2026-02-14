/**
 * MoveVault.js - Move and proof storage
 */

export class MoveVault {
  constructor() {
    this._moveHistory = [];
    this._processedMoves = new Map();
    this._vrfProofArchive = [];
  }

  resetForNewGame() {
    this._moveHistory = [];
    this._processedMoves.clear();
    this._vrfProofArchive = [];
  }

  clearForStop() {
    this._moveHistory = [];
    this._processedMoves.clear();
  }

  addMove(move) {
    this._moveHistory.push(move);
  }

  addGameEvent(event) {
    this._moveHistory.push(event);
  }

  addProcessedMove(moveId, move) {
    this._processedMoves.set(moveId, move);
  }

  hasProcessedMove(moveId) {
    return this._processedMoves.has(moveId);
  }

  addVrfProof(entry) {
    this._vrfProofArchive.push(entry);
  }

  getMoveHistory() {
    return this._moveHistory;
  }

  getMoveCount() {
    return this._moveHistory.length;
  }

  getVrfProofArchive() {
    return this._vrfProofArchive;
  }

  getProcessedMoves() {
    return this._processedMoves;
  }
}

export default MoveVault;
