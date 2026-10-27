# 0004. Minichain consensus and network

Status: accepted, 2026-10-27. Extends [0003](0003-minichain-design.md), which said consensus was the next module.

## Decision

- **Proof-of-work, not proof-of-authority.** A header carries a `target` and a `nonce`, and its hash read as an integer must not exceed the target. The work of a block is `2^256 / (target + 1)`. Proof-of-work is the version where fork choice, difficulty and the 51% attack can all be shown with real hashing.
- **The chain with the most cumulative work wins, and the first one seen wins a tie.** A block tree keeps every valid branch and the state each block leaves, so a reorganization is a pointer move. One state copy per block is accepted as the price of simplicity.
- **Difficulty adjusts every window.** The new target scales by the actual time of the window over the expected time, clamped to a factor of four either way, capped at the maximum target and never below one. A window of N blocks holds N-1 intervals, so the expected time is `(N-1) x interval`. Bitcoin measures N-1 intervals against N, which is an off-by-one this chain does not copy.
- **Timestamps must rise above the parent's.** The limit on how far ahead of the clock a block may be is a check each node makes on input, not a rule of the chain, so every node agrees on validity whatever its clock says. A block can never be stamped earlier than its parent, which closes the step back across a window boundary that the time-warp attack on Bitcoin's retarget needs, so median-time-past is not used.
- **A fixed block reward, committed to the state.** The reward sits in the state root next to the chain identifier. It is paid to the beneficiary after the block's transactions, so it cannot be spent in the block that created it. The genesis block defines the reward but pays none. There is no halving.
- **At most 100 transactions per block.** Checked after the work and before the transactions are hashed, so an oversized block is cheap to refuse.
- **Consensus rules are client configuration, not chain data.** The block interval, retarget window, maximum target, adjustment limit and clock limit are passed to the software, not committed to the genesis state or header. Real chains work this way: a rule change is a software change, and committing the rules would freeze them with no way to upgrade. What changes the state is committed (the chain identifier and the reward), and what the rules refer to by number is checked at the edge (a genesis target may not be easier than the maximum target).
- **A bounded mempool.** A transaction replaces another from the same sender and nonce only for a strictly higher fee. When full, the pool drops the lowest fee, the newest on a tie, for a newcomer that pays more. A block takes the best fee among the transactions that can run next, so a sender's nonces stay in order.
- **A simulated network of full nodes.** Messages travel in memory and are delivered in order or in a seeded random order, so tests are deterministic and can check agreement however messages are ordered. A node passes on newly valid transactions and the new best branch, parents first, and asks the sender for the parent of a block it cannot connect.

## Consequences

- A rewrite of history now costs the work the honest chain holds, until someone has a majority of the hashing. The demonstration shows both sides: a split network that agrees again, and a double spend that fails below a majority and works above it.
- Two nodes with the same genesis and different rules diverge without warning. A version handshake would be the fix, and it is not built.
- Not built, by design: persistence, signed messages, a message format checked at the edge, halving, median-time-past. A block stamped too far ahead is dropped and not remembered, rejected blocks are not remembered, and a node syncs one block per round trip within a pool of 100 waiting blocks.
- A transaction whose lower nonce the pool evicted stays in the pool without being runnable until the sender sends the missing one.
- Tests that depend on mining are deterministic because hashing is, so a given scenario always ends the same way. The 51% tests check the certain cases and the invariants, not a lucky outcome.
