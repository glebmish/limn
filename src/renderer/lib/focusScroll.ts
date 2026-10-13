import type { FocusTarget } from '../../shared/types'
import { dev } from '../dev'

/** CSS attribute-value escape (quotes + backslashes); paths/ids are otherwise safe. */
function attr(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/** One diff line's selector. An old-side line also matches the `data-limn-line-old`
 *  alias a Unified context row carries (DiffBody): that row is addressed by its now
 *  number, but it shows — and hosts comments on — its base number too. */
function lineSelector(file: string, side: 'old' | 'new', line: number): string {
  const k = attr(`${file}:${side}:${line}`)
  return side === 'old' ? `[data-limn-line="${k}"],[data-limn-line-old="${k}"]` : `[data-limn-line="${k}"]`
}

/** The `data-limn-*` selector a FocusTarget resolves to inside `.gmain`. The diff
 *  case keys on `file:side:line` only — a jump never needs the anchor's
 *  hunkRange/lineContent. */
export function limnSelector(a: FocusTarget): string {
  switch (a.kind) {
    case 'summary': return '[data-limn-summary]'
    case 'section': return `[data-limn-section="${attr(a.sectionId)}"]`
    case 'file': return `[data-limn-file="${attr(a.file)}"]`
    case 'diff': return lineSelector(a.file, a.side, a.line)
  }
}

/** Hard cap on the rows one jump highlights. A bad `endLine` (a nonsense agent range,
 *  or an anchor whose end never re-mapped) must not paint a whole file — and the cap
 *  cannot tell that case from a genuinely long range, so a legitimate 100+ line anchor
 *  is truncated too. That is the deliberate trade: a truncated highlight still starts
 *  on the right line and still reads as "this region", where an uncapped one can wash
 *  out the whole file and hide the jump it was meant to point at. */
export const MAX_FOCUS_LINES = 100

/** Every node a jump highlights, the one it scrolls to and badges first. A diff
 *  anchor with an `endLine` covers `line`..`endLine`; every other target is a single
 *  node. The set is exact by construction — nothing outside the anchor is in it — and
 *  the previous jump's set is removed before a new one starts (`cancelFocusJump`), so
 *  stops can neither leak highlights into each other nor stack FOCUS badges (#19). */
export function focusSelectors(a: FocusTarget): string[] {
  if (a.kind !== 'diff') return [limnSelector(a)]
  const end = typeof a.endLine === 'number' && Number.isFinite(a.endLine) && a.endLine > a.line
    ? Math.min(a.endLine, a.line + MAX_FOCUS_LINES - 1)
    : a.line
  const out: string[] = []
  for (let n = a.line; n <= end; n++) out.push(lineSelector(a.file, a.side, n))
  return out
}

// ── settle state machine ──────────────────────────────────────
// A jump cannot be a one-shot scroll. `.gfile-diff` is `content-visibility:auto`
// with an estimated `contain-intrinsic-height` (lib/diffHeight.ts), so every off-screen
// file body is a placeholder whose rows have NO layout box at all. Offsets read from such a
// row are fiction, and the bodies that lay out as the viewport passes them move
// everything below. So: re-measure each frame, scroll again while the goal keeps
// moving, and only flash once the goal has held still for a few frames.

/** px of slop between the goal and the container's actual scrollTop that counts as
 *  arrived (sub-pixel layout, and a scrollTop the browser clamps). */
export const SETTLE_TOL = 1
/** consecutive frames the goal must hold before the jump is considered landed */
export const SETTLE_STABLE_FRAMES = 3
/** frames spent settling *after* the target first had a box, before landing anyway
 *  (≈800ms at 60Hz — a budget in frames, since it is layout frames we are waiting on) */
export const SETTLE_MAX_FRAMES = 48
/** frames to keep waiting for a target that has no box yet (a doc view closing, a
 *  section force-opening, a skipped subtree laying out) before giving up (≈1.5s at 60Hz) */
export const SETTLE_MISSING_FRAMES = 90

export type SettleState = {
  /** frames elapsed since the jump started */
  frames: number
  /** frames the target has had a measurable box */
  seen: number
  /** consecutive frames the container has already been at the goal */
  stable: number
}
/** `scroll` apply the goal and keep looping · `wait` keep looping (nothing measurable
 *  yet — the caller may still scroll toward an approach position) · `land` apply the
 *  goal one last time, then flash and stop · `abandon` stop, the target never rendered. */
export type SettleAction = 'scroll' | 'wait' | 'land' | 'abandon'

export const settleStart: SettleState = { frames: 0, seen: 0, stable: 0 }

/** One frame of the jump loop. `delta` is how far the container still has to scroll
 *  for the target to sit where we want it, or `null` while the target has no
 *  trustworthy box (not mounted yet, or still a skipped `content-visibility` subtree). */
export function settleStep(s: SettleState, delta: number | null): { state: SettleState; action: SettleAction } {
  const frames = s.frames + 1
  if (delta === null) {
    const state = { frames, seen: s.seen, stable: 0 }
    return { state, action: frames >= SETTLE_MISSING_FRAMES ? 'abandon' : 'wait' }
  }
  const seen = s.seen + 1
  const last = seen >= SETTLE_MAX_FRAMES
  if (Math.abs(delta) > SETTLE_TOL) {
    return { state: { frames, seen, stable: 0 }, action: last ? 'land' : 'scroll' }
  }
  const stable = s.stable + 1
  return { state: { frames, seen, stable }, action: stable >= SETTLE_STABLE_FRAMES || last ? 'land' : 'wait' }
}

// ── the jump ──────────────────────────────────────────────────

const FLASH_MS = 1500
/** px of breathing room between the pinned page header and a landed target */
export const JUMP_GAP = 12
/** px of the file header (plus a little) kept in view above a line jump */
const HEADER_GAP = 64
const BADGE_W = 52

/** Height of the review's pinned page header (`.page-head`, sticky at the top of
 *  `.gmain`). Everything that lands a scroll target has to clear it, or the target
 *  sits behind it — on a narrow viewport the wrapped title makes it ~3× taller than
 *  on a desktop, which is what turned "slightly under" into "not on screen at all".
 *  `useReviewScroll` publishes the live height as `--limn-head-h` on `.gmain` (the
 *  sticky file headers stick below it by the same var); read that, and fall back to
 *  measuring the element when the var is not set yet. */
export function pinnedTop(main: HTMLElement): number {
  const v = parseFloat(main.style.getPropertyValue('--limn-head-h'))
  if (Number.isFinite(v)) return v
  return main.querySelector<HTMLElement>('.page-head')?.offsetHeight ?? 0
}

/** The scrollTop that lands a jump. Pure: every input is a content offset within the
 *  scroll container (already corrected for sticky rects), so this can be tested
 *  without a layout engine. `pinned` is the pinned page header's height.
 *  - a block target (file / section / summary) sits `JUMP_GAP` below the pinned head;
 *  - a diff line keeps its file header in view when both fit (`'head'`: the file
 *    header just under the pinned head, the line below it), otherwise centres the
 *    line in the band below the pinned head so it is never the very top row with no
 *    context — and never behind the header either way. */
export function jumpGoal(a: {
  kind: FocusTarget['kind']
  top: number
  headTop: number | null
  viewH: number
  pinned: number
  place?: 'head' | 'centre' | null
}): { goal: number; place: 'head' | 'centre' | null } {
  if (a.kind !== 'diff') return { goal: a.top - a.pinned - JUMP_GAP, place: null }
  const band = a.viewH - a.pinned
  const place = a.place ?? (a.headTop !== null && a.top - a.headTop <= band - HEADER_GAP - 40 ? 'head' : 'centre')
  if (place === 'head' && a.headTop !== null) return { goal: a.headTop - a.pinned - JUMP_GAP, place }
  return { goal: a.top - a.pinned - band / 2, place }
}

/** Sticky elements report their *stuck* rect, so a jump that measured one would
 *  chase its own scroll (`.gfile-head` is sticky under the pinned page header).
 *  Measure the file block that carries the header instead — it never moves. */
function stableEl(el: HTMLElement): HTMLElement {
  return el.classList.contains('gfile-head') ? el.closest<HTMLElement>('.gfile') ?? el : el
}

/** A node inside a skipped `content-visibility:auto` subtree has no box: an empty
 *  rect, positioned at the container's origin. Anything computed from it is fiction. */
function hasBox(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect()
  return r.width > 0 || r.height > 0
}

/** offset of an element's top within the scroll container's content */
function offsetTop(main: HTMLElement, el: HTMLElement): number {
  return el.getBoundingClientRect().top - main.getBoundingClientRect().top + main.scrollTop
}

function clampTop(main: PlaceScroller, top: number): number {
  return Math.max(0, Math.min(top, Math.max(0, main.scrollHeight - main.clientHeight)))
}

// ── holding the reader's place across a fold ──────────────────
// A fold moves the page under the reader. Ticking a file viewed collapses its body;
// ticking the LAST file of a section collapses the whole section — and the scroll
// offset, a bare number of pixels, does not know. With a few thousand px of diff gone
// above the fold line, whatever sat below slides up under the pinned header: the tick
// on `sessions.ts` landed the reader half-way through `ipc.ts`, the next section's
// second file. Native scroll anchoring cannot help: the browser anchors on the first
// visible element, which is a diff row — exactly what the fold removes — and a
// removed anchor node suppresses the adjustment.

export type PlaceAnchor = Pick<Element, 'isConnected' | 'getBoundingClientRect'>
export type PlaceScroller = Pick<HTMLElement, 'scrollTop' | 'scrollHeight' | 'clientHeight'>

/** Record where `anchor` sits on screen now — for a sticky file header that is its
 *  STUCK rect, which is where the eye is — and return the restore step. Call it after
 *  the state change: it waits one frame (React has committed by then, the frame has
 *  not painted), re-measures, and shifts `main` so the anchor is back at that spot.
 *  When the anchor itself unmounted (a section fold takes its files with it) the
 *  `fallback` — the section block — takes its place: the folded section's header
 *  lands where the file header was, with the next section right under it. */
export function holdPlaceIn(main: PlaceScroller, anchor: PlaceAnchor): (fallback?: PlaceAnchor | null) => void {
  const top = anchor.getBoundingClientRect().top
  return (fallback) => {
    requestAnimationFrame(() => {
      const el = anchor.isConnected ? anchor : fallback?.isConnected ? fallback : null
      if (!el) return
      const shift = el.getBoundingClientRect().top - top
      if (Math.abs(shift) <= SETTLE_TOL) return
      main.scrollTop = clampTop(main, main.scrollTop + shift)
    })
  }
}

/** `holdPlaceIn` against the review's scroll container. A jump still in flight is
 *  dropped first — it would drag the view back to its own goal. */
export function holdPlace(anchor: HTMLElement | null | undefined): (fallback?: PlaceAnchor | null) => void {
  const main = anchor?.closest<HTMLElement>('.gmain')
  if (!anchor || !main) return () => {}
  cancelFocusJump()
  return holdPlaceIn(main, anchor)
}

/** Where the FOCUS chip goes for a line, or null when the line isn't in the diff
 *  viewport's visible band. Diff lines run full-width (and can overflow), so
 *  anchoring to the line's right edge would push the chip over the chat drawer; a
 *  line behind the sticky file header or scrolled off would peg it to a screen
 *  corner. Clamp to `.gmain` below the sticky header, and report "nowhere" when the
 *  line isn't in that band — recomputed on scroll, since the chip is `position:fixed`
 *  and would otherwise sit over unrelated code the moment the view moves. */
export function badgeSpot(el: HTMLElement): { top: number; left: number } | null {
  const r = el.getBoundingClientRect()
  const main = el.closest<HTMLElement>('.gmain')
  if (!main) return { top: Math.max(8, r.top + 4), left: Math.max(8, r.right - BADGE_W) }
  const mr = main.getBoundingClientRect()
  // a row behind its file's sticky header is hidden; a jump to the header itself is
  // not — it IS the sticky element, so it may sit at the very top of the band
  const head = el.closest('.gfile')?.querySelector<HTMLElement>('.gfile-head')
  const topMin = (head && head !== el ? head.getBoundingClientRect().bottom : mr.top) + 2
  // line hidden behind the sticky header, or off the bottom → no chip
  if (r.bottom <= topMin || r.top >= mr.bottom) return null
  return {
    top: Math.min(Math.max(r.top + 4, topMin), mr.bottom - 20),
    left: Math.min(Math.max(r.right - BADGE_W, mr.left + 8), mr.right - BADGE_W - 8)
  }
}

/** The minimal query-root/node surface `flashSelectors` needs — kept separate from
 *  `HTMLElement` so it can be pinned with a plain fake (this suite runs without a
 *  DOM), while a real `HTMLElement` satisfies it as-is. */
export interface FlashNode {
  classList: { add(c: string): void; remove(...c: string[]): void }
}
export interface FlashRoot<T extends FlashNode = FlashNode> {
  querySelectorAll(selectors: string): Iterable<T>
  readonly offsetWidth: number
}

/** Resolve every selector in ONE query (attribute selectors aren't indexed, so `root`
 *  is walked once instead of once per line) and flash them together: strip the class
 *  so the animation re-triggers even on an already-flashed row, force a single style
 *  flush, then add it to every node — one reflow for the whole range instead of one
 *  per line. Order doesn't matter to the caller (only used for later class removal).
 *  Generic over the node type so a real `HTMLElement` root hands `land()` back
 *  `HTMLElement[]` with no cast, while a test can still drive it with a plain fake. */
export function flashSelectors<T extends FlashNode>(root: FlashRoot<T>, selectors: string[], flashClass: string): T[] {
  if (selectors.length === 0) return []
  const nodes = [...root.querySelectorAll(selectors.join(','))]
  for (const n of nodes) n.classList.remove('limn-flash')
  void root.offsetWidth
  for (const n of nodes) n.classList.add(flashClass)
  return nodes
}

let cancelActive: (() => void) | null = null

/** Drop the jump in flight: stop its loop, remove its FOCUS chip and every highlight
 *  it applied, and undo its force-render. Every jump starts with this, so a
 *  walkthrough's stops can never stack chips or leave the previous stop lit (#19). */
export function cancelFocusJump(): void {
  const cancel = cancelActive
  cancelActive = null
  cancel?.()
}

/** Scroll `.gmain` to a target and flash it once the layout has settled there.
 *  Jumps are instant (NOT smooth): smooth animates the whole container, reads as
 *  slow, and the flash would have to wait for it. */
export function startFocusJump(target: FocusTarget, opts: { quiet?: boolean } = {}): void {
  cancelFocusJump()
  const selectors = focusSelectors(target)
  const lead = selectors[0]
  const file = target.kind === 'diff' || target.kind === 'file' ? target.file : null

  let raf = 0
  let timer = 0
  let state = settleStart
  // the head-vs-centre rule is chosen once: re-deciding it per frame could flip
  // between two goals and never settle
  let place: 'head' | 'centre' | null = null
  let flashed: HTMLElement[] = []
  let revealed: HTMLElement | null = null
  let badge: HTMLElement | null = null
  let badgeOn: HTMLElement | null = null
  let box: HTMLElement | null = null
  let onScroll: (() => void) | null = null

  const stop = (): void => {
    if (raf) cancelAnimationFrame(raf)
    raf = 0
    if (timer) window.clearTimeout(timer)
    timer = 0
    if (box && onScroll) box.removeEventListener('scroll', onScroll)
    onScroll = null
    box = null
    for (const el of flashed) el.classList.remove('limn-flash', 'limn-flash-hold')
    flashed = []
    badge?.remove()
    badge = null
    badgeOn = null
    // safe to drop the force-render: `contain-intrinsic-size: auto` remembers the
    // size it laid out at, so re-skipping the subtree shifts nothing.
    revealed?.style.removeProperty('content-visibility')
    revealed = null
  }
  const finish = (): void => {
    if (cancelActive === stop) cancelActive = null
    stop()
  }
  cancelActive = stop

  const placeBadge = (): void => {
    if (!badge || !badgeOn) return
    const spot = badgeSpot(badgeOn)
    if (!spot) { badge.style.display = 'none'; return }
    badge.style.display = ''
    badge.style.top = `${spot.top}px`
    badge.style.left = `${spot.left}px`
  }

  const land = (main: HTMLElement, el: HTMLElement): void => {
    // a navigation jump (sidebar click) lands without the flash + FOCUS chip: the
    // reader asked to go there, nothing needs pointing out
    if (opts.quiet) { finish(); return }
    flashed = flashSelectors<HTMLElement>(main, selectors, dev.holdFocus ? 'limn-flash-hold' : 'limn-flash')
    badge = document.createElement('div')
    badge.className = 'limn-focus-badge'
    badge.textContent = 'focus'
    badgeOn = el
    document.body.appendChild(badge)
    placeBadge()
    box = main
    onScroll = placeBadge
    main.addEventListener('scroll', onScroll, { passive: true })
    // dev: a static highlight (the animation ends transparent) for a clean capture
    if (!dev.holdFocus) timer = window.setTimeout(finish, FLASH_MS)
  }

  const frame = (): void => {
    raf = 0
    const main = document.querySelector<HTMLElement>('.gmain')
    const el = main?.querySelector<HTMLElement>(lead) ?? null
    let goal: number | null = null
    let delta: number | null = null
    if (main && el) {
      // Force the target's diff body to lay out. Until it does, its rows have no box
      // (content-visibility skips them) — this is what made the one-shot jump land
      // hundreds of lines away (#19).
      if (!revealed) {
        const body = el.closest<HTMLElement>('.gfile-diff')
        if (body) {
          revealed = body
          body.style.setProperty('content-visibility', 'visible')
        }
      }
      const head = file ? main.querySelector<HTMLElement>(`[data-limn-file="${attr(file)}"]`) : null
      const headBox = head ? stableEl(head) : null
      const headTop = headBox && hasBox(headBox) ? offsetTop(main, headBox) : null
      const elBox = stableEl(el)
      const pinned = pinnedTop(main)
      if (hasBox(elBox)) {
        const top = offsetTop(main, elBox)
        const g = jumpGoal({ kind: target.kind, top, headTop, viewH: main.clientHeight, pinned, place })
        place = g.place
        goal = clampTop(main, g.goal)
        delta = goal - main.scrollTop
      } else if (headTop !== null) {
        // The row is mounted but its file body is still a skipped subtree. Approach
        // by the file header (always laid out — it sits outside `.gfile-diff`); that
        // brings the body on screen, it lays out, and the next frame measures for real.
        goal = clampTop(main, headTop - pinned - JUMP_GAP)
      }
    }
    const step = settleStep(state, delta)
    state = step.state
    if (step.action === 'abandon') { finish(); return }
    if (main && goal !== null && Math.abs(goal - main.scrollTop) > SETTLE_TOL) {
      main.scrollTo({ top: goal, behavior: 'instant' as ScrollBehavior })
    }
    if (step.action === 'land' && main && el) { land(main, el); return }
    raf = requestAnimationFrame(frame)
  }

  raf = requestAnimationFrame(frame)
}
