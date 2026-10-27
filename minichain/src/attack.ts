import { equalBytes } from "@noble/curves/utils.js";

import type { ConsensusRules } from "./consensus.ts";
import { type Hash, toHexadecimal } from "./hash.ts";
import { SimulatedNetwork } from "./network.ts";
import { NetworkNode } from "./node.ts";
import { createGenesis, getAccount } from "./state.ts";
import { addressOfAccount, signTransfer } from "./testing.ts";
import { hashSignedTransaction } from "./transaction.ts";
import { MAXIMUM_TARGET } from "./work.ts";

/** What the attacker pays the merchant, and then takes back. */
export const PAYMENT_AMOUNT = 100n;

const GENESIS_TIMESTAMP = 1_700_000_000n;
const ROUND_SECONDS = 10n;
// One attempt in this many meets the target, so a miner with N attempts a round finds a block about N times in 100.
const ATTEMPT_ODDS = 100n;
const BLOCK_REWARD = 50n;
const ATTACKER_ACCOUNT = 1;
const MERCHANT_ACCOUNT = 2;
const ATTACKER_SAVINGS_ACCOUNT = 3;
const FIRST_HONEST_MINER_ACCOUNT = 5;
const SECOND_HONEST_MINER_ACCOUNT = 6;
const ATTACKER_MINER_ACCOUNT = 7;
const HONEST_MINERS = ["honest-one", "honest-two"];
const HONEST_NODES = [...HONEST_MINERS, "merchant"];

// Difficulty never changes here, which is the easiest case for an attacker; real chains retarget.
const RULES: ConsensusRules = {
  targetBlockIntervalInSeconds: ROUND_SECONDS,
  retargetWindowInBlocks: 1_000_000n,
  maximumTarget: MAXIMUM_TARGET,
  maximumAdjustmentFactor: 4n,
  futureTimeLimitInSeconds: 30n,
};

/** How strong each side is, how patient the merchant is, and how long the scenario may run. */
export type DoubleSpendParameters = {
  /** Nonces each of the two honest miners tries per round. */
  readonly honestAttemptsPerRound: number;
  /** Nonces the attacker tries per round; zero means no hash power at all. */
  readonly attackerAttemptsPerRound: number;
  /** Blocks on top of its payment, itself counted, that the merchant waits for before shipping. */
  readonly confirmationsRequired: number;
  readonly maximumRounds: number;
};

/** What happened: when the merchant shipped, when the attacker published, and who ends up with the money. */
export type DoubleSpendReport = {
  /** The attacker's part of all the nonces tried each round, from 0 to 1. */
  readonly attackerShare: number;
  /** How many rounds ran: up to the attacker's publication, or all of them. */
  readonly rounds: number;
  /** The round in which the merchant saw enough confirmations and shipped, if it did. */
  readonly confirmedAtRound: number | undefined;
  readonly confirmationsWhenShipped: number | undefined;
  readonly merchantBalanceWhenShipped: bigint | undefined;
  /** The round in which the attacker connected and published her secret chain, if she did. */
  readonly releasedAtRound: number | undefined;
  readonly honestHeightAtRelease: bigint | undefined;
  readonly attackerHeightAtRelease: bigint | undefined;
  /** True when the merchant shipped and no longer holds the payment at the end. */
  readonly succeeded: boolean;
  readonly merchantBalanceAtEnd: bigint;
  /** What the attacker's second account holds on the chain the merchant follows at the end. */
  readonly attackerSavingsAtEnd: bigint;
  readonly honestNodesAgree: boolean;
};

/** Throws unless the value is a whole number of at least the minimum. */
function assertWholeNumber(value: number, minimum: number, name: string): void {
  if (!Number.isInteger(value) || value < minimum) {
    throw new RangeError(`${name} must be a whole number of at least ${minimum}`);
  }
}

/** Counts the blocks a node's best chain has from a transaction's block to the tip, or zero if it is not on it. */
function countConfirmations(node: NetworkNode, transactionHash: Hash): number {
  const tipHeight = node.tree.tip.block.header.height;
  for (const stored of node.tree.bestChain()) {
    const includesTransaction = stored.block.transactions.some((transaction) =>
      equalBytes(hashSignedTransaction(transaction), transactionHash),
    );
    if (includesTransaction) {
      return Number(tipHeight - stored.block.header.height) + 1;
    }
  }
  return 0;
}

