/* The Bin hook template (src/codegen/binProject.ts): one permission set, one bitmap, one parameters word. */
import { contractsAvailable, solidity } from "./helpers/contracts.js";
import { describe, expect, it } from "vitest";
import { BIN_HOOK_FLAGS, encodeBinPoolParameters } from "@gullylabs/core-sdk";

import {
  BIN_SOLIDITY_CONSTANTS,
  BIN_SWAP_COUNTER,
  binContext,
  findBinTemplate,
  parseBinFee,
  parseBinStep,
  renderBinGullyCoreConfig,
  renderBinDeployScript,
  renderBinFoundryToml,
  renderBinHook,
  renderBinReadme,
  renderBinTest,
  resolveBinPermissions,
} from "../src/codegen/binProject.js";

const BIN_BASE = solidity("hooks", "src", "base", "BaseBinHook.sol");

const ctx = binContext({
  projectName: "bin-counter",
  contractName: "BinCounter",
  template: BIN_SWAP_COUNTER,
  binStep: 10,
  lpFee: 3000,
  cliVersion: "0.0.0-test",
  paths: { core: "lib/gullycore-contracts/packages/core", hooks: "lib/gullycore-contracts/packages/hooks" },
});

describe.skipIf(!contractsAvailable)("Bin permissions", () => {
  it("every BaseBinHook constant sits at the SDK's bit offset", () => {
    for (const [name, constant] of Object.entries(BIN_SOLIDITY_CONSTANTS)) {
      const offset = BIN_HOOK_FLAGS[name as keyof typeof BIN_HOOK_FLAGS];
      expect(BIN_BASE, `${constant}`).toContain(`uint16 internal constant ${constant} = 1 << ${offset};`);
    }
  });

  it("the swap counter registers afterSwap only: 0x0080", () => {
    const p = resolveBinPermissions(BIN_SWAP_COUNTER.permissions);
    expect(p.bitmap).toBe(0x80);
    expect(p.bitmapHex).toBe("0x0080");
    expect(p.solidityExpression).toBe("AFTER_SWAP");
  });

  it("refuses a returns-delta flag without its base callback", () => {
    expect(() => resolveBinPermissions(["afterSwapReturnsDelta"])).toThrow(/invalid Bin permission bitmap/);
  });
});

describe("the generated project", () => {
  it("computes the parameters word with the SDK's Bin encoder, bin step in bits 16..31", () => {
    expect(ctx.parameters).toBe(encodeBinPoolParameters(0x80, 10));
    expect(BigInt(ctx.parameters)).toBe(0x80n | (10n << 16n));
  });

  it("writes the same bitmap and word into the hook, the test, the script, the README and gullycore.json", () => {
    const hook = renderBinHook(ctx);
    const test = renderBinTest(ctx);
    const script = renderBinDeployScript(ctx);
    const readme = renderBinReadme(ctx);
    const json = JSON.parse(renderBinGullyCoreConfig(ctx)) as { poolType: string; permissions: { bitmapHex: string }; poolKey: { parameters: string; binStep: number } };
    expect(hook).toContain("return AFTER_SWAP;");
    expect(hook).toContain(ctx.parameters);
    expect(test).toContain(`EXPECTED_BITMAP = ${ctx.permissions.bitmapHex};`);
    expect(test).toContain(`EXPECTED_PARAMETERS = ${ctx.parameters};`);
    expect(script).toContain(`EXPECTED_BITMAP = ${ctx.permissions.bitmapHex};`);
    expect(readme).toContain(ctx.parameters);
    expect(json.poolType).toBe("Bin");
    expect(json.permissions.bitmapHex).toBe("0x0080");
    expect(json.poolKey).toMatchObject({ parameters: ctx.parameters, binStep: 10 });
  });

  it("is GPL-2.0-or-later and extends BaseBinHook through the gullycore-hooks remapping", () => {
    for (const src of [renderBinHook(ctx), renderBinTest(ctx), renderBinDeployScript(ctx)]) {
      expect(src.startsWith("// SPDX-License-Identifier: GPL-2.0-or-later\n")).toBe(true);
    }
    expect(renderBinHook(ctx)).toContain('import {BaseBinHook} from "gullycore-hooks/src/base/BaseBinHook.sol";');
    expect(renderBinHook(ctx)).toContain("contract BinCounter is BaseBinHook {");
  });

  it("overrides _afterSwap with BaseBinHook's own signature", () => {
    if (contractsAvailable) expect(BIN_BASE).toMatch(/function _afterSwap\(address, PoolKey calldata, bool, int128, BalanceDelta, bytes calldata\)\s+internal\s+virtual\s+returns \(bytes4, int128\)/);
    expect(renderBinHook(ctx)).toMatch(/function _afterSwap\(address, PoolKey calldata key, bool, int128, BalanceDelta, bytes calldata\)\s+internal\s+override\s+returns \(bytes4, int128\)/);
  });

  it("builds under both profiles from the same remappings as a CL project", () => {
    const toml = renderBinFoundryToml(ctx);
    expect(toml).toContain("[profile.default]");
    expect(toml).toContain("[profile.legacy]");
    expect(toml).toContain('"gullycore-hooks/=lib/gullycore-contracts/packages/hooks/"');
    expect(toml).toContain("hp-transient/=lib/gullycore-contracts/packages/core/src/libraries/transient/eip1153/");
    expect(toml).toContain("hp-transient/=lib/gullycore-contracts/packages/core/src/libraries/transient/storage/");
  });
});

describe("flags", () => {
  it("finds the template by id", () => {
    expect(findBinTemplate(" BIN-swap-counter ")).toBe(BIN_SWAP_COUNTER);
    expect(findBinTemplate("swap-counter")).toBeUndefined();
  });

  it("bin step: 1..100, default 10", () => {
    expect(parseBinStep(undefined)).toBe(10);
    expect(parseBinStep("1")).toBe(1);
    expect(parseBinStep("100")).toBe(100);
    for (const bad of ["0", "101", "x", "-3"]) expect(() => parseBinStep(bad)).toThrow(/--bin-step/);
  });

  it("fee: a static fee up to the Bin maximum of 10%, never 'dynamic'", () => {
    expect(parseBinFee(undefined)).toBe(3000);
    expect(parseBinFee("100000")).toBe(100_000);
    for (const bad of ["100001", "dynamic", "-1", "x"]) expect(() => parseBinFee(bad)).toThrow(/--fee/);
  });
});
