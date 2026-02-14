/**
 * Strict RFC 8785 (JCS) Canonicalization
 * Core logic for KKTP Signature consistency.
 */
export function canonicalize(value) {
  if (value === null) return "null";
  const t = typeof value;

  if (t === "boolean") return value ? "true" : "false";
  if (t === "number") return serializeNumber(value);
  if (t === "string") return serializeString(value);
  if (Array.isArray(value)) return serializeArray(value);
  if (t === "object") return serializeObject(value);

  throw new Error("Unsupported type in canonical JSON");
}

/**
 * Prepares a KKTP anchor for signing by omitting the signature field
 * and the non-signed metadata.
 */
export function prepareForSigning(
  obj,
  { omitKeys = [], excludeMeta = true } = {},
) {
  const clean = toPlainJson(obj);

  function walk(v) {
    if (v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map(walk);

    const out = {};
    for (const k of Object.keys(v)) {
      if (omitKeys.includes(k)) continue;
      if (excludeMeta && k === "meta") continue;
      const child = walk(v[k]);
      if (child !== undefined) out[k] = child;
    }
    return out;
  }
  return walk(clean);
}

function serializeNumber(n) {
  if (!Number.isFinite(n)) throw new Error("Non-finite numbers not allowed");
  let s = n.toString();
  if (s.includes("e") || s.includes("E")) s = toPlainString(n);
  if (s === "-0") s = "0";
  return s;
}

function toPlainString(n) {
  const s = n.toString();
  if (!/e/i.test(s)) return s;
  const [mantissa, expStr] = s.split(/e/i);
  const exp = parseInt(expStr, 10);
  let [intPart, fracPart = ""] = mantissa.split(".");
  if (exp > 0) {
    const neededZeros = exp - fracPart.length;
    if (neededZeros >= 0) return intPart + fracPart + "0".repeat(neededZeros);
    const idx = fracPart.length + exp;
    return intPart + fracPart.slice(0, idx) + "." + fracPart.slice(idx);
  } else {
    const zeros = "0".repeat(Math.abs(exp) - 1);
    return "0." + zeros + intPart + fracPart;
  }
}

function serializeString(str) {
  let out = '"';
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    switch (c) {
      case 0x22:
        out += '\\"';
        break;
      case 0x5c:
        out += "\\\\";
        break;
      case 0x08:
        out += "\\b";
        break;
      case 0x0c:
        out += "\\f";
        break;
      case 0x0a:
        out += "\\n";
        break;
      case 0x0d:
        out += "\\r";
        break;
      case 0x09:
        out += "\\t";
        break;
      default:
        if (c < 0x20) out += "\\u" + c.toString(16).padStart(4, "0");
        else out += str[i];
    }
  }
  return out + '"';
}

function serializeArray(arr) {
  return "[" + arr.map((v) => canonicalize(v)).join(",") + "]";
}

function serializeObject(obj) {
  const keys = Object.keys(obj).sort();
  const parts = [];
  for (const k of keys) {
    const v = obj[k];
    if (v === undefined) continue;
    parts.push(serializeString(k) + ":" + canonicalize(v));
  }
  return "{" + parts.join(",") + "}";
}

/**
 * Strips non-JSON types and creates a clean deep-clone POJO.
 */
export function toPlainJson(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(toPlainJson);

  const out = {};
  for (const key of Object.keys(value)) {
    const child = toPlainJson(value[key]);
    if (child !== undefined) out[key] = child;
  }
  return out;
}

/**
 * KKTP-Compliant Strict Parser
 * Replaces _safeParseJson to satisfy Section 7.9
 */
export function strictParseJson(text) {
  try {
    // 1. Convert string to object
    const obj = JSON.parse(text);

    // 2. Convert that object BACK to a string using your canonical rules
    const verificationString = canonicalize(obj);

    // 3. THE COMPLIANCE CHECK:
    // If the input 'text' isn't EXACTLY the same as our 'verificationString',
    // then the sender violated RFC 8785 (extra spaces, wrong order, etc.)
    if (text !== verificationString) {
      throw new Error("KKTP Section 7.9 Violation: Non-canonical input detected.");
    }

    return obj;
  } catch (e) {
    // Return null to maintain the 'safe' behavior,
    // but only if it's actually valid & canonical JSON.
    return null;
  }
}
