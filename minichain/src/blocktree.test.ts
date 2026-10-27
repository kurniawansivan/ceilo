import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { type Block, createBlock, hashBlockHeader, tryHashBlockHeader } from "./block.ts";
import { type AddBlockOutcome, BlockTree } from "./blocktree.ts";
import { replayChain } from "./chain.ts";
import { type ConsensusRules, computeExpectedTarget } from "./consensus.ts";
import type { Hash } from "./hash.ts";
import { mineBlock } from "./mining.ts";
import {
  computeStateRoot,
  computeTotalSupply,
  createGenesis,
  type Genesis,
  getAccount,
  produceBlock,
} from "./state.ts";
import {
  addressOfAccount,
  createPlaceholderStateRoot,
  elementAt,
  flipFirstBit,
  signTransfer,
} from "./testing.ts";
import type { SignedTransaction } from "./transaction.ts";
import { computeWork, MAXIMUM_TARGET, meetsTarget } from "./work.ts";

const CHAIN_IDENTIFIER = 1337n;
const GENESIS_TIMESTAMP = 1_000n;
const INITIAL_TARGET = 2n ** 252n - 1n;
const ALICE = 1;
const BOB = 2;
const DAVE = 4;
const MINER_ONE = 5;
const MINER_TWO = 6;

// A window this long means difficulty never changes in the short chains below.
const FORK_RULES: ConsensusRules = {
  targetBlockIntervalInSeconds: 10n,
  retargetWindowInBlocks: 1_000_000n,
  maximumTarget: MAXIMUM_TARGET,
  maximumAdjustmentFactor: 4n,
  futureTimeLimitInSeconds: 30n,
};

// A window of 3 blocks expects 2 intervals of 10 seconds, so 20 seconds.
const RETARGET_RULES: ConsensusRules = { ...FORK_RULES, retargetWindowInBlocks: 3n };

/** Options for mining a block on top of a stored parent. */
type ChildOptions = {
  readonly spacing?: bigint;
  readonly miner?: number;
  readonly transactions?: readonly SignedTransaction[];
  readonly target?: bigint;
};

/** Creates the genesis every tree in these tests starts from, with coins only for Alice. */
const createTestGenesis = (): Genesis =>
  createGenesis({
    chainIdentifier: CHAIN_IDENTIFIER,
    timestamp: GENESIS_TIMESTAMP,
    target: INITIAL_TARGET,
    blockReward: 50n,
    allocations: [{ address: addressOfAccount(ALICE), balance: 1_000n }],
  });

/** Creates a tree on the test genesis. */
const createTree = (rules: ConsensusRules = FORK_RULES, maximumOrphanCount?: number): BlockTree =>
  new BlockTree(createTestGenesis(), rules, maximumOrphanCount);

/** Returns the hash of the test genesis block. */
const genesisHash = (): Hash => hashBlockHeader(createTestGenesis().block.header);

/** Produces and mines a child of a stored block, with the target the tree expects unless one is forced. */
const mineChild = (tree: BlockTree, parentHash: Hash, options: ChildOptions = {}): Block => {
  const parent = tree.get(parentHash);
  assert.ok(parent, "the parent is not in the tree");
  const production = produceBlock({
    parentState: parent.state,
    parentHeader: parent.block.header,
    transactions: options.transactions ?? [],
    timestamp: parent.block.header.timestamp + (options.spacing ?? 10n),
    beneficiary: addressOfAccount(options.miner ?? MINER_ONE),
    target: options.target ?? tree.nextTarget(parentHash),
  });
  if (!production.valid) {
    assert.fail(`could not produce a block: ${production.reason}`);
  }
  const mined = mineBlock(production.block, 500_000);
  assert.ok(mined, "no nonce was found within the budget");
  return mined;
};

/** Mines a run of blocks on a scratch tree, starting after some blocks that are already valid. */
const mineBranch = (
  count: number,
  options: ChildOptions = {},
  prefix: readonly Block[] = [],
  rules: ConsensusRules = FORK_RULES,
): Block[] => {
  const scratch = createTree(rules);
  for (const block of prefix) {
    assert.equal(scratch.addBlock(block).status, "added");
  }
  const branch: Block[] = [];
  for (let index = 0; index < count; index++) {
    const block = mineChild(scratch, scratch.tip.hash, options);
    assert.equal(scratch.addBlock(block).status, "added");
    branch.push(block);
  }
  return branch;
};

