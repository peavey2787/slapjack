import { setQrngCache } from "../fetcher/cache.js";
import { getQRNG } from "../fetcher/qrng.js";

export async function runTests() {
  let passed = true;
  let details = [];

  try {
    // 1. Returns valid Block object from cache
    setQrngCache("nist", 16, { hash: "abc", time: 123456, source: "nist" });
    const result = await getQRNG("nist", 16);
    if (!(result && typeof result.hash === "string")) {
      passed = false;
      details.push("getQRNG does not return object with hash field");
    }
    if (!result.time) {
      passed = false;
      details.push("getQRNG does not return object with time field");
    }

    // 2. Throws on invalid length
    let threw = false;
    try {
      await getQRNG("nist", 0);
    } catch (e) {
      threw = true;
    }
    if (!threw) {
      passed = false;
      details.push("getQRNG does not throw on invalid length");
    }

    // 3. Returns cached Block if throttled
    setQrngCache("nist", 16, { hash: "def", time: 654321, source: "nist" });
    const result2 = await getQRNG("nist", 16);
    if (typeof result2.hash !== "string") {
      passed = false;
      details.push("throttled getQRNG does not return object with hash field");
    }
  } catch (err) {
    passed = false;
    details.push("Exception: " + (err.message || err.toString()));
  }

  if (passed) details.push("All qrng.js unit tests passed.");
  return { passed, details: details.join("\n") };
}
