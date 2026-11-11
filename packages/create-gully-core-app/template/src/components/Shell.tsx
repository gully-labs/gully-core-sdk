// SPDX-License-Identifier: MIT
/**
 * The app frame: brand, navigation, wallet button, chain chip, footer.
 *
 * Two rules from the house style are enforced here rather than left to each
 * screen:
 *
 *   * **Static copy must not state anything that can change on chain.** The
 *     header chip shows the live block height and the chain the app is
 *     configured for; it does not claim a pair, a fee or a status that a
 *     screen below might contradict.
 *   * **Navigation follows the feature flags.** A disabled feature is absent
 *     from the nav AND unroutable, so a link can never lead to a screen the
 *     tenant switched off.
 *
 * The bar gives way in steps rather than wrapping: every item wears an icon
 * with its label; when the labelled row no longer fits beside the chain chip
 * and the wallet (measured, so a long brand name or a connected wallet is
 * accounted for), the labels drop to icons with a tooltip, still the accessible
 * name; when even that does not fit, and always at 720px and under, a menu
 * button opens a sheet that holds the whole nav, traps focus, closes on Escape
 * and returns focus to the button.
 */

import { GullyCoreConnectButton } from "@gullylabs/core-connect";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { NavLink, useLocation } from "react-router-dom";

import { resolveConfig } from "../config/resolve";
import { publicClient } from "../lib/client";
import { useAsync } from "../lib/useAsync";
import { NavIcon, type NavIconName } from "./NavIcons";

interface NavItem {
  readonly to: string;
  readonly label: string;
  readonly icon: NavIconName;
}

function navItems(): NavItem[] {
  const cfg = resolveConfig();
  const items: NavItem[] = [];
  if (cfg.features.swap) items.push({ to: "/swap", label: "Swap", icon: "swap" });
  if (cfg.features.pools) items.push({ to: "/pools", label: "Pools", icon: "pools" });
  if (cfg.features.launchpad) items.push({ to: "/launch", label: "Launch", icon: "launch" });
  if (cfg.features.locks) items.push({ to: "/locks", label: "Locks", icon: "locks" });
  if (cfg.features.airdrops) items.push({ to: "/airdrops", label: "Airdrops", icon: "airdrops" });
  if (cfg.features.splits) items.push({ to: "/splits", label: "Splits", icon: "splits" });
  items.push({ to: "/fees", label: "Fees", icon: "fees" });
  return items;
}

