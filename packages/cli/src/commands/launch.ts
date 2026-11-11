// SPDX-License-Identifier: MIT
/**
 * `gullycore launch` — a Kit v2 launch, market-cap-first.
 *
 * The SDK does the protocol work (`readKitV2Limits`, `buildLaunchV2` = `predictLaunchTokenChecked` +
 * `buildLaunchParamsV2` + `validateLaunchParamsV2`); this file is the conversation around it:
 *
 *   1. the creator picks an OPENING MARKET CAP, in dollars only when `resolveNativeUsd` produced a real
 *      price (tier and feed shown), otherwise in the quote's own units with no dollar figure anywhere;
 *   2. the cap becomes a price per token with the SDK's exact integer maths;
 *   3. the kit's maths snaps that price onto the range edge (CL) or a bin (Bin), and the review shows
 *      the SNAPPED price and the cap it implies — the number the pool is actually born at;
 *   4. the exact bytes are simulated, and only then offered for signing.
 */

import {
  LAUNCHPAD_KIT_V2_ABI,
  LAUNCHPAD_KIT_V2_REVERT_ABI,
  LAUNCH_TOKEN_DECIMALS,
  launchSplitBounds,
  PRESET,
  PRESET_NAMES,
  PRESET_PARAMS,
  BIN_SHAPE_NAMES,
  buildLaunchV2,
  readKitV2Limits,
  readTokenMeta,
  type BinShapeName,
  type BuiltLaunchV2,
  type KitV2Limits,
  type LaunchDraftV2,
  type PresetName,
} from "@gullylabs/core-sdk/launchpad";
import {
  DEFAULT_OPENING_MARKET_CAP_USD,
  formatUsdAmount,
  marketCapFromOpeningPrice,
  nativeMarketCapFromOpeningPrice,
  openingPriceFromMarketCap,
  openingPriceFromNativeMarketCap,
  resolveNativeUsd,
  type NativeUsdResult,
} from "@gullylabs/core-sdk/price";
import { GULLY_LAUNCH_RULES } from "@gullylabs/core-sdk";
import { erc20Abi, formatUnits, getAddress, isAddress, parseEventLogs, toHex, type Abi, type Address, type Hex } from "viem";
import { randomBytes } from "node:crypto";

import { bpsPercent, decimalToRawFloor, formatSignificant, formatUnitsTrim, humanSeconds, parseIntStrict, parsePercentBps, parseUnitsExact, pipsPercent } from "../lib/amounts.js";
import { ui } from "../lib/brand.js";
import { CHAIN_FLAGS, assertLiveChain, assertNativeValue, requireDeployment, requireFeature, resolveChain, type ChainContext } from "../lib/chain.js";
import { helpText, parseCommand, type CommandSpec } from "../lib/command.js";
import type { Output } from "../lib/output.js";
import { BACK, askSelect, askText, askTypedConfirmation, canPrompt, intro, outro, runSteps, type Step } from "../lib/prompt.js";
import { assertMayWrite, mainnetPrefix } from "../lib/flow.js";
import { SIGNER_FLAGS, canSend, receiptJson, renderTx, resolveSigner, send, signModeOf, simulate, type PreparedTx } from "../lib/tx.js";
import { EXIT, UserError } from "../util/log.js";

const ZERO: Address = "0x0000000000000000000000000000000000000000";

/** The SDK's opening-market-cap default in whole dollars ("3500"): the one source for the flag's
    label and the scripted default. Only used once `resolveNativeUsd` produced a real price. */
const DEFAULT_CAP_USD_TEXT = formatUsdAmount(DEFAULT_OPENING_MARKET_CAP_USD).replace(/\.00$/, "");

