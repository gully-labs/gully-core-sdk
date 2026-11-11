// SPDX-License-Identifier: MIT
/**
 * The locked-launch wizard: one `LaunchpadKitV2.createLaunch` call, built here.
 *
 * What the user decides: the token (name, symbol, supply), how much of the
 * supply goes into pools and how the rest is allocated, the split of LP fees
 * between the creator and the protocol (this app's integrator share is fixed
 * by the tenant config or `gullycore.config.ts`, and shown), the launch-fee
 * schedule, and one to `maxLegs()` legs — each a quote currency, a share of
 * the seeded supply, an opening price, and either a single-sided CL range or a
 * shaped Bin distribution.
 *
 * What this screen refuses to do:
 *
 *   * **Guess a limit.** Leg count, bins per leg, the fee ceilings, the decay
 *     window, the split bounds and the launch fees are all read off the
 *     deployed contracts every time the screen loads.
 *   * **Send what it has not simulated.** The SDK validates the built argument
 *     first and names the contract error each objection maps to; the exact
 *     bytes are then simulated with `eth_call`; only then is Create enabled.
 *   * **Make the creator type a price.** Every launch opens at a known MARKET
 *     CAP (2026-09-20): the cap field comes first, defaulting to the
 *     config's `launch.defaultOpeningMarketCapUsd` ($3,500 unless the tenant
 *     changed it), and the opening price is derived from it through the
 *     chain's native/USD feed, read on chain, with its source and age stated.
 *     Where the chain has no dollar source the cap is typed in the quote
 *     currency and no dollar figure appears. Either field may be edited; the
 *     other follows (`lib/marketCap.ts`, exact integers, no floating point).
 *   * **Show the typed price.** A CL leg's price is snapped onto its range
 *     edge and a Bin leg's onto a bin; both are shown after the snap, with the
 *     size of the move and the cap they imply, because the snapped price is
 *     the one the pool is born at and there is no undo.
 *   * **Lose the form.** What was typed is kept as a draft in this browser
 *     (`lib/useDraft.ts`), never what the chain answered, and deleted the
 *     moment the launch confirms.
 *   * **Take anything of its own.** `msg.value` is the two launch fees the kit
 *     charges — the protocol's and the integrator's, both read from chain, the
 *     surplus refunded — and this screen adds nothing to it.
 */

import {
  BIN_SHAPE_NAMES,
  KIT_V2_BPS,
  PRESET,
  PRESET_NAMES,
  PRESET_PARAMS,
  kitV2LegSupplies,
  launchSplitBounds,
  type BinShapeName,
} from "@gullylabs/core-sdk";
import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { Link } from "react-router-dom";
import { formatEther, getAddress, isAddress, parseUnits, type Address, type Hex } from "viem";
import { useAccount, usePublicClient, useWalletClient } from "wagmi";

import { Async, NotConfigured } from "../components/States";
import { VestAllocation } from "../components/VestAllocation";
import { resolveConfig } from "../config/resolve";
import { explorerAddressUrl, explorerTxUrl, publicClient } from "../lib/client";
import { ExplorerLink } from "../components/ExplorerLink";
import {
  LAUNCH_TOKEN_DECIMALS,
  buildCreateLaunchV2,
  type CreateLaunchV2Call,
  type LaunchDraftV2,
  type LegDraftV2,
} from "../lib/createLaunchV2";
import { draftKey, sameShape } from "../lib/draft";
import { formatBps, formatPips, formatUnits, shortAddress } from "../lib/format";
import { formatDuration } from "../lib/launches";
import { NATIVE_ADDRESS, readKitV2Bounds } from "../lib/launchesV2";
import { kitFeeWords, lpShareOfPools } from "../lib/launchWords";
import { capFromPrice, capUnitKey, defaultCapPatch, formatCap, reconcileCapLegs, type CapContext, type CapUnit, type LegCapUnit } from "../lib/marketCap";
import { readTokenMeta } from "../lib/tokens";
import { usdNote, usdQuoteOf, useNativeUsd } from "../lib/usd";
import { useDraft } from "../lib/useDraft";
import { isFactorySplit } from "../lib/utilities";
import { readSplit } from "@gullylabs/core-sdk/split";
import { useAsync, type AsyncState } from "../lib/useAsync";
import type { NativeUsdResult } from "@gullylabs/core-sdk";

const CUSTOM_QUOTE = "custom";

interface LegForm {
  kind: "CL" | "Bin";
  /** `native`, a configured token address, or `custom`. */
  quoteChoice: string;
  customQuote: string;
  customQuoteDecimals: string;
  weightBps: string;
  /** Whole quote per whole token, as typed or as derived from the cap. */
  price: string;
  /** The opening market cap, in dollars where the quote is priced, else in the quote currency. */
  marketCap: string;
  /** Which of `marketCap` / `price` the creator last edited; the other is derived. */
  capPrimary: boolean;
  /** What the two numbers were last reconciled in (`capUnitKey`); "" before the first time. */
  capUnitKey: string;
  /** Human quote units; "0" means uncapped. */
  maxBuyPerTx: string;
  tickSpacing: string;
  widthInSpacings: string;
  binStep: string;
  shape: BinShapeName;
  binCount: string;
}

interface FormState {
  name: string;
  symbol: string;
  metadataURI: string;
  /** Whole tokens. */
  totalSupply: string;
  /** Percent of `totalSupply` seeded into pools. */
  seedPercent: string;
  allocationRecipient: string;
  protocolBps: string;
  preset: number;
  initialFeeBips: string;
  finalFeeBips: string;
  decaySeconds: string;
  startDelaySeconds: string;
  legs: LegForm[];
  description: string;
  websiteURI: string;
  /** Bare handles, no "@" and no URL — the registry refuses anything else (`InvalidHandle`). */
  xHandle: string;
  telegramHandle: string;
  /** Who receives the creator share: the connected wallet, or a Team split. */
  creatorMode: "wallet" | "split";
  creatorSplit: string;
}

type SplitCheck = { status: "checking" } | { status: "yes"; name: string } | { status: "no" } | { status: "error"; message: string };

function emptyLeg(): LegForm {
  return {
    kind: "CL",
    quoteChoice: "native",
    customQuote: "",
    customQuoteDecimals: "18",
    weightBps: String(KIT_V2_BPS),
    price: "",
    marketCap: "",
    capPrimary: true,
    capUnitKey: "",
    maxBuyPerTx: "0",
    tickSpacing: "60",
    widthInSpacings: "200",
    binStep: "100",
    shape: "Linear",
    binCount: "10",
  };
}

