# 0005. Test token and how contracts are tested

Status: accepted, 2026-10-27. Extends [0002](0002-toolchain-pins.md) for the linter and the build settings it relies on.

## Decision

- **A test stablecoin built on OpenZeppelin.** `TestUSD` is OpenZeppelin's `ERC20` with `Ownable`. The agent wallet needs a token to pay with before any real one is used, and the project rule is to reach for OpenZeppelin first for every primitive it offers.
- **Six decimals.** USDC counts in six, and amounts in the x402 flow will be written in its units, so an eighteen-decimal test token would teach the wrong numbers.
- **Only the owner mints, and the supply starts at zero.** There is no open faucet: nothing needs one yet and it widens the surface. Ownership moves in one step, which a mistyped address could misuse; for a token that is worth nothing that is accepted, and `Ownable2Step` is the choice if it ever holds value.
- **The bare ERC-20 stays as a lab.** `BareToken` is written from EIP-20 alone to show what the standard fixes and leaves open, and it is the baseline for gas comparisons. It lives in `test/lab/` with the other labs, so no learning code is deployable and Slither only sees contracts that could ship.
- **Properties get an invariant test with a reference model.** A handler makes the fuzzer's calls through bounded actions, works out before each call whether it must succeed or revert with exactly which data, and keeps a model of balances, allowances and supply. Amounts cluster at zero, the balance, one above and below, and the maximum, and the zero address is a target so properties about it are not vacuous. `fail_on_revert` is on so a handler that reverts cannot hide the property it was meant to check.
- **A test of a property is proved by breaking the code.** Each property is checked by mutating the contract and seeing the test fail, with the invariant failure cache cleared between mutants. Foundry replays a persisted failing sequence first, which otherwise lets one kill leak into the next mutant.
- **Gas tests assert relations from the EIPs, not absolute numbers.** A fresh recipient costs 17,100 more than a holder because 20,000 against 2,900 is what EIP-2200 and EIP-2929 say. Relations hold in the optimized build and in the unoptimized build that `forge coverage` uses, where an absolute bound would not.
- **Solhint is part of the contracts job.** One `@notice` on every function, event and public variable, the exact pragma and custom errors; tests get a relaxed copy for Foundry's naming and low-level code.

## Consequences

- The invariants check balances, allowances and the supply, not events. Event behaviour is covered by unit tests only.
- At the CI profile the invariants make 131,072 calls and add about 50 seconds to the tests; `forge coverage` runs them again in an unoptimized build and adds about 110 seconds. Running coverage with the default profile would cut that, since coverage needs only the unit tests.
- Every gas bound in a test must hold in both builds, or `forge coverage` fails the job.
- Calls the test contract makes are charged like transactions: the 21,000 base, the calldata at its standard price, and the EIP-7623 floor. Calls between contracts are not. Gas read inside a contract and gas read from a test therefore differ by that amount.
