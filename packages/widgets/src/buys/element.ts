// SPDX-License-Identifier: MIT
/**
 * `<gully-buys>`: real-time buys of a Gully Core token on any web page, with no
 * framework, no key and no Telegram group.
 *
 * ```html
 * <script src="https://gullycore.xyz/buys.js" defer></script>
 * <gully-buys chain="8453" token="0x…" layout="feed"></gully-buys>
 * ```
 *
 * Attributes (see `./model.ts` `parseBuysAttributes` for every default):
 *   chain    chain id (8453, 56, 4663, 99901, 6714, 485590)
 *   token    the token's address (every Gully Core pool of it on the chain), or
 *   pool     one pool id (bytes32)
 *   layout   `feed` (card list, default) | `strip` (one bar across the page) | `toast` (corner pop-ups)
 *   sells    present: sells shown too (red); absent: buys only
 *   theme    `dark` (default) | `light` | `auto`
 *   step     dollars per emoji (default 10), emoji (default 🟢), min (dollars; smaller trades hidden)
 *   limit    alerts kept (feed 10, strip 12); corner (toast: bottom-right …)
 *   rpc      an RPC URL instead of Gully RPC's keyless project; api, site overrides
 *
 * Renders plain DOM into a shadow root; every colour is a `--gully-buys-*`
 * custom property a host may override. Animations stop under
 * `prefers-reduced-motion: reduce`.
 */

import { alertView, BUYS_TAG, parseBuysAttributes, tokenPageUrl, type AlertView, type BuysAttributes } from "./model.js";
import { BuysSource, type BuysState } from "./source.js";

const ElementBase: typeof HTMLElement = typeof HTMLElement === "undefined" ? (class {} as unknown as typeof HTMLElement) : HTMLElement;

/* Gully Core kit (2026-11-08): orange #FD7716, ink #0F0E0B, cream #FEF4E3; the site theme's dark and light tokens
   (gully-ops sites/_shared/gully-core-theme/tokens.mjs), AA-checked there. Buy = the theme's ok green, sell = warn. */
