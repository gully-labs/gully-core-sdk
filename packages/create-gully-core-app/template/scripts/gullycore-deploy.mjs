// SPDX-License-Identifier: MIT
/**
 * `npm run gullycore:deploy` — stand up your launchpad against the shared core and
 * write the resulting addresses back into `gullycore.config.ts`.
 *
 * ---------------------------------------------------------------------------
 * READ THIS BEFORE YOU EXPECT IT TO DEPLOY SOMETHING
 * ---------------------------------------------------------------------------
 *
 * **In the default path there is nothing to deploy, and that is the product.**
 * `Vault`, both pool managers, the router, the position managers and the quoter
 * are already live and verified — you point at them. `LaunchpadKit` takes every
 * launch parameter as a call argument and holds no owner, no treasury and no
 * mutable state, so ONE instance serves every tenant: your launches differ from
 * anyone else's by their arguments, not by their bytecode. The same is true of
 * `LaunchGuardHook`, whose authority is a per-pool `launchOwner`, and of
 * `RevShareHook`, whose entire configuration is per pool.
 *
 * So this script's real job is **resolve and verify**: confirm the addresses
 * exist, confirm the kit is wired to the same core this app reads, and write
 * what it found into your config. That is the whole shared-core deployment.
 *
 * **If you do want your own kit instance**, run it with `--own-kit`. It will
 * print the exact `forge script` invocation and refuse to run it. That refusal
 * is a licensing boundary, not laziness — see below.
 *
 * ---------------------------------------------------------------------------
 * WHY THE SOLIDITY IS NOT IN THIS PACKAGE
 * ---------------------------------------------------------------------------
 *
 * This template is MIT, and it is MIT because everything it touches reaches the
 * protocol through ABIs rather than through GPL source. `LaunchpadKit` and
 * `LaunchGuardHook` import Gully Core core and are therefore GPL-2.0-or-later, and
 * so is their compiled bytecode. Vendoring either into an MIT package — as
 * source, as an artifact, or as a hex string — would put GPL code inside an MIT
 * distribution and break the licence analysis this whole template rests on.
 *
 * The GPL code stays where it is GPL. You fetch it, you build it, you deploy
 * it, and your front end stays MIT and yours to close-source.
 *
 * ---------------------------------------------------------------------------
 * NOTHING HERE SENDS A TRANSACTION. Ever, on any flag.
 * ---------------------------------------------------------------------------
 */

import { createPublicClient, decodeAbiParameters, fallback, getAddress, http, parseAbi } from "viem";

import { bad, dim, heading, line, loadConfig, ok, writeChainField } from "./lib/config.mjs";

const KIT_ABI = parseAbi([
  "function hook() view returns (address)",
  "function clPoolManager() view returns (address)",
  "function positionManager() view returns (address)",
  "function permit2() view returns (address)",
  "function registry() view returns (address)",
  "function hookBitmap() view returns (uint16)",
  "function EXPECTED_HOOK_BITMAP() view returns (uint16)",
]);

/* ERC-6372 `CLOCK_MODE()`. Only the timestamp-clocked kit and hook answer it;
   the retired block-numbered build reverts. */
const CLOCK_MODE_CALLDATA = "0x4bf5d7e9";

/**
 * "timestamp", "contract-block" (the call REVERTED), or throws on a transport
 * failure — which is never read as a revert, because that would label a
 * timestamp kit block-numbered whenever the RPC hiccuped.
 */
async function probeClock(client, address) {
  try {
    const { data } = await client.call({ to: address, data: CLOCK_MODE_CALLDATA });
    if (data === undefined || data === "0x") return "contract-block";
    const [mode] = decodeAbiParameters([{ type: "string" }], data);
    if (mode === "mode=timestamp") return "timestamp";
    return `unknown:${mode}`;
  } catch (err) {
    let e = err;
    while (e) {
      if (/revert/i.test(String(e.shortMessage ?? e.message ?? ""))) return "contract-block";
      e = e.cause;
    }
    throw err;
  }
}

const HOOK_ABI = parseAbi([
  "function poolManager() view returns (address)",
  "function getHooksRegistrationBitmap() pure returns (uint16)",
]);

function flag(name) {
  const exact = process.argv.indexOf(`--${name}`);
  if (exact !== -1) {
    const next = process.argv[exact + 1];
    return next !== undefined && !next.startsWith("--") ? next : true;
  }
  const prefixed = process.argv.find((a) => a.startsWith(`--${name}=`));
  return prefixed === undefined ? undefined : prefixed.slice(name.length + 3);
}

