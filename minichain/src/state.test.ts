import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  type Block,
  checkBlock,
  computeTransactionsRoot,
  createBlock,
  hashBlockHeader,
} from "./block.ts";
import { encode } from "./encoding.ts";
import { toHexadecimal } from "./hash.ts";
import { computeMerkleRoot } from "./merkle.ts";
import {
  applyBlock,
  applyTransaction,
  type ChainState,
  computeStateRoot,
  computeTotalSupply,
  createAccountProof,
  createGenesis,
  createGenesisState,
  getAccount,
  MAXIMUM_VALUE,
  MINIMUM_FEE,
  produceBlock,
  type TransactionRejection,
  verifyAccountProof,
} from "./state.ts";
import {
  addressOfAccount,
  createPlaceholderStateRoot,
  createSeededRandom,
  elementAt,
  flipFirstBit,
  signTransfer,
  type TransferParameters,
} from "./testing.ts";
import type { SignedTransaction } from "./transaction.ts";

const CHAIN_IDENTIFIER = 1337n;
const ALICE = 1;
const BOB = 2;
const CAROL = 3;
const DAVE = 4;
const ALICE_BALANCE = 1_000n;
const BOB_BALANCE = 500n;
const INITIAL_SUPPLY = ALICE_BALANCE + BOB_BALANCE;

const GENESIS_TIMESTAMP = 1_000n;
const INITIAL_ALLOCATIONS = [
  { address: addressOfAccount(ALICE), balance: ALICE_BALANCE },
  { address: addressOfAccount(BOB), balance: BOB_BALANCE },
];

const genesis = createGenesis({
  chainIdentifier: CHAIN_IDENTIFIER,
  timestamp: GENESIS_TIMESTAMP,
  allocations: INITIAL_ALLOCATIONS,
});
const initialState = genesis.state;

/** Reads an account by the small integer of its private key. */
const accountOf = (state: ChainState, accountNumber: number) =>
  getAccount(state, addressOfAccount(accountNumber));

/** Captures a state as text, so a test can tell whether it was modified. */
const snapshotOf = (state: ChainState): string =>
  JSON.stringify([
    state.chainIdentifier.toString(),
    [...state.accounts.entries()]
      .map(([key, account]) => [key, account.balance.toString(), account.nonce.toString()])
      .sort(),
  ]);

/** Applies a transaction, failing the test if it is rejected, and returns the new state. */
const applyAccepted = (
  state: ChainState,
  transaction: SignedTransaction,
  beneficiaryNumber = CAROL,
): ChainState => {
  const result = applyTransaction(state, transaction, addressOfAccount(beneficiaryNumber));
  if (!result.valid) {
    assert.fail(`transaction was rejected: ${result.reason}`);
  }
  return result.state;
};

/** Asserts a transaction is rejected for the given reason and the state is left untouched. */
const assertRejected = (
  state: ChainState,
  transaction: SignedTransaction,
  reason: TransactionRejection,
  beneficiaryNumber = CAROL,
): void => {
  const snapshotBefore = snapshotOf(state);
  assert.deepEqual(applyTransaction(state, transaction, addressOfAccount(beneficiaryNumber)), {
    valid: false,
    reason,
  });
  assert.equal(snapshotOf(state), snapshotBefore);
};

/** Builds a block carrying the transactions, whose fees go to the given account. */
const createTestBlock = (
  transactions: readonly SignedTransaction[],
  beneficiaryNumber = CAROL,
): Block =>
  createBlock({
    parentHeader: genesis.block.header,
    transactions,
    timestamp: GENESIS_TIMESTAMP + 10n,
    beneficiary: addressOfAccount(beneficiaryNumber),
    stateRoot: createPlaceholderStateRoot(),
  });

/** Produces a block from the initial state with its true state root, failing the test if a transaction is bad. */
const produceTestBlock = (
  transactions: readonly SignedTransaction[],
  beneficiaryNumber = CAROL,
): Block => {
  const production = produceBlock({
    parentState: initialState,
    parentHeader: genesis.block.header,
    transactions,
    timestamp: GENESIS_TIMESTAMP + 10n,
    beneficiary: addressOfAccount(beneficiaryNumber),
  });
  if (!production.valid) {
    assert.fail(
      `block could not be produced: ${production.reason} at ${production.transactionIndex}`,
    );
  }
  return production.block;
};

/** Describes a plain transfer from Alice to Bob that is valid in the initial state. */
const aliceToBob = (overrides: Partial<TransferParameters> = {}): TransferParameters => ({
  from: ALICE,
  to: BOB,
  amount: 100n,
  fee: 3n,
  nonce: 0n,
  ...overrides,
});

