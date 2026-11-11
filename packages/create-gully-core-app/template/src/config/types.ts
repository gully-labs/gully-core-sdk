// SPDX-License-Identifier: MIT
/**
 * The shape of `gullycore.config.ts` — the one file a tenant edits.
 *
 * Everything a tenant needs to change to take this to market is here: the
 * chain, the fee wallet, the branding and which features are switched on.
 * Nothing else in the project should need touching, and in particular **no
 * Solidity**. A tenant who has to fork a contract to change a fee address is a
 * tenant maintaining a Solidity fork, which is the opposite of one click.
 *
 * Two things are deliberately NOT configurable here:
 *
 *   * Core addresses. `Vault` and the pool managers come from
 *     `src/config/deployments.ts`, which records what Gully Core has deployed and
 *     verified per chain. They are overridable (`contracts`) for a full fork,
 *     but a tenant on shared core should never need to. The one exception is
 *     the ROUTER: `chain.router` is a first-class option, because pointing
 *     swaps at your own router is a thing a tenant on SHARED core legitimately
 *     wants, and it should not require the full-fork escape hatch.
 *   * Gully Core's protocol fee. It is set per pool by `protocolFeeController` on the
 *     shared pool manager, which Gully Core governance owns and core caps at
 *     `MAX_PROTOCOL_FEE = 4000` pips (0.4%). Your app can read it — see
 *     `src/lib/protocol.ts` — but it cannot change it.
 */

import type { Address } from "viem";
import type { GullyCoreChainId } from "@gullylabs/core-sdk";

/**
 * Chains where Gully Core's shared core is deployed.
 *
 * Aliased from the SDK rather than written out, so this union cannot fall
 * behind the address book it indexes: Base (8453), BNB Chain (56), Robinhood
 * Chain (4663), Kinetiq Elysium (99901), Anubis Network (6714) and Gully Chain
 * Testnet (485590) as this template ships.
 */
export type SupportedChainId = GullyCoreChainId;

/**
 * Chains on the SDK's target list (`CHAIN_RPCS`) where Gully Core is NOT deployed
 * yet. A config may name one: the app then renders one honest page saying so
 * (every feature "not deployed on <chain>"), instead of failing read by read.
 * When the SDK address book records a deployment there, the chain moves into
 * {@link SupportedChainId} by bumping the dependency, and nothing here changes.
 *
 * `never` today: the rollout is settled at the four deployed chains, and a chain
 * Gully Core has not announced is not "coming soon". The filter in
 * `deployments.ts` drops an id from this list the moment the address book
 * carries it, so no chain can be both "undeployed" and supported.
 */
export type UndeployedChainId = never;

/**
 * Contract addresses.
 *
 * Only supply these to override the address book, which is what a full fork
 * needs. On shared core, leave them out.
 */
export interface ContractOverrides {
  /* The Gully Core utilities: overridable like the core, for a full fork or a local
     devnet. On shared core leave them out; the address book has them. */
  readonly splitFactory?: Address;
  readonly positionLock?: Address;
  readonly tokenLock?: Address;
  readonly multisend?: Address;
  readonly dropFactory?: Address;
  readonly vault?: Address;
  readonly clPoolManager?: Address;
  readonly binPoolManager?: Address;
  /**
   * The router, for a full fork's OWN core.
   *
   * On shared core use `chain.router` instead. Both land in the same place, but
   * they say different things: this one is part of "none of Gully Core's addresses
   * apply to me", `chain.router` is "Gully Core's core, my router". Setting both to
   * different addresses is a config error rather than a precedence puzzle —
   * see `resolveRouter` in `resolve.ts`.
   */
  readonly universalRouter?: Address;
  readonly clPositionManager?: Address;
  readonly binPositionManager?: Address;
  readonly clQuoter?: Address;
  readonly permit2?: Address;
  readonly weth?: Address;
}

export interface ChainConfigInput {
  readonly id: SupportedChainId | UndeployedChainId;

