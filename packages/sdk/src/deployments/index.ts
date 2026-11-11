// SPDX-License-Identifier: MIT
/* ============================================================================
   THE GULLY CORE ADDRESS BOOK — one file, every deployed contract, per chain.

   WHY THIS LIVES IN THE SDK AND NOWHERE ELSE
   ------------------------------------------
   An address table is the first thing an integrator needs and the last thing
   they should have to type. Before this module the SDK shipped ABIs, event
   decoders and a probed RPC list but not a single address, so "simple
   integration" still began with hand-copying twenty hex strings out of a
   markdown file — and every consumer that did so became another place the
   truth could rot.

   It had already started. the Gully Core app carried one copy and
   `packages/create-gully-core-app/template/src/config/deployments.ts` a second, and
   the two had ALREADY diverged: the web copy knows the timelocks, the fee
   controller, the quoters and the position descriptor; the template copy does
   not. Neither was wrong, which is exactly the problem — two partial tables
   with no way to tell which one is behind. The DefiLlama adapters in this repo
   went the other way, two hand-maintained mirrors with a parity test bolted on
   to catch drift, and a parity test is a smoke alarm, not a fix. This module is
   the fix: both of those files now RE-EXPORT this one.

   Addresses and ABIs are facts about a public chain, not derivative works of
   the GPL contracts that produced them. Nothing here imports from
   `packages/core`, `periphery`, `router` or any hook package, so a third-party
   hook author can build against this MIT package without ever touching GPL
   code. Every value entered below must be an address READ BACK off chain
   after deployment, never one copied from a script's log.

   NULL MEANS NOT DEPLOYED. IT NEVER MEANS ZERO.
   ---------------------------------------------
   Every address field that can be absent is typed `Address | null`, and absent
   is written `null`. The zero address is not used as a placeholder anywhere in
   this file and must never be introduced: `0x000...000` is a value a caller
   will happily pass to `readContract`, `getCode` or a swap path, where it
   silently returns empty rather than failing. `null` cannot be called. It
   forces the consumer to branch, which is the whole point — the honest render
   for a contract that does not exist yet is "not configured on this chain",
   not a read against nothing.

   So: `deployment.launchpadKit === null` is a complete, checkable answer.
   `requireContract(deployment, "launchpadKit")` is the other half, for call
   sites that genuinely cannot proceed without it and would rather throw a
   sentence than a stack trace from viem.

   SOME OF THESE ADDRESSES WILL CHANGE
   -----------------------------------
   Registries, hooks and timelocks get redeployed with fixes, and later
   contracts land after the core. That is the normal state of an address book,
   not an exception to plan around, so the shape is chosen for it:

     * ONE edit, in ONE file, per redeploy. Nothing downstream restates an
       address; the Gully Core app and the `create-gully-core-app` template both import.
     * `REDEPLOYABLE_CONTRACTS` names the keys whose address is a moving target,
       because the failure mode of a stale one is silent. A retired
       `GullyCoreRegistry` still answers `gullycoreCount()` with a number and renders as
       a healthy, empty marketplace, because a retired registry still responds
       after nothing reads it any more. A stale Vault, by contrast, cannot
       happen: it is immutable and permanent.

   DECIMALS ARE PART OF THE ADDRESS BOOK, NOT AN AFTERTHOUGHT
   ----------------------------------------------------------
   A USD stablecoin is commonly 6 decimals and WETH9 is 18. `sqrtPriceX96` encodes a
   price as a ratio of RAW units, so a hardcoded 18 against a 6-decimal quote is
   wrong by 10^12 — that is a pool opened at a million times the intended price,
   fixed permanently at `initialize`. This repo has already caught that trap
   twice (see the Arc note in `chains/endpoints.ts`, and `lib/swap.ts`). A token
   listed here therefore ALWAYS carries its decimals, and a token whose decimals
   nobody has read off its own contract does not get listed.

   The table is still a claim, not a proof. `decimals()` on the live contract is
   the proof, and anything pricing a pool should read it — `npm run gullycore:verify`
   in the scaffolded app does exactly that for every address and token here.

   ADDING A CHAIN IS A DATA CHANGE, NOT A CODE CHANGE
   --------------------------------------------------
   One object literal in `DEPLOYMENTS_TABLE` below is the whole edit. Nothing
   restates the chain list: `GullyCoreChainId`, `GullyCoreChainKey`, `GULLYCORE_CHAIN_IDS`,
   `GULLYCORE_MAINNET_CHAIN_IDS`, `NATIVE_CURRENCY` and `isGullyCoreChainId` are all
   DERIVED from that table's keys. Restating a chain list by hand means a new
   chain edits a union type, an array, a map and a function body, any one of
   which can be missed while the other three compile fine.

   What the compiler still enforces, and should: every field typed `Address`
   (not `Address | null`) must be present. A chain is not addable half-way.
   `vault`, `clPoolManager`, `binPoolManager`, `feeController`, `registry`,
   `universalRouter`, both position managers, both quoters, the descriptor,
   `create3Factory`, `permit2`, `weth`, `revShareHook`, the custody timelock and
   `deployedAtBlock` are all required (the policy timelock is not), because a consumer branching on `null`
   for those was never written. So a new chain enters this table when its core
   is deployed and read back, and not one commit earlier. There is no
   placeholder to pre-stage and no zero address to fill in.

   ARC MAINNET (5042) IS DELIBERATELY ABSENT
   -----------------------------------------
   It has never answered a probe from this project: TLS handshake failures on
   every candidate endpoint, so chain id 5042 has never been read off a live
   node, and its published USDC decimals contradict themselves (6 in the owner's
   config, 18 on Circle's own Connect page — the 10^12 gap above). See the long
   note in `chains/endpoints.ts`. Do not add it from memory or from a docs page.
   Nothing is deployed there in any case.
   ============================================================================ */

import type { Address } from "viem";
// SAFE_CONTRACTS (./safe.js) supplies each record's `safe` block; import it again with the first record.
import type { SafeContracts } from "./safe.js";

import { SAFE_CONTRACTS } from "./safe.js";
import { CHAIN_56 } from "./generated/chain56.js";
import { CHAIN_4663 } from "./generated/chain4663.js";
import { CHAIN_6714 } from "./generated/chain6714.js";
import { CHAIN_8453 } from "./generated/chain8453.js";
import { CHAIN_99901 } from "./generated/chain99901.js";
import type { ContractBlockClock } from "../chains/clock.js";

/**
 * Chains where Gully Core's shared core is deployed and verified.
 *
 * DERIVED from `DEPLOYMENTS_TABLE`'s keys — do not write a union here. Adding a
 * chain is one object literal in that table and nothing else.
 */
export type GullyCoreChainId = keyof typeof DEPLOYMENTS_TABLE;

/**
 * Stable key per chain. Matches the keys in `chains/endpoints.ts`.
 *
 * Also derived: it is the union of the table's own `key` fields.
 */
export type GullyCoreChainKey = (typeof DEPLOYMENTS_TABLE)[GullyCoreChainId]["key"];

/**
 * A token this address book knows about, with the decimals that make its
 * amounts mean something.
 *
 * `decimals` is not optional and has no default. See the header: a default of
 * 18 is how a 6-decimal quote token misprices a pool by 10^12.
 */
