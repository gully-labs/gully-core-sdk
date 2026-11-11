// SPDX-License-Identifier: MIT
/**
 * `gullycore site` — a hosted Launchpad or DEX: create one, edit its terms and brand, show it.
 *
 * One contract backs all three kinds (a `GullyCorePad` clone from `GullyCorePadFactory.createPad`); the brand's
 * `kind` only changes what the hosted site renders. Everything is read from and written to chain; the
 * SDK builds every call (`prepareCreatePad`, `encodeConfigurePad`, `encodeSetPadMetadata`).
 */

import {
  ALL_BIN_SHAPES,
  ALL_PRESETS,
  GULLYCORE_PAD_ABI,
  GULLYCORE_PAD_FACTORY_ABI,
  PAD_KINDS,
  PAD_THEMES,
  PAD_THEME_NAMES,
  encodeConfigurePad,
  encodeSetPadMetadata,
  normalizePadXInput,
  padTermsOf,
  prepareCreatePad,
  readKitV2Limits,
  readPad,
  validatePadBrand,
  type KitV2Limits,
  type PadBrand,
  type PadKind,
  type PadRecord,
  type PadTerms,
  type PadTheme,
} from "@gullylabs/core-sdk/launchpad";
import { formatUnits, getAddress, isAddress, type Abi, type Address, type Hex } from "viem";
import { readFileSync } from "node:fs";

import { bpsPercent, parsePercentBps, parseUnitsExact } from "../lib/amounts.js";
import { ui } from "../lib/brand.js";
import { CHAIN_FLAGS, assertLiveChain, requireDeployment, requireFeature, resolveChain, type ChainContext } from "../lib/chain.js";
import { helpText, parseCommand, type CommandSpec, type ParsedCommand } from "../lib/command.js";
import type { Output } from "../lib/output.js";
import { BACK, askSelect, askText, canPrompt, intro, outro, runSteps, type Step } from "../lib/prompt.js";
import { SIGNER_FLAGS, resolveSigner, signModeOf, type PreparedTx } from "../lib/tx.js";
import { flowExit, runFlow } from "../lib/flow.js";
import { UserError } from "../util/log.js";

const KIND_LABEL: Record<PadKind, string> = { launchpad: "Launchpad", dex: "DEX", both: "Launchpad + DEX", stocks: "Stock market" };

export const SITE_SPEC: CommandSpec = {
  name: "site",
  summary: "create or edit a hosted Launchpad or DEX site",
  usage: "gullycore site create --chain <chain> [options]\n  gullycore site edit <address> --chain <chain> [options]\n  gullycore site show <address> --chain <chain>",
  bytes32Flags: ["salt"],
  flags: {
    ...CHAIN_FLAGS,
    ...SIGNER_FLAGS,
    factory: { kind: "string", describe: "GullyCorePadFactory address (default: the address book's)", placeholder: "<address>" },
    kind: { kind: "string", describe: "launchpad, dex, both or stocks", placeholder: "<kind>", defaultLabel: "launchpad" },
    name: { kind: "string", describe: "site name (also fixes its address with your wallet)", placeholder: "<text>" },
    "fee-wallet": { kind: "string", describe: "receives the site's launch fees and LP-fee share (default: the sender)", placeholder: "<address>" },
    "lp-share": { kind: "string", describe: "site's share of every locked pool's LP fees, percent", placeholder: "<pct>", defaultLabel: "0" },
    "launch-fee": { kind: "string", describe: "site's fee per launch, in native units", placeholder: "<amount>", defaultLabel: "0" },
    "max-tax": { kind: "string", describe: "highest creator tax a launch here may set, percent (0 forbids a tax)", placeholder: "<pct>", defaultLabel: "the guard's maximum" },
    "tax-share": { kind: "string", describe: "site's share of every creator tax, percent", placeholder: "<pct>", defaultLabel: "0" },
    "dex-fee": { kind: "string", describe: "DEX swap fee to the fee wallet, percent of output (max 1)", placeholder: "<pct>", defaultLabel: "0" },
    "dex-scope": { kind: "string", describe: "DEX routes through: launches (this site's) or all", placeholder: "<scope>", defaultLabel: "launches" },
    tagline: { kind: "string", describe: "one line under the name", placeholder: "<text>" },
    theme: { kind: "string", describe: `theme pack: ${PAD_THEME_NAMES.join(", ")}`, placeholder: "<name>" },
    accent: { kind: "string", describe: "accent colour #rrggbb", placeholder: "<hex>" },
    logo: { kind: "string", describe: "logo URL (https:// or ipfs://)", placeholder: "<url>" },
    website: { kind: "string", describe: "website URL", placeholder: "<url>" },
    x: { kind: "string", describe: "X handle or URL", placeholder: "<handle>" },
    telegram: { kind: "string", describe: "Telegram handle", placeholder: "<handle>" },
    terms: { kind: "string", describe: "JSON file with the site terms (overrides the term flags)", placeholder: "<file>" },
    salt: { kind: "string", describe: "32-byte salt (default: derived from the name)", placeholder: "<0x…>" },
  },
  examples: [
    "gullycore site create --chain gully-testnet",
    "gullycore site create --chain gully-testnet --kind dex --name 'Frog Swap' --dex-fee 0.3 --keystore me.json --yes",
    "gullycore site edit 0x… --chain gully-testnet --lp-share 10 --keystore me.json",
    "gullycore site show 0x… --chain gully-testnet --json",
  ],
};

