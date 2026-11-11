/**
 * Fetches the contracts a generated project compiles against, for a builder who
 * has no Gully Core checkout on disk.
 *
 * WHAT IS FETCHED. The public contracts repository
 * (`github.com/gully-labs/gully-core`): the settlement layer
 * (`packages/core`), the base contracts a Gully Core extends (`packages/hooks`),
 * the rest of Gully Core's contract packages, and their dependencies as git
 * submodules. It keeps the source repository's own layout, so every path the
 * scaffolder writes is the same whether the contracts were found on disk or
 * fetched.
 *
 * WHERE IT GOES. `lib/gullycore-contracts` in the generated project, as a git
 * SUBMODULE of that project. A submodule records the commit in the builder's
 * own repository, so `git clone --recurse-submodules` of their project gives
 * a colleague the same bytes. The project is `git init`ed when it is not
 * inside a repository already, which is what `forge init` does too.
 *
 * THE COMMIT IS PINNED AND CHECKED. A release of this CLI names one commit of
 * that repository. After the fetch the checked-out commit is read back and
 * compared; anything else is refused. A branch or a tag can be moved by
 * whoever holds the repository, and a Gully Core built against contracts that are
 * not the deployed ones is tested against the wrong Vault: that is a quiet
 * failure, so it is made a loud one here.
 *
 * `GULLYCORE_CONTRACTS_REPO` and `GULLYCORE_CONTRACTS_COMMIT` override both, for a
 * mirror or for testing a publication before it is pushed.
 *
 * A NEW PUBLICATION IS A NEW PIN. When the repository gains a commit that
 * builders should compile against, the release that adopts it changes
 * {@link CONTRACTS_COMMIT} here, in the same change, and is tested against it.
 */

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { resolveCommand, run, runOrThrow } from "./exec.js";
import { UserError } from "./log.js";
import { looksLikeCore, type GullyCoreWorkspace } from "./workspace.js";

/** The public repository the scaffolder fetches. `null` would mean "no publication". */
export const CONTRACTS_REPO: string | null = "https://github.com/gully-labs/gully-core";

/**
 * The commit of {@link CONTRACTS_REPO} this release of the CLI was built and
 * tested against. Written by the release step, never by hand. `null` (or forty
 * zeroes) means "this build has no publication to fetch" and the fetch is refused.
 */
export const CONTRACTS_COMMIT: string | null = "e98ab87f8de22c408550cd64643e90f37d88afba";

/** Where the contracts land, relative to the generated project. */
export const CONTRACTS_DIR = join("lib", "gullycore-contracts");

const SHA = /^[0-9a-f]{40}$/;
/* Deep paths inside the dependencies run past Windows' 260 characters. */
const LONG_PATHS = ["-c", "core.longpaths=true"] as const;

export interface ContractsSource {
  readonly repo: string;
  readonly commit: string;
}

/** The repository and commit to fetch: the environment's, else this release's. */
export function contractsSource(env: NodeJS.ProcessEnv = process.env): ContractsSource {
  const repo = env["GULLYCORE_CONTRACTS_REPO"]?.trim();
  const commit = env["GULLYCORE_CONTRACTS_COMMIT"]?.trim().toLowerCase();
  const source = {
    repo: repo === undefined || repo === "" ? CONTRACTS_REPO : repo,
    commit: commit === undefined || commit === "" ? CONTRACTS_COMMIT : commit,
  };
  if (source.commit !== null && !SHA.test(source.commit)) {
    throw new UserError(
      `GULLYCORE_CONTRACTS_COMMIT=${source.commit} is not a commit`,
      "it must be the full 40-character hash: a branch or a tag can be moved, a commit cannot",
    );
  }
  if (source.repo === null || source.commit === null || /^0{40}$/.test(source.commit)) {
    throw new UserError(
      "this build of the CLI names no publication of the Gully Core contracts to fetch",
      "pass --core <path-to-packages/core>, or set GULLYCORE_CONTRACTS_REPO and GULLYCORE_CONTRACTS_COMMIT",
    );
  }
  return { repo: source.repo, commit: source.commit };
}

async function insideGitRepository(dir: string): Promise<boolean> {
  const result = await run("git", ["rev-parse", "--is-inside-work-tree"], { cwd: dir });
  return result.code === 0 && result.stdout.trim() === "true";
}

/**
 * Puts the contracts at `<targetDir>/lib/gullycore-contracts` and returns them as a
 * workspace. `targetDir` must exist. Idempotent: contracts already there at the
 * pinned commit are used as they are.
 */
