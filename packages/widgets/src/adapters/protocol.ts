// SPDX-License-Identifier: MIT
/**
 * The chain boundary.
 *
 * Every read and every write the widgets perform goes through
 * {@link ProtocolAdapter}. No component, hook or controller in this package
 * imports a viem client directly, which is what makes an implementation
 * swappable without touching a line of UI.
 *
 * One implementation ships: {@link ../adapters/viem.js | ViemProtocolAdapter},
 * real reads and writes through a viem transport. The package ships no mock
 * adapter (source of truth only); the unit suites keep a test-only one under
 * test/helpers/. A host can implement this interface itself, for example on
 * top of wagmi or its own backend quoter - and if such an adapter serves
 * anything not read from a chain, `isMock` must be `true` so the widgets say so.
 */

import type { Address, Hex } from "viem";
import type { PoolKey, PoolId } from "@gullylabs/core-sdk";
import type { LaunchGuard } from "../callpath/launch.js";
import type { ChainConfig } from "../config/chain.js";
import type { ResolvedIntegratorConfig } from "../config/integrator.js";
import type { TokenSaleAdapter } from "./sale.js";
import type { SignedPermit } from "../callpath/permit2.js";

/** Which flavour of pool a key addresses. */
export type PoolType = "CL" | "BIN";

/** Where a piece of data came from. Rendered by the UI; never cosmetic. */
export type DataSource = "live" | "mock";

/** ERC-20 (or native) token metadata. */
export interface TokenInfo {
  readonly address: Address;
  readonly symbol: string;
  readonly name: string;
  readonly decimals: number;
  /** `https://` or `ipfs://` (resolved through the SDK's allow-listed gateways). Anything else renders as a monogram. */
  readonly logoUrl?: string;
  /** True for the chain's native asset (the zero address). */
  readonly isNative?: boolean;
  /**
   * Provenance, once token lists are in play (`SwapWidget`'s `tokenLists` prop).
   * `name` is the list the entry's fields came from, or `null` for a token the
   * adapter itself offers (the pools this site routes through); `alsoIn` is
   * every other list that names the same address. Absent when no list was given.
   */
  readonly listSource?: { readonly name: string | null; readonly alsoIn: readonly string[] };
  /** A tokenised stock, from a list's `extensions.stock`. The picker badges it; `rebasing` is a warning. */
  readonly stock?: { readonly issuer: string; readonly ticker: string; readonly rebasing: boolean };
  /** The list's tag ids for this token (`native`, `stock`, `test`, `launch`, ...). */
  readonly tags?: readonly string[];
  /**
   * One short line shown beside the name where the name alone would mislead (a list's `extensions.note`,
   * the address book's `note`): a pegged token that carries the original issuer's name, for one.
   */
  readonly note?: string;
}

/** A pool the widgets can route through or provide liquidity to. */
export interface PoolInfo {
  readonly id: PoolId;
  readonly key: PoolKey;
  readonly poolType: PoolType;
  readonly token0: TokenInfo;
  readonly token1: TokenInfo;
  /** Static LP fee in pips, or the dynamic-fee marker. */
  readonly lpFeePips: number;
  /** Concentrated-liquidity pools only. */
  readonly tickSpacing?: number;
  /** Liquidity-book pools only. */
  readonly binStep?: number;
  /** Hook contract, or the zero address. */
  readonly hooks: Address;
}

/** Live-ish pool state needed to render ranges and prices. */
export interface PoolState {
  readonly poolId: PoolId;
  readonly poolType: PoolType;
  /** Concentrated liquidity: current tick and price. */
  readonly currentTick?: number;
  readonly sqrtPriceX96?: bigint;
  readonly liquidity?: bigint;
  /** Liquidity book: currently active bin. */
  readonly activeId?: number;
  readonly source: DataSource;
}

/** One hop of a route. */
export interface RouteStep {
  readonly poolId: PoolId;
  readonly poolType: PoolType;
  readonly tokenIn: TokenInfo;
  readonly tokenOut: TokenInfo;
  readonly lpFeePips: number;
  readonly hooks: Address;
}

