import { secp256k1 } from "@noble/curves/secp256k1.js";

import { hashBytes } from "./hash.ts";

/** Number of bytes in an address. */
export const ADDRESS_LENGTH = 20;

const UNCOMPRESSED_PUBLIC_KEY_LENGTH = 65;
const UNCOMPRESSED_PUBLIC_KEY_PREFIX = 0x04;

/** A secp256k1 private key: 32 secret bytes. */
export type PrivateKey = Uint8Array;

/** An uncompressed secp256k1 public key: the 0x04 prefix, then the x and y coordinates. */
export type PublicKey = Uint8Array;

/** An account address: the last 20 bytes of the keccak-256 hash of a public key. */
export type Address = Uint8Array;

/** Generates a random valid private key from the system's secure random source. */
export function generatePrivateKey(): PrivateKey {
  return secp256k1.utils.randomSecretKey();
}

/** Derives the uncompressed public key, throwing if the private key is not valid. */
export function derivePublicKey(privateKey: PrivateKey): PublicKey {
  return secp256k1.getPublicKey(privateKey, false);
}

/** Derives an address from the public key without its 0x04 prefix, the same way Ethereum does. */
export function deriveAddress(publicKey: PublicKey): Address {
  if (publicKey.length !== UNCOMPRESSED_PUBLIC_KEY_LENGTH || publicKey[0] !== UNCOMPRESSED_PUBLIC_KEY_PREFIX) {
    throw new RangeError("public key must be uncompressed: 65 bytes starting with 0x04");
  }
  return hashBytes(publicKey.subarray(1)).slice(-ADDRESS_LENGTH);
}
