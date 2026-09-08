import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import { ActionRunBar } from '../src/renderer/components/ActionRunBar'
import { ActionResultCard } from '../src/renderer/components/ActionResultCard'
import { ActionChips } from '../src/renderer/components/ActionChips'
import { ChatDrawer } from '../src/renderer/components/ChatDrawer'
import { useStore, type OpState } from '../src/renderer/store'
import { FINDING_HARNESS } from '../src/shared/actions'
import type { ActionRunRef, ChatMessage, ChatThread, Comment } from '../src/shared/types'
import type { LoadedReview } from '../src/shared/ipc'
import { initialStateOf } from './helpers/store'

type State = ReturnType<typeof useStore.getState>
const initial = (): State => initialStateOf(useStore)
function seed(patch: Partial<State>): void { Object.assign(initial() as unknown as Record<string, unknown>, patch) }
afterEach(() => seed({ loaded: null, ops: {}, chatOpen: false, activeChatId: null }))

const run = (n: number, kind: ActionRunRef['kind'] = 'skill'): ActionRunRef => ({ actionId: 'act', runId: `run-9-${n}`, n, name: kind === 'skill' ? 'Simplify' : 'Rebase onto main', kind })
const launch = (r: ActionRunRef, text = `/simplify\n\n${FINDING_HARNESS}`): ChatMessage => ({ role: 'user', text, at: '2026-09-08T10:00:00Z', run: r })
const ended = (runId: string, outcome: 'finished' | 'refused' | 'failed' | 'cancelled', extra: Record<string, unknown> = {}, text = 'Four simplifications, none behavioural.'): ChatMessage =>
  ({ role: 'agent', text, at: '2026-09-08T10:01:12Z', runResult: { runId, outcome, ...extra } })
const thread = (messages: ChatMessage[], over: Partial<ChatThread> = {}): ChatThread =>
  ({ id: 9, kind: 'user', agent: { engine: 'claude' }, messages, createdAt: 't', executionMode: 'auto', title: 'Simplify', action: { actionId: 'act', name: 'Simplify', kind: 'skill' }, ...over })
const idle: OpState = { running: false, opId: null, kind: null, threadId: null, log: [], error: null, startedAt: null, outcome: null, errorCode: null, answeredApprovals: new Set(), exclusive: false, queued: null }
const live: OpState = { ...idle, running: true, opId: 'op-9', kind: 'chat', threadId: 9, exclusive: true }
const finding = (id: string, status: Comment['status'] = 'proposed'): Comment =>
  ({ id, anchor: { kind: 'diff', file: 'src/billing/invoice.ts', side: 'new', line: 119, hunkRange: '', lineContent: '' }, author: 'agent', text: 'rows.reduce duplicates gross()', severity: 'note', status, source: { actionId: 'act', runId: 'run-9-1', threadId: 9 }, replies: [], createdAt: 't', iteration: 1 })
const loadedWith = (comments: Comment[], chats: ChatThread[] = []): LoadedReview =>
  ({ state: { repo: '/r', chats, comments, agent: { engine: 'claude' } }, skeleton: { files: [], headSha: 'h' }, volatile: [], artifacts: [], commits: [] } as unknown as LoadedReview)

describe('ActionRunBar', () => {
  it('running: the skill as invoked, the run number, and Cancel', () => {
    const html = renderToStaticMarkup(<ActionRunBar thread={thread([launch(run(1))])} op={live} />)
    expect(html).toContain('class="ax-runbar"')
    expect(html).toContain('Running <b class="mono">/simplify</b> · run 1 · findings attach as proposed')
    expect(html).toContain('>Cancel</button>')
  })
  it('queued: place, what it is behind, and Don’t wait', () => {
    const html = renderToStaticMarkup(<ActionRunBar thread={thread([launch(run(1))])} op={{ ...live, queued: { position: 2, behind: 'Generating the review' } }} />)
    expect(html).toContain('class="ax-runbar wait"')
    expect(html).toContain('Queued · 2nd, behind Generating the review.')
    expect(html).toContain('Don’t wait')
  })
  it('finished: count, duration, Re-run — and the trusted-cache note when the session sent no list', () => {
    seed({ loaded: loadedWith([finding('a'), finding('b', 'queued')]) })
    const html = renderToStaticMarkup(<ActionRunBar thread={thread([launch(run(1)), ended('run-9-1', 'finished')])} op={idle} />)
    expect(html).toContain('class="ax-runbar done"')
    expect(html).toContain('Finished · run 1 · <b>2 findings</b> · 1 m 12 s')
    expect(html).toContain('>Re-run</button>')
    const trusted = renderToStaticMarkup(<ActionRunBar thread={thread([launch(run(1)), ended('run-9-1', 'finished', { availabilityFrom: new Date().toISOString() })])} op={idle} />)
    expect(trusted).toContain('availability from just now')
  })
  it('refused: the reason, Check again, and Run with the other engine when no session was bound', () => {
    const t = thread([launch(run(1)), ended('run-9-1', 'refused', { error: 'Simplify is not installed for Codex in this repo — the session opened, reported its commands, and $simplify was not among them. Nothing was sent.' })], { agent: { engine: 'codex' } })
    const html = renderToStaticMarkup(<ActionRunBar thread={t} op={idle} />)
    expect(html).toContain('class="ax-runbar err"')
    expect(html).toContain('<b>Simplify is not installed for Codex in this repo</b>')
    expect(html).toContain('Nothing was sent.')
    expect(html).toContain('Check again')
    expect(html).toContain('Run with Claude instead')
    const bound = renderToStaticMarkup(<ActionRunBar thread={{ ...t, engineSessionId: 'sess' }} op={idle} />)
    expect(bound).not.toContain('Run with Claude instead')
  })
  it('cancelled and failed read plainly; a thread without a run renders nothing', () => {
    expect(renderToStaticMarkup(<ActionRunBar thread={thread([launch(run(1)), ended('run-9-1', 'cancelled')])} op={idle} />)).toContain('Run 1 cancelled.')
    expect(renderToStaticMarkup(<ActionRunBar thread={thread([launch(run(1)), ended('run-9-1', 'failed', { error: 'boom' })])} op={idle} />)).toContain('<b>Run 1 failed.</b> boom')
    expect(renderToStaticMarkup(<ActionRunBar thread={thread([{ role: 'user', text: 'plain', at: 't' }], { action: undefined })} op={idle} />)).toBe('')
  })
})