describe("createGenesisState", () => {
  test("gives each allocation its balance and a nonce of zero", () => {
    assert.deepEqual(accountOf(initialState, ALICE), { balance: ALICE_BALANCE, nonce: 0n });
    assert.deepEqual(accountOf(initialState, BOB), { balance: BOB_BALANCE, nonce: 0n });
  });

  test("treats an address that was never mentioned as an empty account", () => {
    assert.deepEqual(accountOf(initialState, DAVE), { balance: 0n, nonce: 0n });
  });

  test("has a total supply equal to the sum of the allocations", () => {
    assert.equal(computeTotalSupply(initialState), INITIAL_SUPPLY);
  });

  test("does not store an allocation of zero, so equal states look equal", () => {
    const state = createGenesisState(CHAIN_IDENTIFIER, [
      { address: addressOfAccount(ALICE), balance: 0n },
    ]);
    assert.equal(snapshotOf(state), snapshotOf(createGenesisState(CHAIN_IDENTIFIER, [])));
  });

  test("rejects the same address allocated twice", () => {
    assert.throws(
      () =>
        createGenesisState(CHAIN_IDENTIFIER, [
          { address: addressOfAccount(ALICE), balance: 1n },
          { address: addressOfAccount(ALICE), balance: 2n },
        ]),
      RangeError,
    );
  });

  test("rejects balances and chain identifiers outside the allowed range", () => {
    const allocationOf = (balance: bigint) => [{ address: addressOfAccount(ALICE), balance }];
    assert.throws(() => createGenesisState(CHAIN_IDENTIFIER, allocationOf(-1n)), RangeError);
    assert.throws(
      () => createGenesisState(CHAIN_IDENTIFIER, allocationOf(MAXIMUM_VALUE + 1n)),
      RangeError,
    );
    assert.throws(() => createGenesisState(-1n, []), RangeError);
    assert.throws(() => createGenesisState(MAXIMUM_VALUE + 1n, []), RangeError);
  });

  test("rejects an address of the wrong length", () => {
    assert.throws(
      () => createGenesisState(CHAIN_IDENTIFIER, [{ address: new Uint8Array(19), balance: 1n }]),
      RangeError,
    );
  });
});

describe("applyTransaction accepts", () => {
  test("a transfer: amount to the recipient, fee to the beneficiary, nonce up by one", () => {
    const state = applyAccepted(initialState, signTransfer(aliceToBob()));

    assert.deepEqual(accountOf(state, ALICE), { balance: ALICE_BALANCE - 103n, nonce: 1n });
    assert.deepEqual(accountOf(state, BOB), { balance: BOB_BALANCE + 100n, nonce: 0n });
    assert.deepEqual(accountOf(state, CAROL), { balance: 3n, nonce: 0n });
  });

  test("a transfer without changing the state it was applied to", () => {
    const snapshotBefore = snapshotOf(initialState);
    applyAccepted(initialState, signTransfer(aliceToBob()));
    assert.equal(snapshotOf(initialState), snapshotBefore);
  });

  test("consecutive transfers with consecutive nonces", () => {
    const afterFirst = applyAccepted(initialState, signTransfer(aliceToBob({ nonce: 0n })));
    const afterSecond = applyAccepted(afterFirst, signTransfer(aliceToBob({ nonce: 1n })));

    assert.equal(accountOf(afterSecond, ALICE).nonce, 2n);
    assert.equal(accountOf(afterSecond, ALICE).balance, ALICE_BALANCE - 206n);
  });

  test("an amount of zero, which only pays the fee", () => {
    const state = applyAccepted(initialState, signTransfer(aliceToBob({ amount: 0n })));
    assert.equal(accountOf(state, ALICE).balance, ALICE_BALANCE - 3n);
    assert.equal(accountOf(state, BOB).balance, BOB_BALANCE);
  });

  test("the smallest allowed fee", () => {
    const state = applyAccepted(initialState, signTransfer(aliceToBob({ fee: MINIMUM_FEE })));
    assert.equal(accountOf(state, CAROL).balance, MINIMUM_FEE);
  });

  test("spending the entire balance exactly, leaving the account with a nonce", () => {
    const state = applyAccepted(
      initialState,
      signTransfer(aliceToBob({ amount: ALICE_BALANCE - 3n, fee: 3n })),
    );
    assert.deepEqual(accountOf(state, ALICE), { balance: 0n, nonce: 1n });
  });

  test("an amount of zero to a new account, without creating an empty entry", () => {
    const state = applyAccepted(initialState, signTransfer(aliceToBob({ to: DAVE, amount: 0n })));
    assert.equal(state.accounts.has(toHexadecimal(addressOfAccount(DAVE))), false);
    assert.equal(state.accounts.size, 3);
  });

  describe("when the same account plays several roles", () => {
    test("sender and recipient: only the fee is lost", () => {
      const state = applyAccepted(initialState, signTransfer(aliceToBob({ to: ALICE })));
      assert.deepEqual(accountOf(state, ALICE), { balance: ALICE_BALANCE - 3n, nonce: 1n });
    });

    test("sender and beneficiary: only the amount is lost", () => {
      const state = applyAccepted(initialState, signTransfer(aliceToBob()), ALICE);
      assert.deepEqual(accountOf(state, ALICE), { balance: ALICE_BALANCE - 100n, nonce: 1n });
      assert.deepEqual(accountOf(state, BOB), { balance: BOB_BALANCE + 100n, nonce: 0n });
    });

    test("recipient and beneficiary: both credits land on one account", () => {
      const state = applyAccepted(initialState, signTransfer(aliceToBob()), BOB);
      assert.deepEqual(accountOf(state, BOB), { balance: BOB_BALANCE + 103n, nonce: 0n });
    });

    test("all three: nothing is lost, and the nonce still moves", () => {
      const state = applyAccepted(initialState, signTransfer(aliceToBob({ to: ALICE })), ALICE);
      assert.deepEqual(accountOf(state, ALICE), { balance: ALICE_BALANCE, nonce: 1n });
    });
  });

  test("any transfer without changing the total supply", () => {
    const state = applyAccepted(initialState, signTransfer(aliceToBob()));
    assert.equal(computeTotalSupply(state), INITIAL_SUPPLY);
  });
});

