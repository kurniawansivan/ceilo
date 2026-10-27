import { type DoubleSpendReport, simulateDoubleSpend } from "./attack.ts";
import type { Block } from "./block.ts";
import { hashBlockHeader } from "./block.ts";
import type { ConsensusRules } from "./consensus.ts";
import { toHexadecimal } from "./hash.ts";
import { SimulatedNetwork } from "./network.ts";
import { NetworkNode } from "./node.ts";
import { createGenesis, getAccount } from "./state.ts";
import { addressOfAccount, signTransfer } from "./testing.ts";
import { hashSignedTransaction } from "./transaction.ts";
import { MAXIMUM_TARGET } from "./work.ts";

const GENESIS_TIMESTAMP = 1_700_000_000n;
const ROUND_SECONDS = 10n;
const ATTEMPT_COUNT = 10_000;
const ALICE_ACCOUNT = 1;
const BOB_ACCOUNT = 2;
const ALICE_ALLOCATION = 1_000n;
const BOB_ALLOCATION = 500n;
const PAYMENT_FROM_ALICE_TO_BOB = 50n;
const BLOCK_REWARD = 50n;
const NORTH_MINER_ACCOUNT = 5;
const NORTH_SECOND_ACCOUNT = 6;
const SOUTH_MINER_ACCOUNT = 7;
const SOUTH_SECOND_ACCOUNT = 8;
const HONEST_ATTEMPTS_PER_ROUND = 5;
const CONFIRMATIONS_REQUIRED = 2;
const MAXIMUM_ROUNDS = 100;
const ATTACKER_STRENGTHS = [0, 3, 10, 30, 100];

// Difficulty never changes here, so the halves of a split network mine at the same pace.
const RULES: ConsensusRules = {
  targetBlockIntervalInSeconds: ROUND_SECONDS,
  retargetWindowInBlocks: 1_000_000n,
  maximumTarget: MAXIMUM_TARGET,
  maximumAdjustmentFactor: 4n,
  futureTimeLimitInSeconds: 30n,
};

/** What happens when a network splits into two halves that mine on their own and then join again. */
export type PartitionDemonstration = {
  readonly northBlocksMined: number;
  readonly southBlocksMined: number;
  readonly halvesAgreeInside: boolean;
  readonly halvesAgreeWithEachOther: boolean;
  readonly agreedAfterJoining: boolean;
  readonly finalHeight: bigint;
  /** Blocks the south half mined that are no longer on the chain every node follows. */
  readonly abandonedBlockCount: number;
  readonly paymentBackInPool: boolean;
  readonly bobBalanceOnSouthBeforeJoining: bigint;
  readonly bobBalanceOnSouthAfterJoining: bigint;
};

/** One attacker strength and how the double spend went against it. */
export type DoubleSpendRow = {
  readonly attackerAttemptsPerRound: number;
  readonly report: DoubleSpendReport;
};

/** Everything the network sections of the demonstration show. */
export type NetworkDemonstration = {
  readonly partition: PartitionDemonstration;
  readonly doubleSpends: readonly DoubleSpendRow[];
};

/** Splits four nodes into two halves, lets each mine, joins them, and records who agrees with whom. */
function runPartition(): PartitionDemonstration {
  const clock = { now: GENESIS_TIMESTAMP };
  const genesis = createGenesis({
    chainIdentifier: 1337n,
    timestamp: GENESIS_TIMESTAMP,
    target: MAXIMUM_TARGET / 16n,
    blockReward: BLOCK_REWARD,
    allocations: [
      { address: addressOfAccount(ALICE_ACCOUNT), balance: ALICE_ALLOCATION },
      { address: addressOfAccount(BOB_ACCOUNT), balance: BOB_ALLOCATION },
    ],
  });
  /** Creates a node on the shared genesis and clock that mines for one account. */
  const createNode = (identifier: string, minerAccount: number): NetworkNode =>
    new NetworkNode({
      identifier,
      genesis,
      rules: RULES,
      beneficiary: addressOfAccount(minerAccount),
      clock: () => clock.now,
    });
  const network = new SimulatedNetwork([
    createNode("north-one", NORTH_MINER_ACCOUNT),
    createNode("north-two", NORTH_SECOND_ACCOUNT),
    createNode("south-one", SOUTH_MINER_ACCOUNT),
    createNode("south-two", SOUTH_SECOND_ACCOUNT),
  ]);
  /** Tells whether every named node follows the same tip. */
  const agree = (...identifiers: string[]): boolean =>
    new Set(identifiers.map((identifier) => toHexadecimal(network.node(identifier).tree.tip.hash)))
      .size === 1;
  /** Reads Bob's balance as the south node sees it at its tip. */
  const bobBalanceOnSouth = (): bigint =>
    getAccount(network.node("south-one").tree.tip.state, addressOfAccount(BOB_ACCOUNT)).balance;
  /** Has a node mine the next block a moment later than the last one. */
  const mine = (identifier: string): Block | undefined => {
    clock.now += ROUND_SECONDS;
    network.deliverAll();
    return network.mineBlock(identifier, ATTEMPT_COUNT);
  };

  network.connect("north-one", "north-two");
  network.connect("south-one", "south-two");
  network.deliverAll();

  const payment = signTransfer({
    from: ALICE_ACCOUNT,
    to: BOB_ACCOUNT,
    amount: PAYMENT_FROM_ALICE_TO_BOB,
    fee: 2n,
    nonce: 0n,
  });
  network.submitTransaction("south-one", payment);
  network.deliverAll();
  const southBlocks = [mine("south-one")];
  const northBlocks = [mine("north-one"), mine("north-one")];
  network.deliverAll();

  const halvesAgreeInside = agree("north-one", "north-two") && agree("south-one", "south-two");
  const halvesAgreeWithEachOther = agree("north-one", "south-one");
  const bobBalanceOnSouthBeforeJoining = bobBalanceOnSouth();

  network.connect("north-two", "south-one");
  network.deliverAll();

  const finalChain = new Set(
    network
      .node("north-one")
      .tree.bestChain()
      .map((stored) => toHexadecimal(stored.hash)),
  );
  const minedOnSouth = southBlocks.filter((block) => block !== undefined);
  return {
    northBlocksMined: northBlocks.filter((block) => block !== undefined).length,
    southBlocksMined: minedOnSouth.length,
    halvesAgreeInside,
    halvesAgreeWithEachOther,
    agreedAfterJoining: agree("north-one", "north-two", "south-one", "south-two"),
    finalHeight: network.node("south-one").tree.tip.block.header.height,
    abandonedBlockCount: minedOnSouth.filter(
      (block) => !finalChain.has(toHexadecimal(hashBlockHeader(block.header))),
    ).length,
    paymentBackInPool: network.node("south-one").pool.has(hashSignedTransaction(payment)),
    bobBalanceOnSouthBeforeJoining,
    bobBalanceOnSouthAfterJoining: bobBalanceOnSouth(),
  };
}

