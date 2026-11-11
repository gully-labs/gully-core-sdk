/**
 * Renders a generated hook project for a BIN pool (liquidity-book style, `BinPoolManager`).
 *
 * The concentrated-liquidity generator (`project.ts`) composes a hook from any permission set the
 * developer picks. A Bin hook is a different contract family: different callbacks (`beforeMint`,
 * `afterBurn`, ...), a different base (`BaseBinHook`), a different pool key word (a bin step, not
 * a tick spacing) and a different test harness. Rather than half-generalise the CL generator, a
 * Bin template is a FIXED starting point: its callbacks are its own, and `--permissions` is
 * refused for it. The registration bitmap and the pool key `parameters` word are still computed
 * once, here, from the SDK's Bin encoders, and written into the hook, the test, the deploy script,
 * the README and `gullycore.json` from that one value.
 */

import { BIN_HOOK_FLAGS, encodeBinPoolParameters, encodeHookPermissions, validateHookRegistrationBitmap, type BinHookFlagName } from "@gullylabs/core-sdk";
import { UserError } from "../util/log.js";
import { renderFoundryToml, type ProjectPaths } from "./project.js";

const SOLC = "0.8.26";

/** `BaseBinHook`'s constant for each Bin permission. */
export const BIN_SOLIDITY_CONSTANTS: Readonly<Record<BinHookFlagName, string>> = {
  beforeInitialize: "BEFORE_INITIALIZE",
  afterInitialize: "AFTER_INITIALIZE",
  beforeMint: "BEFORE_MINT",
  afterMint: "AFTER_MINT",
  beforeBurn: "BEFORE_BURN",
  afterBurn: "AFTER_BURN",
  beforeSwap: "BEFORE_SWAP",
  afterSwap: "AFTER_SWAP",
  beforeDonate: "BEFORE_DONATE",
  afterDonate: "AFTER_DONATE",
  beforeSwapReturnsDelta: "BEFORE_SWAP_RETURNS_DELTA",
  afterSwapReturnsDelta: "AFTER_SWAP_RETURNS_DELTA",
  afterMintReturnsDelta: "AFTER_MINT_RETURNS_DELTA",
  afterBurnReturnsDelta: "AFTER_BURN_RETURNS_DELTA",
};

export interface BinHookTemplate {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  /** The callbacks the template implements. Fixed: a Bin template is not recomposed. */
  readonly permissions: readonly BinHookFlagName[];
}

export const BIN_SWAP_COUNTER: BinHookTemplate = {
  id: "bin-swap-counter",
  label: "bin-swap-counter",
  description: "a Bin pool hook: afterSwap keeps a per-pool swap count on chain",
  permissions: ["afterSwap"],
};

export const BIN_TEMPLATES: readonly BinHookTemplate[] = [BIN_SWAP_COUNTER];

export function findBinTemplate(id: string): BinHookTemplate | undefined {
  const wanted = id.trim().toLowerCase();
  return BIN_TEMPLATES.find((t) => t.id === wanted);
}

export interface ResolvedBinPermissions {
  readonly names: readonly BinHookFlagName[];
  readonly bitmap: number;
  readonly bitmapHex: string;
  /** `AFTER_SWAP`, referring to `BaseBinHook`'s constants. */
  readonly solidityExpression: string;
}

export function resolveBinPermissions(names: readonly BinHookFlagName[]): ResolvedBinPermissions {
  const sorted = [...new Set(names)].sort((a, b) => BIN_HOOK_FLAGS[a] - BIN_HOOK_FLAGS[b]);
  const bitmap = encodeHookPermissions("BIN", Object.fromEntries(sorted.map((n) => [n, true])));
  const validation = validateHookRegistrationBitmap("BIN", bitmap);
  if (!validation.valid) {
    throw new UserError(`refusing to generate an invalid Bin permission bitmap: ${validation.issues.map((i) => i.message).join("; ")}`);
  }
  return {
    names: sorted,
    bitmap,
    bitmapHex: `0x${bitmap.toString(16).padStart(4, "0")}`,
    solidityExpression: sorted.length === 0 ? "0" : sorted.map((n) => BIN_SOLIDITY_CONSTANTS[n]).join(" | "),
  };
}

