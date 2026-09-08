import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import { RunsPill } from '../src/renderer/components/RunsPill'
import { useStore, type OpState } from '../src/renderer/store'
import { pillModel } from '../src/renderer/lib/runsPill'
import type { ChatThread, Comment } from '../src/shared/types'
import type { LoadedReview } from '../src/shared/ipc'
import { initialStateOf } from './helpers/store'

type State = ReturnType<typeof useStore.getState>
const initial = (): State => initialStateOf(useStore)
function seed(patch: Partial<State>): void { Object.assign(initial() as unknown as Record<string, unknown>, patch) }
afterEach(() => seed({ loaded: null, ops: {}, seenThreadAt: {}, chatOpen: false, activeChatId: null }))

const NOW = Date.parse('2026-09-08T12:00:00Z')
const op = (over: Partial<OpState>): OpState => ({ running: true, opId: 'op', kind: 'chat', threadId: 1, log: [], error: null, startedAt: NOW - 41_000, outcome: null, errorCode: null, answeredApprovals: new Set(), exclusive: true, queued: null, ...over })
const review: ChatThread = { id: 1, kind: 'review', agent: { engine: 'claude' }, messages: [], createdAt: 't', executionMode: 'auto' }
const simplify: ChatThread = {
  id: 2, kind: 'user', agent: { engine: 'claude' }, createdAt: 't', executionMode: 'auto', title: 'Simplify', action: { actionId: 'act', name: 'Simplify', kind: 'skill' },
  messages: [{ role: 'user', text: '/simplify', at: '2026-09-08T11:00:00Z', run: { actionId: 'act', runId: 'run-2-2', n: 2, name: 'Simplify', kind: 'skill' } }]
}
const security: ChatThread = {
  id: 3, kind: 'user', agent: { engine: 'codex' }, createdAt: 't', executionMode: 'auto', title: 'Security review', action: { actionId: 'sec', name: 'Security review', kind: 'skill' },
  messages: [
    { role: 'user', text: '$security-review', at: '2026-09-08T11:50:00Z', run: { actionId: 'sec', runId: 'run-3-1', n: 1, name: 'Security review', kind: 'skill' } },
    { role: 'agent', text: 'done', at: '2026-09-08T11:57:00Z', runResult: { runId: 'run-3-1', outcome: 'finished' } }
  ]
}
const rebase: ChatThread = { id: 4, kind: 'user', agent: { engine: 'claude' }, createdAt: 't', executionMode: 'auto', title: 'Rebase onto main', action: { actionId: 'rb', name: 'Rebase onto main', kind: 'prompt' }, messages: [{ role: 'user', text: 'Rebase', at: 't', run: { actionId: 'rb', runId: 'run-4-1', n: 1, name: 'Rebase onto main', kind: 'prompt' } }] }
const finding = (id: string, runId: string, status: Comment['status'] = 'proposed'): Comment => ({ id, anchor: { kind: 'diff', file: 'a.ts', side: 'new', line: 1, hunkRange: '', lineContent: '' }, author: 'agent', text: 'f', status, source: { actionId: 'x', runId }, replies: [], createdAt: 't', iteration: 1 })
const chats = [review, simplify, security, rebase]
const comments = [finding('a', 'run-2-2'), finding('b', 'run-2-2'), finding('s1', 'run-3-1'), finding('s2', 'run-3-1'), finding('s3', 'run-3-1'), finding('s4', 'run-3-1')]

describe('pillModel', () => {
  it('lists running, queued (in order, with what they wait on) and finished-unseen runs', () => {
    const ops = {
      g: op({ opId: 'g', kind: 'review', threadId: 1, startedAt: NOW - 80_000 }),
      s: op({ opId: 's', threadId: 2 }),
      r: op({ opId: 'r', threadId: 4, queued: { position: 1, behind: 'Generating the review' } })
    }
    const m = pillModel({ ops, chats, comments, seenThreadAt: {}, shownThreadId: null, approvalsPending: 0, now: NOW })
    expect(m.running.map((r) => [r.title, r.sub, r.time])).toEqual([
      ['Generating the review', 'Claude · exploring the branch', '1 m 20 s'],
      ['Simplify · run 2', 'Claude · 2 findings so far', '41 s']
    ])
    expect(m.queued.map((r) => [r.title, r.sub, r.time])).toEqual([['Rebase onto main · run 1', 'needs the lane · starts when Generating the review ends', '1st']])
    expect(m.unseen.map((r) => [r.title, r.sub, r.time, r.threadId])).toEqual([['Security review · run 1', 'Codex · 4 findings proposed', '3 min ago', 3]])
    expect(m.pill).toEqual({ kind: 'run', text: '2 running · 1 queued' })
  })
  it('amber when an approval waits; dashed proposed when only unseen results remain; nothing when quiet', () => {
    expect(pillModel({ ops: { s: op({ opId: 's', threadId: 2 }) }, chats, comments, seenThreadAt: {}, shownThreadId: null, approvalsPending: 1, now: NOW }).pill).toEqual({ kind: 'amber', text: 'approval · 1 running' })
    expect(pillModel({ ops: {}, chats, comments, seenThreadAt: {}, shownThreadId: null, approvalsPending: 0, now: NOW }).pill).toEqual({ kind: 'new', text: '4 proposed' })
    // seen after it ended, or showing in the drawer right now → no longer unseen
    expect(pillModel({ ops: {}, chats, comments, seenThreadAt: { 3: '2026-09-08T11:58:00Z' }, shownThreadId: null, approvalsPending: 0, now: NOW }).pill).toBeNull()
    expect(pillModel({ ops: {}, chats, comments, seenThreadAt: {}, shownThreadId: 3, approvalsPending: 0, now: NOW }).pill).toBeNull()
    // seen BEFORE it ended still counts as unseen
    expect(pillModel({ ops: {}, chats, comments, seenThreadAt: { 3: '2026-09-08T11:51:00Z' }, shownThreadId: null, approvalsPending: 0, now: NOW }).pill).toEqual({ kind: 'new', text: '4 proposed' })
    // all its proposals triaged → nothing to see
    expect(pillModel({ ops: {}, chats, comments: comments.map((c) => ({ ...c, status: 'queued' as const })), seenThreadAt: {}, shownThreadId: null, approvalsPending: 0, now: NOW }).pill).toBeNull()
  })
})

describe('RunsPill', () => {
  const loaded = { state: { repo: '/r', chats, comments, agent: { engine: 'claude' } }, skeleton: { files: [], headSha: 'h' }, volatile: [], artifacts: [], commits: [] } as unknown as LoadedReview
  it('renders the Chat button with the running pill', () => {
    seed({ loaded, ops: { s: op({ opId: 's', threadId: 2 }), r: op({ opId: 'r', threadId: 4, queued: { position: 1, behind: 'Simplify' } }) } })
    const html = renderToStaticMarkup(<RunsPill chatOpen={false} onToggle={() => {}} />)
    expect(html).toContain('>Chat<span class="pill pill-run" data-pill="run">')
    expect(html).toContain('1 running · 1 queued')
  })
  it('renders the dashed proposed pill when a run finished unseen, and none when quiet', () => {
    seed({ loaded, ops: {} })
    expect(renderToStaticMarkup(<RunsPill chatOpen={false} onToggle={() => {}} />)).toContain('data-pill="new">4 proposed')
    seed({ loaded, ops: {}, seenThreadAt: { 3: '2026-09-08T11:59:00Z' } })
    expect(renderToStaticMarkup(<RunsPill chatOpen={false} onToggle={() => {}} />)).not.toContain('class="pill')
  })
})
