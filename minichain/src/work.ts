import { bytesToHex } from "@noble/hashes/utils.js";

import { HASH_LENGTH, type Hash } from "./hash.ts";

/** The largest target, 2^256 - 1. Every hash meets it, so a block needs no work at all. */
export const MAXIMUM_TARGET = 2n ** 256n - 1n;

/** The largest nonce a header can carry, 2^64 - 1. */
export const MAXIMUM_NONCE = 2n ** 64n - 1n;

/** Throws unless the target lies between 1 and the maximum target. */
function assertTargetInRange(target: bigint): void {
  if (target < 1n || target > MAXIMUM_TARGET) {
    throw new RangeError("target must be between 1 and 2^256 - 1");
  }
}

/** Reads a hash as one big-endian integer, so hashes can be compared with a target. */
export function hashToInteger(hash: Hash): bigint {
  if (hash.length !== HASH_LENGTH) {
    throw new RangeError(`hash must be ${HASH_LENGTH} bytes`);
  }
  return BigInt(`0x${bytesToHex(hash)}`);
}

/** Tells whether a hash, read as an integer, is at or below the target. */
export function meetsTarget(hash: Hash, target: bigint): boolean {
  assertTargetInRange(target);
  return hashToInteger(hash) <= target;
}

/** Computes the expected number of hashes needed to meet a target: 2^256 over target + 1. */
export function computeWork(target: bigint): bigint {
  assertTargetInRange(target);
  return 2n ** 256n / (target + 1n);
}
