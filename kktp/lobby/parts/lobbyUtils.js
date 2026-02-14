/**
 * LobbyUtils - Shared utility functions for lobby modules
 *
 * Pure utility functions with no side effects.
 * Used across all lobby modules for common operations.
 *
 * @module kktp/lobby/parts/lobbyUtils
 */

import { blake2b } from "https://esm.sh/@noble/hashes@1.3.0/blake2b";

/**
 * Convert Uint8Array to hex string
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function uint8ToHex(bytes) {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Convert hex string to Uint8Array
 * @param {string} hex
 * @returns {Uint8Array}
 */
export function hexToUint8(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

/**
 * Generate a 32-byte cryptographic group key
 * @returns {Promise<Uint8Array>}
 */
export async function generateGroupKey() {
  return crypto.getRandomValues(new Uint8Array(32));
}

/**
 * Derive a deterministic group mailbox ID from lobby ID
 * Uses BLAKE2b for domain separation
 * @param {string} lobbyId
 * @returns {string} Hex-encoded mailbox ID
 */
export function deriveGroupMailboxId(lobbyId) {
  const encoder = new TextEncoder();
  const data = encoder.encode(`KKTP:GROUP:MAILBOX:${lobbyId}`);
  const hash = blake2b(data, { dkLen: 32 });
  return uint8ToHex(hash);
}

/**
 * Compute state root commitment for integrity verification
 * Merkle-ish commitment to roster + key version
 * @param {Object} lobby - Lobby object
 * @returns {string} Hex-encoded state root
 */
export function computeStateRoot(lobby) {
  const members = Array.from(lobby.members.keys()).sort();
  const data = JSON.stringify({
    lobbyId: lobby.lobbyId,
    keyVersion: lobby.keyVersion,
    members,
  });
  const encoder = new TextEncoder();
  const hash = blake2b(encoder.encode(data), { dkLen: 32 });
  return uint8ToHex(hash);
}

/**
 * Export group key as hex string
 * @param {Uint8Array} groupKey
 * @returns {string}
 */
export function exportGroupKey(groupKey) {
  return uint8ToHex(groupKey);
}

/**
 * Export member list as a serializable array
 * @param {Map<string, Object>} members - Members map
 * @returns {Array<Object>}
 */
export function exportMemberList(members) {
  return Array.from(members.values()).map((m) => ({
    pubSig: m.pubSig,
    displayName: m.displayName,
    role: m.role,
    joinedAt: m.joinedAt,
  }));
}

/**
 * Truncate a string for logging (safe for undefined)
 * @param {string|undefined} str
 * @param {number} [len=16]
 * @returns {string}
 */
export function truncate(str, len = 16) {
  if (!str) return "";
  return str.slice(0, len);
}
