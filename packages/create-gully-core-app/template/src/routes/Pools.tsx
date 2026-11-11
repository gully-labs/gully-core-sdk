// SPDX-License-Identifier: MIT
/**
 * Pools on the shared core, from `Initialize` logs.
 *
 * Two honesty constraints shape this screen.
 *
 * **The list is scoped, and says so.** There is no on-chain enumeration of
 * pools, so this is a log scan from the block Gully Core was deployed. The
 * provenance line under the table is not decoration.
 *
 * **A hook is disclosed, never rated.** Every row says whether a pool has a
 * hook and what its permission bitmap allows. It does not say whether that hook
 * is safe, because this app cannot know — a bitmap tells you what a contract is
 * *able* to do, and nothing at all about what it will do.
 */

import { LiquidityWidget } from "@gullylabs/core-widgets";
import { useState, type ReactElement } from "react";
import type { Hex } from "viem";

import { PoolLockBadge } from "../components/LockBadges";
import { Async, Empty } from "../components/States";
import { resolveConfig } from "../config/resolve";
import { capabilityReport, RISK_LABEL } from "../lib/capability";
import { explorerAddressUrl } from "../lib/client";
import { ExplorerLink } from "../components/ExplorerLink";
import { formatPips, shortAddress } from "../lib/format";
import { readPools, readRecentSwaps, RECENT_SWAP_WINDOW_BLOCKS, type PoolRecord, type PoolScan } from "../lib/pools";
import { sortRows } from "../lib/chart";
import { BarList, Kpi, Kpis, Sparkline, ViewToggle, type View } from "../components/Charts";
import { useAsync } from "../lib/useAsync";

function pairLabel(pool: PoolRecord): string {
  const a = pool.token0?.symbol ?? shortAddress(pool.currency0);
  const b = pool.token1?.symbol ?? shortAddress(pool.currency1);
  return `${a} / ${b}`;
}

function HookCell({ pool }: { pool: PoolRecord }): ReactElement {
  if (!pool.hasHook) return <span className="muted">none</span>;

  const report = capabilityReport(pool.hookBitmap);

  return (
    <div className="hook-cell">
      <ExplorerLink href={explorerAddressUrl(pool.hooks)}>
        {shortAddress(pool.hooks)}
      </ExplorerLink>
      <span className="tag">{RISK_LABEL[report.riskClass]}</span>
      <ul className="capability-list">
        {report.claims.map((claim) => (
          <li key={claim}>{claim}</li>
        ))}
      </ul>
      {report.valid ? null : (
        <p className="warn-inline">
          This pool&rsquo;s hook bitmap is not a valid combination. Treat the pool as
          unclassifiable, not as safe.
        </p>
      )}
      <p className="state-hint">
        Read off the pool key. It says what this contract is <em>able</em> to do, not what it
        does, and it is not an audit.
      </p>
    </div>
  );
}

type PoolFilter = "all" | "hook" | "plain";
type PoolSort = "created" | "swaps";

