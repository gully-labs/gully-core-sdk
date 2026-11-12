# Changelog — `@gullylabs/core-widgets`

## 0.3.0 on npm (2026-11, with core-sdk 0.3.1)

The 0.3.0 entry below was prepared but never published; it first goes to npm in the 0.3.1 batch, from the public
repo gully-labs/gully-core-sdk, because `@gullylabs/create-core-app`'s template depends on it.

## 0.3.0 — 2026-10-14

First release on npm. Depends on `@gullylabs/core-sdk` ^0.2.0.

- `SwapWidget`: one layout everywhere (You pay / You receive, balance fractions, flip, back-solve
  for a typed output, collapsible summary, price-impact colours, review step).
- Routed fills through the Gully Core router, with Permit2 by signature and every router
  transaction checked by the SDK's `verifySwapCalldata`.
- Pay with the native coin into a wrapped-native pool, and receive it on a sell.
- Real token logos through the `tokenLogo` provider prop; market-hours and price-band notes on
  stock pairs.
- Dark theme by default; the sea-green action colour.
