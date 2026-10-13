import { describe, expect, it } from 'vitest'
import {
  MAX_FOCUS_LINES, SETTLE_MAX_FRAMES, SETTLE_MISSING_FRAMES, SETTLE_STABLE_FRAMES, SETTLE_TOL,
  JUMP_GAP, flashSelectors, focusSelectors, jumpGoal, settleStart, settleStep,
  type FlashNode, type FlashRoot, type SettleAction, type SettleState
} from '../src/renderer/lib/focusScroll'
import type { FocusTarget } from '../src/shared/types'

const diff = (over: Partial<Extract<FocusTarget, { kind: 'diff' }>> = {}): FocusTarget =>
  ({ kind: 'diff', file: 'src/sessions.ts', side: 'new', line: 30, hunkRange: '', lineContent: '', ...over })

// #19: the FOCUS set is what a jump highlights. Exactly the anchor's lines, nothing
// else — the previous stop's set is removed by cancelFocusJump before a new one runs.
describe('focusSelectors', () => {
  it('is a single node for every non-diff target', () => {
    expect(focusSelectors({ kind: 'summary' })).toEqual(['[data-limn-summary]'])
    expect(focusSelectors({ kind: 'section', sectionId: 's2' })).toEqual(['[data-limn-section="s2"]'])
    expect(focusSelectors({ kind: 'file', file: 'a.ts' })).toEqual(['[data-limn-file="a.ts"]'])
  })

  it('is the single line of a point anchor', () => {
    expect(focusSelectors(diff())).toEqual(['[data-limn-line="src/sessions.ts:new:30"]'])
  })

  it('covers line..endLine for a range anchor, the jumped line first', () => {
    expect(focusSelectors(diff({ endLine: 32 }))).toEqual([
      '[data-limn-line="src/sessions.ts:new:30"]',
      '[data-limn-line="src/sessions.ts:new:31"]',
      '[data-limn-line="src/sessions.ts:new:32"]'
    ])
  })

  it('ignores an endLine that is not after line (equal, before, or not a number)', () => {
    const one = ['[data-limn-line="src/sessions.ts:new:30"]']
    expect(focusSelectors(diff({ endLine: 30 }))).toEqual(one)
    expect(focusSelectors(diff({ endLine: 12 }))).toEqual(one)
    expect(focusSelectors(diff({ endLine: NaN }))).toEqual(one)
    expect(focusSelectors(diff({ endLine: Infinity }))).toEqual(one)
  })

  it('caps a runaway range so a bad endLine cannot light the whole file', () => {
    const sels = focusSelectors(diff({ line: 1, endLine: 5000 }))
    expect(sels).toHaveLength(MAX_FOCUS_LINES)
    expect(sels[MAX_FOCUS_LINES - 1]).toBe(`[data-limn-line="src/sessions.ts:new:${MAX_FOCUS_LINES}"]`)
  })

  it('escapes quotes in the file path', () => {
    expect(focusSelectors(diff({ file: 'a"b.ts' }))).toEqual(['[data-limn-line="a\\"b.ts:new:30"]'])
  })

  it('keeps the old-side line on the old side — its own row, or a context row\'s old alias', () => {
    expect(focusSelectors(diff({ side: 'old', endLine: 31 }))).toEqual([
      '[data-limn-line="src/sessions.ts:old:30"],[data-limn-line-old="src/sessions.ts:old:30"]',
      '[data-limn-line="src/sessions.ts:old:31"],[data-limn-line-old="src/sessions.ts:old:31"]'
    ])
  })
})

