// SPDX-License-Identifier: MIT
/* ============================================================================
   Chart kit — motion and size.

   Motion: LazyMotion + `m` + domAnimation only (never the full `motion`
   component), so the kit pulls the DOM animation feature set and nothing more.
   Every chart's entry animation is one-shot, starts when the chart scrolls
   into view, and is OFF — the final state painted on the first frame — when:
     · the reader asks for reduced motion (Motion's useReducedMotion, plus
       MotionConfig reducedMotion="user", plus a CSS guard in chartkit.css);
     · there is no IntersectionObserver, or the tab is hidden at first render
       (a background tab or a headless capture must never see empty tracks);
     · on the server (renderToStaticMarkup paints the final state).
   `ChartKitProvider motion="reduce" | "always"` pins it for tests and embeds.
   ============================================================================ */

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { LazyMotion, MotionConfig, useReducedMotion } from 'motion/react'

export type MotionMode = 'auto' | 'reduce' | 'always'

const MotionModeCtx = createContext<MotionMode>('auto')

/** Wraps kit content in the lazy motion features. Every exported component does this itself; use it to pin the mode. */
export function ChartKitProvider({ motion = 'auto', children }: { motion?: MotionMode; children: ReactNode }) {
  return (
    <MotionModeCtx.Provider value={motion}>
      <Kit>{children}</Kit>
    </MotionModeCtx.Provider>
  )
}

/** The lazy feature bundle and the reduced-motion policy, for a component's own root. */
/* Loaded on first use, so a page pays for the animation engine only when a chart mounts; until it
   arrives `m` elements render their `initial` (or, unarmed, their final) values as plain SVG. */
const loadFeatures = () => import('./features').then((mod) => mod.default)

export function Kit({ children }: { children: ReactNode }) {
  const mode = useContext(MotionModeCtx)
  return (
    <LazyMotion features={loadFeatures} strict>
      <MotionConfig reducedMotion={mode === 'always' ? 'never' : mode === 'reduce' ? 'always' : 'user'}>{children}</MotionConfig>
    </LazyMotion>
  )
}

function canArm(): boolean {
  if (typeof window === 'undefined' || typeof IntersectionObserver !== 'function' || typeof document === 'undefined') return false
  if (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false
  return document.visibilityState === 'visible'
}

export interface Reveal {
  /** A callback ref: put it on the element whose scroll-in starts the animation (re-mounts are followed). */
  readonly ref: (node: Element | null) => void
  /** True when the entry animation runs at all; false paints the final state at once. */
  readonly armed: boolean
  /** True once the chart should be in its final state (seen, or never armed). */
  readonly play: boolean
}

/** One-shot reveal: armed at the first render (never later, so nothing flashes), played on scroll-in. */
export function useReveal(): Reveal {
  const mode = useContext(MotionModeCtx)
  const reduced = useReducedMotion()
  const [armedAtStart] = useState(() => (mode === 'always' ? true : mode === 'reduce' ? false : canArm()))
  const [node, setNode] = useState<Element | null>(null)
  const ref = useCallback((n: Element | null) => setNode(n), [])
  const [seen, setSeen] = useState(false)
  const armed = armedAtStart && (mode === 'always' || reduced !== true)

  useEffect(() => {
    if (!armed || seen || node === null || typeof IntersectionObserver !== 'function') return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          io.disconnect()
          setSeen(true)
        }
      },
      { threshold: 0.2 },
    )
    io.observe(node)
    /* A tab hidden after arming must not keep the chart parked at zero. */
    const onHide = () => {
      if (document.visibilityState !== 'visible') setSeen(true)
    }
    document.addEventListener('visibilitychange', onHide)
    return () => {
      io.disconnect()
      document.removeEventListener('visibilitychange', onHide)
    }
  }, [armed, seen, node])

  return { ref, armed, play: !armed || seen }
}

const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

/** The element's content box, kept current by a ResizeObserver. Before the first measure (and on the server) the fallback is used. */
export function useSize<T extends HTMLElement>(fallbackWidth = 600, fallbackHeight = 220): { ref: RefObject<T | null>; width: number; height: number; measured: boolean } {
  const ref = useRef<T | null>(null)
  const [size, setSize] = useState<{ width: number; height: number } | null>(null)
  useIsoLayoutEffect(() => {
    const el = ref.current
    if (el === null) return
    const read = () => {
      const r = el.getBoundingClientRect()
      setSize((prev) => (prev !== null && Math.abs(prev.width - r.width) < 0.5 && Math.abs(prev.height - r.height) < 0.5 ? prev : { width: r.width, height: r.height }))
    }
    read()
    if (typeof ResizeObserver !== 'function') return
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const width = size !== null && size.width > 0 ? size.width : fallbackWidth
  const height = size !== null && size.height > 0 ? size.height : fallbackHeight
  return { ref, width, height, measured: size !== null }
}
