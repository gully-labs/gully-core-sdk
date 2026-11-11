# Coding-agent prompt — ship a DEX on Gully Core

Paste the block below into a coding agent (Claude Code or any other) inside the repository you
want the DEX in. It is written to be pasted whole. **Fill in the lines under `## My setup` first.**
MIT, like the SDK it ships with.

---

## Before you paste

You are integrating against **shared core**: Gully Core's `Vault` and pool managers are already
deployed on each chain Gully Core is on, and your pools live in them. You do not deploy an AMM.

| Layer | Who deploys it |
|---|---|
| `Vault`, `CLPoolManager`, `BinPoolManager` | **Gully Core. Already on chain.** You call them. |
| Pool creation | Nobody: there is **no factory**. `initialize(poolKey, sqrtPriceX96)` on a pool manager is permissionless and a pool is a storage entry. |
| Router | **Gully Core's UniversalRouter by default**, reached through the router API. You may use your own instead. |
| A hook (a "Gully Core") | **Optional, yours.** Only if your product needs one. |
| Front end | **You.** MIT; you may keep it closed. |

---

## The prompt

````text
I am building a DEX front end on Gully Core. Gully Core is a singleton AMM (a Vault with
concentrated-liquidity and Bin pool managers, Infinity architecture) that is already deployed on
my target chain. I am NOT deploying core contracts.

## My setup

- Chain: Anubis (6714)                   <-- or Gully Chain Testnet 485590
- Quote token: <symbol>                   <-- the token users price against
- My fee wallet: 0x0000000000000000000000000000000000000000   <-- REPLACE. Not optional: a zero
  recipient does not revert, it forfeits whatever it is paid. Refuse to wire it and ask me.
- Router: Gully Core's router API (default)  <-- or "my own router"

## Ground rules — follow these exactly, they are not stylistic

1. ADDRESSES COME FROM THE SDK, NEVER FROM ME AND NEVER FROM MEMORY.

   NOTHING IS PUBLISHED ON NPM YET: `@gullylabs/core-sdk` does not resolve from the registry
   today. Until it does, install the SDK from a tarball Gully Core gives you, or vendor it the way
   the public DEX template does (`npm install ./vendor/gullycore-sdk-<version>.tgz viem`).
   When it is published, the line is `npm install @gullylabs/core-sdk viem`.

   import { getDeployment, requireContract, tokenBySymbol, gullycoreTransport } from "@gullylabs/core-sdk"
   const d = getDeployment(6714)       // undefined on a chain Gully Core has no record for: say so in the UI
   if (!d) throw new Error("Gully Core is not on this chain yet")

   `null` in the address book means "not on this chain"; it is never the zero address. Branch on
   it and say "Coming soon on <chain>" in the UI. A zero address passed to a read returns empty
   instead of failing, which is how a missing contract becomes a blank screen with no error.

2. READ DECIMALS OFF THE TOKEN. Never default to 18.

   `sqrtPriceX96` encodes a ratio of RAW units. A 6-decimal stablecoin against an 18-decimal
   token is a 10^12 factor, and `initialize` fixes the price permanently. If you open a pool, use
   `sqrtPriceX96FromPrice({ price, decimals0, decimals1 })`, which computes in bigint. A
   `Math.sqrt` anywhere near a price is a bug.

3. SWAPS GO THROUGH THE ROUTER API, AND EVERY ROUTER TRANSACTION IS VERIFIED BEFORE IT IS SIGNED.

   import { GullyCoreRouterClient, verifySwapCalldata } from "@gullylabs/core-sdk/router"
   const router = new GullyCoreRouterClient({ baseUrl: "https://gullychain.xyz/core" })
   const quote = await router.quote({ chainId, tokenIn, tokenOut, amountIn, slippageBps })
   const swap  = await router.swap({ chainId, tokenIn, tokenOut, amountIn, sender, slippageBps })

   `swap` checks the target against the SDK's own address book (never the API's answer) and
   decodes the calldata: only Gully Core's own commands, input no more than `amountIn` of
   `tokenIn`, output only to the sender or recipient, the floor, the deadline, the value and the
   fee. If you build or modify a transaction any other way, call
   `verifySwapCalldata(kind, tx, request)` yourself. Never send router calldata you did not verify.
   An API key belongs on a server; a browser calls the router anonymously or through my backend.

   Fees, read, never hardcoded: a fill on a Gully Core pool pays no router fee; a fill routed to
   another venue pays the fee the fill router reports (`feeBps()`, inside an immutable cap). Show
   the router fee, the pool fee and price impact as separate lines; never merge them.