interface SiteInputs {
  kind: PadKind;
  name: string;
  feeWallet: string;
  lpShare: string;
  launchFee: string;
  maxTax: string;
  taxShare: string;
  dexFee: string;
  dexScope: "launches" | "all";
  tagline: string;
  theme: string;
  accent: string;
  logo: string;
  website: string;
  x: string;
  telegram: string;
}

/* ---------------------------------------------------------------- terms */

export interface TermsFile {
  readonly integrator: string;
  readonly integratorBps: number;
  readonly integratorLaunchFeeWei: string;
  readonly allowedPresets?: readonly string[];
  readonly allowedBinShapes?: readonly string[];
  readonly restrictQuotes?: boolean;
  readonly active?: boolean;
  readonly maxTaxBps?: number;
  readonly taxIntegratorBps?: number;
}

/** A terms JSON file -> `PadTerms`. Exported for `gullycore doctor`'s drift check. */
export function termsFromFile(path: string): PadTerms {
  let raw: TermsFile;
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as TermsFile;
  } catch (e) {
    throw new UserError(`cannot read terms file ${path}`, e instanceof Error ? e.message : undefined);
  }
  if (!isAddress(raw.integrator)) throw new UserError("terms.integrator must be an address");
  if (!/^\d+$/.test(String(raw.integratorLaunchFeeWei))) throw new UserError("terms.integratorLaunchFeeWei must be a decimal string of wei");
  return {
    integrator: getAddress(raw.integrator),
    integratorBps: raw.integratorBps,
    integratorLaunchFeeWei: BigInt(raw.integratorLaunchFeeWei),
    allowedPresets: (raw.allowedPresets ?? ALL_PRESETS) as PadTerms["allowedPresets"],
    allowedBinShapes: (raw.allowedBinShapes ?? ALL_BIN_SHAPES) as PadTerms["allowedBinShapes"],
    restrictQuotes: raw.restrictQuotes ?? false,
    active: raw.active ?? true,
    maxTaxBps: raw.maxTaxBps ?? 0,
    taxIntegratorBps: raw.taxIntegratorBps ?? 0,
  };
}