function BlockChip(): ReactElement {
  const cfg = resolveConfig();
  const { state } = useAsync(() => publicClient().getBlockNumber(), []);

  return (
    <span className="chip" title={`Chain ${cfg.core.chainId}`}>
      <span className={`dot ${state.status === "ready" ? "dot-live" : "dot-idle"}`} />
      {cfg.core.name}
      {state.status === "ready" ? (
        <span className="chip-block">#{state.data.toString()}</span>
      ) : state.status === "error" ? (
        <span className="chip-block chip-block-error">unreachable</span>
      ) : (
        <span className="chip-block">…</span>
      )}
    </span>
  );
}

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(
    () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(query).matches,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    mql.addEventListener("change", onChange);
    onChange();
    return () => mql.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

const FOCUSABLE =
  "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";

/** The phone and tablet menu: a modal sheet with the whole nav. Focus is trapped while open and returns to the menu button on close. */
function MenuSheet({ items, open, onClose }: { items: readonly NavItem[]; open: boolean; onClose: () => void }): ReactElement | null {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const back = document.activeElement as HTMLElement | null;
    panel.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== "Tab" || panel.current === null) return;
      const nodes = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (first === undefined || last === undefined) return;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      back?.focus();
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="sheet-root">
      <div className="sheet-scrim" onClick={onClose} aria-hidden="true" />
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title" ref={panel}>
        <div className="sheet-head">
          <h2 id="sheet-title" className="sheet-title">
            Menu
          </h2>
          <button type="button" className="icon-btn" onClick={onClose}>
            <NavIcon name="close" />
            <span className="sr-only">Close menu</span>
          </button>
        </div>
        <nav aria-label="Main">
          <ul className="sheet-list">
            {items.map((item) => (
              <li key={item.to}>
                <NavLink
                  to={item.to}
                  className={({ isActive }) => (isActive ? "sheet-link sheet-link-active" : "sheet-link")}
                  onClick={onClose}
                >
                  <NavIcon name={item.icon} />
                  <span>{item.label}</span>
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
        <div className="sheet-foot">
          <BlockChip />
        </div>
      </div>
    </div>
  );
}

export function Shell({ children }: { children: ReactNode }): ReactElement {
  const cfg = resolveConfig();
  const links = cfg.brand.links ?? {};
  const items = navItems();
  const phone = useMediaQuery("(max-width: 720px)");
  const { pathname } = useLocation();

  /* The bar gives way by MEASUREMENT (a tenant's brand name and a connected wallet change the room):
     0 labels, 1 icons with tooltips, 2 the menu button and the sheet. It steps up when the nav
     overflows its space, and back down once the bar is wider than it was when it stepped up. */
  const bar = useRef<HTMLElement>(null);
  const [level, setLevel] = useState<0 | 1 | 2>(0);
  const upAt = useRef<number[]>([0, 0]);
  useLayoutEffect(() => {
    const el = bar.current;
    if (el === null || phone || typeof ResizeObserver === "undefined") return;
    const check = () => {
      const width = el.clientWidth;
      const nav = el.querySelector<HTMLElement>(".nav");
      if (level < 2 && nav !== null && nav.scrollWidth > nav.clientWidth + 1) {
        upAt.current[level] = width;
        setLevel(level === 0 ? 1 : 2);
        return;
      }
      if (level > 0 && width > (upAt.current[level - 1] ?? 0) + 1) setLevel(level === 2 ? 1 : 0);
    };
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [phone, level]);

  const compact = phone || level === 2;
  const iconOnly = !compact && level === 1;
  const [sheetOn, setSheetOn] = useState<string | null>(null);
  const sheetOpen = compact && sheetOn === pathname;
  const closeSheet = useCallback(() => setSheetOn(null), []);

  return (
    <div className="shell">
      <header className={iconOnly ? "topbar topbar-icons" : "topbar"} ref={bar}>
        <div className="brand">
          {cfg.brand.logoUrl === undefined ? null : (
            <img className="brand-logo" src={cfg.brand.logoUrl} alt="" height={28} />
          )}
          <span className="brand-name">{cfg.brand.name}</span>
        </div>

        {compact ? null : (
          <nav className="nav" aria-label="Main">
            {items.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                data-tip={item.label}
                className={({ isActive }) => (isActive ? "nav-link nav-link-active" : "nav-link")}
              >
                <NavIcon name={item.icon} />
                <span className="nav-label">{item.label}</span>
              </NavLink>
            ))}
          </nav>
        )}

        <div className="topbar-right">
          {compact ? null : <BlockChip />}
          <GullyCoreConnectButton />
          {compact ? (
            <button
              type="button"
              className="icon-btn icon-btn-boxed"
              aria-haspopup="dialog"
              aria-expanded={sheetOpen}
              onClick={() => setSheetOn(pathname)}
            >
              <NavIcon name="menu" />
              <span className="sr-only">Menu</span>
            </button>
          ) : null}
        </div>
      </header>

      <MenuSheet items={items} open={sheetOpen} onClose={closeSheet} />

      {!cfg.core.isMainnet ? (
        <div className="banner banner-testnet">
          Testnet. Nothing here is worth anything, and no mainnet deployment is implied.
        </div>
      ) : null}

      <main className="main">{children}</main>

      <footer className="footer">
        <span>
          {cfg.brand.name}
          {cfg.brand.tagline === undefined ? null : (
            <span className="footer-tagline"> · {cfg.brand.tagline}</span>
          )}
        </span>
        <span className="footer-links">
          {links.docs === undefined ? null : <a href={links.docs}>Docs</a>}
          {links.github === undefined ? null : <a href={links.github}>Source</a>}
          {links.x === undefined ? null : <a href={links.x}>X</a>}
          {links.discord === undefined ? null : <a href={links.discord}>Discord</a>}
          {links.terms === undefined ? null : <a href={links.terms}>Terms</a>}
          {cfg.explorer === null ? null : (
            <a href={cfg.explorer} rel="noreferrer">
              Explorer
            </a>
          )}
        </span>
      </footer>
    </div>
  );
}
