/**
 * utils.js - Shared helpers for cheating audit
 */

import { bytesToHex } from "../../core/cryptoUtils.js";

export function normalizeHex(value) {
  if (!value) return "";
  return String(value).toLowerCase().replace(/^0x/, "");
}

export function equalsHex(a, b) {
  return normalizeHex(a) === normalizeHex(b);
}

export function isZeroHash(value) {
  const clean = normalizeHex(value);
  return clean.length > 0 && /^0+$/.test(clean);
}

export function addReason(reasons, reason) {
  if (reason && !reasons.includes(reason)) reasons.push(reason);
}

export function addWarning(warnings, warning) {
  if (warning && !warnings.includes(warning)) warnings.push(warning);
}

export function readUint32BE(bytes, offset) {
  return (
    ((bytes[offset] << 24) |
      (bytes[offset + 1] << 16) |
      (bytes[offset + 2] << 8) |
      bytes[offset + 3]) >>>
    0
  );
}

export function readBigUint64BE(bytes, offset) {
  let result = 0n;
  for (let i = 0; i < 8; i++) {
    result = (result << 8n) | BigInt(bytes[offset + i]);
  }
  return result;
}

export function getTimeDelta(move) {
  if (Number.isFinite(move?.timeDelta)) return move.timeDelta;
  return null;
}

export function getVrfFragment(move) {
  if (move?.vrfFragment) return normalizeHex(move.vrfFragment).slice(0, 8);
  let vrfHex = move?.vrfOutputHex ?? move?.vrfOutput ?? "";
  if (!vrfHex) return "";
  if (vrfHex instanceof Uint8Array) {
    vrfHex = bytesToHex(vrfHex);
  }
  const clean = normalizeHex(vrfHex);
  return clean.slice(0, 8);
}
