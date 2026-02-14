/**
 * MerkleManager.js - Merkle tree wrapper
 */

import { GameMerkleTree } from "../../core/merkleTree.js";

export class MerkleManager {
  constructor() {
    this._tree = new GameMerkleTree();
  }

  reset() {
    this._tree = new GameMerkleTree();
  }

  addMove(move) {
    return this._tree.addMove(move);
  }

  getProof(index) {
    return this._tree.getProof(index);
  }

  getRoot() {
    return this._tree.root;
  }

  getAllMoves() {
    return this._tree.getAllMoves();
  }

  getLeaves() {
    return this._tree.getLeaves();
  }

  get size() {
    return this._tree.size;
  }

  clear() {
    this._tree.clear?.();
  }
}

export default MerkleManager;
