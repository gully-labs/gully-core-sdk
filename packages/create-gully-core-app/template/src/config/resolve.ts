// SPDX-License-Identifier: MIT
/**
 * Validating `gullycore.config.ts` into something the app can run on.
 *
 * Config errors are RETURNED, not thrown. A throw at module scope produces a
 * blank page and a console message, which is the worst possible failure for the
 * one file a tenant is expected to edit. Instead `App` renders the problems,
 * names the field, and says what to do — the same standard the rest of the app
 * holds itself to for on-chain reads.
 */

import { DEFAULT_OPENING_MARKET_CAP_USD, IPFS_GATEWAYS, gullycoreTokenListUrl } from "@gullylabs/core-sdk";
import { getAddress, isAddress, type Address } from "viem";

import config from "../../gullycore.config";
import { GULLYCORE_DEPLOYMENTS, NATIVE_CURRENCY, UNDEPLOYED_CHAIN_IDS, isSupportedChain, undeployedChain } from "./deployments";
import type { CoreDeployment } from "./deployments";
import type { BrandConfig, ChainConfigInput, FeatureFlags, GullyCoreDexConfig, RoutingConfig, SupportedChainId, TokenConfig } from "./types";

/** Every feature flag, resolved: the three optional utility flags default to `false`. */
export type ResolvedFeatures = Required<FeatureFlags>;

/**
 * The Gully Core utilities this app can drive, from the SDK address book for the
 * configured chain (or a `chain.contracts` override). `null` = not deployed on
 * that chain: the feature renders "not deployed on <chain>" and reads nothing.
 */
export interface UtilityAddresses {
  readonly splitFactory: Address | null;
  readonly positionLock: Address | null;
  readonly tokenLock: Address | null;
  readonly multisend: Address | null;
  readonly dropFactory: Address | null;
}

/** Ceiling `@gullylabs/core-widgets` enforces on an integrator fee. Mirrored, not owned. */
export const MAX_FEE_BPS = 100;

/**
 * The router every swap in this app is built against.
 *
 * One address, resolved once, used by the DEX surfaces and by the launchpad's
 * buy path alike — they share a single widget adapter, so there is no second
 * place a router could be chosen and quietly differ.
 */
export interface ResolvedRouter {
  readonly address: Address;
  /**
   * `true` when `gullycore.config.ts` named it: the tenant's own router, not
   * Gully Core's, and not Gully Core's to answer for. Surfaces that describe where a
   * swap goes should say so rather than implying Gully Core's.
   */
  readonly custom: boolean;
}

export const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";

/**
 * Gully Core's hosted routing API, the default `routing.api`. One origin, every
 * chain; the chain-scoped routes hang off `/v1/chains/<chainId>/…` (`/sources`, `/quote`). A
 * tenant's own API replaces this origin and keeps the same routes.
 */
export const GULLYCORE_ROUTING_API = "https://app.gullycore.xyz";

/**
 * What the swap box is handed as its `router` (`RouterEndpointConfig` in
 * `@gullylabs/core-widgets`, restated structurally so this module stays free of
 * React and the widgets). `endpoint` is `undefined` whenever routed fills are
 * off, and `reason` says why in one sentence a screen may render — or `null`
 * when they are on.
 */
export interface ResolvedRouting {
  readonly endpoint: { readonly baseUrl: string; readonly fillRouter: Address; readonly apiKey?: string } | undefined;
  /** The API origin asked, or `null` when routing is off by config. */
  readonly api: string | null;
  /** `true` when `routing.api` names an origin other than Gully Core's. */
  readonly custom: boolean;
  /** `true` when `routing.fillRouter` overrides the address book (a full fork). */
  readonly customFillRouter: boolean;
  readonly reason: string | null;
}

export interface ConfigProblem {
  /** Dotted path into `gullycore.config.ts`, e.g. `fee.wallet`. */
  readonly field: string;
  readonly message: string;
  /** `error` blocks the app. `warning` is rendered but does not block. */
  readonly severity: "error" | "warning";
}

