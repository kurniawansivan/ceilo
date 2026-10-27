import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  type Block,
  type BlockHeader,
  createBlock,
  createGenesisBlock,
  hashBlockHeader,
} from "./block.ts";
import { findNonce, mineBlock } from "./mining.ts";
import { addressOfAccount, createPlaceholderStateRoot } from "./testing.ts";
import { MAXIMUM_NONCE, MAXIMUM_TARGET, meetsTarget } from "./work.ts";

const EASY_TARGET = 2n ** 252n - 1n;

/** Builds a block on a genesis block with the given target; its nonce is not yet mined. */
const createUnminedBlock = (target: bigint, timestamp = 1_010n): Block => {
  const genesis = createGenesisBlock({
    timestamp: 1_000n,
    stateRoot: createPlaceholderStateRoot(),
    target,
  });
  return createBlock({
    parentHeader: genesis.header,
    transactions: [],
    timestamp,
    beneficiary: addressOfAccount(3),
    stateRoot: createPlaceholderStateRoot(),
  });
};

/** Tells whether a header, given a nonce, meets its own target. */
const meetsOwnTarget = (header: BlockHeader, nonce: bigint): boolean =>
  meetsTarget(hashBlockHeader({ ...header, nonce }), header.target);

describe("findNonce", () => {
  test("returns the first nonce whose header meets the target, and no earlier one does", () => {
    const { header } = createUnminedBlock(EASY_TARGET);
    const nonce = findNonce(header, 0n, 10_000);

    assert.ok(nonce !== undefined);
    assert.equal(meetsOwnTarget(header, nonce), true);
    for (let earlier = 0n; earlier < nonce; earlier++) {
      assert.equal(meetsOwnTarget(header, earlier), false, `nonce ${earlier} already worked`);
    }
  });

  test("is deterministic: the same header gives the same nonce", () => {
    const { header } = createUnminedBlock(EASY_TARGET);
    assert.equal(findNonce(header, 0n, 10_000), findNonce(header, 0n, 10_000));
  });

  test("starts searching at the first nonce it is given", () => {
    const { header } = createUnminedBlock(EASY_TARGET);
    const solution = findNonce(header, 0n, 10_000);
    assert.ok(solution !== undefined);

    assert.equal(findNonce(header, solution, 10_000), solution);
    const later = findNonce(header, solution + 1n, 10_000);
    assert.ok(later !== undefined && later > solution);
    assert.equal(meetsOwnTarget(header, later), true);
  });

  test("gives up when the attempt budget runs out, and not one attempt sooner", () => {
    const { header } = createUnminedBlock(EASY_TARGET);
    const solution = findNonce(header, 0n, 10_000);
    assert.ok(solution !== undefined);

    assert.equal(findNonce(header, 0n, Number(solution) + 1), solution);
    assert.equal(findNonce(header, 0n, Number(solution)), undefined);
    assert.equal(findNonce(header, 0n, 0), undefined);
  });

  test("finds nothing for a target no nonce in a small budget can meet", () => {
    const { header } = createUnminedBlock(1n);
    assert.equal(findNonce(header, 0n, 500), undefined);
  });

  test("accepts the very first nonce at the maximum target", () => {
    const { header } = createUnminedBlock(MAXIMUM_TARGET);
    assert.equal(findNonce(header, 0n, 1), 0n);
  });

  test("stops at the largest nonce instead of running past it", () => {
    const hardHeader = createUnminedBlock(1n).header;
    assert.equal(findNonce(hardHeader, MAXIMUM_NONCE - 2n, 100), undefined);

    const easyHeader = createUnminedBlock(MAXIMUM_TARGET).header;
    assert.equal(findNonce(easyHeader, MAXIMUM_NONCE, 100), MAXIMUM_NONCE);
  });

  test("rejects a first nonce outside the allowed range", () => {
    const { header } = createUnminedBlock(EASY_TARGET);
    assert.throws(() => findNonce(header, -1n, 10), RangeError);
    assert.throws(() => findNonce(header, MAXIMUM_NONCE + 1n, 10), RangeError);
  });

  test("takes about twice as many attempts each time the target halves", () => {
    /** Averages the attempts needed over many headers that differ only in their timestamp. */
    const averageAttempts = (target: bigint): number => {
      let totalAttempts = 0;
      const headerCount = 200;
      for (let offset = 0; offset < headerCount; offset++) {
        const { header } = createUnminedBlock(target, 1_010n + BigInt(offset));
        const nonce = findNonce(header, 0n, 100_000);
        assert.ok(nonce !== undefined);
        totalAttempts += Number(nonce) + 1;
      }
      return totalAttempts / headerCount;
    };

    const easyAverage = averageAttempts(2n ** 252n - 1n);
    const hardAverage = averageAttempts(2n ** 250n - 1n);
    // The expected averages are 16 and 64, a ratio of 4.
    assert.ok(easyAverage > 8 && easyAverage < 32, `easy average ${easyAverage}`);
    assert.ok(hardAverage / easyAverage > 2 && hardAverage / easyAverage < 8);
  });
});

describe("mineBlock", () => {
  test("returns the block with the winning nonce in its header and nothing else changed", () => {
    const block = createUnminedBlock(EASY_TARGET);
    const mined = mineBlock(block, 10_000);

    assert.ok(mined !== undefined);
    assert.equal(mined.header.nonce, findNonce(block.header, 0n, 10_000));
    assert.equal(meetsTarget(hashBlockHeader(mined.header), mined.header.target), true);
    assert.deepEqual({ ...mined.header, nonce: 0n }, { ...block.header, nonce: 0n });
    assert.deepEqual(mined.transactions, block.transactions);
  });

  test("leaves the block it was given untouched", () => {
    const block = createUnminedBlock(EASY_TARGET);
    const nonceBefore = block.header.nonce;
    mineBlock(block, 10_000);
    assert.equal(block.header.nonce, nonceBefore);
  });

  test("returns undefined when the attempt budget is too small", () => {
    assert.equal(mineBlock(createUnminedBlock(1n), 200), undefined);
  });
});
