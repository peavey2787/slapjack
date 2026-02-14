/**
 * outcome.js - Outcome formatting for cheating audit
 */

import { ANCHOR } from "../../core/constants.js";

export function formatOutcome(outcomeCode) {
  if (outcomeCode === ANCHOR.OUTCOME_COMPLETE) return "complete";
  if (outcomeCode === ANCHOR.OUTCOME_FORFEIT) return "forfeit";
  if (outcomeCode === ANCHOR.OUTCOME_TIMEOUT) return "timeout";
  if (outcomeCode === ANCHOR.OUTCOME_CHEAT) return "cheat";
  return "unknown";
}