/** Adds a block, failing the test unless the tree accepted it. */
const addAccepted = (tree: BlockTree, block: Block) => {
  const outcome = tree.addBlock(block);
  if (outcome.status !== "added") {
    assert.fail(`expected the block to be added, got ${JSON.stringify(outcome)}`);
  }
  return outcome.tipChange;
};

/** Returns the block with the first nonce that does not meet its target, failing fast if none does. */
const withFailingNonce = (block: Block): Block => {
  for (let nonce = 0n; nonce < 10_000n; nonce++) {
    const header = { ...block.header, nonce };
    if (!meetsTarget(hashBlockHeader(header), header.target)) {
      return { ...block, header };
    }
  }
  return assert.fail("every nonce met the target");
};

/** Returns the balance of a numbered account at the tree's tip. */
const balanceAtTip = (tree: BlockTree, accountNumber: number): bigint =>
  getAccount(tree.tip.state, addressOfAccount(accountNumber)).balance;

/** Names a rejection so a failure message can show what the tree said. */
const statusOf = (outcome: AddBlockOutcome): string =>
  outcome.status === "rejected" ? `rejected: ${outcome.reason}` : outcome.status;

describe("a new tree", () => {
  test("has the genesis block as its tip, with the work of its target", () => {
    const tree = createTree();

    assert.deepEqual(tree.tip.hash, genesisHash());
    assert.equal(tree.tip.block.header.height, 0n);
    assert.equal(tree.tip.cumulativeWork, computeWork(INITIAL_TARGET));
    assert.equal(tree.tip.cumulativeWork, 16n);
    assert.deepEqual(computeStateRoot(tree.tip.state), tree.tip.block.header.stateRoot);
    assert.equal(tree.orphanCount, 0);
  });

  test("knows the genesis block, and adding it again changes nothing", () => {
    const tree = createTree();
    assert.equal(tree.has(genesisHash()), true);
    assert.deepEqual(tree.addBlock(createTestGenesis().block), { status: "known" });
  });

  test("rejects invalid rules, which is a mistake and not a bad block", () => {
    assert.throws(
      () => new BlockTree(createTestGenesis(), { ...FORK_RULES, retargetWindowInBlocks: 1n }),
      RangeError,
    );
  });

  test("rejects a genesis whose state is not the one its header commits to", () => {
    const genesis = createTestGenesis();
    const richerState = createGenesis({
      chainIdentifier: CHAIN_IDENTIFIER,
      timestamp: GENESIS_TIMESTAMP,
      target: INITIAL_TARGET,
      blockReward: 50n,
      allocations: [{ address: addressOfAccount(ALICE), balance: 2_000n }],
    }).state;

    assert.throws(
      () => new BlockTree({ block: genesis.block, state: richerState }, FORK_RULES),
      RangeError,
    );
  });

  test("rejects a genesis whose target is easier than the rules allow", () => {
    assert.throws(
      () => new BlockTree(createTestGenesis(), { ...FORK_RULES, maximumTarget: 2n ** 200n }),
      RangeError,
    );
  });

  test("rejects a negative orphan limit", () => {
    assert.throws(() => createTree(FORK_RULES, -1), RangeError);
  });

  test("knows nothing about a hash it has not seen", () => {
    const tree = createTree();
    const unknownHash = flipFirstBit(genesisHash());
    assert.equal(tree.has(unknownHash), false);
    assert.equal(tree.get(unknownHash), undefined);
  });
});