  /**
   * `GullyCoreRegistry` — the shared marketplace of listed GullyCores (hook contracts).
   *
   * Read from here, never hardcoded anywhere else in the app: this contract has
   * been redeployed before and will be again, and a stale address in a source
   * file reads as a healthy empty registry rather than as a wrong one. Leave it
   * `null` and every registry surface renders "not configured" and says so.
   */
  readonly registry: Address | null;

  /**
   * `LaunchpadKit` — the one-call launch factory.
   *
   * `null` disables the launch surfaces with an honest "not configured" state.
   * `npm run gullycore:verify` fills this in from the address book when Gully Core has a
   * shared instance on your chain, or from your own deployment when you run one.
   */
  readonly launchpadKit: Address | null;
  /**
   * The LaunchGuardHook a launch pool has attached.
   *
   * Separate from `launchpadKit` because they answer different questions: the
   * kit CREATES a launch, the hook IS the launch — it holds the fee schedule
   * and the start block, and it is what `LaunchWidget` reads. A chain can have
   * the kit without the hook, or a tenant can point at a hook whose pools were
   * created some other way.
   *
   * `null` means the launch surfaces render "not configured" rather than
   * guessing an address. It is the correct value until you have a hook address
   * that `npm run gullycore:verify` reads back with code.
   */
  readonly launchGuardHook: Address | null;

  /**
   * `LaunchpadKitV2` — locked launches: a new token, one to `maxLegs()` pools
   * (single-sided CL ranges and shaped Bin distributions), every position
   * locked forever in a Gully Core locker, all in one transaction.
   *
   * When this is set the launch surfaces use it; `launchpadKit` (v1, unlocked
   * pools seeded from a token you already hold) stays reachable at
   * `/launch/v1`. `null` means the v2 surfaces render "not configured". The SDK
   * address book (`launchpadV2.launchpadKitV2`) has it once Gully Core deploys one;
   * `npm run gullycore:verify` reports which.
   */
  readonly launchpadKitV2: Address | null;

  /**
   * Your TENANT on the v2 kit: a `GullyCorePad` you own, or the wallet that called
   * `setTenantConfig`.
   *
   * A tenant config is the kit's record of your integrator wallet, your share
   * of every launch's trading fee and your launch fee, written by you, readable by anyone.
   * Every launch this app creates names it, and the kit refuses a launch whose
   * numbers differ from the stored ones — so your fee cannot be re-priced by a
   * launcher, and a launch cannot quietly drop it.
   *
   * A PAD address is the recommended form. `GullyCorePadFactory.createPad` clones a
   * `GullyCorePad` and makes it a kit tenant in one transaction; the pad is the
   * tenant, its owner writes the terms with `GullyCorePad.configure` (and the
   * quote allowlist with `setQuote`), it carries your name and brand on chain
   * (`name()`, `metadataURI()`), and it changes hands two-step
   * (`transferOwnership` / `acceptOwnership`) so the launchpad itself is
   * transferable without every launch re-pointing. The pad holds nothing: fees
   * are credited to the integrator wallet in its config, never to the pad.
   *
   * A WALLET address is the older form: the tenant is whoever sent
   * `setTenantConfig`, so the terms are tied to that key forever and cannot be
   * transferred. `npm run gullycore:verify` tells the two apart (a pad has code and
   * answers `owner()` and `KIT()`) and fails if a pad is bound to a different
   * kit than `launchpadKitV2`.
   *
   * `null` means DIRECT launches: the app names `fee.wallet` as the integrator
   * with the numbers in `launch` below, and nothing on chain holds them. That
   * works, but a launcher calling the kit outside this app pays you nothing
   * either way; `npm run gullycore:tenant` prints the transaction that turns the
   * numbers below into a tenant config — `configure` on the pad, from its
   * owner, when this is a pad; `setTenantConfig` on the kit otherwise.
   */
  readonly launchTenant: Address | null;

