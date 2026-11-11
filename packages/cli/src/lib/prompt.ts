// SPDX-License-Identifier: MIT
/**
 * The stepper and its prompts, on `@clack/prompts`.
 *
 * - Every step prints a numbered header: `Step 2 of 6 · Opening market cap`.
 * - BACK: a text prompt accepts `<` to return to the previous step; a select has a `Back` row. What was
 *   entered before is kept as the default when a step is revisited.
 * - Ctrl+C (clack's cancel) aborts the whole flow with nothing sent.
 * - Input/output streams are injectable, so a scripted run can drive the real prompts (see the
 *   transcript test) without a pty.
 *
 * Kit palette: clack draws its own chrome with `node:util`'s `styleText` in terminal colours (cyan,
 * green, yellow). `installKitPalette` remaps those names onto the kit's emerald, Success and Muted,
 * so the whole screen stays in the brand's colours. It patches the process-wide builtin, which is why
 * only the `gullycore` binary calls it and the library surface never does.
 */

import { createRequire, syncBuiltinESMExports } from "node:module";
import type { Readable, Writable } from "node:stream";

import * as clack from "@clack/prompts";

import { KIT, colourEnabled, ui } from "./brand.js";
import { printLogo } from "./logo.js";
import { UserError } from "../util/log.js";

export const BACK: unique symbol = Symbol("gullycore.back");
export type Back = typeof BACK;

/** Thrown when the user cancels (Ctrl+C / Esc). Reported as a clean exit, not an error. */
export class Aborted extends Error {
  constructor() {
    super("cancelled — nothing was sent");
    this.name = "Aborted";
  }
}

let io: { input?: Readable; output?: Writable } = {};

/** Point every prompt at other streams (scripted runs, tests). */
export function setPromptIO(next: { input?: Readable; output?: Writable }): void {
  io = next;
}

export function promptOutput(): Writable {
  return io.output ?? process.stdout;
}