export const BUYS_CSS = `
:host { display: block; font-family: var(--gully-buys-font, Inter, system-ui, -apple-system, "Segoe UI", sans-serif); font-size: 14px; line-height: 1.35; color-scheme: dark; }
:host([hidden]) { display: none; }
:host([layout="toast"]) { display: contents; }
.gb {
  --bg: var(--gully-buys-bg, #0F0E0B);
  --surface: var(--gully-buys-surface, #211E17);
  --surface-2: var(--gully-buys-surface-2, #2C281F);
  --fg: var(--gully-buys-fg, #FEF4E3);
  --fg-2: var(--gully-buys-fg-2, #E6DAC3);
  --muted: var(--gully-buys-muted, #BDB29C);
  --line: var(--gully-buys-line, #3A362B);
  --edge: var(--gully-buys-edge, #8A7F69);
  --accent: var(--gully-buys-accent, #FD7716);
  --accent-text: var(--gully-buys-accent-text, #FF8A3D);
  --buy: var(--gully-buys-buy, #5BC26A);
  --sell: var(--gully-buys-sell, #FF9F5A);
  --radius: var(--gully-buys-radius, 12px);
  --mono: var(--gully-buys-font-mono, "JetBrains Mono", ui-monospace, Menlo, monospace);
  color: var(--fg); background: var(--bg); box-sizing: border-box;
}
.gb[data-theme="light"] {
  --bg: var(--gully-buys-bg, #FEF4E3);
  --surface: var(--gully-buys-surface, #FFFAF0);
  --surface-2: var(--gully-buys-surface-2, #F6E8CD);
  --fg: var(--gully-buys-fg, #0F0E0B);
  --fg-2: var(--gully-buys-fg-2, #3B372D);
  --muted: var(--gully-buys-muted, #6A6254);
  --line: var(--gully-buys-line, #E4D3B2);
  --edge: var(--gully-buys-edge, #0F0E0B);
  --accent-text: var(--gully-buys-accent-text, #A63F00);
  --buy: var(--gully-buys-buy, #2F7D32);
  --sell: var(--gully-buys-sell, #B54B00);
  color-scheme: light;
}
.gb *, .gb *::before, .gb *::after { box-sizing: inherit; }
.gb a { color: inherit; text-decoration: none; }
.gb a:hover { text-decoration: underline; }
.gb a:focus-visible, .gb button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.gb button { font: inherit; color: inherit; background: none; border: 0; cursor: pointer; }

/* header: mark, symbol, chain, live chip */
.gb-head { display: flex; align-items: center; gap: 10px; min-width: 0; }
.gb-mark { width: 28px; height: 28px; border-radius: 50%; background: var(--surface-2); flex: none; object-fit: cover; display: grid; place-items: center; font-weight: 700; font-size: 12px; color: var(--accent-text); overflow: hidden; }
.gb-mark img { width: 100%; height: 100%; object-fit: cover; display: block; }
.gb-title { display: flex; flex-direction: column; min-width: 0; }
.gb-sym { font-weight: 700; letter-spacing: .01em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.gb-sym a { color: var(--fg); }
.gb-chain { color: var(--muted); font-size: 12px; white-space: nowrap; }
.gb-live { margin-left: auto; display: inline-flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); flex: none; }
.gb-live i { width: 8px; height: 8px; border-radius: 50%; background: var(--buy); display: inline-block; }
.gb-live[data-on="1"] i { animation: gb-pulse 1.6s ease-in-out infinite; }
.gb-live[data-on="0"] i { background: var(--edge); }
@keyframes gb-pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: .45; transform: scale(.7); } }

/* one alert */
.gb-row { display: grid; grid-template-columns: auto 1fr auto; gap: 4px 10px; align-items: center; padding: 10px 12px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); min-width: 0; }
.gb-row[data-side="sell"] { border-color: color-mix(in srgb, var(--sell) 40%, var(--line)); }
.gb-row[data-fresh="1"] { animation: gb-in .45s ease-out both; }
.gb-emo { grid-column: 1 / -1; font-size: 15px; line-height: 1.2; letter-spacing: -1px; word-break: break-all; }
.gb-side { font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--buy); }
.gb-row[data-side="sell"] .gb-side { color: var(--sell); }
.gb-money { font-weight: 700; font-size: 16px; font-variant-numeric: tabular-nums; }
.gb-money small { font-weight: 500; font-size: 12px; color: var(--muted); margin-left: 6px; }
.gb-unpriced { font-weight: 700; font-size: 14px; }
.gb-unpriced small { font-weight: 500; font-size: 12px; color: var(--muted); margin-left: 6px; }
.gb-sub { grid-column: 2; color: var(--fg-2); font-size: 13px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gb-meta { grid-column: 3; grid-row: 2 / 4; display: flex; flex-direction: column; align-items: flex-end; gap: 4px; color: var(--muted); font-size: 12px; white-space: nowrap; }
.gb-meta a { color: var(--accent-text); font-weight: 600; }
@keyframes gb-in { from { opacity: 0; transform: translateY(-6px); } to { opacity: 1; transform: none; } }

/* feed */
.gb-feed { display: grid; gap: 10px; padding: 14px; border: 1px solid var(--line); border-radius: calc(var(--radius) + 4px); }
.gb-list { display: grid; gap: 8px; }
.gb-empty { padding: 18px 12px; color: var(--muted); border: 1px dashed var(--line); border-radius: var(--radius); text-align: center; }
.gb-foot { display: flex; align-items: center; gap: 8px; color: var(--muted); font-size: 11px; flex-wrap: wrap; }
.gb-foot a { color: var(--accent-text); font-weight: 600; }
.gb-foot .sp { flex: 1; }

/* strip: one bar, chips scroll sideways */
.gb-strip { display: flex; align-items: center; gap: 12px; padding: 8px 12px; border-bottom: 1px solid var(--line); min-width: 0; }
.gb-strip .gb-head { flex: none; max-width: 40%; }
.gb-strip .gb-mark { width: 22px; height: 22px; }
.gb-strip .gb-chain { display: none; }
.gb-track { flex: 1; display: flex; gap: 8px; overflow-x: auto; scrollbar-width: none; min-width: 0; -webkit-overflow-scrolling: touch; }
.gb-track::-webkit-scrollbar { display: none; }
.gb-chip { flex: none; display: inline-flex; align-items: center; gap: 8px; padding: 5px 10px; border: 1px solid var(--line); border-radius: 999px; background: var(--surface); font-size: 13px; white-space: nowrap; color: var(--fg); }
.gb-chip[data-side="sell"] { border-color: color-mix(in srgb, var(--sell) 40%, var(--line)); }
.gb-chip[data-fresh="1"] { animation: gb-chip-in .5s ease-out both; }
.gb-chip b { font-variant-numeric: tabular-nums; }
.gb-chip small { color: var(--muted); }
.gb-chip .gb-emo { grid-column: auto; font-size: 13px; letter-spacing: -1px; max-width: 120px; overflow: hidden; text-overflow: clip; white-space: nowrap; }
.gb-chip a { color: var(--accent-text); font-weight: 600; }
@keyframes gb-chip-in { from { opacity: 0; transform: translateX(-10px); } to { opacity: 1; transform: none; } }
.gb-strip .gb-live { margin-left: 0; }

/* toast: fixed corner stack */
.gb-toasts { position: fixed; z-index: 2147483000; display: grid; gap: 8px; width: min(360px, calc(100vw - 24px)); pointer-events: none; }
.gb-toasts[data-corner="bottom-right"] { right: 12px; bottom: 12px; }
.gb-toasts[data-corner="bottom-left"] { left: 12px; bottom: 12px; }
.gb-toasts[data-corner="top-right"] { right: 12px; top: 12px; }
.gb-toasts[data-corner="top-left"] { left: 12px; top: 12px; }
.gb-toast { pointer-events: auto; display: grid; grid-template-columns: auto 1fr auto; gap: 4px 10px; align-items: center; padding: 10px 12px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); color: var(--fg); box-shadow: 0 10px 30px rgba(0,0,0,.35); animation: gb-toast-in .4s ease-out both; }
.gb-toast .gb-mark { width: 24px; height: 24px; grid-row: 1 / 3; }
.gb-toast .gb-emo { grid-column: 2 / -1; }
.gb-toast .gb-sub { grid-column: 2 / -1; }
.gb-toast .gb-x { grid-column: 3; grid-row: 1; color: var(--muted); font-size: 16px; line-height: 1; padding: 2px 4px; }
.gb-toast .gb-meta { grid-column: 2 / -1; grid-row: 4; flex-direction: row; align-items: center; justify-content: flex-start; }
.gb-toast[data-side="sell"] { border-color: color-mix(in srgb, var(--sell) 40%, var(--line)); }
@keyframes gb-toast-in { from { opacity: 0; transform: translateY(12px) scale(.98); } to { opacity: 1; transform: none; } }

.gb-msg { padding: 12px 14px; border: 1px solid var(--line); border-radius: var(--radius); color: var(--fg-2); background: var(--surface); display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.gb-msg[data-tone="error"] { border-color: color-mix(in srgb, var(--sell) 40%, var(--line)); }
.gb-retry { color: var(--accent-text); font-weight: 600; text-decoration: underline; }
.gb-brand { display: inline-flex; align-items: center; gap: 6px; }
.gb-brand img { width: 16px; height: 16px; border-radius: 4px; }

@media (prefers-reduced-motion: reduce) {
  .gb-row, .gb-chip, .gb-toast, .gb-live i { animation: none !important; }
  .gb-track { scroll-behavior: auto; }
}
`;