/** Plays the double spend against honest miners with each of the attacker strengths. */
function runDoubleSpends(): DoubleSpendRow[] {
  return ATTACKER_STRENGTHS.map((attackerAttemptsPerRound) => ({
    attackerAttemptsPerRound,
    report: simulateDoubleSpend({
      honestAttemptsPerRound: HONEST_ATTEMPTS_PER_ROUND,
      attackerAttemptsPerRound,
      confirmationsRequired: CONFIRMATIONS_REQUIRED,
      maximumRounds: MAXIMUM_ROUNDS,
    }),
  }));
}

/** Runs the split-and-join story and the double spends, without printing anything. */
export function runNetworkDemonstration(): NetworkDemonstration {
  return { partition: runPartition(), doubleSpends: runDoubleSpends() };
}

/** Says yes or no. */
function yesOrNo(answer: boolean): string {
  return answer ? "yes" : "no";
}

/** Lays out the partition story. */
function formatPartition(partition: PartitionDemonstration): string[] {
  return [
    "4. Consensus: nodes that split and agree again",
    "   four nodes, in two halves with no link between them, mine on their own",
    `   north mined ${partition.northBlocksMined} blocks, south mined ${partition.southBlocksMined} (it holds Alice's payment to Bob)`,
    `   each half agrees inside itself: ${yesOrNo(partition.halvesAgreeInside)}; the halves agree with each other: ${yesOrNo(partition.halvesAgreeWithEachOther)}`,
    `   after one link is back, all four follow the same chain (height ${partition.finalHeight}): ${yesOrNo(partition.agreedAfterJoining)}`,
    `   blocks abandoned by the half with less work: ${partition.abandonedBlockCount}; the payment is back in the pool: ${yesOrNo(partition.paymentBackInPool)}`,
    `   Bob's balance as the south node sees it: ${partition.bobBalanceOnSouthBeforeJoining} before, ${partition.bobBalanceOnSouthAfterJoining} after`,
  ];
}

/** Lays out one attacker strength: its share of the hashing and how the double spend ended. */
function formatDoubleSpendRow(row: DoubleSpendRow): string {
  const { report } = row;
  const share = `${Math.round(report.attackerShare * 100)}%`.padStart(4);
  if (!report.succeeded) {
    return `   ${share}   the payment stands: after the merchant shipped, the secret chain never had more work in ${report.rounds} rounds`;
  }
  return `   ${share}   reversed in round ${report.releasedAtRound}: secret chain ${report.attackerHeightAtRelease} blocks against ${report.honestHeightAtRelease}; merchant ${report.merchantBalanceWhenShipped} to ${report.merchantBalanceAtEnd}, attacker's savings 0 to ${report.attackerSavingsAtEnd}`;
}

/** Lays out the table of double spends and the lesson about hash power. */
function formatDoubleSpends(rows: readonly DoubleSpendRow[]): string[] {
  return [
    "5. A majority of hash power can undo a payment the merchant accepted",
    `   two honest miners; the merchant ships after ${CONFIRMATIONS_REQUIRED} confirmations; the attacker mines a secret chain with a conflicting payment`,
    "   hash share of the attacker, and the result",
    ...rows.map((row) => formatDoubleSpendRow(row)),
    "   The attacker publishes only once the secret chain has more work than the honest one.",
    "   Below a majority the race is a gamble that mostly fails; with one, it is a matter of time.",
  ];
}

/** Renders sections four and five of the demonstration as lines of plain text. */
export function formatNetworkDemonstration(demonstration: NetworkDemonstration): string[] {
  return [
    ...formatPartition(demonstration.partition),
    "",
    ...formatDoubleSpends(demonstration.doubleSpends),
  ];
}