function PoolsBody({ scan, selected, onSelect }: { scan: PoolScan; selected: string | null; onSelect: (id: string | null) => void }): ReactElement {
  const cfg = resolveConfig();
  const recent = useAsync(() => readRecentSwaps(scan), [scan.toBlock]);
  const [view, setView] = useState<View>("table");
  const [filter, setFilter] = useState<PoolFilter>("all");
  const [sort, setSort] = useState<{ key: PoolSort; dir: "asc" | "desc" }>({ key: "created", dir: "desc" });
  const r = recent.state.status === "ready" ? recent.state.data : null;
  const swapsOf = (pool: PoolRecord): number | null => (r === null ? null : (r.prices.get(pool.id.toLowerCase() as Hex)?.length ?? 0));
  const filtered = scan.pools.filter((p) => (filter === "all" ? true : filter === "hook" ? p.hasHook : !p.hasHook));
  const rows = sortRows(filtered, (p) => (sort.key === "created" ? Number(p.createdAtBlock) : swapsOf(p)), sort.dir);
  const onSort = (key: PoolSort): void => setSort((s) => (s.key === key ? { key, dir: s.dir === "desc" ? "asc" : "desc" } : { key, dir: "desc" }));
  const sortTh = (key: PoolSort, label: string): ReactElement => (
    <th aria-sort={sort.key === key ? (sort.dir === "desc" ? "descending" : "ascending") : "none"}>
      <button type="button" className="sort-th" onClick={() => onSort(key)}>
        {label} <span aria-hidden="true">{sort.key === key ? (sort.dir === "desc" ? "↓" : "↑") : "↕"}</span>
      </button>
    </th>
  );
  const totalSwaps = r === null ? null : [...r.prices.values()].reduce((s, l) => s + l.length, 0);

  return (
    <>
      <Kpis>
        <Kpi label="Pools" value={String(scan.pools.length)} sub="all time" />
        <Kpi label="With a Gully Core (hook)" value={String(scan.pools.filter((p) => p.hasHook).length)} sub="disclosed, never rated" />
        <Kpi
          label="Swaps, recent window"
          value={totalSwaps === null ? (recent.state.status === "error" ? "unread" : "…") : String(totalSwaps)}
          sub={r === null ? `last ${RECENT_SWAP_WINDOW_BLOCKS.toString()} blocks` : `blocks ${r.fromBlock.toString()}–${r.toBlock.toString()}`}
        />
      </Kpis>

      <div className="chart-head">
        <div className="filter-chips" role="group" aria-label="Filter pools">
          {(
            [
              ["all", "All"],
              ["hook", "With a Gully Core"],
              ["plain", "No hook"],
            ] as const
          ).map(([k, label]) => (
            <button key={k} type="button" className={`filter-chip${filter === k ? " active" : ""}`} aria-pressed={filter === k} onClick={() => setFilter(k)}>
              {label}
            </button>
          ))}
        </div>
        <ViewToggle view={view} onChange={setView} label="Pools" />
      </div>

      {view === "chart" ? (
        r === null ? (
          recent.state.status === "error" ? (
            <p className="warn-inline">Couldn&rsquo;t load recent trades. Try again.</p>
          ) : (
            <p className="muted">Loading recent trades…</p>
          )
        ) : (
          <BarList
            caption="Swaps per pool in the recent window"
            empty="No pool matches this filter."
            rows={sortRows(filtered, swapsOf, "desc")
              .slice(0, 12)
              .map((p) => {
                const n = swapsOf(p) ?? 0;
                return { key: p.id, label: pairLabel(p), text: pairLabel(p), value: n, display: `${n} swap${n === 1 ? "" : "s"}` };
              })}
          />
        )
      ) : (
        <div className="table-scroll" tabIndex={0} role="region" aria-label="Scrollable table"><table className="table">
          <thead>
            <tr>
              <th>Pair</th>
              <th>LP fee</th>
              <th>Tick spacing</th>
              <th>Gully Core (hook)</th>
              {cfg.features.locks ? <th>Locked liquidity</th> : null}
              <th>Recent price</th>
              {sortTh("swaps", "Swaps")}
              {sortTh("created", "Created")}
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((pool) => (
              <tr key={pool.id}>
                <td>
                  <span className="pair">{pairLabel(pool)}</span>
                  {pool.token0 === null || pool.token1 === null ? (
                    <p className="warn-inline">
                      One side&rsquo;s ERC-20 metadata could not be read, so it is shown as an
                      address rather than a guessed symbol.
                    </p>
                  ) : null}
                </td>
                <td>
                  {/* 0x800000 is core's dynamic-fee flag, not a rate: the hook sets the fee per swap. */}
                  {(pool.lpFeePips & 0x800000) !== 0 ? <span title="Dynamic fee: set by the hook on every swap">dynamic (hook-set)</span> : formatPips(pool.lpFeePips)}
                </td>
                <td>{pool.tickSpacing}</td>
                <td>
                  <HookCell pool={pool} />
                </td>
                {cfg.features.locks ? (
                  <td>
                    <PoolLockBadge poolId={pool.id} />
                  </td>
                ) : null}
                <td>
                  {r === null ? (
                    <span className="muted">{recent.state.status === "error" ? "unread" : "…"}</span>
                  ) : (
                    <Sparkline prices={(r.prices.get(pool.id.toLowerCase() as Hex) ?? []).slice(-40)} unit={`${pool.token1?.symbol ?? "currency1"} per ${pool.token0?.symbol ?? "currency0"}`} />
                  )}
                </td>
                <td className="mono">{swapsOf(pool) ?? "…"}</td>
                <td className="mono">#{pool.createdAtBlock.toString()}</td>
                <td>
                  <button type="button" className="btn btn-ghost" onClick={() => onSelect(selected === pool.id ? null : pool.id)}>
                    {selected === pool.id ? "Close" : "Liquidity"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}


      {selected === null ? null : (
        <section className="panel">
          <LiquidityWidget defaultPoolId={selected} />
        </section>
      )}
    </>
  );
}

export function Pools(): ReactElement {
  const cfg = resolveConfig();
  const resource = useAsync(() => readPools(), []);
  const [selected, setSelected] = useState<string | null>(null);

  return (
    <div className="page">
      <header className="page-head">
        <h1>Pools</h1>
        <p className="page-sub">
          Every pool initialised on the shared CL pool manager at{" "}
          <code>{shortAddress(cfg.contracts.clPoolManager)}</code>.
        </p>
      </header>

      <Async
        state={resource.state}
        onRetry={resource.reload}
        loadingLabel="Loading pools"
        isEmpty={(scan) => scan.pools.length === 0}
        empty={
          <Empty
            title="No pools yet"
            detail="Nothing has been initialised on this pool manager since the block Gully Core was deployed. This is a read of the chain, not a placeholder."
          />
        }
      >
        {(scan) => <PoolsBody scan={scan} selected={selected} onSelect={setSelected} />}
      </Async>
    </div>
  );
}