const USAGE = `
gullycore:deploy — resolve your launchpad against Gully Core's shared core.

  npm run gullycore:deploy                       explain the state of play, change nothing
  npm run gullycore:deploy -- --kit-v2 0x…       verify a LaunchpadKitV2 (locked launches) and write it
  npm run gullycore:deploy -- --tenant 0x…       write your tenant address (the account that ran setTenantConfig)
  npm run gullycore:deploy -- --kit 0x…          verify a v1 LaunchpadKit and write it to the config
  npm run gullycore:deploy -- --registry 0x…     verify a GullyCoreRegistry and write it to the config
  npm run gullycore:deploy -- --own-kit          print the forge command to deploy your own kit
  npm run gullycore:deploy -- --dry-run          verify but do not write

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
  if (core === undefined) {
    throw new Error(`No Gully Core core is recorded for chain ${chainId}.`);
  }

  if (flag("own-kit") !== undefined) {
    printOwnKitInstructions(core, config);
    return;
  }

  const contracts = { ...core, ...(config.chain.contracts ?? {}) };
  const { CHAIN_RPCS } = await import("@gullylabs/core-sdk");
  const urls = [
    ...(config.chain.rpcUrls ?? []),
    ...(Object.values(CHAIN_RPCS).find((c) => c.chainId === chainId)?.endpoints.map((e) => e.url) ??
      []),
  ];
  const client = createPublicClient({
    transport: fallback(
      urls.map((u) => http(u, { timeout: 12_000, retryCount: 0 })),
      { rank: false, retryCount: 2 },
    ),
  });

  const dryRun = flag("dry-run") !== undefined;
  let wrote = 0;

  const kitV2Flag = flag("kit-v2");
  if (typeof kitV2Flag === "string") {
    heading(`Verifying LaunchpadKitV2 ${kitV2Flag}`);
    const kit = getAddress(kitV2Flag);
    const problems = await verifyKitV2(client, kit, contracts);
    if (problems.length > 0) {
      for (const problem of problems) line("fail", "launchpadKitV2", problem);
      throw new Error("The kit did not verify. Nothing was written.");
    }
    if (dryRun) {
      line("ok", "launchpadKitV2", `${kit} verified. --dry-run, so gullycore.config.ts is unchanged.`);
    } else {
      await writeChainField("launchpadKitV2", kit);
      wrote += 1;
      line("ok", "launchpadKitV2", `${kit} written to gullycore.config.ts`);
    }
  }

  const tenantFlag = flag("tenant");
  if (typeof tenantFlag === "string") {
    heading(`Checking tenant ${tenantFlag}`);
    const tenant = getAddress(tenantFlag);
    const kit = typeof kitV2Flag === "string" ? getAddress(kitV2Flag) : config.chain.launchpadKitV2;
    if (kit === null || kit === undefined) {
      throw new Error("A tenant config lives on a LaunchpadKitV2; pass --kit-v2 first or set chain.launchpadKitV2.");
    }
    const stored = await client
      .readContract({ address: getAddress(kit), abi: KIT_V2_ABI, functionName: "tenantConfig", args: [tenant] })
      .catch(() => null);
    if (stored === null) throw new Error(`tenantConfig(${tenant}) could not be read from ${kit}. Nothing was written.`);
    if (!stored.active) {
      throw new Error(
        `${tenant} has no active tenant config on ${kit}. Run \`npm run gullycore:tenant\` and send that transaction ` +
          "from the tenant account first; every launch naming an inactive tenant reverts. Nothing was written.",
      );
    }
    line("ok", "tenant", `active: integrator ${stored.integrator}, ${stored.integratorBps} bps, ${stored.integratorLaunchFeeWei} wei per launch`);
    if (dryRun) {
      line("ok", "launchTenant", "--dry-run, so gullycore.config.ts is unchanged.");
    } else {
      await writeChainField("launchTenant", tenant);
      wrote += 1;
      line("ok", "launchTenant", `${tenant} written to gullycore.config.ts`);
    }
  }

  const kitFlag = flag("kit");
  if (typeof kitFlag === "string") {
    heading(`Verifying LaunchpadKit ${kitFlag}`);
    const kit = getAddress(kitFlag);
    const problems = await verifyKit(client, kit, contracts);
    if (problems.length > 0) {
      for (const problem of problems) line("fail", "launchpadKit", problem);
      throw new Error("The kit did not verify. Nothing was written.");
    }
    if (dryRun) {
      line("ok", "launchpadKit", `${kit} verified. --dry-run, so gullycore.config.ts is unchanged.`);
    } else {
      await writeChainField("launchpadKit", kit);
      wrote += 1;
      line("ok", "launchpadKit", `${kit} written to gullycore.config.ts`);
    }
  }

  const registryFlag = flag("registry");
  if (typeof registryFlag === "string") {
    heading(`Verifying GullyCoreRegistry ${registryFlag}`);
    const registry = getAddress(registryFlag);
    const count = await client
      .readContract({
        address: registry,
        abi: parseAbi(["function gullycoreCount() view returns (uint256)"]),
        functionName: "gullycoreCount",
      })
      .catch(() => null);
    if (count === null) {
      throw new Error(`${registry} does not answer gullycoreCount(). Nothing was written.`);
    }
    line(
      "warn",
      "registry",
      `${count} listing(s). A RETIRED registry answers this call too and looks identical — ` +
        `confirm the address against a Gully Core release note, not against this number.`,
    );
    if (dryRun) {
      line("ok", "registry", "--dry-run, so gullycore.config.ts is unchanged.");
    } else {
      await writeChainField("registry", registry);
      wrote += 1;
      line("ok", "registry", `${registry} written to gullycore.config.ts`);
    }
  }

  if (typeof kitFlag !== "string" && typeof registryFlag !== "string" && typeof kitV2Flag !== "string" && typeof tenantFlag !== "string") {
    printStateOfPlay(config, contracts);
    return;
  }

  process.stdout.write(
    `\n${ok(`${wrote} field(s) updated`)}. ${dim("No transaction was sent.")}\n` +
      `${dim("Run `npm run gullycore:verify` to re-check everything.")}\n`,
  );
}

