<p align="center">
  <a href="https://gullycore.xyz">Website</a> ·
  <a href="https://docs.gullycore.xyz">Docs</a> ·
  <a href="https://github.com/gully-labs/gully-core-sdk">GitHub</a>
</p>

# @gullylabs/create-core-app

The Gully Core app template: scaffold a **DEX, a Launchpad or both** on Gully Core's
**shared core**. You get a Vite + React front end, one config file
(`gullycore.config.ts`: chain, fee wallet, branding, features) and a verify script.
You deploy no core contracts: your pools live in the Vault and pool managers Gully Core
already runs on the chain you pick. Set the fee wallet, restyle if you want, ship.
MIT, and so is everything it emits.

```bash
npm create @gullylabs/core-app@latest my-app -- \
  --chain base \
  --fee-wallet 0xYourTreasury \
  --fee-bps 25 \
  --features both          # dex | launchpad | both

cd my-app
npm install
npm run gullycore:verify     # read every configured address back off chain
npm run dev
```

`npx @gullylabs/create-core-app my-app …` does the same thing. The `--` after the
directory is npm's: it passes the flags through `npm create` to the scaffolder.

Run it with no flags and it prompts. Add `--yes` and it never will: every option
has a flag, and anything with no safe default is an error rather than a guess.

The same scaffolder runs as `gullycore init` in `@gullylabs/core-cli`,
and it is also importable: `import { runCreate } from "@gullylabs/create-core-app"`,
then `await runCreate(["my-app", "--chain", "base", "--yes"])` returns the exit code.

---

## What it produces

A Vite + React app, one config file, and three scripts. **No contracts.**

```
my-app/
  gullycore.config.ts        chain · fee wallet · routing · branding · features · tokens · launch defaults
  src/
    config/              the config's shape, Gully Core's address book, validation
    lib/                 chain reads: pools, tokens, launches, fees, USD, routing, drafts, logos
    components/          the shell, the four data states, the chart kit (Motion + d3, MIT)
    routes/              Swap · Pools · Launch · Launch wizard · Your earnings · Fees ·
                         Splits · Locks · Airdrops
    theme.ts             config colours -> CSS custom properties
  scripts/
    gullycore-verify.mjs     turn every configured address into a fact or a failure
    gullycore-deploy.mjs     resolve and write addresses. Sends no transaction, ever.
    gullycore-tenant.mjs     print the transaction that stores your launch terms
```

Everything a tenant changes to go to market is in `gullycore.config.ts`. Restyling
is a colour edit there — no stylesheet in the template hardcodes a colour, the chart
kit included.

**What the app does today, all read from chain:** a swap box (`@gullylabs/core-widgets`
`SwapWidget`: pays the native coin straight into a wrapped-native pool, Permit2 by
signature, every send simulated first, routed fills through Gully Core's router API
when they pay more, dollar figures under a well only from the chain's native/USD
feed); pools with the chart kit's KPIs, sparklines and bar lists; a locked-launch
wizard that is **market-cap-first** (the opening market cap comes first, defaulting
to the config's `launch.defaultOpeningMarketCapUsd`, $3,500 unless changed, turned
into an opening price through the native/USD feed with its source stated, the
snapped price shown) and keeps a draft of what was typed in the browser; launch
earnings; the Fees screen with every fee a user pays, the routing fee included;
Team splits, locks and airdrops (multisend and Merkle drops).

---

## Shared core, not a full fork

The tenant does **not** deploy `Vault`, `CLPoolManager` or `BinPoolManager`. Their
pools live in the core Gully Core deploys and verifies on the chosen chain: Anubis
(6714) or Gully Chain Testnet (485590), as recorded in the `@gullylabs/core-sdk`
address book. A chain the book does not record is refused
by the scaffolder with that list; nothing is "coming soon" that Gully Core has not
announced.

That is cheaper and faster for them — no nineteen-contract deployment, no
verification, no audit question — and it is the only model in which Gully Core's
protocol fee is enforceable, because `protocolFeeController` on a shared pool
manager belongs to Gully Core governance and is capped at `MAX_PROTOCOL_FEE = 4000`
pips (0.4%) by core.

A full fork is permitted by the GPL, owes nothing, and gets no shared registry.
It is supported here only in the sense that `chain.contracts` lets a tenant point
the front end at their own addresses. The generated README says so plainly rather
than pretending the choice does not exist.

