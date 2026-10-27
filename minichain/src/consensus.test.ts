import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { BlockHeader } from "./block.ts";
import {
  type ConsensusRules,
  computeExpectedTarget,
  isTimestampNotTooFarAhead,
  validateConsensusRules,
} from "./consensus.ts";
import { createStructuralGenesisBlock } from "./testing.ts";
import { MAXIMUM_TARGET } from "./work.ts";

// A window of 10 blocks and an interval of 10 seconds expect 9 intervals, so 90 seconds.
const RULES: ConsensusRules = {
  targetBlockIntervalInSeconds: 10n,
  retargetWindowInBlocks: 10n,
  maximumTarget: MAXIMUM_TARGET,
  maximumAdjustmentFactor: 4n,
  futureTimeLimitInSeconds: 30n,
};
const EXPECTED_TIMESPAN = 90n;
const STARTING_TARGET = 9_000n;

/** Builds a header at a height with a timestamp and a target, everything else from a genesis header. */
const headerAt = (height: bigint, timestamp: bigint, target: bigint): BlockHeader => ({
  ...createStructuralGenesisBlock(0n).header,
  height,
  timestamp,
  target,
});

/** Builds the headers a retarget looks at: the start of the window and its last block, 9 blocks later. */
const createWindow = (
  secondsBetweenFirstAndLast: bigint,
  target = STARTING_TARGET,
  windowStartHeight = 0n,
): { parent: BlockHeader; lookup: (height: bigint) => BlockHeader | undefined } => {
  const windowStart = headerAt(windowStartHeight, 1_000n, target);
  const parent = headerAt(windowStartHeight + 9n, 1_000n + secondsBetweenFirstAndLast, target);
  const headers = new Map([
    [windowStart.height, windowStart],
    [parent.height, parent],
  ]);
  return { parent, lookup: (height) => headers.get(height) };
};

describe("validateConsensusRules", () => {
  test("accepts sensible rules", () => {
    validateConsensusRules(RULES);
  });

  test("rejects a window of fewer than two blocks, saying so", () => {
    for (const retargetWindowInBlocks of [1n, 0n, -3n]) {
      assert.throws(() => validateConsensusRules({ ...RULES, retargetWindowInBlocks }), {
        name: "RangeError",
        message: /at least 2 blocks/,
      });
    }
  });

  test("rejects an interval or adjustment factor below one", () => {
    assert.throws(
      () => validateConsensusRules({ ...RULES, targetBlockIntervalInSeconds: 0n }),
      RangeError,
    );
    assert.throws(
      () => validateConsensusRules({ ...RULES, maximumAdjustmentFactor: 0n }),
      RangeError,
    );
  });

  test("rejects rules whose smallest allowed timespan would round down to zero", () => {
    assert.throws(
      () =>
        validateConsensusRules({
          ...RULES,
          retargetWindowInBlocks: 2n,
          targetBlockIntervalInSeconds: 1n,
          maximumAdjustmentFactor: 4n,
        }),
      RangeError,
    );
  });

  test("rejects a maximum target outside 1 to 2^256 - 1", () => {
    assert.throws(() => validateConsensusRules({ ...RULES, maximumTarget: 0n }), RangeError);
    assert.throws(
      () => validateConsensusRules({ ...RULES, maximumTarget: MAXIMUM_TARGET + 1n }),
      RangeError,
    );
  });

  test("rejects a negative future time limit", () => {
    assert.throws(
      () => validateConsensusRules({ ...RULES, futureTimeLimitInSeconds: -1n }),
      RangeError,
    );
  });
});

