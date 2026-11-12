// SPDX-License-Identifier: MIT
/**
 * The one piece of shared state every widget reads.
 *
 * `WidgetProvider` holds the adapter, the chain config and - critically - the
 * *validated* integrator config. Validation happens once, here, at mount:
 * a bad `feeBps` or a missing `referrer` fails immediately and visibly rather
 * than at the moment a user presses Swap.
 */

import type { ReactElement } from "react";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  type ReactNode,
} from "react";
import type { ProtocolAdapter, TokenInfo } from "../adapters/protocol.js";
import type { ChainConfig } from "../config/chain.js";
import { assertValidChainConfig } from "../config/chain.js";
import {
  resolveIntegratorConfig,
  type IntegratorConfig,
  type ResolvedIntegratorConfig,
} from "../config/integrator.js";
import { DEFAULT_SLIPPAGE_BPS, MAX_SLIPPAGE_BPS } from "../core/math.js";
import type { RouterEndpointConfig } from "../core/routed.js";

/** Colour scheme applied to the styled widgets. */
export type WidgetTheme = "light" | "dark" | "system";

/** Value exposed to every widget beneath the provider. */
export interface WidgetContextValue {
  readonly adapter: ProtocolAdapter;
  readonly chain: ChainConfig;
  /** Always validated. Never optional at this layer. */
  readonly integrator: ResolvedIntegratorConfig;
  readonly defaultSlippageBps: number;
  readonly theme: WidgetTheme;
  /** Locale used by number formatting; defaults to the browser's. */
  readonly locale: string | undefined;
  /**
   * What the "Connect wallet" call to action does when pressed, for every
   * widget under this provider. `undefined` leaves that CTA a disabled label.
   */
  readonly onConnectRequest: (() => void) | undefined;
  /**
   * Routed fills for every SwapWidget beneath the provider (a widget's own `router` prop wins). `undefined`:
   * Gully Core pools only.
   */
  readonly router: RouterEndpointConfig | undefined;
  /** The host's logo for a token that names none (see {@link WidgetProviderProps.tokenLogo}). */
  readonly tokenLogo: ((token: TokenInfo) => string | null | undefined) | undefined;
}

/**
 * The context itself. Exported so a host can detect whether a provider is
 * mounted above it (`useContext(WidgetContext) === null`) instead of catching
 * the throw from {@link useWidgetContext}; {@link useOptionalWidgetContext}
 * is the same test as a hook.
 */
export const WidgetContext = createContext<WidgetContextValue | null>(null);

/** Props accepted by {@link WidgetProvider}. */
export interface WidgetProviderProps {
  /** Where chain reads and writes go. Mock in dev, viem-backed in production. */
  readonly adapter: ProtocolAdapter;
  /**
   * Integrator fee attribution.
   *
   * Omit it and the widgets work, earning you nothing. Supplying it is the
   * entire commercial reason to embed them.
   */
  readonly integrator?: IntegratorConfig;
  readonly defaultSlippageBps?: number;
  readonly theme?: WidgetTheme;
  readonly locale?: string;
  /**
   * Opens the host's wallet-connect flow (RainbowKit's `openConnectModal`,
   * a custom modal, whatever the host has). While no account is connected the
   * widgets' primary button reads "Connect wallet"; with this set it is an
   * enabled button that calls it, without it the button stays a disabled label
   * and the visitor connects through the host's own control. A widget's own
   * `onConnectRequest` prop overrides this one.
   */
  readonly onConnectRequest?: () => void;
  /**
   * The router API every SwapWidget beneath this provider asks for routed fills (the same value as
   * SwapWidget's `router` prop, which overrides it per widget). Absent: Gully Core pools only. The widget
   * falls back to Gully Core pools on any routing failure.
   */
  readonly router?: RouterEndpointConfig;
  /**
   * The logo of a token that carries none of its own (no `logoUrl` from the adapter or a token list): a
   * launch token's own icon from its metadata, the chain's native mark for the native coin and its wrapped
   * form. Return `https://`, `ipfs://` or a same-origin root-relative path, or `null` for none; the widget
   * draws a monogram then, and when the image fails to load. Called during render: keep it a lookup.
   */
  readonly tokenLogo?: (token: TokenInfo) => string | null | undefined;
  readonly children: ReactNode;
}

/** Root provider. Wrap every widget in exactly one of these. */
export function WidgetProvider(props: WidgetProviderProps): ReactElement {
  const {
    adapter,
    integrator,
    defaultSlippageBps = DEFAULT_SLIPPAGE_BPS,
    theme = "dark",
    locale,
    onConnectRequest,
    router,
    tokenLogo,
    children,
  } = props;

  // Throws synchronously during render on a bad config. That is intended: a
  // widget that silently drops the integrator's fee is worse than one that
  // refuses to mount and says why.
  const resolvedIntegrator = useMemo(
    () => resolveIntegratorConfig(integrator ?? null),
    [integrator],
  );

  const chain = adapter.chain;

  useMemo(() => {
    assertValidChainConfig(chain);
    return null;
  }, [chain]);

  if (!Number.isInteger(defaultSlippageBps) || defaultSlippageBps < 0) {
    throw new RangeError(
      `[@gullylabs/core-widgets] defaultSlippageBps must be a non-negative integer: ${defaultSlippageBps}`,
    );
  }
  if (defaultSlippageBps > MAX_SLIPPAGE_BPS) {
    throw new RangeError(
      `[@gullylabs/core-widgets] defaultSlippageBps ${defaultSlippageBps} exceeds ` +
        `MAX_SLIPPAGE_BPS (${MAX_SLIPPAGE_BPS})`,
    );
  }

  useEffect(() => {
    for (const warning of resolvedIntegrator.warnings) {
      // eslint-disable-next-line no-console
      console.warn(`[@gullylabs/core-widgets] ${warning}`);
    }
  }, [resolvedIntegrator]);

  const value = useMemo<WidgetContextValue>(
    () => ({
      adapter,
      chain,
      integrator: resolvedIntegrator,
      defaultSlippageBps,
      theme,
      locale,
      onConnectRequest,
      router,
      tokenLogo,
    }),
    [adapter, chain, resolvedIntegrator, defaultSlippageBps, theme, locale, onConnectRequest, router, tokenLogo],
  );

  return <WidgetContext.Provider value={value}>{children}</WidgetContext.Provider>;
}

/** Reads the widget context. Throws when used outside a {@link WidgetProvider}. */
export function useWidgetContext(): WidgetContextValue {
  const value = useContext(WidgetContext);
  if (value === null) {
    throw new Error(
      "[@gullylabs/core-widgets] no WidgetProvider found. Wrap your app (or just the " +
        "widget) in <WidgetProvider adapter={...} integrator={...}>.",
    );
  }
  return value;
}

/**
 * Reads the widget context, or `null` when no {@link WidgetProvider} is
 * mounted above. For hosts that mount the provider late (once a pool
 * directory is read, say) and want to render a waiting state in the
 * meantime without an error boundary.
 */
export function useOptionalWidgetContext(): WidgetContextValue | null {
  return useContext(WidgetContext);
}

/** Convenience accessor for the adapter. */
export function useProtocolAdapter(): ProtocolAdapter {
  return useWidgetContext().adapter;
}

/** Convenience accessor for the validated integrator config. */
export function useIntegrator(): ResolvedIntegratorConfig {
  return useWidgetContext().integrator;
}
