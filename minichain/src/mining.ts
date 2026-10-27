import { type Block, type BlockHeader, hashBlockHeader } from "./block.ts";
import { MAXIMUM_NONCE, meetsTarget } from "./work.ts";

const DEFAULT_ATTEMPT_COUNT = 1_000_000;

/** Tries nonces upward from a first one and returns the first that meets the header's target, if any. */
export function findNonce(
  header: BlockHeader,
  firstNonce: bigint,
  attemptCount: number,
): bigint | undefined {
  if (firstNonce < 0n || firstNonce > MAXIMUM_NONCE) {
    throw new RangeError("first nonce is out of range");
  }
  for (let attempt = 0; attempt < attemptCount; attempt++) {
    const nonce = firstNonce + BigInt(attempt);
    if (nonce > MAXIMUM_NONCE) {
      return undefined;
    }
    if (meetsTarget(hashBlockHeader({ ...header, nonce }), header.target)) {
      return nonce;
    }
  }
  return undefined;
}

/** Returns a copy of the block with the first winning nonce in its header, or undefined if none is found. */
export function mineBlock(
  block: Block,
  attemptCount: number = DEFAULT_ATTEMPT_COUNT,
): Block | undefined {
  const nonce = findNonce(block.header, 0n, attemptCount);
  if (nonce === undefined) {
    return undefined;
  }
  return { ...block, header: { ...block.header, nonce } };
}