export interface ResolvedConfig {
  readonly brand: BrandConfig;
  readonly features: ResolvedFeatures;
  /**
   * Set when `chain.id` names a chain the SDK lists but Gully Core is not deployed
   * on (HyperEVM today). The app renders one "not deployed on <chain>" page and
   * nothing else; `core`, `contracts` and `nativeCurrency` are then NOT that
   * chain's and must not be read.
   */
  readonly notDeployed: { readonly chainId: number; readonly name: string } | null;
  /** Utility contracts per chain; `null` means not deployed there. */
  readonly utilities: UtilityAddresses;
  readonly core: CoreDeployment;
  readonly nativeCurrency: { name: string; symbol: string; decimals: number };
  /**
   * Merged address book: the deployment, with any `contracts` override applied
   * and `universalRouter` already resolved to {@link ResolvedConfig.router}. A
   * consumer that only wants "the router this app swaps through" can read
   * either; they cannot disagree, which is the point of folding it in here
   * rather than leaving two sources for one address.
   */
  readonly contracts: CoreDeployment;
  /** The router every swap is built against, and whether it is the tenant's own. */
  readonly router: ResolvedRouter;
  readonly registry: Address | null;
  readonly launchpadKit: Address | null;
  /**
   * The `LaunchGuardHook` the launch widget reads. Its duration clock (timestamp
   * or the retired block-numbered build) is resolved by the widget from the SDK
   * address book, else by a `CLOCK_MODE()` probe — never assumed.
   */
  readonly launchGuardHook: Address | null;
  /** `LaunchpadKitV2`, the locked-launch kit. `null` renders the v2 launch surfaces "not configured". */
  readonly launchpadKitV2: Address | null;
  /** The tenant address whose stored config a v2 launch restates. `null` means direct launches. */
  readonly launchTenant: Address | null;
  readonly rpcUrls: readonly string[];
  /**
   * The explorer origin links are built from (no trailing slash), or `null`
   * when there is none: `chain.explorer: ""`, or a local devnet (see
   * `chain.explorer`). Build links only through `explorerTxUrl` /
   * `explorerAddressUrl` in `lib/client.ts`, never from `core.explorer`.
   */
  readonly explorer: string | null;
  readonly fee: {
    readonly wallet: Address;
    readonly bps: number;
    readonly mode: "take-portion" | "pay-portion";
    /** `false` when the app takes nothing. Rendered honestly rather than hidden. */
    readonly active: boolean;
  };
  readonly launch: {
    readonly integratorBps: number;
    readonly integratorLaunchFeeWei: bigint;
    readonly defaultProtocolBps: number;
    /** Whole dollars the launch wizard proposes as the opening market cap. */
    readonly defaultOpeningMarketCapUsd: number;
  };
  readonly tokens: readonly TokenConfig[];
  /** Token-list URLs for the swap picker, in precedence order, `"gullycore"` already resolved to the chain's URL. */
  readonly tokenLists: readonly string[];
  /** Routed fills: the router API the swap box asks, or why it asks none. */
  readonly routing: ResolvedRouting;
  /** The native currency's mark for the swap box, or `null` for a monogram. */
  readonly nativeLogoUrl: string | null;
  /** IPFS gateways a launch token's icon is fetched through, in order. */
  readonly ipfsGateways: readonly string[];
  readonly problems: readonly ConfigProblem[];
}

/**
 * The lockers' deployed integrator ceiling, mirrored so a config above it is a
 * named problem before a wallet ever sees a revert. The chain is the authority:
 * the wizard re-reads `maxIntegratorBps()` and refuses to build past it.
 */
export const MAX_INTEGRATOR_BPS = 2000;
const BPS = 10_000;

function resolveLaunch(
  raw: GullyCoreDexConfig["launch"] | undefined,
  fee: ResolvedConfig["fee"],
  problems: ConfigProblem[],
): ResolvedConfig["launch"] {
  const defaultCap = Number(DEFAULT_OPENING_MARKET_CAP_USD.amount) / 10 ** DEFAULT_OPENING_MARKET_CAP_USD.decimals;
  const fallback = { integratorBps: 0, integratorLaunchFeeWei: 0n, defaultProtocolBps: 0, defaultOpeningMarketCapUsd: defaultCap };
  if (raw === undefined) {
    problems.push({
      field: "launch",
      severity: "error",
      message: "the `launch` block is missing; copy it from the template's gullycore.config.ts (zeros take nothing).",
    });
    return fallback;
  }
  let ok = true;
  const bps = raw.integratorBps;
  if (!Number.isInteger(bps) || bps < 0 || bps > MAX_INTEGRATOR_BPS) {
    problems.push({
      field: "launch.integratorBps",
      severity: "error",
      message: `must be a whole number of basis points in 0..${MAX_INTEGRATOR_BPS} (the lockers' cap), received ${String(bps)}`,
    });
    ok = false;
  }
  let feeWei = 0n;
  if (typeof raw.integratorLaunchFeeWei !== "string" || !/^\d+$/.test(raw.integratorLaunchFeeWei)) {
    problems.push({
      field: "launch.integratorLaunchFeeWei",
      severity: "error",
      message: `must be a decimal string of wei such as "0" or "1000000000000000", received ${JSON.stringify(raw.integratorLaunchFeeWei)}`,
    });
    ok = false;
  } else {
    feeWei = BigInt(raw.integratorLaunchFeeWei);
  }
  const protocolBps = raw.defaultProtocolBps;
  if (!Number.isInteger(protocolBps) || protocolBps < 0 || protocolBps + (ok ? bps : 0) >= BPS) {
    problems.push({
      field: "launch.defaultProtocolBps",
      severity: "error",
      message: `must be a whole number of basis points leaving the creator a share, received ${String(protocolBps)}`,
    });
    ok = false;
  }
  if (ok && (bps > 0 || feeWei > 0n) && fee.wallet === ZERO_ADDRESS) {
    problems.push({
      field: "fee.wallet",
      severity: "error",
      message:
        "launch.integratorBps or launch.integratorLaunchFeeWei is non-zero but fee.wallet is not set. " +
        "A launch share paid to the zero address is forfeited, so the app refuses to run.",
    });
    ok = false;
  }
  let capUsd = defaultCap;
  const rawCap = raw.defaultOpeningMarketCapUsd;
  if (rawCap !== undefined) {
    /* Whole dollars, positive: the wizard turns it into cents for the SDK's exact arithmetic, and
       a fractional default would be a figure no creator typed. */
    if (typeof rawCap !== "number" || !Number.isSafeInteger(rawCap) || rawCap <= 0) {
      problems.push({
        field: "launch.defaultOpeningMarketCapUsd",
        severity: "error",
        message: `must be a whole, positive number of US dollars (Gully Core's default is ${defaultCap}), received ${JSON.stringify(rawCap)}`,
      });
      ok = false;
    } else {
      capUsd = rawCap;
    }
  }
  if (!ok) return fallback;
  return { integratorBps: bps, integratorLaunchFeeWei: feeWei, defaultProtocolBps: protocolBps, defaultOpeningMarketCapUsd: capUsd };
}

