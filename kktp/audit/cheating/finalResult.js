/**
 * finalResult.js - Final result hash verification for cheating audit
 */

import { bytesToHex, sha256 } from "../../core/cryptoUtils.js";
import { equalsHex } from "./utils.js";

export async function verifyFinalResultHash(finalData) {
  const resultString = `RESULT:${finalData.finalScore}:${finalData.coinsCollected}:${finalData.outcomeCode}:${finalData.raceTimeMs}`;
  const hash = await sha256(new TextEncoder().encode(resultString));
  const hashHex = bytesToHex(hash);
  if (!equalsHex(finalData.resultLeafHash, hashHex)) {
    return { ok: false, reason: "final_result_hash_mismatch" };
  }
  return { ok: true };
}