describe("applyTransaction rejects", () => {
  test("a transaction signed for another chain", () => {
    assertRejected(
      initialState,
      signTransfer(aliceToBob({ chainIdentifier: 1338n })),
      "wrong-chain",
    );
  });

  test("a fee below the minimum, including zero", () => {
    assertRejected(initialState, signTransfer(aliceToBob({ fee: 0n })), "fee-too-low");
    assert.equal(MINIMUM_FEE, 1n);
  });

  test("a nonce that was already used, so a transaction cannot be replayed", () => {
    const transaction = signTransfer(aliceToBob());
    const afterFirstUse = applyAccepted(initialState, transaction);
    assertRejected(afterFirstUse, transaction, "nonce-mismatch");
  });

  test("a nonce that skips ahead, leaving a gap", () => {
    assertRejected(initialState, signTransfer(aliceToBob({ nonce: 1n })), "nonce-mismatch");
  });

  test("a cost of one more than the balance, but not exactly the balance", () => {
    assertRejected(
      initialState,
      signTransfer(aliceToBob({ amount: ALICE_BALANCE - 2n, fee: 3n })),
      "insufficient-balance",
    );
  });

  test("a sender with no funds at all", () => {
    assertRejected(initialState, signTransfer(aliceToBob({ from: DAVE })), "insufficient-balance");
  });

  test("a transaction whose amount was changed after signing, which recovers a stranger", () => {
    const signed = signTransfer(aliceToBob());
    const tampered = { ...signed, amount: signed.amount + 1n };

    assertRejected(initialState, tampered, "insufficient-balance");
    assert.deepEqual(accountOf(initialState, ALICE), { balance: ALICE_BALANCE, nonce: 0n });
  });

  describe("a signature that is not valid", () => {
    const signed = signTransfer(aliceToBob());

    test("all zeros", () => {
      const forged = { ...signed, signature: new Uint8Array(65) };
      assertRejected(initialState, forged, "invalid-signature");
    });

    test("the wrong length", () => {
      const forged = { ...signed, signature: signed.signature.slice(1) };
      assertRejected(initialState, forged, "invalid-signature");
    });

    test("a recovery byte other than 0 or 1", () => {
      const signature = Uint8Array.from(signed.signature);
      signature[0] = 2;
      assertRejected(initialState, { ...signed, signature }, "invalid-signature");
    });
  });

  describe("values outside the allowed range", () => {
    const signed = signTransfer(aliceToBob());

    test("a negative amount, fee or nonce", () => {
      assertRejected(initialState, { ...signed, amount: -1n }, "value-out-of-range");
      assertRejected(initialState, { ...signed, fee: -1n }, "value-out-of-range");
      assertRejected(initialState, { ...signed, nonce: -1n }, "value-out-of-range");
    });

    test("an amount, fee, nonce or chain identifier above the maximum", () => {
      assertRejected(initialState, { ...signed, amount: MAXIMUM_VALUE + 1n }, "value-out-of-range");
      assertRejected(initialState, { ...signed, fee: MAXIMUM_VALUE + 1n }, "value-out-of-range");
      assertRejected(initialState, { ...signed, nonce: MAXIMUM_VALUE + 1n }, "value-out-of-range");
      assertRejected(
        initialState,
        { ...signed, chainIdentifier: MAXIMUM_VALUE + 1n },
        "value-out-of-range",
      );
    });

    test("an amount at the maximum is in range, and only fails for lack of funds", () => {
      assertRejected(
        initialState,
        signTransfer(aliceToBob({ amount: MAXIMUM_VALUE })),
        "insufficient-balance",
      );
    });
  });

  describe("a transaction that is malformed", () => {
    const signed = signTransfer(aliceToBob());

    test("a recipient of the wrong length", () => {
      assertRejected(
        initialState,
        { ...signed, recipient: new Uint8Array(19) },
        "malformed-transaction",
      );
    });

    test("an amount that is a plain number, as untyped network input might be", () => {
      const untyped = { ...signed, amount: 100 } as unknown as SignedTransaction;
      assertRejected(initialState, untyped, "malformed-transaction");
    });
  });

  describe("and reports the first broken rule when several are broken", () => {
    test("malformed comes before out of range", () => {
      const signed = signTransfer(aliceToBob());
      const broken = { ...signed, recipient: new Uint8Array(19), amount: -1n };
      assertRejected(initialState, broken, "malformed-transaction");
    });

    test("out of range comes before wrong chain", () => {
      const signed = signTransfer(aliceToBob({ chainIdentifier: 1338n }));
      assertRejected(initialState, { ...signed, amount: MAXIMUM_VALUE + 1n }, "value-out-of-range");
    });

    test("wrong chain comes before a low fee", () => {
      const signed = signTransfer(aliceToBob({ chainIdentifier: 1338n, fee: 0n }));
      assertRejected(initialState, signed, "wrong-chain");
    });

    test("a low fee comes before an invalid signature", () => {
      const signed = signTransfer(aliceToBob({ fee: 0n }));
      assertRejected(initialState, { ...signed, signature: new Uint8Array(65) }, "fee-too-low");
    });

    test("an invalid signature comes before a wrong nonce", () => {
      const signed = signTransfer(aliceToBob({ nonce: 5n }));
      assertRejected(
        initialState,
        { ...signed, signature: new Uint8Array(65) },
        "invalid-signature",
      );
    });

    test("a wrong nonce comes before insufficient funds", () => {
      assertRejected(
        initialState,
        signTransfer(aliceToBob({ nonce: 5n, amount: ALICE_BALANCE * 2n })),
        "nonce-mismatch",
      );
    });
  });
});