4. LAUNCH POOLS ARE DIFFERENT, AND THE SDK KNOWS HOW.

   A pool whose hook is a Gully Core launch guard charges its trade fee and any creator tax in the
   QUOTE currency, on buys and sells, as a hook delta. Its LP fee reads near zero; the real charge
   is the guard's. Read it with `readGuardFeeParts` and show it as its own line
   (`guardBuyCharges`). Tell a launch pool apart by its guard's permission bitmap
   (`readGuardGeneration`), never by an address list.

   A buy a launch range cannot fill completely reverts with `SwapNotFilled`. Size buys from a
   quote, cap them with `largestExactInputFor`, and decode a revert with `decodeSwapNotFilled`.

5. NO FEE-ON-TRANSFER OR REBASING TOKENS. Refuse them as a pair currency.

6. DURATIONS ARE SECONDS. CONTRACT BLOCK NUMBERS ARE A DIFFERENT CLOCK.

   Every duration in Gully Core contracts is `block.timestamp`. Where you must compare a block
   number a contract stored, read the block number the contract sees with
   `readContractBlockNumber(client, chainId)`, not `eth_blockNumber`: on some chains they differ.
   Use the RPC block number only for log ranges.

7. NAMES COME FROM THE ABI, NOT FROM THIS PROMPT.

   Treat every function name here as a hint and confirm it against the ABI the SDK ships.
   Constant and immutable getters keep their own casing (`MAX_TAX_BPS()`, not `maxTaxBps()`).

8. NEVER RENDER A NUMBER YOU DID NOT READ.

   Every figure comes from the chain, the SDK's address book and token list, or Gully Core's public
   API (`https://gullychain.xyz/core/v1/...`: `/v1/chains/:chainId/pools`,
   `/v1/chains/:chainId/pools/:poolId`, `/v1/overview`). The SDK's market reads
   (`readPoolTrades`, `buildCandles`, `marketStats`, `readHolders`, `readPoolDirectory`,
   `readSpotPrice`) are quote-denominated, never USD. No mock modules, no sample series, no
   placeholder price. Four states per panel: loading, error, empty, not available on this chain.
   Two swaps are not a chart: say "2 swaps since block N".

9. IF A POOL USES `RevShareHook`, READ `getPendingConfig` BESIDE `getConfig`.

   A pool can show its cut as off while a proposal sits ready for anyone to apply. A screen
   showing only the live config tells a trader something that can stop being true in the next
   block. Show the pending one and its effective and expiry times.

## Build this

1. Wallet connection and a chain guard (wrong network: a blocking, explicit prompt).
2. A token selector fed by the SDK's token list for the chain.
3. Quote and swap through the router (rule 3), with user-set slippage and a deadline.
4. Pool pages from the public API and the SDK's market reads.
5. Liquidity management through the chain's position managers if I asked for LP.
6. A verify script (`npm run gullycore:verify`) that, for every address and token in my config,
   asserts code exists, identifies the contract by a call only it answers, and reads `decimals()`.
   It must exit non-zero on any mismatch. Run it before telling me anything works.

## Where my fee wallet earns

Explain these and implement the one I chose; do not silently pick:

(a) FRONT-END FEE — an integrator fee on swaps through my site, inside the client-side ceiling
    the Gully Core widgets enforce, paid to my fee wallet.
(b) A LAUNCHPAD — run launches through `LaunchpadKitV2` as a tenant and take the integrator
    share of launch fees, trade fees and taxes (see the Launchpad prompt).
(c) MY OWN HOOK — take a hook delta in my own Gully Core. Highest ceiling, most work, needs an audit.

The core protocol fee is NOT one of my options: Gully Core governance sets it on the shared pool
managers and core caps it at 0.4%. Say so plainly in the README you write. Read the fee a pool
pays from the chain; never hardcode it.

## When you are done

Do not tell me it works. Show me the verify script's output, a real quote against the live
chain, and a list of every screen state you implemented. If something is not wired, say which
and why.
````

---

## What to check before you trust the output

- `grep -r "0x" src/config` finds nothing but your fee wallet. Every other address belongs to the SDK.
- The verify script exits non-zero when pointed at a wrong address on purpose.
- Every router transaction passes through `verifySwapCalldata` (or `GullyCoreRouterClient.swap`) before a wallet sees it.
- Turn the RPC off and reload: you see an error state that names the problem, not a chart.

## The mistakes worth naming up front

- **Assuming a factory.** There is no per-pair contract. An agent writing `getPair` has
  pattern-matched Uniswap v2 and the rest will be wrong.
- **Hardcoding an address "just for now".** The address book is the source; contracts can be
  added to a chain after you ship.
- **A default of 18 decimals.** `initialize` cannot be undone.
- **Merging fees into price impact.** The router fee, the pool or guard fee, a creator tax and
  price impact are different numbers.
