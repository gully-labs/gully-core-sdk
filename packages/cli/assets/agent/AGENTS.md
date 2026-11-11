# Building a Gully Core: the rules a coding agent must follow

This file is for coding agents (Claude Code, and any agent that reads `AGENTS.md`). It states
what is true of Gully Core's contracts and what a Gully Core must never do. Everything here was
read from the source in `packages/core` and `packages/hooks`. Where this file and the source
disagree, the source is right: say so, and follow the source.

A **Gully Core** is a hook contract attached to a pool on Gully Core's core. The product noun is
Gully Core; the code keeps the ABI's names (`IHooks`, `ICLHooks`, `IBinHooks`, `BaseCLHook`,
`BaseBinHook`, `getHooksRegistrationBitmap`, `hookData`). Never rename those.

There are two pool types, and a Gully Core is written for one of them:

| | Concentrated liquidity (CL) | Bin |
|---|---|---|
| Pool manager | `CLPoolManager` | `BinPoolManager` |
| Base contract | `BaseCLHook` (`packages/hooks/src/base`) | `BaseBinHook` (same directory) |
| Liquidity callbacks | `beforeAddLiquidity` / `afterAddLiquidity` / `beforeRemoveLiquidity` / `afterRemoveLiquidity` | `beforeMint` / `afterMint` / `beforeBurn` / `afterBurn` |
| Swap callback arguments | `ICLPoolManager.SwapParams` | `bool swapForY, int128 amountSpecified` |
| Second field of `poolKey.parameters` | tick spacing | bin step |
| `initialize` takes | a `sqrtPriceX96` | an active bin id (`2^23` is price 1) |

## How to work

1. **Understand before you write.** State what the Gully Core does, who calls it, which assets it
   touches, and who holds any role. If something is missing, state the assumption you are making.
2. **Describe the design before the code**: callbacks used, state kept, roles, how value enters
   and how every unit leaves.
3. **Write it, then test it**: happy paths, refusals, unauthorised callers, boundaries, fuzz.
4. **Review it for security** and report findings as Severity, what it is, why it matters, the
   attack, the code, the fix. Never invent a finding to look thorough, and never say code is
   "100% secure". State what is still assumed.

Do not leave a `TODO` or a placeholder check in code you present as ready.

## Facts about the core

| Fact | Consequence |
|---|---|
| A pool has exactly ONE hook, named in its pool key | Two GullyCores cannot share a pool. Compose behaviour into one contract |
| The hook's address is part of the pool's identity | A Gully Core is never upgraded. A new version means new pools. No proxy |
| Permissions live in the pool key, not in the address | A Gully Core works from any address. Do not mine a salt |
| `poolKey.parameters` carries the 16-bit registration bitmap in its low bits | It must equal `getHooksRegistrationBitmap()` exactly, or `initialize` reverts `HookConfigValidationError` |
| Bits 14 and 15 of the bitmap are reserved | They must be zero (`ReservedBitsSet`) |
| A `*ReturnsDelta` permission requires its base callback | The base contract checks this in its constructor (`PermissionDependencyMissing`) |
| Every callback must return its own selector | Anything else reverts `InvalidHookResponse` |
| A callback declared in the bitmap and not implemented | Reverts `HookNotImplemented` when it is called. Declare only what you implement |
| Callbacks are `onlyPoolManager` | Never relax this. Never add an external function that assumes it is reached only through a callback |
| A fee returned from `beforeSwap` is applied only on a DYNAMIC-fee pool (`fee = 0x800000`) and only with `LPFeeLibrary.OVERRIDE_FEE_FLAG` set | On a static-fee pool the returned fee is ignored without an error |
| An override above the pool type's maximum reverts the swap | The maximum is 100% on a CL pool and 10% on a Bin pool. Clamp below it |
| A delta a hook returns is bounded by the swap | More than the swap's amount reverts `HookDeltaExceedsSwapAmount` |
| Settlement happens inside a Vault lock | Value is moved with `vault.take`, `vault.settle`, `vault.mint`, `vault.burn`, and every delta must be zero when the lock exits |
| On a Bin pool, a mint into the ACTIVE bin is charged a composition fee, which `beforeMint` can override | A lopsided active-bin mint is a swap in disguise: price it as one |
| Fee-on-transfer and rebasing tokens | NOT supported by the Vault's accounting. Refuse them; do not work around it |