describe("what is a caller's mistake or a bug, rather than a rejected transaction", () => {
  test("a beneficiary that is not an address makes applyTransaction throw", () => {
    assert.throws(
      () => applyTransaction(initialState, signTransfer(aliceToBob()), new Uint8Array(19)),
      RangeError,
    );
  });

  test("a block header whose beneficiary is not an address makes applyBlock throw", () => {
    const block = createTestBlock([signTransfer(aliceToBob())]);
    const malformedBlock = {
      ...block,
      header: { ...block.header, beneficiary: new Uint8Array(19) },
    };
    assert.throws(() => applyBlock(initialState, malformedBlock), RangeError);
  });

  test("unexpected errors pass through instead of being called an invalid signature", () => {
    const signed = signTransfer(aliceToBob());
    const hostileSignature = new Uint8Array(65);
    Object.defineProperty(hostileSignature, "length", {
      get() {
        throw new Error("unexpected failure");
      },
    });

    assert.throws(
      () =>
        applyTransaction(
          initialState,
          { ...signed, signature: hostileSignature },
          addressOfAccount(CAROL),
        ),
      /unexpected failure/,
    );
  });
});

describe("applyBlock", () => {
  test("applies every transaction in order, paying all fees to the beneficiary", () => {
    const block = produceTestBlock([
      signTransfer(aliceToBob({ nonce: 0n, amount: 100n, fee: 3n })),
      signTransfer(aliceToBob({ nonce: 1n, amount: 50n, fee: 2n })),
      signTransfer({ from: BOB, to: ALICE, amount: 10n, fee: 1n, nonce: 0n }),
    ]);

    const result = applyBlock(initialState, block);
    assert.ok(result.valid);
    assert.deepEqual(accountOf(result.state, ALICE), { balance: 1_000n - 155n + 10n, nonce: 2n });
    assert.deepEqual(accountOf(result.state, BOB), { balance: 500n + 150n - 11n, nonce: 1n });
    assert.deepEqual(accountOf(result.state, CAROL), { balance: 6n, nonce: 0n });
    assert.equal(computeTotalSupply(result.state), INITIAL_SUPPLY);
  });

  test("lets a transaction spend what an earlier one in the same block delivered", () => {
    const block = produceTestBlock([
      signTransfer({ from: ALICE, to: DAVE, amount: 100n, fee: 1n, nonce: 0n }),
      signTransfer({ from: DAVE, to: BOB, amount: 60n, fee: 1n, nonce: 0n }),
    ]);

    const result = applyBlock(initialState, block);
    assert.ok(result.valid);
    assert.deepEqual(accountOf(result.state, DAVE), { balance: 100n - 60n - 1n, nonce: 1n });
  });

  test("depends on the order: the same two transactions reversed are rejected", () => {
    const block = createTestBlock([
      signTransfer({ from: DAVE, to: BOB, amount: 60n, fee: 1n, nonce: 0n }),
      signTransfer({ from: ALICE, to: DAVE, amount: 100n, fee: 1n, nonce: 0n }),
    ]);

    assert.deepEqual(applyBlock(initialState, block), {
      valid: false,
      transactionIndex: 0,
      reason: "insufficient-balance",
    });
  });

  test("accepts a block with no transactions and leaves the state as it was", () => {
    const result = applyBlock(initialState, produceTestBlock([]));
    assert.ok(result.valid);
    assert.equal(snapshotOf(result.state), snapshotOf(initialState));
  });

  test("rejects the whole block when one transaction is bad, naming it", () => {
    const snapshotBefore = snapshotOf(initialState);
    const block = createTestBlock([
      signTransfer(aliceToBob({ nonce: 0n })),
      signTransfer(aliceToBob({ nonce: 7n })),
      signTransfer(aliceToBob({ nonce: 1n })),
    ]);

    assert.deepEqual(applyBlock(initialState, block), {
      valid: false,
      transactionIndex: 1,
      reason: "nonce-mismatch",
    });
    assert.equal(snapshotOf(initialState), snapshotBefore);
  });

  test("rejects a double spend inside one block", () => {
    const block = createTestBlock([
      signTransfer({ from: BOB, to: ALICE, amount: 300n, fee: 1n, nonce: 0n }),
      signTransfer({ from: BOB, to: DAVE, amount: 300n, fee: 1n, nonce: 1n }),
    ]);

    assert.deepEqual(applyBlock(initialState, block), {
      valid: false,
      transactionIndex: 1,
      reason: "insufficient-balance",
    });
  });

  test("rejects the same transaction included twice in one block", () => {
    const transaction = signTransfer(aliceToBob());
    assert.deepEqual(applyBlock(initialState, createTestBlock([transaction, transaction])), {
      valid: false,
      transactionIndex: 1,
      reason: "nonce-mismatch",
    });
  });

  test("lets the beneficiary spend fees it earned earlier in the same block", () => {
    const block = produceTestBlock([
      signTransfer(aliceToBob({ nonce: 0n, fee: 10n })),
      signTransfer({ from: CAROL, to: DAVE, amount: 4n, fee: 1n, nonce: 0n }),
    ]);

    const result = applyBlock(initialState, block);
    assert.ok(result.valid);
    assert.deepEqual(accountOf(result.state, DAVE), { balance: 4n, nonce: 0n });
    assert.deepEqual(accountOf(result.state, CAROL), { balance: 10n - 5n + 1n, nonce: 1n });
  });
});

