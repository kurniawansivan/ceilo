import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { type Block, createBlock, createGenesisBlock } from "./block.ts";
import type { TipChange } from "./blocktree.ts";
import { Mempool } from "./mempool.ts";
import {
  applyTransaction,
  type ChainState,
  createGenesisState,
  getAccount,
  type TransactionRejection,
} from "./state.ts";
import {
  addressOfAccount,
  createPlaceholderStateRoot,
  createSeededRandom,
  elementAt,
  signTransfer,
} from "./testing.ts";
import { hashSignedTransaction, recoverSender, type SignedTransaction } from "./transaction.ts";
import { MAXIMUM_TARGET } from "./work.ts";

const CHAIN_IDENTIFIER = 1337n;
const RICH_BALANCE = 10_000n;
const POOR_ACCOUNT = 6;
const POOR_BALANCE = 100n;
const THIN_ACCOUNT = 7;
const THIN_BALANCE = 10n;
const MINER = 5;
const RECIPIENT = 9;

const state = createGenesisState(CHAIN_IDENTIFIER, [
  ...[1, 2, 3, 4].map((accountNumber) => ({
    address: addressOfAccount(accountNumber),
    balance: RICH_BALANCE,
  })),
  { address: addressOfAccount(POOR_ACCOUNT), balance: POOR_BALANCE },
  { address: addressOfAccount(THIN_ACCOUNT), balance: THIN_BALANCE },
]);

/** Signs a payment from a numbered account to the recipient. */
const payment = (from: number, nonce: bigint, fee: bigint, amount = 10n): SignedTransaction =>
  signTransfer({ from, to: RECIPIENT, amount, fee, nonce });

/** Returns the state after applying transactions in order, failing the test if one is refused. */
const stateAfter = (start: ChainState, ...transactions: SignedTransaction[]): ChainState => {
  let current = start;
  for (const transaction of transactions) {
    const result = applyTransaction(current, transaction, addressOfAccount(MINER));
    if (!result.valid) {
      assert.fail(`transaction was refused: ${result.reason}`);
    }
    current = result.state;
  }
  return current;
};

/** Builds a block that carries the transactions, which is all a tip change needs of it. */
const blockWith = (transactions: readonly SignedTransaction[]): Block =>
  createBlock({
    parentHeader: createGenesisBlock({
      timestamp: 1_000n,
      stateRoot: createPlaceholderStateRoot(),
      target: MAXIMUM_TARGET,
    }).header,
    transactions,
    timestamp: 1_010n,
    beneficiary: addressOfAccount(MINER),
    stateRoot: createPlaceholderStateRoot(),
  });

/** Adds a transaction, failing the test unless the pool took it. */
const addAccepted = (pool: Mempool, poolState: ChainState, transaction: SignedTransaction) => {
  const outcome = pool.add(poolState, transaction);
  if (outcome.status === "rejected") {
    assert.fail(`the pool refused the transaction: ${outcome.reason}`);
  }
  return outcome;
};

describe("a new mempool", () => {
  test("is empty", () => {
    const pool = new Mempool();
    assert.equal(pool.size, 0);
    assert.deepEqual(pool.pending(), []);
  });

  test("needs room for at least one transaction", () => {
    assert.throws(() => new Mempool(0), RangeError);
    assert.throws(() => new Mempool(-3), RangeError);
    assert.throws(() => new Mempool(1.5), RangeError);
    assert.equal(new Mempool(1).size, 0);
  });
});