/** `BinPoolManager.MIN_BIN_STEP` is 1; its default `maxBinStep` is 100 (owner-settable upward). */
export function parseBinStep(raw: string | undefined): number {
  if (raw === undefined) return 10;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new UserError(
      `--bin-step must be an integer between 1 and 100, got "${raw}"`,
      "BinPoolManager refuses a bin step under MIN_BIN_STEP (1) or over its maxBinStep (100 unless its owner raised it)",
    );
  }
  return value;
}

/** A static Bin LP fee: hundredths of a bip, at most 10% (`LPFeeLibrary.TEN_PERCENT_FEE`, the Bin maximum). */
export function parseBinFee(raw: string | undefined): number {
  if (raw === undefined) return 3000;
  const value = Number.parseInt(raw, 10);
  if (raw.trim().toLowerCase() === "dynamic" || !Number.isInteger(value) || value < 0 || value > 100_000) {
    throw new UserError(
      `--fee for a Bin template must be an integer between 0 and 100000, got "${raw}"`,
      "the Bin maximum LP fee is 10% (100000); this template sets no dynamic fee, so 'dynamic' would give swaps away",
    );
  }
  return value;
}

export interface BinProjectContext {
  readonly projectName: string;
  readonly contractName: string;
  readonly template: BinHookTemplate;
  readonly permissions: ResolvedBinPermissions;
  readonly binStep: number;
  /** Static LP fee in hundredths of a bip. */
  readonly lpFee: number;
  /** The pool key `parameters` word, 0x-prefixed 32 bytes. */
  readonly parameters: string;
  readonly paths: ProjectPaths;
  readonly cliVersion: string;
}

export function binContext(input: Omit<BinProjectContext, "permissions" | "parameters">): BinProjectContext {
  const permissions = resolveBinPermissions(input.template.permissions);
  return { ...input, permissions, parameters: encodeBinPoolParameters(permissions.bitmap, input.binStep) };
}

// ---------------------------------------------------------------------------
// src/<Hook>.sol
// ---------------------------------------------------------------------------

export function renderBinHook(ctx: BinProjectContext): string {
  const { contractName, permissions } = ctx;
  const rows = permissions.names.map((n) => `///   bit ${String(BIN_HOOK_FLAGS[n]).padStart(2)}  ${n}`).join("\n");
  return `// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ${SOLC};

import {BaseBinHook} from "gullycore-hooks/src/base/BaseBinHook.sol";
import {IBinHooks} from "infinity-core/src/pool-bin/interfaces/IBinHooks.sol";
import {IBinPoolManager} from "infinity-core/src/pool-bin/interfaces/IBinPoolManager.sol";
import {PoolKey} from "infinity-core/src/types/PoolKey.sol";
import {PoolId} from "infinity-core/src/types/PoolId.sol";
import {BalanceDelta} from "infinity-core/src/types/BalanceDelta.sol";

/// @title ${contractName}
/// @notice Counts the swaps executed on every Bin pool that registers this hook.
/// @dev One deployment can back many pools, so the counter is keyed by \`PoolId\`.
/// The hook trusts nothing but the pool manager: \`BaseBinHook\`'s \`onlyPoolManager\` on the
/// external callback is what stops anyone from inflating the counter for free.
///
/// @dev PERMISSIONS. This hook registers ${permissions.bitmapHex}:
${rows}
///
/// That same value must appear in the low 16 bits of every pool key that uses this hook, or
/// \`Hooks.validateHookConfig\` reverts with \`HookConfigValidationError\` when the pool is
/// initialized. The matching \`parameters\` word for bin step ${ctx.binStep} is:
///
///   ${ctx.parameters}
///
/// The hook's ADDRESS carries no meaning: permissions live in the pool key, so there is no
/// salt to mine.
contract ${contractName} is BaseBinHook {
    /// @notice Number of swaps seen on each pool
    mapping(PoolId poolId => uint256 count) public swapCount;

    /// @notice Emitted once per swap, after the swap has been executed
    event SwapCounted(PoolId indexed poolId, uint256 count);

    /// @param _poolManager The Bin pool manager permitted to call this hook
    constructor(IBinPoolManager _poolManager) BaseBinHook(_poolManager) {}

    /// @inheritdoc BaseBinHook
    /// @dev Generated by create-gully-core-hook. Change this and you MUST change the
    /// \`parameters\` word of every pool key that points at this hook.
    function getHooksRegistrationBitmap() public pure override returns (uint16) {
        return ${permissions.solidityExpression};
    }

    /// @dev Runs after the swap is executed: it can observe, not veto. The second return value
    /// is the hook's delta in the unspecified currency, read only when afterSwapReturnsDelta is
    /// registered; this hook takes nothing.
    function _afterSwap(address, PoolKey calldata key, bool, int128, BalanceDelta, bytes calldata)
        internal
        override
        returns (bytes4, int128)
    {
        PoolId poolId = key.toId();
        uint256 count = ++swapCount[poolId];
        emit SwapCounted(poolId, count);
        return (IBinHooks.afterSwap.selector, int128(0));
    }
}
`;
}

