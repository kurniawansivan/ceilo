import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { assembleBlock } from "./assembly.ts";
import { type Block, hashBlockHeader, MAXIMUM_TRANSACTIONS_PER_BLOCK } from "./block.ts";
import { BlockTree, type TipChange } from "./blocktree.ts";
import type { ConsensusRules } from "./consensus.ts";
import { Mempool } from "./mempool.ts";
import { createGenesis, type Genesis, getAccount } from "./state.ts";
import { addressOfAccount, elementAt, signTransfer } from "./testing.ts";
import { hashSignedTransaction, type SignedTransaction } from "./transaction.ts";
import { MAXIMUM_TARGET } from "./work.ts";

const CHAIN_IDENTIFIER = 1337n;
const GENESIS_TIMESTAMP = 1_000n;
const INITIAL_TARGET = 2n ** 252n - 1n;
const BLOCK_REWARD = 50n;
const ALICE = 1;
const BOB = 2;
const CAROL = 3;
const MINER_ONE = 5;
const MINER_TWO = 6;
const ATTEMPT_COUNT = 500_000;

// A window this long means difficulty never changes in the short chains below.
const STEADY_RULES: ConsensusRules = {
  targetBlockIntervalInSeconds: 10n,
  retargetWindowInBlocks: 1_000_000n,
  maximumTarget: MAXIMUM_TARGET,
  maximumAdjustmentFactor: 4n,
  futureTimeLimitInSeconds: 30n,
};

// A window of 3 blocks expects 2 intervals of 10 seconds, so 20 seconds.
const RETARGET_RULES: ConsensusRules = { ...STEADY_RULES, retargetWindowInBlocks: 3n };

/** Creates the genesis every tree in these tests starts from, with coins for Alice, Bob and Carol. */
const createTestGenesis = (): Genesis =>
  createGenesis({
    chainIdentifier: CHAIN_IDENTIFIER,
    timestamp: GENESIS_TIMESTAMP,
    target: INITIAL_TARGET,
    blockReward: BLOCK_REWARD,
    allocations: [
      { address: addressOfAccount(ALICE), balance: 100_000n },
      { address: addressOfAccount(BOB), balance: 1_000n },
      { address: addressOfAccount(CAROL), balance: 1_000n },
    ],
  });

/** Creates a tree on the test genesis. */
const createTree = (rules: ConsensusRules = STEADY_RULES): BlockTree =>
  new BlockTree(createTestGenesis(), rules);

/** Signs a payment from a numbered account to Carol, or to Bob when Carol is the sender. */
const payment = (from: number, nonce: bigint, fee: bigint, amount = 10n): SignedTransaction =>
  signTransfer({ from, to: from === CAROL ? BOB : CAROL, amount, fee, nonce });

/** Puts transactions into a fresh pool, failing the test if the pool refuses one. */
const poolWith = (tree: BlockTree, ...transactions: SignedTransaction[]): Mempool => {
  const pool = new Mempool();
  for (const transaction of transactions) {
    const outcome = pool.add(tree.tip.state, transaction);
    assert.notEqual(outcome.status, "rejected", "the pool refused a transaction");
  }
  return pool;
};

/** Assembles the next block on the tree's tip, ten seconds after it unless told otherwise. */
const assemble = (
  tree: BlockTree,
  pool: Mempool,
  options: { readonly miner?: number; readonly spacing?: bigint } = {},
): Block => {
  const block = assembleBlock(tree, pool, {
    beneficiary: addressOfAccount(options.miner ?? MINER_ONE),
    timestamp: tree.tip.block.header.timestamp + (options.spacing ?? 10n),
    attemptCount: ATTEMPT_COUNT,
  });
  assert.ok(block, "no nonce was found within the budget");
  return block;
};

/** Gives the tree a block it must take, returning how the tip moved. */
const accept = (tree: BlockTree, block: Block): TipChange => {
  const outcome = tree.addBlock(block);
  if (outcome.status !== "added") {
    assert.fail(`the tree did not take the block: ${outcome.status}`);
  }
  return outcome.tipChange;
};

