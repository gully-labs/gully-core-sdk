// SPDX-License-Identifier: MIT
import { defineConfig } from "vitest/config";

/*
 * The scaffolder's own tests, AND the template's pure-logic tests.
 *
 * WHY THE TEMPLATE'S TESTS RUN HERE NOW. They used to be excluded on the reasoning that they "need
 * the template's real dependencies — run them there, never from here against whatever this package
 * happens to have installed". The reasoning was sound and the consequence was not: `template/`
 * ships no `node_modules` and nothing in this repo scaffolds a project, so those four suites ran
 * NOWHERE — not in `npm test`, not in CI. A test nobody runs is documentation. (Found 2026-09-20,
 * while verifying the `chain.router` work: eight new tests were green in a scratch install and
 * invisible to every command anyone actually runs.)
 *
 * The objection is answered rather than ignored: `viem` and `@gullylabs/core-sdk` are now
 * devDependencies of THIS package, pinned to exactly what `template/package.json` declares, so
 * "whatever this package happens to have installed" is the template's own stack. Keep them in step
 * — if the template bumps `viem`, bump it here in the same commit or this stops testing the thing
 * it claims to.
 *
 * ⚠ WHAT THIS STILL DOES NOT COVER, so nobody reads a green run as more than it is. Only the
 * dependency-light suites run here. The template's REACT surfaces, its typecheck and its `vite
 * build` need a real scaffolded install with React, wagmi and RainbowKit — CLAUDE.md's "a template
 * typecheck needs a REAL install" still stands and this does not replace it. A glob reaching
 * `src/components/**` would fail on import, not pass.
 *
 * The `src/lib/**` glob is deliberately left OPEN with two named exclusions rather than replaced
 * by a list of the files that happen to work today. A list is how these suites got lost in the
 * first place: a new pure-logic test would be added and silently run nowhere. With the glob open,
 * a new test is picked up automatically and only a genuinely React-dependent one has to be
 * argued for here. Both exclusions are the module under test pulling in the app stack, NOT the
 * test doing anything unusual:
 *   * chart.test.ts → chart.ts imports `react` (it exposes a hook)
 *   * tx.test.ts    → tx.ts imports `react` AND `wagmi`
 * Pulling React and wagmi into a SCAFFOLDER's devDependencies to reach two files would re-earn the
 * objection this comment opens with, and bloat a package whose job is to copy a directory.
 */
/*
 * THE REST RUNS IN A SCAFFOLD: `npm run test:template` (scripts/test-template.mjs) packs
 * sdk / widgets / connect, scaffolds a project outside the repository with the BUILT
 * scaffolder, installs, and runs `tsc --noEmit`, `vite build` and the project's own
 * `vitest run` — which picks up every suite under `template/src/`, the React-dependent
 * ones (chart.test, tx.test, the chart kit's 50-odd rendering tests) included. That is the
 * proof that counts; this file is the fast half.
 */
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "template/src/config/**/*.test.ts", "template/src/lib/**/*.test.ts"],
    exclude: ["**/node_modules/**", "template/src/lib/chart.test.ts", "template/src/lib/tx.test.ts"],
    /* The scaffold suite walks and copies the whole template tree; on a loaded
       machine (or a Windows runner) that outlasts vitest's 5 s default. */
    testTimeout: 60_000,
  },
});
