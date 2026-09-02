import { describe, it, expect } from 'vitest'
import { clampPanelWidth, parseStoredWidth, panelVars, PANELS, MAIN_MIN, KEY_STEP, HARD_FLOOR } from '../src/renderer/lib/panelWidths'

describe('PANELS / constants', () => {
  it('defines sidebar and chat specs', () => {
    expect(PANELS.sidebar).toEqual({ default: 286, min: 220, max: 520 })
    expect(PANELS.chat).toEqual({ default: 320, min: 260, max: 640 })
  })

  it('exports the shared layout constants', () => {
    expect(MAIN_MIN).toBe(480)
    expect(KEY_STEP).toBe(16)
    expect(HARD_FLOOR).toBe(160)
  })
})

describe('clampPanelWidth', () => {
  it('clamps to the panel range first', () => {
    expect(clampPanelWidth('sidebar', 100, 1400, 320)).toBe(220)
    expect(clampPanelWidth('sidebar', 900, 1400, 320)).toBe(520)
  })

  it('applies the viewport guard after the range clamp', () => {
    // 1200 - 320 - 480 = 400
    expect(clampPanelWidth('sidebar', 500, 1200, 320)).toBe(400)
  })

  it('allows the full max when the viewport comfortably fits', () => {
    expect(clampPanelWidth('chat', 700, 2000, 286)).toBe(640)
  })

  it('the viewport guard can push the result below min', () => {
    // range clamp: 300 -> 300 (within 260..640)
    // guard: 1000 - 286 - 480 = 234
    expect(clampPanelWidth('chat', 300, 1000, 286)).toBe(234)
  })

  it('the viewport guard never pushes below the hard floor', () => {
    // guard: 900 - 286 - 480 = 134 -> floors at 160
    expect(clampPanelWidth('chat', 300, 900, 286)).toBe(160)
  })
})

describe('parseStoredWidth', () => {
  it('falls back to the panel default when undefined or unparseable', () => {
    expect(parseStoredWidth('sidebar', undefined)).toBe(286)
    expect(parseStoredWidth('sidebar', '"abc"')).toBe(286)
  })

  it('clamps an out-of-range stored value', () => {
    expect(parseStoredWidth('sidebar', '9999')).toBe(520)
  })

  it('passes through an in-range stored value', () => {
    expect(parseStoredWidth('chat', '300')).toBe(300)
  })

  it('falls back to the panel default on NaN', () => {
    expect(parseStoredWidth('chat', 'NaN')).toBe(320)
  })
})

describe('panelVars', () => {
  it('produces the CSS custom properties the shell sets', () => {
    expect(panelVars(300, 400)).toEqual({ '--gside-w': '300px', '--chat-w': '400px' })
  })
})
