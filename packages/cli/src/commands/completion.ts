// SPDX-License-Identifier: MIT
/**
 * `gullycore completion bash|zsh|fish|powershell`: a completion script on stdout, generated from the same
 * specs `--help` prints, so a new flag completes without a second list to keep.
 */

import type { FlagSpecs } from "../util/args.js";
import { BITMAP_FLAGS } from "./bitmap.js";
import { CONFIG_SPEC } from "./config.js";
import { DEVNET_FLAGS } from "./devnet.js";
import { DOCTOR_SPEC } from "./doctor.js";
import { CHAIN_LIST_SPEC, CHAIN_STATUS_SPEC, FEES_SPEC, TOKENS_INFO_SPEC, TOKENS_LIST_SPEC } from "./info.js";
import { LAUNCH_SPEC } from "./launch.js";
import { LIQUIDITY_ADD_SPEC, LIQUIDITY_REMOVE_SPEC } from "./liquidity.js";
import { NEW_FLAGS } from "./new.js";
import { POOL_CREATE_SPEC, POOL_INFO_SPEC, POOL_LIST_SPEC } from "./pool.js";
import { SITE_SPEC } from "./site.js";
import { AIRDROP_SPEC } from "./airdrop.js";
import { SWAP_EXEC_SPEC, SWAP_QUOTE_SPEC } from "./swap.js";
import { LOCK_SPEC, MULTISEND_SPEC, SPLIT_SPEC } from "./utilities.js";
import { VAULT_CREATE_SPEC, VAULT_DEPOSIT_SPEC, VAULT_INFO_SPEC, VAULT_LIST_SPEC } from "./vault.js";
import { parseCommand, type CommandSpec } from "../lib/command.js";
import { UsageError } from "../util/log.js";

export const COMPLETION_SPEC: CommandSpec = {
  name: "completion",
  summary: "print a shell completion script",
  usage: "gullycore completion <bash|zsh|fish|powershell>",
  flags: {},
  examples: ['eval "$(gullycore completion bash)"', "gullycore completion fish > ~/.config/fish/completions/gullycore.fish", "gullycore completion powershell | Out-String | Invoke-Expression"],
};

interface Node {
  readonly subs: Readonly<Record<string, readonly string[]>>;
  readonly flags: readonly string[];
}

function flagsOf(f: FlagSpecs): string[] {
  return Object.keys(f).map((n) => `--${n}`);
}

const specFlags = (s: CommandSpec): string[] => flagsOf(s.flags);

/** The whole command tree. Exported so a test can hold it to the CLI's real commands. */
export function commandTree(): Readonly<Record<string, Node>> {
  const leaf = (flags: readonly string[]): Node => ({ subs: {}, flags });
  const group = (subs: Record<string, CommandSpec>): Node => ({ subs: Object.fromEntries(Object.entries(subs).map(([k, s]) => [k, specFlags(s)])), flags: [] });
  return {
    init: leaf([]),
    launch: leaf(specFlags(LAUNCH_SPEC)),
    site: { subs: { create: specFlags(SITE_SPEC), edit: specFlags(SITE_SPEC), show: specFlags(SITE_SPEC) }, flags: [] },
    doctor: leaf(specFlags(DOCTOR_SPEC)),
    airdrop: { subs: { build: specFlags(AIRDROP_SPEC), create: specFlags(AIRDROP_SPEC), verify: specFlags(AIRDROP_SPEC), claim: specFlags(AIRDROP_SPEC) }, flags: [] },
    multisend: leaf(specFlags(MULTISEND_SPEC)),
    split: leaf(specFlags(SPLIT_SPEC)),
    lock: { subs: { position: specFlags(LOCK_SPEC), status: specFlags(LOCK_SPEC), claim: specFlags(LOCK_SPEC) }, flags: specFlags(LOCK_SPEC) },
    swap: group({ quote: SWAP_QUOTE_SPEC, exec: SWAP_EXEC_SPEC }),
    quote: leaf(specFlags(SWAP_QUOTE_SPEC)),
    pool: group({ list: POOL_LIST_SPEC, info: POOL_INFO_SPEC, create: POOL_CREATE_SPEC }),
    liquidity: group({ add: LIQUIDITY_ADD_SPEC, remove: LIQUIDITY_REMOVE_SPEC }),
    vault: group({ list: VAULT_LIST_SPEC, info: VAULT_INFO_SPEC, create: VAULT_CREATE_SPEC, deposit: VAULT_DEPOSIT_SPEC }),
    fees: leaf(specFlags(FEES_SPEC)),
    tokens: group({ list: TOKENS_LIST_SPEC, info: TOKENS_INFO_SPEC }),
    chain: group({ list: CHAIN_LIST_SPEC, status: CHAIN_STATUS_SPEC }),
    config: { subs: { list: [], get: [], set: [], unset: [], path: [] }, flags: specFlags(CONFIG_SPEC) },
    completion: { subs: { bash: [], zsh: [], fish: [], powershell: [] }, flags: [] },
    new: leaf(flagsOf(NEW_FLAGS)),
    devnet: leaf(flagsOf(DEVNET_FLAGS)),
    bitmap: leaf(flagsOf(BITMAP_FLAGS)),
  };
}

