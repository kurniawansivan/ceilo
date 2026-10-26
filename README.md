# Ceilo

*Set the ceiling. Let your agents spend.*

A wallet for AI agents. An ERC-4337 smart account with modular spend policies lets an agent pay for services over x402 with stablecoins, while its owner keeps hard limits: daily caps, destination whitelists, revocable session keys, and human approval above a threshold.

The repo also contains an educational blockchain (`minichain/`) built from scratch to understand the layers underneath. It is learning-only; the product runs on an existing EVM L2.

**Status:** stage a (testnet, Base Sepolia). Nothing here has been audited. Do not use with real funds.

## Layout

| Path | Contents |
|---|---|
| `contracts/` | Solidity contracts and Foundry tests |
| `minichain/` | Educational blockchain in TypeScript |
| `sdk/` | TypeScript SDK for agents (x402 integration) |
| `app/` | Policy dashboard |
| `docs/` | Roadmap, architecture decision records, per-module learn notes |

See [docs/roadmap.md](docs/roadmap.md) for the plan and [docs/adr/](docs/adr/) for the reasoning behind decisions.

## License

[MIT](LICENSE)