export interface TokenInfo {
  readonly address: Address;
  readonly symbol: string;
  readonly name: string;
  readonly decimals: number;
  /**
   * `true` for a throwaway test token with no economic meaning. Rendering one
   * without saying so is how a testnet balance reads as money.
   */
  readonly isTestToken: boolean;
  /**
   * One short line a UI shows beside the name when the name alone would mislead, e.g. a pegged
   * token that carries the original issuer's name. Absent for almost every token.
   */
  readonly note?: string;
  /**
   * A tokenised stock: an issuer-controlled security token. Present only when
   * true. What it means for a pool or a launch quoted in it (as read on chain
   * for issuer-controlled stock tokens): the issuer can pause transfers, burn from
   * any holder and upgrade every stock token at once, and raw units differ
   * from shares by a UI multiplier. A UI must say so beside any stock pair.
   */
  readonly stock?: {
    /** The issuer as it names itself on the token, e.g. "Robinhood". */
    readonly issuer: string;
    /** Exchange ticker of the underlying, e.g. "NVDA". */
    readonly ticker: string;
  };
}

/* ============================================================================
   DURATION CLOCKS — how a deployed Gully Core contract measures time.

   Every duration in the current Gully Core contract sources uses
   `block.timestamp`. Earlier builds measure in `block.number`, which on Arbitrum
   Nitro is the PARENT chain's block, not the L2 block the RPC reports. A chain
   can hold both kinds at once, and older ones do not go away when the address
   book moves on: a pool is bound to its hook's address forever.

   So the clock is recorded HERE, per contract, and no consumer infers it:

     "timestamp"       stored times are unix seconds; compare with
                       `block.timestamp` (the latest block's `timestamp`).
     "contract-block"  stored times are the EVM's `block.number`; compare with
                       `readContractBlockNumber` from `chains/clock`, NEVER with
                       `eth_blockNumber`.

   There is no decode-time test that tells the two apart. `RevShareHook`'s
   8-word `getPendingConfig` has the same layout in both the block-numbered
   build and the timestamp source, and `LaunchGuardHook`'s `Launch` struct
   lines up word for word. The wrong reading returns a 1970 date or a far-future
   block, not an error. Look the address up; never guess.
   ============================================================================ */

/** How a contract measures and stores durations. See the block above. */
export type DurationClock = "timestamp" | "contract-block";

/**
 * The on-chain layout of `RevShareHook.getPendingConfig(poolId)`.
 *
 * - `block-no-expiry` — 7 words, `(uint48 effectiveBlock, ConfigParams)`. No
 *   expiry at all: a matured proposal stays armed until cancelled or frozen.
 * - `block-with-expiry` — 8 words, `(uint48 effectiveBlock, uint48 expiryBlock, ConfigParams)`.
 * - `timestamp-with-expiry` — 8 words, `(uint40 effectiveAt, uint40 expiresAt, ConfigParams)`.
 */
export type RevSharePendingShape = "block-no-expiry" | "block-with-expiry" | "timestamp-with-expiry";

/** One `RevShareHook` this address book knows, current or retired, with its shape. */
export interface RevShareHookRecord {
  readonly address: Address;
  readonly durationClock: DurationClock;
  readonly pendingShape: RevSharePendingShape;
  /**
   * `current` is the one `GullyCoreDeployment.revShareHook` names. Exactly one per chain.
   * `live` is a deployed, serviceable hook that is not (yet) the one `revShareHook` names —
   * e.g. a redeploy whose consumers have not migrated. `retired` is superseded but still hosts
   * whatever pools were bound to it.
   */
  readonly status: "current" | "live" | "retired";
  /** Why it is here. Pools bound to a retired hook still exist and still trade. */
  readonly note: string;
}

export interface NativeCurrency {
  readonly name: string;
  readonly symbol: string;
  readonly decimals: number;
}

/**
 * The contracts `LaunchpadKitV2` is built from, in the deployment order of
 * `packages/launchpad/docs/kit-v2-integration.md` section 11.12.
 *
 * A separate group rather than new top-level fields: none of these replaces the
 * block-numbered `launchpadKit` / `launchGuardHook` above, which keep hosting
 * their pools, and a kit is only usable when the whole group is present and
 * bound together (its constructor asserts the hooks' factory, the lockers'
 * position managers and recipient). Each slot is `null` until that contract is
 * deployed AND verified; a partially filled group is an in-progress deployment,
 * not a usable kit - `requireLaunchpadV2` refuses it.
 *
 * All durations in this stack are `block.timestamp` (Option B), so the group
 * carries no clock field.
 */
export interface LaunchpadV2Deployment {
  /** `LaunchpadKitV2`. Owner = the governance Safe; its only power is the launch fee. */
  readonly launchpadKitV2: Address | null;
  /** `LaunchLegs`, the linked library the kit DELEGATECALLs. Verified alongside the kit. */
  readonly launchLegs: Address | null;
  /** `LaunchTokenFactory`. Its `launchTokenInitCodeHash()` feeds off-chain address prediction. */
  readonly launchTokenFactory: Address | null;
  /** `GullyCoreLPLocker` (CL). No owner. */
  readonly clLPLocker: Address | null;
  /** `GullyCoreBinLPLocker`. No owner. */
  readonly binLPLocker: Address | null;
  /** The timestamp `LaunchGuardHook` bound to `launchTokenFactory`. Not the block-numbered `launchGuardHook`. */
  readonly clLaunchGuardHook: Address | null;
  /** `BinLaunchGuardHook(binPoolManager, launchTokenFactory)`. */
  readonly binLaunchGuardHook: Address | null;
  /** `GullyCorePadFactory`, bound to `launchpadKitV2`. No owner. */
  readonly padFactory: Address | null;
}

/**
 * The stock / RWA contracts: market-hours and stock-pair hooks and the oracles
 * they read. A hook address is part of pool identity, so every address here is
 * a deploy, never a patch. `null` where not deployed.
 *
 * Owner of all four = the governance Safe (Ownership table). Read `owner()`
 * rather than trusting this comment.
 */
export interface RwaDeployment {
  /** `MarketHoursHook`: trading sessions, holidays and a price band on a stock pool. */
  readonly marketHoursHook: Address | null;
  /**
   * `StockPairHook`: `MarketHoursHook` plus a per-pool compliance allowlist. It needs a trusted
   * router that attests the end user, so it opens no pool until one is configured.
   */
  readonly stockPairHook: Address | null;
  /** `ChainlinkPriceBandAdapter`: the band's reference price, read from Chainlink feeds. */
  readonly chainlinkPriceBandAdapter: Address | null;
  /** `AllowlistComplianceOracle`: the allowlist `StockPairHook` consults. */
  readonly allowlistComplianceOracle: Address | null;
  /**
   * `ManualPriceBandOracle`: a band reference a bounded publisher posts, for a stock no feed prices.
   * Owned by the CUSTODY timelock (its owner is exempt from the publisher bound), born with no
   * publisher. Optional in the type so a partial devnet override need not name it.
   */
  readonly manualPriceBandOracle?: Address | null;
  /** `PythPriceBandAdapter`: the band's reference from Pyth (pull oracle; `refresh` is permissionless). Owner: the Safe. */
  readonly pythPriceBandAdapter?: Address | null;
  /**
   * `ChainlinkCrossPriceBandAdapter`: the band's reference as (stock / USD) / (quote / USD), for a stock
   * pool quoted in the native currency (or any quote not worth one dollar). Owner: the Safe. Optional in
   * the type so records written before it existed stay valid.
   */
  readonly chainlinkCrossPriceBandAdapter?: Address | null;
  /**
   * `ChainlinkScaledSharePriceBandAdapter`: the band's reference as (share / USD) x uiMultiplier / (quote / USD),
   * for an ERC-8056 stock token (Binance bStocks) whose only Chainlink feed prices the UNDERLYING SHARE. Owner:
   * the Safe. While it is null on a chain, `stockPairCoverage` reports no share-priced ticker as pairable there.
   */
  readonly chainlinkScaledSharePriceBandAdapter?: Address | null;
}