/** Gives the tree a block, then brings the pool up to date with the tip the tree now has. */
const follow = (tree: BlockTree, pool: Mempool, block: Block): void => {
  const change = accept(tree, block);
  pool.applyTipChange(tree.tip.state, change);
};

describe("assembleBlock", () => {
  test("builds a block the tree takes as its new tip", () => {
    const tree = createTree();
    const pool = poolWith(tree, payment(ALICE, 0n, 3n), payment(BOB, 0n, 7n));

    const block = assemble(tree, pool);
    const change = accept(tree, block);

    assert.equal(change.kind, "extended");
    assert.deepEqual(tree.tip.block, block);
  });

  test("puts the best-paying transactions first", () => {
    const tree = createTree();
    const pool = poolWith(
      tree,
      payment(ALICE, 0n, 3n),
      payment(BOB, 0n, 7n),
      payment(CAROL, 0n, 5n),
    );

    const block = assemble(tree, pool);
    assert.deepEqual(
      block.transactions.map((transaction) => transaction.fee),
      [7n, 5n, 3n],
    );
  });

  test("pays the beneficiary the reward and every fee it included", () => {
    const tree = createTree();
    const pool = poolWith(tree, payment(ALICE, 0n, 3n), payment(BOB, 0n, 7n));

    accept(tree, assemble(tree, pool, { miner: MINER_ONE }));

    assert.equal(
      getAccount(tree.tip.state, addressOfAccount(MINER_ONE)).balance,
      BLOCK_REWARD + 10n,
    );
  });

  test("builds an empty block from an empty pool, which still earns the reward", () => {
    const tree = createTree();

    const block = assemble(tree, new Mempool());
    accept(tree, block);

    assert.equal(block.transactions.length, 0);
    assert.equal(getAccount(tree.tip.state, addressOfAccount(MINER_ONE)).balance, BLOCK_REWARD);
  });

  test("carries no more transactions than a block may hold, and the tree takes it", () => {
    const tree = createTree();
    const pool = new Mempool();
    const surplus = 5;
    for (let nonce = 0; nonce < MAXIMUM_TRANSACTIONS_PER_BLOCK + surplus; nonce++) {
      const outcome = pool.add(tree.tip.state, payment(ALICE, BigInt(nonce), 2n, 1n));
      assert.equal(outcome.status, "added");
    }

    const block = assemble(tree, pool);
    accept(tree, block);

    assert.equal(block.transactions.length, MAXIMUM_TRANSACTIONS_PER_BLOCK);
    assert.equal(pool.size, MAXIMUM_TRANSACTIONS_PER_BLOCK + surplus);
  });

  test("keeps a sender's transactions in nonce order, so the whole block applies", () => {
    const tree = createTree();
    const pool = poolWith(tree, payment(ALICE, 1n, 9n), payment(ALICE, 0n, 2n));

    const block = assemble(tree, pool);
    accept(tree, block);

    assert.deepEqual(
      block.transactions.map((transaction) => transaction.nonce),
      [0n, 1n],
    );
  });

  test("selects against the state at the tip, so a transaction that needs the tip block can run", () => {
    const tree = createTree();
    accept(tree, assemble(tree, poolWith(tree, payment(ALICE, 0n, 3n))));

    const block = assemble(tree, poolWith(tree, payment(ALICE, 1n, 3n)));
    accept(tree, block);

    assert.equal(block.transactions.length, 1);
  });

  test("stamps the block with the timestamp it was given", () => {
    const tree = createTree();
    const block = assemble(tree, new Mempool(), { spacing: 25n });
    assert.equal(block.header.timestamp, GENESIS_TIMESTAMP + 25n);
  });

  test("builds on the tip of the best chain, not on the genesis block", () => {
    const tree = createTree();
    const first = assemble(tree, new Mempool());
    accept(tree, first);

    const second = assemble(tree, new Mempool());
    assert.deepEqual(second.header.previousBlockHash, hashBlockHeader(first.header));
    assert.equal(second.header.height, 2n);
    accept(tree, second);
  });

  test("uses the target the tree expects, even after a retarget changed it", () => {
    const tree = createTree(RETARGET_RULES);
    accept(tree, assemble(tree, new Mempool(), { spacing: 40n }));
    accept(tree, assemble(tree, new Mempool(), { spacing: 40n }));

    const block = assemble(tree, new Mempool());
    assert.equal(block.header.target, tree.nextTarget(tree.tip.hash));
    assert.notEqual(block.header.target, tree.tip.block.header.target);
    accept(tree, block);
  });

  test("gives up with nothing when no nonce is found within the attempt budget", () => {
    const tree = createTree();
    const block = assembleBlock(tree, new Mempool(), {
      beneficiary: addressOfAccount(MINER_ONE),
      timestamp: GENESIS_TIMESTAMP + 10n,
      attemptCount: 0,
    });
    assert.equal(block, undefined);
  });

  test("leaves the pool as it was, because only the chain decides what is spent", () => {
    const tree = createTree();
    const waiting = payment(ALICE, 0n, 3n);
    const pool = poolWith(tree, waiting);

    assemble(tree, pool);
    assert.deepEqual(pool.pending(), [waiting]);
  });
});

