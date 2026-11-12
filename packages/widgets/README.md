<p align="center">
  <a href="https://gullychain.xyz/core">
    <img src="https://raw.githubusercontent.com/gully-labs/gullychain-sdk/main/.github/assets/og-image-1200x630.png"
         alt="Gully Core — Launch on one core." width="640">
  </a>
</p>

<p align="center">
  <a href="https://gullychain.xyz/core">Website</a> ·
  <a href="https://www.npmjs.com/package/@gullylabs/core-widgets">npm</a> ·
  <a href="https://github.com/gully-labs">GitHub</a>
</p>

# @gullylabs/core-widgets

Embeddable swap, liquidity and launch widgets for **Gully Core** — a hooks platform on its own Infinity-architecture core (a singleton Vault with CL and Bin pool managers), deployed and verified per chain.

These widgets are built to live in **your** app. Not Gully Core's. If you run a DEX, an aggregator, a Launchpad, a wallet or a portfolio tracker, you can drop one in, keep your own look, and **earn a share of every swap it routes**.

MIT licensed. The protocol's Solidity is GPL-2.0; this package is independently authored against the ABIs, so embedding it puts no licence obligation on your app.

---

## The part that matters: integrator fee attribution

Every widget takes an `integrator` config:

```tsx
<WidgetProvider
  adapter={adapter}
  integrator={{
    referrer: "0xYourFeeRecipient",  // where your cut lands
    feeBps: 25,                      // 0.25% of the swap output
  }}
>
  <SwapWidget />
</WidgetProvider>
```

That is the whole integration. From there:

- The fee is taken **in the output currency**, out of the swap's own vault credit.
- It is **an action inside the swap transaction**, not an off-chain accrual, not a claim you file later, not a number in a dashboard someone else controls. It settles atomically with the swap or the swap reverts.
- It is **shown to the user** as its own line in the summary, and the "minimum received" they are quoted is already net of it.

### How it reaches the chain

```text
UniversalRouter.execute([INFI_SWAP], [plan], deadline)

  plan (one vault lock):
    0. CL_SWAP_EXACT_IN_SINGLE   amountOutMinimum = minAmountOutGross
    1. SETTLE_ALL                pull the input currency from the user (via Permit2)
    2. TAKE_PORTION              feeBps of the output credit  ->  your referrer   ← your fee
    3. TAKE_ALL                  the remainder -> the user, floored at minAmountOutNet
```

`TAKE_PORTION` splits the vault credit before anything leaves the singleton, so the router never holds your fee and there is no window in which it can be swept.

The code path, end to end:

| Step | Where |
| --- | --- |
| You pass `integrator` | `<WidgetProvider integrator={...}>` |
| Validated once, at mount | [`validateIntegratorConfig`](src/config/integrator.ts) |
| Split out of the quote for display | [`buildQuoteBreakdown`](src/core/math.ts) |
| Threaded into the execution request | [`useSwapExecute`](src/hooks/useSwapExecute.ts) |
| Encoded as a `TAKE_PORTION` action | [`buildSwapCall`](src/callpath/swap.ts) |

There is no code path that swaps while dropping the fee, and none that encodes a fee that did not pass validation — `buildSwapCall` re-checks the bounds and refuses a hand-constructed config.

### Rules, and what happens when you break them

| Rule | On violation |
| --- | --- |
| `feeBps` is an integer | `IntegratorConfigError` — `FEE_BPS_NOT_AN_INTEGER` |
| `0 ≤ feeBps ≤ 100` (**`MAX_INTEGRATOR_FEE_BPS`**, 1.00%) | `FEE_BPS_ABOVE_MAX` |
| `feeBps > 0` requires a `referrer` | `REFERRER_MISSING` |
| `referrer` is a well-formed address | `REFERRER_MALFORMED` |
| `referrer` is not the zero address | `REFERRER_ZERO_ADDRESS` |

Every one of these **throws at provider mount**, not at swap time. A misconfigured widget refuses to render and tells you why, because the alternative — a widget that renders perfectly and quietly earns you nothing — is the failure mode you would not notice for a month.

`MAX_INTEGRATOR_FEE_BPS` is a client-side policy, not a contract limit (the on-chain `BipsLibrary` only rejects above 100%). It exists so no embedder can ship a widget that takes a third of a user's output and poisons the widget for everyone else.

### Fee modes

`feeMode: "take-portion"` (default) puts the split inside the swap plan, as shown above.

`feeMode: "pay-portion"` moves it to the router level — the swap takes its full output to the router, `PAY_PORTION` forwards your fee, `SWEEP` returns the rest. Use it when the fee has to be taken across a plan the periphery cannot express alone. It costs an extra command and gives the router temporary custody, so it is not the default.

### What is *not* fee-bearing

**Liquidity.** `TAKE_PORTION` splits an output currency; adding liquidity has no output, and removing it returns the user's own principal. Skimming that is a withdrawal charge, not a referral fee. The `integrator` config is still carried through the liquidity path so you can record attribution in analytics, but nothing is taken on-chain.

**Launches** are fee-bearing, because a launch buy *is* a swap. There is no separate launch call path: `buildLaunchBuyCall` checks the hook's gates and then calls `buildSwapCall`, so the `TAKE_PORTION` step is the same one. See [Launch](#launch).

---

## Install

```bash
npm install @gullylabs/core-widgets viem react react-dom
```

`react`, `react-dom` and `viem` are peer dependencies, so your app's copies are used. `wagmi` is an optional peer — the widgets never import it, and you can bridge any wallet stack through the adapter interface.

Requires React 18 or 19, Node 20+ for the build.

---

## Quick start