  /**
   * YOUR OWN ROUTER, in place of Gully Core's. Optional; `null`/absent is the
   * default and is the right answer for almost everybody.
   *
   * Left alone, every swap this app builds — the DEX surfaces AND the buy path
   * on a launch — goes through the `universalRouter` the SDK address book
   * records for `chain.id`. That is Gully Core's, deployed and verified, and
   * it follows a redeploy when you bump the dependency. Zero configuration.
   *
   * Set this and that one address changes. Nothing else does: your pools are
   * still in Gully Core's Vault, the launch kit, the lockers, the registry and the
   * utilities are untouched, and your `fee.bps` still lands — it is a
   * `TAKE_PORTION` action inside the plan your router executes, so it is yours
   * either way.
   *
   * WHAT IT HAS TO BE. `@gullylabs/core-widgets` encodes calldata for Gully Core's
   * `UniversalRouter` ABI: `execute(bytes commands, bytes[] inputs, uint256
   * deadline)`, the Infinity command set, the fee action — and it grants the
   * input token's Permit2 allowance to THIS address. So this must be a
   * deployment of that router (forking it is allowed; it is GPL-2.0-or-later)
   * wired to the same Vault and pool managers this app reads and to the same
   * Permit2. Any other contract that calls itself a router is not a drop-in:
   * the calldata still encodes, and it does not mean what it says.
   *
   * WHAT IT COSTS. The router is in the swap path and handles users' funds
   * while a swap is in flight, so yours is yours to secure, and whoever owns it
   * can pause every swap in this app. Gully Core's routed-fill fee — 15 bps where
   * Gully Core's router fills a trade somewhere other than a Gully Core pool, 0 on a
   * Gully Core pool — is charged by Gully Core's router only: through yours your users do
   * not pay it and you do not earn it, because it was never yours to earn.
   *
   * NOT CHECKED HERE. `resolveConfig` makes no network call, so it can tell you
   * this is a well-formed address and not that anything is deployed at it. Run
   * `npm run gullycore:verify`: it reads the code, checks the router's `vault()`
   * against the one this app uses, and reports `paused()` and `owner()`.
   */
  readonly router?: Address | null;

  /**
   * Extra RPC URLs, tried before the SDK's probed public list.
   *
   * Public endpoints rate-limit and disappear. Put a keyed provider here via an
   * env var; never commit the URL itself, because a provider key is embedded in
   * the path.
   */
  readonly rpcUrls?: readonly string[];

  /**
   * The block explorer every transaction and address link points at. Leave it
   * out for the address book's explorer of `chain.id`. `""` means none: links
   * render as plain text.
   *
   * Also none, when left out, for a LOCAL DEVNET: `contracts` overridden and
   * every `rpcUrls` entry a loopback address (localhost / 127.0.0.1 / [::1]).
   * The real chain's explorer would show nothing, or somebody else's
   * transaction, for a devnet's hashes. Set it to a devnet explorer's origin if
   * you run one.
   */
  readonly explorer?: string;

  readonly contracts?: ContractOverrides;

  /**
   * IPFS gateways a launch token's own icon is fetched through, in order.
   *
   * A token launched by `LaunchpadKitV2` names a metadata document
   * (`metadataURI()`, `ipfs://<cid>`) whose `image` is the icon the swap box
   * draws for it. Only `ipfs://` documents are fetched, only through these
   * gateways (never a creator-chosen host, which could change after people have
   * bought and would see every visitor's address), and a single-block document
   * is checked against its CID. Leave it out for the SDK's allow-listed
   * gateways (`IPFS_GATEWAYS`: Gully Core's own, then two public ones). Put your
   * own gateway FIRST to serve the icons yourself.
   */
  readonly ipfsGateways?: readonly string[];

  /**
   * The first block every log scan reads from. Leave it out: the default is the
   * block Gully Core's core was deployed on this chain, from the address book. Only a
   * full fork (its own core, deployed later) or a local devnet (a chain whose
   * history starts at block 0) needs to set it, next to `contracts`.
   */
  readonly logsFromBlock?: number;
}

