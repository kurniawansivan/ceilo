import assert from "node:assert/strict";

import { type Block, createGenesisBlock } from "./block.ts";
import type { Hash } from "./hash.ts";
import { type Address, deriveAddress, derivePublicKey } from "./keys.ts";
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

/** Returns 32 bytes that stand in for a state root in tests that only look at block structure. */
export function createPlaceholderStateRoot(): Hash {
  return new Uint8Array(32).fill(0xab);
}

/** Builds a genesis block with a placeholder state root, for tests of block structure. */
export function createStructuralGenesisBlock(timestamp: bigint): Block {
  return createGenesisBlock({ timestamp, stateRoot: createPlaceholderStateRoot() });
}

/** Derives the address of the account whose private key is a small integer. */
export function addressOfAccount(accountNumber: number): Address {
  return deriveAddress(derivePublicKey(privateKeyWithValue(accountNumber)));
}

/** Describes a transfer between two accounts, each named by its private key's small integer. */
export type TransferParameters = {
  readonly from: number;
  readonly to: number;
  readonly amount: bigint;
  readonly fee: bigint;
  readonly nonce: bigint;
  readonly chainIdentifier?: bigint;
};

/** Signs a transfer as the sender, on chain 1337 unless the parameters name another chain. */
export function signTransfer(parameters: TransferParameters): SignedTransaction {
  return signTransaction(
    {
      chainIdentifier: parameters.chainIdentifier ?? 1337n,
      nonce: parameters.nonce,
      recipient: addressOfAccount(parameters.to),
      amount: parameters.amount,
      fee: parameters.fee,
    },
    privateKeyWithValue(parameters.from),
  );
}

/** Creates a deterministic pseudo-random generator (mulberry32) that returns floats in [0, 1). */
export function createSeededRandom(seed: number): () => number {
  let generatorState = seed >>> 0;
  return function nextRandomNumber(): number {
    generatorState = (generatorState + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(generatorState ^ (generatorState >>> 15), 1 | generatorState);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
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
