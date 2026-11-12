// SPDX-License-Identifier: MIT
/**
 * Headless entry point: logic without markup.
 *
 * Import from here when you are building your own UI. It carries the config
 * validation, the quote math, the chain adapters, the call-path encoders and
 * the React controllers - and no components, no stylesheet, and no
 * `react-dom/client`.
 *
 * ```ts
 * import {
 *   WidgetProvider,
 *   useSwapQuote,
 *   useSwapExecute,
 *   validateIntegratorConfig,
 * } from "@gullylabs/core-widgets/headless";
 * ```
 *
 * The one thing you do not get to skip by going headless is fee validation:
 * `WidgetProvider` validates the integrator config, and the call-path builders
 * refuse a `ResolvedIntegratorConfig` that did not come from it.
 *
 * @packageDocumentation
 */

export * from "./config/integrator.js";
export * from "./config/chain.js";

export * from "./core/math.js";
export * from "./core/routed.js";
export * from "./core/format.js";
export * from "./core/clMath.js";
export * from "./core/errors.js";
export * from "./core/pool.js";
export * from "./core/tokenLists.js";
export * from "./core/liquidityGuards.js";
export * from "./core/liquidityRefresh.js";
export { buildUniformBinDistribution } from "./adapters/binDistribution.js";

export * from "./adapters/protocol.js";
export * from "./adapters/sale.js";
export {
  createViemAdapter,
  type ViemAdapterOptions,
  type ViemAdapterOverrides,
  type WidgetWallet,
} from "./adapters/viem.js";

export * from "./callpath/constants.js";
export * from "./callpath/plan.js";
export * from "./callpath/swap.js";
export * from "./callpath/liquidity.js";
export * from "./callpath/launch.js";

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
