// SPDX-License-Identifier: MIT
/**
 * Terminal styling in the Gully Core kit's colours, and nothing else.
 *
 * The palette is Gully Chain kit v4's table, the same `BRAND_COLORS` as `packages/notifier/src/brand.ts`. The
 * key names are the notifier's, kept so the two stay comparable: `gullycoreBlue` holds the kit's emerald. There
 * is no red in it, so an error is carried by its wording and weight, not by a colour the kit does not own.
 *
 * THE LOGO lives in ./logo.ts: the kit's gc-icon.svg rendered for a terminal image protocol, or as coloured
 * half-blocks, both generated from that file.
 *
 * Colour is off when `NO_COLOR` is set, when `TERM=dumb`, or when the stream is not a TTY — which is
 * picocolors' own detection (it also honours `FORCE_COLOR`). Kit colours are 24-bit escapes, so they
 * are only emitted when colour is on at all.
 */

import pc from "picocolors";

function colourOn(): boolean {
  if (process.env["NO_COLOR"] !== undefined && process.env["NO_COLOR"] !== "") return false;
  if (process.env["TERM"] === "dumb") return false;
  if (process.env["FORCE_COLOR"] !== undefined && process.env["FORCE_COLOR"] !== "0") return true;
  return pc.isColorSupported && process.stdout.isTTY === true;
}

let enabled = colourOn();

/** For tests: pin colour on or off. */
export function setColour(on: boolean): void {
  enabled = on;
}

export function colourEnabled(): boolean {
  return enabled;
}

/** The kit's colour table, verbatim (kit v4, tokens/design-tokens.css). */
export const BRAND_COLORS = {
  gullycoreBlue: "#00C878",
  deepBlue: "#005B39",
  signalBlue: "#2CF29A",
  void: "#0A0F0E",
  panel: "#1A1F1E",
  hairline: "#353F3D",
  ink: "#D0D5DA",
  muted: "#8FA09C",
  success: "#10B981",
} as const;

/** The three the terminal uses. */
export const KIT = {
  gullycoreBlue: BRAND_COLORS.gullycoreBlue,
  success: BRAND_COLORS.success,
  muted: BRAND_COLORS.muted,
} as const;

/** The one line every command opens with (never in --json). */
export const BRAND_LINE = "Gully Core by Gully Labs · built on PancakeSwap Infinity's audited core";

function rgb(hex: string): (text: string) => string {
  const n = Number.parseInt(hex.slice(1), 16);
  const open = `\u001B[38;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}m`;
  return (text) => (enabled ? `${open}${text}\u001B[39m` : text);
}

const accent = rgb(KIT.gullycoreBlue);
const green = rgb(KIT.success);
const grey = rgb(KIT.muted);

export const ui = {
  accent,
  success: green,
  muted: grey,
  bold: (t: string): string => (enabled ? pc.bold(t) : t),
  /** A step header: `Step 2 of 6 · Opening market cap`. */
  step: (index: number, total: number, title: string): string =>
    `${accent(enabled ? pc.bold(`Step ${index} of ${total}`) : `Step ${index} of ${total}`)} ${grey("·")} ${title}`,
} as const;

/** Removes ANSI escapes, for measuring and for tests. */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001B\[[0-9;]*m/g, "");
}
