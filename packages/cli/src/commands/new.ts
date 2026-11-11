/**
 * `create-gully-core-hook <name>` / `gullycore new <name>`.
 *
 * Generates a Foundry project containing a hook, a test harness that stands the
 * whole settlement stack up in memory, and a deploy script - with the
 * registration bitmap and the pool key `parameters` word generated from one
 * permission set so they cannot disagree.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getBoolean,
  getString,
  parseArgs,
  renderFlags,
  type FlagSpecs,
  type ParsedArgs,
} from "../util/args.js";
import { info, ok, step, style, table, UserError, warn } from "../util/log.js";
import { isEmptyDir, posixRelative, remappingPath, writeFileEnsuringDir } from "../util/fsx.js";
import { askChoice, askConfirm, askMultiSelect, askText, isInteractive } from "../util/prompt.js";
import { fetchContracts } from "../util/contracts.js";
import { findWorkspace, requireHooks, type GullyCoreWorkspace } from "../util/workspace.js";
import { resolveCommand, runOrThrow } from "../util/exec.js";
import {
  ALL_PERMISSIONS,
  parsePermissionList,
  PERMISSION_HELP,
  poolParametersFor,
  resolvePermissions,
  type PermissionName,
} from "../permissions.js";
import { DEFAULT_TEMPLATE_ID, findTemplate, TEMPLATES, templateIds } from "../templates/index.js";
import {
  BIN_TEMPLATES,
  binContext,
  findBinTemplate,
  parseBinFee,
  parseBinStep,
  renderBinAgentGuide,
  renderBinGullyCoreConfig,
  renderBinDeployScript,
  renderBinFoundryToml,
  renderBinHook,
  renderBinReadme,
  renderBinTest,
  type BinHookTemplate,
} from "../codegen/binProject.js";
import { APP_TEMPLATES, appFiles, appTemplateIds, findAppTemplate, sdkDependencyFor, type AppTemplate } from "../codegen/app.js";
import {
  renderDeployScript,
  renderFoundryToml,
  renderGitignore,
  renderHook,
  renderGullyCoreConfig,
  renderAgentGuide,
  renderReadme,
  renderTest,
  type ProjectContext,
} from "../codegen/project.js";

export const NEW_FLAGS: FlagSpecs = {
  template: {
    kind: "string",
    short: "t",
    placeholder: "<id>",
    describe: `starting point: ${[...templateIds(), ...BIN_TEMPLATES.map((t) => t.id), ...appTemplateIds()].join(" | ")}`,
    defaultLabel: DEFAULT_TEMPLATE_ID,
  },
  permissions: {
    kind: "string",
    short: "p",
    placeholder: "<list>",
    describe: "comma-separated callbacks, or 'all' / 'none'",
    defaultLabel: "the template's own set",
  },
  "tick-spacing": {
    kind: "string",
    placeholder: "<n>",
    describe: "tick spacing baked into the pool key parameters",
    defaultLabel: "60",
  },
  "bin-step": {
    kind: "string",
    placeholder: "<n>",
    describe: "bin step baked into the pool key parameters (Bin templates only)",
    defaultLabel: "10",
  },
  fee: {
    kind: "string",
    placeholder: "<n|dynamic>",
    describe: "static LP fee in hundredths of a bip, or 'dynamic'",
    defaultLabel: "the template's own choice",
  },
  contract: {
    kind: "string",
    placeholder: "<Name>",
    describe: "Solidity contract name",
    defaultLabel: "derived from <name>",
  },
  dir: {
    kind: "string",
    short: "d",
    placeholder: "<path>",
    describe: "where to write the project",
    defaultLabel: "./<name>",
  },
  core: {
    kind: "string",
    placeholder: "<path>",
    describe: "path to packages/core; also read from GULLYCORE_CORE_PATH",
    defaultLabel: "auto-detected",
  },
  yes: { kind: "boolean", short: "y", describe: "accept every default; never prompt" },
  force: { kind: "boolean", describe: "write into a non-empty directory" },
  build: { kind: "boolean", describe: "run `forge build` on the generated project" },
  help: { kind: "boolean", short: "h", describe: "show this message" },
};

const USAGE = (invokedAs: string): string => `${style.bold("create-gully-core-hook")} - scaffold a Gully Core hook

${style.bold("USAGE")}
  ${invokedAs} <name> [options]

${style.bold("EXAMPLES")}
  ${invokedAs} my-hook
  ${invokedAs} fee-hook --template dynamic-fee --yes
  ${invokedAs} counter --permissions beforeSwap,afterSwap,afterSwapReturnsDelta --yes
  ${invokedAs} my-drop --template airdrop
  ${invokedAs} my-locks --template locks

${style.bold("OPTIONS")}
${renderFlags(NEW_FLAGS)}

${style.bold("PERMISSIONS")}
${ALL_PERMISSIONS.map((name) => `  ${name.padEnd(34)}${PERMISSION_HELP[name]}`).join("\n")}

  A *ReturnsDelta permission requires its base callback; the missing one is added
  for you rather than generating a project that reverts at pool initialization.

${style.bold("TEMPLATES")}
${TEMPLATES.map((t) => `  ${t.id.padEnd(14)}${t.description}`).join("\n")}

  Bin pools (BinPoolManager, BaseBinHook). The template's callbacks are fixed:
  --permissions and --tick-spacing do not apply; --bin-step and a static --fee do.
${BIN_TEMPLATES.map((t) => `  ${t.id.padEnd(18)}${t.description}`).join("\n")}

  Apps: a Node project on the MIT SDK. --permissions, --tick-spacing, --fee,
  --contract, --core and --build do not apply.
${APP_TEMPLATES.map((t) => `  ${t.id.padEnd(14)}${t.description}`).join("\n")}
`;

const RESERVED_SOLIDITY = new Set([
  "contract",
  "interface",
  "library",
  "abstract",
  "function",
  "address",
  "bool",
  "string",
  "bytes",
  "type",
  "test",
]);

function toContractName(raw: string): string {
  const parts = raw
    .split(/[^A-Za-z0-9]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1));
  const joined = parts.join("");
  return /^[0-9]/.test(joined) ? `Hook${joined}` : joined;
}

function assertValidContractName(name: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new UserError(
      `"${name}" is not a valid Solidity contract name`,
      "use letters, digits and underscores, starting with a letter",
    );
  }
  if (RESERVED_SOLIDITY.has(name.toLowerCase())) {
    throw new UserError(`"${name}" is a reserved word in Solidity`, "pass --contract <Name> with something else");
  }
}

function parseTickSpacing(raw: string | undefined): number {
  if (raw === undefined) return 60;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 1 || value > 32767) {
    throw new UserError(
      `--tick-spacing must be an integer between 1 and 32767, got "${raw}"`,
      "CLPoolManager enforces MIN_TICK_SPACING = 1 and MAX_TICK_SPACING = type(int16).max",
    );
  }
  return value;
}

function parseFee(raw: string | undefined, templateWantsDynamic: boolean): number | undefined {
  if (raw === undefined) return templateWantsDynamic ? undefined : 3000;
  if (raw.trim().toLowerCase() === "dynamic") return undefined;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 0 || value > 1_000_000) {
    throw new UserError(
      `--fee must be 'dynamic' or an integer between 0 and 1000000, got "${raw}"`,
      "the fee is in hundredths of a bip: 3000 is 0.30%",
    );
  }
  return value;
}

export async function runNew(argv: readonly string[], invokedAs: string, cliVersion: string): Promise<number> {
  const args = parseArgs(argv, NEW_FLAGS);

  if (getBoolean(args, "help") || (args.positionals.length === 0 && !isInteractive())) {
    info(USAGE(invokedAs));
    return getBoolean(args, "help") ? 0 : 1;
  }

  const nonInteractive = getBoolean(args, "yes") || !isInteractive();

  // --- name -----------------------------------------------------------------
  let projectName = args.positionals[0];
  if (projectName === undefined) {
    projectName = await askText("Project name?", "my-gullycore-hook");
  }
  projectName = projectName.trim();
  if (projectName.length === 0) throw new UserError("project name cannot be empty");
  if (/[\\/:*?"<>|]/.test(projectName)) {
    throw new UserError(
      `"${projectName}" contains characters that are not valid in a directory name`,
      "use letters, digits and dashes; pass --dir to control the output path separately",
    );
  }

  // --- template -------------------------------------------------------------
  const templateFlag = getString(args, "template");
  let templateId = templateFlag ?? DEFAULT_TEMPLATE_ID;
  if (templateFlag === undefined && !nonInteractive) {
    templateId = await askChoice(
      "\nWhich template?",
      [...TEMPLATES, ...BIN_TEMPLATES, ...APP_TEMPLATES].map((t) => ({ value: t.id, label: t.label, description: t.description })),
      0,
    );
  }
  const appTemplate = findAppTemplate(templateId);
  if (appTemplate !== undefined) return writeApp(args, projectName, appTemplate, nonInteractive, cliVersion);
  const binTemplate = findBinTemplate(templateId);
  if (binTemplate !== undefined) return writeBinHook(args, projectName, binTemplate, nonInteractive, cliVersion);
  const template = findTemplate(templateId);
  if (template === undefined) {
    throw new UserError(
      `unknown template "${templateId}"`,
      `available templates: ${[...templateIds(), ...BIN_TEMPLATES.map((t) => t.id), ...appTemplateIds()].join(", ")}`,
    );
  }
  if (args.flags["bin-step"] !== undefined) {
    throw new UserError(`--bin-step does not apply to the "${template.id}" template`, "it is a CL hook; its pool key carries a tick spacing (--tick-spacing)");
  }

  // --- permissions ----------------------------------------------------------
  const permissionsFlag = getString(args, "permissions");
  let requested: PermissionName[] =
    permissionsFlag === undefined ? [...template.defaultPermissions] : parsePermissionList(permissionsFlag);

  if (permissionsFlag === undefined && !nonInteractive) {
    const preselected = new Set(
      ALL_PERMISSIONS.map((name, index) => (template.defaultPermissions.includes(name) ? index : -1)).filter(
        (index) => index >= 0,
      ),
    );
    info("");
    info(
      style.dim(
        "Permissions live in the pool key, not the hook address - pick freely, there is no salt to mine.",
      ),
    );
    requested = await askMultiSelect(
      "Which callbacks should this hook register?",
      ALL_PERMISSIONS.map((name) => ({
        value: name,
        label: name,
        description: PERMISSION_HELP[name],
      })),
      preselected,
    );
  }

  const permissions = resolvePermissions(requested);
  if (permissions.addedDependencies.length > 0) {
    warn(
      `added ${permissions.addedDependencies.join(", ")}: a *ReturnsDelta permission cannot be registered without its base callback`,
    );
  }

  const templateApplies = template.requires.every((name) => permissions.names.includes(name));
  if (!templateApplies) {
    const missing = template.requires.filter((name) => !permissions.names.includes(name));
    warn(
      `the "${template.id}" template implements ${missing.join(", ")}, which you did not select; ` +
        "its bodies were replaced with pass-throughs",
    );
  }

  // --- pool shape -----------------------------------------------------------
  const tickSpacing = parseTickSpacing(getString(args, "tick-spacing"));
  const lpFee = parseFee(getString(args, "fee"), templateApplies && template.dynamicFee);
  const parameters = poolParametersFor(permissions.bitmap, tickSpacing);

  // --- contract name --------------------------------------------------------
  const contractName = getString(args, "contract") ?? toContractName(projectName);
  assertValidContractName(contractName);

  // --- destination ----------------------------------------------------------
  const dirFlag = getString(args, "dir");
  const targetDir = dirFlag === undefined
    ? resolve(process.cwd(), projectName)
    : isAbsolute(dirFlag)
      ? dirFlag
      : resolve(process.cwd(), dirFlag);

  if (!(await isEmptyDir(targetDir)) && !getBoolean(args, "force")) {
    if (nonInteractive) {
      throw new UserError(`${targetDir} is not empty`, "pass --force to write into it anyway");
    }
    const proceed = await askConfirm(`\n${targetDir} is not empty. Write into it anyway?`, false);
    if (!proceed) {
      info("nothing written");
      return 1;
    }
  }

  // --- workspace ------------------------------------------------------------
  const workspace = await workspaceFor(args, targetDir);
  const hooksPath = requireHooks(workspace);

  const ctx: ProjectContext = {
    projectName,
    contractName,
    template,
    permissions,
    tickSpacing,
    lpFee,
    parameters,
    templateApplies,
    cliVersion,
    paths: {
      core: remappingPath(targetDir, workspace.core),
      hooks: remappingPath(targetDir, hooksPath),
    },
  };

  /* The rules file ships with the CLI (assets/agent/AGENTS.md); dist/commands -> the package root. */
  const rulesPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "assets", "agent", "AGENTS.md");
  const agentGuide = renderAgentGuide(ctx, await readFile(rulesPath, "utf8"));

  // --- write ----------------------------------------------------------------
  const files: ReadonlyArray<readonly [string, string]> = [
    [join(targetDir, "foundry.toml"), renderFoundryToml(ctx)],
    [join(targetDir, ".gitignore"), renderGitignore()],
    [join(targetDir, "gullycore.json"), renderGullyCoreConfig(ctx)],
    [join(targetDir, "README.md"), renderReadme(ctx)],
    [join(targetDir, "CLAUDE.md"), agentGuide],
    [join(targetDir, "AGENTS.md"), agentGuide],
    [join(targetDir, "src", `${contractName}.sol`), renderHook(ctx)],
    [join(targetDir, "test", `${contractName}.t.sol`), renderTest(ctx)],
    [join(targetDir, "script", `Deploy${contractName}.s.sol`), renderDeployScript(ctx)],
  ];

  step(`creating ${style.bold(projectName)} in ${targetDir}`);
  for (const [path, contents] of files) {
    await writeFileEnsuringDir(path, contents);
    info(`  ${style.dim(posixRelative(targetDir, path))}`);
  }

  info("");
  info(
    table([
      ["template", template.id],
      ["contract", `${contractName}.sol`],
      ["callbacks", permissions.names.length === 0 ? "(none)" : permissions.names.join(", ")],
      ["registration bitmap", permissions.bitmapHex],
      ["pool key parameters", parameters],
      ["tick spacing", String(tickSpacing)],
      ["pool fee", lpFee === undefined ? "dynamic (0x800000)" : `${lpFee} (${(lpFee / 10_000).toFixed(2)}%)`],
      ["core contracts", workspace.core],
    ]),
  );
  info("");
  info(
    style.dim(
      "  The bitmap and the parameters word were generated together. CLPoolManager.initialize\n" +
        "  compares them; a mismatch is HookConfigValidationError, and the generated test fails\n" +
        "  the build if they ever stop agreeing.",
    ),
  );

  // --- optional verification build -----------------------------------------
  if (getBoolean(args, "build")) {
    if (resolveCommand("forge") === undefined) {
      warn("skipping --build: forge is not on PATH");
    } else {
      info("");
      step("forge build");
      await runOrThrow("forge", ["build"], {
        cwd: targetDir,
        inherit: true,
        failureHint: "the generated project failed to compile; please report this as a create-gully-core-hook bug",
      });
      ok("generated project compiles");
    }
  }

  info("");
  ok("done");
  info("");
  info(`  cd ${projectName}`);
  info("  forge test -vv");
  info("");
  if (!existsSync(join(workspace.core, "lib", "forge-std", "src", "Test.sol"))) {
    warn(
      `${join(workspace.core, "lib", "forge-std")} is missing - run "forge install" (or "git submodule update --init") in packages/core first`,
    );
  }

  return 0;
}