/**
 * Every Gully Core contract on one chain.
 *
 * Field-by-field nullability is deliberate and load-bearing. A field typed
 * `Address` is deployed on EVERY chain in this table — a consumer can use it
 * without a branch. A field typed `Address | null` is one that genuinely does
 * not exist somewhere, and the compiler makes you say what you will do about
 * that.
 */
export interface GullyCoreDeployment {
  readonly chainId: GullyCoreChainId;
  readonly key: GullyCoreChainKey;
  readonly name: string;
  /** Block explorer origin, no trailing slash. */
  readonly explorer: string;
  /**
   * `true` when this chain holds real value. Governs warning copy and nothing
   * about how anything is read — a testnet address under mainnet chrome is a
   * lie whether or not the reads succeeded.
   */
  readonly isMainnet: boolean;
  /**
   * Block the first Gully Core contract landed. Log scans start here, not at
   * genesis: an unbounded `getLogs` is how a public RPC starts refusing you.
   */
  readonly deployedAtBlock: bigint;
  readonly nativeCurrency: NativeCurrency;
  /**
   * `false` where the native coin pays gas and nothing else (Anubis gasDAI: `eth_getBalance` shows a balance,
   * the BALANCE the EVM sees is 0, and any transaction carrying a value fails with "insufficient funds for
   * transfer"). No native pool, no wrapped native, no native quote; every native fee there is 0. Absent means
   * native value works. Read it through `nativeValueAllowed`.
   */
  readonly nativeValueTransfers?: boolean;
  /** The ERC-20 a pool quotes in where native cannot. Read it through `defaultQuote`. Absent means native. */
  readonly quoteToken?: Address;

  /* -- clocks ------------------------------------------------------------- */

  /**
   * Which clock `block.number` follows INSIDE THE EVM on this chain.
   *
   * `"parent-l1"` on Arbitrum Nitro chains, where a contract sees Ethereum's
   * block number while `eth_blockNumber` (and `deployedAtBlock` above) is the L2
   * one. Every block number a Gully Core contract STORES is on this clock. Compare
   * those against `readContractBlockNumber` from `chains/clock`, never against
   * `getBlockNumber()`. See the header of `chains/clock.ts`.
   */
  readonly contractBlockClock: ContractBlockClock;
  /**
   * Real cadence of the contract-visible `block.number`, in hundredths of a
   * second. NOT the RPC's block time, and NOT whatever a contract declared in
   * its own `blockTimeCentis()` — those can be wrong.
   */
  readonly contractBlockTimeCentis: number;

  /* -- settlement core ---------------------------------------------------- */

  /**
   * The singleton that custodies every token for the whole protocol.
   *
   * Immutable, permanent, and the highest-value address in the system —
   * `registerApp` is `onlyOwner` and irreversible. It will never be redeployed,
   * which is why it is safe to bake into a source file.
   */
  readonly vault: Address;
  readonly clPoolManager: Address;
  readonly binPoolManager: Address;
  /**
   * The `*PoolManagerOwner` wrappers that actually hold fee and pause authority
   * over every pool. `null` where the managers are owned directly.
   *
   * Recorded here because the alternative is what the dapp does today: read
   * `owner()` and keep hopping until you land somewhere recognisable. That hop
   * chain is still the right way to answer "who owns this NOW" — ownership can
   * be mid-migration — but the wrapper's ADDRESS is a fixed fact and
   * does not need discovering.
   */
  readonly clPoolManagerOwner: Address | null;
  readonly binPoolManagerOwner: Address | null;

  /* -- fees --------------------------------------------------------------- */

  /**
   * The contract governance points a pool manager at. Deployed does NOT mean
   * wired: read `poolManager.protocolFeeController()` to find out whether it is
   * in force, and expect `address(0)`.
   *
   * Never point a manager at a controller that has no function able to call
   * `collectProtocolFees`: everything it charged would accrue where nobody
   * could withdraw it (the caller check runs at collection time, so a later
   * controller can still sweep it).
   */
  readonly feeController: Address;
  /**
   * `false` where the installed fee controller has no guardian at all (V5: the Safe alone may lower a fee),
   * so the governance check does not look for one. Absent means the controller answers `guardian()` or `policy()`.
   */
  readonly feeControllerHasGuardian?: boolean;
  /**
   * The two upstream `ProtocolFeeController` instances (one contract, deployed
   * twice — there is no separate CL/Bin source file, whatever the ops table
   * calls them). `null` where neither was deployed.
   */
  readonly clProtocolFeeController: Address | null;
  readonly binProtocolFeeController: Address | null;

  /* -- governance --------------------------------------------------------- */

  /**
   * The governance Safe.
   *
   * This is an identifier, not a claim about who owns what: on one chain it may
   * own every contract in this table, on another exist and own nothing.
   * Which is true for a given chain must be READ, never assumed from here.
   */
  readonly governanceSafe: Address;
  /** 48h tier. Vault and the pool manager owners — irreversible powers. */
  readonly timelockCustody: Address | null;
  /**
   * 6h tier. Fee policy, descriptor, router — reversible ones.
   *
   * `null` where no policy timelock exists. The Policy tier is retired
   * (reversible actions sit with the Safe directly), so new chains have none.
   */
  readonly timelockPolicy: Address | null;
  /**
   * The Safe BATCH-TARGET set on this chain (`deployments/safe.ts`
   * `SAFE_CONTRACTS`, today the canonical v1.4.1 libraries): its
   * `multiSendCallOnly` is what a governance batch DELEGATECALLs, and the
   * admin console verifies the same address. It is NOT what the governance
   * Safe runs: that Safe is v1.5.0 (`governanceSafeContracts(chainId)`, or
   * `safeContractsForVersion(chainId, VERSION())` read from the proxy).
   * `safe.version` names the library set, never the Safe. Verified by
   * `eth_getCode` per chain before listing.
   */
  readonly safe: SafeContracts;

  /* -- directory ---------------------------------------------------------- */

  /**
   * `GullyCoreRegistry` — the HOOK registry, and the Gully Core Marketplace's backing
   * contract. This is the one `LaunchpadKit.registry()` returns and the one
   * `listHook` writes to.
   *
   * NOT `launchRegistry`. There are two registries, the names are one word
   * apart, and both are real and deployed — an integrator wired to the wrong
   * one and only caught it by probing. Tell them apart by a CALL,
   * never by the name or the position in this file:
   *
   *   GullyCoreRegistry        gullycoreCount() answers, MAX_NAME_BYTES() answers 64
   *   GullyCoreLaunchRegistry  gullycoreCount() REVERTS, launchCount() answers
   *
   * This one also owns the governance surface: `GullyCoreLaunchRegistry` reads
   * `CURATOR_ROLE` and `GUARDIAN_ROLE` from here rather than defining its own,
   * so a curator granted here can flag launches too.
   *
   * REDEPLOYABLE, and its stale failure mode is silent: a retired registry
   * answers `gullycoreCount()` with a number and renders as a healthy, empty
   * marketplace. Read it from here and nowhere else.
   */
  readonly registry: Address;

  /* -- periphery and router ----------------------------------------------- */