function termsFromInputs(i: SiteInputs, limits: KitV2Limits, sender: Address): PadTerms {
  const wallet = i.feeWallet.trim() === "" ? sender : i.feeWallet.trim();
  if (!isAddress(wallet)) throw new UserError(`fee wallet is not an address: ${wallet}`);
  const launchFeeWei = parseUnitsExact(i.launchFee, 18, "launch fee");
  if (launchFeeWei > limits.maxIntegratorLaunchFeeWei) {
    throw new UserError(`launch fee is above the kit's cap of ${formatUnits(limits.maxIntegratorLaunchFeeWei, 18)}`);
  }
  return {
    integrator: getAddress(wallet),
    integratorBps: parsePercentBps(i.lpShare, "LP share", limits.locker.maxIntegratorBps),
    integratorLaunchFeeWei: launchFeeWei,
    allowedPresets: ALL_PRESETS,
    allowedBinShapes: ALL_BIN_SHAPES,
    restrictQuotes: false,
    active: true,
    maxTaxBps: i.maxTax.trim() === "" ? limits.tax.maxTaxBps : parsePercentBps(i.maxTax, "max tax", limits.tax.maxTaxBps),
    taxIntegratorBps: parsePercentBps(i.taxShare, "tax share", limits.tax.maxIntegratorBps),
  };
}

function brandFromInputs(i: SiteInputs): PadBrand {
  const links: Record<string, string> = {};
  if (i.website.trim() !== "") links["website"] = i.website.trim();
  if (i.x.trim() !== "") {
    const x = normalizePadXInput(i.x);
    if (!x.ok) throw new UserError(`X: ${x.message}`);
    if (x.url !== null) links["x"] = x.url;
  }
  if (i.telegram.trim() !== "") links["telegram"] = `https://t.me/${i.telegram.trim().replace(/^@/, "").replace(/^https:\/\/t\.me\//, "")}`;
  const dexOn = i.kind !== "launchpad";
  const brand: PadBrand = {
    v: 1,
    kind: i.kind,
    ...(i.tagline.trim() !== "" ? { tagline: i.tagline.trim() } : {}),
    ...(i.theme.trim() !== "" ? { theme: i.theme.trim() as PadTheme } : {}),
    ...(i.accent.trim() !== "" ? { accent: i.accent.trim() } : {}),
    ...(i.logo.trim() !== "" ? { logoUrl: i.logo.trim() } : {}),
    ...(Object.keys(links).length > 0 ? { links } : {}),
    ...(dexOn ? { dex: { enabled: true, feeBps: parsePercentBps(i.dexFee, "DEX fee", 100), scope: i.dexScope } } : {}),
    launchpad: { enabled: i.kind !== "dex" },
  };
  const issues = validatePadBrand(brand);
  if (issues.length > 0) throw new UserError(`brand: ${issues.map((x) => `${x.field} ${x.message}`).join("; ")}`);
  return brand;
}

function inputsFromFlags(cmd: ParsedCommand, base?: SiteInputs): SiteInputs {
  const i: SiteInputs = base ?? {
    kind: "launchpad",
    name: "",
    feeWallet: "",
    lpShare: "0",
    launchFee: "0",
    maxTax: "",
    taxShare: "0",
    dexFee: "0",
    dexScope: "launches",
    tagline: "",
    theme: "",
    accent: "",
    logo: "",
    website: "",
    x: "",
    telegram: "",
  };
  const map: Array<[keyof SiteInputs, string]> = [
    ["name", "name"],
    ["feeWallet", "fee-wallet"],
    ["lpShare", "lp-share"],
    ["launchFee", "launch-fee"],
    ["maxTax", "max-tax"],
    ["taxShare", "tax-share"],
    ["dexFee", "dex-fee"],
    ["tagline", "tagline"],
    ["theme", "theme"],
    ["accent", "accent"],
    ["logo", "logo"],
    ["website", "website"],
    ["x", "x"],
    ["telegram", "telegram"],
  ];
  for (const [k, f] of map) {
    const v = cmd.str(f);
    if (v !== undefined) (i as unknown as Record<string, string>)[k] = v;
  }
  const kind = cmd.str("kind");
  if (kind !== undefined) {
    const k = kind.trim().toLowerCase();
    if (!(PAD_KINDS as readonly string[]).includes(k)) throw new UserError(`--kind must be one of ${PAD_KINDS.join(", ")}`);
    i.kind = k as PadKind;
  }
  const scope = cmd.str("dex-scope");
  if (scope !== undefined) {
    if (scope !== "launches" && scope !== "all") throw new UserError("--dex-scope must be launches or all");
    i.dexScope = scope;
  }
  return i;
}

