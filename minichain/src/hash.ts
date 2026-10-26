import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

import { type Encodable, encode } from "./encoding.ts";

/** Number of bytes in every hash this module produces. */
export const HASH_LENGTH = 32;

/** A keccak-256 digest. */
export type Hash = Uint8Array;

/** Computes keccak-256 (Ethereum's variant, not NIST SHA3-256) of raw bytes. */
export function hashBytes(data: Uint8Array): Hash {
  return keccak_256(data);
}

/** Computes keccak-256 of the canonical encoding of a value. */
export function hashOf(value: Encodable): Hash {
  return hashBytes(encode(value));
}

/** Formats bytes as lowercase hexadecimal with a 0x prefix. */
export function toHexadecimal(bytes: Uint8Array): string {
  return `0x${bytesToHex(bytes)}`;
}

/** Parses 0x-prefixed hexadecimal, throwing on a missing prefix, odd length or invalid characters. */
export function fromHexadecimal(hexadecimalText: string): Uint8Array {
  if (!hexadecimalText.startsWith("0x")) {
    throw new TypeError("hexadecimal text must start with 0x");
  }
  return hexToBytes(hexadecimalText.slice(2));
}
