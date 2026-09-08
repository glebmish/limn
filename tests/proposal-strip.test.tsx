import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import { ProposalStrip } from '../src/renderer/components/ProposalStrip'
import { useStore } from '../src/renderer/store'
import { clampStep, stripView, triageKey } from '../src/renderer/lib/proposals'
import type { ChatThread, Comment } from '../src/shared/types'
import type { LoadedReview } from '../src/shared/ipc'
import { initialStateOf } from './helpers/store'

type State = ReturnType<typeof useStore.getState>
const initial = (): State => initialStateOf(useStore)
function seed(patch: Partial<State>): void { Object.assign(initial() as unknown as Record<string, unknown>, patch) }
afterEach(() => seed({ loaded: null }))

const c = (id: string, over: Partial<Comment> = {}): Comment => ({
  id, anchor: { kind: 'diff', file: 'src/a.ts', side: 'new', line: 2, hunkRange: '', lineContent: '' }, author: 'agent', text: 'f', severity: 'note',
  status: 'proposed', source: { actionId: 'act', runId: 'run-9-2', threadId: 9 }, replies: [], createdAt: '2026-09-08T10:00:00Z', iteration: 1, ...over
})
const thread: ChatThread = {
  id: 9, kind: 'user', agent: { engine: 'claude' }, createdAt: 't', executionMode: 'auto', title: 'Simplify', action: { actionId: 'act', name: 'Simplify', kind: 'skill' },
  messages: [
    { role: 'user', text: '/simplify', at: 't1', run: { actionId: 'act', runId: 'run-9-1', n: 1, name: 'Simplify', kind: 'skill' } },
    { role: 'agent', text: 'x', at: 't2', runResult: { runId: 'run-9-1', outcome: 'finished' } },
    { role: 'user', text: '/simplify', at: 't3', run: { actionId: 'act', runId: 'run-9-2', n: 2, name: 'Simplify', kind: 'skill' } },
    { role: 'agent', text: 'x', at: 't4', runResult: { runId: 'run-9-2', outcome: 'finished' } }
  ]
}
const loadedWith = (comments: Comment[]): LoadedReview => ({ state: { repo: '/r', chats: [thread], comments, agent: { engine: 'claude' } }, skeleton: { files: [], headSha: 'h' }, volatile: [], artifacts: [], commits: [] } as unknown as LoadedReview)

describe('stripView', () => {
  it('follows the newest run with proposals and names it from its thread', () => {
    const v = stripView([c('a'), c('b', { status: 'dismissed' }), c('old', { source: { actionId: 'act', runId: 'run-9-1', threadId: 9 }, createdAt: '2026-09-08T09:00:00Z' })], [thread])!
    expect(v).toMatchObject({ runId: 'run-9-2', name: 'Simplify', kind: 'skill', n: 2, threadId: 9 })
    expect(v.open.map((x) => x.id)).toEqual(['a'])
    expect(v.dismissed.map((x) => x.id)).toEqual(['b'])
    expect(stripView([c('u', { author: 'user', status: 'queued', source: undefined })], [thread])).toBeNull()
    // review hotspots are proposals from the review run
    expect(stripView([c('h', { source: { actionId: 'review', runId: 'review-1' } })], [])).toMatchObject({ name: 'Review', threadId: null })
  })
  it('clampStep and triageKey', () => {
    expect(clampStep(-1, 0)).toBe(-1)
    expect(clampStep(5, 3)).toBe(2)
    expect(clampStep(-3, 3)).toBe(0)
    expect(['a', 'k', 'd', 'r', 'x'].map(triageKey)).toEqual(['accept', 'keep', 'dismiss', 'reply', null])
  })
})

describe('ProposalStrip', () => {
  it('renders the run, the count, the stepper, the bulk pair, restore and the thread link', () => {
    seed({ loaded: loadedWith([c('a'), c('b'), c('d', { status: 'dismissed' })]) })
    const html = renderToStaticMarkup(<ProposalStrip />)
    expect(html).toContain('class="ax-triage"')
    expect(html).toContain('Simplify · run 2')
    expect(html).toContain('<b>2 proposed</b>')
    expect(html).toContain('– of 2')
    expect(html).toContain('aria-label="Next proposal"')
    expect(html).toContain('Accept all')
    expect(html).toContain('Dismiss all')
    expect(html).toContain('1 dismissed · Restore')
    expect(html).toContain('thread ↗')
  })
  it('with nothing left it turns solid and offers Restore; with no proposals at all it renders nothing', () => {
    seed({ loaded: loadedWith([c('d', { status: 'dismissed' })]) })
    const html = renderToStaticMarkup(<ProposalStrip />)
    expect(html).toContain('class="ax-triage empty"')
    expect(html).toContain('no proposals left · 1 dismissed')
    expect(html).toContain('Restore')
    seed({ loaded: loadedWith([]) })
    expect(renderToStaticMarkup(<ProposalStrip />)).toBe('')
  })
})
