# __GULLYCORE_APP_NAME__

A Gully Core app (DEX, Launchpad or both) running on Gully Core's **shared core**.

```
npm install
npm run gullycore:verify     # read every configured address back off the chain
npm run dev
```

Then edit **`gullycore.config.ts`**. That is the whole configuration surface: chain,
fee wallet, branding, feature flags, token list. There is no Solidity in this
project and nothing else needs touching to go to market.

---

## Shared core, not a full fork

You are not deploying an AMM. `Vault`, both pool managers, the Universal Router,
the position managers and the quoter are Gully Core's, deployed and verified once on chain
`__GULLYCORE_CHAIN_ID__`; this app points at them. Your pools live in Gully Core's Vault.
The addresses come from the `@gullylabs/core-sdk` address book (HyperEVM, BNB Smart
Chain, Robinhood Chain and Base as this app was generated); a Gully Core redeploy reaches
you by bumping the dependency, with no change to this project.

**What that buys you.** No nineteen-contract deployment. No verification. No
audit question about contracts you did not write and cannot afford to review.
Every pool you create is visible to every other app on the same core, and every
pool they create is visible to you — the liquidity compounds instead of
fragmenting.

**What it costs you.** Gully Core's protocol fee applies to swaps on these pools. It
is set by Gully Core governance on the shared pool manager and **capped at 0.4%
(4000 pips) by core**, which is a hard limit in the contract rather than a
policy anyone can revise upward. You cannot change it, and it is frequently
zero. The Fees screen reads the live value; do not take a number from this
README.

**A full fork is allowed and owes nothing.** The core contracts are
GPL-2.0-or-later, so you may deploy your own Vault and pool managers, set your
own protocol fee controller, and pay Gully Core nothing at all. That is a legitimate
choice and nobody will stop you. **It is not what you want if all you want is
your own router** — that is one config line on the shared core, see "Your own
router" below. A fork is the harder road: nineteen contracts to
deploy and verify per chain, an empty registry, no shared liquidity, and every
future core fix is yours to port. If you take it, set `chain.contracts` in
`gullycore.config.ts` to your own addresses and this front end will read them
instead. Nothing else changes.

---

## Your own router, on Gully Core's core

Gully Core's router is the default and costs you nothing to use: leave
`chain.router` as `null` and every swap this app builds — the DEX surfaces and
the buy path on a launch alike — goes through the `UniversalRouter` the SDK
address book records for your chain. It is deployed, verified and maintained,
and a Gully Core redeploy reaches you by bumping the dependency. Most people should
stop reading here.

If you want your own, it is one line:

```ts
chain: {
  router: '0xYourRouter',   // null = Gully Core's, which is the default
},
```

Nothing else moves. Your pools are still in Gully Core's Vault, the launchpad kit,
the lockers, the registry and the utilities are unchanged, and your `fee.bps`
still lands — it is an action inside the swap plan your router executes, so it
is yours through either router.

**It has to be that router's ABI.** `@gullylabs/core-widgets` encodes
`execute(bytes commands, bytes[] inputs, uint256 deadline)` with the Infinity
command set, and it grants the input token's Permit2 allowance to this address.
So this must be a deployment of Gully Core's `UniversalRouter` — forking it is
allowed, it is GPL-2.0-or-later — wired to the same Vault, pool managers and
Permit2 this app reads. A different contract that calls itself a router will
accept the calldata and do something else with it.

**What you take on, stated plainly.**

* A router is in the swap path and holds users' funds for the duration of a
  swap. Yours is yours to secure, and whoever owns it can pause every swap in
  this app.
* Gully Core's routed-fill fee — **15 bps where Gully Core's router fills a trade
  somewhere other than a Gully Core pool, 0 on a Gully Core pool**, a governed value
  inside an immutable cap — is charged by Gully Core's router. Through yours, your
  users do not pay it and **you do not earn it either**: it is the protocol's
  fee for finding the fill, not an integrator share. Your revenue is `fee` and
  `launch` below, and neither changes.
* `chain.contracts.universalRouter` does the same thing for a **full fork**,
  which is a different claim: "none of Gully Core's addresses apply to me". Setting
  both to different addresses is refused rather than ranked — one of them would
  have to lose silently, and it would be the one you meant.

