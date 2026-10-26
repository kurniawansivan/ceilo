import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { type Block, createBlock, hashBlockHeader } from "./block.ts";
import { checkChain, replayChain } from "./chain.ts";
import type { Hash } from "./hash.ts";
import { deriveAddress, derivePublicKey } from "./keys.ts";
import {
  type ChainState,
  computeStateRoot,
  createGenesis,
  createGenesisState,
  produceBlock,
} from "./state.ts";
import {
  addressOfAccount,
  createPlaceholderStateRoot,
  createSignedTransactionWithNonce,
  createStructuralGenesisBlock,
  elementAt,
  flipFirstBit,
  privateKeyWithValue,
  signTransfer,
} from "./testing.ts";
import { MAXIMUM_TARGET } from "./work.ts";

const GENESIS_TIMESTAMP = 1_000n;
const BLOCK_INTERVAL_IN_SECONDS = 10n;
const TRANSACTIONS_PER_BLOCK = 2n;
const beneficiaryAddress = deriveAddress(derivePublicKey(privateKeyWithValue(3)));

/** Builds a valid chain: a genesis block, then blocks that each carry two transactions. */
const buildChain = (blockCount: number, genesisTimestamp = GENESIS_TIMESTAMP): Block[] => {
  const chain: Block[] = [createStructuralGenesisBlock(genesisTimestamp)];
  for (let blockIndex = 1; blockIndex < blockCount; blockIndex++) {
    const parent = elementAt(chain, blockIndex - 1);
    const firstNonce = BigInt(blockIndex - 1) * TRANSACTIONS_PER_BLOCK;
    chain.push(
      createBlock({
        parentHeader: parent.header,
        transactions: [
          createSignedTransactionWithNonce(firstNonce),
          createSignedTransactionWithNonce(firstNonce + 1n),
        ],
        timestamp: parent.header.timestamp + BLOCK_INTERVAL_IN_SECONDS,
        beneficiary: beneficiaryAddress,
        stateRoot: createPlaceholderStateRoot(),
      }),
    );
  }
  return chain;
};

/** Returns the hash of the genesis block, which is what identifies a chain. */
const genesisHashOf = (chain: readonly Block[]): Hash =>
  hashBlockHeader(elementAt(chain, 0).header);

/** Returns a copy of the chain with one block swapped for another. */
const replaceBlockAt = (chain: readonly Block[], blockIndex: number, replacement: Block): Block[] =>
  chain.map((block, position) => (position === blockIndex ? replacement : block));

/** Rebuilds the chain from a block onwards so every later link points at the changed history. */
const relinkFrom = (chain: readonly Block[], startIndex: number, startBlock: Block): Block[] => {
  const relinkedChain = [...chain.slice(0, startIndex), startBlock];
  for (let blockIndex = startIndex + 1; blockIndex < chain.length; blockIndex++) {
    const original = elementAt(chain, blockIndex);
    relinkedChain.push(
      createBlock({
        parentHeader: elementAt(relinkedChain, blockIndex - 1).header,
        transactions: original.transactions,
        timestamp: original.header.timestamp,
        beneficiary: original.header.beneficiary,
        stateRoot: original.header.stateRoot,
      }),
    );
  }
  return relinkedChain;
};

/** Builds a replacement for a block that carries one altered transaction and a consistent header. */
const rewriteBlockConsistently = (chain: readonly Block[], blockIndex: number): Block => {
  const original = elementAt(chain, blockIndex);
  const [firstTransaction, ...otherTransactions] = original.transactions;
  assert.ok(firstTransaction);
  return createBlock({
    parentHeader: elementAt(chain, blockIndex - 1).header,
    transactions: [
      { ...firstTransaction, amount: firstTransaction.amount + 1n },
      ...otherTransactions,
    ],
    timestamp: original.header.timestamp,
    beneficiary: original.header.beneficiary,
    stateRoot: original.header.stateRoot,
  });
};

describe("checkChain accepts", () => {
  test("a chain of only the genesis block", () => {
    const chain = buildChain(1);
    assert.deepEqual(checkChain(chain, genesisHashOf(chain)), { valid: true });
  });

  test("a chain of several blocks", () => {
    const chain = buildChain(6);
    assert.deepEqual(checkChain(chain, genesisHashOf(chain)), { valid: true });
  });
});

