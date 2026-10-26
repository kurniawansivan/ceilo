# minichain

An educational blockchain written from scratch in TypeScript, with its own native coin: signed transfers, blocks, Merkle trees, account state and a chain you can replay and attack.

Learning-only. It has no consensus or networking yet, and no production code depends on it.

## Run it

Needs Node 24 or newer, which runs the TypeScript directly.

```shell
npm install --ignore-scripts
npm run demo        # build a chain, attack it, and see which layer catches each attack
npm test            # run every test
npm run typecheck   # check the types
npm run check       # check formatting and lint
```

`npm run demo` prints an honest chain, a balance proven from a block header alone, and eleven attacks with the layer that stops each one. The same scenarios run as tests, so the demo cannot drift from what the code does.

## How it fits together

| Module | What it does |
|---|---|
| `encoding.ts` | An injective byte encoding: tag, length prefix, payload. One value, one byte string. |
| `hash.ts` | keccak-256, as Ethereum uses it, plus hexadecimal helpers. |
| `keys.ts` | secp256k1 keys and Ethereum-style addresses. |
| `transaction.ts` | Transfers signed with a recoverable, low-S signature; the sender is recovered, never stored. |
| `merkle.ts` | A Merkle tree with inclusion proofs. An odd leaf moves up unchanged, so no two lists share a root. |
| `block.ts` | Block headers that commit to their parent, their transactions and the state they leave. |
| `state.ts` | Accounts (balance and nonce), transaction rules, block production, the state root and balance proofs. |
| `chain.ts` | Whole-chain checks: structure first, then a replay of every block from genesis. |
| `attempt.ts` | Turns "this input is invalid" into `undefined` while letting real bugs through. |
| `demo.ts` | The demonstration. |
| `testing.ts` | Shared fixtures for the tests and the demo. |

## Design decisions

- **Account model with Ethereum's primitives.** secp256k1 signatures, keccak-256 hashing and 20-byte addresses, so what is learned here carries over to the smart account later in this repo.
- **The sender is recovered from the signature.** A transaction cannot lie about who sent it. High-S signatures are rejected, because the same transaction would otherwise have two valid signatures.
- **Everything hashed has one encoding.** Each structure is hashed under its own domain tag, and every transaction names its chain, so a signature cannot be reused elsewhere.
- **Headers commit to the full state.** The state root covers the chain identifier and every account, so the genesis hash identifies a chain, nodes can compare results, and a light client can verify a balance with a short proof.
- **Fees only move coins.** The total supply is fixed at genesis. A minimum fee stops anyone from creating accounts or filling blocks for free.

## What each layer catches

| Layer | Catches |
|---|---|
| Chain structure | Edited transactions, broken links, wrong heights and timestamps, a wrong genesis block. |
| Transaction rules | Bad signatures, replays, overspending, free transactions, the wrong chain. |
| State replay | A false state root, redirected fees, anything that does not leave the state a header promises. |
| Nothing | A complete, consistent rewrite of history. Only consensus can choose between valid histories. |

## Not done yet

Consensus, networking, a mempool, block size limits, clock checks on timestamps and persistence. Do not use any of this with real funds.
