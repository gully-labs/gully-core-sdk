// SPDX-License-Identifier: MIT
/**
 * Modules that live in this source tree but are NOT released: their contracts are not deployed
 * on any chain yet. Gully Core's own apps compile against this tree and use them; the npm package
 * and the public source mirror ship without them, and gain them in the release that follows the
 * contracts' deployment and read-back.
 *
 * Used by the npm staging step (on `dist/`).
 * Both strip the same three things: the module's directory, its `package.json` subpath export,
 * and every re-export of it from the root index. Then they ASSERT nothing still names it, so a
 * new re-export written in a form this regex misses fails the release instead of shipping a
 * root index that imports a file which is not there.
 *
 * The address-book fields reserved for these contracts (`rangeOrders`, `dca`, `vaultFactory`,
 * `lpRewardsHook`, `oracleHook`, `dexHook`, `tunerGate`) stay in the types: they are `null` or
 * absent on every chain, and the address-book data and its type must not disagree.
 */

import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/* RELEASED 2026-10-16: limit orders + DCA, managed vaults and liquidity rewards are deployed and read back on HyperEVM,
   Robinhood Chain and Base (the address book carries them; BNB follows). The list is empty; the machinery stays for the
   next module whose contracts are not deployed yet. An EMPTY list must strip nothing: `(?:)` would match every path. */
export const UNRELEASED_MODULES = []

const names = UNRELEASED_MODULES.join('|')
/* `export * as x from "./m/index.js";`, `export { a, b as c, } from "./m/index.js";`,
   `export type { ... } from "./m/index.js";`, with the run of `//` comment lines and the one-line
   JSDoc directly above it (a module's section header goes with it). */
const REEXPORT = new RegExp(
  String.raw`(?:^[ \t]*//[^\n]*\r?\n)*(?:^[ \t]*/\*\*[^\n]*\*/[ \t]*\r?\n)?^[ \t]*export\s+(?:type\s+)?(?:\*\s+as\s+\w+|\{[^}]*\})\s+from\s+["']\./(?:${names})/[^"']*["'];?[ \t]*\r?\n?`,
  'gm',
)
const MENTION = new RegExp(String.raw`["']\.\.?/(?:\.\./)*(?:${names})/`)

/** The root index with every re-export of an unreleased module removed. Throws if one survives. */
export function stripIndex(text, label) {
  if (UNRELEASED_MODULES.length === 0) return text
  const out = text.replace(REEXPORT, '')
  if (MENTION.test(out)) throw new Error(`${label}: still names an unreleased module (${UNRELEASED_MODULES.join(', ')}) after stripping`)
  return out
}

/** `package.json` with the unreleased subpath exports removed. */
export function stripManifest(manifest) {
  const m = structuredClone(manifest)
  for (const name of UNRELEASED_MODULES) if (m.exports !== undefined) delete m.exports[`./${name}`]
  return m
}

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

/**
 * Strips a built package directory in place (`dist/` beside `package.json`): the modules'
 * directories, the root index's re-exports (`index.js`, `index.d.ts`), their now-wrong source
 * maps, and the subpath exports. Then checks that no file left in `dist/` imports one of them.
 */
export function stripBuiltPackage(pkgDir) {
  if (UNRELEASED_MODULES.length === 0) return
  const dist = join(pkgDir, 'dist')
  for (const name of UNRELEASED_MODULES) rmSync(join(dist, name), { recursive: true, force: true })
  for (const f of ['index.js', 'index.d.ts']) {
    const p = join(dist, f)
    const text = readFileSync(p, 'utf8').replace(/^\/\/# sourceMappingURL=.*$/m, '')
    writeFileSync(p, stripIndex(text, `dist/${f}`))
    rmSync(`${p}.map`, { force: true })
  }
  const manifestPath = join(pkgDir, 'package.json')
  writeFileSync(manifestPath, `${JSON.stringify(stripManifest(JSON.parse(readFileSync(manifestPath, 'utf8'))), null, 2)}\n`)
  for (const f of walk(dist)) {
    if (!/\.(js|d\.ts)$/.test(f)) continue
    if (MENTION.test(readFileSync(f, 'utf8'))) throw new Error(`${f} imports an unreleased module`)
  }
  for (const name of UNRELEASED_MODULES) if (existsSync(join(dist, name))) throw new Error(`dist/${name} survived`)
}
