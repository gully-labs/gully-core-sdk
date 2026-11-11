/**
 * The public pages' code samples compile against THIS source.
 *
 * The docs Quickstart and the landing's Builders section (the Gully Core app) render their
 * TypeScript listings from the files under `apps/web/src/routes/docs/samples/`,
 * imported as raw text (`routes/docs/samples.ts`), so what a reader copies is
 * byte for byte what is compiled here. The web app's own `tsc -b` checks the same
 * files against the built `dist/`; this test checks them against `src/`, with this
 * package's strictest options, so a rename or a signature change in the SDK fails
 * `npm test` here before the public pages can show code that does not exist.
 *
 * The Solidity sample is checked against the scaffolder by packages/cli.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const sdkRoot = resolve(here, "..");
const samplesDir = resolve(sdkRoot, "..", "..", "apps", "web", "src", "routes", "docs", "samples");

const SUBPATHS = ["split", "lock", "drop", "launchpad", "deployments", "events", "indexer", "registry", "router", "safe", "trading"] as const;

function compile(files: readonly string[]): readonly string[] {
  const paths: Record<string, string[]> = {
    "@gullylabs/core-sdk": [join(sdkRoot, "src", "index.ts")],
    // One viem: the SDK's. A second copy would make every PublicClient nominally different.
    viem: [join(sdkRoot, "node_modules", "viem")],
    "viem/*": [join(sdkRoot, "node_modules", "viem", "*")],
  };
  for (const sub of SUBPATHS) paths[`@gullylabs/core-sdk/${sub}`] = [join(sdkRoot, "src", sub, "index.ts")];

  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
    types: [],
    strict: true,
    noUncheckedIndexedAccess: true,
    exactOptionalPropertyTypes: true,
    noUnusedLocals: true,
    noUnusedParameters: true,
    noEmit: true,
    skipLibCheck: true,
    isolatedModules: true,
    moduleDetection: ts.ModuleDetectionKind.Force,
    allowImportingTsExtensions: true,
    paths,
  };
  const program = ts.createProgram({ rootNames: [...files], options });
  const host: ts.FormatDiagnosticsHost = {
    getCanonicalFileName: (f) => f,
    getCurrentDirectory: () => sdkRoot,
    getNewLine: () => "\n",
  };
  return ts.getPreEmitDiagnostics(program).map((d) => ts.formatDiagnostic(d, host).trim());
}

describe("docs samples", () => {
  const present = existsSync(samplesDir);
  const files = present
    ? readdirSync(samplesDir)
        .filter((f) => f.endsWith(".ts"))
        .map((f) => join(samplesDir, f))
    : [];

  /* The samples live in the Gully Core app's docs, in the monorepo; the public mirror has no app, so this skips there. */
  it.skipIf(!present)("are where the docs page imports them from", () => {
    expect(present, `no samples at ${samplesDir}`).toBe(true);
    expect(files.length).toBeGreaterThanOrEqual(2);
  });

  it("typecheck against the SDK source with strict options", () => {
    const errors = compile(files);
    expect(errors, errors.join("\n\n")).toEqual([]);
  }, 120_000);

  it("import only MIT packages: the SDK and viem", () => {
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      for (const m of text.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
        const spec = m[1] ?? "";
        expect(spec === "viem" || spec.startsWith("viem/") || spec === "@gullylabs/core-sdk" || spec.startsWith("@gullylabs/core-sdk/"), `${f} imports ${spec}`).toBe(true);
      }
    }
  });

  it("hide only single declaration lines from the reader", () => {
    // The page drops lines ending in `// @docs-hide`. Only ambient setup may be hidden,
    // never a statement that does something, or the copied code would not run.
    for (const f of files) {
      for (const line of readFileSync(f, "utf8").split(/\r?\n/)) {
        if (!line.trimEnd().endsWith("// @docs-hide")) continue;
        expect(/^(declare |import type )/.test(line.trim()), `${f}: "${line.trim()}"`).toBe(true);
      }
    }
  });
});
