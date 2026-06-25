import { describe, test, expect } from 'vitest'
import { computePosition } from '../src/renderer/lib/floating'

// A 1000x800 viewport for most cases.
const VP = { width: 1000, height: 800 }

describe('computePosition — preferred placement when it fits', () => {
  test('bottom-start sits just below the anchor, left-aligned to it', () => {
    const p = computePosition({
      anchor: { top: 100, left: 200, width: 50, height: 20 },
      floating: { width: 240, height: 120 },
      viewport: VP, side: 'bottom', align: 'start', gap: 6, margin: 8,
    })
    expect(p.side).toBe('bottom')
    expect(p.top).toBe(126)   // 100 + 20 + 6
    expect(p.left).toBe(200)  // start = anchor.left
  })

  test('bottom-center centers the floating box on the anchor', () => {
    const p = computePosition({
      anchor: { top: 100, left: 200, width: 50, height: 20 },
      floating: { width: 240, height: 120 },
      viewport: VP, side: 'bottom', align: 'center', gap: 6, margin: 8,
    })
    // anchor center = 225; left = 225 - 120 = 105
    expect(p.left).toBe(105)
  })

  test('bottom-end right-aligns the floating box to the anchor', () => {
    const p = computePosition({
      anchor: { top: 100, left: 600, width: 50, height: 20 },
      floating: { width: 240, height: 120 },
      viewport: VP, side: 'bottom', align: 'end', gap: 6, margin: 8,
    })
    // end = anchor.right - floating.width = 650 - 240 = 410
    expect(p.left).toBe(410)
  })

  test('top-start sits just above the anchor', () => {
    const p = computePosition({
      anchor: { top: 400, left: 200, width: 50, height: 20 },
      floating: { width: 240, height: 100 },
      viewport: VP, side: 'top', align: 'start', gap: 6, margin: 8,
    })
    expect(p.side).toBe('top')
    expect(p.top).toBe(294)  // 400 - 100 - 6
  })
})

describe('computePosition — flip when the preferred side has no room', () => {
  test('top flips to bottom when the anchor hugs the viewport top (cm-tip case)', () => {
    const p = computePosition({
      anchor: { top: 10, left: 700, width: 24, height: 24 },
      floating: { width: 300, height: 60 },
      viewport: VP, side: 'top', align: 'center', gap: 9, margin: 8,
    })
    expect(p.side).toBe('bottom')
    expect(p.top).toBe(43)  // 10 + 24 + 9
  })

  test('bottom flips to top when the anchor hugs the viewport bottom', () => {
    const p = computePosition({
      anchor: { top: 770, left: 200, width: 50, height: 20 },
      floating: { width: 240, height: 120 },
      viewport: VP, side: 'bottom', align: 'start', gap: 6, margin: 8,
    })
    expect(p.side).toBe('top')
    expect(p.top).toBe(644)  // 770 - 120 - 6
  })

  test('does NOT flip when neither side fits — keeps preferred and lets clamp handle it', () => {
    const p = computePosition({
      anchor: { top: 380, left: 200, width: 50, height: 20 },
      floating: { width: 240, height: 700 },
      viewport: VP, side: 'bottom', align: 'start', gap: 6, margin: 8,
    })
    expect(p.side).toBe('bottom')
  })
})

describe('computePosition — cross-axis viewport clamp (shift)', () => {
  test('centered tooltip near the right edge is pulled left to stay on-screen (chip-tip case)', () => {
    const p = computePosition({
      anchor: { top: 100, left: 960, width: 30, height: 18 },
      floating: { width: 260, height: 80 },
      viewport: VP, side: 'bottom', align: 'center', gap: 7, margin: 8,
    })
    // raw center left = 975 - 130 = 845; right edge would be 845+260=1105 > 992
    // clamp: max left = 1000 - 260 - 8 = 732
    expect(p.left).toBe(732)
  })

  test('left-anchored popover near the right edge is pulled left (refpick case)', () => {
    const p = computePosition({
      anchor: { top: 100, left: 800, width: 40, height: 24 },
      floating: { width: 300, height: 200 },
      viewport: VP, side: 'bottom', align: 'start', gap: 4, margin: 8,
    })
    // raw left = 800; right edge 1100 > 992 → clamp to 1000-300-8 = 692
    expect(p.left).toBe(692)
  })

  test('floating box overflowing the left edge is clamped to the margin', () => {
    const p = computePosition({
      anchor: { top: 100, left: 10, width: 20, height: 18 },
      floating: { width: 260, height: 80 },
      viewport: VP, side: 'bottom', align: 'center', gap: 7, margin: 8,
    })
    // center would push left negative → clamp to margin (8)
    expect(p.left).toBe(8)
  })

  test('a floating box wider than the viewport is pinned to the left margin', () => {
    const p = computePosition({
      anchor: { top: 100, left: 400, width: 50, height: 20 },
      floating: { width: 1200, height: 80 },
      viewport: VP, side: 'bottom', align: 'center', gap: 6, margin: 8,
    })
    expect(p.left).toBe(8)
  })
})

describe('computePosition — horizontal sides', () => {
  test('right side places the floating box to the right of the anchor', () => {
    const p = computePosition({
      anchor: { top: 200, left: 100, width: 40, height: 30 },
      floating: { width: 120, height: 80 },
      viewport: VP, side: 'right', align: 'start', gap: 6, margin: 8,
    })
    expect(p.side).toBe('right')
    expect(p.left).toBe(146)  // 100 + 40 + 6
    expect(p.top).toBe(200)   // start = anchor.top
  })

  test('right flips to left when there is no room to the right', () => {
    const p = computePosition({
      anchor: { top: 200, left: 940, width: 40, height: 30 },
      floating: { width: 120, height: 80 },
      viewport: VP, side: 'right', align: 'start', gap: 6, margin: 8,
    })
    expect(p.side).toBe('left')
    expect(p.left).toBe(814)  // 940 - 120 - 6
  })
})
