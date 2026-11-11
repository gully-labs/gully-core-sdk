import { describe, expect, it } from "vitest";

import { parseCommand } from "../src/lib/command.js";
import { LAUNCH_SPEC } from "../src/commands/launch.js";
import { refuseRawKeys, signModeOf } from "../src/lib/tx.js";
import { parseArgs } from "../src/util/args.js";
import { SIGNER_FLAGS } from "../src/lib/tx.js";

const KEY = "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

describe("gullycore never takes a raw key", () => {
  for (const flag of ["--private-key", "--privateKey", "--private_key", "--pk", "--key", "--mnemonic", "--seed", "--seed-phrase", "--secret"]) {
    it(`refuses ${flag} by name, with or without =`, () => {
      expect(() => refuseRawKeys([flag, `0x${KEY}`])).toThrow(/refused/);
      expect(() => refuseRawKeys([`${flag}=0x${KEY}`])).toThrow(/refused/);
    });
  }

  it("refuses a key-shaped value after any flag that is not a declared bytes32 flag", () => {
    expect(() => refuseRawKeys(["--name", `0x${KEY}`])).toThrow(/looks like a private key/);
    expect(() => refuseRawKeys(["--name", KEY])).toThrow(/looks like a private key/);
    expect(() => refuseRawKeys([`0x${KEY}`])).toThrow(/looks like a private key/);
    expect(() => refuseRawKeys([`--symbol=0x${KEY}`])).toThrow(/looks like a private key/);
  });

  it("refuses a mnemonic passed as a value", () => {
    expect(() => refuseRawKeys(["--name", "test test test test test test test test test test test junk"])).toThrow(/mnemonic/);
  });

  it("allows 32-byte values after flags that legitimately take one", () => {
    expect(() => refuseRawKeys(["--salt", `0x${KEY}`], new Set(["salt"]))).not.toThrow();
    expect(() => refuseRawKeys([`--salt=0x${KEY}`], new Set(["salt"]))).not.toThrow();
  });

  it("the launch command refuses before parsing anything", () => {
    expect(() => parseCommand(["--chain", "sepolia", "--private-key", KEY], LAUNCH_SPEC)).toThrow(/refused/);
  });

  it("defaults to --print and pairs --password-file with --keystore", () => {
    expect(signModeOf(parseArgs([], SIGNER_FLAGS)).kind).toBe("print");
    expect(signModeOf(parseArgs(["--keystore", "k.json"], SIGNER_FLAGS))).toEqual({ kind: "keystore", path: "k.json", passwordFile: null });
    expect(() => signModeOf(parseArgs(["--password-file", "p"], SIGNER_FLAGS))).toThrow(/needs --keystore/);
    expect(() => signModeOf(parseArgs(["--keystore", "k", "--print"], SIGNER_FLAGS))).toThrow(/exclusive/);
  });

  it("never reads PRIVATE_KEY from the environment", async () => {
    const src = await import("node:fs").then((fs) =>
      ["tx.ts", "keystore.ts", "chain.ts", "flow.ts"].map((f) => fs.readFileSync(new URL(`../src/lib/${f}`, import.meta.url), "utf8")).join("\n"),
    );
    expect(src).not.toMatch(/env\[?["'.]?PRIVATE_KEY/);
  });
});