/** A swap quote request. Only exact-input is supported by the swap widget UI. */
export interface SwapQuoteRequest {
  readonly tokenIn: TokenInfo;
  readonly tokenOut: TokenInfo;
  readonly amountIn: bigint;
  /**
   * Restrict the quote to ONE pool. A launch widget sets this: a token with
   * both a CL and a Bin leg has two direct pools, and the schedule, the gate
   * and the buy must all refer to the same one.
   */
  readonly poolId?: PoolId;
}

/**
 * A swap quote.
 *
 * `grossAmountOut` is the pool's output **before** any integrator fee. The fee
 * split is computed by {@link ../core/math.js | buildQuoteBreakdown}, never by
 * the adapter, so that no adapter can under-report what an embedder earns.
 */
export interface SwapQuoteResult {
  readonly route: readonly RouteStep[];
  readonly amountIn: bigint;
  readonly grossAmountOut: bigint;
  /** Output at the current price with no impact, if computable. */
  readonly spotAmountOut: bigint | null;
  /**
   * LP fee paid to the pool's liquidity providers, expressed in the input
   * currency. Through a launch that takes the fee itself this is the POOL's part
   * only (`launch.feeParts.poolPips`): the part of a buy's fee the launch leaves
   * to the pool, zero on a sell, and zero when the division could not be read
   * (`launch.feeParts === null`), where zero means "not known", not "none".
   */
  readonly lpFeeAmount: bigint;
  /** The trading fee's rate in pips: the pool's fee, or the WHOLE trading fee through a launch that takes the fee itself. */
  readonly lpFeePips: number;
  /**
   * `true` when the pool's fee is set per swap by its hook and the adapter
   * could not read the rate in force (it can for a launch guard). `lpFeePips`
   * is then `0` and must be rendered as "dynamic", never as "0%".
   */
  readonly lpFeeUnknown?: boolean;
  /**
   * Set when the route goes through a launch pool: what the launch's own
   * contract charges this trade, beside (or in place of) the pool's fee.
   * `spotAmountOut` is already net of every charge named here, so the price
   * impact derived from it never includes a fee or a tax.
   */
  readonly launch?: LaunchCharges;
  readonly estimatedGas: bigint | null;
  readonly source: DataSource;
}

/**
 * What a launch pool charges a trade. A launch pool is one whose hook is a
 * configured launch guard; its fee is set per trade by that contract.
 */
export interface LaunchCharges {
  /**
   * Who charges the trading fee the quote reports as `lpFeePips`.
   *
   * - `"pool"`: it is the pool's own fee, taken from the amount paid in and
   *   earned by the pool's liquidity providers.
   * - `"launch"`: it is paid in the pool's quote currency on every trade, and
   *   the launch takes it itself, except the part of a BUY's fee it leaves to the
   *   pool's liquidity providers (`feeParts`). `lpFeePips` is then the whole
   *   trading fee, both parts.
   */
  readonly feeTakenBy: "pool" | "launch";
  /**
   * Where `feeTakenBy` is `"launch"`: how THIS trade's trading fee is divided,
   * as the launch's contract answers. `null` when it did not answer, or when
   * the trade's direction is not known: the division is then UNKNOWN, which is
   * not the same as the pool's part being zero, and a buy has no price impact
   * figure. Absent where `feeTakenBy` is `"pool"`.
   */
  readonly feeParts?: LaunchFeeParts | null;
  /**
   * The pool's quote currency: what the launch takes its fee and its tax in
   * where `feeTakenBy` is `"launch"`. `null` when the launch's own record could
   * not be read, in which case nothing here names a currency.
   */
  readonly quote: TokenInfo | null;
  /**
   * The creator tax THIS trade pays now, in bps: the buy rate when the input is
   * the quote currency, the sell rate otherwise. `0` when the launch has no
   * tax or it has expired (a tax ends with no transaction). `null` when the
   * launch has no readable tax at all, which is not the same as none.
   */
  readonly taxBps: number | null;
}

