import type { FocusTarget } from '../../shared/types'
import { effectiveSections, useStore } from '../store'
import { dev } from '../dev'

/** CSS attribute-value escape (quotes + backslashes); paths/ids are otherwise safe. */
function attr(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/** The `data-limn-*` selector a FocusTarget resolves to inside `.gmain`. The diff
 *  case keys on `file:side:line` only — `focusAnchor` never needs the anchor's
 *  hunkRange/lineContent. */
export function limnSelector(a: FocusTarget): string {
  switch (a.kind) {
    case 'summary': return '[data-limn-summary]'
    case 'section': return `[data-limn-section="${attr(a.sectionId)}"]`
    case 'file': return `[data-limn-file="${attr(a.file)}"]`
    case 'diff': return `[data-limn-line="${attr(`${a.file}:${a.side}:${a.line}`)}"]`
  }
}

const FLASH_MS = 1500
// px of the file header we try to keep in view above a line jump
const HEADER_GAP = 64

// offset of an element's top within the scroll container
function offsetTop(main: HTMLElement, el: HTMLElement): number {
  return el.getBoundingClientRect().top - main.getBoundingClientRect().top + main.scrollTop
}

// Jumps are instant (NOT smooth): smooth animates the whole container and reads as
// slow, and the flash has to wait for it to settle. Instant lands in one frame so
// we can flash right after.
function scrollWithin(main: HTMLElement, el: HTMLElement): void {
  const top = offsetTop(main, el) - HEADER_GAP
  main.scrollTo({ top: Math.max(0, top), behavior: 'instant' as ScrollBehavior })
}

// Line jump: prefer to keep the file header in view (header near the top, line
// below it); if the line sits too far below its header to show both, center the
// line instead so it's never pinned to the very top with no context.
function scrollLineWithin(main: HTMLElement, line: HTMLElement, header: HTMLElement | null): void {
  const lineTop = offsetTop(main, line)
  const viewH = main.clientHeight
  let top: number
  if (header && lineTop - offsetTop(main, header) <= viewH - HEADER_GAP - 40) {
    top = offsetTop(main, header) - HEADER_GAP
  } else {
    top = lineTop - viewH / 2
  }
  main.scrollTo({ top: Math.max(0, top), behavior: 'instant' as ScrollBehavior })
}

function flash(el: HTMLElement): void {
  const badge = document.createElement('div')
  badge.className = 'limn-focus-badge'
  badge.textContent = 'focus'
  document.body.appendChild(badge)
  const r = el.getBoundingClientRect()
  badge.style.top = `${Math.max(8, r.top + 4)}px`
  badge.style.left = `${Math.max(8, r.right - 52)}px`

  if (dev.holdFocus) {
    // dev: a static highlight (the animation ends transparent) for a clean capture
    el.classList.add('limn-flash-hold')
    return
  }
  // re-trigger the CSS animation even if the element is already flashed
  el.classList.remove('limn-flash')
  void el.offsetWidth
  el.classList.add('limn-flash')
  window.setTimeout(() => {
    el.classList.remove('limn-flash')
    badge.remove()
  }, FLASH_MS)
}

/** Scroll the review to a target and briefly highlight it. Ensures the target is
 *  rendered first (a collapsed/viewed file or a reviewed section is force-shown via
 *  a transient `focusTarget`, without touching `viewedAt`/`reviewedSections`), then
 *  resolves the `data-limn-*` node and flashes it. Reused by focus chips. */
// Scroll the target into place, re-applying across a few frames (force-rendered
// diffs lay out over several frames, so the first instant scroll can land short),
// and flash only once it actually sits inside the viewport — scroll FIRST, focus
// AFTER, so the badge never appears at the old position before the jump lands.
function settleScrollThenFlash(main: HTMLElement, el: HTMLElement, anchor: FocusTarget): void {
  let settle = 0
  const step = (): void => {
    if (anchor.kind === 'diff') {
      const header = main.querySelector<HTMLElement>(`[data-limn-file="${attr(anchor.file)}"]`)
      scrollLineWithin(main, el, header)
    } else {
      scrollWithin(main, el)
    }
    const r = el.getBoundingClientRect()
    const mr = main.getBoundingClientRect()
    const inView = r.top >= mr.top - 1 && r.top <= mr.bottom
    if (inView || settle++ > 6) flash(el)
    else requestAnimationFrame(step)
  }
  requestAnimationFrame(step)
}

export function focusAnchor(anchor: FocusTarget): void {
  const st = useStore.getState()
  // A jump from an open spec/plan must return to the changes view first, or the
  // target diff/section/file node won't exist to scroll to (the retry loop below
  // covers the few frames the changes list takes to remount).
  if (st.docPath) st.closeDoc()
  // A file/line jump must also force-OPEN the section that holds the file: a
  // collapsed section renders none of its diffs, so the target node would never
  // exist. Set both sectionId and file on the transient focus target.
  let secId: string | undefined
  if (anchor.kind === 'file' || anchor.kind === 'diff') {
    secId = effectiveSections(st.loaded).find((s) => s.files.includes(anchor.file))?.id
    if (secId) st.openSection(secId)
  }
  st.setFocusTarget(
    anchor.kind === 'section' ? { sectionId: anchor.sectionId }
      : anchor.kind === 'file' || anchor.kind === 'diff' ? { file: anchor.file, ...(secId ? { sectionId: secId } : {}) }
        : null
  )
  const sel = limnSelector(anchor)
  let tries = 0
  const tick = (): void => {
    const main = document.querySelector<HTMLElement>('.gmain')
    const el = main?.querySelector<HTMLElement>(sel) ?? null
    if (main && el) { settleScrollThenFlash(main, el, anchor); return }
    if (tries++ < 12) window.setTimeout(() => requestAnimationFrame(tick), 40)
  }
  requestAnimationFrame(tick)
}
