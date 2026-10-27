import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { type Block, createBlock, hashBlockHeader } from "./block.ts";
import { checkChain, replayChain } from "./chain.ts";
import { type ConsensusRules, computeExpectedTarget } from "./consensus.ts";
import type { Hash } from "./hash.ts";
import { deriveAddress, derivePublicKey } from "./keys.ts";
import { mineBlock } from "./mining.ts";
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
  TEST_RULES,
} from "./testing.ts";
import { MAXIMUM_TARGET } from "./work.ts";

const GENESIS_TIMESTAMP = 1_000n;
const BLOCK_INTERVAL_IN_SECONDS = 10n;
const TRANSACTIONS_PER_BLOCK = 2n;
const beneficiaryAddress = deriveAddress(derivePublicKey(privateKeyWithValue(3)));

/** Checks a chain under rules where difficulty never changes, as every structural test needs. */
const checkTestChain = (chain: readonly Block[], expectedGenesisHash: Hash) =>
  checkChain(chain, expectedGenesisHash, TEST_RULES);

/** Replays a chain under rules where difficulty never changes. */
const replayTestChain = (
  chain: readonly Block[],
  expectedGenesisHash: Hash,
  genesisState: ChainState,
) => replayChain(chain, expectedGenesisHash, genesisState, TEST_RULES);

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
    assert.deepEqual(checkTestChain(chain, genesisHashOf(chain)), { valid: true });
  });

  test("a chain of several blocks", () => {
    const chain = buildChain(6);
    assert.deepEqual(checkTestChain(chain, genesisHashOf(chain)), { valid: true });
  });
});

