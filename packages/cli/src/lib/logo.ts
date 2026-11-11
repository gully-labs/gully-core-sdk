// SPDX-License-Identifier: MIT
/**
 * The Gully Core mark in the terminal, "A with B as the fallback".
 *
 *   A  terminals with an inline-image protocol (Kitty graphics: Kitty, Ghostty, WezTerm; iTerm2's
 *      OSC 1337: iTerm2, WezTerm) draw kit v4's gc-icon.svg, rendered to PNG because none of them draws SVG.
 *   B  every other colour terminal gets that file rendered as 24-bit half-blocks, with "Gully Core" set
 *      beside it.
 *   —  nothing at all when colour is off (NO_COLOR, TERM=dumb, not a TTY), under CI, or when the
 *      caller is producing --json. A logo is decoration and must never reach a pipe or a parser.
 *
 * Both come from `logo.generated.ts`, which scripts/gen-logo.mjs builds from the kit file, which it also
 * carries byte-identical, so the terminal renders that file rather than a redraw.
 *
 * GULLYCORE_LOGO=off|image|blocks overrides the detection.
 */

import { colourEnabled, ui } from "./brand.js";
import { ICON_PNG, MARK } from "./logo.generated.js";

type Mode = "off" | "kitty" | "iterm" | "blocks";

const env = (k: string): string => process.env[k] ?? "";

/** Width, in terminal columns, the inline lockup is drawn at. */
export const LOCKUP_COLS = 12;

export function logoMode(stream: NodeJS.WriteStream = process.stdout): Mode {
  const forced = env("GULLYCORE_LOGO").toLowerCase();
  if (forced === "off" || forced === "none" || forced === "0") return "off";
  if (!colourEnabled() || stream.isTTY !== true) return "off";
  if (env("CI") !== "" && forced === "") return "off";
  if (forced === "blocks") return "blocks";
  const program = env("TERM_PROGRAM");
  const kitty = env("KITTY_WINDOW_ID") !== "" || env("TERM") === "xterm-kitty" || program === "ghostty" || env("GHOSTTY_RESOURCES_DIR") !== "";
  const iterm = program === "iTerm.app" || env("LC_TERMINAL") === "iTerm2" || program === "WezTerm";
  if (forced === "image") return kitty ? "kitty" : "iterm";
  if (kitty) return "kitty";
  if (iterm) return "iterm";
  return "blocks";
}

function kittyImage(b64: string): string {
  // Kitty graphics: PNG (f=100), transmitted directly (t=d), displayed now (a=T), scaled to c columns.
  // Payloads over 4096 bytes are chunked with m=1 / m=0.
  const chunks = b64.match(/.{1,4096}/g) ?? [];
  return chunks
    .map((chunk, i) => {
      const last = i === chunks.length - 1;
      const head = i === 0 ? `a=T,f=100,t=d,c=${LOCKUP_COLS},q=2,m=${last ? 0 : 1}` : `m=${last ? 0 : 1}`;
      return `\u001B_G${head};${chunk}\u001B\\`;
    })
    .join("");
}

function itermImage(b64: string): string {
  const size = Math.floor((b64.length * 3) / 4);
  return `\u001B]1337;File=inline=1;size=${size};width=${LOCKUP_COLS};preserveAspectRatio=1:${b64}\u0007`;
}

const fg = (hex: string): string => `\u001B[38;2;${parseInt(hex.slice(0, 2), 16)};${parseInt(hex.slice(2, 4), 16)};${parseInt(hex.slice(4, 6), 16)}m`;
const bg = (hex: string): string => `\u001B[48;2;${parseInt(hex.slice(0, 2), 16)};${parseInt(hex.slice(2, 4), 16)};${parseInt(hex.slice(4, 6), 16)}m`;
const RESET = "\u001B[0m";

/** The mark as half-block rows: each character is two vertical pixels (upper = fg ▀, lower = bg). */
export function markRows(): string[] {
  const px = MARK.map((row) => row.split(","));
  const rows: string[] = [];
  for (let y = 0; y + 1 < px.length; y += 2) {
    const top = px[y] ?? [];
    const bottom = px[y + 1] ?? [];
    let line = "";
    for (let x = 0; x < top.length; x++) {
      const t = top[x] ?? "";
      const b = bottom[x] ?? "";
      if (t === "" && b === "") line += " ";
      else if (t !== "" && b === "") line += `${fg(t)}▀${RESET}`;
      else if (t === "" && b !== "") line += `${fg(b)}▄${RESET}`;
      else line += `${fg(t)}${bg(b)}▀${RESET}`;
    }
    rows.push(line);
  }
  return rows;
}

/** The logo as a string for `stream`, or "" when none should be shown. */
export function renderLogo(stream: NodeJS.WriteStream = process.stdout, mode: Mode = logoMode(stream)): string {
  if (mode === "off") return "";
  if (mode === "kitty") return `${kittyImage(ICON_PNG)}\n`;
  if (mode === "iterm") return `${itermImage(ICON_PNG)}\n`;
  const rows = markRows();
  const mid = Math.floor(rows.length / 2);
  const beside: Record<number, string> = {
    [mid - 1]: ui.bold("Gully Core"),
    [mid]: ui.accent("by Gully Labs"),
    [mid + 1]: ui.muted("built on PancakeSwap Infinity's audited core"),
  };
  return `${rows.map((r, i) => `  ${r}${beside[i] !== undefined ? `   ${beside[i]}` : ""}`).join("\n")}\n`;
}

/** Writes the logo once per process, before an interactive flow or the help screen. */
let shown = false;
export function printLogo(stream: NodeJS.WriteStream = process.stdout): void {
  if (shown) return;
  shown = true;
  const out = renderLogo(stream);
  if (out !== "") stream.write(`\n${out}\n`);
}
