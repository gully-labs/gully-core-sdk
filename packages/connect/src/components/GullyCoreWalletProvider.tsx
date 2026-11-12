/* ============================================================================
   The one component an app mounts.

   Nesting order is not stylistic — it is required:

     WagmiProvider  ->  QueryClientProvider  ->  RainbowKitProvider

   wagmi v2 runs every read through TanStack Query, so a `useReadContract` under
   a WagmiProvider with no QueryClient above it throws at render. RainbowKit
   consumes both, so it goes innermost.
   ============================================================================ */

import { MutationCache, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RainbowKitProvider, type AvatarComponent, type Theme } from '@rainbow-me/rainbowkit'
import { useMemo, type ReactNode } from 'react'
import type { Chain } from 'viem'
import { WagmiProvider, type Config } from 'wagmi'

import { GULLYCORE_DEFAULT_CHAIN } from '../chains/index.js'
import { createGullyCoreConfig } from '../config/createGullyCoreConfig.js'
import { gullycoreTheme } from '../theme/gullycoreTheme.js'

export interface GullyCoreWalletProviderProps {
  readonly children: ReactNode

  /**
   * A wagmi config from `createGullyCoreConfig`.
   *
   * Strongly preferred over letting this component build one: a config created
   * inside a component is memoised per mount, and a remount (React StrictMode
   * double-invoke, a route-level key change, an HMR boundary) rebuilds every
   * connector and drops the live session.
   */
  readonly config?: Config

  /** Share the app's existing QueryClient. One is created if omitted. */
  readonly queryClient?: QueryClient

  /** Defaults to the Gully Core theme. */
  readonly theme?: Theme | null

  /**
   * Chain the connect modal targets for a fresh connection. Defaults to
   * HyperEVM (999), Gully Core's launch chain.
   */
  readonly initialChain?: Chain | number

  readonly appName?: string
  /** Rendered in the modal's "what is a wallet" panel. */
  readonly learnMoreUrl?: string
  readonly modalSize?: 'compact' | 'wide'
  /** Custom account avatar. Defaults to RainbowKit's gradient avatar. */
  readonly avatar?: AvatarComponent

  /** Show wagmi's pending-transaction indicator on the connected pill. */
  readonly showRecentTransactions?: boolean
}

/**
 * Default QueryClient tuning.
 *
 * `retry: 2` rather than TanStack's default of 3, and a 12s stale time: several
 * Gully Core chains are served by exactly one rate-limited public RPC, and an
 * aggressive retry storm against those is how a page ends up 429'd for the whole
 * session. `refetchOnWindowFocus: false` for the same reason — an alt-tab should
 * not re-run every on-chain read.
 */
/** The app's toast channel: a window event, so this package needs no toast library and the app decides how it looks
    (apps/web/src/lib/toast.ts listens). Every wallet action (a send, a contract write, a signature) reports here. */
export const GULLYCORE_TOAST_EVENT = 'gullycore:toast'

function say(kind: 'info' | 'success' | 'error', title: string, detail?: string): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(GULLYCORE_TOAST_EVENT, { detail: { kind, title, detail } }))
}

/** A wallet refusal is not an error worth shouting about; a revert is. Short, no stack, no hex blobs. */
function reason(e: unknown): string {
  const m = e instanceof Error ? (e as { shortMessage?: string }).shortMessage ?? e.message : String(e)
  const first = m.split(/\r?\n/)[0] ?? m
  return first.length > 140 ? `${first.slice(0, 137)}...` : first
}

/** What each wagmi mutation says when it starts, finishes and fails. A key not listed is silent. */
const MUTATION_TOASTS: Readonly<Record<string, { start?: string; done: string; fail: string }>> = {
  writeContract: { start: 'Confirm in your wallet', done: 'Sent. Waiting for the chain.', fail: 'Transaction failed' },
  sendTransaction: { start: 'Confirm in your wallet', done: 'Sent. Waiting for the chain.', fail: 'Transaction failed' },
  sendCalls: { start: 'Confirm in your wallet', done: 'Sent. Waiting for the chain.', fail: 'Transaction failed' },
  signMessage: { start: 'Sign in your wallet', done: 'Signed', fail: 'Signing failed' },
  signTypedData: { start: 'Sign in your wallet', done: 'Signed', fail: 'Signing failed' },
  switchChain: { start: 'Switching network', done: 'Network switched', fail: 'Could not switch network' },
  connect: { done: 'Wallet connected', fail: 'Could not connect' },
  disconnect: { done: 'Wallet disconnected', fail: 'Could not disconnect' },
}
const keyOf = (m: { options: { mutationKey?: readonly unknown[] } }): string => String(m.options.mutationKey?.[0] ?? '')

function makeQueryClient(): QueryClient {
  return new QueryClient({
    mutationCache: new MutationCache({
      onMutate: (_v, m) => {
        const t = MUTATION_TOASTS[keyOf(m)]
        if (t?.start !== undefined) say('info', t.start)
      },
      onSuccess: (_d, _v, _c, m) => {
        const t = MUTATION_TOASTS[keyOf(m)]
        if (t !== undefined) say('success', t.done)
      },
      onError: (e, _v, _c, m) => {
        const t = MUTATION_TOASTS[keyOf(m)]
        if (t === undefined) return
        const why = reason(e)
        if (/reject|denied|cancel/i.test(why)) say('info', 'Cancelled in your wallet')
        else say('error', t.fail, why)
      },
    }),
    defaultOptions: {
      queries: {
        retry: 2,
        staleTime: 12_000,
        refetchOnWindowFocus: false,
      },
    },
  })
}

export function GullyCoreWalletProvider({
  children,
  config,
  queryClient,
  theme,
  initialChain = GULLYCORE_DEFAULT_CHAIN,
  appName = 'Gully Core',
  learnMoreUrl,
  modalSize = 'compact',
  avatar,
  showRecentTransactions = false,
}: GullyCoreWalletProviderProps) {
  // Both fall back to a lazily-created singleton for the convenience case. The
  // empty dep arrays are intentional: rebuilding either at runtime is the bug
  // this memo exists to prevent, so a changed `config` prop is honoured directly
  // below instead.
  const fallbackConfig = useMemo(() => createGullyCoreConfig({ appName }), [appName])
  const fallbackQueryClient = useMemo(makeQueryClient, [])

  const resolvedTheme = useMemo(() => (theme === undefined ? gullycoreTheme() : theme), [theme])

  const appInfo = useMemo(
    () => (learnMoreUrl === undefined ? { appName } : { appName, learnMoreUrl }),
    [appName, learnMoreUrl],
  )

  return (
    <WagmiProvider config={config ?? fallbackConfig}>
      <QueryClientProvider client={queryClient ?? fallbackQueryClient}>
        <RainbowKitProvider
          theme={resolvedTheme}
          appInfo={appInfo}
          initialChain={initialChain}
          modalSize={modalSize}
          showRecentTransactions={showRecentTransactions}
          {...(avatar === undefined ? {} : { avatar })}
        >
          {children}
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  )
}
