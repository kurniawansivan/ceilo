import { equalBytes } from "@noble/curves/utils.js";

import {
  type Block,
  type BlockInvalidReason,
  checkBlock,
  checkTransactionsRoot,
  tryHashBlockHeader,
} from "./block.ts";
import { type ConsensusRules, computeExpectedTarget, validateConsensusRules } from "./consensus.ts";
import type { Hash } from "./hash.ts";
import {
  applyBlock,
  type ChainState,
  computeStateRoot,
  type TransactionRejection,
} from "./state.ts";

/** Why a chain was rejected: any block rule, or one of the two rules about the chain as a whole. */
export type ChainInvalidReason =
  | BlockInvalidReason
  | "empty-chain"
  | "genesis-hash-mismatch"
  | "genesis-target-too-easy";

/** Why a replay failed: a structural fault, a bad transaction, or a state root that is not the result. */
export type ChainReplayReason = ChainInvalidReason | TransactionRejection | "state-root-mismatch";

/** The outcome of replaying a chain: the state it ends in, or the first bad block and why. */
export type ChainReplay =
  | { readonly valid: true; readonly state: ChainState }
  | {
      readonly valid: false;
      readonly blockIndex: number;
      readonly reason: ChainReplayReason;
    };

/** The outcome of checking a chain: valid, or the first bad block and the reason it was rejected. */
export type ChainCheck =
  | { readonly valid: true }
  | {
      readonly valid: false;
      readonly blockIndex: number;
      readonly reason: ChainInvalidReason;
    };

/** Builds the result for a chain that broke a rule at a block. */
function reject(blockIndex: number, reason: ChainInvalidReason): ChainCheck {
  return { valid: false, blockIndex, reason };
}

/** Checks every block from the genesis block up under the rules, naming the first block that breaks one. */
export function checkChain(
  chain: readonly Block[],
  expectedGenesisHash: Hash,
  rules: ConsensusRules,
): ChainCheck {
  validateConsensusRules(rules);
  const [genesisBlock] = chain;
  if (genesisBlock === undefined) {
    return reject(0, "empty-chain");
  }

  const genesisHash = tryHashBlockHeader(genesisBlock.header);
  if (genesisHash === undefined) {
    return reject(0, "malformed-header");
  }
  if (!equalBytes(genesisHash, expectedGenesisHash)) {
    return reject(0, "genesis-hash-mismatch");
  }
  if (genesisBlock.header.target > rules.maximumTarget) {
    return reject(0, "genesis-target-too-easy");
  }
  const genesisTransactionsCheck = checkTransactionsRoot(genesisBlock);
  if (!genesisTransactionsCheck.valid) {
    return reject(0, genesisTransactionsCheck.reason);
  }

  let parentHeader = genesisBlock.header;
  for (const [offset, block] of chain.slice(1).entries()) {
    const expectedTarget = computeExpectedTarget(
      rules,
      parentHeader,
      (height) => chain[Number(height)]?.header,
    );
    const blockCheck = checkBlock(block, parentHeader, expectedTarget);
    if (!blockCheck.valid) {
      return reject(offset + 1, blockCheck.reason);
    }
    parentHeader = block.header;
  }
  return { valid: true };
}

/** Checks a chain's structure, then replays every block after genesis, checking each state root. */
export function replayChain(
  chain: readonly Block[],
  expectedGenesisHash: Hash,
  genesisState: ChainState,
  rules: ConsensusRules,
): ChainReplay {
  const structure = checkChain(chain, expectedGenesisHash, rules);
  if (!structure.valid) {
    return structure;
  }

  let state = genesisState;
  for (const [blockIndex, block] of chain.entries()) {
    if (blockIndex === 0) {
      // Genesis is defined, not applied: it pays no reward, and must commit to the state it starts from.
      if (!equalBytes(computeStateRoot(genesisState), block.header.stateRoot)) {
        return { valid: false, blockIndex, reason: "state-root-mismatch" };
      }
      continue;
    }
    const applied = applyBlock(state, block);
    if (!applied.valid) {
      return { valid: false, blockIndex, reason: applied.reason };
    }
    state = applied.state;
  }
  return { valid: true, state };
}
