import { equalBytes } from "@noble/curves/utils.js";

import {
  type Block,
  type BlockHeader,
  type BlockInvalidReason,
  checkBlock,
  hashBlockHeader,
  tryHashBlockHeader,
} from "./block.ts";
import { type ConsensusRules, computeExpectedTarget, validateConsensusRules } from "./consensus.ts";
import { type Hash, toHexadecimal } from "./hash.ts";
import {
  applyBlock,
  type ChainState,
  computeStateRoot,
  type Genesis,
  type TransactionRejection,
} from "./state.ts";
import { computeWork } from "./work.ts";

const DEFAULT_MAXIMUM_ORPHAN_COUNT = 100;

/** A block the tree holds, with its hash, the work behind it and the state it leaves. */
export type StoredBlock = {
  readonly block: Block;
  readonly hash: Hash;
  /** The work of this block and every block back to genesis. */
  readonly cumulativeWork: bigint;
  readonly state: ChainState;
};

/** Why a block was refused: a broken block rule, a bad transaction or a wrong state root. */
export type BlockRejection = BlockInvalidReason | TransactionRejection | "state-root-mismatch";

/** How the best chain changed: not at all, by growing, or by switching to another branch. */
export type TipChange =
  | { readonly kind: "unchanged" }
  | { readonly kind: "extended"; readonly attached: readonly Block[] }
  | {
      readonly kind: "reorganized";
      readonly detached: readonly Block[];
      readonly attached: readonly Block[];
    };

/** What happened to a block offered to the tree. */
export type AddBlockOutcome =
  | { readonly status: "added"; readonly tipChange: TipChange }
  | { readonly status: "known" }
  | { readonly status: "orphan" }
  | { readonly status: "rejected"; readonly reason: BlockRejection };

/** Turns a hash into the text key the tree stores it under. */
function keyOf(hash: Hash): string {
  return toHexadecimal(hash);
}

/** Every valid block a node has seen, on every branch, and the branch it currently follows. */
export class BlockTree {
  readonly #rules: ConsensusRules;
  readonly #maximumOrphanCount: number;
  readonly #stored = new Map<string, StoredBlock>();
  readonly #orphans = new Map<string, Block>();
  #tipKey: string;

