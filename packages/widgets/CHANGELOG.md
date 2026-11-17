# Changelog — `@gullylabs/core-widgets`

## 0.4.0 — 2026-11-12

Buy alerts for any website, no Telegram group needed.

- `<gully-buys chain="8453" token="0x…">`: real-time buys of a token in every Gully Core pool
  it has on a chain, read from the pool managers' `Swap` logs through Gully RPC's keyless
  project (15 s poll while the tab is visible) after a history from the Gully Core API, so
  the widget is never empty. No API key. Chains: Base, BNB Chain, Robinhood Chain, Kinetiq
  Elysium, Anubis, Gully Chain Testnet.
- Three layouts by attribute: `feed` (card list), `strip` (one bar across the page),
  `toast` (corner pop-ups). `sells` shows sells too (red). `theme` dark (default), light, auto.
- Dollars first ("$42.10") with the quote amount in small print, from the API's price
  answer; an unpriced quote says "unpriced". The buy bot's emoji scale (one per `step`
  dollars, up to 40). Links: the trade on the chain's explorer, the token page on the
  Gully Core app.
- Shadow DOM, `--gully-buys-*` custom properties, `prefers-reduced-motion` honoured.
- React: `BuysFeed`. Pure model exported for tests (`parseBuysAttributes`, `mergeTape`,
  `emojiCount`, `alertView`, `buysSnippet`).
- New standalone bundle `buys.js` / `buys.mjs` (IIFE global `GullyBuys`), hosted at
  https://gullycore.xyz/buys.js. Docs: https://docs.gullycore.xyz/buy-alerts/.

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