/** Plays a double spend: pay the merchant, mine a secret chain with a conflicting payment, publish it after the merchant ships if it has more work. */
export function simulateDoubleSpend(parameters: DoubleSpendParameters): DoubleSpendReport {
  assertWholeNumber(parameters.honestAttemptsPerRound, 1, "honest attempts per round");
  assertWholeNumber(parameters.attackerAttemptsPerRound, 0, "attacker attempts per round");
  assertWholeNumber(parameters.confirmationsRequired, 1, "confirmations required");
  assertWholeNumber(parameters.maximumRounds, 1, "maximum rounds");

  const clock = { now: GENESIS_TIMESTAMP };
  const genesis = createGenesis({
    chainIdentifier: 1337n,
    timestamp: GENESIS_TIMESTAMP,
    target: MAXIMUM_TARGET / ATTEMPT_ODDS,
    blockReward: BLOCK_REWARD,
    allocations: [{ address: addressOfAccount(ATTACKER_ACCOUNT), balance: 1_000n }],
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
    createNode("honest-one", FIRST_HONEST_MINER_ACCOUNT),
    createNode("honest-two", SECOND_HONEST_MINER_ACCOUNT),
    createNode("merchant", MERCHANT_ACCOUNT),
    createNode("attacker", ATTACKER_MINER_ACCOUNT),
  ]);
  const merchant = network.node("merchant");
  const attacker = network.node("attacker");

  network.connect("honest-one", "honest-two");
  network.connect("honest-one", "merchant");
  network.connect("honest-two", "merchant");
  network.deliverAll();

  const payment = signTransfer({
    from: ATTACKER_ACCOUNT,
    to: MERCHANT_ACCOUNT,
    amount: PAYMENT_AMOUNT,
    fee: 2n,
    nonce: 0n,
  });
  // The same account and nonce, so only one of the two payments can ever be part of a chain.
  const conflictingPayment = signTransfer({
    from: ATTACKER_ACCOUNT,
    to: ATTACKER_SAVINGS_ACCOUNT,
    amount: PAYMENT_AMOUNT,
    fee: 3n,
    nonce: 0n,
  });
  const paymentHash = hashSignedTransaction(payment);
  network.submitTransaction("honest-one", payment);
  network.submitTransaction("attacker", conflictingPayment);
  network.deliverAll();

  let rounds = 0;
  let confirmedAtRound: number | undefined;
  let confirmationsWhenShipped: number | undefined;
  let merchantBalanceWhenShipped: bigint | undefined;
  let releasedAtRound: number | undefined;
  let honestHeightAtRelease: bigint | undefined;
  let attackerHeightAtRelease: bigint | undefined;
  const merchantAddress = addressOfAccount(MERCHANT_ACCOUNT);

  for (let round = 1; round <= parameters.maximumRounds; round++) {
    rounds = round;
    clock.now += ROUND_SECONDS;
    for (const miner of HONEST_MINERS) {
      network.mineBlock(miner, parameters.honestAttemptsPerRound);
    }
    network.mineBlock("attacker", parameters.attackerAttemptsPerRound);
    network.deliverAll();

    const confirmations = countConfirmations(merchant, paymentHash);
    if (confirmedAtRound === undefined && confirmations >= parameters.confirmationsRequired) {
      confirmedAtRound = round;
      confirmationsWhenShipped = confirmations;
      merchantBalanceWhenShipped = getAccount(merchant.tree.tip.state, merchantAddress).balance;
    }
    const attackerHasMoreWork = attacker.tree.tip.cumulativeWork > merchant.tree.tip.cumulativeWork;
    if (confirmedAtRound !== undefined && attackerHasMoreWork) {
      releasedAtRound = round;
      honestHeightAtRelease = merchant.tree.tip.block.header.height;
      attackerHeightAtRelease = attacker.tree.tip.block.header.height;
      network.connect("attacker", "merchant");
      network.deliverAll();
      break;
    }
  }

  const merchantBalanceAtEnd = getAccount(merchant.tree.tip.state, merchantAddress).balance;
  const honestTips = HONEST_NODES.map((identifier) =>
    toHexadecimal(network.node(identifier).tree.tip.hash),
  );
  return {
    attackerShare:
      parameters.attackerAttemptsPerRound /
      (parameters.attackerAttemptsPerRound +
        HONEST_MINERS.length * parameters.honestAttemptsPerRound),
    rounds,
    confirmedAtRound,
    confirmationsWhenShipped,
    merchantBalanceWhenShipped,
    releasedAtRound,
    honestHeightAtRelease,
    attackerHeightAtRelease,
    succeeded: confirmedAtRound !== undefined && merchantBalanceAtEnd === 0n,
    merchantBalanceAtEnd,
    attackerSavingsAtEnd: getAccount(
      merchant.tree.tip.state,
      addressOfAccount(ATTACKER_SAVINGS_ACCOUNT),
    ).balance,
    honestNodesAgree: new Set(honestTips).size === 1,
  };
}
