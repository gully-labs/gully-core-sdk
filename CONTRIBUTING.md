# Contributing

Issues and pull requests are welcome. The packages are developed in Gully Labs' monorepo and mirrored here, so
an accepted pull request is applied there and arrives back in this repository with the next sync; the
history of this repository starts at the first public release.

Before you open a pull request:

```bash
pnpm install
pnpm build && pnpm typecheck && pnpm test
```

Addresses are never edited by hand. They are generated from the public deployment records in
https://github.com/gully-labs/gully-core/tree/main/deployments (`packages/sdk/records`), and `pnpm sync-check`
fails when they differ.