function checkAddress(
  value: unknown,
  field: string,
  problems: ConfigProblem[],
): Address | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !isAddress(value)) {
    problems.push({
      field,
      severity: "error",
      message: `not a valid address: ${JSON.stringify(value)}`,
    });
    return null;
  }
  return getAddress(value);
}

function resolveFee(
  raw: GullyCoreDexConfig["fee"],
  problems: ConfigProblem[],
): ResolvedConfig["fee"] {
  const mode = raw.mode ?? "take-portion";
  const bps = raw.bps;

  if (!Number.isInteger(bps) || bps < 0) {
    problems.push({
      field: "fee.bps",
      severity: "error",
      message: `must be a whole, non-negative number of basis points, received ${String(bps)}`,
    });
    return { wallet: ZERO_ADDRESS, bps: 0, mode, active: false };
  }
  if (bps > MAX_FEE_BPS) {
    problems.push({
      field: "fee.bps",
      severity: "error",
      message:
        `${bps} bps exceeds the ${MAX_FEE_BPS} bps (1%) ceiling @gullylabs/core-widgets enforces. ` +
        "That ceiling exists so an embedder cannot quietly take a third of a user's output.",
    });
    return { wallet: ZERO_ADDRESS, bps: 0, mode, active: false };
  }

  const wallet = checkAddress(raw.wallet, "fee.wallet", problems);

  if (bps > 0 && (wallet === null || wallet === ZERO_ADDRESS)) {
    problems.push({
      field: "fee.wallet",
      severity: "error",
      message:
        `fee.bps is ${bps} but fee.wallet is ${wallet === null ? "not set" : "the zero address"}. ` +
        "The fee would be forfeited, so the app refuses to run rather than silently earn nothing.",
    });
    return { wallet: ZERO_ADDRESS, bps: 0, mode, active: false };
  }

  if (bps === 0) {
    problems.push({
      field: "fee.bps",
      severity: "warning",
      message:
        "fee.bps is 0, so this front end earns nothing. That is a valid launch position — " +
        "set it above 0 when you are ready to charge.",
    });
    return { wallet: wallet ?? ZERO_ADDRESS, bps: 0, mode, active: false };
  }

  return { wallet: wallet ?? ZERO_ADDRESS, bps, mode, active: true };
}

function resolveTokens(
  raw: readonly TokenConfig[],
  problems: ConfigProblem[],
): readonly TokenConfig[] {
  const seen = new Set<string>();
  const out: TokenConfig[] = [];

  raw.forEach((token, index) => {
    const address = checkAddress(token.address, `tokens[${index}].address`, problems);
    if (address === null) return;
    const key = address.toLowerCase();
    if (seen.has(key)) {
      problems.push({
        field: `tokens[${index}]`,
        severity: "warning",
        message: `${address} is listed twice; the duplicate is ignored`,
      });
      return;
    }
    if (!Number.isInteger(token.decimals) || token.decimals < 0 || token.decimals > 36) {
      problems.push({
        field: `tokens[${index}].decimals`,
        severity: "error",
        message: `decimals must be an integer in 0..36, received ${String(token.decimals)}`,
      });
      return;
    }
    seen.add(key);
    out.push({ ...token, address });
  });

  return out;
}

/** The most token lists a config may name; each is a fetch the picker waits on. */
export const MAX_TOKEN_LISTS = 5;

