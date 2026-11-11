// SPDX-License-Identifier: MIT
/**
 * The whole app, on a chain the SDK lists but Gully Core is not deployed on
 * (HyperEVM today): one page that says so, feature by feature.
 *
 * No wallet provider, no widget layer, no pool scan: each of those would read
 * a core that does not exist and fail one call at a time. The only read here is
 * the chain's block number through the SDK's probed endpoints, so the page can
 * tell "the chain is up, Gully Core is not on it" apart from "the chain is down".
 */

import { gullycoreTransport } from "@gullylabs/core-sdk";
import type { ReactElement } from "react";
import { createPublicClient } from "viem";

import { resolveConfig } from "../config/resolve";
import { useAsync } from "../lib/useAsync";

const FEATURE_LABEL = {
  swap: "Swap",
  pools: "Pools",
  launchpad: "Launchpad",
  locks: "Locks",
  airdrops: "Airdrops",
  splits: "Team splits",
} as const;

export function ChainNotDeployed({ chainId, chainName }: { chainId: number; chainName: string }): ReactElement {
  const cfg = resolveConfig();
  const head = useAsync(async () => {
    const env: Record<string, string | undefined> = cfg.rpcUrls.length > 0 ? { [`GULLYCORE_RPC_${chainId}`]: cfg.rpcUrls.join(",") } : {};
    const client = createPublicClient({ transport: gullycoreTransport(chainId, { env, timeout: 12_000 }) });
    return client.getBlockNumber();
  }, [chainId]);
  const enabled = (Object.keys(FEATURE_LABEL) as (keyof typeof FEATURE_LABEL)[]).filter((k) => cfg.features[k]);

  return (
    <div className="config-gate">
      <h1>
        {cfg.brand.name} is coming soon on {chainName}
      </h1>
      <p>
        This site runs on {chainName} (chain {chainId}), where Gully Core is coming soon. Until then there is nothing here
        to read or send, and the site does not pretend otherwise.
      </p>
      <ul className="problem-list">
        {enabled.map((k) => (
          <li key={k}>
            <code>{FEATURE_LABEL[k]}</code>
            <span>coming soon on {chainName}</span>
          </li>
        ))}
      </ul>
      <p className="state-hint">
        {head.state.status === "ready"
          ? `The chain itself answers (block ${head.state.data.toString()}, through the SDK's public endpoints); Gully Core is coming soon there.`
          : head.state.status === "error"
            ? `The chain's public endpoints did not answer either: ${head.state.error.message}`
            : "Checking that the chain itself answers…"}
      </p>
      <p className="state-hint">
        When Gully Core deploys on {chainName}, updating <code>@gullylabs/core-sdk</code> brings its addresses in and this app
        starts working with no edit here. Until then, set <code>chain.id</code> to a chain Gully Core is deployed on to ship
        today.
      </p>
    </div>
  );
}
