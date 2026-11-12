/**
 * Public RPC endpoints for every Gully Core target chain.
 *
 * Every endpoint below was PROBED, not collected from a list. Each one answered
 * `eth_chainId` with the expected id, served `eth_blockNumber` three times, and was
 * timed by the median of those three. Endpoints that 404'd, 403'd, rate-limited,
 * returned the wrong chain, or failed to resolve were dropped rather than shipped as
 * dead fallbacks — a dead entry is worse than a short list, because a fallback
 * transport spends a retry on it before reaching a provider that works.
 *
 * Ordered fastest-first by measured latency, which is also the order a fallback
 * transport should try them in.
 *
 * CHAIN ID IS NOT PROOF OF CHAIN. Since 2026-09-19 every endpoint here has also been
 * matched against a pinned GENESIS HASH (or, on the chains that serve no historical
 * block, against a settled block read from an endpoint already in this file). The
 * collision is real: chainid.network lists **Wanchain Testnet at chain id 999**, which
 * is HyperEVM's id, and a Wanchain node answers `eth_chainId` and `eth_blockNumber`
 * exactly like a healthy HyperEVM one. `scripts/probe-rpcs.mjs` keeps it as a standing
 * negative control and rejects it on every run. The per-endpoint `identity` field in
 * `rpc-probe-results.json` records which of the two checks settled each URL.
 *
 * SELECTION RULE, applied after the probe: fastest first, at most TWO endpoints per
 * operator, and the chain's own canonical endpoint always included where it was
 * reachable. Five is the target. Chains that carry fewer than five carry fewer
 * because fewer exist — see `THIN_ENDPOINT_CHAINS`; the list is never padded.
 *
 * And, added 2026-09-19: **a verified endpoint beats an unverifiable one.** Where a
 * host could not be reached from the probing machine but was verified on an earlier
 * run, it is kept ONLY if dropping it would leave the chain thinner; otherwise it is
 * replaced by something this run could actually measure. Entries kept that way carry
 * their LAST measured latency and an `unverified 2026-09-19` marker, so nobody reads a
 * stale number as a fresh one.
 *
 * Probed 2026-09-10; re-probed in full 2026-09-19 against an enlarged candidate list
 * (see `scripts/harvest-rpcs.mjs`). Public endpoints rot: re-run
 * `scripts/probe-rpcs.mjs` before relying on this in production, and expect some of
 * these to have gone away.
 *
 * NONE of these carry an API key. Never add a credentialed URL to this file — it is
 * committed. Keyed providers belong in the environment; see `resolveEndpoints`.
 * That is not a theoretical rule: chainid.network's own Sepolia entry ships a
 * FILLED-IN Alchemy key, so the harvester rejects opaque path segments outright.
 *
 * ---------------------------------------------------------------------------
 * WHAT chainid.network/chains.json GAVE US, AND WHAT IT GOT WRONG
 * ---------------------------------------------------------------------------
 *
 * Harvested 2026-09-19 (2,763 chains). It produced 24 candidates we did not have, of
 * which SIX survived the probe and ship here: `robinhood-rpc.publicnode.com`,
 * `rpc.sepolia.ethpandaops.io`, `xrpc.cl/sepolia`, and (already candidates, confirmed)
 * the BSC dataseed mirrors. Useful, and worth re-running. It is NOT a source of truth:
 *
 *   * chain id **999 in chains.json is Wanchain Testnet**, not HyperEVM. HyperEVM
 *     mainnet is ABSENT from the file entirely — only "Hyperliquid EVM Testnet" at 998
 *     is listed. Harvesting id 999 and trusting the chain id would wire a Wanchain node
 *     into HyperEVM's fallback list, and every health check would stay green. Chain 999
 *     is therefore skipped by the harvester AND used as the probe's negative control.
 *     DO NOT "fix" this by trusting the list.
 *   * it carries live credentials: `eth-sepolia.g.alchemy.com/v2/<32-char key>` sits in
 *     the Sepolia entry. A `${PLACEHOLDER}` filter alone would have let it through.
 *   * of our target chains it knows only one RPC each for HyperEVM(no), Monad,
 *     Plasma, Stable and Stable Testnet — it adds nothing on the chains
 *     where we are thinnest, which is precisely where we needed help.
 *
 * ---------------------------------------------------------------------------
 * NOT PRESENT, and why
 * ---------------------------------------------------------------------------
 *
 *   * Arc MAINNET (5042). **LISTED SINCE 2026-10-07** (decision that day: Arc mainnet is
 *     a deploy target; see the `arc` entry and `docs/chain-readiness-2026-10-07.md`). The
 *     history below is kept because the decimals warning in it still binds.
 *     **THIS CHANGED ON 2026-09-19 and the old note below is kept
 *     only for the history.** Arc mainnet now HAS public RPC: eight hosts answered
 *     `eth_chainId` = 5042, served `eth_blockNumber` (head ~21,746,650) and agreed
 *     UNANIMOUSLY on a genesis hash of
 *     `0x09944e07412986bb417fd0006c89ffb71ee523d68ce2017ec2dabc944c42edad` —
 *     Circle's `rpc.mainnet.arc.io` plus its drpc/quicknode/blockdaemon variants,
 *     `arc.drpc.org`, `arc-mainnet.drpc.org`, `5042.rpc.thirdweb.com` and
 *     `rpc.beamrpc.com`. That hash is now pinned in `scripts/probe-rpcs.mjs`.
 *
 *     It is STILL NOT LISTED HERE, and that is a decision rather than an oversight:
 *     Arc mainnet is not one of the fifteen target chains, and the decimals
 *     contradiction recorded below is unresolved. Adding a chain to this file is the
 *     step before somebody prices a pool on it. That needs a decision, not a probe.
 *
 *     The original note, 2026-09-10: "It exists and it is live, but it has NO public
 *     RPC. Circle's own mainnet hosts resolve and answer 401/403, and thirdweb's
 *     `5042.rpc.thirdweb.com` answers `eth_chainId` out of a config table while
 *     failing every `eth_blockNumber` — alive to a chainId check, dead to a real
 *     request." Arc TESTNET (5042002) is fully supported below. Do not add Arc
 *     mainnet from memory: probe it first.
 *
 *     PROBED AGAIN 2026-09-12 with a candidate supplied by the project owner,
 *     `https://rpc.arc-scan.org`. STILL NOT USABLE. DNS resolves and TCP
 *     connects in ~46ms, then the TLS handshake fails (curl exit 35, HTTP
 *     status 000); `https://arc-scan.org` itself behaves identically. A
 *     control request to a known-good host from the same machine returned
 *     200, so this is the endpoint rather than the network. Neither
 *     `eth_chainId` nor `eth_blockNumber` was answerable, so chain id 5042 is
 *     still UNCONFIRMED from here — it has never been read off a live node.
 *
 *     The rest of the original config is recorded so it is not lost, and
 *     because one field needs care when the chain does become reachable:
 *
 *         chainId 5042 · rpc https://rpc.arc-scan.org
 *         explorer https://arc-scan.org
 *         quoteIsGasToken true · nativeDecimals 18 · quoteDecimals 6
 *
 *     THE DECIMALS ARE CONTRADICTORY AND MUST BE SETTLED ON CHAIN FIRST.
 *     The original config says `quoteDecimals: 6`. Arc's own Connect RPC page,
 *     read from a browser that can reach it, says plainly:
 *
 *         Chain ID 5042      USDC - 18 decimals
 *
 *     USDC is 6 decimals everywhere else it exists, so 18 here is either a
 *     deliberate native-gas representation (a gas token has to be 18 to behave
 *     like ether in the EVM) sitting alongside a 6-decimal ERC-20 of the same
 *     name, or one of the two sources is wrong. Both readings are plausible
 *     and they differ by 10^12.
 *
 *     That is the same quantity that would have opened a USDG pool on
 *     Robinhood at a million times the intended price. `sqrtPriceX96` encodes
 *     the ratio in RAW units, so this is not a display concern — it is the
 *     opening price of a pool, fixed permanently at initialize.
 *
 *     Resolve it by reading `decimals()` off the actual token contract before
 *     any pool is priced, and record BOTH the gas-token and ERC-20 answers if
 *     they turn out to differ. Do not let a default of 18, or of 6, anywhere
 *     near an Arc tick.
 *
 *   * `rpc.xlayer.tech` (X Layer's own canonical endpoint) and roughly a dozen
 *     other hosts — `ethereum-rpc.publicnode.com`, `eth.llamarpc.com`,
 *     `rpc.mevblocker.io`, `sepolia.gateway.tenderly.co` among them. These fail
 *     the TLS handshake from the machine this probe ran on (schannel
 *     SEC_E_INVALID_TOKEN / OpenSSL "wrong version number", over both IPv4 and
 *     IPv6, with and without SNI), which is a local network filter rather than a
 *     statement about the endpoint. They are UNVERIFIED, not known-dead. Re-probe
 *     from unfiltered network before concluding anything about them, and if they
 *     work there they belong in this file.
 *
 *   * `*.gateway.tatum.io` — answers, but the free tier is FIVE requests per
 *     minute and `eth_call` is paid-only. It would 429 in normal use.
 *
 *   * `rpc.flashbots.net` and `rpc.flashbots.net/fast` — REMOVED from Ethereum on
 *     2026-09-19, after shipping since 2026-09-10. They pass a chain-id and a
 *     `eth_blockNumber` check perfectly, which is how they got in, but they are
 *     TRANSACTION-SUBMISSION endpoints: `eth_call` answers **HTTP 403** and
 *     `eth_getCode` **HTTP 504**. Every read this SDK makes is an `eth_call` or an
 *     `eth_getCode`, so the entry could never have served one — it could only spend a
 *     fallback attempt and a 403 before the request reached a provider that works.
 *     The old probe recorded this as `eip1153: null` ("could not be asked"), which was
 *     accurate and was not loud enough. Lesson kept: an endpoint that cannot answer
 *     `eth_call` is not a read endpoint, whatever else it answers.
 *
 *   * `1rpc.io/linea` and `1rpc.io/sepolia` — REMOVED 2026-09-19. Both answer
 *     `-32001 "You've reached the usage limit for your current plan"` on a single
 *     cold request. Stated honestly: the probe itself hits 1rpc.io on several chains
 *     in one run, so this MAY be our own quota rather than a permanent state. They are
 *     dropped because verified replacements existed on both chains, not because
 *     1rpc.io is condemned. Re-probe from a fresh IP before concluding.
 *
 *   * `rpc.nodeflare.app/robinhood/public` — REMOVED 2026-09-19 (HTTP 403 to a plain
 *     `eth_chainId`). It was already last in the Robinhood list for answering 429
 *     "1 per 10s" per IP; it has now stopped answering at all from here.
 *
 *   * `plasma.drpc.org`, `stable-testnet.drpc.org` — answer
 *     `eth_chainId` and then HTTP 400 to `eth_blockNumber`. The same config-table
 *     shape dRPC shows for chains it does not really carry.
 *
 *   * Six `*.gateway.tenderly.co` hostnames (ink, monad, plasma, stable,
 *     stable-testnet, and the bare `gateway.tenderly.co`) failed the
 *     TLS handshake from the probing machine on 2026-09-19 — curl reports schannel
 *     `SEC_E_INVALID_TOKEN`, the same local-filter signature described above, and
 *     `base.gateway.tenderly.co` answered fine from the same machine in the same run.
 *     So this is NOT a statement that Tenderly is down. Where a verified replacement
 *     existed they were dropped for it (ink, monad, sepolia); where the chain would
 *     have got thinner they are kept, last, marked `unverified 2026-09-19`.
 */

