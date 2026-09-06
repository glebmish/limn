import { describe, expect, it } from 'vitest'
import { windowMessages } from '../src/renderer/components/ChatDrawer'

/** The chat list only mounts the last `shown` messages; everything older is hidden
 *  behind a "Show earlier messages (N hidden)" button. `windowMessages` is the pure
 *  slice arithmetic behind that — unit-tested directly (the full drawer needs a live
 *  zustand store + window.api, out of scope for this layer). */
describe('windowMessages', () => {
  const make = (n: number) => Array.from({ length: n }, (_, i) => ({ text: `m${i}` }))

  it('windows 250 messages at shown=100 to the last 100 with 150 hidden', () => {
    const msgs = make(250)
    const { start, visible, hidden } = windowMessages(msgs, 100)

    expect(start).toBe(150)
    expect(hidden).toBe(150)
    expect(visible).toHaveLength(100)
    // the visible slice is the *tail* — last message is m249, first is m150
    expect(visible[0].text).toBe('m150')
    expect(visible[visible.length - 1].text).toBe('m249')
    // this is exactly the button label the drawer renders
    expect(`Show earlier messages (${hidden} hidden)`).toBe('Show earlier messages (150 hidden)')
  })

  it('hides nothing when the message count is at or below the window', () => {
    for (const n of [0, 1, 80, 100]) {
      const { start, visible, hidden } = windowMessages(make(n), 100)
      expect(start).toBe(0)
      expect(hidden).toBe(0) // hidden === 0 → no "Show earlier" button
      expect(visible).toHaveLength(n)
    }
  })

  it('reveals another 100 per click (shown grows by CHAT_WINDOW)', () => {
    const msgs = make(250)
    // second click: shown = 200
    const two = windowMessages(msgs, 200)
    expect(two.start).toBe(50)
    expect(two.hidden).toBe(50)
    expect(two.visible).toHaveLength(200)
    // third click: shown = 300 (> count) → everything shown, nothing hidden
    const three = windowMessages(msgs, 300)
    expect(three.start).toBe(0)
    expect(three.hidden).toBe(0)
    expect(three.visible).toHaveLength(250)
  })
})
