<p align="center">
  <a href="https://gullycore.xyz">Website</a> ·
  <a href="https://docs.gullycore.xyz/cli/">Docs</a> ·
  <a href="https://github.com/gully-labs/gully-core-sdk">GitHub</a>
</p>

# @gullylabs/core-cli — the `gullycore` command

Gully Core by Gully Labs, built on PancakeSwap Infinity's audited core.

Do everything on [Gully Core](https://gullycore.xyz) from a terminal: swap, open and read pools, add and
remove liquidity, launch a token on a locked pool, lock tokens and positions, read what the chain charges, open
a hosted Launchpad or DEX site, run airdrops, multisends and Team splits, and scaffold a front end or a hook. MIT.

```bash
npm install -g @gullylabs/core-cli     # Node 20+; or run once with npx @gullylabs/core-cli <command>
```

```bash
gullycore chain list                                  # where Gully Core runs
gullycore doctor --chain gully-testnet                # RPCs, contract clock, address book, USD source
gullycore swap quote --in ETH --out 0x3De9Cbf8E013897c4CAc6C0dc523abf965372358 --amount 0.001 --chain gully-testnet
gullycore pool list --chain gully-testnet --json
gullycore fees --chain gully-testnet                  # the flat 0.30% rule beside what the chain charges
gullycore launch --chain gully-testnet                # step-by-step launch, priced by its opening market cap
gullycore site create --chain gully-testnet           # a hosted Launchpad, DEX, or both
```

| command | what it does |
| ------- | ------------ |
| `gullycore swap quote \| exec` | expected out, minimum out, fees, price impact; through the Router API, or one pool with `--pool` |
| `gullycore pool list \| info \| create` | pools on a chain (API, or `--from-chain` logs), one pool in full, a new CL or Bin pool |
| `gullycore liquidity add \| remove` | a CL position (`--range-pct`, `--full-range`, ticks) or a Bin spread, with slippage bounds |
| `gullycore launch` | a launch-kit launch: opening market cap, protection, creator tax, listing, review, sign |
| `gullycore vault list \| info \| create \| deposit` | managed vaults: read the factory's vaults, make one on a CL pool (you become curator), deposit with exact approvals |
| `gullycore lock`, `lock position \| status \| claim` | a time lock, cliff-and-linear vesting, a CL position lock; read and claim |
| `gullycore fees` | fee controllers, the flat builder fee, the kit release, one pool's fees, read from the chain beside the rule |
| `gullycore tokens list \| info` | the address book's tokens (`--all` adds what the API indexed), a token, a balance |
| `gullycore chain list \| status` | where Gully Core runs, and one chain live |
| `gullycore config get \| set \| unset \| list \| path` | default network, slippage, keystore path, API and RPC URLs; never a key |
| `gullycore completion <shell>` | completions for bash, zsh, fish, PowerShell |
| `gullycore init [dir]` | scaffold the Gully Core app template: DEX, Launchpad or both (wraps `@gullylabs/create-core-app`) |
| `gullycore site create \| edit \| show` | a hosted Launchpad or DEX site: terms, earnings, brand |
| `gullycore doctor` | per-endpoint RPC health and contract clock, address book, launch-kit wiring, a wallet, terms drift |
| `gullycore airdrop build \| create \| verify \| claim` | CSV to a Merkle drop; `verify` asks the drop contract itself to judge the proofs |
| `gullycore multisend` | CSV to batched sends |
| `gullycore split` | a Team split with fixed shares |
| `gullycore new \| devnet \| bitmap` | hook tooling (below) |

**App only, not in the CLI.** Range orders, DCA (`orders`) and liquidity rewards (`rewards`) are in the SDK and the app
(`/app/swap`, pool screens, `GET /v1/chains/:id/pools/:poolId/rewards`) and have no `gullycore` command yet. Rebalancing and
harvesting a vault are permissionless calls the app and the keeper make; the CLI reads a vault but does not send them.

## The stepper

Run `gullycore launch` or `gullycore site create` in a terminal and it asks one step at a time:
`Step 4 of 7 · Opening market cap`. Type `<` in any text step, or pick **Back** in a list, to return
to the previous step; what you entered stays as the default. Every value is checked as you go with the
SDK's own validators, and nothing is offered for signing until the review screen has shown:

- the **snapped** opening price per pool (the price the pool is actually born at) and the market cap it
  implies;
- each fee on its own line — protocol launch fee, Launchpad launch fee, the value sent, creator-tax
  rates, expiry and split, locked-LP fee split;
- what is permanent;

and the exact transaction has succeeded as an `eth_call`. Irreversible actions ask you to type the
token symbol or site name.

**Market cap first.** The opening price comes from the market cap you choose. A dollar default
($3,500) is offered only when a live native/USD price was read (the source, block and age are shown
under it). Where there is none, you choose the cap in the quote currency and no dollar figure appears.

## Signing

gullycore **never accepts a raw private key or a mnemonic** — `--private-key`, `--mnemonic` and friends
are refused, and so is any argument shaped like one.

- **`--print`** (default): the unsigned transaction (`to`, `data`, `value`, chain) and an equivalent
  `cast send` line. Add `--from <address>`: it decides predicted addresses. Nothing is signed.
- **`--dry-run`**: simulates and shows the review. It never unlocks a key, even with a keystore named,
  whose declared address it reads without decrypting.
- **`--keystore <file>`**: an encrypted keystore (`cast wallet new` / `cast wallet import`, geth,
  ethers). `GULLYCORE_KEYSTORE` or the `keystore` setting name the file for scripts. The password is
  asked with a hidden prompt, or read from `--password-file` or `GULLYCORE_KEYSTORE_PASSWORD`. The
  environment only ever points at an encrypted file: a raw key in it is never read.
- **`--hardware ledger|trezor`** with `--from`: signs on the device through Foundry's `cast`, after the
  same simulation and confirmation. The key never leaves the device.

## Safety

- Every transaction is simulated, as the exact bytes from the sender, before it can be signed.
- A write on a chain with no deployment is refused (exit code 3).
- A mainnet write needs a typed confirmation. `--yes` skips it only with `--network <name>` (or `--chain`)
  on that command line: a default in the config can never turn a script into a mainnet write.
- The fee and the minimum out are on screen before any signature. Slippage defaults to 0.5%; above 5% it
  needs `--accept-high-slippage`, as does a price impact above 5%; 50% is refused always. A route whose
  floor is looser than the slippage you set is refused.
- Approvals are for the exact amount and, through Permit2, for one hour. They are built here, never taken
  from an API, and a swap from the Router API is decoded against the address book before it is used.
- A symbol resolves from the address book only. A user's RPC URL is never printed: it may hold a key.

## Scripts and bots

Every prompt has a flag. `--yes` never prompts (and replaces typed confirmation); `--json` prints
exactly one JSON document on stdout, with progress on stderr:

```json
{ "schema": "gullycore.cli/1", "command": "launch", "ok": true, "chainId": 8453, "mode": "print",
  "tx": { "chainId": 8453, "from": "0x…", "to": "0x…", "data": "0x…", "value": "1500000000000000" },
  "simulation": { "ok": true },
  "result": { "token": "0x…", "openingPrice": { "snapped": "…" }, "fees": { … }, "hash": null } }
```

`ok` means the command ran; a command's own verdict lives in `result` (e.g. `result.healthy` for
`doctor`), and the exit code is non-zero when that verdict is negative. On an error:
`{ "schema": "gullycore.cli/1", "command": "…", "ok": false, "error": { "message": "…", "hint": "…", "exitCode": 4 } }`.
Every amount is a decimal string of base units. Fields are only ever added within `gullycore.cli/1`.