describe("computeStateRoot", () => {
  /** Orders account numbers by the hexadecimal text of their address, the order leaves are sorted in. */
  const byAddress = (left: number, right: number): number =>
    toHexadecimal(addressOfAccount(left)).localeCompare(toHexadecimal(addressOfAccount(right)));

  test("is the Merkle root of the chain identifier and the accounts sorted by address", () => {
    const balances = new Map([
      [ALICE, ALICE_BALANCE],
      [BOB, BOB_BALANCE],
    ]);
    const accountLeaves = [ALICE, BOB]
      .sort(byAddress)
      .map((accountNumber) =>
        encode([
          "ceilo/account",
          addressOfAccount(accountNumber),
          balances.get(accountNumber) ?? 0n,
          0n,
        ]),
      );

    assert.deepEqual(
      computeStateRoot(initialState),
      computeMerkleRoot([encode(["ceilo/chain-identifier", CHAIN_IDENTIFIER]), ...accountLeaves]),
    );
  });

  test("of a state with no accounts covers the chain identifier alone", () => {
    assert.deepEqual(
      computeStateRoot(createGenesisState(CHAIN_IDENTIFIER, [])),
      computeMerkleRoot([encode(["ceilo/chain-identifier", CHAIN_IDENTIFIER])]),
    );
  });

  test("does not depend on the order the allocations were listed in", () => {
    const reversedState = createGenesisState(CHAIN_IDENTIFIER, [...INITIAL_ALLOCATIONS].reverse());
    assert.deepEqual(computeStateRoot(reversedState), computeStateRoot(initialState));
  });

  test("changes with the chain identifier, a balance, a nonce or the set of accounts", () => {
    const afterTransfer = applyAccepted(initialState, signTransfer(aliceToBob({ amount: 0n })));
    const variants: Record<string, ChainState> = {
      "chain identifier": createGenesisState(CHAIN_IDENTIFIER + 1n, INITIAL_ALLOCATIONS),
      balance: createGenesisState(CHAIN_IDENTIFIER, [
        { address: addressOfAccount(ALICE), balance: ALICE_BALANCE + 1n },
        { address: addressOfAccount(BOB), balance: BOB_BALANCE },
      ]),
      "set of accounts": createGenesisState(CHAIN_IDENTIFIER, [
        ...INITIAL_ALLOCATIONS,
        { address: addressOfAccount(DAVE), balance: 1n },
      ]),
      "nonce and fee": afterTransfer,
    };

    const roots = new Set([toHexadecimal(computeStateRoot(initialState))]);
    for (const [description, variant] of Object.entries(variants)) {
      roots.add(toHexadecimal(computeStateRoot(variant)));
      assert.notDeepEqual(computeStateRoot(variant), computeStateRoot(initialState), description);
    }
    assert.equal(roots.size, Object.keys(variants).length + 1);
  });

  test("is the same for independent transactions applied in either order", () => {
    const aliceToDave = signTransfer({ from: ALICE, to: DAVE, amount: 5n, fee: 1n, nonce: 0n });
    const bobToCarol = signTransfer({ from: BOB, to: CAROL, amount: 7n, fee: 1n, nonce: 0n });

    const aliceFirst = applyAccepted(applyAccepted(initialState, aliceToDave), bobToCarol);
    const bobFirst = applyAccepted(applyAccepted(initialState, bobToCarol), aliceToDave);
    assert.deepEqual(computeStateRoot(aliceFirst), computeStateRoot(bobFirst));
  });
});

