/* The guide a coding agent reads in a generated project (renderAgentGuide, assets/agent/AGENTS.md). */
import { readFileSync } from "node:fs";
import { contractsAvailable, solidity } from "./helpers/contracts.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { renderAgentGuide, type ProjectContext } from "../src/codegen/project.js";
import { BIN_SWAP_COUNTER, binContext, renderBinAgentGuide } from "../src/codegen/binProject.js";
import { poolParametersFor, resolvePermissions, type PermissionName } from "../src/permissions.js";
import { findTemplate } from "../src/templates/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const RULES = readFileSync(join(here, "..", "assets", "agent", "AGENTS.md"), "utf8");
const BASE = solidity("hooks", "src", "base", "BaseCLHook.sol");
const BIN_BASE = solidity("hooks", "src", "base", "BaseBinHook.sol");

function contextFor(permissions: readonly PermissionName[], templateId: string, lpFee: number | undefined): ProjectContext {
  const template = findTemplate(templateId);
  if (template === undefined) throw new Error(`no template ${templateId}`);
  const resolved = resolvePermissions(permissions);
  return {
    projectName: "fee-gullycore",
    contractName: "FeeGullyCore",
    template,
    permissions: resolved,
    tickSpacing: 60,
    lpFee,
    parameters: poolParametersFor(resolved.bitmap, 60),
    templateApplies: true,
    cliVersion: "0.0.0-test",
    paths: { core: "lib/gullycore-contracts/packages/core", hooks: "lib/gullycore-contracts/packages/hooks" },
  };
}