const KIT_V2_ABI = parseAbi([
  "function clPoolManager() view returns (address)",
  "function binPoolManager() view returns (address)",
  "function clHook() view returns (address)",
  "function binHook() view returns (address)",
  "function tokenFactory() view returns (address)",
  "function maxLegs() view returns (uint8)",
  "function tenantConfig(address) view returns ((address integrator, uint16 integratorBps, uint96 integratorLaunchFeeWei, uint8 allowedPresets, uint8 allowedBinShapes, bool restrictQuotes, bool active, uint16 maxTaxBps, uint16 taxIntegratorBps, bool gullyTerms))",
]);
const GUARD_V2_ABI = parseAbi(["function LAUNCH_TOKEN_FACTORY() view returns (address)"]);

/**
 * A `LaunchpadKitV2` is verified the same way as a v1 kit — code, ABI, wired to
 * THIS core — plus the two things that make it v2: a timestamp clock (no other
 * build exists, so anything else is not this contract) and both guard hooks
 * bound to the kit's own token factory, which is what reserves a launch's pool
 * ids for the kit.
 */
async function verifyKitV2(client, kit, contracts) {
  const problems = [];
  const code = await client.getCode({ address: kit }).catch(() => undefined);
  if (code === undefined || code === "0x") return [`${kit} has no code on this chain`];

  const r = (fn) => client.readContract({ address: kit, abi: KIT_V2_ABI, functionName: fn }).catch(() => null);
  const [clManager, binManager, clHook, binHook, factory, maxLegs, clock] = await Promise.all([
    r("clPoolManager"),
    r("binPoolManager"),
    r("clHook"),
    r("binHook"),
    r("tokenFactory"),
    r("maxLegs"),
    probeClock(client, kit),
  ]);
  if (clManager === null || binManager === null || factory === null || maxLegs === null) {
    return [`${kit} does not answer the LaunchpadKitV2 ABI — is it a LaunchpadKitV2?`];
  }
  if (clock !== "timestamp") problems.push(`CLOCK_MODE is ${clock}; a LaunchpadKitV2 counts block.timestamp`);
  else line("ok", "launchpad v2 clock", "block.timestamp (CLOCK_MODE mode=timestamp)");

  if (getAddress(clManager) !== getAddress(contracts.clPoolManager)) {
    problems.push(`the kit is wired to CL pool manager ${clManager}, but this app reads ${contracts.clPoolManager}`);
  }
  if (getAddress(binManager) !== getAddress(contracts.binPoolManager)) {
    problems.push(`the kit is wired to Bin pool manager ${binManager}, but this app reads ${contracts.binPoolManager}`);
  }
  const [clHookFactory, binHookFactory] = await Promise.all([
    client.readContract({ address: getAddress(clHook), abi: GUARD_V2_ABI, functionName: "LAUNCH_TOKEN_FACTORY" }).catch(() => null),
    client.readContract({ address: getAddress(binHook), abi: GUARD_V2_ABI, functionName: "LAUNCH_TOKEN_FACTORY" }).catch(() => null),
  ]);
  if (clHookFactory === null || binHookFactory === null) {
    problems.push("a guard hook does not answer LAUNCH_TOKEN_FACTORY()");
  } else if (getAddress(clHookFactory) !== getAddress(factory) || getAddress(binHookFactory) !== getAddress(factory)) {
    problems.push("a guard hook is bound to a different token factory than the kit's");
  } else {
    line("ok", "launchpad v2 guards", `CL ${clHook} · Bin ${binHook} · factory ${factory}`);
  }
  const recorded = contracts.launchpadV2?.launchpadKitV2 ?? null;
  if (recorded !== null && getAddress(recorded) !== kit) {
    line("warn", "launchpadKitV2", `${kit} is not the shared kit the SDK records (${recorded}); tenants of Gully Core's kit will not see your launches`);
  }
  return problems;
}

