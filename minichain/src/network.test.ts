import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";

import { type Block, hashBlockHeader } from "./block.ts";
import type { ConsensusRules } from "./consensus.ts";
import { toHexadecimal } from "./hash.ts";
import { SimulatedNetwork } from "./network.ts";
import { NetworkNode } from "./node.ts";
import { computeStateRoot, createGenesis, type Genesis, getAccount } from "./state.ts";
import { addressOfAccount, createSeededRandom, signTransfer } from "./testing.ts";
import { hashSignedTransaction, type SignedTransaction } from "./transaction.ts";
import { MAXIMUM_TARGET } from "./work.ts";

const CHAIN_IDENTIFIER = 1337n;
const GENESIS_TIMESTAMP = 1_000n;
const INITIAL_TARGET = 2n ** 252n - 1n;
const BLOCK_REWARD = 50n;
const ALICE = 1;
const BOB = 2;
const FIRST_MINER = 5;
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

// Every node reads this one clock, so a test moves time for the whole network at once.
const clock = { now: GENESIS_TIMESTAMP + 10n };

beforeEach(() => {
  clock.now = GENESIS_TIMESTAMP + 10n;
});

/** Creates a network of nodes named by the given identifiers, each mining for its own account, none connected. */
const createNetwork = (...identifiers: string[]): SimulatedNetwork =>
  new SimulatedNetwork(
    identifiers.map(
      (identifier, index) =>
        new NetworkNode({
          identifier,
          genesis,
          rules: RULES,
          beneficiary: addressOfAccount(FIRST_MINER + index),
          clock: () => clock.now,
        }),
    ),
  );

/** Signs a payment from Alice to Bob. */
const payment = (nonce: bigint, fee: bigint, amount = 10n): SignedTransaction =>
  signTransfer({ from: ALICE, to: BOB, amount, fee, nonce });

/** Mines the next block on a node of the network, failing the test if no nonce is found. */
const mineOn = (network: SimulatedNetwork, identifier: string): Block => {
  const block = network.mineBlock(identifier, ATTEMPT_COUNT);
  assert.ok(block, "no nonce was found within the budget");
  return block;
};

/** Reads the tip hash of each named node as text. */
const tipsOf = (network: SimulatedNetwork, ...identifiers: string[]): string[] =>
  identifiers.map((identifier) => toHexadecimal(network.node(identifier).tree.tip.hash));

/** Gives the text of a block's hash. */
const hashOf = (block: Block): string => toHexadecimal(hashBlockHeader(block.header));

/** Tells whether every named node has the same tip. */
const agree = (network: SimulatedNetwork, ...identifiers: string[]): boolean =>
  new Set(tipsOf(network, ...identifiers)).size === 1;

describe("setting up a network", () => {
  test("refuses two nodes with the same identifier", () => {
    assert.throws(() => createNetwork("one", "one"), RangeError);
  });

  test("finds a node by identifier and refuses an unknown one", () => {
    const network = createNetwork("one", "two");
    assert.equal(network.node("two").identifier, "two");
    assert.throws(() => network.node("three"), RangeError);
  });

  test("connects two nodes as peers of each other", () => {
    const network = createNetwork("one", "two");
    network.connect("one", "two");
    assert.deepEqual(network.node("one").peers, ["two"]);
    assert.deepEqual(network.node("two").peers, ["one"]);
  });

  test("refuses to connect a node to itself or to one that does not exist", () => {
    const network = createNetwork("one", "two");
    assert.throws(() => network.connect("one", "one"), RangeError);
    assert.throws(() => network.connect("one", "three"), RangeError);
    assert.throws(() => network.connect("three", "one"), RangeError);
  });

  test("has each node announce its tip when two connect", () => {
    const network = createNetwork("one", "two");
    network.connect("one", "two");
    assert.equal(network.pendingCount, 2);
  });
});

