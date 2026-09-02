import { describe, expect, it } from 'vitest'
import { STEP, foldControls, gapContaining, hiddenRange, revealLines, stepReveal, type Gap } from '../src/renderer/lib/expand'

const g: Gap = { key: 'g17', from: 17, to: 66, oldOffset: 1 } // 50 lines
const tail: Gap = { key: 'g80', from: 80, to: null, oldOffset: 0 }
const file = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`)

describe('stepped folds', () => {
  it('reveals 20 from an edge and clamps at the other reveal', () => {
    expect(stepReveal(g, { top: 0, bottom: 0 }, 'top', null)).toEqual({ top: 20, bottom: 0 })
    expect(stepReveal(g, { top: 20, bottom: 20 }, 'bottom', null)).toEqual({ top: 20, bottom: 30 })
    expect(hiddenRange(g, { top: 20, bottom: 30 }, null)).toBeNull()
    expect(hiddenRange(g, { top: 20, bottom: 0 }, null)).toEqual({ from: 37, to: 66 })
  })

  it('shows two step controls over 20 hidden lines, one control at or under', () => {
    expect(foldControls(g, { top: 0, bottom: 0 }, null, '')).toEqual({ kind: 'steps', up: true, down: true, count: 50 })
    expect(foldControls(g, { top: 20, bottom: 10 }, null, '')).toEqual({ kind: 'single', count: 20 })
    expect(foldControls(g, { top: 25, bottom: 25 }, null, '')).toBeNull()
  })

  it('a leading run only expands up, a trailing run only down, its count unknown until fetched', () => {
    const lead: Gap = { key: 'g1', from: 1, to: 50, oldOffset: 0 }
    expect(foldControls(lead, { top: 0, bottom: 0 }, null, 'above')).toEqual({ kind: 'steps', up: true, down: false, count: 50 })
    expect(foldControls(tail, { top: 0, bottom: 0 }, null, 'below')).toEqual({ kind: 'steps', up: false, down: true, count: null })
    expect(foldControls(tail, { top: 0, bottom: 0 }, 100, 'below')).toEqual({ kind: 'steps', up: false, down: true, count: 21 })
    expect(foldControls(tail, { top: 0, bottom: 0 }, 95, 'below')).toEqual({ kind: 'single', count: 16 })
  })

  it('materialises the revealed edges as context lines with both numbers', () => {
    const { top, bottom } = revealLines(file, g, { top: 2, bottom: 1 })
    expect(top).toEqual([{ old: 16, new: 17, kind: '', text: 'line 17' }, { old: 17, new: 18, kind: '', text: 'line 18' }])
    expect(bottom).toEqual([{ old: 65, new: 66, kind: '', text: 'line 66' }])
    expect(revealLines(file, tail, { top: 5, bottom: 0 }).top).toHaveLength(5)
    // a tail revealed past its (now known) end shows the whole rest, once
    const all = revealLines(file, tail, { top: 40, bottom: 0 })
    expect(all.top).toHaveLength(21)
    expect(all.bottom).toEqual([])
  })

  it('finds the fold hiding a line and the edge nearest to it', () => {
    const reveals = { g17: { top: 20, bottom: 0 } }
    expect(gapContaining([g, tail], reveals, null, 30)).toBeUndefined()   // revealed
    expect(gapContaining([g, tail], reveals, null, 37)).toEqual({ gap: g, edge: 'top' })
    expect(gapContaining([g, tail], reveals, null, 66)).toEqual({ gap: g, edge: 'bottom' })
    expect(gapContaining([g, tail], reveals, 100, 90)).toEqual({ gap: tail, edge: 'top' })
    expect(gapContaining([g, tail], reveals, 100, 101)).toBeUndefined()
    expect(STEP).toBe(20)
  })
})
