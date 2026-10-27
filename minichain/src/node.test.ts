import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";

import { type Block, hashBlockHeader } from "./block.ts";
import type { ConsensusRules } from "./consensus.ts";
import { NetworkNode, type Outgoing } from "./node.ts";
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
const MINER_ONE = 5;
const MINER_TWO = 6;
const ATTEMPT_COUNT = 500_000;

const RULES: ConsensusRules = {
  targetBlockIntervalInSeconds: 10n,
  retargetWindowInBlocks: 1_000_000n,
  maximumTarget: MAXIMUM_TARGET,
  maximumAdjustmentFactor: 4n,
  futureTimeLimitInSeconds: 30n,
};

const genesis: Genesis = createGenesis({
  chainIdentifier: CHAIN_IDENTIFIER,
  timestamp: GENESIS_TIMESTAMP,
  target: INITIAL_TARGET,
  blockReward: BLOCK_REWARD,
  allocations: [
    { address: addressOfAccount(ALICE), balance: 10_000n },
    { address: addressOfAccount(BOB), balance: 1_000n },
  ],
});

// Every node in a test reads this one clock, so a test moves time for all of them at once.
const clock = { now: GENESIS_TIMESTAMP + 10n };

beforeEach(() => {
  clock.now = GENESIS_TIMESTAMP + 10n;
});

/** Creates a node on the test genesis that reads the shared clock, already connected to the given peers. */
const createNode = (
  identifier: string,
  miner: number = MINER_ONE,
  peers: readonly string[] = [],
): NetworkNode => {
  const node = new NetworkNode({
    identifier,
    genesis,
    rules: RULES,
    beneficiary: addressOfAccount(miner),
    clock: () => clock.now,
  });
  for (const peer of peers) {
    node.addPeer(peer);
  }
  return node;
};

/** Signs a payment from Alice to Bob. */
const payment = (nonce: bigint, fee: bigint, amount = 10n): SignedTransaction =>
  signTransfer({ from: ALICE, to: BOB, amount, fee, nonce });

/** Mines the next block on a node, failing the test if no nonce is found. */
const mineOn = (node: NetworkNode): Block => {
  const { block } = node.mineBlock(ATTEMPT_COUNT);
  assert.ok(block, "no nonce was found within the budget");
  return block;
};

/** Lists who a batch of outgoing messages is addressed to, in alphabetical order. */
const recipientsOf = (outgoing: readonly Outgoing[]): string[] =>
  outgoing.map((message) => message.recipient).sort();

describe("a new node", () => {
  test("starts at the genesis block with an empty pool and no peers", () => {
    const node = createNode("one");
    assert.deepEqual(node.tree.tip.block, genesis.block);
    assert.equal(node.pool.size, 0);
    assert.deepEqual(node.peers, []);
    assert.equal(node.identifier, "one");
  });

  test("keeps each peer once, in the order added, and forgets one that is removed", () => {
    const node = createNode("one");
    node.addPeer("two");
    node.addPeer("three");
    node.addPeer("two");
    assert.deepEqual(node.peers, ["two", "three"]);

    node.removePeer("two");
    assert.deepEqual(node.peers, ["three"]);
  });

  test("cannot be its own peer", () => {
    assert.throws(() => createNode("one").addPeer("one"), RangeError);
  });
});

describe("submitting a transaction", () => {
  test("pools a valid one and sends it to every peer", () => {
    const node = createNode("one", MINER_ONE, ["two", "three"]);
    const transaction = payment(0n, 3n);

    const result = node.submitTransaction(transaction);

    assert.deepEqual(result.outcome, { status: "added" });
    assert.equal(node.pool.has(hashSignedTransaction(transaction)), true);
    assert.deepEqual(result.outgoing, [
      { recipient: "two", message: { kind: "transaction", transaction } },
      { recipient: "three", message: { kind: "transaction", transaction } },
    ]);
  });

  test("refuses an invalid one and sends nothing", () => {
    const node = createNode("one", MINER_ONE, ["two"]);
    const wrongChain = signTransfer({
      from: ALICE,
      to: BOB,
      amount: 10n,
      fee: 3n,
      nonce: 0n,
      chainIdentifier: 1n,
    });

    const result = node.submitTransaction(wrongChain);

    assert.deepEqual(result.outcome, { status: "rejected", reason: "wrong-chain" });
    assert.deepEqual(result.outgoing, []);
    assert.equal(node.pool.size, 0);
  });

  test("sends nothing for one it already holds", () => {
    const node = createNode("one", MINER_ONE, ["two"]);
    const transaction = payment(0n, 3n);
    node.submitTransaction(transaction);

    const result = node.submitTransaction(transaction);

    assert.deepEqual(result.outcome, { status: "rejected", reason: "already-known" });
    assert.deepEqual(result.outgoing, []);
  });

  test("sends a replacement that pays a higher fee", () => {
    const node = createNode("one", MINER_ONE, ["two"]);
    const original = payment(0n, 3n);
    const bumped = payment(0n, 4n);
    node.submitTransaction(original);

    const result = node.submitTransaction(bumped);

    assert.deepEqual(result.outcome, { status: "replaced", replaced: original });
    assert.deepEqual(result.outgoing, [
      { recipient: "two", message: { kind: "transaction", transaction: bumped } },
    ]);
  });
});

