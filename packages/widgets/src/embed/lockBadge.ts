// SPDX-License-Identifier: MIT
/**
 * `<gullycore-lock-badge>`: the lock badge for any web page, with no framework.
 *
 * ```html
 * <script src="https://<gullycore site>/embed/gullycore-embed.js" defer></script>
 * <gullycore-lock-badge chain="999" pool="0x…"></gullycore-lock-badge>
 * <gullycore-lock-badge chain="999" token="0x…" site="https://<gullycore site>"></gullycore-lock-badge>
 * ```
 *
 * Attributes:
 *   chain      chain id (required); must be a chain in the SDK's address book
 *   pool       a pool id (bytes32), or
 *   token      a token address
 *   pool-type  `cl` (default) or `bin`
 *   rpc        an RPC URL to read through instead of the chain's public RPCs
 *   site       the Gully Core site origin; with it the badge links to its public
 *              lock page (`/locks/pool/<id>?net=<chain>`); without it, no link
 *   theme      `dark` (default) | `light` | `system`
 *   refresh    seconds between re-reads (default 60, 0 = never)
 *
 * It reads the chain directly, through the MIT SDK, with the same readers as
 * `LocksBadge`, and renders plain DOM into a shadow root: no React, no wallet,
 * no writes. The words are only what was read (see `../locks/embedModel.ts`).
 */

import { createClient, http, isAddress, type Address, type Hex, type PublicClient } from "viem";
import { getBlock, getBlockNumber, getLogs, readContract } from "viem/actions";
import { getDeployment } from "@gullylabs/core-sdk/deployments";
import { gullycoreTransport } from "@gullylabs/core-sdk";

import { fetchPoolLocks, fetchTokenLocks, type PoolLocksData, type TokenLocksData } from "../locks/fetch.js";
import { poolEmbedView, tokenEmbedView } from "../locks/embedModel.js";
import { advanceChainNow, formatCountdown, lockPageUrl, type LocksBadgeView } from "../locks/model.js";
import { scanClLpLockerTokenIds } from "../locks/scan.js";
import { WIDGET_CSS } from "../styles/css.js";

export const LOCK_BADGE_TAG = "gullycore-lock-badge";

/* Gully Core chrome in the brand kit's colours and type: on dark grounds Gully Core emerald
   and Success ("locked"); on light grounds deep green and the widget's darker
   green, which keep 4.5:1 for text. Inter / Mono first, then the host's
   own stack when Plex is not loaded. A host overrides with --gullycore-brand-*. */
const HOST_CSS = `
:host { display: inline-block; max-width: 100%; vertical-align: middle; }
.gullycore-embed-badge[data-gullycore-theme] {
  --gullycore-accent: var(--gullycore-brand-accent, #005B39);
  --gullycore-font: var(--gullycore-brand-font, Inter, system-ui, -apple-system, "Segoe UI", sans-serif);
  --gullycore-font-mono: var(--gullycore-brand-font-mono, ui-monospace, monospace);
}
.gullycore-embed-badge[data-gullycore-theme="dark"] { --gullycore-accent: var(--gullycore-brand-accent, #00C878); --gullycore-success: var(--gullycore-brand-success, #10B981); }
@media (prefers-color-scheme: dark) {
  .gullycore-embed-badge[data-gullycore-theme="system"] { --gullycore-accent: var(--gullycore-brand-accent, #00C878); --gullycore-success: var(--gullycore-brand-success, #10B981); }
}
:host([hidden]) { display: none; }
.gullycore-embed-badge { gap: 4px; }
.gullycore-embed-badge__retry { font: inherit; font-size: 11px; background: none; border: 0; padding: 0; color: var(--gullycore-accent); cursor: pointer; text-decoration: underline; }
`;

const ElementBase: typeof HTMLElement = typeof HTMLElement === "undefined" ? (class {} as unknown as typeof HTMLElement) : HTMLElement;