describe("checkChain rejects", () => {
  test("an empty chain", () => {
    assert.deepEqual(checkChain([], new Uint8Array(32)), {
      valid: false,
      blockIndex: 0,
      reason: "empty-chain",
    });
  });

  test("a chain whose genesis block is not the expected one", () => {
    const chain = buildChain(4);
    assert.deepEqual(checkChain(chain, flipFirstBit(genesisHashOf(chain))), {
      valid: false,
      blockIndex: 0,
      reason: "genesis-hash-mismatch",
    });
  });

  test("an entire chain built on a different genesis block", () => {
    const foreignChain = buildChain(4, GENESIS_TIMESTAMP + 1n);
    assert.deepEqual(checkChain(foreignChain, genesisHashOf(buildChain(1))), {
      valid: false,
      blockIndex: 0,
      reason: "genesis-hash-mismatch",
    });
  });

  test("a genesis block whose header is malformed, instead of crashing", () => {
    const chain = buildChain(3);
    const genesis = elementAt(chain, 0);
    const malformedGenesis = {
      ...genesis,
      header: { ...genesis.header, beneficiary: new Uint8Array(19) },
    };

    assert.deepEqual(checkChain(replaceBlockAt(chain, 0, malformedGenesis), genesisHashOf(chain)), {
      valid: false,
      blockIndex: 0,
      reason: "malformed-header",
    });
  });

  test("transactions slipped into the genesis block under its unchanged header", () => {
    const chain = buildChain(3);
    const tamperedGenesis = {
      ...elementAt(chain, 0),
      transactions: [createSignedTransactionWithNonce(0n)],
    };
    assert.deepEqual(checkChain(replaceBlockAt(chain, 0, tamperedGenesis), genesisHashOf(chain)), {
      valid: false,
      blockIndex: 0,
      reason: "transactions-root-mismatch",
    });
  });

  test("a transaction altered inside a block, at the block that holds it", () => {
    const chain = buildChain(6);
    const block = elementAt(chain, 2);
    const [firstTransaction, ...otherTransactions] = block.transactions;
    assert.ok(firstTransaction);
    const alteredBlock = {
      ...block,
      transactions: [
        { ...firstTransaction, amount: firstTransaction.amount + 1n },
        ...otherTransactions,
      ],
    };

    assert.deepEqual(checkChain(replaceBlockAt(chain, 2, alteredBlock), genesisHashOf(chain)), {
      valid: false,
      blockIndex: 2,
      reason: "transactions-root-mismatch",
    });
  });

  test("an altered block whose header was fixed up, at the next block's broken link", () => {
    const chain = buildChain(6);
    const rewrittenBlock = rewriteBlockConsistently(chain, 2);

    assert.deepEqual(checkChain(replaceBlockAt(chain, 2, rewrittenBlock), genesisHashOf(chain)), {
      valid: false,
      blockIndex: 3,
      reason: "previous-hash-mismatch",
    });
  });

  test("a missing block in the middle, where the heights jump", () => {
    const chain = buildChain(6);
    const chainWithGap = chain.filter((_block, blockIndex) => blockIndex !== 2);

    assert.deepEqual(checkChain(chainWithGap, genesisHashOf(chain)), {
      valid: false,
      blockIndex: 2,
      reason: "unexpected-height",
    });
  });

  test("two blocks swapped", () => {
    const chain = buildChain(6);
    const swappedChain = replaceBlockAt(
      replaceBlockAt(chain, 2, elementAt(chain, 3)),
      3,
      elementAt(chain, 2),
    );

    assert.deepEqual(checkChain(swappedChain, genesisHashOf(chain)), {
      valid: false,
      blockIndex: 2,
      reason: "unexpected-height",
    });
  });

  test("the tip block repeated", () => {
    const chain = buildChain(4);
    const chainWithRepeat = [...chain, elementAt(chain, 3)];

    assert.deepEqual(checkChain(chainWithRepeat, genesisHashOf(chain)), {
      valid: false,
      blockIndex: 4,
      reason: "unexpected-height",
    });
  });

  test("a block from another chain spliced in at the same height", () => {
    const chain = buildChain(6);
    const foreignChain = buildChain(6, GENESIS_TIMESTAMP + 1n);

    assert.deepEqual(
      checkChain(replaceBlockAt(chain, 3, elementAt(foreignChain, 3)), genesisHashOf(chain)),
      {
        valid: false,
        blockIndex: 3,
        reason: "previous-hash-mismatch",
      },
    );
  });

  test("a chain with several broken blocks, naming the first", () => {
    const chain = buildChain(7);
    const alteredAtTwo = replaceBlockAt(chain, 2, { ...elementAt(chain, 2), transactions: [] });
    const alteredAtTwoAndFive = replaceBlockAt(alteredAtTwo, 5, {
      ...elementAt(chain, 5),
      transactions: [],
    });

    assert.deepEqual(checkChain(alteredAtTwoAndFive, genesisHashOf(chain)), {
      valid: false,
      blockIndex: 2,
      reason: "transactions-root-mismatch",
    });
  });
});