```tsx
import {
  WidgetProvider,
  SwapWidget,
  createViemAdapter,
  type ChainConfig,
} from "@gullylabs/core-widgets";
import "@gullylabs/core-widgets/styles.css"; // or let the widget inject it
import { createPublicClient, http } from "viem";

const chain: ChainConfig = {
  chainId: 8453,
  name: "Base",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  contracts: {
    vault: "0x...",
    clPoolManager: "0x...",
    binPoolManager: "0x...",
    universalRouter: "0x...",
    permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
  },
  blockExplorerUrl: "https://basescan.org",
};

const adapter = createViemAdapter({
  chain,
  publicClient: createPublicClient({ transport: http("https://your-own-rpc") }),
  wallet: {
    getAccount: async () => yourWallet.address ?? null,
    sendTransaction: (tx) => yourWallet.send(tx),
  },
  tokens: yourTokenList,
  pools: yourPoolList,
});

export function Swap() {
  return (
    <WidgetProvider
      adapter={adapter}
      integrator={{ referrer: "0xYourFeeRecipient", feeBps: 25 }}
      theme="system"
    >
      <SwapWidget />
    </WidgetProvider>
  );
}
```

---

## Headless vs styled

Two layers, two entry points. Pick the one that matches how much of the UI you want to own.

### Styled — `@gullylabs/core-widgets`

Drop-in components: `<SwapWidget />`, `<LiquidityWidget />`, `<LaunchWidget />`. They render real form semantics, handle approvals and transaction states, and theme entirely through CSS custom properties.

### Headless — `@gullylabs/core-widgets/headless`

Hooks and pure functions. No markup, no stylesheet, no `react-dom/client` — so none of it lands in your bundle.

```tsx
import {
  WidgetProvider,
  useSwapQuote,
  useSwapExecute,
} from "@gullylabs/core-widgets/headless";

function MySwapForm({ tokenIn, tokenOut, amountIn }) {
  const { breakdown, status, rate } = useSwapQuote({ tokenIn, tokenOut, amountIn });
  const { execute, step, statusMessage, needsApproval, approve } = useSwapExecute({
    tokenIn, tokenOut, amountIn,
    quote: quote.quote, breakdown,
  });

  // breakdown.integratorFee is already split out. Render it however you like.
}
```

| | Headless | Styled |
| --- | --- | --- |
| Controllers (`useSwapQuote`, `useSwapExecute`, `useAddLiquidityQuote`, `useLaunchBuy`, …) | ✅ | ✅ |
| Quote math, formatting, call-path encoders | ✅ | ✅ |
| Adapters and config validation | ✅ | ✅ |
| Components and stylesheet | — | ✅ |

Going headless does **not** opt you out of fee validation: `WidgetProvider` validates the config, and the call-path builders refuse anything that did not come from it.

Available hooks: `useSwapQuote`, `useSwapExecute`, `useSlippageSetting`, `useAddLiquidityQuote`, `useAddLiquidityExecute`, `usePositions`, `useRemoveLiquidity`, `useLaunch`, `useLaunchList`, `useLaunchBuy`, `useTokenList`, `useTokenBalance`, `useAccount`, `usePools`, `usePoolState`.

---

## Non-React hosts

### Custom elements

```html
<script type="module">
  import { defineGullyCoreWidgets } from "@gullylabs/core-widgets/embed";
  defineGullyCoreWidgets();
</script>

<gullycore-swap-widget
  theme="dark"
  integrator='{"referrer":"0xYourFeeRecipient","feeBps":25}'
></gullycore-swap-widget>

<script type="module">
  // A live adapter cannot come from an attribute (a viem transport is not JSON).
  document.querySelector("gullycore-swap-widget").adapter = myAdapter;
</script>
```

Three elements: `<gullycore-swap-widget>`, `<gullycore-liquidity-widget>`, `<gullycore-launch-widget>`. Each renders into a shadow root, so the widget's CSS cannot leak into your page and your CSS cannot break the widget — while `--gullycore-*` custom properties still inherit through the shadow boundary, which is exactly the theming behaviour you want.

### The lock badge script (`gullycore-embed.js`)

For a project site with no bundler and no React, `dist/gullycore-embed.js` (IIFE, also `dist/gullycore-embed.mjs`) is one self-contained file: viem, the SDK's lock readers and the address book are inside it, and there is no React and no wallet code. It registers `<gullycore-lock-badge>` on load:

```html
<script src="https://<gullycore site>/embed/gullycore-embed.js" defer></script>

<gullycore-lock-badge chain="999" pool="0x…32-byte pool id…" site="https://<gullycore site>"></gullycore-lock-badge>
<gullycore-lock-badge chain="999" token="0x…token…" theme="dark"></gullycore-lock-badge>
```

| Attribute | |
|---|---|
| `chain` | chain id; must be in the SDK's address book, else the badge says Gully Core is not deployed there |
| `pool` / `token` | a pool id (add `pool-type="bin"` for a Bin pool) or a token address |
| `rpc` | read through this RPC instead of the chain's public endpoints |
| `site` | the Gully Core site origin; with it the badge links to the public lock page and shows the Gully Chain icon (`<site>/identity/gc-icon.svg`, `gc-icon-ink.svg` on a light ground), without it neither |
| `theme` | `dark` (default), `light` or `system` |
| `refresh` | seconds between re-reads (default 60, minimum 15, `0` = never) |

It reads the same way as `LocksBadge` and says only what it read: "X% of active liquidity locked", "Locked permanently (LP locker)", "Y% of supply locked" (the share of supply not yet vested), "No locked liquidity". It never says "safe". The Gully Core site serves the file at `/embed/gullycore-embed.js` and has an iframe form at `/embed/lock-badge?net=<network>&pool=…|token=…`; each public lock page's **Embed badge** button prints both, filled in, with a live preview. The ESM entry `@gullylabs/core-widgets/embed` exports `defineGullyCoreLockBadge()` for bundled hosts.

