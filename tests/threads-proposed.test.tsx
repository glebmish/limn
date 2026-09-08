import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { Comment } from '../src/shared/types'
import { InlineThread } from '../src/renderer/components/Threads'
import { commentCounts, openProposals, ownedComments, proposalsByRun, sectionCommentCounts } from '../src/renderer/lib/comments'

const c = (over: Partial<Comment> = {}): Comment => ({
  id: 'af-1', anchor: { kind: 'diff', file: 'src/a.ts', side: 'new', line: 2, hunkRange: '', lineContent: '' },
  author: 'agent', text: 'rows.reduce duplicates gross()', severity: 'note', status: 'proposed',
  source: { actionId: 'act', runId: 'run-1', threadId: 9 }, replies: [], createdAt: '2026-09-08T10:00:00Z', iteration: 1, ...over
})
const html = (x: Comment): string => renderToStaticMarkup(<InlineThread c={x} locLabel="on line 2" />)

describe('InlineThread — a proposed finding', () => {
  it('renders the dashed box, the proposed pill, the severity, and only Accept · Keep · Dismiss · Reply', () => {
    const out = html(c())
    expect(out).toContain('class="box agent proposed" tabindex="0"')
    expect(out).toContain('data-proposed="true"')
    expect(out).toContain('class="pill pill-prop">proposed')
    expect(out).toContain('sev-note')
    expect(out).toContain('class="bf ax-triage-bf"')
    expect(out).toContain('>Accept</button>')
    expect(out).toContain('>Keep</button>')
    expect(out).toContain('>Dismiss</button>')
    expect(out).toContain('>Reply</button>')
    expect(out).not.toContain('Re-queue')
    expect(out).not.toContain('Delete')
  })
  it('a replied-to proposal says so and stays proposed', () => {
    const out = html(c({ replies: [{ author: 'user', text: 'is it really?', at: 't' }] }))
    expect(out).toContain('replied')
    expect(out).toContain('pill-prop')
    expect(out).toContain('>Accept</button>')
  })
  it('a dismissed proposal renders nothing; an accepted one is an ordinary queued comment', () => {
    expect(html(c({ status: 'dismissed' }))).toBe('')
    const accepted = html(c({ status: 'queued' }))
    expect(accepted).not.toContain('proposed')
    expect(accepted).toContain('queued for agent')
    expect(accepted).toContain('sev-note') // the severity survives as a badge
  })
  it('a kept proposal is a resolved agent note with Reply / Re-queue', () => {
    const kept = html(c({ status: 'resolved' }))
    expect(kept).not.toContain('pill-prop')
    expect(kept).toContain('Re-queue')
  })
})

describe('comment count helpers', () => {
  const list = [c(), c({ id: 'p2', status: 'dismissed' }), c({ id: 'u1', author: 'user', status: 'queued', source: undefined, anchor: { kind: 'diff', file: 'src/b.ts', side: 'new', line: 1, hunkRange: '', lineContent: '' } }), c({ id: 'k1', status: 'resolved' }), c({ id: 'r2', source: { actionId: 'act', runId: 'run-2' }, createdAt: '2026-09-08T11:00:00Z' })]
  it('splits owned from proposed, ignoring dismissed', () => {
    expect(ownedComments(list).map((x) => x.id)).toEqual(['u1', 'k1'])
    expect(openProposals(list).map((x) => x.id)).toEqual(['af-1', 'r2'])
    expect(commentCounts(list)).toEqual({ comments: 2, proposed: 2 })
  })
  it('counts per section by file', () => {
    expect(sectionCommentCounts(['src/a.ts'], list)).toEqual({ owned: 1, proposed: 2 })
    expect(sectionCommentCounts(['src/b.ts'], list)).toEqual({ owned: 1, proposed: 0 })
    expect(sectionCommentCounts(['src/z.ts'], list)).toEqual({ owned: 0, proposed: 0 })
  })
  it('groups proposals by run, newest run first, open and dismissed apart', () => {
    const runs = proposalsByRun(list)
    expect(runs.map((r) => r.runId)).toEqual(['run-2', 'run-1'])
    expect(runs[1].open.map((x) => x.id)).toEqual(['af-1'])
    expect(runs[1].dismissed.map((x) => x.id)).toEqual(['p2'])
  })
})