// ---------------------------------------------------------------------------
// test/<Hook>.t.sol
// ---------------------------------------------------------------------------

export function renderBinTest(ctx: BinProjectContext): string {
  const { contractName, permissions } = ctx;
  return `// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ${SOLC};

import {Test} from "forge-std/Test.sol";

import {Vault} from "infinity-core/src/Vault.sol";
import {IVault} from "infinity-core/src/interfaces/IVault.sol";
import {BinPoolManager} from "infinity-core/src/pool-bin/BinPoolManager.sol";
import {IBinPoolManager} from "infinity-core/src/pool-bin/interfaces/IBinPoolManager.sol";
import {IPoolManager} from "infinity-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "infinity-core/src/interfaces/IHooks.sol";
import {Hooks} from "infinity-core/src/libraries/Hooks.sol";
import {PoolKey} from "infinity-core/src/types/PoolKey.sol";
import {PoolId} from "infinity-core/src/types/PoolId.sol";
import {Currency} from "infinity-core/src/types/Currency.sol";
import {BalanceDelta} from "infinity-core/src/types/BalanceDelta.sol";
import {BinPoolParametersHelper} from "infinity-core/src/pool-bin/libraries/BinPoolParametersHelper.sol";
import {Constants} from "infinity-core/src/pool-bin/libraries/Constants.sol";
import {LiquidityConfigurations} from "infinity-core/src/pool-bin/libraries/math/LiquidityConfigurations.sol";
import {PackedUint128Math} from "infinity-core/src/pool-bin/libraries/math/PackedUint128Math.sol";
import {BinLiquidityHelper} from "infinity-core/test/pool-bin/helpers/BinLiquidityHelper.sol";
import {BinSwapHelper} from "infinity-core/test/pool-bin/helpers/BinSwapHelper.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {BaseBinHook} from "gullycore-hooks/src/base/BaseBinHook.sol";

import {${contractName}} from "../src/${contractName}.sol";

/// @title ${contractName}Test
/// @notice Deploys the whole settlement stack in memory - Vault, BinPoolManager, mint and swap
/// helpers and two mock tokens - initializes a Bin pool that registers ${contractName}, and
/// exercises it end to end.
contract ${contractName}Test is Test {
    /*//////////////////////////////////////////////////////////////
        The two values that must never disagree.

        EXPECTED_BITMAP is what the hook reports from getHooksRegistrationBitmap();
        EXPECTED_PARAMETERS is the pool key word that carries it, alongside the bin
        step. \`Hooks.validateHookConfig\` compares them at initialize() and reverts
        on a mismatch. Both were generated together by create-gully-core-hook.
        Enabled callbacks: ${permissions.names.join(", ")}
    //////////////////////////////////////////////////////////////*/
    uint16 internal constant EXPECTED_BITMAP = ${permissions.bitmapHex};
    // forge-lint: disable-next-line(too-many-digits)
    bytes32 internal constant EXPECTED_PARAMETERS = ${ctx.parameters};

    uint16 internal constant BIN_STEP = ${ctx.binStep};
    uint24 internal constant LP_FEE = ${ctx.lpFee};

    /// @dev Bin id 2^23 is price 1 whatever the bin step.
    uint24 internal constant ACTIVE_ID = 2 ** 23;
    /// @dev Liquidity spread over this many bins on each side of the active bin (active included).
    uint256 internal constant BINS_EACH_SIDE = 10;

    uint8 internal constant TOKEN_DECIMALS = 18;
    uint256 internal constant STARTING_BALANCE = 1_000_000 ether;
    uint128 internal constant LIQUIDITY_AMOUNT = 10_000 ether;

    /// @dev Negative amounts are exact-input swaps.
    int128 internal constant SWAP_AMOUNT = -1 ether;
    int128 internal constant SMALL_SWAP_AMOUNT = -0.1 ether;
    uint256 internal constant THREE_SWAPS = 3;

    Vault internal vault;
    BinPoolManager internal poolManager;
    BinLiquidityHelper internal liquidityHelper;
    BinSwapHelper internal swapHelper;
    MockERC20 internal token0;
    MockERC20 internal token1;
    ${contractName} internal hook;
    PoolKey internal key;

    function setUp() public {
        vault = new Vault();
        poolManager = new BinPoolManager(IVault(address(vault)));

        // The pool manager moves funds on the Vault's books, so it has to be
        // registered. registerApp is irreversible on a real deployment.
        vault.registerApp(address(poolManager));

        liquidityHelper = new BinLiquidityHelper(poolManager, vault);
        swapHelper = new BinSwapHelper(poolManager, vault);

        MockERC20 tokenA = new MockERC20("Gully Core Test Token A", "LTA", TOKEN_DECIMALS);
        MockERC20 tokenB = new MockERC20("Gully Core Test Token B", "LTB", TOKEN_DECIMALS);
        (token0, token1) = address(tokenA) < address(tokenB) ? (tokenA, tokenB) : (tokenB, tokenA);

        token0.mint(address(this), STARTING_BALANCE);
        token1.mint(address(this), STARTING_BALANCE);
        require(token0.approve(address(liquidityHelper), type(uint256).max), "token0 approval rejected");
        require(token1.approve(address(liquidityHelper), type(uint256).max), "token1 approval rejected");
        require(token0.approve(address(swapHelper), type(uint256).max), "token0 approval rejected");
        require(token1.approve(address(swapHelper), type(uint256).max), "token1 approval rejected");

        hook = new ${contractName}(poolManager);

        key = _keyWithHook(address(hook));
        _initialize(key);
        _addLiquidity(key);
    }

    /*//////////////////////////////////////////////////////////////
                        THE CONFIGURATION INVARIANT
    //////////////////////////////////////////////////////////////*/

    /// @notice The hook's own bitmap, the pool key's bitmap and the generated constant agree.
    function test_registrationBitmapMatchesPoolKey() public view {
        assertEq(hook.getHooksRegistrationBitmap(), EXPECTED_BITMAP, "hook bitmap drifted");
        assertEq(uint16(uint256(key.parameters)), EXPECTED_BITMAP, "pool key bitmap drifted");
        assertEq(BinPoolParametersHelper.getBinStep(key.parameters), BIN_STEP, "bin step drifted");
    }

    /// @notice A pool key whose bitmap does not match the hook cannot be created.
    function test_mismatchedBitmapRevertsAtInitialize() public {
        PoolKey memory mismatched = _keyWithHook(address(hook));
        mismatched.parameters = bytes32(uint256(EXPECTED_PARAMETERS) ^ 1); // flip bit 0

        vm.expectRevert(Hooks.HookConfigValidationError.selector);
        poolManager.initialize(mismatched, ACTIVE_ID);
    }

    /// @notice The hook works from an address with no special bits at all: permissions live in
    /// the pool key, so there is no salt to mine.
    function test_hookWorksFromAnArbitraryAddress() public {
        address arbitrary = address(0xDEAD);
        vm.etch(arbitrary, address(hook).code);

        PoolKey memory otherKey = _keyWithHook(arbitrary);
        _initialize(otherKey);
        _addLiquidity(otherKey);

        BalanceDelta delta = _swap(otherKey, true, SMALL_SWAP_AMOUNT);
        assertLt(delta.amount0(), 0, "swap did not spend token0");
        assertGt(delta.amount1(), 0, "swap did not return token1");
    }

    /*//////////////////////////////////////////////////////////////
                              BEHAVIOUR
    //////////////////////////////////////////////////////////////*/

    /// @notice The pool is live: the active bin holds both tokens and swaps execute.
    function test_poolAcceptsLiquidityAndSwaps() public {
        // forge-lint: disable-next-line(unused-return)
        (uint128 reserveX, uint128 reserveY,,) = poolManager.getBin(key.toId(), ACTIVE_ID);
        assertGt(reserveX, 0, "active bin holds no token0");
        assertGt(reserveY, 0, "active bin holds no token1");

        BalanceDelta delta = _swap(key, true, SWAP_AMOUNT);
        assertEq(delta.amount0(), SWAP_AMOUNT, "exact input was not consumed exactly");
        assertGt(delta.amount1(), 0, "swap returned nothing");
    }

    /// @notice Swapping the other way round works too.
    function test_swapYForX() public {
        BalanceDelta delta = _swap(key, false, SWAP_AMOUNT);
        assertEq(delta.amount1(), SWAP_AMOUNT, "exact input was not consumed exactly");
        assertGt(delta.amount0(), 0, "swap returned nothing");
    }

    /// @notice Every swap bumps the counter for its own pool, and only its own pool.
    function test_countsSwapsPerPool() public {
        PoolId poolId = key.toId();
        assertEq(hook.swapCount(poolId), 0, "counter should start at zero");

        _swap(key, true, SMALL_SWAP_AMOUNT);
        _swap(key, false, SMALL_SWAP_AMOUNT);
        _swap(key, true, SMALL_SWAP_AMOUNT);

        assertEq(hook.swapCount(poolId), THREE_SWAPS, "counter did not follow the swaps");

        PoolKey memory other = _keyWithHook(address(hook));
        other.parameters = BinPoolParametersHelper.setBinStep(bytes32(uint256(EXPECTED_BITMAP)), BIN_STEP + 1);
        _initialize(other);
        _addLiquidity(other);
        _swap(other, true, SMALL_SWAP_AMOUNT);
        assertEq(hook.swapCount(other.toId()), 1, "the second pool did not count its own swap");
        assertEq(hook.swapCount(poolId), THREE_SWAPS, "the first pool counted another pool's swap");
    }

    /// @notice The callback is not reachable except through the pool manager.
    function test_afterSwapRejectsDirectCalls() public {
        vm.expectRevert(BaseBinHook.NotPoolManager.selector);
        // forge-lint: disable-next-line(unused-return)
        hook.afterSwap(address(this), key, true, SMALL_SWAP_AMOUNT, BalanceDelta.wrap(0), "");
    }

    /// @notice A callback the hook does not declare is never called: minting does not reach it.
    function test_undeclaredCallbacksAreNotCalled() public {
        vm.expectRevert(BaseBinHook.HookNotImplemented.selector);
        vm.prank(address(poolManager));
        // forge-lint: disable-next-line(unused-return)
        hook.beforeSwap(address(this), key, true, SMALL_SWAP_AMOUNT, "");
        // and the pool still trades, because the pool manager never calls beforeSwap on this key
        _swap(key, true, SMALL_SWAP_AMOUNT);
    }

    /*//////////////////////////////////////////////////////////////
                               HELPERS
    //////////////////////////////////////////////////////////////*/

    function _keyWithHook(address hookAddress) internal view returns (PoolKey memory) {
        return PoolKey({
            currency0: Currency.wrap(address(token0)),
            currency1: Currency.wrap(address(token1)),
            hooks: IHooks(hookAddress),
            poolManager: IPoolManager(address(poolManager)),
            fee: LP_FEE,
            parameters: EXPECTED_PARAMETERS
        });
    }

    function _initialize(PoolKey memory poolKey) internal {
        poolManager.initialize(poolKey, ACTIVE_ID);
        // forge-lint: disable-next-line(unused-return)
        (uint24 activeId,,) = poolManager.getSlot0(poolKey.toId());
        assertEq(activeId, ACTIVE_ID, "pool did not start at the price-1 bin");
    }

    /// @dev Spreads token1 over the active bin and the bins below it, token0 over the active bin
    /// and the bins above it: the usual two-sided shape.
    function _addLiquidity(PoolKey memory poolKey) internal {
        uint256 total = BINS_EACH_SIDE * 2 - 1;
        // 1e18 / 10 fits a uint64 many times over.
        // forge-lint: disable-next-line(unsafe-typecast)
        uint64 share = uint64(Constants.PRECISION / BINS_EACH_SIDE);
        bytes32[] memory configs = new bytes32[](total);
        for (uint256 i = 0; i < total; ++i) {
            // forge-lint: disable-next-line(unsafe-typecast)
            uint24 id = uint24(uint256(ACTIVE_ID) + i - (BINS_EACH_SIDE - 1));
            configs[i] = LiquidityConfigurations.encodeParams(
                id >= ACTIVE_ID ? share : 0, id <= ACTIVE_ID ? share : 0, id
            );
        }
        IBinPoolManager.MintParams memory params = IBinPoolManager.MintParams({
            liquidityConfigs: configs,
            amountIn: PackedUint128Math.encode(LIQUIDITY_AMOUNT, LIQUIDITY_AMOUNT),
            salt: bytes32(0)
        });

        BalanceDelta delta = liquidityHelper.mint(poolKey, params, "");
        assertLt(delta.amount0(), 0, "adding liquidity cost no token0");
        assertLt(delta.amount1(), 0, "adding liquidity cost no token1");
    }

    function _swap(PoolKey memory poolKey, bool swapForY, int128 amountSpecified) internal returns (BalanceDelta) {
        return swapHelper.swap(
            poolKey,
            swapForY,
            amountSpecified,
            BinSwapHelper.TestSettings({withdrawTokens: true, settleUsingTransfer: true}),
            ""
        );
    }
}
`;
}

