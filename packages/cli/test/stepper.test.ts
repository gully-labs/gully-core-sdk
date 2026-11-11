import { PassThrough, Writable } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import { stripAnsi } from "../src/lib/brand.js";
import { BACK, askSelect, askText, runSteps, setPromptIO, type Step } from "../src/lib/prompt.js";

/** A fake terminal: keys go in, the rendered screen is collected. */
function terminal(): { input: PassThrough; output: Writable; screen: () => string } {
  const input = new PassThrough() as PassThrough & { isTTY?: boolean; setRawMode?: (b: boolean) => void };
  input.isTTY = true;
  input.setRawMode = () => undefined;
  let text = "";
  const output = new Writable({
    write(chunk: Buffer, _enc, cb) {
      text += chunk.toString();
      cb();
    },
  }) as Writable & { isTTY?: boolean; columns?: number; rows?: number };
  output.isTTY = true;
  output.columns = 100;
  output.rows = 40;
  return { input, output, screen: () => stripAnsi(text) };
}

/** Types each chunk after a pause, the way a person (or a pty script) would. */
async function type(input: PassThrough, chunks: readonly string[], gapMs = 40): Promise<void> {
  for (const c of chunks) {
    await new Promise((r) => setTimeout(r, gapMs));
    input.write(c);
  }
}

afterEach(() => setPromptIO({}));

interface S {
  name: string;
  kind: string;
  cap: string;
}

describe("stepper", () => {
  it("numbers steps, goes back with <, keeps earlier answers as defaults", async () => {
    const t = terminal();
    setPromptIO({ input: t.input, output: t.output });
    const visits: string[] = [];
    const steps: Step<S>[] = [
      {
        title: "Token",
        run: async (s) => {
          visits.push("Token");
          const v = await askText({ message: "Token name", defaultValue: s.name || undefined });
          if (v === BACK) return BACK;
          s.name = v;
          return undefined;
        },
      },
      {
        title: "Pool",
        run: async (s) => {
          visits.push("Pool");
          const v = await askSelect({ message: "Pool type", options: [{ value: "CL", label: "CL" }, { value: "Bin", label: "Bin" }], initial: s.kind, back: true });
          if (v === BACK) return BACK;
          s.kind = v;
          return undefined;
        },
      },
      {
        title: "Opening market cap",
        run: async (s) => {
          visits.push("Cap");
          const v = await askText({ message: "Market cap", defaultValue: s.cap, back: true });
          if (v === BACK) return BACK;
          s.cap = v;
          return undefined;
        },
      },
    ];
    const state: S = { name: "", kind: "CL", cap: "3500" };
    const done = runSteps(steps, state);
    await type(t.input, [
      "Mochi\r", // Token
      "\u001b[B\r", // Pool: down to Bin
      "<\r", // Cap: back
      "\u001b[A\r", // Pool again: up to CL
      "\r", // Cap: accept default 3500
    ]);
    await done;
    expect(state).toEqual({ name: "Mochi", kind: "CL", cap: "3500" });
    expect(visits).toEqual(["Token", "Pool", "Cap", "Pool", "Cap"]);
    const screen = t.screen();
    expect(screen).toContain("Step 1 of 3 · Token");
    expect(screen).toContain("Step 2 of 3 · Pool");
    expect(screen).toContain("Step 3 of 3 · Opening market cap");
    expect(screen).toContain("(< back)");
    expect(screen).toContain("Back");
  });

  it("validates inline and does not advance on a refused value", async () => {
    const t = terminal();
    setPromptIO({ input: t.input, output: t.output });
    let got = "";
    const p = askText({ message: "Supply", validate: (v) => (/^\d+$/.test(v) ? undefined : "a whole number") }).then((v) => {
      got = v === BACK ? "BACK" : v;
    });
    await type(t.input, ["abc\r", "\u0008\u0008\u0008", "42\r"]);
    await p;
    expect(got).toBe("42");
    expect(t.screen()).toContain("a whole number");
  });
});