function resolveTokenLists(
  raw: GullyCoreDexConfig["tokenLists"],
  chainId: number,
  problems: ConfigProblem[],
): readonly string[] {
  const entries = raw ?? ["gullycore"];
  const out: string[] = [];
  entries.forEach((entry, index) => {
    const url = entry === "gullycore" ? gullycoreTokenListUrl(chainId) : entry;
    if (typeof url !== "string" || !/^https:\/\/[^\s]+$/.test(url)) {
      problems.push({
        field: `tokenLists[${index}]`,
        severity: "error",
        message: `must be an https:// URL or "gullycore", received ${String(entry)}`,
      });
      return;
    }
    if (out.includes(url)) {
      problems.push({
        field: `tokenLists[${index}]`,
        severity: "warning",
        message: `${url} is listed twice; the duplicate is ignored`,
      });
      return;
    }
    out.push(url);
  });
  if (out.length > MAX_TOKEN_LISTS) {
    problems.push({ field: "tokenLists", severity: "error", message: `${out.length} lists; at most ${MAX_TOKEN_LISTS}` });
  }
  return out;
}

const UTILITY_FEATURES = ["splits", "locks", "airdrops"] as const;

/**
 * The flags, with the utility flags a config written before they existed does
 * not carry defaulted to OFF (and named, so the tenant knows they exist).
 */
export function resolveFeatures(raw: FeatureFlags, problems: ConfigProblem[]): ResolvedFeatures {
  for (const key of UTILITY_FEATURES) {
    const value: unknown = raw[key];
    if (value === undefined) {
      problems.push({
        field: `features.${key}`,
        severity: "warning",
        message: `not set, so it is off. Add \`${key}: true\` to features in gullycore.config.ts to turn it on (see the template's gullycore.config.ts).`,
      });
    } else if (typeof value !== "boolean") {
      problems.push({ field: `features.${key}`, severity: "error", message: `must be true or false, received ${JSON.stringify(value)}` });
    }
  }
  return {
    swap: raw.swap,
    pools: raw.pools,
    launchpad: raw.launchpad,
    splits: raw.splits === true,
    locks: raw.locks === true,
    airdrops: raw.airdrops === true,
  };
}

/**
 * Warn, never block, when a utility feature is on and its contract is not
 * deployed on the chain: the page renders "not deployed on <chain>", which is
 * true, and the tenant should know before a user does.
 */
export function utilityWarnings(
  features: ResolvedFeatures,
  utilities: UtilityAddresses,
  chainName: string,
  problems: ConfigProblem[],
): void {
  const missing = (feature: string, names: string): void => {
    problems.push({
      field: `features.${feature}`,
      severity: "warning",
      message:
        `on, but the SDK address book records no ${names} on ${chainName}, so that page says ` +
        "\"not deployed\" until Gully Core deploys it there (then bump @gullylabs/core-sdk).",
    });
  };
  if (features.splits && utilities.splitFactory === null) missing("splits", "GullyCoreSplitFactory");
  if (features.locks && utilities.positionLock === null && utilities.tokenLock === null) {
    missing("locks", "GullyCorePositionLock or GullyCoreTokenLock");
  }
  if (features.airdrops && utilities.multisend === null && utilities.dropFactory === null) {
    missing("airdrops", "GullyCoreMultisend or GullyCoreDropFactory");
  }
}

export function resolveLogsFromBlock(raw: unknown, problems: ConfigProblem[]): bigint | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0) {
    problems.push({
      field: "chain.logsFromBlock",
      severity: "error",
      message: `must be a whole, non-negative block number, received ${JSON.stringify(raw)}`,
    });
    return null;
  }
  return BigInt(raw);
}

/** True for a URL whose host is this machine: a local devnet, never a public chain's node. */
function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "localhost" || host === "[::1]" || host === "::1" || /^127(\.\d{1,3}){3}$/.test(host);
  } catch {
    return false;
  }
}

/**
 * The explorer links point at, or `null` for none. An explicit `chain.explorer`
 * wins (`""` = none); otherwise the book's explorer, except on a local devnet
 * (own `contracts` over loopback-only `rpcUrls`), whose hashes the real chain's
 * explorer has never seen.
 */
export function resolveExplorer(
  chain: { readonly explorer?: string; readonly rpcUrls?: readonly string[]; readonly contracts?: object },
  bookExplorer: string,
): string | null {
  const strip = (s: string): string | null => {
    const t = s.trim().replace(/\/+$/, "");
    return t === "" ? null : t;
  };
  if (chain.explorer !== undefined) return strip(chain.explorer);
  const rpcs = chain.rpcUrls ?? [];
  const overridden = chain.contracts !== undefined && Object.values(chain.contracts).some((v) => v !== undefined);
  if (overridden && rpcs.length > 0 && rpcs.every(isLoopbackUrl)) return null;
  return strip(bookExplorer);
}

