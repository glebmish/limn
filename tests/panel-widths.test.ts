import { describe, it, expect } from 'vitest'
import {
  clampPanelWidth, clampPanelRange, effectiveWidths, parseStoredWidth, panelVars, panelVarName,
  shouldPersist, PANELS, PANEL_DIRECTIONS, PANEL_LABELS, PREF_KEYS, MAIN_MIN, KEY_STEP, HARD_FLOOR
} from '../src/renderer/lib/panelWidths'

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

describe('panelVarName', () => {
  // Pins the live-width -> CSS-var-name mapping the shell uses both for the
  // initial panelVars() inline style and for its imperative writes onto the
  // .wf-body element during a pointer drag (see ShellHandle in Review.tsx).
  it('maps sidebar to --gside-w and chat to --chat-w', () => {
    expect(panelVarName('sidebar')).toBe('--gside-w')
    expect(panelVarName('chat')).toBe('--chat-w')
  })
})

describe('clampPanelRange', () => {
  // The commit path range-clamps only: a narrow window must never persist a
  // viewport-guarded width as if the reviewer had chosen it.
  it('clamps into the panel range and ignores the viewport entirely', () => {
    expect(clampPanelRange('sidebar', 100)).toBe(220)
    expect(clampPanelRange('sidebar', 900)).toBe(520)
    expect(clampPanelRange('chat', 300)).toBe(300)
  })
})

describe('effectiveWidths', () => {
  // Stored width = the reviewer's PREFERRED width (range-clamped only).
  // Painted/announced width = the EFFECTIVE width: the preference put through
  // the viewport guard. The rule is sidebar-first, then chat against the
  // already-clamped sidebar, so the two panels can't both claim the same slack.
  it('leaves comfortable defaults untouched', () => {
    expect(effectiveWidths({ sidebar: 286, chat: 320, chatOpen: true, viewport: 1320 }))
      .toEqual({ sidebar: 286, chat: 320 })
  })

  it('clamps the sidebar first, then the chat against the clamped sidebar', () => {
    // sidebar guard: 1280 - 640 (preferred chat) - 480 = 160
    // chat guard:    1280 - 160 (clamped sidebar) - 480 = 640 -> full max
    expect(effectiveWidths({ sidebar: 520, chat: 640, chatOpen: true, viewport: 1280 }))
      .toEqual({ sidebar: 160, chat: 640 })
  })

  it('floors the sidebar and gives the chat only the remaining slack at 1000px', () => {
    // sidebar guard: 1000 - 640 - 480 = -120 -> HARD_FLOOR
    // chat guard:    1000 - 160 - 480 = 360
    expect(effectiveWidths({ sidebar: 520, chat: 640, chatOpen: true, viewport: 1000 }))
      .toEqual({ sidebar: 160, chat: 360 })
  })

  it('keeps the main pane at MAIN_MIN when both panels are dragged wide', () => {
    const { sidebar, chat } = effectiveWidths({ sidebar: 520, chat: 640, chatOpen: true, viewport: 1400 })
    expect({ sidebar, chat }).toEqual({ sidebar: 280, chat: 640 })
    expect(1400 - sidebar - chat).toBe(MAIN_MIN)
  })

  it('ignores a closed chat when guarding the sidebar', () => {
    expect(effectiveWidths({ sidebar: 520, chat: 320, chatOpen: false, viewport: 1000 }))
      .toEqual({ sidebar: 520, chat: 160 })
  })
})

describe('shouldPersist', () => {
  it('persists only when the committed width actually changes', () => {
    expect(shouldPersist(300, 286)).toBe(true)
    expect(shouldPersist(286, 286)).toBe(false)
  })
})

describe('per-panel lookup records', () => {
  it('maps each panel to its pref key, aria label and drag direction', () => {
    expect(PREF_KEYS).toEqual({ sidebar: 'sidebarWidth', chat: 'chatWidth' })
    expect(PANEL_LABELS).toEqual({ sidebar: 'Resize sidebar', chat: 'Resize chat drawer' })
    expect(PANEL_DIRECTIONS).toEqual({ sidebar: 1, chat: -1 })
  })
})