**Between the two: `chain.router`.** A tenant on the shared core can point every
swap — the DEX surfaces and a launch's buy path, which share one widget adapter
— at their OWN router while the Vault, the pool managers, the kits, the lockers
and the registry stay Gully Core's. Absent or `null` (the default, and what the
scaffolder writes) means Gully Core's router from the SDK address book, with no
configuration at all. It is a first-class option rather than the `contracts`
escape hatch on purpose: wanting your own router is not the same claim as
wanting your own core, and a tenant should not have to use the full-fork
mechanism to say the smaller thing. Setting both to different addresses is a
blocking config error — one of them would otherwise lose silently. The router
must still be Gully Core's `UniversalRouter` ABI wired to the same Vault and Permit2,
because the widgets encode that command set; `gullycore:verify` checks the code, the
router's `vault()`, `paused()` and `owner()`, and says whose router is in use.
Gully Core's routed-fill fee travels with Gully Core's router, so a tenant on their own
neither pays nor collects it — the generated README states that rather than
leaving it to be discovered.

**And `routing`: Gully Core's routing API by default, yours as an option.** Separate
from the on-chain router above: the ROUTER API the swap box asks for quotes that
may be filled on a third-party venue through Gully Core's `GullyCoreFillRouter` when
that pays the user more than every Gully Core pool. `routing.api` is `'gullycore'`
(Gully Core's hosted API, the default), an `https://` origin (a tenant's own
deployment of the same API, which must name the same fill router as the address
book or the widget refuses its answers), or `null` (Gully Core pools only). Two things
the generated README says plainly: the routing fee (15 bps on a third-party fill,
0 on a Gully Core pool, inside an immutable cap, read off the fill router) is the
protocol's and not an integrator share; and the widget ignores the router while
`fee.bps` is above zero, because a routed fill has no integrator step and would
silently drop the fee — so routing only runs with `fee.bps: 0`, and the config
resolver names that as a warning. `gullycore:verify` asks the API whether it
serves the chain and which venues it names.

### Nothing to deploy, and that is deliberate

Both launch kits take every launch parameter as a call argument, so **one
instance serves every tenant**: launches differ by their arguments, not by
their bytecode. `LaunchpadKitV2` (locked launches) additionally keeps a
per-tenant config the tenant writes itself — the integrator wallet, its share
of locked-LP fees and its launch fee — and refuses a launch that restates it
differently; the kit's owner cannot touch a tenant's config. `LaunchGuardHook`'s
only authority is a per-pool `launchOwner`, and `RevShareHook` is configured
entirely per pool. So `gullycore:deploy` resolves and verifies rather than
deploying, `gullycore:tenant` prints the one transaction that stores a tenant's
terms (`GullyCorePad.configure` from the pad's owner when `chain.launchTenant` is a
`GullyCorePad` — the recommended, transferable form with an on-chain brand — or
`setTenantConfig` from the wallet otherwise), and `--own-kit` prints a `forge`
command for a tenant who wants their own instance anyway.

Where the SDK address book records no shared kit for a chain,
`chain.launchpadKitV2` and `chain.launchpadKit` start `null` and the launch
screens say so plainly instead of rendering an example. The generated README
documents the options.

### Gully Core utilities, on by default

