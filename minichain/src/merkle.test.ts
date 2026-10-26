import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { concatBytes } from "@noble/hashes/utils.js";

import { type Hash, hashOf } from "./hash.ts";
import { deriveAddress, derivePublicKey } from "./keys.ts";
import {
  computeMerkleRoot,
  createMerkleProof,
  type MerkleProof,
  type MerkleProofStep,
  verifyMerkleProof,
} from "./merkle.ts";
import { elementAt, flipFirstBit, privateKeyWithValue } from "./testing.ts";
import { hashSignedTransaction, signTransaction } from "./transaction.ts";

/** Hashes a leaf exactly as the specification says, written independently of the implementation. */
const leafHashOf = (leaf: Uint8Array): Hash => hashOf(["ceilo/merkle-leaf", leaf]);

/** Hashes an internal node exactly as the specification says, written independently. */
const nodeHashOf = (leftHash: Hash, rightHash: Hash): Hash =>
  hashOf(["ceilo/merkle-node", leftHash, rightHash]);

/** Builds distinct, recognisable leaves: "leaf-0", "leaf-1" and so on. */
const createLeaves = (count: number): Uint8Array[] => {
  const leaves: Uint8Array[] = [];
  for (let leafIndex = 0; leafIndex < count; leafIndex++) {
    leaves.push(new TextEncoder().encode(`leaf-${leafIndex}`));
  }
  return leaves;
};

/** Hashes every leaf, so tests can spell out the expected tree shape by position. */
const createLeafHashes = (count: number): Hash[] => createLeaves(count).map(leafHashOf);

/** Returns the proof with one step partly replaced. */
const replaceStep = (
  proof: MerkleProof,
  position: number,
  replacement: Partial<MerkleProofStep>,
): MerkleProof =>
  proof.map((step, stepPosition) =>
    stepPosition === position ? { ...step, ...replacement } : step,
  );

/** Returns the opposite side of a proof step. */
const oppositeSide = (step: MerkleProofStep): "left" | "right" =>
  step.siblingSide === "left" ? "right" : "left";

