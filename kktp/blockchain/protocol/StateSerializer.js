/**
 * StateSerializer.js - State serialization
 */

export class StateSerializer {
  serialize({ gameId, playerId, opponentId, moveSequence, merkleManager, moveHistory }) {
    return {
      gameId,
      playerId,
      opponentId,
      moveSequence,
      merkleRoot: merkleManager.getRoot(),
      moveCount: merkleManager.size,
      moves: moveHistory,
      merkleLeaves: merkleManager.getLeaves(),
    };
  }
}

export default StateSerializer;