The locker is not in this bundle: it signs transactions, and a framework-free script cannot bring a wallet. Use `LockerWidget` from React, or the Gully Core site's `/embed/locker?net=<network>` iframe, which carries its own wallet connect.

### Iframe bridge

For hosts that will not run third-party script in their own realm — a reasonable position when the script asks users to sign transactions.

The widget runs in the iframe and owns only rendering. It holds no keys and opens no RPC connections. Every chain read and write is a request to your page, which answers it with your adapter and your wallet.

```text
 iframe (widget)                         parent (your page)
 ────────────────                        ──────────────────
  ready ─────────────────────────────────▶
       ◀───────────────────────────── init { chain, integrator, theme, isMock }
  invoke { id, method, args } ───────────▶
       ◀────────── result { id, ok: true, value } | { id, ok: false, error }
  resize { height } ─────────────────────▶
  event  { name, payload } ──────────────▶
```

Every message carries `{ channel: "gullycore-widget", version: 1, type }`; anything else is ignored. Both sides pin the counterpart origin and check `event.origin` — never `"*"`, and never anything inside `data`, which is attacker-controlled. `BigInt` survives structured clone, so amounts cross the boundary as exact integers; nothing is stringified.

Host side:

```ts
import { serveWidgetIframe } from "@gullylabs/core-widgets/embed";

const stop = serveWidgetIframe({
  iframe: document.querySelector("iframe#gullycore")!,
  widgetOrigin: "https://widgets.example",   // exact origin, never "*"
  adapter: myAdapter,
  widget: "swap",
  integrator: { referrer: "0xYourFeeRecipient", feeBps: 25 },
  approveTransaction(request) {
    // Last line of defence before you sign. The widget is still third-party code.
    return (
      request.to === MY_ROUTER &&
      request.integratorFee?.referrer === MY_FEE_RECIPIENT
    );
  },
});
```

Widget side (inside the iframe):

```ts
import { createIframeBridgeAdapter } from "@gullylabs/core-widgets/embed";

const { adapter, init } = await createIframeBridgeAdapter({
  hostOrigin: "https://app.example",
});
```

**You are the security boundary.** Before signing, check that `to` is a contract you expect, that `value` matches what the user was shown, and that `integratorFee.referrer` is your address. This contract makes the widget *inspectable*, not trusted.

---

## Theming

Every colour, radius, font and spacing value is a `--gullycore-*` custom property declared on `.gullycore-widget`. Override one from your page and the widget follows — nothing is hardcoded inside a rule.

```css
.gullycore-widget {
  --gullycore-accent: #ff4d6d;
  --gullycore-accent-hover: #e04360;
  --gullycore-radius: 4px;
  --gullycore-font: "Your Brand Sans", system-ui, sans-serif;
  --gullycore-bg: var(--your-card-background);
  --gullycore-text: var(--your-body-colour);
}
```

The defaults are the Gully Core design's own: panel `#1A1F1E`, wells `#0C1613`, hairlines `#353F3D`, ink `#D0D5DA`, muted `#8FA09C`, the action fill `#2CF29A` with `#0A0F0E` on it (dark), and the matching "surface water" light set; Inter for amounts, Inter for text and the system monospace for labels and lines, each with a system fallback because a host page may not load them. Light and dark both ship, and dark is the default. `theme="dark" | "light" | "system"` on the provider; `system` follows `prefers-color-scheme`.

