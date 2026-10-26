import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { encode } from "./encoding.ts";
import { fromHexadecimal, HASH_LENGTH, hashBytes, hashOf, toHexadecimal } from "./hash.ts";

const KECCAK256_OF_EMPTY_TEXT =
  "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470";
const KECCAK256_OF_ABC = "0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45";
const SHA3_256_OF_EMPTY_TEXT = "0xa7ffc6f8bf1ed76651c14756a061d662f580ff4de43b49fa82d80a4b80f8434a";

/** Converts text to its UTF-8 bytes. */
const textToBytes = (text: string): Uint8Array => new TextEncoder().encode(text);

/** Counts the bit positions where two equally long byte arrays differ. */
const countDifferingBits = (left: Uint8Array, right: Uint8Array): number => {
  let differingBitCount = 0;
  for (let byteIndex = 0; byteIndex < left.length; byteIndex++) {
    let difference = (left[byteIndex] ?? 0) ^ (right[byteIndex] ?? 0);
    while (difference !== 0) {
      differingBitCount += difference & 1;
      difference >>= 1;
    }
  }
  return differingBitCount;
};

describe("hashBytes", () => {
  test("matches the published keccak-256 vectors", () => {
    assert.equal(toHexadecimal(hashBytes(textToBytes(""))), KECCAK256_OF_EMPTY_TEXT);
    assert.equal(toHexadecimal(hashBytes(textToBytes("abc"))), KECCAK256_OF_ABC);
  });

  test("is keccak-256 as Ethereum uses it, not the standardised SHA3-256", () => {
    assert.notEqual(toHexadecimal(hashBytes(textToBytes(""))), SHA3_256_OF_EMPTY_TEXT);
  });

  test("always returns HASH_LENGTH bytes", () => {
    assert.equal(HASH_LENGTH, 32);
    assert.equal(hashBytes(textToBytes("")).length, HASH_LENGTH);
    assert.equal(hashBytes(new Uint8Array(10_000)).length, HASH_LENGTH);
  });

  test("avalanche: flipping one input bit changes about half the output bits", () => {
    const original = textToBytes("ceilo minichain");
    const flipped = Uint8Array.from(original);
    flipped[0] = (flipped[0] ?? 0) ^ 0b0000_0001;

    const differingBitCount = countDifferingBits(hashBytes(original), hashBytes(flipped));
    // 256 output bits: expect about 128, with a standard deviation of 8.
    assert.ok(
      differingBitCount > 64 && differingBitCount < 192,
      `differing bits: ${differingBitCount}`,
    );
  });
});

describe("hashOf", () => {
  test("hashes the canonical encoding of a value", () => {
    const value = ["transaction", 7n, textToBytes("payload")] as const;
    assert.deepEqual(hashOf(value), hashBytes(encode(value)));
  });

  test("is not fooled by shifting a field boundary", () => {
    assert.notDeepEqual(hashOf(["ab", "c"]), hashOf(["a", "bc"]));
  });
});

describe("toHexadecimal and fromHexadecimal", () => {
  test("round-trip with a 0x prefix", () => {
    const original = Uint8Array.from([0x00, 0x0f, 0xf0, 0xff]);
    assert.equal(toHexadecimal(original), "0x000ff0ff");
    assert.deepEqual(fromHexadecimal("0x000ff0ff"), original);
  });

  test("fromHexadecimal rejects input without a 0x prefix", () => {
    assert.throws(() => fromHexadecimal("000ff0ff"), TypeError);
  });

  test("fromHexadecimal rejects odd length and non-hexadecimal characters", () => {
    assert.throws(() => fromHexadecimal("0xabc"));
    assert.throws(() => fromHexadecimal("0xzz"));
  });
});
