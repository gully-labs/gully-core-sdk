# Releasing `@gullylabs/core-sdk`, `@gullylabs/core-cli` and `@gullylabs/create-core-app`

The three packages are released together from the public repository
<https://github.com/gully-labs/gully-core-sdk>, never from a working tree with local changes.

1. **Addresses first.** When a chain or contract changes, copy the new `deployments/<id>.json` from
   <https://github.com/gully-labs/gully-core> to `records/gully-core-<id>.json`, run
   `npm run generate:deployments`, and check `npm run sync-check` is green (it also compares
   <https://gullycore.xyz/manifest.json>).
2. **Version.** Bump the three `package.json` versions (and `src/version.ts` in create-core-app, the
   SDK range in the CLI's `codegen/app.ts` and in the app template's `package.json`), and add the
   CHANGELOG entries.
3. **Publish.** From a clean checkout of the tagged commit of the public repository:

   ```bash
   bash scripts/publish.sh --dry-run   # build, typecheck, tests, sync check, tarball smoke, npm publish --dry-run
   bash scripts/publish.sh             # the same, then npm publish for each package, in order
   ```

   `scripts/publish.sh` uses `NPM_TOKEN` from the environment when it is set (an npm automation token
   for the `@gullylabs` scope), or the npm login of the machine it runs on. With GitHub Actions, the
   release workflow does the same on a `v*` tag and adds npm provenance.
4. **Verify.** `npm view @gullylabs/core-sdk version`, then install the published version in a fresh
   folder and run the README's quote example.

A version on npm is permanent: a bad one is deprecated (`npm deprecate`), never overwritten.
