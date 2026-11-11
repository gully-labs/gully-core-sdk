import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterAll, describe, expect, it } from "vitest";

import {
  APP_DEPENDENCY_LICENCES,
  APP_TEMPLATES,
  appFiles,
  findAppTemplate,
  renderAppPackageJson,
  sdkDependencyFor,
  type AppContext,
  type AppTemplate,
} from "../src/codegen/app.js";
import { findTemplate } from "../src/templates/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const cliRoot = resolve(here, "..");
const sdkRoot = resolve(cliRoot, "..", "sdk");

// Where a dependency lives depends on the install layout: .npmrc says node-linker=hoisted, so in a fresh checkout
// @types/node and viem sit in the repo root node_modules, not under the package. Ask Node's resolver instead.
function installedDir(from: string, pkg: string): string {
  return dirname(createRequire(join(from, "package.json")).resolve(`${pkg}/package.json`));
}
const viemDir = installedDir(sdkRoot, "viem");
const typesDir = dirname(installedDir(cliRoot, "@types/node"));

function ctxFor(template: AppTemplate, sdkDependency = "file:../sdk"): AppContext {
  return { projectName: `my-${template.id}`, template, sdkDependency, cliVersion: "0.0.0-test" };
}

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

/** Write a generated project to a temp dir and typecheck its `src/` against the SDK SOURCE. */
function compileGenerated(template: AppTemplate): readonly string[] {
  const dir = mkdtempSync(join(tmpdir(), `gullycore-app-${template.id}-`));
  scratch.push(dir);
  for (const [rel, contents] of appFiles(ctxFor(template))) {
    const path = join(dir, ...rel.split("/"));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents, "utf8");
  }
  const paths: Record<string, string[]> = {
    "@gullylabs/core-sdk": [join(sdkRoot, "src", "index.ts")],
    viem: [viemDir],
    "viem/*": [join(viemDir, "*")],
  };
  for (const sub of ["split", "lock", "drop", "launchpad", "deployments"]) paths[`@gullylabs/core-sdk/${sub}`] = [join(sdkRoot, "src", sub, "index.ts")];
  const roots = template.scripts.map((s) => join(dir, "src", s.file));
  const program = ts.createProgram({
    rootNames: roots,
    options: {
      // The generated tsconfig.json's options, plus paths to the SDK source.
      target: ts.ScriptTarget.ES2022,
      lib: ["lib.es2022.d.ts"],
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      strict: true,
      noUncheckedIndexedAccess: true,
      exactOptionalPropertyTypes: true,
      noUnusedLocals: true,
      skipLibCheck: true,
      noEmit: true,
      types: ["node"],
      typeRoots: [typesDir],
      paths,
    },
  });
  const host: ts.FormatDiagnosticsHost = { getCanonicalFileName: (f) => f, getCurrentDirectory: () => dir, getNewLine: () => "\n" };
  return ts.getPreEmitDiagnostics(program).map((d) => ts.formatDiagnostic(d, host).trim());
}

describe("app templates", () => {
  it("do not collide with hook template ids", () => {
    for (const t of APP_TEMPLATES) expect(findTemplate(t.id), t.id).toBeUndefined();
    expect(findAppTemplate("AIRDROP")?.id).toBe("airdrop");
    expect(findAppTemplate("noop")).toBeUndefined();
  });

  for (const template of APP_TEMPLATES) {
    describe(template.id, () => {
      const files = new Map(appFiles(ctxFor(template)));

      it("depends only on MIT packages", () => {
        const pkg = JSON.parse(renderAppPackageJson(ctxFor(template))) as {
          license: string;
          dependencies: Record<string, string>;
          devDependencies: Record<string, string>;
        };
        expect(pkg.license).toBe("MIT");
        for (const name of [...Object.keys(pkg.dependencies), ...Object.keys(pkg.devDependencies)]) {
          expect(APP_DEPENDENCY_LICENCES[name], `${name} is not on the MIT list`).toBe("MIT");
        }
        expect(Object.keys(APP_DEPENDENCY_LICENCES).every((n) => APP_DEPENDENCY_LICENCES[n] === "MIT")).toBe(true);
      });

      it("every npm script points at a generated file", () => {
        const pkg = JSON.parse(files.get("package.json") ?? "{}") as { scripts: Record<string, string> };
        for (const s of template.scripts) {
          expect(pkg.scripts[s.name]).toBe(`tsx src/${s.file}`);
          expect(files.has(`src/${s.file}`), s.file).toBe(true);
        }
      });

      it("imports only the SDK, viem, node builtins and its own files", () => {
        for (const [rel, text] of files) {
          if (!rel.endsWith(".ts")) continue;
          for (const m of text.matchAll(/from\s+"([^"]+)"/g)) {
            const spec = m[1] ?? "";
            const allowed =
              spec === "viem" || spec === "viem/accounts" || spec === "@gullylabs/core-sdk" || spec.startsWith("@gullylabs/core-sdk/") || spec.startsWith("node:") || spec.startsWith("./");
            expect(allowed, `${rel} imports ${spec}`).toBe(true);
          }
        }
      });

      it("writes only through runPlan, which simulates before it sends", () => {
        const tx = files.get("src/lib/tx.ts") ?? "";
        // The one sendTransaction in the project is after the simulation and behind execute.
        expect(tx.match(/sendTransaction\(/g)?.length).toBe(1);
        expect(tx.indexOf("ctx.client.call(")).toBeGreaterThan(-1);
        expect(tx.indexOf("ctx.client.call(")).toBeLessThan(tx.indexOf("sendTransaction("));
        expect(tx.indexOf("if (!ctx.execute)")).toBeLessThan(tx.indexOf("sendTransaction("));
        for (const s of template.scripts) {
          const src = files.get(`src/${s.file}`) ?? "";
          expect(src.includes("sendTransaction"), `${s.file} sends outside runPlan`).toBe(false);
          expect(src.includes("runPlan("), `${s.file}`).toBe(s.writes);
        }
      });

      it("reads keys only from the environment", () => {
        const chain = files.get("src/lib/chain.ts") ?? "";
        expect(chain).toContain('env("PRIVATE_KEY")');
        expect(chain).toContain("refuseKeyFlags");
        for (const [rel, text] of files) {
          if (!rel.startsWith("src/") || rel === "src/lib/chain.ts") continue;
          expect(text.includes("PRIVATE_KEY") && text.includes("privateKeyToAccount"), rel).toBe(false);
        }
        expect(files.get(".gitignore")).toContain(".env");
        expect(files.get(".env.example")).toMatch(/# PRIVATE_KEY=0x\.\.\./);
      });

      it("documents a dry run by default and the contract-enforced fee", () => {
        const readme = files.get("README.md") ?? "";
        expect(readme).toContain("Dry run by default");
        expect(readme).toContain("charged by the contract");
        for (const c of template.contracts) {
          expect(readme).toContain(c.env);
          expect(files.get(".env.example")).toContain(c.env);
        }
      });

      it("typechecks against the SDK source", () => {
        const errors = compileGenerated(template);
        expect(errors, errors.join("\n\n")).toEqual([]);
      }, 120_000);
    });
  }

  it("links the SDK from a checkout, and falls back to the registry outside one", () => {
    const inside = sdkDependencyFor(join(cliRoot, "..", "..", "my-drop"));
    expect(inside).toBe("file:../packages/sdk"); // relative to the project dir, repo/my-drop
    const outside = mkdtempSync(join(tmpdir(), "gullycore-no-checkout-"));
    scratch.push(outside);
    expect(sdkDependencyFor(join(outside, "my-drop"))).toBe("^0.3.0");
  });
});