export interface RpcEndpoint {
  readonly url: string
  /** Median of three eth_blockNumber round trips at probe time, in ms. Indicative only. */
  readonly latencyMs: number
  /**
   * Whether this endpoint could execute a TSTORE probe.
   * `null` means the endpoint blocks or rate-limits contract-creation `eth_call`, so
   * it could not be asked — which is NOT the same as the chain lacking EIP-1153.
   */
  readonly eip1153: boolean | null
}

export interface ChainRpcConfig {
  readonly chainId: number
  readonly name: string
  /** Whether the CHAIN supports EIP-1153, decided across endpoints, not from one. */
  readonly supportsEip1153: boolean
  readonly endpoints: readonly RpcEndpoint[]
}

export const CHAIN_RPCS = {
  ethereum: {
    chainId: 1,
    name: 'Ethereum',
    supportsEip1153: true,
    /* 2026-09-19: `rpc.flashbots.net` dropped — it 403s every `eth_call` (see the
       header); `gateway.tenderly.co/public/mainnet` dropped for two endpoints this run
       could measure. Nine Ethereum endpoints verified, all by genesis. */
    endpoints: [
      { url: 'https://1.rpc.thirdweb.com', latencyMs: 37, eip1153: true },
      { url: 'https://eth.drpc.org', latencyMs: 57, eip1153: true },
      { url: 'https://eth-mainnet.public.blastapi.io', latencyMs: 99, eip1153: true },
      { url: 'https://eth.rpc.blxrbdn.com', latencyMs: 101, eip1153: true },
      { url: 'https://0xrpc.io/eth', latencyMs: 185, eip1153: true },
    ],
  },
  base: {
    chainId: 8453,
    name: 'Base',
    supportsEip1153: true,
    endpoints: [
      { url: 'https://8453.rpc.thirdweb.com', latencyMs: 43, eip1153: true },
      { url: 'https://base.drpc.org', latencyMs: 46, eip1153: true },
      { url: 'https://base.gateway.tenderly.co', latencyMs: 96, eip1153: true },
      { url: 'https://base-mainnet.public.blastapi.io', latencyMs: 105, eip1153: true },
      { url: 'https://mainnet.base.org', latencyMs: 114, eip1153: true },
    ],
  },
  bsc: {
    chainId: 56,
    name: 'BNB Smart Chain',
    supportsEip1153: true,
    endpoints: [
      /* BSC is the one chain with real surplus: EIGHTEEN endpoints verified on
         2026-09-19, spread over eight operators, every one by genesis. The set below is
         unchanged — the dataseed mirrors (bnbchain/defibit/ninicoin 1-4) differ by
         single-digit milliseconds, which is noise, and churning the shipped list for
         noise costs review attention and buys nothing. */
      { url: 'https://56.rpc.thirdweb.com', latencyMs: 45, eip1153: true },
      { url: 'https://bsc-dataseed.bnbchain.org', latencyMs: 90, eip1153: true },
      { url: 'https://bsc-dataseed1.ninicoin.io', latencyMs: 93, eip1153: true },
      { url: 'https://bsc-dataseed1.defibit.io', latencyMs: 102, eip1153: true },
      { url: 'https://bsc-rpc.publicnode.com', latencyMs: 131, eip1153: true },
    ],
  },
  /**
   * Linea — Consensys zkEVM L2.
   *
   * EIP-1153 answered true on all six probed endpoints. Caveat worth carrying:
   * on a zkEVM, `eth_call` is executed by the node's EVM, not by the prover, so a
   * successful TSTORE `eth_call` is strong evidence rather than proof that a
   * PROVEN transaction supports it. `script/BackendGuard.sol` is the authoritative
   * check, because it runs on chain at deploy time. Do not skip it here.
   */
  linea: {
    chainId: 59144,
    name: 'Linea',
    supportsEip1153: true,
    /* FOUR on 2026-09-19, down from five: `1rpc.io/linea` now answers -32001 "usage
       limit for your current plan" on a cold request (see the header — that may be our
       own quota). Seven other candidates were tried; blockpi and omniatech 521,
       blastapi 403, decubate/onfinality/tenderly unreachable from here. Linea is now
       in THIN_ENDPOINT_CHAINS. */
    endpoints: [
      { url: 'https://linea.drpc.org', latencyMs: 61, eip1153: true },
      { url: 'https://59144.rpc.thirdweb.com', latencyMs: 106, eip1153: true },
      { url: 'https://rpc.linea.build', latencyMs: 118, eip1153: true },
      { url: 'https://linea-rpc.publicnode.com', latencyMs: 132, eip1153: true },
    ],
  },
  /**
   * Robinhood Chain — Robinhood's own L2. Five endpoints, five operators.
   *
   * All five answered `eth_chainId` with 4663, served `eth_blockNumber`, executed a
   * TSTORE probe, and matched the pinned genesis
   * `0xaad15f3d…09305c`, so both chain identity and EIP-1153 are confirmed per
   * endpoint rather than inferred from one.
   *
   * Changes on 2026-09-19:
   *   + `robinhood-rpc.publicnode.com` — new, from chains.json, fully verified.
   *   − `rpc.nodeflare.app/robinhood/public` — HTTP 403 to a plain `eth_chainId` now.
   *     It was already last for answering 429 "1 per 10s" per IP.
   *
   * Two candidates are still REJECTED rather than padded in:
   *   `lb.routeme.sh/rpc/evm/4663`  returned no usable JSON-RPC response at all.
   *   `robinhood.drpc.org`          used to answer eth_chainId with the correct 4663
   *                                 from a config table while rejecting eth_blockNumber
   *                                 and eth_call. On 2026-09-19 it PASSED everything
   *                                 (116 ms, genesis, TSTORE) — recorded, but not
   *                                 shipped on one clean run after a history of
   *                                 half-answers. Promote it on the next green probe.
   * The two `wss://` endpoints are out of scope: the transports here are http.
   *
   * Changes on 2026-10-11 (probe in apps/web/src/lib/browserRpc.ts's header):
   *   − `rpc.ordofi.network` — answers EVERY call (eth_call, eth_getLogs, 1 in 10 eth_blockNumber)
   *     with `-32005 "the network is busy, please try again in a moment"` as an HTTP 200, after
   *     ~2.7 s. It was second in this list, so every read that fell past the canonical endpoint
   *     paid it. Removed; re-probe before bringing it back.
   *   + `robinhood.drpc.org` — promoted on its second green probe: chain id, reads, eth_call at
   *     a pinned block (timestamp matches the header: the block tag is honoured), eth_getLogs over
   *     1,000 blocks, 10/10 on a burst; its free plan refuses log ranges over 10,000 blocks.
   */
  robinhood: {
    chainId: 4663,
    name: 'Robinhood Chain',
    supportsEip1153: true,
    /* Ordered for READS under load, not by single-request latency (2026-09-19). nodeflare was first on latency, but it answers 429 "1 per 10s"
       per IP and 403 to a batch, so a page's burst of reads failed there first and then fell through;
       a production build of /app made 59 of its 123 requests to it. The canonical endpoint leads
       even though three others measured faster. nodeflare, which used to be the last resort, is
       gone entirely — it 403s now. */
    endpoints: [
      { url: 'https://rpc.mainnet.chain.robinhood.com', latencyMs: 108, eip1153: true },
      { url: 'https://robinhood.rpc.blxrbdn.com', latencyMs: 81, eip1153: true },
      { url: 'https://robinhood.drpc.org', latencyMs: 125, eip1153: true },
      { url: 'https://robinhood-rpc.publicnode.com', latencyMs: 122, eip1153: true },
      { url: 'https://rpc-robinhood.blockmachine.io', latencyMs: 205, eip1153: true },
    ],
  },
  /**
   * Ink — Kraken's OP-Stack L2. Two of the five are Ink's own gel/qnd nodes.
   * 2026-09-19: `ink.gateway.tenderly.co` replaced by `ink-rpc.publicnode.com`, which
   * this run could actually measure (the Tenderly host failed the TLS handshake from
   * the probing machine — see the header; it is unverified, not known-dead).
   */
  ink: {
    chainId: 57073,
    name: 'Ink',
    supportsEip1153: true,
    endpoints: [
      { url: 'https://ink.drpc.org', latencyMs: 67, eip1153: true },
      { url: 'https://rpc-qnd.inkonchain.com', latencyMs: 115, eip1153: true },
      { url: 'https://rpc-gel.inkonchain.com', latencyMs: 166, eip1153: true },
      { url: 'https://57073.rpc.thirdweb.com', latencyMs: 183, eip1153: true },
      { url: 'https://ink-rpc.publicnode.com', latencyMs: 289, eip1153: true },
    ],
  },
  /**
   * X Layer — OKX's Polygon-CDK zkEVM. FOUR endpoints, not five.
   *
   * X Layer's own canonical endpoint `rpc.xlayer.tech` could not be reached from
   * the probing machine (TLS handshake refused before any HTTP; see the header).
   * It is unverified rather than dead, and if it answers from your network it
   * should be added. `xlayerrpc.okx.com` is OKX-operated and does answer, so the
   * operator is represented either way.
   *
   * Same zkEVM caveat as Linea: TSTORE succeeded in `eth_call` on three
   * independent endpoints, which is not the same as a proven transaction.
   * `BackendGuard` decides at deploy time.
   */
  xlayer: {
    chainId: 196,
    name: 'X Layer',
    supportsEip1153: true,
    endpoints: [
      { url: 'https://xlayer.drpc.org', latencyMs: 59, eip1153: true },
      { url: 'https://xlayerrpc.okx.com', latencyMs: 181, eip1153: true },
      { url: 'https://196.rpc.thirdweb.com', latencyMs: 205, eip1153: true },
      { url: 'https://api.zan.top/xlayer-mainnet', latencyMs: 234, eip1153: null },
    ],
  },
  /**
   * HyperEVM. **Its chain id, 999, is SHARED with Wanchain Testnet** — that is the
   * collision the genesis check exists for, and `scripts/probe-rpcs.mjs` keeps a
   * Wanchain node in its candidate list permanently so every run has to reject it.
   *
   * Only two of these serve block 0 at all (Hyperliquid's OWN canonical node answers
   * "invalid block height: 0" while serving block 1 happily), so the other three were
   * settled by the live cross-check instead — a settled block whose hash matches what
   * `rpc.purroofgroup.com` says about the same height. Both are recorded per endpoint
   * in `rpc-probe-results.json`.
   *
   * 2026-09-19: `rpc.hypurrscan.io` (141 ms, and it refuses every low block) replaced
   * by `hyperliquid-rpc.publicnode.com` (125 ms).
   */
  hyperevm: {
    chainId: 999,
    name: 'HyperEVM',
    supportsEip1153: true,
    endpoints: [
      { url: 'https://rpc.purroofgroup.com', latencyMs: 44, eip1153: true },
      { url: 'https://hyperliquid.drpc.org', latencyMs: 52, eip1153: true },
      { url: 'https://999.rpc.thirdweb.com', latencyMs: 103, eip1153: true },
      { url: 'https://hyperliquid-rpc.publicnode.com', latencyMs: 125, eip1153: true },
      { url: 'https://rpc.hyperliquid.xyz/evm', latencyMs: 141, eip1153: true },
    ],
  },
  monad: {
    chainId: 143,
    name: 'Monad',
    supportsEip1153: true,
    endpoints: [
      /* 2026-09-19: `monad.gateway.tenderly.co` (unreachable from the probing machine)
         replaced by `monad.drpc.org`, a new operator this run verified by cross-check —
         dRPC serves no low block on Monad, so genesis could not settle it. */
      { url: 'https://rpc.monad.xyz', latencyMs: 55, eip1153: true },
      { url: 'https://143.rpc.thirdweb.com', latencyMs: 70, eip1153: true },
      { url: 'https://rpc2.monad.xyz', latencyMs: 96, eip1153: true },
      { url: 'https://api.zan.top/monad-mainnet', latencyMs: 236, eip1153: null },
      { url: 'https://monad.drpc.org', latencyMs: 266, eip1153: null },
    ],
  },
  /**
   * Plasma — stablecoin-settlement L1. THREE endpoints; no fourth exists publicly.
   * Ten candidates tried on 2026-09-19: drpc 400, publicnode 404, blockpi 402, ankr
   * 403, onfinality 429, blastapi/stakely unreachable. chains.json knows exactly one.
   */
  plasma: {
    chainId: 9745,
    name: 'Plasma',
    supportsEip1153: true,
    endpoints: [
      { url: 'https://rpc.plasma.to', latencyMs: 96, eip1153: true },
      { url: 'https://9745.rpc.thirdweb.com', latencyMs: 119, eip1153: true },
      // unverified 2026-09-19 (TLS handshake refused from the probing machine, the
      // local-filter signature). Last measured 2026-09-10. Kept because dropping it
      // would leave Plasma on two.
      { url: 'https://plasma.gateway.tenderly.co', latencyMs: 115, eip1153: true },
    ],
  },
  /**
   * Stable — stablecoin-gas L1. FOUR endpoints.
   *
   * Stable has NO GENESIS PIN: every endpoint returns null for block 0, and for blocks
   * 1, 2, 10, 1_000, 100_000 and 1_000_000, while serving head-100_000 fine. They are
   * pruned nodes with a moving history floor, so no fixed low block can be pinned.
   * All three verified endpoints were settled by the live cross-check instead.
   */
  stable: {
    chainId: 988,
    name: 'Stable',
    supportsEip1153: true,
    endpoints: [
      { url: 'https://stable.drpc.org', latencyMs: 58, eip1153: true },
      { url: 'https://rpc.stable.xyz', latencyMs: 174, eip1153: true },
      { url: 'https://988.rpc.thirdweb.com', latencyMs: 203, eip1153: true },
      // unverified 2026-09-19, as Plasma's above. Last measured 2026-09-10.
      { url: 'https://stable.gateway.tenderly.co', latencyMs: 97, eip1153: true },
    ],
  },
  /**
   * Anubis Network — added as a deploy target 2026-09-24. Every line below was read
   * from the chain that day, not from its documentation.
   *
   * ONE endpoint, and it is the chain's own. No third-party provider carries 6714, so there is no
   * fallback: if this host is down, the chain is unreachable to us. That is a real availability
   * difference from every other entry here (all have 3-5) and it is why `gullycoreTransport`'s
   * fall-through has nothing to fall through to. It is also SLOW — 0.79-1.51 s over five samples,
   * against 59-289 ms elsewhere — which matters because the SDK transport's budget is 12 s and a
   * heavy eth_call can approach it.
   *
   * Explorer: https://browser.anubispace.org, the one the chain's own DEX links to (2026-11-05).
   *
   * UPDATE 2026-11-07: Gully Core release 3 is deployed here and the notes below on what is absent are history.
   * CreateX, Permit2 and Multicall3 now exist at Gully's own addresses (the deployment record; Multicall3 is
   * `multicall3For(6714)`, never the canonical address). eth_getLogs serves 5,000 blocks a request. gasDAI pays gas
   * only: see `GullyCoreDeployment.nativeValueTransfers`.
   *
   * Verified on chain 2026-09-24: chainId 0x1a3a, Geth/v1.0.1 fork, head 14,737,414, genesis
   * 0xa77aaf0bb685a9b0b1dfd6f1ad887e39315a578ae320758aadc24557893df1de, gasLimit 100,000,000,
   * difficulty 0x2 (PoA), 20-28 transactions per block, so it is in real use.
   *
   * NOT Nitro, checked rather than assumed: the EVM's `block.number` (14,737,437) and
   * `eth_blockNumber` (14,737,438) agree, so the two-clocks trap that makes every block-denominated
   * value wrong on Robinhood does NOT apply here.
   *
   * NATIVE IS 18 DECIMALS, settled by arithmetic rather than by the docs — the Arc lesson.
   * `baseFeePerGas` is 0 (EIP-1559 headers present but the base fee floors at zero), so the sum
   * uses `eth_gasPrice` = 12 gwei: a 21,000-gas transfer costs 2.52e14 base units, which is
   * 0.000252 at 18 decimals and 252,000,000 at 6. Only one of those is a transfer fee.
   *
   * ⚠ THE INFRASTRUCTURE GULLY CORE ASSUMES IS NOT THERE. Read 2026-09-24, all ABSENT: CreateX
   * (0xba5Ed0…ba5Ed), Multicall3 (0xcA11bde0…CA11), both Safe singletons and both Safe proxy
   * factories, the Arachnid deterministic deployment proxy (0x4e59b448…), and Permit2. The Safe
   * singleton factory (0x914d7Fec…) IS present, so Safe can be bootstrapped. Deploying Gully Core here
   * therefore costs more than a normal chain: without CreateX the mined addresses cannot be
   * reproduced and the same-address-on-every-chain claim breaks, and `permit2` and `weth` are
   * REQUIRED non-null fields in the deployments table. None of that is in this file's scope — an
   * endpoints entry is the RPC, not a deployment — but it is recorded here because this is where
   * somebody will look first.
   *
   * ⚠ AND THEY CANNOT SIMPLY BE DEPLOYED, which is the sharper half. All four of those
   * singletons reach the same address on every chain by replaying a PRESIGNED transaction that
   * carries no chainId in its signature. This RPC refuses those:
   *
   *     eth_sendRawTransaction -> "only replay-protected (EIP-155) transactions allowed over RPC"
   *
   * Probed 2026-09-24 with an unprotected legacy transaction from an unfunded throwaway key, so
   * nothing could execute and the rejection reason IS the result. Base answered the same probe
   * with "nonce too low" — i.e. it accepted the unprotected signature and failed on state — which
   * is the control that makes the Anubis answer mean what it says.
   *
   * THE DISTINCTION THAT DECIDES WHAT TO DO: this is a NODE POLICY, not a consensus rule. It is
   * geth's `--rpc.allow-unprotected-txs`, off by default since v1.10. So the chain itself can
   * almost certainly include such a transaction — it is this endpoint that will not forward one.
   * The cheap fix is to ask the Anubis operators either to deploy the standard singletons
   * themselves (most chains do) or to expose one node with the flag on. Deploying non-canonical
   * equivalents is the fallback, and it is the one that breaks the same-address-on-every-chain
   * claim, so it is a governance decision rather than an implementation detail.
   *
   * ✅ THE SAFE IS THE EXCEPTION, AND IT IS THE ONE THAT MATTERS. Computed 2026-09-24 from Safe's
   * real creation bytecode (@safe-global/safe-contracts), zero salt:
   *
   *     SafeProxyFactory 1.4.1 via 0x914d7Fec… -> 0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67  MATCH
   *     Safe singleton   1.4.1 via 0x914d7Fec… -> 0x41675C099F32341bf84BFc5382aF534df5C7461a  MATCH
   *     (the same two via the Arachnid proxy instead -> different addresses, no match)
   *
   * So the canonical Safe addresses come from the SAFE SINGLETON FACTORY, which is present on this
   * chain and is reached by an ORDINARY EIP-155 transaction. The unprotected-transaction refusal
   * does not block Safe at all: deploy 1.4.1 through that factory and the addresses ARE canonical.
   * A governance Safe is then a CREATE2 proxy of that factory, so the same owners, threshold and
   * saltNonce reproduce the same Safe address here as on any other chain with the canonical
   * factory, even though CreateX and Permit2 cannot keep theirs.
   *
   * Method note, because the first attempt was WRONG and looked right: computing this from
   * `codeHash` in @safe-global/safe-deployments reproduces NEITHER address. That field is the
   * RUNTIME hash — proved by matching it against keccak(eth_getCode) on Base — while CREATE2 needs
   * the CREATION-code hash. Those numbers were discarded rather than reported.
   *
   * ✅ PROVEN ON A FORK OF 6714, not argued (2026-09-24, `anvil --fork-url`):
   *
   *     SafeProxyFactory 1.4.1 -> 0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67  deployed, canonical
   *     Safe singleton   1.4.1 -> 0x41675C099F32341bf84BFc5382aF534df5C7461a  deployed, canonical
   *
   * Both through 0x914d7Fec with an ORDINARY transaction, both at the address Safe publishes.
   *
   * AND THE FACTORY IS NOT SAFE-SPECIFIC. Its 69 bytes are the classic minimal CREATE2 deployer
   * — calldata is a 32-byte salt followed by initcode — so it will deploy ANY contract
   * deterministically. That is the answer to "can we deploy on Anubis without the chain team":
   * yes, entirely. Permit2, Multicall3, a CreateX instance and every Gully Core contract can go
   * through it at addresses that are REPRODUCIBLE from (factory, salt, initcode) rather than
   * dependent on a deployer nonce that any interleaved transaction would shift.
   *
   * What is still NOT canonical there: CreateX, Permit2, Multicall3 and the Arachnid proxy, whose
   * published addresses all derive from the Arachnid route. Ours would live at Gully Core-specific
   * addresses. The user-visible consequence is multi-chain Launchpad identity —
   * `readPadAcrossChains` compares addresses — and that is a product decision, not a blocker.
   */
  anubis: {
    chainId: 6714,
    name: 'Anubis Network',
    supportsEip1153: true,
    endpoints: [
      // TSTORE/TLOAD returned 1 from eth_call on 2026-09-24, so the DEFAULT build profile
      // (cancun / EIP-1153) is the right one here. As with Linea and X Layer, an eth_call is not
      // the same as a proven transaction; BackendGuard decides at deploy time.
      { url: 'https://rpc.anubispace.org', latencyMs: 803, eip1153: true },
    ],
  },
  /**
   * Kinetiq Elysium (99901), an Orbit L3 on HyperEVM with HYPE as gas, MAINNET. Approved as a Gully
   * Core + Gully Multisig target 2026-11-08; release 3 deployed by Gully Labs 2026-11-09.
   * ONE endpoint, Kinetiq's own (2026-11-09; the community relays answered 429 / 502 that day). Measured from a Gully server 2026-11-09 17:20 UTC:
   * eth_chainId 0x1863d, batches, CORS *, sends reach the node; eth_getLogs with an address or topic filter answers any
   * block span, the whole chain included, and is capped by result count ("logs count limit exceeded (10000)", -32005);
   * without a filter 2,000 blocks. The TSTORE probe has not been run here (`eip1153: null`); the chain is Nitro-based and
   * the deployment used the default build, which BackendGuard confirmed at deploy time. In SINGLE_ENDPOINT_CHAINS:
   * supply a keyed node through `GULLYCORE_RPC_99901` for redundancy.
   * Explorer: https://elysium.kinetiq.xyz/explorer (Kinetiq, Blockscout; pages /address/<a>, /tx/<h>). L3 blocks ~0.1 s; the EVM's block.number is the HyperEVM block (~0.985 s), see records/chain-99901.json.
   */
  elysium: {
    chainId: 99901,
    name: 'Kinetiq Elysium',
    supportsEip1153: true,
    endpoints: [
      { url: 'https://rpc.elysium.kinetiq.xyz', latencyMs: 200, eip1153: null },
    ],
  },
  /**
   * Arc — Circle's USDC-gas L1, MAINNET. Added 2026-10-07 (decision the same day: Arc
   * mainnet is a deploy target). Every entry below was probed that day from this machine:
   * `eth_chainId` = 5042, three `eth_blockNumber` round trips (median shown), genesis
   * `0x09944e07412986bb417fd0006c89ffb71ee523d68ce2017ec2dabc944c42edad` read from block 0 on
   * each (the hash `scripts/probe-rpcs.mjs` pins), and the TSTORE+TLOAD creation call returned 1.
   * Seven hostnames answered; one per operator is listed (Blockdaemon, 1,236 ms, and dRPC's
   * second hostname `rpc.drpc.mainnet.arc.io` are left out). Native is USDC at 18 decimals with a
   * 6-decimal ERC-20 face at `0x3600…0000` and NO wrapped USDC (docs.arc.io, contract addresses) —
   * the decimals split recorded for Arc Testnet in `docs/chain-certification.md` §3 applies here
   * unchanged, and no pool may be priced until a quote face is chosen.
   */
  arc: {
    chainId: 5042,
    name: 'Arc',
    supportsEip1153: true,
    endpoints: [
      { url: 'https://5042.rpc.thirdweb.com', latencyMs: 565, eip1153: true },
      { url: 'https://rpc.beamrpc.com', latencyMs: 606, eip1153: true },
      { url: 'https://arc.drpc.org', latencyMs: 635, eip1153: true },
      { url: 'https://rpc.mainnet.arc.io', latencyMs: 671, eip1153: true },
      { url: 'https://rpc.quicknode.mainnet.arc.io', latencyMs: 843, eip1153: true },
    ],
  },
  /**
   * Cronos — Cronos Labs' EVM L1 (Cosmos SDK + Ethermint), chain id 25 per
   * ethereum-lists/chains `eip155-25.json`. Added 2026-10-07 (decided the same day).
   * Probed from this machine that day: `eth_chainId` = 25, three `eth_blockNumber` round trips
   * (median shown), genesis `0xa7f4e603aa51239a15e0a3fafb15c6e4c6d6f2c39c55770330efd2fa5afc12a9`
   * read from block 0 on four of the five (publicnode serves no block 0 and was settled by its
   * head agreeing with the others within 16 blocks), and TSTORE+TLOAD returned 1 on all five.
   * `cronos.blockpi.network/v1/rpc/public` answered HTTP 521 and is not listed. `1rpc.io/cro`
   * answered cleanly here; the header's note about 1rpc.io plan limits on other chains stands.
   * Latency is 400-1,200 ms from here, several times the other chains'.
   */
  cronos: {
    chainId: 25,
    name: 'Cronos',
    supportsEip1153: true,
    endpoints: [
      { url: 'https://cronos.drpc.org', latencyMs: 425, eip1153: true },
      { url: 'https://evm.cronos.org', latencyMs: 506, eip1153: true },
      { url: 'https://cronos-evm-rpc.publicnode.com', latencyMs: 528, eip1153: true },
      { url: 'https://1rpc.io/cro', latencyMs: 554, eip1153: true },
      { url: 'https://25.rpc.thirdweb.com', latencyMs: 1206, eip1153: true },
    ],
  },
  sepolia: {
    chainId: 11155111,
    name: 'Ethereum Sepolia',
    supportsEip1153: true,
    /* Tenderly's public gateway was kept-but-last on 2026-09-19 morning, on the theory that its
       failure was local. It is now GONE, because the re-probe found two endpoints that answer:
       a production /app had been spending 9 requests on it before reaching a working provider,
       and "kept in case it is local" is only worth a slot when nothing verified can fill it.
       `1rpc.io/sepolia` went with it (plan usage limit). */
    endpoints: [
      { url: 'https://11155111.rpc.thirdweb.com', latencyMs: 46, eip1153: true },
      { url: 'https://ethereum-sepolia-rpc.publicnode.com', latencyMs: 131, eip1153: true },
      { url: 'https://0xrpc.io/sep', latencyMs: 194, eip1153: true },
      { url: 'https://rpc.sepolia.ethpandaops.io', latencyMs: 207, eip1153: true },
      /* `xrpc.cl/sepolia` REMOVED 2026-09-26: it answers eth_getLogs over the release range with an
         EMPTY list and no error, where publicnode and ethpandaops return all 10 Initialize logs for
         the same query. A wrong answer is worse than a refusal: the failover only moves on after an
         error, so whenever this endpoint was reached, pools and swaps silently read as zero (the
         dashboard's "no swaps yet" and /pools' "no pools" on a chain that has both). */
    ],
  },
  /* Monad Testnet (10143) was REMOVED on 2026-09-24. Monad MAINNET (143) stays; only the testnet is gone. Its RPC certification survives
     in `docs/chain-certification.md` as a measurement that was paid for, but it is not a target and
     nothing should read it back in. */
  /**
   * Stable Testnet. THREE endpoints, and no genesis pin for the same reason as Stable:
   * the nodes serve no block older than roughly head-100_000, so identity here rests
   * on the live cross-check.
   */
  /* Base Sepolia (84532): Gully Core's testnet from 2026-10-15 (Ethereum Sepolia reprices contract creation
     ~7.6x and caps a transaction at ~16.7 M gas). Probed 2026-10-15 by scripts/probe-rpcs.mjs: genesis
     0x0dcc9e08…34e4 on publicnode, thirdweb and nodies; the other two by the cross-check (sepolia.base.org prunes
     history below block 46.5 M). eth_getLogs range per request differs a lot: thirdweb and publicnode answered
     500 blocks (99 WETH logs, the same on both), sepolia.base.org caps at 200, nodies at 50, drpc's free plan
     refused. Dropped: tenderly and meowrpc (fetch failed), blockpi (503), onfinality (429), 1rpc (400). */
  baseSepolia: {
    chainId: 84532,
    name: 'Base Sepolia',
    supportsEip1153: true,
    endpoints: [
      { url: 'https://84532.rpc.thirdweb.com', latencyMs: 48, eip1153: true },
      { url: 'https://base-sepolia.drpc.org', latencyMs: 65, eip1153: true },
      { url: 'https://sepolia.base.org', latencyMs: 104, eip1153: true },
      { url: 'https://base-sepolia-public.nodies.app', latencyMs: 108, eip1153: true },
      { url: 'https://base-sepolia-rpc.publicnode.com', latencyMs: 162, eip1153: true },
    ],
  },
  /* Gully Chain Testnet (485590): an Arbitrum Orbit L3 (Nitro v3.12.1, ArbOS 51) settling to Arbitrum Sepolia, ETH gas.
     Gully Core's testnet target from 2026-10-25. Read
     2026-10-25 from testnet-rpc.gullychain.xyz: eth_chainId 485590, genesis 0x32f58173…9ea8, TSTORE+TLOAD and PUSH0
     pass. ONE public endpoint exists (Gully's own; a keyed provider is the operator's, via GULLYCORE_RPC_485590), so
     the chain is in SINGLE_ENDPOINT_CHAINS. eth_getLogs serves at most 30,000 blocks per request (LOG_RANGE_LIMITS). CLOCK: Nitro, so the EVM's block.number is the PARENT chain's
     (Arbitrum Sepolia's, which is itself Ethereum Sepolia's: 11,992,816 while eth_blockNumber read 189);
     ArbSys(0x64).arbBlockNumber() returns the L3 block. Blocks are produced only when transactions arrive. */
  gullyTestnet: {
    chainId: 485590,
    name: 'Gully Chain Testnet',
    supportsEip1153: true,
    endpoints: [
      { url: 'https://testnet-rpc.gullychain.xyz', latencyMs: 190, eip1153: true },
    ],
  },
  stableTestnet: {
    chainId: 2201,
    name: 'Stable Testnet',
    supportsEip1153: true,
    endpoints: [
      { url: 'https://rpc.testnet.stable.xyz', latencyMs: 176, eip1153: true },
      { url: 'https://2201.rpc.thirdweb.com', latencyMs: 255, eip1153: true },
      // unverified 2026-09-19 (local TLS filter). Last measured 2026-09-10. Kept
      // because the alternative is two.
      { url: 'https://stable-testnet.gateway.tenderly.co', latencyMs: 103, eip1153: true },
    ],
  },
  /**
   * Arc Testnet — Circle's USDC-gas L1, testnet.
   *
   * Nine hostnames answer, but they front only FIVE operators: Circle, dRPC,
   * QuickNode, Blockdaemon and thirdweb. Circle publishes each partner on both
   * `*.arc.io` (its docs) and `*.arc.network` (ethereum-lists), and dRPC answers
   * on `arc-testnet.drpc.org` as well. One hostname per operator is listed here,
   * because two names in front of one node is not failover — it is one outage
   * counted twice.
   */
  arcTestnet: {
    chainId: 5042002,
    name: 'Arc Testnet',
    supportsEip1153: true,
    /* All NINE hostnames answered on 2026-09-19 and all nine matched the pinned genesis;
       the five below are one per operator, re-ordered by this run's latency. */
    endpoints: [
      { url: 'https://5042002.rpc.thirdweb.com', latencyMs: 42, eip1153: true },
      { url: 'https://rpc.quicknode.testnet.arc.io', latencyMs: 61, eip1153: true },
      { url: 'https://rpc.drpc.testnet.arc.io', latencyMs: 65, eip1153: true },
      { url: 'https://rpc.testnet.arc.io', latencyMs: 70, eip1153: true },
      { url: 'https://rpc.blockdaemon.testnet.arc.io', latencyMs: 171, eip1153: true },
    ],
  },
} as const satisfies Record<string, ChainRpcConfig>

