import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  type Block,
  type BlockHeader,
  checkBlock,
  computeTransactionsRoot,
  createBlock,
  createGenesisBlock,
  hashBlockHeader,
} from "./block.ts";
import { hashOf } from "./hash.ts";
import { deriveAddress, derivePublicKey } from "./keys.ts";
import { computeMerkleRoot, createMerkleProof, verifyMerkleProof } from "./merkle.ts";
import { findNonce } from "./mining.ts";
import {
  createPlaceholderStateRoot,
  createSignedTransactionWithNonce,
  createStructuralGenesisBlock,
  elementAt,
  flipFirstBit,
  privateKeyWithValue,
} from "./testing.ts";
import { hashSignedTransaction, type SignedTransaction } from "./transaction.ts";
import { MAXIMUM_NONCE, MAXIMUM_TARGET, meetsTarget } from "./work.ts";

const GENESIS_TIMESTAMP = 1_000n;
const MODERATE_TARGET = 2n ** 252n - 1n;
const MAXIMUM_NONCES_TRIED = 10_000n;
const beneficiaryAddress = deriveAddress(derivePublicKey(privateKeyWithValue(3)));
const genesisBlock = createStructuralGenesisBlock(GENESIS_TIMESTAMP);
const signedTransactions = [0n, 1n, 2n].map(createSignedTransactionWithNonce);

/** Builds a valid child of the genesis block carrying three transactions. */
const createValidChild = (): Block =>
  createBlock({
    parentHeader: genesisBlock.header,
    transactions: signedTransactions,
    timestamp: GENESIS_TIMESTAMP + 10n,
    beneficiary: beneficiaryAddress,
    stateRoot: createPlaceholderStateRoot(),
  });

/** Returns the block with its header partly replaced and everything else untouched. */
const withHeader = (block: Block, replacement: Partial<BlockHeader>): Block => ({
  ...block,
  header: { ...block.header, ...replacement },
});

/** Builds a block on a parent whose target is moderate, so the block's nonce actually matters. */
const createUnminedChildOfHardParent = (): { parent: Block; unmined: Block } => {
  const parent = createStructuralGenesisBlock(GENESIS_TIMESTAMP, MODERATE_TARGET);
  const unmined = createBlock({
    parentHeader: parent.header,
    transactions: signedTransactions,
    timestamp: GENESIS_TIMESTAMP + 10n,
    beneficiary: beneficiaryAddress,
    stateRoot: createPlaceholderStateRoot(),
  });
  return { parent, unmined };
};

/** Returns the block with the first nonce that does not meet its target, failing fast if none does. */
const withFailingNonce = (block: Block): Block => {
  for (let nonce = 0n; nonce < MAXIMUM_NONCES_TRIED; nonce++) {
    if (!meetsTarget(hashBlockHeader({ ...block.header, nonce }), block.header.target)) {
      return withHeader(block, { nonce });
    }
  }
  return assert.fail("every nonce tried met the target, so none can fail it");
};

/** Returns the block with different transactions and its header untouched. */
const withTransactions = (block: Block, transactions: readonly SignedTransaction[]): Block => ({
  ...block,
  transactions,
});