  readonly universalRouter: Address;
  /**
   * `GullyCoreFillRouter` — the routed-fill router that may fill a trade on a THIRD-PARTY AMM and
   * charges 10 bps for it, while a Gully Core pool is charged exactly 0 (2026-09-20).
   *
   * `null` where it is not deployed, which is the house convention and NOT `?:` — `requireContract`
   * tests for `null`, so an optional member would be invisible to it and would produce viem's
   * "invalid address" instead of this file's "not deployed on <chain>" message. The absence is
   * meaningful: a caller that reads `null` as "route through Gully Core pools only" is behaving
   * correctly.
   *
   * ⚠ Never fall back to `universalRouter`. They are different contracts with different fee
   * behaviour, and conflating them charges a Gully Core pool the routed fee — the exact opposite of
   * the decision this router implements.
   *
   * Its `GullyCoreFillExecutor` is deliberately not listed: it is the router's own first CREATE
   * (nonce 1), so it is derived rather than configured, and `EXECUTOR()` on the router is the
   * authority.
   */
  readonly fillRouter: Address | null;
  readonly clPositionManager: Address;
  readonly binPositionManager: Address;
  readonly clQuoter: Address;
  readonly binQuoter: Address;
  /** `MixedQuoter`: a quote across CL and Bin pools. Absent where it is not recorded. */
  readonly mixedQuoter?: Address;
  readonly clPositionDescriptor: Address;

  /* -- external and utility ----------------------------------------------- */

  /** Our OWN CREATE3 factory. PancakeSwap's is `onlyWhitelisted` and not ours. */
  readonly create3Factory: Address;
  /** Canonical Permit2. Confirmed by reading code at the address on each chain. */
  readonly permit2: Address;
  /** `Multicall3`. Absent means the canonical address; read it through `multicall3For`. */
  readonly multicall3?: Address;
  /**
   * The wrapped native the contracts were deployed against. Also present in `tokens` with its decimals.
   * Where `nativeValueTransfers` is `false` it has no supply: it is a constructor argument, never a pool token.
   */
  readonly weth: Address;

  /* -- Gully Core's own hooks --------------------------------------------------- */

  /**
   * `RevShareHook`. Takes nothing at all until a pool owner configures a
   * roster, so its presence in a pool key is not by itself a fee.
   *
   * REDEPLOYABLE. An older build may lack `keyOf`/`hasKey`/`totalTaken` and
   * revert on all three — a reminder that "the hook is deployed" and "the hook
   * has the function you are about to call" are different questions.
   *
   * `null` on a chain where it is not deployed.
   */
  readonly revShareHook: Address | null;

  /* -- launchpad ------------------------------------------------------------ */

  /**
   * `GullyCoreLaunchRegistry` — the LAUNCH registry. A different contract from
   * `registry` above. If you are reading a claim about what is deployed,
   * check the table below, not a comment.
   *
   * Holds `registerLaunch` / `getLaunch(poolId)` / `launchCount()` and the
   * launchpad directory `registerLaunchpad` / `getLaunchpad`. It reads its
   * roles from `registry`, so it has no ownership row of its own.
   *
   * WHICH ONE DO I WANT?
   *   listing a HOOK ......... `registry`  (this is what the kit uses)
   *   a launch's own record ... `LaunchpadKit.getLaunchRecord(poolId)`
   *   the curated launch/launchpad directory ... this contract
   *
   * `gullycoreCount()` reverts here. That is the cheapest way to prove which of the
   * two you are holding.
   */
  readonly launchRegistry: Address | null;
  readonly launchpadKit: Address | null;
  readonly launchGuardHook: Address | null;

  /**
   * The CURRENT `LaunchpadKitV2` stack: the one a NEW launch and a NEW Launchpad go
   * through. See `LaunchpadV2Deployment`. Every slot is `null` on a chain without a kit.
   *
   * Only half the story for a READER: a hook address is part of pool identity, so a kit
   * that has been superseded keeps its launches, pools, locks and Launchpads forever.
   * Anything that lists or reads launches, pools, earnings, locks or Launchpads iterates
   * `launchpadV2Generations(d)` (current first, then `launchpadV2Retired`), never this
   * field alone, or every launch of an earlier generation disappears.
   */
  readonly launchpadV2: LaunchpadV2Deployment;

  /**
   * EARLIER kit v2 generations that are still SERVED: nothing new is created through them,
   * but their launches, pools, locks, fee credits and Launchpads live on and must still be
   * read. Newest first. Empty where the chain has only ever had one generation.
   *
   * Contracts a generation shares with another (the lockers and the token factory were
   * reused when the quote-fee guards shipped, 2026-09-28) appear in both records; readers
   * dedupe with `launchpadV2Addresses`. Tell generations' BEHAVIOUR apart by the guard's
   * bitmap (`guardGenerationOf`), never by which list an address sits in.
   */
  readonly launchpadV2Retired: readonly LaunchpadV2Deployment[];

  /**
   * `GullyCoreLaunchAndBuy`: create a launch and make the creator's first buy in one transaction.
   * Bound at construction to ONE kit (its `KIT()`), which is `launchpadV2.launchpadKitV2`
   * whenever this is set. `null` where it is not deployed.
   */
  readonly launchAndBuy: Address | null;
  /**
   * `GullyCoreDynamicFeeHook` (CL): a dynamic fee for ordinary pools, with a protocol share of each swap's
   * fee. `null` where not deployed.
   */
  readonly dynamicFeeHook: Address | null;
  /** `GullyCoreBinDynamicFeeHook`: the Bin twin. `null` where not deployed. */
  readonly binDynamicFeeHook: Address | null;
  /**
   * `GullyCoreLiquidityRewardsHook` (CL, `packages/lp-rewards`): project-funded reward streams paid to
   * in-range liquidity. Registers a REMOVAL callback, so `GullyCoreLPLocker` refuses its positions. The
   * protocol takes a share of every funding inside an immutable cap (owner = the governance Safe).
   * Optional in the type so records written before it existed stay valid; absent or `null` where not
   * deployed.
   *
   * @experimental Preview: the contracts are not deployed on any chain yet; addresses are null until they are.
   */
  readonly lpRewardsHook?: Address | null;
  /**
   * `GullyCoreOracleHook` (CL, `packages/hooks/src/oracle`): the price oracle Gully Core. A pool born on it
   * keeps a truncated time-weighted average tick that any contract reads through `IGullyCoreOracle`
   * (`consult`, `observe`, `kind() == keccak256("gullycore.oracle.truncated-twap.v1")`). No role, no fee,
   * holds nothing. A hook is part of a pool's identity, so only pools CREATED on it have the oracle.
   * Optional in the type so records written before it existed stay valid; absent or `null` where not
   * deployed.
   *
   * @experimental Preview: the contracts are not deployed on any chain yet; addresses are null until they are.
   */
  readonly oracleHook?: Address | null;
  /**
   * `GullyCoreDexHook` (CL, `packages/hooks/src/dex`): the accepted dynamic fee (`GullyCoreDynamicFeeHook`)
   * with the same oracle compiled in, so a dynamic-fee pool born on it also answers `IGullyCoreOracle`.
   * Optional in the type; absent or `null` where not deployed.
   *
   * @experimental Preview: the contracts are not deployed on any chain yet; addresses are null until they are.
   */
  readonly dexHook?: Address | null;

  /**
   * `GullyCoreSplitFactory` (Team splits): clones a `GullyCoreSplit` per team. Owner =
   * the governance Safe, whose only powers are the creation fee and the
   * protocol share for NEW splits, each inside an immutable cap. Independent of
   * the kit, so it is not part of `launchpadV2`. `null` where not deployed.
   */
  readonly splitFactory: Address | null;

