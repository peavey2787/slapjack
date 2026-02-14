/**
 * entropy.js - External entropy verification for cheating audit
 */

import { ANCHOR } from "../../core/constants.js";
import {
  addReason,
  addWarning,
  equalsHex,
  isZeroHash,
  normalizeHex,
} from "./utils.js";

const PROXY = "https://api.allorigins.win/raw?url=";
const NIST_PULSE_BASE_URL = "https://beacon.nist.gov/beacon/2.0/chain/1/pulse/";
const BTC_BLOCK_BASE_URL = "https://mempool.space/api/block/";

export async function verifyEntropySources({
  genesisData,
  heartbeats,
  parsedByTxId,
  reasons,
  warnings,
}) {
  if (!globalThis.fetch) {
    addWarning(warnings, "fetch_unavailable");
    return;
  }

  const btcHashes = Array.isArray(genesisData?.btcBlockHashes)
    ? genesisData.btcBlockHashes.filter(
        (h) => normalizeHex(h) && !isZeroHash(h),
      )
    : [];

  if (btcHashes.length === 0) {
    addReason(reasons, "genesis_btc_hashes_missing");
  } else {
    const results = [];
    for (const hash of btcHashes) {
      // Process one by one to avoid hammering the proxy/API
      const result = await verifyBtcHash(hash).catch(() => ({ ok: false }));
      results.push(result);

      // Optional: tiny 50ms delay if you're still seeing glitches
      // await new Promise(r => setTimeout(r, 50));
    }

    results.forEach((result) => {
      if (!result.ok) {
        addReason(reasons, "btc_hash_invalid");
      }
    });
  }

  const nistPulseIndex = genesisData?.nistPulseIndex ?? null;
  const nistOutputHash = genesisData?.nistOutputHash ?? "";
  const nistSignature = genesisData?.nistSignature ?? "";
  if (
    nistPulseIndex === null ||
    nistPulseIndex === undefined ||
    !normalizeHex(nistOutputHash) ||
    !normalizeHex(nistSignature)
  ) {
    addReason(reasons, "genesis_nist_missing");
  } else {
    const nistCheck = await verifyNistPulse(
      nistPulseIndex,
      nistOutputHash,
      nistSignature,
    );
    if (!nistCheck.ok) {
      addReason(reasons, nistCheck.reason);
    }
  }

  for (const heartbeat of heartbeats || []) {
    const txId = normalizeHex(heartbeat?.txId);
    const parsed = parsedByTxId.get(txId) || {};

    if (parsed.deltaFlags & ANCHOR.DELTA_FLAG_BTC) {
      const btcDelta = parsed.btcDeltaHash || "";
      if (!normalizeHex(btcDelta) || isZeroHash(btcDelta)) {
        addReason(reasons, "heartbeat_btc_delta_missing");
      } else {
        const btcCheck = await verifyBtcHash(btcDelta);
        if (!btcCheck.ok) {
          addReason(reasons, "heartbeat_btc_delta_invalid");
        }
      }
    }

    if (parsed.deltaFlags & ANCHOR.DELTA_FLAG_NIST) {
      const nistDelta = parsed.nistDelta || null;
      if (!nistDelta || !nistDelta.pulseIndex) {
        addReason(reasons, "heartbeat_nist_delta_missing");
      } else {
        const nistDeltaCheck = await verifyNistPulse(
          nistDelta.pulseIndex,
          nistDelta.outputHash,
          nistDelta.signature,
        );
        if (!nistDeltaCheck.ok) {
          addReason(reasons, "heartbeat_nist_delta_invalid");
        }
      }
    }
  }
}

export async function verifyNistPulse(pulseIndex, outputHash, signature) {
  try {
    // Convert BigInt to a clean string so "1648264n" becomes "1648264"
    const cleanIndex = pulseIndex.toString().replace("n", "");
    const url = `${NIST_PULSE_BASE_URL}${cleanIndex}`;

    // 2. Fetch directly from NIST
    const response = await fetch(url);

    if (!response.ok) {
      return { ok: false, reason: "nist_fetch_failed" };
    }

    const data = await response.json();
    const pulse = data?.pulse ?? null;

    if (!pulse) return { ok: false, reason: "nist_response_invalid" };

    const outputValue = normalizeHex(pulse.outputValue);
    const signatureValue = normalizeHex(pulse.signatureValue);

    // 3. Comparison logic remains the same
    if (!equalsHex(outputValue, outputHash)) {
      return { ok: false, reason: "nist_output_mismatch" };
    }

    // Some pulses might have slightly different signature lengths depending on the chain,
    // so we verify it if provided.
    if (signature && !equalsHex(signatureValue, signature)) {
      return { ok: false, reason: "nist_signature_mismatch" };
    }

    return { ok: true };
  } catch (err) {
    // Logging the error is helpful for debugging if NIST changes their API
    console.error("NIST direct fetch error:", err);
    return { ok: false, reason: "nist_fetch_failed" };
  }
}

export async function verifyBtcHash(hash) {
  try {
    const url = `${PROXY}${encodeURIComponent(`${BTC_BLOCK_BASE_URL}${normalizeHex(hash)}`)}`;
    const response = await fetch(url);
    if (!response.ok) return { ok: false };
    const data = await response.json();
    const id = normalizeHex(data?.id ?? data?.hash ?? "");
    if (!id || !equalsHex(id, hash)) return { ok: false };
    return { ok: true };
  } catch (err) {
    return { ok: false };
  }
}