export type ChainKey = keyof typeof CHAIN_RPCS

/**
 * Chains with only ONE verified public endpoint, where a fallback transport cannot
 * fail over at all.
 *
 * Still EMPTY after the 2026-09-19 re-probe: every target chain has at least three
 * independent public endpoints (the thinnest are Plasma and Stable Testnet, on three).
 * It was not empty before — Monad, Plasma, Stable, Sepolia, Stable Testnet and Arc
 * Testnet each had exactly one on 2026-09-09.
 *
 * Kept as an exported, empty list rather than deleted, because it is the assertion
 * a deploy check should make, and it will stop being empty the moment a chain is
 * added ahead of its provider ecosystem.
 *
 * IT STOPPED BEING EMPTY ON 2026-09-24, exactly as that sentence predicted. Anubis
 * Network (6714) is carried by its own node and nothing else — no third-party provider
 * serves 6714 — so `gullycoreTransport` has nothing to fall through to and the chain is
 * unreachable to us whenever that one host is. Treat a self-hosted or paid node via
 * `GULLYCORE_RPC_6714` as a REQUIREMENT there, not an optimisation.
 */
export const SINGLE_ENDPOINT_CHAINS: readonly ChainKey[] = ['anubis', 'gullyTestnet', 'elysium']

/**
 * Chains carrying FEWER than the five-endpoint target.
 *
 * These are not failures of the probe: no fifth public endpoint was found for them.
 * They still fail over, but with less headroom, and on a rate-limited day they will
 * degrade first. On these chains treat a paid or self-hosted node supplied through
 * `GULLYCORE_RPC_<chainId>` as a requirement rather than an optimisation.
 *
 * This list MUST name exactly the chains whose `endpoints` array is shorter than
 * `ENDPOINT_TARGET` — `transport.ts` reports `belowTarget` as the AND of the two, so a
 * chain missing from here is silently reported as healthy. `linea` joined on 2026-09-19
 * (four, after `1rpc.io/linea` hit its plan limit). Monad Testnet was removed 2026-09-24.
 */
