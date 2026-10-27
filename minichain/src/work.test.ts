import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { numberToBytesBE } from "@noble/curves/utils.js";

import { computeWork, hashToInteger, MAXIMUM_NONCE, MAXIMUM_TARGET, meetsTarget } from "./work.ts";

/** Builds the 32-byte hash whose big-endian value is the given integer. */
const hashWithValue = (value: bigint): Uint8Array => numberToBytesBE(value, 32);

describe("limits", () => {
  test("the maximum target is every possible hash value, 2^256 - 1", () => {
    assert.equal(MAXIMUM_TARGET, 2n ** 256n - 1n);
  });

  test("the maximum nonce is 2^64 - 1", () => {
    assert.equal(MAXIMUM_NONCE, 2n ** 64n - 1n);
  });
});

describe("hashToInteger", () => {
  test("reads a hash as one big-endian integer", () => {
    assert.equal(hashToInteger(new Uint8Array(32)), 0n);
    assert.equal(hashToInteger(new Uint8Array(32).fill(0xff)), 2n ** 256n - 1n);
    assert.equal(hashToInteger(hashWithValue(1n)), 1n);
  });

  test("puts the first byte in the most significant place", () => {
    const hash = new Uint8Array(32);
    hash[0] = 1;
    assert.equal(hashToInteger(hash), 2n ** 248n);

    const twoBytes = new Uint8Array(32);
    twoBytes[0] = 0x01;
    twoBytes[1] = 0x02;
    assert.equal(hashToInteger(twoBytes), 0x0102n * 2n ** 240n);
  });

  test("rejects anything that is not 32 bytes", () => {
    assert.throws(() => hashToInteger(new Uint8Array(31)), RangeError);
    assert.throws(() => hashToInteger(new Uint8Array(33)), RangeError);
  });
});

describe("meetsTarget", () => {
  test("accepts a hash exactly equal to the target, and rejects one above it", () => {
    const target = 2n ** 200n;
    assert.equal(meetsTarget(hashWithValue(target), target), true);
    assert.equal(meetsTarget(hashWithValue(target - 1n), target), true);
    assert.equal(meetsTarget(hashWithValue(target + 1n), target), false);
  });

  test("accepts every hash at the maximum target", () => {
    assert.equal(meetsTarget(new Uint8Array(32).fill(0xff), MAXIMUM_TARGET), true);
    assert.equal(meetsTarget(new Uint8Array(32), MAXIMUM_TARGET), true);
  });

  test("accepts only the zero hash at the smallest target", () => {
    assert.equal(meetsTarget(hashWithValue(1n), 1n), true);
    assert.equal(meetsTarget(hashWithValue(2n), 1n), false);
  });

  test("rejects a target outside 1 to the maximum", () => {
    assert.throws(() => meetsTarget(new Uint8Array(32), 0n), RangeError);
    assert.throws(() => meetsTarget(new Uint8Array(32), -1n), RangeError);
    assert.throws(() => meetsTarget(new Uint8Array(32), MAXIMUM_TARGET + 1n), RangeError);
  });
});

describe("computeWork", () => {
  test("is the expected number of hashes needed, 2^256 divided by target + 1", () => {
    assert.equal(computeWork(MAXIMUM_TARGET), 1n);
    assert.equal(computeWork(2n ** 254n - 1n), 4n);
    assert.equal(computeWork(2n ** 252n - 1n), 16n);
    assert.equal(computeWork(1n), 2n ** 255n);
  });

  test("rounds down, so a target just above half the range still counts as one hash", () => {
    assert.equal(computeWork(2n ** 255n), 1n);
  });

  test("grows as the target shrinks", () => {
    const targets = [MAXIMUM_TARGET, 2n ** 200n, 2n ** 100n, 2n ** 50n, 1n];
    const works = targets.map(computeWork);
    for (let index = 1; index < works.length; index++) {
      const previousWork = works[index - 1];
      const work = works[index];
      assert.ok(previousWork !== undefined && work !== undefined);
      assert.ok(work > previousWork, `work did not grow at target ${targets[index]}`);
    }
  });

  test("doubles when the target halves", () => {
    assert.equal(computeWork(2n ** 251n - 1n), 2n * computeWork(2n ** 252n - 1n));
  });

  test("rejects a target outside 1 to the maximum", () => {
    assert.throws(() => computeWork(0n), RangeError);
    assert.throws(() => computeWork(-1n), RangeError);
    assert.throws(() => computeWork(MAXIMUM_TARGET + 1n), RangeError);
  });
});