describe("account proofs", () => {
  /** Builds a state of 17 accounts, so proofs have several levels. */
  const createCrowdedState = (): ChainState =>
    createGenesisState(
      CHAIN_IDENTIFIER,
      Array.from({ length: 17 }, (_value, index) => ({
        address: addressOfAccount(index + 1),
        balance: BigInt(100 * (index + 1)),
      })),
    );

  test("every account of a small state is proven against the state root", () => {
    const root = computeStateRoot(initialState);
    for (const accountNumber of [ALICE, BOB]) {
      const address = addressOfAccount(accountNumber);
      const accountProof = createAccountProof(initialState, address);

      assert.ok(accountProof);
      assert.deepEqual(accountProof.account, accountOf(initialState, accountNumber));
      assert.equal(verifyAccountProof(root, address, accountProof), true);
    }
  });

  test("every account of a state with 17 accounts is proven in at most 5 steps", () => {
    const crowdedState = createCrowdedState();
    const root = computeStateRoot(crowdedState);
    for (let accountNumber = 1; accountNumber <= 17; accountNumber++) {
      const address = addressOfAccount(accountNumber);
      const accountProof = createAccountProof(crowdedState, address);

      assert.ok(accountProof, `account ${accountNumber}`);
      assert.equal(
        verifyAccountProof(root, address, accountProof),
        true,
        `account ${accountNumber}`,
      );
      assert.ok(accountProof.proof.length <= 5, `account ${accountNumber} needs too many steps`);
    }
  });

  test("a state with one account needs a single step, beside the chain identifier", () => {
    const singleAccountState = createGenesisState(CHAIN_IDENTIFIER, [
      { address: addressOfAccount(ALICE), balance: 5n },
    ]);
    const accountProof = createAccountProof(singleAccountState, addressOfAccount(ALICE));

    assert.ok(accountProof);
    assert.equal(accountProof.proof.length, 1);
    assert.equal(
      verifyAccountProof(
        computeStateRoot(singleAccountState),
        addressOfAccount(ALICE),
        accountProof,
      ),
      true,
    );
  });

  test("follow the state: a new proof fits the new root, and the old proof no longer does", () => {
    const oldProof = createAccountProof(initialState, addressOfAccount(BOB));
    const newState = applyAccepted(initialState, signTransfer(aliceToBob()));
    const newProof = createAccountProof(newState, addressOfAccount(BOB));

    assert.ok(oldProof && newProof);
    assert.equal(newProof.account.balance, BOB_BALANCE + 100n);
    assert.equal(
      verifyAccountProof(computeStateRoot(newState), addressOfAccount(BOB), newProof),
      true,
    );
    assert.equal(
      verifyAccountProof(computeStateRoot(newState), addressOfAccount(BOB), oldProof),
      false,
    );
  });

  test("let a light client check a balance knowing only a block header", () => {
    const block = produceTestBlock([signTransfer(aliceToBob())]);
    const applied = applyBlock(initialState, block);
    assert.ok(applied.valid);

    const accountProof = createAccountProof(applied.state, addressOfAccount(BOB));
    assert.ok(accountProof);
    assert.equal(
      verifyAccountProof(block.header.stateRoot, addressOfAccount(BOB), accountProof),
      true,
    );
  });

  test("cannot prove an account that is not in the state, since a Merkle tree cannot show absence", () => {
    assert.equal(createAccountProof(initialState, addressOfAccount(DAVE)), undefined);
  });

  test("still prove an account that spent its whole balance, because its nonce keeps it in the state", () => {
    const emptiedState = applyAccepted(
      initialState,
      signTransfer(aliceToBob({ amount: ALICE_BALANCE - 3n, fee: 3n })),
    );
    const accountProof = createAccountProof(emptiedState, addressOfAccount(ALICE));

    assert.ok(accountProof);
    assert.deepEqual(accountProof.account, { balance: 0n, nonce: 1n });
    assert.equal(
      verifyAccountProof(computeStateRoot(emptiedState), addressOfAccount(ALICE), accountProof),
      true,
    );
  });

  describe("reject a forged claim", () => {
    const root = computeStateRoot(initialState);
    const aliceAddress = addressOfAccount(ALICE);
    const genuineProof = createAccountProof(initialState, aliceAddress);
    assert.ok(genuineProof);

    test("sanity check: the genuine proof is accepted", () => {
      assert.equal(verifyAccountProof(root, aliceAddress, genuineProof), true);
    });

    test("a larger balance than the real one", () => {
      const forgedProof = {
        ...genuineProof,
        account: { ...genuineProof.account, balance: genuineProof.account.balance + 1n },
      };
      assert.equal(verifyAccountProof(root, aliceAddress, forgedProof), false);
    });

    test("a different nonce", () => {
      const forgedProof = {
        ...genuineProof,
        account: { ...genuineProof.account, nonce: genuineProof.account.nonce + 1n },
      };
      assert.equal(verifyAccountProof(root, aliceAddress, forgedProof), false);
    });

    test("another account's address with this account's proof", () => {
      assert.equal(verifyAccountProof(root, addressOfAccount(BOB), genuineProof), false);
    });

    test("a root that is not the state's", () => {
      assert.equal(verifyAccountProof(flipFirstBit(root), aliceAddress, genuineProof), false);
    });

    test("a proof step with one bit flipped", () => {
      const [firstStep, ...otherSteps] = genuineProof.proof;
      assert.ok(firstStep);
      const forgedProof = {
        ...genuineProof,
        proof: [{ ...firstStep, siblingHash: flipFirstBit(firstStep.siblingHash) }, ...otherSteps],
      };
      assert.equal(verifyAccountProof(root, aliceAddress, forgedProof), false);
    });

    test("a proof with its steps removed", () => {
      assert.equal(verifyAccountProof(root, aliceAddress, { ...genuineProof, proof: [] }), false);
    });

    test("a claim that cannot be encoded, without throwing", () => {
      const negativeClaim = { ...genuineProof, account: { balance: -1n, nonce: 0n } };
      const untypedClaim = {
        ...genuineProof,
        account: { balance: 100, nonce: 0n },
      } as unknown as typeof genuineProof;

      assert.equal(verifyAccountProof(root, aliceAddress, negativeClaim), false);
      assert.equal(verifyAccountProof(root, aliceAddress, untypedClaim), false);
    });
  });
});

describe("createGenesis", () => {
  test("returns the genesis state and a block whose header commits to it", () => {
    assert.equal(
      snapshotOf(genesis.state),
      snapshotOf(createGenesisState(CHAIN_IDENTIFIER, INITIAL_ALLOCATIONS)),
    );
    assert.deepEqual(genesis.block.header.stateRoot, computeStateRoot(genesis.state));
    assert.equal(genesis.block.header.height, 0n);
    assert.equal(genesis.block.header.timestamp, GENESIS_TIMESTAMP);
    assert.deepEqual(genesis.block.transactions, []);
  });

  test("gives a genesis hash that depends on the allocations and the chain identifier", () => {
    const genesisHashOf = (chainIdentifier: bigint, aliceBalance: bigint) =>
      hashBlockHeader(
        createGenesis({
          chainIdentifier,
          timestamp: GENESIS_TIMESTAMP,
          allocations: [{ address: addressOfAccount(ALICE), balance: aliceBalance }],
        }).block.header,
      );

    assert.deepEqual(genesisHashOf(CHAIN_IDENTIFIER, 100n), genesisHashOf(CHAIN_IDENTIFIER, 100n));
    assert.notDeepEqual(
      genesisHashOf(CHAIN_IDENTIFIER, 100n),
      genesisHashOf(CHAIN_IDENTIFIER, 101n),
    );
    assert.notDeepEqual(
      genesisHashOf(CHAIN_IDENTIFIER, 100n),
      genesisHashOf(CHAIN_IDENTIFIER + 1n, 100n),
    );
  });
});