describe("adding blocks onto the tip", () => {
  test("adds a valid child and extends the tip", () => {
    const tree = createTree();
    const block = mineChild(tree, genesisHash());

    assert.deepEqual(tree.addBlock(block), {
      status: "added",
      tipChange: { kind: "extended", attached: [block] },
    });
    assert.deepEqual(tree.tip.hash, hashBlockHeader(block.header));
    assert.equal(tree.tip.block.header.height, 1n);
  });

  test("adds up the work of every block back to genesis", () => {
    const tree = createTree();
    const blocks = mineBranch(3);
    for (const block of blocks) {
      addAccepted(tree, block);
    }

    assert.equal(tree.tip.cumulativeWork, 16n * 4n);
    assert.equal(tree.get(hashBlockHeader(elementAt(blocks, 0).header))?.cumulativeWork, 32n);
  });

  test("stores the state each block leaves", () => {
    const tree = createTree();
    const transfer = signTransfer({ from: ALICE, to: BOB, amount: 100n, fee: 1n, nonce: 0n });
    const block = mineChild(tree, genesisHash(), { transactions: [transfer] });
    addAccepted(tree, block);

    assert.equal(balanceAtTip(tree, BOB), 100n);
    assert.equal(balanceAtTip(tree, ALICE), 899n);
    assert.deepEqual(computeStateRoot(tree.tip.state), block.header.stateRoot);
  });

  test("answers that a block it holds is known, and does not add it twice", () => {
    const tree = createTree();
    const block = mineChild(tree, genesisHash());
    addAccepted(tree, block);

    assert.deepEqual(tree.addBlock(block), { status: "known" });
    assert.equal(tree.has(hashBlockHeader(block.header)), true);
  });

  test("keeps the whole path to genesis available", () => {
    const tree = createTree();
    const blocks = mineBranch(3);
    for (const block of blocks) {
      addAccepted(tree, block);
    }

    const path = tree.bestChain().map((stored) => stored.block.header.height);
    assert.deepEqual(path, [0n, 1n, 2n, 3n]);
  });
});

describe("rejecting blocks", () => {
  /** Adds a block that must be refused for a reason, and checks the tree is untouched. */
  const assertRejected = (tree: BlockTree, block: Block, reason: string): void => {
    const tipBefore = tree.tip.hash;
    const outcome = tree.addBlock(block);

    assert.deepEqual(outcome, { status: "rejected", reason }, statusOf(outcome));
    const hash = tryHashBlockHeader(block.header);
    if (hash !== undefined) {
      assert.equal(tree.has(hash), false);
    }
    assert.deepEqual(tree.tip.hash, tipBefore);
    assert.equal(tree.orphanCount, 0);
  };

  test("a header that is malformed", () => {
    const tree = createTree();
    const child = mineChild(tree, genesisHash());
    const malformed = { ...child, header: { ...child.header, beneficiary: new Uint8Array(19) } };
    assertRejected(tree, malformed, "malformed-header");
  });

  test("a height that does not follow its parent", () => {
    const tree = createTree();
    const child = mineChild(tree, genesisHash());
    const wrongHeight = mineBlock({ ...child, header: { ...child.header, height: 5n } }, 500_000);
    assert.ok(wrongHeight);
    assertRejected(tree, wrongHeight, "unexpected-height");
  });

  test("a timestamp that is not after its parent's", () => {
    const tree = createTree();
    const child = mineChild(tree, genesisHash());
    const tooEarly = mineBlock(
      { ...child, header: { ...child.header, timestamp: GENESIS_TIMESTAMP } },
      500_000,
    );
    assert.ok(tooEarly);
    assertRejected(tree, tooEarly, "timestamp-not-increasing");
  });

  test("a target other than the one the rules expect", () => {
    const tree = createTree();
    const wrongTarget = mineChild(tree, genesisHash(), { target: INITIAL_TARGET / 2n });
    assertRejected(tree, wrongTarget, "target-mismatch");
  });

  test("a nonce that does not reach the target", () => {
    const tree = createTree();
    const child = mineChild(tree, genesisHash());
    assertRejected(tree, withFailingNonce(child), "insufficient-work");
  });

  test("transactions that are not the ones the header commits to", () => {
    const tree = createTree();
    const child = mineChild(tree, genesisHash());
    const swapped = {
      ...child,
      transactions: [signTransfer({ from: ALICE, to: BOB, amount: 1n, fee: 1n, nonce: 0n })],
    };
    assertRejected(tree, swapped, "transactions-root-mismatch");
  });

  test("a transaction the state refuses", () => {
    const tree = createTree();
    const badTransfer = signTransfer({ from: ALICE, to: BOB, amount: 1n, fee: 1n, nonce: 9n });
    const unmined = createBlock({
      parentHeader: tree.tip.block.header,
      transactions: [badTransfer],
      timestamp: GENESIS_TIMESTAMP + 10n,
      beneficiary: addressOfAccount(MINER_ONE),
      stateRoot: createPlaceholderStateRoot(),
      target: tree.nextTarget(genesisHash()),
    });
    const mined = mineBlock(unmined, 500_000);
    assert.ok(mined);
    assertRejected(tree, mined, "nonce-mismatch");
  });

  test("a state root that is not the result of its transactions", () => {
    const tree = createTree();
    const child = mineChild(tree, genesisHash());
    const forged = mineBlock(
      { ...child, header: { ...child.header, stateRoot: flipFirstBit(child.header.stateRoot) } },
      500_000,
    );
    assert.ok(forged);
    assertRejected(tree, forged, "state-root-mismatch");
  });

  test("a rejected block is judged again, not remembered as known", () => {
    const tree = createTree();
    const child = mineChild(tree, genesisHash());
    const refused = withFailingNonce(child);

    assert.equal(tree.addBlock(refused).status, "rejected");
    assert.equal(tree.addBlock(refused).status, "rejected");
  });
});