describe("hashBlockHeader", () => {
  const header = createValidChild().header;

  test("hashes the domain tag followed by every field, in a fixed order", () => {
    assert.deepEqual(
      hashBlockHeader(header),
      hashOf([
        "ceilo/block-header",
        header.height,
        header.previousBlockHash,
        header.transactionsRoot,
        header.stateRoot,
        header.timestamp,
        header.beneficiary,
        header.target,
        header.nonce,
      ]),
    );
  });

  const alteredHeaders: Record<string, BlockHeader> = {
    target: { ...header, target: header.target - 1n },
    nonce: { ...header, nonce: header.nonce + 1n },
    height: { ...header, height: header.height + 1n },
    "previous block hash": { ...header, previousBlockHash: flipFirstBit(header.previousBlockHash) },
    "transactions root": { ...header, transactionsRoot: flipFirstBit(header.transactionsRoot) },
    "state root": { ...header, stateRoot: flipFirstBit(header.stateRoot) },
    timestamp: { ...header, timestamp: header.timestamp + 1n },
    beneficiary: { ...header, beneficiary: flipFirstBit(header.beneficiary) },
  };
  for (const [fieldName, alteredHeader] of Object.entries(alteredHeaders)) {
    test(`changes when the ${fieldName} changes`, () => {
      assert.notDeepEqual(hashBlockHeader(alteredHeader), hashBlockHeader(header));
    });
  }

  test("rejects hashes and addresses of the wrong length", () => {
    assert.throws(
      () => hashBlockHeader({ ...header, previousBlockHash: new Uint8Array(31) }),
      RangeError,
    );
    assert.throws(
      () => hashBlockHeader({ ...header, transactionsRoot: new Uint8Array(33) }),
      RangeError,
    );
    assert.throws(() => hashBlockHeader({ ...header, stateRoot: new Uint8Array(31) }), RangeError);
    assert.throws(
      () => hashBlockHeader({ ...header, beneficiary: new Uint8Array(19) }),
      RangeError,
    );
  });

  test("rejects a negative height or timestamp", () => {
    assert.throws(() => hashBlockHeader({ ...header, height: -1n }), RangeError);
    assert.throws(() => hashBlockHeader({ ...header, timestamp: -1n }), RangeError);
  });

  test("rejects a target outside 1 to the maximum, and a nonce outside 0 to the maximum", () => {
    assert.throws(() => hashBlockHeader({ ...header, target: 0n }), RangeError);
    assert.throws(() => hashBlockHeader({ ...header, target: -1n }), RangeError);
    assert.throws(() => hashBlockHeader({ ...header, target: MAXIMUM_TARGET + 1n }), RangeError);
    assert.throws(() => hashBlockHeader({ ...header, nonce: -1n }), RangeError);
    assert.throws(() => hashBlockHeader({ ...header, nonce: MAXIMUM_NONCE + 1n }), RangeError);
  });

  test("accepts the extremes of both ranges", () => {
    hashBlockHeader({ ...header, target: 1n, nonce: 0n });
    hashBlockHeader({ ...header, target: MAXIMUM_TARGET, nonce: MAXIMUM_NONCE });
  });
});

describe("computeTransactionsRoot", () => {
  test("is the Merkle root of the signed transaction hashes", () => {
    assert.deepEqual(
      computeTransactionsRoot(signedTransactions),
      computeMerkleRoot(signedTransactions.map(hashSignedTransaction)),
    );
  });

  test("of no transactions is the empty-tree root", () => {
    assert.deepEqual(computeTransactionsRoot([]), computeMerkleRoot([]));
  });

  test("depends on the order of the transactions", () => {
    assert.notDeepEqual(
      computeTransactionsRoot(signedTransactions),
      computeTransactionsRoot([...signedTransactions].reverse()),
    );
  });

  test("lets a transaction be proven to be in a block from its header alone", () => {
    const block = createValidChild();
    const transactionHashes = block.transactions.map(hashSignedTransaction);
    const proof = createMerkleProof(transactionHashes, 1);

    assert.equal(
      verifyMerkleProof(elementAt(transactionHashes, 1), proof, block.header.transactionsRoot),
      true,
    );
  });
});

describe("createGenesisBlock", () => {
  test("has height 0, no parent, no transactions and no beneficiary", () => {
    const { header, transactions } = createStructuralGenesisBlock(GENESIS_TIMESTAMP);

    assert.equal(header.height, 0n);
    assert.deepEqual(header.previousBlockHash, new Uint8Array(32));
    assert.deepEqual(header.transactionsRoot, computeMerkleRoot([]));
    assert.equal(header.timestamp, GENESIS_TIMESTAMP);
    assert.deepEqual(header.beneficiary, new Uint8Array(20));
    assert.deepEqual(transactions, []);
  });

  test("carries the state root and target it was given, with a nonce of zero", () => {
    const stateRoot = new Uint8Array(32).fill(0x5a);
    const { header } = createGenesisBlock({
      timestamp: GENESIS_TIMESTAMP,
      stateRoot,
      target: MODERATE_TARGET,
    });
    assert.deepEqual(header.stateRoot, stateRoot);
    assert.equal(header.target, MODERATE_TARGET);
    assert.equal(header.nonce, 0n);
  });

  test("is deterministic, and a different timestamp, state root or target makes a different chain", () => {
    /** Hashes the genesis block that a timestamp, state root and target would make. */
    const hashWith = (timestamp: bigint, stateRoot: Uint8Array, target = MAXIMUM_TARGET) =>
      hashBlockHeader(createGenesisBlock({ timestamp, stateRoot, target }).header);
    const stateRoot = createPlaceholderStateRoot();

    assert.notDeepEqual(
      hashWith(GENESIS_TIMESTAMP, stateRoot),
      hashWith(GENESIS_TIMESTAMP, stateRoot, MODERATE_TARGET),
    );

    assert.deepEqual(
      hashWith(GENESIS_TIMESTAMP, stateRoot),
      hashWith(GENESIS_TIMESTAMP, stateRoot),
    );
    assert.notDeepEqual(
      hashWith(GENESIS_TIMESTAMP, stateRoot),
      hashWith(GENESIS_TIMESTAMP + 1n, stateRoot),
    );
    assert.notDeepEqual(
      hashWith(GENESIS_TIMESTAMP, stateRoot),
      hashWith(GENESIS_TIMESTAMP, flipFirstBit(stateRoot)),
    );
  });
});