/**
 * The two parts of one trade's trading fee through a launch that takes the fee
 * itself, in pips (1_000_000 = 100%). They add up to the trading fee, and both
 * are paid in the pool's quote currency.
 */
export interface LaunchFeeParts {
  /** What the pool charges as its own fee, paid to its liquidity providers. Zero on every sell. */
  readonly poolPips: number;
  /** What the launch takes. */
  readonly launchPips: number;
}

/** A transaction the host is asked to sign, in adapter-neutral form. */
export interface WidgetTransactionRequest {
  readonly to: Address;
  readonly data: Hex;
  readonly value: bigint;
  /** Human-readable summary, used in confirmation UI and error messages. */
  readonly summary: string;
  /** Populated when the transaction includes an integrator fee step. */
  readonly integratorFee?: {
    readonly referrer: Address;
    readonly feeBps: number;
    readonly currency: Address;
    readonly expectedAmount: bigint;
  };
  readonly source: DataSource;
}

/** The two-step allowance the router needs before it can pull the input token. */
export type ApprovalKind = "erc20-to-permit2" | "permit2-to-router";

/** An outstanding approval blocking a swap or liquidity action. */
export interface ApprovalRequirement {
  readonly kind: ApprovalKind;
  readonly token: TokenInfo;
  readonly spender: Address;
  readonly current: bigint;
  readonly required: bigint;
}

/** Parameters for building a swap transaction. */
export interface SwapExecutionRequest {
  readonly quote: SwapQuoteResult;
  readonly tokenIn: TokenInfo;
  readonly tokenOut: TokenInfo;
  readonly amountIn: bigint;
  /** Floor enforced by the swap action, before the integrator fee. */
  readonly minAmountOutGross: bigint;
  /** Floor on what the user receives, after the integrator fee. */
  readonly minAmountOutNet: bigint;
  /** Validated integrator config. Threaded straight into the call path. */
  readonly integrator: ResolvedIntegratorConfig;
  readonly recipient: Address;
  readonly deadline: bigint;
  /** Extra data forwarded to the pool's hook, if any. */
  readonly hookData?: Hex;
  /**
   * The user's signed Permit2 grant of `tokenIn` to the router, from `signPermit2`: the swap applies it
   * first (`PERMIT2_PERMIT`), in place of a separate `Permit2.approve` transaction.
   */
  readonly permit?: SignedPermit;
}

/** A price range, expressed in whichever units the pool type uses. */
export type LiquidityRange =
  | { readonly type: "CL"; readonly tickLower: number; readonly tickUpper: number }
  | {
      readonly type: "BIN";
      readonly activeIdDesired: number;
      readonly binIdLower: number;
      readonly binIdUpper: number;
      /** How many bins the active id may drift before the mint reverts. */
      readonly idSlippage: number;
    };

/** Request to quote an add-liquidity operation. */
export interface AddLiquidityQuoteRequest {
  readonly pool: PoolInfo;
  readonly range: LiquidityRange;
  readonly amount0Desired: bigint;
  readonly amount1Desired: bigint;
}

/** Quoted result of adding liquidity. */
export interface AddLiquidityQuote {
  readonly pool: PoolInfo;
  readonly range: LiquidityRange;
  readonly amount0: bigint;
  readonly amount1: bigint;
  /** CL: liquidity units. BIN: total liquidity minted across the bins. */
  readonly liquidity: bigint;
  /** Share of the pool this position would represent, in bps. Null if unknown. */
  readonly shareBps: number | null;
  /** BIN only: the per-bin distribution the call path will encode. */
  readonly binDistribution?: readonly BinLiquidityShare[];
  readonly source: DataSource;
}

/** One bin's share of a liquidity-book mint. */
export interface BinLiquidityShare {
  readonly binId: number;
  /** Offset from the active bin. */
  readonly deltaId: number;
  /** Share of `amount0`, scaled to 1e18. */
  readonly distributionX: bigint;
  /** Share of `amount1`, scaled to 1e18. */
  readonly distributionY: bigint;
}

