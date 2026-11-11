// SPDX-License-Identifier: MIT
/**
 * Branding, applied as CSS custom properties.
 *
 * Every colour in `styles.css` reads a `--brand-*` variable and nothing
 * hardcodes a hex value, so restyling the whole app is an edit to
 * `gullycore.config.ts` rather than a search through stylesheets. That is the
 * difference between "restyle the UI if you want" being a sentence in a README
 * and it being true.
 *
 * The `--gullycore-*` names are also set, because that is the namespace
 * `@gullylabs/core-widgets` themes through. Setting both from one source is what
 * stops the embedded swap widget looking like a different product from the page
 * around it.
 */

import { resolveConfig } from "./config/resolve";

export function applyBrand(root: HTMLElement = document.documentElement): void {
  const { brand } = resolveConfig();
  const c = brand.colors;
  const radius = `${brand.radius ?? 12}px`;

  const vars: Record<string, string> = {
    "--brand-accent": c.accent,
    "--brand-on-accent": c.onAccent,
    "--brand-bg": c.background,
    "--brand-surface": c.surface,
    "--brand-surface-alt": c.surfaceAlt,
    "--brand-text": c.text,
    "--brand-text-muted": c.textMuted,
    "--brand-border": c.border,
    "--brand-positive": c.positive,
    "--brand-negative": c.negative,
    "--brand-radius": radius,
    "--brand-font": brand.fontFamily ?? "system-ui, sans-serif",
    "--brand-mono": brand.monoFamily ?? "ui-monospace, monospace",
    "--brand-heading": brand.headingFamily ?? brand.fontFamily ?? "system-ui, sans-serif",

    /* The widgets' own token namespace, fed from the same values. */
    "--gullycore-color-accent": c.accent,
    "--gullycore-color-on-accent": c.onAccent,
    "--gullycore-color-bg": c.background,
    "--gullycore-color-surface": c.surface,
    "--gullycore-color-surface-alt": c.surfaceAlt,
    "--gullycore-color-text": c.text,
    "--gullycore-color-text-muted": c.textMuted,
    "--gullycore-color-border": c.border,
    "--gullycore-color-positive": c.positive,
    "--gullycore-color-negative": c.negative,
    "--gullycore-radius-md": radius,
    "--gullycore-font-sans": brand.fontFamily ?? "system-ui, sans-serif",
    "--gullycore-font-mono": brand.monoFamily ?? "ui-monospace, monospace",
  };

  for (const [name, value] of Object.entries(vars)) {
    root.style.setProperty(name, value);
  }
  /* The side the palette is on: form controls, scrollbars and the chart kit's
     two-sided data colours (`light-dark()`) follow it. Dark by default. */
  root.style.setProperty("color-scheme", brand.colorScheme === "light" ? "light" : "dark");

  document.title = brand.name;
}