export const LAUNCH_SPEC: CommandSpec = {
  name: "launch",
  summary: "launch a token on a locked pool, priced by its opening market cap",
  usage: "gullycore launch --chain <chain> [options]",
  bytes32Flags: ["salt"],
  flags: {
    ...CHAIN_FLAGS,
    ...SIGNER_FLAGS,
    kit: { kind: "string", describe: "LaunchpadKitV2 address (default: the address book's)", placeholder: "<address>" },
    launchpad: { kind: "string", describe: "launch through this Launchpad (its stored terms apply)", placeholder: "<address>" },
    name: { kind: "string", describe: "token name", placeholder: "<text>" },
    symbol: { kind: "string", describe: "token symbol", placeholder: "<text>" },
    supply: { kind: "string", describe: "total supply in whole tokens; release 2 and later mint exactly 1,000,000,000", placeholder: "<n>", defaultLabel: "1000000000" },
    "seed-percent": { kind: "string", describe: "percent of supply seeded into the locked pool", placeholder: "<pct>", defaultLabel: "100" },
    "allocation-to": { kind: "string", describe: "receives the unseeded supply", placeholder: "<address>" },
    quote: { kind: "string", describe: "native, or a quote token address", placeholder: "<native|address>", defaultLabel: "native" },
    "market-cap-usd": { kind: "string", describe: "opening market cap in USD (needs a live native/USD source)", placeholder: "<usd>", defaultLabel: `${DEFAULT_CAP_USD_TEXT} when priced` },
    "market-cap": { kind: "string", describe: "opening market cap in quote units (e.g. 1.5 for 1.5 ETH)", placeholder: "<amount>" },
    pool: { kind: "string", describe: "CL (single-sided range) or Bin (shaped bins)", placeholder: "<CL|Bin>", defaultLabel: "CL" },
    "tick-spacing": { kind: "string", describe: "CL tick spacing", placeholder: "<n>", defaultLabel: "60" },
    width: { kind: "string", describe: "CL range width in tick spacings", placeholder: "<n>", defaultLabel: "200" },
    "bin-step": { kind: "string", describe: "Bin step", placeholder: "<n>", defaultLabel: "100" },
    shape: { kind: "string", describe: `Bin shape: ${BIN_SHAPE_NAMES.filter((n) => n !== "Custom").join(", ")}`, placeholder: "<name>", defaultLabel: "Linear" },
    "bin-count": { kind: "string", describe: "Bin count", placeholder: "<n>", defaultLabel: "10" },
    protection: { kind: "string", describe: `launch protection preset: ${PRESET_NAMES.filter((n) => n !== "Custom").join(", ")}`, placeholder: "<preset>", defaultLabel: "FairLaunch" },
    "start-delay": { kind: "string", describe: "seconds until trading opens", placeholder: "<s>", defaultLabel: "0" },
    "max-buy": { kind: "string", describe: "largest buy per transaction during protection, in quote units (0 = none)", placeholder: "<amount>", defaultLabel: "0" },
    "tax-buy": { kind: "string", describe: "creator tax on buys, percent (max 10)", placeholder: "<pct>", defaultLabel: "0" },
    "tax-sell": { kind: "string", describe: "creator tax on sells, percent (max 10)", placeholder: "<pct>", defaultLabel: "0" },
    "tax-days": { kind: "string", describe: "days the creator tax lasts after trading opens, or forever where the kit allows it", placeholder: "<days|forever>" },
    "tax-protocol": { kind: "string", describe: "protocol share of the tax, percent (the guard's floor applies)", placeholder: "<pct>" },
    "lp-protocol": { kind: "string", describe: "protocol share of locked-LP fees, percent; the kit fixes it by the launch's terms (0 outside Gully's own Launchpads)", placeholder: "<pct>" },
    creator: { kind: "string", describe: "receives the creator share (default: the sender)", placeholder: "<address>" },
    description: { kind: "string", describe: "listing description", placeholder: "<text>" },
    website: { kind: "string", describe: "listing website", placeholder: "<url>" },
    x: { kind: "string", describe: "X handle, without @", placeholder: "<handle>" },
    telegram: { kind: "string", describe: "Telegram handle, without @", placeholder: "<handle>" },
    "metadata-uri": { kind: "string", describe: "token metadata URI", placeholder: "<uri>" },
    salt: { kind: "string", describe: "32-byte salt for the token address (default: random)", placeholder: "<0x…>" },
    "no-usd": { kind: "boolean", describe: "never read a USD price; price in quote units" },
  },
  examples: [
    "gullycore launch --chain gully-testnet",
    "gullycore launch --chain gully-testnet --name Mochi --symbol MOCHI --market-cap 2 --from 0x… --json",
    "gullycore launch --chain gully-testnet --name Mochi --symbol MOCHI --keystore ./me.json --yes",
  ],
};

/* ----------------------------------------------------------------- state */

export interface LaunchInputs {
  name: string;
  symbol: string;
  supply: string;
  seedPercent: string;
  allocationTo: string;
  quote: string;
  capMode: "usd" | "quote";
  capValue: string;
  pool: "CL" | "Bin";
  tickSpacing: string;
  width: string;
  binStep: string;
  shape: BinShapeName;
  binCount: string;
  protection: PresetName;
  startDelay: string;
  maxBuy: string;
  taxBuy: string;
  taxSell: string;
  taxDays: string;
  taxProtocol: string;
  lpProtocol: string;
  creator: string;
  description: string;
  website: string;
  x: string;
  telegram: string;
  metadataURI: string;
}

interface QuoteMeta {
  readonly address: Address;
  readonly symbol: string;
  readonly decimals: number;
  readonly isNative: boolean;
}

interface LaunchEnv {
  readonly ctx: ChainContext;
  readonly kit: Address;
  readonly tenant: Address | null;
  readonly limits: KitV2Limits;
  readonly nativeSymbol: string;
  readonly usd: NativeUsdResult | null;
  readonly launcher: Address;
  readonly salt: Hex;
}

export interface LaunchPlan {
  readonly built: BuiltLaunchV2;
  readonly quote: QuoteMeta;
  readonly totalSupply: bigint;
  readonly seedSupply: bigint;
  /** Raw quote units per whole token, from the cap, before the snap. */
  readonly requestedPrice: bigint;
  /** Raw quote units per whole token the pool is born at (8 significant digits from the snap). */
  readonly snappedPrice: bigint;
  readonly snappedCapQuote: bigint;
  readonly snappedCapUsd: string | null;
  readonly draft: LaunchDraftV2;
}

function defaults(): LaunchInputs {
  return {
    name: "",
    symbol: "",
    supply: "1000000000",
    seedPercent: "100",
    allocationTo: "",
    quote: "native",
    capMode: "quote",
    capValue: "",
    pool: "CL",
    tickSpacing: "60",
    width: "200",
    binStep: "100",
    shape: "Linear",
    binCount: "10",
    protection: "FairLaunch",
    startDelay: "0",
    maxBuy: "0",
    taxBuy: "0",
    taxSell: "0",
    taxDays: "30",
    taxProtocol: "",
    lpProtocol: "",
    creator: "",
    description: "",
    website: "",
    x: "",
    telegram: "",
    metadataURI: "",
  };
}

/* ------------------------------------------------------------ resolution */

/** Whether `--quote` names the chain's native currency: "native" in any case, or the zero address. */
export function isNativeQuote(quote: string): boolean {
  const q = quote.trim().toLowerCase();
  return q === "native" || q === ZERO.toLowerCase();
}

/**
 * The cap a scripted launch opens at when no flag names one: the SDK's USD default, and only for a
 * natively quoted pool on a chain whose native/USD price was read. `null` everywhere else, and the
 * caller then REFUSES rather than falling back to a round number of the quote, which would open a
 * pool at a cap nobody chose.
 */
