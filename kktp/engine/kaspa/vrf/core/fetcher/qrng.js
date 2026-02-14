import { getQrngCache, setQrngCache } from "./cache.js";
import { Block } from "../models/Block.js";
import { NISTBeacon } from "./QRNG-fetcher.js";
import { logInfo, logError } from "../logs/logger.js";
import { CONFIG } from "../config.js";

const nistProvider = new NISTBeacon();

export async function getQRNG(providerName = "nist", length = 32) {
  if (!length || length <= 0) {
    throw new Error("Invalid QRNG length");
  }

  const cache = getQrngCache();
  if (cache?.result?.hash && (Date.now() - cache.timestamp < CONFIG.QRNG_CACHE_DURATION)) {
    return cache.result;
  }

  // Auto-retry with exponential backoff (production-ready)
  const MAX_RETRIES = 3;
  let lastErr = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      logInfo(`Fetching QRNG (attempt ${attempt}/${MAX_RETRIES})...`);
      const response = await nistProvider.request(nistProvider.baseUrl);
      const pulse = response.pulse;
      const previousValue =
        pulse.listValues?.find((v) => v.type === "previous")?.value ||
        pulse.previousOutputValue;
      const qrngBlock = new Block({
        hash: pulse.outputValue,
        time: pulse.timeStamp,
        source: providerName,
        seedValue: pulse.seedValue,
        certificateId: pulse.certificateId,
        previousOutputValue: pulse.localPrevHash || previousValue,
        pulseIndex: pulse.pulseIndex,
        signature: pulse.signatureValue,
        signatureValue: pulse.signatureValue,
        uri: pulse.uri,
        version: pulse.version,
        cipherSuite: pulse.cipherSuite,
        period: pulse.period,
        chainIndex: pulse.chainIndex,
        timeStamp: pulse.timeStamp,
        localRandomValue: pulse.localRandomValue,
        external: pulse.external,
        listValues: pulse.listValues,
        precommitmentValue: pulse.precommitmentValue,
        statusCode: pulse.statusCode,
      });

      setQrngCache(providerName, length, qrngBlock);
      return qrngBlock;
    } catch (err) {
      lastErr = err;
      logError(`QRNG Fetch Failed (attempt ${attempt}/${MAX_RETRIES})`, err.message);

      if (attempt < MAX_RETRIES) {
        const delay = 1000 * Math.pow(2, attempt - 1); // 1s, 2s
        logInfo(`Retrying QRNG fetch in ${delay}ms...`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  // All retries exhausted — return stale cache if available
  if (cache?.result?.hash) {
    logInfo("All QRNG retries failed, returning stale cached pulse", {
      cacheAge: Math.round((Date.now() - cache.timestamp) / 1000) + "s",
    });
    return cache.result;
  }

  throw lastErr;
}