// ---------------------------------------------------------------------------
// script/Deploy<Hook>.s.sol
// ---------------------------------------------------------------------------

export function renderBinDeployScript(ctx: BinProjectContext): string {
  const { contractName, permissions } = ctx;
  return `// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ${SOLC};

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";

import {IBinPoolManager} from "infinity-core/src/pool-bin/interfaces/IBinPoolManager.sol";
import {BinPoolParametersHelper} from "infinity-core/src/pool-bin/libraries/BinPoolParametersHelper.sol";

import {${contractName}} from "../src/${contractName}.sol";

/// @title Deploy${contractName}
/// @notice Deploys the hook and prints the exact \`parameters\` word its Bin pools need.
///
/// @dev Usage against a local node started with \`gullycore devnet\`:
///
///   forge script script/Deploy${contractName}.s.sol:Deploy${contractName} \\
///       --rpc-url http://127.0.0.1:8545 --broadcast
///
/// Environment:
///   PRIVATE_KEY        deployer key (the devnet prints one)
///   BIN_POOL_MANAGER   address of BinPoolManager (the devnet prints it)
///   BIN_STEP           optional, defaults to ${ctx.binStep}
contract Deploy${contractName} is Script {
    /// @dev Generated alongside the hook's getHooksRegistrationBitmap(). The assertion below
    /// is what keeps the two honest at deploy time.
    uint16 internal constant EXPECTED_BITMAP = ${permissions.bitmapHex};

    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address binPoolManager = vm.envAddress("BIN_POOL_MANAGER");
        uint256 rawBinStep = vm.envOr("BIN_STEP", uint256(${ctx.binStep}));
        require(rawBinStep >= 1 && rawBinStep <= type(uint16).max, "BIN_STEP outside a uint16 above zero");
        // forge-lint: disable-next-line(unsafe-typecast)
        uint16 binStep = uint16(rawBinStep);

        vm.startBroadcast(deployerPrivateKey);
        ${contractName} hook = new ${contractName}(IBinPoolManager(binPoolManager));
        vm.stopBroadcast();

        uint16 onChainBitmap = hook.getHooksRegistrationBitmap();
        require(onChainBitmap == EXPECTED_BITMAP, "bitmap drifted from the generated constant");

        bytes32 parameters = BinPoolParametersHelper.setBinStep(bytes32(uint256(onChainBitmap)), binStep);

        console.log("");
        console.log("=== ${contractName} deployed ===");
        console.log("hook                :", address(hook));
        console.log("registration bitmap :", vm.toString(onChainBitmap));
        console.log("pool key parameters :", vm.toString(parameters));
        console.log("pool fee            : ${ctx.lpFee} (${(ctx.lpFee / 10_000).toFixed(4)}%)");
        console.log("");
        console.log("Use that parameters word verbatim in your PoolKey. Any other value");
        console.log("makes BinPoolManager.initialize revert with HookConfigValidationError.");
    }
}
`;
}