export function scriptedDefaultCap(usd: NativeUsdResult | null, quote: string): { readonly mode: "usd"; readonly value: string } | null {
  if (usd === null || !usd.ok || !isNativeQuote(quote)) return null;
  return { mode: "usd", value: DEFAULT_CAP_USD_TEXT };
}

async function quoteMetaOf(ctx: ChainContext, quote: string, nativeSymbol: string, nativeDecimals: number): Promise<QuoteMeta> {
  if (isNativeQuote(quote)) {
    return { address: ZERO, symbol: nativeSymbol, decimals: nativeDecimals, isNative: true };
  }
  if (!isAddress(quote)) throw new UserError(`--quote must be "native" or a token address, received ${quote}`);
  const meta = await readTokenMeta(ctx.client, getAddress(quote));
  if (meta === null) throw new UserError(`${quote} does not answer as an ERC-20 on ${ctx.name}`);
  return { address: meta.address, symbol: meta.symbol, decimals: meta.decimals, isNative: false };
}

function presetOf(name: string): PresetName {
  const match = PRESET_NAMES.find((n) => n.toLowerCase() === name.trim().toLowerCase());
  if (match === undefined || match === "Custom") {
    throw new UserError(`unknown protection preset "${name}"`, `use one of ${PRESET_NAMES.filter((n) => n !== "Custom").join(", ")}`);
  }
  return match;
}

function shapeOf(name: string): BinShapeName {
  const match = BIN_SHAPE_NAMES.find((n) => n.toLowerCase() === name.trim().toLowerCase());
  if (match === undefined || match === "Custom") throw new UserError(`unknown Bin shape "${name}"`);
  return match;
}

function optionalAddress(text: string, what: string): Address | null {
  const t = text.trim();
  if (t === "") return null;
  if (!isAddress(t)) throw new UserError(`${what} is not an address: ${t}`);
  return getAddress(t);
}

export interface LaunchTerms {
  readonly totalSupply: bigint;
  readonly taxBuy: number;
  readonly taxSell: number;
  readonly taxSeconds: number;
  readonly taxProtocolBps: number;
  readonly lpProtocolBps: number;
}

/**
 * What the kit allows, applied to what was asked. A release 2 kit fixes the supply and the protocol's 50%
 * share and has no tax ceiling (`maxTaxDurationSeconds` null), so a tax may last forever. Refused here, in
 * words, rather than as a revert. Pure; exported for tests.
 */
export function launchTerms(
  limits: Pick<KitV2Limits, "tax" | "locker" | "feeSplit"> & Pick<Partial<KitV2Limits>, "rules">,
  input: Pick<LaunchInputs, "supply" | "taxBuy" | "taxSell" | "taxDays" | "taxProtocol" | "lpProtocol">,
): LaunchTerms {
  const supplyWhole = parseUnitsExact(input.supply, 0, "supply");
  if (supplyWhole <= 0n) throw new UserError("supply must be positive");
  const totalSupply = supplyWhole * 10n ** BigInt(LAUNCH_TOKEN_DECIMALS);
  const rules = limits.rules ?? null;
  if (rules !== null && totalSupply !== rules.launchTotalSupply) {
    throw new UserError(`this launch kit mints exactly ${formatUnitsTrim(rules.launchTotalSupply, LAUNCH_TOKEN_DECIMALS)} tokens`, "drop --supply");
  }

  const taxBuy = parsePercentBps(input.taxBuy, "buy tax", limits.tax.maxTaxBps);
  const taxSell = parsePercentBps(input.taxSell, "sell tax", limits.tax.maxTaxBps);
  const hasTax = taxBuy > 0 || taxSell > 0;
  const ceiling = limits.tax.maxTaxDurationSeconds;
  const forever = hasTax && input.taxDays.trim().toLowerCase() === "forever";
  if (forever && (rules === null || ceiling !== null)) throw new UserError("this launch kit does not allow a forever tax", "give --tax-days a number");
  const maxDays = ceiling === null ? 36_500 : Math.floor(ceiling / 86_400);
  const taxSeconds = !hasTax ? 0 : forever ? GULLY_LAUNCH_RULES.TAX_SECONDS_FOREVER : parseIntStrict(input.taxDays, "tax days", 1, maxDays) * 86_400;

  const share = (text: string, what: string, min: number, max: number): number => {
    if (text.trim() === "") return min;
    const bps = parsePercentBps(text, what, max);
    if (bps < min) throw new UserError(`${what} cannot be below ${bpsPercent(min)} on this launch kit`, min === max ? "this kit fixes it: drop the flag" : undefined);
    return bps;
  };
  const lp = launchSplitBounds(limits);
  return {
    totalSupply,
    taxBuy,
    taxSell,
    taxSeconds,
    taxProtocolBps: share(input.taxProtocol, "tax protocol share", limits.tax.minProtocolBps, limits.tax.maxProtocolBps),
    lpProtocolBps: share(input.lpProtocol, "LP protocol share", lp.minProtocolBps, lp.maxProtocolBps),
  };
}

