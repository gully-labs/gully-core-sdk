// SPDX-License-Identifier: MIT
/**
 * `npm run gullycore:tenant` — turn the launch terms in `gullycore.config.ts` into the
 * `setTenantConfig` transaction that stores them on the shared `LaunchpadKitV2`.
 *
 * ---------------------------------------------------------------------------
 * WHY A TENANT CONFIG, WHEN DIRECT LAUNCHES ALREADY CARRY YOUR TERMS
 * ---------------------------------------------------------------------------
 *
 * Without one, the wizard sends `integrator = fee.wallet` and your bps and
 * launch fee as plain call arguments. That works, but it is enforced by
 * nothing: the numbers live in a TypeScript file, and a launcher who calls the
 * kit any other way names whatever integrator they like.
 *
 * A tenant config is the kit's own record of your terms, written by YOU (the
 * kit's owner cannot touch it) and restated by every launch that names you —
 * the kit reverts `TenantConfigMismatch` otherwise. It also lets you restrict
 * which presets, Bin shapes and quote currencies launches through your front
 * end may use. What it still does not do, stated plainly: a launcher who calls
 * the kit with `tenant = 0` pays you nothing. A tenant config is a policy for
 * launches that go through you, not a toll on the kit.
 *
 * ---------------------------------------------------------------------------
 * TWO KINDS OF TENANT, TWO TRANSACTIONS
 * ---------------------------------------------------------------------------
 *
 * When `chain.launchTenant` is a `GullyCorePad` (code at the address that answers
 * `owner()` and `KIT()`), the pad IS the tenant and its OWNER writes the terms:
 * this script prints `GullyCorePad.configure(config)` with `to` = the pad and the
 * sender = the pad's owner. The pad is the recommended form — the launchpad
 * changes hands with the pad, and its name and brand live on chain.
 *
 * Otherwise the tenant address IS whoever sends `setTenantConfig` on the kit,
 * so the sender must be the account you will then write into
 * `chain.launchTenant` — a key you control, or a Safe.
 *
 * ---------------------------------------------------------------------------
 * NOTHING HERE SENDS A TRANSACTION.
 * ---------------------------------------------------------------------------
 *
 * This script prints the target, the calldata and a `cast send` line for it;
 * you send it from wherever that key lives. It reads the caps off the kit
 * first and refuses to print a transaction that would revert.
 */

import { createPublicClient, encodeFunctionData, fallback, getAddress, http, parseAbi } from "viem";

import { bad, dim, heading, line, loadConfig, ok, warnColor } from "./lib/config.mjs";

const KIT_V2_ABI = parseAbi([
  "function clLocker() view returns (address)",
  "function maxIntegratorBps() view returns (uint16)",
  "function maxIntegratorLaunchFeeWei() view returns (uint256)",
  "function tenantConfig(address) view returns ((address integrator, uint16 integratorBps, uint96 integratorLaunchFeeWei, uint8 allowedPresets, uint8 allowedBinShapes, bool restrictQuotes, bool active, uint16 maxTaxBps, uint16 taxIntegratorBps, bool gullyTerms))",
  "function setTenantConfig((address integrator, uint16 integratorBps, uint96 integratorLaunchFeeWei, uint8 allowedPresets, uint8 allowedBinShapes, bool restrictQuotes, bool active, uint16 maxTaxBps, uint16 taxIntegratorBps, bool gullyTerms) c)",
]);
/* A `GullyCorePad` is recognised by code that answers BOTH owner() and KIT(). */
const PAD_PROBE_ABI = parseAbi([
  "function owner() view returns (address)",
  "function KIT() view returns (address)",
  "function name() view returns (string)",
]);

/* `enum Preset` and `enum BinShape`, declaration order = bit index. The masks
   below allow everything a launch can name; narrow them by editing the flags
   this script takes, never by guessing a bit. */
const PRESETS = ["Custom", "FairLaunch", "AntiSniperAggressive", "Stealth", "NoTax"];
const BIN_SHAPES = ["Custom", "Flat", "Linear", "Exponential", "Stepped"];

function flag(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) {
    const inline = process.argv.find((a) => a.startsWith(`--${name}=`));
    return inline === undefined ? undefined : inline.slice(name.length + 3);
  }
  const next = process.argv[index + 1];
  return next === undefined || next.startsWith("--") ? true : next;
}

function maskOf(names, all, label) {
  let mask = 0;
  for (const name of names) {
    const i = all.indexOf(name);
    if (i === -1) throw new Error(`${label}: "${name}" is not one of ${all.join(", ")}`);
    mask |= 1 << i;
  }
  return mask;
}

const USAGE = `
gullycore:tenant — print the setTenantConfig transaction for your terms.

  npm run gullycore:tenant                                  all presets and shapes allowed, quotes unrestricted
  npm run gullycore:tenant -- --presets FairLaunch,NoTax    allow only these presets (names from LaunchPresets)
  npm run gullycore:tenant -- --shapes Flat,Linear          allow only these Bin shapes (empty = no Bin legs)
  npm run gullycore:tenant -- --restrict-quotes             only quotes you later allow with setTenantQuote
  npm run gullycore:tenant -- --deactivate                  print the transaction that switches your tenant off

Terms come from gullycore.config.ts: fee.wallet, launch.integratorBps, launch.integratorLaunchFeeWei.
When chain.launchTenant is a GullyCorePad, the transaction printed is GullyCorePad.configure, sent by the pad's owner.
No flag sends a transaction. This script has no signer and no private key path.
`;

