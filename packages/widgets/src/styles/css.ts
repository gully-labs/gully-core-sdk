// SPDX-License-Identifier: MIT
/**
 * The stylesheet, as a string.
 *
 * It lives in TypeScript rather than a `.css` file for one reason: the web
 * component renders into a shadow root, and a shadow root cannot see the host
 * page's stylesheets. The same source therefore has to be injectable in three
 * places - a `<style>` in the document head for React hosts, a
 * `CSSStyleSheet` adopted by each shadow root, and `dist/styles.css` for hosts
 * that prefer a `<link>`. One source, no drift.
 *
 * ## Theming
 *
 * Every colour, radius and font is a `--gullycore-*` custom property declared on
 * `.gullycore-widget`. Overriding one from the host page is enough to restyle the
 * widget; nothing is hardcoded inside a rule. Light is the base, dark is applied
 * by `[data-gullycore-theme="dark"]` and by `prefers-color-scheme` when the theme is
 * left on `system`.
 *
 * The layout is single-column and fluid from 280px up, because these widgets
 * are expected to live in narrow sidebars.
 */

/** The complete widget stylesheet. */
export const WIDGET_CSS = `
.gullycore-widget {
  /* Palette: the Gully Core design handoff's tokens (light "surface water" here,
     dark below). Fills stay literal in both themes (#2CF29A action, #10B981
     done); the *-ink tokens are the text-safe forms of the same hues. */
  --gullycore-bg: #ffffff;
  --gullycore-bg-elevated: #f0f3f2;
  --gullycore-bg-sunken: #e0e6e5;
  --gullycore-bg-selected: #e8edec;
  --gullycore-border: #d4dddb;
  --gullycore-border-strong: #b5c7c2;
  --gullycore-text: #0a0f0e;
  --gullycore-text-muted: #4b5d58;
  --gullycore-text-inverted: #ffffff;
  --gullycore-accent: #2cf29a;
  --gullycore-accent-hover: #4fe0cf;
  --gullycore-accent-text: #0a0f0e;
  --gullycore-accent-ink: #0c7650;
  --gullycore-done: #10b981;
  --gullycore-done-text: #0a0f0e;
  --gullycore-success: #1e7f4f;
  --gullycore-warning: #8a5a00;
  --gullycore-warning-bg: #fff6e0;
  --gullycore-danger: #b23a17;
  --gullycore-danger-bg: #fdf0ec;
  --gullycore-focus: #0c7650;
  /* The compact swap's Buy / Sell: the CVD-safe up / down hues, tinted, with their ink. */
  --gullycore-buy: #1f9e89;
  --gullycore-buy-hover: #23b39b;
  --gullycore-buy-text: #0a0f0e;
  --gullycore-buy-ink: #167a69;
  --gullycore-sell: #e4572e;
  --gullycore-sell-ink: #b23a17;

  /* Shape and type. Inter are the handoff's faces; a host
     page that does not load them falls back to the system's. */
  --gullycore-radius: 14px;
  --gullycore-radius-sm: 10px;
  --gullycore-radius-lg: calc(var(--gullycore-radius) + 4px);
  --gullycore-font: Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --gullycore-font-display: Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --gullycore-font-mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  --gullycore-font-size: 14px;
  --gullycore-font-size-sm: 12px;
  --gullycore-font-size-lg: 22px;
  --gullycore-gap: 14px;
  --gullycore-padding: 22px;
  --gullycore-control-height: 44px;
  --gullycore-max-width: 480px;
  --gullycore-shadow: 0 1px 2px rgba(10, 15, 14, 0.05), 0 8px 24px rgba(10, 15, 14, 0.06);

  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: var(--gullycore-gap);
  width: 100%;
  min-width: 0;
  max-width: var(--gullycore-max-width);
  padding: var(--gullycore-padding);
  background: var(--gullycore-bg);
  color: var(--gullycore-text);
  border: 1px solid var(--gullycore-border);
  border-radius: var(--gullycore-radius-lg);
  box-shadow: var(--gullycore-shadow);
  font-family: var(--gullycore-font);
  font-size: var(--gullycore-font-size);
  line-height: 1.45;
}

/* A host that frames the widget itself (\`bare\`): no frame of the widget's own. */
.gullycore-widget[data-gullycore-bare="true"] {
  max-width: none;
  padding: 0;
  background: transparent;
  border: 0;
  border-radius: 0;
  box-shadow: none;
}

.gullycore-widget *,
.gullycore-widget *::before,
.gullycore-widget *::after {
  box-sizing: inherit;
}

/* Text takes the WIDGET's ink, not the host page's. A host rule such as
   \`h2 { color: var(--ink) }\` otherwise beats inheritance: a dark-themed widget
   on a light page drew its title in the page's near-black on the widget's
   near-black (1.1:1, axe, the locker embed 2026-09-26). Specificity (0,1,0)
   beats any element selector; every widget class rule below comes later and
   still sets its own colour. A host's own content in a slot is left alone. */
.gullycore-widget :where(h1, h2, h3, h4, h5, h6, p, label, legend, dt, dd, li, th, td, figcaption, caption):where(:not(.gullycore-slot *)) {
  color: inherit;
}

.gullycore-widget[data-gullycore-theme="dark"] {
  --gullycore-bg: #1a1f1e;
  --gullycore-bg-elevated: #0C1613;
  --gullycore-bg-sunken: #101d1a;
  --gullycore-bg-selected: #0f1c18;
  --gullycore-border: #353f3d;
  --gullycore-border-strong: #263b35;
  --gullycore-text: #d0d5da;
  --gullycore-text-muted: #8fa09c;
  --gullycore-text-inverted: #0a0f0e;
  --gullycore-accent: #2cf29a;
  --gullycore-accent-hover: #4fe0cf;
  --gullycore-accent-text: #0a0f0e;
  --gullycore-accent-ink: var(--gullycore-accent);
  --gullycore-success: #10b981;
  --gullycore-warning: #f59e0b;
  --gullycore-warning-bg: #2a2110;
  --gullycore-danger: #f07b5a;
  --gullycore-danger-bg: #2c140e;
  --gullycore-focus: #2cf29a;
  --gullycore-buy-ink: #5fd3be;
  --gullycore-sell-ink: #f07b5a;
  --gullycore-shadow: none;
}

@media (prefers-color-scheme: dark) {
  .gullycore-widget[data-gullycore-theme="system"] {
    --gullycore-bg: #1a1f1e;
    --gullycore-bg-elevated: #0C1613;
    --gullycore-bg-sunken: #101d1a;
    --gullycore-bg-selected: #0f1c18;
    --gullycore-border: #353f3d;
    --gullycore-border-strong: #263b35;
    --gullycore-text: #d0d5da;
    --gullycore-text-muted: #8fa09c;
    --gullycore-text-inverted: #0a0f0e;
    --gullycore-accent: #2cf29a;
    --gullycore-accent-hover: #4fe0cf;
    --gullycore-accent-text: #0a0f0e;
    --gullycore-accent-ink: var(--gullycore-accent);
    --gullycore-success: #10b981;
    --gullycore-warning: #f59e0b;
    --gullycore-warning-bg: #2a2110;
    --gullycore-danger: #f07b5a;
    --gullycore-danger-bg: #2c140e;
    --gullycore-focus: #2cf29a;
    --gullycore-buy-ink: #5fd3be;
    --gullycore-sell-ink: #f07b5a;
    --gullycore-shadow: none;
  }
}

.gullycore-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}

.gullycore-title {
  margin: 0;
  font-family: var(--gullycore-font-display);
  font-size: 18px;
  font-weight: 700;
}

.gullycore-subtitle {
  margin: 0;
  color: var(--gullycore-text-muted);
  font-size: var(--gullycore-font-size-sm);
}

.gullycore-mock-banner {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  padding: 10px 12px;
  border: 1px solid var(--gullycore-warning);
  border-radius: var(--gullycore-radius-sm);
  background: var(--gullycore-warning-bg);
  color: var(--gullycore-warning);
  font-size: var(--gullycore-font-size-sm);
  font-weight: 600;
}

.gullycore-mock-banner span {
  font-weight: 500;
}

.gullycore-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px;
  background: var(--gullycore-bg-elevated);
  border: 1px solid var(--gullycore-border);
  border-radius: var(--gullycore-radius-sm);
}

.gullycore-field-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.gullycore-label {
  display: block;
  color: var(--gullycore-text-muted);
  font-size: var(--gullycore-font-size-sm);
  font-weight: 600;
  letter-spacing: 0.01em;
}

.gullycore-amount-input {
  flex: 1 1 120px;
  min-width: 0;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--gullycore-text);
  font-family: var(--gullycore-font);
  font-size: var(--gullycore-font-size-lg);
  font-weight: 600;
  line-height: 1.2;
}

.gullycore-amount-input::placeholder {
  color: var(--gullycore-text-muted);
  font-weight: 500;
}

.gullycore-amount-input:focus-visible,
.gullycore-select:focus-visible,
.gullycore-button:focus-visible,
.gullycore-icon-button:focus-visible,
.gullycore-slider:focus-visible,
.gullycore-chip:focus-visible {
  outline: 2px solid var(--gullycore-focus);
  outline-offset: 3px;
  border-radius: 4px;
}

.gullycore-swap :is(.gullycore-portion, .gullycore-slippage__btn, .gullycore-details__flip, .gullycore-sides__btn, .gullycore-token-button, .gullycore-flip__button, .gullycore-cta, .gullycore-details__toggle, .gullycore-details__rate, .gullycore-settings-trigger):focus-visible {
  outline: 2px solid var(--gullycore-focus);
  outline-offset: 3px;
}

.gullycore-select {
  flex: 0 1 auto;
  max-width: 100%;
  height: 34px;
  padding: 0 8px;
  background: var(--gullycore-bg);
  color: var(--gullycore-text);
  border: 1px solid var(--gullycore-border-strong);
  border-radius: 999px;
  font-family: inherit;
  font-size: var(--gullycore-font-size);
  font-weight: 600;
  cursor: pointer;
}

.gullycore-meta {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  color: var(--gullycore-text-muted);
  font-size: var(--gullycore-font-size-sm);
}

.gullycore-meta-value {
  font-variant-numeric: tabular-nums;
}

.gullycore-switch-row {
  display: flex;
  justify-content: center;
  margin: -6px 0;
}

.gullycore-icon-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  padding: 0;
  background: var(--gullycore-bg);
  color: var(--gullycore-text);
  border: 1px solid var(--gullycore-border-strong);
  border-radius: 999px;
  cursor: pointer;
  font-size: 15px;
  line-height: 1;
}

.gullycore-icon-button:hover {
  background: var(--gullycore-bg-sunken);
}

.gullycore-summary {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px;
  background: var(--gullycore-bg-sunken);
  border-radius: var(--gullycore-radius-sm);
  font-size: var(--gullycore-font-size-sm);
}

.gullycore-summary dl {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
}

.gullycore-summary-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
}

.gullycore-summary-row dt {
  color: var(--gullycore-text-muted);
  min-width: 0;
}

.gullycore-summary-row dd {
  margin: 0;
  text-align: right;
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
}

.gullycore-summary-row[data-gullycore-emphasis="fee"] dd {
  color: var(--gullycore-accent);
  font-weight: 650;
}

.gullycore-summary-row[data-gullycore-severity="high"] dd,
.gullycore-summary-row[data-gullycore-severity="severe"] dd {
  color: var(--gullycore-danger);
  font-weight: 650;
}

.gullycore-route {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  font-size: var(--gullycore-font-size-sm);
  color: var(--gullycore-text-muted);
}

.gullycore-route-token {
  padding: 2px 8px;
  background: var(--gullycore-bg);
  border: 1px solid var(--gullycore-border);
  border-radius: 999px;
  color: var(--gullycore-text);
  font-weight: 600;
}

.gullycore-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  width: 100%;
  min-height: var(--gullycore-control-height);
  padding: 0 16px;
  background: var(--gullycore-accent);
  color: var(--gullycore-accent-text);
  border: 1px solid transparent;
  border-radius: var(--gullycore-radius-sm);
  font-family: inherit;
  font-size: 15px;
  font-weight: 650;
  cursor: pointer;
}

.gullycore-button:hover:not(:disabled) {
  background: var(--gullycore-accent-hover);
}

.gullycore-button:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.gullycore-button[data-gullycore-variant="secondary"] {
  background: var(--gullycore-bg-elevated);
  color: var(--gullycore-text);
  border-color: var(--gullycore-border-strong);
}

.gullycore-button[data-gullycore-variant="danger"] {
  background: var(--gullycore-danger);
  color: var(--gullycore-text-inverted);
}

.gullycore-status {
  min-height: 18px;
  margin: 0;
  font-size: var(--gullycore-font-size-sm);
  color: var(--gullycore-text-muted);
}

.gullycore-status[data-gullycore-tone="error"] {
  color: var(--gullycore-danger);
}

.gullycore-status[data-gullycore-tone="success"] {
  color: var(--gullycore-success);
}

.gullycore-error {
  padding: 10px 12px;
  background: var(--gullycore-danger-bg);
  border: 1px solid var(--gullycore-danger);
  border-radius: var(--gullycore-radius-sm);
  color: var(--gullycore-danger);
  font-size: var(--gullycore-font-size-sm);
  overflow-wrap: anywhere;
}

.gullycore-tabs {
  display: flex;
  gap: 4px;
  padding: 3px;
  background: var(--gullycore-bg-sunken);
  border-radius: 999px;
}

.gullycore-chip {
  flex: 1 1 0;
  min-width: 0;
  padding: 7px 10px;
  background: transparent;
  color: var(--gullycore-text-muted);
  border: 0;
  border-radius: 999px;
  font-family: inherit;
  font-size: var(--gullycore-font-size-sm);
  font-weight: 650;
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.gullycore-chip[aria-selected="true"],
.gullycore-chip[aria-pressed="true"] {
  background: var(--gullycore-bg);
  color: var(--gullycore-text);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08);
}

.gullycore-progress {
  height: 8px;
  background: var(--gullycore-bg-sunken);
  border-radius: 999px;
  overflow: hidden;
}

.gullycore-progress-fill {
  height: 100%;
  background: var(--gullycore-accent);
  border-radius: 999px;
  transition: width 200ms ease;
}

.gullycore-slider {
  width: 100%;
  accent-color: var(--gullycore-accent);
}

.gullycore-range-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.gullycore-range-grid input {
  width: 100%;
  min-width: 0;
  height: 36px;
  padding: 0 10px;
  background: var(--gullycore-bg);
  color: var(--gullycore-text);
  border: 1px solid var(--gullycore-border-strong);
  border-radius: var(--gullycore-radius-sm);
  font-family: var(--gullycore-font-mono);
  font-size: var(--gullycore-font-size);
}

.gullycore-curve {
  display: block;
  width: 100%;
  height: auto;
  border-radius: var(--gullycore-radius-sm);
  background: var(--gullycore-bg-sunken);
}

.gullycore-visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  border: 0;
  clip: rect(0 0 0 0);
  clip-path: inset(50%);
  overflow: hidden;
  white-space: nowrap;
}

.gullycore-footer {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  color: var(--gullycore-text-muted);
  font-size: 11px;
}

.gullycore-footer a {
  color: inherit;
}

.gullycore-launch-legs {
  display: grid;
  gap: 16px;
}

.gullycore-empty {
  margin: 0;
  color: var(--gullycore-text-muted);
  font-size: 13px;
  line-height: 1.5;
}

@media (max-width: 380px) {
  .gullycore-widget {
    --gullycore-padding: 16px;
    --gullycore-font-size-lg: 20px;
  }

  .gullycore-range-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}

@media (prefers-reduced-motion: reduce) {
  .gullycore-progress-fill {
    transition: none;
  }
}

/* ============================================================================
   Swap surface (SwapWidget): the design handoff's trade panel. Labelled wells,
   a token chip, mono lines, the 52px call to action with its three-bar
   sounder while it waits and the done fill after. Every colour, radius and
   font is a --gullycore-* token above.
   ============================================================================ */

/* The handoff sets no line-height on the panel's type: every line is the face's own "normal". */
.gullycore-swap__form { display: flex; flex-direction: column; gap: 4px; line-height: normal; }
.gullycore-swap .gullycore-header:has(.gullycore-sides) { line-height: normal; }
.gullycore-swap__form[data-gullycore-variant="compact"] { gap: var(--gullycore-gap); }
.gullycore-swap__form[data-gullycore-variant="panel"] { gap: 12px; }

/* The wells */
.gullycore-panel {
  display: flex; flex-direction: column; gap: 8px;
  background: var(--gullycore-bg-elevated);
  border: 1px solid var(--gullycore-border);
  border-radius: var(--gullycore-radius);
  padding: 14px 16px;
  transition: border-color 120ms ease;
}
.gullycore-panel:focus-within { border-color: var(--gullycore-border-strong); }
/* The amount field draws no outline of its own (it is the well's big number), so the WELL carries
   the keyboard focus ring (WCAG 2.4.7). */
.gullycore-panel:has(.gullycore-big-input:focus-visible) { border-color: var(--gullycore-focus); box-shadow: 0 0 0 1px var(--gullycore-focus); }
.gullycore-panel__top { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.gullycore-swap .gullycore-label {
  font-family: var(--gullycore-font-mono); font-size: 11px; font-weight: 400; letter-spacing: 0.12em;
  text-transform: uppercase; color: var(--gullycore-text-muted);
}
.gullycore-panel__balance { font-family: var(--gullycore-font-mono); font-size: 11px; color: var(--gullycore-text-muted); display: inline-flex; gap: 8px; align-items: center; font-variant-numeric: tabular-nums; }
.gullycore-panel__main { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.gullycore-big-input {
  flex: 1 1 auto; min-width: 0; width: 100%;
  font-family: var(--gullycore-font-display); font-size: 28px; font-weight: 600; line-height: normal; letter-spacing: 0;
  background: transparent; border: 0; color: var(--gullycore-text); padding: 0; outline: none;
}
/* An input keeps the browser's own 1px 2px padding, as the handoff's does (it sizes the well). */
input.gullycore-big-input { padding: 1px 2px; }
.gullycore-big-input::placeholder, .gullycore-big-input__placeholder { color: var(--gullycore-text-muted); opacity: 1; }
.gullycore-big-input--out { display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; transition: opacity 150ms; }
.gullycore-big-input--out.is-refreshing { opacity: 0.55; }
.gullycore-panel__error { margin: 0; font-family: var(--gullycore-font-mono); font-size: var(--gullycore-font-size-sm); color: var(--gullycore-danger); }
.gullycore-panel__note { margin: 0; font-family: var(--gullycore-font-mono); font-size: var(--gullycore-font-size-sm); color: var(--gullycore-text-muted); }

/* Quick amounts: 25% / 50% / 75% / MAX, one row of equal chips. */
.gullycore-portions { display: flex; gap: 6px; }
.gullycore-portion {
  flex: 1 1 0; min-width: 0; white-space: nowrap; height: 36px; padding: 0 6px;
  border: 1px solid var(--gullycore-border); border-radius: var(--gullycore-radius-sm); background: transparent; color: var(--gullycore-text-muted);
  font-family: var(--gullycore-font-mono); font-size: 12px; font-weight: 500; text-transform: uppercase; cursor: pointer;
  transition: all 0.2s;
}
.gullycore-portion:hover { border-color: color-mix(in srgb, var(--gullycore-accent) 50%, transparent); color: var(--gullycore-accent-ink); }
.gullycore-portion[aria-pressed="true"] { background: var(--gullycore-bg-selected); border-color: color-mix(in srgb, var(--gullycore-accent) 50%, transparent); color: var(--gullycore-accent-ink); }

/* The inline slippage row */
.gullycore-slippage {
  display: flex; align-items: center; justify-content: space-between; gap: 10px;
  font-family: var(--gullycore-font-mono); font-size: 12px; color: var(--gullycore-text-muted);
}
.gullycore-slippage__opts { display: flex; gap: 4px; }
.gullycore-slippage__btn {
  white-space: nowrap; height: 32px; padding: 0 10px; border: 1px solid var(--gullycore-border); border-radius: calc(var(--gullycore-radius-sm) - 2px);
  background: transparent; color: var(--gullycore-text-muted); font-family: var(--gullycore-font-mono); font-size: 11px; font-weight: 500; cursor: pointer;
}
.gullycore-slippage__btn[aria-checked="true"] { border-color: var(--gullycore-accent); color: var(--gullycore-accent-ink); }

/* The compact variant's Buy / Sell tabs, in the header where the title was. */
.gullycore-sides {
  flex: 1 1 auto; display: flex; gap: 4px; padding: 3px; min-width: 0;
  border: 1px solid var(--gullycore-border); border-radius: calc(var(--gullycore-radius-sm) + 2px); background: var(--gullycore-bg-elevated);
}
.gullycore-sides__btn {
  flex: 1; white-space: nowrap; height: 42px; border: 0; border-radius: calc(var(--gullycore-radius-sm) - 1px); background: transparent; color: var(--gullycore-text-muted);
  font-family: var(--gullycore-font); font-size: 14px; font-weight: 500; cursor: pointer; transition: all 0.2s;
}
.gullycore-sides__btn[data-gullycore-side="buy"]::before { content: "\\25B2\\00a0"; content: "\\25B2\\00a0" / ""; }
.gullycore-sides__btn[data-gullycore-side="sell"]::before { content: "\\25BC\\00a0"; content: "\\25BC\\00a0" / ""; }
.gullycore-sides__btn:hover:not([aria-pressed="true"]) { color: var(--gullycore-text); }
.gullycore-sides__btn[data-gullycore-side="buy"][aria-pressed="true"] { background: color-mix(in srgb, var(--gullycore-buy) 18%, transparent); color: var(--gullycore-buy-ink); }
.gullycore-sides__btn[data-gullycore-side="sell"][aria-pressed="true"] { background: color-mix(in srgb, var(--gullycore-sell) 16%, transparent); color: var(--gullycore-sell-ink); }
.gullycore-swap .gullycore-header:has(.gullycore-sides) { align-items: center; flex-wrap: nowrap; }

/* The lines: label left, value right, mono. */
.gullycore-lines { margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; font-family: var(--gullycore-font-mono); font-size: 12px; color: var(--gullycore-text-muted); }
.gullycore-lines--panel { padding: 4px 2px; }
.gullycore-lines .gullycore-details__row { font-size: inherit; }
.gullycore-lines .gullycore-details__row dt { color: var(--gullycore-text-muted); }
.gullycore-lines .gullycore-details__row dd { color: var(--gullycore-text); }
.gullycore-lines output { font: inherit; transition: opacity 150ms; }
.gullycore-lines output.is-refreshing { opacity: 0.55; }

/* The token chip (a selector, or read-only when the pair is fixed) */
.gullycore-token-button {
  flex: 0 0 auto; display: inline-flex; align-items: center; gap: 8px; white-space: nowrap;
  height: 36px; padding: 0 12px; border-radius: var(--gullycore-radius-sm); cursor: pointer;
  background: transparent; color: var(--gullycore-text); border: 1px solid var(--gullycore-border); box-shadow: none;
  font-family: var(--gullycore-font-mono); font-size: 13px; font-weight: 500;
  transition: border-color 120ms, transform 80ms;
}
.gullycore-token-button:has(.gullycore-token-logo) { padding-left: 8px; }
.gullycore-token-button:hover { border-color: var(--gullycore-border-strong); }
.gullycore-token-button:active { transform: scale(0.98); }
.gullycore-token-button__chevron { color: var(--gullycore-text-muted); font-size: 12px; }
.gullycore-token-button--locked { cursor: default; }
.gullycore-token-button--locked:hover { border-color: var(--gullycore-border); }
.gullycore-token-button--locked:active { transform: none; }
.gullycore-slot { display: block; }
.gullycore-token-logo { border-radius: 50%; object-fit: cover; flex-shrink: 0; background: var(--gullycore-bg-sunken); }
.gullycore-token-logo--initials {
  display: inline-flex; align-items: center; justify-content: center; font-weight: 700;
  color: #fff; letter-spacing: 0.01em; text-shadow: 0 1px 1px rgba(0, 0, 0, 0.25);
  background: linear-gradient(140deg, hsl(var(--gullycore-mono-hue, 215) 62% 52%), hsl(calc(var(--gullycore-mono-hue, 215) + 28) 58% 34%));
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.12);
}

.gullycore-flip { display: flex; justify-content: center; height: 0; position: relative; z-index: 1; }
.gullycore-flip__button {
  position: relative; top: -18px; width: 36px; height: 36px; border-radius: calc(var(--gullycore-radius-sm) + 2px); cursor: pointer;
  background: var(--gullycore-bg); border: 1px solid var(--gullycore-border); color: var(--gullycore-accent-ink);
  box-shadow: 0 0 0 4px var(--gullycore-bg); font-size: 16px; line-height: 1;
  display: inline-flex; align-items: center; justify-content: center; transition: transform 160ms ease, background 120ms;
}
.gullycore-flip__button:hover { background: var(--gullycore-bg-selected); transform: rotate(180deg); }

/* The call to action: idle, waiting (sounder + "Confirming"), done ("Swapped ✓", 1.8 s). */
.gullycore-cta {
  white-space: nowrap; position: relative; overflow: hidden; width: 100%; height: 52px; margin: 0;
  display: flex; align-items: center; justify-content: center; gap: 10px;
  border: 0; border-radius: calc(var(--gullycore-radius) + 2px);
  background: var(--gullycore-accent); color: var(--gullycore-accent-text);
  font-family: var(--gullycore-font); font-size: 16px; font-weight: 500;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.5), inset 0 -2px 0 rgba(10, 15, 14, 0.18), 0 0 28px color-mix(in srgb, var(--gullycore-accent) 22%, transparent);
  cursor: pointer; transition: background 0.25s, box-shadow 0.25s;
}
.gullycore-swap__form[data-gullycore-variant="default"] .gullycore-cta { margin-top: 10px; }
.gullycore-cta:hover:not(:disabled) {
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.5), inset 0 -2px 0 rgba(10, 15, 14, 0.18), 0 0 36px color-mix(in srgb, var(--gullycore-accent) 50%, transparent);
}
.gullycore-cta:disabled { background: var(--gullycore-border); color: var(--gullycore-text-muted); box-shadow: none; cursor: not-allowed; }
.gullycore-cta[data-gullycore-busy="true"] {
  background: var(--gullycore-accent); color: var(--gullycore-accent-text); cursor: progress;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.5), inset 0 -2px 0 rgba(10, 15, 14, 0.18), 0 0 28px color-mix(in srgb, var(--gullycore-accent) 22%, transparent);
}
.gullycore-cta[data-gullycore-done="true"] { background: var(--gullycore-done); color: var(--gullycore-done-text); }
.gullycore-sounder { display: flex; align-items: flex-end; gap: 3px; height: 16px; }
.gullycore-sounder > span {
  width: 3px; height: 16px; border-radius: 2px; background: currentColor;
  animation: gullycore-pulse 2.2s ease-out infinite;
}
.gullycore-sounder > span:nth-child(2) { animation-delay: -0.4s; }
.gullycore-sounder > span:nth-child(3) { animation-delay: -0.8s; }
@keyframes gullycore-pulse { from { transform: scale(1); opacity: 0.7; } to { transform: scale(2.6); opacity: 0; } }
/* Kept for hosts that drew their own spinner from the old class. */
.gullycore-spinner {
  width: 16px; height: 16px; border-radius: 50%; border: 2px solid currentColor; border-right-color: transparent;
  animation: gullycore-spin 0.8s linear infinite;
}
@keyframes gullycore-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  .gullycore-sounder > span { animation: none; opacity: 1; }
  .gullycore-cta, .gullycore-portion, .gullycore-sides__btn, .gullycore-flip__button, .gullycore-token-button, .gullycore-panel { transition: none; }
}

.gullycore-ack {
  display: flex; gap: 10px; align-items: flex-start; padding: 10px 12px;
  border-radius: var(--gullycore-radius-sm); background: var(--gullycore-warning-bg); color: var(--gullycore-text); font-size: var(--gullycore-font-size-sm);
}
.gullycore-ack input { margin-top: 2px; }

.gullycore-details { margin-top: 8px; border: 1px solid var(--gullycore-border); border-radius: var(--gullycore-radius-sm); overflow: hidden; }
.gullycore-details__toggle {
  width: 100%; display: flex; justify-content: space-between; align-items: center; gap: 8px;
  padding: 10px 12px; background: transparent; border: 0; font-family: var(--gullycore-font-mono); font-size: 12px; color: var(--gullycore-text); cursor: pointer; text-align: left;
}
.gullycore-details__toggle:hover { background: var(--gullycore-bg-elevated); }
.gullycore-details__rate { font-weight: 500; cursor: pointer; }
.gullycore-details__hint { display: inline-flex; gap: 10px; align-items: center; color: var(--gullycore-text-muted); font-size: var(--gullycore-font-size-sm); }
.gullycore-details__list { margin: 0; padding: 8px 12px 10px; display: grid; gap: 8px; border-top: 1px solid var(--gullycore-border); font-family: var(--gullycore-font-mono); font-size: 12px; }
.gullycore-details__row { display: flex; justify-content: space-between; gap: 12px; font-size: var(--gullycore-font-size-sm); }
.gullycore-details__row dt { color: var(--gullycore-text-muted); }
.gullycore-details__row dd { margin: 0; text-align: right; color: var(--gullycore-text); overflow-wrap: anywhere; }
[data-gullycore-severity="high"] { color: var(--gullycore-danger) !important; }
[data-gullycore-severity="medium"] { color: var(--gullycore-warning) !important; }

/* Price impact's colour (owner 2026-10-11): amber above 1%, red above 5%. */
[data-gullycore-tone="warn"] { color: var(--gullycore-warning) !important; }
[data-gullycore-tone="bad"] { color: var(--gullycore-danger) !important; font-weight: 600; }
.gullycore-details__flip { all: unset; cursor: pointer; text-align: right; }
.gullycore-details__flip:focus-visible { outline: 2px solid var(--gullycore-focus); outline-offset: 2px; }
.gullycore-panel__usd { font-family: var(--gullycore-font-mono); font-size: 12px; color: var(--gullycore-text-muted); font-variant-numeric: tabular-nums; }
.gullycore-panel__echo { margin: 0; font-family: var(--gullycore-font-mono); font-size: 12px; color: var(--gullycore-accent-ink); font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.gullycore-panel__note--bad { color: var(--gullycore-danger); }
input.gullycore-big-input--out { text-overflow: ellipsis; }

/* "Review swap": the exact amounts, every line, the steps, then the one button that reaches the wallet. */
.gullycore-review { gap: 12px; padding: 16px 16px 12px; overflow-y: auto; }
.gullycore-review__amounts { display: grid; gap: 8px; }
.gullycore-review__amount {
  display: flex; flex-direction: column; gap: 4px; padding: 12px 14px;
  background: var(--gullycore-bg-elevated); border: 1px solid var(--gullycore-border); border-radius: var(--gullycore-radius);
}
.gullycore-review__amount strong { font-family: var(--gullycore-font-display); font-size: 22px; font-weight: 600; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
.gullycore-review__value { display: flex; align-items: center; gap: 8px; }
.gullycore-review__value .gullycore-token-logo { flex: 0 0 auto; }
.gullycore-review__min { font-family: var(--gullycore-font-mono); font-size: 12px; color: var(--gullycore-text-muted); }
.gullycore-review__warn {
  margin: 0; padding: 10px 12px; border-radius: var(--gullycore-radius-sm);
  background: color-mix(in srgb, var(--gullycore-danger) 12%, transparent); color: var(--gullycore-danger); font-size: var(--gullycore-font-size-sm); font-weight: 600;
}
.gullycore-review__lines { border: 1px solid var(--gullycore-border); border-radius: var(--gullycore-radius-sm); }
.gullycore-review__steps { margin: 0; padding: 0; list-style: none; display: grid; gap: 6px; font-family: var(--gullycore-font-mono); font-size: 12px; color: var(--gullycore-text-muted); }
.gullycore-review__steps li { display: flex; align-items: center; gap: 8px; }
.gullycore-review__steps li[data-gullycore-current="true"] { color: var(--gullycore-accent-ink); font-weight: 600; }
.gullycore-review__step-n {
  display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 20px; border-radius: 999px;
  border: 1px solid currentColor; font-size: 11px;
}
.gullycore-review__note { margin: 0; font-size: var(--gullycore-font-size-sm); color: var(--gullycore-text-muted); }
.gullycore-review .gullycore-cta[data-gullycore-danger="true"]:not(:disabled) { background: var(--gullycore-danger); color: #fff; }
.gullycore-review .gullycore-status:empty { display: none; }
.gullycore-review .gullycore-status { margin: 0; font-family: var(--gullycore-font-mono); font-size: 12px; }

.gullycore-swap .gullycore-status { min-height: 0; font-family: var(--gullycore-font-mono); }
.gullycore-swap .gullycore-status:empty { display: none; }
.gullycore-swap .gullycore-footer { font-family: var(--gullycore-font-mono); }

.gullycore-settings-trigger { display: inline-flex; align-items: center; gap: 6px; width: auto; padding: 0 10px; border-radius: 999px; }
.gullycore-settings-trigger__value { font-family: var(--gullycore-font-mono); font-size: var(--gullycore-font-size-sm); font-weight: 500; }

/* Overlays. Portalled into .gullycore-widget, so they inherit the tokens. */
.gullycore-overlay { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.45); backdrop-filter: blur(2px); animation: gullycore-fade 120ms ease; z-index: 50; }
.gullycore-dialog {
  position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%); z-index: 51;
  width: min(420px, calc(100vw - 32px)); max-height: min(640px, calc(100vh - 32px));
  display: flex; flex-direction: column; gap: 10px;
  background: var(--gullycore-bg); color: var(--gullycore-text); border: 1px solid var(--gullycore-border);
  border-radius: var(--gullycore-radius); box-shadow: var(--gullycore-shadow); padding: 14px 14px 8px;
  font-family: var(--gullycore-font); font-size: var(--gullycore-font-size); animation: gullycore-pop 140ms ease;
}
@keyframes gullycore-fade { from { opacity: 0; } }
@keyframes gullycore-pop { from { opacity: 0; transform: translate(-50%, -48%) scale(0.98); } }
.gullycore-dialog__head { display: flex; justify-content: space-between; align-items: center; }
.gullycore-dialog__title { margin: 0; font-size: 17px; font-weight: 700; display: inline-flex; align-items: center; gap: 8px; }
.gullycore-dialog__count {
  font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 999px; font-variant-numeric: tabular-nums;
  color: var(--gullycore-text-muted); background: var(--gullycore-bg-elevated); border: 1px solid var(--gullycore-border);
}
.gullycore-search-wrap { position: relative; display: flex; align-items: center; }
.gullycore-search-wrap__icon { position: absolute; left: 14px; color: var(--gullycore-text-muted); pointer-events: none; }
.gullycore-search-wrap__clear {
  position: absolute; right: 8px; width: 28px; height: 28px; border-radius: 999px; border: 0; cursor: pointer;
  background: var(--gullycore-bg-sunken); color: var(--gullycore-text-muted); font-size: 16px; line-height: 1;
}
.gullycore-search-wrap__clear:hover { color: var(--gullycore-text); }
.gullycore-search {
  width: 100%; font: inherit; font-size: 16px; padding: 12px 40px; border-radius: 999px;
  border: 1px solid var(--gullycore-border); background: var(--gullycore-bg-elevated); color: var(--gullycore-text); outline: none;
  transition: border-color 120ms, box-shadow 120ms;
}
.gullycore-search:focus { border-color: var(--gullycore-accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--gullycore-accent) 22%, transparent); }
.gullycore-common { display: flex; flex-wrap: wrap; gap: 8px; padding-bottom: 4px; }
.gullycore-chip--token {
  flex: 0 0 auto; display: inline-flex; align-items: center; gap: 8px; min-height: 36px; padding: 0 14px 0 6px;
  border-radius: 999px; border: 1px solid var(--gullycore-border); background: var(--gullycore-bg-elevated); color: var(--gullycore-text);
  font-weight: 600; transition: border-color 120ms, background 120ms;
}
.gullycore-chip--token:hover { border-color: color-mix(in srgb, var(--gullycore-accent) 55%, var(--gullycore-border)); }
.gullycore-chip--token[aria-pressed="true"] { border-color: var(--gullycore-accent); background: color-mix(in srgb, var(--gullycore-accent) 14%, var(--gullycore-bg-elevated)); }
.gullycore-token-list { list-style: none; margin: 0 -14px; padding: 6px 8px 8px; overflow-y: auto; border-top: 1px solid var(--gullycore-border); }
.gullycore-token-row {
  width: 100%; display: flex; align-items: center; gap: 12px; padding: 10px; min-height: 56px; background: transparent; border: 0;
  border-radius: 12px; font: inherit; color: var(--gullycore-text); cursor: pointer; text-align: left; transition: background 100ms;
}
.gullycore-token-row:hover:not(:disabled), .gullycore-token-row:focus-visible { background: var(--gullycore-bg-elevated); outline: none; }
.gullycore-token-row:focus-visible { box-shadow: inset 0 0 0 2px var(--gullycore-accent); }
.gullycore-token-row[aria-selected="true"] { background: color-mix(in srgb, var(--gullycore-accent) 10%, transparent); }
.gullycore-token-row:disabled { opacity: 0.4; cursor: not-allowed; }
.gullycore-token-row--note { color: var(--gullycore-text-muted); font-size: var(--gullycore-font-size-sm); cursor: default; min-height: 0; }
.gullycore-token-row--empty { justify-content: center; text-align: center; padding: 28px 16px; }
.gullycore-token-row__main { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
.gullycore-token-row__symbol { font-weight: 650; font-size: 15px; display: inline-flex; align-items: center; flex-wrap: wrap; }
.gullycore-token-row__name { font-size: var(--gullycore-font-size-sm); color: var(--gullycore-text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.gullycore-token-row__balance { display: flex; flex-direction: column; align-items: flex-end; font-variant-numeric: tabular-nums; color: var(--gullycore-text); font-weight: 600; }
.gullycore-token-row__balance-sym { font-size: 11px; font-weight: 500; color: var(--gullycore-text-muted); }
.gullycore-token-row__check { color: var(--gullycore-accent); font-weight: 700; font-size: 15px; margin-left: 4px; }
@media (prefers-reduced-motion: reduce) {
  .gullycore-token-row, .gullycore-chip--token, .gullycore-search { transition: none; }
}
.gullycore-token-row--unlisted { background: color-mix(in srgb, var(--gullycore-warning) 8%, transparent); }
.gullycore-token-row__badges { display: inline-flex; flex-wrap: wrap; gap: 4px; margin-left: 8px; vertical-align: middle; }
.gullycore-badge {
  display: inline-block; padding: 1px 6px; border-radius: 999px; font-size: 11px; font-weight: 600; line-height: 16px; letter-spacing: 0.01em;
  border: 1px solid var(--gullycore-border); background: var(--gullycore-bg-elevated); color: var(--gullycore-text-muted); white-space: nowrap;
}
.gullycore-badge[data-gullycore-tone="info"] { color: var(--gullycore-accent); border-color: color-mix(in srgb, var(--gullycore-accent) 35%, transparent); }
.gullycore-badge[data-gullycore-tone="warn"] { color: var(--gullycore-warning); border-color: color-mix(in srgb, var(--gullycore-warning) 45%, transparent); }
.gullycore-token-group { list-style: none; }
.gullycore-token-group__label {
  display: block; padding: 8px 14px 4px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em;
  color: var(--gullycore-text-muted); border-top: 1px solid var(--gullycore-border);
}
.gullycore-token-group:first-child .gullycore-token-group__label { border-top: 0; }
.gullycore-token-group__list { list-style: none; margin: 0; padding: 0; }

.gullycore-popover {
  z-index: 51; width: min(320px, calc(100vw - 32px)); background: var(--gullycore-bg); color: var(--gullycore-text);
  border: 1px solid var(--gullycore-border); border-radius: var(--gullycore-radius); box-shadow: var(--gullycore-shadow); padding: 12px;
  display: flex; flex-direction: column; gap: 8px; font-family: var(--gullycore-font); font-size: var(--gullycore-font-size); animation: gullycore-fade 120ms ease;
}
.gullycore-popover__row { display: flex; justify-content: space-between; align-items: center; }
.gullycore-popover__value { font-size: var(--gullycore-font-size-sm); color: var(--gullycore-text-muted); }
.gullycore-custom-slippage { display: inline-flex; align-items: center; gap: 4px; flex: 0 0 auto; }
.gullycore-custom-slippage input {
  width: 56px; font: inherit; font-size: var(--gullycore-font-size-sm); padding: 6px 8px; border-radius: 999px;
  border: 1px solid var(--gullycore-border); background: var(--gullycore-bg); color: var(--gullycore-text); text-align: right; outline: none;
}
.gullycore-custom-slippage input:focus { border-color: var(--gullycore-accent); }
.gullycore-note { margin: 0; font-size: var(--gullycore-font-size-sm); color: var(--gullycore-text-muted); }
.gullycore-note--warn { color: var(--gullycore-warning); }
.gullycore-footer--brand { justify-content: center; color: var(--gullycore-text-muted); font-size: 11px; }
.gullycore-footer a { color: var(--gullycore-accent); text-decoration: none; }

/* ============================================================================
   Locks (LocksBadge, LocksPanel): the locked share and a countdown. Every
   colour is a --gullycore-* token above.
   ============================================================================ */
.gullycore-locks { gap: 6px; }
.gullycore-locks--badge { display: inline-flex; flex-direction: column; width: auto; max-width: 100%; padding: 10px 14px; box-shadow: none; border-radius: var(--gullycore-radius-sm); }
.gullycore-locks--panel { max-width: none; }
.gullycore-locks__headline { margin: 0; display: flex; align-items: baseline; gap: 8px; font-weight: 600; overflow-wrap: anywhere; }
.gullycore-locks__headline--muted { color: var(--gullycore-text-muted); font-weight: 500; }
.gullycore-locks__headline--error { color: var(--gullycore-danger); font-weight: 500; }
.gullycore-locks__dot { flex: 0 0 auto; width: 9px; height: 9px; border-radius: 50%; background: var(--gullycore-text-muted); transform: translateY(-1px); }
.gullycore-locks__dot--locked { background: var(--gullycore-success); }
.gullycore-locks__dot--open { background: var(--gullycore-warning); }
.gullycore-locks__dot--none { background: var(--gullycore-border-strong); }
.gullycore-locks__countdown { margin: 0; font-size: var(--gullycore-font-size-sm); color: var(--gullycore-text-muted); overflow-wrap: anywhere; }
.gullycore-locks__timer { font-family: var(--gullycore-font-mono); font-variant-numeric: tabular-nums; color: var(--gullycore-text); }
.gullycore-locks__link { font-size: var(--gullycore-font-size-sm); color: var(--gullycore-accent); text-decoration: none; font-weight: 600; }
.gullycore-locks__link:hover { text-decoration: underline; }
.gullycore-locks__link:focus-visible { outline: 2px solid var(--gullycore-focus); outline-offset: 2px; border-radius: 4px; }
.gullycore-locks__list { list-style: none; margin: 4px 0 0; padding: 0; display: grid; gap: 8px; }
.gullycore-locks__item { display: grid; gap: 6px; padding: 10px 12px; border: 1px solid var(--gullycore-border); border-radius: var(--gullycore-radius-sm); background: var(--gullycore-bg-elevated); min-width: 0; }
.gullycore-locks__item[data-status="withdrawn"], .gullycore-locks__item[data-status="claimed"] { opacity: 0.72; }
.gullycore-locks__row { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.gullycore-locks__status { flex: 0 0 auto; padding: 1px 8px; border: 1px solid currentColor; border-radius: 999px; font-size: 11px; font-weight: 650; white-space: nowrap; }
.gullycore-locks__status--locked, .gullycore-locks__status--cliff, .gullycore-locks__status--vesting { color: var(--gullycore-success); }
.gullycore-locks__status--unlockable, .gullycore-locks__status--vested { color: var(--gullycore-warning); }
.gullycore-locks__status--withdrawn, .gullycore-locks__status--claimed { color: var(--gullycore-text-muted); }
.gullycore-locks__status--permanent { color: var(--gullycore-accent, var(--gullycore-success)); }
.gullycore-locks__facts { margin: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 6px 12px; font-size: var(--gullycore-font-size-sm); }
.gullycore-locks__facts div { min-width: 0; }
.gullycore-locks__facts dt { color: var(--gullycore-text-muted); }
.gullycore-locks__facts dd { margin: 0; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }

/* Lock charts (lockCharts.tsx): a locked-share bar that grows in, and a release
   schedule that draws on. Motion off under prefers-reduced-motion. */
.gullycore-sharebar { display: grid; gap: 6px; min-width: 0; }
.gullycore-locks--badge .gullycore-sharebar { min-width: 180px; }
.gullycore-sharebar__track { height: 8px; border-radius: 999px; overflow: hidden; background: var(--gullycore-bg-sunken); }
.gullycore-sharebar__grow { display: flex; height: 100%; transform-origin: left center; animation: gullycore-grow 0.9s cubic-bezier(0.22, 1, 0.36, 1) both; }
.gullycore-sharebar__part { flex: 0 0 auto; height: 100%; }
.gullycore-sharebar__part + .gullycore-sharebar__part { box-shadow: inset 2px 0 0 var(--gullycore-bg); }
.gullycore-sharebar__part--permanent, .gullycore-sharebar__part--lp { background: var(--gullycore-success); }
.gullycore-sharebar__part--time, .gullycore-sharebar__part--unvested { background: var(--gullycore-accent); }
.gullycore-sharebar__part--vested { background: var(--gullycore-accent); opacity: 0.45; }
.gullycore-sharebar__key { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 2px 12px; font-size: 11px; color: var(--gullycore-text-muted); font-variant-numeric: tabular-nums; }
.gullycore-sharebar__key li { display: inline-flex; align-items: center; gap: 5px; }
.gullycore-sharebar__sw { display: inline-block; width: 8px; height: 8px; border-radius: 2px; }
.gullycore-spark { margin: 2px 0 0; display: grid; gap: 4px; }
.gullycore-spark__svg { display: block; width: 100%; height: 44px; overflow: visible; cursor: crosshair; border-radius: 4px; }
.gullycore-spark__svg:focus-visible { outline: 2px solid var(--gullycore-focus); outline-offset: 2px; }
.gullycore-spark__base { stroke: var(--gullycore-border); stroke-width: 1; }
.gullycore-spark__line { stroke: var(--gullycore-accent); stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; stroke-dasharray: 2000; animation: gullycore-draw 1.3s cubic-bezier(0.22, 1, 0.36, 1) both; }
.gullycore-spark__now { stroke: var(--gullycore-text-muted); stroke-width: 1; stroke-dasharray: 3 3; }
.gullycore-spark__cross { stroke: var(--gullycore-accent); stroke-width: 1; opacity: 0.6; }
.gullycore-spark__cap { font-size: 11px; color: var(--gullycore-text-muted); overflow-wrap: anywhere; }
.gullycore-locks .gullycore-progress-fill, .gullycore-locker .gullycore-progress-fill { transform-origin: left center; animation: gullycore-grow 0.9s cubic-bezier(0.22, 1, 0.36, 1) both; }
@keyframes gullycore-grow { from { transform: scaleX(0.02); } to { transform: scaleX(1); } }
@keyframes gullycore-draw { from { stroke-dashoffset: 2000; } to { stroke-dashoffset: 0; } }
@media (prefers-reduced-motion: reduce) {
  .gullycore-sharebar__grow, .gullycore-spark__line, .gullycore-locks .gullycore-progress-fill, .gullycore-locker .gullycore-progress-fill { animation: none; transform: none; stroke-dashoffset: 0; }
}

/* ============================================================================
   Token trust (TokenTrustPanel): labelled rows, each with its source.
   ============================================================================ */
.gullycore-trust { max-width: none; gap: 8px; }
.gullycore-trust__list { margin: 0; display: grid; gap: 0; }
.gullycore-trust__row { display: grid; grid-template-columns: minmax(120px, 180px) 1fr; gap: 4px 14px; padding: 9px 0; border-top: 1px solid var(--gullycore-border); min-width: 0; }
.gullycore-trust__row:first-child { border-top: 0; }
@media (max-width: 520px) { .gullycore-trust__row { grid-template-columns: 1fr; } }
.gullycore-trust__label { color: var(--gullycore-text-muted); font-size: var(--gullycore-font-size-sm); font-weight: 600; }
.gullycore-trust__value { margin: 0; min-width: 0; display: grid; gap: 3px; }
.gullycore-trust__headline { margin: 0; display: flex; align-items: baseline; gap: 8px; font-weight: 600; overflow-wrap: anywhere; }
.gullycore-trust__detail { margin: 0; font-size: var(--gullycore-font-size-sm); color: var(--gullycore-text-muted); overflow-wrap: anywhere; }
.gullycore-trust__source { margin: 0; display: flex; flex-wrap: wrap; gap: 2px 10px; font-family: var(--gullycore-font-mono); font-size: 11px; color: var(--gullycore-text-muted); overflow-wrap: anywhere; }
.gullycore-trust__source a { color: inherit; text-decoration: underline; text-decoration-color: var(--gullycore-border-strong); }
.gullycore-trust__source a:hover { color: var(--gullycore-accent); }
.gullycore-trust__dot { flex: 0 0 auto; width: 9px; height: 9px; border-radius: 50%; background: var(--gullycore-border-strong); transform: translateY(-1px); }
.gullycore-trust__dot--locked { background: var(--gullycore-success); }
.gullycore-trust__dot--neutral { background: var(--gullycore-text-muted); }
.gullycore-trust__dot--caution { background: var(--gullycore-warning); }
.gullycore-trust__dot--flagged, .gullycore-trust__dot--error { background: var(--gullycore-danger); }
.gullycore-trust__row[data-tone="flagged"] .gullycore-trust__headline, .gullycore-trust__row[data-tone="error"] .gullycore-trust__headline { color: var(--gullycore-danger); }
.gullycore-trust__subhead { margin: 6px 0 0; font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--gullycore-text-muted); }
.gullycore-trust__pool { display: grid; gap: 4px; padding: 10px 12px; border: 1px solid var(--gullycore-border); border-radius: var(--gullycore-radius-sm); background: var(--gullycore-bg-elevated); min-width: 0; }
.gullycore-trust__pool-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 12px; }
.gullycore-trust__pool-head code { font-family: var(--gullycore-font-mono); font-size: 11px; color: var(--gullycore-text-muted); }
.gullycore-trust__found { margin: 0; font-size: 11px; color: var(--gullycore-text-muted); }
.gullycore-trust__link { font-size: var(--gullycore-font-size-sm); color: var(--gullycore-accent); text-decoration: none; font-weight: 600; margin-left: auto; }
.gullycore-trust__link:hover { text-decoration: underline; }
.gullycore-trust__state { margin: 0; color: var(--gullycore-text-muted); }
.gullycore-trust__state--error { color: var(--gullycore-danger); }
.gullycore-trust__retry { font: inherit; background: none; border: 0; padding: 0; color: var(--gullycore-accent); cursor: pointer; text-decoration: underline; }

/* ============================================================================
   Locker (LockerWidget): lock a position, lock or vest tokens, manage locks.
   ============================================================================ */
.gullycore-locker { gap: 10px; }
.gullycore-locker__tabs { display: flex; gap: 4px; padding: 3px; border-radius: 999px; background: var(--gullycore-bg-sunken); }
.gullycore-locker__tab { flex: 1; font: inherit; font-size: var(--gullycore-font-size-sm); font-weight: 600; padding: 7px 10px; border: 0; border-radius: 999px; background: transparent; color: var(--gullycore-text-muted); cursor: pointer; }
.gullycore-locker__tab[aria-selected="true"] { background: var(--gullycore-bg); color: var(--gullycore-text); box-shadow: var(--gullycore-shadow); }
.gullycore-locker__field { display: grid; gap: 4px; font-size: var(--gullycore-font-size-sm); }
.gullycore-locker__field > span { color: var(--gullycore-text-muted); font-weight: 600; }
.gullycore-locker__input { width: 100%; font: inherit; padding: 10px 12px; border-radius: var(--gullycore-radius-sm); border: 1px solid var(--gullycore-border); background: var(--gullycore-bg-elevated); color: var(--gullycore-text); outline: none; min-width: 0; }
.gullycore-locker__input:focus { border-color: var(--gullycore-accent); }
.gullycore-locker__row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
@media (max-width: 420px) { .gullycore-locker__row2 { grid-template-columns: 1fr; } }
.gullycore-locker__issues { margin: 0; padding-left: 18px; color: var(--gullycore-danger); font-size: var(--gullycore-font-size-sm); }
.gullycore-locker__fee { margin: 0; padding: 8px 10px; border-radius: var(--gullycore-radius-sm); background: var(--gullycore-bg-elevated); font-size: var(--gullycore-font-size-sm); display: grid; gap: 2px; }
.gullycore-locker__fee strong { font-variant-numeric: tabular-nums; }
.gullycore-locker__steps { margin: 0; padding-left: 18px; display: grid; gap: 2px; font-size: var(--gullycore-font-size-sm); color: var(--gullycore-text-muted); }
.gullycore-locker__steps li[data-state="done"] { color: var(--gullycore-success); }
.gullycore-locker__steps li[data-state="active"] { color: var(--gullycore-text); font-weight: 600; }
.gullycore-locker__status { margin: 0; font-size: var(--gullycore-font-size-sm); overflow-wrap: anywhere; }
.gullycore-locker__status[data-kind="error"] { color: var(--gullycore-danger); }
.gullycore-locker__status[data-kind="success"] { color: var(--gullycore-success); }
.gullycore-locker__actions { display: flex; flex-wrap: wrap; gap: 6px; }
.gullycore-locker__btn { font: inherit; font-size: var(--gullycore-font-size-sm); font-weight: 600; padding: 6px 12px; border-radius: 999px; border: 1px solid var(--gullycore-border-strong); background: var(--gullycore-bg); color: var(--gullycore-text); cursor: pointer; }
.gullycore-locker__btn:hover:not(:disabled) { border-color: var(--gullycore-accent); color: var(--gullycore-accent); }
.gullycore-locker__btn:disabled { opacity: 0.5; cursor: not-allowed; }
.gullycore-locker__choice { display: flex; gap: 12px; flex-wrap: wrap; font-size: var(--gullycore-font-size-sm); }
.gullycore-locker__choice label { display: inline-flex; gap: 6px; align-items: center; cursor: pointer; }

/* ============================================================================
   The Gully Core icon (kit 02-icon/gully-core-icon-orange.svg, loaded as shipped, never
   redrawn). 24 px wide is the kit's minimum; the margin is its clear space
   (the height of the hook's eye at this size).
   ============================================================================ */
.gullycore-brand { display: flex; align-items: center; gap: 6px; margin: 0; font-size: 11px; color: var(--gullycore-text-muted); }
.gullycore-brand__mark { flex: 0 0 auto; width: 24px; height: auto; margin: 4px; display: block; }
.gullycore-brand__spacer { flex: 1; }


/* ============================================================================
   Touch (pointer: coarse): 44px targets, and inputs at 16px so iOS Safari does
   not zoom the host page when a field is focused.
   ============================================================================ */
@media (pointer: coarse) {
  .gullycore-widget input:not([type="checkbox"]):not([type="radio"]):not([type="range"]),
  .gullycore-widget select,
  .gullycore-widget textarea,
  .gullycore-locker input:not([type="checkbox"]):not([type="radio"]):not([type="range"]),
  .gullycore-locker select { font-size: max(16px, 1em); }
  .gullycore-portion, .gullycore-chip, .gullycore-select, .gullycore-settings-trigger, .gullycore-icon-button,
  .gullycore-locker__tab, .gullycore-locker__input, .gullycore-locker__btn, .gullycore-button, .gullycore-token-button { min-height: 44px; }
  .gullycore-locker__choice label { min-height: 44px; }
}
`;

const STYLE_ELEMENT_ID = "gullycore-widgets-styles";

/**
 * Injects the stylesheet into the document once.
 *
 * React hosts call this automatically the first time a styled widget mounts.
 * Hosts that bundle CSS themselves can import `@gullylabs/core-widgets/styles.css`
 * instead and never call it.
 */
export function injectWidgetStyles(target: Document | ShadowRoot | null = globalThis.document ?? null): void {
  if (target === null) return;
  const root: Document | ShadowRoot = target;
  if (root.getElementById(STYLE_ELEMENT_ID) !== null) return;

  const doc = "createElement" in root ? root : root.ownerDocument;
  if (doc === null) return;
  const style = doc.createElement("style");
  style.id = STYLE_ELEMENT_ID;
  style.textContent = WIDGET_CSS;
  const parent = "head" in root && root.head !== null ? root.head : root;
  parent.appendChild(style);
}