/** Inputs + chain reads -> the exact `createLaunch` call and everything the review shows. */
export async function planLaunch(env: LaunchEnv, input: LaunchInputs): Promise<LaunchPlan> {
  const { ctx, limits } = env;
  const deployment = ctx.deployment;
  const nativeDecimals = deployment?.nativeCurrency.decimals ?? 18;
  const quote = await quoteMetaOf(ctx, input.quote, env.nativeSymbol, nativeDecimals);

  const name = input.name.trim();
  const symbol = input.symbol.trim();
  if (name === "") throw new UserError("the token needs a name");
  if (symbol === "") throw new UserError("the token needs a symbol");

  const { totalSupply, taxBuy, taxSell, taxSeconds, taxProtocolBps, lpProtocolBps } = launchTerms(limits, input);
  const hasTax = taxBuy > 0 || taxSell > 0;
  const seedBps = parsePercentBps(input.seedPercent, "seed percent", 10_000);
  if (seedBps === 0) throw new UserError("seed percent must be above 0: the locked pool needs tokens");
  const seedSupply = (totalSupply * BigInt(seedBps)) / 10_000n;
  const allocationTo = optionalAddress(input.allocationTo, "allocation recipient");
  if (seedSupply < totalSupply && allocationTo === null) {
    throw new UserError("with less than 100% seeded, --allocation-to must name who receives the rest");
  }

  let requestedPrice: bigint;
  if (input.capMode === "usd") {
    if (env.usd === null || !env.usd.ok) throw new UserError("no live USD price on this chain; give the market cap in quote units (--market-cap)");
    if (!quote.isNative) throw new UserError("a USD market cap needs the native quote; use --market-cap in quote units");
    const cents = parseUnitsExact(input.capValue.replace(/^\$/, ""), 2, "market cap (USD)");
    requestedPrice = openingPriceFromMarketCap({
      usdTarget: { amount: cents, decimals: 2 },
      totalSupply,
      tokenDecimals: LAUNCH_TOKEN_DECIMALS,
      quoteUsd: { answer: env.usd.answer, answerDecimals: env.usd.answerDecimals },
      quoteDecimals: quote.decimals,
    });
  } else {
    const target = parseUnitsExact(input.capValue, quote.decimals, `market cap (${quote.symbol})`);
    requestedPrice = openingPriceFromNativeMarketCap({ quoteTarget: target, totalSupply, tokenDecimals: LAUNCH_TOKEN_DECIMALS });
  }
  if (requestedPrice === 0n) {
    throw new UserError("that market cap is below one raw quote unit per token at this supply", "raise the market cap or lower the supply");
  }

  const preset = input.protection;
  const pp = PRESET_PARAMS[preset as Exclude<PresetName, "Custom">];
  const maxBuy = parseUnitsExact(input.maxBuy, quote.decimals, "max buy");
  if (pp.requiresMaxBuyPerTx && maxBuy === 0n) throw new UserError(`${preset} requires --max-buy`);


  const creator = optionalAddress(input.creator, "creator") ?? env.launcher;
  const draft: LaunchDraftV2 = {
    name,
    symbol,
    metadataURI: input.metadataURI.trim(),
    totalSupply,
    seedSupply,
    allocationRecipient: allocationTo ?? ZERO,
    creator,
    operator: env.launcher,
    steward: env.launcher,
    protocolBps: lpProtocolBps,
    schedule: {
      preset: PRESET[preset],
      initialFeeBips: 0,
      finalFeeBips: 0,
      decaySeconds: 0,
      startDelaySeconds: parseIntStrict(input.startDelay, "start delay", 0, limits.guard.maxStartDelaySeconds),
    },
    ...(hasTax ? { tax: { buyBps: taxBuy, sellBps: taxSell, taxSeconds, protocolBps: taxProtocolBps } } : {}),
    legs: [
      {
        kind: input.pool,
        quote: quote.address,
        quoteDecimals: quote.decimals,
        weightBps: 10_000,
        quotePerLaunchToken: formatUnits(requestedPrice, quote.decimals),
        maxBuyPerTx: maxBuy,
        tickSpacing: parseIntStrict(input.tickSpacing, "tick spacing", 1, 32_767),
        widthInSpacings: parseIntStrict(input.width, "range width", 1, 1_000_000),
        binStep: parseIntStrict(input.binStep, "bin step", 1, 100),
        shape: input.shape,
        binCount: parseIntStrict(input.binCount, "bin count", 1, limits.caps.maxBinsPerLeg),
      },
    ],
    listing: {
      description: input.description,
      websiteURI: input.website.trim(),
      xHandle: input.x.trim().replace(/^@/, ""),
      telegramHandle: input.telegram.trim().replace(/^@/, ""),
    },
    userSalt: env.salt,
    launcher: env.launcher,
  };

  let built: BuiltLaunchV2;
  try {
    built = await buildLaunchV2(ctx.client, env.kit, draft, limits);
  } catch (e) {
    if (e instanceof RangeError) throw new UserError(e.message);
    throw e;
  }

  const leg = built.legs[0];
  const snappedPrice = leg === undefined ? requestedPrice : decimalToRawFloor(leg.openingPrice, quote.decimals);
  const snappedCapQuote = nativeMarketCapFromOpeningPrice({ price: snappedPrice, totalSupply, tokenDecimals: LAUNCH_TOKEN_DECIMALS });
  const snappedCapUsd =
    env.usd !== null && env.usd.ok && quote.isNative
      ? formatUsdAmount(
          marketCapFromOpeningPrice({
            price: snappedPrice,
            totalSupply,
            tokenDecimals: LAUNCH_TOKEN_DECIMALS,
            quoteUsd: { answer: env.usd.answer, answerDecimals: env.usd.answerDecimals },
            quoteDecimals: quote.decimals,
          }),
        )
      : null;

  return { built, quote, totalSupply, seedSupply, requestedPrice, snappedPrice, snappedCapQuote, snappedCapUsd, draft };
}

/* ---------------------------------------------------------------- review */

