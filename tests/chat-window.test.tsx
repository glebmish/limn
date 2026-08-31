import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { SubmittedCommentRefs, windowMessages } from '../src/renderer/components/ChatDrawer'
import type { Comment } from '../src/shared/types'

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

// The submitted-batch rows jump to each comment. A comment the re-anchor pass could
// not place (`notInDiff` / status 'outdated') has no line to land on, so the row must
// name the file alone and say why — same rule the point/comment cards follow.
describe('SubmittedCommentRefs — comments the re-anchor pass could not place', () => {
  const cmt = (over: Partial<Comment> = {}): Comment => ({
    id: 'c1', author: 'user', text: 'why this?', status: 'sent', replies: [], createdAt: 'now', iteration: 1,
    anchor: { kind: 'diff', file: 'src/a.ts', side: 'new', line: 14, hunkRange: '', lineContent: 'x' },
    ...over
  })
  const render = (c: Comment): string =>
    renderToStaticMarkup(<SubmittedCommentRefs commentRefs={[c.id]} comments={[c]} />)

  it('keeps file:line for a comment that is still placed', () => {
    expect(render(cmt())).toContain('a.ts:14')
  })

  it('drops the stale line and explains the degraded jump', () => {
    const lost = render(cmt({ notInDiff: true }))
    expect(lost).not.toContain('a.ts:14')
    expect(lost).toContain('not shown in this diff')
    const stale = render(cmt({ status: 'outdated' }))
    expect(stale).not.toContain('a.ts:14')
    expect(stale).toContain('changed since this comment')
  })
})
