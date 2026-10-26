# 0001. Scope and stack

Status: accepted, 2026-10-26.

## Decision

- **Use case: wallet for AI agents with spend policies.** Agents have started paying for services themselves (x402), but there is no safe way to hand them funds. The wallet enforces limits, whitelists, revocable session keys and human approval above a threshold.
- **Chain and standards: Base Sepolia, ERC-4337 account with ERC-7579-style policy modules, x402 behind an adapter** so Stripe's competing MPP can be added later.
- **Mini-chain is learning-only.** It teaches hashing, signatures, consensus and p2p, and carries its own native coin. Production code runs on an existing EVM L2. Rolling a production L1 is expensive, unsafe for solo work, and needs a validator set. If a chain is ever needed, use OP Stack or Cosmos SDK.
- **No own token in the product yet.** Payments use existing stablecoins (USDC). A product token (e.g. operator bond with slashing) is evaluated in stage c, and only if proven necessary. A test ERC-20 is used for tests.
- **Market: global, developer-facing.** Legal review for Indonesia and target countries happens before mainnet in stage b.

## Rejected

- **Rupiah stablecoin**: OJK stablecoin rules are expected in early 2027, and crypto is not legal tender in Indonesia. Too early and too risky for solo work.
- **Tokenized SME receivables**: strong fit with OJK's 2026-2031 tokenization roadmap, but heavy legal exposure once real money is involved. Kept as a candidate pivot for stage c.

## Notes

- Market figures behind this decision came from secondary sources and are unverified. Standards must be re-checked against official specs at the start of M4 and M6.
