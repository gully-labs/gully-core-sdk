// SPDX-License-Identifier: MIT
// -----------------------------------------------------------------------------
// ABIs of GullyCoreRangeOrders and GullyCoreDCA (packages/orders), copied from the
// compiled artifacts (constructor and internalType omitted). test/orders.abi.test.ts
// compares them with packages/orders/foundry-out when that build exists.
// -----------------------------------------------------------------------------

/** `GullyCoreRangeOrders`: 41 functions, 13 events, 41 errors. */
export const RANGE_ORDERS_ABI = [
  {
    "type": "receive",
    "stateMutability": "payable"
  },
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
    "name": "MAX_INTEGRATOR_BPS",
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
    "name": "MAX_LAUNCH_GUARDS",
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
    "name": "acceptOwnership",
    "inputs": [],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "cancel",
    "inputs": [
      {
        "name": "orderId",
        "type": "uint256"
      },
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
    "name": "cancelPendingProtocolFee",
    "inputs": [],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "claimIntegratorFees",
    "inputs": [
      {
        "name": "currency",
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
    "name": "epochKey",
    "inputs": [
      {
        "name": "epochId",
        "type": "uint256"
      }
    ],
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
    "name": "execute",
    "inputs": [
      {
        "name": "epochId",
        "type": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "proceeds",
        "type": "uint256"
      },
      {
        "name": "tip",
        "type": "uint256"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "executeMany",
    "inputs": [
      {
        "name": "epochIds",
        "type": "uint256[]"
      }
    ],
    "outputs": [
      {
        "name": "filled",
        "type": "uint256"
      }
    ],
    "stateMutability": "nonpayable"
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
    "name": "getEpoch",
    "inputs": [
      {
        "name": "epochId",
        "type": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "tuple",
        "components": [
          {
            "name": "poolId",
            "type": "bytes32"
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
            "name": "zeroForOne",
            "type": "bool"
          },
          {
            "name": "filled",
            "type": "bool"
          },
          {
            "name": "liquidity",
            "type": "uint128"
          },
          {
            "name": "liquidityAtFill",
            "type": "uint128"
          },
          {
            "name": "proceeds",
            "type": "uint256"
          },
          {
            "name": "acc0X128",
            "type": "uint256"
          },
          {
            "name": "acc1X128",
            "type": "uint256"
          },
          {
            "name": "held0",
            "type": "uint256"
          },
          {
            "name": "held1",
            "type": "uint256"
          },
          {
            "name": "tipTotal",
            "type": "uint256"
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "getOrder",
    "inputs": [
      {
        "name": "orderId",
        "type": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "tuple",
        "components": [
          {
            "name": "maker",
            "type": "address"
          },
          {
            "name": "epochId",
            "type": "uint64"
          },
          {
            "name": "feeBps",
            "type": "uint16"
          },
          {
            "name": "integratorBps",
            "type": "uint16"
          },
          {
            "name": "integrator",
            "type": "address"
          },
          {
            "name": "liquidity",
            "type": "uint128"
          },
          {
            "name": "tip",
            "type": "uint128"
          },
          {
            "name": "snap0X128",
            "type": "uint256"
          },
          {
            "name": "snap1X128",
            "type": "uint256"
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "integratorOwed",
    "inputs": [
      {
        "name": "",
        "type": "address"
      },
      {
        "name": "",
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
    "name": "isCrossed",
    "inputs": [
      {
        "name": "epochId",
        "type": "uint256"
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
    "name": "isLaunchGuard",
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
    "name": "isLaunchPool",
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
    "name": "nextEpochId",
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
    "name": "nextOrderId",
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
    "name": "openEpochOf",
    "inputs": [
      {
        "name": "poolId",
        "type": "bytes32"
      },
      {
        "name": "tickLower",
        "type": "int24"
      },
      {
        "name": "zeroForOne",
        "type": "bool"
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
    "name": "place",
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
            "name": "tickLower",
            "type": "int24"
          },
          {
            "name": "zeroForOne",
            "type": "bool"
          },
          {
            "name": "amountIn",
            "type": "uint256"
          },
          {
            "name": "tip",
            "type": "uint128"
          },
          {
            "name": "integrator",
            "type": "address"
          },
          {
            "name": "integratorBps",
            "type": "uint16"
          }
        ]
      }
    ],
    "outputs": [
      {
        "name": "orderId",
        "type": "uint256"
      },
      {
        "name": "epochId",
        "type": "uint256"
      },
      {
        "name": "liquidity",
        "type": "uint128"
      }
    ],
    "stateMutability": "payable"
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
        "name": "",
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
    "name": "renounceOwnership",
    "inputs": [],
    "outputs": [],
    "stateMutability": "pure"
  },
  {
    "type": "function",
    "name": "rescueSurplus",
    "inputs": [
      {
        "name": "currency",
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
    "name": "totalOwed",
    "inputs": [
      {
        "name": "",
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
    "name": "withdraw",
    "inputs": [
      {
        "name": "orderId",
        "type": "uint256"
      },
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
    "type": "event",
    "name": "EpochFilled",
    "inputs": [
      {
        "name": "epochId",
        "type": "uint256",
        "indexed": true
      },
      {
        "name": "executor",
        "type": "address",
        "indexed": true
      },
      {
        "name": "proceeds",
        "type": "uint256",
        "indexed": false
      },
      {
        "name": "tip",
        "type": "uint256",
        "indexed": false
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "EpochOpened",
    "inputs": [
      {
        "name": "epochId",
        "type": "uint256",
        "indexed": true
      },
      {
        "name": "poolId",
        "type": "bytes32",
        "indexed": true
      },
      {
        "name": "tickLower",
        "type": "int24",
        "indexed": false
      },
      {
        "name": "tickUpper",
        "type": "int24",
        "indexed": false
      },
      {
        "name": "zeroForOne",
        "type": "bool",
        "indexed": false
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "IntegratorFeesClaimed",
    "inputs": [
      {
        "name": "integrator",
        "type": "address",
        "indexed": true
      },
      {
        "name": "currency",
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
    "name": "OrderCancelled",
    "inputs": [
      {
        "name": "orderId",
        "type": "uint256",
        "indexed": true
      },
      {
        "name": "maker",
        "type": "address",
        "indexed": true
      },
      {
        "name": "to",
        "type": "address",
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
    "name": "OrderPlaced",
    "inputs": [
      {
        "name": "orderId",
        "type": "uint256",
        "indexed": true
      },
      {
        "name": "epochId",
        "type": "uint256",
        "indexed": true
      },
      {
        "name": "maker",
        "type": "address",
        "indexed": true
      },
      {
        "name": "amountIn",
        "type": "uint256",
        "indexed": false
      },
      {
        "name": "liquidity",
        "type": "uint128",
        "indexed": false
      },
      {
        "name": "tip",
        "type": "uint128",
        "indexed": false
      },
      {
        "name": "feeBps",
        "type": "uint16",
        "indexed": false
      },
      {
        "name": "integrator",
        "type": "address",
        "indexed": false
      },
      {
        "name": "integratorBps",
        "type": "uint16",
        "indexed": false
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "OrderWithdrawn",
    "inputs": [
      {
        "name": "orderId",
        "type": "uint256",
        "indexed": true
      },
      {
        "name": "maker",
        "type": "address",
        "indexed": true
      },
      {
        "name": "to",
        "type": "address",
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
    "name": "ProtocolFeesFlushed",
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
    "name": "SurplusRescued",
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
    "name": "EmptyEpoch",
    "inputs": []
  },
  {
    "type": "error",
    "name": "EpochAlreadyFilled",
    "inputs": []
  },
  {
    "type": "error",
    "name": "EpochNotFilled",
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
    "name": "IntegratorBpsAboveCap",
    "inputs": [
      {
        "name": "bps",
        "type": "uint16"
      }
    ]
  },
  {
    "type": "error",
    "name": "IntegratorMissing",
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
    "name": "LaunchPoolNotSupported",
    "inputs": [
      {
        "name": "hook",
        "type": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "LevelNotAligned",
    "inputs": [
      {
        "name": "tickLower",
        "type": "int24"
      },
      {
        "name": "tickSpacing",
        "type": "int24"
      }
    ]
  },
  {
    "type": "error",
    "name": "LevelOutOfBounds",
    "inputs": [
      {
        "name": "tickLower",
        "type": "int24"
      }
    ]
  },
  {
    "type": "error",
    "name": "LiquidityOutOfBounds",
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
    "name": "NotCrossed",
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
    "name": "NotMaker",
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
    "name": "NothingToRescue",
    "inputs": []
  },
  {
    "type": "error",
    "name": "OrderInRange",
    "inputs": [
      {
        "name": "tick",
        "type": "int24"
      },
      {
        "name": "tickLower",
        "type": "int24"
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
    "name": "PoolNotInitialized",
    "inputs": []
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
    "name": "TooManyLaunchGuards",
    "inputs": []
  },
  {
    "type": "error",
    "name": "UnexpectedDelta",
    "inputs": []
  },
  {
    "type": "error",
    "name": "UnknownEpoch",
    "inputs": []
  },
  {
    "type": "error",
    "name": "UnknownOrder",
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
    "name": "ZeroAmount",
    "inputs": []
  }
] as const;

/** `GullyCoreDCA`: 35 functions, 11 events, 32 errors. */
export const DCA_ABI = [
  {
    "type": "receive",
    "stateMutability": "payable"
  },
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
    "name": "BIN_POOL_MANAGER",
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
    "name": "MAX_INTEGRATOR_BPS",
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
    "name": "MAX_SLICES",
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
    "name": "MIN_INTERVAL",
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
    "name": "acceptOwnership",
    "inputs": [],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "cancel",
    "inputs": [
      {
        "name": "planId",
        "type": "uint256"
      },
      {
        "name": "to",
        "type": "address"
      }
    ],
    "outputs": [
      {
        "name": "refund",
        "type": "uint256"
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
    "name": "claimIntegratorFees",
    "inputs": [
      {
        "name": "currency",
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
    "name": "create",
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
            "name": "zeroForOne",
            "type": "bool"
          },
          {
            "name": "amountPerSlice",
            "type": "uint128"
          },
          {
            "name": "tipPerSlice",
            "type": "uint128"
          },
          {
            "name": "slices",
            "type": "uint32"
          },
          {
            "name": "interval",
            "type": "uint32"
          },
          {
            "name": "startAt",
            "type": "uint64"
          },
          {
            "name": "deadline",
            "type": "uint64"
          },
          {
            "name": "minPriceX96",
            "type": "uint256"
          },
          {
            "name": "recipient",
            "type": "address"
          },
          {
            "name": "integrator",
            "type": "address"
          },
          {
            "name": "integratorBps",
            "type": "uint16"
          }
        ]
      }
    ],
    "outputs": [
      {
        "name": "planId",
        "type": "uint256"
      }
    ],
    "stateMutability": "payable"
  },
  {
    "type": "function",
    "name": "execute",
    "inputs": [
      {
        "name": "planId",
        "type": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "netOut",
        "type": "uint256"
      }
    ],
    "stateMutability": "nonpayable"
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
    "name": "getPlan",
    "inputs": [
      {
        "name": "planId",
        "type": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "tuple",
        "components": [
          {
            "name": "owner",
            "type": "address"
          },
          {
            "name": "recipient",
            "type": "address"
          },
          {
            "name": "zeroForOne",
            "type": "bool"
          },
          {
            "name": "feeBps",
            "type": "uint16"
          },
          {
            "name": "integratorBps",
            "type": "uint16"
          },
          {
            "name": "integrator",
            "type": "address"
          },
          {
            "name": "interval",
            "type": "uint32"
          },
          {
            "name": "slicesLeft",
            "type": "uint32"
          },
          {
            "name": "nextAt",
            "type": "uint64"
          },
          {
            "name": "deadline",
            "type": "uint64"
          },
          {
            "name": "amountPerSlice",
            "type": "uint128"
          },
          {
            "name": "tipPerSlice",
            "type": "uint128"
          },
          {
            "name": "minPriceX96",
            "type": "uint256"
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
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "integratorOwed",
    "inputs": [
      {
        "name": "",
        "type": "address"
      },
      {
        "name": "",
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
    "name": "isDue",
    "inputs": [
      {
        "name": "planId",
        "type": "uint256"
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
    "name": "minOutPerSlice",
    "inputs": [
      {
        "name": "planId",
        "type": "uint256"
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
    "name": "nextPlanId",
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
        "name": "",
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
    "name": "renounceOwnership",
    "inputs": [],
    "outputs": [],
    "stateMutability": "pure"
  },
  {
    "type": "function",
    "name": "rescueSurplus",
    "inputs": [
      {
        "name": "currency",
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
    "name": "totalOwed",
    "inputs": [
      {
        "name": "",
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
    "type": "event",
    "name": "IntegratorFeesClaimed",
    "inputs": [
      {
        "name": "integrator",
        "type": "address",
        "indexed": true
      },
      {
        "name": "currency",
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
    "name": "PlanCancelled",
    "inputs": [
      {
        "name": "planId",
        "type": "uint256",
        "indexed": true
      },
      {
        "name": "owner",
        "type": "address",
        "indexed": true
      },
      {
        "name": "to",
        "type": "address",
        "indexed": false
      },
      {
        "name": "refund",
        "type": "uint256",
        "indexed": false
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "PlanCreated",
    "inputs": [
      {
        "name": "planId",
        "type": "uint256",
        "indexed": true
      },
      {
        "name": "owner",
        "type": "address",
        "indexed": true
      },
      {
        "name": "poolId",
        "type": "bytes32",
        "indexed": true
      },
      {
        "name": "zeroForOne",
        "type": "bool",
        "indexed": false
      },
      {
        "name": "amountPerSlice",
        "type": "uint128",
        "indexed": false
      },
      {
        "name": "tipPerSlice",
        "type": "uint128",
        "indexed": false
      },
      {
        "name": "slices",
        "type": "uint32",
        "indexed": false
      },
      {
        "name": "interval",
        "type": "uint32",
        "indexed": false
      },
      {
        "name": "startAt",
        "type": "uint64",
        "indexed": false
      },
      {
        "name": "deadline",
        "type": "uint64",
        "indexed": false
      },
      {
        "name": "minPriceX96",
        "type": "uint256",
        "indexed": false
      },
      {
        "name": "recipient",
        "type": "address",
        "indexed": false
      },
      {
        "name": "feeBps",
        "type": "uint16",
        "indexed": false
      },
      {
        "name": "integrator",
        "type": "address",
        "indexed": false
      },
      {
        "name": "integratorBps",
        "type": "uint16",
        "indexed": false
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
    "name": "ProtocolFeesFlushed",
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
    "name": "SliceExecuted",
    "inputs": [
      {
        "name": "planId",
        "type": "uint256",
        "indexed": true
      },
      {
        "name": "executor",
        "type": "address",
        "indexed": true
      },
      {
        "name": "amountIn",
        "type": "uint256",
        "indexed": false
      },
      {
        "name": "grossOut",
        "type": "uint256",
        "indexed": false
      },
      {
        "name": "netOut",
        "type": "uint256",
        "indexed": false
      },
      {
        "name": "tip",
        "type": "uint256",
        "indexed": false
      },
      {
        "name": "slicesLeft",
        "type": "uint32",
        "indexed": false
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "SurplusRescued",
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
    "name": "BadSchedule",
    "inputs": []
  },
  {
    "type": "error",
    "name": "BelowMinOut",
    "inputs": [
      {
        "name": "netOut",
        "type": "uint256"
      },
      {
        "name": "minOut",
        "type": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "Expired",
    "inputs": [
      {
        "name": "deadline",
        "type": "uint64"
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
    "name": "IntegratorBpsAboveCap",
    "inputs": [
      {
        "name": "bps",
        "type": "uint16"
      }
    ]
  },
  {
    "type": "error",
    "name": "IntegratorMissing",
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
    "name": "NotDue",
    "inputs": [
      {
        "name": "nextAt",
        "type": "uint64"
      }
    ]
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
    "name": "NotOwner",
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
    "name": "NothingToRescue",
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
    "name": "PartialFill",
    "inputs": [
      {
        "name": "spent",
        "type": "uint256"
      },
      {
        "name": "amountIn",
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
    "name": "UnexpectedDelta",
    "inputs": []
  },
  {
    "type": "error",
    "name": "UnknownPlan",
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
    "name": "ZeroAmount",
    "inputs": []
  }
] as const;

