// SPDX-License-Identifier: MIT
/**
 * Drop-in liquidity widget, covering both pool types.
 *
 * The add/remove split is a tab; the CL/BIN split is not. The pool determines
 * which range editor renders, and the rest of the component - amounts, quote,
 * approvals, execution - is identical either way. That is the point of routing
 * both pool types through one `LiquidityRange` union.
 */

import type { ReactElement } from "react";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import type { LiquidityRange, PoolInfo, PositionInfo } from "../adapters/protocol.js";
import { useWidgetContext } from "../context/WidgetProvider.js";
import { formatUnits } from "viem";
import { formatAmount, formatPercentFromPips, parseAmount } from "../core/format.js";
import { clRangeSide, pairedAmountForRange, type ClRangeSide } from "../core/clMath.js";
import {
  adjustRange,
  defaultRangeFor,
  describeRange,
  useAddLiquidityExecute,
  useAddLiquidityQuote,
  usePositions,
  useRemoveLiquidity,
} from "../hooks/useLiquidity.js";
import { useAccount, usePoolState, usePools } from "../hooks/useTokens.js";
import { binStepOf, tickSpacingOf } from "../core/pool.js";
import { bumpOnConfirmed, reconcileSelection, withdrawablePositions } from "../core/liquidityRefresh.js";
import { isDynamicLPFee } from "@gullylabs/core-sdk";
import {
  ActionButton,
  AmountField,
  ErrorPanel,
  SegmentedControl,
  StatusRegion,
  SummaryList,
  SummaryRow,
  WidgetShell,
} from "./primitives.js";

/** Props for {@link LiquidityWidget}. */
export interface LiquidityWidgetProps {
  /** Pre-selects a pool by id. */
  readonly defaultPoolId?: string;
  readonly title?: string;
  /** Which tab opens first. */
  readonly defaultMode?: LiquidityMode;
  /**
   * Makes the "Connect wallet" call to action a working button that opens
   * the host's connect flow. Absent (and absent on the provider too), the CTA
   * is a disabled label and the visitor connects through the host's control.
   */
  readonly onConnectRequest?: () => void;
  /**
   * Called with the hash once an add or a removal CONFIRMS (a status-1
   * receipt), so the host can re-read what it shows beside the widget - the
   * wallet's positions, the pool's depth.
   */
  readonly onLiquidityChanged?: (hash: `0x${string}`) => void;
}

/** Add or remove. */
export type LiquidityMode = "add" | "remove";

/** The styled liquidity widget. */
export function LiquidityWidget(props: LiquidityWidgetProps): ReactElement {
  const { chain, onConnectRequest: providerConnect } = useWidgetContext();
  const onConnectRequest = props.onConnectRequest ?? providerConnect;
  const pools = usePools();
  const accountResource = useAccount();
  const [mode, setMode] = useState<LiquidityMode>(props.defaultMode ?? "add");
  const [pool, setPool] = useState<PoolInfo | null>(null);
  /* Confirmed adds and removals, counted. The positions list, the pool state
     and the balances depend on it, so a confirmation re-reads them. */
  const [refreshKey, setRefreshKey] = useState(0);
  const hostChanged = props.onLiquidityChanged;
  const onChanged = useMemo(
    () => bumpOnConfirmed<`0x${string}`>(() => setRefreshKey((k) => k + 1), hostChanged),
    [hostChanged],
  );

  useEffect(() => {
    const list = pools.data ?? [];
    if (list.length === 0) return;
    setPool((current) => {
      if (current !== null) return current;
      const preferred = props.defaultPoolId
        ? list.find((candidate) => candidate.id === props.defaultPoolId)
        : undefined;
      return preferred ?? list[0] ?? null;
    });
  }, [pools.data, props.defaultPoolId]);

  return (
    <WidgetShell
      title={props.title ?? "Liquidity"}
      subtitle={`Gully Core · ${chain.name}`}
    >
      <SegmentedControl<LiquidityMode>
        label="Liquidity action"
        value={mode}
        options={[
          { value: "add", label: "Add" },
          { value: "remove", label: "Remove" },
        ]}
        onChange={setMode}
      />

      <PoolSelect pools={pools.data ?? []} value={pool} onChange={setPool} />

      {pool === null ? (
        <StatusRegion message="No pools are configured for this deployment." />
      ) : mode === "add" ? (
        <AddLiquidityPanel pool={pool} account={accountResource.data} refreshKey={refreshKey} onChanged={onChanged} {...(onConnectRequest === undefined ? {} : { onConnectRequest })} />
      ) : (
        <RemoveLiquidityPanel pool={pool} account={accountResource.data} refreshKey={refreshKey} onChanged={onChanged} {...(onConnectRequest === undefined ? {} : { onConnectRequest })} />
      )}
    </WidgetShell>
  );
}

