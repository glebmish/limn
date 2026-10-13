import { describe, it, expect } from 'vitest'

;(globalThis as unknown as { window: unknown }).window = { api: {} }

import { frameSaveOutcome, unsavedMessage } from '../src/renderer/components/FlowFrame'
import { singleFlight } from '../src/renderer/lib/singleFlight'
import type { ApplyEditResult } from '../src/shared/types'

// A transport failure on save (network drop, server restart) used to close the frame
// and drop the draft — text the reviewer typed and can't get back. It now stays open,
// like the too-large / no-longer-text path, with the save retry-able. And a double ✓
// (or a held ⌘⏎) must not send the same edit twice.

describe('frame save outcome', () => {
  it('a transport failure keeps the frame open for a retry', () => {
    expect(frameSaveOutcome(null)).toBe('retry')
  })
  it('success closes, a conflict re-anchors, a dead file keeps the text', () => {
    expect(frameSaveOutcome({ ok: true } as ApplyEditResult)).toBe('saved')
    expect(frameSaveOutcome({ ok: false, reason: 'conflict', current: [] } as unknown as ApplyEditResult)).toBe('conflict')
    expect(frameSaveOutcome({ ok: false, reason: 'too-large' } as unknown as ApplyEditResult)).toBe('dead')
    expect(frameSaveOutcome({ ok: false, reason: 'not-text' } as unknown as ApplyEditResult)).toBe('dead')
  })
  it('the retry message keeps the cause and says the text is still there', () => {
    const m = unsavedMessage('src/a.ts', 'fetch failed')
    expect(m).toContain('src/a.ts')
    expect(m).toContain('fetch failed')
    expect(m).toMatch(/still in the frame/)
  })
})

describe('singleFlight', () => {
  it('drops a second call while the first is in flight, and frees the slot after', async () => {
    const busy = { current: false }
    const states: boolean[] = []
    let release!: () => void
    let runs = 0
    const run = () => { runs++; return new Promise<void>((r) => { release = r }) }
    const first = singleFlight(busy, (b) => states.push(b), run)
    const second = singleFlight(busy, (b) => states.push(b), run)
    expect(runs).toBe(1)
    await second
    release()
    await first
    expect(busy.current).toBe(false)
    expect(states).toEqual([true, false])
    void singleFlight(busy, () => {}, run)
    expect(runs).toBe(2)
  })

  it('frees the slot when the run throws', async () => {
    const busy = { current: false }
    await expect(singleFlight(busy, () => {}, async () => { throw new Error('boom') })).rejects.toThrow('boom')
    expect(busy.current).toBe(false)
  })
})
