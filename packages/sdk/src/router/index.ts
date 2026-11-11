/**
 * `@gullylabs/core-sdk/router` — the Gully Core Router API client. See `client.ts` for what it verifies.
 */
export {
  GullyCoreRouterClient,
  GullyCoreRouterError,
  approvalsOf,
  type GullyCoreRouterClientOptions,
  type RouterApproval,
  type RouterErrorCode,
  type RouterQuote,
  type RouterRoutedFee,
  type RouterSwap,
} from "./client.js";

// Calldata verification for integrators that build their own flow around the API (audit D, 2026-10-07).
export { verifySwapCalldata, swapKindFromCalldata, isErc8021Suffix, ERC8021_MARKER, UnverifiedSwapCalldata, FILL_ABI as GULLYCORE_FILL_ROUTER_FILL_ABI, type SwapRequestFacts, type SwapTxFacts } from "./verify.js";