/** An existing liquidity position owned by the connected account. */
export interface PositionInfo {
  readonly id: string;
  /** CL positions are ERC-721 token ids; bin positions are ERC-6909-style. */
  readonly tokenId?: bigint;
  readonly pool: PoolInfo;
  readonly range: LiquidityRange;
  readonly liquidity: bigint;
  readonly amount0: bigint;
  readonly amount1: bigint;
  readonly feesOwed0: bigint;
  readonly feesOwed1: bigint;
  /** BIN positions: the bins actually held, with their share amounts. */
  readonly binAmounts?: readonly { readonly binId: number; readonly amount: bigint }[];
  readonly inRange: boolean;
  readonly source: DataSource;
}

/** Request to build an add-liquidity transaction. */
export interface AddLiquidityExecutionRequest {
  readonly quote: AddLiquidityQuote;
  readonly amount0Max: bigint;
  readonly amount1Max: bigint;
  readonly recipient: Address;
  readonly deadline: bigint;
  readonly integrator: ResolvedIntegratorConfig;
  readonly hookData?: Hex;
  /** Set to increase an existing CL position rather than mint a new one. */
  readonly tokenId?: bigint;
}

/** Request to build a remove-liquidity transaction. */
export interface RemoveLiquidityExecutionRequest {
  readonly position: PositionInfo;
  /** Fraction of the position to withdraw, in bps of its liquidity. */
  readonly percentBps: number;
  readonly amount0Min: bigint;
  readonly amount1Min: bigint;
  readonly recipient: Address;
  readonly deadline: bigint;
  readonly integrator: ResolvedIntegratorConfig;
  readonly hookData?: Hex;
}

/** Quote for removing liquidity. */
export interface RemoveLiquidityQuote {
  readonly position: PositionInfo;
  readonly percentBps: number;
  readonly amount0: bigint;
  readonly amount1: bigint;
  readonly source: DataSource;
}

/**
 * A Gully Core launch.
 *
 * Not a token sale. A launch is a concentrated-liquidity pool with
 * `LaunchGuardHook` named in its `PoolKey` and a fee that decays from
 * `initialFeePips` to `finalFeePips` over `guard.window`. Everything the
 * hook knows is keyed by `PoolId`, and every field below is read from it or
 * from the pool key — there is no sale record, no cap, no allocation and no
 * per-account state to read, because none of those exist.
 *
 * Buying into a launch is an ordinary swap, quoted with `quoteSwap` and
 * executed with `buildSwap`, which is why this interface adds no buy method.
 */
export interface LaunchInfo {
  readonly poolId: PoolId;
  /** The pool itself: key, tokens, tick spacing. */
  readonly pool: PoolInfo;
  /** The launch guard the pool key names: `LaunchGuardHook` for a CL pool, `BinLaunchGuardHook` for a Bin pool. */
  readonly hook: Address;
  /** The token being launched, resolved from `guard.launchTokenIsCurrency0`. */
  readonly launchToken: TokenInfo;
  /** The other side of the pool: what buyers pay with, and what caps are in. */
  readonly quoteToken: TokenInfo;
  /** The decoded `getLaunch(poolId)` record. */
  readonly guard: LaunchGuard;
  /**
   * `currentFee(poolId)` as the hook answered it, in pips.
   *
   * Read from chain rather than derived, so the number on screen is the number
   * the contract will charge. {@link ../callpath/launch.js | launchFeeAt}
   * reproduces the same maths locally for the projected schedule.
   */
  readonly currentFeePips: number;
  /**
   * "Now" on the hook's own clock when the reads above were taken
   * (`guard.durationClock`): the latest `block.timestamp` for the timestamp
   * build, or `block.number` as the hook sees it for the block-numbered one —
   * NOT `eth_blockNumber`, which on an Arbitrum chain is the L2 block.
   */
  readonly readAt: bigint;
  readonly source: DataSource;
}

/** Result of waiting on a transaction. */
export interface TransactionOutcome {
  readonly hash: Hex;
  readonly status: "success" | "reverted";
  readonly blockNumber: bigint | null;
  readonly source: DataSource;
}