describe("renderAgentGuide", () => {
  const ctx = contextFor(["beforeSwap"], "dynamic-fee", undefined);
  const guide = renderAgentGuide(ctx, RULES);

  it("states this project's own facts: files, callbacks, bitmap and the parameters word", () => {
    expect(guide).toContain("src/FeeGullyCore.sol");
    expect(guide).toContain("script/DeployFeeGullyCore.s.sol");
    expect(guide).toContain("`beforeSwap`");
    expect(guide).toContain(ctx.permissions.bitmapHex);
    expect(guide).toContain(ctx.parameters);
    expect(guide).toContain("lib/gullycore-contracts/packages/core");
  });

  it("says a returned fee is ignored when the pool's fee is static", () => {
    expect(guide).toContain("dynamic (`0x800000`)");
    const fixed = renderAgentGuide(contextFor(["beforeSwap"], "noop", 3000), RULES);
    expect(fixed).toContain("static, `3000`");
    expect(fixed).toContain("IGNORED");
  });

  it("carries the rules once, under the project's own heading", () => {
    expect(guide.match(/^# /gm)).toHaveLength(1);
    expect(guide).toContain("## Facts about the core");
    expect(guide).toContain("## Rules for a Gully Core that touches money");
    expect(guide).toContain("## Before you call it done");
  });

  it("tells an agent not to deploy, not to edit lib/, and never to print a key", () => {
    expect(guide).toContain("Do not deploy or send a transaction on a real chain");
    expect(guide).toContain("Never edit anything under `lib/`");
    expect(guide).toContain("Never print a key");
  });

  it("writes LF line endings whatever the rules file was checked out with", () => {
    expect(renderAgentGuide(ctx, RULES.replace(/\r?\n/g, "\r\n"))).not.toContain("\r");
  });
});

describe("renderBinAgentGuide", () => {
  const ctx = binContext({
    projectName: "bin-counter",
    contractName: "BinCounter",
    template: BIN_SWAP_COUNTER,
    binStep: 10,
    lpFee: 3000,
    cliVersion: "0.0.0-test",
    paths: { core: "lib/gullycore-contracts/packages/core", hooks: "lib/gullycore-contracts/packages/hooks" },
  });
  const guide = renderBinAgentGuide(ctx, RULES);

  it("states the Bin project's own facts: pool type, base, files, bitmap, word and bin step", () => {
    expect(guide).toContain("Bin (`BinPoolManager`; the hook extends `BaseBinHook`)");
    expect(guide).toContain("src/BinCounter.sol");
    expect(guide).toContain("script/DeployBinCounter.s.sol");
    expect(guide).toContain("`afterSwap`");
    expect(guide).toContain("`0x0080`");
    expect(guide).toContain(ctx.parameters);
    expect(guide).toContain("| Bin step | 10 |");
    expect(guide).toContain("IGNORED");
  });

  it("carries the same rules once, and never sends a Bin builder to the CL-only bitmap command", () => {
    expect(guide.match(/^# /gm)).toHaveLength(1);
    expect(guide).toContain("## Facts about the core");
    expect(guide).toContain("`gullycore bitmap` is for CL pools only");
    expect(renderBinAgentGuide(ctx, RULES.replace(/\r?\n/g, "\r\n"))).not.toContain("\r");
  });
});

/* The rules name errors, flags and limits. Each is checked against the source it was read from,
   so a rename there fails here instead of misleading every agent that reads the file. */
describe.skipIf(!contractsAvailable)("the rules agree with the contracts", () => {
  const hooksLib = solidity("core", "src", "libraries", "Hooks.sol");
  const feeLib = solidity("core", "src", "libraries", "LPFeeLibrary.sol");

  it("every error the rules name exists", () => {
    for (const name of ["HookConfigValidationError", "InvalidHookResponse", "HookDeltaExceedsSwapAmount"]) {
      expect(RULES).toContain(name);
      expect(hooksLib).toContain(`error ${name}(`);
    }
    for (const name of ["HookNotImplemented", "ReservedBitsSet", "PermissionDependencyMissing"]) {
      expect(RULES).toContain(name);
      expect(BASE).toContain(`error ${name}(`);
    }
  });

  it("the dynamic fee flag, the override flag and the two maximums are the library's", () => {
    expect(RULES).toContain("0x800000");
    expect(feeLib).toMatch(/DYNAMIC_FEE_FLAG = 0x800000/);
    expect(RULES).toContain("OVERRIDE_FEE_FLAG");
    expect(feeLib).toContain("OVERRIDE_FEE_FLAG");
    expect(feeLib).toMatch(/ONE_HUNDRED_PERCENT_FEE = 1_000_000/);
    expect(feeLib).toMatch(/TEN_PERCENT_FEE = 100_000/);
    expect(RULES).toContain("100% on a CL pool and 10% on a Bin pool");
  });

  it("the Bin half of the rules names BaseBinHook's real callbacks, and the same three errors", () => {
    expect(RULES).toContain("BaseBinHook");
    for (const cb of ["beforeMint", "afterMint", "beforeBurn", "afterBurn"]) {
      expect(RULES).toContain(`\`${cb}\``);
      expect(BIN_BASE).toContain(`function ${cb}(`);
    }
    for (const name of ["HookNotImplemented", "ReservedBitsSet", "PermissionDependencyMissing"]) expect(BIN_BASE).toContain(`error ${name}(`);
    expect(BIN_BASE).toMatch(/RESERVED_BITS = uint16\(0xC000\)/);
    expect(BIN_BASE).toMatch(/MAX_LP_FEE = LPFeeLibrary\.TEN_PERCENT_FEE/);
    expect(RULES).toContain("`2^23` is price 1");
  });

  it("bits 14 and 15 are the reserved ones", () => {
    expect(BASE).toMatch(/RESERVED_BITS = uint16\(0xC000\)/);
    expect(RULES).toContain("Bits 14 and 15");
  });

  it("names no operator wallet and nothing internal", () => {
    for (const word of ["0x304b", "0x91c37e", "keeper", "runbook", "Slither 0.", "VPS", "devnet", "do-not-queue"]) expect(RULES).not.toContain(word);
  });
});