describe("delivering messages", () => {
  test("reports how many it delivered, and stops once nothing new is passed on", () => {
    const network = createNetwork("one", "two");
    network.connect("one", "two");
    assert.equal(network.deliverAll(), 2);
    assert.equal(network.pendingCount, 0);

    mineOn(network, "one");
    assert.equal(network.deliverAll(), 1);
  });

  test("refuses to go on past the most deliveries it was allowed", () => {
    const network = createNetwork("one", "two");
    network.connect("one", "two");
    mineOn(network, "one");
    mineOn(network, "one");

    assert.throws(() => network.deliverAll({ maximumDeliveries: 1 }), RangeError);
    assert.equal(network.pendingCount, 3, "exactly one message was delivered before it stopped");
  });

  test("delivers exactly as many as it was allowed when that is all there is", () => {
    const network = createNetwork("one", "two");
    network.connect("one", "two");
    assert.equal(network.deliverAll({ maximumDeliveries: 2 }), 2);
  });

  test("delivers in the order sent unless told to pick at random", () => {
    const network = createNetwork("one", "two");
    network.connect("one", "two");
    network.deliverAll();
    mineOn(network, "one");
    mineOn(network, "one");
    assert.equal(network.deliverAll(), 2);

    const reversed = createNetwork("one", "two");
    reversed.connect("one", "two");
    reversed.deliverAll();
    mineOn(reversed, "one");
    mineOn(reversed, "one");
    const deliveries = reversed.deliverAll({ random: () => 0.999 });

    assert.ok(deliveries > 2, "the second block came first, so its parent had to be asked for");
    assert.equal(agree(reversed, "one", "two"), true);
  });

  test("drops the messages in flight between two nodes when their link is cut", () => {
    const network = createNetwork("one", "two");
    network.connect("one", "two");
    network.deliverAll();
    mineOn(network, "one");
    assert.equal(network.pendingCount, 1);

    network.disconnect("one", "two");

    assert.equal(network.pendingCount, 0);
    assert.deepEqual(network.node("one").peers, []);
    assert.deepEqual(network.node("two").peers, []);
    network.deliverAll();
    assert.equal(network.node("two").tree.tip.block.header.height, 0n);
  });

  test("drops the messages in flight in both directions when a link is cut", () => {
    const network = createNetwork("one", "two");
    network.connect("one", "two");
    network.deliverAll();
    mineOn(network, "one");
    mineOn(network, "two");
    assert.equal(network.pendingCount, 2);

    network.disconnect("one", "two");

    assert.equal(network.pendingCount, 0);
  });

  test("keeps the messages in flight on other links when one link is cut", () => {
    const network = createNetwork("one", "two", "three");
    network.connect("one", "two");
    network.connect("one", "three");
    network.deliverAll();
    mineOn(network, "one");
    assert.equal(network.pendingCount, 2);

    network.disconnect("one", "two");

    assert.equal(network.pendingCount, 1);
    network.deliverAll();
    assert.equal(agree(network, "one", "three"), true);
  });
});

describe("spreading blocks and transactions", () => {
  test("passes a block along a line of nodes until every one has it", () => {
    const network = createNetwork("one", "two", "three");
    network.connect("one", "two");
    network.connect("two", "three");
    network.deliverAll();

    const block = mineOn(network, "one");
    network.deliverAll();

    assert.deepEqual(tipsOf(network, "one", "two", "three"), [
      hashOf(block),
      hashOf(block),
      hashOf(block),
    ]);
  });

  test("carries a transaction to every pool, and every pool forgets it once a block takes it", () => {
    const network = createNetwork("one", "two", "three");
    network.connect("one", "two");
    network.connect("two", "three");
    network.deliverAll();
    const transaction = payment(0n, 3n);

    assert.deepEqual(network.submitTransaction("one", transaction), { status: "added" });
    network.deliverAll();
    for (const identifier of ["one", "two", "three"]) {
      assert.equal(network.node(identifier).pool.has(hashSignedTransaction(transaction)), true);
    }

    mineOn(network, "three");
    network.deliverAll();
    for (const identifier of ["one", "two", "three"]) {
      const node = network.node(identifier);
      assert.equal(node.pool.size, 0);
      assert.equal(getAccount(node.tree.tip.state, addressOfAccount(BOB)).balance, 1_010n);
    }
  });

  test("brings a node that joins late up to date, asking for every block it lacks", () => {
    const network = createNetwork("one", "two", "late");
    network.connect("one", "two");
    network.deliverAll();
    for (let count = 0; count < 4; count++) {
      clock.now += 10n;
      mineOn(network, "one");
    }
    network.deliverAll();

    network.connect("two", "late");
    network.deliverAll();

    assert.equal(agree(network, "one", "two", "late"), true);
    assert.equal(network.node("late").tree.tip.block.header.height, 4n);
    assert.equal(network.node("late").tree.orphanCount, 0);
  });
});