  /**
   * Gully Core utilities: lockers, multisend and Merkle airdrops. Each charges one
   * flat native fee per action, enforced by the contract (`GullyCoreFeeGate`: owner
   * = the governance Safe, fee inside an immutable cap, increases behind a
   * notice, decreases immediate, flushed permissionlessly to the Safe). A caller
   * through the SDK pays exactly what any other caller pays. `null` where not
   * deployed.
   *
   * - `positionLock`: `GullyCorePositionLock`, time-locks a CLPositionManager NFT
   *   (bound to one position manager, read `positionManager()` from it).
   * - `tokenLock`: `GullyCoreTokenLock`, ERC-20 / native time-locks and vesting.
   * - `multisend`: `GullyCoreMultisend`, one call to up to 1,000 recipients.
   * - `dropFactory`: `GullyCoreDropFactory`, clones and funds a `GullyCoreMerkleDrop`.
   */
  readonly positionLock: Address | null;
  readonly tokenLock: Address | null;
  readonly multisend: Address | null;
  readonly dropFactory: Address | null;

  /**
   * Limit orders and DCA (`packages/orders`). Each charges a bps protocol fee on
   * what it produces, frozen per order or plan, inside an immutable cap (owner =
   * the governance Safe; increases behind a notice, decreases immediate; paid
   * only to the Safe through the permissionless `flushProtocolFees`). Executing a
   * crossed order or a due slice is permissionless and pays the executor the tip
   * its maker escrowed. `null` where not deployed.
   *
   * - `rangeOrders`: `GullyCoreRangeOrders`, CL limit orders as one-spacing range positions.
   * - `dca`: `GullyCoreDCA`, scheduled exact-input swaps through one pool the user names.
   *
   * @experimental Preview: the contracts are not deployed on any chain yet; addresses are null until they are.
   */
  readonly rangeOrders: Address | null;
  readonly dca: Address | null;

  /**
   * `GullyCoreVaultFactory` (`packages/vaults`): creates managed-liquidity vaults (EIP-1167 clones of
   * `GullyCoreManagedVault`), each holding a concentrated position in one CL pool whose range follows a
   * pool oracle's TWAP. Owner = the governance Safe, fee-only (creation fee and the performance fee new
   * vaults freeze, inside immutable caps). Optional in the type so records written before it existed stay
   * valid; absent or `null` where not deployed.
   *
   * @experimental Preview: the contracts are not deployed on any chain yet; addresses are null until they are.
   */
  readonly vaultFactory?: Address | null;

  /**
   * `GullyCoreTunerGate` (`packages/governance`): Gully Core's own gate in front of an agent key that tunes
   * Gully Core-owned dynamic-fee pools inside bounded policies. Owner = the governance Safe; born with no
   * agent and no policy (each is proposed behind the gate's notice). Optional in the type so records
   * written before it existed stay valid; absent or `null` where not deployed.
   *
   * @experimental Preview: the contracts are not deployed on any chain yet; addresses are null until they are.
   */
  readonly tunerGate?: Address | null;

  /**
   * Stock / RWA hooks and oracles. See `RwaDeployment`. Every slot is `null` on a chain where
   * they are not deployed.
   */
  readonly rwa: RwaDeployment;

  /* -- duration clocks ----------------------------------------------------- */

  /**
   * How each redeployable time-bounded contract in THIS record measures time.
   * `null` exactly where the contract itself is `null`. Consumers branch on this
   * — the landing preset curve, the dapp proposal banner, the keeper — and it
   * moves in the same edit as the address it describes.
   */
  readonly durationClocks: {
    readonly revShareHook: DurationClock | null;
    readonly launchpadKit: DurationClock | null;
    readonly launchGuardHook: DurationClock | null;
  };
  /**
   * Every `RevShareHook` a surface may meet on this chain: the current one and
   * each retired one that still hosts pools. Look a hook up with
   * `revShareHookRecord`; an address not listed here has an UNKNOWN shape.
   */
  readonly revShareHooks: readonly RevShareHookRecord[];

  /* -- tokens -------------------------------------------------------------- */

  /**
   * Tokens whose decimals have been read off their own contracts.
   *
   * NOT a token list for a UI to offer — there is no on-chain token registry
   * and this is not a substitute for one. It is the set this repo has actually
   * transacted with, carried so nobody has to guess a decimals value.
   */
  readonly tokens: readonly TokenInfo[];
}

/* ============================================================================
   THE TABLE.

   Edit HERE for a redeploy, and only here. Everything downstream — the dapp,
   the scaffolded tenant app, the keeper, any integrator — reads through this.
   ============================================================================ */

/*
 * The table itself, unannotated and `as const` so its KEYS and its `key` fields
 * are literal types the chain-id and chain-key unions above are read off. The
 * shape check happens once, on the annotated `GULLYCORE_DEPLOYMENTS` below: a field
 * of the wrong type, or a missing required address, is an error there and
 * points at the offending line here.
 */