  /** Starts a tree at a genesis block, throwing if the genesis, the rules or the orphan limit are unusable. */
  constructor(
    genesis: Genesis,
    rules: ConsensusRules,
    maximumOrphanCount: number = DEFAULT_MAXIMUM_ORPHAN_COUNT,
  ) {
    validateConsensusRules(rules);
    if (!Number.isInteger(maximumOrphanCount) || maximumOrphanCount < 0) {
      throw new RangeError("the orphan limit must be a whole number, zero or more");
    }
    const { header } = genesis.block;
    if (header.target > rules.maximumTarget) {
      throw new RangeError("the genesis target is easier than the rules allow");
    }
    if (!equalBytes(computeStateRoot(genesis.state), header.stateRoot)) {
      throw new RangeError("the genesis state is not the one its header commits to");
    }

    const hash = hashBlockHeader(header);
    this.#rules = rules;
    this.#maximumOrphanCount = maximumOrphanCount;
    this.#tipKey = keyOf(hash);
    this.#stored.set(this.#tipKey, {
      block: genesis.block,
      hash,
      cumulativeWork: computeWork(header.target),
      state: genesis.state,
    });
  }

  /** The tip of the branch with the most work, which is the chain the node follows. */
  get tip(): StoredBlock {
    return this.#require(this.#tipKey);
  }

  /** How many blocks are waiting for a parent that has not arrived. */
  get orphanCount(): number {
    return this.#orphans.size;
  }

  /** Tells whether a block with this hash is in the tree; orphans do not count. */
  has(hash: Hash): boolean {
    return this.#stored.has(keyOf(hash));
  }

  /** Returns the stored block with this hash, if the tree holds it. */
  get(hash: Hash): StoredBlock | undefined {
    return this.#stored.get(keyOf(hash));
  }

  /** Computes the target the child of a stored block must have, along that block's own branch. */
  nextTarget(parentHash: Hash): bigint {
    const parent = this.get(parentHash);
    if (parent === undefined) {
      throw new RangeError("the parent is not in the tree");
    }
    return computeExpectedTarget(this.#rules, parent.block.header, (height) =>
      this.#headerOnBranch(parent, height),
    );
  }

  /** Lists the blocks from genesis to a stored block, throwing if the tree does not hold it. */
  chainTo(hash: Hash): StoredBlock[] {
    let current: StoredBlock | undefined = this.get(hash);
    if (current === undefined) {
      throw new RangeError("the block is not in the tree");
    }
    const path: StoredBlock[] = [];
    while (current !== undefined) {
      path.push(current);
      current = this.#parentOf(current);
    }
    return path.reverse();
  }

  /** Lists the blocks from genesis to the tip. */
  bestChain(): StoredBlock[] {
    return this.chainTo(this.tip.hash);
  }

  /** Offers a block: it is added if valid and its parent is known, or kept aside until its parent arrives. */
  addBlock(block: Block): AddBlockOutcome {
    const hash = tryHashBlockHeader(block.header);
    if (hash === undefined) {
      return { status: "rejected", reason: "malformed-header" };
    }
    const key = keyOf(hash);
    if (this.#stored.has(key)) {
      return { status: "known" };
    }
    const parentKey = keyOf(block.header.previousBlockHash);
    if (!this.#stored.has(parentKey)) {
      this.#keepAsOrphan(block, key);
      return { status: "orphan" };
    }

    const tipBefore = this.#tipKey;
    const reason = this.#connect(block, hash, key);
    if (reason !== undefined) {
      return { status: "rejected", reason };
    }
    this.#connectOrphansOf(key);
    return { status: "added", tipChange: this.#describeTipChange(tipBefore) };
  }

  /** Returns a stored block by key, throwing if it is missing, which would mean the tree is broken. */
  #require(key: string): StoredBlock {
    const stored = this.#stored.get(key);
    if (stored === undefined) {
      throw new RangeError("the tree is missing a block it should hold");
    }
    return stored;
  }

  /** Finds the stored parent of a stored block; the genesis block has none. */
  #parentOf(stored: StoredBlock): StoredBlock | undefined {
    return this.#stored.get(keyOf(stored.block.header.previousBlockHash));
  }

  /** Walks back from a block to the header at a height on the same branch, if there is one. */
  #headerOnBranch(branchTip: StoredBlock, height: bigint): BlockHeader | undefined {
    let current: StoredBlock | undefined = branchTip;
    while (current !== undefined && current.block.header.height > height) {
      current = this.#parentOf(current);
    }
    return current?.block.header.height === height ? current.block.header : undefined;
  }

  /** Validates a block whose parent is stored and stores it, returning why not if it is invalid. */
  #connect(block: Block, hash: Hash, key: string): BlockRejection | undefined {
    const parent = this.#require(keyOf(block.header.previousBlockHash));
    const expectedTarget = computeExpectedTarget(this.#rules, parent.block.header, (height) =>
      this.#headerOnBranch(parent, height),
    );
    const check = checkBlock(block, parent.block.header, expectedTarget);
    if (!check.valid) {
      return check.reason;
    }
    const applied = applyBlock(parent.state, block);
    if (!applied.valid) {
      return applied.reason;
    }

    const stored: StoredBlock = {
      block,
      hash,
      cumulativeWork: parent.cumulativeWork + computeWork(block.header.target),
      state: applied.state,
    };
    this.#stored.set(key, stored);
    if (stored.cumulativeWork > this.tip.cumulativeWork) {
      this.#tipKey = key;
    }
    return undefined;
  }

  /** Holds a block until its parent arrives, dropping the oldest orphan when over the limit. */
  #keepAsOrphan(block: Block, key: string): void {
    this.#orphans.set(key, block);
    if (this.#orphans.size > this.#maximumOrphanCount) {
      // A Map iterates in insertion order, so its first key is the oldest orphan.
      for (const oldestKey of this.#orphans.keys()) {
        this.#orphans.delete(oldestKey);
        break;
      }
    }
  }

  /** Connects every orphan that was waiting for a newly stored block, and then theirs in turn. */
  #connectOrphansOf(storedKey: string): void {
    const parentKeys = [storedKey];
    for (let index = 0; index < parentKeys.length; index++) {
      const parentKey = parentKeys[index];
      for (const [orphanKey, orphan] of [...this.#orphans.entries()]) {
        if (keyOf(orphan.header.previousBlockHash) !== parentKey) {
          continue;
        }
        this.#orphans.delete(orphanKey);
        if (this.#connect(orphan, hashBlockHeader(orphan.header), orphanKey) === undefined) {
          parentKeys.push(orphanKey);
        }
      }
    }
  }

  /** Describes how the tip moved from a previous tip: blocks undone, then blocks applied, oldest first. */
  #describeTipChange(previousTipKey: string): TipChange {
    if (this.#tipKey === previousTipKey) {
      return { kind: "unchanged" };
    }
    let previousCursor = this.#require(previousTipKey);
    let newCursor = this.tip;
    const detached: Block[] = [];
    const attached: Block[] = [];

    while (previousCursor.block.header.height > newCursor.block.header.height) {
      detached.push(previousCursor.block);
      previousCursor = this.#requireParent(previousCursor);
    }
    while (newCursor.block.header.height > previousCursor.block.header.height) {
      attached.push(newCursor.block);
      newCursor = this.#requireParent(newCursor);
    }
    while (keyOf(previousCursor.hash) !== keyOf(newCursor.hash)) {
      detached.push(previousCursor.block);
      attached.push(newCursor.block);
      previousCursor = this.#requireParent(previousCursor);
      newCursor = this.#requireParent(newCursor);
    }

    attached.reverse();
    if (detached.length === 0) {
      return { kind: "extended", attached };
    }
    return { kind: "reorganized", detached: detached.reverse(), attached };
  }

  /** Finds the stored parent of a block that must have one, throwing if the tree is broken. */
  #requireParent(stored: StoredBlock): StoredBlock {
    const parent = this.#parentOf(stored);
    if (parent === undefined) {
      throw new RangeError("the tree is missing a parent it should hold");
    }
    return parent;
  }
}