export function reviewLines(env: LaunchEnv, plan: LaunchPlan): Array<readonly [string, string]> {
  const { limits } = env;
  const q = plan.quote;
  const b = plan.built;
  const native = env.nativeSymbol;
  const p = b.params;
  const rows: Array<readonly [string, string]> = [];
  rows.push(["Token", `${p.name} (${p.symbol}) at ${b.token}`]);
  rows.push(["Supply", `${formatUnitsTrim(plan.totalSupply, 18)} ${p.symbol}, fixed forever`]);
  rows.push([
    "Seeded",
    `${formatUnitsTrim(plan.seedSupply, 18)} into the locked pool${plan.seedSupply < plan.totalSupply ? `, rest to ${p.allocationRecipient}` : ""}`,
  ]);
  for (const leg of b.legs) {
    rows.push([
      `Opening price (${leg.kind})`,
      `1 ${p.symbol} = ${formatSignificant(plan.snappedPrice, q.decimals, 8)} ${q.symbol}` +
        (leg.snapFraction > 0.000001 ? ui.muted(`  snapped ${(leg.snapFraction * 100).toFixed(4)}% from the cap's price`) : ""),
    ]);
    rows.push(["Pool id", leg.key.poolId]);
  }
  rows.push(["Opening market cap", `${formatSignificant(plan.snappedCapQuote, q.decimals, 8)} ${q.symbol}${plan.snappedCapUsd !== null ? ` ≈ $${plan.snappedCapUsd}` : ""}`]);
  if (plan.snappedCapUsd !== null && env.usd !== null && env.usd.ok) rows.push(["USD source", env.usd.provenance.label]);

  rows.push(["Protocol launch fee", `${formatUnits(limits.value.launchFeeWei, 18)} ${native}`]);
  rows.push(["Launchpad launch fee", `${formatUnits(limits.value.integratorFeeWei, 18)} ${native}${limits.integrator.source === "tenant" ? " (set by the Launchpad)" : ""}`]);
  rows.push(["Sent with the transaction", `${formatUnits(b.value, 18)} ${native}${b.value > limits.value.minimumValue ? " (covers an announced fee increase; the surplus is refunded in the same call)" : ""}`]);
  if (limits.value.pending !== null) {
    rows.push(["Announced fee", `${formatUnits(limits.value.pending.feeWei, 18)} ${native} from ${new Date(Number(limits.value.pending.effectiveAt) * 1000).toISOString()}`]);
  }

  const presetName = PRESET_NAMES[p.schedule.preset] as PresetName;
  const pp = presetName === "Custom" ? null : PRESET_PARAMS[presetName];
  rows.push([
    "Launch protection",
    pp === null
      ? "custom"
      : pp.enabled
        ? `${presetName}: swap fee ${pipsPercent(pp.initialFeeBips)} falling to ${pipsPercent(pp.finalFeeBips)} over ${humanSeconds(pp.windowSeconds)}`
        : `${presetName}: flat ${pipsPercent(pp.finalFeeBips)} swap fee`,
  ]);
  rows.push(["Trading opens", p.schedule.startDelaySeconds === 0 ? "in the launch transaction" : `${humanSeconds(p.schedule.startDelaySeconds)} after it`]);
  const tax = p.tax;
  if (tax.buyBps === 0 && tax.sellBps === 0) {
    rows.push(["Creator tax", "none"]);
  } else {
    rows.push(["Creator tax", `buy ${bpsPercent(tax.buyBps)}, sell ${bpsPercent(tax.sellBps)}, for ${humanSeconds(tax.taxSeconds)} after trading opens, then 0`]);
    rows.push(["Tax split", `creator ${bpsPercent(tax.creatorBps)} · protocol ${bpsPercent(tax.protocolBps)} · Launchpad ${bpsPercent(tax.integratorBps)}`]);
  }
  rows.push(["LP fees (locked)", `creator ${bpsPercent(p.creatorBps)} · protocol ${bpsPercent(p.protocolBps)} · Launchpad ${bpsPercent(p.integratorBps)}`]);
  rows.push(["Creator", p.creator]);
  return rows;
}

export const PERMANENT = [
  "The seeded liquidity is locked forever. Nobody can withdraw it, including you.",
  "The LP-fee split is frozen at creation.",
  "The protection schedule and the creator tax freeze at the first trade.",
  "Supply, name and symbol can never change.",
];

function printReview(out: Output, env: LaunchEnv, plan: LaunchPlan): void {
  out.line("");
  out.line(ui.bold("Review"));
  out.rows(reviewLines(env, plan));
  out.line("");
  out.line(ui.bold("Permanent"));
  for (const l of PERMANENT) out.line(`  ${ui.muted("·")} ${l}`);
  const issues = plan.built.issues;
  if (issues.length > 0) {
    out.line("");
    for (const i of issues) out.line(`  ${ui.bold(i.severity === "error" ? "✕" : "!")} ${i.field}: ${i.message}${i.contractError !== undefined ? ui.muted(` (${i.contractError})`) : ""}`);
  }
}

/* --------------------------------------------------------------- stepper */

function capPrompt(env: LaunchEnv, quoteSymbol: string, isNative: boolean): { mode: "usd" | "quote"; message: string; defaultValue: string | undefined } {
  if (env.usd !== null && env.usd.ok && isNative) {
    return { mode: "usd", message: "Opening market cap, in USD", defaultValue: DEFAULT_CAP_USD_TEXT };
  }
  return { mode: "quote", message: `Opening market cap, in ${quoteSymbol}`, defaultValue: undefined };
}