/** True when a human can answer prompts: a TTY on both ends, or injected streams. */
export function canPrompt(): boolean {
  if (io.input !== undefined) return true;
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

/* ------------------------------------------------------------ kit palette */

let paletteInstalled = false;

/** Maps clack's terminal colour names onto the kit's colours. Idempotent; safe to call once at startup. */
export function installKitPalette(): void {
  if (paletteInstalled) return;
  paletteInstalled = true;
  try {
    const require = createRequire(import.meta.url);
    const util = require("node:util") as { styleText?: (f: string | string[], t: string, o?: unknown) => string };
    const original = util.styleText;
    if (typeof original !== "function") return;
    const hex = (h: string, t: string): string => {
      const n = Number.parseInt(h.slice(1), 16);
      return `\u001B[38;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}m${t}\u001B[39m`;
    };
    const COLOUR: Record<string, string> = {
      cyan: KIT.gullycoreBlue,
      blue: KIT.gullycoreBlue,
      blueBright: KIT.gullycoreBlue,
      cyanBright: KIT.gullycoreBlue,
      magenta: KIT.gullycoreBlue,
      green: KIT.success,
      greenBright: KIT.success,
      gray: KIT.muted,
      grey: KIT.muted,
    };
    // Not in the kit: rendered by weight instead of a colour the kit does not own.
    const WEIGHT = new Set(["yellow", "red", "yellowBright", "redBright"]);
    util.styleText = (format: string | string[], text: string): string => {
      const formats = Array.isArray(format) ? format : [format];
      if (!colourEnabled()) return text;
      let out = text;
      const rest: string[] = [];
      let colour: string | undefined;
      for (const f of formats) {
        if (COLOUR[f] !== undefined) colour = COLOUR[f];
        else if (WEIGHT.has(f)) rest.push("bold");
        else if (f.startsWith("bg") && f !== "bgWhite") continue;
        else rest.push(f);
      }
      if (rest.length > 0) out = original(rest, out, { validateStream: false });
      return colour === undefined ? out : hex(colour, out);
    };
    syncBuiltinESMExports();
  } catch {
    /* Cosmetic only: clack's default chrome is left as it is. */
  }
}

/* --------------------------------------------------------------- prompts */

function unwrap<T>(v: T): Exclude<T, symbol> {
  if (clack.isCancel(v)) throw new Aborted();
  return v as Exclude<T, symbol>;
}

export interface TextPrompt {
  readonly message: string;
  /** Pressing Enter on an empty line accepts this. Shown as the placeholder. */
  readonly defaultValue?: string | undefined;
  readonly placeholder?: string | undefined;
  /** Return an error string to refuse the value, or undefined to accept. */
  readonly validate?: ((value: string) => string | undefined) | undefined;
  /** Offer `<` to go back. */
  readonly back?: boolean;
}

export async function askText(p: TextPrompt): Promise<string | Back> {
  const hint = p.back === true ? ` ${ui.muted("(< back)")}` : "";
  const value = unwrap(
    await clack.text({
      message: `${p.message}${hint}`,
      ...(p.placeholder !== undefined ? { placeholder: p.placeholder } : p.defaultValue !== undefined ? { placeholder: p.defaultValue } : {}),
      ...(p.defaultValue !== undefined ? { defaultValue: p.defaultValue } : {}),
      validate: (raw) => {
        const v = (raw ?? "").trim();
        if (p.back === true && v === "<") return undefined;
        const candidate = v === "" && p.defaultValue !== undefined ? p.defaultValue : v;
        return p.validate?.(candidate);
      },
      ...io,
    }),
  );
  const v = value.trim();
  if (p.back === true && v === "<") return BACK;
  return v === "" && p.defaultValue !== undefined ? p.defaultValue : v;
}

export interface Choice<T> {
  readonly value: T;
  readonly label: string;
  readonly hint?: string;
}

const BACK_ROW = "__gullycore_back__";

export async function askSelect<T extends string>(p: {
  readonly message: string;
  readonly options: readonly Choice<T>[];
  readonly initial?: T | undefined;
  readonly back?: boolean;
}): Promise<T | Back> {
  const options = [
    ...p.options.map((o) => ({ value: o.value as string, label: o.label, ...(o.hint !== undefined ? { hint: o.hint } : {}) })),
    ...(p.back === true ? [{ value: BACK_ROW, label: "Back" }] : []),
  ];
  const v = unwrap(
    await clack.select<string>({
      message: p.message,
      options,
      ...(p.initial !== undefined ? { initialValue: p.initial as string } : {}),
      ...io,
    }),
  );
  return v === BACK_ROW ? BACK : (v as T);
}

export async function askConfirm(message: string, initial = false): Promise<boolean> {
  return unwrap(await clack.confirm({ message, initialValue: initial, ...io }));
}

/** Irreversible actions: the user types `expected` exactly. */
export async function askTypedConfirmation(what: string, expected: string): Promise<boolean> {
  const v = unwrap(
    await clack.text({
      message: `${what}\n  Type ${ui.bold(expected)} to confirm, or leave empty to stop`,
      validate: (raw) => {
        const s = (raw ?? "").trim();
        return s === "" || s === expected ? undefined : `type exactly ${expected}`;
      },
      ...io,
    }),
  );
  return v.trim() === expected;
}

export async function askPassword(message: string): Promise<string> {
  return unwrap(await clack.password({ message, ...io }));
}

export function note(body: string, title?: string): void {
  clack.note(body, title, { ...io });
}

export function intro(title: string): void {
  printLogo();
  clack.intro(title, { ...io });
}

export function outro(message: string): void {
  clack.outro(message, { ...io });
}

export function stepHeader(index: number, total: number, title: string): void {
  clack.log.message(ui.step(index, total, title), { ...io, symbol: ui.accent("◆") });
}

/* --------------------------------------------------------------- stepper */

export interface Step<S> {
  readonly title: string;
  /** Skipped steps are not counted in "Step N of M". Re-evaluated on every move. */
  readonly skip?: (state: S) => boolean;
  /** Mutates `state`. Return BACK to go to the previous step. */
  readonly run: (state: S, ctx: { readonly first: boolean }) => Promise<Back | undefined>;
}

/** Runs steps in order with back-navigation. Returns when the last step completes. */
export async function runSteps<S>(steps: readonly Step<S>[], state: S): Promise<void> {
  if (!canPrompt()) throw new UserError("this step needs an interactive terminal", "pass every value as a flag with --yes");
  let i = 0;
  const active = (): Step<S>[] => steps.filter((s) => s.skip?.(state) !== true);
  while (i < steps.length) {
    const step = steps[i] as Step<S>;
    if (step.skip?.(state) === true) {
      i += 1;
      continue;
    }
    const list = active();
    const position = list.indexOf(step) + 1;
    stepHeader(position, list.length, step.title);
    const result = await step.run(state, { first: position === 1 });
    if (result === BACK) {
      let j = i - 1;
      while (j >= 0 && (steps[j] as Step<S>).skip?.(state) === true) j -= 1;
      i = j < 0 ? i : j;
      continue;
    }
    i += 1;
  }
}