export const THIN_ENDPOINT_CHAINS: readonly ChainKey[] = [
  // One endpoint, so it is in SINGLE_ENDPOINT_CHAINS as well — the two lists are not
  // exclusive, and `transport.ts` reports `belowTarget` from this one.
  'anubis',
  'linea',
  'xlayer',
  'plasma',
  'stable',
  'stableTestnet',
  // 4 since 2026-09-26: xrpc.cl/sepolia removed for answering getLogs with an empty list.
  'sepolia',
  // One endpoint (Gully's own), 2026-10-25: also in SINGLE_ENDPOINT_CHAINS.
  'gullyTestnet',
  // One endpoint (Kinetiq's own), 2026-11-09: also in SINGLE_ENDPOINT_CHAINS.
  'elysium',
]

/** The number of public endpoints this file aims to carry per chain. */
export const ENDPOINT_TARGET = 5

const BY_ID = new Map<number, ChainRpcConfig>(
  Object.values(CHAIN_RPCS).map((c) => [c.chainId, c]),
)

export function chainById(chainId: number): ChainRpcConfig | undefined {
  return BY_ID.get(chainId)
}

/**
 * Ordered endpoint URLs for a chain, private providers first.
 *
 * A keyed provider is always preferable to a public one: public endpoints rate-limit,
 * lag, and disappear. Supply yours via env (`GULLYCORE_RPC_<CHAINID>`, comma-separated for
 * several) and they are tried before the public list, which then acts as a safety net.
 *
 * THE PUBLIC SAFETY NET IS NOT ALWAYS WANTED. A caller-supplied RPC that points at a LOCAL or
 * private-network node (a devnet on 127.0.0.1, an anvil fork, a node on 10.x / 192.168.x) is used
 * ALONE by default: behind it the public list is the REAL chain, so a failed local request — a
 * signed `eth_sendRawTransaction` among them — would silently fall through to mainnet. Pass
 * `publicFallback` to decide explicitly either way (`false` for any exclusive endpoint, `true` to
 * keep the net behind a local node on purpose).
 *
 * @param chainId target chain
 * @param env process environment, injected so this stays testable and browser-safe
 * @param opts `publicFallback`: append the chain's public endpoints behind the supplied ones.
 *        Default: true, unless a supplied endpoint is local / private-network (see `isLocalRpcUrl`).
 */
