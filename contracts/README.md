# contracts

Solidity contracts and Foundry tests: the ERC-4337 smart account and its policy modules.

Dependencies are git submodules, so clone with `--recurse-submodules`. Install [Foundry](https://book.getfoundry.sh/getting-started/installation), then:

```shell
forge build
forge test
forge fmt --check
forge coverage --report summary
```

Pinned versions and the reasons behind them: [ADR 0002](../docs/adr/0002-toolchain-pins.md).