describe("adding transactions", () => {
  test("takes a valid one", () => {
    const pool = new Mempool();
    const transaction = payment(1, 0n, 2n);

    assert.deepEqual(pool.add(state, transaction), { status: "added" });
    assert.equal(pool.size, 1);
    assert.equal(pool.has(hashSignedTransaction(transaction)), true);
  });

  test("refuses one it already holds", () => {
    const pool = new Mempool();
    const transaction = payment(1, 0n, 2n);
    pool.add(state, transaction);

    assert.deepEqual(pool.add(state, transaction), { status: "rejected", reason: "already-known" });
    assert.equal(pool.size, 1);
  });

  test("refuses what a block would refuse, naming the same reason, and keeps nothing", () => {
    const signed = payment(1, 0n, 2n);
    const cases: Record<string, [SignedTransaction, TransactionRejection]> = {
      "a recipient of the wrong length": [
        { ...signed, recipient: new Uint8Array(19) },
        "malformed-transaction",
      ],
      "a negative amount": [{ ...signed, amount: -1n }, "value-out-of-range"],
      "another chain": [
        signTransfer({
          from: 1,
          to: RECIPIENT,
          amount: 10n,
          fee: 2n,
          nonce: 0n,
          chainIdentifier: 1n,
        }),
        "wrong-chain",
      ],
      "a fee below the minimum": [payment(1, 0n, 0n), "fee-too-low"],
      "a garbage signature": [{ ...signed, signature: new Uint8Array(65) }, "invalid-signature"],
      "a sender who cannot pay": [payment(THIN_ACCOUNT, 0n, 2n, 50n), "insufficient-balance"],
    };

    for (const [description, [transaction, reason]] of Object.entries(cases)) {
      const pool = new Mempool();
      assert.deepEqual(pool.add(state, transaction), { status: "rejected", reason }, description);
      assert.equal(pool.size, 0, description);
    }
  });

  test("refuses a nonce the account has already used", () => {
    const pool = new Mempool();
    const advanced = stateAfter(state, payment(1, 0n, 2n));

    assert.deepEqual(pool.add(advanced, payment(1, 0n, 5n)), {
      status: "rejected",
      reason: "nonce-mismatch",
    });
  });

  test("keeps a nonce that is ahead of the account, queued until its turn", () => {
    const pool = new Mempool();
    assert.deepEqual(pool.add(state, payment(1, 3n, 2n)), { status: "added" });
    assert.equal(pool.size, 1);
  });

  test("lists what it holds in the order it arrived", () => {
    const pool = new Mempool();
    const first = payment(2, 0n, 9n);
    const second = payment(1, 0n, 2n);
    const third = payment(3, 0n, 5n);
    for (const transaction of [first, second, third]) {
      addAccepted(pool, state, transaction);
    }

    assert.deepEqual(pool.pending(), [first, second, third]);
  });
});

describe("replacing a transaction", () => {
  test("lets one that pays a higher fee take the place of the same sender and nonce", () => {
    const pool = new Mempool();
    const original = payment(1, 0n, 2n);
    const bumped = payment(1, 0n, 3n);
    pool.add(state, original);

    assert.deepEqual(pool.add(state, bumped), { status: "replaced", replaced: original });
    assert.equal(pool.size, 1);
    assert.equal(pool.has(hashSignedTransaction(bumped)), true);
    assert.equal(pool.has(hashSignedTransaction(original)), false);
  });

  test("refuses one that pays the same or a lower fee, leaving the original in place", () => {
    const pool = new Mempool();
    const original = payment(1, 0n, 5n);
    pool.add(state, original);

    for (const fee of [5n, 4n, 1n]) {
      assert.deepEqual(pool.add(state, payment(1, 0n, fee, 11n)), {
        status: "rejected",
        reason: "replacement-fee-too-low",
      });
    }
    assert.deepEqual(pool.pending(), [original]);
  });

  test("does not treat a different nonce from the same sender as a replacement", () => {
    const pool = new Mempool();
    addAccepted(pool, state, payment(1, 0n, 2n));
    assert.deepEqual(pool.add(state, payment(1, 1n, 2n)), { status: "added" });
    assert.equal(pool.size, 2);
  });

  test("still checks the replacement itself, so a bad one cannot displace a good one", () => {
    const pool = new Mempool();
    const original = payment(1, 0n, 2n);
    pool.add(state, original);
    const forged = { ...payment(1, 0n, 9n), signature: new Uint8Array(65) };

    assert.deepEqual(pool.add(state, forged), { status: "rejected", reason: "invalid-signature" });
    assert.deepEqual(pool.pending(), [original]);
  });
});

describe("a full mempool", () => {
  test("drops its lowest-fee transaction to make room for one that pays more", () => {
    const pool = new Mempool(3);
    const lowest = payment(1, 0n, 2n);
    addAccepted(pool, state, lowest);
    addAccepted(pool, state, payment(2, 0n, 3n));
    addAccepted(pool, state, payment(3, 0n, 4n));

    assert.deepEqual(pool.add(state, payment(4, 0n, 5n)), { status: "added" });
    assert.equal(pool.size, 3);
    assert.equal(pool.has(hashSignedTransaction(lowest)), false);
  });

  test("refuses a newcomer that pays no more than its lowest-fee transaction", () => {
    const pool = new Mempool(2);
    addAccepted(pool, state, payment(1, 0n, 3n));
    addAccepted(pool, state, payment(2, 0n, 4n));

    for (const fee of [3n, 2n]) {
      assert.deepEqual(pool.add(state, payment(3, 0n, fee)), {
        status: "rejected",
        reason: "pool-full",
      });
    }
    assert.equal(pool.size, 2);
  });

  test("drops the newest of the lowest-fee transactions, so earlier arrivals keep their place", () => {
    const pool = new Mempool(2);
    const earlier = payment(1, 0n, 2n);
    const later = payment(2, 0n, 2n);
    addAccepted(pool, state, earlier);
    addAccepted(pool, state, later);
    addAccepted(pool, state, payment(3, 0n, 3n));

    assert.equal(pool.has(hashSignedTransaction(earlier)), true);
    assert.equal(pool.has(hashSignedTransaction(later)), false);
  });

  test("lets a replacement through without dropping anything, even when full", () => {
    const pool = new Mempool(2);
    addAccepted(pool, state, payment(1, 0n, 2n));
    addAccepted(pool, state, payment(2, 0n, 3n));

    assert.equal(pool.add(state, payment(1, 0n, 4n)).status, "replaced");
    assert.equal(pool.size, 2);
  });
});

