import { describe, expect, it } from 'vitest'
import type { Comment } from '../src/shared/types'
import { withUserReply } from '../src/shared/commentReply'

const base = (over: Partial<Comment> = {}): Comment => ({
  id: 'c1',
  anchor: { kind: 'diff', file: 'src/a.ts', side: 'new', line: 30, hunkRange: '', lineContent: '' },
  author: 'user',
  text: 'using text and prefix for logic smells',
  status: 'resolved',
  resolution: { verdict: 'addressed', note: 'Replaced the prefix with a union.', agentRef: { engine: 'codex' } },
  replies: [],
  createdAt: 't0',
  iteration: 1,
  ...over
})

// A review thread can have many turns (GitHub-style). The reviewer's reply is not a
// new comment and not a bare re-send of the old text: it continues the thread, and
// the agent's next batch gets the whole exchange.
describe('withUserReply', () => {
  it('appends the reply and re-queues the comment', () => {
    const out = withUserReply(base(), 'not quite — the summary still counts by prefix', 't1')
    expect(out.status).toBe('queued')
    expect(out.replies.at(-1)).toEqual({ author: 'user', text: 'not quite — the summary still counts by prefix', at: 't1' })
  })

  it('folds a resolved verdict + note into the thread as the agent turn before the reply, keeping the verdict', () => {
    const out = withUserReply(base(), 'again', 't1')
    expect(out.replies).toHaveLength(2)
    expect(out.replies[0]).toEqual({
      author: 'agent', text: 'Replaced the prefix with a union.', at: 't1',
      agentRef: { engine: 'codex' }, threadId: undefined, verdict: 'addressed'
    })
    expect(out.resolution).toBeUndefined() // the next resolution starts clean — it cannot overwrite this one
  })

  it('keeps earlier turns in order: comment, resolution, reply, resolution, reply', () => {
    const once = withUserReply(base(), 'first follow-up', 't1')
    const resolvedAgain: Comment = { ...once, status: 'resolved', resolution: { verdict: 'reworked', note: 'Reworked the summary.' } }
    const twice = withUserReply(resolvedAgain, 'second follow-up', 't2')
    expect(twice.replies.map((r) => [r.author, r.verdict ?? null, r.text])).toEqual([
      ['agent', 'addressed', 'Replaced the prefix with a union.'],
      ['user', null, 'first follow-up'],
      ['agent', 'reworked', 'Reworked the summary.'],
      ['user', null, 'second follow-up']
    ])
  })

  it('does not invent an agent turn for a thread that was never resolved (an outdated one, say)', () => {
    const out = withUserReply(base({ status: 'outdated', resolution: undefined }), 'still relevant', 't1')
    expect(out.replies).toEqual([{ author: 'user', text: 'still relevant', at: 't1' }])
    expect(out.status).toBe('queued')
  })

  it('works on an agent hotspot too — agreeing with it in words, not just re-queueing it', () => {
    const out = withUserReply(base({ id: 'hs-1', author: 'agent', severity: 'risk', resolution: undefined }), 'agree, fix it', 't1')
    expect(out.status).toBe('queued')
    expect(out.replies).toEqual([{ author: 'user', text: 'agree, fix it', at: 't1' }])
  })

  it('keeps a proposal proposed — a reply marks it touched, it does not accept it', () => {
    const out = withUserReply(base({ id: 'af-1', author: 'agent', severity: 'note', status: 'proposed', resolution: undefined, source: { actionId: 'a', runId: 'r' } }), 'is this really duplicated?', 't1')
    expect(out.status).toBe('proposed')
    expect(out.replies).toEqual([{ author: 'user', text: 'is this really duplicated?', at: 't1' }])
    expect(out.source).toEqual({ actionId: 'a', runId: 'r' })
  })
})