/** A pool whose selection is a transaction no chain would take, to prove the assembler does not hide it. */
class BrokenPool extends Mempool {
  /** Selects a transaction signed for another chain. */
  override select(): SignedTransaction[] {
    return [
      signTransfer({ from: ALICE, to: BOB, amount: 1n, fee: 1n, nonce: 0n, chainIdentifier: 1n }),
    ];
  }
}

describe("assembleBlock given a pool that selects badly", () => {
  test("throws instead of building a block the chain would refuse", () => {
    assert.throws(
      () =>
        assembleBlock(createTree(), new BrokenPool(), {
          beneficiary: addressOfAccount(MINER_ONE),
          timestamp: GENESIS_TIMESTAMP + 10n,
          attemptCount: ATTEMPT_COUNT,
        }),
      /wrong-chain/,
    );
  });
});

describe("a pool that follows a tree", () => {
  test("forgets what a mined block included", () => {
    const tree = createTree();
    const included = payment(ALICE, 0n, 3n);
    const waiting = payment(BOB, 0n, 4n);
    const pool = poolWith(tree, included, waiting);

    const block = assembleBlock(tree, poolWith(tree, included), {
      beneficiary: addressOfAccount(MINER_ONE),
      timestamp: GENESIS_TIMESTAMP + 10n,
      attemptCount: ATTEMPT_COUNT,
    });
    assert.ok(block);
    follow(tree, pool, block);

    assert.deepEqual(pool.pending(), [waiting]);
  });

  test("takes back a transaction when the block that carried it loses to a longer branch", () => {
    const tree = createTree();
    const carried = payment(ALICE, 0n, 3n);
    const pool = poolWith(tree, carried);

    const losing = assemble(tree, pool, { miner: MINER_ONE });
    follow(tree, pool, losing);
    assert.equal(pool.size, 0);

    const rival = createTree();
    const rivalFirst = assemble(rival, new Mempool(), { miner: MINER_TWO });
    accept(rival, rivalFirst);
    const rivalSecond = assemble(rival, new Mempool(), { miner: MINER_TWO });

    assert.equal(accept(tree, rivalFirst).kind, "unchanged");
    const change = accept(tree, rivalSecond);
    assert.equal(change.kind, "reorganized");
    pool.applyTipChange(tree.tip.state, change);

    assert.equal(pool.size, 1);
    assert.equal(pool.has(hashSignedTransaction(carried)), true);
    assert.deepEqual(
      elementAt(
        pool.select(tree.tip.state, addressOfAccount(MINER_ONE), MAXIMUM_TRANSACTIONS_PER_BLOCK),
        0,
      ),
      carried,
    );
  });
});
