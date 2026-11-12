// SPDX-License-Identifier: MIT
/**
 * Live protocol adapter, backed by viem.
 *
 * This is the implementation that produces **real calldata** and submits real
 * transactions. It is the swap and liquidity call paths from `src/callpath/`
 * wired to a viem `PublicClient` for reads and a wallet for writes.
 *
 * ## What it can and cannot do today
 *
 * Bounded honestly, feature by feature:
 *
 * - **Encoding** is complete and unit-tested. `buildSwap`, `buildAddLiquidity`
 *   and `buildRemoveLiquidity` produce the exact calldata the router and
 *   position managers decode, integrator fee step included.
 * - **Launches** are read from the launch guards, keyed by pool id: CL pools
 *   from `contracts.launchGuardHook`, Bin pools from `contracts.binLaunchGuardHook`.
 *   With neither configured every launch read throws
 *   `ChainConfigError` rather than guessing an address. On a chain with no
 *   `LaunchGuardHook` deployed, that is the correct and only answer.
 * - **Token, balance and allowance reads** are ordinary ERC-20 and Permit2
 *   calls and will work against any chain that has them.
 * - **Pool discovery** is not on-chain: the singleton has no pool enumeration.
 *   Pass the pools you support, or wire an indexer (`@gullylabs/core-sdk/indexer`
 *   describes the schema).
 * - **Quoting** requires either a deployed quoter or a host-supplied function.
 *   Without one, `quoteSwap` throws {@link UnsupportedOperationError} rather
 *   than inventing a number - a fabricated quote is worse than no quote.
 */

import {
  BaseError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  ExecutionRevertedError,
  decodeAbiParameters,
  encodeFunctionData,
  isAddressEqual,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import {
  BIN_LAUNCH_GUARD_HOOK_ABI,
  CLOCK_MODE_CALLDATA,
  LAUNCH_GUARD_HOOK_ABI,
  LAUNCHPAD_KIT_V2_ABI,
  TIMESTAMP_CLOCK_MODE,
  binRawPriceFromId,
  getDeployment,
  guardBuyCharges,
  guardGenerationOfKey,
  guardSwapRates,
  isDynamicLPFee,
  largestExactInputFor,
  quoterAbiFor,
  poolKeyToId,
  readBinPoolKeyParameters,
  readCLPoolKeyParameters,
  readContractClock,
  readGuardFeeParts,
  type GuardFeeParts,
  type PoolId,
  type PoolKey,
} from "@gullylabs/core-sdk";
import { verifySwapCalldata } from "@gullylabs/core-sdk/router";

/* getSlot0 on both pool managers: the pool's own price, for the no-impact output. */
const CL_SLOT0_ABI = [
  {
    type: "function",
    name: "getSlot0",
    stateMutability: "view",
    inputs: [{ name: "id", type: "bytes32" }],
    outputs: [
      { name: "sqrtPriceX96", type: "uint160" },
      { name: "tick", type: "int24" },
      { name: "protocolFee", type: "uint24" },
      { name: "lpFee", type: "uint24" },
    ],
  },
] as const;
const BIN_SLOT0_ABI = [
  {
    type: "function",
    name: "getSlot0",
    stateMutability: "view",
    inputs: [{ name: "id", type: "bytes32" }],
    outputs: [
      { name: "activeId", type: "uint24" },
      { name: "protocolFee", type: "uint24" },
      { name: "lpFee", type: "uint24" },
    ],
  },
] as const;
const Q192 = 2n ** 192n;

/* The pool-manager views the liquidity paths read: pool liquidity and fee
   growth (CL, for a position's amounts and uncollected fees), bin reserves and
   share supply (Bin, for what a holder's shares are worth). */
const CL_POOL_VIEWS_ABI = [
  {
    type: "function",
    name: "getLiquidity",
    stateMutability: "view",
    inputs: [{ name: "id", type: "bytes32" }],
    outputs: [{ name: "liquidity", type: "uint128" }],
  },
  {
    type: "function",
    name: "getFeeGrowthGlobals",
    stateMutability: "view",
    inputs: [{ name: "id", type: "bytes32" }],
    outputs: [
      { name: "feeGrowthGlobal0x128", type: "uint256" },
      { name: "feeGrowthGlobal1x128", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "getPoolTickInfo",
    stateMutability: "view",
    inputs: [
      { name: "id", type: "bytes32" },
      { name: "tick", type: "int24" },
    ],
    outputs: [
      {
        name: "info",
        type: "tuple",
        components: [
          { name: "liquidityGross", type: "uint128" },
          { name: "liquidityNet", type: "int128" },
          { name: "feeGrowthOutside0X128", type: "uint256" },
          { name: "feeGrowthOutside1X128", type: "uint256" },
        ],
      },
    ],
  },
] as const;
const BIN_POOL_VIEWS_ABI = [
  {
    type: "function",
    name: "getBin",
    stateMutability: "view",
    inputs: [
      { name: "id", type: "bytes32" },
      { name: "binId", type: "uint24" },
    ],
    outputs: [
      { name: "binReserveX", type: "uint128" },
      { name: "binReserveY", type: "uint128" },
      { name: "binLiquidity", type: "uint256" },
      { name: "totalShares", type: "uint256" },
    ],
  },
] as const;
const POOL_KEY_OUTPUT = {
  name: "poolKey",
  type: "tuple",
  components: [
    { name: "currency0", type: "address" },
    { name: "currency1", type: "address" },
    { name: "hooks", type: "address" },
    { name: "poolManager", type: "address" },
    { name: "fee", type: "uint24" },
    { name: "parameters", type: "bytes32" },
  ],
} as const;
/* CLPositionManager: a solmate ERC-721 with no owner enumeration, so a
   holder's tokens come from `Transfer(to)` logs confirmed by `ownerOf`. */
const CL_POSM_VIEWS_ABI = [
  {
    type: "function",
    name: "ownerOf",
    stateMutability: "view",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [{ name: "owner", type: "address" }],
  },
  {
    type: "function",
    name: "positions",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [
      POOL_KEY_OUTPUT,
      { name: "tickLower", type: "int24" },
      { name: "tickUpper", type: "int24" },
      { name: "liquidity", type: "uint128" },
      { name: "feeGrowthInside0LastX128", type: "uint256" },
      { name: "feeGrowthInside1LastX128", type: "uint256" },
      { name: "subscriber", type: "address" },
    ],
  },
  {
    type: "event",
    name: "Transfer",
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "id", type: "uint256", indexed: true },
    ],
  },
] as const;
/* BinPositionManager: ERC-1155-like shares per (pool, bin); the token ids a
   holder ever received come from `TransferBatch(to)` logs, the live balance from `balanceOf`. */
const BIN_POSM_VIEWS_ABI = [
  {
    type: "function",
    name: "positions",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [POOL_KEY_OUTPUT, { name: "binId", type: "uint24" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "id", type: "uint256" },
    ],
    outputs: [{ name: "balance", type: "uint256" }],
  },
  {
    type: "event",
    name: "TransferBatch",
    inputs: [
      { name: "sender", type: "address", indexed: true },
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "ids", type: "uint256[]", indexed: false },
      { name: "amounts", type: "uint256[]", indexed: false },
    ],
  },
] as const;
import type { ChainConfig } from "../config/chain.js";
import { nextBlockClock, requireContract } from "../config/chain.js";
import {
  ERC20_ABI,
  MAX_UINT160,
  MAX_UINT256,
  MAX_UINT48,
  PERMIT2_ABI,
} from "../callpath/constants.js";
import { buildSwapCall, type SwapHop } from "../callpath/swap.js";
import { buildPermitSingle, permitTypedData, type PermitTypedData, type SignedPermit } from "../callpath/permit2.js";
import {
  buildBinAddCall,
  buildBinRemoveCall,
  buildCLDecreaseCall,
  buildCLMintCall,
} from "../callpath/liquidity.js";
import {
  decodeLaunchGuard,
  isLaunchConfigured,
  launchGuardAbiFor,
  type DurationClock,
  type RawLaunchGuard,
} from "../callpath/launch.js";
import {
  amountsForLiquidity,
  getLiquidityForAmounts,
  getSqrtRatioAtTick,
  uncollectedFees,
} from "../core/clMath.js";
import { binShareAmounts, binStepOf, tickSpacingOf } from "../core/pool.js";
import { swapNotFilledOf } from "../core/errors.js";
import { spotAfterCharges } from "../core/launchCharges.js";
import { buildUniformBinDistribution } from "./binDistribution.js";
import {
  BatchUnavailableError,
  SwapTooLargeError,
  UnsupportedOperationError,
  WalletNotConnectedError,
  type AddLiquidityExecutionRequest,
  type AddLiquidityQuote,
  type AddLiquidityQuoteRequest,
  type ApprovalRequirement,
  type LaunchCharges,
  type LaunchInfo,
  type PoolInfo,
  type PoolType,
  type PoolState,
  type PositionInfo,
  type ProtocolAdapter,
  type RemoveLiquidityExecutionRequest,
  type RemoveLiquidityQuote,
  type SwapExecutionRequest,
  type SwapQuoteRequest,
  type SwapQuoteResult,
  type TokenInfo,
  type TransactionOutcome,
  type WidgetTransactionRequest,
} from "./protocol.js";

const NATIVE: Address = "0x0000000000000000000000000000000000000000";

