# 0002. Toolchain pins

Status: accepted, 2026-10-26.

## Decision

- **Solidity 0.8.36, exact pragma** (`pragma solidity 0.8.36;`). The newest release that has been public for at least three months. Brand-new compiler releases carry fresh, still-undiscovered bugs; 0.8.38 was four days old when this was chosen. Revisit before stage b.
- **EVM version `prague`**, matching Pectra. Confirm Base Sepolia supports it at the first deployment (M7); drop to `cancun` if not.
- **OpenZeppelin Contracts v5.7.0**, a git submodule pinned to the tag.
- **Foundry v1.8.6** locally and in CI, so results are reproducible.
- **GitHub Actions pinned by commit SHA** (`actions/checkout` v7.0.0, `crytic/slither-action` v0.4.2), with the version in a trailing comment. A moved tag cannot change what CI runs.

## Consequences

- Bumping any pin is a deliberate commit that records the reason.
- Every Solidity file in `src/` and `test/` carries the exact pragma.
