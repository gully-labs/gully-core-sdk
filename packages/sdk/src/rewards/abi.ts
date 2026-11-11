// SPDX-License-Identifier: MIT
// -----------------------------------------------------------------------------
// ABI of GullyCoreLiquidityRewardsHook (packages/lp-rewards), copied from the compiled
// artifact (constructor and internalType omitted). test/rewards.abi.test.ts compares
// it with packages/lp-rewards/foundry-out when that build exists.
// -----------------------------------------------------------------------------

/** `GullyCoreLiquidityRewardsHook`: 65 functions, 20 events, 50 errors. */
export const LP_REWARDS_ABI = [
  {
    "type": "function",
    "name": "ABSOLUTE_MAX_PROTOCOL_FEE_BPS",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint16"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "MAX_DELAY",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint64"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "MAX_FEE_NOTICE_SECONDS",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "MAX_REWARD_TOKENS",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint8"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "MAX_STREAM_DURATION",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "MIN_DELAY",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint64"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "MIN_ELIGIBLE_LIQUIDITY",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint128"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "MIN_FEE_NOTICE_SECONDS",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "MIN_STREAM_DURATION",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "MIN_TOPUP_REMAINING",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "POSITION_MANAGER",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "RECLAIM_DELAY",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint64"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "RECYCLE_DELAY",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint64"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "acceptOwnership",
    "inputs": [],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "acceptPoolOwnership",
    "inputs": [
      {
        "name": "id",
        "type": "bytes32"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "afterAddLiquidity",
    "inputs": [
      {
        "name": "sender",
        "type": "address"
      },
      {
        "name": "key",
        "type": "tuple",
        "components": [
          {
            "name": "currency0",
            "type": "address"
          },
          {
            "name": "currency1",
            "type": "address"
          },
          {
            "name": "hooks",
            "type": "address"
          },
          {
            "name": "poolManager",
            "type": "address"
          },
          {
            "name": "fee",
            "type": "uint24"
          },
          {
            "name": "parameters",
            "type": "bytes32"
          }
        ]
      },
      {
        "name": "params",
        "type": "tuple",
        "components": [
          {
            "name": "tickLower",
            "type": "int24"
          },
          {
            "name": "tickUpper",
            "type": "int24"
          },
          {
            "name": "liquidityDelta",
            "type": "int256"
          },
          {
            "name": "salt",
            "type": "bytes32"
          }
        ]
      },
      {
        "name": "delta",
        "type": "int256"
      },
      {
        "name": "feesAccrued",
        "type": "int256"
      },
      {
        "name": "hookData",
        "type": "bytes"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes4"
      },
      {
        "name": "",
        "type": "int256"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "afterDonate",
    "inputs": [
      {
        "name": "sender",
        "type": "address"
      },
      {
        "name": "key",
        "type": "tuple",
        "components": [
          {
            "name": "currency0",
            "type": "address"
          },
          {
            "name": "currency1",
            "type": "address"
          },
          {
            "name": "hooks",
            "type": "address"
          },
          {
            "name": "poolManager",
            "type": "address"
          },
          {
            "name": "fee",
            "type": "uint24"
          },
          {
            "name": "parameters",
            "type": "bytes32"
          }
        ]
      },
      {
        "name": "amount0",
        "type": "uint256"
      },
      {
        "name": "amount1",
        "type": "uint256"
      },
      {
        "name": "hookData",
        "type": "bytes"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes4"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "afterInitialize",
    "inputs": [
      {
        "name": "sender",
        "type": "address"
      },
      {
        "name": "key",
        "type": "tuple",
        "components": [
          {
            "name": "currency0",
            "type": "address"
          },
          {
            "name": "currency1",
            "type": "address"
          },
          {
            "name": "hooks",
            "type": "address"
          },
          {
            "name": "poolManager",
            "type": "address"
          },
          {
            "name": "fee",
            "type": "uint24"
          },
          {
            "name": "parameters",
            "type": "bytes32"
          }
        ]
      },
      {
        "name": "sqrtPriceX96",
        "type": "uint160"
      },
      {
        "name": "tick",
        "type": "int24"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes4"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "afterRemoveLiquidity",
    "inputs": [
      {
        "name": "sender",
        "type": "address"
      },
      {
        "name": "key",
        "type": "tuple",
        "components": [
          {
            "name": "currency0",
            "type": "address"
          },
          {
            "name": "currency1",
            "type": "address"
          },
          {
            "name": "hooks",
            "type": "address"
          },
          {
            "name": "poolManager",
            "type": "address"
          },
          {
            "name": "fee",
            "type": "uint24"
          },
          {
            "name": "parameters",
            "type": "bytes32"
          }
        ]
      },
      {
        "name": "params",
        "type": "tuple",
        "components": [
          {
            "name": "tickLower",
            "type": "int24"
          },
          {
            "name": "tickUpper",
            "type": "int24"
          },
          {
            "name": "liquidityDelta",
            "type": "int256"
          },
          {
            "name": "salt",
            "type": "bytes32"
          }
        ]
      },
      {
        "name": "delta",
        "type": "int256"
      },
      {
        "name": "feesAccrued",
        "type": "int256"
      },
      {
        "name": "hookData",
        "type": "bytes"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes4"
      },
      {
        "name": "",
        "type": "int256"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "afterSwap",
    "inputs": [
      {
        "name": "sender",
        "type": "address"
      },
      {
        "name": "key",
        "type": "tuple",
        "components": [
          {
            "name": "currency0",
            "type": "address"
          },
          {
            "name": "currency1",
            "type": "address"
          },
          {
            "name": "hooks",
            "type": "address"
          },
          {
            "name": "poolManager",
            "type": "address"
          },
          {
            "name": "fee",
            "type": "uint24"
          },
          {
            "name": "parameters",
            "type": "bytes32"
          }
        ]
      },
      {
        "name": "params",
        "type": "tuple",
        "components": [
          {
            "name": "zeroForOne",
            "type": "bool"
          },
          {
            "name": "amountSpecified",
            "type": "int256"
          },
          {
            "name": "sqrtPriceLimitX96",
            "type": "uint160"
          }
        ]
      },
      {
        "name": "delta",
        "type": "int256"
      },
      {
        "name": "hookData",
        "type": "bytes"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes4"
      },
      {
        "name": "",
        "type": "int128"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "allowRewardToken",
    "inputs": [
      {
        "name": "key",
        "type": "tuple",
        "components": [
          {
            "name": "currency0",
            "type": "address"
          },
          {
            "name": "currency1",
            "type": "address"
          },
          {
            "name": "hooks",
            "type": "address"
          },
          {
            "name": "poolManager",
            "type": "address"
          },
          {
            "name": "fee",
            "type": "uint24"
          },
          {
            "name": "parameters",
            "type": "bytes32"
          }
        ]
      },
      {
        "name": "token",
        "type": "address"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "beforeAddLiquidity",
    "inputs": [
      {
        "name": "sender",
        "type": "address"
      },
      {
        "name": "key",
        "type": "tuple",
        "components": [
          {
            "name": "currency0",
            "type": "address"
          },
          {
            "name": "currency1",
            "type": "address"
          },
          {
            "name": "hooks",
            "type": "address"
          },
          {
            "name": "poolManager",
            "type": "address"
          },
          {
            "name": "fee",
            "type": "uint24"
          },
          {
            "name": "parameters",
            "type": "bytes32"
          }
        ]
      },
      {
        "name": "params",
        "type": "tuple",
        "components": [
          {
            "name": "tickLower",
            "type": "int24"
          },
          {
            "name": "tickUpper",
            "type": "int24"
          },
          {
            "name": "liquidityDelta",
            "type": "int256"
          },
          {
            "name": "salt",
            "type": "bytes32"
          }
        ]
      },
      {
        "name": "hookData",
        "type": "bytes"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes4"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "beforeDonate",
    "inputs": [
      {
        "name": "sender",
        "type": "address"
      },
      {
        "name": "key",
        "type": "tuple",
        "components": [
          {
            "name": "currency0",
            "type": "address"
          },
          {
            "name": "currency1",
            "type": "address"
          },
          {
            "name": "hooks",
            "type": "address"
          },
          {
            "name": "poolManager",
            "type": "address"
          },
          {
            "name": "fee",
            "type": "uint24"
          },
          {
            "name": "parameters",
            "type": "bytes32"
          }
        ]
      },
      {
        "name": "amount0",
        "type": "uint256"
      },
      {
        "name": "amount1",
        "type": "uint256"
      },
      {
        "name": "hookData",
        "type": "bytes"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes4"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "beforeInitialize",
    "inputs": [
      {
        "name": "sender",
        "type": "address"
      },
      {
        "name": "key",
        "type": "tuple",
        "components": [
          {
            "name": "currency0",
            "type": "address"
          },
          {
            "name": "currency1",
            "type": "address"
          },
          {
            "name": "hooks",
            "type": "address"
          },
          {
            "name": "poolManager",
            "type": "address"
          },
          {
            "name": "fee",
            "type": "uint24"
          },
          {
            "name": "parameters",
            "type": "bytes32"
          }
        ]
      },
      {
        "name": "sqrtPriceX96",
        "type": "uint160"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes4"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "beforeRemoveLiquidity",
    "inputs": [
      {
        "name": "sender",
        "type": "address"
      },
      {
        "name": "key",
        "type": "tuple",
        "components": [
          {
            "name": "currency0",
            "type": "address"
          },
          {
            "name": "currency1",
            "type": "address"
          },
          {
            "name": "hooks",
            "type": "address"
          },
          {
            "name": "poolManager",
            "type": "address"
          },
          {
            "name": "fee",
            "type": "uint24"
          },
          {
            "name": "parameters",
            "type": "bytes32"
          }
        ]
      },
      {
        "name": "params",
        "type": "tuple",
        "components": [
          {
            "name": "tickLower",
            "type": "int24"
          },
          {
            "name": "tickUpper",
            "type": "int24"
          },
          {
            "name": "liquidityDelta",
            "type": "int256"
          },
          {
            "name": "salt",
            "type": "bytes32"
          }
        ]
      },
      {
        "name": "hookData",
        "type": "bytes"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes4"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "beforeSwap",
    "inputs": [
      {
        "name": "sender",
        "type": "address"
      },
      {
        "name": "key",
        "type": "tuple",
        "components": [
          {
            "name": "currency0",
            "type": "address"
          },
          {
            "name": "currency1",
            "type": "address"
          },
          {
            "name": "hooks",
            "type": "address"
          },
          {
            "name": "poolManager",
            "type": "address"
          },
          {
            "name": "fee",
            "type": "uint24"
          },
          {
            "name": "parameters",
            "type": "bytes32"
          }
        ]
      },
      {
        "name": "params",
        "type": "tuple",
        "components": [
          {
            "name": "zeroForOne",
            "type": "bool"
          },
          {
            "name": "amountSpecified",
            "type": "int256"
          },
          {
            "name": "sqrtPriceLimitX96",
            "type": "uint160"
          }
        ]
      },
      {
        "name": "hookData",
        "type": "bytes"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes4"
      },
      {
        "name": "",
        "type": "int256"
      },
      {
        "name": "",
        "type": "uint24"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "cancelPendingProtocolFee",
    "inputs": [],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "claim",
    "inputs": [
      {
        "name": "id",
        "type": "bytes32"
      },
      {
        "name": "k",
        "type": "tuple",
        "components": [
          {
            "name": "sender",
            "type": "address"
          },
          {
            "name": "tickLower",
            "type": "int24"
          },
          {
            "name": "tickUpper",
            "type": "int24"
          },
          {
            "name": "salt",
            "type": "bytes32"
          }
        ]
      },
      {
        "name": "to",
        "type": "address"
      }
    ],
    "outputs": [
      {
        "name": "amounts",
        "type": "uint256[]"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "claimCredit",
    "inputs": [
      {
        "name": "token",
        "type": "address"
      },
      {
        "name": "to",
        "type": "address"
      }
    ],
    "outputs": [
      {
        "name": "amount",
        "type": "uint256"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "configureRewards",
    "inputs": [
      {
        "name": "key",
        "type": "tuple",
        "components": [
          {
            "name": "currency0",
            "type": "address"
          },
          {
            "name": "currency1",
            "type": "address"
          },
          {
            "name": "hooks",
            "type": "address"
          },
          {
            "name": "poolManager",
            "type": "address"
          },
          {
            "name": "fee",
            "type": "uint24"
          },
          {
            "name": "parameters",
            "type": "bytes32"
          }
        ]
      },
      {
        "name": "cfg",
        "type": "tuple",
        "components": [
          {
            "name": "rewardTokens",
            "type": "address[]"
          },
          {
            "name": "minWidthTicks",
            "type": "uint24"
          }
        ]
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "credit",
    "inputs": [
      {
        "name": "account",
        "type": "address"
      },
      {
        "name": "token",
        "type": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "earned",
    "inputs": [
      {
        "name": "id",
        "type": "bytes32"
      },
      {
        "name": "k",
        "type": "tuple",
        "components": [
          {
            "name": "sender",
            "type": "address"
          },
          {
            "name": "tickLower",
            "type": "int24"
          },
          {
            "name": "tickUpper",
            "type": "int24"
          },
          {
            "name": "salt",
            "type": "bytes32"
          }
        ]
      }
    ],
    "outputs": [
      {
        "name": "out",
        "type": "uint256[]"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "eligibleLiquidity",
    "inputs": [
      {
        "name": "id",
        "type": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint128"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "extendStream",
    "inputs": [
      {
        "name": "key",
        "type": "tuple",
        "components": [
          {
            "name": "currency0",
            "type": "address"
          },
          {
            "name": "currency1",
            "type": "address"
          },
          {
            "name": "hooks",
            "type": "address"
          },
          {
            "name": "poolManager",
            "type": "address"
          },
          {
            "name": "fee",
            "type": "uint24"
          },
          {
            "name": "parameters",
            "type": "bytes32"
          }
        ]
      },
      {
        "name": "token",
        "type": "address"
      },
      {
        "name": "amount",
        "type": "uint256"
      },
      {
        "name": "newFinish",
        "type": "uint64"
      }
    ],
    "outputs": [],
    "stateMutability": "payable"
  },
  {
    "type": "function",
    "name": "feeNoticeSeconds",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "flushProtocolFees",
    "inputs": [
      {
        "name": "token",
        "type": "address"
      }
    ],
    "outputs": [
      {
        "name": "amount",
        "type": "uint256"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "getHooksRegistrationBitmap",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint16"
      }
    ],
    "stateMutability": "pure"
  },
  {
    "type": "function",
    "name": "kind",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "maxProtocolFeeBps",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint16"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "mirroredTick",
    "inputs": [
      {
        "name": "id",
        "type": "bytes32"
      },
      {
        "name": "tick",
        "type": "int24"
      }
    ],
    "outputs": [
      {
        "name": "gross",
        "type": "uint128"
      },
      {
        "name": "net",
        "type": "int128"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "owner",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "pendingOwner",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "pendingPoolOwner",
    "inputs": [
      {
        "name": "id",
        "type": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "pendingProtocolFee",
    "inputs": [],
    "outputs": [
      {
        "name": "newFeeBps",
        "type": "uint16"
      },
      {
        "name": "effectiveAt",
        "type": "uint64"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "poolConfig",
    "inputs": [
      {
        "name": "id",
        "type": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "initialized",
        "type": "bool"
      },
      {
        "name": "tickSpacing",
        "type": "int24"
      },
      {
        "name": "lastTick",
        "type": "int24"
      },
      {
        "name": "minWidthTicks",
        "type": "uint24"
      },
      {
        "name": "mirroredTotal",
        "type": "uint128"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "poolManager",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "poolOwner",
    "inputs": [
      {
        "name": "id",
        "type": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "positionOf",
    "inputs": [
      {
        "name": "id",
        "type": "bytes32"
      },
      {
        "name": "k",
        "type": "tuple",
        "components": [
          {
            "name": "sender",
            "type": "address"
          },
          {
            "name": "tickLower",
            "type": "int24"
          },
          {
            "name": "tickUpper",
            "type": "int24"
          },
          {
            "name": "salt",
            "type": "bytes32"
          }
        ]
      }
    ],
    "outputs": [
      {
        "name": "liquidity",
        "type": "uint128"
      },
      {
        "name": "lastTouched",
        "type": "uint64"
      },
      {
        "name": "storedEarned",
        "type": "uint256[]"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "protocolFeeBps",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint16"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "protocolFeeRecipient",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "protocolOwed",
    "inputs": [
      {
        "name": "token",
        "type": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "reclaim",
    "inputs": [
      {
        "name": "id",
        "type": "bytes32"
      },
      {
        "name": "token",
        "type": "address"
      }
    ],
    "outputs": [
      {
        "name": "amount",
        "type": "uint256"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "recycle",
    "inputs": [
      {
        "name": "id",
        "type": "bytes32"
      },
      {
        "name": "k",
        "type": "tuple",
        "components": [
          {
            "name": "sender",
            "type": "address"
          },
          {
            "name": "tickLower",
            "type": "int24"
          },
          {
            "name": "tickUpper",
            "type": "int24"
          },
          {
            "name": "salt",
            "type": "bytes32"
          }
        ]
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "renounceOwnership",
    "inputs": [],
    "outputs": [],
    "stateMutability": "pure"
  },
  {
    "type": "function",
    "name": "rewardTokens",
    "inputs": [
      {
        "name": "id",
        "type": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "out",
        "type": "address[]"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "setProtocolFee",
    "inputs": [
      {
        "name": "newFeeBps",
        "type": "uint16"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "startStream",
    "inputs": [
      {
        "name": "key",
        "type": "tuple",
        "components": [
          {
            "name": "currency0",
            "type": "address"
          },
          {
            "name": "currency1",
            "type": "address"
          },
          {
            "name": "hooks",
            "type": "address"
          },
          {
            "name": "poolManager",
            "type": "address"
          },
          {
            "name": "fee",
            "type": "uint24"
          },
          {
            "name": "parameters",
            "type": "bytes32"
          }
        ]
      },
      {
        "name": "token",
        "type": "address"
      },
      {
        "name": "amount",
        "type": "uint256"
      },
      {
        "name": "duration",
        "type": "uint32"
      },
      {
        "name": "refundRecipient",
        "type": "address"
      }
    ],
    "outputs": [],
    "stateMutability": "payable"
  },
  {
    "type": "function",
    "name": "streamOf",
    "inputs": [
      {
        "name": "id",
        "type": "bytes32"
      },
      {
        "name": "token",
        "type": "address"
      }
    ],
    "outputs": [
      {
        "name": "rateX64",
        "type": "uint256"
      },
      {
        "name": "periodFinish",
        "type": "uint64"
      },
      {
        "name": "undistributed",
        "type": "uint256"
      },
      {
        "name": "refundRecipient",
        "type": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "streams",
    "inputs": [
      {
        "name": "id",
        "type": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "out",
        "type": "tuple[]",
        "components": [
          {
            "name": "token",
            "type": "address"
          },
          {
            "name": "rateX64",
            "type": "uint256"
          },
          {
            "name": "periodFinish",
            "type": "uint64"
          },
          {
            "name": "lastUpdate",
            "type": "uint64"
          },
          {
            "name": "undistributed",
            "type": "uint256"
          },
          {
            "name": "accruedUnpaid",
            "type": "uint256"
          },
          {
            "name": "refundRecipient",
            "type": "address"
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "sweep",
    "inputs": [
      {
        "name": "token",
        "type": "address"
      }
    ],
    "outputs": [
      {
        "name": "amount",
        "type": "uint256"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "topUp",
    "inputs": [
      {
        "name": "key",
        "type": "tuple",
        "components": [
          {
            "name": "currency0",
            "type": "address"
          },
          {
            "name": "currency1",
            "type": "address"
          },
          {
            "name": "hooks",
            "type": "address"
          },
          {
            "name": "poolManager",
            "type": "address"
          },
          {
            "name": "fee",
            "type": "uint24"
          },
          {
            "name": "parameters",
            "type": "bytes32"
          }
        ]
      },
      {
        "name": "token",
        "type": "address"
      },
      {
        "name": "amount",
        "type": "uint256"
      }
    ],
    "outputs": [],
    "stateMutability": "payable"
  },
  {
    "type": "function",
    "name": "totalOwed",
    "inputs": [
      {
        "name": "token",
        "type": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "transferOwnership",
    "inputs": [
      {
        "name": "newOwner",
        "type": "address"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "transferPoolOwnership",
    "inputs": [
      {
        "name": "id",
        "type": "bytes32"
      },
      {
        "name": "newOwner",
        "type": "address"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "zeroLiquiditySince",
    "inputs": [
      {
        "name": "id",
        "type": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint64"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "event",
    "name": "CreditClaimed",
    "inputs": [
      {
        "name": "account",
        "type": "address",
        "indexed": true
      },
      {
        "name": "token",
        "type": "address",
        "indexed": true
      },
      {
        "name": "to",
        "type": "address",
        "indexed": false
      },
      {
        "name": "amount",
        "type": "uint256",
        "indexed": false
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "OwnershipTransferStarted",
    "inputs": [
      {
        "name": "previousOwner",
        "type": "address",
        "indexed": true
      },
      {
        "name": "newOwner",
        "type": "address",
        "indexed": true
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "OwnershipTransferred",
    "inputs": [
      {
        "name": "previousOwner",
        "type": "address",
        "indexed": true
      },
      {
        "name": "newOwner",
        "type": "address",
        "indexed": true
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "PendingProtocolFeeCancelled",
    "inputs": [
      {
        "name": "cancelledBps",
        "type": "uint16",
        "indexed": false
      },
      {
        "name": "effectiveAt",
        "type": "uint64",
        "indexed": false
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "PoolOwnershipTransferStarted",
    "inputs": [
      {
        "name": "poolId",
        "type": "bytes32",
        "indexed": true
      },
      {
        "name": "previousOwner",
        "type": "address",
        "indexed": true
      },
      {
        "name": "newOwner",
        "type": "address",
        "indexed": true
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "PoolOwnershipTransferred",
    "inputs": [
      {
        "name": "poolId",
        "type": "bytes32",
        "indexed": true
      },
      {
        "name": "previousOwner",
        "type": "address",
        "indexed": true
      },
      {
        "name": "newOwner",
        "type": "address",
        "indexed": true
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "ProtocolFeeChanged",
    "inputs": [
      {
        "name": "previousBps",
        "type": "uint16",
        "indexed": false
      },
      {
        "name": "newBps",
        "type": "uint16",
        "indexed": false
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "ProtocolFeeIncreaseScheduled",
    "inputs": [
      {
        "name": "currentBps",
        "type": "uint16",
        "indexed": false
      },
      {
        "name": "newBps",
        "type": "uint16",
        "indexed": false
      },
      {
        "name": "effectiveAt",
        "type": "uint64",
        "indexed": false
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "ProtocolFeeTaken",
    "inputs": [
      {
        "name": "poolId",
        "type": "bytes32",
        "indexed": true
      },
      {
        "name": "token",
        "type": "address",
        "indexed": true
      },
      {
        "name": "amount",
        "type": "uint256",
        "indexed": false
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "ProtocolFeesFlushed",
    "inputs": [
      {
        "name": "token",
        "type": "address",
        "indexed": true
      },
      {
        "name": "to",
        "type": "address",
        "indexed": true
      },
      {
        "name": "amount",
        "type": "uint256",
        "indexed": false
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "Reclaimed",
    "inputs": [
      {
        "name": "poolId",
        "type": "bytes32",
        "indexed": true
      },
      {
        "name": "token",
        "type": "address",
        "indexed": true
      },
      {
        "name": "refundRecipient",
        "type": "address",
        "indexed": true
      },
      {
        "name": "amount",
        "type": "uint256",
        "indexed": false
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "Recycled",
    "inputs": [
      {
        "name": "poolId",
        "type": "bytes32",
        "indexed": true
      },
      {
        "name": "positionId",
        "type": "bytes32",
        "indexed": true
      },
      {
        "name": "token",
        "type": "address",
        "indexed": false
      },
      {
        "name": "amount",
        "type": "uint256",
        "indexed": false
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "RewardTokenAllowed",
    "inputs": [
      {
        "name": "poolId",
        "type": "bytes32",
        "indexed": true
      },
      {
        "name": "token",
        "type": "address",
        "indexed": true
      },
      {
        "name": "index",
        "type": "uint8",
        "indexed": false
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "RewardsClaimed",
    "inputs": [
      {
        "name": "poolId",
        "type": "bytes32",
        "indexed": true
      },
      {
        "name": "positionId",
        "type": "bytes32",
        "indexed": true
      },
      {
        "name": "to",
        "type": "address",
        "indexed": true
      },
      {
        "name": "token",
        "type": "address",
        "indexed": false
      },
      {
        "name": "amount",
        "type": "uint256",
        "indexed": false
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "RewardsConfigured",
    "inputs": [
      {
        "name": "poolId",
        "type": "bytes32",
        "indexed": true
      },
      {
        "name": "poolOwner",
        "type": "address",
        "indexed": true
      },
      {
        "name": "minWidthTicks",
        "type": "uint24",
        "indexed": false
      },
      {
        "name": "rewardTokens",
        "type": "address[]",
        "indexed": false
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "RewardsCredited",
    "inputs": [
      {
        "name": "poolId",
        "type": "bytes32",
        "indexed": true
      },
      {
        "name": "positionId",
        "type": "bytes32",
        "indexed": true
      },
      {
        "name": "recipient",
        "type": "address",
        "indexed": true
      },
      {
        "name": "token",
        "type": "address",
        "indexed": false
      },
      {
        "name": "amount",
        "type": "uint256",
        "indexed": false
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "StreamExtended",
    "inputs": [
      {
        "name": "poolId",
        "type": "bytes32",
        "indexed": true
      },
      {
        "name": "token",
        "type": "address",
        "indexed": true
      },
      {
        "name": "amount",
        "type": "uint256",
        "indexed": false
      },
      {
        "name": "rateX64",
        "type": "uint256",
        "indexed": false
      },
      {
        "name": "periodFinish",
        "type": "uint64",
        "indexed": false
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "StreamStarted",
    "inputs": [
      {
        "name": "poolId",
        "type": "bytes32",
        "indexed": true
      },
      {
        "name": "token",
        "type": "address",
        "indexed": true
      },
      {
        "name": "amount",
        "type": "uint256",
        "indexed": false
      },
      {
        "name": "rateX64",
        "type": "uint256",
        "indexed": false
      },
      {
        "name": "periodFinish",
        "type": "uint64",
        "indexed": false
      },
      {
        "name": "refundRecipient",
        "type": "address",
        "indexed": false
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "StreamToppedUp",
    "inputs": [
      {
        "name": "poolId",
        "type": "bytes32",
        "indexed": true
      },
      {
        "name": "token",
        "type": "address",
        "indexed": true
      },
      {
        "name": "from",
        "type": "address",
        "indexed": true
      },
      {
        "name": "amount",
        "type": "uint256",
        "indexed": false
      },
      {
        "name": "rateX64",
        "type": "uint256",
        "indexed": false
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "Swept",
    "inputs": [
      {
        "name": "token",
        "type": "address",
        "indexed": true
      },
      {
        "name": "to",
        "type": "address",
        "indexed": true
      },
      {
        "name": "amount",
        "type": "uint256",
        "indexed": false
      }
    ],
    "anonymous": false
  },
  {
    "type": "error",
    "name": "AddressEmptyCode",
    "inputs": [
      {
        "name": "target",
        "type": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "AddressInsufficientBalance",
    "inputs": [
      {
        "name": "account",
        "type": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "AmountTooLarge",
    "inputs": []
  },
  {
    "type": "error",
    "name": "DuplicateRewardToken",
    "inputs": []
  },
  {
    "type": "error",
    "name": "DurationOutOfRange",
    "inputs": []
  },
  {
    "type": "error",
    "name": "FailedInnerCall",
    "inputs": []
  },
  {
    "type": "error",
    "name": "FeeAboveCap",
    "inputs": [
      {
        "name": "feeBps",
        "type": "uint256"
      },
      {
        "name": "capBps",
        "type": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "FinishWouldMoveIn",
    "inputs": []
  },
  {
    "type": "error",
    "name": "HookNotImplemented",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidDelay",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidNotice",
    "inputs": [
      {
        "name": "noticeSeconds",
        "type": "uint32"
      }
    ]
  },
  {
    "type": "error",
    "name": "InvalidRefundRecipient",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidSqrtRatio",
    "inputs": [
      {
        "name": "sqrtPriceX96",
        "type": "uint160"
      }
    ]
  },
  {
    "type": "error",
    "name": "InvalidTick",
    "inputs": [
      {
        "name": "tick",
        "type": "int24"
      }
    ]
  },
  {
    "type": "error",
    "name": "MinWidthTooLarge",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NativeAmountMismatch",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NativeNotAccepted",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NoPendingFee",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NoStream",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotPendingPoolOwner",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotPoolManager",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotPoolOwner",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotPositionOwner",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NothingToClaim",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NothingToFlush",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NothingToReclaim",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NothingToRecycle",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NothingToSweep",
    "inputs": []
  },
  {
    "type": "error",
    "name": "OwnableInvalidOwner",
    "inputs": [
      {
        "name": "owner",
        "type": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "OwnableUnauthorizedAccount",
    "inputs": [
      {
        "name": "account",
        "type": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "PermissionDependencyMissing",
    "inputs": [
      {
        "name": "declared",
        "type": "uint16"
      }
    ]
  },
  {
    "type": "error",
    "name": "PoolAlreadyConfigured",
    "inputs": []
  },
  {
    "type": "error",
    "name": "PoolNotConfigured",
    "inputs": []
  },
  {
    "type": "error",
    "name": "PoolNotInitialized",
    "inputs": []
  },
  {
    "type": "error",
    "name": "PositionStillActive",
    "inputs": []
  },
  {
    "type": "error",
    "name": "RateWouldFall",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ReclaimTooSoon",
    "inputs": [
      {
        "name": "earliest",
        "type": "uint64"
      }
    ]
  },
  {
    "type": "error",
    "name": "RecycleTooSoon",
    "inputs": [
      {
        "name": "earliest",
        "type": "uint64"
      }
    ]
  },
  {
    "type": "error",
    "name": "ReentrancyGuardReentrantCall",
    "inputs": []
  },
  {
    "type": "error",
    "name": "RenounceDisabled",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ReservedBitsSet",
    "inputs": [
      {
        "name": "declared",
        "type": "uint16"
      }
    ]
  },
  {
    "type": "error",
    "name": "SafeERC20FailedOperation",
    "inputs": [
      {
        "name": "token",
        "type": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "StreamEndsTooSoon",
    "inputs": []
  },
  {
    "type": "error",
    "name": "StreamRunning",
    "inputs": []
  },
  {
    "type": "error",
    "name": "TokenNotAllowed",
    "inputs": []
  },
  {
    "type": "error",
    "name": "TooManyRewardTokens",
    "inputs": []
  },
  {
    "type": "error",
    "name": "WrongHook",
    "inputs": []
  },
  {
    "type": "error",
    "name": "WrongPoolManager",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ZeroAddress",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ZeroAmount",
    "inputs": []
  }
] as const;
