# 0002. Toolchain pins

Status: accepted, 2026-10-26.

## Decision

- **Solidity 0.8.36, exact pragma** (`pragma solidity 0.8.36;`). The newest release that has been public for at least three months. Brand-new compiler releases carry fresh, still-undiscovered bugs; 0.8.38 was four days old when this was chosen. Revisit before stage b.
- **EVM version `prague`**, matching Pectra. Confirm Base Sepolia supports it at the first deployment (M7); drop to `cancun` if not.
- **OpenZeppelin Contracts v5.7.0**, a git submodule pinned to the tag.
- **Foundry v1.8.6** locally and in CI, so results are reproducible.
- **`@noble/curves` and `@noble/hashes` 2.3.0, exact.** The version their README says Trail of Bits audited (August 2026), rather than the newer 2.4.0. Cryptography comes from audited code.
- **TypeScript 7.0.2 and Biome 2.5.5**, the newest releases at least three months old. `@types/node` 24.19.2, the latest 24.x, and Node 24 or newer, which runs `.ts` files directly.
- **GitHub Actions pinned by commit SHA** (`actions/checkout` v7.0.0, `actions/setup-node` v7.0.0, `crytic/slither-action` v0.4.2), with the version in a trailing comment. A moved tag cannot change what CI runs.

## Consequences

- Bumping any pin is a deliberate commit that records the reason.
- Every Solidity file in `src/` and `test/` carries the exact pragma.
- TypeScript packages list exact versions in `package.json` and commit `package-lock.json`. CI installs with `npm ci --ignore-scripts`, so install scripts never run.
- The Slither job runs inside its action's container, which installs its own Foundry (1.5.1 stable on the first run), so the Foundry pin does not apply there. It is skipped until `contracts/src/` holds a contract.
