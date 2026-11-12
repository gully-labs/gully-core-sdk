import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CLI_VERSION } from "../src/version.js";

describe("CLI_VERSION", () => {
  it("matches package.json", () => {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string };
    expect(CLI_VERSION).toBe(pkg.version);
  });
});

describe("bin", () => {
  /* `npx @gullylabs/core-cli <cmd>` needs a bin named after the package: with two bins and none called
     "core-cli", npm exits "could not determine executable to run" (found on the published 0.3.0). */
  it("has a core-cli bin that runs the gullycore command", () => {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { bin: Record<string, string> };
    expect(pkg.bin["core-cli"]).toBeDefined();
    expect(pkg.bin["core-cli"]).toBe(pkg.bin["gullycore"]);
  });
});
