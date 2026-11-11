// SPDX-License-Identifier: MIT
/**
 * `npm run gullycore:verify` — read every configured address back off the chain.
 *
 * An address book is a claim. This turns each claim into a fact or a failure,
 * before a user ever loads the app:
 *
 *   * does the address have code?
 *   * is the CL pool manager actually a registered app on that Vault? (if not,
 *     nothing works, and the failure at swap time is opaque)
 *   * is a protocol fee controller wired, and what would a pool pay today?
 *   * do the configured tokens agree with their own contracts?
 *   * is the launchpad kit real, pointed at THIS core, and running the hook
 *     bitmap the kit expects?
 *
 * It sends nothing. Every call here is `eth_call` or `eth_getCode`.
 */

import { createPublicClient, decodeAbiParameters, erc20Abi, http, fallback, parseAbi, getAddress } from "viem";

import { bad, dim, heading, line, loadConfig, ok } from "./lib/config.mjs";

const VAULT_ABI = parseAbi([
  "function isAppRegistered(address) view returns (bool)",
  "function owner() view returns (address)",
]);
const MANAGER_ABI = parseAbi(["function protocolFeeController() view returns (address)"]);
const CONTROLLER_ABI = parseAbi([
  "function defaultFee() view returns (bool isSet, uint16 zeroForOne, uint16 oneForZero)",
  "function feesDisabled() view returns (bool)",
]);
const REGISTRY_ABI = parseAbi(["function gullycoreCount() view returns (uint256)"]);
/* The UniversalRouter's readable surface. `vault()` is the public immutable it
   inherits from periphery's ImmutableState and is the one that matters: a
   router bound to a DIFFERENT Vault encodes and sends perfectly well and
   settles nothing this app can see. `paused()` and `owner()` come from the
   router's own Pausable/Ownable — a paused router reverts every swap, and its
   owner is whoever can do that to you. */
const ROUTER_ABI = parseAbi([
  "function vault() view returns (address)",
  "function paused() view returns (bool)",
  "function owner() view returns (address)",
]);
const KIT_ABI = parseAbi([
  "function hook() view returns (address)",
  "function clPoolManager() view returns (address)",
  "function positionManager() view returns (address)",
  "function permit2() view returns (address)",
  "function registry() view returns (address)",
  "function hookBitmap() view returns (uint16)",
  "function EXPECTED_HOOK_BITMAP() view returns (uint16)",
]);
/* Only the block-numbered (retired) kit has this getter. */
const BLOCK_KIT_ABI = parseAbi(["function blockTimeCentis() view returns (uint32)"]);
const KIT_V2_ABI = parseAbi([
  "function clPoolManager() view returns (address)",
  "function binPoolManager() view returns (address)",
  "function clHook() view returns (address)",
  "function binHook() view returns (address)",
  "function clLocker() view returns (address)",
  "function binLocker() view returns (address)",
  "function tokenFactory() view returns (address)",
  "function maxLegs() view returns (uint8)",
  "function maxBinsPerLeg() view returns (uint16)",
  "function launchFeeWei() view returns (uint256)",
  "function maxIntegratorLaunchFeeWei() view returns (uint256)",
  "function owner() view returns (address)",
  "function tenantConfig(address) view returns ((address integrator, uint16 integratorBps, uint96 integratorLaunchFeeWei, uint8 allowedPresets, uint8 allowedBinShapes, bool restrictQuotes, bool active, uint16 maxTaxBps, uint16 taxIntegratorBps, bool gullyTerms))",
]);
const GUARD_ABI = parseAbi(["function LAUNCH_TOKEN_FACTORY() view returns (address)"]);
/* `GullyCorePad`: a transferable kit tenant with an on-chain brand. `chain.launchTenant`
   may be one; a pad is recognised by code at the address that answers BOTH
   `owner()` and `KIT()`, never by name alone. */
const PAD_ABI = parseAbi([
  "function owner() view returns (address)",
  "function KIT() view returns (address)",
  "function name() view returns (string)",
]);
const LOCKER_ABI = parseAbi([
  "function maxIntegratorBps() view returns (uint16)",
  "function protocolRecipient() view returns (address)",
]);
/* ERC-6372 `CLOCK_MODE()`. Only the timestamp-clocked kit and hook answer it. */
const CLOCK_MODE_CALLDATA = "0x4bf5d7e9";

/** "timestamp", "contract-block" (reverted), "unknown:<mode>", or null on a transport failure. */
async function probeClock(client, address) {
  try {
    const { data } = await client.call({ to: address, data: CLOCK_MODE_CALLDATA });
    if (data === undefined || data === "0x") return "contract-block";
    const [mode] = decodeAbiParameters([{ type: "string" }], data);
    return mode === "mode=timestamp" ? "timestamp" : `unknown:${mode}`;
  } catch (err) {
    for (let e = err; e; e = e.cause) {
      if (/revert/i.test(String(e.shortMessage ?? e.message ?? ""))) return "contract-block";
    }
    return null;
  }
}

const ZERO = "0x0000000000000000000000000000000000000000";
let failures = 0;
let warnings = 0;

