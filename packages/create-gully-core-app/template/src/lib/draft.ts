// SPDX-License-Identifier: MIT
/**
 * Drafts: what a creator TYPED into a builder, kept in this browser so a
 * reload, a wallet reconnect or a closed tab does not lose the form.
 *
 * Three rules, each the Gully Core dapp's (2026-10-11):
 *
 *   1. A draft is what was typed, never what the chain answered. Limits, fees,
 *      the snapped opening price and the simulation are read again when a
 *      draft is opened; `READ_KEYS` are stripped on save so a stale answer can
 *      never be restored as if it were current.
 *   2. Storage is a per-viewer convenience. Every read and write is wrapped;
 *      a blocked or full storage is a stated outcome (`'blocked'` / `'full'`),
 *      never a crash, and nothing here is sent anywhere.
 *   3. A draft is deleted the moment its create confirms. A launch exists from
 *      its receipt onward; keeping the form that made it invites a duplicate.
 *
 * Keys carry the chain and the builder, so a draft typed for one chain is
 * never restored into a form that writes to another. No React and no chain
 * imports: `draft.test.ts` runs this in node with an in-memory storage.
 */

export type DraftOutcome = "saved" | "blocked" | "full";

const PREFIX = "gullycore.app.draft.v1";

/** The storage key for a builder on a chain (and a wallet, when the form's meaning depends on one). */
export function draftKey(builder: string, chainId: number, wallet: string | null = null): string {
  return `${PREFIX}.${builder}.${chainId}${wallet === null ? "" : `.${wallet.toLowerCase()}`}`;
}

type KV = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function storage(): KV | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** Keys a draft never stores: values the chain answered, at the top level of the form. */
export const READ_KEYS: readonly string[] = ["limits", "preview", "phase", "simulation", "call", "fee", "feeWei", "openingPrice", "snappedPrice", "usdPrice"];

/** Strip the chain's answers out of a form before it is saved. Pure. */
export function strippedForSave<T extends object>(form: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(form)) if (!READ_KEYS.includes(k)) out[k] = v;
  return out as Partial<T>;
}

export interface StoredDraft<T> {
  readonly v: 1;
  readonly savedAt: number;
  readonly form: Partial<T>;
}

/** Save a form under `key`. Never throws: a storage that refuses is an outcome. */
export function saveDraft<T extends object>(key: string, form: T, kv: KV | null = storage(), now: () => number = Date.now): DraftOutcome {
  if (kv === null) return "blocked";
  const doc: StoredDraft<T> = { v: 1, savedAt: now(), form: strippedForSave(form) };
  try {
    kv.setItem(key, JSON.stringify(doc));
    return "saved";
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    return name === "QuotaExceededError" || /quota/i.test(String(err)) ? "full" : "blocked";
  }
}

/**
 * Read a draft back. `accept` keeps only the values of the right shape (the
 * caller knows its form; a draft written by an older build may lack fields or
 * carry ones that no longer exist), so a restored form is always well typed.
 */
export function loadDraft<T extends object>(key: string, accept: (raw: Record<string, unknown>) => Partial<T>, kv: KV | null = storage()): { form: Partial<T>; savedAt: number } | null {
  if (kv === null) return null;
  let text: string | null;
  try {
    text = kv.getItem(key);
  } catch {
    return null;
  }
  if (text === null || text === "") return null;
  try {
    const doc = JSON.parse(text) as unknown;
    if (typeof doc !== "object" || doc === null) return null;
    const d = doc as { v?: unknown; savedAt?: unknown; form?: unknown };
    if (d.v !== 1 || typeof d.savedAt !== "number" || typeof d.form !== "object" || d.form === null) return null;
    const form = accept(d.form as Record<string, unknown>);
    return Object.keys(form).length === 0 ? null : { form, savedAt: d.savedAt };
  } catch {
    return null;
  }
}

/** Forget a draft (a confirmed create, or the creator's choice). Never throws. */
export function clearDraft(key: string, kv: KV | null = storage()): void {
  if (kv === null) return;
  try {
    kv.removeItem(key);
  } catch {
    /* A storage that refuses to forget has nothing to restore either. */
  }
}

/** An accept helper: keep every key of `shape` whose value in `raw` has the same primitive type (arrays and objects taken as they are). */
export function sameShape<T extends object>(shape: T, raw: Record<string, unknown>): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, example] of Object.entries(shape)) {
    const v = raw[k];
    if (v === undefined) continue;
    if (typeof example === "string" && typeof v === "string") out[k] = v;
    else if (typeof example === "number" && typeof v === "number" && Number.isFinite(v)) out[k] = v;
    else if (typeof example === "boolean" && typeof v === "boolean") out[k] = v;
    else if (Array.isArray(example) && Array.isArray(v)) out[k] = v;
    else if (typeof example === "object" && example !== null && !Array.isArray(example) && typeof v === "object" && v !== null && !Array.isArray(v)) out[k] = v;
  }
  return out as Partial<T>;
}