function initialForm(defaultProtocolBps: number): FormState {
  return {
    name: "",
    symbol: "",
    metadataURI: "",
    totalSupply: "1000000000",
    seedPercent: "100",
    allocationRecipient: "",
    protocolBps: String(defaultProtocolBps),
    /* The default schedule (2026-09-28): FairLaunch's opening (10% over five minutes),
       then a 1% pool fee on every trade, forever. The named presets are fixed ON CHAIN
       (LaunchPresets.sol) and FairLaunch ends at 0.30%, so a 1% final fee is only reachable
       as Custom. A tenant that forbids Custom must pick one of its allowed presets instead. */
    preset: PRESET.Custom,
    initialFeeBips: String(PRESET_PARAMS.FairLaunch.initialFeeBips),
    finalFeeBips: "10000",
    decaySeconds: String(PRESET_PARAMS.FairLaunch.windowSeconds),
    startDelaySeconds: "0",
    legs: [emptyLeg()],
    description: "",
    websiteURI: "",
    xHandle: "",
    telegramHandle: "",
    creatorMode: "wallet",
    creatorSplit: "",
  };
}

function randomSalt(): Hex {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

type Phase =
  | { kind: "idle" }
  | { kind: "simulating" }
  | { kind: "simulated"; call: CreateLaunchV2Call }
  | { kind: "sending" }
  | { kind: "sent"; hash: Hex; token: Address; call: CreateLaunchV2Call }
  | { kind: "confirmed"; hash: Hex; token: Address; call: CreateLaunchV2Call }
  | { kind: "reverted"; hash: Hex; token: Address }
  | { kind: "failed"; message: string };

/** The one sentence that explains an absent dollar figure on a leg, or `null` when there is one. */
function noUsdReason(read: AsyncState<NativeUsdResult>, quoteIsNative: boolean, quoteSymbol: string): string | null {
  if (!quoteIsNative) return `This pool is quoted in ${quoteSymbol}, which this app has no price source for, so the market cap is in ${quoteSymbol} and no dollar figure is shown.`;
  if (read.status === "loading") return "Reading a native/USD source…";
  if (read.status === "error") return `A native/USD source could not be read (${read.error.message}), so the market cap is in ${quoteSymbol} and no dollar figure is shown.`;
  const q = usdQuoteOf(read);
  return q === null ? `${read.data.ok ? "" : read.data.detail} The market cap is in ${quoteSymbol}.`.trim() : null;
}

/** The quick choices beside the cap field, dollars only; the config's default is among them and marked. */
function capChips(defaultUsd: number): readonly { readonly text: string; readonly label: string; readonly isDefault: boolean }[] {
  const base = [1000, 3500, 10000, 50000];
  const values = [...new Set([...base, defaultUsd])].sort((a, b) => a - b);
  const label = (v: number): string => (v >= 1000 ? `$${(v / 1000).toString().replace(/\.0$/, "")}K` : `$${v}`);
  return values.map((v) => ({ text: String(v), label: label(v), isDefault: v === defaultUsd }));
}

/** A draft read back: the keys of a fresh form, each leg the keys of a fresh leg. */
function acceptDraft(raw: Record<string, unknown>, fresh: FormState): Partial<FormState> {
  const out = sameShape(fresh, raw);
  if (Array.isArray(out.legs)) {
    const legs = (out.legs as unknown[])
      .filter((l): l is Record<string, unknown> => typeof l === "object" && l !== null)
      .map((l) => ({ ...emptyLeg(), ...sameShape(emptyLeg(), l) }));
    return { ...out, legs: legs.length === 0 ? fresh.legs : legs };
  }
  return out;
}

/** A percentage string to a bigint share of `total`, exact to two decimal places. */
function percentOf(total: bigint, percent: string): bigint | null {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(percent.trim());
  if (m === null) return null;
  const hundredths = BigInt(m[1] ?? "0") * 100n + BigInt((m[2] ?? "").padEnd(2, "0"));
  if (hundredths > 10_000n) return null;
  return (total * hundredths) / 10_000n;
}

export function LaunchWizardV2(): ReactElement {
  const cfg = resolveConfig();
  const { address } = useAccount();
  const { data: walletClient } = useWalletClient();
  const wagmiClient = usePublicClient();

  const bounds = useAsync(() => readKitV2Bounds(), [cfg.launchpadKitV2, cfg.launchTenant]);
  const [form, setForm] = useState<FormState>(() => initialForm(cfg.launch.defaultProtocolBps));
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  /* The chain's native/USD rate, with provenance, read once: it decides whether a cap is in dollars. */
  const usdRead = useNativeUsd();
  /* What was typed, kept in this browser per chain and wallet; the chain's answers are never stored. */
  const draft = useDraft<FormState>(
    cfg.launchpadKitV2 === null ? null : draftKey("launch", cfg.core.chainId, address ?? null),
    form,
    (raw) => acceptDraft(raw, initialForm(cfg.launch.defaultProtocolBps)),
    phase.kind !== "confirmed" && phase.kind !== "sent",
  );
  const [userSalt] = useState<Hex>(() => randomSalt());
  /** Decimals of custom quotes, read off their contracts, keyed by lowercase address. */
  const [quoteDecimals, setQuoteDecimals] = useState<Record<string, number | "unreadable">>({});
  const [preview, setPreview] = useState<{ call: CreateLaunchV2Call | null; error: string | null }>({ call: null, error: null });
  /** `isSplit` answers from the configured split factory, keyed by lowercase address. */
  const [splitChecks, setSplitChecks] = useState<Record<string, SplitCheck>>({});

  /* A split named as creator must be one the configured factory made: the
     creator share is then claimable only by the split, and pays its payees. */
  useEffect(() => {
    if (form.creatorMode !== "split" || !isAddress(form.creatorSplit)) return;
    const key = form.creatorSplit.toLowerCase();
    if (splitChecks[key] !== undefined) return;
    const split = getAddress(form.creatorSplit);
    setSplitChecks((c) => ({ ...c, [key]: { status: "checking" } }));
    void isFactorySplit(split)
      .then(async (yes) => {
        if (!yes) return { status: "no" } as const;
        const info = await readSplit(publicClient(), split);
        return { status: "yes", name: info.name } as const;
      })
      .then(
        (r: SplitCheck) => setSplitChecks((c) => ({ ...c, [key]: r })),
        (err: unknown) => setSplitChecks((c) => ({ ...c, [key]: { status: "error", message: err instanceof Error ? err.message : String(err) } })),
      );
  }, [form.creatorMode, form.creatorSplit, splitChecks]);

  if (cfg.launchpadKitV2 === null) {
    return (
      <div className="page page-narrow">
        <header className="page-head">
          <h1>New locked launch</h1>
        </header>
        <NotConfigured
          what="The locked launchpad"
          field="chain.launchpadKitV2"
          detail={
            cfg.launchpadKit === null ? undefined : (
              <>
                A v1 <code>LaunchpadKit</code> is configured; its unlocked launches are at{" "}
                <Link to="/launch/v1/new">/launch/v1/new</Link>.
              </>
            )
          }
        />
      </div>
    );
  }
  const kit = cfg.launchpadKitV2;

  function set<K extends keyof FormState>(key: K, value: FormState[K]): void {
    setForm((current) => ({ ...current, [key]: value }));
    setPhase({ kind: "idle" });
  }
  function setLeg(index: number, patch: Partial<LegForm>): void {
    setForm((current) => {
      const legs = current.legs.map((leg, i) => (i === index ? { ...leg, ...patch } : leg));
      /* Settle the cap/price link inside the keystroke's own update, so the effect below finds nothing to write. */
      return { ...current, legs: [...reconcileCapLegs(legs, legUnitsRef.current, capContextOf(current.totalSupply), String(cfg.launch.defaultOpeningMarketCapUsd))] };
    });
    setPhase({ kind: "idle" });
  }
  const setLegCap = (index: number, v: string): void => setLeg(index, { marketCap: v.replace(/[$,\s]/g, ""), capPrimary: true });
  const setLegPrice = (index: number, v: string): void => setLeg(index, { price: v, capPrimary: false });

  const quoteOptions = useMemo(
    () => [
      { value: "native", label: `${cfg.nativeCurrency.symbol} (native)`, address: NATIVE_ADDRESS, decimals: cfg.nativeCurrency.decimals },
      ...cfg.tokens.map((t) => ({ value: t.address.toLowerCase(), label: `${t.symbol} · ${shortAddress(t.address)}`, address: t.address, decimals: t.decimals })),
    ],
    [cfg],
  );

  /* Custom quote decimals are read from the token, never typed: a wrong decimal
     count misprices the pool by a power of ten, permanently. */
  useEffect(() => {
    for (const leg of form.legs) {
      if (leg.quoteChoice !== CUSTOM_QUOTE || !isAddress(leg.customQuote)) continue;
      const key = leg.customQuote.toLowerCase();
      if (quoteDecimals[key] !== undefined) continue;
      void readTokenMeta(getAddress(leg.customQuote)).then((meta) => {
        setQuoteDecimals((d) => ({ ...d, [key]: meta === null ? "unreadable" : meta.decimals }));
      });
    }
  }, [form.legs, quoteDecimals]);

  function resolveQuote(leg: LegForm): { address: Address; decimals: number } | { error: string } {
    if (leg.quoteChoice === CUSTOM_QUOTE) {
      if (!isAddress(leg.customQuote)) return { error: "The custom quote is not a valid address." };
      const d = quoteDecimals[leg.customQuote.toLowerCase()];
      if (d === undefined) return { error: "Reading the custom quote's decimals…" };
      if (d === "unreadable") return { error: `${leg.customQuote} does not answer decimals(); it is not an ERC-20 this app can quote in.` };
      return { address: getAddress(leg.customQuote), decimals: d };
    }
    const opt = quoteOptions.find((o) => o.value === leg.quoteChoice);
    if (opt === undefined) return { error: "Pick a quote currency." };
    return { address: opt.address, decimals: opt.decimals };
  }

  /** Everything a cap conversion needs about the token: the raw total supply. Zero while the supply is not a number. */
  function capContextOf(totalSupply: string): CapContext {
    let raw = 0n;
    try {
      raw = parseUnits(totalSupply.trim() || "0", LAUNCH_TOKEN_DECIMALS);
    } catch {
      raw = 0n;
    }
    return { totalSupply: raw, tokenDecimals: LAUNCH_TOKEN_DECIMALS };
  }

  /**
   * What each leg's cap is denominated in RIGHT NOW: dollars only for a natively
   * quoted leg whose native/USD read answered; the quote currency otherwise;
   * `pending` while that read is in flight (nothing is derived or seeded then);
   * `null` while the leg's quote itself is unresolved.
   */
  const legUnits: readonly (LegCapUnit | null)[] = form.legs.map((leg) => {
    const quote = resolveQuote(leg);
    if ("error" in quote) return null;
    const quoteIsNative = quote.address === NATIVE_ADDRESS;
    if (quoteIsNative && usdRead.status === "loading") return { pending: true };
    const q = quoteIsNative ? usdQuoteOf(usdRead) : null;
    const symbol = quoteIsNative ? cfg.nativeCurrency.symbol : (quoteOptions.find((o) => o.value === leg.quoteChoice)?.label.split(" ")[0] ?? shortAddress(quote.address));
    const unit: CapUnit = q !== null ? { k: "usd", rate: { answer: q.answer, answerDecimals: q.answerDecimals }, quoteDecimals: quote.decimals } : { k: "quote", symbol, quoteDecimals: quote.decimals };
    return { pending: false, unit, key: capUnitKey(unit, quote.address) };
  });
  const legUnitsRef = useRef<readonly (LegCapUnit | null)[]>(legUnits);
  legUnitsRef.current = legUnits;
  const unitsKey = legUnits.map((u) => (u === null ? "-" : u.pending ? "?" : u.key)).join("|");

  /* The cap/price link, kept in agreement when the unit or the supply moves
     (a rate lands, the quote changes, the supply is retyped). The first leg
     with neither number yet gets the configured default cap, in dollars only. */
  useEffect(() => {
    setForm((current) => {
      const ctx = capContextOf(current.totalSupply);
      let legs = reconcileCapLegs(current.legs, legUnitsRef.current, ctx, String(cfg.launch.defaultOpeningMarketCapUsd));
      const first = legs[0];
      const u0 = legUnitsRef.current[0];
      if (first !== undefined && u0 !== null && u0 !== undefined && ctx.totalSupply > 0n) {
        const seed = defaultCapPatch(first, u0, String(cfg.launch.defaultOpeningMarketCapUsd));
        if (seed !== null) legs = reconcileCapLegs(legs.map((l, i) => (i === 0 ? { ...l, ...seed } : l)), legUnitsRef.current, ctx, String(cfg.launch.defaultOpeningMarketCapUsd));
      }
      return legs === current.legs ? current : { ...current, legs: [...legs] };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unitsKey, form.totalSupply]);

  /* A restored draft keeps what was typed; its caps and prices are reconciled against today's rate by the effect above. */
  function restoreDraft(): void {
    const found = draft.restore();
    if (found !== null) setForm((current) => ({ ...current, ...found }));
    setPhase({ kind: "idle" });
  }

  function draftFrom(): LaunchDraftV2 | { error: string } {
    if (address === undefined) return { error: "Connect a wallet first: the token's address depends on who sends the launch." };
    let totalSupply: bigint;
    try {
      totalSupply = parseUnits(form.totalSupply.trim() || "0", LAUNCH_TOKEN_DECIMALS);
    } catch {
      return { error: "Total supply must be a decimal number of whole tokens." };
    }
    const seedSupply = percentOf(totalSupply, form.seedPercent);
    if (seedSupply === null) return { error: "The seeded share must be a percentage between 0 and 100 with at most two decimals." };
    const allocation = form.allocationRecipient.trim();
    if (seedSupply < totalSupply && !isAddress(allocation)) {
      return { error: "Part of the supply is not seeded, so the allocation recipient must be a valid address." };
    }
    const legs: LegDraftV2[] = [];
    for (const [i, leg] of form.legs.entries()) {
      const quote = resolveQuote(leg);
      if ("error" in quote) return { error: `Leg ${i + 1}: ${quote.error}` };
      if (leg.price.trim() === "") return { error: `Leg ${i + 1}: set an opening market cap (or a price, in quote tokens per launch token).` };
      if (form.name.trim() === "" || form.symbol.trim() === "") return { error: "Give the token a name and a symbol." };
      let maxBuy: bigint;
      try {
        maxBuy = parseUnits(leg.maxBuyPerTx.trim() || "0", quote.decimals);
      } catch {
        return { error: `Leg ${i + 1}: the max buy must be a decimal amount of the quote currency.` };
      }
      legs.push({
        kind: leg.kind,
        quote: quote.address,
        quoteDecimals: quote.decimals,
        weightBps: Number(leg.weightBps),
        quotePerLaunchToken: leg.price.trim(),
        maxBuyPerTx: maxBuy,
        tickSpacing: Number(leg.tickSpacing),
        widthInSpacings: Number(leg.widthInSpacings),
        binStep: Number(leg.binStep),
        shape: leg.shape,
        binCount: Number(leg.binCount),
      });
    }
    let creator: Address = address;
    if (form.creatorMode === "split") {
      if (!isAddress(form.creatorSplit)) return { error: "The creator split is not a valid address." };
      const check = splitChecks[form.creatorSplit.toLowerCase()];
      if (check === undefined || check.status === "checking") return { error: "Checking the creator split against the split factory…" };
      if (check.status === "no") return { error: `${form.creatorSplit} is not a split made by the configured GullyCoreSplitFactory.` };
      if (check.status === "error") return { error: `The creator split could not be checked: ${check.message}` };
      creator = getAddress(form.creatorSplit);
    }
    return {
      name: form.name.trim(),
      symbol: form.symbol.trim(),
      metadataURI: form.metadataURI.trim(),
      totalSupply,
      seedSupply,
      allocationRecipient: isAddress(allocation) ? getAddress(allocation) : NATIVE_ADDRESS,
      creator,
      operator: address,
      steward: address,
      protocolBps: Number(form.protocolBps),
      schedule: {
        preset: form.preset,
        initialFeeBips: Number(form.initialFeeBips),
        finalFeeBips: Number(form.finalFeeBips),
        decaySeconds: Number(form.decaySeconds),
        startDelaySeconds: Number(form.startDelaySeconds),
      },
      legs,
      listing: {
        description: form.description.trim(),
        websiteURI: form.websiteURI.trim(),
        xHandle: form.xHandle.trim().replace(/^@/, ""),
        telegramHandle: form.telegramHandle.trim().replace(/^@/, ""),
      },
      userSalt,
      launcher: address,
    };
  }

  /* Live preview: rebuild the call as the form changes, debounced. Every
     objection the SDK raises is shown beside the field it names, before a
     simulation is ever run. */
  useEffect(() => {
    if (bounds.state.status !== "ready") return;
    const limits = bounds.state.data;
    const draft = draftFrom();
    if ("error" in draft) {
      setPreview({ call: null, error: draft.error });
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void buildCreateLaunchV2(draft, limits)
        .then((call) => {
          if (!cancelled) setPreview({ call, error: null });
        })
        .catch((err: unknown) => {
          if (!cancelled) setPreview({ call: null, error: err instanceof Error ? err.message : String(err) });
        });
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form, address, bounds.state.status, quoteDecimals, splitChecks]);

  async function onSimulate(): Promise<void> {
    if (address === undefined || wagmiClient === undefined) {
      setPhase({ kind: "failed", message: "Connect a wallet first." });
      return;
    }
    if (bounds.state.status !== "ready") {
      setPhase({ kind: "failed", message: "The kit's limits have not loaded yet." });
      return;
    }
    const draft = draftFrom();
    if ("error" in draft) {
      setPhase({ kind: "failed", message: draft.error });
      return;
    }
    setPhase({ kind: "simulating" });
    try {
      const call = await buildCreateLaunchV2(draft, bounds.state.data);
      const errors = call.issues.filter((i) => i.severity === "error");
      if (errors.length > 0) {
        setPhase({ kind: "failed", message: `${errors.length} problem(s) remain; see the list beside the form.` });
        return;
      }
      /* A raw call, so what is simulated is byte-identical to what is sent. */
      await wagmiClient.call({ account: address, to: call.to, data: call.data, value: call.value });
      setPhase({ kind: "simulated", call });
    } catch (err) {
      setPhase({ kind: "failed", message: err instanceof Error ? err.message : String(err) });
    }
  }

  async function onSend(): Promise<void> {
    if (walletClient === undefined || address === undefined || phase.kind !== "simulated") return;
    const call = phase.call;
    setPhase({ kind: "sending" });
    try {
      const hash = await walletClient.sendTransaction({ to: call.to, data: call.data, value: call.value });
      setPhase({ kind: "sent", hash, token: call.token, call });
      /* A hash is a submission, not a launch: wait for the receipt and say which it was. */
      try {
        const receipt = await publicClient().waitForTransactionReceipt({ hash });
        /* A launch exists from its receipt onward; the form that made it is deleted so it cannot make a second. */
        if (receipt.status === "success") draft.clear();
        setPhase(receipt.status === "success" ? { kind: "confirmed", hash, token: call.token, call } : { kind: "reverted", hash, token: call.token });
      } catch (err) {
        setPhase({ kind: "failed", message: `Submitted (${hash}), but the receipt could not be read: ${err instanceof Error ? err.message : String(err)}` });
      }
    } catch (err) {
      setPhase({ kind: "failed", message: err instanceof Error ? err.message : String(err) });
    }
  }

  const weightSum = form.legs.reduce((s, l) => s + (Number(l.weightBps) || 0), 0);

  return (
    <div className="page">
      <header className="page-head">
        <h1>New locked launch</h1>
        <p className="page-sub">
          One transaction: mint the token, open its pools, seed them from the supply, and lock every
          position forever. Trading opens at the start time against that liquidity; nothing graduates
          and nothing migrates.
        </p>
      </header>

      <Async state={bounds.state} onRetry={bounds.reload} loadingLabel="Loading the limits">
        {(limits) => {
          const presetName = PRESET_NAMES[form.preset] ?? "Custom";
          const presetBlocked = limits.tenant !== null && !limits.tenant.allowedPresets.includes(presetName);
          const hasBin = form.legs.some((l) => l.kind === "Bin");
          const integratorBps = limits.integrator.bps;
          /* What the fee is called for this kit, and the bounds its split has to fit: the lockers',
             and the launch contract's own where it takes the fee (the tighter of each pair). */
          const words = kitFeeWords(limits.feeSplit !== null, lpShareOfPools(limits.lpShareBps, form.legs.map((l) => l.kind)));
          const splitBounds = launchSplitBounds(limits);
          const protocolBps = Number(form.protocolBps) || 0;
          const creatorBps = KIT_V2_BPS - protocolBps - integratorBps;
          const supplies = preview.call === null ? null : kitV2LegSupplies(preview.call.params.seedSupply, preview.call.params.legs.map((l) => l.weightBps));
          const issuesFor = (prefix: string) => (preview.call?.issues ?? []).filter((i) => i.field === prefix || i.field.startsWith(`${prefix}.`) || i.field.startsWith(`${prefix}[`));
          const issueList = (prefix: string): ReactElement | null => {
            const list = issuesFor(prefix);
            if (list.length === 0) return null;
            return (
              <ul className="problem-list">
                {list.map((i) => (
                  <li key={`${i.field}:${i.message}`}>
                    <code>{i.field}</code>
                    <span>
                      {i.message}
                      {i.contractError === undefined ? "" : ` (${i.contractError})`}
                    </span>
                  </li>
                ))}
              </ul>
            );
          };

          return (
            <div className="wizard">
              <form
                className="form"
                onSubmit={(e) => {
                  e.preventDefault();
                  void onSimulate();
                }}
              >
                {draft.found !== null ? (
                  <p className="state state-ok" role="status">
                    A draft of this form from {new Date(draft.found.savedAt).toISOString().slice(0, 16).replace("T", " ")} UTC was found in this browser.{" "}
                    <button type="button" className="btn btn-ghost" onClick={restoreDraft}>
                      Restore it
                    </button>{" "}
                    <button type="button" className="btn btn-ghost" onClick={draft.discard}>
                      Start fresh
                    </button>
                    <small> Only what was typed is kept; limits, fees and prices are read again now.</small>
                  </p>
                ) : null}
                <fieldset>
                  <legend>Token</legend>
                  <label>
                    Name (up to {limits.token.maxNameBytes} bytes)
                    <input value={form.name} onChange={(e) => set("name", e.target.value)} maxLength={limits.token.maxNameBytes} required />
                  </label>
                  <label>
                    Symbol (up to {limits.token.maxSymbolBytes} bytes)
                    <input value={form.symbol} onChange={(e) => set("symbol", e.target.value)} maxLength={limits.token.maxSymbolBytes} required />
                  </label>
                  <label>
                    Metadata URI (optional, up to {limits.token.maxMetadataUriBytes} bytes)
                    <input value={form.metadataURI} onChange={(e) => set("metadataURI", e.target.value)} placeholder="ipfs://…" maxLength={limits.token.maxMetadataUriBytes} />
                  </label>
                  <label>
                    Total supply, whole tokens ({LAUNCH_TOKEN_DECIMALS} decimals, minted once, never again)
                    <input value={form.totalSupply} onChange={(e) => set("totalSupply", e.target.value)} required />
                  </label>
                  <label>
                    Share of the supply seeded into pools, %
                    <input value={form.seedPercent} onChange={(e) => set("seedPercent", e.target.value)} required />
                    <small>
                      Everything seeded is locked forever. What is not seeded is sent to the allocation
                      recipient in the same transaction — a team allocation, a treasury, a vesting contract
                      you deployed beforehand. The kit holds nothing and creates no lock: if the recipient is
                      your own wallet, this page offers to vest it with GullyCoreTokenLock once the launch confirms
                      (a second, optional transaction).
                    </small>
                  </label>
                  {form.seedPercent.trim() !== "100" ? (
                    <label>
                      Allocation recipient
                      <input value={form.allocationRecipient} onChange={(e) => set("allocationRecipient", e.target.value)} placeholder="0x…" />
                    </label>
                  ) : null}
                  {issueList("seedSupply")}
                  {issueList("allocationRecipient")}
                </fieldset>

                <fieldset>
                  <legend>{words.splitLegend}</legend>
                  <label>
                    Protocol share, bps ({formatBps(splitBounds.minProtocolBps)} to {formatBps(splitBounds.maxProtocolBps)})
                    <input
                      type="number"
                      min={splitBounds.minProtocolBps}
                      max={splitBounds.maxProtocolBps}
                      value={form.protocolBps}
                      onChange={(e) => set("protocolBps", e.target.value)}
                    />
                  </label>
                  <fieldset className="subfieldset">
                    <legend>Creator share paid to</legend>
                    <label>
                      <input type="radio" checked={form.creatorMode === "wallet"} onChange={() => set("creatorMode", "wallet")} /> The
                      connected wallet
                    </label>
                    {cfg.features.splits ? (
                      <label>
                        <input
                          type="radio"
                          checked={form.creatorMode === "split"}
                          disabled={cfg.utilities.splitFactory === null}
                          onChange={() => set("creatorMode", "split")}
                        />{" "}
                        A Team split
                        {cfg.utilities.splitFactory === null ? (
                          <small> — Team splits are coming soon on {cfg.core.name}.</small>
                        ) : (
                          <small>
                            {" "}
                            — the split, not you, is the creator: it receives the creator share of {words.fees} (and of any creator
                            tax) and pays its payees by their frozen shares. <Link to="/splits/new" target="_blank">Create one</Link>{" "}
                            first.
                          </small>
                        )}
                      </label>
                    ) : null}
                    {form.creatorMode === "split" ? (
                      <label>
                        Split address
                        <input value={form.creatorSplit} onChange={(e) => set("creatorSplit", e.target.value)} placeholder="0x…" />
                        <small>
                          {(() => {
                            if (!isAddress(form.creatorSplit)) return "The address of a split made by this chain's GullyCoreSplitFactory.";
                            const c = splitChecks[form.creatorSplit.toLowerCase()];
                            if (c === undefined || c.status === "checking") return "Checking isSplit() on the factory…";
                            if (c.status === "yes") return `Split "${c.name}", made by the configured factory.`;
                            if (c.status === "no") return "Not a split made by the configured factory. Refused.";
                            return `Could not be checked: ${c.message}`;
                          })()}
                        </small>
                      </label>
                    ) : null}
                  </fieldset>
                  <dl className="kv">
                    <dt>{form.creatorMode === "split" ? "Creator (the split)" : "Creator (you)"}</dt>
                    <dd>{creatorBps < 0 ? <span className="state-error">negative</span> : formatBps(creatorBps)}</dd>
                    <dt>{cfg.brand.name} (integrator)</dt>
                    <dd>
                      {formatBps(integratorBps)}
                      {integratorBps > 0 ? (
                        <>
                          {" "}
                          to{" "}
                          <ExplorerLink href={explorerAddressUrl(limits.integrator.address)}>
                            {shortAddress(limits.integrator.address)}
                          </ExplorerLink>
                        </>
                      ) : null}
                      <span className="muted">
                        {" "}
                        · {limits.integrator.source === "tenant" ? "stored tenant config" : "gullycore.config.ts"}
                      </span>
                    </dd>
                    <dt>Protocol</dt>
                    <dd>{formatBps(protocolBps)}</dd>
                  </dl>
                  <p className="state-hint">
                    {words.splitRule}{" "}
                    The protocol floor ({formatBps(splitBounds.minProtocolBps)}) is immutable in the
                    contracts; the integrator share is capped at {formatBps(splitBounds.maxIntegratorBps)}.
                  </p>
                  {issueList("creatorBps")}
                  {issueList("protocolBps")}
                  {issueList("integratorBps")}
                  {issueList("integrator")}
                  {issueList("tenant")}
                </fieldset>

                <fieldset>
                  <legend>Launch fee schedule (every pool)</legend>
                  <label>
                    Preset
                    <select value={form.preset} onChange={(e) => set("preset", Number(e.target.value))}>
                      {PRESET_NAMES.map((name) => (
                        <option key={name} value={PRESET[name]} disabled={limits.tenant !== null && !limits.tenant.allowedPresets.includes(name)}>
                          {name}
                          {name === "Custom"
                            ? ""
                            : ` · ${formatPips(PRESET_PARAMS[name].initialFeeBips)} → ${formatPips(PRESET_PARAMS[name].finalFeeBips)} over ${formatDuration(PRESET_PARAMS[name].windowSeconds)}`}
                        </option>
                      ))}
                    </select>
                    {presetName !== "Custom" ? (
                      <small>
                        {PRESET_PARAMS[presetName].requiresMaxBuyPerTx ? "Requires a max buy per transaction on every CL leg. " : ""}
                        Does not protect against: {PRESET_PARAMS[presetName].doesNotProtectAgainst}
                      </small>
                    ) : null}
                    {presetBlocked ? (
                      <small className="state-error">
                        {presetName === "Custom"
                          ? "This tenant does not allow a custom schedule, so the 1% default cannot be sent. Pick one of its presets; its final fee is what every trade pays, forever."
                          : "This tenant does not allow that preset."}
                      </small>
                    ) : null}
                    {hasBin && presetName !== "Custom" && PRESET_PARAMS[presetName].initialFeeBips > 100_000 ? (
                      <small className="state-error">
                        Core caps a Bin pool&rsquo;s fee at 10%, so a launch with a Bin leg cannot open at{" "}
                        {formatPips(PRESET_PARAMS[presetName].initialFeeBips)}.
                      </small>
                    ) : null}
                  </label>
                  {form.preset === PRESET.Custom ? (
                    <>
                      <label>
                        Opening fee, pips (max {formatPips(limits.guard.maxInitialFeeBips)}
                        {hasBin ? ", 10% with a Bin leg" : ""})
                        <input type="number" min={0} max={limits.guard.maxInitialFeeBips} value={form.initialFeeBips} onChange={(e) => set("initialFeeBips", e.target.value)} />
                        <small>{formatPips(Number(form.initialFeeBips) || 0)} of every trade at the start</small>
                      </label>
                      <label>
                        Final fee, pips (max {formatPips(limits.guard.maxFinalFeeBips)})
                        <input type="number" min={0} max={limits.guard.maxFinalFeeBips} value={form.finalFeeBips} onChange={(e) => set("finalFeeBips", e.target.value)} />
                        <small>{formatPips(Number(form.finalFeeBips) || 0)} once decay ends, forever</small>
                      </label>
                      <label>
                        Decay window, seconds ({formatDuration(limits.guard.minDecaySeconds)} to {formatDuration(limits.guard.maxDecaySeconds)})
                        <input type="number" min={limits.guard.minDecaySeconds} max={limits.guard.maxDecaySeconds} value={form.decaySeconds} onChange={(e) => set("decaySeconds", e.target.value)} />
                        <small>{formatDuration(Number(form.decaySeconds) || 0)} on <code>block.timestamp</code>.</small>
                      </label>
                    </>
                  ) : null}
                  <label>
                    Start delay, seconds (up to {formatDuration(limits.guard.maxStartDelaySeconds)})
                    <input type="number" min={0} max={limits.guard.maxStartDelaySeconds} value={form.startDelaySeconds} onChange={(e) => set("startDelaySeconds", e.target.value)} />
                    <small>
                      Trading opens this long after the launch lands, on <code>block.timestamp</code>. Until
                      then you can still <code>reconfigureLaunch</code>; from then on the schedule is frozen.
                    </small>
                  </label>
                  <p>
                    After the opening the {words.fee} is{" "}
                    <strong>
                      {formatPips(presetName === "Custom" ? Number(form.finalFeeBips) || 0 : PRESET_PARAMS[presetName].finalFeeBips)} on every trade, forever
                    </strong>
                    . Nobody can change it once trading has started.
                  </p>
                  {issueList("schedule")}
                </fieldset>

                {form.legs.map((leg, index) => (
                  <fieldset key={index}>
                    <legend>
                      Leg {index + 1} of {form.legs.length} (kit allows up to {limits.caps.maxLegs})
                    </legend>
                    <label>
                      Pool type
                      <select value={leg.kind} onChange={(e) => setLeg(index, { kind: e.target.value === "Bin" ? "Bin" : "CL" })}>
                        <option value="CL">Concentrated liquidity — one single-sided range above the price</option>
                        <option value="Bin" disabled={limits.tenant !== null && limits.tenant.allowedBinShapes.length === 0}>
                          Bin — a shaped ladder of price bins
                        </option>
                      </select>
                    </label>
                    <label>
                      Quote currency
                      <select value={leg.quoteChoice} onChange={(e) => setLeg(index, { quoteChoice: e.target.value })}>
                        {quoteOptions.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                        <option value={CUSTOM_QUOTE}>Another ERC-20 by address…</option>
                      </select>
                    </label>
                    {leg.quoteChoice === CUSTOM_QUOTE ? (
                      <label>
                        Quote token address
                        <input value={leg.customQuote} onChange={(e) => setLeg(index, { customQuote: e.target.value })} placeholder="0x…" />
                        <small>
                          Decimals are read from the contract, never typed.{" "}
                          {isAddress(leg.customQuote)
                            ? (() => {
                                const d = quoteDecimals[leg.customQuote.toLowerCase()];
                                return d === undefined ? "Reading…" : d === "unreadable" ? "Not readable as an ERC-20." : `${d} decimals.`;
                              })()
                            : ""}
                        </small>
                      </label>
                    ) : null}
                    <label>
                      Share of the seeded supply, bps (all legs must sum to {KIT_V2_BPS})
                      <input type="number" min={1} max={KIT_V2_BPS} value={leg.weightBps} onChange={(e) => setLeg(index, { weightBps: e.target.value })} />
                      {supplies !== null && supplies.supplies[index] !== undefined ? (
                        <small>{formatUnits(supplies.supplies[index], LAUNCH_TOKEN_DECIMALS)} tokens into this pool</small>
                      ) : null}
                    </label>
                    {(() => {
                      const u = legUnits[index] ?? null;
                      const pending = u !== null && u.pending;
                      const unit = u !== null && !u.pending ? u.unit : null;
                      const quote = resolveQuote(leg);
                      const quoteIsNative = !("error" in quote) && quote.address === NATIVE_ADDRESS;
                      const symbol = unit !== null && unit.k === "quote" ? unit.symbol : cfg.nativeCurrency.symbol;
                      const reason = u === null ? "Pick a quote currency first." : noUsdReason(usdRead, quoteIsNative, symbol);
                      const snapped = preview.call?.legs[index];
                      const snappedCap = snapped !== undefined && unit !== null ? capFromPrice(snapped.openingPrice, unit, capContextOf(form.totalSupply)) : null;
                      const q = quoteIsNative ? usdQuoteOf(usdRead) : null;
                      return (
                        <>
                          <label>
                            Opening market cap{unit !== null ? (unit.k === "usd" ? ", US dollars" : `, ${unit.symbol}`) : ""}
                            <input
                              inputMode="decimal"
                              value={leg.marketCap}
                              disabled={pending}
                              aria-busy={pending}
                              placeholder={pending ? "reading the dollar price…" : unit?.k === "usd" ? String(cfg.launch.defaultOpeningMarketCapUsd) : ""}
                              onChange={(e) => setLegCap(index, e.target.value)}
                            />
                            {unit !== null && unit.k === "usd" ? (
                              <span className="filter-chips" role="group" aria-label="Opening market cap, quick choices">
                                {capChips(cfg.launch.defaultOpeningMarketCapUsd).map((c) => (
                                  <button key={c.text} type="button" className={`filter-chip${leg.marketCap.trim() === c.text ? " active" : ""}`} aria-pressed={leg.marketCap.trim() === c.text} onClick={() => setLegCap(index, c.text)}>
                                    {c.label}
                                    {c.isDefault ? " · default" : ""}
                                  </button>
                                ))}
                              </span>
                            ) : null}
                            <small>
                              {q !== null && quoteIsNative ? usdNote(q) : (reason ?? "")}{" "}
                              {unit !== null && unit.k === "usd"
                                ? `${cfg.brand.name} proposes $${cfg.launch.defaultOpeningMarketCapUsd.toLocaleString("en-US")}; the price below follows this number.`
                                : "Type a cap in the quote currency; the price below follows it."}
                            </small>
                          </label>
                          <label>
                            Opening price, {symbol} per token
                            <input inputMode="decimal" value={leg.price} disabled={pending} placeholder={pending ? "" : "follows the market cap"} onChange={(e) => setLegPrice(index, e.target.value)} required />
                            {snapped !== undefined ? (
                              <small>
                                Born at <strong>{snapped.openingPrice}</strong> {symbol} per token
                                {snapped.snapFraction > 1e-6 ? ` (snapped ${(snapped.snapFraction * 100).toFixed(3)}% onto the ${leg.kind === "CL" ? "range edge" : "nearest bin"})` : ""}
                                {snappedCap !== null && snappedCap.ok && unit !== null ? (
                                  <>
                                    {" "}
                                    — an opening market cap of <strong>{formatCap(snappedCap.value, unit)}</strong>
                                  </>
                                ) : null}
                                . This is permanent; the dollar figure is a convenience, this price is the number the contract uses.
                              </small>
                            ) : (
                              <small>
                                {leg.capPrimary ? "Derived from the market cap. Type here instead and the market cap follows." : "You are setting the price directly; the market cap above follows it."}{" "}
                                The price the pool is born at is permanent and is shown here, after snapping, once the form is complete.
                              </small>
                            )}
                          </label>
                        </>
                      );
                    })()}
                    {leg.kind === "CL" ? (
                      <>
                        <label>
                          Tick spacing
                          <input type="number" min={1} max={32767} value={leg.tickSpacing} onChange={(e) => setLeg(index, { tickSpacing: e.target.value })} />
                        </label>
                        <label>
                          Range width, in tick spacings
                          <input type="number" min={1} value={leg.widthInSpacings} onChange={(e) => setLeg(index, { widthInSpacings: e.target.value })} />
                          <small>
                            The whole leg&rsquo;s supply sits in one range starting at the opening price and
                            reaching up by this many spacings (each tick is 0.01%). A narrow range fills, and
                            stops selling, sooner; a wide one sells across a larger price move. A buy that
                            would run past the end of the range is REFUSED by the launch contract
                            (<code>SwapNotFilled</code>), never partly filled: the swap box sizes every buy
                            from a quote and says so.
                          </small>
                        </label>
                        <label>
                          Max buy per transaction, in quote (0 for uncapped)
                          <input value={leg.maxBuyPerTx} onChange={(e) => setLeg(index, { maxBuyPerTx: e.target.value })} />
                        </label>
                      </>
                    ) : (
                      <>
                        <label>
                          Bin step, bps (price gap between adjacent bins)
                          <input type="number" min={1} max={65535} value={leg.binStep} onChange={(e) => setLeg(index, { binStep: e.target.value })} />
                        </label>
                        <label>
                          Shape
                          <select value={leg.shape} onChange={(e) => setLeg(index, { shape: e.target.value as BinShapeName })}>
                            {BIN_SHAPE_NAMES.filter((s) => s !== "Custom").map((s) => (
                              <option key={s} value={s} disabled={limits.tenant !== null && !limits.tenant.allowedBinShapes.includes(s)}>
                                {s}
                              </option>
                            ))}
                          </select>
                          <small>
                            Flat: every bin equal. Linear: each bin smaller than the last. Exponential: each bin
                            9/10 of the previous. Stepped: tiers of four bins with two empty bins between tiers.
                          </small>
                        </label>
                        <label>
                          Bins (1 to {limits.caps.maxBinsPerLeg})
                          <input type="number" min={1} max={limits.caps.maxBinsPerLeg} value={leg.binCount} onChange={(e) => setLeg(index, { binCount: e.target.value })} />
                        </label>
                        <label>
                          Max buy per transaction, in quote (0 for uncapped)
                          <input value={leg.maxBuyPerTx} onChange={(e) => setLeg(index, { maxBuyPerTx: e.target.value })} />
                        </label>
                      </>
                    )}
                    {preview.call !== null && preview.call.legs[index] !== undefined ? (
                      <p className="state-hint mono">
                        Pool id {preview.call.legs[index].key.poolId}
                        {preview.call.legs[index].key.launchTokenIsCurrency0 ? " · token is currency0" : " · token is currency1"}
                      </p>
                    ) : null}
                    {issueList(`legs[${index}]`)}
                    {form.legs.length > 1 ? (
                      <button type="button" className="btn btn-ghost" onClick={() => set("legs", form.legs.filter((_, i) => i !== index))}>
                        Remove leg
                      </button>
                    ) : null}
                  </fieldset>
                ))}
                {form.legs.length < limits.caps.maxLegs ? (
                  <p>
                    <button type="button" className="btn btn-ghost" onClick={() => set("legs", [...form.legs, { ...emptyLeg(), weightBps: "0" }])}>
                      Add a leg
                    </button>{" "}
                    <span className="muted">
                      Leg weights sum to {weightSum} of {KIT_V2_BPS}.
                    </span>
                  </p>
                ) : null}
                {issueList("legs")}

                <fieldset>
                  <legend>Listing (written to every pool&rsquo;s registry record)</legend>
                  <label>
                    Description
                    <input value={form.description} onChange={(e) => set("description", e.target.value)} />
                  </label>
                  <label>
                    Website
                    <input value={form.websiteURI} onChange={(e) => set("websiteURI", e.target.value)} placeholder="https://" />
                  </label>
                  <label>
                    X handle
                    <input value={form.xHandle} onChange={(e) => set("xHandle", e.target.value)} placeholder="handle" maxLength={16} />
                  </label>
                  <label>
                    Telegram handle
                    <input value={form.telegramHandle} onChange={(e) => set("telegramHandle", e.target.value)} placeholder="handle" maxLength={33} />
                  </label>
                  <p className="muted">Handles, not links: letters, digits and underscore, without the &ldquo;@&rdquo;. Rendered as x.com/&lt;handle&gt; and t.me/&lt;handle&gt;. Both optional.</p>
                </fieldset>

                <div className="form-actions">
                  <button type="submit" className="btn btn-ghost" disabled={phase.kind === "simulating" || phase.kind === "sending"}>
                    {phase.kind === "simulating" ? "Simulating…" : "Simulate"}
                  </button>
                  <button type="button" className="btn btn-primary" disabled={phase.kind !== "simulated"} onClick={() => void onSend()}>
                    Create launch
                  </button>
                </div>

                {phase.kind === "simulated" ? (
                  <p className="state state-ok">
                    Simulation succeeded. The token will be{" "}
                    <ExplorerLink href={explorerAddressUrl(phase.call.token)} className="mono">
                      {phase.call.token}
                    </ExplorerLink>
                    ; {phase.call.legs.length} pool{phase.call.legs.length === 1 ? "" : "s"}; you will send{" "}
                    {formatEther(phase.call.value)} {cfg.nativeCurrency.symbol}, any surplus refunded.
                  </p>
                ) : null}
                {phase.kind === "failed" ? (
                  <p className="state state-error" role="alert">
                    {phase.message}
                  </p>
                ) : null}
                {phase.kind === "confirmed" ? (
                  <p className="state state-ok">
                    Launched and confirmed.{" "}
                    <ExplorerLink href={explorerTxUrl(phase.hash)}>View transaction</ExplorerLink>. The token is <code className="mono">{phase.token}</code>; see{" "}
                    <Link to="/launch">the launch list</Link>.
                    {phase.call.params.seedSupply < phase.call.params.totalSupply ? " Optional next step, below: vest the unseeded allocation (a second transaction)." : ""}
                  </p>
                ) : null}
                {phase.kind === "reverted" ? (
                  <p className="state state-error" role="alert">
                    The launch transaction was mined but REVERTED: nothing was created and only gas was spent.{" "}
                    <ExplorerLink href={explorerTxUrl(phase.hash)}>View transaction</ExplorerLink>. Simulate again before retrying.
                  </p>
                ) : null}
                {phase.kind === "sent" ? (
                  <p className="state state-ok">
                    Submitted, waiting for the receipt.{" "}
                    <ExplorerLink href={explorerTxUrl(phase.hash)}>
                      View transaction
                    </ExplorerLink>
                    . The token lands at <code className="mono">{phase.token}</code>; the launch will appear on{" "}
                    <Link to="/launch">the launch list</Link> once mined.
                  </p>
                ) : null}
              </form>

              <aside className="panel">
                <h2>What this costs</h2>
                <dl className="kv">
                  <dt>Protocol launch fee</dt>
                  <dd>
                    {formatEther(limits.value.launchFeeWei)} {cfg.nativeCurrency.symbol}
                  </dd>
                  <dt>{cfg.brand.name} launch fee</dt>
                  <dd>
                    {formatEther(limits.value.integratorFeeWei)} {cfg.nativeCurrency.symbol}
                  </dd>
                  <dt>Sent as msg.value</dt>
                  <dd>
                    {formatEther(limits.value.safeValue)} {cfg.nativeCurrency.symbol}
                    {limits.value.safeValue > limits.value.minimumValue ? " (covers the scheduled increase; surplus refunded)" : ""}
                  </dd>
                </dl>
                {limits.value.pending !== null ? (
                  <p className="warn-inline">
                    The protocol launch fee rises to {formatEther(limits.value.pending.feeWei)} {cfg.nativeCurrency.symbol}{" "}
                    at {new Date(Number(limits.value.pending.effectiveAt) * 1000).toISOString()}. A launch mined after that pays the new fee.
                  </p>
                ) : null}
                <p className="state-hint">
                  Nothing else is taken: any overpayment is refunded in the same transaction, and{" "}
                  {words.revenue}.
                </p>

                <h2>Preview</h2>
                {preview.error !== null ? <p className="state-hint">{preview.error}</p> : null}
                {preview.call !== null ? (
                  <>
                    <dl className="kv">
                      <dt>Token</dt>
                      <dd className="mono">{preview.call.token}</dd>
                      <dt>Seeded</dt>
                      <dd>
                        {formatUnits(preview.call.params.seedSupply, LAUNCH_TOKEN_DECIMALS)} of{" "}
                        {formatUnits(preview.call.params.totalSupply, LAUNCH_TOKEN_DECIMALS)} {form.symbol || "tokens"}
                      </dd>
                      <dt>Problems</dt>
                      <dd>
                        {preview.call.issues.filter((i) => i.severity === "error").length === 0
                          ? "none found by the SDK; simulate to ask the chain"
                          : `${preview.call.issues.filter((i) => i.severity === "error").length}, listed beside the fields`}
                      </dd>
                    </dl>
                    {preview.call.issues.filter((i) => i.severity === "warning").map((i) => (
                      <p key={`${i.field}:${i.message}`} className="state-hint">
                        {i.message}
                      </p>
                    ))}
                  </>
                ) : null}
                <p className="state-hint">
                  The token address is fixed by your wallet and a salt made for this session; reloading
                  the page picks a new one.
                  {draft.lastSave === "saved"
                    ? " What you typed is saved as a draft in this browser until the launch confirms."
                    : draft.lastSave === null
                      ? ""
                      : ` The draft could not be saved in this browser (storage ${draft.lastSave}).`}
                </p>
              </aside>
            </div>
          );
        }}
      </Async>
      {phase.kind === "confirmed" ? (
        <VestAllocation
          token={phase.token}
          symbol={phase.call.params.symbol}
          decimals={LAUNCH_TOKEN_DECIMALS}
          kit={kit}
          launchTx={phase.hash}
          totalSupply={phase.call.params.totalSupply}
          seedSupply={phase.call.params.seedSupply}
        />
      ) : null}
    </div>
  );
}