/** Minimal wallet surface. Any wallet stack that can sign satisfies this. */
export interface WidgetWallet {
  /** Currently selected account, or `null`. */
  getAccount(): Promise<Address | null>;
  /** Submits a transaction and returns its hash. */
  sendTransaction(request: {
    to: Address;
    data: Hex;
    value: bigint;
  }): Promise<Hex>;
  /**
   * Optional. Signs EIP-712 typed data (`eth_signTypedData_v4`). With it, the Permit2 grant to the router
   * is a signature carried in the swap instead of a `Permit2.approve` transaction.
   */
  signTypedData?(data: PermitTypedData): Promise<Hex>;
  /**
   * Optional EIP-5792. Whether the wallet sends several calls atomically on this chain
   * (`wallet_getCapabilities` → `atomic.status` "supported" or "ready").
   */
  supportsAtomicBatch?(): Promise<boolean>;
  /**
   * Optional EIP-5792. Simulates `calls` together, sends them with `wallet_sendCalls` (atomic required)
   * and resolves with the mined transaction hashes once `wallet_getCallsStatus` reports success. Rejects
   * with `BatchUnavailableError` when the calls cannot be simulated or sent as a batch.
   */
  sendCalls?(calls: readonly { to: Address; data: Hex; value: bigint }[]): Promise<readonly Hex[]>;
}

/**
 * Host-supplied functions for the parts the protocol cannot answer on its own.
 *
 * Each one is optional. Omitting a function makes the corresponding widget
 * feature fail loudly with a named error instead of degrading to invented data.
 */
export interface ViemAdapterOverrides {
  quoteSwap?: (request: SwapQuoteRequest, pools: readonly PoolInfo[]) => Promise<SwapQuoteResult>;
  quoteAddLiquidity?: (request: AddLiquidityQuoteRequest) => Promise<AddLiquidityQuote>;
  quoteRemoveLiquidity?: (
    position: PositionInfo,
    percentBps: number,
  ) => Promise<RemoveLiquidityQuote>;
  listPositions?: (owner: Address, pool?: PoolInfo) => Promise<readonly PositionInfo[]>;
  getPoolState?: (pool: PoolInfo) => Promise<PoolState>;
  /** Resolves a route. Defaults to a direct pool match over `pools`. */
  findRoute?: (
    tokenIn: TokenInfo,
    tokenOut: TokenInfo,
    pools: readonly PoolInfo[],
  ) => readonly SwapHop[];
}

/** Options for {@link createViemAdapter}. */
export interface ViemAdapterOptions {
  readonly chain: ChainConfig;
  readonly publicClient: PublicClient;
  readonly wallet?: WidgetWallet;
  /** Tokens offered in the picker. There is no on-chain token registry. */
  readonly tokens: readonly TokenInfo[];
  /**
   * Pools this integrator supports. There is no on-chain pool enumeration.
   *
   * Launch pools live in this list too: a launch is a pool. `listLaunches`
   * selects the ones whose key names `contracts.launchGuardHook`, so there is
   * no separate launch list to keep in sync.
   */
  readonly pools: readonly PoolInfo[];
  /**
   * The block the position managers were deployed at (or any earlier one).
   *
   * Neither position manager enumerates a holder's positions, so
   * `listPositions` reconstructs them from `Transfer` / `TransferBatch` logs
   * addressed to the owner and confirms each against live state. The scan
   * starts here. Without it `listPositions` throws rather than scanning from
   * genesis, which public endpoints refuse and which would read as "no
   * positions" when it silently returned nothing.
   */
  readonly positionsFromBlock?: bigint;
  readonly overrides?: ViemAdapterOverrides;
}

class ViemProtocolAdapter implements ProtocolAdapter {
  readonly kind = "viem";
  readonly isMock = false;
  readonly chain: ChainConfig;

  readonly #options: ViemAdapterOptions;
  /** Which side of a launch pool is the launch token: fixed by the two addresses' order, so read once per pool. */
  readonly #launchTokenIsCurrency0 = new Map<PoolId, boolean>();

  constructor(options: ViemAdapterOptions) {
    this.#options = options;
    this.chain = options.chain;
  }