function fail(label, detail) {
  failures += 1;
  line("fail", label, detail);
}
function warn(label, detail) {
  warnings += 1;
  line("warn", label, detail);
}
function pass(label, detail) {
  line("ok", label, detail);
}

async function main() {
  const { config, deployments } = await loadConfig();
  const chainId = config.chain.id;
  const known = deployments[chainId];

  heading(`Verifying ${config.brand.name} against chain ${chainId}`);

  if (known === undefined) {
    const { chainById } = await import("@gullylabs/core-sdk");
    const listed = chainById(chainId);
    if (listed !== undefined) {
      fail(
        "chain.id",
        `Gully Core is not deployed on ${listed.name} (${chainId}) yet: the SDK lists the chain but its address book ` +
          "records no contract there. The app renders one \"not deployed\" page; there is nothing to verify until " +
          "@gullylabs/core-sdk records the chain.",
      );
    } else {
      fail("chain.id", `no Gully Core core is recorded for chain ${chainId}`);
    }
    return finish();
  }

  const { CHAIN_RPCS } = await import("@gullylabs/core-sdk");
  const publicRpcs =
    Object.values(CHAIN_RPCS).find((c) => c.chainId === chainId)?.endpoints.map((e) => e.url) ?? [];
  const urls = [...(config.chain.rpcUrls ?? []), ...publicRpcs];
  if (urls.length === 0) {
    fail("rpc", `no endpoint known for chain ${chainId}; set chain.rpcUrls`);
    return finish();
  }

  const client = createPublicClient({
    transport: fallback(
      urls.map((u) => http(u, { timeout: 12_000, retryCount: 0 })),
      { rank: false, retryCount: 2 },
    ),
  });

  const liveChainId = await client.getChainId().catch(() => null);
  if (liveChainId === null) {
    fail("rpc", `none of the ${urls.length} endpoints answered`);
    return finish();
  }
  if (liveChainId !== chainId) {
    fail("rpc", `endpoints answer chain ${liveChainId}, config says ${chainId}`);
    return finish();
  }
  pass("rpc", `${urls.length} endpoint(s), chain ${liveChainId}`);

  /* ---- core ---- */
  heading("Shared core (Gully Core's contracts — you did not deploy these)");
  const contracts = { ...known, ...(config.chain.contracts ?? {}) };
  for (const [name, address] of Object.entries(contracts)) {
    if (typeof address !== "string" || !address.startsWith("0x")) continue;
    /* The router gets its own section below, because on a config with
       `chain.router` set it is NOT one of "Gully Core's contracts you did not
       deploy" — and one line claiming otherwise under this heading is exactly
       the kind of thing a reader believes. */
    if (name === "universalRouter") continue;
    const code = await client.getCode({ address: getAddress(address) }).catch(() => undefined);
    if (code === undefined || code === "0x") fail(name, `${address} has NO CODE`);
    else pass(name, `${address} (${(code.length - 2) / 2} bytes)`);
  }

  const [registered, vaultOwner] = await Promise.all([
    client
      .readContract({
        address: getAddress(contracts.vault),
        abi: VAULT_ABI,
        functionName: "isAppRegistered",
        args: [getAddress(contracts.clPoolManager)],
      })
      .catch(() => null),
    client
      .readContract({ address: getAddress(contracts.vault), abi: VAULT_ABI, functionName: "owner" })
      .catch(() => null),
  ]);

  if (registered === true) pass("CL manager registered", "the Vault will accept its locks");
  else if (registered === false)
    fail("CL manager registered", "NOT registered on this Vault — no swap can settle");
  else warn("CL manager registered", "could not be read");

  if (vaultOwner !== null) pass("vault owner", vaultOwner);

  /* ---- router ---- */
  await verifyRouter(client, config, contracts, known);

  /* ---- routed fills ---- */
  await verifyRouting(client, config, contracts);

  /* ---- protocol fee ---- */
  heading("Gully Core's protocol fee (set by Gully Core governance, capped at 0.4% by core)");
  const controller = await client
    .readContract({
      address: getAddress(contracts.clPoolManager),
      abi: MANAGER_ABI,
      functionName: "protocolFeeController",
    })
    .catch(() => null);

  if (controller === null) {
    warn("protocolFeeController", "could not be read");
  } else if (controller === ZERO) {
    pass("protocolFeeController", "not wired — the protocol fee is zero today");
  } else {
    const [defaultFee, disabled] = await Promise.all([
      client
        .readContract({ address: controller, abi: CONTROLLER_ABI, functionName: "defaultFee" })
        .catch(() => null),
      client
        .readContract({ address: controller, abi: CONTROLLER_ABI, functionName: "feesDisabled" })
        .catch(() => null),
    ]);
    if (defaultFee === null) {
      warn("protocolFeeController", `${controller} is wired but does not answer defaultFee()`);
    } else {
      const [isSet, zeroForOne, oneForZero] = defaultFee;
      const pips = isSet && disabled !== true ? Math.max(zeroForOne, oneForZero) : 0;
      pass("protocol fee", `${(pips / 10_000).toFixed(4)}% (${pips} pips) — you cannot change this`);
    }
  }

  /* ---- your fee ---- */
  heading("Your fee (this is the part you control)");
  if (!Number.isInteger(config.fee.bps) || config.fee.bps < 0 || config.fee.bps > 100) {
    fail("fee.bps", `${config.fee.bps} is outside 0..100`);
  } else if (config.fee.bps === 0) {
    warn("fee.bps", "0 — this front end earns you nothing");
  } else if (config.fee.wallet === null || config.fee.wallet === ZERO) {
    fail("fee.wallet", `fee.bps is ${config.fee.bps} but no destination is set; the fee is burned`);
  } else {
    const code = await client.getCode({ address: getAddress(config.fee.wallet) }).catch(() => "0x");
    pass(
      "fee",
      `${(config.fee.bps / 100).toFixed(2)}% of swap output to ${config.fee.wallet}` +
        (code !== undefined && code !== "0x" ? " (a contract — make sure it can receive tokens)" : ""),
    );
  }

  /* ---- registry ---- */
  heading("Marketplace");
  if (config.chain.registry === null) {
    warn("chain.registry", "not set — registry surfaces will say 'not configured'");
  } else {
    const count = await client
      .readContract({
        address: getAddress(config.chain.registry),
        abi: REGISTRY_ABI,
        functionName: "gullycoreCount",
      })
      .catch(() => null);
    if (count === null)
      fail("chain.registry", `${config.chain.registry} does not answer gullycoreCount()`);
    else
      pass(
        "chain.registry",
        `${count} listing(s). A live registry with 0 listings and a RETIRED one look identical ` +
          `from here — check the address against a release note.`,
      );
  }

  /* ---- launchpad ---- */
  heading("Launchpad");
  if (config.chain.launchpadKit === null) {
    if (config.features.launchpad) {
      warn(
        "chain.launchpadKit",
        "features.launchpad is on but no kit is configured; the launch screens will say so",
      );
    } else {
      pass("chain.launchpadKit", "not set, and features.launchpad is off");
    }
  } else {
    const kit = getAddress(config.chain.launchpadKit);
    const [hook, kitManager, expected, actual, kitClock] = await Promise.all([
      client.readContract({ address: kit, abi: KIT_ABI, functionName: "hook" }).catch(() => null),
      client
        .readContract({ address: kit, abi: KIT_ABI, functionName: "clPoolManager" })
        .catch(() => null),
      client
        .readContract({ address: kit, abi: KIT_ABI, functionName: "EXPECTED_HOOK_BITMAP" })
        .catch(() => null),
      client.readContract({ address: kit, abi: KIT_ABI, functionName: "hookBitmap" }).catch(() => null),
      probeClock(client, kit),
    ]);

    if (hook === null || kitManager === null) {
      fail("chain.launchpadKit", `${kit} does not answer the LaunchpadKit ABI`);
    } else {
      pass("launchpad hook", hook);
      if (getAddress(kitManager) !== getAddress(contracts.clPoolManager)) {
        fail(
          "launchpad core",
          `the kit points at pool manager ${kitManager}, not the one this app uses ` +
            `(${contracts.clPoolManager}). Pools it creates would be invisible here.`,
        );
      } else {
        pass("launchpad core", "wired to the same shared CL pool manager");
      }
      if (expected !== null && actual !== null && expected !== actual) {
        fail("launchpad bitmap", `hook bitmap ${actual} does not match the kit's expected ${expected}`);
      } else if (expected !== null) {
        pass("launchpad bitmap", `0x${Number(expected).toString(16).padStart(4, "0")}`);
      }
      const hookClock = await probeClock(client, getAddress(hook));
      const recorded =
        contracts.launchpadKit && getAddress(contracts.launchpadKit) === kit
          ? contracts.durationClocks?.launchpadKit ?? null
          : null;
      if (kitClock === null || hookClock === null) {
        fail("launchpad clock", "the RPC failed the CLOCK_MODE() probe; the kit's duration unit is unverified");
      } else if (kitClock.startsWith("unknown:") || hookClock.startsWith("unknown:")) {
        fail("launchpad clock", `unrecognised CLOCK_MODE (kit ${kitClock}, hook ${hookClock})`);
      } else if (kitClock !== hookClock) {
        fail("launchpad clock", `the kit counts ${kitClock} but its hook counts ${hookClock}`);
      } else if (recorded !== null && recorded !== kitClock) {
        fail(
          "launchpad clock",
          `the SDK address book records this kit as ${recorded}, but it answers as ${kitClock}. ` +
            "Update @gullylabs/core-sdk before trusting any schedule this app renders.",
        );
      } else if (kitClock === "timestamp") {
        pass("launchpad clock", "block.timestamp (CLOCK_MODE mode=timestamp) — decay windows are real seconds");
      } else {
        const blockTimeCentis = await client
          .readContract({ address: kit, abi: BLOCK_KIT_ABI, functionName: "blockTimeCentis" })
          .catch(() => null);
        warn(
          "launchpad clock",
          "block-numbered kit (the retired build): decay windows count the hook's block.number, " +
            "which on an Arbitrum chain is the parent chain's ~12s block" +
            (blockTimeCentis !== null
              ? `, while the kit was configured with ${Number(blockTimeCentis) / 100}s per block.`
              : ".") +
            " Prefer a timestamp-clocked kit.",
        );
      }
    }
  }

  /* ---- launchpad v2 ---- */
  heading("Launchpad v2 (locked launches)");
  const recordedV2 = contracts.launchpadV2?.launchpadKitV2 ?? null;
  if (config.chain.launchpadKitV2 === null) {
    if (recordedV2 !== null) {
      warn(
        "chain.launchpadKitV2",
        `not set, but the SDK address book records Gully Core's shared LaunchpadKitV2 at ${recordedV2} on this chain. ` +
          `Run \`npm run gullycore:deploy -- --kit-v2 ${recordedV2}\` to verify and write it.`,
      );
    } else if (config.features.launchpad) {
      warn("chain.launchpadKitV2", "not set, and the SDK address book has no shared LaunchpadKitV2 on this chain yet");
    } else {
      pass("chain.launchpadKitV2", "not set, and features.launchpad is off");
    }
  } else {
    const kit = getAddress(config.chain.launchpadKitV2);
    const r = (fn, args = []) =>
      client.readContract({ address: kit, abi: KIT_V2_ABI, functionName: fn, args }).catch(() => null);
    const [clManager, binManager, clHook, binHook, clLocker, binLocker, factory, maxLegs, maxBins, launchFee, maxIntegratorFee, owner, clock] =
      await Promise.all([
        r("clPoolManager"),
        r("binPoolManager"),
        r("clHook"),
        r("binHook"),
        r("clLocker"),
        r("binLocker"),
        r("tokenFactory"),
        r("maxLegs"),
        r("maxBinsPerLeg"),
        r("launchFeeWei"),
        r("maxIntegratorLaunchFeeWei"),
        r("owner"),
        probeClock(client, kit),
      ]);
    if (clManager === null || factory === null || maxLegs === null) {
      fail("chain.launchpadKitV2", `${kit} does not answer the LaunchpadKitV2 ABI`);
    } else {
      if (recordedV2 !== null && getAddress(recordedV2) !== kit) {
        warn(
          "chain.launchpadKitV2",
          `${kit} is not the kit the SDK address book records (${recordedV2}); a self-deployed kit shares nothing with Gully Core's tenants`,
        );
      }
      if (
        getAddress(clManager) !== getAddress(contracts.clPoolManager) ||
        getAddress(binManager) !== getAddress(contracts.binPoolManager)
      ) {
        fail("launchpad v2 core", `the kit points at managers ${clManager} / ${binManager}, not the ones this app uses`);
      } else {
        pass("launchpad v2 core", "wired to the same shared CL and Bin pool managers");
      }
      if (clock !== "timestamp") {
        fail("launchpad v2 clock", `CLOCK_MODE is ${clock ?? "unreadable"}; every v2 duration must be block.timestamp`);
      } else {
        pass("launchpad v2 clock", "block.timestamp (CLOCK_MODE mode=timestamp)");
      }
      const [clHookFactory, binHookFactory] = await Promise.all([
        client.readContract({ address: getAddress(clHook), abi: GUARD_ABI, functionName: "LAUNCH_TOKEN_FACTORY" }).catch(() => null),
        client.readContract({ address: getAddress(binHook), abi: GUARD_ABI, functionName: "LAUNCH_TOKEN_FACTORY" }).catch(() => null),
      ]);
      if (clHookFactory === null || binHookFactory === null) {
        fail("launchpad v2 guards", "a guard hook does not answer LAUNCH_TOKEN_FACTORY()");
      } else if (getAddress(clHookFactory) !== getAddress(factory) || getAddress(binHookFactory) !== getAddress(factory)) {
        fail("launchpad v2 guards", "a guard hook is bound to a different token factory than the kit's");
      } else {
        pass("launchpad v2 guards", `CL ${clHook} · Bin ${binHook}, both bound to factory ${factory}`);
      }
      const [lockerMaxIntegrator, lockerRecipient] = await Promise.all([
        client.readContract({ address: getAddress(clLocker), abi: LOCKER_ABI, functionName: "maxIntegratorBps" }).catch(() => null),
        client.readContract({ address: getAddress(clLocker), abi: LOCKER_ABI, functionName: "protocolRecipient" }).catch(() => null),
      ]);
      if (lockerMaxIntegrator === null) {
        fail("launchpad v2 lockers", `${clLocker} does not answer the locker ABI`);
      } else {
        pass("launchpad v2 lockers", `CL ${clLocker} · Bin ${binLocker} · protocol paid at ${lockerRecipient}`);
      }
      pass("launchpad v2 caps", `${maxLegs} legs, ${maxBins} bins per leg, launch fee ${launchFee} wei, owner ${owner}`);

      /* ---- your terms ---- */
      const launch = config.launch ?? { integratorBps: 0, integratorLaunchFeeWei: "0" };
      if (lockerMaxIntegrator !== null && Number(launch.integratorBps) > Number(lockerMaxIntegrator)) {
        fail("launch.integratorBps", `${launch.integratorBps} is above the lockers' cap of ${lockerMaxIntegrator}`);
      }
      if (maxIntegratorFee !== null && BigInt(launch.integratorLaunchFeeWei) > maxIntegratorFee) {
        fail("launch.integratorLaunchFeeWei", `${launch.integratorLaunchFeeWei} is above the kit's cap of ${maxIntegratorFee} wei`);
      }
      if (config.chain.launchTenant === null) {
        if (Number(launch.integratorBps) > 0 || BigInt(launch.integratorLaunchFeeWei) > 0n) {
          warn(
            "chain.launchTenant",
            "not set: launches are DIRECT and carry your terms from gullycore.config.ts, which nothing on chain enforces. " +
              "Run `npm run gullycore:tenant` to store them on the kit, then set chain.launchTenant.",
          );
        } else {
          pass("chain.launchTenant", "not set, and launch.* takes nothing, so there is nothing to store");
        }
      } else {
        const tenant = getAddress(config.chain.launchTenant);
        /* A pad or a wallet? A pad has code and answers owner() and KIT(). A
           wallet has no code. Code that answers neither is something else
           entirely, and a launch naming it still works only if the kit holds an
           active tenant config for it, which is checked below either way. */
        const tenantCode = await client.getCode({ address: tenant }).catch(() => undefined);
        const tenantHasCode = tenantCode !== undefined && tenantCode !== "0x";
        let padOk = true;
        if (tenantHasCode) {
          const [padOwner, padKit, padName] = await Promise.all([
            client.readContract({ address: tenant, abi: PAD_ABI, functionName: "owner" }).catch(() => null),
            client.readContract({ address: tenant, abi: PAD_ABI, functionName: "KIT" }).catch(() => null),
            client.readContract({ address: tenant, abi: PAD_ABI, functionName: "name" }).catch(() => null),
          ]);
          if (padOwner !== null && padKit !== null) {
            if (getAddress(padKit) !== kit) {
              padOk = false;
              fail(
                "launchTenant pad",
                `${tenant} is a GullyCorePad bound to kit ${padKit}, not chain.launchpadKitV2 ${kit}; ` +
                  "its tenant config lives on the other kit and every launch through this app would revert TenantNotActive",
              );
            } else {
              pass(
                "launchTenant pad",
                `GullyCorePad "${padName ?? "(name unreadable)"}" owned by ${padOwner}, bound to this kit; ` +
                  "`npm run gullycore:tenant` prints its configure() transaction, sent by that owner",
              );
            }
          } else {
            warn("launchTenant pad", `${tenant} has code but does not answer the GullyCorePad ABI (owner() and KIT()); treating it as a plain tenant`);
          }
        }
        const stored = padOk ? await r("tenantConfig", [tenant]) : null;
        if (!padOk) {
          /* already failed above */
        } else if (stored === null) {
          fail("chain.launchTenant", "tenantConfig() could not be read");
        } else if (!stored.active) {
          fail("chain.launchTenant", `${tenant} has no active tenant config on the kit; every launch naming it reverts TenantNotActive`);
        } else {
          const wallet = config.fee.wallet === null ? null : getAddress(config.fee.wallet);
          const mismatches = [];
          if (wallet === null || getAddress(stored.integrator) !== wallet) {
            mismatches.push(`integrator ${stored.integrator} vs fee.wallet ${wallet}`);
          }
          if (Number(stored.integratorBps) !== Number(launch.integratorBps)) {
            mismatches.push(`integratorBps ${stored.integratorBps} vs launch.integratorBps ${launch.integratorBps}`);
          }
          if (BigInt(stored.integratorLaunchFeeWei) !== BigInt(launch.integratorLaunchFeeWei)) {
            mismatches.push(`integratorLaunchFeeWei ${stored.integratorLaunchFeeWei} vs launch.integratorLaunchFeeWei ${launch.integratorLaunchFeeWei}`);
          }
          if (mismatches.length > 0) {
            fail(
              "chain.launchTenant",
              `the stored tenant config differs from gullycore.config.ts (${mismatches.join("; ")}). The app sends the STORED ` +
                "values, so the Fees screen would misstate your terms; align one side or run `npm run gullycore:tenant`" +
                (tenantHasCode ? " (a pad's owner sends configure())." : "."),
            );
          } else {
            pass(
              "chain.launchTenant",
              `active: ${stored.integratorBps} bps of every launch's trading fee and ${stored.integratorLaunchFeeWei} wei per launch to ${stored.integrator}` +
                `; presets mask 0x${Number(stored.allowedPresets).toString(16)}, bin shapes mask 0x${Number(stored.allowedBinShapes).toString(16)}` +
                (stored.restrictQuotes ? "; quotes restricted to the tenant's allowlist" : ""),
            );
          }
        }
      }
    }
  }

  /* ---- utilities ---- */
  heading("Gully Core utilities (each contract charges its own fee; this app adds none)");
  const UTILITY_FEE_ABI = parseAbi([
    "function feeWei() view returns (uint256)",
    "function maxFeeWei() view returns (uint256)",
    "function owner() view returns (address)",
  ]);
  const SPLIT_FACTORY_ABI = parseAbi([
    "function splitFeeWei() view returns (uint256)",
    "function protocolShareBps() view returns (uint16)",
    "function splitCount() view returns (uint256)",
  ]);
  const features = config.features ?? {};
  const utilities = [
    ["splits", "splitFactory", "GullyCoreSplitFactory"],
    ["locks", "positionLock", "GullyCorePositionLock"],
    ["locks", "tokenLock", "GullyCoreTokenLock"],
    ["airdrops", "multisend", "GullyCoreMultisend"],
    ["airdrops", "dropFactory", "GullyCoreDropFactory"],
  ];
  for (const [feature, key, name] of utilities) {
    const on = features[feature] === true;
    const address = contracts[key] ?? null;
    if (address === null) {
      if (on) warn(name, `not deployed on ${known.name} per the SDK address book; features.${feature} pages say "not deployed"`);
      else pass(name, `not deployed on ${known.name}, and features.${feature} is off`);
      continue;
    }
    const at = getAddress(address);
    if (key === "splitFactory") {
      const [fee, share, splits] = await Promise.all([
        client.readContract({ address: at, abi: SPLIT_FACTORY_ABI, functionName: "splitFeeWei" }).catch(() => null),
        client.readContract({ address: at, abi: SPLIT_FACTORY_ABI, functionName: "protocolShareBps" }).catch(() => null),
        client.readContract({ address: at, abi: SPLIT_FACTORY_ABI, functionName: "splitCount" }).catch(() => null),
      ]);
      if (fee === null || share === null) fail(name, `${at} does not answer the GullyCoreSplitFactory ABI`);
      else pass(name, `${at}: ${fee} wei per split, protocol share ${share} bps frozen into new splits, ${splits} made${on ? "" : " (features.splits is off)"}`);
      continue;
    }
    const [fee, cap, owner] = await Promise.all([
      client.readContract({ address: at, abi: UTILITY_FEE_ABI, functionName: "feeWei" }).catch(() => null),
      client.readContract({ address: at, abi: UTILITY_FEE_ABI, functionName: "maxFeeWei" }).catch(() => null),
      client.readContract({ address: at, abi: UTILITY_FEE_ABI, functionName: "owner" }).catch(() => null),
    ]);
    if (fee === null || cap === null) fail(name, `${at} does not answer the fee-gate ABI (feeWei, maxFeeWei)`);
    else pass(name, `${at}: ${fee} wei per action (cap ${cap} wei, set by ${owner})${on ? "" : ` (features.${feature} is off)`}`);
  }

  /* ---- tokens ---- */
  heading("Tokens");
  if (config.tokens.length === 0) {
    warn("tokens", "empty — the swap picker will have nothing in it");
  }
  for (const token of config.tokens) {
    const address = getAddress(token.address);
    try {
      const [symbol, decimals] = await Promise.all([
        client.readContract({ address, abi: erc20Abi, functionName: "symbol" }),
        client.readContract({ address, abi: erc20Abi, functionName: "decimals" }),
      ]);
      if (symbol !== token.symbol) {
        fail(token.symbol, `contract says "${symbol}", config says "${token.symbol}"`);
      } else if (Number(decimals) !== token.decimals) {
        fail(token.symbol, `contract says ${decimals} decimals, config says ${token.decimals}`);
      } else {
        pass(token.symbol, `${address}, ${decimals} decimals`);
      }
    } catch {
      fail(token.symbol ?? address, `${address} does not answer the ERC-20 ABI`);
    }
  }

  /* ---- token lists ---- */
  heading("Token lists");
  const { fetchTokenList, gullycoreTokenListUrl } = await import("@gullylabs/core-sdk");
  const lists = config.tokenLists ?? ["gullycore"];
  if (lists.length === 0) {
    warn("tokenLists", "empty — the picker offers only `tokens` and the pools' own tokens");
  }
  for (const entry of lists) {
    const url = entry === "gullycore" ? gullycoreTokenListUrl(config.chain.id) : entry;
    if (typeof url !== "string" || !/^https:\/\/[^\s]+$/.test(url)) {
      fail(String(entry), 'must be an https:// URL or "gullycore"');
      continue;
    }
    try {
      const { list, bytes } = await fetchTokenList(url);
      const onChain = list.tokens.filter((t) => t.chainId === config.chain.id).length;
      const label = entry === "gullycore" ? `Gully Core's list (${url})` : url;
      if (onChain === 0) {
        warn(label, `${list.name} v${list.version.major}.${list.version.minor}.${list.version.patch} loaded (${bytes} bytes) but names no token on chain ${config.chain.id}`);
      } else {
        pass(label, `${list.name} v${list.version.major}.${list.version.minor}.${list.version.patch}, ${onChain} token(s) on chain ${config.chain.id}, ${bytes} bytes`);
      }
    } catch (e) {
      fail(entry === "gullycore" ? `Gully Core's list (${url})` : url, e instanceof Error ? e.message : String(e));
    }
  }

  return finish();
}