**Verify it before anyone trades.** `npm run gullycore:verify` reads the code at the
address, checks the router's `vault()` against the Vault this app uses, and
reports `paused()` and `owner()`. Config validation cannot do this: it runs
before the app mounts and makes no network call, so a codeless address passes
it. A swap encoded to an address with no code is a plain call that succeeds
doing nothing — and a native-currency swap hands it the user's funds.

---

## Routed fills: Gully Core's routing API by default, yours as an option

Separate from the router above. The swap box can ask a ROUTER API for a quote and
fill a trade on a third-party venue, through Gully Core's `GullyCoreFillRouter`, when
that pays the user more than every Gully Core pool. It falls back to Gully Core pools on
any routing failure, so this setting can only make a swap better, never break one.

```ts
routing: {
  api: 'gullycore',             // Gully Core's hosted routing API (the default)
  // api: 'https://r.you.com', // your own deployment of the same API (MIT, in Gully Core's repository)
  // api: null,                // off: Gully Core pools only
  // apiKey: import.meta.env.VITE_GULLYCORE_ROUTER_KEY,   // router:quote scope; never commit one
},
```

* **A key is optional, and public once set.** Anonymous quotes work, rate-limited per
  address. A key from <https://app.gullycore.xyz/app/developers> (sign in with a wallet; up to 3
  keys, scopes `public:read` + `router:quote`, the secret shown once) gets a per-key
  limit instead. A `VITE_` variable is compiled into the bundle every visitor downloads,
  so anyone can read the key and spend its limit. It cannot move funds and is revocable
  at `/developers`; to keep it private, forward quotes through a server of your own.

* Your own API must name the **same fill router** as the SDK address book, or the
  swap box refuses its answers (`FILL_ROUTER_MISMATCH`): the address book is the one
  source of truth for where a user's funds may be sent. `routing.fillRouter` overrides
  it for a full fork only.
* **The routing fee is the protocol's.** A third-party fill pays Gully Core's routing
  fee — 15 bps of the input, 0 on a Gully Core pool, inside an immutable cap, read off
  the fill router and shown on the Fees screen — to the protocol. You do not earn it.
* **Routing and a swap fee are a choice.** The swap box IGNORES the router while
  `fee.bps` is above zero: a routed fill has no integrator step and would silently
  drop your fee. So routing only runs with `fee.bps: 0`; the app names that as a
  warning in the config, never as a surprise.
* `npm run gullycore:verify` asks the API whether it serves your chain, that it names
  the same fill router, and which venues it enables, and reads the fee in force.

---

## Licensing — what you may close-source

| Layer | Licence | Yours to close-source? |
|---|---|---|
| **This project** — everything in this repository | **MIT** | **Yes.** Fork it, restyle it, sell it, keep it private. |
| `@gullylabs/core-sdk`, `@gullylabs/core-widgets`, `@gullylabs/core-connect` | MIT | Dependencies, not derivative works of the contracts. |
| Gully Core core, periphery, router, and Gully Core's own hooks | **GPL-2.0-or-later** | No. Derivatives of `infinity-core`. If you fork them, your fork is GPL. |

The reason this app can be MIT while it talks to GPL contracts is that **it talks
to them through their ABIs.** An ABI call is not linking and does not create a
derivative work. That analysis holds only while it stays true, so there is one
rule to keep:

> **Never import GPL Solidity, or code generated from GPL Solidity, into this
> project.** Not the sources, not a build artifact, not a hex bytecode string.

Concretely: `npm run gullycore:deploy -- --own-kit` prints a `forge` command rather
than deploying a kit for you, and that refusal is this rule being enforced, not
a missing feature. The GPL code stays where it is GPL; you fetch it, build it,
deploy it, and this front end stays MIT and yours.

---

## Your revenue

`fee` in `gullycore.config.ts`:

```ts
fee: {
  wallet: '0xYourTreasury',
  bps: 25,                 // 0.25% of the swap OUTPUT
  mode: 'take-portion',
},
```

