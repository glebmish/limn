import { describe, expect, it } from 'vitest'
import { gapContaining, hiddenRange, stepReveal, type Gap } from '../src/renderer/lib/expand'

/** The two non-button callers of the reveal primitive — the post-save ↑/↓ walk and
 *  the FlowFrame growth gesture — both ask `gapContaining` which fold hides the line
 *  they are heading for and from which edge to open it, then take one STEP from
 *  there. These pin the edge choice, the easy thing to get backwards. */
const g: Gap = { key: 'g17', from: 17, to: 66, oldOffset: 0 }

describe('reveal callers', () => {
  it('a frame growing upward into a fold opens it from the bottom edge', () => {
    // frame at 67 grows up to 66: the effect probes 65 and 66
    const plan = gapContaining([g], {}, 100, 66)
    expect(plan).toEqual({ gap: g, edge: 'bottom' })
    const next = stepReveal(g, { top: 0, bottom: 0 }, plan!.edge, 100)
    expect(hiddenRange(g, next, 100)).toEqual({ from: 17, to: 46 }) // 47..66 now shown
  })

  it('arrowing down out of the change above opens the fold from the top edge', () => {
    const plan = gapContaining([g], {}, 100, 17)
    expect(plan).toEqual({ gap: g, edge: 'top' })
    const next = stepReveal(g, { top: 0, bottom: 0 }, plan!.edge, 100)
    expect(hiddenRange(g, next, 100)).toEqual({ from: 37, to: 66 })
  })

  it('a line already revealed needs no plan, and Expand all leaves nothing hidden', () => {
    const opened = stepReveal(g, { top: 0, bottom: 0 }, 'top', 100, Infinity)
    expect(gapContaining([g], { g17: opened }, 100, 40)).toBeUndefined()
    expect(hiddenRange(g, opened, 100)).toBeNull()
  })
})
