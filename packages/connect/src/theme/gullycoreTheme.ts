/* ============================================================================
   The Gully Core RainbowKit theme.

   Built by taking RainbowKit's own `darkTheme()` as the base and overriding
   every field the brand actually specifies. Starting from `darkTheme()` rather
   than writing a bare object literal is deliberate: RainbowKit's `Theme` type
   grows between minor versions, and a literal would silently ship whatever the
   TypeScript defaults happen to be for a field we never considered. Spreading
   the upstream theme means a new field arrives with a sane dark default instead
   of `undefined`.
   ============================================================================ */

import { darkTheme, type Theme } from '@rainbow-me/rainbowkit'

import {
  GULLYCORE_COLORS as C,
  GULLYCORE_FONTS,
  GULLYCORE_RADII,
  GULLYCORE_SCRIM,
  GULLYCORE_SHADOWS,
} from './tokens.js'

export interface GullyCoreThemeOptions {
  /** Accent used for primary buttons and the connected pill. Defaults to Gully Core emerald. */
  readonly accentColor?: string
  /** Ink drawn on top of `accentColor`. Defaults to the kit's ink (white on emerald is 2.3:1). */
  readonly accentColorForeground?: string
}

const base = darkTheme({
  borderRadius: 'medium',
  fontStack: 'system',
  overlayBlur: 'small',
})

/**
 * Build the Gully Core theme.
 *
 * Pass it to `RainbowKitProvider theme={...}`, or let `GullyCoreWalletProvider` do
 * it for you — that is the default there.
 */
export function gullycoreTheme(options: GullyCoreThemeOptions = {}): Theme {
  const accent = options.accentColor ?? C.gullycoreBlue
  const accentInk = options.accentColorForeground ?? C.void

  return {
    ...base,
    blurs: {
      ...base.blurs,
      modalOverlay: 'blur(6px)',
    },
    colors: {
      ...base.colors,

      accentColor: accent,
      accentColorForeground: accentInk,

      /* the pill RainbowKit renders when nothing is connected */
      connectButtonBackground: C.panel,
      connectButtonInnerBackground: C.panelAlt,
      connectButtonText: C.ink,
      connectButtonBackgroundError: C.error,
      connectButtonTextError: C.inkBright,

      /* modal chrome */
      modalBackdrop: GULLYCORE_SCRIM,
      modalBackground: C.panel,
      modalBorder: C.hairline,
      modalText: C.ink,
      modalTextDim: C.faintInk,
      modalTextSecondary: C.mutedInk,

      /* wallet rows, account sheet */
      menuItemBackground: C.panelAlt,
      profileForeground: C.panel,
      profileAction: C.panelAlt,
      profileActionHover: C.hairlineDark,

      /* buttons inside the modal */
      actionButtonBorder: C.hairline,
      actionButtonBorderMobile: C.hairline,
      actionButtonSecondaryBackground: C.panelAlt,
      closeButton: C.mutedInk,
      closeButtonBackground: C.panelAlt,

      /* borders + state */
      generalBorder: C.hairline,
      generalBorderDim: C.hairlineSoft,
      selectedOptionBorder: C.borderHover,
      connectionIndicator: C.success,
      standby: C.warning,
      error: C.error,

      /* "download a wallet" cards */
      downloadBottomCardBackground: C.codeGround,
      downloadTopCardBackground: C.deepPanel,
    },
    fonts: {
      ...base.fonts,
      body: GULLYCORE_FONTS.body,
    },
    radii: {
      ...base.radii,
      actionButton: GULLYCORE_RADII.btn,
      connectButton: GULLYCORE_RADII.btn,
      menuButton: GULLYCORE_RADII.btn,
      modal: GULLYCORE_RADII.card,
      modalMobile: GULLYCORE_RADII.card,
    },
    shadows: {
      ...base.shadows,
      connectButton: GULLYCORE_SHADOWS.button,
      dialog: GULLYCORE_SHADOWS.card,
      profileDetailsAction: '0 2px 6px rgba(10, 15, 14, 0.55)',
      selectedOption: `0 2px 6px rgba(10, 15, 14, 0.35), 0 0 0 1px ${C.borderHover}`,
      selectedWallet: `0 2px 6px rgba(10, 15, 14, 0.35), 0 0 0 1px ${C.borderHover}`,
      walletLogo: '0 2px 16px rgba(10, 15, 14, 0.55)',
    },
  }
}

/** Ready-made instance for the common case. */
export const GULLYCORE_THEME: Theme = gullycoreTheme()

export { GULLYCORE_COLORS, GULLYCORE_FONTS, GULLYCORE_RADII, GULLYCORE_SHADOWS, GULLYCORE_SCRIM, GULLYCORE_EASE } from './tokens.js'
export type { Theme }
