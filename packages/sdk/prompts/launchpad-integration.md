# Coding-agent prompt — run a Launchpad on Gully Core

Paste the block below into a coding agent (Claude Code or any other) inside the repository you
want the Launchpad in. **Fill in `## My setup` first.** MIT, like the SDK it ships with.

A launch on Gully Core is one transaction: `LaunchpadKitV2.createLaunch(LaunchParamsV2)` creates
the token, opens one or two pools on Gully Core's shared core (a single-sided CL range and/or a
shaped Bin distribution), configures the launch guard and locks the liquidity forever (CL legs
in `GullyCoreLPLocker`, Bin legs in `GullyCoreBinLPLocker`). You deploy none of it. The kit, the
guards and the lockers are already on chain; you call them. If the creator wants the first buy,
`GullyCoreLaunchAndBuy` does the launch and that buy in the same transaction.

---

## Before you paste

Four facts shape the whole integration. An agent that does not know them writes plausible code
that loses money.

1. **Every duration is seconds, measured by `block.timestamp`.** Fee decay, start delay and tax
   expiry are all seconds. Nothing in Kit v2 takes a block count, so no block time is ever
   needed. The anti-snipe decay has a floor of 60 seconds, on purpose: a sequencer may move
   timestamps by a few seconds, and a shorter window could be skipped.
2. **The launch guard takes its fee and the creator tax in the QUOTE currency**, as a hook delta,
   not as the pool's LP fee. Anything that reads the pool's LP fee sees a small number or zero;
   the real charge is the guard's, and the SDK reads it (`readGuardFeeParts`, `guardBuyCharges`).
3. **A buy the launch range cannot fill completely reverts** with the guard's `SwapNotFilled`.
   Size every buy from a quote, never "spend all of it and see". `decodeSwapNotFilled` turns the
   revert into the two numbers that explain it.
4. **Fee-on-transfer and rebasing tokens are not supported**, as the quote or anywhere else.
   Refuse them in the UI.

---

## The prompt

````text
I am building a token Launchpad on Gully Core. `LaunchpadKitV2` is already deployed on my
chain and does the whole launch in one call. I am NOT deploying the kit, the guards or the lockers.

## My setup

- Chain: Anubis (6714)                   <-- or Gully Chain Testnet 485590
- Quote token: <symbol>                   <-- what launches trade against (native or an ERC-20 from the token list)
- My fee wallet: 0x0000000000000000000000000000000000000000   <-- REPLACE. Not optional: a zero
  recipient does not revert, it forfeits the revenue. Refuse to wire it and ask me for a real address.
- Tenant: none | my Launchpad's GullyCorePad address   <-- see rule 6

## Ground rules — follow these exactly

1. ADDRESSES AND LAUNCH MATHS COME FROM THE SDK. NEVER HAND-ROLL EITHER.

   NOTHING IS PUBLISHED ON NPM YET: `@gullylabs/core-sdk` does not resolve from the registry
   today. Until it does, install the SDK from a tarball Gully Core gives you, or vendor it the way
   the public DEX template does (`npm install ./vendor/gullycore-sdk-<version>.tgz viem`).
   When it is published, the line is `npm install @gullylabs/core-sdk viem`.

   import {
     getDeployment, requireContract, GULLYCORE_CHAIN_IDS,
     readKitV2Limits, buildLaunchV2, validateLaunchParamsV2,
     readKitV2Launches, readKitV2Earnings, readTenantConfig,
     openingPriceFromMarketCap, resolveNativeUsd,
     readGuardFeeParts, guardBuyCharges, largestExactInputFor, decodeSwapNotFilled,
     readGuardGeneration, readGuardLpShareBps, PRESET, NO_TAX, LAUNCH_TAX_LIMITS,
     buildLaunchAndBuyV2, decodeLaunchAndBuyResult,
   } from "@gullylabs/core-sdk"

   const d = getDeployment(6714)       // undefined on a chain Gully Core has no record for: say so in the UI
   if (!d) throw new Error("Gully Core is not on this chain yet")
   const kit = d.launchpadV2.launchpadKitV2   // Address | null; null means not on this chain
   const launchAndBuy = d.launchAndBuy         // Address | null; bound to that same kit

   `null` in the address book means "not on this chain". It is never the zero address and must
   never be treated as one. Never paste a hex address into source: every contract is in the book.

