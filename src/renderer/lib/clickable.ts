import type { KeyboardEvent } from 'react'

/** Spread onto a non-<button> element to make it a real keyboard- and
 *  screen-reader-operable control (Enter/Space activate), matching the
 *  picker-option pattern used across the app. Pass `expanded` for a disclosure
 *  control, `label` for an icon-only control. */
export function clickable(
  onActivate: () => void,
  opts: { expanded?: boolean; label?: string } = {}
) {
  return {
    role: 'button' as const,
    tabIndex: 0,
    onClick: onActivate,
    onKeyDown: (e: KeyboardEvent) => {
      // Only when the key originated on THIS element — not bubbled up from an
      // interactive child (a scope button / checkbox inside a clickable header,
      // a comment "+" inside a clickable row), which would otherwise double-fire.
      // On the simple rows children aren't focusable, so this is a no-op there.
      if (e.target !== e.currentTarget) return
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onActivate() }
    },
    ...(opts.expanded !== undefined ? { 'aria-expanded': opts.expanded } : {}),
    ...(opts.label ? { 'aria-label': opts.label } : {}),
  }
}
