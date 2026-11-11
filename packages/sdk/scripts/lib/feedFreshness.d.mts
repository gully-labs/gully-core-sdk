// Types for `feedFreshness.mjs`, so `test/feedFreshness.test.ts` typechecks under
// `tsconfig.json` (which includes `scripts/` without `allowJs`).

export declare const FUTURE_SKEW_SECONDS: 120;
export declare const STALE_GRACE_SECONDS: 300;
export declare const HEAD_WALL_TOLERANCE_SECONDS: 120;

/** Null when the head is a usable reference clock, else why it is not. */
export declare function headClockFault(headTimestamp: number, wallSeconds: number, tolerance?: number): string | null;

export interface RoundFreshnessInput {
  readonly updatedAt: number;
  readonly referenceTimestamp: number;
  readonly heartbeatSeconds: number;
  readonly futureSkewSeconds?: number | undefined;
  readonly staleGraceSeconds?: number | undefined;
}

export interface RoundFreshnessVerdict {
  /** `!future && !noHeartbeat && !stale`. */
  readonly ok: boolean;
  /** `referenceTimestamp − updatedAt`; negative when the round is ahead of the head. */
  readonly ageSeconds: number;
  /** `updatedAt − referenceTimestamp`; the negation of `ageSeconds`. */
  readonly aheadSeconds: number;
  readonly reasons: readonly string[];
  /** `aheadSeconds > futureSkewSeconds`: the round is past the head it was read against. */
  readonly future: boolean;
  /** The directory gave no heartbeat, so staleness cannot be judged at all. */
  readonly noHeartbeat: boolean;
  /** `ageSeconds > heartbeatSeconds + staleGraceSeconds`; never set with `noHeartbeat`. */
  readonly stale: boolean;
}

export declare function judgeRoundFreshness(round: RoundFreshnessInput): RoundFreshnessVerdict;

/** The two viem public-client methods `readRoundBesideHead` uses; a test may fake them. */
export interface RoundClient {
  readContract(args: { address: string; abi: readonly unknown[]; functionName: string }): Promise<unknown>;
  getBlock(args: { blockTag: "latest" }): Promise<{ number: bigint | number; timestamp: bigint | number }>;
}

export interface ReadRoundBesideHeadArgs {
  readonly address: string;
  readonly abi: readonly unknown[];
  /** Defaults to `latestRoundData`. */
  readonly functionName?: string | undefined;
  /** Defaults to `HEAD_WALL_TOLERANCE_SECONDS`. */
  readonly tolerance?: number | undefined;
  /** The wall clock in milliseconds; defaults to `Date.now`. */
  readonly now?: (() => number) | undefined;
}

export interface RoundBesideHead {
  /** Whatever `functionName` returned (for `latestRoundData`, the five-tuple). */
  readonly data: unknown;
  readonly headBlock: number;
  /** The reference clock the round is judged against. */
  readonly headTimestamp: number;
  /** The wall clock at the read, unix seconds. */
  readonly wallSeconds: number;
  /** `headTimestamp − wallSeconds`. */
  readonly headWallOffsetSeconds: number;
}

/**
 * Round first, head second, same client; throws when `headClockFault` refuses the head
 * so an endpoint-fallback loop moves to the next endpoint.
 */
export declare function readRoundBesideHead(client: RoundClient, args: ReadRoundBesideHeadArgs): Promise<RoundBesideHead>;