describe("computeMerkleRoot", () => {
  describe("exact tree shape", () => {
    test("no leaves: the hash of an empty-tree marker", () => {
      assert.deepEqual(computeMerkleRoot([]), hashOf(["ceilo/merkle-empty"]));
    });

    test("one leaf: just the leaf hash, with no node above it", () => {
      assert.deepEqual(computeMerkleRoot(createLeaves(1)), elementAt(createLeafHashes(1), 0));
    });

    test("two leaves: one node over both", () => {
      const leafHashes = createLeafHashes(2);
      assert.deepEqual(
        computeMerkleRoot(createLeaves(2)),
        nodeHashOf(elementAt(leafHashes, 0), elementAt(leafHashes, 1)),
      );
    });

    test("three leaves: the odd leaf moves up unchanged instead of being duplicated", () => {
      const leafHashes = createLeafHashes(3);
      const leftNode = nodeHashOf(elementAt(leafHashes, 0), elementAt(leafHashes, 1));
      assert.deepEqual(
        computeMerkleRoot(createLeaves(3)),
        nodeHashOf(leftNode, elementAt(leafHashes, 2)),
      );
    });

    test("four leaves: a balanced tree", () => {
      const leafHashes = createLeafHashes(4);
      const leftNode = nodeHashOf(elementAt(leafHashes, 0), elementAt(leafHashes, 1));
      const rightNode = nodeHashOf(elementAt(leafHashes, 2), elementAt(leafHashes, 3));
      assert.deepEqual(computeMerkleRoot(createLeaves(4)), nodeHashOf(leftNode, rightNode));
    });

    test("five leaves: the left side takes the largest power of two, four", () => {
      const leafHashes = createLeafHashes(5);
      const leftNode = nodeHashOf(
        nodeHashOf(elementAt(leafHashes, 0), elementAt(leafHashes, 1)),
        nodeHashOf(elementAt(leafHashes, 2), elementAt(leafHashes, 3)),
      );
      assert.deepEqual(
        computeMerkleRoot(createLeaves(5)),
        nodeHashOf(leftNode, elementAt(leafHashes, 4)),
      );
    });

    test("six leaves: four on the left, two on the right", () => {
      const leafHashes = createLeafHashes(6);
      const leftNode = nodeHashOf(
        nodeHashOf(elementAt(leafHashes, 0), elementAt(leafHashes, 1)),
        nodeHashOf(elementAt(leafHashes, 2), elementAt(leafHashes, 3)),
      );
      const rightNode = nodeHashOf(elementAt(leafHashes, 4), elementAt(leafHashes, 5));
      assert.deepEqual(computeMerkleRoot(createLeaves(6)), nodeHashOf(leftNode, rightNode));
    });

    test("seven leaves: four on the left, three on the right", () => {
      const leafHashes = createLeafHashes(7);
      const leftNode = nodeHashOf(
        nodeHashOf(elementAt(leafHashes, 0), elementAt(leafHashes, 1)),
        nodeHashOf(elementAt(leafHashes, 2), elementAt(leafHashes, 3)),
      );
      const rightNode = nodeHashOf(
        nodeHashOf(elementAt(leafHashes, 4), elementAt(leafHashes, 5)),
        elementAt(leafHashes, 6),
      );
      assert.deepEqual(computeMerkleRoot(createLeaves(7)), nodeHashOf(leftNode, rightNode));
    });
  });

  describe("commits to its input", () => {
    test("is deterministic", () => {
      assert.deepEqual(computeMerkleRoot(createLeaves(6)), computeMerkleRoot(createLeaves(6)));
    });

    test("depends on the order of the leaves", () => {
      const leaves = createLeaves(2);
      const reversedLeaves = [elementAt(leaves, 1), elementAt(leaves, 0)];
      assert.notDeepEqual(computeMerkleRoot(leaves), computeMerkleRoot(reversedLeaves));
    });

    test("changes when any single leaf changes, at every position and tree size", () => {
      for (let leafCount = 1; leafCount <= 9; leafCount++) {
        const originalRoot = computeMerkleRoot(createLeaves(leafCount));
        for (let changedIndex = 0; changedIndex < leafCount; changedIndex++) {
          const alteredLeaves = createLeaves(leafCount);
          alteredLeaves[changedIndex] = new TextEncoder().encode("altered");
          assert.notDeepEqual(
            computeMerkleRoot(alteredLeaves),
            originalRoot,
            `leaf ${changedIndex} of ${leafCount}`,
          );
        }
      }
    });

    test("never gives two different lists the same root", () => {
      const leaves = createLeaves(4);
      const lists = [
        [],
        ...Array.from({ length: 9 }, (_value, leafCount) => createLeaves(leafCount + 1)),
        // Bitcoin's duplicate-last-leaf rule makes each of these collide with the list before it.
        [elementAt(leaves, 0), elementAt(leaves, 1), elementAt(leaves, 2), elementAt(leaves, 2)],
        [elementAt(leaves, 0), elementAt(leaves, 0)],
        [elementAt(leaves, 0), elementAt(leaves, 1), elementAt(leaves, 0), elementAt(leaves, 1)],
      ];
      const distinctRoots = new Set(
        lists.map((list) => Buffer.from(computeMerkleRoot(list)).toString("hex")),
      );
      assert.equal(distinctRoots.size, lists.length);
    });

    test("does not modify its input", () => {
      const leaves = createLeaves(5);
      const snapshot = leaves.map((leaf) => Uint8Array.from(leaf));
      computeMerkleRoot(leaves);
      assert.deepEqual(leaves, snapshot);
    });
  });

  describe("keeps leaves and nodes apart", () => {
    test("the two halves of a node cannot be passed off as a single leaf", () => {
      const leaves = createLeaves(2);
      const leafHashes = createLeafHashes(2);
      const nodePreimage = concatBytes(elementAt(leafHashes, 0), elementAt(leafHashes, 1));
      assert.notDeepEqual(computeMerkleRoot([nodePreimage]), computeMerkleRoot(leaves));
    });
  });
});

