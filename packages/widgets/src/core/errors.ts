// SPDX-License-Identifier: MIT
/**
 * Turns whatever a quote, a wallet or a transaction threw into one sentence a
 * trader can read.
 *
 * The raw error stays on the hook results (`error`) for hosts and logs; this is
 * only what the styled widgets PRINT. Nothing here invents a cause: a revert is
 * decoded against the ABIs of the contracts the widgets actually call (router,
 * quoters, position managers, launch guards, core), wrappers are unwrapped
 * (core's `WrappedError`, the quoter's `UnexpectedRevertBytes`), and a known
 * error name gets a plain explanation. An unknown selector is reported as what
 * it is - an unrecognised refusal - never guessed at.
 */

import { BaseError, decodeErrorResult, parseAbi, type Abi, type Hex } from "viem";
import {
  decodeSwapNotFilled,
  BIN_LAUNCH_GUARD_HOOK_ABI,
  BIN_POSITION_MANAGER_ABI,
  BIN_QUOTER_ABI,
  CL_POSITION_MANAGER_ABI,
  CL_QUOTER_ABI,
  LAUNCH_GUARD_HOOK_ABI,
  UNIVERSAL_ROUTER_ABI,
} from "@gullylabs/core-sdk";
import { GULLYCORE_POSITION_LOCK_ABI, GULLYCORE_TOKEN_LOCK_ABI } from "@gullylabs/core-sdk/lock";
import { NoRouteError, SwapTooLargeError, UnsupportedOperationError, WalletNotConnectedError } from "../adapters/protocol.js";
import { formatAmount } from "./format.js";
import { tooLargeMessage } from "./launchCharges.js";

/* Core errors that surface through the router and the quoters. Declared here
   because the SDK ships events for core, not its errors. */
const CORE_ERRORS_ABI = parseAbi([
  "error WrappedError(address target, bytes4 selector, bytes reason, bytes details)",
  "error UnexpectedRevertBytes(bytes revertData)",
  "error PoolNotInitialized()",
  "error InvalidFeeForExactOut()",
  "error InvalidSqrtPriceLimit(uint160 sqrtPriceCurrentX96, uint160 sqrtPriceLimitX96)",
  "error NoLiquidityToReceiveFees()",
  "error BinPool__OutOfLiquidity()",
  "error BinPool__InsufficientAmountUnSpecified()",
  "error CurrencyNotSettled()",
  "error HookDeltaExceedsSwapAmount()",
  "error InvalidHookResponse()",
  "error HookCallFailed()",
  "error Error(string)",
]);

/* One ABI of errors only; duplicates across ABIs decode identically. */
const ERROR_ABI: Abi = (() => {
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const abi of [
    CORE_ERRORS_ABI,
    UNIVERSAL_ROUTER_ABI,
    CL_QUOTER_ABI,
    BIN_QUOTER_ABI,
    CL_POSITION_MANAGER_ABI,
    BIN_POSITION_MANAGER_ABI,
    LAUNCH_GUARD_HOOK_ABI,
    BIN_LAUNCH_GUARD_HOOK_ABI,
    GULLYCORE_POSITION_LOCK_ABI,
    GULLYCORE_TOKEN_LOCK_ABI,
  ] as readonly (readonly { type: string; name?: string; inputs?: readonly { type: string }[] }[])[]) {
    for (const item of abi) {
      if (item.type !== "error" || item.name === undefined) continue;
      const key = `${item.name}(${(item.inputs ?? []).map((i) => i.type).join(",")})`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
  }
  return out as Abi;
})();