  get #client(): PublicClient {
    return this.#options.publicClient;
  }

  get #overrides(): ViemAdapterOverrides {
    return this.#options.overrides ?? {};
  }

  async getAccount(): Promise<Address | null> {
    const wallet = this.#options.wallet;
    if (wallet === undefined) return null;
    return wallet.getAccount();
  }

  /**
   * The configured tokens, plus the chain's native coin just before its wrapped native when
   * `contracts.wrappedNative` is set and the list names the wrapped native but not the native coin: a pool
   * quoted in the wrapped native can be paid in the native coin (the router wraps it).
   */
  async listTokens(): Promise<readonly TokenInfo[]> {
    const tokens = this.#options.tokens;
    const wrapped = this.chain.contracts.wrappedNative;
    if (wrapped === undefined) return tokens;
    const at = tokens.findIndex((t) => isAddressEqual(t.address, wrapped));
    if (at < 0 || tokens.some((t) => t.isNative === true || isAddressEqual(t.address, NATIVE))) return tokens;
    const native: TokenInfo = {
      address: NATIVE,
      symbol: this.chain.nativeCurrency.symbol,
      name: this.chain.nativeCurrency.name,
      decimals: this.chain.nativeCurrency.decimals,
      isNative: true,
    };
    return [...tokens.slice(0, at), native, ...tokens.slice(at)];
  }

  async getToken(address: Address): Promise<TokenInfo | null> {
    const known = this.#options.tokens.find((token) => isAddressEqual(token.address, address));
    if (known !== undefined) return known;
    if (isAddressEqual(address, NATIVE)) {
      return {
        address: NATIVE,
        symbol: this.chain.nativeCurrency.symbol,
        name: this.chain.nativeCurrency.name,
        decimals: this.chain.nativeCurrency.decimals,
        isNative: true,
      };
    }
    const [symbol, name, decimals] = await Promise.all([
      this.#client.readContract({ address, abi: ERC20_ABI, functionName: "symbol" }),
      this.#client.readContract({ address, abi: ERC20_ABI, functionName: "name" }),
      this.#client.readContract({ address, abi: ERC20_ABI, functionName: "decimals" }),
    ]);
    return { address, symbol, name, decimals: Number(decimals) };
  }

  async getBalance(token: TokenInfo, owner: Address): Promise<bigint> {
    if (token.isNative === true || isAddressEqual(token.address, NATIVE)) {
      return this.#client.getBalance({ address: owner });
    }
    return this.#client.readContract({
      address: token.address,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [owner],
    });
  }

  async listPools(): Promise<readonly PoolInfo[]> {
    return this.#options.pools;
  }

  /**
   * The pool's live state from its manager's `getSlot0` (plus `getLiquidity`
   * for a CL pool). An uninitialised pool answers a zero price, which is
   * reported as an error rather than as tick 0.
   */
  async getPoolState(pool: PoolInfo): Promise<PoolState> {
    const override = this.#overrides.getPoolState;
    if (override !== undefined) return override(pool);
    if (pool.poolType === "CL") {
      const [[sqrtPriceX96, tick], liquidity] = await Promise.all([
        this.#client.readContract({ address: pool.key.poolManager, abi: CL_SLOT0_ABI, functionName: "getSlot0", args: [pool.id] }),
        this.#client.readContract({ address: pool.key.poolManager, abi: CL_POOL_VIEWS_ABI, functionName: "getLiquidity", args: [pool.id] }),
      ]);
      if (sqrtPriceX96 === 0n) {
        throw new UnsupportedOperationError("getPoolState", `pool ${pool.id} is not initialised on ${pool.key.poolManager}`);
      }
      return { poolId: pool.id, poolType: "CL", currentTick: tick, sqrtPriceX96, liquidity, source: "live" };
    }
    const [activeId] = await this.#client.readContract({ address: pool.key.poolManager, abi: BIN_SLOT0_ABI, functionName: "getSlot0", args: [pool.id] });
    if (activeId === 0) {
      throw new UnsupportedOperationError("getPoolState", `pool ${pool.id} is not initialised on ${pool.key.poolManager}`);
    }
    return { poolId: pool.id, poolType: "BIN", activeId, source: "live" };
  }

  /**
   * The two allowances `spender` needs before it can pull `token` through
   * Permit2: ERC-20 to Permit2, then Permit2 to the spender. The spender is
   * the router for a swap (the default) and a position manager for a
   * liquidity add; the liquidity hooks pass it, because an allowance to the
   * router does nothing for a mint.
   */
  async getApprovalRequirements(
    token: TokenInfo,
    owner: Address,
    amount: bigint,
    spender?: Address,
  ): Promise<readonly ApprovalRequirement[]> {
    if (token.isNative === true || isAddressEqual(token.address, NATIVE)) return [];
    const permit2 = requireContract(this.chain, "permit2", "pull the input token for a swap");
    const router = spender ?? requireContract(this.chain, "universalRouter", "execute a swap");

    const requirements: ApprovalRequirement[] = [];

    const erc20Allowance = await this.#client.readContract({
      address: token.address,
      abi: ERC20_ABI,
      functionName: "allowance",
      args: [owner, permit2],
    });
    if (erc20Allowance < amount) {
      requirements.push({
        kind: "erc20-to-permit2",
        token,
        spender: permit2,
        current: erc20Allowance,
        required: amount,
      });
    }

    const [permit2Amount, expiration] = await this.#client.readContract({
      address: permit2,
      abi: PERMIT2_ABI,
      functionName: "allowance",
      args: [owner, token.address, router],
    });
    const nowSeconds = BigInt(Math.floor(Date.now() / 1000));
    const expired = BigInt(expiration) !== 0n && BigInt(expiration) <= nowSeconds;
    if (BigInt(permit2Amount) < amount || expired) {
      requirements.push({
        kind: "permit2-to-router",
        token,
        spender: router,
        current: expired ? 0n : BigInt(permit2Amount),
        required: amount,
      });
    }

    return requirements;
  }

  canSignPermit2(): boolean {
    return this.#options.wallet?.signTypedData !== undefined && this.chain.contracts.permit2 !== undefined;
  }

  /** The Permit2 grant a `permit2-to-router` requirement asks for, as a signature (callpath/permit2.ts). */
  async signPermit2(requirement: ApprovalRequirement): Promise<SignedPermit> {
    if (requirement.kind !== "permit2-to-router") throw new UnsupportedOperationError("signPermit2", "only a Permit2 grant to a spender can be signed");
    const wallet = this.#options.wallet;
    if (wallet?.signTypedData === undefined) throw new UnsupportedOperationError("signPermit2", "the wallet cannot sign typed data");
    const owner = await this.getAccount();
    if (owner === null) throw new WalletNotConnectedError("sign a Permit2 allowance");
    const permit2 = requireContract(this.chain, "permit2", "sign a Permit2 allowance");
    const [, , nonce] = await this.#client.readContract({
      address: permit2,
      abi: PERMIT2_ABI,
      functionName: "allowance",
      args: [owner, requirement.token.address, requirement.spender],
    });
    const now = Number(await this.getBlockTimestamp());
    const permit = buildPermitSingle({ token: requirement.token.address, spender: requirement.spender, nonce: Number(nonce), nowSeconds: now });
    const signature = await wallet.signTypedData(permitTypedData(this.chain.chainId, permit2, permit));
    return { permit, signature };
  }

  async supportsAtomicBatch(): Promise<boolean> {
    const wallet = this.#options.wallet;
    if (wallet?.supportsAtomicBatch === undefined || wallet.sendCalls === undefined) return false;
    try {
      return await wallet.supportsAtomicBatch();
    } catch {
      return false;
    }
  }

  async sendBatch(requests: readonly WidgetTransactionRequest[]): Promise<Hex> {
    const wallet = this.#options.wallet;
    if (wallet?.sendCalls === undefined) throw new BatchUnavailableError("the wallet has no wallet_sendCalls");
    const hashes = await wallet.sendCalls(requests.map((r) => ({ to: r.to, data: r.data, value: r.value })));
    const last = hashes[hashes.length - 1];
    if (last === undefined) throw new Error("the batch was mined without a transaction hash");
    return last;
  }

  async buildApproval(requirement: ApprovalRequirement): Promise<WidgetTransactionRequest> {
    if (requirement.kind === "erc20-to-permit2") {
      return {
        to: requirement.token.address,
        data: encodeFunctionData({
          abi: ERC20_ABI,
          functionName: "approve",
          args: [requirement.spender, MAX_UINT256],
        }),
        value: 0n,
        summary: `Approve ${requirement.token.symbol} for Permit2`,
        source: "live",
      };
    }
    const permit2 = requireContract(this.chain, "permit2", "approve the router through Permit2");
    return {
      to: permit2,
      data: encodeFunctionData({
        abi: PERMIT2_ABI,
        functionName: "approve",
        args: [requirement.token.address, requirement.spender, MAX_UINT160, Number(MAX_UINT48)],
      }),
      value: 0n,
      summary: `Approve ${requirement.spender} to spend ${requirement.token.symbol} via Permit2`,
      source: "live",
    };
  }

  /**
   * Quotes an exact-input swap.
   *
   * With `overrides.quoteSwap` the host answers. Otherwise every configured
   * pool holding both tokens is quoted DIRECTLY against the deployed quoter for
   * its type (`contracts.quoter` for CL, `contracts.binQuoter` for Bin) and the
   * best output wins. No multi-hop routing: a route this adapter did not quote
   * is a route it cannot vouch for. Throws when no quoter can answer.
   *
   * The LP fee shown beside the quote is the pool's static fee, or, for a
   * dynamic-fee pool whose hook is a launch guard, the guard's `currentFee`.
   * Any other dynamic pool is reported `lpFeeUnknown`, which the widget renders
   * as "dynamic" rather than as a rate it did not read.
   *
   * A quote through a launch pool also says what the launch charges (`launch`):
   * who takes the fee, in which currency, and the creator tax this trade pays.
   * The no-impact output it is compared with is net of all of it, so the price
   * impact is never a fee in disguise.
   *
   * Throws `SwapTooLargeError` when every pool refused because the trade is more
   * than it can fill.
   */
  async quoteSwap(request: SwapQuoteRequest): Promise<SwapQuoteResult> {
    const override = this.#overrides.quoteSwap;
    if (override !== undefined) return override(request, this.#options.pools);

    const contracts = this.chain.contracts;
    /* The native coin matches a pool quoted in the wrapped native (`#poolSide`); the router wraps or
       unwraps around the swap, so the quote is the wrapped pool's quote, one for one. */
    const candidates = this.#options.pools.filter((pool) => {
      const tin = this.#poolSide(request.tokenIn.address, pool);
      const tout = this.#poolSide(request.tokenOut.address, pool);
      return (
        (request.poolId === undefined || pool.id === request.poolId) &&
        !isAddressEqual(tin, tout) &&
        ((isAddressEqual(pool.token0.address, tin) && isAddressEqual(pool.token1.address, tout)) ||
          (isAddressEqual(pool.token1.address, tin) && isAddressEqual(pool.token0.address, tout)))
      );
    });
    if (candidates.length === 0) {
      throw new UnsupportedOperationError(
        "quoteSwap",
        request.poolId !== undefined
          ? `pool ${request.poolId} is not a configured pool holding both ${request.tokenIn.symbol} and ${request.tokenOut.symbol}.`
          : `no configured pool holds both ${request.tokenIn.symbol} and ${request.tokenOut.symbol}. ` +
            "This adapter quotes direct pools only; supply `overrides.quoteSwap` for multi-hop routes.",
      );
    }
    const quotable = candidates.filter((pool) =>
      pool.poolType === "CL" ? contracts.quoter !== undefined : contracts.binQuoter !== undefined,
    );
    if (quotable.length === 0) {
      throw new UnsupportedOperationError(
        "quoteSwap",
        `a pool for this pair exists but no quoter is configured for its type (${candidates.map((p) => p.poolType).join(", ")}). ` +
          "Set `contracts.quoter` (CL) / `contracts.binQuoter` (Bin), or supply `overrides.quoteSwap`. " +
          "This adapter will not estimate a price it cannot verify.",
      );
    }

    const results = await Promise.all(
      quotable.map(async (pool) => {
        const quoter = (pool.poolType === "CL" ? contracts.quoter : contracts.binQuoter) as Address;
        try {
          const { result } = await this.#client.simulateContract({
            address: quoter,
            abi: quoterAbiFor(pool.poolType),
            functionName: "quoteExactInputSingle",
            args: [
              {
                poolKey: pool.key,
                zeroForOne: isAddressEqual(pool.key.currency0, this.#poolSide(request.tokenIn.address, pool)),
                exactAmount: request.amountIn,
                hookData: "0x",
              },
            ],
          });
          const [amountOut, gasEstimate] = result as readonly [bigint, bigint];
          return { pool, amountOut, gasEstimate, error: null as Error | null };
        } catch (error) {
          return { pool, amountOut: 0n, gasEstimate: 0n, error: error instanceof Error ? error : new Error(String(error)) };
        }
      }),
    );
    const answered = results.filter((r) => r.error === null);
    if (answered.length === 0) {
      /* A launch pool that refuses a trade it could only fill in part says how much it did trade.
         That is a plain state for a trader, not a failure to quote. */
      for (const r of results) {
        const refusal = swapNotFilledOf(r.error);
        if (refusal === null) continue;
        throw new SwapTooLargeError(request.tokenIn, request.amountIn, await this.#largestFillable(r.pool, { ...request, tokenIn: this.#poolToken(request.tokenIn, r.pool) }, refusal.traded));
      }
      const first = results[0]?.error;
      throw new UnsupportedOperationError(
        "quoteSwap",
        `every direct pool for this pair failed to quote${first === null || first === undefined ? "" : `: ${first.message}`}`,
      );
    }
    const best = answered.reduce((a, b) => (b.amountOut > a.amountOut ? b : a));
    const pool = best.pool;
    /* What the pool itself is paid: the wrapped native when the user pays the native coin. */
    const poolTokenIn = this.#poolToken(request.tokenIn, pool);

    let lpFeePips = pool.lpFeePips;
    let lpFeeUnknown = false;
    if (isDynamicLPFee(pool.lpFeePips)) {
      const guardFee = await this.#launchGuardFee(pool);
      if (guardFee === null) {
        lpFeePips = 0;
        lpFeeUnknown = true;
      } else {
        lpFeePips = guardFee;
      }
    }
    const launch = lpFeeUnknown ? null : await this.#launchCharges(pool, poolTokenIn);

    /* The output the same input would fetch at the pool's CURRENT price, net of
       every charge that is known (the fee, and a launch's creator tax), so the
       breakdown can isolate price impact from them. With a hook-set fee the
       adapter cannot separate the two and reports no spot rather than an impact
       that silently includes the fee. The same goes for a buy through a launch
       that did not say how its fee is divided. */
    const launchTakesFee = launch?.charges.feeTakenBy === "launch";
    const spotAmountOut = lpFeeUnknown
      ? null
      : await this.#spotAmountOut(pool, poolTokenIn.address, request.amountIn, {
          feePips: lpFeePips,
          taxBps: launch?.charges.taxBps ?? 0,
          feeTakenBy: launch?.charges.feeTakenBy ?? "pool",
          inputIsQuote: launch?.inputIsQuote ?? false,
          ...(launchTakesFee ? { feeParts: launch.charges.feeParts ?? null } : {}),
        });

    /* What the pool's liquidity providers are paid, in the input currency. Through a launch that takes
       the fee itself that is the pool's part of a BUY's fee, charged on what is left after the launch's
       take; a sell pays the pool nothing; a division that was not read is reported as zero, and
       `launch.feeParts === null` says the zero is not a reading. */
    let lpFeeAmount = (request.amountIn * BigInt(lpFeePips)) / 1_000_000n;
    if (launchTakesFee) {
      lpFeeAmount =
        launch.parts !== null && launch.inputIsQuote && launch.charges.taxBps !== null
          ? guardBuyCharges({ amount: request.amountIn, parts: launch.parts, taxBps: launch.charges.taxBps }).lpFee
          : 0n;
    }

    return {
      route: [
        {
          poolId: pool.id,
          poolType: pool.poolType,
          tokenIn: request.tokenIn,
          tokenOut: request.tokenOut,
          lpFeePips,
          hooks: pool.hooks,
        },
      ],
      amountIn: request.amountIn,
      grossAmountOut: best.amountOut,
      spotAmountOut,
      lpFeeAmount,
      lpFeePips,
      ...(lpFeeUnknown ? { lpFeeUnknown } : {}),
      ...(launch === null ? {} : { launch: launch.charges }),
      estimatedGas: best.gasEstimate,
      source: "live",
    };
  }

  /**
   * What the launch behind `pool` charges a trade paying `tokenIn`, or `null`
   * when the pool's hook is not a configured launch guard.
   *
   * WHO TAKES THE FEE is read from the bitmap in the pool's own key, which is
   * the guard's answer at the pool's birth (core refuses a key that disagrees
   * with its hook). Only a bitmap that is exactly that of a guard taking the fee
   * itself says `"launch"`; every other guard, the older builds included, keeps
   * the treatment it always had.
   *
   * HOW THE FEE IS DIVIDED is asked of such a guard only (`currentFeeParts`):
   * what the pool charges a buy as its own fee and what the guard takes. A guard
   * that does not answer leaves `parts` and `charges.feeParts` `null`: unknown,
   * never a pool's part of zero.
   *
   * A read that REVERTS is "not readable" (an older guard has no tax, an
   * unclaimed pool has no record). Anything else is thrown, as for the fee.
   */
  async #launchCharges(
    pool: PoolInfo,
    tokenIn: TokenInfo,
  ): Promise<{ readonly charges: LaunchCharges; readonly inputIsQuote: boolean; /** Both directions' parts, as read; `null` for a pool whose fee is its own, and when not read. */ readonly parts: GuardFeeParts | null } | null> {
    const guard = this.#guardFor(pool);
    if (guard === null) return null;
    /* A block-numbered build is an older guard: its fee is the pool's, it has no tax to read, and its
       launch record is a different struct, so nothing more is asked of it. */
    if (guard.poolType === "CL" && (await this.#launchClock(guard.hook, "CL")) !== "timestamp") {
      return { charges: { feeTakenBy: "pool", quote: null, taxBps: null }, inputIsQuote: false, parts: null };
    }
    const abi = guard.poolType === "CL" ? LAUNCH_GUARD_HOOK_ABI : BIN_LAUNCH_GUARD_HOOK_ABI;
    /* A contract that refused, or that has no such function (an older guard has no tax): not readable.
       A transport failure is neither, and is thrown. */
    const revertedToNull = async <T>(read: Promise<T>): Promise<T | null> => {
      try {
        return await read;
      } catch (error) {
        if (
          error instanceof BaseError &&
          error.walk((x: unknown) => x instanceof ExecutionRevertedError || x instanceof ContractFunctionRevertedError || x instanceof ContractFunctionZeroDataError) !== null
        ) {
          return null;
        }
        throw error;
      }
    };

    const generation = guardGenerationOfKey(pool.key, guard.poolType === "CL" ? "CL" : "Bin");
    let tokenIs0 = this.#launchTokenIsCurrency0.get(pool.id) ?? null;
    const [record, rates, feeParts] = await Promise.all([
      tokenIs0 !== null ? Promise.resolve(null) : revertedToNull(this.#client.readContract({ address: guard.hook, abi, functionName: "getLaunch", args: [pool.id] })),
      revertedToNull(this.#client.readContract({ address: guard.hook, abi, functionName: "currentTaxRates", args: [pool.id] })),
      /* The fee decays with no transaction, and its parts with it: read every time, like the tax. */
      generation === "quote-fee" ? readGuardFeeParts(this.#client, guard.hook, pool.id).then((r) => r.parts) : Promise.resolve(null),
    ]);
    if (tokenIs0 === null && record !== null && !isAddressEqual(record.owner, NATIVE)) {
      tokenIs0 = record.launchTokenIsCurrency0;
      this.#launchTokenIsCurrency0.set(pool.id, tokenIs0);
    }

    const quote = tokenIs0 === null ? null : tokenIs0 ? pool.token1 : pool.token0;
    const inputIsQuote = quote !== null && isAddressEqual(quote.address, tokenIn.address);
    /* Without the launch's record the direction is unknown, so no rate can be picked for this trade. */
    const taxBps = rates === null || quote === null ? null : Number(inputIsQuote ? rates[0] : rates[1]);
    if (generation !== "quote-fee") return { charges: { feeTakenBy: "pool", quote, taxBps }, inputIsQuote, parts: null };
    /* The same goes for the fee's parts: a buy and a sell are divided differently. */
    const rates_ = feeParts === null || quote === null ? null : guardSwapRates(feeParts, inputIsQuote);
    return {
      charges: { feeTakenBy: "launch", quote, taxBps, feeParts: rates_ === null ? null : { poolPips: rates_.lpPips, launchPips: rates_.guardPips } },
      inputIsQuote,
      parts: quote === null ? null : feeParts,
    };
  }

  /**
   * The most `request.tokenIn` a launch pool can fill now, given that it traded
   * `traded` of its quote currency before running out, or `null`.
   *
   * Sized from the pool's own answer with what the LAUNCH takes added back
   * (`largestExactInputFor`, fed the launch's part of a buy's fee: the pool's own
   * part is charged inside the pool, out of `traded`), then QUOTED: the figure
   * is returned only if the pool does quote it. A number nobody checked is not
   * offered to a trader, and none is sized from a division that was not read.
   */
  async #largestFillable(pool: PoolInfo, request: SwapQuoteRequest, traded: bigint): Promise<bigint | null> {
    if (traded <= 0n) return null;
    try {
      const launch = await this.#launchCharges(pool, request.tokenIn);
      /* Only a buy names its quote amount, and only a launch that takes the fee itself refuses this way. */
      if (launch === null || launch.charges.taxBps === null || !launch.inputIsQuote || launch.charges.feeTakenBy !== "launch" || launch.parts === null) return null;
      const largest = largestExactInputFor({ poolCapacity: traded, feePips: launch.parts.buyGuardPips, taxBps: launch.charges.taxBps });
      if (largest <= 0n || largest >= request.amountIn) return null;
      await this.#client.simulateContract({
        address: (pool.poolType === "CL" ? this.chain.contracts.quoter : this.chain.contracts.binQuoter) as Address,
        abi: quoterAbiFor(pool.poolType),
        functionName: "quoteExactInputSingle",
        args: [{ poolKey: pool.key, zeroForOne: isAddressEqual(pool.key.currency0, request.tokenIn.address), exactAmount: largest, hookData: "0x" }],
      });
      return largest;
    } catch {
      return null;
    }
  }

  /**
   * `currentFee(poolId)` when the pool's hook is one of the configured launch
   * guards; `null` when the hook is not a guard (the fee is then genuinely
   * unreadable in advance). A guard that REVERTS `currentFee` — an unclaimed
   * pool id — is also `null`. Anything else (transport failure, an unknown
   * `CLOCK_MODE`) is thrown: an unreachable RPC is an error state, never a
   * quote annotated "dynamic".
   */
  async #launchGuardFee(pool: PoolInfo): Promise<number | null> {
    const guard = this.#guardFor(pool);
    if (guard === null) return null;
    const abi =
      guard.poolType === "CL" ? launchGuardAbiFor(await this.#launchClock(guard.hook, "CL")) : BIN_LAUNCH_GUARD_HOOK_ABI;
    try {
      const fee = await this.#client.readContract({ address: guard.hook, abi, functionName: "currentFee", args: [pool.id] });
      return Number(fee);
    } catch (error) {
      if (error instanceof BaseError && error.walk((x: unknown) => x instanceof ExecutionRevertedError) !== null) {
        return null;
      }
      throw error;
    }
  }

  /**
   * The currency `token` trades as in `pool`: the chain's wrapped native for the native coin when the pool
   * is quoted in the wrapped native and does not hold the native coin itself (the router wraps / unwraps
   * inside the swap); `token` unchanged otherwise, and always when `contracts.wrappedNative` is unset.
   */
  #poolSide(token: Address, pool: PoolInfo): Address {
    const wrapped = this.chain.contracts.wrappedNative;
    if (wrapped === undefined || !isAddressEqual(token, NATIVE)) return token;
    const holds = (a: Address) => isAddressEqual(pool.token0.address, a) || isAddressEqual(pool.token1.address, a);
    return !holds(NATIVE) && holds(wrapped) ? wrapped : token;
  }

  /** `#poolSide` as the pool's own `TokenInfo`. */
  #poolToken(token: TokenInfo, pool: PoolInfo): TokenInfo {
    const side = this.#poolSide(token.address, pool);
    if (isAddressEqual(side, token.address)) return token;
    return isAddressEqual(pool.token0.address, side) ? pool.token0 : pool.token1;
  }

  /** The configured launch guard this pool names, if any, with the pool type it serves. */
  #guardFor(pool: PoolInfo): { readonly hook: Address; readonly poolType: PoolType } | null {
    /* The current generation, then every retired one: an earlier kit's launch pools trade forever. */
    for (const g of [this.chain.contracts, ...(this.chain.retiredLaunchGenerations ?? [])]) {
      const { launchGuardHook, binLaunchGuardHook } = g;
      if (pool.poolType === "CL" && launchGuardHook !== undefined && isAddressEqual(pool.hooks, launchGuardHook)) {
        return { hook: launchGuardHook, poolType: "CL" };
      }
      if (pool.poolType === "BIN" && binLaunchGuardHook !== undefined && isAddressEqual(pool.hooks, binLaunchGuardHook)) {
        return { hook: binLaunchGuardHook, poolType: "BIN" };
      }
    }
    return null;
  }

  /**
   * `amountIn` priced at the pool's spot from `getSlot0`, net of every charge in
   * `charges` (`core/launchCharges.ts`); `null` when the read fails.
   */
  async #spotAmountOut(
    pool: PoolInfo,
    tokenIn: Address,
    amountIn: bigint,
    charges: {
      readonly feePips: number;
      readonly taxBps: number;
      readonly feeTakenBy: "pool" | "launch";
      readonly inputIsQuote: boolean;
      readonly feeParts?: LaunchCharges["feeParts"];
    },
  ): Promise<bigint | null> {
    /* A buy through a launch whose division of the fee was not read has no reference: say so before reading a price. */
    if (charges.feeTakenBy === "launch" && charges.inputIsQuote && (charges.feeParts ?? null) === null) return null;
    const zeroForOne = isAddressEqual(pool.key.currency0, tokenIn);
    try {
      let atSpot: (amount: bigint) => bigint;
      if (pool.poolType === "CL") {
        const [sqrtPriceX96] = await this.#client.readContract({ address: pool.key.poolManager, abi: CL_SLOT0_ABI, functionName: "getSlot0", args: [pool.id] });
        if (sqrtPriceX96 === 0n) return null;
        const p2 = sqrtPriceX96 * sqrtPriceX96;
        atSpot = (amount) => (zeroForOne ? (amount * p2) / Q192 : (amount * Q192) / p2);
      } else {
        const [activeId] = await this.#client.readContract({ address: pool.key.poolManager, abi: BIN_SLOT0_ABI, functionName: "getSlot0", args: [pool.id] });
        const { binStep } = readBinPoolKeyParameters(pool.key);
        const raw1per0 = binRawPriceFromId(Number(activeId), binStep);
        if (!Number.isFinite(raw1per0) || raw1per0 <= 0) return null;
        /* 1e18-scaled fixed point keeps the bigint arithmetic exact enough for an impact figure. */
        const SCALE = 10n ** 18n;
        const scaled = BigInt(Math.round(raw1per0 * 1e18));
        if (scaled === 0n) return null;
        atSpot = (amount) => (zeroForOne ? (amount * scaled) / SCALE : (amount * SCALE) / scaled);
      }
      return spotAfterCharges({ amountIn, ...charges, atSpot });
    } catch {
      return null;
    }
  }

  async buildSwap(request: SwapExecutionRequest): Promise<WidgetTransactionRequest> {
    const router = requireContract(this.chain, "universalRouter", "execute a swap");
    const account = await this.getAccount();
    if (account === null) throw new WalletNotConnectedError("build a swap");

    const hops = this.#resolveHops(request);
    const first = hops[0];
    const last = hops[hops.length - 1];
    const wrappedNative = this.chain.contracts.wrappedNative;
    /* The native coin in or out of a route whose ends are the wrapped native: wrap / unwrap in the same transaction. */
    const nativeSide = (token: TokenInfo) => token.isNative === true || isAddressEqual(token.address, NATIVE);
    const wrapInput = wrappedNative !== undefined && first !== undefined && nativeSide(request.tokenIn) && isAddressEqual(first.currencyIn, wrappedNative);
    const unwrapOutput = wrappedNative !== undefined && last !== undefined && nativeSide(request.tokenOut) && isAddressEqual(last.currencyOut, wrappedNative);
    const call = buildSwapCall({
      router,
      hops,
      amountIn: request.amountIn,
      minAmountOutGross: request.minAmountOutGross,
      minAmountOutNet: request.minAmountOutNet,
      expectedAmountOutGross: request.quote.grossAmountOut,
      integrator: request.integrator,
      recipient: request.recipient,
      sender: account,
      deadline: request.deadline,
      ...(wrapInput || unwrapOutput ? { wrapInput, unwrapOutput, wrappedNative } : {}),
      ...(request.permit === undefined ? {} : { permit: request.permit }),
    });
    /* The bytes about to reach the wallet are decoded and checked against the trade the user saw: the SDK's
       verifySwapCalldata, the same check every router-API transaction passes. An integrator fee pays the
       host's referrer, a third party to that check by design, so such a build is covered by its encoder's
       own tests instead. */
    if (!request.integrator.active) {
      verifySwapCalldata("universal-router", call, {
        tokenIn: nativeSide(request.tokenIn) ? NATIVE : request.tokenIn.address,
        tokenOut: nativeSide(request.tokenOut) ? NATIVE : request.tokenOut.address,
        amountIn: request.amountIn,
        recipient: request.recipient,
        minAmountOut: request.minAmountOutNet,
        deadline: Number(request.deadline),
        ...(wrappedNative === undefined ? {} : { wrappedNative }),
      });
    }

    return {
      to: call.to,
      data: call.data,
      value: call.value,
      summary: `Swap ${request.tokenIn.symbol} for ${request.tokenOut.symbol}`,
      ...(call.integratorFee
        ? {
            integratorFee: {
              referrer: call.integratorFee.referrer,
              feeBps: call.integratorFee.feeBps,
              currency: call.integratorFee.currency,
              expectedAmount: call.integratorFee.expectedAmount,
            },
          }
        : {}),
      source: "live",
    };
  }

  #resolveHops(request: SwapExecutionRequest): readonly SwapHop[] {
    const override = this.#overrides.findRoute;
    if (override !== undefined) {
      return override(request.tokenIn, request.tokenOut, this.#options.pools);
    }
    const hops: SwapHop[] = [];
    for (const step of request.quote.route) {
      const pool = this.#options.pools.find((candidate) => candidate.id === step.poolId);
      if (pool === undefined) {
        throw new UnsupportedOperationError(
          "buildSwap",
          `the quote routes through pool ${step.poolId}, which is not in the configured pool list`,
        );
      }
      hops.push({
        poolKey: pool.key,
        poolType: pool.poolType,
        currencyIn: this.#poolSide(step.tokenIn.address, pool),
        currencyOut: this.#poolSide(step.tokenOut.address, pool),
        ...(request.hookData ? { hookData: request.hookData } : {}),
      });
    }
    return hops;
  }

  /**
   * Turns desired amounts into the liquidity the pool will mint and the
   * amounts it will pull, from live state and the pool's own formulas
   * (`core/clMath.ts`; `adapters/binDistribution.ts`). The amounts reported
   * are what the position manager settles: an add rounds towards the pool.
   */
  async quoteAddLiquidity(request: AddLiquidityQuoteRequest): Promise<AddLiquidityQuote> {
    const override = this.#overrides.quoteAddLiquidity;
    if (override !== undefined) return override(request);
    const { pool, range } = request;
    if (range.type === "CL") {
      if (pool.poolType !== "CL") {
        throw new UnsupportedOperationError("quoteAddLiquidity", "tick range given for a bin pool");
      }
      const spacing = tickSpacingOf(pool);
      if (range.tickLower % spacing !== 0 || range.tickUpper % spacing !== 0) {
        throw new RangeError(
          `[@gullylabs/core-widgets] ticks must be multiples of the pool's spacing ${spacing}: [${range.tickLower}, ${range.tickUpper}]`,
        );
      }
      const state = await this.getPoolState(pool);
      const sqrtPriceX96 = state.sqrtPriceX96 as bigint;
      const liquidity = getLiquidityForAmounts(
        sqrtPriceX96,
        getSqrtRatioAtTick(range.tickLower),
        getSqrtRatioAtTick(range.tickUpper),
        request.amount0Desired,
        request.amount1Desired,
      );
      if (liquidity === 0n) {
        throw new UnsupportedOperationError(
          "quoteAddLiquidity",
          "these amounts mint no liquidity in this range: at the pool's price the range needs the other token, or the amounts are too small",
        );
      }
      const amounts = amountsForLiquidity(sqrtPriceX96, range.tickLower, range.tickUpper, liquidity, true);
      const inRange = (state.currentTick as number) >= range.tickLower && (state.currentTick as number) < range.tickUpper;
      const poolLiquidity = state.liquidity ?? 0n;
      const shareBps = inRange ? Number((liquidity * 10_000n) / (poolLiquidity + liquidity)) : null;
      return { pool, range, amount0: amounts.amount0, amount1: amounts.amount1, liquidity, shareBps, source: "live" };
    }
    if (pool.poolType !== "BIN") {
      throw new UnsupportedOperationError("quoteAddLiquidity", "bin range given for a CL pool");
    }
    const state = await this.getPoolState(pool);
    const activeId = state.activeId as number;
    if (Math.abs(activeId - range.activeIdDesired) > range.idSlippage) {
      throw new UnsupportedOperationError(
        "quoteAddLiquidity",
        `the active bin is ${activeId}, more than ${range.idSlippage} bins from the ${range.activeIdDesired} the range was built around; rebuild the range`,
      );
    }
    const distribution = buildUniformBinDistribution(range.binIdLower, range.binIdUpper, range.activeIdDesired);
    const takesX = distribution.some((share) => share.distributionX > 0n);
    const takesY = distribution.some((share) => share.distributionY > 0n);
    const amount0 = takesX ? request.amount0Desired : 0n;
    const amount1 = takesY ? request.amount1Desired : 0n;
    if (amount0 + amount1 === 0n) {
      throw new UnsupportedOperationError(
        "quoteAddLiquidity",
        "nothing to deposit: the chosen bins take only the token whose amount is zero",
      );
    }
    /* Bin shares are minted per bin from the deposit's value in that bin; the
       total is not a single figure the way CL liquidity is. Reported as the
       sum of what the distribution places, in currency1 units at each bin's
       price, which is what `BinPool.mint` credits. */
    const binStep = binStepOf(pool);
    let liquidity = 0n;
    for (const share of distribution) {
      const x = (amount0 * share.distributionX) / 10n ** 18n;
      const y = (amount1 * share.distributionY) / 10n ** 18n;
      const price = binRawPriceFromId(share.binId, binStep);
      liquidity += BigInt(Math.floor(Number(x) * price)) + y;
    }
    return { pool, range, amount0, amount1, liquidity, shareBps: null, binDistribution: distribution, source: "live" };
  }

  async buildAddLiquidity(
    request: AddLiquidityExecutionRequest,
  ): Promise<WidgetTransactionRequest> {
    const account = await this.getAccount();
    if (account === null) throw new WalletNotConnectedError("add liquidity");
    const { quote } = request;
    const nativeValue = this.#nativeValueFor(quote.pool, request.amount0Max, request.amount1Max);

    if (quote.range.type === "CL") {
      const positionManager = requireContract(
        this.chain,
        "clPositionManager",
        "mint a concentrated-liquidity position",
      );
      const call = buildCLMintCall({
        positionManager,
        poolKey: quote.pool.key,
        tickLower: quote.range.tickLower,
        tickUpper: quote.range.tickUpper,
        liquidity: quote.liquidity,
        amount0Max: request.amount0Max,
        amount1Max: request.amount1Max,
        owner: request.recipient,
        deadline: request.deadline,
        value: nativeValue,
        ...(request.hookData ? { hookData: request.hookData } : {}),
      });
      return {
        to: call.to,
        data: call.data,
        value: call.value,
        summary: `Add liquidity to ${quote.pool.token0.symbol}/${quote.pool.token1.symbol}`,
        source: "live",
      };
    }

    const positionManager = requireContract(
      this.chain,
      "binPositionManager",
      "add liquidity to a bin pool",
    );
    const distribution = quote.binDistribution;
    if (distribution === undefined || distribution.length === 0) {
      throw new UnsupportedOperationError(
        "buildAddLiquidity",
        "a bin mint needs a per-bin distribution; the quote did not supply one",
      );
    }
    const call = buildBinAddCall({
      positionManager,
      poolKey: quote.pool.key,
      amount0: quote.amount0,
      amount1: quote.amount1,
      amount0Max: request.amount0Max,
      amount1Max: request.amount1Max,
      activeIdDesired: quote.range.activeIdDesired,
      idSlippage: quote.range.idSlippage,
      deltaIds: distribution.map((share) => share.deltaId),
      distributionX: distribution.map((share) => share.distributionX),
      distributionY: distribution.map((share) => share.distributionY),
      to: request.recipient,
      deadline: request.deadline,
      value: nativeValue,
      ...(request.hookData ? { hookData: request.hookData } : {}),
    });
    return {
      to: call.to,
      data: call.data,
      value: call.value,
      summary: `Add liquidity to ${quote.pool.token0.symbol}/${quote.pool.token1.symbol}`,
      source: "live",
    };
  }

  #nativeValueFor(pool: PoolInfo, amount0Max: bigint, amount1Max: bigint): bigint {
    if (isAddressEqual(pool.token0.address, NATIVE)) return amount0Max;
    if (isAddressEqual(pool.token1.address, NATIVE)) return amount1Max;
    return 0n;
  }

  /**
   * A holder's positions, reconstructed from position-manager logs and
   * confirmed against live state. Needs `positionsFromBlock`.
   *
   * CL: `Transfer(to = owner)` candidates, each confirmed by `ownerOf`, then
   * `positions(tokenId)` for the key, ticks and liquidity; amounts and fees
   * from the pool's slot0, tick info and fee-growth globals, exactly as the
   * pool would credit them. Bin: `TransferBatch(to = owner)` candidates, each
   * confirmed by `balanceOf`, grouped by pool; amounts from each bin's
   * reserves and share supply. A position on a pool not in the configured
   * list still appears, with its tokens read off their contracts.
   */
  async listPositions(owner: Address, pool?: PoolInfo): Promise<readonly PositionInfo[]> {
    const override = this.#overrides.listPositions;
    if (override !== undefined) return override(owner, pool);
    const fromBlock = this.#options.positionsFromBlock;
    if (fromBlock === undefined) {
      throw new UnsupportedOperationError(
        "listPositions",
        "position enumeration scans the position managers' transfer logs and needs " +
          "`positionsFromBlock` (the block they were deployed at) in the adapter options.",
      );
    }
    const wanted = pool?.poolType;
    const [cl, bin] = await Promise.all([
      wanted === "BIN" ? Promise.resolve([]) : this.#listCLPositions(owner, fromBlock, pool),
      wanted === "CL" ? Promise.resolve([]) : this.#listBinPositions(owner, fromBlock, pool),
    ]);
    return [...cl, ...bin];
  }

  async #listCLPositions(owner: Address, fromBlock: bigint, only?: PoolInfo): Promise<readonly PositionInfo[]> {
    const positionManager = this.chain.contracts.clPositionManager;
    if (positionManager === undefined) return [];
    const logs = await this.#client.getLogs({
      address: positionManager,
      event: CL_POSM_VIEWS_ABI[2],
      args: { to: owner },
      fromBlock,
      toBlock: "latest",
    });
    const candidates = [...new Set(logs.map((log) => log.args.id as bigint))];
    const out: PositionInfo[] = [];
    for (const tokenId of candidates) {
      let holder: Address;
      try {
        holder = await this.#client.readContract({ address: positionManager, abi: CL_POSM_VIEWS_ABI, functionName: "ownerOf", args: [tokenId] });
      } catch {
        continue; // burned
      }
      if (!isAddressEqual(holder, owner)) continue;
      const [key, tickLower, tickUpper, liquidity, feeGrowthInside0Last, feeGrowthInside1Last] = await this.#client.readContract({
        address: positionManager,
        abi: CL_POSM_VIEWS_ABI,
        functionName: "positions",
        args: [tokenId],
      });
      const poolInfo = await this.#poolInfoFor(key, "CL", only);
      if (poolInfo === null) continue;
      const [[sqrtPriceX96, currentTick], [feeGrowthGlobal0, feeGrowthGlobal1], lower, upper] = await Promise.all([
        this.#client.readContract({ address: key.poolManager, abi: CL_SLOT0_ABI, functionName: "getSlot0", args: [poolInfo.id] }),
        this.#client.readContract({ address: key.poolManager, abi: CL_POOL_VIEWS_ABI, functionName: "getFeeGrowthGlobals", args: [poolInfo.id] }),
        this.#client.readContract({ address: key.poolManager, abi: CL_POOL_VIEWS_ABI, functionName: "getPoolTickInfo", args: [poolInfo.id, tickLower] }),
        this.#client.readContract({ address: key.poolManager, abi: CL_POOL_VIEWS_ABI, functionName: "getPoolTickInfo", args: [poolInfo.id, tickUpper] }),
      ]);
      const amounts = amountsForLiquidity(sqrtPriceX96, tickLower, tickUpper, liquidity, false);
      const fees = uncollectedFees({
        liquidity,
        tickLower,
        tickUpper,
        currentTick,
        feeGrowthGlobal0X128: feeGrowthGlobal0,
        feeGrowthGlobal1X128: feeGrowthGlobal1,
        lower,
        upper,
        feeGrowthInside0LastX128: feeGrowthInside0Last,
        feeGrowthInside1LastX128: feeGrowthInside1Last,
      });
      out.push({
        id: `cl:${tokenId}`,
        tokenId,
        pool: poolInfo,
        range: { type: "CL", tickLower, tickUpper },
        liquidity,
        amount0: amounts.amount0,
        amount1: amounts.amount1,
        feesOwed0: fees.fees0,
        feesOwed1: fees.fees1,
        inRange: currentTick >= tickLower && currentTick < tickUpper,
        source: "live",
      });
    }
    return out;
  }

  async #listBinPositions(owner: Address, fromBlock: bigint, only?: PoolInfo): Promise<readonly PositionInfo[]> {
    const positionManager = this.chain.contracts.binPositionManager;
    if (positionManager === undefined) return [];
    const logs = await this.#client.getLogs({
      address: positionManager,
      event: BIN_POSM_VIEWS_ABI[2],
      args: { to: owner },
      fromBlock,
      toBlock: "latest",
    });
    const candidates = [...new Set(logs.flatMap((log) => (log.args.ids ?? []) as readonly bigint[]))];
    /* Group the held bins by pool. */
    const byPool = new Map<string, { key: PoolKey; bins: { binId: number; shares: bigint }[] }>();
    for (const tokenId of candidates) {
      const shares = await this.#client.readContract({ address: positionManager, abi: BIN_POSM_VIEWS_ABI, functionName: "balanceOf", args: [owner, tokenId] });
      if (shares === 0n) continue;
      const [key, binId] = await this.#client.readContract({ address: positionManager, abi: BIN_POSM_VIEWS_ABI, functionName: "positions", args: [tokenId] });
      const id = poolKeyToId(key);
      const entry = byPool.get(id) ?? { key, bins: [] };
      entry.bins.push({ binId, shares });
      byPool.set(id, entry);
    }
    const out: PositionInfo[] = [];
    for (const [poolId, { key, bins }] of byPool) {
      const poolInfo = await this.#poolInfoFor(key, "BIN", only);
      if (poolInfo === null) continue;
      const [activeId] = await this.#client.readContract({ address: key.poolManager, abi: BIN_SLOT0_ABI, functionName: "getSlot0", args: [poolId as PoolId] });
      let amount0 = 0n;
      let amount1 = 0n;
      let liquidity = 0n;
      const sortedBins = [...bins].sort((a, b) => a.binId - b.binId);
      for (const bin of sortedBins) {
        const [reserveX, reserveY, , totalShares] = await this.#client.readContract({
          address: key.poolManager,
          abi: BIN_POOL_VIEWS_ABI,
          functionName: "getBin",
          args: [poolId as PoolId, bin.binId],
        });
        const amounts = binShareAmounts({ shares: bin.shares, totalShares, reserveX, reserveY });
        amount0 += amounts.amount0;
        amount1 += amounts.amount1;
        liquidity += bin.shares;
      }
      const first = sortedBins[0] as { binId: number };
      const last = sortedBins[sortedBins.length - 1] as { binId: number };
      out.push({
        id: `bin:${poolId}`,
        pool: poolInfo,
        range: { type: "BIN", activeIdDesired: activeId, binIdLower: first.binId, binIdUpper: last.binId, idSlippage: 0 },
        liquidity,
        amount0,
        amount1,
        /* Bin fees compound into the bins' reserves; they are inside amount0/amount1, never a separate figure. */
        feesOwed0: 0n,
        feesOwed1: 0n,
        binAmounts: sortedBins.map((bin) => ({ binId: bin.binId, amount: bin.shares })),
        inRange: sortedBins.some((bin) => bin.binId === activeId),
        source: "live",
      });
    }
    return out;
  }

  /**
   * The `PoolInfo` for a position's key: the configured one when the pool is
   * listed, else one built from the key with both tokens read off their
   * contracts. `null` when `only` names a different pool.
   */
  async #poolInfoFor(key: PoolKey, poolType: PoolType, only?: PoolInfo): Promise<PoolInfo | null> {
    const id = poolKeyToId(key);
    if (only !== undefined) return only.id.toLowerCase() === id.toLowerCase() ? only : null;
    const listed = this.#options.pools.find((candidate) => candidate.id.toLowerCase() === id.toLowerCase());
    if (listed !== undefined) return listed;
    const [token0, token1] = await Promise.all([this.getToken(key.currency0), this.getToken(key.currency1)]);
    if (token0 === null || token1 === null) return null;
    const granularity =
      poolType === "CL" ? { tickSpacing: readCLPoolKeyParameters(key).tickSpacing } : { binStep: readBinPoolKeyParameters(key).binStep };
    return { id, key, poolType, token0, token1, lpFeePips: key.fee, hooks: key.hooks, ...granularity };
  }

  /**
   * What withdrawing `percentBps` of a position returns as PRINCIPAL, rounded
   * down as the pool rounds a burn. A CL decrease also pays out the position's
   * uncollected fees (`feesOwed0/1` on the position); they are not in these
   * figures because the position manager's minimum-out check is on the
   * principal alone, and a floor that counted fees could revert an honest
   * withdrawal.
   */
  async quoteRemoveLiquidity(position: PositionInfo, percentBps: number): Promise<RemoveLiquidityQuote> {
    const override = this.#overrides.quoteRemoveLiquidity;
    if (override !== undefined) return override(position, percentBps);
    if (!Number.isInteger(percentBps) || percentBps <= 0 || percentBps > 10_000) {
      throw new RangeError(`[@gullylabs/core-widgets] percentBps must be an integer in (0, 10000]: ${percentBps}`);
    }
    const { pool } = position;
    if (position.range.type === "CL") {
      const state = await this.getPoolState(pool);
      const liquidity = (position.liquidity * BigInt(percentBps)) / 10_000n;
      const amounts = amountsForLiquidity(state.sqrtPriceX96 as bigint, position.range.tickLower, position.range.tickUpper, liquidity, false);
      return { position, percentBps, amount0: amounts.amount0, amount1: amounts.amount1, source: "live" };
    }
    const held = position.binAmounts ?? [];
    let amount0 = 0n;
    let amount1 = 0n;
    for (const bin of held) {
      const [reserveX, reserveY, , totalShares] = await this.#client.readContract({
        address: pool.key.poolManager,
        abi: BIN_POOL_VIEWS_ABI,
        functionName: "getBin",
        args: [pool.id, bin.binId],
      });
      const amounts = binShareAmounts({ shares: (bin.amount * BigInt(percentBps)) / 10_000n, totalShares, reserveX, reserveY });
      amount0 += amounts.amount0;
      amount1 += amounts.amount1;
    }
    return { position, percentBps, amount0, amount1, source: "live" };
  }

  async buildRemoveLiquidity(
    request: RemoveLiquidityExecutionRequest,
  ): Promise<WidgetTransactionRequest> {
    const account = await this.getAccount();
    if (account === null) throw new WalletNotConnectedError("remove liquidity");
    const { position } = request;

    if (position.range.type === "CL") {
      const positionManager = requireContract(
        this.chain,
        "clPositionManager",
        "decrease a concentrated-liquidity position",
      );
      if (position.tokenId === undefined) {
        throw new UnsupportedOperationError(
          "buildRemoveLiquidity",
          "a CL position must carry its ERC-721 tokenId",
        );
      }
      const liquidity = (position.liquidity * BigInt(request.percentBps)) / 10_000n;
      const call = buildCLDecreaseCall({
        positionManager,
        poolKey: position.pool.key,
        tokenId: position.tokenId,
        liquidity,
        amount0Min: request.amount0Min,
        amount1Min: request.amount1Min,
        recipient: request.recipient,
        owner: account,
        deadline: request.deadline,
        ...(request.hookData ? { hookData: request.hookData } : {}),
      });
      return {
        to: call.to,
        data: call.data,
        value: call.value,
        summary: `Remove ${request.percentBps / 100}% of position #${position.tokenId}`,
        source: "live",
      };
    }

    const positionManager = requireContract(
      this.chain,
      "binPositionManager",
      "remove liquidity from a bin pool",
    );
    const binAmounts = position.binAmounts;
    if (binAmounts === undefined || binAmounts.length === 0) {
      throw new UnsupportedOperationError(
        "buildRemoveLiquidity",
        "a bin burn needs the per-bin share amounts held by the position",
      );
    }
    const call = buildBinRemoveCall({
      positionManager,
      poolKey: position.pool.key,
      amount0Min: request.amount0Min,
      amount1Min: request.amount1Min,
      ids: binAmounts.map((entry) => entry.binId),
      amounts: binAmounts.map(
        (entry) => (entry.amount * BigInt(request.percentBps)) / 10_000n,
      ),
      from: account,
      recipient: request.recipient,
      deadline: request.deadline,
      ...(request.hookData ? { hookData: request.hookData } : {}),
    });
    return {
      to: call.to,
      data: call.data,
      value: call.value,
      summary: `Remove ${request.percentBps / 100}% of a bin position`,
      source: "live",
    };
  }

  /**
   * Requires at least one launch guard. A chain with neither is "no launchpad
   * here", signalled the way every missing contract is: `ChainConfigError`
   * naming `launchGuardHook`, which `isLaunchpadNotConfigured` recognises.
   */
  #requireAnyGuard(usedFor: string): void {
    const { launchGuardHook, binLaunchGuardHook } = this.chain.contracts;
    if (launchGuardHook === undefined && binLaunchGuardHook === undefined) {
      requireContract(this.chain, "launchGuardHook", usedFor);
    }
  }

  /**
   * Every configured pool whose key names one of the chain's launch guards:
   * CL pools naming `launchGuardHook`, Bin pools naming `binLaunchGuardHook`.
   *
   * There is no on-chain enumeration of launches any more than there is of
   * pools, so the candidate set is the pool list the host supplied. Throws
   * `ChainConfigError` when no guard address is configured, which is how a
   * caller distinguishes "no launchpad on this chain" from "no launches yet".
   */
  async listLaunches(): Promise<readonly LaunchInfo[]> {
    this.#requireAnyGuard("read a launch schedule");
    const candidates = this.#options.pools.filter((pool) => this.#guardFor(pool) !== null);
    const launches = await Promise.all(candidates.map((pool) => this.#readLaunch(pool)));
    return launches.filter((launch): launch is LaunchInfo => launch !== null);
  }

  async getLaunch(poolId: PoolId): Promise<LaunchInfo | null> {
    this.#requireAnyGuard("read a launch schedule");
    const pool = this.#options.pools.find((candidate) => candidate.id === poolId);
    if (pool === undefined) {
      throw new UnsupportedOperationError(
        "getLaunch",
        `pool ${poolId} is not in the configured pool list. The singleton has no pool ` +
          "enumeration, so the widget can only read pools the host declared.",
      );
    }
    if (this.#guardFor(pool) === null) return null;
    return this.#readLaunch(pool);
  }

  /**
   * The pools a `LaunchpadKitV2` launch opened for `token`, read from the kit's
   * `legsOf(token)` and then from the guards, in leg order.
   *
   * Every leg's pool must be in the host's pool list — the kit knows the ids,
   * not the keys, and a pool the host has not declared cannot be quoted or
   * swapped through anyway. A missing one is an error naming the id, not a
   * shorter list.
   */
  async getLaunchesForToken(token: Address): Promise<readonly LaunchInfo[]> {
    const current = requireContract(this.chain, "launchpadKitV2", "look a launch up by its token");
    /* The current kit first, then each retired one: a token was launched on exactly one of them. */
    const kits = [current, ...(this.chain.retiredLaunchGenerations ?? []).flatMap((g) => (g.launchpadKitV2 === undefined ? [] : [g.launchpadKitV2]))];
    let poolIds: readonly `0x${string}`[] = [];
    for (const kit of kits) {
      poolIds = await this.#client.readContract({
        address: kit,
        abi: LAUNCHPAD_KIT_V2_ABI,
        functionName: "legsOf",
        args: [token],
      });
      if (poolIds.length > 0) break;
    }
    if (poolIds.length === 0) return [];
    const missing = poolIds.filter((id) => this.#options.pools.every((pool) => pool.id !== id));
    if (missing.length > 0) {
      throw new UnsupportedOperationError(
        "getLaunchesForToken",
        `the kit lists ${poolIds.length} pool(s) for ${token} but ${missing.length} of them ` +
          `(${missing.join(", ")}) are not in the configured pool list. Declare them (the pool ` +
          "manager's Initialize log carries the key) so the widget can read and route through them.",
      );
    }
    const unguarded = poolIds.filter((id) => {
      const pool = this.#options.pools.find((candidate) => candidate.id === id) as PoolInfo;
      return this.#guardFor(pool) === null;
    });
    if (unguarded.length > 0) {
      throw new UnsupportedOperationError(
        "getLaunchesForToken",
        `${unguarded.length} of the kit's pools for ${token} (${unguarded.join(", ")}) name a launch guard ` +
          "this chain config does not declare. Set `contracts.launchGuardHook` (CL) and " +
          "`contracts.binLaunchGuardHook` (Bin) to the kit's guards; a launch cannot be shown with a leg missing.",
      );
    }
    const launches = await Promise.all(
      poolIds.map(async (id) => {
        const pool = this.#options.pools.find((candidate) => candidate.id === id) as PoolInfo;
        const launch = await this.#readLaunch(pool);
        if (launch === null) {
          // The kit only records legs it configured itself, so an unclaimed guard record here
          // means the guard and the kit disagree - say so rather than drop the leg.
          throw new UnsupportedOperationError(
            "getLaunchesForToken",
            `the kit lists pool ${id} for ${token} but its guard has no launch record for it`,
          );
        }
        return launch;
      }),
    );
    return launches;
  }

  /**
   * Which generation a launch hook is, by configuration first, then the SDK
   * address book, then the hook's own `CLOCK_MODE()` (a revert means the
   * block-numbered build). A transport failure throws; it is never a revert.
   */
  async #launchClock(hook: Address, poolType: PoolType = "CL"): Promise<DurationClock> {
    if (poolType === "CL") {
      const configured = this.chain.contracts.launchGuardHookClock;
      if (configured !== undefined) return configured;
    }
    const deployment = getDeployment(this.chain.chainId);
    if (poolType === "CL" && deployment?.launchGuardHook && isAddressEqual(deployment.launchGuardHook, hook)) {
      const clock = deployment.durationClocks.launchGuardHook;
      if (clock !== null) return clock;
    }
    /* Every kit v2 guard, current or retired, is timestamp-clocked. */
    for (const v2 of deployment === undefined ? [] : [deployment.launchpadV2, ...(deployment.launchpadV2Retired ?? [])]) {
      const known = poolType === "CL" ? v2.clLaunchGuardHook : v2.binLaunchGuardHook;
      if (known !== null && isAddressEqual(known, hook)) return "timestamp";
    }
    for (const g of this.chain.retiredLaunchGenerations ?? []) {
      const known = poolType === "CL" ? g.launchGuardHook : g.binLaunchGuardHook;
      if (known !== undefined && isAddressEqual(known, hook)) return "timestamp";
    }
    try {
      const { data } = await this.#client.call({ to: hook, data: CLOCK_MODE_CALLDATA });
      if (data === undefined || data === "0x") return "contract-block";
      const [mode] = decodeAbiParameters([{ type: "string" }], data);
      if (mode === TIMESTAMP_CLOCK_MODE) return "timestamp";
      throw new UnsupportedOperationError("getLaunch", `hook ${hook} reports an unknown CLOCK_MODE "${mode}"`);
    } catch (error) {
      if (error instanceof BaseError && error.walk((x: unknown) => x instanceof ExecutionRevertedError) !== null) {
        return "contract-block";
      }
      throw error;
    }
  }

  async #readLaunch(pool: PoolInfo): Promise<LaunchInfo | null> {
    const bound = this.#guardFor(pool);
    if (bound === null) return null;
    const hook = bound.hook;
    const durationClock = await this.#launchClock(hook, bound.poolType);
    if (bound.poolType === "BIN" && durationClock !== "timestamp") {
      throw new UnsupportedOperationError(
        "getLaunch",
        `BinLaunchGuardHook ${hook} answers as a block-numbered build; no such build exists, so this is not a Bin launch guard.`,
      );
    }
    /* Both guards return the same `Launch` struct; the Bin ABI is the timestamp shape. */
    const abi = bound.poolType === "CL" ? launchGuardAbiFor(durationClock) : BIN_LAUNCH_GUARD_HOOK_ABI;
    const raw = await this.#client.readContract({
      address: hook,
      abi,
      functionName: "getLaunch",
      args: [pool.id],
    });
    const guard = decodeLaunchGuard(raw as unknown as RawLaunchGuard, durationClock);
    if (!isLaunchConfigured(guard)) return null;

    const [currentFeePips, clock] = await Promise.all([
      this.#client.readContract({
        address: hook,
        abi,
        functionName: "currentFee",
        args: [pool.id],
      }),
      /* "Now" on the HOOK's clock. The timestamp build compares with
         block.timestamp. The block-numbered build compares with the EVM's
         block.number, which on an Arbitrum Nitro chain is
         Ethereum's block number while the RPC head is the L2 block; against
         the RPC head every unopened launch rendered as settled. */
      readContractClock(this.#client, this.chain.chainId),
    ]);
    const readAt = durationClock === "timestamp" ? clock.timestamp : clock.contractBlockNumber;

    const [launchToken, quoteToken] = guard.launchTokenIsCurrency0
      ? [pool.token0, pool.token1]
      : [pool.token1, pool.token0];

    return {
      poolId: pool.id,
      pool,
      hook,
      launchToken,
      quoteToken,
      guard,
      currentFeePips: Number(currentFeePips),
      readAt,
      source: "live",
    };
  }

  async sendTransaction(request: WidgetTransactionRequest): Promise<Hex> {
    const wallet = this.#options.wallet;
    if (wallet === undefined) throw new WalletNotConnectedError("send a transaction");
    return wallet.sendTransaction({
      to: request.to,
      data: request.data,
      value: request.value,
    });
  }

  /**
   * The clock the next block will carry, as closely as the RPC can say: the
   * later of the PENDING block's timestamp (anvil and geth-style nodes compute
   * the next block's; an RPC without one refuses or echoes the latest) and the
   * latest block's. See `nextBlockClock` for why the pending read matters.
   */
  async getBlockTimestamp(): Promise<bigint> {
    const [pending, latest] = await Promise.allSettled([
      this.#client.getBlock({ blockTag: "pending" }),
      this.#client.getBlock({ blockTag: "latest" }),
    ]);
    const clock = nextBlockClock(
      pending.status === "fulfilled" ? pending.value.timestamp : null,
      latest.status === "fulfilled" ? latest.value.timestamp : null,
    );
    if (clock === null) throw latest.status === "rejected" ? latest.reason : new Error("no block timestamp could be read");
    return clock;
  }

  async waitForTransaction(hash: Hex): Promise<TransactionOutcome> {
    const receipt = await this.#client.waitForTransactionReceipt({ hash });
    return {
      hash,
      status: receipt.status === "success" ? "success" : "reverted",
      blockNumber: receipt.blockNumber,
      source: "live",
    };
  }
}

/** Creates the live, viem-backed adapter. */
export function createViemAdapter(options: ViemAdapterOptions): ProtocolAdapter {
  return new ViemProtocolAdapter(options);
}