describe("createMerkleProof", () => {
  test("is empty for a single leaf, which is already the root", () => {
    assert.deepEqual(createMerkleProof(createLeaves(1), 0), []);
  });

  test("lists siblings from the leaf upwards, each with the side it sits on", () => {
    const leafHashes = createLeafHashes(3);
    const leftNode = nodeHashOf(elementAt(leafHashes, 0), elementAt(leafHashes, 1));

    assert.deepEqual(createMerkleProof(createLeaves(3), 0), [
      { siblingHash: elementAt(leafHashes, 1), siblingSide: "right" },
      { siblingHash: elementAt(leafHashes, 2), siblingSide: "right" },
    ]);
    assert.deepEqual(createMerkleProof(createLeaves(3), 1), [
      { siblingHash: elementAt(leafHashes, 0), siblingSide: "left" },
      { siblingHash: elementAt(leafHashes, 2), siblingSide: "right" },
    ]);
    assert.deepEqual(createMerkleProof(createLeaves(3), 2), [
      { siblingHash: leftNode, siblingSide: "left" },
    ]);
  });

  test("needs at most ceil(log2(leaf count)) steps: 10 for 1,000 leaves", () => {
    const leaves = createLeaves(1000);
    for (const leafIndex of [0, 1, 499, 500, 998, 999]) {
      assert.ok(createMerkleProof(leaves, leafIndex).length <= 10, `leaf ${leafIndex}`);
    }
  });

  test("rejects an empty list, since there is nothing to prove", () => {
    assert.throws(() => createMerkleProof([], 0), { name: "RangeError", message: /empty/ });
  });

  test("rejects a leaf index that is negative, fractional, not a number or past the end", () => {
    const leaves = createLeaves(4);
    for (const invalidIndex of [-1, 1.5, Number.NaN, 4, 100]) {
      assert.throws(
        () => createMerkleProof(leaves, invalidIndex),
        RangeError,
        String(invalidIndex),
      );
    }
  });
});