/* --------------------------------------------------------------- review */

function termsRows(terms: PadTerms, native: string): Array<readonly [string, string]> {
  return [
    ["Fee wallet", terms.integrator],
    ["Launch fee", `${formatUnits(terms.integratorLaunchFeeWei, 18)} ${native} per launch, to the fee wallet`],
    ["LP-fee share", `${bpsPercent(terms.integratorBps)} of every locked pool's LP fees`],
    ["Creator tax", (terms.maxTaxBps ?? 0) === 0 ? "not allowed through this site" : `up to ${bpsPercent(terms.maxTaxBps ?? 0)}, site share ${bpsPercent(terms.taxIntegratorBps ?? 0)}`],
    ["Open to launches", terms.active ? "yes" : "no"],
  ];
}

function brandRows(brand: PadBrand | null): Array<readonly [string, string]> {
  if (brand === null) return [["Brand", "none"]];
  const rows: Array<readonly [string, string]> = [["Type", KIND_LABEL[brand.kind ?? "launchpad"]]];
  if (brand.dex !== undefined) rows.push(["DEX fee", `${bpsPercent(brand.dex.feeBps)} of swap output, routing ${brand.dex.scope ?? "launches"}`]);
  if (brand.tagline !== undefined) rows.push(["Tagline", brand.tagline]);
  if (brand.theme !== undefined) rows.push(["Theme", `${brand.theme} (${PAD_THEMES[brand.theme]})`]);
  if (brand.accent !== undefined) rows.push(["Accent", brand.accent]);
  for (const [k, v] of Object.entries(brand.links ?? {})) rows.push([k[0]!.toUpperCase() + k.slice(1), v]);
  return rows;
}

function siteUrl(ctx: ChainContext, pad: Address): string | null {
  if (ctx.overrideSource !== null || ctx.deployment === null) return null;
  return `${ctx.deployment.isMainnet ? "https://gullychain.xyz/core" : "https://gullychain.xyz/core"}/p/${pad}`;
}

/* ------------------------------------------------------------- stepper */