describe("orphans, blocks whose parent has not arrived", () => {
  test("is kept aside, not added, until its parent arrives", () => {
    const tree = createTree();
    const [first, second] = mineBranch(2);
    assert.ok(first && second);

    assert.deepEqual(tree.addBlock(second), { status: "orphan" });
    assert.equal(tree.orphanCount, 1);
    assert.equal(tree.has(hashBlockHeader(second.header)), false);
    assert.deepEqual(tree.tip.hash, genesisHash());
  });

  test("connects, with its parent, when the parent arrives", () => {
    const tree = createTree();
    const [first, second] = mineBranch(2);
    assert.ok(first && second);
    tree.addBlock(second);

    assert.deepEqual(addAccepted(tree, first), { kind: "extended", attached: [first, second] });
    assert.equal(tree.orphanCount, 0);
    assert.deepEqual(tree.tip.hash, hashBlockHeader(second.header));
  });

  test("connects a whole chain that arrived in reverse order", () => {
    const tree = createTree();
    const [first, second, third] = mineBranch(3);
    assert.ok(first && second && third);

    assert.equal(tree.addBlock(third).status, "orphan");
    assert.equal(tree.addBlock(second).status, "orphan");
    assert.equal(tree.orphanCount, 2);
    assert.deepEqual(addAccepted(tree, first), {
      kind: "extended",
      attached: [first, second, third],
    });
    assert.equal(tree.tip.block.header.height, 3n);
  });

  test("counts a block that arrives twice once", () => {
    const tree = createTree();
    const [, second] = mineBranch(2);
    assert.ok(second);

    tree.addBlock(second);
    assert.deepEqual(tree.addBlock(second), { status: "orphan" });
    assert.equal(tree.orphanCount, 1);
  });

  test("drops the oldest when more arrive than the limit allows", () => {
    const tree = createTree(FORK_RULES, 2);
    const [first, second, third, fourth] = mineBranch(4);
    assert.ok(first && second && third && fourth);

    tree.addBlock(fourth);
    tree.addBlock(third);
    tree.addBlock(second);
    assert.equal(tree.orphanCount, 2);

    addAccepted(tree, first);
    // The fourth block was dropped, so the chain stops at the third.
    assert.deepEqual(tree.tip.hash, hashBlockHeader(third.header));
    assert.equal(tree.has(hashBlockHeader(fourth.header)), false);
  });

  test("is not kept at all when the limit is zero", () => {
    const tree = createTree(FORK_RULES, 0);
    const [, second] = mineBranch(2);
    assert.ok(second);

    assert.deepEqual(tree.addBlock(second), { status: "orphan" });
    assert.equal(tree.orphanCount, 0);
  });

  test("is dropped silently if it turns out invalid once its parent arrives", () => {
    const tree = createTree();
    const [first, second] = mineBranch(2);
    assert.ok(first && second);
    const forgedSecond = mineBlock(
      { ...second, header: { ...second.header, stateRoot: flipFirstBit(second.header.stateRoot) } },
      500_000,
    );
    assert.ok(forgedSecond);

    assert.equal(tree.addBlock(forgedSecond).status, "orphan");
    addAccepted(tree, first);

    assert.equal(tree.orphanCount, 0);
    assert.equal(tree.has(hashBlockHeader(forgedSecond.header)), false);
    assert.deepEqual(tree.tip.hash, hashBlockHeader(first.header));
  });

  test("keeps waiting when the parent it waited for turned out invalid, instead of failing", () => {
    const tree = createTree();
    const [first, second, third] = mineBranch(3);
    assert.ok(first && second && third);
    const forgedSecond = mineBlock(
      { ...second, header: { ...second.header, stateRoot: flipFirstBit(second.header.stateRoot) } },
      500_000,
    );
    assert.ok(forgedSecond);
    const orphanOfForged = mineBlock(
      {
        ...third,
        header: { ...third.header, previousBlockHash: hashBlockHeader(forgedSecond.header) },
      },
      500_000,
    );
    assert.ok(orphanOfForged);

    assert.equal(tree.addBlock(orphanOfForged).status, "orphan");
    assert.equal(tree.addBlock(forgedSecond).status, "orphan");
    assert.equal(tree.orphanCount, 2);

    addAccepted(tree, first);
    // The forged block was dropped, so the block that waited for it has no parent to connect to.
    assert.equal(tree.orphanCount, 1);
    assert.deepEqual(tree.tip.hash, hashBlockHeader(first.header));
    assert.equal(tree.has(hashBlockHeader(orphanOfForged.header)), false);
  });

  test("is never made of a block that was rejected for its own faults", () => {
    const tree = createTree();
    const child = mineChild(tree, genesisHash());
    assert.equal(tree.addBlock(withFailingNonce(child)).status, "rejected");
    assert.equal(tree.orphanCount, 0);
  });
});