/** Plain explanations for the refusals a trader can actually meet. */
const EXPLANATIONS: Readonly<Record<string, string>> = {
  TransactionDeadlinePassed: "The transaction's deadline passed before it was mined. Nothing was spent; try again.",
  DeadlinePassed: "The transaction's deadline passed before it was mined. Nothing was spent; try again.",
  SignatureDeadlineExpired: "The signature's deadline passed. Sign again.",
  TooLittleReceived: "The price moved past your slippage tolerance, so the trade was refused.",
  V3TooLittleReceived: "The price moved past your slippage tolerance, so the trade was refused.",
  V2TooLittleReceived: "The price moved past your slippage tolerance, so the trade was refused.",
  TooMuchRequested: "The price moved past your slippage tolerance, so the trade was refused.",
  MinimumAmountInsufficient: "The pool would return less than your minimum, so it was refused. Widen slippage or try again.",
  MaximumAmountExceeded: "The pool would take more than your maximum, so it was refused. Widen slippage or try again.",
  LiquiditySlippageCaught: "The pool price moved while you were adding liquidity, so it was refused.",
  IdSlippageCaught: "The active bin moved while you were adding liquidity, so it was refused.",
  NotEnoughLiquidity: "The pool does not hold enough liquidity to fill this amount.",
  BinPool__OutOfLiquidity: "The pool does not hold enough liquidity to fill this amount.",
  InvalidSqrtPriceLimit: "This amount would move the price past the pool's limit. Try a smaller amount.",
  PoolNotInitialized: "This pool has not been initialised yet.",
  InsufficientBalance: "Your balance is too low for this transaction.",
  InsufficientETH: "Not enough native currency was sent with this transaction.",
  InsufficientToken: "Your token balance is too low for this transaction.",
  BalanceTooLow: "Your balance is too low for this transaction.",
  TradingNotOpen: "Trading on this launch pool has not opened yet.",
  BuyExceedsMaxPerTx: "This buy is larger than the launch's per-transaction cap. Try a smaller amount.",
  SwapNotFilled: "This trade is larger than the pool can fill. Try a smaller amount.",
  ExactOutputBuyBlockedDuringLaunch: "Exact-output buys are blocked while the launch is decaying.",
  TaxedActiveBinMintBlocked: "Liquidity cannot be added to the active bin while the launch's creator tax is live.",
  EnforcedPause: "The router is paused.",
  ContractLocked: "The contract is busy with another call. Try again.",
  /* GullyCorePositionLock / GullyCoreTokenLock (the locker widget). */
  InsufficientFee: "Less than the lock fee was sent. The fee may have risen since it was read; reload and try again.",
  AlreadyLocked: "This position is already locked.",
  EmptyPosition: "This position holds no liquidity, so there is nothing to lock.",
  NotPositionOwner: "The connected wallet does not own this position.",
  InvalidUnlock: "The unlock date must be in the future and at most 100 years away.",
  InvalidOwner: "The lock owner is not a valid address.",
  NotLater: "A lock can only be extended to a later date, never shortened.",
  NotLockOwner: "Only the lock owner can do this.",
  NotPendingOwner: "Only the address the lock was offered to can accept it.",
  NotLocked: "No lock exists for this position.",
  StillLocked: "The lock has not reached its unlock date yet.",
  PositionIsLocked: "This position is held by a lock.",
  InvalidSchedule: "The schedule is invalid: it needs start <= cliff <= end, an end in the future, at most 100 years away.",
  InvalidBeneficiary: "The beneficiary is not a valid address.",
  NativeValueMismatch: "The native amount sent does not match the amount plus the fee.",
  NoSuchLock: "No lock exists with this id.",
  NotBeneficiary: "Only the beneficiary can claim or move this lock.",
  NotPendingBeneficiary: "Only the address the lock was offered to can accept it.",
  NothingToClaim: "Nothing has vested beyond what was already claimed.",
  ZeroAmount: "Lock an amount above zero.",
  SafeERC20FailedOperation: "The token transfer failed. Check the balance and the approval.",
};