async function interactive(i: SiteInputs, limits: KitV2Limits, native: string): Promise<void> {
  const steps: Step<SiteInputs>[] = [
    {
      title: "Type",
      run: async (s) => {
        const k = await askSelect<PadKind>({
          message: "What are you building?",
          options: [
            { value: "launchpad", label: "Launchpad", hint: "people launch tokens through your site" },
            { value: "dex", label: "DEX", hint: "a trading site over Gully Core pools" },
            { value: "both", label: "Launchpad + DEX", hint: "both, side by side" },
          ],
          initial: s.kind,
        });
        if (k === BACK) return BACK;
        s.kind = k;
        return undefined;
      },
    },
    {
      title: "Name",
      run: async (s) => {
        const n = await askText({ message: "Site name", defaultValue: s.name || undefined, back: true, validate: (v) => (v.trim().length < 3 ? "at least 3 characters" : undefined) });
        if (n === BACK) return BACK;
        s.name = n;
        return undefined;
      },
    },
    {
      title: "Your earnings",
      run: async (s) => {
        const w = await askText({ message: "Fee wallet (Enter for the sending wallet)", defaultValue: s.feeWallet, placeholder: "sending wallet", back: true, validate: (v) => (v === "" || isAddress(v) ? undefined : "an address") });
        if (w === BACK) return BACK;
        s.feeWallet = w;
        if (s.kind !== "dex") {
          const f = await askText({ message: `Your fee per launch, in ${native} (max ${formatUnits(limits.maxIntegratorLaunchFeeWei, 18)})`, defaultValue: s.launchFee, back: true });
          if (f === BACK) return BACK;
          const lp = await askText({ message: `Your share of locked LP fees, percent (max ${bpsPercent(limits.locker.maxIntegratorBps)})`, defaultValue: s.lpShare, back: true });
          if (lp === BACK) return BACK;
          const tx = await askText({ message: `Your share of creator taxes, percent (max ${bpsPercent(limits.tax.maxIntegratorBps)})`, defaultValue: s.taxShare, back: true });
          if (tx === BACK) return BACK;
          s.launchFee = f;
          s.lpShare = lp;
          s.taxShare = tx;
        }
        if (s.kind !== "launchpad") {
          const d = await askText({ message: "DEX swap fee to your wallet, percent of output (max 1)", defaultValue: s.dexFee, back: true });
          if (d === BACK) return BACK;
          s.dexFee = d;
        }
        return undefined;
      },
    },
    {
      title: "Look",
      run: async (s) => {
        const t = await askSelect<string>({
          message: "Theme",
          options: [{ value: "", label: "Default" }, ...PAD_THEME_NAMES.map((n) => ({ value: n, label: n, hint: PAD_THEMES[n] }))],
          initial: s.theme,
          back: true,
        });
        if (t === BACK) return BACK;
        const tag = await askText({ message: "Tagline (optional)", defaultValue: s.tagline, placeholder: "skip", back: true });
        if (tag === BACK) return BACK;
        const ac = await askText({ message: "Accent colour #rrggbb (optional)", defaultValue: s.accent, placeholder: "skip", back: true, validate: (v) => (v === "" || /^#[0-9a-fA-F]{6}$/.test(v) ? undefined : "#rrggbb") });
        if (ac === BACK) return BACK;
        s.theme = t;
        s.tagline = tag;
        s.accent = ac;
        return undefined;
      },
    },
    {
      title: "Links",
      run: async (s) => {
        const w = await askText({ message: "Website (optional)", defaultValue: s.website, placeholder: "skip", back: true });
        if (w === BACK) return BACK;
        const x = await askText({ message: "X handle (optional)", defaultValue: s.x, placeholder: "skip", back: true });
        if (x === BACK) return BACK;
        const t = await askText({ message: "Telegram handle (optional)", defaultValue: s.telegram, placeholder: "skip", back: true });
        if (t === BACK) return BACK;
        s.website = w;
        s.x = x;
        s.telegram = t;
        return undefined;
      },
    },
  ];
  await runSteps(steps, i);
}

/* ------------------------------------------------------------------ run */

async function showSite(out: Output, ctx: ChainContext, pad: Address): Promise<PadRecord> {
  const rec = await readPad(ctx.client, pad);
  const brand = rec.metadata.kind === "brand" ? rec.metadata.brand : null;
  out.line(ui.bold(rec.name));
  out.rows([["Address", rec.address], ["Owner", rec.owner], ...brandRows(brand), ...termsRows(padTermsOf(rec), ctx.chain.nativeCurrency.symbol)]);
  const url = siteUrl(ctx, pad);
  if (url !== null) out.line(`  ${ui.muted("Site")}  ${ui.accent(url)}`);
  return rec;
}

export async function runSite(argv: readonly string[]): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub === undefined || sub === "--help" || sub === "-h" || !["create", "edit", "show"].includes(sub)) {
    process.stdout.write(`${helpText(SITE_SPEC)}\n`);
    return sub === undefined || sub.startsWith("-") ? 0 : 1;
  }
  const cmd = parseCommand(rest, { ...SITE_SPEC, name: `site ${sub}` });
  const out = cmd.out;
  if (cmd.help) {
    out.line(helpText(SITE_SPEC));
    return 0;
  }
  const yes = cmd.bool("yes");
  const prompting = !yes && !out.json && canPrompt();
  const ctx = resolveChain({ chain: cmd.str("chain"), rpc: cmd.str("rpc"), deployment: cmd.str("deployment") });
  const factoryFlag = cmd.str("factory");
  const factory = factoryFlag !== undefined ? getAddress(factoryFlag) : requireFeature(ctx, "Launchpad and DEX sites", ctx.deployment?.launchpadV2.padFactory);
  requireDeployment(ctx);
  if (ctx.overrideSource !== null) out.line(ui.muted(`addresses: from ${ctx.overrideSource}`));
  await assertLiveChain(ctx);
  const native = ctx.chain.nativeCurrency.symbol;
  const abis = [GULLYCORE_PAD_FACTORY_ABI as unknown as Abi, GULLYCORE_PAD_ABI as unknown as Abi];

  if (sub === "show") {
    const target = cmd.args.positionals[0];
    if (target === undefined || !isAddress(target)) throw new UserError("gullycore site show <address>");
    const rec = await showSite(out, ctx, getAddress(target));
    out.result("site show", { chainId: ctx.chainId, result: { ...rec, terms: padTermsOf(rec), url: siteUrl(ctx, rec.address) } });
    return 0;
  }

  const kit = (await ctx.client.readContract({ address: factory, abi: GULLYCORE_PAD_FACTORY_ABI, functionName: "KIT" })) as Address;
  const limits = await readKitV2Limits(ctx.client, kit);
  const mode = signModeOf(cmd.args);
  const signer = await resolveSigner(mode, cmd.str("from"), (a) => isAddress(a));
  const saltFlag = cmd.str("salt");
  if (saltFlag !== undefined && !/^0x[0-9a-fA-F]{64}$/.test(saltFlag)) throw new UserError("--salt must be 32 bytes of hex");

  if (sub === "create") {
    if (prompting) intro(`Gully Core · new site on ${ctx.name}`);
    const input = inputsFromFlags(cmd);
    if (prompting) await interactive(input, limits, native);
    if (input.name.trim() === "") throw new UserError("--name is required");
    const termsPath = cmd.str("terms");
    const terms = termsPath !== undefined ? termsFromFile(termsPath) : termsFromInputs(input, limits, signer.address);
    const brand = brandFromInputs(input);
    const prepared = await prepareCreatePad(ctx.client, {
      chainId: ctx.chainId,
      creator: signer.address,
      name: input.name.trim(),
      brand,
      terms,
      factory,
      ...(saltFlag !== undefined ? { userSalt: saltFlag as Hex } : {}),
    });
    if (prepared.exists) {
      throw new UserError(`your wallet already has a site named "${input.name}" at ${prepared.predicted}`, "pick another name, or pass --salt");
    }
    out.line("");
    out.line(ui.bold("Review"));
    out.rows([
      ["Name", input.name.trim()],
      ["Address", `${prepared.predicted} (fixed by your wallet and the name)`],
      ...brandRows(brand),
      ...termsRows(terms, native),
      ["Site fee", `${formatUnits(prepared.fee.feeWei, 18)} ${native}, to the protocol, not refundable`],
      ["Sent", `${formatUnits(prepared.tx.value, 18)} ${native}${prepared.tx.value > prepared.fee.feeWei ? " (covers an announced increase; surplus refunded in the same call)" : ""}`],
    ]);
    out.line(ui.muted("  Terms and brand stay editable by the owner; launches already made keep the terms they were made under."));
    out.line("");
    const tx: PreparedTx = { chainId: ctx.chainId, from: signer.address, to: prepared.tx.to, data: prepared.tx.data, value: prepared.tx.value };
    const r = await runFlow(out, ctx, signer, [{ label: "createPad", tx }], { prompting, yes, what: `This pays the site fee and creates "${input.name.trim()}".`, expected: input.name.trim() }, abis);
    let readBack: unknown = null;
    if (r.ok && r.sent.length > 0) {
      out.line("");
      readBack = await showSite(out, ctx, prepared.predicted);
    }
    out.result("site create", {
      chainId: ctx.chainId,
      mode: mode.kind,
      tx,
      simulation: r.simulations[0] ?? null,
      result: { site: prepared.predicted, userSalt: prepared.userSalt, fee: prepared.fee, terms, brand, url: siteUrl(ctx, prepared.predicted), sent: r.sent, readBack },
    });
    if (prompting) outro(r.ok ? (signer.account === null ? "Nothing was signed." : "Done.") : "Nothing was sent.");
    return flowExit(r);
  }

  /* edit */
  const target = cmd.args.positionals[0];
  if (target === undefined || !isAddress(target)) throw new UserError("gullycore site edit <address>");
  const pad = getAddress(target);
  const rec = await readPad(ctx.client, pad);
  if (rec.owner.toLowerCase() !== signer.address.toLowerCase()) {
    throw new UserError(`only the site owner ${rec.owner} can edit it`);
  }
  const brand0 = rec.metadata.kind === "brand" ? rec.metadata.brand : null;
  const current: SiteInputs = {
    kind: brand0?.kind ?? "launchpad",
    name: rec.name,
    feeWallet: rec.tenant.integrator,
    lpShare: String(rec.tenant.integratorBps / 100),
    launchFee: formatUnits(rec.tenant.integratorLaunchFeeWei, 18),
    maxTax: String(rec.tenant.maxTaxBps / 100),
    taxShare: String(rec.tenant.taxIntegratorBps / 100),
    dexFee: String((brand0?.dex?.feeBps ?? 0) / 100),
    dexScope: brand0?.dex?.scope ?? "launches",
    tagline: brand0?.tagline ?? "",
    theme: brand0?.theme ?? "",
    accent: brand0?.accent ?? "",
    logo: brand0?.logoUrl ?? "",
    website: brand0?.links?.website ?? "",
    x: brand0?.links?.x ?? "",
    telegram: (brand0?.links?.telegram ?? "").replace(/^https:\/\/t\.me\//, ""),
  };
  const input = inputsFromFlags(cmd, { ...current });
  if (prompting) {
    intro(`Gully Core · edit ${rec.name}`);
    await interactive(input, limits, native);
  }
  const termsPath = cmd.str("terms");
  const terms = termsPath !== undefined ? termsFromFile(termsPath) : termsFromInputs(input, limits, signer.address);
  const brand = brandFromInputs(input);
  const oldTerms = padTermsOf(rec);
  const txs: { label: string; tx: PreparedTx }[] = [];
  if (JSON.stringify(encodeConfigurePad(terms)) !== JSON.stringify(encodeConfigurePad(oldTerms))) {
    txs.push({ label: "configure (terms)", tx: { chainId: ctx.chainId, from: signer.address, to: pad, data: encodeConfigurePad(terms), value: 0n } });
  }
  const newMeta = encodeSetPadMetadata(input.name.trim(), brand);
  if (newMeta !== encodeSetPadMetadata(rec.name, brand0)) {
    txs.push({ label: "setMetadata (name and brand)", tx: { chainId: ctx.chainId, from: signer.address, to: pad, data: newMeta, value: 0n } });
  }
  if (txs.length === 0) {
    out.line("Nothing to change: the flags match what is on chain.");
    out.result("site edit", { chainId: ctx.chainId, result: { site: pad, changes: [] } });
    return 0;
  }
  out.line(ui.bold("Review"));
  out.rows([...brandRows(brand), ...termsRows(terms, native)]);
  out.line(ui.muted("  New terms apply to launches made from now on; existing launches keep theirs."));
  const r = await runFlow(out, ctx, signer, txs, { prompting, yes, what: `This updates "${rec.name}".`, expected: rec.name }, abis);
  let readBack: unknown = null;
  if (r.ok && r.sent.length > 0) readBack = await showSite(out, ctx, pad);
  out.result("site edit", { chainId: ctx.chainId, mode: mode.kind, txs: txs.map((t) => ({ label: t.label, ...t.tx })), simulations: r.simulations, result: { site: pad, sent: r.sent, readBack } });
  return flowExit(r);
}