describe("choosing the tip", () => {
  test("keeps the block seen first when two branches have equal work", () => {
    const tree = createTree();
    const [firstA] = mineBranch(1, { miner: MINER_ONE });
    const [firstB] = mineBranch(1, { miner: MINER_TWO });
    assert.ok(firstA && firstB);

    addAccepted(tree, firstA);
    assert.deepEqual(addAccepted(tree, firstB), { kind: "unchanged" });
    assert.deepEqual(tree.tip.hash, hashBlockHeader(firstA.header));
    assert.equal(tree.has(hashBlockHeader(firstB.header)), true);
  });

  test("switches to a branch that gains more work, naming what was undone and applied", () => {
    const tree = createTree();
    const [firstA] = mineBranch(1, { miner: MINER_ONE });
    const [firstB, secondB] = mineBranch(2, { miner: MINER_TWO });
    assert.ok(firstA && firstB && secondB);

    addAccepted(tree, firstA);
    addAccepted(tree, firstB);
    assert.deepEqual(addAccepted(tree, secondB), {
      kind: "reorganized",
      detached: [firstA],
      attached: [firstB, secondB],
    });
    assert.deepEqual(tree.tip.hash, hashBlockHeader(secondB.header));
  });

  test("switches back when the first branch overtakes again", () => {
    const tree = createTree();
    const [firstA, secondA, thirdA] = mineBranch(3, { miner: MINER_ONE });
    const [firstB, secondB] = mineBranch(2, { miner: MINER_TWO });
    assert.ok(firstA && secondA && thirdA && firstB && secondB);

    addAccepted(tree, firstA);
    addAccepted(tree, firstB);
    addAccepted(tree, secondB);
    assert.deepEqual(addAccepted(tree, secondA), { kind: "unchanged" });
    assert.deepEqual(addAccepted(tree, thirdA), {
      kind: "reorganized",
      detached: [firstB, secondB],
      attached: [firstA, secondA, thirdA],
    });
  });

  test("leaves the tip alone when a side branch grows but stays lighter", () => {
    const tree = createTree();
    const [firstA, secondA] = mineBranch(2, { miner: MINER_ONE });
    const [firstB] = mineBranch(1, { miner: MINER_TWO });
    assert.ok(firstA && secondA && firstB);

    addAccepted(tree, firstA);
    addAccepted(tree, secondA);
    assert.deepEqual(addAccepted(tree, firstB), { kind: "unchanged" });
    assert.deepEqual(tree.tip.hash, hashBlockHeader(secondA.header));
  });

  test("reports a reorganization that an arriving orphan caused, against the tip before it", () => {
    const tree = createTree();
    const [firstA] = mineBranch(1, { miner: MINER_ONE });
    const [firstB, secondB] = mineBranch(2, { miner: MINER_TWO });
    assert.ok(firstA && firstB && secondB);

    addAccepted(tree, firstA);
    assert.equal(tree.addBlock(secondB).status, "orphan");
    assert.deepEqual(addAccepted(tree, firstB), {
      kind: "reorganized",
      detached: [firstA],
      attached: [firstB, secondB],
    });
  });

  test("prefers the heaviest branch even when another is longer", () => {
    const tree = createTree(RETARGET_RULES);
    // Slow blocks make the target easier at height 3: each later block carries little work.
    const slowBranch = mineBranch(6, { spacing: 100n, miner: MINER_ONE }, [], RETARGET_RULES);
    // Fast blocks make it harder at height 3: each later block carries much more work.
    const fastBranch = mineBranch(4, { spacing: 1n, miner: MINER_TWO }, [], RETARGET_RULES);
    for (const block of slowBranch) {
      addAccepted(tree, block);
    }
    assert.equal(tree.tip.block.header.height, 6n);
    assert.equal(tree.tip.cumulativeWork, 61n);

    const [fastOne, fastTwo, fastThree, fastFour] = fastBranch;
    assert.ok(fastOne && fastTwo && fastThree && fastFour);
    assert.deepEqual(addAccepted(tree, fastOne), { kind: "unchanged" });
    assert.deepEqual(addAccepted(tree, fastTwo), { kind: "unchanged" });

    const change = addAccepted(tree, fastThree);
    assert.equal(change.kind, "reorganized");
    assert.equal(tree.tip.block.header.height, 3n);
    assert.equal(tree.tip.cumulativeWork, 112n);

    addAccepted(tree, fastFour);
    assert.equal(tree.tip.block.header.height, 4n);
    assert.equal(tree.tip.cumulativeWork, 176n);
    assert.ok(tree.tip.block.header.height < 6n, "the winning branch is the shorter one");
  });
});