export function resolveEndpoints(
  chainId: number,
  env: Record<string, string | undefined> = {},
  opts: { readonly publicFallback?: boolean } = {},
): string[] {
  const priv = suppliedEndpoints(chainId, env)
  const fallback = opts.publicFallback ?? !priv.some(isLocalRpcUrl)
  if (priv.length > 0 && !fallback) return [...new Set(priv)]

  const pub = chainById(chainId)?.endpoints.map((e) => e.url) ?? []

  // de-dupe while preserving order, private first
  return [...new Set([...priv, ...pub])]
}

/** The endpoints a caller supplied for `chainId` (`GULLYCORE_RPC_<chainId>`, comma-separated). */
function suppliedEndpoints(chainId: number, env: Record<string, string | undefined>): string[] {
  return (env[`GULLYCORE_RPC_${chainId}`] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * True for an RPC URL that names a local or private-network host: `localhost` / `*.localhost`,
 * loopback (127.0.0.0/8, ::1), 0.0.0.0, RFC 1918 (10/8, 172.16/12, 192.168/16), link-local
 * (169.254/16), `*.local` and `host.docker.internal`. Such a node is a devnet or a fork, never the
 * chain itself, and must not have the real chain's public endpoints behind it.
 */
export function isLocalRpcUrl(url: string): boolean {
  let host: string
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '')
  } catch {
    return false
  }
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host === 'host.docker.internal') return true
  if (host === '::1' || host === '0.0.0.0') return true
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (m === null) return false
  const a = Number(m[1])
  const b = Number(m[2])
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)
}