function PoolSelect(props: {
  readonly pools: readonly PoolInfo[];
  readonly value: PoolInfo | null;
  readonly onChange: (pool: PoolInfo) => void;
}): ReactElement {
  return (
    <div className="gullycore-field">
      <label className="gullycore-label" htmlFor="gullycore-pool-select">
        Pool
      </label>
      <select
        id="gullycore-pool-select"
        className="gullycore-select"
        style={{ width: "100%", borderRadius: "var(--gullycore-radius-sm)" }}
        value={props.value?.id ?? ""}
        onChange={(event) => {
          const next = props.pools.find((pool) => pool.id === event.target.value);
          if (next !== undefined) props.onChange(next);
        }}
      >
        {props.pools.length === 0 ? <option value="">No pools available</option> : null}
        {props.pools.map((pool) => (
          <option key={pool.id} value={pool.id}>
            {pool.token0.symbol}/{pool.token1.symbol} · {pool.poolType} ·{" "}
            {/* The dynamic-fee flag is not a rate: a hook sets the fee per swap. */}
            {isDynamicLPFee(pool.lpFeePips) ? "dynamic fee" : formatPercentFromPips(pool.lpFeePips)}
          </option>
        ))}
      </select>
    </div>
  );
}

function AddLiquidityPanel(props: {
  readonly pool: PoolInfo;
  readonly account: `0x${string}` | null;
  readonly refreshKey: number;
  readonly onConnectRequest?: () => void;
  readonly onChanged: (hash: `0x${string}`) => void;
}): ReactElement {
  const { pool, refreshKey } = props;
  const poolState = usePoolState(pool);
  /* A confirmed deposit (here or in the Remove tab) changed the pool's
     liquidity: re-read its state. The first render is the initial read. */
  const refetchPoolState = poolState.refetch;
  useEffect(() => {
    if (refreshKey > 0) refetchPoolState();
  }, [refreshKey, refetchPoolState]);
  const [range, setRange] = useState<LiquidityRange | null>(null);
  /* The amount the user typed, and on which side. For a CL range the other
     side is DERIVED from it at the pool's price (a position takes both tokens
     in the ratio the price and the range fix, so a free second field would
     only ever mint the smaller of the two); for a bin range both are free. */
  const [edited, setEdited] = useState<{ readonly side: 0 | 1; readonly text: string }>({ side: 0, text: "" });
  const [freeText, setFreeText] = useState<{ readonly t0: string; readonly t1: string }>({ t0: "", t1: "" });

  // Reset the range whenever the pool changes, then seed it from live state.
  useEffect(() => {
    setRange(null);
  }, [pool.id]);

  useEffect(() => {
    if (range !== null) return;
    const state = poolState.data;
    const seeded = defaultRangeFor(
      pool,
      state?.currentTick ?? null,
      state?.activeId ?? null,
    );
    if (seeded !== null) setRange(seeded);
  }, [pool, poolState.data, range]);

  useEffect(() => {
    setEdited({ side: 0, text: "" });
    setFreeText({ t0: "", t1: "" });
  }, [pool.id]);

  const sqrtPriceX96 = poolState.data?.sqrtPriceX96 ?? null;
  const clRange = range !== null && range.type === "CL" && sqrtPriceX96 !== null ? range : null;
  const side: ClRangeSide | null = clRange === null || sqrtPriceX96 === null ? null : clRangeSide(sqrtPriceX96, clRange.tickLower, clRange.tickUpper);

  /* The texts the two fields show. CL: the typed side verbatim, the other
     derived (or pinned to zero when the range cannot take it). Bin: both free. */
  const { amount0Text, amount1Text } = useMemo(() => {
    if (clRange === null || sqrtPriceX96 === null || side === null) return { amount0Text: freeText.t0, amount1Text: freeText.t1 };
    const decimalsIn = edited.side === 0 ? pool.token0.decimals : pool.token1.decimals;
    const decimalsOther = edited.side === 0 ? pool.token1.decimals : pool.token0.decimals;
    const typed = edited.text;
    let other = "";
    if (side === "both") {
      const parsed = typed.trim() === "" ? null : parseAmount(typed, decimalsIn);
      if (parsed !== null && parsed.ok) {
        const paired = pairedAmountForRange(sqrtPriceX96, clRange.tickLower, clRange.tickUpper, edited.side === 0 ? "token0" : "token1", parsed.value);
        other = paired === null ? "" : formatUnits(paired, decimalsOther);
      }
    }
    /* Out of range, only one side can hold anything; the typed text moves to it
       if it was typed on the side the range cannot take. */
    if (side === "token0-only") return { amount0Text: edited.side === 0 ? typed : "", amount1Text: "0" };
    if (side === "token1-only") return { amount0Text: "0", amount1Text: edited.side === 1 ? typed : "" };
    return edited.side === 0 ? { amount0Text: typed, amount1Text: other } : { amount0Text: other, amount1Text: typed };
  }, [clRange, sqrtPriceX96, side, edited, freeText, pool.token0.decimals, pool.token1.decimals]);

  const setAmount0Text = useCallback((text: string) => {
    setEdited({ side: 0, text });
    setFreeText((current) => ({ ...current, t0: text }));
  }, []);
  const setAmount1Text = useCallback((text: string) => {
    setEdited({ side: 1, text });
    setFreeText((current) => ({ ...current, t1: text }));
  }, []);

  const parsed0 = amount0Text.trim() === "" ? null : parseAmount(amount0Text, pool.token0.decimals);
  const parsed1 = amount1Text.trim() === "" ? null : parseAmount(amount1Text, pool.token1.decimals);
  const amount0 = parsed0 !== null && parsed0.ok ? parsed0.value : null;
  const amount1 = parsed1 !== null && parsed1.ok ? parsed1.value : null;
  const rangeNote =
    side === "token0-only"
      ? `This range sits above the current price, so it holds only ${pool.token0.symbol}.`
      : side === "token1-only"
        ? `This range sits below the current price, so it holds only ${pool.token1.symbol}.`
        : side === "both"
          ? "In range: enter either amount and the other is filled at the pool's current price."
          : null;

  const quote = useAddLiquidityQuote({
    pool,
    range,
    amount0Desired: amount0,
    amount1Desired: amount1,
  });

  const execution = useAddLiquidityExecute({ quote: quote.data ?? null, onSuccess: props.onChanged });
  const insufficient = execution.insufficient;

  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (execution.insufficient !== null) return;
      if (execution.needsApproval) {
        void execution.approve();
        return;
      }
      void execution.execute();
    },
    [execution],
  );

  /* The balance check comes before the approval: never ask for an allowance on
     a deposit the wallet cannot pay (core/liquidityGuards). */
  const buttonLabel =
    props.account === null
      ? "Connect wallet"
      : insufficient !== null
        ? `Insufficient ${insufficient.symbol}`
        : execution.needsApproval
          ? `Approve ${execution.approvals[0]?.token.symbol ?? ""}`
          : "Add liquidity";

  const busy =
    execution.step === "approving" ||
    execution.step === "building" ||
    execution.step === "awaiting-signature" ||
    execution.step === "pending";

  return (
    <form onSubmit={handleSubmit} noValidate>
      {range === null ? (
        <StatusRegion message="Waiting for pool state to seed a default range." />
      ) : (
        <RangeEditor
          pool={pool}
          range={range}
          onChange={setRange}
          currentTick={poolState.data?.currentTick ?? null}
          activeId={poolState.data?.activeId ?? null}
        />
      )}

      {rangeNote !== null ? <p className="gullycore-panel__note">{rangeNote}</p> : null}
      <AmountField
        label={`Deposit ${pool.token0.symbol}`}
        value={amount0Text}
        onValueChange={setAmount0Text}
        readOnly={side === "token1-only"}
        token={pool.token0}
        tokens={[pool.token0]}
        error={parsed0 !== null && !parsed0.ok ? parsed0.message : null}
      />
      <AmountField
        label={`Deposit ${pool.token1.symbol}`}
        value={amount1Text}
        onValueChange={setAmount1Text}
        readOnly={side === "token0-only"}
        token={pool.token1}
        tokens={[pool.token1]}
        error={parsed1 !== null && !parsed1.ok ? parsed1.message : null}
      />

      {quote.data !== null && quote.data !== undefined ? (
        <SummaryList>
          <SummaryRow
            label={`${pool.token0.symbol} deposited`}
            value={formatAmount(quote.data.amount0, pool.token0.decimals)}
          />
          <SummaryRow
            label={`${pool.token1.symbol} deposited`}
            value={formatAmount(quote.data.amount1, pool.token1.decimals)}
          />
          <SummaryRow label="Liquidity" value={quote.data.liquidity.toString()} />
          <SummaryRow label="Range" value={describeRange(quote.data.range)} />
          {quote.data.binDistribution !== undefined ? (
            <SummaryRow
              label="Bins used"
              value={`${quote.data.binDistribution.length}`}
            />
          ) : null}
        </SummaryList>
      ) : null}

      <StatusRegion
        message={execution.statusMessage}
        tone={execution.step === "error" ? "error" : execution.step === "success" ? "success" : "neutral"}
      />

      <ActionButton
        type="submit"
        disabled={quote.data === null || quote.data === undefined || busy || insufficient !== null}
        busy={busy}
        needsConnect={props.account === null}
        {...(props.onConnectRequest === undefined ? {} : { onConnectRequest: props.onConnectRequest })}
      >
        {buttonLabel}
      </ActionButton>

      <ErrorPanel error={execution.error !== null ? null : quote.error} context="liquidity" />
    </form>
  );
}