function words(n: Node): string {
  return [...Object.keys(n.subs), ...n.flags].join(" ");
}

export function bashScript(tree: Readonly<Record<string, Node>>): string {
  const cases = Object.entries(tree)
    .map(([name, n]) => {
      const subs = Object.entries(n.subs).map(([s, f]) => `        ${s}) words="${f.join(" ")}" ;;`);
      return `    ${name})\n      case "$sub" in\n${subs.join("\n")}${subs.length > 0 ? "\n" : ""}        *) words="${words(n)}" ;;\n      esac ;;`;
    })
    .join("\n");
  return `# gullycore completion (bash): eval "$(gullycore completion bash)"
_gullycore() {
  local cur="\${COMP_WORDS[COMP_CWORD]}" cmd="\${COMP_WORDS[1]}" sub="\${COMP_WORDS[2]}" words=""
  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=($(compgen -W "${Object.keys(tree).join(" ")} --help --version" -- "$cur"))
    return
  fi
  case "$cmd" in
${cases}
  esac
  COMPREPLY=($(compgen -W "$words" -- "$cur"))
}
complete -F _gullycore gullycore
`;
}

export function zshScript(tree: Readonly<Record<string, Node>>): string {
  return `#compdef gullycore
# gullycore completion (zsh): gullycore completion zsh > "\${fpath[1]}/_gullycore"
autoload -U +X bashcompinit && bashcompinit
${bashScript(tree)}`;
}

export function fishScript(tree: Readonly<Record<string, Node>>): string {
  const lines = [`# gullycore completion (fish)`, `complete -c gullycore -f`, `complete -c gullycore -n __fish_use_subcommand -a "${Object.keys(tree).join(" ")}"`];
  for (const [name, n] of Object.entries(tree)) {
    if (Object.keys(n.subs).length > 0) lines.push(`complete -c gullycore -n "__fish_seen_subcommand_from ${name}" -a "${Object.keys(n.subs).join(" ")}"`);
    const flags = new Set([...n.flags, ...Object.values(n.subs).flat()]);
    for (const f of flags) lines.push(`complete -c gullycore -n "__fish_seen_subcommand_from ${name}" -l ${f.slice(2)}`);
  }
  return `${lines.join("\n")}\n`;
}

export function powershellScript(tree: Readonly<Record<string, Node>>): string {
  const table = Object.entries(tree)
    .map(([name, n]) => `  '${name}' = '${words(n)} ${[...new Set(Object.values(n.subs).flat())].join(" ")}'`)
    .join("\n");
  return `# gullycore completion (PowerShell): gullycore completion powershell | Out-String | Invoke-Expression
$gullycoreWords = @{
${table}
}
Register-ArgumentCompleter -Native -CommandName gullycore -ScriptBlock {
  param($word, $ast, $cursor)
  $parts = $ast.CommandElements | ForEach-Object { $_.ToString() }
  $list = if ($parts.Count -le 2 -and $word) { $gullycoreWords.Keys } elseif ($parts.Count -ge 2) { ($gullycoreWords[$parts[1]] -split ' ') } else { $gullycoreWords.Keys }
  $list | Where-Object { $_ -like "$word*" } | ForEach-Object { [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_) }
}
`;
}

export function runCompletion(argv: readonly string[]): number {
  /* The script goes to stdout alone so it can be piped into a shell: no brand line, no parseCommand. */
  const shell = argv[0];
  if (shell === undefined || shell === "--help" || shell === "-h") {
    const cmd = parseCommand([], COMPLETION_SPEC);
    cmd.out.line(`${COMPLETION_SPEC.usage}\n\n${(COMPLETION_SPEC.examples ?? []).join("\n")}`);
    return shell === undefined ? 2 : 0;
  }
  const tree = commandTree();
  const scripts: Record<string, () => string> = { bash: () => bashScript(tree), zsh: () => zshScript(tree), fish: () => fishScript(tree), powershell: () => powershellScript(tree) };
  const make = scripts[shell];
  if (make === undefined) throw new UsageError(`no completion for "${shell}"`, "bash, zsh, fish or powershell");
  process.stdout.write(make());
  return 0;
}
