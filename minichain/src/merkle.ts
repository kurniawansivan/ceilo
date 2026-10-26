import { equalBytes } from "@noble/curves/utils.js";

import { type Hash, hashOf } from "./hash.ts";

const LEAF_DOMAIN = "ceilo/merkle-leaf";
const NODE_DOMAIN = "ceilo/merkle-node";
const EMPTY_TREE_DOMAIN = "ceilo/merkle-empty";

/** One level of a proof: a sibling hash and the side it is combined on. */
export type MerkleProofStep = {
  readonly siblingHash: Hash;
  readonly siblingSide: "left" | "right";
};

/** Sibling hashes from a leaf up to the root: enough to recompute the root from that leaf alone. */
export type MerkleProof = readonly MerkleProofStep[];

/** Hashes a leaf under its own domain tag, so a leaf can never be mistaken for an internal node. */
function hashLeaf(leaf: Uint8Array): Hash {
  return hashOf([LEAF_DOMAIN, leaf]);
}

/** Hashes two child hashes under the node domain tag. */
function hashNode(leftHash: Hash, rightHash: Hash): Hash {
  return hashOf([NODE_DOMAIN, leftHash, rightHash]);
}

/** Finds the largest power of two strictly below a count of at least two. */
function largestPowerOfTwoBelow(count: number): number {
  let powerOfTwo = 1;
  while (powerOfTwo * 2 < count) {
    powerOfTwo *= 2;
  }
  return powerOfTwo;
}

/** Computes the root over leaf hashes by giving the left side the largest power of two of them. */
function computeSubtreeRoot(leafHashes: readonly Hash[]): Hash {
  const [firstLeafHash] = leafHashes;
  if (firstLeafHash === undefined) {
    throw new RangeError("a subtree needs at least one leaf hash");
  }
  if (leafHashes.length === 1) {
    return firstLeafHash;
  }
  const splitIndex = largestPowerOfTwoBelow(leafHashes.length);
  return hashNode(
    computeSubtreeRoot(leafHashes.slice(0, splitIndex)),
    computeSubtreeRoot(leafHashes.slice(splitIndex)),
  );
}

/** Collects the sibling at every level from the leaf up, mirroring how the root is computed. */
function collectProofSteps(leafHashes: readonly Hash[], leafIndex: number): MerkleProofStep[] {
  if (leafHashes.length === 1) {
    return [];
  }
  const splitIndex = largestPowerOfTwoBelow(leafHashes.length);
  const leftHashes = leafHashes.slice(0, splitIndex);
  const rightHashes = leafHashes.slice(splitIndex);

  if (leafIndex < splitIndex) {
    return [
      ...collectProofSteps(leftHashes, leafIndex),
      { siblingHash: computeSubtreeRoot(rightHashes), siblingSide: "right" },
    ];
  }
  return [
    ...collectProofSteps(rightHashes, leafIndex - splitIndex),
    { siblingHash: computeSubtreeRoot(leftHashes), siblingSide: "left" },
  ];
}

/** Computes the Merkle root of the leaves; an odd leaf moves up unchanged, so no list is ambiguous. */
export function computeMerkleRoot(leaves: readonly Uint8Array[]): Hash {
  if (leaves.length === 0) {
    return hashOf([EMPTY_TREE_DOMAIN]);
  }
  return computeSubtreeRoot(leaves.map(hashLeaf));
}

/** Builds the proof that the leaf at the given index is in the tree, throwing if there is no such leaf. */
export function createMerkleProof(leaves: readonly Uint8Array[], leafIndex: number): MerkleProof {
  if (leaves.length === 0) {
    throw new RangeError("cannot prove membership in an empty tree");
  }
  if (!Number.isInteger(leafIndex) || leafIndex < 0 || leafIndex >= leaves.length) {
    throw new RangeError(`leaf index must be an integer from 0 to ${leaves.length - 1}`);
  }
  return collectProofSteps(leaves.map(hashLeaf), leafIndex);
}

/** Checks that a leaf and its proof recompute the expected root, returning false for any malformed proof. */
export function verifyMerkleProof(
  leaf: Uint8Array,
  proof: MerkleProof,
  expectedRoot: Hash,
): boolean {
  let runningHash = hashLeaf(leaf);
  for (const step of proof) {
    if (step.siblingSide === "left") {
      runningHash = hashNode(step.siblingHash, runningHash);
    } else if (step.siblingSide === "right") {
      runningHash = hashNode(runningHash, step.siblingHash);
    } else {
      return false;
    }
  }
  return equalBytes(runningHash, expectedRoot);
}
