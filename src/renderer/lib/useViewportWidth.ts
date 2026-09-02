import { useSyncExternalStore } from 'react'

/** The width assumed when there is no `window` (server render / a non-DOM test
 *  import). Deliberately generous: a wide viewport means the panel widths pass
 *  through their guard untouched, so the first client render is the one that
 *  narrows them rather than the other way round. */
export const SSR_VIEWPORT_WIDTH = 1600

function subscribe(onChange: () => void): () => void {
  window.addEventListener('resize', onChange)
  return () => window.removeEventListener('resize', onChange)
}

function getSnapshot(): number {
  return typeof window === 'undefined' ? SSR_VIEWPORT_WIDTH : window.innerWidth
}

function getServerSnapshot(): number {
  return SSR_VIEWPORT_WIDTH
}

/** The live viewport width, re-rendering the caller on `resize`. The review shell
 *  needs it to re-derive the panels' effective widths (see `effectiveWidths`): the
 *  stored width is a *preference*, and shrinking the window has to squeeze the
 *  panels without overwriting it. */
export function useViewportWidth(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}
