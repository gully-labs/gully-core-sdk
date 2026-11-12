# Changelog — `@gullylabs/create-core-app`

## 0.3.1 (unreleased)

- The scaffolded app installs from npm: `@gullylabs/core-connect` 0.2.0 and `@gullylabs/core-widgets` 0.3.0, which
  the template depends on, are published in the same batch (0.3.0's `npm install` failed with 404 on both).
- `--chain` accepts every display name `--help` prints ("gully chain testnet", "BNB Chain", any case).
- API keys link to <https://app.gullycore.xyz/app/developers> (was the retired gullychain.xyz/core/developers).
- The app's `npm run build` runs Vite with a 4 GB heap (`node --max-old-space-size=4096`, works on Windows): the
  wallet stack bundles ~5,700 modules and Vite ran out of memory at Node's default heap on a 3 GB machine.
- `--help` drops the "from a checkout" and "once the package is on npm" lines.

## 0.2.0 — 2026-10-14

First release on npm. The template installs `@gullylabs/core-sdk` ^0.2.0,
`@gullylabs/core-connect` ^0.2.0 and `@gullylabs/core-widgets` ^0.3.0.

- The template on the current stack: routed fills, token logos, USD figures with their source,
  animated interactive charts, market-cap-first launches, drafts.
- The Launches page shows each pool's market cap read from the chain.