The fee is a `TAKE_PORTION` action inside the swap's own call path, built by
`@gullylabs/core-widgets`. It is paid in the same transaction as the swap, from
the output currency, before anything leaves the singleton — so nothing is
escrowed, owed, or reconciled later. Either the fee lands atomically with the
swap or the whole transaction reverts.

**Ceiling: 100 bps (1%).** The widgets package refuses to encode more. That is a
client-side policy rather than a contract limit, and it exists so no integrator
can quietly take a third of a user's output and poison the widget for everyone
else.

**It stacks on two fees you do not control**: the pool's LP fee (set by whoever
created the pool) and Gully Core's protocol fee. All three are disclosed on the Fees
screen, read live. Disclosing one of three is misleading by omission, so please
do not remove that screen.

### Market-cap-first launches

Every launch opens at a known market cap (Gully Core, 2026-09-20): the wizard asks for
an **opening market cap** before anything else, defaulting to
`launch.defaultOpeningMarketCapUsd` (Gully Core's own default is $3,500; a launchpad built
on the kit must not quietly offer a worse one), and derives the opening price from it
through the chain's native/USD feed, READ ON CHAIN, with the source and its age
stated beside the field. A creator may type the price instead and watch the cap
follow. The price shown as the answer is the **snapped** one the pool is actually
born at, with the cap it implies. Where the chain has no dollar source the cap is
typed in the quote currency and no dollar figure appears anywhere. What was typed is
kept as a draft in the browser (never what the chain answered) until the launch
confirms.

### Launches pay you too — through contracts, not through this app

`launch` in `gullycore.config.ts`, paid to the same `fee.wallet`:

```ts
launch: {
  integratorBps: 500,                       // 5% of every locked position's LP fees, forever
  integratorLaunchFeeWei: '1000000000000000', // 0.001 native per launch, on top of the protocol's
  defaultProtocolBps: 0,                    // the protocol's share: exactly 0 on an outside launch (release 3)
},
```

A locked launch (`LaunchpadKitV2`) mints a new token, opens its pools, seeds
them from the supply and locks every position **forever** in a Gully Core locker.
The lockers split each position's LP fees three ways at lock time — creator,
you (the integrator), protocol — and those numbers never change. The kit also
credits your flat launch fee at launch time. Both are capped by immutables you
can read off chain (`maxIntegratorBps()` on the lockers, 20%;
`maxIntegratorLaunchFeeWei()` on the kit), the protocol's 20% floor on LP fees
comes off first, and the creator gets the rest.

**Store your terms on the kit, then point the config at them.** Without a
tenant config the wizard sends your terms as plain call arguments, which
nothing enforces. `npm run gullycore:tenant` prints the `setTenantConfig`
transaction; send it from the account you will use as your tenant (a key you
hold, or a Safe — the *sender* is the tenant), then
`npm run gullycore:deploy -- --tenant 0x…`. From then on every launch through this
app names your tenant and the kit **refuses** one that restates your terms
differently (`TenantConfigMismatch`). It also lets you restrict presets, Bin
shapes and quote currencies.

Stated plainly: a launcher who calls the kit outside this app with
`tenant = 0` pays you nothing. A tenant config is a policy for launches that go
through you, not a toll on the kit. The protocol's launch fee, the lockers'
floor and the zero core fee on locked pools are the only parts nobody can route
around. Your earnings are claimable on **Launch → Your earnings**: the lockers'
`collectFees` is permissionless and `claim` pays only the caller's own credit.

---

## Two launchpads, and which one you get

**`LaunchpadKitV2` — locked launches.** The one to build on. A new token, one
to four pools (single-sided concentrated ranges above the opening price, or
shaped Bin ladders: flat, linear, exponential, stepped), everything seeded from
the token's own supply and locked forever, a decaying launch fee on every pool,
your integrator share frozen in the locks, tradable from the first block with
no graduation and no migration. Configure `chain.launchpadKitV2`; the SDK
address book carries Gully Core's shared instance once it is deployed and
`npm run gullycore:verify` reports it. `npm run gullycore:deploy -- --kit-v2 0x…`
verifies a kit is wired to this core and writes it.

