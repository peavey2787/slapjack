import {
  dehydrateTx,
  dehydrateBlock,
  payloadToHex,
  hexToString
} from "../utilities/utilities.js";

/**
 * Production-ready forward DAG walker.
 * Supports start/end hashes, blueScore boundaries, and timestamp filtering.
 */
export async function walkDagRange({
  client,
  startHash,
  endHash = null,
  prefixes = [],
  onMatch,
  maxSeconds = 30,
  minTimestamp = 0,
  logFn = () => {},
} = {}) {
  const startedAt = Date.now();
  const deadline = startedAt + maxSeconds * 1000;

  // Normalize prefixes once (hex)
  const hexPrefixes = prefixes.map(p => payloadToHex(p)).filter(Boolean);

  let stopScore = Infinity;
  if (endHash) {
    try {
      const endResp = await client.getBlock({
        hash: endHash,
        includeTransactions: true,
      });
      logFn("[walkDagRange] endHash getBlock response:", endResp);
      const endBlockSafe = dehydrateBlock(endResp?.block);
      stopScore = endBlockSafe?.blueScore ?? Infinity;
      logFn("[walkDagRange] stopScore set to:", stopScore);
    } catch (err) {
      logFn(`[WARN] Could not resolve endHash score, walking to present.`);
    }
  }

  let lowHash = startHash;
  let loopCount = 0;

  while (Date.now() < deadline) {
    loopCount++;
    let resp;
    try {
      logFn(`[walkDagRange] Fetching blocks with lowHash: ${lowHash}`);
      resp = await client.getBlocks({
        lowHash,
        includeBlocks: true,
        includeTransactions: true,
      });
      logFn(`[walkDagRange] getBlocks response:`, resp);
    } catch (err) {
      logFn(`[RPC ERROR] ${err.message}`);
      logFn("[walkDagRange] getBlocks RPC ERROR:", err);
      break;
    }

    if (!resp?.blocks?.length) {
      logFn("[walkDagRange] No blocks returned, breaking.");
      break;
    }

    for (const block of resp.blocks) {
      const safeBlock = dehydrateBlock(block);
      logFn(`[walkDagRange] Processing block:`, safeBlock);

      if (safeBlock.blueScore > stopScore) {
        logFn(`[END] Reached blue score ${safeBlock.blueScore}`);
        logFn(
          `[walkDagRange] Exiting: blueScore ${safeBlock.blueScore} > stopScore ${stopScore}`,
        );
        return;
      }

      if (safeBlock.timestamp < minTimestamp) {
        if (block.transactions) {
          for (const tx of block.transactions) if (tx.free) tx.free();
        }
        logFn(
          `[walkDagRange] Skipping block (timestamp too old):`,
          safeBlock.timestamp,
        );
        continue;
      }

      const txs = block.transactions || [];
      for (const tx of txs) {
        const payload = (tx.payload || "").toLowerCase();
        if (
          hexPrefixes.length === 0 ||
          hexPrefixes.some((preHex) => payload.startsWith(preHex))
        ) {
          // Decode payload to string
          let decodedPayload = undefined;
          if (tx.payload) {
            try {
              decodedPayload = hexToString(tx.payload);
            } catch (e) {
              decodedPayload = undefined;
            }
          }
          const safeTx = dehydrateTx({ tx, block, decodedPayload });
          logFn(`[walkDagRange] Matching tx:`, safeTx);
          if (onMatch && (await onMatch(safeTx, safeBlock)) === true) {
            tx.free?.();
            return;
          }
        }
        if (typeof tx.free === "function") tx.free();
      }
    }

    const lastBlock = resp.blocks[resp.blocks.length - 1];
    const newLow = (lastBlock.hash || lastBlock.header?.hash).toString();
    logFn(
      `[walkDagRange] lastBlock.hash: ${newLow}, previous lowHash: ${lowHash}`,
    );
    if (newLow === lowHash) {
      logFn("[walkDagRange] newLow equals lowHash, breaking.");
      break;
    }
    lowHash = newLow;
  }
  logFn(`[walkDagRange] Exiting main loop after ${loopCount} iterations.`);
}
