import { describe, expect, it } from 'vitest'
import {
  MAX_FOCUS_LINES, SETTLE_MAX_FRAMES, SETTLE_MISSING_FRAMES, SETTLE_STABLE_FRAMES, SETTLE_TOL,
  focusSelectors, settleStart, settleStep, type SettleAction, type SettleState
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

  it('keeps the old-side line on the old side', () => {
    expect(focusSelectors(diff({ side: 'old', endLine: 31 }))).toEqual([
      '[data-limn-line="src/sessions.ts:old:30"]',
      '[data-limn-line="src/sessions.ts:old:31"]'
    ])
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
