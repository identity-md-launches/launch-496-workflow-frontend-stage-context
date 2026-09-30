// Shared helpers for the deployment manifest scripts. No network access, no secrets.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { keccak_256 } from '@noble/hashes/sha3.js';

/** Key-sorted, whitespace-free JSON (the handoff's `canonicalKeccak(abi)` input). */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function canonicalKeccak(value) {
  return Buffer.from(keccak_256(new TextEncoder().encode(canonicalJson(value)))).toString('hex');
}

export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function isHex64(s) {
  return typeof s === 'string' && /^[0-9a-f]{64}$/.test(s);
}

export function isAddress(s) {
  return typeof s === 'string' && /^0x[0-9a-fA-F]{40}$/.test(s);
}