The emitted app also ships Team splits (`/splits`, and a "pay the creator share to a
split" option in the launch wizard), locks (`/locks`, lock badges on pools and launched
tokens) and airdrops (`/airdrops`: multisend and claimable Merkle drops from a CSV, and a
claim page that verifies the claims file against the drop's root). Each is a flag in
`features`; addresses come from the SDK address book per chain, and a contract recorded
`null` renders "coming soon on <chain>". The contracts charge their own flat fees, read
live and shown before signing; **the template adds no fee of its own to any of them.**
The template carries its own tests (`npm test`), run in a generated project.

### Dollars, only where a price was read

Every amount of value reads in dollars first where the chain's native/USD feed
answered (`resolveNativeUsd` from the SDK: Chainlink read on chain, then Pyth, then
a Gully Core pool, each answer carrying its source and age), and ONLY for the native
coin and its wrapped form. Every other token stays in its own units with its
symbol; nothing in the template prices an arbitrary ERC-20, and a testnet never
shows dollars. The launch wizard derives a PERMANENT figure from the same read and
says which source it used.

### The chart kit

`template/src/components/chartkit/` is the template's own copy (MIT) of Gully Core's
shared chart kit: Motion (`LazyMotion` + `m`) for the draw-on, rise and count-up,
d3-scale and d3-shape for the maths only, one even grid, crosshair + tooltip, ←/→,
Chart | Table on every card, the four honest states, provenance under every chart,
everything off under `prefers-reduced-motion`. `components/Charts.tsx` keeps the
template's short names (`Kpi`, `Sparkline`, `BarList`, `ShareBar`) as thin wrappers
over it, so no screen builds a second chart. Its CSS maps the kit's tokens onto the
`--brand-*` custom properties, so a colour edit in `gullycore.config.ts` restyles the
charts too; the data colours stay the kit's validated set.

---

## Licensing — the rule this package exists under

**This package and everything it emits are MIT**, and a tenant may close-source
their fork. That holds for exactly one reason: the emitted app reaches the
protocol through the MIT `@gullylabs/core-sdk` and through ABIs, never through GPL
Solidity. An ABI call is not linking and does not create a derivative work.

| Layer | Licence |
|---|---|
| This scaffolder and its template | **MIT** |
| `@gullylabs/core-sdk`, `/widgets`, `/connect` | MIT, independently authored |
| Gully Core core, periphery, router, Gully Core's hooks | **GPL-2.0-or-later** |

> **Never import GPL Solidity, or anything generated from it, into `template/`.**
> Not sources, not build artifacts, not a hex bytecode string.

`test/scaffold.test.ts` enforces this: it greps every emitted source file for an
import reaching into `packages/core`, `packages/periphery`, `packages/router`, a
GPL hook package, or any `.sol` path, and fails the build if it finds one. The
rule is a test, not a paragraph.

The same rule is why `gullycore:deploy --own-kit` prints a command instead of running
one. Shipping the kit's bytecode would put GPL code inside an MIT distribution.

---

## The template is a real app

Every file under `template/` typechecks and builds exactly as it sits on disk,
against defaults pointing at a chain Gully Core is deployed on. Substitution replaces
valid values with other valid values, in two shapes:

```ts
name: '__GULLYCORE_APP_NAME__',              // placeholder inside a string literal
id: 8453 /* __GULLYCORE_CHAIN_ID__ */,        // real literal, tagged by a comment
```

The tagged form is what lets the template compile before substitution — and a
template nobody can build is a template nobody reviews. After substitution the
marker comment is gone, and `scaffold()` fails loudly if any marker survives.

---

## Flags

| Flag | Meaning |
|---|---|
| `--chain <name\|id>` | `base` / `8453`, `bnb` / `bsc` / `56`, `robinhood` / `4663`, `elysium` / `99901`, `anubis` / `6714`, `gully-testnet` / `485590`. Required. The list is the SDK address book's; `test/scaffold.test.ts` keeps the two in step. |
| `--fee-wallet <address>` | Where the front end's swap fee is paid. Required when `--fee-bps > 0`. |
| `--fee-bps <n>` | Fee in basis points of the swap **output**, `0..100`. Default `0`. |
| `--features <set>` | `dex` (swap, pools, locks, airdrops), `launchpad` (launchpad, splits, locks, airdrops), `both` (everything), or a comma list of `swap,pools,launchpad,splits,locks,airdrops`. |
| `--name <string>` | Product name. Defaults from the directory name. |
| `--package-manager <pm>` | `npm` / `pnpm` / `yarn` / `bun`. Only changes the printed next steps. |
| `--yes` | Never prompt. |

The fee ceiling of 100 bps mirrors `MAX_INTEGRATOR_FEE_BPS` in
`@gullylabs/core-widgets`, which is what actually builds the calldata. If the two
ever disagree, the widget is authoritative.

---

## Other Gully Core packages

- `@gullylabs/core-sdk` — TypeScript SDK: pool keys and ids, the hook permission bitmap, typed events, the address book, market reads, the native/USD resolver and the Launchpad builders
- `@gullylabs/core-cli` — the `gullycore` command: swaps, pools, launches, hosted Launchpad and DEX sites, airdrops, splits, locks and `gullycore doctor`

Website: [gullycore.xyz](https://gullycore.xyz) · Docs: [docs.gullycore.xyz](https://docs.gullycore.xyz)

---

## Tests, and the proof that counts

`npm test` runs the scaffolder's suite and the template's pure suites (config
resolution, routing, the market-cap seam, drafts, logos, forms, revert decoding)
against this package's own `node_modules`. It proves nothing about the React
surfaces, the typecheck or `vite build`, which need a REAL install. That is
`npm run test:template` (after `npm run build`): it packs `sdk`, `widgets` and
`connect` from the monorepo with their `file:` dependencies rewritten, scaffolds a
project OUTSIDE the repository with the built scaffolder, installs from the
tarballs, and runs `tsc --noEmit`, `vite build` and the project's own `vitest run`
— every suite under `template/src/`, the React-dependent ones included.

## No invented data

The template inherits the rule the Gully Core dapp runs under: every figure is read
from chain, and what cannot be read is named rather than filled in. Four visually
distinct states — loading, error, empty, not-configured — live in
`src/components/States.tsx`, and there is no fifth state where a screen shows an
example.

Two consequences worth knowing before extending the template:

- **`@gullylabs/core-widgets` exports a `LaunchWidget` that this template does not
  use.** It is bound to a *proposed* token-sale interface that no deployed Gully Core
  contract implements. The launch screens here are written against the real
  `LAUNCHPAD_KIT_ABI` instead, and they render a fee schedule rather than a sale
  progress bar, because a Gully Core launch is a pool with a decaying fee and has no
  cap to progress toward.
- **The pool table discloses capability, never safety.** It says what a hook is
  *able* to do, from its permission bitmap. A registry listing is not an audit
  and a bitmap is not a review.