describe("createBlock", () => {
  test("links to the parent: next height and the parent's header hash", () => {
    const { header } = createValidChild();

    assert.equal(header.height, genesisBlock.header.height + 1n);
    assert.deepEqual(header.previousBlockHash, hashBlockHeader(genesisBlock.header));
  });

  test("commits to its transactions through the Merkle root", () => {
    const { header, transactions } = createValidChild();

    assert.deepEqual(header.transactionsRoot, computeTransactionsRoot(transactions));
    assert.deepEqual(transactions, signedTransactions);
  });

  test("carries the given timestamp, beneficiary and state root", () => {
    const { header } = createValidChild();

    assert.equal(header.timestamp, GENESIS_TIMESTAMP + 10n);
    assert.deepEqual(header.beneficiary, beneficiaryAddress);
    assert.deepEqual(header.stateRoot, createPlaceholderStateRoot());
  });

  test("starts unmined, with the parent's target unless another is given", () => {
    const inherited = createValidChild().header;
    assert.equal(inherited.nonce, 0n);
    assert.equal(inherited.target, genesisBlock.header.target);

    const overridden = createBlock({
      parentHeader: genesisBlock.header,
      transactions: [],
      timestamp: GENESIS_TIMESTAMP + 10n,
      beneficiary: beneficiaryAddress,
      stateRoot: createPlaceholderStateRoot(),
      target: MODERATE_TARGET,
      nonce: 77n,
    }).header;
    assert.equal(overridden.target, MODERATE_TARGET);
    assert.equal(overridden.nonce, 77n);
  });
});