const DEPLOYMENTS_TABLE = {
  /* --------------------------------------------------------------------------
     Each record lands here after its chain's contracts are deployed and every
     address is READ BACK off chain (an address with no code is refused) — never
     with a placeholder. A contract not deployed on
     a chain is `null` in that chain's record.

     The records that used to live here (Robinhood 4663, Base 8453, Sepolia
     11155111) belonged to the protocol this codebase was forked from. They are
     not Gully Core's and must never be re-added.
     -------------------------------------------------------------------------- */

  /* Gully Chain Testnet (485590, an Arbitrum Orbit L3 on Arbitrum Sepolia). Gully Core release 3, deployed
     2026-11-06 (record: the public deployment record,
     65 contracts source-verified). Per-tenant launch terms and fee controller V5: an outside Launchpad pays
     Gully a flat 0.30% and nothing else. A contract that is not deployed here is `null`. Releases 2 and 1 of
     the launch kit are in `launchpadV2Retired`: their launches and Launchpads keep working and stay served,
     kre8 keeps launching through release 2, and nothing new in this app is created through them.

     Robinhood 4663, Base 8453 and BNB 56 joined 2026-11-09 from their own release-3 records. HyperEVM 999 and
     Kinetiq Elysium 99901 join when THEIR OWN records exist; contracts another project runs there never go here. */
  485590: {
    chainId: 485590,
    key: "gullyTestnet",
    name: "Gully Chain Testnet",
    explorer: "https://testnet.gullyscan.xyz",
    isMainnet: false,
    deployedAtBlock: 2494n,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    contractBlockClock: "parent-l1",
    contractBlockTimeCentis: 1200,
    vault: "0x90c882D9C307c2bF7E961bC279b0929f92997dD4",
    clPoolManager: "0x6D0721230b6beD4bc9eeb65E200B6f90c2C9aEE6",
    binPoolManager: "0x4255B0B14F3dd4e2350954Da78707E3fA6c94E2B",
    clPoolManagerOwner: "0xAC57987b453533e3D67881026dA5CA271A7c7438",
    binPoolManagerOwner: "0xF8b4B5b1444fC2843BcA72b56d094a947b63654a",
    feeController: "0x8aE0C023A4e345Ff9D14E123848816ad332fDe95",
    feeControllerHasGuardian: false,
    clProtocolFeeController: null,
    binProtocolFeeController: null,
    governanceSafe: "0xC5526E28B5cDe3C5962A224896804a499d5bb240",
    timelockCustody: null,
    timelockPolicy: null,
    safe: SAFE_CONTRACTS[485590]!,
    registry: "0x352e2881Ae34bCcF8e6bB3BC38dC0Ffe9e99Aa2a",
    universalRouter: "0xb6ab6f0D23c769329DB4b3CFB947fDe3a9e797A5",
    fillRouter: "0x7577aEcB9862a7a6022Dcf1D3a3623ED91EdD9c6",
    clPositionManager: "0x337c8E7B40132B677db2b99445EbC6B3835fd7A4",
    binPositionManager: "0xC1EEF3aaf142dffDe6551a557E9700DB12817719",
    clQuoter: "0xAFFd2FcE14990C624aDf076C479a098Fa37b35eb",
    binQuoter: "0x4206Bb61C793027EcfB2d56e91Be78a5ba3b0BDB",
    mixedQuoter: "0x8b9F914e7a6CF966D6826dAC965499E43a91e55F",
    clPositionDescriptor: "0x8504aD36c38D34b31B431169530eC56340e1dF5f",
    create3Factory: "0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed",
    permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
    weth: "0x26aCCCb2e98ca9e067E58668Aa3B101beF432754",
    revShareHook: "0xFcf532aFA09F822BC5c89f7a004CBd4d0BDCBf1c",
    launchRegistry: "0x232B22f21cF12Db740df21DE09915eC7F6e61039",
    launchpadKit: null,
    launchGuardHook: null,
    launchpadV2: {
      launchpadKitV2: "0xb204c2c6CB7Ad0758Fa90B73E1B0e2405A510636",
      launchLegs: "0x72f5d873464899C163C7330909b371B452D37cA6",
      launchTokenFactory: "0xc43AcDa7f74AA372Cab96E58C97Eb9a62cf1BE70",
      clLPLocker: "0x9a88B84193F790CD3E8d99594d67F83cE6900097",
      binLPLocker: "0x98A0dC1FE694DB36eEdf767f976792eA00F20e68",
      clLaunchGuardHook: "0xB4553D0e24E4d541c620612A99c816a89aA4f30A",
      binLaunchGuardHook: "0x9D3B43CD5c5df9810B044b0694669b206646A70E",
      padFactory: "0xFB740b71F8548b013f921dC331e5662f8bc5b7BD",
    },
    launchpadV2Retired: [
      /* Release 2 (2026-11-04): one set of terms for every launch, 1% fee split 50/50. kre8 launches here. */
      {
        launchpadKitV2: "0xE8Bbf42a7583C71085F26dd5c31Cb1e5448B0545",
        launchLegs: "0xFfF4ac7F8Dcf9a9d74691099fc2FEdd67F6E19f9",
        launchTokenFactory: "0xC36E33Ef98Bf83d4D3A016dBa32822303f30cCB8",
        clLPLocker: "0x0Ca509787bf2C6a241761586d02885b9719aca5f",
        binLPLocker: "0x444719a68d039639655EDC943F1826cC2835c5a5",
        clLaunchGuardHook: "0x0Cf9A6a75F7C83dDb8B22b59757d7118931aE2A9",
        binLaunchGuardHook: "0x9a8dD4f4710708cAEE94E5704e5D45b93235b59B",
        padFactory: "0xfDC3c29332ED2E77663178A9E85F6844961928D2",
      },
      /* Release 1 (2026-10-29): 0.30% steady fee, 180-day tax ceiling, protocol share chosen per launch. */
      {
        launchpadKitV2: "0xd46543Fcb42878868eBA0C62ea1F7801a357B12D",
        launchLegs: "0xE3e49aF19f2ed8Dfe8F0380e70796e7Bd69Cf777",
        launchTokenFactory: "0xC36E33Ef98Bf83d4D3A016dBa32822303f30cCB8",
        clLPLocker: "0x0Ca509787bf2C6a241761586d02885b9719aca5f",
        binLPLocker: "0x444719a68d039639655EDC943F1826cC2835c5a5",
        clLaunchGuardHook: "0xAc79571DB68bF84012Ea986d25Bd09c6de6d4935",
        binLaunchGuardHook: "0x01c7F3E6d9715FB5240b666ef963C61138694Cab",
        padFactory: "0x2D7dcdfC94C014f64E5F23b7A3E79df759183080",
      },
    ],
    launchAndBuy: "0xA2098A55A9C6A01aBFcd71F56c018014f6a7Ea9C",
    dynamicFeeHook: "0xB2Fc45D22683beC1e72Ec5D316d910294551bA00",
    binDynamicFeeHook: "0x8664b12e10a5A1FE86c47481333Bf56894b68BBd",
    splitFactory: "0x6e38c46A7f836896E635c28afE98b022f93D01df",
    positionLock: "0x7b63b4C482E23C423ED65a8648358C5417703Ea3",
    tokenLock: "0x593a98b20A78538432571cb90704A234fa9D7ED5",
    multisend: "0x0D13fC3102079CBA6c2629c8de003DD3cB333bc4",
    dropFactory: "0x3259f54374e4970c908112c1682F000612d5D422",
    rangeOrders: "0x66a92Db09eB576bb90C0d1C209AeB160bAdE91E9",
    dca: "0x5D39079CE27819682613b67D3EB13D88B3A1146F",
    lpRewardsHook: "0xb6E700a7fdC274f85E521A49159503d54E23fE4e",
    oracleHook: "0xA8F9049ec5a0b8D4451a3915606ac83278798eB9",
    dexHook: "0x26F5e7144dBe0ADB6767D7889b79e50693d50E5D",
    tunerGate: "0xED0C799f0fe1BfDf85E9298BF6383d0526331Cd0",
    vaultFactory: "0xDB61faBF2B15654edB01c25E162ae579f729407F",
    /* hooks-rwa on the testnet (2026-11-10, the Meridian Stocks demo): MarketHoursHook and a ManualPriceBandOracle,
       both owned by the testnet governance Safe from the constructor and verified on Sourcify (from
       the testnet demo seed record). They govern the made-up demo shares only. No stock pair hook (it needs an
       attesting router that does not exist yet) and no Chainlink adapters (no feeds on Gully Chain). */
    rwa: {
      marketHoursHook: "0x3E69761c88B075147f8FdaE0F25be3047ec9aE34",
      stockPairHook: null,
      chainlinkPriceBandAdapter: null,
      allowlistComplianceOracle: null,
      manualPriceBandOracle: "0x2Ac87B2FF0dCEaf0155D0e8AF50d9422e5881988",
      chainlinkCrossPriceBandAdapter: null,
      chainlinkScaledSharePriceBandAdapter: null,
    },
    durationClocks: { revShareHook: "timestamp", launchpadKit: null, launchGuardHook: null },
    revShareHooks: [
      { address: "0xFcf532aFA09F822BC5c89f7a004CBd4d0BDCBf1c", durationClock: "timestamp", pendingShape: "timestamp-with-expiry", status: "current", note: "First deployment (2026-10-29)." },
    ],
    /* Read on chain 2026-11-05: name(), symbol(), decimals(). */
    tokens: [
      { address: "0x26aCCCb2e98ca9e067E58668Aa3B101beF432754", symbol: "WETH", name: "Wrapped Ether", decimals: 18, isTestToken: true },
      { address: "0x65Ba03c6FA90Ed549f465D4c8f2e784D6eEB7E76", symbol: "USDC.e", name: "Bridged USDC (Gully Labs)", decimals: 6, isTestToken: true },
    ],
  },
  /* Anubis Network (6714). Gully Core release 3, flat 0.30% fee controller V5. Generated, never edited here:
     packages/sdk/records and scripts/generate-deployments.mjs. gasDAI pays gas only: see `nativeValueTransfers`.
     Read before relying on it: no pool exists there yet. */
  6714: CHAIN_6714,
  /* Gully Core release 3 on Robinhood, Base and BNB (the public deployment record, broadcast 2026-11-08, every
     contract source-verified), with the chain facts read on chain 2026-11-09 (records/chain-<id>.json). */
  4663: CHAIN_4663,
  8453: CHAIN_8453,
  56: CHAIN_56,
  /* Kinetiq Elysium (99901, Orbit L3 on HyperEVM, HYPE native). Gully Core release 3 (the public deployment record,
     broadcast 2026-11-09, every contract source-verified), chain facts read on chain 2026-11-09 (records/chain-99901.json). */
  99901: CHAIN_99901,
} as const;