/** CL LP-locker ids per chain, scanned once per page load and shared by every badge. */
const lpIdCache = new Map<string, Promise<bigint[]>>();

type Parsed =
  | { readonly ok: false; readonly message: string }
  | {
      readonly ok: true;
      readonly chainId: number;
      readonly target: { readonly kind: "pool"; readonly poolId: Hex; readonly poolType: "cl" | "bin" } | { readonly kind: "token"; readonly token: Address };
    };

/** Pure: the element's attributes, validated. */
export function parseLockBadgeAttributes(get: (name: string) => string | null): Parsed {
  const chain = Number(get("chain") ?? "");
  if (!Number.isInteger(chain) || chain <= 0) return { ok: false, message: "Set the chain attribute to a chain id, e.g. chain=\"999\"." };
  const pool = get("pool");
  const token = get("token");
  if (pool !== null && pool !== "") {
    if (!/^0x[0-9a-fA-F]{64}$/.test(pool)) return { ok: false, message: "The pool attribute is not a 32-byte pool id." };
    const t = (get("pool-type") ?? "cl").toLowerCase();
    return { ok: true, chainId: chain, target: { kind: "pool", poolId: pool as Hex, poolType: t === "bin" ? "bin" : "cl" } };
  }
  if (token !== null && token !== "") {
    if (!isAddress(token, { strict: false })) return { ok: false, message: "The token attribute is not an address." };
    return { ok: true, chainId: chain, target: { kind: "token", token: token as Address } };
  }
  return { ok: false, message: "Set a pool or a token attribute." };
}

type State =
  | { readonly k: "message"; readonly tone: "none" | "error"; readonly text: string; readonly retry: boolean }
  | { readonly k: "loading" }
  | { readonly k: "ready"; readonly view: LocksBadgeView; readonly chainNow: bigint; readonly readAtMs: number; readonly href: string | null };

export class GullyCoreLockBadgeElement extends ElementBase {
  static get observedAttributes(): readonly string[] {
    return ["chain", "pool", "token", "pool-type", "rpc", "site", "theme", "refresh"];
  }

  #shadow: ShadowRoot | null = null;
  #root: HTMLDivElement | null = null;
  #state: State = { k: "loading" };
  #read = 0;
  #refreshTimer: ReturnType<typeof setInterval> | null = null;
  #tickTimer: ReturnType<typeof setInterval> | null = null;
  #client: { key: string; client: PublicClient } | null = null;

  connectedCallback(): void {
    if (this.#shadow === null) {
      this.#shadow = this.attachShadow({ mode: "open" });
      const style = document.createElement("style");
      style.textContent = `${WIDGET_CSS}\n${HOST_CSS}`;
      this.#shadow.appendChild(style);
      this.#root = document.createElement("div");
      this.#shadow.appendChild(this.#root);
    }
    this.#start();
  }

  disconnectedCallback(): void {
    this.#stopTimers();
    this.#read += 1;
  }

  attributeChangedCallback(): void {
    if (this.#shadow !== null && this.isConnected) this.#start();
  }

  #stopTimers(): void {
    if (this.#refreshTimer !== null) clearInterval(this.#refreshTimer);
    if (this.#tickTimer !== null) clearInterval(this.#tickTimer);
    this.#refreshTimer = null;
    this.#tickTimer = null;
  }

  #start(): void {
    this.#stopTimers();
    this.#state = { k: "loading" };
    this.#render();
    void this.#load();
    const refresh = Number(this.getAttribute("refresh") ?? "60");
    if (Number.isFinite(refresh) && refresh > 0) this.#refreshTimer = setInterval(() => void this.#load(), Math.max(15, refresh) * 1000);
    this.#tickTimer = setInterval(() => {
      if (this.#state.k === "ready" && this.#state.view.countdownTo !== null) this.#render();
    }, 1000);
  }