The full token set: `--gullycore-bg` (the panel), `--gullycore-bg-elevated` (the wells), `--gullycore-bg-sunken`, `--gullycore-bg-selected` (a pressed chip), `--gullycore-border`, `--gullycore-border-strong`, `--gullycore-text`, `--gullycore-text-muted`, `--gullycore-text-inverted`, `--gullycore-accent` (the action fill), `--gullycore-accent-hover`, `--gullycore-accent-text` (text on it), `--gullycore-accent-ink` (the action colour as text; follows `--gullycore-accent` in dark), `--gullycore-done` / `--gullycore-done-text` (the button after a confirmed swap), `--gullycore-buy` / `--gullycore-buy-ink` / `--gullycore-sell` / `--gullycore-sell-ink` (the Buy / Sell tabs), `--gullycore-success`, `--gullycore-warning`, `--gullycore-warning-bg`, `--gullycore-danger`, `--gullycore-danger-bg`, `--gullycore-focus`, `--gullycore-radius` (wells; the button is 2px rounder), `--gullycore-radius-sm` (chips), `--gullycore-radius-lg` (the frame, `radius + 4px` by default), `--gullycore-font`, `--gullycore-font-display` (amounts and titles), `--gullycore-font-mono`, `--gullycore-font-size`, `--gullycore-font-size-sm`, `--gullycore-font-size-lg`, `--gullycore-gap`, `--gullycore-padding`, `--gullycore-control-height`, `--gullycore-max-width` (480px; `none` to fill the host's column), `--gullycore-shadow`.

**Getting the stylesheet in:** either `import "@gullylabs/core-widgets/styles.css"`, or do nothing — the styled components inject it once on mount. The web component always injects it into its own shadow root. All three come from one source (`src/styles/css.ts`), so they cannot drift.

**Narrow layouts.** The widgets are single-column and fluid from 280px up, with a tighter padding and type scale below 380px. They are meant to live in a 360px sidebar and are tested at that width.

---

## Chain configuration

Nothing in this package knows which chain you are on. There are no bundled RPC URLs and no address book — a hardcoded address is a bug that ships to every host. Everything arrives through `ChainConfig`:

```ts
interface ChainConfig {
  chainId: number;
  name: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  contracts: {
    vault: Address;               // required
    clPoolManager?: Address;      // at least one pool manager required
    binPoolManager?: Address;
    universalRouter?: Address;    // required to swap
    clPositionManager?: Address;  // required for CL liquidity
    binPositionManager?: Address; // required for bin liquidity
    permit2?: Address;            // required to pull the input token
    quoter?: Address;             // CLQuoter; required to quote CL hops
    binQuoter?: Address;          // BinQuoter; required to quote liquidity-book hops
    launchGuardHook?: Address;    // required to read a launch schedule
    launchGuardHookClock?: "timestamp" | "contract-block"; // else the SDK record, else CLOCK_MODE()
    binLaunchGuardHook?: Address; // the Bin launch guard, timestamp-clocked
    launchpadKitV2?: Address;     // lets a launch be looked up by its token
  };
  transport?: Transport;          // viem transport, if the adapter reads directly
  blockExplorerUrl?: string;
  defaultDeadlineSeconds?: number; // default 1200
}
```

`assertValidChainConfig` runs at provider mount. A missing address fails at the operation that needs it, naming both — `contracts.universalRouter is not configured, but it is required to execute a swap` — rather than surfacing as a decode error.

---

## The adapter boundary

Every chain read and write goes through one interface, `ProtocolAdapter` ([`src/adapters/protocol.ts`](src/adapters/protocol.ts)). No component, hook or controller imports a viem client directly.

### `createViemAdapter` — live

Produces real calldata and submits real transactions.

- **Encoding** is complete and unit-tested against the router and periphery sources. See [Executed against a real deployment](#executed-against-a-real-deployment).
- **Token, balance and allowance reads** are ordinary ERC-20 and Permit2 calls.
- **Pool discovery** is not on-chain — the singleton has no pool enumeration. Pass the pools you support, or wire an indexer (`@gullylabs/core-sdk/indexer` describes the schema).
- **Quoting** needs a deployed quoter or a host-supplied `overrides.quoteSwap`. Without one it throws `UnsupportedOperationError` rather than inventing a number. **A fabricated quote is worse than no quote.**

The same applies to `getPoolState`, `listPositions`, `quoteAddLiquidity` and `quoteRemoveLiquidity`: supply an override or get a named error, never silent zeros. "There is no liquidity" and "I could not find out" must not render identically.

### Your own adapter

Implement `ProtocolAdapter` to route through your backend, your quoter, or wagmi. The widgets neither know nor care.

---

## Widgets

### Swap

`<SwapWidget />` is the one swap surface Gully Core ships: the template, the hosted Launchpad and DEX sites and the dapp all mount this component. Two labelled wells (YOU PAY / YOU RECEIVE), each with a token chip that opens a selector dialog; a flip button between them; one 52px call to action that always says the next step (connect, enter an amount, insufficient balance, approve, swap); and a details disclosure. While a transaction is on its way the button reads **Confirming** beside three sounder bars (the finer step, "Confirm in your wallet…" or "Confirming on chain…", is its accessible text, and the button is an `aria-live` region); a confirmed swap shows **Swapped ✓** in the done fill (`--gullycore-done`) for 1.8 s, then the button says the next step again. Motion is off under `prefers-reduced-motion`.

```ts
interface SwapWidgetProps {
  defaultTokenIn?: string;        // pre-select the input token by address
  defaultTokenOut?: string;       // pre-select the output token by address
  title?: string;
  showSlippageControl?: boolean;  // default true
  onSwapConfirmed?: (hash: string) => void;
  tokenLists?: readonly (TokenList | { url: string })[];  // Uniswap Token Lists, see below
  onConnectRequest?: () => void;  // makes "Connect wallet" a working button

  // Host framing - all opt-in; without them the widget is the one above.
  pair?: { token; quote } | { tokenIn; tokenOut };   // pin the pair (address or TokenInfo)
  lockPair?: boolean;             // with pair: selectors become read-only chips
  side?: 'buy' | 'sell';          // controlled direction over the pair
  onSideChange?: (side: 'buy' | 'sell') => void;
  portions?: readonly number[];   // balance chips as fractions; default [0.25, 0.5, 0.75, 1]
  onNeedsWallet?: () => void;     // a portion was asked for with no balance to take it from
  onQuote?: (quote: SwapQuoteView | null) => void;
  slots?: { header?: ReactNode; aboveButton?: ReactNode; footer?: ReactNode };
  variant?: 'default' | 'compact' | 'panel'; // see below
  showPortions?: boolean;         // absent: chips once a balance is read; true: always; false: never
  slippageControl?: 'settings' | 'inline' | 'none';  // default 'settings' ('none' when showSlippageControl is false)
  slippageOptions?: readonly number[];  // inline choices in bps; default [10, 50, 100]
  bare?: boolean;                 // no frame of its own, for a host that already draws the panel
  creatorTax?: { buyBps: number; sellBps: number } | null;  // its own line; the rate NOW (0 once expired)
}

interface SwapWidgetHandle {       // via `ref`
  setAmountIn(text: string): void;
  setPortion(fraction: number): boolean;
  flip(): void;
  refreshQuote(): void;
}
```

**Token lists.** `tokenLists` takes lists in the [Uniswap Token Lists](https://github.com/Uniswap/token-lists) standard, as documents already in hand or as `{ url }` entries the widget fetches through the SDK's `fetchTokenList` (schema-validated, size-capped, no caching). The adapter's own tokens — the tokens of the pools this site routes through, decimals read off their contracts — always come first and are never overridden by a list; then each list's tokens in list order, deduped by address, the first list to name an address winning and the others recorded as `listSource.alsoIn`. The picker groups entries by list, badges tokenised stocks from `extensions.stock` (issuer and ticker; `rebasing` is a warning), marks `test` and `launch` tags, resolves `ipfs://` logos through the SDK's allow-listed gateways, and names a list that failed to load instead of dropping it silently. A pasted address that is in no list is read off its contract and shown as **unlisted**. Gully Core's own list per chain is `gullycoreTokenListUrl(chainId)` from the SDK; a runtime list of a kit's launches is `launchedTokenList` / `launchedTokenListFromScan`. The pure helpers (`combineTokens`, `tokensFromLists`, `groupBySource`, `resolveLogoUrl`) and the `useTokenLists` hook are exported from the headless entry.

Everything below the presentation is the headless layer (`useSwapQuote`, `useSwapExecute`); the component only renders it.

**Overlays are Radix primitives (MIT), portalled into the widget root.** The token selector is `@radix-ui/react-dialog`, the slippage settings `@radix-ui/react-popover`. Radix portals default to `document.body`, which is outside a shadow root and outside the `.gullycore-widget` theme scope, so `WidgetShell` provides its own portal container (`src/components/portal.tsx`) and every overlay renders inside it: dialogs and popovers inherit the `--gullycore-*` variables and stay styled inside the custom-element embed.

**The details list**, in order: price impact (with severity), max slippage, minimum received, pool fee, the integrator fee line, the route, and the quote's age.

- **Price impact comes from `getSlot0`, net of the known LP fee.** The live adapter prices the input at the pool's current `sqrtPriceX96` (CL) or `activeId` (Bin), deducts the pool's declared LP fee, and compares the quoted output against that; the shortfall is the impact (`priceImpactBps` in `src/core/math.ts`). When the pool's fee is **hook-set** and not readable in advance, the adapter reports **no spot at all** rather than an impact that silently includes the fee, so the row shows no number and the pool fee row reads `dynamic (hook-set)`. A price impact of 15% or more must be acknowledged before the button arms.
- **Through a launch pool, the trading fee and the creator tax are their own lines, never part of the impact.** On some launch pools the fee is the pool's own. On others it is paid in the pool's quote currency and the launch contract takes it: on a buy, part of the trading fee goes to the pool's liquidity providers and the launch contract takes the rest; on a sell the launch contract takes all of it. The adapter reads how the fee is divided from the launch contract and reports it on the quote (`launch.feeParts`, in pips: `poolPips` and `launchPips`). The fee line always prints the whole trading fee. If the division could not be read, the line says so, `feeParts` is `null`, and a buy shows no price impact rather than one worked out from a guess.
- **The integrator fee line** appears only when `integrator.feeBps > 0`: `<label> fee (0.25%)`, the amount in the output token, and the referrer it goes to — the same `TAKE_PORTION` step the transaction carries. `label` names the line; it is never sent on chain.
- **Minimum received** is the floor after slippage *and* the integrator fee, which is what the plan's final `TAKE` enforces.
- **No dollar figure anywhere.** Nothing in the adapter prices a token in USD, and a number that looks priced and is not would be an invented one.

`Max` on the native asset keeps a sliver back for gas; on an ERC-20 it uses the whole balance.

#### Framing the widget from a host page

A token page with its own Buy / Sell tabs, or a swap page that deep-links a pair, drives the widget through props rather than by remounting it with a `key` (a remount clears the typed amount and re-reads the token list). Every prop below is opt-in and the widget without them behaves exactly as before. The state behind them is pure (`swap/state.ts`, exported from both entries) and tested without a DOM.

**`pair` pins the pair.** Either shape: `{ token, quote }` is the anchored form (`token` is what is traded, `quote` what it is priced in); `{ tokenIn, tokenOut }` is the same pair in its buy orientation. Each entry is an address or a `TokenInfo`. An address is resolved against the widget's token list and, when the list lacks it, read off the token contract through the adapter (the path a pasted address takes); a `TokenInfo` is selected on the first frame. A change of `pair` re-pins without a remount, so the typed amount survives a host switching between a token's pools. Without `lockPair` the visitor can still pick other tokens; the pin returns when the prop changes.

**`lockPair`** (with `pair`) turns the two selectors into read-only chips: the token's logo and symbol, no chevron, no dialog, labelled "(fixed)". The pair cannot be changed from inside the widget. The flip button stays, because it flips the *side*, not the pair. The amount input is never remounted, so it keeps focus and value across quote refreshes and side changes.

**`side` orients the pair.** `buy` pays the quote and receives the token; `sell` the reverse. It is a controlled prop: when set, the widget's flip button does not move on its own but reports through `onSideChange`, and the host decides. When absent the widget owns its side and still reports every flip. A side change - from the prop, the flip button or `flip()` - **keeps the typed amount as the amount you pay** and re-quotes at once; it never clears the field (the widget is exact-input only, so the number in the field always means "what I pay"). The price-impact acknowledgement resets, because it was given for a different trade. `defaultTokenIn` / `defaultTokenOut` describe what the panels show on the initial side.

**`portions`** are the quick-amount chips under the "You pay" amount, as fractions in `(0, 1]` in the order given; `1` renders as "Max" (native keeps its gas sliver). Default `[0.25, 0.5, 0.75, 1]`; `[]` hides them; anything outside `(0, 1]` throws at render like every other bad config. The chips show only once a balance has been read: without a wallet there is no balance to take a portion of, and the widget does not invent one.

**`variant="compact"`** is the trade panel (a token page's or a market page's): ▲ Buy / ▼ Sell tabs in the header where the title was (tinted in the CVD-safe up / down hues, `--gullycore-buy` / `--gullycore-sell`), one AMOUNT well, its chips as their own row, the inline slippage row when `slippageControl="inline"`, and every line always visible above the button, each on its own line: you receive, pool fee, price impact, the creator tax when `creatorTax` is given, minimum received (with the slippage in its label). The button names the trade ("Buy TKN" / "Sell TKN") and, once confirmed, "Bought ✓" / "Sold ✓". Use it with a pinned `pair`; the tabs change the side exactly as `side` / `onSideChange` do and keep the typed amount. The quote and the simulation before every send are the default variant's. On the custom element: `variant="compact"`.

**`variant="panel"`** is the dashboard's swap card: no title row (the title stays the section's heading for assistive technology, and the row comes back only to hold the settings popover), the YOU PAY well with its balance under the amount, the YOU RECEIVE well, no flip button, and the lines always visible: pool fee, price impact, route, the creator tax, the integrator fee, minimum received. On the custom element: `variant="panel"`.

**`showPortions`** decides when the chips show: absent, once a balance has been read (as before); `true`, always - the trade panel's 25% / 50% / 75% / MAX row - and a chip pressed with no wallet calls `onNeedsWallet` and writes nothing; `false`, never. The chip last used reads as pressed (`aria-pressed`) until the amount is typed over or the side changes. On the custom element: `show-portions="true"`.

**`slippageControl`** places the slippage choice: `"settings"` is the header's popover; `"inline"` a "Slippage" row of `slippageOptions` (bps, default 0.1% / 0.5% / 1%) as a radio group, the provider's `defaultSlippageBps` checked first; `"none"` leaves the provider's default in force. A bad choice throws at render. On the custom element: `slippage-control="inline"`.

**`bare`** drops the widget's own frame (padding, border, background, shadow, max width) for a host that already puts it in a panel; the root carries `data-gullycore-bare="true"`.

**`creatorTax`** is the launch guard's creator tax as the host read it (`getTax`), in bps for a buy and a sell, rendered as its own "Creator tax (buy|sell)" line in both variants — never folded into the pool fee or the price impact. Pass the rate NOW: 0 once `expiresAt` has passed, because the tax ends with no transaction. `null` reads "none"; absent, there is no line.

**The `ref` handle** lets a host draw its own chips or tabs and leave the trade to the widget. `setAmountIn("1.5")` writes the field; `setPortion(0.75)` writes a fraction of the input balance and returns `true`, or returns `false` and calls `onNeedsWallet` when there is no balance to take it from (nothing is written then; pass `onNeedsWallet={openConnectModal}` to turn a "Max" press without a wallet into a connect prompt, or leave it and give the host chip a title); `flip()` is the flip button; `refreshQuote()` re-reads now.

**`onQuote`** reports every quote the widget holds as a `SwapQuoteView` - `amountOut` (net of the integrator fee), `minReceived` (the floor the transaction enforces), `priceImpactBps` with its severity (`null` when the pool's fee is hook-set: an impact that silently included the fee would be an invented number), `lpFee.label` (a percentage or `dynamic (hook-set)`), the `route` and its `routeSymbols`, the display `rate`, `isRefreshing` and `updatedAt` - and `null` when there is none: empty amount, no route, or unmounted. It fires when the quote changes, including on each refresh, so a host prints the impact in its own header without running `useSwapQuote` a second time.

**`slots`** are the host's own chrome, rendered inside the widget's frame: `header` between the title row and the panels (a leg switcher, a note), `aboveButton` between the panels and the call to action, `footer` after the details and status line. The brand line ("Gully Core · chain") is not a slot and stays last.

**Provider presence.** `WidgetContext` and `useOptionalWidgetContext()` are exported, so a host that mounts the provider late (once its pool directory is read, say) tests for it directly - `useOptionalWidgetContext() === null` - and renders its waiting state, instead of catching the throw from `useWidgetContext` in an error boundary.

```tsx
const widget = useRef<SwapWidgetHandle>(null);
const [side, setSide] = useState<'buy' | 'sell'>('buy');
const [quote, setQuote] = useState<SwapQuoteView | null>(null);

<SwapWidget
  ref={widget}
  pair={{ token: launch.token, quote: leg.quote }}
  lockPair
  side={side}
  onSideChange={setSide}
  onQuote={setQuote}
  onNeedsWallet={openConnectModal}
  slots={{ header: <LegSwitcher legs={legs} /> }}
/>
<button onClick={() => widget.current?.setPortion(0.75)}>75%</button>
{quote ? <span>{formatPercentFromBps(quote.priceImpactBps)} impact · min {formatAmount(quote.minReceived, quote.tokenOut.decimals)}</span> : null}
```

### Liquidity

`<LiquidityWidget />` covers add and remove for **both** pool types behind one interface. The add/remove split is a tab; the CL/Bin split is not — the pool decides which range editor renders and the rest (amounts, quote, approvals, execution) is identical.

```ts
interface LiquidityWidgetProps {
  defaultPoolId?: string;          // pre-select a pool by id
  title?: string;
  defaultMode?: "add" | "remove";  // which tab opens first
}
```

- **Concentrated liquidity** — a tick pair, snapped to the pool's tick spacing, with widen/narrow controls (`adjustRange` moves both edges by whole spacings). The default range is ten spacings either side of the current tick.
- **Liquidity book** — a bin span around the active id (ten bins either side by default), with `idSlippage` of five, and a **uniform distribution** across it (`buildUniformBinDistribution`): bins below the active id take the Y side, bins above it the X side, the active bin both, and each side sums to exactly `1e18` with the rounding dust pushed into that side's last bin, as `BinPool.mint` requires.

Both emit the same `LiquidityRange` union, so everything above the range editor — amounts, quote, approvals, execution — is identical. The divergence is confined to [`src/callpath/liquidity.ts`](src/callpath/liquidity.ts). Positions for the remove tab come from `listPositions`: the live adapter reconstructs them from the position managers' transfer logs (confirmed against `ownerOf` / `balanceOf` and live pool state) and needs `positionsFromBlock` in its options, or it throws `UnsupportedOperationError` rather than scanning from genesis and reading as "no positions". No fee is taken on liquidity (see above).

### Launch

**A Gully Core launch is not a token sale.** It is a concentrated-liquidity pool with `LaunchGuardHook` named in its `PoolKey`, a dynamic LP fee, and a fee that decays from `initialFeeBips` to `finalFeeBips` over a window starting at the launch start — `startTime`/`decaySeconds` (seconds of `block.timestamp`) on the current hook, `startBlock`/`decayBlocks` (contract blocks) on the earlier block-numbered hook build. Every decoded `LaunchGuard` carries its `durationClock`; the live adapter picks the matching ABI from `contracts.launchGuardHookClock`, the SDK address book, or the hook's own `CLOCK_MODE()`. There is no `buy`, no soft cap, no hard cap, no allocation and no claim. **Buying into a launch is an ordinary swap.**

So `<LaunchWidget />` is a launch-aware swap panel. It reads, from `LaunchGuardHook`, keyed by pool id:

| Read | From |
|---|---|
| the whole schedule — start, window (`startTime`/`decaySeconds` or `startBlock`/`decayBlocks`), `enabled`, the owner | `getLaunch(poolId)` |
| the fee being charged **right now** | `currentFee(poolId)` |
| the block those two were true at | `eth_blockNumber` |

and then renders the decay curve by evaluating `launchFeeAtBlock`, an exact mirror of the hook's `feeAt` — flooring included, so the projected fee rounds up toward the LPs the way the contract does. If the chain's `currentFee` and the local projection ever disagree for the same block, the widget shows the chain's number and says the curve may be wrong.

Buying delegates to the swap path. `useLaunchBuy` composes `useSwapQuote` and `useSwapExecute`, and `buildLaunchBuyCall` checks the hook's gates and then calls `buildSwapCall`. A launch buy that took a different code path from a swap would be a second call path to keep correct, and the second one always rots.

#### `maxBuyPerTx` is per transaction, not per wallet

The widget says this on screen, because it is the field most likely to be read as an allocation. From the hook's own source:

> Splitting a buy across N wallets or N transactions in the same block is NOT prevented and cannot be. `maxBuyPerTx` bounds one transaction, nothing more.

The reason is structural: `beforeSwap` receives the *locker* as `sender`, which under a shared router is the router for every buyer alike. No identity-based rule is implementable at that layer, so there is no per-wallet cap to display and the widget does not invent one. The cap also stops being enforced once the decay window ends.

#### Four states, and no fallback

| State | When | What it says |
|---|---|---|
| loading | a read is in flight | "Reading the launch schedule from chain" |
| **not-configured** | `contracts.launchGuardHook` is unset | names the chain, says no hook is deployed there, and tells you which config key to set. **No address is invented.** |
| empty | the hook answered and holds no record for the pool | explains that a pool id is only claimed by `configureLaunch` |
| error | the read failed | the error, plus "nothing is shown in place of the schedule" |

The adapters keep *not-configured* and *empty* apart deliberately: `listLaunches` throws `ChainConfigError` when no hook address is configured and returns `[]` when the hook is there and no pool uses it. An empty array in the first case would read as "the launchpad is here and nobody has launched", which is a different and untrue statement.

#### If you run your own sale contract

Gully Core has none, but you might. [`src/adapters/sale.ts`](src/adapters/sale.ts) defines `TokenSaleAdapter` — caps, allocations, per-wallet limits, price curves — as an optional `ProtocolAdapter.sale`. It defines the shape of an *answer*, not the shape of your contract: your `buildBuy` returns a `WidgetTransactionRequest` encoded against your own ABI. Nothing in this package reads it, and the styled `LaunchWidget` binds to `LaunchGuardHook` and to nothing else.

### Locks — `LocksBadge`, `LocksPanel`

Read-only: a viem `PublicClient` and the lock contract from your address book, no provider and no wallet. `LocksBadge` is one line (the locked share of a pool's ACTIVE liquidity, or of a token's supply, a countdown to the next unlock, a link); `LocksPanel` is the full list. Pass the protocol's LP lockers (`lpLocker`, `binLpLocker`) and a launch's seed reads "Locked permanently (LP locker)". `linkTarget="_blank"` for a badge inside an iframe; `wording="embed"` for the embed badge's words.

```tsx
<LocksBadge client={client} target={{ kind: "pool", poolId, positionLock: book.positionLock }} siteUrl="https://<gullycore site>" lockPathBase="/locks" />
```

### Token trust — `TokenTrustPanel`

One place with what the Gully Core contracts hold about a token, each row with the contract, the view and the blocks it was read at:

- **Gully Core launch**: whether `LaunchpadKitV2` launched it (`legsOf`); "Launch status unknown" when no kit is deployed, never "not a launch".
- **Token locks & vesting**: `GullyCoreTokenLock` — share of supply locked (not yet vested) and held, next release.
- **Creator tax**: the Kit v2 launch guard's `getTax` / `currentTaxRates` per launch pool — buy and sell rates now, expiry, the frozen creator / protocol / integrator split. "No creator tax" only when the guard reads zero; "Not a Gully Core launch" only when the kit's `legsOf` is empty.
- **Per pool** (found through the launch legs, the LP lockers, `GullyCorePositionLock` and any `pools` you pass; the panel says the list is not every pool of the token): liquidity locks (locked share of active liquidity, permanent and time-locked), LP fee now (the guard's `currentFee` on a launch pool, the key's fee when static, "Dynamic (hook-set)" otherwise), protocol fee per direction, and what `GullyCoreRegistry` records about the hook — listed or not, listing status, verification, risk class and its source. A listing is not an audit, and nothing here says "safe".

```tsx
import { TokenTrustPanel } from "@gullylabs/core-widgets";

<TokenTrustPanel
  client={client}
  token={token}
  contracts={{
    clPoolManager: book.clPoolManager,
    binPoolManager: book.binPoolManager,
    launchpadKitV2: book.launchpadV2.launchpadKitV2,
    positionLock: book.positionLock,
    tokenLock: book.tokenLock,
    clLpLocker: book.launchpadV2.clLPLocker,
    binLpLocker: book.launchpadV2.binLPLocker,
    registry: book.registry,
  }}
  explorerAddressUrl={(a) => `${book.explorer}/address/${a}`}
/>
```

`contracts={null}` renders "Gully Core is not deployed on this chain". Headless: `useTokenTrust` / `fetchTokenTrust` here, `readTokenTrust` and the formatters (`describeLiquidity`, `describeCreatorTax`, `describeRegistry`, …) in `@gullylabs/core-sdk/trust`; `tokenTrustView` turns a read into rows.

### Locker — `LockerWidget`

A connected wallet locks a CL position NFT in `GullyCorePositionLock`, locks or vests tokens in `GullyCoreTokenLock` (a time lock, or cliff + linear), and manages its own locks: collect fees, extend, withdraw after the date, claim what has vested, accept an offered lock.

```tsx
import { LockerWidget } from "@gullylabs/core-widgets";

<LockerWidget
  client={client}                                   // reads, simulations and receipts
  contracts={{ positionLock: book.positionLock, tokenLock: book.tokenLock }}
  wallet={wallet}                                   // { getAccount, sendTransaction }, as createViemAdapter takes
  onConnectRequest={openConnectModal}
/>
```

- **The fee is the contract's.** `feeWei` and any announced `pendingFee` are read live and shown before anything is signed, in native units; the lock call sends the higher of the two and the contract refunds the surplus in the same call. Embedding the widget elsewhere changes nothing about what is charged.
- **Exact approvals, only when missing**: the one position NFT (`approve(lock, tokenId)`), or exactly the amount (`approve(lock, amount)`); none for native.
- **Simulate, send, confirm**: every call is simulated with its exact bytes from the connected account before the wallet sees it, and every receipt is checked — a mined revert is reported as one. Errors go through the same decoder as every other widget (`describeError`), which knows the lock contracts' errors.
- Omit `wallet` under a `WidgetProvider` and the provider's adapter signs. `contracts` with both `null` renders "No Gully Core locker is deployed on this chain".
- Headless: `useLockerFees`, `useMyLocks`, `useLockerRunner`, `simulateSendConfirm`, and the pure `planPositionLock`, `planTokenLock`, `lockerFeeView`, `positionLockActions`, `tokenLockActions`.

---

## Accessibility

- Real `<form>` elements; submit works from the keyboard, and Enter in the amount field does what you expect.
- A `<label>` for every input, including visually-hidden labels on the token selectors.
- One `aria-live="polite"` region per widget. Quote refreshes and transaction transitions are **announced without moving focus**, so a background re-quote never yanks a keyboard user out of the amount field mid-typing.
- `role="alert"` for errors, `aria-invalid` + `aria-describedby` on invalid fields, `role="progressbar"` on the sale progress, `aria-busy` on in-flight buttons.
- Visible focus rings on every interactive element, using `--gullycore-focus`.
- `prefers-reduced-motion` respected.

---

## Development

```bash
npm install
npm run typecheck    # tsc --noEmit, strict + noUncheckedIndexedAccess
npm test             # vitest, unit only
npm run build        # ESM + .d.ts + dist/styles.css
```

Tests cover fee attribution (validation, rounding parity with `BipsLibrary.calculatePortion`, and that the fee is genuinely in the encoded calldata), quote math (including the property that a swap clearing the gross floor always leaves the user at or above the net floor), and call-path encoding for both pool types. The unit suites drive the widgets through a test-only adapter under `test/helpers/`; the package exports no mock adapter.

### Executed against a real deployment

The `SwapWidget` is the swap box on <https://gullychain.xyz/core>, which trades against the deployed contracts on HyperEVM, BNB Chain, Robinhood Chain and Base through the Gully Core router. This package's own unit suites assert every encoding by decoding it back, which proves the encoder agrees with itself and nothing more: they do not execute against a chain.

---

## Other Gully Core packages

- [`@gullylabs/core-sdk`](../sdk/README.md) — TypeScript SDK: pool keys and ids, the hook permission bitmap, typed events, the address book, market reads and the Launchpad builders
- [`@gullylabs/core-connect`](../connect/README.md) — the wallet layer: a Gully Core-themed wrapper over RainbowKit and wagmi, with the Gully Core chain list
- [`@gullylabs/core-cli`](../cli/README.md) — the `gullycore` command: launches, hosted Launchpad and DEX sites, airdrops, splits, locks and `gullycore doctor`
- [`@gullylabs/create-core-app`](../create-gully-core-app/README.md) — the Gully Core app template: a DEX, a Launchpad or both, on the shared core
- [`@gullylabs/create-core-hook`](../create-gully-core-hook/README.md) — the hook starter: from a checkout, `node packages/create-gully-core-hook/bin/create-hook.js my-gullycore --template dynamic-fee` (`npx @gullylabs/create-core-hook` once it is on npm)

None of these packages is on npm yet (planned once Gully Core is live on all its chains); the links above point at each package's README in this repository, and every command runs from a checkout after `pnpm install` and the package's `build`.

Website: [gullychain.xyz](https://gullychain.xyz/core)


## Licence

MIT. See [LICENSE](LICENSE).

The protocol's core contracts are GPL-2.0-or-later. This package is independently authored from the compiled ABIs and contains no Solidity source, so building against it carries no obligation from the contracts' licence.