async function interactive(env: LaunchEnv, input: LaunchInputs, out: Output): Promise<void> {
  const nativeSymbol = env.nativeSymbol;
  const listed = (env.ctx.deployment?.tokens ?? []).filter((t) => !t.isTestToken || !env.ctx.deployment?.isMainnet);
  let quoteSymbol = nativeSymbol;
  let quoteIsNative = true;

  const steps: Step<LaunchInputs>[] = [
    {
      title: "Token",
      run: async (s) => {
        const name = await askText({ message: "Token name", defaultValue: s.name || undefined, validate: (v) => (v.trim() === "" ? "required" : undefined) });
        if (name === BACK) return BACK;
        const symbol = await askText({ message: "Symbol", defaultValue: s.symbol || undefined, back: true, validate: (v) => (v.trim() === "" ? "required" : undefined) });
        if (symbol === BACK) return BACK;
        s.name = name;
        s.symbol = symbol;
        return undefined;
      },
    },
    {
      title: "Supply",
      run: async (s) => {
        /* A release 2 kit mints one fixed supply: nothing to ask. */
        if (env.limits.rules !== undefined && env.limits.rules !== null) return undefined;
        const supply = await askText({
          message: "Total supply (whole tokens)",
          defaultValue: s.supply,
          back: true,
          validate: (v) => (/^\d[\d_,]*$/.test(v) && BigInt(v.replace(/[_,]/g, "")) > 0n ? undefined : "a whole number above 0"),
        });
        if (supply === BACK) return BACK;
        const seed = await askText({ message: "Percent seeded into the locked pool", defaultValue: s.seedPercent, back: true, validate: (v) => (/^(100|\d{1,2})(\.\d{1,2})?$/.test(v) && Number(v) > 0 ? undefined : "0 < percent <= 100") });
        if (seed === BACK) return BACK;
        s.supply = supply.replace(/[_,]/g, "");
        s.seedPercent = seed;
        if (Number(seed) < 100) {
          const to = await askText({ message: "Who receives the rest (address)", defaultValue: s.allocationTo || undefined, back: true, validate: (v) => (isAddress(v) ? undefined : "an address") });
          if (to === BACK) return BACK;
          s.allocationTo = to;
        }
        return undefined;
      },
    },
    {
      title: "Quote",
      run: async (s) => {
        const choice = await askSelect<string>({
          message: "What does the pool trade against?",
          options: [
            { value: "native", label: nativeSymbol, hint: "the chain's native currency" },
            ...listed.map((t) => ({ value: t.address as string, label: t.symbol, hint: t.name })),
          ],
          initial: s.quote,
          back: true,
        });
        if (choice === BACK) return BACK;
        s.quote = choice;
        const q = await quoteMetaOf(env.ctx, choice, nativeSymbol, env.ctx.deployment?.nativeCurrency.decimals ?? 18);
        quoteSymbol = q.symbol;
        quoteIsNative = q.isNative;
        return undefined;
      },
    },
    {
      title: "Opening market cap",
      run: async (s) => {
        const cp = capPrompt(env, quoteSymbol, quoteIsNative);
        if (cp.mode === "usd" && env.usd !== null && env.usd.ok) {
          out.line(ui.muted(`  USD from ${env.usd.provenance.label}`));
        } else if (env.usd !== null && !env.usd.ok) {
          out.line(ui.muted(`  No USD price: ${env.usd.detail}`));
        }
        const v = await askText({
          message: cp.message,
          defaultValue: s.capMode === cp.mode && s.capValue !== "" ? s.capValue : cp.defaultValue,
          back: true,
          validate: (x) => (/^\$?\d[\d,]*(\.\d+)?$/.test(x) && Number(x.replace(/[$,]/g, "")) > 0 ? undefined : "a positive number"),
        });
        if (v === BACK) return BACK;
        s.capMode = cp.mode;
        s.capValue = v.replace(/[$,]/g, "");
        return undefined;
      },
    },
    {
      title: "Launch protection",
      run: async (s) => {
        const choice = await askSelect<PresetName>({
          message: "Protection at the open",
          options: PRESET_NAMES.filter((n) => n !== "Custom").map((n) => {
            const pp = PRESET_PARAMS[n as Exclude<PresetName, "Custom">];
            return {
              value: n,
              label: n,
              hint: pp.enabled ? `${pipsPercent(pp.initialFeeBips)} -> ${pipsPercent(pp.finalFeeBips)} over ${humanSeconds(pp.windowSeconds)}` : `flat ${pipsPercent(pp.finalFeeBips)}`,
            };
          }),
          initial: s.protection,
          back: true,
        });
        if (choice === BACK) return BACK;
        s.protection = choice;
        const pp = PRESET_PARAMS[choice as Exclude<PresetName, "Custom">];
        out.line(ui.muted(`  Does not protect against ${pp.doesNotProtectAgainst}`));
        if (pp.requiresMaxBuyPerTx) {
          const mb = await askText({ message: `Largest buy per transaction during protection (${quoteSymbol})`, defaultValue: s.maxBuy === "0" ? undefined : s.maxBuy, back: true, validate: (x) => (Number(x) > 0 ? undefined : "required by this preset") });
          if (mb === BACK) return BACK;
          s.maxBuy = mb;
        }
        return undefined;
      },
    },
    {
      title: "Creator tax",
      run: async (s) => {
        const max = bpsPercent(env.limits.tax.maxTaxBps);
        const buy = await askText({ message: `Tax on buys, percent (0 for none, max ${max})`, defaultValue: s.taxBuy, back: true });
        if (buy === BACK) return BACK;
        const sell = await askText({ message: `Tax on sells, percent (max ${max})`, defaultValue: s.taxSell, back: true });
        if (sell === BACK) return BACK;
        s.taxBuy = buy;
        s.taxSell = sell;
        if (Number(buy) > 0 || Number(sell) > 0) {
          const days = await askText({ message: env.limits.tax.maxTaxDurationSeconds === null ? "Days the tax lasts after trading opens, or forever" : `Days the tax lasts after trading opens (max ${Math.floor(env.limits.tax.maxTaxDurationSeconds / 86_400)})`, defaultValue: s.taxDays, back: true });
          if (days === BACK) return BACK;
          s.taxDays = days;
        }
        return undefined;
      },
    },
    {
      title: "Listing",
      run: async (s) => {
        const d = await askText({ message: "Description (optional)", defaultValue: s.description, placeholder: "skip", back: true });
        if (d === BACK) return BACK;
        const w = await askText({ message: "Website (optional)", defaultValue: s.website, placeholder: "skip", back: true });
        if (w === BACK) return BACK;
        const x = await askText({ message: "X handle, without @ (optional)", defaultValue: s.x, placeholder: "skip", back: true });
        if (x === BACK) return BACK;
        const t = await askText({ message: "Telegram handle, without @ (optional)", defaultValue: s.telegram, placeholder: "skip", back: true });
        if (t === BACK) return BACK;
        s.description = d;
        s.website = w;
        s.x = x;
        s.telegram = t;
        return undefined;
      },
    },
  ];
  await runSteps(steps, input);
}

