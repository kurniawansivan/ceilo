# Ceilo

Portfolio-grade solo project in three stages: **a** testnet learning, **b** mainnet with hard fund caps, **c** business. Current stage: **a**.

Product: a wallet for AI agents. An ERC-4337 smart account with modular spend-policy modules (daily limit, whitelist, session keys, human approval above a threshold). Agents pay through x402 in stablecoins on Base Sepolia. `minichain/` is a separate educational blockchain with its own native coin; it is learning-only and no production code depends on it.

Roadmap, definition of done and stage gates: `docs/roadmap.md`. Why each decision was made: `docs/adr/`. Read the ADR before reopening a settled decision.

## Language

- Code, comments, NatSpec, docs, commit messages, PR text: English.
- Everything said to the user in chat: Indonesian.

## Stack

- Solidity 0.8.x with the compiler version pinned, Foundry, OpenZeppelin, solhint, Slither.
- TypeScript for `minichain/`, `sdk/`, `app/`.
- Layout: `contracts/`, `minichain/`, `sdk/`, `app/`, `docs/` in one monorepo.
- Pinned tool and library versions, and why: `docs/adr/0002-toolchain-pins.md`. Bump a pin in its own commit with the reason.
- Standards (ERC-4337, ERC-7579, x402) move fast. Check the official spec at the start of each module that uses one, and record the version read in the module's learn note.

## Code style

- Write every identifier out in full: `transaction`, `signature`, `index`, `hexadecimal`, not `tx`, `sig`, `i`, `hex`. Names fixed by a standard, the language or an imported library (`keccak_256`, `Uint8Array`, `msg.sender`) are the only exceptions.
- Put exactly one comment line above every function and helper, stating what it does. The title of a `test` or `describe` callback is its comment.
- Solidity: one `/// @notice` line per function; descriptive parameter names replace `@param` and `@return` tags.

## Security (all stages)

- Testnet and throwaway keys only until an independent audit exists.
- Secrets live in the environment or a keystore outside the repo. Commit only `.env.example`.
- Reach for OpenZeppelin first for every primitive it offers. Cryptography comes from audited libraries.
- Upgradeable contracts need an ADR that states why immutability does not work.
- Tests come first: write the failing unit, fuzz or invariant test, then the code. Every security property gets an invariant test (e.g. an agent's spend never exceeds its limit).

## Workflow

- Conventional Commits. Short-lived branches, PR into `main`.
- CI must be green to merge: `forge fmt --check`, `forge test`, coverage of at least 90% (line and branch) on policy modules, Slither with no unaddressed high or medium findings.
- Solhint clean.

## Learning protocol

Each module teaches something and ships a portfolio artifact. For every module:

1. Explain the concept briefly before any code.
2. Split the module into small steps, each test first. The user decides per module which parts they write; Claude writes the rest (M1: Claude writes all code).
3. End every step at a **checkpoint**: stop, walk the user through what was built and why, show the tests and results, then wait for their evaluation and questions. The next step starts only after the user says to proceed.
4. Claude reviews any code the user wrote.
5. Close with `docs/learn/M<n>.md` (use `docs/learn/TEMPLATE.md`) holding 3-5 check questions.

A module is done when its tests are green, its learn note exists, and the user has answered the check questions.