async function main() {
  if (flag("help") !== undefined || flag("h") !== undefined) {
    process.stdout.write(USAGE);
    return;
  }
  const { config, deployments } = await loadConfig();
  const chainId = config.chain.id;
  const core = deployments[chainId];
  if (core === undefined) throw new Error(`No Gully Core core is recorded for chain ${chainId}.`);

  const kitAddress = config.chain.launchpadKitV2 ?? core.launchpadV2?.launchpadKitV2 ?? null;
  if (kitAddress === null) {
    throw new Error(
      "No LaunchpadKitV2 to write a tenant config to: chain.launchpadKitV2 is null and the SDK address book " +
        "has no shared kit on this chain. There is nothing to configure yet.",
    );
  }
  const kit = getAddress(kitAddress);

  const wallet = config.fee.wallet === null ? null : getAddress(config.fee.wallet);
  const launch = config.launch;
  if (launch === undefined) throw new Error("gullycore.config.ts has no `launch` block; copy it from the template.");
  const integratorBps = Number(launch.integratorBps);
  const integratorLaunchFeeWei = BigInt(launch.integratorLaunchFeeWei);
  const deactivate = flag("deactivate") !== undefined;

  if (!deactivate && (integratorBps > 0 || integratorLaunchFeeWei > 0n) && (wallet === null || /^0x0{40}$/.test(wallet))) {
    throw new Error("launch.* takes a share but fee.wallet is not set; a tenant config paying the zero address is refused by the kit.");
  }

  const { CHAIN_RPCS, GULLYCORE_PAD_ABI } = await import("@gullylabs/core-sdk");
  const urls = [
    ...(config.chain.rpcUrls ?? []),
    ...(Object.values(CHAIN_RPCS).find((c) => c.chainId === chainId)?.endpoints.map((e) => e.url) ?? []),
  ];
  const client = createPublicClient({
    transport: fallback(urls.map((u) => http(u, { timeout: 12_000, retryCount: 0 })), { rank: false, retryCount: 2 }),
  });

  heading(`Caps on ${kit}`);
  const [maxBps, maxFee] = await Promise.all([
    client.readContract({ address: kit, abi: KIT_V2_ABI, functionName: "maxIntegratorBps" }).catch(() => null),
    client.readContract({ address: kit, abi: KIT_V2_ABI, functionName: "maxIntegratorLaunchFeeWei" }).catch(() => null),
  ]);
  if (maxBps === null || maxFee === null) throw new Error(`${kit} does not answer the LaunchpadKitV2 ABI.`);
  line("ok", "maxIntegratorBps", String(maxBps));
  line("ok", "maxIntegratorLaunchFeeWei", `${maxFee} wei`);
  if (integratorBps > Number(maxBps)) throw new Error(`launch.integratorBps ${integratorBps} is above the cap ${maxBps}; the kit would revert IntegratorBpsTooHigh.`);
  if (integratorLaunchFeeWei > maxFee) throw new Error(`launch.integratorLaunchFeeWei ${integratorLaunchFeeWei} is above the cap ${maxFee}; the kit would revert IntegratorFeeAboveCap.`);

  const presetsFlag = flag("presets");
  const shapesFlag = flag("shapes");
  const allowedPresets = typeof presetsFlag === "string" ? maskOf(presetsFlag.split(",").map((s) => s.trim()).filter(Boolean), PRESETS, "--presets") : (1 << PRESETS.length) - 1;
  const allowedBinShapes =
    typeof shapesFlag === "string"
      ? maskOf(shapesFlag.split(",").map((s) => s.trim()).filter(Boolean), BIN_SHAPES, "--shapes")
      : (1 << BIN_SHAPES.length) - 1;
  if (allowedPresets === 0) throw new Error("--presets must allow at least one preset, or no launch through you can ever be created.");

  const c = {
    integrator: wallet ?? "0x0000000000000000000000000000000000000000",
    integratorBps: deactivate ? 0 : integratorBps,
    integratorLaunchFeeWei: deactivate ? 0n : integratorLaunchFeeWei,
    allowedPresets,
    allowedBinShapes,
    restrictQuotes: flag("restrict-quotes") !== undefined,
    active: !deactivate,
    maxTaxBps: 0,
    taxIntegratorBps: 0,
    /* Only a Launchpad the Gully Safe designated can use this. Yours pays the flat 0.30% of every trade and nothing else. */
    gullyTerms: false,
  };
  /* Pad or wallet? Decided by what is at chain.launchTenant, never by the config's say-so. */
  let pad = null;
  if (config.chain.launchTenant !== null) {
    const tenant = getAddress(config.chain.launchTenant);
    const code = await client.getCode({ address: tenant }).catch(() => undefined);
    if (code !== undefined && code !== "0x") {
      const [owner, padKit, name] = await Promise.all([
        client.readContract({ address: tenant, abi: PAD_PROBE_ABI, functionName: "owner" }).catch(() => null),
        client.readContract({ address: tenant, abi: PAD_PROBE_ABI, functionName: "KIT" }).catch(() => null),
        client.readContract({ address: tenant, abi: PAD_PROBE_ABI, functionName: "name" }).catch(() => null),
      ]);
      if (owner !== null && padKit !== null) {
        if (getAddress(padKit) !== kit) {
          throw new Error(
            `chain.launchTenant ${tenant} is a GullyCorePad bound to kit ${padKit}, not chain.launchpadKitV2 ${kit}. ` +
              "Its terms live on that other kit; point chain.launchpadKitV2 at it or create a pad on this one.",
          );
        }
        if (getAddress(c.integrator) === tenant) {
          throw new Error("fee.wallet is the pad itself; the pad reverts PadCannotBeIntegrator. Name the wallet fees should reach.");
        }
        pad = { address: tenant, owner: getAddress(owner), name: name ?? "(name unreadable)" };
      } else {
        line("warn", "chain.launchTenant", `${tenant} has code but does not answer the GullyCorePad ABI; printing setTenantConfig for it as a plain tenant`);
      }
    }
  }

  const data =
    pad === null
      ? encodeFunctionData({ abi: KIT_V2_ABI, functionName: "setTenantConfig", args: [c] })
      : encodeFunctionData({ abi: GULLYCORE_PAD_ABI, functionName: "configure", args: [c] });

  heading("Your terms, as the kit will store them");
  line("ok", "integrator", c.integrator);
  line("ok", "integratorBps", `${c.integratorBps} (${(c.integratorBps / 100).toFixed(2)}% of every launch's trading fee)`);
  line("ok", "integratorLaunchFeeWei", `${c.integratorLaunchFeeWei} wei per launch`);
  line("ok", "allowedPresets", PRESETS.filter((_, i) => ((allowedPresets >> i) & 1) === 1).join(", "));
  line("ok", "allowedBinShapes", BIN_SHAPES.filter((_, i) => ((allowedBinShapes >> i) & 1) === 1).join(", ") || "none (no Bin legs)");
  line("ok", "restrictQuotes", String(c.restrictQuotes));
  line(c.active ? "ok" : "warn", "active", String(c.active));

  if (config.chain.launchTenant !== null) {
    const tenant = getAddress(config.chain.launchTenant);
    const stored = await client.readContract({ address: kit, abi: KIT_V2_ABI, functionName: "tenantConfig", args: [tenant] }).catch(() => null);
    if (stored !== null) {
      heading(`Currently stored for ${tenant}`);
      line(stored.active ? "ok" : "warn", "active", String(stored.active));
      line("ok", "integrator", stored.integrator);
      line("ok", "integratorBps", String(stored.integratorBps));
      line("ok", "integratorLaunchFeeWei", `${stored.integratorLaunchFeeWei} wei`);
    }
  }

  heading("The transaction");
  if (pad !== null) {
    process.stdout.write(
      `  GullyCorePad.configure on "${pad.name}"\n  to     ${pad.address}\n  from   ${pad.owner}  (the pad's owner; the pad reverts NotOwner for anyone else)\n  value  0\n  data   ${data}\n\n`,
    );
    process.stdout.write(dim("  The pad is the tenant; chain.launchTenant already names it. With foundry, from the owner's key:\n\n"));
    process.stdout.write(`    cast send ${pad.address} ${data} --rpc-url <your rpc> --private-key <the pad owner's key>\n\n`);
    process.stdout.write(
      dim(
        "  If the owner is a Safe, queue the same calldata there. Quotes under --restrict-quotes are allowed one by one\n" +
          "  with GullyCorePad.setQuote(quote, true), also owner-only.\n" +
          "  A later change to launch.* in gullycore.config.ts needs this again: the kit sends the STORED values\n" +
          "  and refuses a launch that restates them differently.\n",
      ),
    );
  } else {
    process.stdout.write(`  to     ${kit}\n  value  0\n  data   ${data}\n\n`);
    process.stdout.write(
      dim(
        "  Send it FROM the account you will write into chain.launchTenant — the sender IS the tenant.\n" +
          "  With foundry, from that key:\n\n",
      ),
    );
    process.stdout.write(`    cast send ${kit} ${data} --rpc-url <your rpc> --private-key <the tenant key>\n\n`);
    process.stdout.write(
      dim(
        "  Then:  npm run gullycore:deploy -- --tenant <that address>\n" +
          "  A later change to launch.* in gullycore.config.ts needs this again: the kit sends the STORED values\n" +
          "  and refuses a launch that restates them differently.\n",
      ),
    );
  }
  process.stdout.write(`\n${warnColor("No transaction was sent.")} ${ok("Nothing above was guessed: caps were read off the kit.")}\n`);
}

main().catch((err) => {
  process.stderr.write(`${bad("x")} ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