/**
 * Which router this app swaps through: Gully Core's by default, the tenant's own
 * when `chain.router` names one.
 *
 * THE DEFAULT IS THE WHOLE FEATURE. A tenant who sets nothing gets Gully Core's
 * deployed, verified router for `chain.id` and follows a Gully Core redeploy by
 * bumping the SDK. A tenant who wants their own sets ONE field and keeps
 * everything else — Vault, managers, kit, lockers, registry, utilities — shared.
 *
 * This refuses early and by name, the same way `resolveFee` refuses a fee share
 * with nowhere to pay it, because every failure here is silent at run time:
 *
 *   * The ZERO address. `@gullylabs/core-widgets` throws on it, but only once a
 *     user has picked a pair and pressed swap — a build-time value should not
 *     wait for that.
 *   * A core address pasted by mistake (the Vault, a pool manager, Permit2, a
 *     position manager). Router calldata sent to one of those does not fail in
 *     a way that names the mistake.
 *   * `chain.router` AND `chain.contracts.universalRouter` set to different
 *     addresses. One of them would have to lose, and a swap going to the
 *     address you did not mean is not a thing to settle by precedence rules
 *     nobody reads. Say so and stop.
 *
 * WHAT IT CANNOT CHECK. Nothing here touches the network — `resolveConfig`
 * runs at module scope before React mounts, and a config file is not the place
 * to discover the chain is down. So an address with NO CODE passes this
 * function. That matters, and `npm run gullycore:verify` is where it is caught: a
 * swap encoded to a codeless address is a plain call that succeeds doing
 * nothing, and a native-currency swap hands it the user's `msg.value`. Verify
 * before you point users at a router, not after.
 */
export function resolveRouter(
  chain: Pick<ChainConfigInput, "router" | "contracts">,
  contracts: CoreDeployment,
  bookRouter: Address,
  problems: ConfigProblem[],
): ResolvedRouter {
  /* Checksummed on both sides of every comparison below. An address book entry
     and a hand-typed config line can spell the same address in two casings, and
     `0xAbC… !== 0xabc…` would read as "a different router" — a false error on
     the one path a tenant cannot debug from the page it breaks. */
  const book = getAddress(bookRouter);
  const merged = getAddress(contracts.universalRouter);

  /* `contracts.universalRouter` is post-merge: the book's, unless a full fork
     overrode it. Either is the answer when `chain.router` is absent. */
  const fallback: ResolvedRouter = { address: merged, custom: merged !== book };
  const raw = chain.router;
  if (raw === undefined || raw === null) {
    /* A fork that overrode the router with the zero address gets here: it is a
       well-formed address, so the `contracts` merge accepted it, and no swap
       can use it. The widgets say so too — when somebody presses swap. */
    if (merged === ZERO_ADDRESS) {
      problems.push({
        field: "chain.contracts.universalRouter",
        severity: "error",
        message: "the zero address. Remove the override to use Gully Core's router, or give your own router's address.",
      });
    }
    return fallback;
  }

  const address = checkAddress(raw, "chain.router", problems);
  if (address === null) return fallback;

  if (address === ZERO_ADDRESS) {
    problems.push({
      field: "chain.router",
      severity: "error",
      message:
        "the zero address. Leave chain.router null to use Gully Core's router for this chain, or give " +
        "your own router's address — a swap encoded to address(0) is not a swap.",
    });
    return fallback;
  }

  const lookalikes: readonly (readonly [string, Address])[] = [
    ["the Vault", contracts.vault],
    ["the CL pool manager", contracts.clPoolManager],
    ["the Bin pool manager", contracts.binPoolManager],
    ["Permit2", contracts.permit2],
    ["the CL position manager", contracts.clPositionManager],
    ["the Bin position manager", contracts.binPositionManager],
  ];
  const clash = lookalikes.find(([, candidate]) => getAddress(candidate) === address);
  if (clash !== undefined) {
    problems.push({
      field: "chain.router",
      severity: "error",
      message:
        `${address} is ${clash[0]}, not a router. The widgets would encode ` +
        "`execute(bytes,bytes[],uint256)` against it, which is not a call that contract answers.",
    });
    return fallback;
  }

  /* Re-checked here, and NOT with `checkAddress`, for two reasons that both matter.
     `getAddress` THROWS on a malformed string, and `resolveConfig` runs at module scope — so a
     typo in this field would white-screen the app instead of showing the named config problem the
     merge above already recorded for it. And `checkAddress` would record that problem a second
     time, so the tenant would read the same typo reported twice under two different field names.
     A malformed value is therefore treated as absent: the merge skipped it, so there is no second
     router to conflict with. */
  const forkOverrideRaw = chain.contracts?.universalRouter;
  const forkOverride =
    typeof forkOverrideRaw === "string" && isAddress(forkOverrideRaw) ? getAddress(forkOverrideRaw) : undefined;
  if (forkOverride !== undefined && forkOverride !== address) {
    problems.push({
      field: "chain.router",
      severity: "error",
      message:
        `chain.router is ${address} but chain.contracts.universalRouter is ${forkOverride}. ` +
        "Two different routers are configured and only one can be used; the app refuses to pick. " +
        "On Gully Core's shared core keep chain.router and delete the override; on a full fork keep the override.",
    });
    return fallback;
  }
  if (forkOverride !== undefined) {
    problems.push({
      field: "chain.router",
      severity: "warning",
      message:
        "chain.router and chain.contracts.universalRouter name the same address; the override is " +
        "redundant. Keep chain.router — it is the documented option and it says what you meant.",
    });
  }

  if (address === book) {
    problems.push({
      field: "chain.router",
      severity: "warning",
      message:
        `${address} is Gully Core's own router for this chain, which is already the default. Setting it ` +
        "here pins the app to today's address: if Gully Core redeploys the router, a null here follows " +
        "the SDK address book and this does not. Leave it null unless the address is yours.",
    });
  }

  return { address, custom: address !== book };
}