describe("computeExpectedTarget", () => {
  test("keeps the parent's target for every height that is not a multiple of the window", () => {
    for (let parentHeight = 0n; parentHeight < 30n; parentHeight++) {
      if ((parentHeight + 1n) % 10n === 0n) {
        continue;
      }
      const parent = headerAt(parentHeight, 1_000n, 1234n);
      assert.equal(
        computeExpectedTarget(RULES, parent, () => undefined),
        1234n,
        `${parentHeight}`,
      );
    }
  });

  test("keeps the target when the window took exactly the expected time", () => {
    const { parent, lookup } = createWindow(EXPECTED_TIMESPAN);
    assert.equal(computeExpectedTarget(RULES, parent, lookup), STARTING_TARGET);
  });

  test("makes the target smaller, so mining harder, in proportion when blocks came too fast", () => {
    const { parent, lookup } = createWindow(45n);
    assert.equal(computeExpectedTarget(RULES, parent, lookup), 4_500n);
  });

  test("makes the target larger, so mining easier, in proportion when blocks came too slowly", () => {
    const { parent, lookup } = createWindow(180n);
    assert.equal(computeExpectedTarget(RULES, parent, lookup), 18_000n);
  });

  test("rounds down", () => {
    const { parent, lookup } = createWindow(91n, 1_001n);
    assert.equal(computeExpectedTarget(RULES, parent, lookup), (1_001n * 91n) / 90n);
    assert.equal((1_001n * 91n) / 90n, 1_012n);
  });

  test("changes the target by at most the adjustment factor, however fast the blocks came", () => {
    const { parent, lookup } = createWindow(1n);
    assert.equal(computeExpectedTarget(RULES, parent, lookup), (STARTING_TARGET * 22n) / 90n);
    assert.equal(STARTING_TARGET / computeExpectedTarget(RULES, parent, lookup) >= 4n, true);
  });

  test("changes the target by at most the adjustment factor, however slowly the blocks came", () => {
    const { parent, lookup } = createWindow(100_000n);
    assert.equal(computeExpectedTarget(RULES, parent, lookup), STARTING_TARGET * 4n);
  });

  test("treats a window whose last timestamp is not after its first like the fastest one", () => {
    const equal = createWindow(0n);
    const backwards = createWindow(-500n);
    const fastest = createWindow(1n);

    const expected = computeExpectedTarget(RULES, fastest.parent, fastest.lookup);
    assert.equal(computeExpectedTarget(RULES, equal.parent, equal.lookup), expected);
    assert.equal(computeExpectedTarget(RULES, backwards.parent, backwards.lookup), expected);
  });

  test("never goes above the maximum target", () => {
    const rules = { ...RULES, maximumTarget: 10_000n };
    const { parent, lookup } = createWindow(10_000n);
    assert.equal(computeExpectedTarget(rules, parent, lookup), 10_000n);
  });

  test("never goes below a target of 1", () => {
    const { parent, lookup } = createWindow(1n, 1n);
    assert.equal(computeExpectedTarget(RULES, parent, lookup), 1n);
  });

  test("measures the second window from its own first block, not from genesis", () => {
    const { parent, lookup } = createWindow(45n, STARTING_TARGET, 10n);
    assert.equal(computeExpectedTarget(RULES, parent, lookup), 4_500n);
  });

  test("throws when the header at the start of the window is missing", () => {
    const { parent } = createWindow(45n);
    assert.throws(() => computeExpectedTarget(RULES, parent, () => undefined), RangeError);
  });

  test("rejects invalid rules on a window boundary", () => {
    const { parent, lookup } = createWindow(45n);
    assert.throws(
      () => computeExpectedTarget({ ...RULES, retargetWindowInBlocks: 1n }, parent, lookup),
      RangeError,
    );
  });

  test("rejects invalid rules even when the child is not on a window boundary", () => {
    const parent = headerAt(3n, 1_000n, STARTING_TARGET);
    const invalidRules = { ...RULES, futureTimeLimitInSeconds: -1n };
    assert.throws(() => computeExpectedTarget(invalidRules, parent, () => undefined), RangeError);
  });
});

describe("isTimestampNotTooFarAhead", () => {
  test("accepts a timestamp up to the limit ahead of the clock, and no further", () => {
    assert.equal(isTimestampNotTooFarAhead(1_030n, 1_000n, RULES), true);
    assert.equal(isTimestampNotTooFarAhead(1_031n, 1_000n, RULES), false);
  });

  test("accepts any timestamp in the past", () => {
    assert.equal(isTimestampNotTooFarAhead(0n, 1_000n, RULES), true);
    assert.equal(isTimestampNotTooFarAhead(999n, 1_000n, RULES), true);
  });

  test("accepts a timestamp equal to the clock", () => {
    assert.equal(isTimestampNotTooFarAhead(1_000n, 1_000n, RULES), true);
  });

  test("follows the limit in the rules", () => {
    const strictRules = { ...RULES, futureTimeLimitInSeconds: 0n };
    assert.equal(isTimestampNotTooFarAhead(1_000n, 1_000n, strictRules), true);
    assert.equal(isTimestampNotTooFarAhead(1_001n, 1_000n, strictRules), false);
  });
});