/**
 * The router every swap in this app is built against: Gully Core's by default, the
 * tenant's own when `chain.router` names one.
 *
 * Worth its own section because a router is the one shared-core address a
 * tenant is invited to replace, and because every way of getting it wrong is
 * QUIET. An address with no code accepts an `execute(...)` call and does
 * nothing with it; on a native-currency swap it keeps the user's `msg.value`. A
 * router bound to a different Vault encodes, sends and settles somewhere this
 * app cannot see. A paused router reverts every swap with an error the trader
 * will read as "this app is broken". None of that shows up in `gullycore.config.ts`
 * — it shows up here, or in front of a user.
 *
 * Mirrors `resolveRouter` in `src/config/resolve.ts`: this script builds its own
 * view of the config (it must run before the app does), so the two must agree
 * about which router is in use. Change one, change the other.
 */
async function verifyRouter(client, config, contracts, known) {
  heading("Router (every swap in this app goes through it)");

  const configured = config.chain.router ?? null;
  const fork = config.chain.contracts?.universalRouter ?? null;
  if (configured !== null && fork !== null && getAddress(configured) !== getAddress(fork)) {
    fail(
      "chain.router",
      `chain.router is ${getAddress(configured)} but chain.contracts.universalRouter is ${getAddress(fork)}. ` +
        "Two routers are configured; the app refuses to pick one and so does this script.",
    );
    return;
  }

  const gullycore = getAddress(known.universalRouter);
  const router = getAddress(configured ?? fork ?? gullycore);
  const custom = router !== gullycore;

  if (!custom) {
    pass("router", `${router} — Gully Core's, the default. Nothing to deploy, nothing to maintain.`);
  } else {
    warn(
      "router",
      `${router} — YOURS, not Gully Core's (Gully Core's is ${gullycore}). Everything else stays shared. ` +
        "You are responsible for this contract: it is in the swap path and it holds users' funds " +
        "while a swap is in flight. Gully Core's routed-fill fee is charged by Gully Core's router only, so " +
        "through yours your users do not pay it and you do not earn it.",
    );
  }

  const code = await client.getCode({ address: router }).catch(() => undefined);
  if (code === undefined || code === "0x") {
    fail(
      "router code",
      `${router} has NO CODE on this chain. A swap encoded to it is a plain call that succeeds ` +
        "doing nothing, and a native-currency swap sends it the user's funds. Fix this before anyone trades.",
    );
    return;
  }
  pass("router code", `${(code.length - 2) / 2} bytes`);

  const [routerVault, paused, owner] = await Promise.all([
    client.readContract({ address: router, abi: ROUTER_ABI, functionName: "vault" }).catch(() => null),
    client.readContract({ address: router, abi: ROUTER_ABI, functionName: "paused" }).catch(() => null),
    client.readContract({ address: router, abi: ROUTER_ABI, functionName: "owner" }).catch(() => null),
  ]);

  if (routerVault === null) {
    warn(
      "router vault",
      "does not answer vault(). @gullylabs/core-widgets encodes Gully Core's UniversalRouter ABI " +
        "(`execute(bytes,bytes[],uint256)`, the Infinity command set) and grants Permit2 allowance to " +
        "this address — a contract that is not that router will encode fine and mean something else.",
    );
  } else if (getAddress(routerVault) !== getAddress(contracts.vault)) {
    fail(
      "router vault",
      `the router settles through Vault ${routerVault}, but this app reads ${contracts.vault}. ` +
        "Swaps would settle somewhere none of these pools live.",
    );
  } else {
    pass("router vault", "the same Vault this app reads");
  }

  if (paused === true) {
    fail("router paused", "PAUSED — every swap through it reverts until its owner unpauses it");
  } else if (paused === false) {
    pass("router paused", "not paused");
  }

  if (owner !== null) {
    (custom ? warn : pass)(
      "router owner",
      `${owner}${custom ? " — this key can pause every swap in your app" : ""}`,
    );
  }
}