/**
 * The one place the pool types genuinely diverge in the UI.
 *
 * Concentrated liquidity gets a tick pair snapped to the pool's tick spacing;
 * the liquidity book gets a bin span around the active id. Both emit the same
 * `LiquidityRange` union, so nothing downstream branches again.
 */
function RangeEditor(props: {
  readonly pool: PoolInfo;
  readonly range: LiquidityRange;
  readonly onChange: (range: LiquidityRange) => void;
  readonly currentTick: number | null;
  readonly activeId: number | null;
}): ReactElement {
  const { pool, range } = props;

  if (range.type === "CL") {
    return (
      <fieldset className="gullycore-field" style={{ margin: 0 }}>
        <legend className="gullycore-label" style={{ padding: "0 4px" }}>
          Price range (ticks, spacing {tickSpacingOf(pool)})
        </legend>
        <div className="gullycore-range-grid">
          <label className="gullycore-visually-hidden" htmlFor="gullycore-tick-lower">
            Lower tick
          </label>
          <input
            id="gullycore-tick-lower"
            type="number"
            step={tickSpacingOf(pool)}
            value={range.tickLower}
            onChange={(event) =>
              props.onChange({
                type: "CL",
                tickLower: Number(event.target.value),
                tickUpper: range.tickUpper,
              })
            }
          />
          <label className="gullycore-visually-hidden" htmlFor="gullycore-tick-upper">
            Upper tick
          </label>
          <input
            id="gullycore-tick-upper"
            type="number"
            step={tickSpacingOf(pool)}
            value={range.tickUpper}
            onChange={(event) =>
              props.onChange({
                type: "CL",
                tickLower: range.tickLower,
                tickUpper: Number(event.target.value),
              })
            }
          />
        </div>
        <div className="gullycore-meta">
          <span>
            {props.currentTick === null
              ? "Current tick unknown"
              : `Current tick ${props.currentTick}`}
          </span>
          <span>
            <button
              type="button"
              className="gullycore-chip"
              onClick={() => props.onChange(adjustRange(range, pool, 5))}
            >
              Widen
            </button>{" "}
            <button
              type="button"
              className="gullycore-chip"
              onClick={() => props.onChange(adjustRange(range, pool, -5))}
            >
              Narrow
            </button>
          </span>
        </div>
      </fieldset>
    );
  }

  const binCount = range.binIdUpper - range.binIdLower + 1;
  return (
    <fieldset className="gullycore-field" style={{ margin: 0 }}>
      <legend className="gullycore-label" style={{ padding: "0 4px" }}>
        Bin range (step {binStepOf(pool)})
      </legend>
      <label className="gullycore-label" htmlFor="gullycore-bin-width">
        Bins each side of active: {Math.floor((binCount - 1) / 2)}
      </label>
      <input
        id="gullycore-bin-width"
        className="gullycore-slider"
        type="range"
        min={0}
        max={30}
        value={Math.floor((binCount - 1) / 2)}
        onChange={(event) => {
          const half = Number(event.target.value);
          props.onChange({
            type: "BIN",
            activeIdDesired: range.activeIdDesired,
            binIdLower: range.activeIdDesired - half,
            binIdUpper: range.activeIdDesired + half,
            idSlippage: range.idSlippage,
          });
        }}
      />
      <div className="gullycore-meta">
        <span>{describeRange(range)}</span>
        <span>
          {props.activeId === null ? "Active bin unknown" : `Active bin ${props.activeId}`}
        </span>
      </div>
    </fieldset>
  );
}

