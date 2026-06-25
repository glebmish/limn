import { describe, it, expect } from 'vitest'
import { genCancelled } from '../src/renderer/store'
import type { GenState } from '../src/renderer/store'

// a finished op's gen-state, parameterized by the two signals that classify it.
function done(over: Partial<GenState>): GenState {
  return { running: false, opId: 'op-1', kind: 'review', threadId: null, log: [], error: null, startedAt: null, cancelled: false, ...over }
}

describe('genCancelled (routes a finished op back to the generate block vs. the failure banner)', () => {
  it('is true when the user explicitly cancelled — regardless of the error text the engine then reports', () => {
    // this is the regression guard: a user-initiated cancel must NEVER surface as a failure,
    // even if the engine reports an unrecognised abort message (e.g. a stale build, "AbortError",
    // a localized/changed SDK string).
    expect(genCancelled(done({ cancelled: true, error: null }))).toBe(true)
    expect(genCancelled(done({ cancelled: true, error: 'The operation was aborted' }))).toBe(true)
    expect(genCancelled(done({ cancelled: true, error: 'AbortError' }))).toBe(true)
    expect(genCancelled(done({ cancelled: true, error: 'kaboom — totally unrelated failure' }))).toBe(true)
  })

  it('still treats a recognised abort/cancelled error string as a cancel (belt-and-suspenders)', () => {
    expect(genCancelled(done({ error: 'cancelled' }))).toBe(true)
    expect(genCancelled(done({ error: 'The operation was aborted' }))).toBe(true)
  })

  it('is false for a genuine failure the user did not cancel', () => {
    expect(genCancelled(done({ error: 'ENOENT: no such file' }))).toBe(false)
    expect(genCancelled(done({ error: 'Engine crashed' }))).toBe(false)
  })

  it('is false for a clean, still-pristine op', () => {
    expect(genCancelled(done({}))).toBe(false)
  })
})