/**
 * Where the front end's revenue comes from.
 *
 * This is a fee on the swap OUTPUT, taken inside the same transaction as the
 * swap by `@gullylabs/core-widgets` — a `TAKE_PORTION` action in the swap plan,
 * not an accounting entry settled later. It either happens atomically or the
 * whole transaction reverts.
 *
 * It stacks on top of, and is entirely separate from, the pool's LP fee and
 * Gully Core's protocol fee. Show all three; see `src/routes/Fees.tsx`.
 */
export interface FeeConfig {
  /** Address the fee is paid to. Required whenever `bps > 0`. */
  readonly wallet: Address | null;
  /**
   * Fee in basis points of the swap output. `@gullylabs/core-widgets` refuses
   * anything above 100 bps (1%), so a value above that is a build-time error
   * rather than a business decision.
   */
  readonly bps: number;
  /**
   * Where in the call path the fee is taken.
   *
   * `take-portion` splits the vault credit before anything leaves the singleton,
   * so the router never custodies the fee. Use it unless you have a reason.
   */
  readonly mode?: "take-portion" | "pay-portion";
}

/**
 * ROUTED FILLS: where the swap box asks for a quote that may be filled on a
 * third-party venue, through Gully Core's `GullyCoreFillRouter`, when that pays the
 * user more than every Gully Core pool. The swap box falls back to Gully Core pools
 * on any routing failure, so a wrong value here degrades, never breaks.
 *
 * `api` is the router API the swap box asks:
 *
 *   * `'gullycore'` — Gully Core's hosted routing API (the default; `GULLYCORE_ROUTING_API`
 *     in `resolve.ts`). Anonymous quotes are rate-limited per address; a key with
 *     the `router:quote` scope lifts that (`apiKey` below, read from an env var).
 *   * an `https://` origin — your OWN deployment of the routing API (it is in
 *     Gully Core's repository, MIT like this template), answering
 *     `/v1/chains/:chainId/sources` and `/quote` for your chain. The API
 *     must name the SAME fill router as the SDK address book, or the swap box
 *     refuses its answers (`FILL_ROUTER_MISMATCH`): the address book is the one
 *     source of truth for where a user's funds go.
 *   * `null` — off. Every swap goes through Gully Core pools only.
 *
 * WHAT IT COSTS, stated plainly. A routed fill pays Gully Core's routing fee —
 * 15 bps of the input on a fill somewhere other than a Gully Core pool, 0 on a
 * Gully Core pool, a governed value inside an immutable cap, read off the fill
 * router — to the protocol. It is not an integrator share: you do not earn it.
 *
 * AND THE RULE THAT DECIDES WHETHER IT RUNS AT ALL: a routed fill has no
 * integrator step, so `@gullylabs/core-widgets` IGNORES the router while your
 * `fee.bps` is above zero rather than silently drop your fee. Routing is
 * therefore only live with `fee.bps: 0`; `resolveConfig` names that as a
 * warning so it is a decision rather than a surprise. (A launch's integrator
 * share is unaffected: it is frozen on chain, not taken by the swap box.)
 */
export interface RoutingConfig {
  readonly api: "gullycore" | string | null;
  /**
   * An API key with the `router:quote` scope, for a per-key rate limit instead
   * of the anonymous one. Read it from the environment
   * (`import.meta.env.VITE_GULLYCORE_ROUTER_KEY`); never commit one. Self-serve at
   * https://gullychain.xyz/core/developers. A `VITE_` value ships in the public bundle:
   * anyone can read it and spend its rate limit (it can only read and quote, and
   * is revocable there).
   */
  readonly apiKey?: string;
  /**
   * The `GullyCoreFillRouter` to accept calldata for, for a FULL FORK only. On
   * shared core leave it out: the SDK address book's `fillRouter` for `chain.id`
   * is used, and a chain whose record carries none is routed through Gully Core
   * pools only. The widget refuses any calldata not addressed to this contract.
   */
  readonly fillRouter?: Address;
}

