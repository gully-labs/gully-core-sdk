// SPDX-License-Identifier: MIT
// -----------------------------------------------------------------------------
// ABIs of GullyCoreManagedVault and GullyCoreVaultFactory (packages/vaults), copied from the
// compiled artifacts (constructor and internalType omitted). test/vaults.test.ts
// compares them with packages/vaults/foundry-out when that build exists.
// -----------------------------------------------------------------------------

/** `GullyCoreManagedVault`: 58 functions, 13 events, 48 errors. */
export const MANAGED_VAULT_ABI = [
  {
    "type": "receive",
    "stateMutability": "payable"
  },
  {
    "type": "function",
    "name": "ABSOLUTE_MAX_PERFORMANCE_FEE_BPS",
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
    "name": "CL_POOL_MANAGER",
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
    "name": "DEAD",
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
    "name": "DEAD_SHARES",
    "inputs": [],
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
    "name": "FACTORY",
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
    "name": "FORBIDDEN_HOOK_BITS",
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
    "name": "MAX_COOLDOWN",
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
    "name": "MAX_CURATOR_FEE_BPS",
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
    "name": "MAX_DEVIATION",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "int24"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "MAX_TWAP_WINDOW",
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
    "name": "MAX_WIDTH",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "int24"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "MIN_COOLDOWN",
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
    "name": "MIN_INITIAL_SHARES",
    "inputs": [],
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
    "name": "MIN_TWAP_WINDOW",
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
    "name": "ORACLE_GAS",
    "inputs": [],
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
    "name": "ORACLE_KIND",
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
    "name": "VAULT",
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
    "name": "acceptCurator",
    "inputs": [],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "allowance",
    "inputs": [
      {
        "name": "owner",
        "type": "address"
      },
      {
        "name": "spender",
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
    "name": "approve",
    "inputs": [
      {
        "name": "spender",
        "type": "address"
      },
      {
        "name": "value",
        "type": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "balanceOf",
    "inputs": [
      {
        "name": "account",
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
    "name": "base",
    "inputs": [],
    "outputs": [
      {
        "name": "lower",
        "type": "int24"
      },
      {
        "name": "upper",
        "type": "int24"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "claimCuratorFees",
    "inputs": [
      {
        "name": "to",
        "type": "address"
      }
    ],
    "outputs": [
      {
        "name": "amount0",
        "type": "uint256"
      },
      {
        "name": "amount1",
        "type": "uint256"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "config",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "tuple",
        "components": [
          {
            "name": "baseHalfWidth",
            "type": "int24"
          },
          {
            "name": "limitWidth",
            "type": "int24"
          },
          {
            "name": "maxDeviation",
            "type": "int24"
          },
          {
            "name": "rebalanceThreshold",
            "type": "int24"
          },
          {
            "name": "twapWindow",
            "type": "uint32"
          },
          {
            "name": "cooldown",
            "type": "uint32"
          },
          {
            "name": "curatorFeeBps",
            "type": "uint16"
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "curator",
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
    "name": "curatorOwed0",
    "inputs": [],
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
    "name": "curatorOwed1",
    "inputs": [],
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
    "name": "decimals",
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
    "name": "deposit",
    "inputs": [
      {
        "name": "shares",
        "type": "uint256"
      },
      {
        "name": "max0",
        "type": "uint256"
      },
      {
        "name": "max1",
        "type": "uint256"
      },
      {
        "name": "to",
        "type": "address"
      },
      {
        "name": "deadline",
        "type": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "amount0",
        "type": "uint256"
      },
      {
        "name": "amount1",
        "type": "uint256"
      }
    ],
    "stateMutability": "payable"
  },
  {
    "type": "function",
    "name": "depositInitial",
    "inputs": [
      {
        "name": "max0",
        "type": "uint256"
      },
      {
        "name": "max1",
        "type": "uint256"
      },
      {
        "name": "minShares",
        "type": "uint256"
      },
      {
        "name": "to",
        "type": "address"
      },
      {
        "name": "deadline",
        "type": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "shares",
        "type": "uint256"
      },
      {
        "name": "amount0",
        "type": "uint256"
      },
      {
        "name": "amount1",
        "type": "uint256"
      }
    ],
    "stateMutability": "payable"
  },
  {
    "type": "function",
    "name": "flushProtocolFees",
    "inputs": [],
    "outputs": [
      {
        "name": "amount0",
        "type": "uint256"
      },
      {
        "name": "amount1",
        "type": "uint256"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "harvest",
    "inputs": [],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "initialize",
    "inputs": [
      {
        "name": "p",
        "type": "tuple",
        "components": [
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
            "name": "oracleKey",
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
            "name": "config",
            "type": "tuple",
            "components": [
              {
                "name": "baseHalfWidth",
                "type": "int24"
              },
              {
                "name": "limitWidth",
                "type": "int24"
              },
              {
                "name": "maxDeviation",
                "type": "int24"
              },
              {
                "name": "rebalanceThreshold",
                "type": "int24"
              },
              {
                "name": "twapWindow",
                "type": "uint32"
              },
              {
                "name": "cooldown",
                "type": "uint32"
              },
              {
                "name": "curatorFeeBps",
                "type": "uint16"
              }
            ]
          }
        ]
      },
      {
        "name": "curator_",
        "type": "address"
      },
      {
        "name": "recipient_",
        "type": "address"
      },
      {
        "name": "performanceFeeBps_",
        "type": "uint16"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "lastRebalanceAt",
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
    "name": "limit",
    "inputs": [],
    "outputs": [
      {
        "name": "lower",
        "type": "int24"
      },
      {
        "name": "upper",
        "type": "int24"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "lockAcquired",
    "inputs": [
      {
        "name": "data",
        "type": "bytes"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "name",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "string"
      }
    ],
    "stateMutability": "pure"
  },
  {
    "type": "function",
    "name": "oracle",
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
    "name": "oraclePoolId",
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
    "name": "oraclePoolKey",
    "inputs": [],
    "outputs": [
      {
        "name": "",
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
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "pendingCurator",
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
    "name": "performanceFeeBps",
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
    "name": "poolId",
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
    "name": "poolKey",
    "inputs": [],
    "outputs": [
      {
        "name": "",
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
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "positionLiquidity",
    "inputs": [],
    "outputs": [
      {
        "name": "baseLiquidity",
        "type": "uint128"
      },
      {
        "name": "limitLiquidity",
        "type": "uint128"
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
    "name": "protocolOwed0",
    "inputs": [],
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
    "name": "protocolOwed1",
    "inputs": [],
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
    "name": "rebalance",
    "inputs": [],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "sweep",
    "inputs": [
      {
        "name": "currency",
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
    "name": "symbol",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "string"
      }
    ],
    "stateMutability": "pure"
  },
  {
    "type": "function",
    "name": "tickSpacing",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "int24"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "totalAmounts",
    "inputs": [],
    "outputs": [
      {
        "name": "total0",
        "type": "uint256"
      },
      {
        "name": "total1",
        "type": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "totalSupply",
    "inputs": [],
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
    "name": "transfer",
    "inputs": [
      {
        "name": "to",
        "type": "address"
      },
      {
        "name": "value",
        "type": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "transferCurator",
    "inputs": [
      {
        "name": "next",
        "type": "address"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "transferFrom",
    "inputs": [
      {
        "name": "from",
        "type": "address"
      },
      {
        "name": "to",
        "type": "address"
      },
      {
        "name": "value",
        "type": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "withdraw",
    "inputs": [
      {
        "name": "shares",
        "type": "uint256"
      },
      {
        "name": "min0",
        "type": "uint256"
      },
      {
        "name": "min1",
        "type": "uint256"
      },
      {
        "name": "to",
        "type": "address"
      },
      {
        "name": "deadline",
        "type": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "amount0",
        "type": "uint256"
      },
      {
        "name": "amount1",
        "type": "uint256"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "event",
    "name": "Approval",
    "inputs": [
      {
        "name": "owner",
        "type": "address",
        "indexed": true
      },
      {
        "name": "spender",
        "type": "address",
        "indexed": true
      },
      {
        "name": "value",
        "type": "uint256",
        "indexed": false
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "CuratorFeesClaimed",
    "inputs": [
      {
        "name": "curator",
        "type": "address",
        "indexed": true
      },
      {
        "name": "to",
        "type": "address",
        "indexed": true
      },
      {
        "name": "amount0",
        "type": "uint256",
        "indexed": false
      },
      {
        "name": "amount1",
        "type": "uint256",
        "indexed": false
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "CuratorTransferStarted",
    "inputs": [
      {
        "name": "previous",
        "type": "address",
        "indexed": true
      },
      {
        "name": "next",
        "type": "address",
        "indexed": true
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "CuratorTransferred",
    "inputs": [
      {
        "name": "previous",
        "type": "address",
        "indexed": true
      },
      {
        "name": "next",
        "type": "address",
        "indexed": true
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "Deposit",
    "inputs": [
      {
        "name": "sender",
        "type": "address",
        "indexed": true
      },
      {
        "name": "to",
        "type": "address",
        "indexed": true
      },
      {
        "name": "shares",
        "type": "uint256",
        "indexed": false
      },
      {
        "name": "amount0",
        "type": "uint256",
        "indexed": false
      },
      {
        "name": "amount1",
        "type": "uint256",
        "indexed": false
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "Harvested",
    "inputs": [
      {
        "name": "fee0",
        "type": "uint256",
        "indexed": false
      },
      {
        "name": "fee1",
        "type": "uint256",
        "indexed": false
      },
      {
        "name": "protocol0",
        "type": "uint256",
        "indexed": false
      },
      {
        "name": "protocol1",
        "type": "uint256",
        "indexed": false
      },
      {
        "name": "curator0",
        "type": "uint256",
        "indexed": false
      },
      {
        "name": "curator1",
        "type": "uint256",
        "indexed": false
      },
      {
        "name": "compounded",
        "type": "bool",
        "indexed": false
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "Initialized",
    "inputs": [
      {
        "name": "poolId",
        "type": "bytes32",
        "indexed": true
      },
      {
        "name": "oraclePoolId",
        "type": "bytes32",
        "indexed": true
      },
      {
        "name": "curator",
        "type": "address",
        "indexed": true
      },
      {
        "name": "performanceFeeBps",
        "type": "uint16",
        "indexed": false
      },
      {
        "name": "config",
        "type": "tuple",
        "indexed": false,
        "components": [
          {
            "name": "baseHalfWidth",
            "type": "int24"
          },
          {
            "name": "limitWidth",
            "type": "int24"
          },
          {
            "name": "maxDeviation",
            "type": "int24"
          },
          {
            "name": "rebalanceThreshold",
            "type": "int24"
          },
          {
            "name": "twapWindow",
            "type": "uint32"
          },
          {
            "name": "cooldown",
            "type": "uint32"
          },
          {
            "name": "curatorFeeBps",
            "type": "uint16"
          }
        ]
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "ProtocolFeesFlushed",
    "inputs": [
      {
        "name": "to",
        "type": "address",
        "indexed": true
      },
      {
        "name": "amount0",
        "type": "uint256",
        "indexed": false
      },
      {
        "name": "amount1",
        "type": "uint256",
        "indexed": false
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "Rebalanced",
    "inputs": [
      {
        "name": "caller",
        "type": "address",
        "indexed": true
      },
      {
        "name": "twapTick",
        "type": "int24",
        "indexed": false
      },
      {
        "name": "spotTick",
        "type": "int24",
        "indexed": false
      },
      {
        "name": "baseLower",
        "type": "int24",
        "indexed": false
      },
      {
        "name": "baseUpper",
        "type": "int24",
        "indexed": false
      },
      {
        "name": "limitLower",
        "type": "int24",
        "indexed": false
      },
      {
        "name": "limitUpper",
        "type": "int24",
        "indexed": false
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "Snapshot",
    "inputs": [
      {
        "name": "total0",
        "type": "uint256",
        "indexed": false
      },
      {
        "name": "total1",
        "type": "uint256",
        "indexed": false
      },
      {
        "name": "supply",
        "type": "uint256",
        "indexed": false
      },
      {
        "name": "sqrtPriceX96",
        "type": "uint160",
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
        "name": "currency",
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
    "name": "Transfer",
    "inputs": [
      {
        "name": "from",
        "type": "address",
        "indexed": true
      },
      {
        "name": "to",
        "type": "address",
        "indexed": true
      },
      {
        "name": "value",
        "type": "uint256",
        "indexed": false
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "Withdraw",
    "inputs": [
      {
        "name": "owner",
        "type": "address",
        "indexed": true
      },
      {
        "name": "to",
        "type": "address",
        "indexed": true
      },
      {
        "name": "shares",
        "type": "uint256",
        "indexed": false
      },
      {
        "name": "amount0",
        "type": "uint256",
        "indexed": false
      },
      {
        "name": "amount1",
        "type": "uint256",
        "indexed": false
      }
    ],
    "anonymous": false
  },
  {
    "type": "error",
    "name": "AboveMaximum",
    "inputs": [
      {
        "name": "amount",
        "type": "uint256"
      },
      {
        "name": "maximum",
        "type": "uint256"
      }
    ]
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
    "name": "AlreadyInitialized",
    "inputs": []
  },
  {
    "type": "error",
    "name": "BelowMinimum",
    "inputs": [
      {
        "name": "amount",
        "type": "uint256"
      },
      {
        "name": "minimum",
        "type": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "CooldownActive",
    "inputs": [
      {
        "name": "readyAt",
        "type": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "CurrencyMismatch",
    "inputs": []
  },
  {
    "type": "error",
    "name": "DeviationTooHigh",
    "inputs": [
      {
        "name": "spotTick",
        "type": "int24"
      },
      {
        "name": "twapTick",
        "type": "int24"
      }
    ]
  },
  {
    "type": "error",
    "name": "ERC20InsufficientAllowance",
    "inputs": [
      {
        "name": "spender",
        "type": "address"
      },
      {
        "name": "allowance",
        "type": "uint256"
      },
      {
        "name": "needed",
        "type": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "ERC20InsufficientBalance",
    "inputs": [
      {
        "name": "sender",
        "type": "address"
      },
      {
        "name": "balance",
        "type": "uint256"
      },
      {
        "name": "needed",
        "type": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "ERC20InvalidApprover",
    "inputs": [
      {
        "name": "approver",
        "type": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "ERC20InvalidReceiver",
    "inputs": [
      {
        "name": "receiver",
        "type": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "ERC20InvalidSender",
    "inputs": [
      {
        "name": "sender",
        "type": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "ERC20InvalidSpender",
    "inputs": [
      {
        "name": "spender",
        "type": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "Expired",
    "inputs": [
      {
        "name": "deadline",
        "type": "uint256"
      }
    ]
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
        "name": "bps",
        "type": "uint16"
      }
    ]
  },
  {
    "type": "error",
    "name": "FeeOnTransferUnsupported",
    "inputs": [
      {
        "name": "expected",
        "type": "uint256"
      },
      {
        "name": "received",
        "type": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "HookCanTrapLiquidity",
    "inputs": [
      {
        "name": "bitmap",
        "type": "uint16"
      }
    ]
  },
  {
    "type": "error",
    "name": "InvalidConfig",
    "inputs": [
      {
        "name": "reason",
        "type": "uint8"
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
    "name": "NativeNotAccepted",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NoDrift",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotCurator",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotFactory",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotLocker",
    "inputs": [
      {
        "name": "locker",
        "type": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "NotPendingCurator",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotVault",
    "inputs": [
      {
        "name": "caller",
        "type": "address"
      }
    ]
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
    "name": "NothingToHarvest",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NothingToManage",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NothingToSweep",
    "inputs": []
  },
  {
    "type": "error",
    "name": "OracleKindMismatch",
    "inputs": []
  },
  {
    "type": "error",
    "name": "OracleUnreadable",
    "inputs": []
  },
  {
    "type": "error",
    "name": "PoolNotInitialized",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ReadDuringExecution",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ReentrancyGuardReentrantCall",
    "inputs": []
  },
  {
    "type": "error",
    "name": "SafeCastOverflow",
    "inputs": []
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
    "name": "SharesToVault",
    "inputs": []
  },
  {
    "type": "error",
    "name": "UnexpectedDelta",
    "inputs": []
  },
  {
    "type": "error",
    "name": "VaultEmpty",
    "inputs": []
  },
  {
    "type": "error",
    "name": "VaultNotEmpty",
    "inputs": []
  },
  {
    "type": "error",
    "name": "WrongPoolManager",
    "inputs": []
  },
  {
    "type": "error",
    "name": "WrongValue",
    "inputs": [
      {
        "name": "expected",
        "type": "uint256"
      },
      {
        "name": "sent",
        "type": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "ZeroAddress",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ZeroShares",
    "inputs": []
  }
] as const;

/** `GullyCoreVaultFactory`: 31 functions, 12 events, 21 errors. */
export const VAULT_FACTORY_ABI = [
  {
    "type": "function",
    "name": "ABSOLUTE_MAX_PERFORMANCE_FEE_BPS",
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
    "name": "acceptOwnership",
    "inputs": [],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "cancelPendingFee",
    "inputs": [],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "cancelPendingPerformanceFee",
    "inputs": [],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "createVault",
    "inputs": [
      {
        "name": "p",
        "type": "tuple",
        "components": [
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
            "name": "oracleKey",
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
            "name": "config",
            "type": "tuple",
            "components": [
              {
                "name": "baseHalfWidth",
                "type": "int24"
              },
              {
                "name": "limitWidth",
                "type": "int24"
              },
              {
                "name": "maxDeviation",
                "type": "int24"
              },
              {
                "name": "rebalanceThreshold",
                "type": "int24"
              },
              {
                "name": "twapWindow",
                "type": "uint32"
              },
              {
                "name": "cooldown",
                "type": "uint32"
              },
              {
                "name": "curatorFeeBps",
                "type": "uint16"
              }
            ]
          }
        ]
      },
      {
        "name": "salt",
        "type": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "vault",
        "type": "address"
      }
    ],
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
    "name": "feeWei",
    "inputs": [],
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
    "name": "flushProtocolFees",
    "inputs": [],
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
    "name": "implementation",
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
    "name": "isVault",
    "inputs": [
      {
        "name": "",
        "type": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "maxFeeWei",
    "inputs": [],
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
    "name": "maxPerformanceFeeBps",
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
    "name": "pendingFee",
    "inputs": [],
    "outputs": [
      {
        "name": "newFeeWei",
        "type": "uint256"
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
    "name": "pendingPerformanceFee",
    "inputs": [],
    "outputs": [
      {
        "name": "newBps",
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
    "name": "performanceFeeBps",
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
    "name": "predictVault",
    "inputs": [
      {
        "name": "creator",
        "type": "address"
      },
      {
        "name": "salt",
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
    "name": "protocolFeesOwed",
    "inputs": [],
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
    "name": "renounceOwnership",
    "inputs": [],
    "outputs": [],
    "stateMutability": "pure"
  },
  {
    "type": "function",
    "name": "rescueERC20",
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
    "name": "setFee",
    "inputs": [
      {
        "name": "newFeeWei",
        "type": "uint256"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "setPerformanceFee",
    "inputs": [
      {
        "name": "newBps",
        "type": "uint16"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
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
    "name": "vaultAt",
    "inputs": [
      {
        "name": "i",
        "type": "uint256"
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
    "name": "vaultCount",
    "inputs": [],
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
    "name": "vaults",
    "inputs": [
      {
        "name": "start",
        "type": "uint256"
      },
      {
        "name": "count",
        "type": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "page",
        "type": "address[]"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "vaultsOfPool",
    "inputs": [
      {
        "name": "id",
        "type": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "address[]"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "event",
    "name": "ERC20Rescued",
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
    "name": "FeeChanged",
    "inputs": [
      {
        "name": "previousWei",
        "type": "uint256",
        "indexed": false
      },
      {
        "name": "newWei",
        "type": "uint256",
        "indexed": false
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "FeeIncreaseScheduled",
    "inputs": [
      {
        "name": "currentWei",
        "type": "uint256",
        "indexed": false
      },
      {
        "name": "newWei",
        "type": "uint256",
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
    "name": "FeePaid",
    "inputs": [
      {
        "name": "payer",
        "type": "address",
        "indexed": true
      },
      {
        "name": "feeWei",
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
    "name": "PendingFeeCancelled",
    "inputs": [
      {
        "name": "cancelledWei",
        "type": "uint256",
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
    "name": "PendingPerformanceFeeCancelled",
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
    "name": "PerformanceFeeChanged",
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
    "name": "PerformanceFeeIncreaseScheduled",
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
    "name": "ProtocolFeesFlushed",
    "inputs": [
      {
        "name": "to",
        "type": "address",
        "indexed": true
      },
      {
        "name": "amount",
        "type": "uint256",
        "indexed": false
      },
      {
        "name": "owed",
        "type": "uint256",
        "indexed": false
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "VaultCreated",
    "inputs": [
      {
        "name": "vault",
        "type": "address",
        "indexed": true
      },
      {
        "name": "poolId",
        "type": "bytes32",
        "indexed": true
      },
      {
        "name": "curator",
        "type": "address",
        "indexed": true
      },
      {
        "name": "performanceFeeBps",
        "type": "uint16",
        "indexed": false
      },
      {
        "name": "feePaid",
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
    "name": "ERC1167FailedCreateClone",
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
        "name": "feeWei",
        "type": "uint256"
      },
      {
        "name": "capWei",
        "type": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "ImplementationMismatch",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InsufficientFee",
    "inputs": [
      {
        "name": "required",
        "type": "uint256"
      },
      {
        "name": "sent",
        "type": "uint256"
      }
    ]
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
    "name": "NativeTransferFailed",
    "inputs": [
      {
        "name": "to",
        "type": "address"
      },
      {
        "name": "amount",
        "type": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "NoPendingFee",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NoPendingPerformanceFee",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NothingToFlush",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NothingToRescue",
    "inputs": [
      {
        "name": "token",
        "type": "address"
      }
    ]
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
    "name": "PerformanceFeeAboveCap",
    "inputs": [
      {
        "name": "bps",
        "type": "uint256"
      },
      {
        "name": "cap",
        "type": "uint256"
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
    "name": "RescueToZero",
    "inputs": []
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
    "name": "ZeroAddress",
    "inputs": []
  }
] as const;
