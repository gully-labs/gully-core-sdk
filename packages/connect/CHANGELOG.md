# Changelog — `@gullylabs/core-connect`

## 0.2.0 on npm (2026-11, with core-sdk 0.3.1)

The 0.2.0 entry below was prepared but never published; it first goes to npm in the 0.3.1 batch, from the public
repo gully-labs/gully-core-sdk, because `@gullylabs/create-core-app`'s template depends on it.

## 0.2.0 — 2026-10-14

First release on npm. The Gully Core wallet layer over RainbowKit and wagmi: the Gully Core chain list
(HyperEVM, BNB Chain, Robinhood Chain, Base) with measured public endpoints and cooldown on limit
answers, and the Gully Core theme in the sea-green action colour.

`GULLYCORE_DEPLOYED_CHAIN_IDS` names the four chains Gully Core is deployed on (999, 56, 4663,
8453), so the chain switcher lists them as available and every other chain as coming soon.
