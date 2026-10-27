import type { Block } from "./block.ts";
import { MAXIMUM_TRANSACTIONS_PER_BLOCK } from "./block.ts";
import type { BlockTree } from "./blocktree.ts";
import type { Address } from "./keys.ts";
import type { Mempool } from "./mempool.ts";
import { mineBlock } from "./mining.ts";
import { produceBlock } from "./state.ts";

/** What a miner chooses about the next block: who earns it, when it is stamped, how long to search. */
export type BlockAssemblyParameters = {
  readonly beneficiary: Address;
  readonly timestamp: bigint;
  /** How many nonces to try; the mining default if left out. */
  readonly attemptCount?: number;
};

/** Builds and mines the next block on the tree's tip from the best transactions in the pool, if a nonce is found. */
export function assembleBlock(
  tree: BlockTree,
  pool: Mempool,
  parameters: BlockAssemblyParameters,
): Block | undefined {
  const tip = tree.tip;
  const transactions = pool.select(
    tip.state,
    parameters.beneficiary,
    MAXIMUM_TRANSACTIONS_PER_BLOCK,
  );
  const production = produceBlock({
    parentState: tip.state,
    parentHeader: tip.block.header,
    transactions,
    timestamp: parameters.timestamp,
    beneficiary: parameters.beneficiary,
    target: tree.nextTarget(tip.hash),
  });
  if (!production.valid) {
    throw new RangeError(`the pool selected a transaction the chain refuses: ${production.reason}`);
  }
  return mineBlock(production.block, parameters.attemptCount);
}
