// SPDX-License-Identifier: MIT
/* ============================================================================
   THE ONE FILE YOU EDIT.

   Everything needed to take this front end to market is below: the chain, the
   fee wallet, the branding and which features are on. There is no Solidity to
   fork, no address to hunt for in a component, and no second config.

   Your pools live in the Vault and pool managers Gully Core already has deployed and
   verified on the chain you pick. You are not deploying core. See README.md
   § "Shared core, not a full fork" for what that means and what it costs.

   After editing, check your work against the chain:

       npm run gullycore:verify

   It reads every configured address back, tells you which have code, what the
   pool manager's protocol fee controller currently is, and what a swap would
   actually cost a user. It sends no transaction.
   ============================================================================ */

import { defineGullyCoreDex } from "./src/config/types";

export default defineGullyCoreDex({
  /* --------------------------------------------------------------------------
     BRANDING
     -------------------------------------------------------------------------- */
  brand: {
    name: '__GULLYCORE_APP_NAME__',

    /* One line under the name, and none until you write one. Keep it true: it
       sits directly above numbers read from chain, and a tagline that claims
       something the app cannot show (a launchpad with `launchpad` switched off,
       say) is the same class of error as an invented figure.

         tagline: '…',  */

    /* Drop your own file in `public/` and point at it. Rendered 28px tall. */
    logoUrl: '/logo.svg',

    /* The native currency's own mark (ETH, HYPE, BNB), drawn by the swap box for
       the native coin and its wrapped form. Take it from the network's brand kit
       as it is — never redraw a mark — drop it in `public/` and point at it:

         nativeLogoUrl: '/hype.svg',

       Left out, the swap box draws a monogram of the symbol, which is honest.
       Every other token's logo comes from `tokens` below, a token list, or (for a
       token launched here) the icon its own metadata names. */

    /* `dark` (the default) or `light`: tells the browser and the charts which
       side of a two-sided colour the palette below is on. Pick the one that
       matches `colors.background`. */
    colorScheme: 'dark',

    colors: {
      accent: '#2cf29a',
      onAccent: '#0a0f0e',
      background: '#0c1110',
      surface: '#131a19',
      surfaceAlt: '#18211e',
      text: '#f2f4f4',
      textMuted: '#96a5a1',
      border: '#222d2a',
      positive: '#2f9e6b',
      negative: '#d94a4a',
    },

    /* The Gully Core type system, loaded in index.html (2026-09-26). Swap all three for your own
       brand, and change the <link> in index.html to match; nothing else reads a font name. */
    fontFamily: "Inter, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
    monoFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    headingFamily: "Inter, Inter, system-ui, sans-serif",
    radius: 12,

    /* Omit a link and it is not rendered. Nothing here invents a destination. */
    links: {
      // docs: 'https://docs.example.com',
      // x: 'https://x.com/example',
      // discord: 'https://discord.gg/example',
      // github: 'https://github.com/example/example',
      // terms: 'https://example.com/terms',
    },
  },

  /* --------------------------------------------------------------------------
     CHAIN
     -------------------------------------------------------------------------- */
  chain: {
    /* The chain this app reads and writes. Its core addresses come from the
       @gullylabs/core-sdk address book — the list of chains is not restated
       here, because a list in a comment is a list that goes stale. Run
       `npm run gullycore:verify` and it prints the chains it knows, with a live
       `eth_getCode` against every address it is about to use.

       As this template ships the book records Base (8453), BNB Chain (56),
       Robinhood Chain (4663), Kinetiq Elysium (99901), Anubis Network (6714) and
       Gully Chain Testnet (485590). A chain Gully Core has
       announced but not deployed on would be accepted too: the app then renders
       one "Coming soon" page and nothing else — no half-working screens, no
       reads against addresses that do not exist — and starts working when the
       SDK address book records the chain (bump the dependency); nothing in this
       file changes. */
    id: 8453 /* __GULLYCORE_CHAIN_ID__ */,

    /* GullyCoreRegistry — the shared marketplace of listed GullyCores (hook contracts).

       Deliberately NOT baked into deployments.ts. This contract is redeployable
       and has been redeployed once already, and a stale address does not fail
       loudly: it answers gullycoreCount() with a number and renders as a healthy
       empty marketplace. Read it from a release note or from `gullycore:verify`,
       set it here, and leave it null until you have.  */
    registry: null,

    /* LaunchpadKit — the one-call launch factory (create pool, configure the
       launch-guard decay schedule, seed liquidity, list the hook).

       null disables every launch surface with an honest "not configured" state.
       There is no shared v1 instance; Gully Core's shared launchpad is the v2
       kit below. See README.md § "Two launchpads, and which one you get". */
    launchpadKit: null,
    launchGuardHook: null,

    /* LaunchpadKitV2 — locked launches. One transaction mints a new token,
       opens one or more pools (single-sided CL ranges, shaped Bin
       distributions) and locks every position forever in a Gully Core locker, with
       the trading fee split between the creator, you and the protocol.

       null renders the v2 launch surfaces "not configured". Gully Core's own
       instance, once deployed, is in the SDK address book; `gullycore:verify`
       reports it and `gullycore:deploy -- --kit-v2 0x…` writes it here. */
    launchpadKitV2: null,

    /* Your tenant on that kit: the address that ran `setTenantConfig`. Leave
       null until you have (see `npm run gullycore:tenant`); until then launches are
       DIRECT, naming fee.wallet with the numbers in `launch` below. */
    launchTenant: null,

    /* YOUR OWN ROUTER — optional, and null is the right answer for almost
       everybody.

       Gully Core's router is the default and needs no configuration: leave this
       null and every swap this app builds — on the DEX surfaces AND when
       somebody buys on a launch — goes through the UniversalRouter the SDK
       address book records for the chain above (once Gully Core is deployed
       there), and a Gully Core redeploy reaches you by bumping the dependency.

       Set it to your own deployment and that one address changes. Everything
       else stays shared: your pools are still in Gully Core's Vault, the launchpad
       kit, the lockers, the registry and the utilities are untouched, and your
       `fee` below still lands — it is an action inside the swap plan your
       router executes, so it is yours through either one.

       IT MUST BE THAT ROUTER'S ABI. @gullylabs/core-widgets encodes
       `execute(bytes,bytes[],uint256)` with the Infinity command set, and it
       grants the input token's Permit2 allowance to this address. So this is a
       deployment of Gully Core's UniversalRouter — forking it is allowed, it is
       GPL-2.0-or-later — wired to the same Vault, pool managers and Permit2
       this app reads. Another contract that calls itself a router will encode
       fine and mean something else.

       WHAT YOU TAKE ON. A router sits in the swap path and holds users' funds
       while a swap is in flight; yours is yours to secure, and whoever owns it
       can pause every swap in this app. Gully Core's routed-fill fee (15 bps where
       Gully Core's router fills a trade somewhere other than a Gully Core pool, 0 on a
       Gully Core pool, inside an immutable cap) is charged by Gully Core's router: through
       yours your users do not pay it and you do not earn it — it is the
       protocol's, not an integrator share.

       Nothing here is checked until you ask: `npm run gullycore:verify` reads the
       code at this address, checks the router's vault() against the Vault this
       app uses, and reports paused() and owner(). Do that before users see it —
       a swap encoded to an address with no code does nothing, and a
       native-currency swap sends them the user's ETH. */
    router: null,

    /* Extra RPC URLs, tried before the SDK's probed public list. A keyed
       provider embeds its credential in the path, so read it from the
       environment and never commit the URL:

         rpcUrls: [import.meta.env.VITE_RPC_URL].filter(Boolean) as string[],  */
    rpcUrls: [],

    /* Only for a full fork or a local devnet. Your own core (and utility)
       addresses, and the block your log scans start from. On shared core
       leave both out: the SDK address book has the addresses, and the scans
       start at the block Gully Core's core was deployed. Wanting your own ROUTER on
       Gully Core's core is not a fork — that is `router` above, and setting both to
       different addresses is refused rather than silently ranked.

         contracts: { vault: '0x…', clPoolManager: '0x…', splitFactory: '0x…', … },
         logsFromBlock: 0,  */
  },

  /* --------------------------------------------------------------------------
     YOUR FEE — the reason this front end exists.

     Taken from the swap OUTPUT, inside the same transaction as the swap, by
     @gullylabs/core-widgets. Nothing is escrowed, owed, or reconciled later:
     either the fee is paid atomically with the swap or the whole transaction
     reverts.

     It is capped at 100 bps (1%) by the widgets package.

     It is SEPARATE FROM, and stacks on top of, two other fees your users pay:
       · the pool's LP fee, set by whoever created the pool;
       · Gully Core's protocol fee, set by Gully Core governance on the shared pool
         manager and capped at 0.4% by core. You cannot change that one, and it
         is the price of not deploying nineteen contracts yourself.
     The Fees screen reads all three from chain and shows the composed total.
     -------------------------------------------------------------------------- */
  fee: {
    /* null until you set it. A non-zero `bps` (or a launch share below) with no
       wallet is refused at startup rather than paid to nobody. */
    wallet: null /* __GULLYCORE_FEE_WALLET__ */,
    bps: 0 /* __GULLYCORE_FEE_BPS__ */,
    mode: 'take-portion',
  },

  /* --------------------------------------------------------------------------
     YOUR TAKE ON LAUNCHES (LaunchpadKitV2 only)

     Separate from the swap fee above, and paid to the SAME wallet. A locked
     launch pays you a share of its trading fee forever (next to the creator's
     and the protocol's shares) and, if you set
     one, a flat native-currency fee per launch on top of the protocol's.

     Both are capped by immutables on chain: maxIntegratorBps() (20%) and the
     kit's maxIntegratorLaunchFeeWei(). The protocol's 20% floor on the trading
     fee comes off first; the creator gets what is left.

     If chain.launchTenant is set these numbers MUST equal what you stored on
     chain, or every launch reverts. `npm run gullycore:verify` checks that.
     -------------------------------------------------------------------------- */
  launch: {
    integratorBps: 0,
    integratorLaunchFeeWei: '0',
    defaultProtocolBps: 0, /* release 3: an outside launch restates exactly 0; Gully takes the flat 0.30% on the pool instead */

    /* MARKET-CAP-FIRST. The wizard asks for an opening market cap, not a price:
       a price field for a 1e9-supply token is "0.000000005", and one zero out is
       10x, permanent, with the liquidity locked forever. This is the whole
       dollars the wizard proposes; Gully Core's own default is $3,500 (decided
       2026-09-20, the same on every chain and in every launchpad built
       on the kit). The wizard turns it into an opening price from the chain's
       native/USD feed, READ ON CHAIN, states the source and its age, and shows
       the SNAPPED price the pool is actually born at. Where the chain has no
       dollar source the field starts empty and the creator types a cap in the
       quote currency: no dollar figure is ever shown that nothing read. */
    defaultOpeningMarketCapUsd: 3500,
  },

  /* --------------------------------------------------------------------------
     FEATURES

     These gate navigation AND routing, so an off feature is unreachable rather
     than merely unlinked. No files were deleted; flip one back on any time.
     -------------------------------------------------------------------------- */
  features: {
    swap: true /* __GULLYCORE_FEATURE_SWAP__ */,
    pools: true /* __GULLYCORE_FEATURE_POOLS__ */,
    launchpad: true /* __GULLYCORE_FEATURE_LAUNCHPAD__ */,

    /* GULLY CORE UTILITIES — protocol tools your users get out of the box:

         splits    Team splits: one address that pays a team by fixed shares.
                   Also offered in the launch wizard as the creator-share
                   recipient.
         locks     Time-lock a liquidity position, or lock / vest tokens; lock
                   badges on pools and launched tokens, and a locks list.
         airdrops  Send to a CSV list in one transaction, or create a
                   claimable drop from a CSV, and a claim page.

       Their contracts come from the SDK address book for chain.id. Where one
       is not deployed yet, its page says "not deployed on <chain>" rather
       than failing; `npm run gullycore:verify` lists which are.

       FEES. Each contract charges its own flat fee in the native currency
       (a split's creation fee and frozen protocol share; one fee per lock,
       per multisend batch, per drop). The fee is ENFORCED BY THE CONTRACT,
       set by Gully Core governance inside an immutable cap, read live and shown
       before anyone signs. This app adds NO fee of its own to any of them —
       they are protocol utilities, not a revenue line of yours. Your revenue
       is `fee` (swaps) and `launch` (launches) above. */
    splits: true /* __GULLYCORE_FEATURE_SPLITS__ */,
    locks: true /* __GULLYCORE_FEATURE_LOCKS__ */,
    airdrops: true /* __GULLYCORE_FEATURE_AIRDROPS__ */,
  },

  /* --------------------------------------------------------------------------
     TOKENS

     There is no on-chain token registry, so this list is yours. Symbols and
     decimals are read back from the contracts at runtime and a mismatch is
     shown rather than hidden — a token that lies about its symbol in a config
     file is how somebody swaps into the wrong asset.

     Start empty and add what you list. An empty list renders an honest empty
     picker; it does not invent a pair.
     -------------------------------------------------------------------------- */
  tokens: [],

  /* --------------------------------------------------------------------------
     TOKEN LISTS

     Lists in the Uniswap Token Lists standard, offered in the swap picker
     beside `tokens` and the tokens of every pool on the core. 'gullycore' is
     Gully Core's own list for the chain above (generated from the SDK's address
     book and verified stock registry, published from a separate public
     repository; see `gullycoreTokenListUrl` in @gullylabs/core-sdk). Add your own
     https:// URLs after it. Order is precedence: the first list to name an
     address wins in the picker. Each list is fetched and schema-checked at
     runtime; one that does not load is named in the picker, never hidden.
     -------------------------------------------------------------------------- */
  tokenLists: ['gullycore'],

  /* --------------------------------------------------------------------------
     ROUTED FILLS — Gully Core's router by default, yours as an option.

     The swap box can ask a ROUTER API for a quote and fill a trade on a
     third-party venue through Gully Core's `GullyCoreFillRouter` when that pays the
     user more than every Gully Core pool. It falls back to Gully Core pools on any
     routing failure, so nothing here can break a swap; it can only make one
     better. The on-chain router every swap is EXECUTED through is a separate
     setting (`chain.router` above).

       api: 'gullycore'            Gully Core's hosted routing API (default).
       api: 'https://r.you.com'   your own deployment of the same API (it is in
                                  Gully Core's repository, MIT). It must name the
                                  same fill router as the SDK address book.
       api: null                  off: Gully Core pools only.

     A routed fill pays Gully Core's routing fee — 15 bps on a fill somewhere
     other than a Gully Core pool, 0 on a Gully Core pool, inside an immutable cap —
     to the protocol; it is not yours. And the one rule to decide on: the swap
     box IGNORES the router while `fee.bps` above is non-zero (a routed fill
     has no integrator step and would drop your fee), so routing only runs
     with `fee.bps: 0`. The app names that as a warning, never a surprise.

     An API key with the `router:quote` scope lifts the anonymous rate limit;
     read it from the environment, never commit it:

       apiKey: import.meta.env.VITE_GULLYCORE_ROUTER_KEY,

     Keys are self-serve at https://gullychain.xyz/core/developers (wallet sign-in).
     A VITE_ value is compiled into the public bundle, so whoever loads the
     site can read the key and spend its rate limit; it can only read and
     quote, and it is revocable there. See .env.example before setting it.

     `npm run gullycore:verify` asks the API whether it serves this chain and
     which venues it names, and reads the fee off the fill router.
     -------------------------------------------------------------------------- */
  routing: {
    api: 'gullycore',
  },
});