describe("checkBlock", () => {
  test("accepts a block built by createBlock", () => {
    assert.deepEqual(
      checkBlock(createValidChild(), genesisBlock.header, genesisBlock.header.target),
      { valid: true },
    );
  });

  test("accepts a block that was mined to a moderate target", () => {
    const { parent, unmined } = createUnminedChildOfHardParent();
    const nonce = findNonce(unmined.header, 0n, 10_000);
    assert.ok(nonce !== undefined);

    assert.deepEqual(
      checkBlock(withHeader(unmined, { nonce }), parent.header, parent.header.target),
      { valid: true },
    );
  });

  test("accepts a target different from the parent's when that is the one expected", () => {
    const { parent, unmined } = createUnminedChildOfHardParent();
    const easierTarget = MODERATE_TARGET * 2n;
    const retargeted = withHeader(unmined, { target: easierTarget });
    const nonce = findNonce(retargeted.header, 0n, 10_000);
    assert.ok(nonce !== undefined);

    assert.deepEqual(checkBlock(withHeader(retargeted, { nonce }), parent.header, easierTarget), {
      valid: true,
    });
  });

  test("accepts a block with no transactions", () => {
    const emptyBlock = createBlock({
      parentHeader: genesisBlock.header,
      transactions: [],
      timestamp: GENESIS_TIMESTAMP + 1n,
      beneficiary: beneficiaryAddress,
      stateRoot: createPlaceholderStateRoot(),
    });
    assert.deepEqual(checkBlock(emptyBlock, genesisBlock.header, genesisBlock.header.target), {
      valid: true,
    });
  });

  describe("rejects", () => {
    test("a height that is not the parent's plus one", () => {
      for (const wrongHeight of [0n, 2n, 5n]) {
        assert.deepEqual(
          checkBlock(
            withHeader(createValidChild(), { height: wrongHeight }),
            genesisBlock.header,
            genesisBlock.header.target,
          ),
          {
            valid: false,
            reason: "unexpected-height",
          },
        );
      }
    });

    test("a link to a hash that is not the parent's", () => {
      const flippedLink = flipFirstBit(createValidChild().header.previousBlockHash);
      const otherParentLink = hashBlockHeader(
        createStructuralGenesisBlock(GENESIS_TIMESTAMP - 1n).header,
      );

      for (const wrongLink of [flippedLink, otherParentLink]) {
        assert.deepEqual(
          checkBlock(
            withHeader(createValidChild(), { previousBlockHash: wrongLink }),
            genesisBlock.header,
            genesisBlock.header.target,
          ),
          { valid: false, reason: "previous-hash-mismatch" },
        );
      }
    });

    test("a timestamp that is not after the parent's", () => {
      for (const wrongTimestamp of [GENESIS_TIMESTAMP, GENESIS_TIMESTAMP - 1n, 0n]) {
        assert.deepEqual(
          checkBlock(
            withHeader(createValidChild(), { timestamp: wrongTimestamp }),
            genesisBlock.header,
            genesisBlock.header.target,
          ),
          { valid: false, reason: "timestamp-not-increasing" },
        );
      }
    });

    test("a transactions root that was altered", () => {
      const alteredRoot = flipFirstBit(createValidChild().header.transactionsRoot);
      assert.deepEqual(
        checkBlock(
          withHeader(createValidChild(), { transactionsRoot: alteredRoot }),
          genesisBlock.header,
          genesisBlock.header.target,
        ),
        { valid: false, reason: "transactions-root-mismatch" },
      );
    });

    describe("transactions that no longer match the header", () => {
      const [firstTransaction, secondTransaction, thirdTransaction] = signedTransactions;
      assert.ok(firstTransaction && secondTransaction && thirdTransaction);

      const tamperedTransactionLists: Record<string, SignedTransaction[]> = {
        "an altered amount": [
          firstTransaction,
          { ...secondTransaction, amount: secondTransaction.amount + 1n },
          thirdTransaction,
        ],
        "a removed transaction": [firstTransaction, secondTransaction],
        "an added transaction": [...signedTransactions, createSignedTransactionWithNonce(3n)],
        "reordered transactions": [secondTransaction, firstTransaction, thirdTransaction],
        "a duplicated transaction": [
          firstTransaction,
          secondTransaction,
          thirdTransaction,
          thirdTransaction,
        ],
      };
      for (const [description, tamperedTransactions] of Object.entries(tamperedTransactionLists)) {
        test(description, () => {
          assert.deepEqual(
            checkBlock(
              withTransactions(createValidChild(), tamperedTransactions),
              genesisBlock.header,
              genesisBlock.header.target,
            ),
            {
              valid: false,
              reason: "transactions-root-mismatch",
            },
          );
        });
      }
    });

    test("a header with a hash or address of the wrong length", () => {
      const malformedHeaders: Partial<BlockHeader>[] = [
        { previousBlockHash: new Uint8Array(31) },
        { transactionsRoot: new Uint8Array(33) },
        { stateRoot: new Uint8Array(31) },
        { beneficiary: new Uint8Array(19) },
        { timestamp: -1n },
        { target: 0n },
        { nonce: -1n },
      ];
      for (const malformedHeader of malformedHeaders) {
        assert.deepEqual(
          checkBlock(
            withHeader(createValidChild(), malformedHeader),
            genesisBlock.header,
            genesisBlock.header.target,
          ),
          {
            valid: false,
            reason: "malformed-header",
          },
        );
      }
    });

    test("a header whose height is not a bigint, as untyped network input might be", () => {
      const untypedHeader = { height: 1 } as unknown as Partial<BlockHeader>;
      assert.deepEqual(
        checkBlock(
          withHeader(createValidChild(), untypedHeader),
          genesisBlock.header,
          genesisBlock.header.target,
        ),
        {
          valid: false,
          reason: "malformed-header",
        },
      );
    });

    test("a target that is not the parent's", () => {
      const block = withHeader(createValidChild(), { target: MAXIMUM_TARGET - 1n });
      assert.deepEqual(checkBlock(block, genesisBlock.header, genesisBlock.header.target), {
        valid: false,
        reason: "target-mismatch",
      });
    });

    test("a target equal to the parent's when a different one is expected", () => {
      const block = createValidChild();
      assert.deepEqual(checkBlock(block, genesisBlock.header, genesisBlock.header.target - 1n), {
        valid: false,
        reason: "target-mismatch",
      });
    });

    test("a nonce that does not reach the target", () => {
      const { parent, unmined } = createUnminedChildOfHardParent();
      assert.deepEqual(checkBlock(withFailingNonce(unmined), parent.header, parent.header.target), {
        valid: false,
        reason: "insufficient-work",
      });
    });

    test("a transaction that cannot be hashed", () => {
      const firstTransaction = elementAt(signedTransactions, 0);
      const malformedTransaction = { ...firstTransaction, recipient: new Uint8Array(19) };
      assert.deepEqual(
        checkBlock(
          withTransactions(createValidChild(), [malformedTransaction]),
          genesisBlock.header,
          genesisBlock.header.target,
        ),
        {
          valid: false,
          reason: "malformed-transaction",
        },
      );
    });
  });

  test("lets unexpected errors through instead of calling the block malformed", () => {
    const hostileBlock: Block = {
      header: createValidChild().header,
      get transactions(): readonly SignedTransaction[] {
        throw new Error("unexpected failure");
      },
    };
    assert.throws(
      () => checkBlock(hostileBlock, genesisBlock.header, genesisBlock.header.target),
      /unexpected failure/,
    );
  });

  describe("reports the first broken rule when several are broken", () => {
    test("a bad timestamp comes before a target mismatch", () => {
      const block = withHeader(createValidChild(), {
        timestamp: GENESIS_TIMESTAMP,
        target: MAXIMUM_TARGET - 1n,
      });
      assert.deepEqual(checkBlock(block, genesisBlock.header, genesisBlock.header.target), {
        valid: false,
        reason: "timestamp-not-increasing",
      });
    });

    test("a target mismatch comes before insufficient work", () => {
      const { parent, unmined } = createUnminedChildOfHardParent();
      const block = withFailingNonce(withHeader(unmined, { target: 1n }));
      assert.deepEqual(checkBlock(block, parent.header, parent.header.target), {
        valid: false,
        reason: "target-mismatch",
      });
    });

    test("insufficient work comes before a wrong transactions root, so fake blocks are cheap to refuse", () => {
      const { parent, unmined } = createUnminedChildOfHardParent();
      const block = withFailingNonce(
        withHeader(unmined, { transactionsRoot: flipFirstBit(unmined.header.transactionsRoot) }),
      );
      assert.deepEqual(checkBlock(block, parent.header, parent.header.target), {
        valid: false,
        reason: "insufficient-work",
      });
    });

    test("a malformed header comes before a wrong height", () => {
      const block = withHeader(createValidChild(), { height: 9n, beneficiary: new Uint8Array(19) });
      assert.deepEqual(checkBlock(block, genesisBlock.header, genesisBlock.header.target), {
        valid: false,
        reason: "malformed-header",
      });
    });

    test("a wrong height comes before a broken link", () => {
      const block = withHeader(createValidChild(), {
        height: 9n,
        previousBlockHash: new Uint8Array(32),
      });
      assert.deepEqual(checkBlock(block, genesisBlock.header, genesisBlock.header.target), {
        valid: false,
        reason: "unexpected-height",
      });
    });

    test("a broken link comes before a bad timestamp", () => {
      const block = withHeader(createValidChild(), {
        previousBlockHash: new Uint8Array(32),
        timestamp: GENESIS_TIMESTAMP,
      });
      assert.deepEqual(checkBlock(block, genesisBlock.header, genesisBlock.header.target), {
        valid: false,
        reason: "previous-hash-mismatch",
      });
    });

    test("a bad timestamp comes before a wrong transactions root", () => {
      const block = withHeader(createValidChild(), {
        timestamp: GENESIS_TIMESTAMP,
        transactionsRoot: new Uint8Array(32),
      });
      assert.deepEqual(checkBlock(block, genesisBlock.header, genesisBlock.header.target), {
        valid: false,
        reason: "timestamp-not-increasing",
      });
    });
  });
});