export async function fetchContracts(targetDir: string, source: ContractsSource = contractsSource()): Promise<GullyCoreWorkspace> {
  if (resolveCommand("git") === undefined) {
    throw new UserError("git is not on PATH", "the Gully Core contracts are fetched with git; install it, or pass --core <path-to-packages/core>");
  }
  const dest = join(targetDir, CONTRACTS_DIR);
  const submodulePath = CONTRACTS_DIR.split("\\").join("/");
  const failureHint = `could not fetch ${source.repo}; check the network, or pass --core <path-to-packages/core>`;

  if (!existsSync(join(dest, ".git"))) {
    if (!(await insideGitRepository(targetDir))) {
      await runOrThrow("git", ["init", "--quiet"], { cwd: targetDir, failureHint: "git init failed in the new project" });
    }
    /* A repository on disk (a publication being tested before it is pushed) is reached over git's
       file transport, which git refuses for a submodule unless told otherwise. Never for a URL. */
    await runOrThrow("git", [...LONG_PATHS, ...fileTransport(source.repo), "submodule", "add", "--quiet", "--force", source.repo, submodulePath], {
      cwd: targetDir,
      failureHint,
    });
  }

  await checkoutPinned(dest, source, failureHint);
  const workspace = await verifyFetched(dest, source);
  /* The submodule is staged for the builder; committing is theirs to do. */
  await run("git", ["add", ".gitmodules", submodulePath], { cwd: targetDir });
  return workspace;
}

/** Fetch the pinned commit into an existing clone, check it out, and init its libraries. */
async function checkoutPinned(dest: string, source: ContractsSource, failureHint: string): Promise<void> {
  await runOrThrow("git", [...LONG_PATHS, "fetch", "--quiet", "origin", source.commit], { cwd: dest, failureHint });
  await runOrThrow("git", [...LONG_PATHS, "checkout", "--quiet", "--detach", source.commit], { cwd: dest, failureHint });
  /* The same tree `git clone --recurse-submodules` gives, as the repository's README says to clone it.
     A local repository (a publication being tested) needs git's file transport for its own submodules. */
  await runOrThrow("git", [...LONG_PATHS, ...fileTransport(source.repo), "submodule", "update", "--init", "--recursive", "--quiet"], {
    cwd: dest,
    failureHint: "the contracts were fetched, but their dependencies (forge-std, openzeppelin-contracts, solmate) were not",
  });
}

/** Git's file transport, for a repository on disk only. Never for a URL. */
function fileTransport(repo: string): string[] {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(repo) ? [] : ["-c", "protocol.file.allow=always"];
}

/** The checked-out commit is the pinned one and the tree holds what a Gully Core compiles against. */
async function verifyFetched(dest: string, source: ContractsSource): Promise<GullyCoreWorkspace> {
  const head = (await runOrThrow("git", ["rev-parse", "HEAD"], { cwd: dest })).stdout.trim().toLowerCase();
  if (head !== source.commit) {
    throw new UserError(
      `the fetched contracts are at ${head}, not at ${source.commit}`,
      "nothing was generated against them; this should not happen, please report it",
    );
  }

  const core = join(dest, "packages", "core");
  const hooks = join(dest, "packages", "hooks");
  if (!looksLikeCore(core) || !existsSync(join(hooks, "src", "base", "BaseCLHook.sol"))) {
    throw new UserError(`${source.repo} at ${source.commit} does not hold the Gully Core contracts`, "expected packages/core and packages/hooks/src/base");
  }
  if (!existsSync(join(core, "lib", "forge-std", "src", "Test.sol"))) {
    throw new UserError("the contracts' dependencies are missing after the fetch", `run "git submodule update --init -- packages/core/lib/forge-std packages/core/lib/openzeppelin-contracts packages/core/lib/solmate" in ${dest}`);
  }
  return { core, hooks, fees: feesIn(dest), root: dest, source: "fetched" };
}

/** `packages/fees` of a fetched tree, when the publication carries it (the devnet deploys from it). */
function feesIn(dest: string): string | undefined {
  const fees = join(dest, "packages", "fees");
  return existsSync(join(fees, "foundry.toml")) ? fees : undefined;
}

/**
 * The pinned contracts as a PLAIN clone at `dest` (not a submodule of anything), for a command
 * that runs outside any project, such as `gullycore devnet` with no checkout and no generated
 * project near it. Same commit, same check, same libraries as {@link fetchContracts}.
 * Idempotent: a clone already at the commit is used as it is.
 */
export async function cloneContracts(dest: string, source: ContractsSource = contractsSource()): Promise<GullyCoreWorkspace> {
  if (resolveCommand("git") === undefined) {
    throw new UserError("git is not on PATH", "the Gully Core contracts are fetched with git; install it, or pass --core <path-to-packages/core>");
  }
  const failureHint = `could not fetch ${source.repo}; check the network, or pass --core <path-to-packages/core>`;
  if (!existsSync(join(dest, ".git"))) {
    await mkdir(dest, { recursive: true });
    await runOrThrow("git", ["init", "--quiet"], { cwd: dest, failureHint: `git init failed in ${dest}` });
    await runOrThrow("git", ["remote", "add", "origin", source.repo], { cwd: dest, failureHint });
  } else {
    await runOrThrow("git", ["remote", "set-url", "origin", source.repo], { cwd: dest, failureHint });
  }
  await checkoutPinned(dest, source, failureHint);
  return verifyFetched(dest, source);
}