/** A checkout on disk, else the pinned public contracts fetched into the project. */
async function workspaceFor(args: ParsedArgs, targetDir: string): Promise<GullyCoreWorkspace> {
  const workspaceOptions = { near: targetDir, ...(getString(args, "core") === undefined ? {} : { explicit: getString(args, "core") }) };
  const found = findWorkspace(workspaceOptions);
  if (found !== undefined) return found;
  /* No checkout on disk: the contracts come from their public repository, into this project. */
  step("fetching the Gully Core contracts");
  await mkdir(targetDir, { recursive: true });
  const fetched = await fetchContracts(targetDir);
  ok(`contracts at ${posixRelative(targetDir, fetched.core)}`);
  return fetched;
}

/** `--template bin-*`: a hook for a Bin pool, from a fixed template (see codegen/binProject.ts). */
async function writeBinHook(
  args: ParsedArgs,
  projectName: string,
  template: BinHookTemplate,
  nonInteractive: boolean,
  cliVersion: string,
): Promise<number> {
  const refused = (["permissions", "tick-spacing"] as const).filter((f) => args.flags[f] !== undefined);
  if (refused.length > 0) {
    throw new UserError(
      `--${refused.join(", --")} ${refused.length === 1 ? "does" : "do"} not apply to the "${template.id}" template`,
      "a Bin template's callbacks are fixed and its pool key carries a bin step (--bin-step), not a tick spacing",
    );
  }
  const binStep = parseBinStep(getString(args, "bin-step"));
  const lpFee = parseBinFee(getString(args, "fee"));
  const contractName = getString(args, "contract") ?? toContractName(projectName);
  assertValidContractName(contractName);

  const targetDir = targetDirFor(args, projectName);
  if (!(await isEmptyDir(targetDir)) && !getBoolean(args, "force")) {
    if (nonInteractive) throw new UserError(`${targetDir} is not empty`, "pass --force to write into it anyway");
    const proceed = await askConfirm(`\n${targetDir} is not empty. Write into it anyway?`, false);
    if (!proceed) {
      info("nothing written");
      return 1;
    }
  }

  const workspace = await workspaceFor(args, targetDir);
  const hooksPath = requireHooks(workspace);
  if (!existsSync(join(hooksPath, "src", "base", "BaseBinHook.sol"))) {
    throw new UserError(
      `${hooksPath} does not contain src/base/BaseBinHook.sol`,
      "a Bin hook extends BaseBinHook; these contracts predate it, so this template cannot be generated against them",
    );
  }

  const ctx = binContext({
    projectName,
    contractName,
    template,
    binStep,
    lpFee,
    cliVersion,
    paths: { core: remappingPath(targetDir, workspace.core), hooks: remappingPath(targetDir, hooksPath) },
  });
  const rulesPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "assets", "agent", "AGENTS.md");
  const agentGuide = renderBinAgentGuide(ctx, await readFile(rulesPath, "utf8"));

  const files: ReadonlyArray<readonly [string, string]> = [
    [join(targetDir, "foundry.toml"), renderBinFoundryToml(ctx)],
    [join(targetDir, ".gitignore"), renderGitignore()],
    [join(targetDir, "gullycore.json"), renderBinGullyCoreConfig(ctx)],
    [join(targetDir, "README.md"), renderBinReadme(ctx)],
    [join(targetDir, "CLAUDE.md"), agentGuide],
    [join(targetDir, "AGENTS.md"), agentGuide],
    [join(targetDir, "src", `${contractName}.sol`), renderBinHook(ctx)],
    [join(targetDir, "test", `${contractName}.t.sol`), renderBinTest(ctx)],
    [join(targetDir, "script", `Deploy${contractName}.s.sol`), renderBinDeployScript(ctx)],
  ];
  step(`creating ${style.bold(projectName)} in ${targetDir}`);
  for (const [path, contents] of files) {
    await writeFileEnsuringDir(path, contents);
    info(`  ${style.dim(posixRelative(targetDir, path))}`);
  }
  info("");
  info(
    table([
      ["template", template.id],
      ["pool type", "Bin"],
      ["contract", `${contractName}.sol`],
      ["callbacks", ctx.permissions.names.join(", ")],
      ["registration bitmap", ctx.permissions.bitmapHex],
      ["pool key parameters", ctx.parameters],
      ["bin step", String(binStep)],
      ["pool fee", `${lpFee} (${(lpFee / 10_000).toFixed(2)}%)`],
      ["core contracts", workspace.core],
    ]),
  );
  if (getBoolean(args, "build")) {
    if (resolveCommand("forge") === undefined) {
      warn("skipping --build: forge is not on PATH");
    } else {
      info("");
      step("forge build");
      await runOrThrow("forge", ["build"], {
        cwd: targetDir,
        inherit: true,
        failureHint: "the generated project failed to compile; please report this as a create-gully-core-hook bug",
      });
      ok("generated project compiles");
    }
  }
  info("");
  ok("done");
  info("");
  info(`  cd ${projectName}`);
  info("  forge test -vv");
  info("");
  return 0;
}

