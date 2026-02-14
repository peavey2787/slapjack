import { Logger, LogModule } from "../../../../core/logger.js";

const log = Logger.create(LogModule.vrf.core.nistVerifier);

// This is the JWK representation of the NIST 2.0 Beta Key.
// It explicitly defines the modulus (n) and exponent (e).
const NIST_JWK = {
  kty: "RSA",
  n: "wvC8V3Nb6i8tC_x4Khs0aSDSyvXpGS9Ny3tjkG9b4q4dPdrKzgzl611sbo0PZvob3VQM8MYyY7Y07-PSu76uR_qjAiE-0bz5qjrgtqzXA1JIN0cCP7t7SML9xCn5S45NIauEUxJVFZ6E83GNjAgk_Ctra4MCD73UC74qx8kP-idR6BwkQYSgoPTzgkpiFBvXkAo4TIociiExaEOYP208ZgcXHphB2gb_TKKlA3r9aTYUIZcpT23MTEmV6913T8ODC-CyRNSZ0OvIO0uXzNpOHGzsd_AnT5C6T-9aMWx-4IjeRgl3zwuP9cnNMbJUJQ2qfGiQA2_4Cr19oHN-XiBQIgsX2RmPuVRUAGpQrqzTF5z-OvGutgaA6ZL0SUyN9KnRO0KkVqb1lWaclCEEiIJTXjC9tCo1xF0wGZyeHrbWI4TqKKgnKC__NejclCak-li1HW02Vttjav4PhlcnSI0f_uW6ljjOG0TQdJiqWLN-jTZEZQ2CmMLRJQLfj_brti4J-IFZEjDF3CwK8daf-n36he7J1PAwRCWNsKExIyGzQTyWGfJ9VTz9ljtY5-zz-hA5PTUaPVOzUzHyl97227kPf4KaJQYMwa2Uf67zmzCv3NZtVACo2pVJvYwFZhjG8RThgY60KJZHcJnuhwG0CHBrHpArryLrdeMWEePd-7-aCWu88KQ",
  e: "AQAB",
  alg: "PS512",
  ext: true,
  key_ops: ["verify"],
  use: "sig",
};

const CERT_BASE_URL = "https://beacon.nist.gov/beacon/2.0/certificate/";
const RSA_OID = new Uint8Array([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01]);

let cachedKey = null;
let cachedKeyId = null;

function cleanB64Url(s) {
  return String(s || "").replace(/[^A-Za-z0-9_-]/g, "");
}