describe('ActionResultCard', () => {
  it('counts the run\'s proposals with the bulk pair and Show in diff', () => {
    seed({ loaded: loadedWith([finding('a'), finding('b'), finding('c', 'dismissed')]) })
    const html = renderToStaticMarkup(<ActionResultCard thread={thread([launch(run(1)), ended('run-9-1', 'finished')])} runId="run-9-1" agentText="report" />)
    expect(html).toContain('Run finished · <b>3 findings</b> · 2 still proposed · 1 dismissed')
    expect(html).toContain('>Accept all 2</button>')
    expect(html).toContain('>Dismiss all</button>')
    expect(html).toContain('Show in diff')
    expect(html).toContain('Re-running replaces proposals you haven’t touched')
  })
  it('a skill run that ended in prose offers Attach findings and Keep as prose; kept hides the card', () => {
    seed({ loaded: loadedWith([]) })
    const html = renderToStaticMarkup(<ActionResultCard thread={thread([launch(run(1)), ended('run-9-1', 'finished')])} runId="run-9-1" agentText="## Review report\n1. Retry backoff" />)
    expect(html).toContain('The report attached nothing to the code')
    expect(html).toContain('Attach findings')
    expect(html).toContain('Keep as prose')
    const kept = renderToStaticMarkup(<ActionResultCard thread={thread([launch(run(1)), ended('run-9-1', 'finished', { keepProse: true })])} runId="run-9-1" agentText="report" />)
    expect(kept).toBe('')
  })
  it('a prompt run with no findings shows nothing; a superseded run says so', () => {
    seed({ loaded: loadedWith([]) })
    const prompt = renderToStaticMarkup(<ActionResultCard thread={thread([launch(run(1, 'prompt'), 'Explain the churn'), ended('run-9-1', 'finished')])} runId="run-9-1" agentText="It moved." />)
    expect(prompt).toBe('')
    seed({ loaded: loadedWith([finding('a', 'queued')]) })
    const old = renderToStaticMarkup(<ActionResultCard thread={thread([launch(run(1)), ended('run-9-1', 'finished'), launch(run(2)), ended('run-9-2', 'finished')])} runId="run-9-1" agentText="x" />)
    expect(old).toContain('Superseded by run 2 · 1 you took stayed')
    expect(old).not.toContain('Accept all')
  })
})

describe('the finding chip and the run prompt bubble in the drawer', () => {
  it('a finding_added action renders the dashed mark, severity, location and body; a triaged one says so', () => {
    seed({ loaded: loadedWith([finding('a', 'queued')]) })
    const html = renderToStaticMarkup(<ActionChips actions={[{ kind: 'finding_added', comment: finding('a') }, { kind: 'finding_added', comment: finding('zz') }]} engine="claude" threadId={9} />)
    expect(html).toContain('class="limn-act ax-finding"')
    expect(html).toContain('class="ax-fmark off"')
    expect(html).toContain('accepted')
    expect(html).toContain('sev-note')
    expect(html).toContain('invoice.ts:119')
    expect(html).toContain('rows.reduce duplicates gross()')
    // the second finding no longer exists in the review: swept by a re-run
    expect(html).toContain('swept')
  })
  it('the launching bubble shows the kind glyph, the invocation, the run number and the folded harness; the run bar sits under the head', () => {
    const t = thread([launch(run(1))])
    seed({ chatOpen: true, activeChatId: 9, loaded: loadedWith([], [t]), ops: { 'op-9': live } })
    const html = renderToStaticMarkup(<ChatDrawer open onClose={() => {}} />)
    expect(html).toContain('class="chat-bubble ax-prompt"')
    expect(html).toContain('<span class="ax-prompt-text">/simplify</span>')
    expect(html).toContain('run 1')
    expect(html).toContain('+ Limn: report each finding with add_finding')
    expect(html).toContain('>Show</a>')
    expect(html).toContain('class="ax-runbar"')
    expect(html).toContain('<span class="cd-name">Simplify</span>')
  })
})