const CHAIN_NAMES: Readonly<Record<number, string>> = { 8453: "Base", 56: "BNB Chain", 4663: "Robinhood Chain", 99901: "Kinetiq Elysium", 6714: "Anubis", 485590: "Gully Chain Testnet" };

const TOAST_MS = 9_000;
const MAX_TOASTS = 3;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls !== undefined) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function link(href: string, text: string, cls?: string): HTMLAnchorElement {
  const a = el("a", cls, text);
  a.href = href;
  a.target = "_blank";
  a.rel = "noopener";
  return a;
}

export class GullyBuysElement extends ElementBase {
  static get observedAttributes(): readonly string[] {
    return ["chain", "token", "pool", "layout", "sells", "theme", "step", "emoji", "min", "limit", "rpc", "api", "site", "corner", "poll"];
  }

  #shadow: ShadowRoot | null = null;
  #root: HTMLDivElement | null = null;
  #source: BuysSource | null = null;
  #unsub: (() => void) | null = null;
  #attrs: BuysAttributes | null = null;
  #attrKey = "";
  #tick: ReturnType<typeof setInterval> | null = null;
  #toastShown = new Set<string>();
  #toasts: { key: string; node: HTMLElement; until: number }[] = [];
  #media: MediaQueryList | null = null;
  #onMedia: (() => void) | null = null;
  #state: BuysState | null = null;