/** Colours. Every one of these becomes a CSS custom property on `:root`. */
export interface BrandColors {
  /** Primary action colour: buttons, active nav, focus rings. */
  readonly accent: string;
  /** Text drawn on top of `accent`. Pick for contrast, not for taste. */
  readonly onAccent: string;
  readonly background: string;
  readonly surface: string;
  readonly surfaceAlt: string;
  readonly text: string;
  readonly textMuted: string;
  readonly border: string;
  readonly positive: string;
  readonly negative: string;
}

export interface BrandLinks {
  readonly docs?: string;
  readonly x?: string;
  readonly discord?: string;
  readonly github?: string;
  readonly terms?: string;
}

export interface BrandConfig {
  /** Product name. Appears in the header, the title and wallet prompts. */
  readonly name: string;
  /** One line under the name. Keep it true — it sits above live on-chain data. */
  readonly tagline?: string;
  /** Path or URL to a logo. Rendered at 28px tall; SVG recommended. */
  readonly logoUrl?: string;
  /**
   * The native currency's own mark (ETH, HYPE, BNB), drawn by the swap box for
   * the native coin AND its wrapped form (WETH is ETH held in a contract). A
   * root-relative path into `public/` (`/eth.svg`), `https://` or `ipfs://`.
   * Take the mark from the network's own brand kit as it is; never redraw one.
   * Omitted: the swap box draws a monogram of the symbol, which is honest.
   */
  readonly nativeLogoUrl?: string;
  /**
   * Which side the palette is on: sets the document's `color-scheme`, which
   * the browser's form controls and the chart kit's two-sided data colours
   * follow. `dark` when omitted (every Gully Core surface is dark by default).
   */
  readonly colorScheme?: "dark" | "light";
  readonly colors: BrandColors;
  /** CSS font stacks. Anything you self-host or load in `index.html`. */
  readonly fontFamily?: string;
  readonly monoFamily?: string;
  /** Headings and large figures. Defaults to `fontFamily` when unset. */
  readonly headingFamily?: string;
  /** Corner radius for cards and buttons, in px. */
  readonly radius?: number;
  readonly links?: BrandLinks;
}

/**
 * Which surfaces exist.
 *
 * These gate navigation AND routing, so a disabled feature is unreachable
 * rather than merely unlinked. Switching one back on is a one-word edit; no
 * files are deleted by the scaffolder.
 */
export interface FeatureFlags {
  readonly swap: boolean;
  readonly pools: boolean;
  readonly launchpad: boolean;
  /**
   * Team splits (`GullyCoreSplitFactory`): create a split, view one, collect into it
   * and pay its payees; and, in the launch wizard, pay a launch's creator share
   * to a split. Omitted = off (a config written before this flag existed).
   */
  readonly splits?: boolean;
  /**
   * Locks (`GullyCorePositionLock`, `GullyCoreTokenLock`): lock badges on pools and
   * launched tokens, a "Lock liquidity or tokens" page and a locks list.
   * Omitted = off.
   */
  readonly locks?: boolean;
  /**
   * Airdrops (`GullyCoreMultisend`, `GullyCoreDropFactory`): send to a CSV list, create
   * a claimable Merkle drop from a CSV, and a claim page. Omitted = off.
   */
  readonly airdrops?: boolean;
}

/**
 * Tokens offered in the swap picker.
 *
 * There is no on-chain token registry, so this list is the app's own. Symbols
 * and decimals are read back from the token contracts at runtime and a mismatch
 * is surfaced rather than papered over — a token that lies about its symbol in
 * a config file is how a user swaps into the wrong asset.
 */
export interface TokenConfig {
  readonly address: Address;
  readonly symbol: string;
  readonly name: string;
  readonly decimals: number;
  readonly logoUrl?: string;
}