// #91: `land()` used to resolve each of up to MAX_FOCUS_LINES selectors with its
// own `querySelector` (a fresh unindexed subtree walk each time) plus its own
// forced reflow. flashSelectors is the single-query, single-reflow replacement —
// pinned here (against a fake root, since this suite has no DOM) so the rewrite is
// provably the same landing: every selector's node gets `limn-flash` removed then
// the flash class added, a selector nothing resolves to is silently skipped, and
// an empty range queries nothing.
describe('flashSelectors', () => {
  function fakeNode(): FlashNode & { added: string[]; removed: string[] } {
    const added: string[] = []
    const removed: string[] = []
    return { added, removed, classList: { add: (c) => added.push(c), remove: (...c) => removed.push(...c) } }
  }
  function fakeRoot(nodes: Record<string, FlashNode>): FlashRoot & { queries: string[] } {
    const queries: string[] = []
    return {
      queries,
      offsetWidth: 0,
      querySelectorAll: (sel) => {
        queries.push(sel)
        return sel.split(',').map((s) => nodes[s]).filter((n): n is FlashNode => Boolean(n))
      }
    }
  }

  it('resolves every selector in ONE query and flashes them all', () => {
    const [a, b, c] = [fakeNode(), fakeNode(), fakeNode()]
    const selectors = ['[data-limn-line="f:new:1"]', '[data-limn-line="f:new:2"]', '[data-limn-line="f:new:3"]']
    const root = fakeRoot({ [selectors[0]]: a, [selectors[1]]: b, [selectors[2]]: c })

    const flashed = flashSelectors(root, selectors, 'limn-flash')

    expect(root.queries).toEqual([selectors.join(',')]) // one query, not one per line
    expect(flashed).toEqual([a, b, c])
    for (const n of [a, b, c]) {
      expect(n.removed).toContain('limn-flash') // re-triggers the animation
      expect(n.added).toEqual(['limn-flash'])
    }
  })

  it('passes through the hold-vs-flash class the caller chose', () => {
    const a = fakeNode()
    const root = fakeRoot({ '[data-limn-line="f:new:1"]': a })

    flashSelectors(root, ['[data-limn-line="f:new:1"]'], 'limn-flash-hold')

    expect(a.added).toEqual(['limn-flash-hold'])
  })

  it('skips a selector nothing resolves to', () => {
    const a = fakeNode()
    const root = fakeRoot({ '[data-limn-line="f:new:1"]': a })

    const flashed = flashSelectors(root, ['[data-limn-line="f:new:1"]', '[data-limn-line="f:new:2"]'], 'limn-flash')

    expect(flashed).toEqual([a])
  })

  it('queries nothing and flashes nothing for an empty range', () => {
    const root = fakeRoot({})

    expect(flashSelectors(root, [], 'limn-flash')).toEqual([])
    expect(root.queries).toEqual([])
  })
})

/** run a whole jump: one `delta` per frame (null = the target has no box yet). */
function drive(deltas: (number | null)[]): { actions: SettleAction[]; state: SettleState } {
  let state = settleStart
  const actions: SettleAction[] = []
  for (const d of deltas) {
    const step = settleStep(state, d)
    state = step.state
    actions.push(step.action)
    if (step.action === 'land' || step.action === 'abandon') break
  }
  return { actions, state }
}