/* ------------------------------------------------------------------- run */

function inputsFromFlags(cmd: ReturnType<typeof parseCommand>): LaunchInputs {
  const i = defaults();
  const s = (k: string): string | undefined => cmd.str(k);
  const set = <K extends keyof LaunchInputs>(key: K, flag: string): void => {
    const v = s(flag);
    if (v !== undefined) (i as unknown as Record<string, string>)[key] = v;
  };
  set("name", "name");
  set("symbol", "symbol");
  set("supply", "supply");
  set("seedPercent", "seed-percent");
  set("allocationTo", "allocation-to");
  set("quote", "quote");
  set("tickSpacing", "tick-spacing");
  set("width", "width");
  set("binStep", "bin-step");
  set("binCount", "bin-count");
  set("startDelay", "start-delay");
  set("maxBuy", "max-buy");
  set("taxBuy", "tax-buy");
  set("taxSell", "tax-sell");
  set("taxDays", "tax-days");
  set("taxProtocol", "tax-protocol");
  set("lpProtocol", "lp-protocol");
  set("creator", "creator");
  set("description", "description");
  set("website", "website");
  set("x", "x");
  set("telegram", "telegram");
  set("metadataURI", "metadata-uri");
  const pool = s("pool");
  if (pool !== undefined) {
    const p = pool.trim().toLowerCase();
    if (p !== "cl" && p !== "bin") throw new UserError(`--pool must be CL or Bin, received ${pool}`);
    i.pool = p === "cl" ? "CL" : "Bin";
  }
  const shape = s("shape");
  if (shape !== undefined) i.shape = shapeOf(shape);
  const prot = s("protection");
  if (prot !== undefined) i.protection = presetOf(prot);
  const usd = s("market-cap-usd");
  const q = s("market-cap");
  if (usd !== undefined && q !== undefined) throw new UserError("--market-cap-usd and --market-cap are exclusive");
  if (usd !== undefined) {
    i.capMode = "usd";
    i.capValue = usd.replace(/[$,]/g, "");
  } else if (q !== undefined) {
    i.capMode = "quote";
    i.capValue = q;
  }
  return i;
}