/* `GullyCoreFillRouter`'s readable fee surface. */
const FILL_ROUTER_ABI = parseAbi([
  "function feeBps() view returns (uint16)",
  "function maxFeeBps() view returns (uint16)",
  "function pendingFee() view returns (uint16 newFeeBps, uint64 effectiveAt)",
  "function paused() view returns (bool)",
]);

/** Gully Core's hosted routing API; mirrors `GULLYCORE_ROUTING_API` in `src/config/resolve.ts`. */
const GULLYCORE_ROUTING_API = "https://gullychain.xyz/core";

/**
 * Routed fills: the router API the swap box asks and the fill router it would
 * accept calldata for. Mirrors `resolveRouting` in `src/config/resolve.ts` and
 * then asks what the config cannot: does the API serve this chain, does it
 * name the same fill router as the address book, what is the fee in force.
 */
async function verifyRouting(client, config, contracts) {
  heading("Routed fills (the swap box asks a router API; Gully Core pools stay the fallback)");
  const raw = config.routing;
  const api = raw === undefined ? "gullycore" : raw.api;
  if (api === null) {
    pass("routing.api", "null — routed fills are off by choice; every swap goes through Gully Core pools");
    return;
  }
  const origin = api === "gullycore" ? GULLYCORE_ROUTING_API : String(api).trim().replace(/\/+$/, "");
  if (!/^https:\/\/[^/\s]+$/.test(origin)) {
    fail("routing.api", `must be 'gullycore', an https:// origin with no path, or null; received ${JSON.stringify(api)}`);
    return;
  }
  const custom = origin !== GULLYCORE_ROUTING_API;
  (custom ? warn : pass)("routing.api", `${origin}${custom ? " — YOUR router API, not Gully Core's; it must name the same fill router as the address book" : " — Gully Core's hosted routing API"}`);

  const bookFill = contracts.fillRouter ?? null;
  const override = raw?.fillRouter ?? null;
  const fillRouter = override ?? bookFill;
  if (fillRouter === null) {
    warn("fill router", `the SDK address book records no GullyCoreFillRouter on chain ${config.chain.id}; routed fills are off there`);
    return;
  }
  if (override !== null && (bookFill === null || getAddress(override) !== getAddress(bookFill))) {
    warn("routing.fillRouter", `${getAddress(override)} overrides the address book (${bookFill ?? "none"}); only a full fork should do this`);
  }
  const fee = Number(config.fee?.bps ?? 0);
  if (fee > 0) {
    warn("routing", `fee.bps is ${fee}, so the swap box IGNORES the router: a routed fill has no integrator step and would drop your fee. Set fee.bps to 0 to route, or routing.api to null.`);
  }

  const code = await client.getCode({ address: fillRouter }).catch(() => undefined);
  if (code === undefined || code === "0x") {
    fail("fill router code", `${fillRouter} has no code on this chain`);
    return;
  }
  pass("fill router code", `${fillRouter}, ${(code.length - 2) / 2} bytes`);
  const [feeBps, maxFeeBps, pending, paused] = await Promise.all([
    client.readContract({ address: fillRouter, abi: FILL_ROUTER_ABI, functionName: "feeBps" }).catch(() => null),
    client.readContract({ address: fillRouter, abi: FILL_ROUTER_ABI, functionName: "maxFeeBps" }).catch(() => null),
    client.readContract({ address: fillRouter, abi: FILL_ROUTER_ABI, functionName: "pendingFee" }).catch(() => null),
    client.readContract({ address: fillRouter, abi: FILL_ROUTER_ABI, functionName: "paused" }).catch(() => null),
  ]);
  if (feeBps === null || maxFeeBps === null) {
    warn("routing fee", "the fill router does not answer feeBps() / maxFeeBps(); is this a GullyCoreFillRouter?");
  } else {
    const change = pending !== null && pending[1] !== 0n ? ` (changing to ${Number(pending[0]) / 100}% at ${new Date(Number(pending[1]) * 1000).toISOString()})` : "";
    pass("routing fee", `${Number(feeBps) / 100}% of the input on a third-party fill, 0 on a Gully Core pool; cap ${Number(maxFeeBps) / 100}% immutable${change}. The protocol's fee, not yours.`);
  }
  if (paused === true) fail("fill router paused", "PAUSED — no routed fill can be executed until its owner unpauses it");

  /* The API's own answer for this chain: served, and naming this fill router. */
  const url = `${origin}/v1/chains/${config.chain.id}/sources`;
  try {
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (res.status === 404) {
      warn("router API", `${url} answers 404: the API does not serve chain ${config.chain.id}; the swap box stays on Gully Core pools`);
      return;
    }
    if (!res.ok) {
      warn("router API", `${url} answered ${res.status}; the swap box stays on Gully Core pools until it answers`);
      return;
    }
    /* The API wraps every answer in `data`, as the widget's own client expects. */
    const body = (await res.json())?.data;
    const named = body?.routers?.fillRouter;
    if (typeof named !== "string" || getAddress(named) !== getAddress(fillRouter)) {
      fail("router API", `names fill router ${named ?? "none"}, not ${fillRouter}; the swap box refuses its answers (FILL_ROUTER_MISMATCH)`);
      return;
    }
    const venues = (body?.sources ?? []).filter((v) => v?.enabled === true).map((v) => v.name);
    pass("router API", `serves chain ${config.chain.id} with the same fill router; venues: ${venues.length === 0 ? "none enabled" : venues.join(", ")}`);
  } catch (e) {
    warn("router API", `${url} could not be reached (${e instanceof Error ? e.message : String(e)}); the swap box stays on Gully Core pools until it can`);
  }
}

function finish() {
  process.stdout.write("\n");
  if (failures > 0) {
    process.stdout.write(`${bad(`${failures} failure(s)`)}, ${warnings} warning(s)\n`);
    process.stdout.write(dim("Nothing was sent. Fix gullycore.config.ts and run this again.\n"));
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${ok("all checks passed")}, ${warnings} warning(s)\n`);
  process.stdout.write(dim("No transaction was sent; every call above was a read.\n"));
}

main().catch((err) => {
  process.stderr.write(`${bad("x")} ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
