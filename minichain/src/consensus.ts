import type { BlockHeader } from "./block.ts";
import { MAXIMUM_TARGET } from "./work.ts";

/** The numbers a chain's difficulty and clock rules are built from. */
export type ConsensusRules = {
  /** How many seconds one block should take on average. */
  readonly targetBlockIntervalInSeconds: bigint;
  /** The difficulty is adjusted once every this many blocks. */
  readonly retargetWindowInBlocks: bigint;
  /** The easiest target a block may ever have; the target never rises above it. */
  readonly maximumTarget: bigint;
  /** One adjustment may make mining at most this many times harder or easier. */
  readonly maximumAdjustmentFactor: bigint;
  /** How far ahead of a node's clock a block's timestamp may be. */
  readonly futureTimeLimitInSeconds: bigint;
};

/** Finds a header on the chain being checked by its height, if the chain has one. */
export type HeaderLookup = (height: bigint) => BlockHeader | undefined;

/** Clamps a value to the range from a lower to an upper bound. */
function clamp(value: bigint, lowerBound: bigint, upperBound: bigint): bigint {
  if (value < lowerBound) {
    return lowerBound;
  }
  return value > upperBound ? upperBound : value;
}

/** Computes the time one retarget window should take: its intervals times the target interval. */
function computeExpectedTimespan(rules: ConsensusRules): bigint {
  return (rules.retargetWindowInBlocks - 1n) * rules.targetBlockIntervalInSeconds;
}

/** Throws a RangeError unless every rule has a value the others can be computed from. */
export function validateConsensusRules(rules: ConsensusRules): void {
  if (rules.retargetWindowInBlocks < 2n) {
    throw new RangeError("the retarget window must be at least 2 blocks");
  }
  if (rules.targetBlockIntervalInSeconds < 1n) {
    throw new RangeError("the target block interval must be at least 1 second");
  }
  if (rules.maximumAdjustmentFactor < 1n) {
    throw new RangeError("the maximum adjustment factor must be at least 1");
  }
  if (computeExpectedTimespan(rules) / rules.maximumAdjustmentFactor < 1n) {
    throw new RangeError("the smallest allowed timespan would round down to zero");
  }
  if (rules.maximumTarget < 1n || rules.maximumTarget > MAXIMUM_TARGET) {
    throw new RangeError("the maximum target must be between 1 and 2^256 - 1");
  }
  if (rules.futureTimeLimitInSeconds < 0n) {
    throw new RangeError("the future time limit cannot be negative");
  }
}

/** Computes the target a child must have: its parent's, except on a window boundary, where it scales by speed. */
export function computeExpectedTarget(
  rules: ConsensusRules,
  parentHeader: BlockHeader,
  headerAtHeight: HeaderLookup,
): bigint {
  validateConsensusRules(rules);
  const childHeight = parentHeader.height + 1n;
  if (childHeight % rules.retargetWindowInBlocks !== 0n) {
    return parentHeader.target;
  }

  const windowStart = headerAtHeight(childHeight - rules.retargetWindowInBlocks);
  if (windowStart === undefined) {
    throw new RangeError("the header at the start of the retarget window is missing");
  }
  const expectedTimespan = computeExpectedTimespan(rules);
  const measuredTimespan = parentHeader.timestamp - windowStart.timestamp;
  const actualTimespan = clamp(
    measuredTimespan,
    expectedTimespan / rules.maximumAdjustmentFactor,
    expectedTimespan * rules.maximumAdjustmentFactor,
  );
  const adjustedTarget = (parentHeader.target * actualTimespan) / expectedTimespan;
  return clamp(adjustedTarget, 1n, rules.maximumTarget);
}

/** Tells whether a timestamp is no further ahead of a node's clock than the rules allow. */
export function isTimestampNotTooFarAhead(
  timestamp: bigint,
  currentTime: bigint,
  rules: ConsensusRules,
): boolean {
  return timestamp <= currentTime + rules.futureTimeLimitInSeconds;
}