describe("produceBlock", () => {
  const transactions = [
    signTransfer(aliceToBob({ nonce: 0n })),
    signTransfer(aliceToBob({ nonce: 1n })),
  ];

  test("builds a block that links to its parent and commits to the resulting state", () => {
    const production = produceBlock({
      parentState: initialState,
      parentHeader: genesis.block.header,
      transactions,
      timestamp: GENESIS_TIMESTAMP + 10n,
      beneficiary: addressOfAccount(CAROL),
    });
    assert.ok(production.valid);

    const { header } = production.block;
    assert.equal(header.height, 1n);
    assert.deepEqual(header.previousBlockHash, hashBlockHeader(genesis.block.header));
    assert.deepEqual(header.transactionsRoot, computeTransactionsRoot(transactions));
    assert.deepEqual(header.stateRoot, computeStateRoot(production.state));
    assert.equal(header.timestamp, GENESIS_TIMESTAMP + 10n);
    assert.deepEqual(header.beneficiary, addressOfAccount(CAROL));
  });

  test("builds a block that checkBlock and applyBlock both accept, reaching the same state", () => {
    const block = produceTestBlock(transactions);
    const production = produceBlock({
      parentState: initialState,
      parentHeader: genesis.block.header,
      transactions,
      timestamp: GENESIS_TIMESTAMP + 10n,
      beneficiary: addressOfAccount(CAROL),
    });
    assert.ok(production.valid);

    assert.deepEqual(checkBlock(block, genesis.block.header), { valid: true });
    const applied = applyBlock(initialState, block);
    assert.ok(applied.valid);
    assert.deepEqual(computeStateRoot(applied.state), computeStateRoot(production.state));
  });

  test("names the bad transaction instead of building a block", () => {
    const production = produceBlock({
      parentState: initialState,
      parentHeader: genesis.block.header,
      transactions: [signTransfer(aliceToBob()), signTransfer(aliceToBob({ nonce: 9n }))],
      timestamp: GENESIS_TIMESTAMP + 10n,
      beneficiary: addressOfAccount(CAROL),
    });
    assert.deepEqual(production, { valid: false, transactionIndex: 1, reason: "nonce-mismatch" });
  });

  test("throws when the parent state is not the state its header commits to", () => {
    const otherState = createGenesisState(CHAIN_IDENTIFIER, [
      { address: addressOfAccount(ALICE), balance: ALICE_BALANCE + 1n },
    ]);
    assert.throws(
      () =>
        produceBlock({
          parentState: otherState,
          parentHeader: genesis.block.header,
          transactions,
          timestamp: GENESIS_TIMESTAMP + 10n,
          beneficiary: addressOfAccount(CAROL),
        }),
      RangeError,
    );
  });

  test("leaves the parent state untouched", () => {
    const snapshotBefore = snapshotOf(initialState);
    produceTestBlock(transactions);
    assert.equal(snapshotOf(initialState), snapshotBefore);
  });
});

describe("applyBlock checks the state root", () => {
  test("rejects a block whose state root is not the root of the state it produces", () => {
    const block = produceTestBlock([signTransfer(aliceToBob())]);
    const forgedBlock = {
      ...block,
      header: { ...block.header, stateRoot: flipFirstBit(block.header.stateRoot) },
    };
    const snapshotBefore = snapshotOf(initialState);

    assert.deepEqual(applyBlock(initialState, forgedBlock), {
      valid: false,
      reason: "state-root-mismatch",
    });
    assert.equal(snapshotOf(initialState), snapshotBefore);
  });

  test("rejects a block whose beneficiary differs from the one its root was computed for", () => {
    const block = produceTestBlock([signTransfer(aliceToBob())], CAROL);
    const redirectedBlock = {
      ...block,
      header: { ...block.header, beneficiary: addressOfAccount(DAVE) },
    };

    assert.deepEqual(applyBlock(initialState, redirectedBlock), {
      valid: false,
      reason: "state-root-mismatch",
    });
  });

  test("reports a bad transaction before a wrong state root", () => {
    const block = createTestBlock([signTransfer(aliceToBob({ nonce: 9n }))]);
    assert.deepEqual(applyBlock(initialState, block), {
      valid: false,
      transactionIndex: 0,
      reason: "nonce-mismatch",
    });
  });
});

/** An account's balance and nonce in the reference model. */
type ModelAccount = { balance: bigint; nonce: bigint };

/** The reference model: balances and nonces by account number. */
type Model = Map<number, ModelAccount>;

/** A transfer to attempt, including who receives its fee. */
type Candidate = TransferParameters & { readonly beneficiary: number };

/** Builds the reference model of the initial state. */
const createInitialModel = (): Model =>
  new Map([
    [ALICE, { balance: ALICE_BALANCE, nonce: 0n }],
    [BOB, { balance: BOB_BALANCE, nonce: 0n }],
  ]);

/** Copies a model so a test can try transactions without committing them. */
const cloneModel = (model: Model): Model =>
  new Map([...model.entries()].map(([accountNumber, account]) => [accountNumber, { ...account }]));

/** Reads an account from the model, treating an unknown account as empty. */
const modelAccountOf = (model: Model, accountNumber: number): ModelAccount =>
  model.get(accountNumber) ?? { balance: 0n, nonce: 0n };

/** Draws a whole number from 0 up to, but not including, the limit. */
const randomInteger = (random: () => number, limit: number): number => Math.floor(random() * limit);

/** The reference rules, written apart from the implementation: a rejection reason, or none. */
const predictRejection = (model: Model, candidate: Candidate): TransactionRejection | undefined => {
  const sender = modelAccountOf(model, candidate.from);
  if (candidate.chainIdentifier !== CHAIN_IDENTIFIER) {
    return "wrong-chain";
  }
  if (candidate.fee < MINIMUM_FEE) {
    return "fee-too-low";
  }
  if (candidate.nonce !== sender.nonce) {
    return "nonce-mismatch";
  }
  if (sender.balance < candidate.amount + candidate.fee) {
    return "insufficient-balance";
  }
  return undefined;
};

/** Applies an accepted candidate to the model, one account change at a time. */
const applyToModel = (model: Model, candidate: Candidate): void => {
  const sender = modelAccountOf(model, candidate.from);
  model.set(candidate.from, {
    balance: sender.balance - candidate.amount - candidate.fee,
    nonce: sender.nonce + 1n,
  });
  const recipient = modelAccountOf(model, candidate.to);
  model.set(candidate.to, { ...recipient, balance: recipient.balance + candidate.amount });
  const beneficiary = modelAccountOf(model, candidate.beneficiary);
  model.set(candidate.beneficiary, {
    ...beneficiary,
    balance: beneficiary.balance + candidate.fee,
  });
};