/**
 * Your take on LAUNCHES created through `LaunchpadKitV2`.
 *
 * Distinct from `fee`, which is the swap-output fee the widgets take. A v2
 * launch pays two things to the tenant's integrator wallet (`fee.wallet`):
 *
 *   * `integratorBps` of every launch's trading fee, forever, split next to
 *     the creator's and the protocol's shares: by the Gully Core lockers where the
 *     pool charges the fee (the locked position's LP fees), by the launch guard
 *     where it takes the fee itself, in the pool's quote currency. Capped by an
 *     immutable `maxIntegratorBps()` (2000 = 20%); the protocol's floor (20%)
 *     comes off first and the creator gets the rest.
 *   * `integratorLaunchFeeWei` in native currency, once per launch, on top of
 *     the protocol's launch fee. Capped by the kit's `maxIntegratorLaunchFeeWei()`.
 *
 * With `chain.launchTenant` set, these MUST equal the stored tenant config or
 * every launch reverts `TenantConfigMismatch`; `gullycore:verify` compares them.
 * Without a tenant they are what the wizard sends as a direct launch.
 */
export interface LaunchConfig {
  /** Basis points of every launch's trading fee to `fee.wallet`. `0` takes nothing. */
  readonly integratorBps: number;
  /** Wei of native currency per launch to `fee.wallet`, as a decimal string. `"0"` takes nothing. */
  readonly integratorLaunchFeeWei: string;
  /**
   * The protocol share the wizard proposes by default, in basis points. Must lie
   * within the lockers' `[minProtocolBps, maxProtocolBps]`; the creator can raise
   * it per launch, never lower it below the floor.
   */
  readonly defaultProtocolBps: number;
  /**
   * The opening market cap the launch wizard proposes, in whole US dollars.
   * Gully Core's default is $3,500 (`DEFAULT_OPENING_MARKET_CAP_USD` in the SDK;
   * decision 2026-09-20: every launch opens at a known market cap, and a
   * launchpad built on the kit must not quietly offer a worse default than
   * Gully Core's own). The wizard turns it into an opening price from the chain's
   * native/USD feed, read on chain, and shows the snapped price the pool is
   * actually born at. Where the chain has no USD source the field stays
   * empty and the creator types a cap in the quote currency: a dollar default
   * with no dollar source is a figure nobody read. Omitted: Gully Core's default.
   */
  readonly defaultOpeningMarketCapUsd?: number;
}

/**
 * The token lists the swap picker offers beside `tokens` and the tokens of
 * every pool on the core, in the Uniswap Token Lists standard.
 *
 * Each entry is an `https://` URL, or the literal `"gullycore"` for Gully Core's own
 * list for the configured chain (`gullycoreTokenListUrl(chain.id)` from the SDK,
 * published from a separate public repository). Order is precedence: the first
 * list to name an address wins in the picker, and every later list that also
 * names it is shown as corroboration. A list is fetched and schema-validated by
 * the widget at runtime; one that fails to load is named in the picker rather
 * than silently dropped. Leave the array empty to offer only `tokens` and the
 * pools' own tokens.
 */
export type TokenListsConfig = readonly (string | "gullycore")[];

export interface GullyCoreDexConfig {
  readonly brand: BrandConfig;
  readonly chain: ChainConfigInput;
  readonly fee: FeeConfig;
  readonly launch: LaunchConfig;
  readonly features: FeatureFlags;
  readonly tokens: readonly TokenConfig[];
  /** Optional; `["gullycore"]` when omitted. See {@link TokenListsConfig}. */
  readonly tokenLists?: TokenListsConfig;
  /** Optional; `{ api: 'gullycore' }` when omitted. See {@link RoutingConfig}. */
  readonly routing?: RoutingConfig;
}

/**
 * Identity function that gives `gullycore.config.ts` its types.
 *
 * No validation happens here on purpose: it runs at module scope, and a config
 * error thrown before React mounts produces a blank page with a console
 * message. `resolveConfig` validates instead, and the app renders the failure.
 */
export function defineGullyCoreDex(config: GullyCoreDexConfig): GullyCoreDexConfig {
  return config;
}
