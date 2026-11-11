// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 DeepCoreProtocol
pragma solidity ^0.8.26;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";

import {BackendGuard} from "infinity-core/script/BackendGuard.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";

import {Vault} from "infinity-core/src/Vault.sol";
import {IVault} from "infinity-core/src/interfaces/IVault.sol";
import {CLPoolManager} from "infinity-core/src/pool-cl/CLPoolManager.sol";
import {ICLPoolManager} from "infinity-core/src/pool-cl/interfaces/ICLPoolManager.sol";
import {BinPoolManager} from "infinity-core/src/pool-bin/BinPoolManager.sol";
import {IPoolManager} from "infinity-core/src/interfaces/IPoolManager.sol";
import {IProtocolFees} from "infinity-core/src/interfaces/IProtocolFees.sol";
import {IProtocolFeeController} from "infinity-core/src/interfaces/IProtocolFeeController.sol";
import {IHooks} from "infinity-core/src/interfaces/IHooks.sol";
import {PoolKey} from "infinity-core/src/types/PoolKey.sol";
import {PoolId} from "infinity-core/src/types/PoolId.sol";
import {Currency} from "infinity-core/src/types/Currency.sol";
import {CLPoolParametersHelper} from "infinity-core/src/pool-cl/libraries/CLPoolParametersHelper.sol";
import {CLPoolManagerRouter} from "infinity-core/test/pool-cl/helpers/CLPoolManagerRouter.sol";

import {GullyCoreProtocolFeeController} from "gullycore-fees/src/GullyCoreProtocolFeeController.sol";