  #clientFor(chainId: number): PublicClient {
    const rpc = this.getAttribute("rpc");
    const key = `${chainId}|${rpc ?? ""}`;
    if (this.#client?.key === key) return this.#client.client;
    const transport = rpc !== null && rpc.trim() !== "" ? http(rpc.trim()) : gullycoreTransport(chainId);
    /* Only the four actions the lock readers call: a full public client would
       carry signature verification and every other action into the bundle. */
    const base = createClient({ transport });
    const client = {
      ...base,
      readContract: (args: unknown) => readContract(base, args as never),
      getBlock: (args?: unknown) => getBlock(base, args as never),
      getBlockNumber: (args?: unknown) => getBlockNumber(base, args as never),
      getLogs: (args?: unknown) => getLogs(base, args as never),
    } as unknown as PublicClient;
    this.#client = { key, client };
    return client;
  }

  async #load(): Promise<void> {
    const id = ++this.#read;
    const parsed = parseLockBadgeAttributes((n) => this.getAttribute(n));
    if (!parsed.ok) return this.#set(id, { k: "message", tone: "error", text: parsed.message, retry: false });
    const d = getDeployment(parsed.chainId);
    if (d === undefined) return this.#set(id, { k: "message", tone: "none", text: `Gully Core does not support chain ${parsed.chainId}.`, retry: false });
    const native = { symbol: d.nativeCurrency.symbol, decimals: d.nativeCurrency.decimals };
    const clLocker = d.launchpadV2.clLPLocker;
    const binLocker = d.launchpadV2.binLPLocker;
    const t = parsed.target;
    const hasLocker = t.kind === "pool" ? (t.poolType === "bin" ? binLocker !== null : d.positionLock !== null || clLocker !== null) : d.tokenLock !== null || clLocker !== null || binLocker !== null;
    if (!hasLocker) return this.#set(id, { k: "message", tone: "none", text: `Gully Core locks are coming soon on ${d.name}.`, retry: false });
    try {
      const client = this.#clientFor(parsed.chainId);
      let ids: bigint[] = [];
      if (clLocker !== null && !(t.kind === "pool" && t.poolType === "bin")) {
        const k = `${parsed.chainId}|${clLocker.toLowerCase()}|${this.getAttribute("rpc") ?? ""}`;
        let p = lpIdCache.get(k);
        if (p === undefined) {
          p = scanClLpLockerTokenIds(client, clLocker, { fromBlock: d.deployedAtBlock });
          lpIdCache.set(k, p);
          p.catch(() => lpIdCache.delete(k));
        }
        ids = await p;
      }
      const lp = {
        ...(clLocker !== null ? { lpLocker: clLocker, lpLockerTokenIds: ids } : {}),
        ...(binLocker !== null ? { binLpLocker: binLocker } : {}),
      };
      let data: PoolLocksData | TokenLocksData;
      let view: LocksBadgeView;
      if (t.kind === "pool") {
        const pd = await fetchPoolLocks(client, d.positionLock, t.poolId, { native, lp: { ...lp, poolType: t.poolType } });
        data = pd;
        view = poolEmbedView(pd);
      } else {
        const td = await fetchTokenLocks(client, d.tokenLock, t.token, { native, lp });
        data = td;
        view = tokenEmbedView(td);
      }
      const site = this.getAttribute("site");
      const href =
        site === null || site.trim() === ""
          ? null
          : lockPageUrl(site.trim(), t.kind === "pool" ? { kind: "pool", poolId: t.poolId } : { kind: "token", token: t.token }, { pathBase: "/locks", query: `net=${d.key}` });
      this.#set(id, { k: "ready", view, chainNow: data.chainNow, readAtMs: data.readAtMs, href });
    } catch {
      /* A failed refresh keeps the last good read on screen. */
      if (this.#state.k === "ready") return;
      this.#set(id, { k: "message", tone: "error", text: "Couldn't load locks. Try again.", retry: true });
    }
  }

  #set(id: number, state: State): void {
    if (id !== this.#read) return;
    this.#state = state;
    this.#render();
  }