/**
 * Public endpoints VERIFIED to answer a whole-history `eth_getLogs` in ONE request,
 * per chain. Each URL must also appear in that chain's `CHAIN_RPCS` list; this table
 * only REORDERS, it never adds an endpoint.
 *
 * WHY A SEPARATE ORDERING, RATHER THAN MOVING THESE FIRST IN `CHAIN_RPCS`. The two
 * orderings answer different questions. `CHAIN_RPCS` is ranked by `eth_blockNumber`
 * latency, which is what an `eth_call` cares about. A log scan cares about something
 * the latency probe never measured: the maximum block span an endpoint will serve.
 * Where the fastest endpoints refuse a wide range, a fallback transport with
 * `rank: false` restarts at endpoint 1 on EVERY request and pays a refusal or a 429
 * at each of them before reaching the one that would have served the range at once.
 * Reordering reads globally to fix logs would trade a measured read order for an
 * unmeasured one; routing only `eth_getLogs` through this list fixes logs and leaves
 * reads exactly as probed.
 *
 * An endpoint that answers SHORT without an error is the dangerous kind, because the
 * failover only moves on after an error. Re-probe before adding anything.
 */
export const LOG_RANGE_ENDPOINTS: Readonly<Record<number, readonly string[]>> = {
  /* HyperEVM, 2026-09-19. Hyperliquid's own RPC
     serves "up to 50 blocks in query range" and rate-limited a 10,000-block query (-32005).
     rpc.purroofgroup.com served 100,000-block windows (100,001 -> "query exceeds max block
     range 100000"); rpc.hypurrscan.io 1,000 ("Response is too big" on a busy token);
     hyperliquid.drpc.org refused 1,000 with HTTP 400. purroofgroup is the only public
     endpoint serving more than 1,000-block windows, so it goes first for logs. */
  999: ["https://rpc.purroofgroup.com"],
  /* BNB, 2026-10-10/11: 56.rpc.thirdweb.com is the only public endpoint that serves logs at all
     (the bsc-dataseed endpoints refuse every range with -32005 "limit exceeded"). Already first
     by latency, so this row pins the order rather than changing it. */
  56: ["https://56.rpc.thirdweb.com"],
  /* Robinhood, 2026-10-10/11: the official RPC served 10,000,000-block windows and refused
     20,000,000 ("only 10000000 are allowed"); the others refuse past 10,000. Already first. */
  4663: ["https://rpc.mainnet.chain.robinhood.com"],
  /* Base, 2026-10-11: 8453.rpc.thirdweb.com serves 1,000 blocks back to the deployment block;
     base.drpc.org (free plan) and blastapi refuse any useful range, mainnet.base.org answered
     "request limit reached". Already first by latency. */
  8453: ["https://8453.rpc.thirdweb.com"],
  /* Anubis, 2026-11-07: the chain's only public endpoint. Old ranges answered too. */
  6714: ["https://rpc.anubispace.org"],
  /* Kinetiq Elysium, 2026-11-09: Kinetiq's own RPC, the chain's only endpoint here (address-filtered logs over any span,
     capped at 10,000 results). */
  99901: ["https://rpc.elysium.kinetiq.xyz"],
};