/** The revert data a thrown error carries, if any. */
export function revertDataOf(error: unknown): Hex | null {
  let found: Hex | null = null;
  const visit = (value: unknown): void => {
    if (found !== null || value === null || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    for (const key of ["raw", "data"]) {
      const v = record[key];
      if (typeof v === "string" && /^0x[0-9a-fA-F]{8,}$/.test(v)) {
        found = v as Hex;
        return;
      }
      if (v !== null && typeof v === "object" && typeof (v as Record<string, unknown>).data === "string") {
        const inner = (v as Record<string, unknown>).data as string;
        if (/^0x[0-9a-fA-F]{8,}$/.test(inner)) {
          found = inner as Hex;
          return;
        }
      }
    }
    visit(record.cause);
  };
  visit(error);
  if (found !== null) return found;
  /* Anvil and some nodes only put it in the message: "custom error 0x5bf6f916: …". */
  const message = messageOf(error);
  const inMessage = /custom error (0x[0-9a-fA-F]{8})(?::\s*(?:0x)?([0-9a-fA-F]*))?/.exec(message);
  if (inMessage !== null) return `${inMessage[1]}${inMessage[2] ?? ""}` as Hex;
  const signature = /signature:\s*\n?\s*(0x[0-9a-fA-F]{8,})/.exec(message);
  if (signature !== null) return signature[1] as Hex;
  return null;
}

function messageOf(error: unknown): string {
  if (error instanceof BaseError) return `${error.message}`;
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Decodes revert data to an error name, following wrappers. `null` when unknown. */
export function decodeRevertName(data: Hex, depth = 0): string | null {
  if (depth > 4 || data.length < 10) return null;
  try {
    const decoded = decodeErrorResult({ abi: ERROR_ABI, data });
    const args = (decoded.args ?? []) as readonly unknown[];
    if (decoded.errorName === "WrappedError") {
      const inner = args[2];
      if (typeof inner === "string" && inner.length >= 10) return decodeRevertName(inner as Hex, depth + 1) ?? "WrappedError";
      return "WrappedError";
    }
    if (decoded.errorName === "UnexpectedRevertBytes") {
      const inner = args[0];
      if (typeof inner === "string" && inner.length >= 10) return decodeRevertName(inner as Hex, depth + 1);
      return null;
    }
    if (decoded.errorName === "Error" && typeof args[0] === "string") return `Error: ${args[0]}`;
    return decoded.errorName;
  } catch {
    return null;
  }
}

/**
 * Whether a thrown error is a launch pool refusing a trade it could only fill in
 * part, and what it said: how much the pool had to trade and how much it did,
 * both in the pool's quote currency. `null` for any other error. The decoding
 * is the SDK's, through whatever wrapped the refusal on its way here.
 */
export function swapNotFilledOf(error: unknown): { readonly expected: bigint; readonly traded: bigint } | null {
  const data = revertDataOf(error);
  if (data === null) return null;
  const refusal = decodeSwapNotFilled(data);
  return refusal === null ? null : { expected: refusal.expected, traded: refusal.traded };
}

/** A sentence for a decoded refusal. */
function explainRevert(name: string): string {
  if (name.startsWith("Error: ")) return `The contract refused: ${name.slice(7)}`;
  return EXPLANATIONS[name] ?? `The contract refused the transaction (${name}).`;
}

function isUserRejection(error: unknown): boolean {
  let hit = false;
  const visit = (value: unknown, depth: number): void => {
    if (hit || depth > 6 || value === null || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (record.code === 4001 || record.name === "UserRejectedRequestError") {
      hit = true;
      return;
    }
    visit(record.cause, depth + 1);
  };
  visit(error, 0);
  return hit || /user rejected|user denied|rejected the request/i.test(messageOf(error));
}

/** The first human line of a message, without the package tag or viem's appendix. */
function firstLine(message: string): string {
  const cleaned = message.replace(/^\[@gullylabs\/core-widgets\]\s*/, "");
  const line = cleaned.split("\n")[0]?.trim() ?? "";
  return line.length > 180 ? `${line.slice(0, 177)}…` : line;
}

/** What went wrong, in one plain sentence. `context` names the action for the fallbacks. */
export function describeError(error: unknown, context: "quote" | "swap" | "liquidity" | "transaction" = "transaction"): string {
  if (error === null || error === undefined) return "Something went wrong.";
  if (isUserRejection(error)) return "You rejected the request in your wallet. Nothing was sent.";
  if (error instanceof WalletNotConnectedError) return "Connect a wallet first.";
  if (error instanceof NoRouteError) return "No pool on this site connects these two tokens.";
  if (error instanceof SwapTooLargeError) {
    return tooLargeMessage(error.tokenIn, error.largestAmountIn === null ? null : formatAmount(error.largestAmountIn, error.tokenIn.decimals));
  }

  const data = revertDataOf(error);
  const name = data === null ? null : decodeRevertName(data);
  if (name !== null) return explainRevert(name);

  if (error instanceof UnsupportedOperationError) {
    if (error.operation === "quoteSwap") {
      if (/every direct pool for this pair failed to quote/.test(error.message)) {
        return "No pool could quote this trade. The amount may be more than the pool can fill, or trading may not be open yet.";
      }
      if (/no configured pool holds both/.test(error.message)) return "No pool on this site connects these two tokens.";
      if (/no quoter is configured/.test(error.message)) return "This site cannot price trades on that kind of pool yet.";
    }
    if (error.operation === "quoteAddLiquidity") {
      if (/mint no liquidity/.test(error.message)) return "These amounts add no liquidity to this range. Enter a larger amount of the token the range holds.";
      if (/active bin is/.test(error.message)) return "The active bin moved since the range was set. Reset the range and try again.";
      if (/nothing to deposit/.test(error.message)) return "The chosen bins take only the token whose amount is zero. Enter an amount of the other token.";
      return "This position cannot be priced on this pool. Check the range and the amounts.";
    }
    return "This action is not available on this deployment.";
  }

  if (data !== null) return `The contract refused the transaction (unrecognised error ${data.slice(0, 10)}).`;
  if (error instanceof BaseError && typeof error.shortMessage === "string" && error.shortMessage !== "") {
    if (/reverted/i.test(error.shortMessage)) {
      return context === "quote" ? "The pool refused to quote this trade." : "The transaction would revert, so it was not sent.";
    }
    return firstLine(error.shortMessage);
  }
  const line = firstLine(messageOf(error));
  return line === "" ? "Something went wrong." : line;
}