describe("what hash links alone cannot stop", () => {
  test("a consistently rewritten tip passes the check, so the tip hash must be known from outside", () => {
    const chain = buildChain(6);
    const rewrittenTip = rewriteBlockConsistently(chain, 5);
    const rewrittenChain = replaceBlockAt(chain, 5, rewrittenTip);

    assert.deepEqual(checkChain(rewrittenChain, genesisHashOf(chain)), { valid: true });
    assert.notDeepEqual(
      hashBlockHeader(rewrittenTip.header),
      hashBlockHeader(elementAt(chain, 5).header),
    );
  });

  test("rewritten history that is re-linked all the way up also passes, which is why consensus costs work", () => {
    const chain = buildChain(6);
    const rewrittenChain = relinkFrom(chain, 2, rewriteBlockConsistently(chain, 2));

    assert.deepEqual(checkChain(rewrittenChain, genesisHashOf(chain)), { valid: true });
    for (let blockIndex = 0; blockIndex < chain.length; blockIndex++) {
      const originalHash = hashBlockHeader(elementAt(chain, blockIndex).header);
      const rewrittenHash = hashBlockHeader(elementAt(rewrittenChain, blockIndex).header);
      if (blockIndex < 2) {
        assert.deepEqual(rewrittenHash, originalHash, `block ${blockIndex} is before the rewrite`);
      } else {
        assert.notDeepEqual(
          rewrittenHash,
          originalHash,
          `block ${blockIndex} is after the rewrite`,
        );
      }
    }
  });
});

const CHAIN_IDENTIFIER = 1337n;
const SENDER = 1;
const RECEIVER = 2;
const FEE_COLLECTOR = 3;
const OTHER_ACCOUNT = 4;
const ALLOCATED_BALANCE = 1_000n;
const TRANSFER_AMOUNT = 10n;

/** A chain built from real state, with the genesis state it starts from and the state it ends in. */
type RealChain = {
  readonly chain: Block[];
  readonly genesisState: ChainState;
  readonly finalState: ChainState;
};

/** Signs two consecutive transfers from the sender to the receiver. */
const createTransfers = (firstNonce: bigint, amount: bigint) => [
  signTransfer({ from: SENDER, to: RECEIVER, amount, fee: 1n, nonce: firstNonce }),
  signTransfer({ from: SENDER, to: RECEIVER, amount, fee: 1n, nonce: firstNonce + 1n }),
];

/** Builds a real chain by producing each block from the state before it, optionally changing one amount. */
const buildRealChain = (
  blockCount: number,
  amountChange?: { readonly blockIndex: number; readonly amount: bigint },
): RealChain => {
  const genesis = createGenesis({
    chainIdentifier: CHAIN_IDENTIFIER,
    timestamp: GENESIS_TIMESTAMP,
    target: MAXIMUM_TARGET,
    allocations: [{ address: addressOfAccount(SENDER), balance: ALLOCATED_BALANCE }],
  });
  const chain: Block[] = [genesis.block];
  let state = genesis.state;

  for (let blockIndex = 1; blockIndex < blockCount; blockIndex++) {
    const parent = elementAt(chain, blockIndex - 1);
    const amount = amountChange?.blockIndex === blockIndex ? amountChange.amount : TRANSFER_AMOUNT;
    const production = produceBlock({
      parentState: state,
      parentHeader: parent.header,
      transactions: createTransfers(BigInt(blockIndex - 1) * 2n, amount),
      timestamp: parent.header.timestamp + BLOCK_INTERVAL_IN_SECONDS,
      beneficiary: addressOfAccount(FEE_COLLECTOR),
    });
    if (!production.valid) {
      assert.fail(`block ${blockIndex} could not be produced: ${production.reason}`);
    }
    chain.push(production.block);
    state = production.state;
  }
  return { chain, genesisState: genesis.state, finalState: state };
};

describe("replayChain accepts", () => {
  test("a chain of only the genesis block", () => {
    const { chain, genesisState } = buildRealChain(1);
    const result = replayChain(chain, genesisHashOf(chain), genesisState);

    assert.ok(result.valid);
    assert.deepEqual(computeStateRoot(result.state), computeStateRoot(genesisState));
  });

  test("a real chain, ending in exactly the state its last block committed to", () => {
    const { chain, genesisState, finalState } = buildRealChain(6);
    const result = replayChain(chain, genesisHashOf(chain), genesisState);

    assert.ok(result.valid);
    assert.deepEqual(computeStateRoot(result.state), computeStateRoot(finalState));
    assert.deepEqual(computeStateRoot(result.state), elementAt(chain, 5).header.stateRoot);
  });
});