/**
 * The largest `eth_getLogs` block span a public endpoint is VERIFIED to serve, by URL.
 *
 * Measured, never inferred: each number is the span the endpoint answered with the next
 * larger request refused. An endpoint that is not here has no verified limit, which is NOT
 * the same as no limit: `hyperliquid.drpc.org` refused 1,000 blocks (HTTP 400) and
 * `rpc.hypurrscan.io` 1,000 ("Response is too big"), and neither was walked down to a span
 * that holds, so neither is listed. A scanner that reaches an unlisted endpoint keeps its
 * own chunk and halves on refusal.
 *
 * It lives here, beside `LOG_RANGE_ENDPOINTS`, because it is a fact about the chain's public
 * endpoints and both off-chain services size their log chunks from it (the API's indexer
 * through `logSpanBoundsFor`). The keeper does not depend on this package and carries its own
 * copy of the same numbers in `packages/keeper/src/config.ts` — keep the two equal.
 */
export const LOG_RANGE_LIMITS: Readonly<Record<string, number>> = {
  /* HyperEVM, 2026-09-19: 100,001 blocks answered
     "query exceeds max block range 100000"; Hyperliquid's own RPC documents "up to 50 blocks in
     query range" and answered -32005 "rate limited" to a 10,000-block query. */
  "https://rpc.purroofgroup.com": 100_000,
  "https://rpc.hyperliquid.xyz/evm": 50,
  /* BNB and Base, 2026-10-11: thirdweb answered 1,001 blocks and refused 1,002 with -32005
     "Maximum allowed number of requested blocks is 1000"; 1,000 is its stated limit. */
  "https://56.rpc.thirdweb.com": 1_000,
  "https://8453.rpc.thirdweb.com": 1_000,
  /* Robinhood, 2026-10-11: the official RPC answered 10,000,002 blocks and refused 20,000,000
     with -32602 "only 10000000 are allowed"; 10,000,000 is its stated limit. */
  "https://rpc.mainnet.chain.robinhood.com": 10_000_000,
  /* Gully Chain Testnet, 2026-10-25: blocks 0..29,999 passed the range check and 0..30,000 answered -32012 "getLogs
     request exceeded max allowed range" (details.maxAllowedRange 30000); 30,000 is its stated limit. */
  "https://testnet-rpc.gullychain.xyz": 30_000,
  /* Anubis, 2026-11-07: a span of 5,000 answered and 5,001 returned -32000 "exceed maximum block range: 5000". */
  "https://rpc.anubispace.org": 5_000,
  /* Kinetiq Elysium, Kinetiq's own RPC, 2026-11-09 17:20 UTC (from a Gully server): with an address filter 10,000 / 100,000 /
     1,000,000 / 3,000,000 blocks and 0..head (3,389,318) all answered; the limit is the RESULT COUNT ("logs count limit
     exceeded (10000)", an error, never a short list), so a busy span is refused and the scan halves. Without an address the
     span is capped at 2,000 (-32602 "block range ... exceeds maximum of 2000"); every Gully Core log read names addresses. */
  "https://rpc.elysium.kinetiq.xyz": 3_000_000,
};

