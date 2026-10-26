import { equalBytes } from "@noble/curves/utils.js";

import { tryCompute } from "./attempt.ts";
import { HASH_LENGTH, type Hash, hashOf } from "./hash.ts";
import { ADDRESS_LENGTH, type Address } from "./keys.ts";
import { computeMerkleRoot } from "./merkle.ts";
import { hashSignedTransaction, type SignedTransaction } from "./transaction.ts";
import { MAXIMUM_NONCE, MAXIMUM_TARGET, meetsTarget } from "./work.ts";

const BLOCK_HEADER_DOMAIN = "ceilo/block-header";

/** Where a block sits, what it links to, what it contains, the state it leaves and who earns its fees. */
export type BlockHeader = {
  readonly height: bigint;
  readonly previousBlockHash: Hash;
  readonly transactionsRoot: Hash;
  /** Merkle root of the whole chain state after this block's transactions. */
  readonly stateRoot: Hash;
  /** Seconds since the Unix epoch. */
  readonly timestamp: bigint;
  readonly beneficiary: Address;
  /** The block's hash, read as an integer, must be at or below this. A smaller target means more work. */
  readonly target: bigint;
  /** A number the miner varies until the header's hash meets the target. */
  readonly nonce: bigint;
};

/** A header plus the transactions that its Merkle root commits to. */
export type Block = {
  readonly header: BlockHeader;
  readonly transactions: readonly SignedTransaction[];
};

/** The first rule a block breaks, in the order the rules are checked. */
export type BlockInvalidReason =
  | "malformed-header"
  | "unexpected-height"
  | "previous-hash-mismatch"
  | "timestamp-not-increasing"
  | "target-mismatch"
  | "insufficient-work"
  | "malformed-transaction"
  | "transactions-root-mismatch";

/** The outcome of checking a block: valid, or the reason it was rejected. */
export type BlockCheck =
  | { readonly valid: true }
  | { readonly valid: false; readonly reason: BlockInvalidReason };

/** Everything needed to build the next block on top of a parent. */
export type NewBlockParameters = {
  readonly parentHeader: BlockHeader;
  readonly transactions: readonly SignedTransaction[];
  readonly timestamp: bigint;
  readonly beneficiary: Address;
  readonly stateRoot: Hash;
  /** The target to meet; the parent's target if left out. */
  readonly target?: bigint;
  /** The nonce to start with; zero, meaning not yet mined, if left out. */
  readonly nonce?: bigint;
};

/** Everything needed to build the first block of a chain. */
export type GenesisBlockParameters = {
  readonly timestamp: bigint;
  readonly stateRoot: Hash;
  readonly target: bigint;
};

/** Builds the result for a block that broke a rule. */
function reject(reason: BlockInvalidReason): BlockCheck {
  return { valid: false, reason };
}

/** Throws unless the bytes are exactly the expected length. */
function assertByteLength(bytes: Uint8Array, expectedLength: number, name: string): void {
  if (bytes.length !== expectedLength) {
    throw new RangeError(`${name} must be ${expectedLength} bytes`);
  }
}

/** Hashes every header field under a domain tag; this hash is the block's identity. */
export function hashBlockHeader(header: BlockHeader): Hash {
  assertByteLength(header.previousBlockHash, HASH_LENGTH, "previous block hash");
  assertByteLength(header.transactionsRoot, HASH_LENGTH, "transactions root");
  assertByteLength(header.stateRoot, HASH_LENGTH, "state root");
  assertByteLength(header.beneficiary, ADDRESS_LENGTH, "beneficiary");
  if (header.target < 1n || header.target > MAXIMUM_TARGET) {
    throw new RangeError("target must be between 1 and 2^256 - 1");
  }
  if (header.nonce < 0n || header.nonce > MAXIMUM_NONCE) {
    throw new RangeError("nonce must be between 0 and 2^64 - 1");
  }
  return hashOf([
    BLOCK_HEADER_DOMAIN,
    header.height,
    header.previousBlockHash,
    header.transactionsRoot,
    header.stateRoot,
    header.timestamp,
    header.beneficiary,
    header.target,
    header.nonce,
  ]);
}

/** Hashes a header, returning undefined instead of throwing when the header is malformed. */
export function tryHashBlockHeader(header: BlockHeader): Hash | undefined {
  return tryCompute(() => hashBlockHeader(header));
}

/** Computes the Merkle root over the hashes of the signed transactions, in order. */
export function computeTransactionsRoot(transactions: readonly SignedTransaction[]): Hash {
  return computeMerkleRoot(transactions.map((transaction) => hashSignedTransaction(transaction)));
}

/** Creates the first block: height 0, no parent, no transactions, no beneficiary, with its state root and target. */
export function createGenesisBlock(parameters: GenesisBlockParameters): Block {
  return {
    header: {
      height: 0n,
      previousBlockHash: new Uint8Array(HASH_LENGTH),
      transactionsRoot: computeTransactionsRoot([]),
      stateRoot: parameters.stateRoot,
      timestamp: parameters.timestamp,
      beneficiary: new Uint8Array(ADDRESS_LENGTH),
      target: parameters.target,
      nonce: 0n,
    },
    transactions: [],
  };
}

/** Creates the next block, linked to its parent and committing to its transactions and state, not yet mined. */
export function createBlock(parameters: NewBlockParameters): Block {
  return {
    header: {
      height: parameters.parentHeader.height + 1n,
      previousBlockHash: hashBlockHeader(parameters.parentHeader),
      transactionsRoot: computeTransactionsRoot(parameters.transactions),
      stateRoot: parameters.stateRoot,
      timestamp: parameters.timestamp,
      beneficiary: parameters.beneficiary,
      target: parameters.target ?? parameters.parentHeader.target,
      nonce: parameters.nonce ?? 0n,
    },
    transactions: parameters.transactions,
  };
}

/** Checks that a block's transactions are the ones its header's Merkle root commits to. */
export function checkTransactionsRoot(block: Block): BlockCheck {
  const computedRoot = tryCompute(() => computeTransactionsRoot(block.transactions));
  if (computedRoot === undefined) {
    return reject("malformed-transaction");
  }
  if (!equalBytes(computedRoot, block.header.transactionsRoot)) {
    return reject("transactions-root-mismatch");
  }
  return { valid: true };
}

/** Checks a block against its parent, reporting the first rule it breaks. */
export function checkBlock(block: Block, parentHeader: BlockHeader): BlockCheck {
  const { header } = block;
  const headerHash = tryHashBlockHeader(header);
  if (headerHash === undefined) {
    return reject("malformed-header");
  }
  if (header.height !== parentHeader.height + 1n) {
    return reject("unexpected-height");
  }
  if (!equalBytes(header.previousBlockHash, hashBlockHeader(parentHeader))) {
    return reject("previous-hash-mismatch");
  }
  if (header.timestamp <= parentHeader.timestamp) {
    return reject("timestamp-not-increasing");
  }
  if (header.target !== parentHeader.target) {
    return reject("target-mismatch");
  }
  // Checked before the transactions, so a block with no real work behind it is cheap to refuse.
  if (!meetsTarget(headerHash, header.target)) {
    return reject("insufficient-work");
  }
  return checkTransactionsRoot(block);
}