## Chains, RPCs and your own addresses

Addresses come from `@gullylabs/core-sdk`'s address book, and `gullycore chain list` shows exactly what it
holds: Gully Chain Testnet (485590), Anubis (6714), Robinhood Chain (4663), Base (8453), BNB Chain (56) and
Kinetiq Elysium (99901). HyperEVM (999) is planned and says "no deployment yet". Anubis's gasDAI pays for gas only, so native value is
refused there and `launch` quotes in its ERC-20 DAI by default. No address is ever made up. `--network` is the same flag as
`--chain`; `gully-testnet`, `anubis`, `robinhood`, `base`, `bnb`, `elysium` or a chain id all work, and
`gullycore config set network <chain>` sets a default.

- `--rpc <url>` or `GULLYCORE_RPC_<chainId>`: your node. When given, it is used **alone** — never mixed
  with public endpoints, so a failing local node can never hand a signed transaction to another network.
- `--deployment <file.json>` or `GULLYCORE_DEPLOYMENT_OVERRIDE_<chainId>`: a partial address book merged
  over the SDK's (same shape as the web app's override; `deployedAtBlock` is a string). Every screen
  says when it is in use.
- `--api <url>`, `GULLYCORE_API` or the `api` setting: the Gully Core API (default
  `https://app.gullycore.xyz`), used for routes and indexed reads. `GULLYCORE_API_KEY` is sent if set. Pool
  reads fall back to the chain's logs, and a pool key from the API is re-hashed to its id before it is used.

