// SPDX-License-Identifier: MIT
/**
 * Gully Core widgets.
 *
 * Embeddable swap, liquidity and launch UI for Gully Core, in two layers:
 *
 * - **Headless** (`@gullylabs/core-widgets/headless`) - hooks and pure functions
 *   with no markup and no styles. Build your own UI on them.
 * - **Styled** (this entry) - drop-in components on top of the headless layer,
 *   themed entirely through `--gullycore-*` CSS custom properties.
 *
 * Both share one thing that is not optional: `integrator: { referrer, feeBps }`
 * is validated once at the provider and threaded into the swap call path, so the
 * site embedding the widget earns from the flow it sends.
 *
 * @packageDocumentation
 */

// --- configuration ---------------------------------------------------------
export * from "./config/integrator.js";
export * from "./config/chain.js";

// --- headless core ---------------------------------------------------------
export * from "./core/math.js";
export * from "./core/routed.js";
export * from "./core/format.js";
export * from "./core/clMath.js";
export * from "./core/errors.js";
export * from "./core/launchCharges.js";
export * from "./core/pool.js";
export * from "./core/tokenLists.js";
export { buildUniformBinDistribution } from "./adapters/binDistribution.js";

// --- chain boundary --------------------------------------------------------
export * from "./adapters/protocol.js";
export * from "./adapters/sale.js";
export {
  createViemAdapter,
  type ViemAdapterOptions,
  type ViemAdapterOverrides,
  type WidgetWallet,
} from "./adapters/viem.js";

// --- call path -------------------------------------------------------------
export * from "./callpath/constants.js";
export * from "./callpath/plan.js";
export * from "./callpath/swap.js";
export * from "./callpath/permit2.js";
export * from "./callpath/liquidity.js";
export * from "./callpath/launch.js";

// --- react: provider and hooks --------------------------------------------
export * from "./context/WidgetProvider.js";
export * from "./hooks/useAsyncResource.js";
export * from "./hooks/useSwapQuote.js";
export * from "./hooks/useSwapExecute.js";
export * from "./hooks/useRoutedSwap.js";
export * from "./hooks/useLiquidity.js";
export * from "./hooks/useLaunch.js";
export * from "./hooks/useTokens.js";
export * from "./hooks/useTokenLists.js";
export * from "./hooks/useLocks.js";
export * from "./locks/model.js";
export * from "./locks/embedModel.js";
export * from "./locks/scan.js";
export * from "./trust/model.js";
export * from "./hooks/useTokenTrust.js";
export * from "./locker/model.js";
export * from "./hooks/useLocker.js";
export * from "./components/swap/state.js";

// --- react: styled components ---------------------------------------------
export * from "./components/primitives.js";
export * from "./components/SwapWidget.js";
export * from "./components/LiquidityWidget.js";
export * from "./components/LaunchWidget.js";
export * from "./components/LocksWidgets.js";
export * from "./components/TokenTrustPanel.js";
export * from "./components/LockerWidget.js";

// --- theming ---------------------------------------------------------------
export { WIDGET_CSS, injectWidgetStyles } from "./styles/css.js";