// ---------------------------------------------------------------------------
// foundry.toml, gullycore.json, README.md, CLAUDE.md / AGENTS.md
// ---------------------------------------------------------------------------

export function renderBinFoundryToml(ctx: BinProjectContext): string {
  return renderFoundryToml({ paths: ctx.paths, cliVersion: ctx.cliVersion });
}

export function renderBinGullyCoreConfig(ctx: BinProjectContext): string {
  return `${JSON.stringify(
    {
      $schema: "https://gullycore.dev/schema/hook-project.json",
      generatedBy: `create-gully-core-hook@${ctx.cliVersion}`,
      poolType: "Bin",
      contract: ctx.contractName,
      template: ctx.template.id,
      permissions: { names: ctx.permissions.names, bitmap: ctx.permissions.bitmap, bitmapHex: ctx.permissions.bitmapHex },
      poolKey: { parameters: ctx.parameters, binStep: ctx.binStep, fee: ctx.lpFee },
    },
    null,
    2,
  )}\n`;
}

export function renderBinReadme(ctx: BinProjectContext): string {
  const { contractName, permissions, template, projectName } = ctx;
  const rows = permissions.names.map((n) => `| ${BIN_HOOK_FLAGS[n]} | \`${n}\` | \`_${n}\` |`).join("\n");
  return `# ${projectName}

A [Gully Core](https://gullychain.xyz/core) **Bin** pool hook (a Gully Core), generated by
\`create-gully-core-hook\` from the \`${template.id}\` template.

${template.description.charAt(0).toUpperCase()}${template.description.slice(1)}.

## Quickstart

\`\`\`bash
forge build
forge test -vv
FOUNDRY_PROFILE=legacy forge test -vv   # chains without EIP-1153
\`\`\`

To try it against a local node:

\`\`\`bash
gullycore devnet                      # in another terminal; prints BIN_POOL_MANAGER and a key

export PRIVATE_KEY=0x...          # PowerShell: $env:PRIVATE_KEY = "0x..."
export BIN_POOL_MANAGER=0x...
forge script script/Deploy${contractName}.s.sol:Deploy${contractName} \\
    --rpc-url http://127.0.0.1:8545 --broadcast
\`\`\`

## The one thing that must not drift

\`\`\`
registration bitmap   ${permissions.bitmapHex}
pool key parameters   ${ctx.parameters}
bin step              ${ctx.binStep}
pool fee              ${ctx.lpFee} (${(ctx.lpFee / 10_000).toFixed(2)}%), static
\`\`\`

\`BinPoolManager.initialize\` reads the low 16 bits of \`poolKey.parameters\` and compares them
with \`getHooksRegistrationBitmap()\` (\`Hooks.validateHookConfig\`); a mismatch reverts with
\`HookConfigValidationError\`. The bin step sits in the same word. Both values above were
generated together, and \`test_registrationBitmapMatchesPoolKey\` fails if they stop agreeing.

### Registered callbacks

| bit | callback | implemented in |
| --: | -------- | -------------- |
${rows}

## Layout

\`\`\`
src/${contractName}.sol             the hook (extends BaseBinHook)
test/${contractName}.t.sol          Vault + BinPoolManager + mint/swap helpers, end to end
script/Deploy${contractName}.s.sol  deploys and prints the pool key parameters
foundry.toml                        remappings and the two build profiles
gullycore.json                       machine-readable record of the above
\`\`\`

## How a Bin pool differs from a CL pool

- Liquidity sits in discrete bins; bin id \`2^23\` is price 1. \`initialize(key, activeId)\` takes
  a bin id, not a sqrt price.
- The callbacks are \`beforeMint\` / \`afterMint\` / \`beforeBurn\` / \`afterBurn\` instead of the
  add/remove-liquidity pair, and the swap callbacks take \`swapForY\` and an \`int128\` amount.
- A fee override is at most 10% on a Bin pool (\`LPFeeLibrary.TEN_PERCENT_FEE\`), and a mint into
  the ACTIVE bin is charged a composition fee that \`beforeMint\` can set.
- \`afterBurn\` (and \`beforeBurn\`) run on every withdrawal: one that can revert traps a
  provider's principal. Never let it revert on a condition the provider cannot clear.

## Security checklist before you ship

- Every callback is \`onlyPoolManager\` via \`BaseBinHook\`. Do not add an external
  state-mutating function that assumes it is reached only from a callback.
- Declaring a permission you have not implemented is not a silent no-op: \`BaseBinHook\`'s
  default override points revert with \`HookNotImplemented\`.
- \`*ReturnsDelta\` permissions let the hook move user funds; they are bounded by the swap and
  by nothing else.
`;
}

