// SPDX-License-Identifier: MIT
/**
 * Providers, routing and the config gate.
 *
 * The config gate comes first and blocks everything: if `gullycore.config.ts` has
 * an error in it, the app renders the error with the field name rather than
 * mounting a UI that will fail one read at a time. A tenant editing one file
 * should find out immediately, in the page, what they broke.
 */

import { GullyCoreWalletProvider, createGullyCoreConfig, gullycoreChainById } from "@gullylabs/core-connect";
import { WidgetProvider, createViemAdapter } from "@gullylabs/core-widgets";
import type { ProtocolAdapter, ChainConfig } from "@gullylabs/core-widgets";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { useMemo, type ReactElement } from "react";
import { Navigate, Route, BrowserRouter, Routes } from "react-router-dom";
import type { Address, Chain } from "viem";
import { useAccount, useWalletClient } from "wagmi";

import { Shell } from "./components/Shell";
import { Async, Empty, ErrorState } from "./components/States";
import { hasBlockingProblem, resolveConfig } from "./config/resolve";
import { activeChain, publicClient } from "./lib/client";
import { readPools, toWidgetPools } from "./lib/pools";
import { swapRouterEndpoint } from "./lib/routing";
import { mergeTokens, readTokens } from "./lib/tokens";
import { useAsync } from "./lib/useAsync";
import { useTokenLogo } from "./lib/useTokenLogo";
import { AirdropClaim, AirdropNew, AirdropSend, Airdrops } from "./routes/Airdrops";
import { ChainNotDeployed } from "./routes/ChainNotDeployed";
import { Fees } from "./routes/Fees";
import { LockNew, Locks, PoolLocks, TokenLocks } from "./routes/Locks";
import { SplitDetail, SplitNew, Splits } from "./routes/Splits";
import { LaunchEarnings } from "./routes/LaunchEarnings";
import { LaunchWizard } from "./routes/LaunchWizard";
import { LaunchWizardV2 } from "./routes/LaunchWizardV2";
import { Launches } from "./routes/Launches";
import { LaunchesV2 } from "./routes/LaunchesV2";
import { Pools } from "./routes/Pools";
import { Swap } from "./routes/Swap";

/** Renders `gullycore.config.ts` problems instead of a broken app. */
function ConfigErrors(): ReactElement {
  const cfg = resolveConfig();
  return (
    <div className="config-gate">
      <h1>gullycore.config.ts needs fixing</h1>
      <p>
        The app did not mount because the configuration it depends on is not valid. Nothing below
        was read from chain.
      </p>
      <ul className="problem-list">
        {cfg.problems
          .filter((p) => p.severity === "error")
          .map((p) => (
            <li key={`${p.field}:${p.message}`}>
              <code>{p.field}</code>
              <span>{p.message}</span>
            </li>
          ))}
      </ul>
    </div>
  );
}

/**
 * Builds the widgets' adapter from what is actually on chain.
 *
 * Pools come from the CL manager's `Initialize` logs and tokens from the config
 * list read back off their own contracts. There is no on-chain enumeration of
 * either, and neither is invented: an empty pool list produces a swap widget
 * that says there is nothing to route through.
 */