**`LaunchpadKit` (v1) — unlocked launches.** A pool for a token you already
hold, seeded from your wallet, positions returned to you. Still supported at
`chain.launchpadKit`; when both are configured it lives at `/launch/v1`, and
when it is the only one configured it keeps `/launch` so existing links do not
break. It takes no fee of any kind, for you or for Gully Core.

**Gully Core's shared `LaunchpadKitV2` is in the SDK address book** for every chain
this app supports; `npm run gullycore:verify` reports it and
`npm run gullycore:deploy -- --kit-v2 0x…` writes it into `chain.launchpadKitV2`.
There is no shared v1 kit. While neither field is set, every launch surface
renders an explicit "not configured" state rather than an empty list — "no
launchpad" and "no launches" are different facts. To run the DEX alone, set
`features.launchpad: false`; to run a kit of your own,
`npm run gullycore:deploy -- --own-kit` prints how.

---

## Gully Core utilities: Team splits, locks, airdrops

Three protocol tools ship switched on, each behind a flag in `features`:

| Flag | Pages | Contracts (from the SDK address book) |
|---|---|---|
| `splits` | `/splits` (every split, open one by address), `/splits/new`, `/splits/:address` (payees, books per currency, collect-and-pay in one transaction). The launch wizard can pay a launch's **creator share to a split** instead of the connected wallet. | `GullyCoreSplitFactory`, `GullyCoreSplit` |
| `locks` | `/locks` (every locked pool and token, and the connected wallet's own locks with claim / collect fees / withdraw), `/locks/new` (lock tokens with a time-lock or cliff + linear vesting, or lock a liquidity position NFT), `/locks/pool/:poolId`, `/locks/token/:address`. Lock badges beside every pool on **Pools** and every launched token on **Launch**. | `GullyCorePositionLock`, `GullyCoreTokenLock`, and the protocol's LP locker (Kit v2 launch liquidity, locked permanently) |
| `airdrops` | `/airdrops` (every drop), `/airdrops/send` (send to a CSV list, batched 1,000 per transaction), `/airdrops/new` (a claimable Merkle drop from a CSV, with its claims file to download and publish), `/airdrops/claim` (load the claims file by URL or upload, **verify it rebuilds the drop's root**, then claim). | `GullyCoreMultisend`, `GullyCoreDropFactory`, `GullyCoreMerkleDrop` |

**Nothing to configure but the flag.** The addresses come from `@gullylabs/core-sdk` for
`chain.id`. Where the address book records `null`, the contract is not deployed on that
chain and the page says "coming soon on <chain>" instead of
failing; `npm run gullycore:verify` lists which are deployed. A full fork or a local devnet
overrides them in `chain.contracts` (`splitFactory`, `positionLock`, `tokenLock`,
`multisend`, `dropFactory`) and sets `chain.logsFromBlock`.

**Fees are the contracts', and none are yours.** Each contract charges one flat fee in
the native currency (a split's creation fee plus a protocol share frozen into the split;
one fee per lock, per multisend batch, per drop), set by Gully Core governance inside an
immutable cap and enforced on chain. Every page reads it live and shows it before
anyone signs, with any announced increase and the cap. **This app adds no fee to any
of them** — they are protocol utilities, not a revenue line. Your revenue is `fee`
(swaps) and `launch` (launches).

**Every write simulates first.** A transaction is built by the SDK, simulated with
`eth_call` from the connected account, and only then handed to the wallet; a refusal
is decoded against the contract's own ABI (`InsufficientFee(…)`, `InvalidProof()`) and
shown with what to do. ERC-20 approvals are exact, never unlimited. CSV amounts are
parsed exactly: `0.1` is 10^17 base units of an 18-decimal token, and a value with more
decimals than the token has is an error on its line, never a rounding.

## Chains where Gully Core is coming soon

`chain.id` accepts only chains in the SDK's chain table. On a chain Gully Core has
announced but not yet deployed to, the app renders one "Coming soon" page,
feature by feature, and checks that the chain itself answers; it reads nothing
else. When the SDK address book records that chain, updating
`@gullylabs/core-sdk` turns the app on with no edit here. As this template
ships, every chain it accepts is deployed.

---

## No invented data

Every figure this app renders was read from the chain it is configured for. That
is not a style preference: each screen exists to help somebody decide whether to
trust a contract in their swap path, and a number that looks real and is not
poisons that judgement with no way for the reader to tell which numbers to
discount.

The rules, if you extend this app:

- **If you cannot read it, do not render it.** Say what is missing and why.
- **Four states, visually distinct**: loading, error, empty, not-configured.
  `src/components/States.tsx` has all four. On error, say the chain is
  unreachable — never fall back to an example.
- **Dollars only where a price was read.** A figure reads in dollars only for the
  native coin and its wrapped form, and only when the SDK's native/USD resolver
  answered for this chain (Chainlink on chain, then Pyth, then a Gully Core pool, the
  source stated). Every other token stays in its own units with its symbol. Nothing
  here prices an arbitrary ERC-20, and inventing a price to produce a headline is
  the specific failure this rule exists to prevent.
- **Every chart is the chart kit.** `src/components/chartkit` (Motion + d3, MIT,
  Gully Core's shared kit) is the one set of charts; `src/components/Charts.tsx`
  keeps the short names over it. A new visual is a kit component, never a second
  chart library. Each chart takes the rows a screen read, draws its own table
  view, carries a provenance line, and refuses to draw a series from too few
  points.
- **Label the provenance.** A pool list is a log scan over a block range, not an
  enumeration. `<Provenance>` says which range. Do not tidy that away.
- **Disclose capability, never rate safety.** The pool table says what a hook
  is *able* to do, from its permission bitmap. It does not say whether the hook
  is safe, because this app cannot know that and neither can a registry listing.

---

## What is in here

```
gullycore.config.ts          the one file you edit
index.html
src/
  config/types.ts        the config's shape, documented field by field
  config/deployments.ts  Gully Core's shared core, per chain
  config/resolve.ts      validation — problems are rendered, never thrown
  lib/                   chain reads: pools, tokens, launches (v1 and v2), fees
  lib/createLaunchV2.ts  a locked launch, built and validated before it is simulated
  lib/marketCap.ts       market cap <-> opening price, exact integers, tested
  lib/usd.ts             dollars only where a price was read (the native/USD resolver)
  lib/routing.ts         routed fills: the router API, its answer for this chain, the fee
  lib/tokenLogo.ts       the native mark and a launch token's own verified icon
  lib/draft.ts           builder drafts in this browser, what was typed only
  components/chartkit/   the chart kit (Motion + d3), and Charts.tsx over it
  components/States.tsx  the four data states
  routes/                Swap · Pools · Launch · Launch wizard · Your earnings · Fees ·
                         Splits · Locks · Airdrops · the not-deployed-chain page
  lib/tx.ts              simulate → send → confirm, with revert decoding
  lib/utilities.ts       splits / locks / airdrops reads through the SDK
  lib/forms.ts           pure form logic (shares, dates, schedules, claims-file URLs), tested
  theme.ts               gullycore.config.ts colours -> CSS custom properties
scripts/
  gullycore-verify.mjs       read every configured address back off chain
  gullycore-deploy.mjs       resolve and write addresses; never sends a transaction
  gullycore-tenant.mjs       print the setTenantConfig transaction for your terms; never sends it
```

## Tests

`npm test` runs the template's own tests (`src/**/*.test.ts` and `test/`): config resolution
(features, utility addresses, routing, the market-cap default, `logsFromBlock`), the
market-cap seam, drafts, logos, dollar formats, form logic, revert decoding and the
chart kit (rendered with `renderToStaticMarkup`). `npm run typecheck` and
`npm run build` must pass as well.

## Deploying the front end

`npm run build` produces a static `dist/`. Host it anywhere. There is no server,
no API key and no backend: the app talks to public RPC endpoints probed by
`@gullylabs/core-sdk`, and you can put your own dedicated endpoint in front of
them with `VITE_RPC_URL`.

Set `VITE_WALLETCONNECT_PROJECT_ID` if you want WalletConnect wallets in the
connect modal. Without it those rows are omitted entirely rather than offered
and then failing at relay time.