describe("selecting transactions for a block", () => {
  const miner = addressOfAccount(MINER);

  test("takes the highest fee first", () => {
    const pool = new Mempool();
    for (const [from, fee] of [
      [1, 2n],
      [2, 5n],
      [3, 3n],
    ] as const) {
      addAccepted(pool, state, payment(from, 0n, fee));
    }

    assert.deepEqual(
      pool.select(state, miner, 10).map((transaction) => transaction.fee),
      [5n, 3n, 2n],
    );
  });

  test("keeps a sender's nonces in order, even when a later one pays more", () => {
    const pool = new Mempool();
    addAccepted(pool, state, payment(1, 0n, 1n));
    addAccepted(pool, state, payment(1, 1n, 9n));
    addAccepted(pool, state, payment(2, 0n, 5n));

    const selected = pool.select(state, miner, 10);
    assert.deepEqual(
      selected.map((transaction) => [transaction.nonce, transaction.fee]),
      [
        [0n, 5n],
        [0n, 1n],
        [1n, 9n],
      ],
    );
  });

  test("stops at the maximum count, keeping the best that fit", () => {
    const pool = new Mempool();
    for (const [from, fee] of [
      [1, 2n],
      [2, 6n],
      [3, 4n],
      [4, 8n],
    ] as const) {
      addAccepted(pool, state, payment(from, 0n, fee));
    }

    assert.deepEqual(
      pool.select(state, miner, 2).map((transaction) => transaction.fee),
      [8n, 6n],
    );
    assert.deepEqual(pool.select(state, miner, 0), []);
  });

  test("leaves out a transaction whose earlier nonce is missing, because it cannot run yet", () => {
    const pool = new Mempool();
    addAccepted(pool, state, payment(1, 2n, 9n));
    addAccepted(pool, state, payment(2, 0n, 1n));

    assert.deepEqual(
      pool.select(state, miner, 10).map((transaction) => transaction.fee),
      [1n],
    );
  });

  test("leaves out a later transaction once an earlier one has spent the funds it needs", () => {
    const pool = new Mempool();
    addAccepted(pool, state, payment(POOR_ACCOUNT, 0n, 2n, 90n));
    addAccepted(pool, state, payment(POOR_ACCOUNT, 1n, 2n, 90n));

    const selected = pool.select(state, miner, 10);
    assert.equal(selected.length, 1);
    assert.equal(elementAt(selected, 0).nonce, 0n);
  });

  test("counts the fees a sender earns as the beneficiary toward its later transactions", () => {
    const pool = new Mempool();
    addAccepted(pool, state, payment(THIN_ACCOUNT, 0n, 3n, 5n));
    addAccepted(pool, state, payment(THIN_ACCOUNT, 1n, 1n, 4n));

    assert.equal(pool.select(state, miner, 10).length, 1);
    assert.equal(pool.select(state, addressOfAccount(THIN_ACCOUNT), 10).length, 2);
  });

  test("breaks a tie in fee by arrival, earliest first", () => {
    const pool = new Mempool();
    const first = payment(3, 0n, 4n);
    const second = payment(1, 0n, 4n);
    const third = payment(2, 0n, 4n);
    for (const transaction of [first, second, third]) {
      addAccepted(pool, state, transaction);
    }

    assert.deepEqual(pool.select(state, miner, 10), [first, second, third]);
  });

  test("does not change the pool", () => {
    const pool = new Mempool();
    addAccepted(pool, state, payment(1, 0n, 2n));
    pool.select(state, miner, 10);
    assert.equal(pool.size, 1);
  });

  test("refuses a maximum count that is not a whole number of zero or more", () => {
    const pool = new Mempool();
    assert.throws(() => pool.select(state, miner, -1), RangeError);
    assert.throws(() => pool.select(state, miner, 1.5), RangeError);
  });

  test("always returns an order a block could apply, using as much room as the pool can fill", () => {
    const random = createSeededRandom(20_261_028);
    const pool = new Mempool();
    for (let attempt = 0; attempt < 120; attempt++) {
      const from = 1 + Math.floor(random() * 4);
      const nonce = BigInt(Math.floor(random() * 6));
      const fee = 1n + BigInt(Math.floor(random() * 9));
      const amount = BigInt(Math.floor(random() * 3_000));
      pool.add(state, payment(from, nonce, fee, amount));
    }

    const maximumCount = 12;
    const selected = pool.select(state, miner, maximumCount);
    let working = state;
    for (const transaction of selected) {
      const result = applyTransaction(working, transaction, miner);
      assert.ok(result.valid, "a selected transaction did not apply in order");
      working = result.state;
    }

    assert.ok(selected.length <= maximumCount);
    assert.equal(
      new Set(selected.map((transaction) => hashSignedTransaction(transaction))).size,
      selected.length,
    );
    if (selected.length < maximumCount) {
      for (const leftover of pool.pending()) {
        const nextNonce = getAccount(working, recoverSender(leftover)).nonce;
        if (leftover.nonce === nextNonce) {
          assert.equal(
            applyTransaction(working, leftover, miner).valid,
            false,
            "a runnable transaction was left out although there was room",
          );
        }
      }
    }
  });
});