async function verifyKit(client, kit, contracts) {
  const problems = [];

  const code = await client.getCode({ address: kit }).catch(() => undefined);
  if (code === undefined || code === "0x") return [`${kit} has no code on this chain`];

  const [hook, kitManager, expected, actual] = await Promise.all([
    client.readContract({ address: kit, abi: KIT_ABI, functionName: "hook" }).catch(() => null),
    client
      .readContract({ address: kit, abi: KIT_ABI, functionName: "clPoolManager" })
      .catch(() => null),
    client
      .readContract({ address: kit, abi: KIT_ABI, functionName: "EXPECTED_HOOK_BITMAP" })
      .catch(() => null),
    client.readContract({ address: kit, abi: KIT_ABI, functionName: "hookBitmap" }).catch(() => null),
  ]);

  if (hook === null || kitManager === null) {
    return [`${kit} does not answer the LaunchpadKit ABI — is it a LaunchpadKit?`];
  }

  /* The clock decides the unit of every schedule this app will read and write.
     A block-numbered kit still works here — the app reads both — but it is the
     retired build, whose windows run on the parent chain's block number. */
  const [kitClock, hookClock] = await Promise.all([probeClock(client, kit), probeClock(client, hook)]);
  if (kitClock.startsWith("unknown:") || hookClock.startsWith("unknown:")) {
    problems.push(`unrecognised CLOCK_MODE (kit ${kitClock}, hook ${hookClock})`);
  } else if (kitClock !== hookClock) {
    problems.push(`the kit counts ${kitClock} but its hook counts ${hookClock}; schedules would be misread`);
  } else if (kitClock === "contract-block") {
    line(
      "warn",
      "launchpad clock",
      "block-numbered kit (no CLOCK_MODE). This is the retired build: its decay windows count the " +
        "hook's block.number, which on an Arbitrum chain is the parent chain's block. Prefer a " +
        "timestamp-clocked kit.",
    );
  } else {
    line("ok", "launchpad clock", "block.timestamp (CLOCK_MODE mode=timestamp)");
  }

  /* The single most damaging misconfiguration: a kit wired to a DIFFERENT pool
     manager. It deploys fine, it creates launches fine, and none of them ever
     appear in this app, because this app reads the other manager's logs. */
  if (getAddress(kitManager) !== getAddress(contracts.clPoolManager)) {
    problems.push(
      `the kit is wired to pool manager ${kitManager}, but this app reads ` +
        `${contracts.clPoolManager}. Launches it creates would be invisible here.`,
    );
  }

  if (expected !== null && actual !== null && expected !== actual) {
    problems.push(`hook bitmap ${actual} does not match the kit's expected ${expected}`);
  }

  const hookManager = await client
    .readContract({ address: hook, abi: HOOK_ABI, functionName: "poolManager" })
    .catch(() => null);
  if (hookManager !== null && getAddress(hookManager) !== getAddress(contracts.clPoolManager)) {
    problems.push(`the kit's hook is wired to pool manager ${hookManager}, not the shared one`);
  }

  return problems;
}

