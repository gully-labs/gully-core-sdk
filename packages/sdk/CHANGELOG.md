# Changelog — `@gullylabs/core-sdk`

MIT. Source: <https://github.com/gully-labs/gully-core-sdk>. 0.3.0 is the first release on npm; earlier
versions were never published.

## 0.3.1 (unreleased)

- Package metadata only: the published 0.3.0 `package.json` scripts named `scripts/write-cjs-marker.mjs`,
  which is not in the tarball; `build` and `build:ci` now write the CommonJS marker inline. No API change.
- Kinetiq Elysium (99901): the explorer is Kinetiq's official one, `https://elysium.kinetiq.xyz/explorer`
  (pages `/address/<a>`, `/tx/<h>`), replacing scan.elysp.com in the address book and chain record.

## 0.3.0 (2026-11-11)

- **Every live Gully Core chain in the address book:** Anubis (6714), Robinhood Chain (4663), Base (8453),
  BNB Chain (56), Kinetiq Elysium (99901) and Gully Chain Testnet (485590), generated from the public
  deployment records of gully-labs/gully-core (`records/gully-core-<id>.json` are byte copies of its
  `deployments/<id>.json`).
- **CommonJS build** beside the ESM build (`require("@gullylabs/core-sdk")`), each with its own types.
- **`scripts/sync-check.mjs`** (`npm run sync-check`): fails when the records, gully-core's deployments and
  <https://gullycore.xyz/manifest.json> disagree on any contract of any chain.
- Router API default origin is `https://app.gullycore.xyz`.

## Before 0.3.0 (unreleased)

- **Anubis (6714) in the address book**, generated from its deployment record by
  `scripts/generate-deployments.mjs`. Gully Chain Testnet is checked against its record.
- `nativeValueAllowed`, `defaultQuote`, `assertNativeValue`, `multicall3For`. A launch that quotes in native on
  a gas-only chain is an error issue from `buildLaunchV2` and `buildLaunchAndBuyV2`.
- `LOG_RANGE_LIMITS` carries Anubis (5,000 blocks).
- The README lists what is live. The earlier entries below describe a package that was never on npm and
  address books that are no longer shipped.

## 0.2.0 — 2026-10-14

First release on npm as `@gullylabs/core-sdk`.

### Added

- Stock market reads and the `stocks` site kind.
- Robinhood Chain stock tokens (38, each read on chain from the issuer's factory), more BNB Chain
  stock tokens, Binance-Peg USDT on BNB Chain.
- The two integration prompts in `prompts/` are rewritten for `LaunchpadKitV2`: second-based
  durations, guard fees taken in the quote currency, `SwapNotFilled`, the router and
  `verifySwapCalldata`, and the public API. They now ship in the package.
- `CHANGELOG.md` ships in the package.

### Added after the first build (released with 0.2.0)

- **Limit orders and DCA, managed vaults, liquidity rewards** (`orders`, `vaults`, `rewards`), now that
  their contracts are deployed and read back on HyperEVM (999), Robinhood Chain (4663) and Base (8453)
  (2026-10-16). The address book carries `rangeOrders`, `dca`, `vaultFactory`, `lpRewardsHook`,
  `oracleHook`, `dexHook` and `tunerGate` there; BNB Chain carries none of them
  until its deployment completes.
- **Stock premiums** (`stocks/premium`): a stock token's on-chain price beside its market price
  (token-priced Chainlink feeds; share-priced feeds only through the token's own multiplier, read on
  chain), with the reason whenever the two are not comparable.
- Base Sepolia (84532) in the chain table, as Gully Core's testnet (no address-book record until deployed).
- The stock and native price-feed tables judge each round against the chain head read beside it.

## 0.1.4 — 2026-10-12

- **Address book:** HyperEVM (999), BNB Chain (56), Robinhood Chain (4663) and Base (8453), written
  from on-chain read-back, at the same contract addresses on every chain; HyperEVM's two dynamic-fee
  hooks.
- **Router:** `verifySwapCalldata` decodes router calldata and refuses anything but the requested
  swap; `GullyCoreRouterClient.swap` applies it to every answer. Swaps pay with Permit2 by
  signature, and the native coin can be paid into (and received from) a wrapped-native pool in one
  transaction.
- **Launches:** `buildLaunchAndBuyV2`, a launch and the creator's first buy in one transaction.
- **Safe:** `SafeContracts.version` is `"1.4.1" | "1.5.0"`, with the verified v1.5.0 contract set
  per chain.
- **Chains:** an endpoint that answers with a JSON-RPC limit or "busy" error cools down like one that
  answers 429; measured `eth_getLogs` range limits for BNB Chain, Robinhood Chain and Base.
- **Tokens and prices:** USDG on Robinhood Chain; native-quoted stock pools
  (`chainlinkCrossFeedConfig`; `chainlinkFeedConfig` refuses a native quote).
- **IPFS:** Gully Core's own gateway (`ipfs.gullylabs.xyz`) first in the default gateway list.

## Unreleased: release 3

- **Gully Chain Testnet is on launch kit release 3 and fee controller V5.** A launch through an outside
  Launchpad, or with no Launchpad, restates a zero protocol share and pays Gully no launch fee and no share
  of the fee or tax; the pool pays the flat 0.30%. `readLaunchValue` answers `terms`, and `readKitV2Limits`
  applies them to `rules`, `tax` and `feeSplit`.
- `TenantConfig` gains `gullyTerms`, so `createPad`, `configure` and `setTenantConfig` change shape.
  `readTenantConfig` and `readPad` read a retired kit's or pad's shorter struct too
  (`RETIRED_KIT_TENANT_ABI`, `RETIRED_PAD_TENANT_ABI`).
- `readChainFeeTerms` answers `tenantOnGullyTerms`, the two keys together.

## 0.1.3 — 2026-09-30

- `LaunchpadKitV2` with quote-currency guard fees: launch builders and validation, the guard
  generation read from the hook's permission bitmap, `decodeSwapNotFilled`, earnings reads that
  keep one claimable balance per account and currency.
- The Launchpad factory (`GullyCorePadFactory`) and pad reads, launch-and-buy, the price-band oracles.
- `@gullylabs/core-sdk/router`: typed client for the router API tier.