describe("receiving a transaction", () => {
  test("pools a valid one and passes it to every peer except the one it came from", () => {
    const node = createNode("one", MINER_ONE, ["two", "three", "four"]);
    const transaction = payment(0n, 3n);

    const outgoing = node.receive("two", { kind: "transaction", transaction });

    assert.equal(node.pool.size, 1);
    assert.deepEqual(recipientsOf(outgoing), ["four", "three"]);
    assert.deepEqual(elementAt(outgoing, 0).message, { kind: "transaction", transaction });
  });

  test("passes on nothing for one it already holds", () => {
    const node = createNode("one", MINER_ONE, ["two", "three"]);
    const transaction = payment(0n, 3n);
    node.receive("two", { kind: "transaction", transaction });

    assert.deepEqual(node.receive("three", { kind: "transaction", transaction }), []);
    assert.equal(node.pool.size, 1);
  });

  test("keeps and passes on nothing for an invalid one", () => {
    const node = createNode("one", MINER_ONE, ["two", "three"]);
    const unpayable = payment(0n, 3n, 1_000_000n);

    assert.deepEqual(node.receive("two", { kind: "transaction", transaction: unpayable }), []);
    assert.equal(node.pool.size, 0);
  });
});

describe("receiving a block", () => {
  test("adds a valid one, passes it to every peer except its sender, and clears what it included", () => {
    const node = createNode("one", MINER_ONE, ["two", "three"]);
    const included = payment(0n, 3n);
    node.submitTransaction(included);
    const scratch = createNode("scratch", MINER_TWO);
    scratch.submitTransaction(included);
    const block = mineOn(scratch);

    const outgoing = node.receive("two", { kind: "block", block });

    assert.deepEqual(node.tree.tip.block, block);
    assert.deepEqual(outgoing, [{ recipient: "three", message: { kind: "block", block } }]);
    assert.equal(node.pool.size, 0);
  });

  test("passes on nothing for a block it already has", () => {
    const node = createNode("one", MINER_ONE, ["two", "three"]);
    const block = mineOn(createNode("scratch", MINER_TWO));
    node.receive("two", { kind: "block", block });

    assert.deepEqual(node.receive("three", { kind: "block", block }), []);
  });

  test("passes on a valid block that does not become its tip, since peers may lack it", () => {
    const node = createNode("one", MINER_ONE, ["two", "three"]);
    const own = mineOn(node);
    const rival = mineOn(createNode("rival", MINER_TWO));

    const outgoing = node.receive("two", { kind: "block", block: rival });

    assert.deepEqual(node.tree.tip.block, own);
    assert.deepEqual(outgoing, [{ recipient: "three", message: { kind: "block", block: rival } }]);
  });

  test("refuses an invalid block, passing on nothing and keeping its tip", () => {
    const node = createNode("one", MINER_ONE, ["two", "three"]);
    const block = mineOn(createNode("scratch", MINER_TWO));
    const stale = { ...block, header: { ...block.header, timestamp: GENESIS_TIMESTAMP } };

    assert.deepEqual(node.receive("two", { kind: "block", block: stale }), []);
    assert.deepEqual(node.tree.tip.block, genesis.block);
  });

  test("asks the sender for the parent of a block whose parent it lacks, and passes nothing on", () => {
    const node = createNode("one", MINER_ONE, ["two", "three"]);
    const scratch = createNode("scratch", MINER_TWO);
    const first = mineOn(scratch);
    const second = mineOn(scratch);

    const outgoing = node.receive("two", { kind: "block", block: second });

    assert.deepEqual(outgoing, [
      {
        recipient: "two",
        message: { kind: "request-block", hash: hashBlockHeader(first.header) },
      },
    ]);
    assert.deepEqual(node.tree.tip.block, genesis.block);
  });

  test("connects a waiting block when its parent arrives, and passes on both, parent first", () => {
    const node = createNode("one", MINER_ONE, ["two", "three"]);
    const scratch = createNode("scratch", MINER_TWO);
    const first = mineOn(scratch);
    const second = mineOn(scratch);
    node.receive("two", { kind: "block", block: second });

    const outgoing = node.receive("two", { kind: "block", block: first });

    assert.deepEqual(node.tree.tip.block, second);
    assert.deepEqual(outgoing, [
      { recipient: "three", message: { kind: "block", block: first } },
      { recipient: "three", message: { kind: "block", block: second } },
    ]);
  });

  test("passes on every block of a branch that replaces its chain, parents first", () => {
    const node = createNode("one", MINER_ONE, ["two", "three"]);
    mineOn(node);
    const rival = createNode("rival", MINER_TWO);
    const rivalFirst = mineOn(rival);
    const rivalSecond = mineOn(rival);
    node.receive("two", { kind: "block", block: rivalFirst });

    const outgoing = node.receive("two", { kind: "block", block: rivalSecond });

    assert.deepEqual(node.tree.tip.block, rivalSecond);
    assert.deepEqual(outgoing, [
      { recipient: "three", message: { kind: "block", block: rivalFirst } },
      { recipient: "three", message: { kind: "block", block: rivalSecond } },
    ]);
  });

  test("ignores a block stamped too far ahead of its clock, and takes it once the clock catches up", () => {
    const node = createNode("one", MINER_ONE, ["two", "three"]);
    clock.now = GENESIS_TIMESTAMP + 1_000n;
    const block = mineOn(createNode("scratch", MINER_TWO));

    clock.now = GENESIS_TIMESTAMP + 10n;
    assert.deepEqual(node.receive("two", { kind: "block", block }), []);
    assert.deepEqual(node.tree.tip.block, genesis.block);

    clock.now = GENESIS_TIMESTAMP + 1_000n;
    node.receive("two", { kind: "block", block });
    assert.deepEqual(node.tree.tip.block, block);
  });

  test("takes back a transaction when a longer branch replaces the block that carried it", () => {
    const node = createNode("one", MINER_ONE, ["two"]);
    const carried = payment(0n, 3n);
    node.submitTransaction(carried);
    mineOn(node);
    assert.equal(node.pool.size, 0);

    const rival = createNode("rival", MINER_TWO);
    const rivalFirst = mineOn(rival);
    const rivalSecond = mineOn(rival);
    node.receive("two", { kind: "block", block: rivalFirst });
    assert.equal(node.pool.size, 0);
    node.receive("two", { kind: "block", block: rivalSecond });

    assert.deepEqual(node.tree.tip.block, rivalSecond);
    assert.equal(node.pool.has(hashSignedTransaction(carried)), true);
  });
});