## Exit codes

| code | meaning |
| ---- | ------- |
| 0 | done |
| 1 | failed: bad input, or a read that found nothing |
| 2 | usage: an unknown flag, a missing value |
| 3 | Gully Core has no deployment on that chain, or not that feature |
| 4 | the transaction would revert, or did |
| 5 | an RPC or the Router API could not be reached |
| 6 | a safety guard refused: slippage, price impact, a mainnet write without confirmation |
| 130 | cancelled at a prompt |

## Shell completions

```bash
eval "$(gullycore completion bash)"
gullycore completion zsh > "${fpath[1]}/_gullycore"
gullycore completion fish > ~/.config/fish/completions/gullycore.fish
gullycore completion powershell | Out-String | Invoke-Expression
```

## Hook tooling

`gullycore new <name>` generates a hook project (the same scaffolder as the `create-gully-core-hook` command this package installs); `gullycore devnet` runs a local
node with the protocol on it; `gullycore bitmap` explains permission bitmaps.

### Why this exists

On Uniswap v4 a hook's permissions are encoded in the *address* of the hook
contract, so shipping one means grinding a CREATE2 salt until the deployed
address happens to carry the right low bits - and changing your mind about a
callback means grinding again.

Gully Core keeps permissions in the pool key instead: the low 16 bits of
`poolKey.parameters` hold a registration bitmap, and `CLPoolManager.initialize`
cross-checks it against the hook's own `getHooksRegistrationBitmap()`. **A hook
works from any address. There is no salt to mine.**

What replaces salt mining as the first hurdle is keeping those two values in
step. They live in different files, in different languages, and when they drift
`initialize` reverts with `HookConfigValidationError` - the single most common
way a first hook fails. This CLI generates both from one permission set, so
there is no second source for them to drift from, and the generated test fails
the build if they ever stop agreeing.

## Quickstart

