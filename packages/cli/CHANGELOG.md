# Changelog — `@gullylabs/core-cli`

## 0.3.1 (unreleased)

- `npx @gullylabs/core-cli <command>` works: a `core-cli` bin (same entry as `gullycore`). On 0.3.0 npx stopped
  with "could not determine executable to run" because the package had two bins and neither matched its name.
- The swap examples (README, `--help`) quote a pair the testnet can fill: ETH to gTGULLY
  (`0x3De9…2358`, 0.001 ETH). WETH to USDC.e answered "no configured source can fill this trade".

## 0.3.0 — unreleased

- `gullycore swap quote | exec`, through the Router API or one pool with `--pool`: expected and minimum out,
  fees and price impact before any signature. `gullycore quote` is `swap quote`.
- `gullycore pool list | info | create`, `gullycore liquidity add | remove` (CL and Bin), `gullycore fees`,
  `gullycore tokens list | info`, `gullycore chain list | status`, `gullycore config`,
  `gullycore completion`, and `gullycore lock position | status | claim`.
- `--dry-run` on every write, `--hardware ledger|trezor` through Foundry's `cast`, `GULLYCORE_KEYSTORE`,
  `GULLYCORE_KEYSTORE_PASSWORD` and `--network`, the same flag as `--chain`.
- Safety: a mainnet write needs a typed confirmation, or `--yes` with the network named on the command line.
  A slippage guard, a price impact guard and exact approvals. A write on a chain with no deployment is
  refused.
- Exit codes are now a stated interface (see the README), and `--json` covers `new`, `init` and `bitmap`.
  A `--json` failure's hint no longer lands on stdout.
- Chains: examples and messages follow the address book, which holds Gully Chain Testnet and Anubis. A chain
  with no deployment says so. Native value is refused on a gas-only chain, and `launch` defaults to its quote
  token there.
- `launch` follows launch kit release 2: the fixed 1,000,000,000 supply, the fixed 50% protocol share, and a
  tax that may last forever (`--tax-days forever`). Any tax used to be refused on such a kit.
- `gullycore new` and `devnet` fetch the public contracts, https://github.com/gully-labs/gully-core at
  e98ab87, with their submodules. `devnet` deploys plainly: the public contracts carry no CREATE3 factory,
  so its deployment JSON has no `create3Factory` field any more.
- The bundled terminal logo was another project's. It now comes from Gully Chain kit v4's gc-icon.svg, carried
  byte-identical and rendered for the terminal, and the colours are the kit's table.
- A user's RPC URL is no longer printed in a `cast send` line.

- `gullycore devnet` runs without a Gully Core checkout: inside a generated project it uses the
  project's `lib/gullycore-contracts`; anywhere else it clones the public contracts repository at
  the pinned commit into `<workdir>/contracts` once. `--core` / `GULLYCORE_CORE_PATH` and a checkout
  on disk still win.
- `gullycore devnet` no longer prints a key passed to `--deployer-key` in its PowerShell hint (only
  anvil's public test key is ever printed), and prints `BIN_POOL_MANAGER` beside `CL_POOL_MANAGER`.
- New hook template `bin-swap-counter`: a Bin pool hook on `BaseBinHook`, with a `BinPoolManager`
  test harness and a deploy script; `--bin-step` and a static `--fee` (at most 10%) apply to it.
- The agent guide (`AGENTS.md` / `CLAUDE.md` in every project) covers Bin pools.

## 0.2.0 — 2026-10-14

Ported version; never published to npm by Gully Labs.

- With no Gully Core checkout on disk, `create-gully-core-hook` / `gullycore new` fetches the public
  contracts repository (<https://github.com/gully-labs/gully-core>) into the project as the
  submodule `lib/gullycore-contracts`, at one pinned commit, and checks the commit after the fetch.
- Generated hooks, tests and deploy scripts carry GPL-2.0-or-later.
- Generated app projects depend on `@gullylabs/core-sdk` ^0.2.0 from npm.
