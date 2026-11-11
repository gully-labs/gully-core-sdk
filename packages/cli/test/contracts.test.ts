/* Where a builder with no checkout gets the contracts from (src/util/contracts.ts, workspace.ts). */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { CONTRACTS_COMMIT, CONTRACTS_REPO, cloneContracts, contractsSource, fetchContracts } from "../src/util/contracts.js";
import { findWorkspace, resolveWorkspace } from "../src/util/workspace.js";

const scratch = mkdtempSync(join(tmpdir(), "gullycore-contracts-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();

/** A repository shaped like the published one, small enough to make in a test. No submodules: the file that proves them is committed. */
function publication(name = "publication"): { repo: string; commit: string } {
  const repo = join(scratch, name);
  for (const [path, body] of [
    ["packages/core/foundry.toml", "[profile.default]\n"],
    ["packages/core/src/Vault.sol", "// vault\n"],
    ["packages/core/src/pool-cl/CLPoolManager.sol", "// manager\n"],
    ["packages/core/lib/forge-std/src/Test.sol", "// test\n"],
    ["packages/hooks/foundry.toml", "[profile.default]\n"],
    ["packages/hooks/src/base/BaseCLHook.sol", "// base\n"],
    ["packages/fees/foundry.toml", "[profile.default]\n"],
  ] as const) {
    mkdirSync(join(repo, path, ".."), { recursive: true });
    writeFileSync(join(repo, path), body);
  }
  git(repo, "init", "--quiet", "-b", "main");
  git(repo, "add", "-A");
  git(repo, "commit", "--quiet", "-m", "publication");
  return { repo, commit: git(repo, "rev-parse", "HEAD") };
}

describe("contractsSource", () => {
  it("names the public contracts repository and one full commit of it", () => {
    expect(CONTRACTS_REPO).toBe("https://github.com/gully-labs/gully-core");
    expect(CONTRACTS_COMMIT).toMatch(/^[0-9a-f]{40}$/);
    expect(contractsSource({})).toEqual({ repo: CONTRACTS_REPO, commit: CONTRACTS_COMMIT });
  });

  it("takes both from the environment when they are set", () => {
    const commit = "a".repeat(40);
    expect(contractsSource({ GULLYCORE_CONTRACTS_REPO: " /somewhere ", GULLYCORE_CONTRACTS_COMMIT: commit.toUpperCase() })).toEqual({ repo: "/somewhere", commit });
  });

  it("refuses a branch, a tag or a short hash", () => {
    for (const bad of ["main", "v1.0.0", "abc1234", "g".repeat(40)]) expect(() => contractsSource({ GULLYCORE_CONTRACTS_COMMIT: bad })).toThrow(/not a commit/);
  });

  it("refuses the placeholder, so a build with no publication never fetches a guess", () => {
    expect(() => contractsSource({ GULLYCORE_CONTRACTS_COMMIT: "0".repeat(40) })).toThrow(/names no publication/);
  });
});

describe("findWorkspace", () => {
  it("answers undefined where there is no checkout, and resolveWorkspace throws for the same place", () => {
    const empty = join(scratch, "nowhere");
    mkdirSync(empty, { recursive: true });
    const saved = process.env["GULLYCORE_CORE_PATH"];
    delete process.env["GULLYCORE_CORE_PATH"];
    const cwd = process.cwd();
    try {
      /* Discovery also walks up from the working directory and from the CLI itself, both of which
         sit inside the monorepo here. A named path is the case a test can pin down. */
      process.chdir(empty);
      expect(() => findWorkspace({ near: empty, explicit: join(empty, "missing") })).toThrow(/does not look like a Gully Core core checkout/);
      expect(() => resolveWorkspace({ near: empty, explicit: join(empty, "missing") })).toThrow(/does not look like a Gully Core core checkout/);
    } finally {
      process.chdir(cwd);
      if (saved !== undefined) process.env["GULLYCORE_CORE_PATH"] = saved;
    }
  });

  it("a path named in the environment that is not a checkout throws: a typo is never a silent download", () => {
    const saved = process.env["GULLYCORE_CORE_PATH"];
    process.env["GULLYCORE_CORE_PATH"] = join(scratch, "typo");
    try {
      expect(() => findWorkspace({ near: scratch })).toThrow(/GULLYCORE_CORE_PATH/);
    } finally {
      if (saved === undefined) delete process.env["GULLYCORE_CORE_PATH"];
      else process.env["GULLYCORE_CORE_PATH"] = saved;
    }
  });
});

// Real git work (init, fetch, submodule): seconds on Windows, past vitest's 5 s default under load.
describe("fetchContracts", { timeout: 30_000 }, () => {
  const pub = publication();

  it("puts the pinned commit in lib/gullycore-contracts, as a submodule of the project", async () => {
    const project = join(scratch, "project-a");
    mkdirSync(project, { recursive: true });
    const ws = await fetchContracts(project, pub);
    expect(ws.source).toBe("fetched");
    expect(existsSync(join(ws.core, "src", "Vault.sol"))).toBe(true);
    expect(ws.hooks).toBeDefined();
    expect(existsSync(join(ws.hooks as string, "src", "base", "BaseCLHook.sol"))).toBe(true);
    expect(git(join(project, "lib", "gullycore-contracts"), "rev-parse", "HEAD")).toBe(pub.commit);
    expect(readFileSync(join(project, ".gitmodules"), "utf8")).toContain("lib/gullycore-contracts");
    expect(git(project, "ls-files", "--stage", "lib/gullycore-contracts")).toContain(pub.commit);
  });

  it("is idempotent", async () => {
    const project = join(scratch, "project-a");
    const ws = await fetchContracts(project, pub);
    expect(git(join(project, "lib", "gullycore-contracts"), "rev-parse", "HEAD")).toBe(pub.commit);
    expect(ws.source).toBe("fetched");
  });

  it("refuses a commit the repository does not have", async () => {
    const project = join(scratch, "project-b");
    mkdirSync(project, { recursive: true });
    await expect(fetchContracts(project, { repo: pub.repo, commit: "b".repeat(40) })).rejects.toThrow();
  });

  it("checks out the pinned commit even when the repository has moved on", async () => {
    writeFileSync(join(pub.repo, "packages", "core", "src", "Vault.sol"), "// vault, later\n");
    git(pub.repo, "commit", "--quiet", "-am", "later");
    const project = join(scratch, "project-c");
    mkdirSync(project, { recursive: true });
    const ws = await fetchContracts(project, pub);
    /* A Windows checkout may write CRLF; the words are what tell the two commits apart. */
    expect(readFileSync(join(ws.core, "src", "Vault.sol"), "utf8").trim()).toBe("// vault");
  });
});

/* `gullycore devnet` from a generated project (no checkout on disk), or from nowhere at all. */
describe("the devnet's contracts without a checkout", { timeout: 30_000 }, () => {
  const pub = publication("publication-devnet");

  it("findWorkspace finds a generated project's lib/gullycore-contracts, fees included", async () => {
    const project = join(scratch, "generated");
    mkdirSync(project, { recursive: true });
    const fetched = await fetchContracts(project, pub);
    expect(fetched.fees).toBe(join(project, "lib", "gullycore-contracts", "packages", "fees"));
    const nested = join(project, "src");
    mkdirSync(nested, { recursive: true });
    const saved = process.env["GULLYCORE_CORE_PATH"];
    delete process.env["GULLYCORE_CORE_PATH"];
    try {
      const ws = findWorkspace({ near: nested });
      expect(ws?.core).toBe(join(project, "lib", "gullycore-contracts", "packages", "core"));
      expect(ws?.fees).toBe(join(project, "lib", "gullycore-contracts", "packages", "fees"));
      expect(ws?.hooks).toBe(join(project, "lib", "gullycore-contracts", "packages", "hooks"));
    } finally {
      if (saved !== undefined) process.env["GULLYCORE_CORE_PATH"] = saved;
    }
  });

  it("cloneContracts makes a plain clone at the pinned commit, and reuses it", async () => {
    const dest = join(scratch, "devnet-work", "contracts");
    const ws = await cloneContracts(dest, pub);
    expect(ws.source).toBe("fetched");
    expect(git(dest, "rev-parse", "HEAD")).toBe(pub.commit);
    expect(ws.fees).toBe(join(dest, "packages", "fees"));
    const again = await cloneContracts(dest, pub);
    expect(again.core).toBe(ws.core);
    expect(git(dest, "rev-parse", "HEAD")).toBe(pub.commit);
  });

  it("cloneContracts refuses a commit the repository does not have", async () => {
    await expect(cloneContracts(join(scratch, "devnet-bad"), { repo: pub.repo, commit: "c".repeat(40) })).rejects.toThrow();
  });
});
