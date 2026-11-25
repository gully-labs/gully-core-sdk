// SPDX-License-Identifier: MIT
/**
 * `@gullylabs/core-sdk/solana`: Gully Core on Solana (DEVNET ONLY). The address book, account decoders and a minimal
 * read client: pools, launches, the fee settings and Gully Router quotes. No signing and no transactions.
 *
 *   import { requireDeployment, createSolanaRpc, listPools, GullyCoreSolanaRouterClient } from "@gullylabs/core-sdk/solana";
 *   const d = requireDeployment("devnet");
 *   const rpc = createSolanaRpc({ url: d.rpc });
 *   const pools = await listPools(rpc, d);
 *   const q = await new GullyCoreSolanaRouterClient({ url: d.router.url }).quote({ tokenIn: d.wsol, tokenOut: mint, amountIn: 1_000_000n });
 */
export * from "./codec.js";
export * from "./accounts.js";
export * from "./deployments.js";
export * from "./client.js";