describe("following the chain", () => {
  /** Builds the tip change for blocks added to the end of the chain. */
  const extended = (...attached: Block[]): TipChange => ({ kind: "extended", attached });

  test("forgets transactions a new block included, and keeps the rest", () => {
    const pool = new Mempool();
    const included = payment(1, 0n, 3n);
    const waiting = payment(2, 0n, 4n);
    addAccepted(pool, state, included);
    addAccepted(pool, state, waiting);

    pool.applyTipChange(stateAfter(state, included), extended(blockWith([included])));
    assert.deepEqual(pool.pending(), [waiting]);
  });

  test("forgets a transaction whose nonce a different transaction used in the block", () => {
    const pool = new Mempool();
    const mine = payment(1, 0n, 3n);
    const theirs = payment(1, 0n, 2n, 77n);
    addAccepted(pool, state, mine);

    pool.applyTipChange(stateAfter(state, theirs), extended(blockWith([theirs])));
    assert.equal(pool.size, 0);
  });

  test("forgets a queued transaction the sender can no longer afford", () => {
    const pool = new Mempool();
    const first = payment(POOR_ACCOUNT, 0n, 2n, 50n);
    const queued = payment(POOR_ACCOUNT, 1n, 2n, 90n);
    addAccepted(pool, state, first);
    addAccepted(pool, state, queued);

    pool.applyTipChange(stateAfter(state, first), extended(blockWith([first])));
    assert.equal(pool.size, 0);
  });

  test("keeps a queued transaction that has become runnable and affordable", () => {
    const pool = new Mempool();
    const first = payment(1, 0n, 2n);
    const queued = payment(1, 1n, 2n);
    addAccepted(pool, state, first);
    addAccepted(pool, state, queued);

    pool.applyTipChange(stateAfter(state, first), extended(blockWith([first])));
    assert.deepEqual(pool.pending(), [queued]);
  });

  test("returns the transactions of a block that a reorganization undid", () => {
    const pool = new Mempool();
    const undone = payment(1, 0n, 3n);

    pool.applyTipChange(state, {
      kind: "reorganized",
      detached: [blockWith([undone])],
      attached: [blockWith([])],
    });
    assert.deepEqual(pool.pending(), [undone]);
  });

  test("does not return one that the branch now winning also included", () => {
    const pool = new Mempool();
    const shared = payment(1, 0n, 3n);
    const onlyUndone = payment(2, 0n, 3n);
    const winningState = stateAfter(state, shared);

    pool.applyTipChange(winningState, {
      kind: "reorganized",
      detached: [blockWith([shared, onlyUndone])],
      attached: [blockWith([shared])],
    });
    assert.deepEqual(pool.pending(), [onlyUndone]);
  });

  test("does not return an undone transaction whose nonce is already used on the winning branch", () => {
    const pool = new Mempool();
    const undone = payment(1, 0n, 3n);
    const rival = payment(1, 0n, 2n, 77n);

    pool.applyTipChange(stateAfter(state, rival), {
      kind: "reorganized",
      detached: [blockWith([undone])],
      attached: [blockWith([rival])],
    });
    assert.equal(pool.size, 0);
  });

  test("changes nothing when the tip did not move", () => {
    const pool = new Mempool();
    const waiting = payment(1, 0n, 3n);
    addAccepted(pool, state, waiting);

    pool.applyTipChange(state, { kind: "unchanged" });
    assert.deepEqual(pool.pending(), [waiting]);
  });
});
