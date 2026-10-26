import assert from "node:assert/strict";

import { type Hash } from "./hash.ts";
import { deriveAddress, derivePublicKey } from "./keys.ts";
import { type SignedTransaction, signTransaction } from "./transaction.ts";

/** Builds a 32-byte private key holding a small integer, for fixtures that need a known key. */
export function privateKeyWithValue(value: number): Uint8Array {
  const privateKey = new Uint8Array(32);
  privateKey[31] = value;
  return privateKey;
}

/** Signs a transfer from private key 1 to the address of private key 2, varying only by nonce. */
export function createSignedTransactionWithNonce(nonce: bigint): SignedTransaction {
  return signTransaction(
    {
      chainIdentifier: 1337n,
      nonce,
      recipient: deriveAddress(derivePublicKey(privateKeyWithValue(2))),
      amount: 100n,
      fee: 1n,
    },
    privateKeyWithValue(1),
  );
}

/** Returns the element at a position, failing the test if there is none. */
export function elementAt<Element>(elements: readonly Element[], position: number): Element {
  const element = elements[position];
  assert.ok(element !== undefined, `no element at position ${position}`);
  return element;
}

/** Returns a copy of the bytes with the first bit flipped. */
export function flipFirstBit(bytes: Hash): Hash {
  const flippedBytes = Uint8Array.from(bytes);
  flippedBytes[0] = (flippedBytes[0] ?? 0) ^ 0b0000_0001;
  return flippedBytes;
}
