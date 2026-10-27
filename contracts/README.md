# contracts

Solidity contracts and Foundry tests: the ERC-4337 smart account and its policy modules.

Dependencies are git submodules, so clone with `--recurse-submodules`. Install [Foundry](https://book.getfoundry.sh/getting-started/installation), then:

```shell
forge build
forge test
forge fmt --check
forge coverage --report summary
npm ci --ignore-scripts && npm run lint    # solhint
```

Pinned versions and the reasons behind them: [ADR 0002](../docs/adr/0002-toolchain-pins.md). How the contracts are tested and why: [ADR 0005](../docs/adr/0005-test-token-and-contract-testing.md).

## What is here

| Path | What it holds |
|---|---|
| `src/TestUSD.sol` | A test stablecoin: OpenZeppelin's ERC-20 with six decimals, minted only by its owner. For tests and testnets only. |
| `test/TestUSD.t.sol` | Unit and fuzz tests, including where OpenZeppelin differs from the bare standard. |
| `test/invariant/` | Invariant tests: a handler makes bounded random calls and checks each against a reference model. |
| `test/gas/` | What calls cost, derived from the EIPs: storage writes, allowances, calldata and the EIP-7623 floor. |
| `test/lab/` | Learning labs, not deployable: how a call executes, what state costs, and an ERC-20 written from EIP-20 alone. |

## How the labs read

Each lab states a rule from an EVM spec and measures it from inside a contract, so a reader can change the code and watch the number move. Start with `test/lab/RawBytecode.t.sol`, where contracts are written as opcodes.