describe("verifyMerkleProof", () => {
  describe("accepts genuine proofs", () => {
    for (const leafCount of [1, 2, 3, 4, 5, 6, 7, 8, 9, 16, 17]) {
      test(`for every leaf of a tree with ${leafCount} leaves`, () => {
        const leaves = createLeaves(leafCount);
        const root = computeMerkleRoot(leaves);
        for (let leafIndex = 0; leafIndex < leafCount; leafIndex++) {
          const proof = createMerkleProof(leaves, leafIndex);
          assert.equal(
            verifyMerkleProof(elementAt(leaves, leafIndex), proof, root),
            true,
            `leaf ${leafIndex}`,
          );
        }
      });
    }

    test("for a tree with 1,000 leaves", () => {
      const leaves = createLeaves(1000);
      const root = computeMerkleRoot(leaves);
      for (const leafIndex of [0, 1, 499, 500, 998, 999]) {
        const proof = createMerkleProof(leaves, leafIndex);
        assert.equal(
          verifyMerkleProof(elementAt(leaves, leafIndex), proof, root),
          true,
          `leaf ${leafIndex}`,
        );
      }
    });
  });

  describe("rejects forgeries", () => {
    const leaves = createLeaves(8);
    const root = computeMerkleRoot(leaves);
    const leafIndex = 5;
    const leaf = elementAt(leaves, leafIndex);
    const proof = createMerkleProof(leaves, leafIndex);

    test("sanity check: the unaltered proof is accepted", () => {
      assert.equal(verifyMerkleProof(leaf, proof, root), true);
    });

    test("a different leaf", () => {
      assert.equal(verifyMerkleProof(elementAt(leaves, 4), proof, root), false);
    });

    test("a leaf that is in the tree but at another position", () => {
      assert.equal(verifyMerkleProof(elementAt(leaves, 6), proof, root), false);
    });

    test("a different root", () => {
      assert.equal(verifyMerkleProof(leaf, proof, flipFirstBit(root)), false);
    });

    test("a root of a different tree", () => {
      assert.equal(verifyMerkleProof(leaf, proof, computeMerkleRoot(createLeaves(9))), false);
    });

    test("a sibling hash with one bit flipped, at every step", () => {
      for (let position = 0; position < proof.length; position++) {
        const forgedProof = replaceStep(proof, position, {
          siblingHash: flipFirstBit(elementAt(proof, position).siblingHash),
        });
        assert.equal(verifyMerkleProof(leaf, forgedProof, root), false, `step ${position}`);
      }
    });

    test("a sibling on the wrong side, at every step", () => {
      for (let position = 0; position < proof.length; position++) {
        const forgedProof = replaceStep(proof, position, {
          siblingSide: oppositeSide(elementAt(proof, position)),
        });
        assert.equal(verifyMerkleProof(leaf, forgedProof, root), false, `step ${position}`);
      }
    });

    test("a proof with its first step removed", () => {
      assert.equal(verifyMerkleProof(leaf, proof.slice(1), root), false);
    });

    test("a proof with its last step removed", () => {
      assert.equal(verifyMerkleProof(leaf, proof.slice(0, -1), root), false);
    });

    test("a proof with an extra step added", () => {
      const extendedProof = [...proof, elementAt(proof, 0)];
      assert.equal(verifyMerkleProof(leaf, extendedProof, root), false);
    });

    test("a proof with its steps in reverse order", () => {
      assert.equal(verifyMerkleProof(leaf, [...proof].reverse(), root), false);
    });

    test("an empty proof for a leaf that is not the whole tree", () => {
      assert.equal(verifyMerkleProof(leaf, [], root), false);
    });

    test("an internal node presented as a leaf", () => {
      const leafHashes = createLeafHashes(2);
      const twoLeafRoot = computeMerkleRoot(createLeaves(2));
      const nodePreimage = concatBytes(elementAt(leafHashes, 0), elementAt(leafHashes, 1));
      assert.equal(verifyMerkleProof(nodePreimage, [], twoLeafRoot), false);
    });

    test("a step whose side is neither left nor right, instead of treating it as right", () => {
      const rightSidedProof = createMerkleProof(leaves, 4);
      assert.equal(elementAt(rightSidedProof, 0).siblingSide, "right");
      assert.equal(verifyMerkleProof(elementAt(leaves, 4), rightSidedProof, root), true);

      const forgedProof = replaceStep(rightSidedProof, 0, {
        siblingSide: "rightwards" as unknown as "right",
      });
      assert.equal(verifyMerkleProof(elementAt(leaves, 4), forgedProof, root), false);
    });

    test("a sibling hash of the wrong length, without throwing", () => {
      for (const wrongLength of [0, 31, 33]) {
        const forgedProof = replaceStep(proof, 0, { siblingHash: new Uint8Array(wrongLength) });
        assert.equal(verifyMerkleProof(leaf, forgedProof, root), false, `length ${wrongLength}`);
      }
    });

    test("a root of the wrong length, without throwing", () => {
      assert.equal(verifyMerkleProof(leaf, proof, root.slice(1)), false);
    });
  });
});

describe("a tree of signed transactions", () => {
  /** Signs a transfer with the given nonce, so each transaction hashes differently. */
  const createSignedTransaction = (nonce: bigint) =>
    signTransaction(
      {
        chainIdentifier: 1337n,
        nonce,
        recipient: deriveAddress(derivePublicKey(privateKeyWithValue(2))),
        amount: 100n,
        fee: 1n,
      },
      privateKeyWithValue(1),
    );

  test("proves that a transaction is in a block, and not an altered copy", () => {
    const signedTransactions = [0n, 1n, 2n, 3n, 4n].map(createSignedTransaction);
    const transactionHashes = signedTransactions.map(hashSignedTransaction);
    const root = computeMerkleRoot(transactionHashes);
    const proof = createMerkleProof(transactionHashes, 3);

    const provenTransaction = elementAt(signedTransactions, 3);
    assert.equal(verifyMerkleProof(hashSignedTransaction(provenTransaction), proof, root), true);

    const alteredTransaction = { ...provenTransaction, amount: provenTransaction.amount + 1n };
    assert.equal(verifyMerkleProof(hashSignedTransaction(alteredTransaction), proof, root), false);
  });
});