function printStateOfPlay(config, contracts) {
  heading("Shared core — already deployed, nothing for you to do");
  line("ok", "vault", contracts.vault);
  line("ok", "clPoolManager", contracts.clPoolManager);
  /* `chain.router` is the tenant's own router on Gully Core's core — the one shared
     address they are invited to replace. Printing the book's here regardless
     would name a contract this app does not use. */
  const router = config.chain.router ?? contracts.universalRouter;
  line(
    config.chain.router === null || config.chain.router === undefined ? "ok" : "warn",
    "universalRouter",
    config.chain.router === null || config.chain.router === undefined
      ? router
      : `${router} (YOURS, from chain.router — Gully Core's is ${contracts.universalRouter}; run gullycore:verify)`,
  );
  line("ok", "clPositionManager", contracts.clPositionManager);
  process.stdout.write(
    dim(
      "\n  Your pools live in that Vault. You are not deploying it, you cannot upgrade it,\n" +
        "  and neither can anyone else operating a front end on it.\n",
    ),
  );

  heading("Launchpad v2 (locked launches)");
  if (config.chain.launchpadKitV2 !== null) {
    line("ok", "launchpadKitV2", `${config.chain.launchpadKitV2} (configured)`);
    line(
      config.chain.launchTenant !== null ? "ok" : "warn",
      "launchTenant",
      config.chain.launchTenant !== null
        ? `${config.chain.launchTenant} (configured)`
        : "not set: launches are direct, your terms come from gullycore.config.ts and nothing on chain enforces them",
    );
    process.stdout.write(dim("\n  Run `npm run gullycore:verify` to check both against the chain, `npm run gullycore:tenant` to store your terms.\n"));
  } else {
    line("warn", "launchpadKitV2", "not configured");
    const recorded = contracts.launchpadV2?.launchpadKitV2 ?? null;
    if (recorded !== null) {
      process.stdout.write(
        dim(
          `\n  The SDK address book records Gully Core's shared LaunchpadKitV2 on this chain at\n` +
            `  ${recorded}. Pointing at it is \`npm run gullycore:deploy -- --kit-v2 ${recorded}\`,\n` +
            "  which verifies it first. Then `npm run gullycore:tenant` to store your terms on it.\n",
        ),
      );
    } else {
      process.stdout.write(
        dim(
          "\n  The SDK address book has no shared LaunchpadKitV2 on this chain yet. Bump\n" +
            "  @gullylabs/core-sdk when Gully Core deploys one; the v1 kit below still works meanwhile.\n",
        ),
      );
    }
  }

  heading("Launchpad v1 (unlocked launches, seeded from a token you hold)");
  if (config.chain.launchpadKit !== null) {
    line("ok", "launchpadKit", `${config.chain.launchpadKit} (configured)`);
    process.stdout.write(dim("\n  Run `npm run gullycore:verify` to check it against the chain.\n"));
  } else {
    line("warn", "launchpadKit", "not configured");
    if (contracts.launchpadKit) {
      const clock = contracts.durationClocks?.launchpadKit ?? "unknown";
      process.stdout.write(
        dim(
          `\n  The SDK address book records a Gully Core LaunchpadKit on this chain at\n` +
            `  ${contracts.launchpadKit} (duration clock: ${clock}).` +
            (clock === "contract-block"
              ? " That is the block-numbered\n  build, whose windows count the parent chain's block number; a\n  timestamp-clocked redeploy supersedes it.\n"
              : "\n") +
            "  Pointing at it is `npm run gullycore:deploy -- --kit <address>`, which verifies it first.\n",
        ),
      );
    }
    process.stdout.write(
      dim(
        "\n  Your options:\n\n" +
          "    1. Ship without the launchpad. Set features.launchpad to false and the\n" +
          "       launch screens disappear rather than sitting there broken.\n" +
          "    2. Deploy your own instance. `npm run gullycore:deploy -- --own-kit`\n" +
          "       prints exactly how, then feed the address back with `--kit 0x…`.\n\n" +
          "  Pointing at a shared instance, where one exists, is one `--kit` away and\n" +
          "  costs you nothing.\n",
      ),
    );
  }

  heading("Your fee");
  if (config.fee.bps > 0) {
    line("ok", "fee", `${(config.fee.bps / 100).toFixed(2)}% of swap output to ${config.fee.wallet}`);
    process.stdout.write(
      dim("\n  No contract holds this. It is an action inside the swap's own call path.\n"),
    );
  } else {
    line("warn", "fee", "0 bps — this front end earns nothing");
  }

  process.stdout.write(`\n${dim("Nothing was written and no transaction was sent.")}\n`);
}

