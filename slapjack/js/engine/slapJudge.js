/**
 * slapJudge.js — VRF-based tie-breaking and slap validation.
 *
 * Uses the kkGameEngine's VRF to settle simultaneous slaps
 * with cryptographically provable fairness.
 */

import * as Bridge from './bridge.js';

/**
 * Determine winner of a simultaneous slap using VRF.
 *
 * Both players slapped within the tie window, so we use provable
 * randomness to decide who wins. The seed is deterministic —
 * same pile state → same result → verifiable.
 *
 * @param {string} pileHash - Hash/id of the current pile state
 * @param {string} player1Id
 * @param {string} player2Id
 * @returns {Promise<{winnerId: string, vrfValue: string, vrfNumber: number}>}
 */
export async function breakTie(pileHash, player1Id, player2Id) {
  const seed = `tie-${pileHash}-${[player1Id, player2Id].sort().join('-')}`;

  const vrf = await Bridge.getRandom(seed);

  // VRF number is 0–1. Below 0.5 → player1 wins, else player2.
  const winnerId = vrf.number < 0.5 ? player1Id : player2Id;

  return {
    winnerId,
    vrfValue: vrf.value,
    vrfNumber: vrf.number,
  };
}

/** Grace period (ms) for considering two slaps "simultaneous" */
export const TIE_WINDOW_MS = 400;

/**
 * Validate whether a slap is legal (top card is a Jack).
 *
 * @param {Object|null} topCard - The card on top of the pile
 * @returns {boolean}
 */
export function isValidSlap(topCard) {
  return topCard?.rank === 'J';
}

/**
 * Check if a slap arrived within the tie window relative to a reference time.
 *
 * @param {number} slapTime
 * @param {number} referenceTime
 * @returns {boolean}
 */
export function isWithinTieWindow(slapTime, referenceTime) {
  return Math.abs(slapTime - referenceTime) <= TIE_WINDOW_MS;
}