2. BUILD THE CALL WITH `buildLaunchV2`, NOT BY ENCODING `createLaunch` YOURSELF.

   const limits = await readKitV2Limits(client, kit, { tenant })   // or { direct: {...} } with no tenant
   const built  = await buildLaunchV2(client, kit, draft, limits)

   `buildLaunchV2` predicts the launch token's address and cross-checks it against the kit
   (`predictLaunchTokenChecked`), snaps the opening price to what each leg can really open at,
   validates the whole call against the kit's and the guards' own bounds, and returns
   `{ to, data, value, issues, legs, token }`.

   - Any issue with `severity: "error"` means the kit would revert. Do not send. Show it.
   - Show `legs[i].openingPrice` (the SNAPPED price the pool is born at) and `snapFraction`.
     That number, not the one the user typed, is what the contract uses.
   - Send exactly `built.value`. It is the kit's "safe value": a launch-fee increase scheduled
     behind its notice cannot make the call revert, and any surplus is refunded in the same call.

3. OPEN AT A MARKET CAP, NOT AT A TYPED PRICE.

   Ask the creator for an opening market cap and turn it into a price with
   `openingPriceFromMarketCap`, using a native/USD price from `resolveNativeUsd` (Chainlink on
   chain first, then other on-chain sources). Show where the price came from. If no source
   answers, default in native units and say there is no USD price; never invent one. A launch's
   opening price cannot be changed after the pool exists, and its liquidity is locked forever.

4. SIMULATE THE EXACT BYTES, SHOW THEM, THEN SEND. In that order.

   `eth_call` `{ to: built.to, data: built.data, value: built.value, from: launcher }` before
   enabling the button. Disable the button until it simulates. Show: the token address, every
   leg's pool and opening price, the fee schedule (initial fee, final fee, decay in seconds,
   start time), the tax if any, the lock split, and the launch fee in native.

5. THE ANTI-SNIPE SCHEDULE AND THE CREATOR TAX HAVE HARD LIMITS. READ THEM, DO NOT HARDCODE THEM.

   `limits` carries every cap the contracts enforce: the initial fee (up to 50% on a CL leg, 10% on
   a Bin leg), decay at least 60 seconds, start delay at most 30 days, a tax of at most 10% per
   side that may last forever (`taxSeconds` = `GULLY_LAUNCH_RULES.TAX_SECONDS_FOREVER`) or end after
   a number of seconds, the protocol's share. `limits.rules` carries what the kit FIXES for every
   launch: a steady trade fee of at least 1%, the protocol's share of it (0 on an outside launch, and
   exactly 50% only on a Launchpad Gully designated that opted in), and a total supply of exactly
   1,000,000,000 tokens. An outside launch pays Gully a flat 0.30% of every trade as the pool's
   protocol fee, and no launch fee and no share of the fee or the tax. A form offers the total fee as a pick from
   `TOTAL_FEE_CHOICES_BPS` (1% to 11% in 0.5% steps; the tax is the total minus the 1% trade fee) and
   shows the split with `launchFeeBreakdown`. Use `PRESET` by name; a
   bare `0` is `Custom`, which reads the schedule fields directly and, left at zero, launches
   with no protection and no error. `NO_TAX` is the explicit "no tax" value.

   Until then the launch's operator may change the schedule and the tax with
   `reconfigureLaunch(token, keys, schedule, tax)`. The configuration freezes at the first swap,
   or when the clock passes the start time, whichever is first; after that nobody can change it.
   A start time can be pushed out at most 30 days from the pool's first claim, in total.

6. TENANT TERMS ARE STORED ON CHAIN. A LAUNCH RESTATES THEM EXACTLY.

   If I run a Launchpad (a `GullyCorePad`), its integrator share, integrator launch fee, tax caps
   and allowed quotes are read with `readTenantConfig(client, kit, tenant)` and passed through
   `readKitV2Limits(..., { tenant })`. The integrator is my fee wallet. A launch sent with no
   tenant pays no tenant terms: tenant fees are a default, not an enforcement.

