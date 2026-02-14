/**
 * merkleTree.js - Lightweight Merkle tree for move hashing
 */

function simpleHashHex(input) {
  const str = typeof input === 'string' ? input : JSON.stringify(input);
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  let hex = '';
  for (let i = 0; i < 8; i++) {
    hex += ((hash >> ((i % 4) * 8)) & 0xff).toString(16).padStart(2, '0');
  }
  return hex.repeat(8).slice(0, 64);
}

export class GameMerkleTree {
  constructor() {
    this._leaves = [];
    this._moves = [];
    this.root = '';
  }

  get size() {
    return this._leaves.length;
  }

  addMove(move) {
    const leafHash = simpleHashHex(move);
    this._leaves.push(leafHash);
    this._moves.push(move);
    this.root = this._computeRoot();

    const index = this._leaves.length - 1;
    const moveId = `${index}-${leafHash.slice(0, 8)}`;

    return { index, hash: leafHash, moveId };
  }

  _computeRoot() {
    if (this._leaves.length === 0) return '';
    let level = [...this._leaves];
    while (level.length > 1) {
      const next = [];
      for (let i = 0; i < level.length; i += 2) {
        const left = level[i];
        const right = level[i + 1] ?? level[i];
        next.push(simpleHashHex(left + right));
      }
      level = next;
    }
    return level[0];
  }

  getProof(index) {
    if (index < 0 || index >= this._leaves.length) return [];
    const proof = [];
    let idx = index;
    let level = [...this._leaves];

    while (level.length > 1) {
      const isRight = idx % 2 === 1;
      const pairIndex = isRight ? idx - 1 : idx + 1;
      const pairHash = level[pairIndex] ?? level[idx];
      proof.push({ position: isRight ? 'left' : 'right', hash: pairHash });

      const next = [];
      for (let i = 0; i < level.length; i += 2) {
        const left = level[i];
        const right = level[i + 1] ?? level[i];
        next.push(simpleHashHex(left + right));
      }
      level = next;
      idx = Math.floor(idx / 2);
    }

    return proof;
  }

  getAllMoves() {
    return [...this._moves];
  }

  getLeaves() {
    return [...this._leaves];
  }

  clear() {
    this._leaves = [];
    this._moves = [];
    this.root = '';
  }
}

export default {
  GameMerkleTree
};