You need [Foundry](https://getfoundry.sh) (`forge`, `anvil`) and Node 20+.

```bash
# 1. install the CLI
npm install -g @gullylabs/core-cli   # once published; puts `gullycore` and `create-gully-core-hook` on PATH
```

```bash
# 2. scaffold a hook
create-gully-core-hook my-hook
cd my-hook
forge test -vv
```

That is the loop. The first `forge test` compiles the protocol and takes about a
minute; after that it is seconds.

```bash
# 3. run a local node with the protocol on it, in another terminal
gullycore devnet
```

```bash
# 4. deploy the hook you just generated onto it
#    (bash/zsh - the devnet prints the PowerShell form too)
# NOTE: this is anvil's well-known deterministic account #0. It is public, holds no
#       real funds, and exists only for local development. NEVER export a real
#       private key this way - shell history and terminal transcripts persist it.
export PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
export CL_POOL_MANAGER=<address printed by gullycore devnet>
forge script script/DeployMyHook.s.sol:DeployMyHook --rpc-url http://127.0.0.1:8545 --broadcast
```

The deploy script reads the bitmap back off the deployed contract and prints the
exact `parameters` word your pool key needs, so the value you copy can never be
stale.

### Without installing

```bash
node packages/cli/dist/bin/create-gully-core-hook.js my-hook
node packages/cli/dist/bin/gullycore.js devnet
```

### Finding the contracts

Generated projects compile against Gully Core's contracts, resolved in this order:

1. `--core <path-to-packages/core>`
2. `GULLYCORE_CORE_PATH` in the environment
3. a walk up from the output directory (and then the current directory) looking
   for `packages/core`
4. none of those: the scaffolder fetches the public contracts repository
   (<https://github.com/gully-labs/gully-core>) into the project as the git
   submodule `lib/gullycore-contracts`, at the one commit this release names, with
   its own submodules (as `git clone --recurse-submodules` gives them), and checks
   the commit after the fetch.

`gullycore devnet` resolves the same way, and also finds the contracts a generated
project fetched (`lib/gullycore-contracts`) when it is run inside that project. With
none of those it clones the public contracts repository at the pinned commit into
`<workdir>/contracts` once and reuses it.

Generated `foundry.toml` files get a **relative** path when the project sits near
the checkout, so the project can be committed and moved with it, and an absolute
one only when no sensible relative path exists.

## `@gullylabs/create-core-hook` / `gullycore new`

```
gullycore new <name> [options]                        # from a checkout: node packages/cli/dist/bin/gullycore.js new <name>
node packages/create-gully-core-hook/bin/create-hook.js <name> [options]   # the starter package, run in place
```

`create-gully-core-hook <name>` (installed with this package) runs the same scaffolder on its own.

Interactive by default; `--yes` makes it non-interactive, and every prompt has a
flag, so it runs in CI unattended.

| flag | meaning |
| ---- | ------- |
| `-t, --template <id>` | CL hooks: `noop`, `dynamic-fee`, `swap-counter`; Bin hook: `bin-swap-counter`; apps: `airdrop`, `locks` (see below) |
| `-p, --permissions <list>` | comma-separated callbacks, or `all` / `none` (CL templates only) |
| `--tick-spacing <n>` | tick spacing packed into `parameters` (default 60; CL templates only) |
| `--bin-step <n>` | bin step packed into `parameters` (default 10, 1-100; Bin templates only) |
| `--fee <n\|dynamic>` | static LP fee in hundredths of a bip, or a dynamic-fee pool |
| `--contract <Name>` | Solidity contract name (default: derived from `<name>`) |
| `-d, --dir <path>` | output directory (default `./<name>`) |
| `--core <path>` | where `packages/core` lives |
| `-y, --yes` | accept defaults, never prompt |
| `--force` | write into a non-empty directory |
| `--build` | run `forge build` on the result before reporting success |

### Templates

| id | what you get |
| -- | ------------ |
| `noop` | the smallest hook that builds, deploys and backs a live pool - one `beforeSwap` that does nothing |
| `dynamic-fee` | `beforeSwap` returns a per-swap LP fee, higher above a size threshold, on a dynamic-fee pool |
| `swap-counter` | `afterSwap` keeps an on-chain swap count per `PoolId` |
| `bin-swap-counter` | a **Bin** pool hook on `BaseBinHook`: `afterSwap` keeps a swap count per `PoolId`; test harness on `BinPoolManager` with mint/swap helpers; deploy script reads `BIN_POOL_MANAGER` |

The Bin template is a fixed starting point: its callbacks are its own (bitmap
`0x0080`), so `--permissions` and `--tick-spacing` are refused for it; `--bin-step`
and a static `--fee` (at most 10%, the Bin maximum) apply. Add callbacks by hand
from `BaseBinHook`'s override points and change the bitmap and the test's
`EXPECTED_PARAMETERS` together.

Templates are starting points, not permission sets. Pick any callbacks you like
with `--permissions`: the generator emits an override for each one, using the
template's body where it has one and a pass-through otherwise. Registering a
callback you have not implemented is not a silent no-op on Gully Core -
`BaseCLHook`'s default override points `revert HookNotImplemented()` - so the
generator never emits a bitmap wider than the code behind it.

A `*ReturnsDelta` permission cannot stand alone; the base callback it needs is
added for you, with a warning, rather than generating a project that reverts at
pool initialization.

### App templates: `airdrop` and `locks`

Not every Gully Core integration is a hook. Two templates generate a **Node project**
on the MIT [`@gullylabs/core-sdk`](../sdk) instead of a Foundry one:

```bash
gullycore new my-drop  --template airdrop
gullycore new my-locks --template locks
```

| id | scripts | contracts |
| -- | ------- | --------- |
| `airdrop` | `multisend` (CSV -> atomic batches of up to 1,000), `drop` (CSV -> Merkle tree -> `claims.json` -> a funded drop), `holders` (a token's holders at a snapshot block -> a checked recipients CSV, pro-rata / equal / fixed), `check-claims` (verify a claims file against a drop's stored root) | `GullyCoreMultisend`, `GullyCoreDropFactory` |
| `locks` | `lock-position` (time-lock a CL position NFT), `vest` (token time-lock or cliff + linear vesting), `status` (locked share of a pool's active liquidity, or of a token's supply) | `GullyCorePositionLock`, `GullyCoreTokenLock` |

Every generated app follows the same rules, and `test/app.test.ts` checks them:

- **MIT dependencies only**: `@gullylabs/core-sdk`, `viem`, and `tsx` /
  `@types/node` for development. Nothing GPL, so the project is yours to license.
- **Dry run by default.** Without `--execute` a script reads, validates, prints the
  plan and simulates every transaction it can (as `PRIVATE_KEY`'s address, or
  `FROM`). A step that needs an earlier one mined first (a transfer after its
  approval) is reported as such, not faked.
- **Simulate, then send.** With `--execute` each transaction's exact bytes are
  simulated, sent, and its receipt checked before the next; the first failure
  stops the plan, and the revert is named from the contract's ABI.
- **Keys only from the environment.** `PRIVATE_KEY` (or `.env`); a key passed as a
  flag is refused.
- **Exact approvals**, never unlimited, skipped when the allowance already covers it.
- **Addresses from the SDK's address book**; `null` there means not deployed, and
  the script stops and says so. `GULLYCORE_MULTISEND`, `GULLYCORE_DROP_FACTORY`,
  `GULLYCORE_POSITION_LOCK` and `GULLYCORE_TOKEN_LOCK` override them for a local devnet.

Every action pays the utility's flat native fee, **charged by the contract**
however it is called; the scripts read it live. The hook-only flags
(`--permissions`, `--tick-spacing`, `--fee`, `--contract`, `--core`, `--build`)
are refused for an app template rather than silently ignored.

Inside a Gully Core checkout the SDK is linked with `file:`: build it once with
`npm install && npm run build` in `packages/sdk`, then `npm install` in the
generated project. Elsewhere the project depends on `@gullylabs/core-sdk` from npm. The script sources live as real files
under `assets/apps/` so the test suite compiles them against the SDK source.

### What gets generated

```
my-hook/
  src/MyHook.sol                 extends BaseCLHook; getHooksRegistrationBitmap() is generated
  test/MyHook.t.sol              Vault + CLPoolManager + router + two mock ERC20s, end to end
  script/DeployMyHook.s.sol      deploys, then prints the parameters word for your pool key
  foundry.toml                   remappings and both build profiles
  gullycore.json                     machine-readable record of the permission set
  README.md                      quickstart, the invariant, and a security checklist
  .gitignore
```

The generated test suite covers, for every template:

- `test_registrationBitmapMatchesPoolKey` - the hook's bitmap, the pool key's
  bitmap and the generated constant are one number.
- `test_mismatchedBitmapRevertsAtInitialize` - deliberately reproduces
  `HookConfigValidationError`, so the error you are most likely to hit is one you
  have already seen pass by.
- `test_hookWorksFromAnArbitraryAddress` - `vm.etch`es the hook at `0xDEAD`,
  initializes a pool with it and swaps. This is the part v4 cannot do.
- liquidity and swaps in both directions, plus whatever the template adds.

## `gullycore devnet`

```
gullycore devnet [options] [-- <extra anvil args>]
```

Starts anvil and deploys:

- **Vault** and **CLPoolManager** / **BinPoolManager**, both registered as Vault apps
- **GullyCoreProtocolFeeController** from `packages/fees`, wired into both managers
  (the contracts come from `--core`, a checkout, a generated project's
  `lib/gullycore-contracts`, or a clone of the public contracts repository at the
  pinned commit in `<workdir>/contracts`)
- two freely mintable mock ERC20s (`mint` is public - fund yourself)
- **CLPoolManagerRouter**, the core test router, so pools are usable without
  writing a lock callback by hand
- one initialized, seeded, hookless CL pool

Addresses are printed as a table and also written to
`<workdir>/deployments/devnet.json`.

| flag | meaning |
| ---- | ------- |
| `-p, --port <n>` | anvil port (default 8545) |
| `--host <addr>` | bind address (default 127.0.0.1) |
| `-f, --fork <rpc-url>` | fork a live chain (anvil's `--fork-url`) |
| `--fork-block-number <n>` | pin the fork height |
| `--rpc-url <url>` | deploy to a node that is already running instead of starting anvil |
| `--deployer-key <hex>` | deploying key (default: anvil account 0) |
| `--workdir <path>` | where the devnet project and its build cache live (default `~/.gullycore/devnet`) |
| `-q, --quiet` | do not stream anvil's log |
| `--json` | deploy, print the addresses as JSON, shut down |

Anything after `--` goes to anvil untouched: `gullycore devnet -- --block-time 2`.

The deployment is a Foundry script that reuses `packages/core/script`'s
`BackendGuard` and deploys plainly: anvil's deterministic accounts give the same
addresses on every run, so no CREATE3 factory is needed locally. The first run compiles the protocol with `via_ir` and takes a couple of minutes; the
build cache lives in the working directory, so later runs start in seconds.

anvil runs a Cancun-capable EVM whatever it forks, so the devnet always uses the
**default** (EIP-1153 / transient storage) build. The `legacy` SSTORE backend is
for pre-Cancun chains only.

## `gullycore bitmap`

The permission maths on its own - useful when a pool refuses to initialize.

```bash
$ gullycore bitmap beforeSwap,beforeSwapReturnsDelta

  bitmap     0x0440
  decimal    1088
  binary     0000010001000000
  callbacks  beforeSwap, beforeSwapReturnsDelta

  tick spacing         60
  pool key parameters  0x00000000000000000000000000000000000000000000000000000000003c0440

  In the hook:

    function getHooksRegistrationBitmap() public pure override returns (uint16) {
        return BEFORE_SWAP | BEFORE_SWAP_RETURNS_DELTA;
    }
```

```bash
gullycore bitmap --decode 0x0080                  # which callbacks is that?
gullycore bitmap --parameters 0x...003c0080       # unpack a whole parameters word
gullycore bitmap --list                           # every permission and its bit
```

## Build profiles

Every generated project carries the same two profiles as the rest of the
monorepo, differing only in which transient-storage backend the settlement layer
compiles against:

```bash
forge test                          # default: EIP-1153 (tstore/tload), evm_version = cancun
FOUNDRY_PROFILE=legacy forge test   # legacy:  SSTORE/SLOAD,            evm_version = shanghai
```

The `hp-transient/` remapping is pinned **per profile in `foundry.toml`**, and
generated projects deliberately have no `remappings.txt`: that file silently
overrides per-profile remappings and would build the wrong backend under
`--profile legacy`.

## How this package stays honest

The permission tables here are a copy of numbers that really live in Solidity.
`test/parity.test.ts` reads the Solidity and fails if they drift:

- bit offsets against `packages/core/src/pool-cl/interfaces/ICLHooks.sol`
- constant names and shifts against `packages/hooks/src/base/BaseCLHook.sol`
- bitmap and tick-spacing offsets against `ParametersHelper.sol` and
  `CLPoolParametersHelper.sol`

Encoding, decoding and validation themselves are reused from
[`@gullylabs/core-sdk`](../sdk) rather than re-derived.

```bash
npm run typecheck    # tsc --noEmit, strict
npm test             # vitest
npm run build        # tsc + copy the Foundry assets into dist/
```

## Known limitations

- One Bin template (`bin-swap-counter`) and it is not recomposable with
  `--permissions` the way the CL templates are; the devnet seeds a CL pool only
  (it deploys `BinPoolManager`, but no Bin pool).
- Generated projects take the contracts as a git submodule (or a checkout on
  disk), not as a `forge install` dependency.
- `gullycore devnet` assumes anvil's deterministic accounts. If you pass a custom
  `--mnemonic` through `--`, pass the matching `--deployer-key` too.
- The devnet script constructs `GullyCoreProtocolFeeController` directly, so a change
  to that contract's constructor in `packages/fees` breaks `gullycore devnet` until
  `assets/devnet/script/GullyCoreDevnet.s.sol` is updated to match. The failure is a
  compile error naming the constructor, not a silent misdeployment.
- The devnet refuses to start when something is already serving JSON-RPC on the
  chosen port, rather than quietly deploying onto a stranger's node. Use
  `--port`, or `--rpc-url` if attaching was the intent.

## Other Gully Core packages

- [`@gullylabs/core-sdk`](../sdk/README.md) — TypeScript SDK: pool keys and ids, the hook permission bitmap, typed events, the address book, market reads and the Launchpad builders (`npm i @gullylabs/core-sdk viem`)
- [`@gullylabs/create-core-app`](../create-gully-core-app/README.md) — the Gully Core app template: a DEX, a Launchpad or both, on the shared core (`npm create @gullylabs/core-app@latest`)

Website: [gullycore.xyz](https://gullycore.xyz) · Docs: [docs.gullycore.xyz](https://docs.gullycore.xyz)


## Licence

MIT. Generated hooks are yours; they import `BaseCLHook` (GPL-2.0-or-later) from
`packages/hooks`, and building against the MIT-licensed SDK carries no obligation
from the core contracts.