/** Draws a random transfer, making one of five kinds of mistake with the given probability. */
const generateCandidate = (
  random: () => number,
  model: Model,
  mistakeProbability: number,
  beneficiary: number,
): Candidate => {
  const from = 1 + randomInteger(random, 4);
  const to = 1 + randomInteger(random, 4);
  const sender = modelAccountOf(model, from);
  const mistake = random() < mistakeProbability ? randomInteger(random, 5) : undefined;

  return {
    from,
    to,
    beneficiary,
    chainIdentifier: mistake === 0 ? 1338n : CHAIN_IDENTIFIER,
    nonce: mistake === 1 ? sender.nonce + 1n : sender.nonce,
    fee: mistake === 2 ? 0n : 1n + BigInt(randomInteger(random, 5)),
    amount:
      mistake === 3
        ? sender.balance + 1n
        : BigInt(randomInteger(random, Number(sender.balance) / 2 + 1)),
  };
};

/** Checks every account against the model, and that nothing was created or destroyed. */
const assertMatchesModel = (state: ChainState, model: Model): void => {
  for (const accountNumber of [ALICE, BOB, CAROL, DAVE]) {
    const expected = modelAccountOf(model, accountNumber);
    const actual = accountOf(state, accountNumber);
    assert.deepEqual(actual, expected, `account ${accountNumber}`);
    assert.ok(actual.balance >= 0n, `account ${accountNumber} has a negative balance`);
  }
  assert.equal(computeTotalSupply(state), INITIAL_SUPPLY);
};

describe("invariants under random transactions", () => {
  test("each verdict and each balance match an independent reference model", () => {
    const random = createSeededRandom(20_261_026);
    const model = createInitialModel();
    let state = initialState;
    let acceptedCount = 0;
    let rejectedCount = 0;

    for (let step = 0; step < 300; step++) {
      const candidate = generateCandidate(random, model, 0.35, 1 + randomInteger(random, 4));
      const expectedRejection = predictRejection(model, candidate);
      const snapshotBefore = snapshotOf(state);
      const result = applyTransaction(
        state,
        signTransfer(candidate),
        addressOfAccount(candidate.beneficiary),
      );

      if (expectedRejection === undefined) {
        if (!result.valid) {
          assert.fail(`step ${step} should have been accepted, but: ${result.reason}`);
        }
        applyToModel(model, candidate);
        state = result.state;
        acceptedCount++;
      } else {
        assert.deepEqual(result, { valid: false, reason: expectedRejection }, `step ${step}`);
        assert.equal(snapshotOf(state), snapshotBefore, `step ${step} changed the state`);
        rejectedCount++;
      }
      assertMatchesModel(state, model);
    }

    assert.ok(acceptedCount > 50, `only ${acceptedCount} transactions were accepted`);
    assert.ok(rejectedCount > 50, `only ${rejectedCount} transactions were rejected`);
  });

  test("blocks are applied whole or not at all, and match the reference model", () => {
    const random = createSeededRandom(20_261_027);
    let model = createInitialModel();
    let state = initialState;
    let tipHeader = genesis.block.header;
    let acceptedBlocks = 0;
    let rejectedBlocks = 0;

    for (let blockNumber = 0; blockNumber < 80; blockNumber++) {
      const beneficiary = 1 + randomInteger(random, 4);
      const trialModel = cloneModel(model);
      const transactions: SignedTransaction[] = [];
      let expectedFailure: { index: number; reason: TransactionRejection } | undefined;

      for (let index = 0; index < 4; index++) {
        const candidate = generateCandidate(random, trialModel, 0.05, beneficiary);
        transactions.push(signTransfer(candidate));
        const rejection = predictRejection(trialModel, candidate);
        if (rejection !== undefined) {
          expectedFailure ??= { index, reason: rejection };
        } else {
          applyToModel(trialModel, candidate);
        }
      }

      const snapshotBefore = snapshotOf(state);
      let block: Block;
      if (expectedFailure === undefined) {
        const production = produceBlock({
          parentState: state,
          parentHeader: tipHeader,
          transactions,
          timestamp: tipHeader.timestamp + 10n,
          beneficiary: addressOfAccount(beneficiary),
        });
        if (!production.valid) {
          assert.fail(`block ${blockNumber} could not be produced: ${production.reason}`);
        }
        block = production.block;
      } else {
        block = createTestBlock(transactions, beneficiary);
      }
      const result = applyBlock(state, block);

      if (expectedFailure === undefined) {
        if (!result.valid) {
          assert.fail(`block ${blockNumber} should have been accepted, but: ${result.reason}`);
        }
        model = trialModel;
        state = result.state;
        tipHeader = block.header;
        acceptedBlocks++;
      } else {
        assert.deepEqual(
          result,
          {
            valid: false,
            transactionIndex: expectedFailure.index,
            reason: expectedFailure.reason,
          },
          `block ${blockNumber}`,
        );
        assert.equal(snapshotOf(state), snapshotBefore, `block ${blockNumber} changed the state`);
        rejectedBlocks++;
      }
      assertMatchesModel(state, model);
    }

    assert.ok(acceptedBlocks > 20, `only ${acceptedBlocks} blocks were accepted`);
    assert.ok(rejectedBlocks > 5, `only ${rejectedBlocks} blocks were rejected`);
    assert.ok(elementAt([...state.accounts.values()], 0).balance >= 0n);
  });
});
