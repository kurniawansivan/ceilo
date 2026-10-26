import { equalBytes } from "@noble/curves/utils.js";

import {
  type Block,
  type BlockInvalidReason,
  checkBlock,
  checkTransactionsRoot,
  tryHashBlockHeader,
} from "./block.ts";
import { type Hash } from "./hash.ts";

/** Why a chain was rejected: any block rule, or one of the two rules about the chain as a whole. */
export type ChainInvalidReason = BlockInvalidReason | "empty-chain" | "genesis-hash-mismatch";

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

/** Checks every block from the genesis block up, naming the first block that breaks a rule. */
export function checkChain(chain: readonly Block[], expectedGenesisHash: Hash): ChainCheck {
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
  const genesisTransactionsCheck = checkTransactionsRoot(genesisBlock);
  if (!genesisTransactionsCheck.valid) {
    return reject(0, genesisTransactionsCheck.reason);
  }

  let parentHeader = genesisBlock.header;
  for (const [offset, block] of chain.slice(1).entries()) {
    const blockCheck = checkBlock(block, parentHeader);
    if (!blockCheck.valid) {
      return reject(offset + 1, blockCheck.reason);
    }
    parentHeader = block.header;
  }
  return { valid: true };
}