/**
 * Every Gully Core contract on every chain.
 *
 * This annotation is the shape check for `DEPLOYMENTS_TABLE` above: a typo, a
 * wrong type or a missing required address fails HERE and names the field.
 */
export const GULLYCORE_DEPLOYMENTS: Readonly<Record<GullyCoreChainId, GullyCoreDeployment>> = DEPLOYMENTS_TABLE;

/**
 * The same table, indexed by plain chain id, for the helpers in this module whose ids
 * come from the table's own keys (or have passed `isGullyCoreChainId`). It keeps them
 * compiling while the table is empty and `GullyCoreChainId` is `never`; it adds no
 * chain and no record.
 */
const BOOK: Readonly<Record<number, GullyCoreDeployment>> = DEPLOYMENTS_TABLE;

/** Every chain in the table, ascending. Derived — never written out by hand. */
export const GULLYCORE_CHAIN_IDS: readonly GullyCoreChainId[] = (
  Object.keys(DEPLOYMENTS_TABLE).map(Number) as GullyCoreChainId[]
).sort((a, b) => a - b);

/**
 * The mainnets only. Iterate this, not `GULLYCORE_CHAIN_IDS`, anywhere a testnet
 * being present would be a bug.
 *
 * BOTH LISTS EXIST ON PURPOSE, and the reasoning is worth keeping because the
 * obvious move is to ship one. Dropping the testnet was considered and rejected: a
 * developer building a hook needs a deployed Gully Core to test against before
 * putting one in a real swap path, and a mainnet-only address book means they
 * hand-type testnet addresses — which is precisely the drift this module was
 * created to end.
 *
 * The real risk was never that a testnet is listed. It is that one gets
 * SELECTED by a default nobody revisited. So the answer is a narrower list for
 * the code paths where that would matter, rather than a smaller table that
 * makes honest testing harder.
 *
 * `GULLYCORE_DEPLOYMENTS[id].isMainnet` is the per-record form of the same fact.
 */
export const GULLYCORE_MAINNET_CHAIN_IDS: readonly GullyCoreChainId[] = GULLYCORE_CHAIN_IDS.filter(
  (id) => BOOK[id]!.isMainnet,
);

/**
 * Native currency per chain, split out for callers that want only this.
 *
 * Derived. Do not restate a chain here: a hand-written map is how a third chain
 * gets a fourth-hand ETH entry with the wrong symbol on a chain whose gas token
 * is not ether at all.
 */
export const NATIVE_CURRENCY: Readonly<Record<GullyCoreChainId, NativeCurrency>> = Object.freeze(
  Object.fromEntries(
    GULLYCORE_CHAIN_IDS.map((id) => [id, BOOK[id]!.nativeCurrency] as const),
  ) as Record<GullyCoreChainId, NativeCurrency>,
);

/** The address Multicall3 has on most chains. A chain where it differs says so in its record. */
const CANONICAL_MULTICALL3: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";

/** The zero address as a CURRENCY: the native coin. A pool leg's sentinel, not a placeholder. */
const NATIVE_CURRENCY_ADDRESS: Address = "0x0000000000000000000000000000000000000000";

/**
 * `Multicall3` on `chainId`. Anubis has it at its own address: the canonical one has no code there, so a
 * client built with the canonical address fails every batched read. A chain not in the book answers the
 * canonical address.
 */
export function multicall3For(chainId: number): Address {
  return BOOK[chainId]?.multicall3 ?? CANONICAL_MULTICALL3;
}

/**
 * Whether a transaction on this chain may carry a value. `false` on Anubis: see
 * `GullyCoreDeployment.nativeValueTransfers`. Branch on this, never on a chain id.
 */
export function nativeValueAllowed(deployment: Pick<GullyCoreDeployment, "nativeValueTransfers">): boolean {
  return deployment.nativeValueTransfers !== false;
}

/** The token a new pool or launch quotes in by default on a chain. */
export interface DefaultQuote {
  /** The ERC-20, or the zero address for the native coin. */
  readonly address: Address;
  readonly symbol: string;
  readonly decimals: number;
}

/** The default quote: `quoteToken` from the record (DAI on Anubis), else the native coin. */
export function defaultQuote(deployment: GullyCoreDeployment): DefaultQuote {
  const quote = deployment.quoteToken;
  if (quote === undefined) {
    return { address: NATIVE_CURRENCY_ADDRESS, symbol: deployment.nativeCurrency.symbol, decimals: deployment.nativeCurrency.decimals };
  }
  const token = deployment.tokens.find((t) => t.address.toLowerCase() === quote.toLowerCase());
  if (token === undefined) throw new Error(`${deployment.name}: quote token ${quote} is not in the deployment record's token table, so its decimals are unknown.`);
  return { address: token.address, symbol: token.symbol, decimals: token.decimals };
}

/** Throws a sentence when `value` is above 0 on a chain whose transactions cannot carry one. */
export function assertNativeValue(deployment: GullyCoreDeployment, value: bigint): void {
  if (value > 0n && !nativeValueAllowed(deployment)) {
    throw new Error(
      `${deployment.name} (${deployment.chainId}): ${deployment.nativeCurrency.symbol} pays gas only, so a transaction cannot carry a value. ` +
        `Quote in ${defaultQuote(deployment).symbol} and pay with an ERC-20 approval.`,
    );
  }
}

/**
 * Contracts whose address is a MOVING TARGET.
 *
 * Not a style note — a warning about failure modes. Each of these can be
 * replaced without anything downstream noticing, because the retired instance
 * keeps answering: a dead `GullyCoreRegistry` returns a count, a superseded
 * `RevShareHook` returns balances for pools nobody uses any more, a replaced
 * timelock still reports its delay. None of that throws.
 *
 * The correct handling is to read them from this module at call time rather
 * than snapshot them into a config, a database or a deployed front end's build.
 * Everything NOT on this list — the Vault above all — is immutable or has never
 * been replaced.
 */
export const REDEPLOYABLE_CONTRACTS = [
  "registry",
  "revShareHook",
  "timelockCustody",
  "timelockPolicy",
  "feeController",
  "launchRegistry",
  "launchpadKit",
  "launchGuardHook",
] as const satisfies readonly (keyof GullyCoreDeployment)[];

export type RedeployableContract = (typeof REDEPLOYABLE_CONTRACTS)[number];

/** Keys of `GullyCoreDeployment` that hold a single contract address. */
export type ContractKey = {
  [K in keyof GullyCoreDeployment]-?: GullyCoreDeployment[K] extends Address | null | undefined ? K : never;
}[keyof GullyCoreDeployment];

/**
 * Whether the address book knows this chain. Derived from the table's keys, so
 * a chain added there is recognised everywhere without a second edit.
 */
export function isGullyCoreChainId(chainId: number): chainId is GullyCoreChainId {
  return Object.prototype.hasOwnProperty.call(DEPLOYMENTS_TABLE, chainId);
}

/**
 * The deployment for a chain, or `undefined`.
 *
 * `undefined` rather than a throw, because "Gully Core is not on this chain" is a
 * perfectly ordinary answer that a UI should render, not an exception.
 */
export function getDeployment(chainId: number): GullyCoreDeployment | undefined {
  return isGullyCoreChainId(chainId) ? GULLYCORE_DEPLOYMENTS[chainId] : undefined;
}