export async function runLaunch(argv: readonly string[]): Promise<number> {
  const cmd = parseCommand(argv, LAUNCH_SPEC);
  const out = cmd.out;
  if (cmd.help) {
    out.line(helpText(LAUNCH_SPEC));
    return 0;
  }
  const yes = cmd.bool("yes");
  const prompting = !yes && !out.json && canPrompt();

  const ctx = resolveChain({ chain: cmd.str("chain"), rpc: cmd.str("rpc"), deployment: cmd.str("deployment") });
  const deployment = ctx.deployment;
  const kitFlag = cmd.str("kit");
  const kit = kitFlag !== undefined ? getAddress(kitFlag) : requireFeature(ctx, "Launches", deployment?.launchpadV2.launchpadKitV2);
  requireDeployment(ctx);
  assertMayWrite(ctx, yes);
  if (prompting) intro(`Gully Core · launch on ${ctx.name}`);
  if (ctx.overrideSource !== null) out.line(ui.muted(`addresses: from ${ctx.overrideSource}`));
  await assertLiveChain(ctx);

  const mode = signModeOf(cmd.args);
  const signer = await resolveSigner(mode, cmd.str("from"), (a) => isAddress(a));
  const saltFlag = cmd.str("salt");
  if (saltFlag !== undefined && !/^0x[0-9a-fA-F]{64}$/.test(saltFlag)) throw new UserError("--salt must be 32 bytes of hex");
  const salt = (saltFlag ?? toHex(randomBytes(32))) as Hex;

  const input = inputsFromFlags(cmd);
  /* A gas-only chain (Anubis) has no native pools: the default quote is the chain's own ERC-20. */
  if (deployment?.nativeValueTransfers === false && deployment.quoteToken !== undefined && cmd.str("quote") === undefined) input.quote = deployment.quoteToken;
  if (isNativeQuote(input.quote)) assertNativeValue(ctx);
  const tenantFlag = cmd.str("launchpad");
  const tenant = tenantFlag === undefined ? null : optionalAddress(tenantFlag, "--launchpad");
  const nativeSymbol = deployment?.nativeCurrency.symbol ?? ctx.chain.nativeCurrency.symbol;

  const quoteForLimits = input.quote.trim().toLowerCase() === "native" ? ZERO : optionalAddress(input.quote, "--quote") ?? ZERO;
  const limits = await readKitV2Limits(ctx.client, kit, { tenant, candidateQuotes: [ZERO, quoteForLimits] });
  const usd = cmd.bool("no-usd") ? null : await resolveNativeUsd({ client: ctx.client, chainId: ctx.chainId });

  const env: LaunchEnv = { ctx, kit, tenant, limits, nativeSymbol, usd, launcher: signer.address, salt };

  if (prompting) {
    await interactive(env, input, out);
  } else {
    if (input.name === "" || input.symbol === "") throw new UserError("--name and --symbol are required without a terminal (or with --yes)");
    if (input.capValue === "") {
      /* `usd` is already null under --no-usd, so the default cannot apply there. */
      const fallback = scriptedDefaultCap(usd, input.quote);
      if (fallback !== null) {
        input.capMode = fallback.mode;
        input.capValue = fallback.value;
      } else if (usd !== null && usd.ok) {
        throw new UserError("--market-cap <amount in quote units> is required: the USD default applies only to a pool quoted in the native currency");
      } else {
        throw new UserError("--market-cap <amount in quote units> is required: this chain has no live USD price", usd !== null && !usd.ok ? usd.detail : undefined);
      }
    }
  }

  let plan: LaunchPlan;
  for (;;) {
    try {
      plan = await planLaunch(env, input);
      break;
    } catch (e) {
      /* In the stepper a refused value sends the user back through the steps, answers kept; a script
         gets the error. */
      if (!(prompting && e instanceof UserError)) throw e;
      out.warn(`${e.message}${e.hint !== undefined ? ` (${e.hint})` : ""}`);
      await interactive(env, input, out);
    }
  }
  printReview(out, env, plan);

  const errors = plan.built.issues.filter((i) => i.severity === "error");
  const tx: PreparedTx = { chainId: ctx.chainId, from: signer.address, to: kit, data: plan.built.data, value: plan.built.value };
  const abis = [LAUNCHPAD_KIT_V2_REVERT_ABI as unknown as Abi, LAUNCHPAD_KIT_V2_ABI as unknown as Abi];
  const sim = errors.length > 0 ? ({ ok: false, error: errors.map((e) => `${e.field}: ${e.message}`).join("; ") } as const) : await simulate(ctx, tx, abis);

  const resultBody = (extra: Record<string, unknown>): Record<string, unknown> => ({
    chainId: ctx.chainId,
    mode: mode.kind,
    tx,
    simulation: sim,
    result: {
      token: plan.built.token,
      name: plan.built.params.name,
      symbol: plan.built.params.symbol,
      totalSupply: plan.totalSupply,
      seedSupply: plan.seedSupply,
      quote: plan.quote,
      openingPrice: { requested: plan.requestedPrice, snapped: plan.snappedPrice, unit: `raw ${plan.quote.symbol} per whole token`, decimals: plan.quote.decimals },
      openingMarketCap: { quote: plan.snappedCapQuote, usd: plan.snappedCapUsd },
      usdSource: usd === null ? null : usd.ok ? usd.provenance.label : null,
      legs: plan.built.legs.map((l) => ({ kind: l.kind, poolId: l.key.poolId, openingPrice: l.openingPrice, snapFraction: l.snapFraction })),
      fees: {
        protocolLaunchFeeWei: limits.value.launchFeeWei,
        launchpadLaunchFeeWei: limits.value.integratorFeeWei,
        valueWei: plan.built.value,
        tax: plan.built.params.tax,
        lp: { creatorBps: plan.built.params.creatorBps, protocolBps: plan.built.params.protocolBps, launchpadBps: plan.built.params.integratorBps },
      },
      issues: plan.built.issues,
      salt,
      ...extra,
    },
  });

  out.line("");
  if (!sim.ok) {
    out.line(`${ui.bold("✕ Simulation failed")}: ${sim.error}`);
    out.result("launch", resultBody({ hash: null, receipt: null }));
    if (out.json) return EXIT.SIMULATION;
    throw new UserError("the launch would revert; nothing was sent", undefined, EXIT.SIMULATION);
  }
  out.line(`${ui.success("✓")} Simulated: the exact transaction succeeds from ${signer.address}`);

  if (!canSend(signer)) {
    renderTx(out, ctx, tx, nativeSymbol);
    out.result("launch", resultBody({ hash: null, receipt: null }));
    if (prompting) outro("Nothing was signed.");
    return 0;
  }

  if (!yes) {
    if (!prompting) throw new UserError("sending needs --yes when there is no terminal to confirm in", undefined, EXIT.REFUSED);
    const ok = await askTypedConfirmation(`${mainnetPrefix(ctx)}This creates the token and locks its liquidity forever.`, plan.built.params.symbol);
    if (!ok) {
      outro("Stopped. Nothing was sent.");
      return EXIT.CANCELLED;
    }
  }
  const sent = await send(ctx, signer, tx);
  const events = parseEventLogs({ abi: LAUNCHPAD_KIT_V2_ABI, logs: sent.receipt.logs }).map((l) => l.eventName);
  let readBack: Record<string, unknown> | null = null;
  if (sent.receipt.status === "success") {
    const [nm, sym, ts] = await Promise.all([
      ctx.client.readContract({ address: plan.built.token, abi: erc20Abi, functionName: "name" }),
      ctx.client.readContract({ address: plan.built.token, abi: erc20Abi, functionName: "symbol" }),
      ctx.client.readContract({ address: plan.built.token, abi: erc20Abi, functionName: "totalSupply" }),
    ]);
    readBack = { name: nm, symbol: sym, totalSupply: ts };
  }
  out.line(`${sent.receipt.status === "success" ? ui.success("✓ Launched") : ui.bold("✕ Reverted")} in block ${sent.receipt.blockNumber}`);
  out.rows([
    ["tx", sent.hash],
    ["token", plan.built.token],
    ["gas used", sent.receipt.gasUsed.toString()],
    ["events", events.join(", ")],
  ]);
  out.result("launch", resultBody({ hash: sent.hash, receipt: receiptJson(sent.receipt), events, readBack }));
  if (prompting) outro(sent.receipt.status === "success" ? "Done." : "The transaction reverted.");
  return sent.receipt.status === "success" ? 0 : EXIT.SIMULATION;
}
