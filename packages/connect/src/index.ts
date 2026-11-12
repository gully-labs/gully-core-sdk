/* ============================================================================
   @gullylabs/core-connect — public surface.

   Everything an integrator may import from the package root is listed here by
   name. Nothing is `export *`-ed: the surface of an MIT package that sits on
   the GPL boundary should be auditable at a glance, and a name that is not on
   this list is internal and may change without notice.

   Subpath entries (`./chains`, `./theme`) re-export the same symbols for apps
   that want the chain list or the theme without pulling React into a bundle.
   ============================================================================ */

/* ---------------------------------------------------------------- components */

export { GullyCoreWalletProvider } from './components/GullyCoreWalletProvider.js'
export type { GullyCoreWalletProviderProps } from './components/GullyCoreWalletProvider.js'

export { GullyCoreConnectButton } from './components/GullyCoreConnectButton.js'
export type { GullyCoreConnectButtonProps } from './components/GullyCoreConnectButton.js'

export { GullyCoreChainSwitcher } from './components/GullyCoreChainSwitcher.js'
export type { GullyCoreChainSwitcherProps } from './components/GullyCoreChainSwitcher.js'

/* -------------------------------------------------------------------- config */

export { createGullyCoreConfig, hasWalletConnect } from './config/createGullyCoreConfig.js'
export type { CreateGullyCoreConfigOptions } from './config/createGullyCoreConfig.js'

export { WALLETCONNECT_PROJECT_ID_ENV, walletConnectProjectId } from './config/env.js'

/* -------------------------------------------------------------------- chains */

export {
  /* mainnets — wagmi-curated identity, probed RPC lists */
  mainnet,
  base,
  bsc,
  linea,
  ink,
  xLayer,
  hyperEvm,
  monad,
  plasma,
  robinhood,
  stable,
  /* testnets — none is OFFERED; all three are defined and probed but absent
     from GULLYCORE_CHAINS (see GULLYCORE_UNLISTED_CHAINS) */
  sepolia,
  stableTestnet,
  arcTestnet,
  /* lists */
  GULLYCORE_CHAINS,
  GULLYCORE_MAINNET_CHAINS,
  GULLYCORE_TESTNET_CHAINS,
  gullyChainTestnet,
  GULLYCORE_UNLISTED_CHAINS,
  GULLYCORE_DEPLOYED_CHAIN_IDS,
  GULLYCORE_DEFAULT_CHAIN,
  GULLYCORE_PUBLIC_RPCS,
  /* audit surface */
  SINGLE_ENDPOINT_CHAIN_IDS,
  THIN_ENDPOINT_CHAIN_IDS,
  UNVERIFIED_CHAIN_METADATA,
  /* helpers */
  isGullyCoreDeployedChain,
  gullycoreChainById,
} from './chains/index.js'

/* --------------------------------------------------------------------- theme */

export { gullycoreTheme, GULLYCORE_THEME } from './theme/index.js'
export type { GullyCoreThemeOptions, Theme } from './theme/index.js'
export {
  GULLYCORE_COLORS,
  GULLYCORE_EASE,
  GULLYCORE_FONTS,
  GULLYCORE_RADII,
  GULLYCORE_SCRIM,
  GULLYCORE_SHADOWS,
} from './theme/index.js'
