# minichain

An educational blockchain written from scratch in TypeScript, with its own native coin: signed transfers, blocks, Merkle trees, account state and a chain you can replay and attack.

Learning-only. It has proof-of-work consensus and a simulated network of nodes, and no production code depends on it.

## Run it

Needs Node 24 or newer, which runs the TypeScript directly.

```shell
npm install --ignore-scripts
npm run demo        # build a chain, attack it, split and rejoin a network, and run a 51% attack
npm test            # run every test
npm run typecheck   # check the types
npm run check       # check formatting and lint
```

`npm run demo` prints an honest chain, a balance proven from a block header alone, eleven attacks with the layer that stops each one, a network that splits into two halves and agrees again, and a double spend against a merchant at five strengths of attacker. The same scenarios run as tests, so the demo cannot drift from what the code does.

## How it fits together

| Module | What it does |
|---|---|
| `encoding.ts` | An injective byte encoding: tag, length prefix, payload. One value, one byte string. |
| `hash.ts` | keccak-256, as Ethereum uses it, plus hexadecimal helpers. |
| `keys.ts` | secp256k1 keys and Ethereum-style addresses. |
| `transaction.ts` | Transfers signed with a recoverable, low-S signature; the sender is recovered, never stored. |
| `merkle.ts` | A Merkle tree with inclusion proofs. An odd leaf moves up unchanged, so no two lists share a root. |
| `block.ts` | Block headers that commit to their parent, their transactions, the state they leave and the work behind them. A block holds at most 100 transactions. |
| `work.ts` | Proof-of-work arithmetic: the target, whether a hash meets it, and the work a target stands for. |
| `mining.ts` | Searches for a nonce within a budget of attempts. |
| `consensus.ts` | The rules of timing and difficulty: the next target from a window of blocks, and the clock check on timestamps. |
| `blocktree.ts` | Every valid block on every branch, the chain with the most work, reorganizations, and blocks waiting for a parent. |
| `state.ts` | Accounts (balance and nonce), transaction rules, block production, the state root and balance proofs. |
| `chain.ts` | Whole-chain checks: structure first, then a replay of every block from genesis. |
| `mempool.ts` | A bounded pool of waiting transactions: fee replacement, eviction, selection for a block, and following the chain tip. |
| `assembly.ts` | Builds and mines the next block on the tip from the best transactions in the pool. |
| `node.ts` | A full node: a block tree, a pool and peers; it passes on what is new and asks for what is missing. |
| `network.ts` | A simulated network: links that can be cut, and messages delivered in order or at random from a seed. |
| `attack.ts` | A 51% double spend played against honest miners, with real hashing. |
| `networkdemo.ts` | The network sections of the demonstration: a split that heals, and the double spend at five strengths. |
| `attempt.ts` | Turns "this input is invalid" into `undefined` while letting real bugs through. |
| `demo.ts` | The demonstration. |
| `testing.ts` | Shared fixtures for the tests and the demo. |

## Design decisions

- **Account model with Ethereum's primitives.** secp256k1 signatures, keccak-256 hashing and 20-byte addresses, so what is learned here carries over to the smart account later in this repo.
- **The sender is recovered from the signature.** A transaction cannot lie about who sent it. High-S signatures are rejected, because the same transaction would otherwise have two valid signatures.
- **Everything hashed has one encoding.** Each structure is hashed under its own domain tag, and every transaction names its chain, so a signature cannot be reused elsewhere.
- **Headers commit to the full state.** The state root covers the chain identifier and every account, so the genesis hash identifies a chain, nodes can compare results, and a light client can verify a balance with a short proof.
- **Fees only move coins.** A minimum fee stops anyone from creating accounts or filling blocks for free. New coins come only from the block reward, which the state root commits to.
- **The chain with the most work wins.** Every valid branch is kept, ties go to the first one seen, and a reorganization hands the transactions of the abandoned branch back to the pool. See [ADR 0004](../docs/adr/0004-minichain-consensus-and-network.md).
- **The network is simulated.** Messages move in memory in an order the test chooses, so the same code is checked under any ordering and every run is repeatable.

## What each layer catches

| Layer | Catches |
|---|---|
| Chain structure | Edited transactions, broken links, wrong heights and timestamps, a wrong genesis block. |
| Transaction rules | Bad signatures, replays, overspending, free transactions, the wrong chain. |
| State replay | A false state root, redirected fees, anything that does not leave the state a header promises. |
| Consensus | A complete, consistent rewrite of history: it loses to the chain with more work. |
| Nothing | A rewrite backed by a majority of the hashing, which holds more work than the honest chain. |

## Not done yet

Persistence, signed or validated network messages, a version handshake, halving of the reward and median-time-past. Do not use any of this with real funds.