function base64UrlToBytes(b64url) {
  const clean = cleanB64Url(b64url);
  const padded = clean + "===".slice((clean.length + 3) % 4);
  const base64 = padded.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function bytesToBase64Url(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const base64 = btoa(binary);
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function hexToBytes(hex) {
  const clean = String(hex || "").replace(/[^0-9a-fA-F]/g, "");
  if (clean.length === 0) return new Uint8Array(0);
  if (clean.length % 2 !== 0) {
    throw new Error("Invalid hex length for NIST field");
  }
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < clean.length; i += 2) {
    bytes[i / 2] = parseInt(clean.slice(i, i + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes) {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function u32be(value) {
  const v = Number(value || 0) >>> 0;
  return new Uint8Array([
    (v >>> 24) & 0xff,
    (v >>> 16) & 0xff,
    (v >>> 8) & 0xff,
    v & 0xff,
  ]);
}

function u64be(value) {
  const v = BigInt(value || 0);
  const bytes = new Uint8Array(8);
  for (let i = 7; i >= 0; i--) {
    bytes[i] = Number(v >> BigInt((7 - i) * 8)) & 0xff;
  }
  return bytes;
}

function concatBytes(chunks) {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

function utf8Bytes(str) {
  return new TextEncoder().encode(String(str ?? ""));
}

function buildSignedData(pulse) {
  const uri = utf8Bytes(pulse.uri || "");
  const version = utf8Bytes(pulse.version || "");
  const cipherSuite = u32be(pulse.cipherSuite);
  const period = u32be(pulse.period);
  const certificateId = hexToBytes(pulse.certificateId || "");
  const chainIndex = u64be(pulse.chainIndex);
  const pulseIndex = u64be(pulse.pulseIndex);
  const timeStamp = utf8Bytes(pulse.timeStamp || pulse.time || "");
  const localRandomValue = hexToBytes(pulse.localRandomValue || pulse.seedValue || "");

  const externalSourceId = hexToBytes(pulse.external?.sourceId || "");
  const externalStatusCode = u32be(pulse.external?.statusCode);
  const externalValue = hexToBytes(pulse.external?.value || "");

  const listValues = Array.isArray(pulse.listValues) ? pulse.listValues : [];
  const listValueChunks = [];
  if (listValues.length > 0) {
    for (const item of listValues) {
      const valueBytes = hexToBytes(item?.value || "");
      listValueChunks.push(u32be(valueBytes.length), valueBytes);
    }
  } else if (pulse.previousOutputValue) {
    const valueBytes = hexToBytes(pulse.previousOutputValue);
    listValueChunks.push(u32be(valueBytes.length), valueBytes);
  }

  const precommitmentValue = hexToBytes(pulse.precommitmentValue || "");
  const statusCode = u32be(pulse.statusCode);

  return concatBytes([
    u32be(uri.length),
    uri,
    u32be(version.length),
    version,
    cipherSuite,
    period,
    u32be(certificateId.length),
    certificateId,
    chainIndex,
    pulseIndex,
    u32be(timeStamp.length),
    timeStamp,
    u32be(localRandomValue.length),
    localRandomValue,
    u32be(externalSourceId.length),
    externalSourceId,
    externalStatusCode,
    u32be(externalValue.length),
    externalValue,
    ...listValueChunks,
    u32be(precommitmentValue.length),
    precommitmentValue,
    statusCode,
  ]);
}

function pemToDerBytes(pem) {
  const clean = pem
    .replace(/-----BEGIN CERTIFICATE-----/g, "")
    .replace(/-----END CERTIFICATE-----/g, "")
    .replace(/\s+/g, "");
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function readLength(bytes, offset) {
  const first = bytes[offset];
  if (first < 0x80) return { length: first, lengthBytes: 1 };
  const count = first & 0x7f;
  let length = 0;
  for (let i = 0; i < count; i++) {
    length = (length << 8) | bytes[offset + 1 + i];
  }
  return { length, lengthBytes: 1 + count };
}

function readTlv(bytes, offset) {
  const tag = bytes[offset];
  const { length, lengthBytes } = readLength(bytes, offset + 1);
  const header = 1 + lengthBytes;
  const valueStart = offset + header;
  const next = valueStart + length;
  return { tag, length, header, valueStart, next, offset };
}

function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function extractSpkiFromX509(derBytes) {
  const cert = readTlv(derBytes, 0);
  if (cert.tag !== 0x30) {
    throw new Error("Unexpected certificate ASN.1 tag");
  }
  const tbs = readTlv(derBytes, cert.valueStart);
  let offset = tbs.valueStart;
  const end = tbs.valueStart + tbs.length;
  while (offset < end) {
    const tlv = readTlv(derBytes, offset);
    if (tlv.tag === 0x30) {
      const firstChild = readTlv(derBytes, tlv.valueStart);
      const secondChild = readTlv(derBytes, firstChild.next);
      if (firstChild.tag === 0x30 && secondChild.tag === 0x03) {
        const oidTlv = readTlv(derBytes, firstChild.valueStart);
        if (oidTlv.tag === 0x06) {
          const oidBytes = derBytes.slice(oidTlv.valueStart, oidTlv.valueStart + oidTlv.length);
          if (bytesEqual(oidBytes, RSA_OID)) {
            return derBytes.slice(tlv.offset, tlv.next);
          }
        }
      }
    }
    offset = tlv.next;
  }
  throw new Error("SubjectPublicKeyInfo not found in certificate");
}

async function fetchCertificatePem(certificateId) {
  const url = `${CERT_BASE_URL}${certificateId}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`NIST certificate fetch failed: ${res.status}`);
  }
  return await res.text();
}

export const NistVerifier = {
  async getPublicKey(pulse) {
    const certId = pulse?.certificateHash || pulse?.certificateId;
    if (certId && cachedKey && cachedKeyId === certId) {
      return cachedKey;
    }
    if (certId) {
      try {
        log.warn("NistVerifier: attempting certificate fetch", certId);
        const pem = await fetchCertificatePem(certId);
        const der = pemToDerBytes(pem);
        const spki = extractSpkiFromX509(der);
        const key = await crypto.subtle.importKey(
          "spki",
          spki,
          { name: "RSASSA-PKCS1-v1_5", hash: "SHA-512" },
          false,
          ["verify"],
        );
        cachedKey = key;
        cachedKeyId = certId;
        return key;
      } catch (certErr) {
        log.error("NistVerifier: certificate import failed:", certErr);
      }
    }

    try {
      const rawN = base64UrlToBytes(NIST_JWK.n);
      const rawE = base64UrlToBytes(NIST_JWK.e);
      let trimmedN = rawN;
      while (trimmedN.length > 0 && trimmedN[0] === 0) {
        trimmedN = trimmedN.slice(1);
      }
      const validSizes = new Set([256, 384, 512]);
      if (!validSizes.has(trimmedN.length)) {
        log.warn(
          "NistVerifier: unexpected modulus length (bytes)",
          trimmedN.length,
        );
      }
      const buildJwk = (modulusBytes) => ({
        ...NIST_JWK,
        n: bytesToBase64Url(modulusBytes),
        e: bytesToBase64Url(rawE),
      });

      log.debug("NistVerifier: secureContext =", window.isSecureContext);
      log.debug("NistVerifier: crypto.subtle =", !!crypto?.subtle);
      log.debug("NistVerifier: n length =", NIST_JWK.n?.length);
      log.debug("NistVerifier: e length =", NIST_JWK.e?.length);
      log.debug(
        "NistVerifier: n valid b64url =",
        /^[A-Za-z0-9_-]+$/.test(NIST_JWK.n || ""),
      );
      log.debug(
        "NistVerifier: e valid b64url =",
        /^[A-Za-z0-9_-]+$/.test(NIST_JWK.e || ""),
      );
      log.debug("NistVerifier: n bytes =", rawN.length);
      log.debug("NistVerifier: n trimmed bytes =", trimmedN.length);
      log.debug("NistVerifier: e bytes =", rawE.length);
      try {
        const key = await crypto.subtle.importKey(
          "jwk",
          buildJwk(trimmedN),
          { name: "RSA-PSS", hash: "SHA-512" },
          false,
          ["verify"],
        );
        cachedKey = key;
        cachedKeyId = certId || cachedKeyId;
        return key;
      } catch (primaryErr) {
        if (!validSizes.has(trimmedN.length)) {
          const targetSizes = [512, 384, 256];
          for (const size of targetSizes) {
            if (trimmedN.length <= size) continue;
            const drop = trimmedN.length - size;
            const headSlice = trimmedN.slice(drop);
            log.warn(
              "NistVerifier: retry import with trimmed modulus (drop head bytes)",
              drop,
            );
            try {
              const key = await crypto.subtle.importKey(
                "jwk",
                buildJwk(headSlice),
                { name: "RSA-PSS", hash: "SHA-512" },
                false,
                ["verify"],
              );
              cachedKey = key;
              cachedKeyId = certId || cachedKeyId;
              return key;
            } catch (headErr) {
              log.warn(
                "NistVerifier: retry failed (drop head bytes)",
                headErr,
              );
            }

            const tailSlice = trimmedN.slice(0, size);
            log.warn(
              "NistVerifier: retry import with trimmed modulus (drop tail bytes)",
              drop,
            );
            try {
              const key = await crypto.subtle.importKey(
                "jwk",
                buildJwk(tailSlice),
                { name: "RSA-PSS", hash: "SHA-512" },
                false,
                ["verify"],
              );
              cachedKey = key;
              cachedKeyId = certId || cachedKeyId;
              return key;
            } catch (tailErr) {
              log.warn(
                "NistVerifier: retry failed (drop tail bytes)",
                tailErr,
              );
            }
          }
        }
        throw primaryErr;
      }
    } catch (err) {
      log.error("NistVerifier: JWK Import Failed:", err);
      throw err;
    }
  },

  async verifyPulse(pulse) {
    try {
      const publicKey = await this.getPublicKey(pulse);

      if (!pulse.uri || !pulse.version || !pulse.certificateId) {
        log.error("NistVerifier: pulse missing required fields", {
          uri: pulse.uri,
          version: pulse.version,
          certificateId: pulse.certificateId,
        });
      }

      const message = buildSignedData(pulse);

      const sigHex = (pulse.signatureValue || pulse.signature).replace(
        /[^0-9a-fA-F]/g,
        "",
      );
      const signature = new Uint8Array(
        sigHex.match(/.{1,2}/g).map((b) => parseInt(b, 16)),
      );

      const expectedOutput = String(
        pulse.outputValue || pulse.hash || "",
      ).replace(/[^0-9a-fA-F]/g, "");
      if (expectedOutput) {
        const digestInput = concatBytes([message, signature]);
        const digest = await crypto.subtle.digest("SHA-512", digestInput);
        const digestHex = bytesToHex(new Uint8Array(digest));
        if (digestHex !== expectedOutput.toLowerCase()) {
          log.error("NistVerifier: outputValue mismatch", {
            expected: expectedOutput.toLowerCase(),
            computed: digestHex,
            messageLength: message.length,
            signatureLength: signature.length,
          });
          return false;
        }
      }

      return await crypto.subtle.verify(
        { name: "RSASSA-PKCS1-v1_5" },
        publicKey,
        signature,
        message,
      );
    } catch (err) {
      log.error("NistVerifier: Verification Logic Failed:", err);
      return false;
    }
  },
};