export function renderBinAgentGuide(ctx: BinProjectContext, rules: string): string {
  const { contractName, permissions, projectName } = ctx;
  const body = rules.replace(/\r\n/g, "\n").replace(/^# .*\n+/, "");
  return `# ${projectName}: guide for coding agents

This project is a Gully Core (a hook) for a **Bin** pool on Gully Core, generated by
\`create-gully-core-hook\` ${ctx.cliVersion}. Read this file before you change anything.

## This project

| | |
|---|---|
| Pool type | Bin (\`BinPoolManager\`; the hook extends \`BaseBinHook\`) |
| Contract | \`src/${contractName}.sol\` |
| Test | \`test/${contractName}.t.sol\` |
| Deploy script | \`script/Deploy${contractName}.s.sol\` |
| Callbacks declared | ${permissions.names.map((n) => `\`${n}\``).join(", ")} |
| Registration bitmap | \`${permissions.bitmapHex}\` |
| Pool key \`parameters\` | \`${ctx.parameters}\` |
| Bin step | ${ctx.binStep} |
| Pool fee | static, \`${ctx.lpFee}\`: a fee the Gully Core returns is IGNORED on this pool |
| Contracts it compiles against | \`${ctx.paths.core}\` and \`${ctx.paths.hooks}\` |

\`\`\`bash
forge test -vv                        # default profile
FOUNDRY_PROFILE=legacy forge test     # chains without EIP-1153
\`\`\`

- **The bitmap and the parameters word were generated together.** Change the callbacks and you
  change both: the bitmap is the OR of \`BaseBinHook\`'s constants for the callbacks you declare
  (the SDK's \`encodeBinHookPermissions\` computes it off chain), and the word is
  \`BinPoolParametersHelper.setBinStep(bytes32(uint256(bitmap)), binStep)\` (the SDK's
  \`encodeBinPoolParameters\`). \`gullycore bitmap\` is for CL pools only. Update the contract, the
  test, the deploy script and \`gullycore.json\` in the same change.
- **Never edit anything under \`lib/\`.** Those are the deployed contracts, at a pinned commit.
- **Do not deploy or send a transaction on a real chain.** Give the command and say what it does.

${body}`;
}
