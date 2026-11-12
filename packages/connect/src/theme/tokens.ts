/* ============================================================================
   Gully Core brand values, transcribed from `apps/web/src/styles/tokens.css`, which
   is itself transcribed from "gullycore design/README.md" § Design tokens.

   Why literals and not `var(--gullycore-blue)`: RainbowKit's theme object is read by
   its own vanilla-extract runtime, and several fields are composed into inline
   styles and canvas fills where a CSS custom property does not resolve. A
   package must also render correctly when mounted in a host that never loaded
   Gully Core's token sheet. The literals below are therefore the source of truth for
   THIS package, and they must be kept in step with tokens.css by hand.

   The design commits to a single dark world (Void ground). There is deliberately
   no light theme; the spec defines none.
   ============================================================================ */

export const GULLYCORE_COLORS = {
  /* brand */
  gullycoreBlue: '#fd7716',
  deepBlue: '#a63f00',
  signalBlue: '#ff9446',
  skyInk: '#ff9446',

  /* grounds */
  void: '#0f0e0b',
  panel: '#1b1913',
  panelAlt: '#24211a',
  codeGround: '#0f0e0b',
  deepPanel: '#1b1913',

  /* lines */
  hairline: '#3a362b',
  hairlineSoft: '#2e2a21',
  hairlineBlue2: '#5a5446',
  hairlineDark: '#2e2a21',
  borderHover: '#ff9446',
  activeNav: '#3a2a14',

  /* ink */
  ink: '#fef4e3',
  inkBright: '#fef4e3',
  mutedInk: '#b9ae98',
  labelInk: '#b9ae98',
  faintInk: '#b9ae98',

  /* status */
  success: '#5fd08a',
  warning: '#f2b04a',
  error: '#ff8a80',
} as const

export const GULLYCORE_FONTS = {
  body: '"Outfit", ui-sans-serif, system-ui, -apple-system, sans-serif',
  mono: '"JetBrains Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace',
  display: '"Outfit", ui-sans-serif, system-ui, sans-serif',
} as const

export const GULLYCORE_RADII = {
  btn: '10px',
  chip: '10px',
  card: '14px',
  sm: '14px',
  pill: '999px',
} as const

export const GULLYCORE_SHADOWS = {
  /* --sh-btn */
  button: '3px 3px 0 #fef4e3',
  /* --sh-card-hover */
  card: '4px 4px 0 #fd7716',
} as const

/** `--header-bg` in tokens.css — the ground the sticky header and modal scrim use. */
export const GULLYCORE_SCRIM = 'rgba(15, 14, 11, 0.82)'

/** README § Interactions & behavior — every timing uses this curve. */
export const GULLYCORE_EASE = 'cubic-bezier(0.22, 0.61, 0.36, 1)'