describe("state across a reorganization", () => {
  /** Mines a one-block branch in which Alice pays an account, plus empty blocks after it. */
  const mineBranchPaying = (recipient: number, miner: number, extraBlocks: number): Block[] => {
    const scratch = createTree();
    const payment = signTransfer({ from: ALICE, to: recipient, amount: 100n, fee: 1n, nonce: 0n });
    const blocks: Block[] = [];
    for (let index = 0; index < 1 + extraBlocks; index++) {
      const block = mineChild(scratch, scratch.tip.hash, {
        miner,
        transactions: index === 0 ? [payment] : [],
      });
      scratch.addBlock(block);
      blocks.push(block);
    }
    return blocks;
  };

  test("follows the branch that wins, and the losing branch's coins disappear", () => {
    const tree = createTree();
    const branchPayingBob = mineBranchPaying(BOB, MINER_ONE, 0);
    const branchPayingDave = mineBranchPaying(DAVE, MINER_TWO, 1);
    assert.ok(branchPayingBob.length === 1 && branchPayingDave.length === 2);

    for (const block of branchPayingBob) {
      addAccepted(tree, block);
    }
    assert.equal(balanceAtTip(tree, BOB), 100n);
    assert.equal(balanceAtTip(tree, DAVE), 0n);

    for (const block of branchPayingDave) {
      addAccepted(tree, block);
    }
    assert.equal(balanceAtTip(tree, DAVE), 100n);
    assert.equal(balanceAtTip(tree, BOB), 0n);
  });

  test("keeps the abandoned branch's own states intact, so it can win again", () => {
    const tree = createTree();
    const branchPayingBob = mineBranchPaying(BOB, MINER_ONE, 2);
    const branchPayingDave = mineBranchPaying(DAVE, MINER_TWO, 1);
    assert.ok(branchPayingBob.length === 3 && branchPayingDave.length === 2);
    const bobsFirstBlock = elementAt(branchPayingBob, 0);

    addAccepted(tree, bobsFirstBlock);
    for (const block of branchPayingDave) {
      addAccepted(tree, block);
    }
    assert.equal(balanceAtTip(tree, DAVE), 100n);

    const abandoned = tree.get(hashBlockHeader(bobsFirstBlock.header));
    assert.ok(abandoned);
    assert.equal(getAccount(abandoned.state, addressOfAccount(BOB)).balance, 100n);

    for (const block of branchPayingBob.slice(1)) {
      addAccepted(tree, block);
    }
    assert.equal(balanceAtTip(tree, BOB), 100n);
    assert.equal(balanceAtTip(tree, DAVE), 0n);
  });

  test("moves block rewards with the winning branch, and the supply with it", () => {
    const tree = createTree();
    const [firstA, secondA, thirdA] = mineBranch(3, { miner: MINER_ONE });
    const [firstB, secondB] = mineBranch(2, { miner: MINER_TWO });
    assert.ok(firstA && secondA && thirdA && firstB && secondB);

    addAccepted(tree, firstA);
    assert.equal(balanceAtTip(tree, MINER_ONE), 50n);
    assert.equal(computeTotalSupply(tree.tip.state), 1_000n + 50n);

    addAccepted(tree, firstB);
    addAccepted(tree, secondB);
    // Branch B now leads, so branch A's reward is gone from the tip and B's two rewards are in.
    assert.equal(balanceAtTip(tree, MINER_ONE), 0n);
    assert.equal(balanceAtTip(tree, MINER_TWO), 100n);
    assert.equal(computeTotalSupply(tree.tip.state), 1_000n + 100n);

    addAccepted(tree, secondA);
    addAccepted(tree, thirdA);
    assert.equal(balanceAtTip(tree, MINER_ONE), 150n);
    assert.equal(balanceAtTip(tree, MINER_TWO), 0n);
    assert.equal(computeTotalSupply(tree.tip.state), 1_000n + 150n);
  });

  test("keeps sibling states independent of each other", () => {
    const tree = createTree();
    const [bobBlock] = mineBranchPaying(BOB, MINER_ONE, 0);
    const [daveBlock] = mineBranchPaying(DAVE, MINER_TWO, 0);
    assert.ok(bobBlock && daveBlock);
    addAccepted(tree, bobBlock);
    addAccepted(tree, daveBlock);

    const bobState = tree.get(hashBlockHeader(bobBlock.header))?.state;
    const daveState = tree.get(hashBlockHeader(daveBlock.header))?.state;
    assert.ok(bobState && daveState);
    assert.equal(getAccount(bobState, addressOfAccount(DAVE)).balance, 0n);
    assert.equal(getAccount(daveState, addressOfAccount(BOB)).balance, 0n);
  });
});

