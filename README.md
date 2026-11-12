# Gully Core SDK

TypeScript tools for [Gully Core](https://gullycore.xyz), the shared liquidity core by Gully Labs, built on
PancakeSwap Infinity's audited core. MIT licensed.

| Package | What it is | npm |
|---|---|---|
| [`@gullylabs/core-sdk`](packages/sdk) | The address book for every Gully Core chain, pool keys and ids, hook permission bitmaps, typed events, quotes, launches, locks, vaults, orders and the Router API client. ESM and CommonJS, with types. Only dependency: `viem`. | `npm i @gullylabs/core-sdk viem` |
| [`@gullylabs/core-cli`](packages/cli) | The `gullycore` command: swap, pools, liquidity, launches, locks, fees and chains from a terminal. Every send is simulated first; it signs only with an encrypted keystore or a hardware wallet. | `npm i -g @gullylabs/core-cli` |
| [`@gullylabs/create-core-app`](packages/create-gully-core-app) | The app template: scaffold a DEX, a Launchpad or both on Gully Core. | `npm create @gullylabs/core-app@latest my-app` |
| [`@gullylabs/core-connect`](packages/connect) | The template's wallet layer over RainbowKit and wagmi: the Gully Core chain list, a connect button and a chain switcher. | not on npm yet (next release) |
| [`@gullylabs/core-widgets`](packages/widgets) | The template's React widgets: swap, launch, liquidity and locks, every send simulated first. | not on npm yet (next release) |

CommonJS note: `require("@gullylabs/core-sdk")` works at runtime. viem publishes ESM-only type definitions, so a
TypeScript project compiled as CommonJS with `moduleResolution: node16` needs `skipLibCheck` (the default in most
setups); ESM and bundler projects need nothing.

Docs: <https://docs.gullycore.xyz>. Contracts, deployment records and the integration guide:
<https://github.com/gully-labs/gully-core>.

## Chains

Every address in the SDK is generated from the public deployment records in
[gully-labs/gully-core `deployments/`](https://github.com/gully-labs/gully-core/tree/main/deployments). A sync check
(`pnpm sync-check`) fails when the SDK, those records and <https://gullycore.xyz/manifest.json> disagree.

| Chain | Chain id | Native coin | Keyless RPC (Gully RPC) |
|---|---|---|---|
| Anubis | 6714 | gasDAI (gas only: send no native value) | `https://rpc.gullyrpc.xyz/gullychain/evm/6714` |
| Robinhood Chain | 4663 | ETH | `https://rpc.gullyrpc.xyz/gullychain/evm/4663` |
| Base | 8453 | ETH | `https://rpc.gullyrpc.xyz/gullychain/evm/8453` |
| BNB Chain | 56 | BNB | `https://rpc.gullyrpc.xyz/gullychain/evm/56` |
| Kinetiq Elysium | 99901 | HYPE | `https://rpc.gullyrpc.xyz/gullychain/evm/99901` |
| Gully Chain Testnet | 485590 | ETH (testnet) | `https://rpc.gullyrpc.xyz/gullychain/evm/485590` |

The keyless endpoints are rate limited. For production traffic use your own Gully RPC key
(<https://gullyrpc.xyz>) or any RPC for the chain.

## A swap quote in five minutes

```bash
mkdir quote && cd quote && npm init -y && npm i @gullylabs/core-sdk viem
```

`quote.mjs`:

```js
import { createPublicClient, http, parseEther, formatUnits } from "viem";
import { applySlippage, quoteExactInputSingle, requireDeployment } from "@gullylabs/core-sdk";

const chainId = Number(process.argv[2] ?? 485590); // any chain id from the table above
const book = requireDeployment(chainId);           // every address comes from the book: never paste one
const client = createPublicClient({ transport: http(`https://rpc.gullyrpc.xyz/gullychain/evm/${chainId}`) });

// A pool key. Find pools with `gullycore pool list --chain <id>` or the Gully Core API
// (https://app.gullycore.xyz/v1/chains/<id>/pools), then fill in its key.
const poolKey = {
  currency0: "0x0000000000000000000000000000000000000000", // native coin
  currency1: "0x...",                                      // the other token
  hooks: "0x...",
  poolManager: book.clPoolManager,
  fee: 8388608,                                            // the pool's fee field (this value = dynamic fee)
  parameters: "0x...",
};

// The quoter runs the real swap against current state with eth_call. Nothing is sent.
const { result } = await client.simulateContract(
  quoteExactInputSingle({ quoter: book.clQuoter, poolKey, tokenIn: poolKey.currency0, amountIn: parseEther("0.01") }),
);
console.log("out", formatUnits(result[0], 18), "min out at 0.5%", formatUnits(applySlippage(result[0], 50), 18));
```

```bash
node quote.mjs 485590   # Gully Chain Testnet
node quote.mjs 8453     # Base
```

The same quote from the CLI, with the pool found for you:

```bash
gullycore pool list --chain 485590 --from-chain
gullycore swap quote --chain 485590 --pool <poolId> --in ETH --out <token> --amount 0.01
```

Per chain:

- **Gully Chain Testnet (485590):** pools exist today; this is the place to try a quote and a swap.
- **Base (8453), BNB Chain (56), Robinhood Chain (4663), Kinetiq Elysium (99901):** the contracts are live and
  source-verified. A quote needs a pool on that chain; `gullycore pool list --chain <id>` shows what exists.
- **Anubis (6714):** gasDAI pays gas only, so a swap from the native coin is refused. Quote token-to-token pools,
  and keep `value` at 0 (`assertNativeValue(book, value)` throws otherwise).

To send a swap, see the SDK README ([packages/sdk](packages/sdk/README.md)): build the call, simulate the exact
bytes with `eth_call`, then send them.

## Develop

Node 20 or newer and pnpm 10.

```bash
pnpm install
pnpm build        # every package
pnpm typecheck
pnpm test         # unit tests, offline
pnpm sync-check   # SDK records == gully-core deployments == gullycore.xyz/manifest.json (network)
pnpm smoke        # pack every package, install the tarballs in a fresh project, read-only quotes on testnet and a mainnet
```

### Where the source lives

These packages are developed inside Gully Labs' Gully Core monorepo, where the Gully Core apps consume them as
workspace packages, and are mirrored here by a sync step on every release. This repository is the public source
of every published version: each npm release is tagged here (`core-sdk-v0.3.0`, ...) and built from this tree.
Issues and pull requests are welcome here; an accepted change is applied in the monorepo and mirrored back in the
next sync, so the two never drift.

## Releasing

`scripts/publish.sh` publishes from a clean checkout of a tagged commit. It runs the build, the tests, the sync check
and the tarball smoke test, then `npm publish` for each package in order (sdk, core-connect, core-widgets, create-core-app, cli). It reads an npm
automation token from `NPM_TOKEN` when one is set, or uses the npm login of the machine it runs on. When GitHub Actions
runs, `.github/workflows/release.yml` does the same on a `v*` tag with npm provenance.

## Licence and credits

MIT, see [LICENSE](LICENSE) and [NOTICE](NOTICE). The SDK holds no Solidity: it describes contracts that are
GPL-2.0-or-later (Gully Core, built on PancakeSwap Infinity), and importing it does not bring their licence into your
code. Security reports: [SECURITY.md](SECURITY.md).