describe("checkChain rejects", () => {
  test("an empty chain", () => {
    assert.deepEqual(checkTestChain([], new Uint8Array(32)), {
      valid: false,
      blockIndex: 0,
      reason: "empty-chain",
    });
  });

  test("a chain whose genesis block is not the expected one", () => {
    const chain = buildChain(4);
    assert.deepEqual(checkTestChain(chain, flipFirstBit(genesisHashOf(chain))), {
      valid: false,
      blockIndex: 0,
      reason: "genesis-hash-mismatch",
    });
  });

  test("an entire chain built on a different genesis block", () => {
    const foreignChain = buildChain(4, GENESIS_TIMESTAMP + 1n);
    assert.deepEqual(checkTestChain(foreignChain, genesisHashOf(buildChain(1))), {
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

    assert.deepEqual(
      checkTestChain(replaceBlockAt(chain, 0, malformedGenesis), genesisHashOf(chain)),
      {
        valid: false,
        blockIndex: 0,
        reason: "malformed-header",
      },
    );
  });

  test("transactions slipped into the genesis block under its unchanged header", () => {
    const chain = buildChain(3);
    const tamperedGenesis = {
      ...elementAt(chain, 0),
      transactions: [createSignedTransactionWithNonce(0n)],
    };
    assert.deepEqual(
      checkTestChain(replaceBlockAt(chain, 0, tamperedGenesis), genesisHashOf(chain)),
      {
        valid: false,
        blockIndex: 0,
        reason: "transactions-root-mismatch",
      },
    );
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

    assert.deepEqual(checkTestChain(replaceBlockAt(chain, 2, alteredBlock), genesisHashOf(chain)), {
      valid: false,
      blockIndex: 2,
      reason: "transactions-root-mismatch",
    });
  });

  test("an altered block whose header was fixed up, at the next block's broken link", () => {
    const chain = buildChain(6);
    const rewrittenBlock = rewriteBlockConsistently(chain, 2);

    assert.deepEqual(
      checkTestChain(replaceBlockAt(chain, 2, rewrittenBlock), genesisHashOf(chain)),
      {
        valid: false,
        blockIndex: 3,
        reason: "previous-hash-mismatch",
      },
    );
  });

  test("a missing block in the middle, where the heights jump", () => {
    const chain = buildChain(6);
    const chainWithGap = chain.filter((_block, blockIndex) => blockIndex !== 2);

    assert.deepEqual(checkTestChain(chainWithGap, genesisHashOf(chain)), {
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

    assert.deepEqual(checkTestChain(swappedChain, genesisHashOf(chain)), {
      valid: false,
      blockIndex: 2,
      reason: "unexpected-height",
    });
  });

  test("the tip block repeated", () => {
    const chain = buildChain(4);
    const chainWithRepeat = [...chain, elementAt(chain, 3)];

    assert.deepEqual(checkTestChain(chainWithRepeat, genesisHashOf(chain)), {
      valid: false,
      blockIndex: 4,
      reason: "unexpected-height",
    });
  });

  test("a block from another chain spliced in at the same height", () => {
    const chain = buildChain(6);
    const foreignChain = buildChain(6, GENESIS_TIMESTAMP + 1n);

    assert.deepEqual(
      checkTestChain(replaceBlockAt(chain, 3, elementAt(foreignChain, 3)), genesisHashOf(chain)),
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

    assert.deepEqual(checkTestChain(alteredAtTwoAndFive, genesisHashOf(chain)), {
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

    assert.deepEqual(checkTestChain(rewrittenChain, genesisHashOf(chain)), { valid: true });
    assert.notDeepEqual(
      hashBlockHeader(rewrittenTip.header),
      hashBlockHeader(elementAt(chain, 5).header),
    );
  });

  test("rewritten history that is re-linked all the way up also passes, which is why consensus costs work", () => {
    const chain = buildChain(6);
    const rewrittenChain = relinkFrom(chain, 2, rewriteBlockConsistently(chain, 2));

    assert.deepEqual(checkTestChain(rewrittenChain, genesisHashOf(chain)), { valid: true });
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
    blockReward: 10n,
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
    const result = replayTestChain(chain, genesisHashOf(chain), genesisState);

    assert.ok(result.valid);
    assert.deepEqual(computeStateRoot(result.state), computeStateRoot(genesisState));
  });

  test("a real chain, ending in exactly the state its last block committed to", () => {
    const { chain, genesisState, finalState } = buildRealChain(6);
    const result = replayTestChain(chain, genesisHashOf(chain), genesisState);

    assert.ok(result.valid);
    assert.deepEqual(computeStateRoot(result.state), computeStateRoot(finalState));
    assert.deepEqual(computeStateRoot(result.state), elementAt(chain, 5).header.stateRoot);
  });
});

describe("replayChain rejects", () => {
  test("a chain with the wrong genesis hash, as checkChain does", () => {
    const { chain, genesisState } = buildRealChain(4);
    assert.deepEqual(replayTestChain(chain, flipFirstBit(genesisHashOf(chain)), genesisState), {
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
      replayTestChain(replaceBlockAt(chain, 3, alteredBlock), genesisHashOf(chain), genesisState),
      { valid: false, blockIndex: 3, reason: "transactions-root-mismatch" },
    );
  });

  test("a genesis state that is not the one the genesis block commits to", () => {
    const { chain } = buildRealChain(4);
    const richerGenesisState = createGenesisState(CHAIN_IDENTIFIER, [
      { address: addressOfAccount(SENDER), balance: ALLOCATED_BALANCE + 1n },
    ]);

    assert.deepEqual(replayTestChain(chain, genesisHashOf(chain), richerGenesisState), {
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

    assert.deepEqual(checkTestChain(forgedChain, genesisHashOf(chain)), { valid: true });
    assert.deepEqual(replayTestChain(forgedChain, genesisHashOf(chain), genesisState), {
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

    assert.deepEqual(checkTestChain(redirectedChain, genesisHashOf(chain)), { valid: true });
    assert.deepEqual(replayTestChain(redirectedChain, genesisHashOf(chain), genesisState), {
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

    assert.deepEqual(checkTestChain(longerChain, genesisHashOf(chain)), { valid: true });
    assert.deepEqual(replayTestChain(longerChain, genesisHashOf(chain), genesisState), {
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
    const result = replayTestChain(
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

// A window of 4 blocks with 10-second intervals expects 3 intervals, so 30 seconds.
const RETARGET_RULES: ConsensusRules = {
  targetBlockIntervalInSeconds: 10n,
  retargetWindowInBlocks: 4n,
  maximumTarget: MAXIMUM_TARGET,
  maximumAdjustmentFactor: 4n,
  futureTimeLimitInSeconds: 30n,
};
const INITIAL_TARGET = 2n ** 252n - 1n;

/** Mines the next block on a chain, with the target the rules call for unless one is forced. */
const mineNextBlock = (
  chain: readonly Block[],
  secondsBetweenBlocks: bigint,
  forcedTarget?: bigint,
): Block => {
  const parent = elementAt(chain, chain.length - 1);
  const target =
    forcedTarget ??
    computeExpectedTarget(RETARGET_RULES, parent.header, (height) => chain[Number(height)]?.header);
  const unmined = createBlock({
    parentHeader: parent.header,
    transactions: [],
    timestamp: parent.header.timestamp + secondsBetweenBlocks,
    beneficiary: beneficiaryAddress,
    stateRoot: createPlaceholderStateRoot(),
    target,
  });
  const mined = mineBlock(unmined, 100_000);
  assert.ok(mined, "no nonce was found within the budget");
  return mined;
};

/** Builds a chain of really mined blocks that arrive a fixed number of seconds apart. */
const buildMinedChain = (
  blockCount: number,
  secondsBetweenBlocks: bigint,
  genesisTarget = INITIAL_TARGET,
): Block[] => {
  const chain: Block[] = [createStructuralGenesisBlock(GENESIS_TIMESTAMP, genesisTarget)];
  while (chain.length < blockCount) {
    chain.push(mineNextBlock(chain, secondsBetweenBlocks));
  }
  return chain;
};

/** Returns the target of the block at a height. */
const targetAt = (chain: readonly Block[], height: number): bigint =>
  elementAt(chain, height).header.target;

describe("difficulty adjustment in a chain", () => {
  test("keeps the target inside a window and retargets on its boundary, harder when blocks are fast", () => {
    const chain = buildMinedChain(5, 2n);

    for (const height of [1, 2, 3]) {
      assert.equal(targetAt(chain, height), INITIAL_TARGET, `height ${height}`);
    }
    // The window took 6 seconds, below the minimum of 30 / 4 = 7, so 7 is used.
    assert.equal(targetAt(chain, 4), (INITIAL_TARGET * 7n) / 30n);
    assert.deepEqual(checkChain(chain, genesisHashOf(chain), RETARGET_RULES), { valid: true });
  });

  test("makes the target easier by at most four times when blocks are slow", () => {
    const chain = buildMinedChain(5, 100n);

    // The window took 300 seconds, above the maximum of 30 * 4 = 120, so 120 is used.
    assert.equal(targetAt(chain, 4), INITIAL_TARGET * 4n);
    assert.deepEqual(checkChain(chain, genesisHashOf(chain), RETARGET_RULES), { valid: true });
  });

  test("leaves the target alone when blocks arrive exactly on schedule", () => {
    const chain = buildMinedChain(9, 10n);
    for (let height = 1; height <= 8; height++) {
      assert.equal(targetAt(chain, height), INITIAL_TARGET, `height ${height}`);
    }
    assert.deepEqual(checkChain(chain, genesisHashOf(chain), RETARGET_RULES), { valid: true });
  });

  test("retargets each window from its own blocks, so a second adjustment builds on the first", () => {
    const chain = buildMinedChain(9, 5n);
    // Each window took 15 seconds against 30 expected, so the target halves each time.
    const afterFirstWindow = (INITIAL_TARGET * 15n) / 30n;
    const afterSecondWindow = (afterFirstWindow * 15n) / 30n;

    assert.equal(targetAt(chain, 4), afterFirstWindow);
    assert.equal(targetAt(chain, 7), afterFirstWindow);
    assert.equal(targetAt(chain, 8), afterSecondWindow);
    assert.deepEqual(checkChain(chain, genesisHashOf(chain), RETARGET_RULES), { valid: true });
  });

  test("never lets the target pass the maximum the rules allow", () => {
    const chain = buildMinedChain(5, 100n, MAXIMUM_TARGET);
    assert.equal(targetAt(chain, 4), MAXIMUM_TARGET);
    assert.deepEqual(checkChain(chain, genesisHashOf(chain), RETARGET_RULES), { valid: true });
  });

  test("rejects a retarget block that keeps the old target", () => {
    const honest = buildMinedChain(4, 2n);
    const chain = [...honest, mineNextBlock(honest, 2n, INITIAL_TARGET)];

    assert.deepEqual(checkChain(chain, genesisHashOf(chain), RETARGET_RULES), {
      valid: false,
      blockIndex: 4,
      reason: "target-mismatch",
    });
  });

  test("rejects a retarget block that claims an easier target than the rules allow", () => {
    const honest = buildMinedChain(4, 2n);
    const chain = [...honest, mineNextBlock(honest, 2n, MAXIMUM_TARGET)];

    assert.deepEqual(checkChain(chain, genesisHashOf(chain), RETARGET_RULES), {
      valid: false,
      blockIndex: 4,
      reason: "target-mismatch",
    });
  });

  test("rejects a block in the middle of a window that changes the target", () => {
    const honest = buildMinedChain(2, 2n);
    const chain = [...honest, mineNextBlock(honest, 2n, INITIAL_TARGET / 2n)];

    assert.deepEqual(checkChain(chain, genesisHashOf(chain), RETARGET_RULES), {
      valid: false,
      blockIndex: 2,
      reason: "target-mismatch",
    });
  });

  test("rejects a chain whose genesis target is easier than the rules allow", () => {
    const chain = buildMinedChain(2, 2n);
    const strictRules = { ...RETARGET_RULES, maximumTarget: 2n ** 200n };

    assert.deepEqual(checkChain(chain, genesisHashOf(chain), strictRules), {
      valid: false,
      blockIndex: 0,
      reason: "genesis-target-too-easy",
    });
  });

  test("accepts a genesis target exactly equal to the maximum the rules allow", () => {
    const chain = buildMinedChain(2, 2n);
    const exactRules = { ...RETARGET_RULES, maximumTarget: INITIAL_TARGET };
    assert.deepEqual(checkChain(chain, genesisHashOf(chain), exactRules), { valid: true });
  });

  test("checks the rules even for a chain of only the genesis block", () => {
    const chain = buildMinedChain(1, 2n);
    const brokenRules = { ...RETARGET_RULES, retargetWindowInBlocks: 1n };
    assert.throws(() => checkChain(chain, genesisHashOf(chain), brokenRules), RangeError);
  });

  test("throws when the rules themselves are invalid, which is a mistake and not a bad chain", () => {
    const chain = buildMinedChain(2, 2n);
    const brokenRules = { ...RETARGET_RULES, retargetWindowInBlocks: 1n };
    assert.throws(() => checkChain(chain, genesisHashOf(chain), brokenRules), RangeError);
  });

  test("replays a real chain across a retarget, with state, mining and difficulty all agreeing", () => {
    const genesis = createGenesis({
      chainIdentifier: CHAIN_IDENTIFIER,
      timestamp: GENESIS_TIMESTAMP,
      target: INITIAL_TARGET,
      blockReward: 10n,
      allocations: [{ address: addressOfAccount(SENDER), balance: ALLOCATED_BALANCE }],
    });
    const chain: Block[] = [genesis.block];
    let state = genesis.state;

    while (chain.length < 6) {
      const parent = elementAt(chain, chain.length - 1);
      const production = produceBlock({
        parentState: state,
        parentHeader: parent.header,
        transactions: [
          signTransfer({
            from: SENDER,
            to: RECEIVER,
            amount: 10n,
            fee: 1n,
            nonce: BigInt(chain.length - 1),
          }),
        ],
        timestamp: parent.header.timestamp + 2n,
        beneficiary: addressOfAccount(FEE_COLLECTOR),
        target: computeExpectedTarget(
          RETARGET_RULES,
          parent.header,
          (height) => chain[Number(height)]?.header,
        ),
      });
      assert.ok(production.valid);
      const mined = mineBlock(production.block, 100_000);
      assert.ok(mined);
      chain.push(mined);
      state = production.state;
    }

    const result = replayChain(chain, genesisHashOf(chain), genesis.state, RETARGET_RULES);
    assert.ok(result.valid);
    assert.deepEqual(computeStateRoot(result.state), computeStateRoot(state));
    assert.equal(targetAt(chain, 4), (INITIAL_TARGET * 7n) / 30n);
  });
});