/**
 * Routed fills: which router API the swap box asks, or why it asks none.
 *
 * Gully Core's hosted API by default, a tenant's own origin when `routing.api`
 * names one, nothing when it is `null`. Every refusal here is a stated reason
 * rather than a silent fallback, because the widget's own fallback IS silent:
 * a wrong endpoint quietly means "Gully Core pools only", which is safe and
 * invisible. The reasons, in the order they are checked:
 *
 *   * `routing.api: null` — off by choice.
 *   * a malformed origin — an error, named.
 *   * `fee.bps > 0` — the widget ignores the router while an integrator fee is
 *     active (a routed fill has no integrator step and would silently drop
 *     the fee). Routing and a swap fee are a choice between two revenue
 *     models, and the config must make one.
 *   * a chain that is not a mainnet, or whose address book records no
 *     `GullyCoreFillRouter` and no `routing.fillRouter` override — nothing to
 *     accept calldata for.
 *
 * NOT CHECKED HERE: whether the API serves this chain. The widget asks
 * `/sources` itself and `npm run gullycore:verify` reports the answer.
 */
export function resolveRouting(
  raw: RoutingConfig | undefined,
  chain: { readonly isMainnet: boolean; readonly fillRouter: Address | null },
  fee: { readonly bps: number },
  problems: ConfigProblem[],
): ResolvedRouting {
  const api = raw === undefined ? "gullycore" : raw.api;
  const off = (reason: string, origin: string | null, custom: boolean, customFillRouter: boolean): ResolvedRouting => ({
    endpoint: undefined,
    api: origin,
    custom,
    customFillRouter,
    reason,
  });
  if (api === null) return off("Routed fills are off: routing.api is null in gullycore.config.ts.", null, false, false);
  const origin = api === "gullycore" ? GULLYCORE_ROUTING_API : typeof api === "string" ? api.trim().replace(/\/+$/, "") : "";
  const custom = origin !== GULLYCORE_ROUTING_API;
  if (!/^https:\/\/[^/\s]+$/.test(origin)) {
    problems.push({
      field: "routing.api",
      severity: "error",
      message: `must be 'gullycore', an https:// origin with no path (https://router.example.com), or null; received ${JSON.stringify(api)}`,
    });
    return off("Routed fills are off: routing.api is not a valid origin.", null, custom, false);
  }
  const overrideRaw = raw?.fillRouter;
  const override = overrideRaw === undefined ? null : checkAddress(overrideRaw, "routing.fillRouter", problems);
  if (override === ZERO_ADDRESS) {
    problems.push({ field: "routing.fillRouter", severity: "error", message: "the zero address. Leave it out to use the address book's fill router." });
    return off("Routed fills are off: routing.fillRouter is the zero address.", origin, custom, true);
  }
  const fillRouter = override ?? chain.fillRouter;
  const customFillRouter = override !== null && (chain.fillRouter === null || getAddress(chain.fillRouter) !== override);
  if (fee.bps > 0) {
    problems.push({
      field: "routing",
      severity: "warning",
      message:
        `fee.bps is ${fee.bps}, so routed fills are off: the swap box ignores the router while an integrator fee is active ` +
        "(a routed fill has no integrator step and would silently drop your fee). Set fee.bps to 0 to route trades " +
        "to third-party venues, or routing.api to null to say so on purpose.",
    });
    return off("Routed fills are off while this app takes a swap fee: a routed fill cannot carry it.", origin, custom, customFillRouter);
  }
  if (!chain.isMainnet) return off("Routed fills are off on a test network.", origin, custom, customFillRouter);
  if (fillRouter === null) {
    return off("Routed fills are off: the SDK address book records no GullyCoreFillRouter on this chain.", origin, custom, customFillRouter);
  }
  const apiKey = raw?.apiKey?.trim();
  return {
    endpoint: { baseUrl: `${origin}/v1/chains`, fillRouter: getAddress(fillRouter), ...(apiKey === undefined || apiKey === "" ? {} : { apiKey }) },
    api: origin,
    custom,
    customFillRouter,
    reason: null,
  };
}

/** `brand.nativeLogoUrl`, checked to be a root-relative path, `https://` or `ipfs://` (what the widget loads). */
export function resolveNativeLogo(raw: string | undefined, problems: ConfigProblem[]): string | null {
  if (raw === undefined) return null;
  const v = raw.trim();
  if (v === "") return null;
  if (/^(\/(?!\/)|https:\/\/|ipfs:\/\/)/.test(v)) return v;
  problems.push({
    field: "brand.nativeLogoUrl",
    severity: "error",
    message: `must be a root-relative path (/eth.svg), an https:// URL or an ipfs:// URI, received ${JSON.stringify(raw)}`,
  });
  return null;
}