const HOOK_ONLY_FLAGS = ["permissions", "tick-spacing", "bin-step", "fee", "contract", "core", "build"] as const;

function targetDirFor(args: ParsedArgs, projectName: string): string {
  const dirFlag = getString(args, "dir");
  return dirFlag === undefined
    ? resolve(process.cwd(), projectName)
    : isAbsolute(dirFlag)
      ? dirFlag
      : resolve(process.cwd(), dirFlag);
}

/** `--template airdrop | locks`: a Node project on the MIT SDK, no Solidity and no core checkout needed. */
async function writeApp(
  args: ParsedArgs,
  projectName: string,
  template: AppTemplate,
  nonInteractive: boolean,
  cliVersion: string,
): Promise<number> {
  const ignored = HOOK_ONLY_FLAGS.filter((f) => args.flags[f] !== undefined);
  if (ignored.length > 0) {
    throw new UserError(
      `--${ignored.join(", --")} ${ignored.length === 1 ? "does" : "do"} not apply to the "${template.id}" template`,
      "those flags shape a hook; an app template is a Node project",
    );
  }
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(projectName)) {
    throw new UserError(`"${projectName}" is not a valid npm package name`, "use lowercase letters, digits, dashes and dots");
  }
  const targetDir = targetDirFor(args, projectName);
  if (!(await isEmptyDir(targetDir)) && !getBoolean(args, "force")) {
    if (nonInteractive) throw new UserError(`${targetDir} is not empty`, "pass --force to write into it anyway");
    const proceed = await askConfirm(`
${targetDir} is not empty. Write into it anyway?`, false);
    if (!proceed) {
      info("nothing written");
      return 1;
    }
  }

  const cliDir = dirname(fileURLToPath(import.meta.url));
  const sdkDependency = sdkDependencyFor(targetDir, [process.cwd(), cliDir]);
  const files = appFiles({ projectName, template, sdkDependency, cliVersion });

  step(`creating ${style.bold(projectName)} in ${targetDir}`);
  for (const [rel, contents] of files) {
    const path = join(targetDir, ...rel.split("/"));
    await writeFileEnsuringDir(path, contents);
    info(`  ${style.dim(posixRelative(targetDir, path))}`);
  }
  info("");
  info(
    table([
      ["template", template.id],
      ["scripts", template.scripts.map((s) => s.name).join(", ")],
      ["@gullylabs/core-sdk", sdkDependency],
      ["contracts", template.contracts.map((c) => c.contract).join(", ")],
    ]),
  );
  info("");
  info(style.dim("  Dry run by default: nothing is sent without --execute AND PRIVATE_KEY in the environment."));
  info("");
  ok("done");
  info("");
  info(`  cd ${projectName}`);
  info("  npm install");
  info("  cp .env.example .env");
  info(`  npm run ${template.scripts[0]?.name ?? ""} -- --help`);
  info("");
  if (sdkDependency.startsWith("file:")) {
    warn(`the SDK is linked from your checkout (${sdkDependency}); build it first: npm run build in packages/sdk`);
  }
  return 0;
}

export function newHelp(invokedAs: string): string {
  return USAGE(invokedAs);
}

/** Exposed for the `gullycore` multiplexer so it can forward its own argv. */
export type { ParsedArgs };