  connectedCallback(): void {
    if (this.#shadow === null) {
      this.#shadow = this.attachShadow({ mode: "open" });
      const style = document.createElement("style");
      style.textContent = BUYS_CSS;
      this.#shadow.appendChild(style);
      this.#root = document.createElement("div");
      this.#shadow.appendChild(this.#root);
    }
    this.#start();
    this.#tick = setInterval(() => this.#render(), 10_000);
    if (typeof matchMedia === "function") {
      this.#media = matchMedia("(prefers-color-scheme: light)");
      this.#onMedia = () => this.#render();
      this.#media.addEventListener("change", this.#onMedia);
    }
  }

  disconnectedCallback(): void {
    this.#unsub?.();
    this.#unsub = null;
    this.#source?.stop();
    if (this.#tick !== null) clearInterval(this.#tick);
    this.#tick = null;
    if (this.#media !== null && this.#onMedia !== null) this.#media.removeEventListener("change", this.#onMedia);
  }

  attributeChangedCallback(): void {
    if (this.#shadow !== null && this.isConnected) this.#start();
  }

  /** The source behind this element (tests, hosts that want the state). */
  get source(): BuysSource | null {
    return this.#source;
  }

  #start(): void {
    const parsed = parseBuysAttributes((n) => this.getAttribute(n));
    if (!parsed.ok) {
      this.#attrs = null;
      this.#source?.stop();
      this.#message("error", parsed.message, false);
      return;
    }
    const key = JSON.stringify(parsed.attrs);
    if (key === this.#attrKey && this.#source !== null) {
      this.#render();
      return;
    }
    this.#attrKey = key;
    this.#attrs = parsed.attrs;
    this.#toastShown.clear();
    this.#unsub?.();
    if (this.#source === null) this.#source = new BuysSource(parsed.attrs);
    else this.#source.reset(parsed.attrs);
    this.#unsub = this.#source.subscribe((s) => {
      this.#state = s;
      this.#render();
    });
    if (this.#source.state.status === "loading" && this.#source.state.polls === 0 && this.#source.state.tape.length === 0) this.#source.start();
  }

  #theme(): "dark" | "light" {
    const t = this.#attrs?.theme ?? "dark";
    if (t === "auto") return this.#media?.matches === true ? "light" : "dark";
    return t;
  }

  #message(tone: "error" | "none", text: string, retry: boolean): void {
    const root = this.#root;
    if (root === null) return;
    const box = el("div", "gb");
    box.dataset["theme"] = this.#theme();
    const m = el("div", "gb-msg", text);
    m.dataset["tone"] = tone;
    m.setAttribute("role", tone === "error" ? "alert" : "status");
    if (retry) {
      const b = el("button", "gb-retry", "Retry");
      b.type = "button";
      b.addEventListener("click", () => this.#source?.start());
      m.appendChild(b);
    }
    box.appendChild(m);
    root.replaceChildren(box);
  }

  #views(s: BuysState, a: BuysAttributes): AlertView[] {
    const now = this.#source?.now ?? Math.floor(Date.now() / 1000);
    const out: AlertView[] = [];
    for (const t of s.tape) {
      if (!a.sells && t.trade.side === "sell") continue;
      const v = alertView(t, s.pools, s.usdPerQuote, { chainId: a.chainId, stepUsd: a.stepUsd, emoji: a.emoji, now });
      if (v === null) continue;
      if (a.minUsd > 0 && v.usdValue !== null && v.usdValue < a.minUsd) continue;
      out.push(v);
      if (out.length >= a.limit) break;
    }
    return out;
  }

