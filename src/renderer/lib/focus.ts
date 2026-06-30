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

const BADGE_W = 52
// Place the "focus" chip on the line, but only when the line is genuinely visible in
// the diff viewport. Diff lines run full-width (and can overflow), so anchoring to the
// line's right edge would push the chip over the chat drawer; a line behind the sticky
// file header or scrolled off would peg it to a screen corner. Clamp to .gmain below
// the sticky header, and skip the chip entirely when the line isn't in that band.
function placeBadge(el: HTMLElement): HTMLElement | null {
  const r = el.getBoundingClientRect()
  const main = el.closest<HTMLElement>('.gmain')
  let top: number, left: number
  if (main) {
    const mr = main.getBoundingClientRect()
    const head = el.closest('.gfile')?.querySelector<HTMLElement>('.gfile-head')
    const topMin = (head ? head.getBoundingClientRect().bottom : mr.top) + 2
    // line hidden behind the sticky header, or off the bottom → no chip
    if (r.bottom <= topMin || r.top >= mr.bottom) return null
    top = Math.min(Math.max(r.top + 4, topMin), mr.bottom - 20)
    left = Math.min(Math.max(r.right - BADGE_W, mr.left + 8), mr.right - BADGE_W - 8)
  } else {
    top = Math.max(8, r.top + 4)
    left = Math.max(8, r.right - BADGE_W)
  }
  const badge = document.createElement('div')
  badge.className = 'limn-focus-badge'
  badge.textContent = 'focus'
  badge.style.top = `${top}px`
  badge.style.left = `${left}px`
  document.body.appendChild(badge)
  return badge
}

function flash(el: HTMLElement): void {
  const badge = placeBadge(el)

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
    badge?.remove()
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
  // Jumping TO a section opens it imperatively (via openSection), so the arrival
  // expands it but it's still freely collapsible afterward — selection landing on a
  // section must never pin it permanently open. A file/line jump instead force-OPENs
  // the section that holds the file through the TRANSIENT focus target: a collapsed
  // section renders none of its diffs, so the target node would never exist; routing
  // it through focusTarget (not openSection) means only the jumped section opens, and
  // it returns to its natural state once the next jump moves focus on.
  if (anchor.kind === 'section') {
    st.openSection(anchor.sectionId)
    st.setFocusTarget(null)
  } else {
    let secId: string | undefined
    if (anchor.kind === 'file' || anchor.kind === 'diff') {
      secId = effectiveSections(st.loaded).find((s) => s.files.includes(anchor.file))?.id
    }
    st.setFocusTarget(
      anchor.kind === 'file' || anchor.kind === 'diff'
        ? { file: anchor.file, ...(secId ? { sectionId: secId } : {}) }
        : null
    )
  }
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
