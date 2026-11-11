// SPDX-License-Identifier: MIT
/** What the pool managers charge, read from the chain. Rules come from the SDK; the numbers come from here. */

import { decodeProtocolFee, poolKeyToTuple, type PoolKey } from "@gullylabs/core-sdk";
import { parseAbi, type Address, type Hex } from "viem";

import { pipsPercent } from "./amounts.js";
import type { ChainContext } from "./chain.js";

export const POOL_MANAGER_FEE_ABI = parseAbi(["function protocolFeeController() view returns (address)"]);

/** `protocolFeeForPool` as the core calls it on a new pool. */
export const CONTROLLER_FEE_ABI = [
  {
    type: "function",
    name: "protocolFeeForPool",
    stateMutability: "view",
    inputs: [
      {
        name: "poolKey",
        type: "tuple",
        components: [
          { name: "currency0", type: "address" },
          { name: "currency1", type: "address" },
          { name: "hooks", type: "address" },
          { name: "poolManager", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "parameters", type: "bytes32" },
        ],
      },
    ],
    outputs: [{ name: "", type: "uint24" }],
  },
] as const;

/** The packed per-direction protocol fee as text: one figure when both directions match. */
export function formatProtocolFee(packed: number): string {
  const { zeroForOne, oneForZero } = decodeProtocolFee(packed);
  if (zeroForOne === oneForZero) return pipsPercent(zeroForOne);
  return `${pipsPercent(zeroForOne)} selling currency0, ${pipsPercent(oneForZero)} selling currency1`;
}

/** The controller a manager points at, or null when it answers none (`address(0)` included). */
export async function readController(ctx: ChainContext, manager: Address): Promise<Address | null> {
  const c = await ctx.client.readContract({ address: manager, abi: POOL_MANAGER_FEE_ABI, functionName: "protocolFeeController" });
  return /^0x0+$/.test(c) ? null : c;
}

/** What the controller would set on this pool at creation, or null when it does not say. */
export async function readFeeForNewPool(ctx: ChainContext, controller: Address | null, key: PoolKey): Promise<number | null> {
  if (controller === null) return null;
  try {
    const [currency0, currency1, hooks, poolManager, fee, parameters] = poolKeyToTuple(key) as unknown as [Address, Address, Address, Address, number, Hex];
    return Number(await ctx.client.readContract({ address: controller, abi: CONTROLLER_FEE_ABI, functionName: "protocolFeeForPool", args: [{ currency0, currency1, hooks, poolManager, fee, parameters }] }));
  } catch {
    return null;
  }
}
