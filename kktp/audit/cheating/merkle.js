/**
 * merkle.js - Merkle verification for cheating audit
 */

import { ANCHOR, ACTION_TO_CODE, CODE_TO_ACTION, MOVE_ACTION_CODE } from "../../core/constants.js";
import { GameMerkleTree } from "../../core/merkleTree.js";
import {
  addReason,
  addWarning,
  equalsHex,
  getTimeDelta,
  getVrfFragment,
  normalizeHex,
} from "./utils.js";

export function verifyMerkleAndMoves({
  moveHistory,
  heartbeats,
  parsedByTxId,
  finalData,
  warnings,
}) {
  const reasons = [];
  const useMoveHistory = Array.isArray(moveHistory) && moveHistory.length > 0;
  if (!useMoveHistory && (!heartbeats || heartbeats.length === 0)) {
    addWarning(warnings, "missing_move_history");
    return { reasons };
  }

  const sortedMoves = useMoveHistory
    ? [...moveHistory].sort((a, b) => {
        const aSeq = Number.isFinite(a.sequence)
          ? a.sequence
          : (a.moveIndex ?? 0);
        const bSeq = Number.isFinite(b.sequence)
          ? b.sequence
          : (b.moveIndex ?? 0);
        return aSeq - bSeq;
      })
    : [];

  const totalMovesTarget = Number.isFinite(finalData?.totalMoves)
    ? finalData.totalMoves
    : useMoveHistory
      ? sortedMoves.length
      : 0;

  if (useMoveHistory && sortedMoves.length < totalMovesTarget) {
    addWarning(warnings, "move_history_shorter_than_final_total");
    return { reasons };
  }

  const merkleTree = new GameMerkleTree();
  let cursor = 0;

  for (const heartbeat of heartbeats) {
    const txId = normalizeHex(heartbeat?.txId);
    const parsed = parsedByTxId.get(txId) || {};
    const moveCount = Number.isFinite(parsed.moveCount)
      ? parsed.moveCount
      : null;
    if (moveCount === null || !Array.isArray(parsed.moves)) {
      addWarning(warnings, "heartbeat_move_data_missing");
      continue;
    }

    if (moveCount === 0) {
      continue;
    }

    for (let i = 0; i < moveCount; i++) {
      const movePacket = parsed.moves[i];
      let leafMove = null;

      if (useMoveHistory) {
        const move = sortedMoves[cursor];
        if (!move) {
          addReason(reasons, "move_history_exhausted_before_heartbeat");
          break;
        }

        const actionCode = ACTION_TO_CODE[move.action] ?? null;
        if (actionCode !== movePacket.actionCode) {
          addReason(reasons, "heartbeat_action_mismatch");
        }

        if (actionCode === MOVE_ACTION_CODE) {
          // MOVE — check x/y/z instead of lane
          if (movePacket.xRaw != null && move.x !== movePacket.xRaw) {
            addReason(reasons, "heartbeat_x_mismatch");
          }
          if (movePacket.yRaw != null && move.y !== movePacket.yRaw) {
            addReason(reasons, "heartbeat_y_mismatch");
          }
          if (movePacket.zRaw != null && move.z !== movePacket.zRaw) {
            addReason(reasons, "heartbeat_z_mismatch");
          }
        } else {
          const lane = Number.isFinite(move.lane) ? move.lane : 0;
          if (lane !== movePacket.lane) {
            addReason(reasons, "heartbeat_lane_mismatch");
          }
        }

        const vrfFragment = getVrfFragment(move);
        if (vrfFragment && vrfFragment !== movePacket.vrfFragment) {
          addReason(reasons, "heartbeat_vrf_fragment_mismatch");
        }

        const timeDelta = getTimeDelta(move);
        if (Number.isFinite(timeDelta) && timeDelta !== movePacket.timeDelta) {
          addWarning(warnings, "heartbeat_time_delta_mismatch");
        }

        leafMove = buildLeafMove(move, warnings);
      } else {
        leafMove = buildLeafFromPacket(movePacket, reasons);
      }

      if (leafMove) {
        merkleTree.addMove(leafMove);
      } else {
        addWarning(warnings, "insufficient_move_data_for_merkle");
        return { reasons };
      }

      cursor += 1;
    }

    if (
      parsed.merkleRoot &&
      merkleTree.root &&
      !equalsHex(parsed.merkleRoot, merkleTree.root)
    ) {
      addReason(reasons, "heartbeat_merkle_mismatch");
    }
  }

  if (useMoveHistory) {
    while (cursor < totalMovesTarget) {
      const move = sortedMoves[cursor];
      if (!move) break;
      const leafMove = buildLeafMove(move, warnings);
      if (leafMove) {
        merkleTree.addMove(leafMove);
      } else {
        addWarning(warnings, "insufficient_move_data_for_merkle");
        return { reasons };
      }
      cursor += 1;
    }
  }

  if (finalData?.merkleRoot && merkleTree.root) {
    if (!equalsHex(finalData.merkleRoot, merkleTree.root)) {
      addReason(reasons, "final_merkle_mismatch");
    }
  }

  return { reasons };
}

/**
 * Build a Merkle leaf from a move-history entry.
 * MOVE (action code 1): { action, x, y, z, timeDelta, vrfFragment }
 * Standard:              { action, lane, timeDelta, vrfFragment }
 */
export function buildLeafMove(move, warnings) {
  const action = move?.action;
  const timeDelta = getTimeDelta(move);
  const vrfFragment = getVrfFragment(move);

  if (!action || !Number.isFinite(timeDelta)) {
    addWarning(warnings, "missing_move_fields_for_merkle");
    return null;
  }

  const actionCode = ACTION_TO_CODE[action] ?? null;

  if (actionCode === MOVE_ACTION_CODE) {
    return {
      action,
      x: move.x ?? 0,
      y: move.y ?? 0,
      z: move.z ?? 0,
      timeDelta,
      vrfFragment,
    };
  }

  return {
    action,
    lane: Number.isFinite(move?.lane) ? move.lane : 0,
    timeDelta,
    vrfFragment,
  };
}

/**
 * Build a Merkle leaf from a parsed heartbeat move packet.
 * MOVE (action code 1): { action, x, y, z, timeDelta, vrfFragment }
 * Standard:              { action, lane, timeDelta, vrfFragment }
 */
export function buildLeafFromPacket(movePacket, reasons) {
  const action = CODE_TO_ACTION[movePacket.actionCode] ?? null;
  if (!action) {
    addReason(reasons, "heartbeat_action_unknown");
  }

  if (movePacket.actionCode === MOVE_ACTION_CODE) {
    return {
      action: action ?? "move",
      x: movePacket.xRaw ?? 0,
      y: movePacket.yRaw ?? 0,
      z: movePacket.zRaw ?? 0,
      timeDelta: movePacket.timeDelta ?? 0,
      vrfFragment: movePacket.vrfFragment ?? "",
    };
  }

  return {
    action: action ?? "unknown",
    lane: movePacket.lane ?? 0,
    timeDelta: movePacket.timeDelta ?? 0,
    vrfFragment: movePacket.vrfFragment ?? "",
  };
}