  #render(): void {
    const root = this.#root;
    if (root === null) return;
    const theme = this.getAttribute("theme");
    const s = this.#state;
    const box = document.createElement("div");
    box.className = "gullycore-widget gullycore-locks gullycore-locks--badge gullycore-embed-badge";
    box.dataset["gullycoreTheme"] = theme === "light" || theme === "system" ? theme : "dark";
    const line = (cls: string, text: string, tone?: string): HTMLParagraphElement => {
      const p = document.createElement("p");
      p.className = cls;
      if (tone !== undefined) {
        const dot = document.createElement("span");
        dot.className = `gullycore-locks__dot gullycore-locks__dot--${tone}`;
        dot.setAttribute("aria-hidden", "true");
        p.appendChild(dot);
      }
      const span = document.createElement("span");
      span.textContent = text;
      p.appendChild(span);
      return p;
    };
    if (s.k === "loading") {
      box.appendChild(line("gullycore-locks__headline gullycore-locks__headline--muted", "Loading locks…"));
      box.setAttribute("role", "status");
    } else if (s.k === "message") {
      const p = line(`gullycore-locks__headline${s.tone === "error" ? " gullycore-locks__headline--error" : ""}`, s.text, s.tone === "none" ? "none" : undefined);
      box.appendChild(p);
      if (s.retry) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "gullycore-embed-badge__retry";
        b.textContent = "Retry";
        b.addEventListener("click", () => this.#start());
        box.appendChild(b);
      }
    } else {
      const headline = line("gullycore-locks__headline", s.view.headline, s.view.tone);
      headline.title = s.view.detail ?? "";
      box.dataset["tone"] = s.view.tone;
      box.appendChild(headline);
      if (s.view.countdownTo !== null) {
        const now = advanceChainNow(s.chainNow, s.readAtMs, Date.now());
        const p = document.createElement("p");
        p.className = "gullycore-locks__countdown";
        const timer = document.createElement("span");
        timer.className = "gullycore-locks__timer";
        timer.textContent = formatCountdown(s.view.countdownTo - now);
        p.append(timer, ` to ${s.view.countdownLabel ?? "the next unlock"}`);
        box.appendChild(p);
      }
    }
    const brand = document.createElement("p");
    brand.className = "gullycore-brand";
    const site = this.getAttribute("site");
    if (site !== null && site.trim() !== "") {
      /* The Gully Core icon (brand kit, 02-icon/gully-core-icon-orange.svg), as shipped, from the Gully Core site:
         never redrawn, 24 px. It carries its own orange ground, so one file reads on a dark and a light host.
         The width and height attributes are the file's viewBox and only reserve the shape; the CSS decides how
         big it draws. */
      const mark = document.createElement("img");
      mark.className = "gullycore-brand__mark";
      mark.src = `${site.trim().replace(/\/+$/, "")}/kit/gully-core-kit/02-icon/gully-core-icon-orange.svg`;
      mark.width = 220;
      mark.height = 220;
      mark.alt = "Gully Core";
      brand.appendChild(mark);
    }
    const src = document.createElement("span");
    src.textContent = "Live from the chain";
    brand.appendChild(src);
    const spacer = document.createElement("span");
    spacer.className = "gullycore-brand__spacer";
    brand.appendChild(spacer);
    if (s.k === "ready" && s.href !== null) {
      const a = document.createElement("a");
      a.className = "gullycore-locks__link";
      a.href = s.href;
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = "Lock details →";
      brand.appendChild(a);
    }
    box.appendChild(brand);
    root.replaceChildren(box);
  }
}

/** Registers `<gullycore-lock-badge>`. Safe to call twice. */
export function defineGullyCoreLockBadge(): void {
  if (typeof customElements === "undefined") return;
  if (customElements.get(LOCK_BADGE_TAG) === undefined) customElements.define(LOCK_BADGE_TAG, GullyCoreLockBadgeElement);
}