describe("replayChain rejects", () => {
  test("a chain with the wrong genesis hash, as checkChain does", () => {
    const { chain, genesisState } = buildRealChain(4);
    assert.deepEqual(replayChain(chain, flipFirstBit(genesisHashOf(chain)), genesisState), {
      valid: false,
      blockIndex: 0,
      reason: "genesis-hash-mismatch",
    });
  });

  test("a structural fault, as checkChain does: a transaction altered inside a block", () => {
    const { chain, genesisState } = buildRealChain(6);
    const block = elementAt(chain, 3);
    const [firstTransaction, ...otherTransactions] = block.transactions;
    assert.ok(firstTransaction);
    const alteredBlock = {
      ...block,
      transactions: [
        { ...firstTransaction, amount: firstTransaction.amount + 1n },
        ...otherTransactions,
      ],
    };

    assert.deepEqual(
      replayChain(replaceBlockAt(chain, 3, alteredBlock), genesisHashOf(chain), genesisState),
      { valid: false, blockIndex: 3, reason: "transactions-root-mismatch" },
    );
  });

  test("a genesis state that is not the one the genesis block commits to", () => {
    const { chain } = buildRealChain(4);
    const richerGenesisState = createGenesisState(CHAIN_IDENTIFIER, [
      { address: addressOfAccount(SENDER), balance: ALLOCATED_BALANCE + 1n },
    ]);

    assert.deepEqual(replayChain(chain, genesisHashOf(chain), richerGenesisState), {
      valid: false,
      blockIndex: 0,
      reason: "state-root-mismatch",
    });
  });

  test("a forged state root that is re-linked so the structure still holds", () => {
    const { chain, genesisState } = buildRealChain(6);
    const original = elementAt(chain, 2);
    const forgedBlock = createBlock({
      parentHeader: elementAt(chain, 1).header,
      transactions: original.transactions,
      timestamp: original.header.timestamp,
      beneficiary: original.header.beneficiary,
      stateRoot: flipFirstBit(original.header.stateRoot),
    });
    const forgedChain = relinkFrom(chain, 2, forgedBlock);

    assert.deepEqual(checkChain(forgedChain, genesisHashOf(chain)), { valid: true });
    assert.deepEqual(replayChain(forgedChain, genesisHashOf(chain), genesisState), {
      valid: false,
      blockIndex: 2,
      reason: "state-root-mismatch",
    });
  });

  test("a changed beneficiary, because the fees then land in a different account", () => {
    const { chain, genesisState } = buildRealChain(6);
    const original = elementAt(chain, 4);
    const redirectedBlock = createBlock({
      parentHeader: elementAt(chain, 3).header,
      transactions: original.transactions,
      timestamp: original.header.timestamp,
      beneficiary: addressOfAccount(OTHER_ACCOUNT),
      stateRoot: original.header.stateRoot,
    });
    const redirectedChain = relinkFrom(chain, 4, redirectedBlock);

    assert.deepEqual(checkChain(redirectedChain, genesisHashOf(chain)), { valid: true });
    assert.deepEqual(replayChain(redirectedChain, genesisHashOf(chain), genesisState), {
      valid: false,
      blockIndex: 4,
      reason: "state-root-mismatch",
    });
  });

  test("a block whose transaction the state cannot afford, though its structure is sound", () => {
    const { chain, genesisState } = buildRealChain(3);
    const overspendingBlock = createBlock({
      parentHeader: elementAt(chain, 2).header,
      transactions: [
        signTransfer({ from: SENDER, to: RECEIVER, amount: 10_000n, fee: 1n, nonce: 4n }),
      ],
      timestamp: elementAt(chain, 2).header.timestamp + BLOCK_INTERVAL_IN_SECONDS,
      beneficiary: addressOfAccount(FEE_COLLECTOR),
      stateRoot: createPlaceholderStateRoot(),
    });
    const longerChain = [...chain, overspendingBlock];

    assert.deepEqual(checkChain(longerChain, genesisHashOf(chain)), { valid: true });
    assert.deepEqual(replayChain(longerChain, genesisHashOf(chain), genesisState), {
      valid: false,
      blockIndex: 3,
      reason: "insufficient-balance",
    });
  });
});

describe("what replaying cannot stop", () => {
  test("an alternative history that is consistent all the way is just as valid", () => {
    const original = buildRealChain(6);
    const alternative = buildRealChain(6, { blockIndex: 2, amount: TRANSFER_AMOUNT + 1n });
    const result = replayChain(
      alternative.chain,
      genesisHashOf(original.chain),
      alternative.genesisState,
    );

    assert.ok(result.valid);
    assert.notDeepEqual(
      hashBlockHeader(elementAt(alternative.chain, 5).header),
      hashBlockHeader(elementAt(original.chain, 5).header),
    );
    assert.notDeepEqual(
      computeStateRoot(alternative.finalState),
      computeStateRoot(original.finalState),
    );
  });
});