## Two build profiles

One source, two transient-storage backends, chosen by the `hp-transient/` remapping:

```bash
forge build                          # default: EIP-1153, evm_version cancun
FOUNDRY_PROFILE=legacy forge build   # legacy:  storage backend, evm_version shanghai
```

- Test under BOTH. A failing legacy test is a claim about the storage backend: read it before
  you change it.
- Keep `hp-transient/` pinned per profile in `foundry.toml`. Never put it in a `remappings.txt`:
  that file overrides per-profile remappings and builds the wrong backend without a warning.
- If your Gully Core needs a reentrancy guard, use OpenZeppelin's storage `ReentrancyGuard`, so both
  profiles run the same logic.

## Rules for a Gully Core that touches money

- **Every unit that can enter must be able to leave.** For each contract, write down what value
  can reach it (native, ERC-20, vault claims) and the path out. A contract that can receive value
  with no path out is a defect. Prefer a contract that cannot receive at all: no `receive`, no
  `fallback`.
- **No key may move a user's funds, change a term that was frozen, or change code.** For each
  role, list what it can and cannot do.
- **Ownership is two-step, and `renounceOwnership` reverts.** Prefer no role at all.
- **Caps are immutable.** A value an operator may change moves only inside a cap fixed at
  deployment. Increases wait for a notice period; decreases are immediate.
- **Every value a deployer might want to change is a constructor argument**, never a constant
  they must fork the contract to edit.
- **Durations are `block.timestamp` seconds, never block numbers.** On some chains
  `block.number` inside the EVM is not the block the RPC reports. State a minimum length for
  any short window.
- **Checks, effects, interactions.** Custom errors. An event for every state change that matters.
- **Be deliberate about what reverts.** A `beforeSwap` that reverts makes the pool untradeable
  for as long as the condition holds. A callback on removing liquidity that reverts traps a
  provider's principal: never let one revert on a condition the provider cannot clear.
- **Pull, do not push.** Credit a balance and let its owner claim it. A payment inside a swap
  that can fail makes the swap fail.
- **No `delegatecall` to an address that can be set, no `selfdestruct`, no upgradeability.**

## Before you call it done

1. `forge test` passes under both profiles.
2. The runtime size is under 24,576 bytes, read from `deployedBytecode.object` in the artifact.
   Foundry's test EVM does not enforce that limit, so a green suite says nothing about it.
3. Each guard you wrote is proven by breaking it: remove the check, confirm a test fails, put it
   back. When you script this, assert that the pattern matched, run `forge test --force`, and
   `git diff` afterwards to confirm nothing is left behind.
4. Every external function has been called on a running chain (`anvil`), once to succeed and once
   to be refused.
5. Static analysis (Slither) has run, and every medium or high finding has a written reason.

## What never goes in the repository

`.env` files, private keys, mnemonics, keystores, RPC URLs that carry a key, and Foundry's
`broadcast/` directory. Deploy scripts read keys from the environment
(`vm.envUint("PRIVATE_KEY")`). Never print a key. If a secret is ever committed, it is
compromised: rotate it.

## What you must never claim

- That a Gully Core is "safe". Say what it is permitted to do and what it does not cover.
- A number you did not read. If you cannot read it, say what is missing.
- That a registry listing is an audit. It is not.

## Licence

`packages/core` and `packages/hooks` are GPL-2.0-or-later. A contract that imports them is a
derivative work under the same licence. The SDK is MIT and talks to deployed contracts through
their ABI.
