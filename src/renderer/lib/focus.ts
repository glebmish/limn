import type { FocusTarget } from '../../shared/types'
import { useStore } from '../store'

/** CSS attribute-value escape (quotes + backslashes); paths/ids are otherwise safe. */
function attr(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/** The `data-lr-*` selector a FocusTarget resolves to inside `.gmain`. The diff
 *  case keys on `file:side:line` only — `focusAnchor` never needs the anchor's
 *  hunkRange/lineContent. */
export function lrSelector(a: FocusTarget): string {
  switch (a.kind) {
    case 'summary': return '[data-lr-summary]'
    case 'section': return `[data-lr-section="${attr(a.sectionId)}"]`
    case 'file': return `[data-lr-file="${attr(a.file)}"]`
    case 'diff': return `[data-lr-line="${attr(`${a.file}:${a.side}:${a.line}`)}"]`
  }
}

const FLASH_MS = 1500

function scrollWithin(main: HTMLElement, el: HTMLElement): void {
  const top = el.getBoundingClientRect().top - main.getBoundingClientRect().top + main.scrollTop - 64
  main.scrollTo({ top: Math.max(0, top), behavior: 'smooth' })
}

function flash(el: HTMLElement): void {
  const badge = document.createElement('div')
  badge.className = 'lr-focus-badge'
  badge.textContent = 'focus'
  document.body.appendChild(badge)
  const r = el.getBoundingClientRect()
  badge.style.top = `${Math.max(8, r.top + 4)}px`
  badge.style.left = `${Math.max(8, r.right - 52)}px`

  if (window.lrDev?.holdFocus) {
    // dev: a static highlight (the animation ends transparent) for a clean capture
    el.classList.add('lr-flash-hold')
    return
  }
  // re-trigger the CSS animation even if the element is already flashed
  el.classList.remove('lr-flash')
  void el.offsetWidth
  el.classList.add('lr-flash')
  window.setTimeout(() => {
    el.classList.remove('lr-flash')
    badge.remove()
  }, FLASH_MS)
}

/** Scroll the review to a target and briefly highlight it. Ensures the target is
 *  rendered first (a collapsed/viewed file or a reviewed section is force-shown via
 *  a transient `focusTarget`, without touching `viewedAt`/`reviewedSections`), then
 *  resolves the `data-lr-*` node and flashes it. Reused by focus chips. */
export function focusAnchor(anchor: FocusTarget): void {
  const st = useStore.getState()
  st.setFocusTarget(
    anchor.kind === 'section' ? { sectionId: anchor.sectionId }
      : anchor.kind === 'file' || anchor.kind === 'diff' ? { file: anchor.file }
        : null
  )
  const sel = lrSelector(anchor)
  let tries = 0
  const tick = (): void => {
    const main = document.querySelector<HTMLElement>('.gmain')
    const el = main?.querySelector<HTMLElement>(sel) ?? null
    if (main && el) { scrollWithin(main, el); flash(el); return }
    if (tries++ < 8) window.setTimeout(() => requestAnimationFrame(tick), 40)
  }
  requestAnimationFrame(tick)
}