function WidgetLayer({ children }: { children: ReactElement }): ReactElement {
  const cfg = resolveConfig();
  const { data: walletClient } = useWalletClient();
  const { address } = useAccount();
  /* The widgets' "Connect a wallet" button opens the same RainbowKit modal the
     header's connect button does. RainbowKit hands back no opener while a
     wallet is connected, and the widgets then never ask. */
  const { openConnectModal } = useConnectModal();

  const resource = useAsync(async () => {
    const [tokenResult, poolScan] = await Promise.all([readTokens(), readPools()]);
    return { tokenResult, poolScan };
  }, []);

  /* Routed fills: Gully Core's router API by default, the tenant's own or none by
     config (`routing` in gullycore.config.ts; `resolveRouting` says why it is off).
     Passed ONCE, on the provider, so every swap box in the app — the Swap screen
     and a launch's buy path — asks the same router, or none. */
  const router = useMemo(() => swapRouterEndpoint(), []);
  /* Logos no list carries: the native mark for the native coin and its wrapped
     form (`brand.nativeLogoUrl`), and each launch token's own verified icon.
     Launch tokens are the tokens of the pools on a launch guard, read once. */
  const launchTokens = useMemo((): readonly Address[] => {
    if (resource.state.status !== "ready") return [];
    const guards = new Set(
      [cfg.launchGuardHook, cfg.contracts.launchpadV2?.clLaunchGuardHook ?? null, cfg.contracts.launchpadV2?.binLaunchGuardHook ?? null]
        .filter((a): a is Address => a !== null)
        .map((a) => a.toLowerCase()),
    );
    const weth = (cfg.contracts.weth ?? "").toLowerCase();
    const out: Address[] = [];
    for (const p of resource.state.data.poolScan.pools) {
      if (!guards.has(p.hooks.toLowerCase())) continue;
      for (const c of [p.currency0, p.currency1]) if (c.toLowerCase() !== weth && c !== "0x0000000000000000000000000000000000000000") out.push(c);
    }
    return out;
  }, [cfg, resource.state]);
  const tokenLogo = useTokenLogo(launchTokens);

  const chainConfig: ChainConfig = useMemo(
    () => ({
      chainId: cfg.core.chainId,
      name: cfg.core.name,
      nativeCurrency: cfg.nativeCurrency,
      /* null (a local devnet, or chain.explorer: "") is passed as "": the widgets read an empty explorer as none. */
      blockExplorerUrl: cfg.explorer ?? "",
      contracts: {
        vault: cfg.contracts.vault,
        clPoolManager: cfg.contracts.clPoolManager,
        binPoolManager: cfg.contracts.binPoolManager,
        /* Gully Core's router by default; the tenant's own when `chain.router` names
           one (`cfg.contracts.universalRouter` is the same address — `resolve.ts`
           folds it in). This is the ONLY place either is read, so the swap
           surfaces and the launchpad's buy path cannot end up on different
           routers: both go through this one adapter. */
        universalRouter: cfg.router.address,
        clPositionManager: cfg.contracts.clPositionManager,
        binPositionManager: cfg.contracts.binPositionManager,
        permit2: cfg.contracts.permit2,
        quoter: cfg.contracts.clQuoter,
        binQuoter: cfg.contracts.binQuoter,
        /* Kit v2: the widgets read launches by token and quote launch pools. */
        ...(cfg.launchpadKitV2 === null ? {} : { launchpadKitV2: cfg.launchpadKitV2 }),
        /* `launchGuardHook`, not `launchpad`, and not the kit. The old line
           passed LaunchpadKit as `contracts.launchpad`, which the widget then
           called a token-sale ABI against — the kit implements no such thing.
           The widget now binds to LaunchGuardHook, which is the contract that
           actually holds a launch's schedule. */
        ...(cfg.launchGuardHook === null ? {} : { launchGuardHook: cfg.launchGuardHook }),
      },
    }),
    [cfg],
  );

  return (
    <Async
      state={resource.state}
      onRetry={resource.reload}
      loadingLabel="Loading pools and tokens"
    >
      {({ tokenResult, poolScan }) => {
        /* The picker offers the configured list PLUS every token a discovered
           pool trades. A tenant with an empty `tokens` still gets a real picker,
           built from pools that exist on this core - never from a placeholder
           pair - and a configured entry keeps its logo. */
        const pools = toWidgetPools(poolScan.pools);
        const tokens = mergeTokens(tokenResult.tokens, pools);
        const adapter: ProtocolAdapter = createViemAdapter({
          chain: chainConfig,
          publicClient: publicClient(),
          tokens,
          pools,
          ...(walletClient === undefined || address === undefined
            ? {}
            : {
                wallet: {
                  getAccount: async () => address,
                  /* Every send is simulated with the exact bytes first; a call that would revert never reaches the wallet. */
                  sendTransaction: async (request) => {
                    await publicClient().call({ account: address, to: request.to, data: request.data, value: request.value });
                    return walletClient.sendTransaction({ to: request.to, data: request.data, value: request.value });
                  },
                  /* Permit2's grant to the router as a SIGNATURE carried in the swap: one confirmation,
                     no `Permit2.approve` transaction, and nothing standing afterwards. */
                  signTypedData: async (typed) => walletClient.signTypedData({ account: address, ...typed } as Parameters<typeof walletClient.signTypedData>[0]),
                },
              }),
        });

        return (
          <WidgetProvider
            adapter={adapter}
            theme={cfg.brand.colorScheme === "light" ? "light" : "dark"}
            tokenLogo={tokenLogo}
            {...(router === undefined ? {} : { router })}
            {...(openConnectModal === undefined ? {} : { onConnectRequest: openConnectModal })}
            {...(cfg.fee.active
              ? {
                  integrator: {
                    referrer: cfg.fee.wallet,
                    feeBps: cfg.fee.bps,
                    feeMode: cfg.fee.mode,
                    label: cfg.brand.name,
                  },
                }
              : {})}
          >
            {children}
          </WidgetProvider>
        );
      }}
    </Async>
  );
}

