# Roadmap

Solo, about 10 hours per week, $0 budget in stage a. MVP target: 12 weeks.

## Stage a modules

| Module | Weeks | Learn | Artifact |
|---|---|---|---|
| M0 Setup and standards | 1 | EVM toolchain, CI | Monorepo, CLAUDE.md, green CI |
| M1 Mini-chain core | 2-3 | Hashing, digital signatures, blocks, Merkle trees, accounts and balances | Chain with native coin, signed transfers, fees |
| M2 Consensus and network (cut first if behind) | 4 | Proof-of-work or proof-of-authority, mempool, fork choice, p2p | Several nodes agreeing on one chain |
| M3 Solidity and EVM | 5 | EVM execution model, gas, ERC-20, fuzz testing | Test ERC-20 with full test suite |
| M4 Core account | 6-7 | ERC-4337, UserOperation validation, first module | Smart account with daily limit |
| M5 Policy modules and security | 8-9 | Whitelist, session keys, human approval, invariant tests, Slither, threat modeling | Full policy modules and `THREAT_MODEL.md` |
| M6 x402 integration | 10-11 | HTTP 402 flow, payload signing, TypeScript SDK | SDK and a demo agent paying an endpoint |
| M7 Dashboard and release | 12 | Passkeys, deployment and verification, documentation | Policy dashboard, Base Sepolia deployment, README and demo video |

## Progress

| Module | Status |
|---|---|
| M0 | Done. |
| M1 | Done, see the [learn note](learn/M1.md). The scope grew beyond the plan: a state root in block headers, light-client balance proofs and an attack demonstration. The check answers were written by Claude at the user's request. |
| M2 | Built and tested, see the [learn note](learn/M2.md) and [ADR 0004](adr/0004-minichain-consensus-and-network.md). Proof-of-work, fork choice, a mempool, nodes on a simulated network and a 51% attack demonstration. Done once the check questions are answered. |
| M3-M7 | Not started. |

## Definition of done, stage a

- M0-M7 complete; each has a learn note and answered check questions.
- Policy modules: coverage of at least 90% (line and branch).
- Invariant tests exist for the key properties.
- Slither shows no unaddressed high or medium findings.
- `THREAT_MODEL.md` exists.
- Contracts deployed and verified on Base Sepolia.
- End-to-end demo: an agent pays an x402 endpoint within policy and is blocked outside it.
- Public repo, green CI, README with architecture diagram, demo video or GIF.

## Stage gates

- **a to b**: definition of done met, then the budget for an independent audit (private or public contest) and legal consultation is decided. Without that budget, stage b does not start.
- **b**: mainnet with strict fund caps (per account and total), multisig or timelock for admin, and a bug bounty.
- **b to c**: evidence of real usage (outside developers using the SDK), then decide on a legal entity and a token model.
