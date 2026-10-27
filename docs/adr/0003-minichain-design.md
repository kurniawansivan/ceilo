# 0003. Minichain design

Status: accepted, 2026-10-26. Consensus, the block reward, the block size limit and the mempool are decided in [0004](0004-minichain-consensus-and-network.md).

## Decision

- **Account model with Ethereum's primitives.** secp256k1, keccak-256 and 20-byte addresses, not Bitcoin's UTXOs or SHA-256. What is learned here carries over to the ERC-4337 account in M4, and the minichain's keys and addresses match the EVM's.
- **The sender is recovered, not stored.** A transaction carries only a recoverable signature, so it cannot lie about who sent it. High-`S` signatures are rejected, because public key recovery accepts both halves of a signature pair and one transaction would otherwise have two valid signatures and two hashes.
- **One value, one byte string.** Hashing uses an injective tag, length and payload encoding that refuses values with no single form. Every hashed structure has its own domain tag, and a transaction names its chain, so a hash or signature cannot be reused in another context.
- **A Merkle tree that splits at a power of two.** An odd leaf moves up unchanged, which avoids the duplicate-leaf collision of Bitcoin's CVE-2012-2459, and leaves and nodes are hashed under different tags.
- **Headers commit to the full state.** The state root covers the chain identifier and every account, so the genesis hash identifies a chain, allocations included, nodes can compare results, and a light client can check a balance against a header. Proofs exist only for accounts that exist.
- **Fixed supply and a minimum fee.** Fees only move coins and there is no block reward yet. Without a minimum fee, anyone could create accounts or fill blocks for free.
- **Results, not exceptions, for invalid input.** An invalid block or transaction from the network is a normal event, so the checks return a reason. Only `RangeError` and `TypeError` count as bad input; anything else is a bug and propagates.

## Consequences

- Hash links alone are tamper-evident, not tamper-proof: a history rewritten consistently from some block on passes every check. Choosing between valid histories is the job of consensus, in M2.
- The minichain stays learning-only. No consensus, networking, mempool, block size limit or clock checks yet.
- Changing the header's fields changes every block hash, so the header format is fixed by tests.