/** `chain.ipfsGateways`, each an `https://…/` prefix a CID is appended to; the SDK's allow-list when omitted. */
export function resolveIpfsGateways(raw: readonly string[] | undefined, problems: ConfigProblem[]): readonly string[] {
  if (raw === undefined) return IPFS_GATEWAYS;
  const out: string[] = [];
  raw.forEach((entry, index) => {
    if (typeof entry !== "string" || !/^https:\/\/[^\s]+\/$/.test(entry)) {
      problems.push({
        field: `chain.ipfsGateways[${index}]`,
        severity: "error",
        message: `must be an https:// gateway prefix ending in "/" (https://ipfs.example.com/ipfs/), received ${JSON.stringify(entry)}`,
      });
      return;
    }
    if (!out.includes(entry)) out.push(entry);
  });
  if (out.length === 0) {
    problems.push({ field: "chain.ipfsGateways", severity: "error", message: "names no usable gateway; leave it out for the SDK's allow-list." });
    return IPFS_GATEWAYS;
  }
  return out;
}

/** Applies a full fork's `chain.contracts` overrides onto `core`, each address checked first. */
function mergeOverrides(
  core: CoreDeployment | null,
  overrides: ChainConfigInput["contracts"],
  problems: ConfigProblem[],
): CoreDeployment {
  const merged: Record<string, unknown> = { ...(core ?? {}) };
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (value === undefined) continue;
    const checked = checkAddress(value, `chain.contracts.${key}`, problems);
    if (checked === null) continue;
    merged[key] = checked;
  }
  return merged as unknown as CoreDeployment;
}

/**
 * A value that must not be read: every property access throws, naming the field.
 * Used for the chain-specific parts of a config whose chain has no Gully Core
 * deployment, instead of a zero address or another chain's record.
 */
function unreadable<T extends object>(what: string): T {
  return new Proxy({} as T, {
    get(_target, prop) {
      /* Inspection (vitest/console printing, promise sniffing) is not a read. */
      if (typeof prop === "symbol" || prop === "then" || prop === "toJSON" || prop === "constructor") return undefined;
      throw new Error(
        `cfg.${what}.${prop} was read, but Gully Core is not deployed on the configured chain. ` +
          "Check cfg.notDeployed (and the chain.id problem) before reading chain-specific fields.",
      );
    },
  });
}

let cached: ResolvedConfig | null = null;

