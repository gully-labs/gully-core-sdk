<p align="center">
  <a href="https://gullychain.xyz/core">
    <img src="https://raw.githubusercontent.com/gully-labs/gullychain-sdk/main/.github/assets/og-image-1200x630.png"
         alt="Gully Core — Launch on one core." width="640">
  </a>
</p>

<p align="center">
  <a href="https://gullychain.xyz/core">Website</a> ·
  <a href="https://www.npmjs.com/package/@gullylabs/core-connect">npm</a> ·
  <a href="https://github.com/gully-labs">GitHub</a>
</p>

# @gullylabs/core-connect

The wallet layer for Gully Core: a thin, Gully Core-themed wrapper over
[RainbowKit](https://rainbowkit.com) and [wagmi](https://wagmi.sh), plus the
Gully Core chain list — wagmi's curated chain identities carrying probed,
redundant public RPC endpoints instead of wagmi's one-to-three defaults.

It **wraps** RainbowKit. It does not fork it. See
[Why a wrapper and not a fork](#why-a-wrapper-and-not-a-fork).

Licensed **MIT** (see `LICENSE`). This package is deliberately independent of
the GPL-2.0 Gully Core core so that applications and hook developers can build
against it without importing GPL code.

## Install

```sh
npm install @gullylabs/core-connect @rainbow-me/rainbowkit wagmi viem @tanstack/react-query
```

Peer dependencies (you install them; this package does not bundle them):

| Package                   | Range                  |
| ------------------------- | ---------------------- |
| `@rainbow-me/rainbowkit`  | `^2.2.0`               |
| `wagmi`                   | `^2.9.0`               |
| `viem`                    | `2.x`                  |
| `@tanstack/react-query`   | `^5.0.0`               |
| `react`, `react-dom`      | `^18.0.0 \|\| ^19.0.0` |

Node `>=20`. ESM only.

## Usage

Two stylesheets, RainbowKit's first, then ours:

```ts
import '@rainbow-me/rainbowkit/styles.css'
import '@gullylabs/core-connect/styles.css'
```

Create the wagmi config **once**, at module scope, and pass it to the provider.
A config rebuilt on render tears down every connector and drops the live
session.

```tsx
// wallet.ts
import { createGullyCoreConfig } from '@gullylabs/core-connect'

export const wagmiConfig = createGullyCoreConfig({
  appName: 'My Gully Core App',
  // projectId: '...',   // WalletConnect; defaults to VITE_WALLETCONNECT_PROJECT_ID
  // chains: [hyperEvm], // narrow to the chains your app actually writes to
})
```

```tsx
// App.tsx
import {
  GullyCoreWalletProvider,
  GullyCoreConnectButton,
  GullyCoreChainSwitcher,
} from '@gullylabs/core-connect'

import { wagmiConfig } from './wallet'

export function App() {
  return (
    <GullyCoreWalletProvider config={wagmiConfig}>
      <header>
        <GullyCoreChainSwitcher />
        <GullyCoreConnectButton variant="inline" />
      </header>
      {/* your routes; any wagmi hook works below this point */}
    </GullyCoreWalletProvider>
  )
}
```

`GullyCoreWalletProvider` mounts `WagmiProvider -> QueryClientProvider ->
RainbowKitProvider` in that order, applies the Gully Core theme, and targets
`GULLYCORE_DEFAULT_CHAIN` (Gully Chain Testnet) for a fresh connection; pass
`initialChain` to change it. Pass `queryClient` to share an
existing TanStack client, and `theme` to override or disable the Gully Core theme.

### `<GullyCoreConnectButton />`

RainbowKit's `ConnectButton.Custom` with Gully Core markup. Handles every
connection state explicitly, including "wrong network", which opens the chain
modal rather than falling through to a connected pill.

| Prop          | Default             | Notes                                  |
| ------------- | ------------------- | -------------------------------------- |
| `variant`     | `'sidebar'`         | `'sidebar'` fills width; `'inline'` is a compact pill |
| `showChain`   | `false`             | chain chip beside the account          |
| `showBalance` | `false`             | native balance in the account pill     |
| `label`       | `'Connect wallet'`  | disconnected-state label               |
| `className`   |                     | extra class on the outer element       |

### `<GullyCoreChainSwitcher />`

A menu over wagmi's `useSwitchChain`, grouped by the only question a user is
actually asking — *can I use this right now*:

```
AVAILABLE
  (none until Gully Core's first deployment)
COMING SOON
  ● HyperEVM
  ● Robinhood Chain
  ● Ethereum
  ● Base
  ● BNB Smart Chain
  …
```

**Available** is `GULLYCORE_DEPLOYED_CHAIN_IDS`: Anubis (6714) and Gully Chain Testnet (485590),
the chains in `@gullylabs/core-sdk`'s address book. **Coming
soon** is everything else in the config: endpoint-verified chains with no contracts yet. Testnet
is a per-row `TEST` tag, not a group — it qualifies a chain, it does not decide
whether the app works.

Coming-soon rows are **inert and say so**. They carry `aria-disabled="true"`
and the reason in their accessible name, and they stay in the tab order so a
keyboard or screen-reader user can reach that reason. They are not silently
no-op. Letting the switch through instead was rejected: `switchChain` to a
chain the wallet does not know triggers `wallet_addEthereumChain`, which is a
permanent change to the user's wallet, requested so they can look at an app
with no contracts on it.

| Prop           | Default | Notes                                       |
| -------------- | ------- | ------------------------------------------- |
| `renderIcon`   |         | `(chain: Chain) => ReactNode` — see below   |
| `onlyDeployed` | `false` | `true` drops the "Coming soon" section; falls back to the full list if that would be empty |
| `grouped`      | `true`  | Available / Coming soon sections; ungrouped, inert rows grow a visible `SOON` tag |
| `onSwitch`     |         | `(chainId: number) => void` after a successful switch |
| `className`    |         |                                             |

Keyboard: `↑`/`↓` wrap through every row, `Home`/`End` jump to the ends,
`Enter`/`Space` select, `Escape` closes and returns focus to the trigger, `Tab`
closes and moves on. Opening the menu focuses the row for the chain you are
already on.

#### Chain icons: `renderIcon`

**This package ships no chain logos** and never reads from a host
application's `public/` directory. Supply them with a render prop:

```tsx
<GullyCoreChainSwitcher renderIcon={(chain) => <MyChainLogo chainId={chain.id} />} />
```

It is called once per row and once for the trigger. Return an `<img>`, an
inline `<svg>`, anything — the switcher wraps it in `.gullycore-chain__icon` and
sizes that box, so a square 16–18px asset is the natural thing to hand back.
Return `null` for a chain you have no asset for and that one row falls back.

**Omit the prop entirely and the switcher still works.** Every row renders a
typographic monogram — the chain's first letter in the host's own type and
tokens. That is a deliberate placeholder, not a degraded state: an approximated
logo would misrepresent somebody else's brand, and a guessed asset path would
be a broken image.

### WalletConnect

`createGullyCoreConfig` reads `VITE_WALLETCONNECT_PROJECT_ID` from the build
environment (or takes `projectId` directly). When no id is present,
WalletConnect-backed wallets are **omitted from the modal** instead of failing
at connect time; only injected, Coinbase and Safe connectors are offered.
`hasWalletConnect()` reports which mode you are in.

The id is a public identifier, not a secret, but it is still read from the
environment so a fork does not silently bill its traffic to Gully Core's quota.

## Chains

```ts
import { GULLYCORE_CHAINS, GULLYCORE_DEPLOYED_CHAIN_IDS, hyperEvm, monad } from '@gullylabs/core-connect/chains'
```

`GULLYCORE_CHAINS` offers **twelve** mainnets (Anubis, HyperEVM, Robinhood Chain,
Ethereum, Base, BNB Smart Chain, Linea, Ink, X Layer, Monad, Plasma, Stable) and
Gully Chain Testnet. Every entry takes its identity — name,
`nativeCurrency`, `blockExplorers` — from wagmi's curated registry; the one
field this package replaces is `rpcUrls.default.http`, which carries a probed,
fastest-first list of three to five public endpoints per chain
(`GULLYCORE_PUBLIC_RPCS`).

Presence in `GULLYCORE_CHAINS` means "verified EIP-1153 target", **not** "Gully Core is
live". Check `GULLYCORE_DEPLOYED_CHAIN_IDS` / `isGullyCoreDeployedChain()` before any
write.

### Defined but not offered

Ethereum Sepolia (11155111), Stable Testnet (2201) and Arc Testnet (5042002) are
**absent from `GULLYCORE_CHAINS`**. Gully Core has no contracts on any of them, so
each would be a switcher row that could
only lead somewhere empty — and, unlike a mainnet, with no roadmap value to
justify it.

Their definitions were kept, not deleted: the endpoints were genuinely probed.
They are collected in `GULLYCORE_UNLISTED_CHAINS`, and opting one back in is one
line:

```ts
import { GULLYCORE_CHAINS, stableTestnet, createGullyCoreConfig } from '@gullylabs/core-connect'
createGullyCoreConfig({ chains: [...GULLYCORE_CHAINS, stableTestnet] })
```

### Audit surface

`UNVERIFIED_CHAIN_METADATA` (chains whose `nativeCurrency`/`blockExplorers` are
unverified) and `SINGLE_ENDPOINT_CHAIN_IDS` (chains with no RPC failover) are
both **empty** as of the 2026-09-10 probe, and exported as empty lists so a
release check can assert on them. `THIN_ENDPOINT_CHAIN_IDS` lists the chains
carrying fewer than five endpoints; its scope is every chain this package
*defines*, so it includes the unlisted Stable Testnet — intersect it with
`GULLYCORE_CHAINS` if you only care about offered chains.

## Theme

```ts
import { gullycoreTheme, GULLYCORE_THEME, GULLYCORE_COLORS } from '@gullylabs/core-connect/theme'
```

`gullycoreTheme({ accentColor?, accentColorForeground? })` returns a RainbowKit
`Theme` built by spreading RainbowKit's `darkTheme()` and overriding the fields
the Gully Core brand specifies. There is no light theme; the design defines none.
The raw brand tokens (`GULLYCORE_COLORS`, `GULLYCORE_FONTS`, `GULLYCORE_RADII`,
`GULLYCORE_SHADOWS`, `GULLYCORE_SCRIM`, `GULLYCORE_EASE`) are exported for hosts that need
matching values outside RainbowKit.

### Styling hooks

Every colour in `styles.css` is `var(--token, #fallback)`, so a host that
defines Gully Core's CSS tokens restyles the controls for free, and one that does
not still gets the brand.

- `--gullycore-connect-logo`: image shown before the connect-modal title. Defaults
  to the Gully Chain icon (kit v4 `gc-icon.svg`, byte-identical), inlined as a data URI (no file to host); set to `none` to disable, or
  point it at your own asset.
- `--gullycore-connect-plug-mask`: optional mask image for the plug glyph on the
  disconnected button.

## Why a wrapper and not a fork

RainbowKit is MIT, so a rebranded fork would be legal. The cost is
maintenance, not licensing: RainbowKit carries a large set of wallet
connectors whose SDKs, and WalletConnect itself, change constantly. A fork
would make every future connector breakage and security fix ours, forever.
RainbowKit's theme API and `ConnectButton.Custom` already reach everything the
Gully Core brand needs, and the few behaviours the theme cannot express, such as
dropping WalletConnect rows when no project id is configured, are handled in
`createGullyCoreConfig` by composing the wallet list ourselves.

This package is the seam. If RainbowKit ever cannot express something we need,
a fork replaces the internals of this package without touching its consumers.

## Other Gully Core packages

- [`@gullylabs/core-sdk`](../sdk/README.md) — TypeScript SDK: pool keys and ids, the hook permission bitmap, typed events, the address book, market reads and the Launchpad builders
- [`@gullylabs/core-widgets`](../widgets/README.md) — embeddable swap, liquidity and launch widgets with integrator fee attribution
- [`@gullylabs/core-cli`](../cli/README.md) — the `gullycore` command: launches, hosted Launchpad and DEX sites, airdrops, splits, locks and `gullycore doctor`
- [`@gullylabs/create-core-app`](../create-gully-core-app/README.md) — the Gully Core app template: a DEX, a Launchpad or both, on the shared core
- [`@gullylabs/create-core-hook`](../create-gully-core-hook/README.md) — the hook starter: from a checkout, `node packages/create-gully-core-hook/bin/create-hook.js my-gullycore --template dynamic-fee` (`npx @gullylabs/create-core-hook` once it is on npm)

None of these packages is on npm yet (planned once Gully Core is live on all its chains); the links above point at each package's README in this repository, and every command runs from a checkout after `pnpm install` and the package's `build`.

Website: [gullychain.xyz](https://gullychain.xyz/core)


## Build

```sh
npm run typecheck   # tsc --noEmit
npm run build       # tsc -> dist/, then copies src/styles.css -> dist/styles.css
```