function printOwnKitInstructions(core, config) {
  heading("Deploying your own LaunchpadKit against the shared core");

  process.stdout.write(
    "\n" +
      "This script will not run these commands for you. LaunchpadKit and\n" +
      "LaunchGuardHook import Gully Core core, so they are GPL-2.0-or-later — and this\n" +
      "template is MIT precisely because it contains no GPL source and no bytecode\n" +
      "compiled from any. Vendoring them here would break that, and with it your\n" +
      "right to close-source your fork of this front end.\n" +
      "\n" +
      "The contracts stay where they are GPL. You fetch, build and deploy them.\n" +
      "\n" +
      "  1. Get the GPL launchpad sources and build them. They are published in\n" +
      "     Gully Core's contracts repository, under `packages/launchpad`:\n" +
      "\n" +
      "       git clone --recurse-submodules https://github.com/gully-labs/gully-core\n" +
      "       cd contracts/packages/launchpad\n" +
      "       forge build\n" +
      "\n" +
      "  2. Deploy the hook. It is `LaunchGuardHook(ICLPoolManager, ILaunchTokenOrigin)`.\n" +
      "     The pool manager must be the SHARED one below or your launches will not\n" +
      "     appear in any app reading Gully Core's core. The second argument is the\n" +
      "     LaunchTokenFactory whose tokens get front-run-proof launch pools; deploy\n" +
      "     one first, or pass the zero address to opt out of that reservation for\n" +
      "     the life of the hook. The script lists the hook in the registry in the\n" +
      "     same session and hands the listing to your steward:\n" +
      "\n" +
      `       export CL_POOL_MANAGER=${core.clPoolManager}\n` +
      "       export LAUNCH_TOKEN_FACTORY=0x...   # your LaunchTokenFactory, or 0x0 to opt out\n" +
      `       export LAUNCH_GUARD_REGISTRY=${config.chain.registry ?? "0x..."}\n` +
      "       export LAUNCH_GUARD_STEWARD=0x...   # the key that should own the listing metadata\n" +
      "       export PRIVATE_KEY=...              # never commit this, never echo it\n" +
      "       forge script script/DeployLaunchGuardHookMainnet.s.sol \\\n" +
      "         --rpc-url $RPC_URL --broadcast --verify\n" +
      "\n" +
      "  3. Deploy the kit. Its constructor is\n" +
      "     `(ICLPoolManager, LaunchGuardHook, ICLPositionManager, IAllowanceTransfer,\n" +
      "       IHookRegistryListing)`. There is no block-time argument: every duration\n" +
      "     is seconds of block.timestamp, and the script refuses a hook that is not\n" +
      "     timestamp-clocked:\n" +
      "\n" +
      `       export LAUNCH_GUARD_HOOK=0x...   # from step 2\n` +
      `       export CL_POSITION_MANAGER=${core.clPositionManager}\n` +
      `       export PERMIT2=${core.permit2}\n` +
      `       export LAUNCHPAD_REGISTRY=${config.chain.registry ?? "0x0000000000000000000000000000000000000000"}\n` +
      "       forge script script/DeployLaunchpadKitMainnet.s.sol \\\n" +
      "         --rpc-url $RPC_URL --broadcast --verify\n" +
      "\n" +
      "  4. Point this app at it, which verifies it first:\n" +
      "\n" +
      "       npm run gullycore:deploy -- --kit 0xYourKitAddress\n" +
      "\n",
  );

  process.stdout.write(
    "Two things to get right, because neither can be fixed afterwards:\n" +
      "\n" +
      "  · LAUNCHPAD_BLOCK_TIME_CENTIS is IMMUTABLE and is how the kit converts a\n" +
      "    start delay in seconds into a block count. Wrong by 100x and every launch\n" +
      "    you schedule starts at the wrong time. It is hundredths of a second per\n" +
      "    block: 1200 on a 12s chain, 10 on a 0.1s chain. Measure it, do not assume.\n" +
      "\n" +
      "  · LAUNCHPAD_REGISTRY at address(0) disables registry listing on that kit\n" +
      "    PERMANENTLY. That is a valid choice, but it is not reversible: the kit has\n" +
      "    no owner and no setter, by design.\n" +
      "\n",
  );

  process.stdout.write(dim("Nothing was run and no transaction was sent.\n"));
}

main().catch((err) => {
  process.stderr.write(`${bad("x")} ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