describe("a network that splits and joins again", () => {
  /** Builds the two halves, one with nodes one and two, the other with three and four. */
  const createSplitNetwork = (): SimulatedNetwork => {
    const network = createNetwork("one", "two", "three", "four");
    network.connect("one", "two");
    network.connect("three", "four");
    network.deliverAll();
    return network;
  };

  test("lets each half agree inside itself while the halves disagree", () => {
    const network = createSplitNetwork();
    mineOn(network, "one");
    clock.now += 10n;
    mineOn(network, "three");
    network.deliverAll();

    assert.equal(agree(network, "one", "two"), true);
    assert.equal(agree(network, "three", "four"), true);
    assert.equal(agree(network, "one", "three"), false);
  });

  test("moves the half with less work onto the chain with more once they join", () => {
    const network = createSplitNetwork();
    mineOn(network, "one");
    clock.now += 10n;
    mineOn(network, "one");
    mineOn(network, "three");
    network.deliverAll();

    network.connect("two", "three");
    network.deliverAll();

    assert.equal(agree(network, "one", "two", "three", "four"), true);
    assert.equal(network.node("four").tree.tip.block.header.height, 2n);
  });

  test("returns the transactions of the abandoned branch to the pools that held them", () => {
    const network = createSplitNetwork();
    const abandoned = payment(0n, 3n);
    network.submitTransaction("three", abandoned);
    network.deliverAll();
    mineOn(network, "three");
    clock.now += 10n;
    mineOn(network, "one");
    clock.now += 10n;
    mineOn(network, "one");
    network.deliverAll();
    assert.equal(network.node("three").pool.size, 0);

    network.connect("two", "three");
    network.deliverAll();

    for (const identifier of ["three", "four"]) {
      assert.equal(network.node(identifier).pool.has(hashSignedTransaction(abandoned)), true);
    }
    assert.equal(network.node("one").pool.size, 0);
    assert.equal(
      getAccount(network.node("three").tree.tip.state, addressOfAccount(BOB)).balance,
      1_000n,
    );
  });

  test("stays split when both halves have the same work, until one more block breaks the tie", () => {
    const network = createSplitNetwork();
    mineOn(network, "one");
    clock.now += 10n;
    mineOn(network, "three");
    network.deliverAll();

    network.connect("two", "three");
    network.deliverAll();
    assert.equal(agree(network, "one", "two"), true);
    assert.equal(agree(network, "three", "four"), true);
    assert.equal(agree(network, "one", "three"), false);

    clock.now += 10n;
    const decisive = mineOn(network, "one");
    network.deliverAll();

    assert.deepEqual(
      tipsOf(network, "one", "two", "three", "four"),
      Array(4).fill(hashOf(decisive)),
    );
  });
});

describe("agreement however the messages are ordered", () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    test(`ends on one chain after competing blocks and a shuffled delivery (seed ${seed})`, () => {
      const identifiers = ["one", "two", "three", "four"];
      const network = createNetwork(...identifiers);
      for (const [index, first] of identifiers.entries()) {
        for (const second of identifiers.slice(index + 1)) {
          network.connect(first, second);
        }
      }
      const random = createSeededRandom(seed);
      network.deliverAll({ random });

      for (let round = 0; round < 4; round++) {
        clock.now += 10n;
        for (const identifier of identifiers) {
          mineOn(network, identifier);
        }
        network.deliverAll({ random });
      }
      clock.now += 10n;
      mineOn(network, "one");
      network.deliverAll({ random });

      assert.equal(agree(network, ...identifiers), true);
      for (const identifier of identifiers) {
        const node = network.node(identifier);
        assert.equal(node.tree.orphanCount, 0);
        assert.deepEqual(
          computeStateRoot(node.tree.tip.state),
          computeStateRoot(network.node("one").tree.tip.state),
        );
        assert.equal(node.tree.tip.block.header.height, 5n);
      }
    });
  }
});