/**
 * The single interface every chain read and write passes through.
 *
 * Methods that a given deployment cannot support must throw
 * {@link UnsupportedOperationError} rather than returning empty or zero data.
 * Silence is indistinguishable from "there is no liquidity", which is a lie the
 * UI would render as fact.
 */
export interface ProtocolAdapter {
  /** Identifies the implementation, e.g. `"viem"`. */
  readonly kind: string;
  /**
   * `true` when nothing this adapter returns came from a chain. The styled
   * widgets render a persistent banner when this is set, and it cannot be
   * suppressed by configuration.
   */
  readonly isMock: boolean;
  readonly chain: ChainConfig;

  /** Connected account, or `null` when no wallet is connected. */
  getAccount(): Promise<Address | null>;

  /** Tokens this deployment knows about, for the token picker. */
  listTokens(): Promise<readonly TokenInfo[]>;
  getToken(address: Address): Promise<TokenInfo | null>;
  getBalance(token: TokenInfo, owner: Address): Promise<bigint>;

  /** Pools available for routing and liquidity provision. */
  listPools(): Promise<readonly PoolInfo[]>;
  getPoolState(pool: PoolInfo): Promise<PoolState>;

  /**
   * Approvals still required before `spender` can pull `amount` of `token`
   * through Permit2. `spender` defaults to the universal router (a swap); a
   * liquidity add passes the position manager that settles the deposit.
   */
  getApprovalRequirements(
    token: TokenInfo,
    owner: Address,
    amount: bigint,
    spender?: Address,
  ): Promise<readonly ApprovalRequirement[]>;
  buildApproval(requirement: ApprovalRequirement): Promise<WidgetTransactionRequest>;
  /**
   * Optional. `true` when a `permit2-to-router` requirement can be met by a SIGNATURE (`signPermit2`)
   * carried in the swap, rather than a `Permit2.approve` transaction: the wallet can sign typed data.
   */
  canSignPermit2?(): boolean;
  /** Optional. Asks the wallet to sign the Permit2 `PermitSingle` that meets `requirement` (kind `permit2-to-router`). */
  signPermit2?(requirement: ApprovalRequirement): Promise<SignedPermit>;
  /**
   * Optional. `true` when the wallet can send several calls as ONE atomic batch on this chain (EIP-5792
   * `wallet_getCapabilities` reports `atomic` supported or ready).
   */
  supportsAtomicBatch?(): Promise<boolean>;
  /**
   * Optional. Sends `requests` as one atomic EIP-5792 batch (one confirmation) and resolves, once the batch
   * is mined, with the hash of the transaction carrying the LAST call. Rejects with
   * `BatchUnavailableError` when the batch could not be simulated or sent as a batch: the caller then
   * sends the calls one by one, so nothing unsimulated reaches the wallet.
   */
  sendBatch?(requests: readonly WidgetTransactionRequest[]): Promise<Hex>;

  quoteSwap(request: SwapQuoteRequest): Promise<SwapQuoteResult>;
  buildSwap(request: SwapExecutionRequest): Promise<WidgetTransactionRequest>;

  quoteAddLiquidity(request: AddLiquidityQuoteRequest): Promise<AddLiquidityQuote>;
  buildAddLiquidity(request: AddLiquidityExecutionRequest): Promise<WidgetTransactionRequest>;
  listPositions(owner: Address, pool?: PoolInfo): Promise<readonly PositionInfo[]>;
  quoteRemoveLiquidity(position: PositionInfo, percentBps: number): Promise<RemoveLiquidityQuote>;
  buildRemoveLiquidity(
    request: RemoveLiquidityExecutionRequest,
  ): Promise<WidgetTransactionRequest>;