// #19 root cause: `.gfile-diff` is content-visibility:auto, so an off-screen file
// body has no layout at all and the bodies that render as the viewport passes them
// move everything below. A one-shot scroll therefore lands hundreds of lines away.
// The machine keeps re-measuring and only lands once the goal has held still.
describe('settleStep', () => {
  it('waits (without burning the settle budget) while the target has no box', () => {
    const { actions, state } = drive([null, null, null])
    expect(actions).toEqual(['wait', 'wait', 'wait'])
    expect(state).toEqual({ frames: 3, seen: 0, stable: 0 })
  })

  it('gives up on a target that never renders, after SETTLE_MISSING_FRAMES', () => {
    const { actions } = drive(Array<number | null>(SETTLE_MISSING_FRAMES + 5).fill(null))
    expect(actions).toHaveLength(SETTLE_MISSING_FRAMES)
    expect(actions[SETTLE_MISSING_FRAMES - 1]).toBe('abandon')
    expect(actions.slice(0, -1).every((a) => a === 'wait')).toBe(true)
  })

  it('scrolls again for as long as the goal keeps moving', () => {
    const { actions } = drive([-4200, -900, -120])
    expect(actions).toEqual(['scroll', 'scroll', 'scroll'])
  })

  it('lands only after the goal has held for SETTLE_STABLE_FRAMES', () => {
    const { actions } = drive([-4200, 0, 0, 0])
    expect(SETTLE_STABLE_FRAMES).toBe(3)
    expect(actions).toEqual(['scroll', 'wait', 'wait', 'land'])
  })

  it('restarts the count when a late layout shift moves the target', () => {
    // two settled frames, then a collapsed block above finally lays out and pushes
    // the row down: the jump must chase it rather than flash where it used to be
    const { actions } = drive([0, 0, -800, 0, 0, 0])
    expect(actions).toEqual(['wait', 'wait', 'scroll', 'wait', 'wait', 'land'])
  })

  it('treats sub-pixel drift as arrived, and anything larger as a move', () => {
    expect(settleStep(settleStart, SETTLE_TOL).action).toBe('wait')
    expect(settleStep(settleStart, -SETTLE_TOL).action).toBe('wait')
    expect(settleStep(settleStart, SETTLE_TOL + 0.5).action).toBe('scroll')
  })

  it('lands anyway once the settle budget is spent on a target that never stops moving', () => {
    const { actions, state } = drive(Array<number | null>(SETTLE_MAX_FRAMES + 5).fill(-40))
    expect(actions).toHaveLength(SETTLE_MAX_FRAMES)
    expect(actions[SETTLE_MAX_FRAMES - 1]).toBe('land')
    expect(state.seen).toBe(SETTLE_MAX_FRAMES)
  })

  it('spends the settle budget only on frames the target was measurable', () => {
    // 30 frames of a doc view remounting, then a normal settle — the wait must not
    // eat into the frames the jump gets to converge in
    const { actions } = drive([...Array<number | null>(30).fill(null), -900, 0, 0, 0])
    expect(actions.slice(30)).toEqual(['scroll', 'wait', 'wait', 'land'])
  })
})

// The pinned page header (`.page-head`, sticky at the top of `.gmain`) is part of
// every landing: a goal that ignores it puts the target behind the header. On a
// narrow viewport the wrapped title makes the header ~3× taller, which is how a
// sidebar click on a viewed file showed the NEXT section's title at the top.
describe('jumpGoal', () => {
  const view = { viewH: 900, pinned: 280 }

  it('lands a block target (file / section / summary) just below the pinned header', () => {
    for (const kind of ['file', 'section', 'summary'] as const) {
      expect(jumpGoal({ kind, top: 5000, headTop: null, ...view })).toEqual({ goal: 5000 - 280 - JUMP_GAP, place: null })
    }
  })

  it('a taller header moves the landing by exactly its extra height', () => {
    const desktop = jumpGoal({ kind: 'file', top: 5000, headTop: null, viewH: 900, pinned: 90 }).goal
    const tablet = jumpGoal({ kind: 'file', top: 5000, headTop: null, viewH: 900, pinned: 280 }).goal
    expect(desktop - tablet).toBe(190)
  })

  it('keeps the file header in view for a line near it: header under the pinned head, line below', () => {
    const g = jumpGoal({ kind: 'diff', top: 5200, headTop: 5000, ...view })
    expect(g.place).toBe('head')
    expect(g.goal).toBe(5000 - 280 - JUMP_GAP)
  })

  it('centres a line too far below its header to show both — in the band BELOW the pinned head', () => {
    const g = jumpGoal({ kind: 'diff', top: 9000, headTop: 5000, ...view })
    expect(g.place).toBe('centre')
    // the line sits at the middle of the visible band (viewH − pinned), offset by the header
    expect(g.goal).toBe(9000 - 280 - (900 - 280) / 2)
  })

  it('the head-vs-centre decision shrinks with the band, not the viewport', () => {
    // same line offset: fits beside the header on a desktop header, not under a tall one
    const desktop = jumpGoal({ kind: 'diff', top: 5600, headTop: 5000, viewH: 900, pinned: 90 })
    const tablet = jumpGoal({ kind: 'diff', top: 5600, headTop: 5000, viewH: 900, pinned: 400 })
    expect(desktop.place).toBe('head')
    expect(tablet.place).toBe('centre')
  })

  it('a placement chosen on the first frame is kept, so the loop cannot flip between two goals', () => {
    const g = jumpGoal({ kind: 'diff', top: 9000, headTop: 5000, ...view, place: 'head' })
    expect(g.place).toBe('head')
    expect(g.goal).toBe(5000 - 280 - JUMP_GAP)
  })

  it('centres when the file header could not be measured', () => {
    const g = jumpGoal({ kind: 'diff', top: 5200, headTop: null, ...view })
    expect(g.place).toBe('centre')
  })
})

