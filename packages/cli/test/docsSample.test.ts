/**
 * The Solidity listing on the public docs Quickstart (apps/web/src/routes/docs/samples/MyGullyCore.sol)
 * is what `create-hook --template swap-counter` writes, less its NatSpec: every code line of the
 * sample must be a line the generator emits. A renamed base contract, a changed callback signature
 * or a different import path in the scaffolder fails here before the docs show code nobody can build.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderHook } from "../src/codegen/project.js";
import { poolParametersFor, resolvePermissions } from "../src/permissions.js";
import { findTemplate } from "../src/templates/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const SAMPLE = resolve(here, "..", "..", "..", "apps", "web", "src", "routes", "docs", "samples", "MyGullyCore.sol");

describe("docs Solidity sample", () => {
  // The sample lives in the Gully Core app docs (monorepo only); the public mirror skips this.
  it.skipIf(!existsSync(SAMPLE))("is the swap-counter scaffold, line for line (comments aside)", () => {
    const template = findTemplate("swap-counter");
    if (template === undefined) throw new Error("no swap-counter template");
    const permissions = resolvePermissions(template.defaultPermissions);
    const hook = renderHook({
      projectName: "my-gullycore",
      contractName: "MyGullyCore",
      template,
      permissions,
      tickSpacing: 60,
      lpFee: 3000,
      parameters: poolParametersFor(permissions.bitmap, 60),
      templateApplies: true,
      cliVersion: "0.0.0-test",
      paths: { core: "../core", hooks: "../hooks" },
    });
    const generated = new Set(hook.split(/\r?\n/).map((l) => l.trim()));
    const code = readFileSync(SAMPLE, "utf8")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l !== "" && !l.startsWith("//"));
    expect(code.length).toBeGreaterThan(15);
    const missing = code.filter((l) => !generated.has(l));
    expect(missing, `lines the scaffolder does not write:\n${missing.join("\n")}`).toEqual([]);
  });
});