7. WHO EARNS WHAT, AND IN WHICH CURRENCY.

   - The guard's trade fee and the creator tax are taken in the quote currency on buys AND sells
     (the pool's own LP fee override is the guard's, so the pool never charges the launch token).
     On a buy, the guard's `LP_SHARE_BPS` of the trade fee (20% on Gully Core's guards; read it with
     `readGuardLpShareBps`, never assume it) goes to the pool's liquidity, and so to the locked
     position by the lock's split; the rest, and all of a sell's fee, is the guard's, split
     creator / protocol / integrator by the launch's frozen split (protocol 0 on an outside launch;
     on Gully terms protocol exactly 50%, integrator at most 20%).
   - The tax is split by its own frozen buckets (protocol 0 on an outside launch; on Gully terms
     protocol at least 10%).
   - Earnings are pull-claimed. `readKitV2Launches` then `readKitV2Earnings(client, scan, account)`
     lists what an account can collect and claim; build the claim screen from it.
   - A guard keeps ONE claimable balance per account and currency, shared by fee and tax. Never add
     a "fee claimable" to a "tax claimable".

8. BUYS ARE SIZED FROM A QUOTE.

   A buy that the launch range cannot fill reverts with `SwapNotFilled` (the guard refuses a
   partial fill because it has already charged the amount named). Use `largestExactInputFor` to
   cap the input, and decode any revert with `decodeSwapNotFilled(revertData)` to tell the user
   how much the pool could take. Show the guard's fee and the tax as their own lines
   (`guardBuyCharges`), never folded into price impact.

9. TRADES GO THROUGH GULLY CORE'S ROUTER, AND EVERY ROUTER TRANSACTION IS VERIFIED.

   import { GullyCoreRouterClient, verifySwapCalldata } from "@gullylabs/core-sdk/router"
   const router = new GullyCoreRouterClient({ baseUrl: "https://gullychain.xyz/core" })

   `router.swap(...)` checks the transaction's target against the SDK's own address book and
   decodes the calldata. If you build a transaction any other way from the API's answer, call
   `verifySwapCalldata(kind, tx, request)` yourself before the wallet sees it. It refuses any
   calldata that does anything but the swap that was asked for. Never sign router calldata you
   did not verify.

10. THE CREATOR'S FIRST BUY GOES THROUGH `GullyCoreLaunchAndBuy`, NOT A SECOND TRANSACTION.

   const built = await buildLaunchAndBuyV2(client, { launchAndBuy, kit }, draft, limits,
     { legIndex: 0, amountIn, minAmountOut: 0n })   // 0n: simulate, then bound by what it returns

   It refuses a launch with a start delay (`StartDelayMustBeZero`): the buy is only possible when
   the launch opens in the same block. It also refuses a token other than the one shown
   (`expectedToken`), a launch fee above `maxLaunchFeeWei`, an opening fee above `maxLpFeePips`,
   and an output under `minAmountOut`. Decode the result with `decodeLaunchAndBuyResult`. A buy
   larger than the leg can fill reverts the launch with it (rule 8). If `launchAndBuy` is `null`
   on the chain, offer no first buy rather than a two-transaction imitation a sniper can split.

11. NEVER RENDER A NUMBER YOU DID NOT READ.

   Every figure comes from the chain, the SDK's address book and token list, or the public API
   (`https://gullychain.xyz/core/v1/...`, e.g. `/v1/launches`, `/v1/chains/:chainId/pools/:poolId`).
   No mock data, no sample series. Four distinct states per panel: loading, error, empty,
   not available on this chain. Two trades are not a chart: say the count.

## Build this

1. Wallet connection and a chain guard.
2. The launch wizard: name, symbol, metadata, supply, opening market cap, legs (CL range and/or
   Bin shape), preset, optional tax, optional first buy (rule 10), review with the snapped
   prices, simulate, send.
3. The launch list (`readKitV2Launches(client, kit, { fromBlock, chainId, tenant })`, or
   `/v1/launches`) with each launch's phase and live fee.
4. The earnings screen for creators and for my fee wallet (`readKitV2Earnings`).
5. A token page with a buy/sell box that uses the router and rule 8.

## When you are done

Do not tell me it works. Show me a simulated `createLaunch` against the live chain with zero
error issues, the list reading real launches, and every screen state you implemented. If
something is not wired, say which and why.
````

---

## What to check before you trust the output

- `grep -r "0x" src` finds nothing but your fee wallet and test fixtures.
- The wizard's button stays disabled when the simulation fails, and the issue list explains why.
- A buy larger than the range reverts in simulation and the UI says how much would fit.
- Turn the RPC off and reload: you see an error state that names the problem, not a chart.