/**
 * The deployment for a chain, or a thrown error naming the supported chains.
 *
 * For call sites that cannot proceed — a swap builder, a deploy script. Failing
 * loudly beats defaulting to another chain, which is how a testnet call ends up
 * signed against mainnet.
 */
export function requireDeployment(chainId: number): GullyCoreDeployment {
  const d = getDeployment(chainId);
  if (d === undefined) {
    throw new Error(
      `Gully Core is not deployed on chain ${chainId}. Deployed: ` +
        GULLYCORE_CHAIN_IDS.map((id) => `${id} (${BOOK[id]!.name})`).join(", ") +
        ".",
    );
  }
  return d;
}

/**
 * One contract address, or a thrown error that says which chain lacks it.
 *
 * The point is the message. `readContract` against `null` throws something
 * about an invalid address; this throws "LaunchpadKit is not deployed on
 * <chain name> (<chain id>)", which is the sentence the caller needed.
 */
export function requireContract(deployment: GullyCoreDeployment, key: ContractKey): Address {
  const value = (deployment[key] ?? null) as Address | null;
  if (value === null) {
    throw new Error(
      `${key} is not deployed on ${deployment.name} (${deployment.chainId}). ` +
        "It is recorded as null in @gullylabs/core-sdk deployments, which means " +
        "not-yet-deployed — handle its absence rather than substituting an address.",
    );
  }
  return value;
}

/** A known token on a chain, by symbol (case-insensitive). `undefined` if unknown. */
export function tokenBySymbol(
  chainId: GullyCoreChainId,
  symbol: string,
): TokenInfo | undefined {
  const wanted = symbol.toLowerCase();
  return BOOK[chainId]!.tokens.find((t) => t.symbol.toLowerCase() === wanted);
}

/** A known token on a chain, by address (case-insensitive). `undefined` if unknown. */
export function tokenByAddress(
  chainId: GullyCoreChainId,
  address: string,
): TokenInfo | undefined {
  const wanted = address.toLowerCase();
  return BOOK[chainId]!.tokens.find((t) => t.address.toLowerCase() === wanted);
}

/**
 * The record for a `RevShareHook` at `address` on `chainId`, current or retired,
 * or `undefined` when the address book does not know it.
 *
 * `undefined` is a real answer. A tenant's own hook, or a hook deployed after
 * this build of the SDK, has an unknown shape: render "unrecognised hook"
 * rather than decoding it through a layout that might be wrong.
 */
export function revShareHookRecord(chainId: number, address: string): RevShareHookRecord | undefined {
  const d = getDeployment(chainId);
  if (d === undefined) return undefined;
  const wanted = address.toLowerCase();
  return d.revShareHooks.find((h) => h.address.toLowerCase() === wanted);
}

/**
 * The duration clock of one of a deployment's time-bounded contracts, or a
 * thrown error when that contract is not deployed on this chain.
 */
export function requireDurationClock(
  deployment: GullyCoreDeployment,
  key: keyof GullyCoreDeployment["durationClocks"],
): DurationClock {
  const clock = deployment.durationClocks[key];
  if (clock === null) {
    throw new Error(`${key} is not deployed on ${deployment.name} (${deployment.chainId}), so it has no clock.`);
  }
  return clock;
}

/**
 * The kit v2 stack on a chain, every address present, or a thrown error naming
 * what is missing. A partially filled group is a deployment in progress: a kit
 * whose lockers or guards are not recorded cannot be checked, so it is refused.
 */
export function requireLaunchpadV2(deployment: GullyCoreDeployment): { readonly [K in keyof LaunchpadV2Deployment]: Address } {
  const g = deployment.launchpadV2;
  const missing = (Object.keys(g) as (keyof LaunchpadV2Deployment)[]).filter((k) => g[k] === null);
  if (missing.length > 0) {
    throw new Error(
      `LaunchpadKitV2 is not deployed on ${deployment.name} (${deployment.chainId}): ${missing.join(", ")} ` +
        "recorded as null in @gullylabs/core-sdk deployments.",
    );
  }
  return g as { readonly [K in keyof LaunchpadV2Deployment]: Address };
}

/** The part of a deployment the generation helpers read. `launchpadV2Retired` may be absent (a partial devnet override). */
export interface LaunchpadV2Book {
  readonly launchpadV2: LaunchpadV2Deployment;
  readonly launchpadV2Retired?: readonly LaunchpadV2Deployment[] | undefined;
}

const isSet = (a: Address | null | undefined): a is Address => typeof a === "string" && !/^0x0{40}$/i.test(a);

/**
 * Every kit v2 generation a READER must serve on this chain: the current one first, then the
 * retired ones, newest first. A generation with no kit recorded is left out. Creating a launch or
 * a Launchpad uses `launchpadV2` alone; everything that lists or reads uses this.
 */
export function launchpadV2Generations(d: LaunchpadV2Book): readonly LaunchpadV2Deployment[] {
  return [d.launchpadV2, ...(d.launchpadV2Retired ?? [])].filter((g) => isSet(g.launchpadKitV2));
}

/**
 * One contract role across every served generation, deduplicated (case-insensitively, first
 * spelling kept) and without nulls, current generation first. The lockers and the token factory
 * are shared between generations, so this is how a reader watches each of them ONCE.
 */
export function launchpadV2Addresses(d: LaunchpadV2Book, key: keyof LaunchpadV2Deployment): readonly Address[] {
  const seen = new Set<string>();
  const out: Address[] = [];
  for (const g of launchpadV2Generations(d)) {
    const a = g[key];
    if (!isSet(a) || seen.has(a.toLowerCase())) continue;
    seen.add(a.toLowerCase());
    out.push(a);
  }
  return out;
}

/** Which served generation a contract belongs to. */
export interface LaunchpadV2GenerationMatch {
  readonly generation: LaunchpadV2Deployment;
  /** True for `launchpadV2`, the generation new launches go through. */
  readonly current: boolean;
  /** 0 = current, 1 = the newest retired, and so on. */
  readonly index: number;
}

/**
 * The served generation whose `key` slot (the kit by default) is `address`, or `null` when no
 * served generation has it. For a SHARED contract (a locker) this is the newest generation that
 * uses it; ask by kit, guard or pad factory when the generation matters.
 */
export function launchpadV2GenerationOf(
  d: LaunchpadV2Book,
  address: string,
  key: keyof LaunchpadV2Deployment = "launchpadKitV2",
): LaunchpadV2GenerationMatch | null {
  const wanted = address.toLowerCase();
  const all = launchpadV2Generations(d);
  const index = all.findIndex((g) => g[key]?.toLowerCase() === wanted);
  if (index < 0) return null;
  return { generation: all[index]!, current: all[index] === d.launchpadV2, index };
}

export function explorerTxUrl(chainId: GullyCoreChainId, hash: string): string {
  return `${BOOK[chainId]!.explorer}/tx/${hash}`;
}

export function explorerAddressUrl(chainId: GullyCoreChainId, address: string): string {
  return `${BOOK[chainId]!.explorer}/address/${address}`;
}

// Safe contract addresses per chain and version (see ./safe.ts). Re-exported here so
// the `deployments` namespace and the `./deployments` subpath carry them.
export { GOVERNANCE_SAFE_VERSION, SAFE_CONTRACTS, SAFE_CONTRACTS_1_5_0, SAFE_CONTRACT_CHAIN_IDS, SAFE_CONTRACT_1_5_0_CHAIN_IDS, SAFE_TX_TYPES, SAFE_VERSIONS, governanceSafeContracts, publishedMultiSendCallOnly, requireSafeContracts, safeContractsFor, safeContractsForVersion } from "./safe.js";
export type { SafeContracts, SafeVersion } from "./safe.js";