function RemoveLiquidityPanel(props: {
  readonly pool: PoolInfo;
  readonly account: `0x${string}` | null;
  readonly refreshKey: number;
  readonly onConnectRequest?: () => void;
  readonly onChanged: (hash: `0x${string}`) => void;
}): ReactElement {
  /* Re-read on every confirmed add or removal (refreshKey), and offer only
     positions with something to withdraw: one removed to zero disappears. */
  const positions = usePositions(props.account, props.pool, props.refreshKey);
  const [selected, setSelected] = useState<PositionInfo | null>(null);
  const [percentBps, setPercentBps] = useState(5_000);

  const list = useMemo(() => withdrawablePositions(positions.data ?? []), [positions.data]);

  useEffect(() => {
    setSelected((current) => reconcileSelection(current, list));
  }, [list]);

  const removal = useRemoveLiquidity({ position: selected, percentBps, onSuccess: props.onChanged });

  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      void removal.execute();
    },
    [removal],
  );

  if (props.account === null) {
    return (
      <>
        <StatusRegion message="Connect a wallet to see your positions." />
        <ActionButton needsConnect {...(props.onConnectRequest === undefined ? {} : { onConnectRequest: props.onConnectRequest })}>
          Connect wallet
        </ActionButton>
      </>
    );
  }

  if (list.length === 0) {
    return (
      <StatusRegion
        message={
          positions.status === "loading"
            ? "Loading your positions"
            : positions.status === "error"
              ? (positions.error?.message ?? "Could not load positions")
              : "You have no positions in this pool."
        }
        tone={positions.status === "error" ? "error" : "neutral"}
      />
    );
  }

  return (
    <form onSubmit={handleSubmit} noValidate>
      <div className="gullycore-field">
        <label className="gullycore-label" htmlFor="gullycore-position-select">
          Position
        </label>
        <select
          id="gullycore-position-select"
          className="gullycore-select"
          style={{ width: "100%", borderRadius: "var(--gullycore-radius-sm)" }}
          value={selected?.id ?? ""}
          onChange={(event) => {
            const next = list.find((position) => position.id === event.target.value);
            setSelected(next ?? null);
          }}
        >
          {list.map((position) => (
            <option key={position.id} value={position.id}>
              {describeRange(position.range)}
            </option>
          ))}
        </select>
      </div>

      <div className="gullycore-field">
        <label className="gullycore-label" htmlFor="gullycore-remove-percent">
          Amount to withdraw: {(percentBps / 100).toFixed(0)}%
        </label>
        <input
          id="gullycore-remove-percent"
          className="gullycore-slider"
          type="range"
          min={1}
          max={100}
          value={Math.round(percentBps / 100)}
          onChange={(event) => setPercentBps(Number(event.target.value) * 100)}
        />
      </div>

      {removal.quote !== null ? (
        <SummaryList>
          <SummaryRow
            label={`${props.pool.token0.symbol} returned`}
            value={formatAmount(removal.quote.amount0, props.pool.token0.decimals)}
          />
          <SummaryRow
            label={`${props.pool.token1.symbol} returned`}
            value={formatAmount(removal.quote.amount1, props.pool.token1.decimals)}
          />
        </SummaryList>
      ) : null}

      <StatusRegion
        message={removal.statusMessage}
        tone={removal.step === "error" ? "error" : removal.step === "success" ? "success" : "neutral"}
      />

      <ActionButton
        type="submit"
        disabled={selected === null || removal.quote === null}
        busy={removal.step === "pending" || removal.step === "awaiting-signature"}
      >
        Remove liquidity
      </ActionButton>

      <ErrorPanel error={removal.error} />
    </form>
  );
}