  #mark(s: BuysState): HTMLElement {
    const m = el("span", "gb-mark");
    const t = s.token;
    if (t?.logoUrl) {
      const img = document.createElement("img");
      img.src = t.logoUrl;
      img.alt = "";
      img.width = 28;
      img.height = 28;
      img.loading = "lazy";
      img.addEventListener("error", () => {
        img.remove();
        m.textContent = (t.symbol[0] ?? "?").toUpperCase();
      });
      m.appendChild(img);
    } else m.textContent = (t?.symbol[0] ?? "?").toUpperCase();
    return m;
  }

  #head(s: BuysState, a: BuysAttributes): HTMLElement {
    const h = el("div", "gb-head");
    h.appendChild(this.#mark(s));
    const title = el("div", "gb-title");
    const sym = el("span", "gb-sym");
    const tokenAddr = s.token?.address ?? (a.target.kind === "token" ? a.target.token : null);
    if (tokenAddr !== null) sym.appendChild(link(tokenPageUrl(a.site, a.chainId, tokenAddr), `$${s.token?.symbol ?? "token"} buys`));
    else sym.textContent = `${s.token?.symbol ?? "Token"} buys`;
    title.appendChild(sym);
    title.appendChild(el("span", "gb-chain", `${s.token?.name ?? ""}${s.token?.name ? " · " : ""}${CHAIN_NAMES[a.chainId] ?? `chain ${a.chainId}`}`));
    h.appendChild(title);
    const live = el("span", "gb-live");
    const on = s.status === "ready" && s.stalled < 2;
    live.dataset["on"] = on ? "1" : "0";
    live.appendChild(el("i"));
    live.appendChild(document.createTextNode(s.status !== "ready" ? "Loading" : on ? "Live" : "Paused"));
    live.title = on ? `Swap logs read from the chain every ${a.pollSeconds} s` : "The last read failed; showing the last good tape";
    h.appendChild(live);
    return h;
  }

  #row(v: AlertView, s: BuysState, kind: "row" | "toast"): HTMLElement {
    const r = el("div", kind === "toast" ? "gb-toast" : "gb-row");
    r.dataset["side"] = v.side;
    if (s.fresh.has(v.key)) r.dataset["fresh"] = "1";
    if (kind === "toast") r.appendChild(this.#mark(s));
    r.appendChild(el("div", "gb-emo", v.emojis));
    r.appendChild(el("span", "gb-side", v.side === "buy" ? "Buy" : "Sell"));
    if (v.usd !== null) {
      const money = el("span", "gb-money", v.usd);
      money.appendChild(el("small", undefined, v.quoteText));
      r.appendChild(money);
    } else {
      const money = el("span", "gb-unpriced", v.quoteText);
      money.appendChild(el("small", undefined, "unpriced"));
      r.appendChild(money);
    }
    r.appendChild(el("div", "gb-sub", `${v.side === "buy" ? "bought" : "sold"} ${v.baseText}`));
    const meta = el("div", "gb-meta");
    meta.appendChild(el("span", undefined, v.ago));
    if (v.txUrl !== null) meta.appendChild(link(v.txUrl, "tx ↗"));
    r.appendChild(meta);
    return r;
  }

  #chip(v: AlertView, s: BuysState): HTMLElement {
    const c = el("span", "gb-chip");
    c.dataset["side"] = v.side;
    if (s.fresh.has(v.key)) c.dataset["fresh"] = "1";
    c.appendChild(el("span", "gb-emo", v.emojis));
    c.appendChild(el("b", undefined, v.usd ?? v.quoteText));
    c.appendChild(el("small", undefined, v.usd === null ? "unpriced" : v.quoteText));
    c.appendChild(el("small", undefined, v.ago));
    if (v.txUrl !== null) c.appendChild(link(v.txUrl, "tx ↗"));
    return c;
  }

  #foot(s: BuysState, a: BuysAttributes): HTMLElement {
    const f = el("div", "gb-foot");
    const brand = el("span", "gb-brand");
    brand.appendChild(document.createTextNode("Live from Gully Core"));
    f.appendChild(brand);
    if (s.priceNote !== "") f.appendChild(el("span", undefined, s.priceNote));
    f.appendChild(el("span", "sp"));
    f.appendChild(link("https://docs.gullycore.xyz/buy-alerts/", "Add buy alerts to your site →"));
    void a;
    return f;
  }

  #render(): void {
    const root = this.#root;
    const a = this.#attrs;
    const s = this.#state;
    if (root === null || a === null || s === null) return;
    if (s.status === "error") return this.#message("error", s.message ?? "Couldn't load buys.", true);
    const box = el("div", "gb");
    box.dataset["theme"] = this.#theme();
    box.dataset["layout"] = a.layout;
    const views = this.#views(s, a);
    if (a.layout === "strip") {
      const strip = el("div", "gb-strip");
      strip.setAttribute("role", "region");
      strip.setAttribute("aria-label", `${s.token?.symbol ?? "token"} buys`);
      strip.appendChild(this.#head(s, a));
      const track = el("div", "gb-track");
      if (s.status === "loading") track.appendChild(el("span", "gb-chip", "Reading the pool…"));
      else if (views.length === 0) track.appendChild(el("span", "gb-chip", a.sells ? "No trades yet" : "No buys yet"));
      for (const v of views) track.appendChild(this.#chip(v, s));
      strip.appendChild(track);
      box.appendChild(strip);
    } else if (a.layout === "toast") {
      const stack = el("div", "gb-toasts");
      stack.dataset["corner"] = a.corner;
      stack.setAttribute("role", "status");
      stack.setAttribute("aria-live", "polite");
      this.#syncToasts(views, s);
      for (const t of this.#toasts) stack.appendChild(t.node);
      box.appendChild(stack);
    } else {
      const feed = el("section", "gb-feed");
      feed.setAttribute("aria-label", `${s.token?.symbol ?? "token"} buys`);
      feed.appendChild(this.#head(s, a));
      const list = el("div", "gb-list");
      if (s.status === "loading") list.appendChild(el("div", "gb-empty", "Reading the pool's trades…"));
      else if (views.length === 0) list.appendChild(el("div", "gb-empty", a.sells ? "No trades yet. The first one shows here within a few seconds of its block." : "No buys yet. The first one shows here within a few seconds of its block."));
      for (const v of views) list.appendChild(this.#row(v, s, "row"));
      feed.appendChild(list);
      feed.appendChild(this.#foot(s, a));
      box.appendChild(feed);
    }
    root.replaceChildren(box);
  }

  /** Toasts: the newest alert on first load, then every fresh one; each stays TOAST_MS, at most MAX_TOASTS at once. */
  #syncToasts(views: readonly AlertView[], s: BuysState): void {
    const now = Date.now();
    this.#toasts = this.#toasts.filter((t) => t.until > now);
    const candidates = views.filter((v) => !this.#toastShown.has(v.key) && (s.fresh.has(v.key) || this.#toastShown.size === 0));
    for (const v of candidates.slice(0, MAX_TOASTS)) {
      this.#toastShown.add(v.key);
      const node = this.#row(v, s, "toast");
      const x = el("button", "gb-x", "×");
      x.type = "button";
      x.setAttribute("aria-label", "Dismiss");
      x.addEventListener("click", () => {
        this.#toasts = this.#toasts.filter((t) => t.key !== v.key);
        node.remove();
      });
      node.appendChild(x);
      this.#toasts.unshift({ key: v.key, node, until: now + TOAST_MS });
      /* only the newest alert of the first load becomes a toast: the rest were seen before the page opened */
      if (this.#toastShown.size === 1 && !s.fresh.has(v.key)) for (const o of views) this.#toastShown.add(o.key);
    }
    this.#toasts = this.#toasts.slice(0, MAX_TOASTS);
    if (this.#toasts.length > 0) setTimeout(() => this.#render(), TOAST_MS + 50);
  }
}

/** Registers `<gully-buys>`. Safe to call twice. */
export function defineGullyBuys(): void {
  if (typeof customElements === "undefined") return;
  if (customElements.get(BUYS_TAG) === undefined) customElements.define(BUYS_TAG, GullyBuysElement);
}