describe("asking the tree", () => {
  test("lists the best chain from genesis to the tip, and changes it after a reorganization", () => {
    const tree = createTree();
    const [firstA] = mineBranch(1, { miner: MINER_ONE });
    const [firstB, secondB] = mineBranch(2, { miner: MINER_TWO });
    assert.ok(firstA && firstB && secondB);
    addAccepted(tree, firstA);
    assert.equal(tree.bestChain().length, 2);

    addAccepted(tree, firstB);
    addAccepted(tree, secondB);
    const hashes = tree.bestChain().map((stored) => stored.hash);
    assert.deepEqual(hashes, [
      genesisHash(),
      hashBlockHeader(firstB.header),
      hashBlockHeader(secondB.header),
    ]);
  });

  test("lists the path to a block on a side branch", () => {
    const tree = createTree();
    const [firstA, secondA] = mineBranch(2, { miner: MINER_ONE });
    const [firstB] = mineBranch(1, { miner: MINER_TWO });
    assert.ok(firstA && secondA && firstB);
    for (const block of [firstA, secondA, firstB]) {
      addAccepted(tree, block);
    }

    const path = tree.chainTo(hashBlockHeader(firstB.header)).map((stored) => stored.hash);
    assert.deepEqual(path, [genesisHash(), hashBlockHeader(firstB.header)]);
  });

  test("refuses to list the path to a block it does not hold", () => {
    assert.throws(() => createTree().chainTo(flipFirstBit(genesisHash())), RangeError);
  });

  test("gives its best chain to an independent validator, which agrees it is valid", () => {
    const tree = createTree(RETARGET_RULES);
    for (const block of mineBranch(7, { spacing: 5n }, [], RETARGET_RULES)) {
      addAccepted(tree, block);
    }

    const chain = tree.bestChain().map((stored) => stored.block);
    const replay = replayChain(chain, genesisHash(), createTestGenesis().state, RETARGET_RULES);
    assert.ok(replay.valid);
    assert.deepEqual(computeStateRoot(replay.state), computeStateRoot(tree.tip.state));
  });

  test("tells a miner the target its child must have, per branch", () => {
    const tree = createTree(RETARGET_RULES);
    const slowBranch = mineBranch(2, { spacing: 100n, miner: MINER_ONE }, [], RETARGET_RULES);
    const fastBranch = mineBranch(2, { spacing: 1n, miner: MINER_TWO }, [], RETARGET_RULES);
    for (const block of [...slowBranch, ...fastBranch]) {
      addAccepted(tree, block);
    }

    const slowTip = hashBlockHeader(elementAt(slowBranch, 1).header);
    const fastTip = hashBlockHeader(elementAt(fastBranch, 1).header);
    // Height 3 is a window boundary: 200 slow seconds clamp to 80, and 2 fast seconds clamp to 5.
    assert.equal(tree.nextTarget(slowTip), (INITIAL_TARGET * 80n) / 20n);
    assert.equal(tree.nextTarget(fastTip), (INITIAL_TARGET * 5n) / 20n);
  });

  test("agrees with the rules function for the target of any child", () => {
    const tree = createTree(RETARGET_RULES);
    const blocks = mineBranch(5, { spacing: 7n }, [], RETARGET_RULES);
    for (const block of blocks) {
      addAccepted(tree, block);
    }

    const chain = tree.bestChain().map((stored) => stored.block);
    const expected = computeExpectedTarget(
      RETARGET_RULES,
      tree.tip.block.header,
      (height) => chain[Number(height)]?.header,
    );
    assert.equal(tree.nextTarget(tree.tip.hash), expected);
  });

  test("finds the start of a retarget window on the parent's own branch, not on the tip's", () => {
    const tree = createTree(RETARGET_RULES);
    // Both branches pass height 3 with different timestamps, so the window that ends at height 5 differs.
    const slowBranch = mineBranch(5, { spacing: 15n, miner: MINER_ONE }, [], RETARGET_RULES);
    const fastBranch = mineBranch(5, { spacing: 8n, miner: MINER_TWO }, [], RETARGET_RULES);
    for (const block of [...slowBranch, ...fastBranch]) {
      addAccepted(tree, block);
    }
    assert.deepEqual(tree.tip.hash, hashBlockHeader(elementAt(fastBranch, 4).header));

    const targets = [slowBranch, fastBranch].map((branch) => {
      const parent = elementAt(branch, 4);
      const ownPath = tree
        .chainTo(hashBlockHeader(parent.header))
        .map((stored) => stored.block.header);
      const expected = computeExpectedTarget(
        RETARGET_RULES,
        parent.header,
        (height) => ownPath[Number(height)],
      );
      assert.equal(tree.nextTarget(hashBlockHeader(parent.header)), expected);
      return expected;
    });
    assert.notEqual(targets[0], targets[1]);
  });

  test("refuses to give a target for a parent it does not hold", () => {
    assert.throws(() => createTree().nextTarget(flipFirstBit(genesisHash())), RangeError);
  });
});
