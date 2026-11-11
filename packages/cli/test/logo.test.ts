import { afterEach, describe, expect, it } from "vitest";

import { KIT, setColour, stripAnsi } from "../src/lib/brand.js";
import { logoMode, markRows, renderLogo } from "../src/lib/logo.js";
import { GC_ICON_SVG_B64, ICON_PNG, MARK } from "../src/lib/logo.generated.js";

const KEYS = ["GULLYCORE_LOGO", "CI", "TERM_PROGRAM", "KITTY_WINDOW_ID", "TERM", "LC_TERMINAL", "GHOSTTY_RESOURCES_DIR"];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
const tty = { isTTY: true } as NodeJS.WriteStream;
const pipe = { isTTY: false } as NodeJS.WriteStream;

function env(vars: Record<string, string>): void {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, vars);
}

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  setColour(true);
});

describe("logo: Gully Core's own", () => {
  it("carries no trace of the old blue palette", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    const dir = new URL("../src/lib/", import.meta.url);
    for (const f of readdirSync(dir)) expect(readFileSync(new URL(f, dir), "utf8"), f).not.toMatch(/2b8bff/i);
    expect(KIT.gullycoreBlue).toBe("#00C878");
  });
  it("carries the kit's gc-icon.svg byte for byte, the hash the kit-v4 records", async () => {
    const { createHash } = await import("node:crypto");
    const { existsSync, readFileSync } = await import("node:fs");
    const bytes = Buffer.from(GC_ICON_SVG_B64, "base64");
    expect(createHash("sha256").update(bytes).digest("hex").slice(0, 12)).toBe("4f86d2a0c2bb");
    const kit = new URL("../../../apps/web/public/identity/gc-icon.svg", import.meta.url);
    if (existsSync(kit)) expect(bytes.equals(readFileSync(kit))).toBe(true);
  });
  it("renders that file: a real PNG, and an emerald mark in the blocks", () => {
    expect(Buffer.from(ICON_PNG, "base64").subarray(1, 4).toString("latin1")).toBe("PNG");
    const pixels = MARK.join(",").split(",").filter(Boolean);
    expect(pixels.length).toBeGreaterThan(20);
    for (const hex of pixels) {
      const [r, g, b] = [hex.slice(0, 2), hex.slice(2, 4), hex.slice(4, 6)].map((h) => Number.parseInt(h, 16)) as [number, number, number];
      expect(g, hex).toBeGreaterThan(r);
      expect(g, hex).toBeGreaterThan(b);
    }
  });
});

describe("logo: never where it could reach a parser", () => {
  it("is off when the stream is not a TTY", () => {
    env({});
    setColour(true);
    expect(logoMode(pipe)).toBe("off");
    expect(renderLogo(pipe)).toBe("");
  });
  it("is off when colour is off (NO_COLOR, TERM=dumb)", () => {
    env({});
    setColour(false);
    expect(logoMode(tty)).toBe("off");
  });
  it("is off under CI unless explicitly forced", () => {
    env({ CI: "true" });
    setColour(true);
    expect(logoMode(tty)).toBe("off");
    env({ CI: "true", GULLYCORE_LOGO: "blocks" });
    expect(logoMode(tty)).toBe("blocks");
  });
  it("GULLYCORE_LOGO=off wins over everything", () => {
    env({ GULLYCORE_LOGO: "off", TERM_PROGRAM: "iTerm.app" });
    setColour(true);
    expect(logoMode(tty)).toBe("off");
  });
});

describe("logo: A (image protocol) where the terminal has one, B (blocks) elsewhere", () => {
  it("uses Kitty graphics in Kitty and Ghostty", () => {
    setColour(true);
    env({ KITTY_WINDOW_ID: "1" });
    expect(logoMode(tty)).toBe("kitty");
    env({ TERM_PROGRAM: "ghostty" });
    expect(logoMode(tty)).toBe("kitty");
    expect(renderLogo(tty, "kitty")).toMatch(/^\u001B_Ga=T,f=100,t=d,c=\d+/);
  });
  it("uses iTerm2 inline images in iTerm2 and WezTerm", () => {
    setColour(true);
    env({ TERM_PROGRAM: "iTerm.app" });
    expect(logoMode(tty)).toBe("iterm");
    env({ TERM_PROGRAM: "WezTerm" });
    expect(logoMode(tty)).toBe("iterm");
    expect(renderLogo(tty, "iterm")).toMatch(/^\u001B\]1337;File=inline=1;/);
  });
  it("falls back to blocks in any other colour terminal", () => {
    setColour(true);
    env({ TERM_PROGRAM: "vscode" });
    expect(logoMode(tty)).toBe("blocks");
  });
});

describe("logo: the block rendering is the kit mark, two pixels per cell", () => {
  it("has one row per two pixel rows, and the wordmark beside it", () => {
    setColour(true);
    env({});
    expect(markRows()).toHaveLength(MARK.length / 2);
    const plain = stripAnsi(renderLogo(tty, "blocks"));
    expect(plain).toContain("Gully Core");
    expect(plain).not.toMatch(/latch|deepcore|protocol/i);
    expect(plain).toMatch(/[▀▄]/);
  });
});
