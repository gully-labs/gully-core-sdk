/* PR #14's guard (apps/web/test/brandSweep.test.ts) leaves packages/cli out, so this package holds itself to
   the same lists: the old blue identity's values, its typefaces, and the kit's table as the notifier has it. */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { BRAND_COLORS, KIT } from "../src/lib/brand.js";

const CLI = fileURLToPath(new URL("..", import.meta.url));
const SKIP = /\.test\.ts$|logo\.generated\.ts$/;
const OLD_VALUES = ["2b8bff", "0a63e0", "4a9bff", "8fc2ff", "3f8ff0", "6c5cff", "04060c", "070c17", "080e1a", "061024", "16223a", "e4ecf9", "8a9bb6", "61789c", "37d6c4", "5fd39a"];

function walk(path: string): string[] {
  if (statSync(path).isFile()) return SKIP.test(path) || !/\.(css|ts|tsx|mjs|md|sol|toml)$/.test(path) ? [] : [path];
  return readdirSync(path).flatMap((f) => (f === "node_modules" || f === "dist" ? [] : walk(join(path, f))));
}
const files = ["src", "assets", "scripts", "README.md"].flatMap((p) => walk(join(CLI, p)));

describe("the old brand stays out of packages/cli", () => {
  it("scans real files", () => {
    expect(files.length).toBeGreaterThan(40);
  });
  it("has no old palette value", () => {
    const pattern = new RegExp(`(?:#|0x)(?:${OLD_VALUES.join("|")})\\b`, "gi");
    expect(files.filter((f) => pattern.test(readFileSync(f, "utf8")))).toEqual([]);
  });
  it("has no old face and no old colour name", () => {
    expect(files.filter((f) => /Chakra Petch|IBM Plex|Gully Core Blue/.test(readFileSync(f, "utf8")))).toEqual([]);
  });
});

describe("the kit's colours", () => {
  it("are the notifier's table, value for value", () => {
    expect(BRAND_COLORS).toEqual({
      gullycoreBlue: "#00C878",
      deepBlue: "#005B39",
      signalBlue: "#2CF29A",
      void: "#0A0F0E",
      panel: "#1A1F1E",
      hairline: "#353F3D",
      ink: "#D0D5DA",
      muted: "#8FA09C",
      success: "#10B981",
    });
  });
  it("match the notifier's file once #14 is in this tree", () => {
    const notifier = join(CLI, "..", "notifier", "src", "brand.ts");
    if (!existsSync(notifier)) return;
    const text = readFileSync(notifier, "utf8");
    if (!text.includes("#00C878")) return;
    for (const value of Object.values(BRAND_COLORS)) expect(text).toContain(value);
  });
  it("are what the terminal uses", () => {
    expect(KIT).toEqual({ gullycoreBlue: "#00C878", success: "#10B981", muted: "#8FA09C" });
  });
});
