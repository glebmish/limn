import { describe, it, expect } from 'vitest'
import { genCancelled } from '../src/renderer/store'
import type { GenState } from '../src/renderer/store'

// a finished op's gen-state, parameterized by the two signals that classify it.
function done(over: Partial<GenState>): GenState {
  return { running: false, opId: 'op-1', kind: 'review', threadId: null, log: [], error: null, startedAt: null, outcome: null, ...over }
}

describe('genCancelled (routes a finished op back to the generate block vs. the failure banner)', () => {
  it('uses the typed operation outcome', () => {
    expect(genCancelled(done({ outcome: 'cancelled' }))).toBe(true)
    expect(genCancelled(done({ outcome: 'failed', error: 'cancelled' }))).toBe(false)
  })

  it('is false for a genuine failure the user did not cancel', () => {
    expect(genCancelled(done({ outcome: 'failed', error: 'ENOENT: no such file' }))).toBe(false)
    expect(genCancelled(done({ outcome: 'failed', error: 'Engine crashed' }))).toBe(false)
  })

  it('is false for a clean, still-pristine op', () => {
    expect(genCancelled(done({}))).toBe(false)
  })
})
