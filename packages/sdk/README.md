<p align="center">
  <a href="https://gullycore.xyz">Website</a> ·
  <a href="https://docs.gullycore.xyz">Docs</a> ·
  <a href="https://github.com/gully-labs/gully-core-sdk">GitHub</a>
</p>

# @gullylabs/core-sdk

TypeScript SDK for **Gully Core**: a hooks platform on its own Infinity-architecture core (Vault, CL and Bin pool managers) that Launchpads and DEXes ship on without deploying an AMM.

**Live on Anubis (6714), Robinhood Chain (4663), Base (8453), BNB Chain (56), Kinetiq Elysium (99901) and
Gully Chain Testnet (485590).** Every chain runs launch release 3 and fee controller V5. Every address ships
in this package's address book, generated from the public deployment records in
[gully-labs/gully-core](https://github.com/gully-labs/gully-core/tree/main/deployments) and checked against
<https://gullycore.xyz/manifest.json>. MIT.

```bash
npm install @gullylabs/core-sdk viem
```

| Network | Chain id | Status | Quote token | Gas |
|---|---|---|---|---|
| Anubis Network | 6714 | Live, source-verified on Sourcify | DAI (ERC-20) | gasDAI, gas only |
| Robinhood Chain | 4663 | Live, source-verified | ETH | ETH |
| Base | 8453 | Live, source-verified | ETH | ETH |
| BNB Chain | 56 | Live, source-verified | BNB | BNB |
| Kinetiq Elysium | 99901 | Live, source-verified | HYPE | HYPE |
| Gully Chain Testnet | 485590 | Live, source-verified (testnet) | ETH | ETH |

HyperEVM (999) is planned and not deployed: `getDeployment(999)` returns `undefined`.

### Anubis: three rules

- **gasDAI pays gas and nothing else.** A transaction with a value fails, there is no native pool and
  no wrapped native. Quote in DAI (`defaultQuote(book)`) and pay with ERC-20 approvals. Every native fee
  on Anubis is 0, so `value` is 0 on every call. `assertNativeValue` refuses anything else.
- **`eth_getLogs` serves 5,000 blocks a request** from `https://rpc.anubispace.org`. Start at
  `book.deployedAtBlock` and page. `logSpanBoundsFor(6714)` gives the limit.
- **Multicall3 is not at the canonical address.** Use `multicall3For(chainId)`. Anubis also has one public RPC
  endpoint; set `GULLYCORE_RPC_6714` if you have your own.

## Quickstart

Quote, swap, launch, create a Launchpad, lock. There are no pools on Anubis yet, so the quote and the
swap need a pool you opened; on Gully Chain Testnet they work today. This listing is compiled by the
test suite.

```ts
import { createPublicClient, createWalletClient, custom, parseUnits, toHex, type Address, type EIP1193Provider, type Hex } from "viem";
import {
  LAUNCH_TOKEN_DECIMALS, NATIVE_ADDRESS, PRESET, applySlippage, assertNativeValue, buildLaunchV2, defaultQuote, gullycoreTransport,
  prepareCreatePad, quoteExactInputSingle, readKitV2Limits, requireDeployment, requireLaunchpadV2, type PadTerms, type PoolKey,
} from "@gullylabs/core-sdk";
import { buildErc20Approve, buildTokenLock, readChainNow, readErc20Allowance, readFeeGate, timeLockSchedule, validateTokenLock } from "@gullylabs/core-sdk/lock";

// Set up. Every address comes from the book. Never paste one.
const chainId = 6714; // Anubis. Use 485590 for Gully Chain Testnet.
const book = requireDeployment(chainId);
const client = createPublicClient({ transport: gullycoreTransport(chainId) });
const wallet = createWalletClient({ transport: custom(provider) });
const [me] = await wallet.requestAddresses();
if (me === undefined) throw new Error("connect a wallet");

// Simulate the exact bytes, then send them. On Anubis `value` must be 0: gasDAI pays gas only.
const send = async (tx: { readonly to: Address; readonly data: Hex; readonly value: bigint }) => {
  assertNativeValue(book, tx.value);
  await client.call({ account: me, to: tx.to, data: tx.data, value: tx.value });
  return wallet.sendTransaction({ account: me, chain: null, to: tx.to, data: tx.data, value: tx.value });
};

// Quote: run the real swap against current state with eth_call. Never send it.
const { result } = await client.simulateContract(
  quoteExactInputSingle({ quoter: book.clQuoter, poolKey: key, tokenIn, amountIn: parseUnits("100", 18) }),
);
const minAmountOut = applySlippage(result[0], 50); // 0.5%
console.log(minAmountOut);

// Launch a token. `defaultQuote` is DAI on Anubis and the native coin where native works.
const quote = defaultQuote(book);
const kit = requireLaunchpadV2(book).launchpadKitV2;
const supply = parseUnits("1000000000", LAUNCH_TOKEN_DECIMALS);
const limits = await readKitV2Limits(client, kit);
const launch = await buildLaunchV2(client, kit, {
  name: "[NAME]", symbol: "[SYMBOL]", metadataURI: "",
  totalSupply: supply, seedSupply: supply, allocationRecipient: NATIVE_ADDRESS,
  creator: me, operator: me, steward: me, launcher: me,
  protocolBps: limits.locker.minProtocolBps,
  schedule: { preset: PRESET.FairLaunch, initialFeeBips: 100_000, finalFeeBips: 3_000, decaySeconds: 300, startDelaySeconds: 0 },
  legs: [{
    kind: "CL", quote: quote.address, quoteDecimals: quote.decimals, weightBps: 10_000,
    quotePerLaunchToken: "[PRICE]", maxBuyPerTx: 0n, tickSpacing: 60, widthInSpacings: 200,
    binStep: 100, shape: "Linear", binCount: 10,
  }],
  listing: { description: "", websiteURI: "", xHandle: "", telegramHandle: "" },
  userSalt: toHex(crypto.getRandomValues(new Uint8Array(32))),
}, limits);
const errors = launch.issues.filter((i) => i.severity === "error");
if (errors.length > 0) throw new Error(errors.map((i) => `${i.field}: ${i.message}`).join("\n"));
await send(launch);

// Create a Launchpad or DEX. An outside pad pays Gully a flat 0.30% of every trade and nothing else.
const terms: PadTerms = {
  integrator: feeWallet, integratorBps: 500, integratorLaunchFeeWei: 0n,
  allowedPresets: [], allowedBinShapes: [], restrictQuotes: false, active: true,
};
const pad = await prepareCreatePad(client, { chainId, creator: me, name: "Mochi Launchpad", brand: null, terms });
if (pad.exists) throw new Error(`this wallet already made that Launchpad: ${pad.predicted}`);
await send(pad.tx);

// Lock tokens until a date. The clock is block.timestamp, in seconds.
if (book.tokenLock === null) throw new Error(`no GullyCoreTokenLock on ${book.name}`);
const lock = book.tokenLock;
const amount = parseUnits("1000000", LAUNCH_TOKEN_DECIMALS);
const now = await readChainNow(client);
const schedule = timeLockSchedule(now + 180n * 86_400n);
const issues = validateTokenLock({ currency: launch.token, amount, beneficiary: me, schedule, nowSeconds: now, lock });
if (issues.length > 0) throw new Error(issues.map((i) => i.message).join(" "));
if ((await readErc20Allowance(client, launch.token, me, lock)) < amount) {
  await send(buildErc20Approve({ token: launch.token, spender: lock, amount }));
}
await send(buildTokenLock({ lock, currency: launch.token, amount, beneficiary: me, schedule, terms: await readFeeGate(client, lock) }));
```

Swap through the `UniversalRouter`, with the builder in `@gullylabs/core-widgets/headless`:

```tsx
import { applySlippage, quoteExactInputSingle, requireDeployment, type PoolKey } from '@gullylabs/core-sdk'
import { NO_INTEGRATOR_FEE, buildSwapCall } from '@gullylabs/core-widgets/headless'

const chainId = 6714;
const book = requireDeployment(chainId)

// 1. Quote, then floor the output at your slippage.
const { result } = await client.simulateContract(quoteExactInputSingle({ quoter: book.clQuoter, poolKey: key, tokenIn, amountIn }))
const minOut = applySlippage(result[0], 50)

// 2. Encode UniversalRouter.execute: one CL swap, the input settled from the caller
//    through Permit2, the output taken to the caller, floored at minOut.
const call = buildSwapCall({
  router: book.universalRouter,
  hops: [{ poolKey: key, poolType: 'CL', currencyIn: tokenIn, currencyOut: tokenOut }],
  amountIn,
  minAmountOutGross: minOut,
  minAmountOutNet: minOut,
  integrator: NO_INTEGRATOR_FEE,
  recipient: account,
  sender: account,
  deadline: BigInt(Math.floor(Date.now() / 1000) + 300),
})

// 3. Simulate the exact bytes, then send them. `value` is amountIn when the input is native.
await client.call({ account, to: call.to, data: call.data, value: call.value })
await wallet.sendTransaction({ account, chain: wallet.chain ?? null, to: call.to, data: call.data, value: call.value })
```

## Features

Gully Core is one shared liquidity core (a single Vault with concentrated-liquidity and Bin pool
managers) that Launchpads and DEXes build on instead of deploying their own AMM. The SDK is the
typed way in:

- **One address book.** `GULLYCORE_CHAIN_IDS` is `[6714, 485590]` (Anubis, Gully Chain Testnet);
  `getDeployment(id)` returns every contract on that chain, `null` where one is not shipped, and the
  block to start log scans from.
- **Cross-chain reads.** `readPadAcrossChains` asks each chain about a Launchpad or DEX by its
  creator and salt, and tells "not there" apart from "could not read". Gully's two chains have
  different addresses, so read each row's own address.

- **Protocol types.** Pool keys and ids, currencies, balance deltas, fees, the hook permission bitmap,
  and typed definitions for every event the contracts emit.
- **Launches.** Build and validate a token launch on a CL range or a shaped Bin distribution:
  presets, the opening price from a market cap, the anti-snipe fee schedule (up to 50% on CL, 10% on
  Bin, decaying over at least 60 seconds), the optional creator tax (up to 10%, expiring on its own)
  and a Launchpad's terms, then simulate the exact bytes before sending.
- **Launchpads and DEXes.** Read and write the on-chain owner, name and brand of a Launchpad or DEX
  created through `GullyCorePadFactory`.
- **Market reads.** Trades, candles, holders, the pool directory and spot price, from logs and
  `getSlot0`, denominated in the quote token.
- **Prices with provenance.** A native/USD price resolved from Chainlink on chain, then Pyth, then a
  Gully Core pool; every answer says where it came from, and "no source" is an answer, not a zero.
- **Utilities.** Liquidity locks, token locks and vesting, multisend, Merkle airdrops and team splits.
- **Registry and trust.** What the on-chain registry records about a hook, rendered without implying
  an audit.
- **Chains.** Public endpoints per chain with a failover transport, measured `eth_getLogs` range
  limits per endpoint, and a reader for the clock the contracts actually see.
- **Routing.** Quotes and calldata for the router: Gully Core pools pay no router fee, a fill routed to
  another venue pays the fee `GullyCoreFillRouter.feeBps()` reports.

### Modules

It also carries the modules the rest of the product is built from, and they are all MIT:

| Module | What it does |
|---|---|
| `launchpad/` | Build and validate a launch: presets, CL ranges and Bin shapes, the creator tax, tenant terms, the pads |
| `price/` | Resolve a native/USD price in tiers — Chainlink on chain, then Pyth, then a Gully Core pool — and turn it into a market cap. Every answer carries its provenance, and "no source" is a first-class answer rather than a zero |
| `lock/`, `drop/`, `split/`, `utilities/` | Liquidity locks, token locks and vesting, Merkle airdrops, multisend, team splits, and the shared fee gate in front of them |
| `rwa/` | Tokenised equities: the verified feed table, and the exact `configureFeed` / `configureMarket` arguments a banded stock pool needs |
| `trading/` | Routing and fills, including the router that can fill on a third-party venue |
| `registry/`, `trust/` | What the on-chain registry says about a Gully Core, and how to render it without ever implying it is an audit |
| `tokenlists/` | The Gully Core token list in the standard schema, merged and verified |
| `chains/` | Probed public endpoints per chain, a failover transport, and the contract-clock reader — because on some chains `block.number` inside the EVM is not the block number the RPC reports |
| `router/` | Typed client for the routing API, and `verifySwapCalldata`, which decodes the calldata the API returns and refuses anything but the swap you asked for. Check every router transaction with it before it is signed |

| `orders/` | Limit orders (`GullyCoreRangeOrders`) and DCA plans (`GullyCoreDCA`): build, read and cancel |
| `vaults/` | Managed vaults (`GullyCoreVaultFactory` and its vaults): create, deposit, withdraw, read |
| `rewards/` | Liquidity rewards (`GullyCoreLiquidityRewardsHook`): fund a stream, read and claim earnings |
| `stocks/` | Tokenized stocks: the market session, and each token's on-chain price beside its market price |

The address book carries `rangeOrders`, `dca`, `vaultFactory`, `lpRewardsHook`, `oracleHook`, `dexHook`
and `tunerGate` where those contracts are deployed and read back (both chains today), and `null` where
they are not. Never assume an address is there: check it.

---

## Licensing, and why it matters

The Solidity core is **GPL-2.0-or-later**. That licence is viral: code that links against it can inherit the obligation. If building a hook required importing GPL sources, every third-party hook would arguably become a derivative work.

**This package is the firewall.** It is MIT-licensed and independently authored:

- No Solidity source, comment or NatSpec from `packages/core` is copied into it.
- Types are derived from the **compiled ABI JSON** — a machine-generated description of selectors, argument names and argument types — by the generator in `scripts/generate-events.mjs`.
- All prose, naming and structure here are original.

You can build a hook, an indexer or a front end on this SDK under MIT terms. Deploying against the on-chain contracts is not the same as linking their source; nothing in this package requires you to open your hook.

---

## Launching a token

`LaunchpadKitV2.createLaunch` opens a launch in one transaction: the token, the pool, the anti-snipe
schedule, the seeded liquidity (locked forever) and the registry listing. The [Quickstart](#quickstart)
has the whole call.

`buildLaunchV2` takes the kit's limits, predicts the token address, snaps
the opening price to the pool's grid and returns every objection as an `issue` before a wallet is
opened; `client.call` simulates the exact bytes before they are sent. Every duration in the kit
and the guards is `block.timestamp`, in seconds.

### Two block clocks

On an Arbitrum Nitro chain (Robinhood Chain is one) `block.number` inside the EVM is Ethereum's
block number, while `eth_blockNumber` is the L2 block. Compare any block number a contract stores
against `readContractBlockNumber(client, chainId)`, never against `getBlockNumber()`; keep
`getBlockNumber()` for `eth_getLogs` ranges, which are on the L2 clock.

```ts
const clock = await readContractClock(publicClient, chainId)
clock.contractBlockNumber   // the EVM's block.number
clock.rpcBlockNumber        // eth_blockNumber, the log clock (equal on a "native" chain)
```

---

## Market data

`packages/sdk/src/market` reads everything a token or pool page shows from the chain alone, and
labels where each number came from so a page can print it. **Nothing is priced in dollars.** Every
price is quote per whole base token, every volume is in the quote currency.

| Figure | Source |
|---|---|
| trades | the pool manager's `Swap` logs for the pool id (CL or Bin) — `readPoolTrades` |
| price after each trade | the pool's own price in the log (`sqrtPriceX96` on CL, `activeId` on Bin), oriented by `priceFromSqrt` / `priceFromBinId` |
| spot | `getSlot0` — `readSpotPrice` |
| volume | the quote-side amount of every swap, absolute, summed — `marketStats` |
| candles | `buildCandles(trades, bucketSeconds)`; **a bucket with no trade is not emitted** |
| holders | the token's `Transfer` logs since its launch block, reduced to balances — `readHolders` |
| pool directory | both managers' `Initialize` logs with the full key — `readPoolDirectory` |

```ts
import {
  readPoolTrades, withTimestamps, buildCandles, marketStats, readSpotPrice, readHolders, readPoolDirectory,
  type MarketPool,
} from "@gullylabs/core-sdk"

// Orientation is explicit. `baseIsCurrency0` says which currency is the launch token; both
// decimals are required. A wrong decimals value is a 10^12 mispricing, not a display bug.
const pool: MarketPool = { poolId, kind: "CL", key, baseIsCurrency0: true, baseDecimals: 18, quoteDecimals: 6 }

const raw = await readPoolTrades(client, pool, { fromBlock: launchBlock })  // one eth_getLogs
const trades = await withTimestamps(client, raw)                             // one header per distinct block
const spot = await readSpotPrice(client, pool)                               // quote per base, now

const candles = buildCandles(trades, 300)             // 5-minute OHLC, gaps left as gaps
const day = marketStats(trades, now - 86_400)         // trades, buys, sells, volumeQuote, first, last, change
const holders = await readHolders(client, token, { fromBlock: launchBlock, totalSupply })
holders.fromBlock                                     // what "since block N" on a page means

// Every pool the chain's Gully Core managers opened since a block: the directory a DEX front routes through.
const listings = await readPoolDirectory(client, { clPoolManager, binPoolManager }, { fromBlock: deployedAtBlock })
```

Swap deltas follow the Vault's convention: a negative amount was paid by the trader, a positive one
received; `side` is judged from the base token's delta. `Trade.sender` is the pool manager's caller
(a router), never the end user. `readHolders` lists the Vault and the lockers because they hold —
label them, do not hide them.

---

## Pads: a launchpad or DEX somebody else runs

A **pad** is one `GullyCorePad` contract, cloned by `GullyCorePadFactory.createPad` and made a
`LaunchpadKitV2` tenant in the same transaction. The pad *is* the tenant (every launch names it),
its owner configures it, and ownership moves two-step. The pad holds nothing: the kit and the
lockers credit the integrator wallet the owner names, and `configure` refuses the pad itself.

Two things live on a pad and they are not alike:

- **Terms** (`TenantConfig`) are stored on the kit and **enforced on every launch that names the
  pad**: integrator, `integratorBps` (≤ the lockers' `maxIntegratorBps`), `integratorLaunchFeeWei`
  (≤ the kit's `maxIntegratorLaunchFeeWei`), allowed presets, allowed Bin shapes, `restrictQuotes`,
  `active`. `PadTerms` spells them in names; `tenantConfigFromTerms` turns them into the struct.
- **The brand** (`PadBrand`) is the pad's `metadataURI`, stored inline as a `data:application/json`
  URI of at most `PAD_MAX_METADATA_URI_BYTES` (4,096) bytes: tagline, logo URL, accent, one of
  `PAD_THEMES`, links, `kind` (`launchpad` | `dex` | `both`), `dex: { enabled, feeBps, scope }` and
  `customDomain`. **Nothing in the brand is enforced by any contract.** `dex.feeBps`
  (≤ `PAD_MAX_DEX_FEE_BPS`, 100) is a request to whichever front end hosts the pad.

```ts
import {
  encodeCreatePad, encodeSetPadMetadata, encodeConfigurePad,
  readPad, readPads, padKindOf, padDexScopeOf, padHostnameOf, validatePadBrand,
  type PadBrand, type PadTerms,
} from "@gullylabs/core-sdk"

const brand: PadBrand = {
  v: 1,
  tagline: "Launches for the Mochi community",
  theme: "frost",
  accent: "#1f9e89",
  kind: "both",
  dex: { enabled: true, feeBps: 25, scope: "all" },   // a request to the hosting front end
  customDomain: "launch.mochi.xyz",                    // the owner's half of the domain proof
}
validatePadBrand(brand)   // [] — every objection, cheapest first; encode throws on any

const terms: PadTerms = {
  integrator: feeWallet,        // never the pad
  integratorBps: 500,
  integratorLaunchFeeWei: 0n,
  allowedPresets: [],           // [] means every preset
  allowedBinShapes: [],         // [] FORBIDS Bin legs
  restrictQuotes: false,
  active: true,
}

// One transaction to GullyCorePadFactory, paying its flat site fee; the owner is msg.sender.
// `readPadFactoryFee` reads padFeeWei / pendingPadFee / maxPadFeeWei / padFeeNoticeSeconds /
// protocolFeeRecipient; `buildCreatePad` sends `padSafeValue(fee)` (the higher of the fee in force
// and an announced increase) and the factory refunds the difference in the same call.
const fee = await readPadFactoryFee(client, factoryAddress)
const create = buildCreatePad({ factory: factoryAddress, name: "Mochi Pad", brand, terms, fee }) // { to, data, value }

// Later, from the owner: rename / re-brand, or change the terms.
const rebrand = encodeSetPadMetadata("Mochi Pad", { ...brand, tagline: "Now with Bin launches" })
const retune = encodeConfigurePad({ ...terms, integratorBps: 300 })

// Reads. `metadata.kind` is brand | remote | empty | invalid — never a default brand.
const pad = await readPad(client, padAddress)
const b = pad.metadata.kind === "brand" ? pad.metadata.brand : null
padKindOf(b)        // "launchpad" when absent
padDexScopeOf(b)    // "launches" when absent
padHostnameOf(b)    // a valid hostname or null
pad.tenant.configured   // false when the kit never stored terms for it

const all = await readPads(client, factoryAddress)   // padCount / pads(start, end); no log scan
```

`readPad` returns the kit's stored terms decoded (`tenant`), the pending owner, and the brand as
one of four states. A `remote` brand (`ipfs://`, `https://`) is returned as a URL for the caller to
fetch and run through `validatePadBrand`; the SDK does not fetch.

Read `GullyCoreDeployment.launchpadV2.padFactory` for the chain you are on: an address means the
factory is there, `null` means it is coming soon on that chain. The helpers also encode and read
against a factory you name, so they work either way — and reading the address book is the right
check in code, because a sentence in a README goes stale the day something ships.

---

## Install

```bash
npm install @gullylabs/core-sdk viem
# or: pnpm add @gullylabs/core-sdk viem / yarn add @gullylabs/core-sdk viem
```

`viem` is the only runtime dependency (used for `Address`/`Hex` types, ABI encoding and `keccak256`).

Requires Node 20+. ESM (`import`) and CommonJS (`require`) builds ship side by side, each with its own type
definitions (TypeScript 5.x, `"strict": true`).

---

## Deployed addresses

Every deployed Gully Core contract ships with the package. You should never have to hand-type one.

```ts
import { GULLYCORE_DEPLOYMENTS, GULLYCORE_CHAIN_IDS, explorerAddressUrl, getDeployment, tokenBySymbol } from "@gullylabs/core-sdk";
// or, tree-shaking only this:
// import { ... } from "@gullylabs/core-sdk/deployments";

const gullycore = getDeployment(chainId);       // undefined where Gully Core is not deployed
if (gullycore) {
  gullycore.vault;
  gullycore.clPoolManager;
  gullycore.universalRouter;
  gullycore.deployedAtBlock;                    // start log scans here, not at genesis
}

for (const id of GULLYCORE_CHAIN_IDS) {         // 6714, 4663, 8453, 56, 99901, 485590
  const d = getDeployment(id)!;
  console.log(d.name, d.vault, explorerAddressUrl(id, d.vault));
}
```

`GULLYCORE_CHAIN_IDS` lists the chains that carry a record. A chain joins the book from its deployment
record (`records/gully-core-<id>.json`, turned into `src/deployments/generated/` by
`scripts/generate-deployments.mjs`) after every contract is deployed, source-verified and read back:
never before, and never with a placeholder. For any other chain `getDeployment(id)` returns `undefined`; render
that as "not available on this chain", do not guess.

**`null` means not deployed. It is never the zero address.** A contract Gully Core has not shipped on a
chain reads `null`, so the compiler makes you handle it. A zero
address would not: it is a value `readContract` accepts and answers with silence.

```ts
if (gullycore.launchpadKit === null) {
  // render "not configured on this chain", do not substitute an address
}
requireContract(gullycore, "launchpadKit"); // or throw a sentence that names the chain
```

**Tokens carry their decimals**, because `sqrtPriceX96` encodes a price as a ratio of *raw* units.
A USD stablecoin is commonly 6 decimals and WETH is 18; assuming 18 for both misprices a pool by
10¹², and that price is fixed permanently at `initialize`.

```ts
tokenBySymbol(chainId, "WETH")?.decimals;  // from the record, never assumed
```

**Some of these addresses move.** `REDEPLOYABLE_CONTRACTS` names the ones that do — the registry,
the RevShareHook, the timelocks, the fee controller and the launchpad contracts. Their stale
failure mode is silent: a retired `GullyCoreRegistry` still answers `gullycoreCount()` and renders as a
healthy, empty marketplace. Read them from this module at call time rather than snapshotting them
into a build. The `Vault` is immutable and will not move.

An address book is a claim, not a proof. Verify with `eth_getCode` before you rely on one.

---

## The differentiator: permissions live in the pool key, not the address

In Uniswap v4, a hook's permissions are read from the **address** of the hook contract. Each callback is a bit of the address, so shipping a hook means grinding a CREATE2 salt until the deployed address happens to carry the right low bits. Change your mind about one callback and you redeploy at a new address.

Gully Core takes permissions out of the address entirely. They live in the **low 16 bits of `poolKey.parameters`**, and the pool manager cross-checks that word against the hook's own `getHooksRegistrationBitmap()` view when the pool is initialized.

Consequences you can rely on:

- **No vanity-salt mining.** Deploy your hook at whatever address CREATE gives you.
- **One hook, many permission sets.** The same deployed contract can back several pools with different bitmaps, provided it reports the bitmap each pool key declares.
- **The bitmap is part of the pool identity.** It is hashed into the pool id, so flipping one bit yields a different pool.

### Bitmap layout

| Bit | Concentrated liquidity (CL)        | Liquidity book (bin)     |
| --- | ---------------------------------- | ------------------------ |
| 0   | `beforeInitialize`                 | `beforeInitialize`       |
| 1   | `afterInitialize`                  | `afterInitialize`        |
| 2   | `beforeAddLiquidity`               | `beforeMint`             |
| 3   | `afterAddLiquidity`                | `afterMint`              |
| 4   | `beforeRemoveLiquidity`            | `beforeBurn`             |
| 5   | `afterRemoveLiquidity`             | `afterBurn`              |
| 6   | `beforeSwap`                       | `beforeSwap`             |
| 7   | `afterSwap`                        | `afterSwap`              |
| 8   | `beforeDonate`                     | `beforeDonate`           |
| 9   | `afterDonate`                      | `afterDonate`            |
| 10  | `beforeSwapReturnsDelta`           | `beforeSwapReturnsDelta` |
| 11  | `afterSwapReturnsDelta`            | `afterSwapReturnsDelta`  |
| 12  | `afterAddLiquidityReturnsDelta`    | `afterMintReturnsDelta`  |
| 13  | `afterRemoveLiquidityReturnsDelta` | `afterBurnReturnsDelta`  |

Bits 14 and 15 are unassigned and must be zero. Both pool types share every offset; only the names of bits 2–5, 12 and 13 differ.

The rest of the `parameters` word carries pool-type configuration:

```text
bits [ 0 .. 15]  hook registration bitmap (uint16)   - both pool types
bits [16 .. 39]  tickSpacing (int24)                 - concentrated liquidity
bits [16 .. 31]  binStep (uint16)                    - liquidity book
bits above       unused, must be zero
```

### Two rules the pool manager enforces

1. **Dependencies.** A `*ReturnsDelta` flag is only valid alongside its base callback — `beforeSwapReturnsDelta` (10) needs `beforeSwap` (6), `afterSwapReturnsDelta` (11) needs `afterSwap` (7), bit 12 needs bit 3, bit 13 needs bit 5. Otherwise the manager would never call the hook and the delta could never be produced.
2. **Hookless pools.** A pool key with no hook (`hooks == address(0)`) must carry an all-zero bitmap **and** a static fee. A dynamic fee needs a hook to supply it.

Both are checked locally by `validateHookConfig`, so a misconfiguration surfaces before you spend gas.

---

## Usage

### Build a permission bitmap

```ts
import {
  encodeCLHookPermissions,
  decodeCLHookPermissions,
  validateHookRegistrationBitmap,
  formatHookPermissions,
} from "@gullylabs/core-sdk";

const bitmap = encodeCLHookPermissions({
  beforeSwap: true,
  afterSwap: true,
  beforeSwapReturnsDelta: true,
});

bitmap;                                   // 0x04c0
formatHookPermissions("CL", bitmap);      // "0x04c0 (beforeSwap, afterSwap, beforeSwapReturnsDelta)"
decodeCLHookPermissions(bitmap).afterSwap; // true

validateHookRegistrationBitmap("CL", bitmap).valid; // true

// A returns-delta flag without its base callback is rejected:
validateHookRegistrationBitmap(
  "CL",
  encodeCLHookPermissions({ afterSwapReturnsDelta: true }),
);
// { valid: false, issues: [{ code: "MISSING_DEPENDENCY", message: "afterSwapReturnsDelta (bit 11) requires afterSwap (bit 7)" }] }
```

Return this value from your hook's `getHooksRegistrationBitmap()`:

```solidity
function getHooksRegistrationBitmap() external pure returns (uint16) {
    return 0x04c0;
}
```

### Build a pool key and derive its id

```ts
import { createCLPoolKey, poolKeyToId, DYNAMIC_FEE_FLAG } from "@gullylabs/core-sdk";

const key = createCLPoolKey({
  currency0: "0x0000000000000000000000000000000000000000", // native
  currency1: "0xA0b8...",
  hooks: "0x1234...",
  poolManager: CL_POOL_MANAGER_ADDRESS,
  fee: DYNAMIC_FEE_FLAG,      // the hook supplies the LP fee
  tickSpacing: 60,
  hooksRegistrationBitmap: bitmap,
});

key.parameters;    // 0x...3c04c0  — tickSpacing 60 above the bitmap
poolKeyToId(key);  // 0x1667...e350
```

`createCLPoolKey` validates that currencies are sorted and the fee is in range. Use `createBinPoolKey` with `binStep` for liquidity-book pools, and `sortCurrencies` if your inputs may be out of order.

### Check a hook configuration against the chain

```ts
import { validateHookConfig } from "@gullylabs/core-sdk";
import { createPublicClient, http } from "viem";

const client = createPublicClient({ transport: http(RPC_URL) });

const onChainBitmap = await client.readContract({
  address: key.hooks,
  abi: [
    {
      type: "function",
      name: "getHooksRegistrationBitmap",
      stateMutability: "view",
      inputs: [],
      outputs: [{ type: "uint16" }],
    },
  ],
  functionName: "getHooksRegistrationBitmap",
});

const result = validateHookConfig({
  poolType: "CL",
  hooks: key.hooks,
  fee: key.fee,
  parameters: key.parameters,
  onChainBitmap,
});

if (!result.valid) throw new Error(result.issues.map((i) => i.message).join("; "));
```

### Work with typed events

```ts
import {
  EVENT_DESCRIPTORS,
  EVENT_TOPICS,
  descriptorsForTopic,
  decodeProtocolLog,
  type CLPoolManagerSwapArgs,
} from "@gullylabs/core-sdk/events";

EVENT_TOPICS.CL_POOL_MANAGER_SWAP;        // topic0 for CLPoolManager.Swap
descriptorsForTopic(log.topics[0]);        // which contracts declare this event

const decoded = decodeProtocolLog("CLPoolManager", log);
if (decoded?.eventName === "Swap") {
  const args = decoded.args as unknown as CLPoolManagerSwapArgs;
  args.amount0; // bigint
  args.tick;    // number (int24 fits in a JS number)
}
```

Every event carries a generated argument interface (`VaultTransferArgs`, `BinPoolManagerMintArgs`, …) and a member of the `GullyCoreProtocolEvent` union, discriminated by `contract` + `eventName`.

Integers wider than 48 bits map to `bigint`; narrower ones (`int24`, `uint24`, `uint16`, …) map to `number`.

### Balance deltas and fees

```ts
import { unpackBalanceDelta, decodeProtocolFee, feeToPercent } from "@gullylabs/core-sdk";

unpackBalanceDelta(-1n);                 // { amount0: -1n, amount1: -1n }
decodeProtocolFee(0x7d03e8);             // { zeroForOne: 1000, oneForZero: 2000 }
feeToPercent(3000);                      // 0.3
```

### Indexer model

`schema.graphql` is a subgraph-flavoured GraphQL schema covering pools, swaps, liquidity changes, positions, hooks, fee governance and vault claim tokens. `@gullylabs/core-sdk/indexer` exports the equivalent TypeScript entity types plus deterministic id builders.

```ts
import {
  buildHookPermissionsEntity,
  eventId,
  poolEntityId,
  type Pool,
  type Swap,
} from "@gullylabs/core-sdk/indexer";

const permissions = buildHookPermissionsEntity("CL", 0x04c0);
permissions.id;         // "CL-0x04c0"
permissions.beforeSwap; // true

eventId(log.transactionHash, log.logIndex); // "0xabc...-7"
```

Relationships are explicit throughout: a `Swap` points at a `Pool`, a `Pool` points at a `Hook` and two `Token`s, positions point at their pool. Because a hook may back pools with different bitmaps, the permission set is recorded on the `Pool` (via `hookPermissions`) as well as on the `Hook` (`observedBitmaps`).

---

## Package layout

`src/` is the whole public surface; everything here is MIT and independently authored.

```
packages/sdk/
├── LICENSE                       MIT
├── README.md
├── schema.graphql                indexer schema (GraphQL / subgraph dialect)
├── scripts/                      ABI -> TypeScript generators, the RPC probe,
│                                 and the mirror that writes the public repo
├── src/
│   ├── index.ts                  public entry point
│   ├── ipfs.ts                   metadata URIs, and what a gateway may not be trusted for
│   ├── types/                    Currency, PoolKey, PoolId, the bytes32 parameters
│   │                             codec, packed balance deltas, LP and protocol fees
│   ├── deployments/              THE address book — every chain, every contract,
│   │                             `null` means not deployed; plus the Safe contracts,
│   │                             the verified stock feeds and the native/USD feeds
│   ├── chains/                   probed endpoints, a failover transport, and the
│   │                             contract clock (see "Two block clocks" above)
│   ├── hooks/                    permission bitmap: flag tables, encode/decode/validate
│   ├── events/                   topic index and log decoding
│   ├── generated/                DO NOT EDIT — produced by the generators
│   ├── launchpad/                launches, presets, CL ranges and Bin shapes, the
│   │                             creator tax, tenant terms, kit v2 and the pads
│   ├── price/                    native/USD in tiers (Chainlink, Pyth, a Gully Core pool),
│   │                             market cap, and the provenance of each answer
│   ├── market/                   trades, candles, holders, the pool directory, spot
│   ├── lock/                     liquidity locks and token locks / vesting
│   ├── drop/                     Merkle airdrops and multisend
│   ├── split/                    team splits
│   ├── utilities/                the shared fee gate in front of those four
│   ├── rwa/                      market hours, price bands, stock pair coverage
│   ├── trading/                  routing and fills
│   ├── registry/                 what the registry records about a Gully Core
│   ├── trust/                    reading a listing honestly — never "this is safe"
│   ├── revshare/                 revenue-share config, including a pending proposal
│   ├── tokenlists/               the token list, merged and verified
│   ├── safe/                     Safe addresses and derivation
│   └── indexer/                  TS mirror of schema.graphql, id builders
└── test/                         41 suites, run with vitest
```

---

## Code generation

Event types are never hand-transcribed. `scripts/generate-events.mjs` reads the Foundry artifacts and emits `src/generated/`:

```bash
npm run generate                            # default: ../core/foundry-out
node scripts/generate-events.mjs --artifacts <dir>
node scripts/generate-events.mjs --check    # non-zero exit if generated files are stale (CI)
```

It reads only the `abi` array of each artifact, and emits, per event:

- an argument interface with the ABI's own parameter names,
- the canonical signature and its `keccak256` (topic0),
- an entry in `EVENT_DESCRIPTORS` and a member of the `GullyCoreProtocolEvent` union,
- an `as const satisfies Abi` fragment for `viem`.

Current output: **29 event declarations** across `Vault` (6), `CLPoolManager` (10) and `BinPoolManager` (13), plus the 5 events of the shared `ProtocolFees` base (which the two managers re-emit) — 34 declarations over 22 unique signatures, since several events are declared identically in more than one contract.

Re-run it whenever the contracts are rebuilt. `npm run build` runs it first.

---

## Development

```bash
npm install
npm run build       # tsc (in the monorepo: regenerate the ABIs from the contracts, then tsc)
npm run typecheck   # tsc --noEmit
```

The test suite runs in the Gully Core monorepo, where its fixtures live; it is not part of this mirror.

TypeScript is configured with `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` and `verbatimModuleSyntax`.

### Verifying the encoding

The bitmap offsets, the `parameters` layout and the dependency rules were read from the protocol's own definitions, not assumed from Uniswap v4. The pool id derivation is additionally pinned by a fixture in `test/events.test.ts`: the same six key words hashed by the EVM (`keccak256(poolKey, 0xc0)`) and by `poolKeyToId` produce the identical digest.

---

## Links

| | |
|---|---|
| Website | <https://gullycore.xyz> |
| Docs | <https://docs.gullycore.xyz> |
| Source | <https://github.com/gully-labs/gully-core-sdk> |
| Contracts | <https://github.com/gully-labs/gully-core> |
| Org | <https://github.com/gully-labs> |

Issues and pull requests belong on the source repo above. The package is developed in Gully Labs'
monorepo and mirrored there on every release; an accepted pull request is applied upstream and comes back
with the next sync.

---

## License

MIT — see [LICENSE](./LICENSE).