/** Validates the tenant config once and caches the result. */
export function resolveConfig(input: GullyCoreDexConfig = config): ResolvedConfig {
  if (cached !== null && input === config) return cached;

  const problems: ConfigProblem[] = [];

  const notDeployed = undeployedChain(input.chain.id);
  if (!isSupportedChain(input.chain.id) && notDeployed === null) {
    const supported = (Object.values(GULLYCORE_DEPLOYMENTS) as CoreDeployment[])
      .map((d) => `${d.chainId} (${d.name})`)
      .join(", ");
    const announced = UNDEPLOYED_CHAIN_IDS.map((id) => `${id} (${undeployedChain(id)?.name ?? "?"})`).join(", ");
    problems.push({
      field: "chain.id",
      severity: "error",
      message:
        `Gully Core's shared core is not deployed on chain ${String(input.chain.id)}. ` +
        (supported.length > 0 ? `Deployed on: ${supported}.` : "It is not deployed on any chain yet.") +
        (announced.length > 0 ? ` Coming soon (the app says so): ${announced}.` : "") +
        " A full fork can target any EIP-1153 chain, but then you must also supply " +
        "chain.contracts — see the README.",
    });
  }

  /* On an undeployed or unsupported chain there is no book to read. Nothing is
     borrowed from another chain's record to fill the shape (this used to read the
     literal 4663, then `SUPPORTED_CHAIN_IDS[0]` — both meant "the not-deployed page
     is backed by some other chain's addresses", and with an empty book there is no
     first entry at all). Instead `core`, `contracts`, `router` and `nativeCurrency`
     are guards that THROW when read: `App` renders the not-deployed page (or the
     blocking chain.id problem) before anything reads them, and a code path that
     does read one fails loudly rather than calling an address that is not there.
     The utilities are all `null`, which is the honest "not deployed" value. */
  const deployed = isSupportedChain(input.chain.id);
  const logsFromBlock = resolveLogsFromBlock(input.chain.logsFromBlock, problems);
  let core: CoreDeployment;
  let contracts: CoreDeployment;
  let router: ResolvedRouter;
  let nativeCurrency: ResolvedConfig["nativeCurrency"];
  let explorer: string | null;
  if (deployed) {
    const chainId: SupportedChainId = input.chain.id as SupportedChainId;
    const book: CoreDeployment = GULLYCORE_DEPLOYMENTS[chainId];
    core = logsFromBlock === null ? book : { ...book, deployedAtBlock: logsFromBlock };

    /* Overrides exist for a full fork, which points the app at its own core. Each
       one is validated before it lands, so a typo becomes a named config problem
       rather than a read against an address with no code. */
    const overridden = mergeOverrides(core, input.chain.contracts, problems);

    /* The router is resolved AFTER the fork override and folded back into the
       merged book, so every consumer — `App.tsx` building the widgets' ChainConfig,
       anything reading `cfg.contracts.universalRouter` later — gets the tenant's
       router without knowing this option exists. One address, one source; a second
       place to choose a router is a place for the two to disagree. */
    router = resolveRouter(input.chain, overridden, book.universalRouter, problems);
    contracts =
      router.address === overridden.universalRouter
        ? overridden
        : { ...overridden, universalRouter: router.address };
    nativeCurrency = NATIVE_CURRENCY[chainId];
    explorer = resolveExplorer(input.chain, core.explorer);
  } else {
    /* Still validated, so a typo is named even before the chain is deployed. */
    mergeOverrides(null, input.chain.contracts, problems);
    core = unreadable<CoreDeployment>("core");
    contracts = unreadable<CoreDeployment>("contracts");
    router = unreadable<ResolvedRouter>("router");
    nativeCurrency = unreadable<ResolvedConfig["nativeCurrency"]>("nativeCurrency");
    explorer = null;
  }

  const utilities: UtilityAddresses = deployed
    ? {
        splitFactory: contracts.splitFactory,
        positionLock: contracts.positionLock,
        tokenLock: contracts.tokenLock,
        multisend: contracts.multisend,
        dropFactory: contracts.dropFactory,
      }
    : { splitFactory: null, positionLock: null, tokenLock: null, multisend: null, dropFactory: null };

  const registry = checkAddress(input.chain.registry, "chain.registry", problems);
  const launchpadKit = checkAddress(input.chain.launchpadKit, "chain.launchpadKit", problems);
  const launchGuardHook = checkAddress(input.chain.launchGuardHook, "chain.launchGuardHook", problems);
  const launchpadKitV2 = checkAddress(input.chain.launchpadKitV2, "chain.launchpadKitV2", problems);
  const launchTenant = checkAddress(input.chain.launchTenant, "chain.launchTenant", problems);

  if (input.features.launchpad && launchpadKit === null && launchpadKitV2 === null) {
    problems.push({
      field: "chain.launchpadKitV2",
      severity: "warning",
      message:
        "features.launchpad is on but neither a LaunchpadKitV2 nor a LaunchpadKit address is " +
        "configured, so the launch surfaces will render 'not configured'. Run `npm run gullycore:verify` " +
        "to fill one in, or set features.launchpad to false.",
    });
  }
  if (launchTenant !== null && launchpadKitV2 === null) {
    problems.push({
      field: "chain.launchTenant",
      severity: "warning",
      message: "a tenant is set but no LaunchpadKitV2 is; the tenant config lives on the kit and is unused without one.",
    });
  }

  const brandName = input.brand.name.trim();
  if (brandName.length === 0) {
    problems.push({ field: "brand.name", severity: "error", message: "must not be empty" });
  }

  const enabled = Object.values(input.features).filter(Boolean).length;
  if (enabled === 0) {
    problems.push({
      field: "features",
      severity: "error",
      message: "every feature is off, so the app has nothing to render",
    });
  }

  const features = resolveFeatures(input.features, problems);
  if (deployed) utilityWarnings(features, utilities, core.name, problems);

  const fee = resolveFee(input.fee, problems);
  const routing: ResolvedRouting = deployed
    ? resolveRouting(input.routing, { isMainnet: core.isMainnet, fillRouter: contracts.fillRouter ?? null }, fee, problems)
    : { endpoint: undefined, api: null, custom: false, customFillRouter: false, reason: "Gully Core is not deployed on the configured chain." };
  const resolved: ResolvedConfig = {
    brand: input.brand,
    features,
    notDeployed,
    utilities,
    core,
    contracts,
    router,
    nativeCurrency,
    registry,
    launchpadKit,
    launchGuardHook,
    launchpadKitV2,
    launchTenant,
    rpcUrls: input.chain.rpcUrls ?? [],
    explorer,
    fee,
    launch: resolveLaunch(input.launch, fee, problems),
    tokens: resolveTokens(input.tokens, problems),
    tokenLists: resolveTokenLists(input.tokenLists, input.chain.id, problems),
    routing,
    nativeLogoUrl: resolveNativeLogo(input.brand.nativeLogoUrl, problems),
    ipfsGateways: resolveIpfsGateways(input.chain.ipfsGateways, problems),
    problems,
  };

  if (input === config) cached = resolved;
  return resolved;
}

export function hasBlockingProblem(resolved: ResolvedConfig): boolean {
  return resolved.problems.some((p) => p.severity === "error");
}