function AppRoutes(): ReactElement {
  const cfg = resolveConfig();
  const home = cfg.features.swap
    ? "/swap"
    : cfg.features.pools
      ? "/pools"
      : cfg.features.launchpad
        ? "/launch"
        : cfg.features.locks
          ? "/locks"
          : cfg.features.airdrops
            ? "/airdrops"
            : cfg.features.splits
              ? "/splits"
              : "/fees";

  return (
    <Routes>
      <Route path="/" element={<Navigate to={home} replace />} />
      {cfg.features.swap ? <Route path="/swap" element={<Swap />} /> : null}
      {cfg.features.pools ? <Route path="/pools" element={<Pools />} /> : null}
      {/* The locked launchpad (Kit v2) owns /launch whenever it is configured;
          the v1 unlocked kit then lives at /launch/v1. With only v1 configured,
          v1 keeps /launch so an existing tenant's links do not break. */}
      {cfg.features.launchpad && (cfg.launchpadKitV2 !== null || cfg.launchpadKit === null) ? (
        <>
          <Route path="/launch" element={<LaunchesV2 />} />
          <Route path="/launch/new" element={<LaunchWizardV2 />} />
          <Route path="/launch/earnings" element={<LaunchEarnings />} />
          {cfg.launchpadKit === null ? null : <Route path="/launch/v1" element={<Launches />} />}
          {cfg.launchpadKit === null ? null : <Route path="/launch/v1/new" element={<LaunchWizard />} />}
        </>
      ) : null}
      {cfg.features.launchpad && cfg.launchpadKitV2 === null && cfg.launchpadKit !== null ? (
        <>
          <Route path="/launch" element={<Launches />} />
          <Route path="/launch/new" element={<LaunchWizard />} />
        </>
      ) : null}
      {cfg.features.splits ? (
        <>
          <Route path="/splits" element={<Splits />} />
          <Route path="/splits/new" element={<SplitNew />} />
          <Route path="/splits/:address" element={<SplitDetail />} />
        </>
      ) : null}
      {cfg.features.locks ? (
        <>
          <Route path="/locks" element={<Locks />} />
          <Route path="/locks/new" element={<LockNew />} />
          <Route path="/locks/pool/:poolId" element={<PoolLocks />} />
          <Route path="/locks/token/:token" element={<TokenLocks />} />
        </>
      ) : null}
      {cfg.features.airdrops ? (
        <>
          <Route path="/airdrops" element={<Airdrops />} />
          <Route path="/airdrops/send" element={<AirdropSend />} />
          <Route path="/airdrops/new" element={<AirdropNew />} />
          <Route path="/airdrops/claim" element={<AirdropClaim />} />
        </>
      ) : null}
      <Route path="/fees" element={<Fees />} />
      <Route
        path="*"
        element={
          <Empty
            title="No such page"
            detail="That route is not part of this app, or the feature is switched off in gullycore.config.ts."
          />
        }
      />
    </Routes>
  );
}

export function App(): ReactElement {
  const cfg = resolveConfig();

  if (hasBlockingProblem(cfg)) return <ConfigErrors />;
  /* A chain the SDK lists but Gully Core is not deployed on: one honest page, and no
     provider, client or read that would point at a core that is not there. */
  if (cfg.notDeployed !== null) return <ChainNotDeployed chainId={cfg.notDeployed.chainId} chainName={cfg.notDeployed.name} />;

  const chain: Chain = gullycoreChainById(cfg.core.chainId) ?? activeChain();

  let wagmiConfig;
  try {
    wagmiConfig = createGullyCoreConfig({
      chains: [chain],
      appName: cfg.brand.name,
      ...(cfg.brand.logoUrl === undefined ? {} : { appIcon: cfg.brand.logoUrl }),
    });
  } catch (err) {
    return (
      <ErrorState
        error={err instanceof Error ? err : new Error(String(err))}
      />
    );
  }

  return (
    <GullyCoreWalletProvider config={wagmiConfig} appName={cfg.brand.name} initialChain={chain}>
      <BrowserRouter>
        <Shell>
          <WidgetLayer>
            <AppRoutes />
          </WidgetLayer>
        </Shell>
      </BrowserRouter>
    </GullyCoreWalletProvider>
  );
}