describe("serving blocks", () => {
  test("answers a request for a block it has with that block", () => {
    const node = createNode("one", MINER_ONE, ["two"]);
    const block = mineOn(node);

    assert.deepEqual(
      node.receive("two", { kind: "request-block", hash: hashBlockHeader(block.header) }),
      [{ recipient: "two", message: { kind: "block", block } }],
    );
    assert.deepEqual(
      node.receive("two", { kind: "request-block", hash: hashBlockHeader(genesis.block.header) }),
      [{ recipient: "two", message: { kind: "block", block: genesis.block } }],
    );
  });

  test("stays silent for a block it does not have", () => {
    const node = createNode("one", MINER_ONE, ["two"]);
    const unknown = hashBlockHeader(mineOn(createNode("scratch", MINER_TWO)).header);

    assert.deepEqual(node.receive("two", { kind: "request-block", hash: unknown }), []);
  });

  test("announces its tip to a peer", () => {
    const node = createNode("one", MINER_ONE, ["two"]);
    const block = mineOn(node);

    assert.deepEqual(node.announceTip("two"), [
      { recipient: "two", message: { kind: "block", block } },
    ]);
  });
});

describe("mining", () => {
  test("builds a block from the pool, moves its own tip, and sends the block to every peer", () => {
    const node = createNode("one", MINER_ONE, ["two", "three"]);
    const transaction = payment(0n, 3n);
    node.submitTransaction(transaction);

    const { block, outgoing } = node.mineBlock(ATTEMPT_COUNT);

    assert.ok(block);
    assert.deepEqual(block.transactions, [transaction]);
    assert.deepEqual(node.tree.tip.block, block);
    assert.equal(node.pool.size, 0);
    assert.deepEqual(outgoing, [
      { recipient: "two", message: { kind: "block", block } },
      { recipient: "three", message: { kind: "block", block } },
    ]);
  });

  test("pays the reward and the fees to its beneficiary", () => {
    const node = createNode("one", MINER_ONE);
    node.submitTransaction(payment(0n, 3n));
    mineOn(node);

    assert.equal(
      getAccount(node.tree.tip.state, addressOfAccount(MINER_ONE)).balance,
      BLOCK_REWARD + 3n,
    );
  });

  test("sends nothing when no nonce is found within the attempts", () => {
    const node = createNode("one", MINER_ONE, ["two"]);
    assert.deepEqual(node.mineBlock(0), { block: undefined, outgoing: [] });
    assert.deepEqual(node.tree.tip.block, genesis.block);
  });

  test("stamps the block with its clock", () => {
    const node = createNode("one");
    clock.now = GENESIS_TIMESTAMP + 77n;
    assert.equal(mineOn(node).header.timestamp, GENESIS_TIMESTAMP + 77n);
  });

  test("stamps one second after its tip when the clock is not ahead of it", () => {
    const node = createNode("one");
    clock.now = GENESIS_TIMESTAMP - 500n;
    assert.equal(mineOn(node).header.timestamp, GENESIS_TIMESTAMP + 1n);
  });
});