  /**
   * Launch pools this deployment surfaces.
   *
   * Must throw — not return `[]` — when the chain config carries neither a
   * `launchGuardHook` nor a `binLaunchGuardHook` address. An empty array means
   * "a guard is deployed and no pool uses it"; a `ChainConfigError` means "there is no guard here". A UI
   * has to be able to tell those apart, and only one of them is a launchpad
   * that does not exist on this chain.
   */
  listLaunches(): Promise<readonly LaunchInfo[]>;
  /** One launch by pool id, or `null` when that pool has no launch record. */
  getLaunch(poolId: PoolId): Promise<LaunchInfo | null>;
  /**
   * Every pool a `LaunchpadKitV2` launch opened for `token`, as launches, in
   * the kit's leg order. Must throw `ChainConfigError` naming `launchpadKitV2`
   * when no kit is configured; returns `[]` for a token the kit never launched.
   */
  getLaunchesForToken(token: Address): Promise<readonly LaunchInfo[]>;

  /**
   * Optional. A third-party token sale contract, which Gully Core does not have.
   * Nothing in this package reads it; see {@link ./sale.js}.
   */
  readonly sale?: TokenSaleAdapter;

  sendTransaction(request: WidgetTransactionRequest): Promise<Hex>;
  waitForTransaction(hash: Hex): Promise<TransactionOutcome>;
  /**
   * The chain's clock, in seconds: the timestamp the next block will carry
   * where the RPC can say (the pending block), else the latest block's (see
   * `nextBlockClock` in config/chain). Transaction deadlines are
   * compared with `block.timestamp`, so they are built from this clock rather
   * than the browser's: a devnet whose time was advanced, or a visitor whose
   * clock is wrong, would otherwise sign a trade that is already expired.
   * Optional: without it the widgets fall back to the local clock.
   */
  getBlockTimestamp?(): Promise<bigint>;
}

/** Thrown when an adapter cannot perform an operation on this deployment. */
export class UnsupportedOperationError extends Error {
  readonly operation: string;

  constructor(operation: string, detail: string) {
    super(`[@gullylabs/core-widgets] ${operation} is not available: ${detail}`);
    this.name = "UnsupportedOperationError";
    this.operation = operation;
  }
}

/**
 * Thrown by `quoteSwap` when the trade is larger than the pool can fill.
 *
 * Some launch pools refuse a trade they could only fill in part, where an
 * ordinary pool would fill what it can. `largestAmountIn` is the most the pool
 * can fill right now, in `tokenIn`'s smallest unit, and is only ever a number a
 * quote was actually obtained for; `null` when none could be.
 */
export class SwapTooLargeError extends Error {
  readonly tokenIn: TokenInfo;
  readonly amountIn: bigint;
  readonly largestAmountIn: bigint | null;

  constructor(tokenIn: TokenInfo, amountIn: bigint, largestAmountIn: bigint | null) {
    super(
      `[@gullylabs/core-widgets] the trade is larger than the pool can fill${largestAmountIn === null ? "" : `; the most it can fill now is ${largestAmountIn} of ${tokenIn.symbol} (smallest units)`}`,
    );
    this.name = "SwapTooLargeError";
    this.tokenIn = tokenIn;
    this.amountIn = amountIn;
    this.largestAmountIn = largestAmountIn;
  }
}

/** Thrown when a wallet action is required but no account is connected. */
/**
 * The wallet (or the RPC behind the batch simulation) cannot take these calls as one atomic batch.
 * Not a failure of the trade: the caller sends the same calls one by one.
 */
export class BatchUnavailableError extends Error {
  constructor(reason: string) {
    super(`atomic batch unavailable: ${reason}`);
    this.name = "BatchUnavailableError";
  }
}

export class WalletNotConnectedError extends Error {
  constructor(action: string) {
    super(`[@gullylabs/core-widgets] connect a wallet before attempting to ${action}`);
    this.name = "WalletNotConnectedError";
  }
}

/** Thrown when the requested route does not exist in this deployment. */
export class NoRouteError extends Error {
  readonly tokenIn: Address;
  readonly tokenOut: Address;

  constructor(tokenIn: Address, tokenOut: Address) {
    super(`[@gullylabs/core-widgets] no pool connects ${tokenIn} to ${tokenOut}`);
    this.name = "NoRouteError";
    this.tokenIn = tokenIn;
    this.tokenOut = tokenOut;
  }
}