import { afterEach, beforeEach, vi } from 'vitest'
import { holdPlaceIn, type PlaceAnchor } from '../src/renderer/lib/focusScroll'

/** an element with a screen `top` that the test moves between measure and restore */
function box(top: number, connected = true): PlaceAnchor & { top: number; isConnected: boolean } {
  const b = {
    top,
    isConnected: connected,
    getBoundingClientRect: () => ({ top: b.top }) as DOMRect
  }
  return b
}

// Ticking a file viewed folds its body; ticking the last file of a section folds the
// section. The scroll offset does not know, so the page below slides up under the
// pinned header (the tick on sessions.ts landed half-way through ipc.ts). The reader's
// place is held: the anchor is measured before the fold and put back after it.
describe('holdPlaceIn', () => {
  let frame: (() => void) | null
  beforeEach(() => {
    frame = null
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => { frame = () => cb(0); return 1 }) as typeof globalThis.requestAnimationFrame
  })
  afterEach(() => { vi.unstubAllGlobals() })

  const main = (scrollTop: number): { scrollTop: number; scrollHeight: number; clientHeight: number } =>
    ({ scrollTop, scrollHeight: 20000, clientHeight: 800 })

  it('shifts the container so the anchor is back where it was measured', () => {
    const m = main(5000)
    const head = box(120)            // the stuck file header, under the pinned page head
    const restore = holdPlaceIn(m, head)
    head.top = -2880                 // the body above folded away; the card is now far above
    restore()
    frame?.()
    expect(m.scrollTop).toBe(2000)
  })

  it('waits for the frame — the change has to commit before it is measured', () => {
    const m = main(5000)
    const head = box(120)
    const restore = holdPlaceIn(m, head)
    head.top = -2880
    restore()
    expect(m.scrollTop).toBe(5000)
  })

  it('falls back to the section block when the file unmounted with its section', () => {
    const m = main(5000)
    const head = box(120)
    const restore = holdPlaceIn(m, head)
    head.isConnected = false
    const section = box(-3000)       // the folded section's row, now above the viewport
    restore(section)
    frame?.()
    expect(m.scrollTop).toBe(5000 - 3120)
  })

  it('leaves the container alone when nothing moved (unticking opens the body BELOW the header)', () => {
    const m = main(5000)
    const head = box(120)
    const restore = holdPlaceIn(m, head)
    restore()
    frame?.()
    expect(m.scrollTop).toBe(5000)
  })

  it('does nothing when neither the anchor nor a fallback is left to measure', () => {
    const m = main(5000)
    const head = box(120)
    const restore = holdPlaceIn(m, head)
    head.isConnected = false
    restore(null)
    frame?.()
    expect(m.scrollTop).toBe(5000)
  })

  it('clamps to the scrollable range', () => {
    const m = main(500)
    const head = box(120)
    const restore = holdPlaceIn(m, head)
    head.top = 900                   // content ABOVE grew (a section re-opened over it)
    restore()
    frame?.()
    expect(m.scrollTop).toBe(1280)
    const m2 = main(300)
    const h2 = box(120)
    const r2 = holdPlaceIn(m2, h2)
    h2.top = -1000
    r2()
    frame?.()
    expect(m2.scrollTop).toBe(0)
  })
})
