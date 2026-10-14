import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ActionLauncher } from '../src/renderer/components/ActionLauncher'
import { ChatDrawer } from '../src/renderer/components/ChatDrawer'
import { dev } from '../src/renderer/dev'
import { useStore } from '../src/renderer/store'
import type { ActionDef, ChatThread } from '../src/shared/types'
import type { LoadedReview } from '../src/shared/ipc'
import type { CommandAvailability } from '../src/shared/actions'
import { initialStateOf } from './helpers/store'

type State = ReturnType<typeof useStore.getState>
const initial = (): State => initialStateOf(useStore)
function seed(patch: Partial<State>): void { Object.assign(initial() as unknown as Record<string, unknown>, patch) }

const SIMPLIFY: ActionDef = { id: 'a', kind: 'skill', name: 'Simplify', body: 'simplify' }
const REBASE: ActionDef = { id: 'b', kind: 'prompt', name: 'Rebase onto main', body: 'Rebase this branch onto main' }
const avail = (engine: 'claude' | 'codex', over: Partial<CommandAvailability> = {}): CommandAvailability =>
  ({ engine, repo: '/r/acme', names: ['simplify'], checkedAt: new Date().toISOString(), state: 'ok', ...over })
const thread = (id: number, over: Partial<ChatThread> = {}): ChatThread =>
  ({ id, kind: 'user', agent: { engine: 'claude' }, messages: [{ role: 'user', text: 'hi', at: 't' }], createdAt: 't', executionMode: 'auto', title: `Chat ${id}`, ...over })
const loadedWith = (chats: ChatThread[]): LoadedReview =>
  ({ state: { repo: '/r/acme', chats, comments: [], agent: { engine: 'claude' } }, skeleton: { files: [], headSha: 'h' }, volatile: [], artifacts: [], commits: [] } as unknown as LoadedReview)

beforeEach(() => { dev.openLauncher = true; dev.launcherPane = undefined })
afterEach(() => {
  dev.openLauncher = undefined; dev.launcherPane = undefined
  seed({ actions: [], commands: {}, loaded: null, defaultAgent: { engine: 'claude' }, ops: {} })
})

describe('ActionLauncher — the list pane', () => {
  it('names the default agent in the head and renders a row per pinned action', () => {
    seed({ actions: [SIMPLIFY, REBASE], defaultAgent: { engine: 'codex', model: 'gpt-6-luna' }, loaded: loadedWith([]), commands: { '/r/acme': [avail('claude'), avail('codex', { names: ['$simplify'] })] } })
    const html = renderToStaticMarkup(<ActionLauncher />)
    expect(html).toContain('class="ax-bolt on"')
    expect(html).toContain('runs with')
    expect(html).toMatch(/ax-head-agent[^>]*>[\s\S]*?Codex/)
    const rows = html.split('class="ax-row"').slice(1)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toContain('<b>Simplify</b>')
    expect(rows[0]).toContain('data-mark="ok"')
    expect(rows[0]).toContain('aria-label="Options for Simplify"')
    expect(rows[1]).toContain('<b>Rebase onto main</b>')
    expect(rows[1].split('ax-more')[0]).not.toContain('ax-engs')
    expect(html).toContain('Edit…')
    expect(html).toContain('Refresh')
  })

  it('mutes a skill row the default agent cannot run, and says so', () => {
    seed({ actions: [SIMPLIFY], defaultAgent: { engine: 'codex' }, loaded: loadedWith([]), commands: { '/r/acme': [avail('claude'), avail('codex', { names: ['review'], state: 'ok' })] } })
    const html = renderToStaticMarkup(<ActionLauncher />)
    expect(html).toContain('class="ax-row blocked"')
    expect(html).toContain('data-cur="Codex"')
    expect(html).toContain('title="Not on Codex — click for options"')
  })

  it('shows a running action as busy', () => {
    const t = thread(4, { action: { actionId: 'a', name: 'Simplify', kind: 'skill' } })
    seed({ actions: [SIMPLIFY], loaded: loadedWith([t]), ops: { op1: { running: true, opId: 'op1', kind: 'chat', threadId: 4, log: [], error: null, startedAt: 0, outcome: null, errorCode: null, answeredApprovals: new Set(), exclusive: true, queued: null } } })
    const html = renderToStaticMarkup(<ActionLauncher />)
    expect(html).toContain('class="ax-row busy"')
    expect(html).toContain('Simplify · running…')
  })

  it('renders the empty state with a link to Settings when nothing is pinned', () => {
    seed({ loaded: loadedWith([]) })
    const html = renderToStaticMarkup(<ActionLauncher />)
    expect(html).toContain('No actions yet')
    expect(html).toContain('Add one in Settings')
  })
})

describe('ActionLauncher — the target pane', () => {
  it('offers a new thread with an agent picker, mode auto, and a block when the engine lacks the skill', () => {
    dev.launcherPane = 'target'
    seed({ actions: [SIMPLIFY], defaultAgent: { engine: 'codex' }, loaded: loadedWith([]), commands: { '/r/acme': [avail('claude'), avail('codex', { names: [], state: 'empty' })] } })
    const html = renderToStaticMarkup(<ActionLauncher />)
    expect(html).toContain('class="ax-pane ax-target"')
    expect(html).toContain('<b>Simplify</b>')
    expect(html).toContain('Run in')
    expect(html).toContain('New thread')
    expect(html).toContain('class="ag-trigger"')
    expect(html).toContain('mode auto')
    expect(html).toContain('Simplify is not installed for Codex')
    expect(html).toContain('$simplify')
    expect(html).toContain('Use Claude')
    expect(html).toContain('findings attach as proposed comments')
    expect(html).toMatch(/class="btn btn-sm btn-primary ax-run" disabled=""[^>]*>Run Simplify/)
  })

  it('enables Run when the default engine has the skill', () => {
    dev.launcherPane = 'target'
    seed({ actions: [SIMPLIFY], loaded: loadedWith([]), commands: { '/r/acme': [avail('claude')] } })
    const html = renderToStaticMarkup(<ActionLauncher />)
    expect(html).not.toContain('is not installed')
    expect(html).toMatch(/class="btn btn-sm btn-primary ax-run"(?! disabled)[^>]*>Run Simplify/)
  })

  it('a pending probe shows the waiting block', () => {
    dev.launcherPane = 'target'
    seed({ actions: [SIMPLIFY], loaded: loadedWith([]), commands: { '/r/acme': [avail('claude', { state: 'checking' })] } })
    const html = renderToStaticMarkup(<ActionLauncher />)
    expect(html).toContain('Checking Claude — its session is opening')
  })
})

describe('ChatDrawer — the bolt is in the head', () => {
  it('renders the launcher beside the chat selector, and in the empty drawer too', () => {
    dev.openLauncher = undefined
    seed({ chatOpen: true, loaded: loadedWith([thread(1)]), actions: [SIMPLIFY] })
    const withChats = renderToStaticMarkup(<ChatDrawer open onClose={() => {}} />)
    expect(withChats).toContain('class="chatdd-trig"')
    expect(withChats).toContain('aria-label="Run an action"')
    seed({ loaded: loadedWith([]) })
    const empty = renderToStaticMarkup(<ChatDrawer open onClose={() => {}} />)
    expect(empty).toContain('Generate a guided review first')
    expect(empty).toContain('aria-label="Run an action"')
  })
})