/**
 * The verified `eth_getLogs` span bounds of a chain's log endpoints, in blocks: `max` is the
 * widest limit in `LOG_RANGE_LIMITS` among `resolveLogEndpoints(chainId, env)` and `min` the
 * narrowest, or `undefined` when none of them has a verified limit (a scanner then keeps its
 * own defaults).
 *
 * `max` is the CEILING for a scan that halves on refusal: the endpoint verified for the widest
 * window is asked first, and a narrower one behind it is reached only after the first refused
 * or failed. `min` is the FLOOR such a scan must be allowed to reach, or the narrowest endpoint
 * can never serve it when the wide one is down. A supplied private endpoint
 * (`GULLYCORE_RPC_<chainId>`) has no verified limit and does not change the answer.
 */
export function logSpanBoundsFor(
  chainId: number,
  env: Record<string, string | undefined> = {},
): { readonly max: number; readonly min: number } | undefined {
  let max: number | undefined;
  let min: number | undefined;
  for (const url of resolveLogEndpoints(chainId, env)) {
    const limit = LOG_RANGE_LIMITS[url];
    if (limit === undefined) continue;
    if (max === undefined || limit > max) max = limit;
    if (min === undefined || limit < min) min = limit;
  }
  return max === undefined || min === undefined ? undefined : { max, min };
}

/**
 * Ordered endpoint URLs for `eth_getLogs` on a chain: private providers first (as in
 * `resolveEndpoints`), then the endpoints verified for full-range logs in
 * `LOG_RANGE_ENDPOINTS`, then every other public endpoint in its probed order.
 *
 * The SET of URLs is exactly `resolveEndpoints(chainId, env)`; only the order differs.
 *
 * @param chainId target chain
 * @param env process environment, injected so this stays testable and browser-safe
 */
export function resolveLogEndpoints(
  chainId: number,
  env: Record<string, string | undefined> = {},
  opts: { readonly publicFallback?: boolean } = {},
): string[] {
  const all = resolveEndpoints(chainId, env, opts);
  const priv = (env[`GULLYCORE_RPC_${chainId}`] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const verified = (LOG_RANGE_ENDPOINTS[chainId] ?? []).filter((u) => all.includes(u));
  return [...new Set([...priv, ...verified, ...all])];
}