/// @title GullyCoreDevnet
/// @notice Deploys the whole Gully Core stack onto a local node in one transaction batch.
///
/// @dev Plain deployments, so the broadcasting deployer owns everything from the start. A
/// fresh anvil with its deterministic accounts gives the same addresses on every run, so
/// the CREATE3 factory a public chain needs for matching addresses has no job here.
///
/// It inherits `BackendGuard`, so the run aborts unless the compiled transient-storage
/// backend matches what the target chain supports. `gullycore devnet` writes the chain's
/// classification into `script/config/eip1153.json` before invoking this script.
///
/// Extras that only make sense locally, and are labelled as such in the output:
///   - two freely mintable MockERC20s (`mint` is public - fund yourself),
///   - `CLPoolManagerRouter`, the core test router, so pools are usable without
///     writing a lock callback by hand,
///   - one initialized, seeded, hookless CL pool.
contract GullyCoreDevnet is Script, BackendGuard {
    /// @dev sqrt(1) in Q64.96
    uint160 internal constant SQRT_PRICE_1_1 = 79228162514264337593543950336;

    int24 internal constant TICK_SPACING = 60;
    int24 internal constant TICK_LOWER = -6000;
    int24 internal constant TICK_UPPER = 6000;
    uint24 internal constant LP_FEE = 3000;

    uint256 internal constant MINT_AMOUNT = 1_000_000_000 ether;
    uint256 internal constant SEED_LIQUIDITY = 1_000_000 ether;

    function run() external {
        assertBackendMatchesChain();

        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);

        vm.startBroadcast(deployerPrivateKey);

        // 1. Vault and pool managers, owned by the deployer that creates them.
        address vault = address(new Vault());
        address clPoolManager = address(new CLPoolManager(IVault(vault)));
        address binPoolManager = address(new BinPoolManager(IVault(vault)));

        // registerApp is irreversible on a real deployment: a registered app can move
        // funds against the Vault forever. Locally it is just two calls.
        IVault(vault).registerApp(clPoolManager);
        IVault(vault).registerApp(binPoolManager);

        // 2. Protocol fee controller. `protocolFeeForPool` is staticcalled during pool
        //    initialization, so a broken controller bricks pool creation - which is why
        //    it is wired up here and exercised by the pool below.
        // Owner and guardian are both the devnet deployer. On a real deployment these
        // are different keys: the owner is the multisig+timelock that sets fees, the
        // guardian is the faster key that can only switch them off.
        GullyCoreProtocolFeeController feeController = new GullyCoreProtocolFeeController(deployer, deployer);
        IProtocolFees(clPoolManager).setProtocolFeeController(IProtocolFeeController(address(feeController)));
        IProtocolFees(binPoolManager).setProtocolFeeController(IProtocolFeeController(address(feeController)));

        // 3. Local-only conveniences.
        (MockERC20 token0, MockERC20 token1) = _deployTokens(deployer);
        CLPoolManagerRouter router = new CLPoolManagerRouter(IVault(vault), ICLPoolManager(clPoolManager));

        // 4. One live pool, hookless, with liquidity in range.
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(address(token0)),
            currency1: Currency.wrap(address(token1)),
            hooks: IHooks(address(0)),
            poolManager: IPoolManager(clPoolManager),
            fee: LP_FEE,
            parameters: CLPoolParametersHelper.setTickSpacing(bytes32(0), TICK_SPACING)
        });
        ICLPoolManager(clPoolManager).initialize(key, SQRT_PRICE_1_1);

        token0.approve(address(router), type(uint256).max);
        token1.approve(address(router), type(uint256).max);
        router.modifyPosition(
            key,
            ICLPoolManager.ModifyLiquidityParams({
                tickLower: TICK_LOWER,
                tickUpper: TICK_UPPER,
                liquidityDelta: int256(SEED_LIQUIDITY),
                salt: bytes32(0)
            }),
            ""
        );

        vm.stopBroadcast();

        _report(deployer, vault, clPoolManager, binPoolManager, address(feeController), address(router), token0, token1, key);
    }

    function _deployTokens(address deployer) private returns (MockERC20 token0, MockERC20 token1) {
        MockERC20 tokenA = new MockERC20("Gully Core Devnet USD", "dUSD", 18);
        MockERC20 tokenB = new MockERC20("Gully Core Devnet Ether", "dETH", 18);
        (token0, token1) = address(tokenA) < address(tokenB) ? (tokenA, tokenB) : (tokenB, tokenA);

        token0.mint(deployer, MINT_AMOUNT);
        token1.mint(deployer, MINT_AMOUNT);
    }

    struct Report {
        address deployer;
        address vault;
        address clPoolManager;
        address binPoolManager;
        address feeController;
        address router;
        address token0;
        address token1;
    }

    function _report(
        address deployer,
        address vault,
        address clPoolManager,
        address binPoolManager,
        address feeController,
        address router,
        MockERC20 token0,
        MockERC20 token1,
        PoolKey memory key
    ) private {
        Report memory r = Report({
            deployer: deployer,
            vault: vault,
            clPoolManager: clPoolManager,
            binPoolManager: binPoolManager,
            feeController: feeController,
            router: router,
            token0: address(token0),
            token1: address(token1)
        });

        console.log(string.concat("GULLYCORE_DEVNET_VAULT=", vm.toString(r.vault)));
        console.log(string.concat("GULLYCORE_DEVNET_CL_POOL_MANAGER=", vm.toString(r.clPoolManager)));
        console.log(string.concat("GULLYCORE_DEVNET_BIN_POOL_MANAGER=", vm.toString(r.binPoolManager)));

        // `gullycore devnet` reads this file rather than scraping the log, so the CLI
        // never has to guess at an address from formatted output.
        string memory obj = "gullycore-devnet";
        string memory out;
        out = vm.serializeUint(obj, "chainId", block.chainid);
        out = vm.serializeAddress(obj, "deployer", r.deployer);
        out = vm.serializeAddress(obj, "vault", r.vault);
        out = vm.serializeAddress(obj, "clPoolManager", r.clPoolManager);
        out = vm.serializeAddress(obj, "binPoolManager", r.binPoolManager);
        out = vm.serializeAddress(obj, "protocolFeeController", r.feeController);
        out = vm.serializeAddress(obj, "clPoolManagerRouter", r.router);
        out = vm.serializeAddress(obj, "token0", r.token0);
        out = vm.serializeAddress(obj, "token1", r.token1);
        out = vm.serializeString(obj, "token0Symbol", token0.symbol());
        out = vm.serializeString(obj, "token1Symbol", token1.symbol());
        out = vm.serializeBytes32(obj, "poolParameters", key.parameters);
        out = vm.serializeUint(obj, "poolFee", key.fee);
        out = vm.serializeInt(obj, "poolTickSpacing", TICK_SPACING);
        out = vm.serializeBytes32(obj, "poolId", PoolId.unwrap(key.toId()));

        vm.writeJson(out, "./deployments/devnet.json");
    }
}
