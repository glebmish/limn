import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/server/db/db'
import { getSession, listChatThreads, loadReviewState } from '../src/server/db/sessions'
import { registerIpc, shutdownIpc } from '../src/server/ipc'
import { issueCliOpen, setGenerationKicker, _getGenerationKicker, _resetTickets } from '../src/server/cliOpen'
import { releaseFakeHolds } from '../src/server/engines/fake'
import { makeFixtureRepo, fixtureGit } from './helpers/fixtureRepo'
import type { EngineId } from '../src/shared/types'
import type { EngineRun, ReviewRequest } from '../src/server/engines/types'
import type { ParsedReview } from '../src/server/engines/schema'
import type { LoadedReview, OpEventMsg, OpResultMsg } from '../src/shared/ipc'
import type { Transport } from '../src/server/transport'

// The CLI kick passes no steer, so the fake engine's `[hold]` affordance is out of
// reach: this seam injects it, letting a test observe a CLI-kicked generation while
// it is genuinely in flight (lane held, op live).
const engineHooks = vi.hoisted(() => ({ hold: false }))
vi.mock('../src/server/engines/index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/server/engines/index')>()
  const { FakeEngine } = await import('../src/server/engines/fake')
  class HoldableFake extends FakeEngine {
    generateReview(req: ReviewRequest): EngineRun<ParsedReview> {
      return super.generateReview(engineHooks.hold ? { ...req, steer: '[hold]' } : req)
    }
  }
  return { ...actual, makeEngine: (id: EngineId) => new HoldableFake(id) }
})

interface Harness {
  db: ReturnType<typeof openDb>['db']
  repo: string
  handlers: Map<string, (...args: unknown[]) => Promise<unknown>>
  results: OpResultMsg[]
  events: OpEventMsg[]
}

function setup(): Harness {
  const { dir } = makeFixtureRepo()
  const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'limn-cligen-')), 'db')).db
  const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>()
  const results: OpResultMsg[] = []
  const events: OpEventMsg[] = []
  const transport: Transport = {
    handle(name, fn) { handlers.set(name, fn as (...a: unknown[]) => Promise<unknown>) },
    broadcast(channel, msg) {
      if (channel === 'op:result') results.push(msg as OpResultMsg)
      if (channel === 'op:event') events.push(msg as OpEventMsg)
    },
    notify() { /* unused */ },
    async pickDirectory() { return null }
  }
  registerIpc(db, [], transport)
  // repoRoot realpaths the dir (/private/var vs /var on macOS) — the kicker and every
  // session row use that form, so tests compare against it.
  return { db, repo: fs.realpathSync(dir), handlers, results, events }
}

async function waitFor(what: string, cond: () => boolean): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > 10000) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

const heldGeneration = (h: Harness): Promise<void> =>
  waitFor('the generation to park', () =>
    h.events.some((e) => e.event.type === 'status' && e.event.text.startsWith('holding')))

const settled = (h: Harness, opId: string): Promise<void> =>
  waitFor(`op ${opId} to settle`, () => h.results.some((r) => r.opId === opId))

/** The op id the kicker minted (server-side ids are `op-cli-<12 hex>`). The kick is
 *  fire-and-forget, so wait for its first event rather than reading an empty log. */
async function kickedOpId(h: Harness): Promise<string> {
  await waitFor('the kicked op to stream', () => h.events.length > 0)
  const ids = [...new Set(h.events.map((e) => e.opId))]
  expect(ids).toHaveLength(1)
  return ids[0]
}

beforeEach(() => { _resetTickets(); engineHooks.hold = false })
afterEach(async () => {
  engineHooks.hold = false
  releaseFakeHolds()
  // let any still-running kick finish before the next test reuses the module-level
  // operation coordinator / live-op registry.
  await new Promise((r) => setTimeout(r, 20))
  shutdownIpc()
  setGenerationKicker(null)
})

describe('cli:open --generate — the service kicks the pass', () => {
  it('installs the kicker with registerIpc and clears it on shutdown', () => {
    setup()
    expect(_getGenerationKicker()).not.toBeNull()
    shutdownIpc()
    expect(_getGenerationKicker()).toBeNull()
  })

  it('mints the session, opens the review thread, streams live, and lands annotations', async () => {
    const h = setup()
    engineHooks.hold = true

    const result = await issueCliOpen({ dir: h.repo, generate: true })
    expect(result.path).toBe('/review/1')
    expect(result.note).toBeUndefined()

    // resolved refs: --base defaults to defaultBase (main), --branch to the checked-out branch
    const session = getSession(h.db, 1)!
    expect(session.repo).toBe(h.repo)
    expect(session.pair.base.symbol).toBe('main')
    expect(session.pair.compare.symbol).toBe('feature')

    // the review thread exists with its opening user turn, before the pass finishes
    const [thread] = listChatThreads(h.db, 1).filter((t) => t.kind === 'review')
    expect(thread.messages).toHaveLength(1)
    expect(thread.messages[0]).toMatchObject({
      role: 'user', text: 'Generate a guided review of feature against main.'
    })

    await heldGeneration(h)
    const opId = await kickedOpId(h)
    expect(opId).toMatch(/^op-cli-[0-9a-f]{12}$/)

    const during = await h.handlers.get('loadSession')!(1) as LoadedReview
    expect(during.activeOps).toHaveLength(1)
    expect(during.activeOps[0]).toMatchObject({ opId, kind: 'review', threadId: thread.id, exclusive: true })

    releaseFakeHolds()
    await settled(h, opId)
    expect(h.results.find((r) => r.opId === opId)!.status).toBe('succeeded')
    expect(loadReviewState(h.db, 1).annotations).not.toBeNull()
    expect((await h.handlers.get('loadSession')!(1) as LoadedReview).activeOps).toEqual([])
  })

  it('does not kick a second pass while the repo lane is held — it points at the running one', async () => {
    const h = setup()
    engineHooks.hold = true
    const first = await issueCliOpen({ dir: h.repo, generate: true })
    await heldGeneration(h)
    const opId = await kickedOpId(h)

    const second = await issueCliOpen({ dir: h.repo, generate: true })
    expect(second.path).toBe(first.path)
    expect(second.note).toBe('a review is already generating for this repository — opening it')
    // no second op: a kicked generation registers its live op synchronously, so by the
    // time the call above returned a second one would already be visible here.
    const during = await h.handlers.get('loadSession')!(1) as LoadedReview
    expect(during.activeOps.map((o) => o.opId)).toEqual([opId])
    expect(listChatThreads(h.db, 1).filter((t) => t.kind === 'review')).toHaveLength(1)

    releaseFakeHolds()
    await settled(h, opId)
  })

  it('reuses the pair session by default and runs an UPDATE pass once a review exists', async () => {
    const h = setup()
    const first = await issueCliOpen({ dir: h.repo, generate: true })
    await settled(h, await kickedOpId(h))
    expect(first.path).toBe('/review/1')

    h.events.length = 0
    const second = await issueCliOpen({ dir: h.repo, generate: true })
    await settled(h, await kickedOpId(h))

    expect(second.path).toBe('/review/1') // same session
    const reviews = listChatThreads(h.db, 1).filter((t) => t.kind === 'review')
    expect(reviews).toHaveLength(1) // an update reuses the review thread
    expect(reviews[0].messages.filter((m) => m.role === 'user').map((m) => m.text)).toEqual([
      'Generate a guided review of feature against main.',
      'Update a guided review of feature against main.'
    ])
  })

  it('--new mints a fresh session and runs a full pass', async () => {
    const h = setup()
    await issueCliOpen({ dir: h.repo, generate: true })
    await settled(h, await kickedOpId(h))

    h.events.length = 0
    const fresh = await issueCliOpen({ dir: h.repo, generate: true, fresh: true })
    await settled(h, await kickedOpId(h))

    expect(fresh.path).toBe('/review/2')
    expect(listChatThreads(h.db, 2).filter((t) => t.kind === 'review')[0].messages[0].text)
      .toBe('Generate a guided review of feature against main.')
  })

  it('applies the --agent override to the session that gets generated', async () => {
    const h = setup()
    await issueCliOpen({ dir: h.repo, generate: true, agent: { engine: 'codex' } })
    await settled(h, await kickedOpId(h))

    expect(getSession(h.db, 1)!.agent).toEqual({ engine: 'codex' })
  })

  it('propagates an agent-validation error verbatim and never mints a session', async () => {
    const h = setup()
    await expect(issueCliOpen({ dir: h.repo, generate: true, agent: { effort: 'high' } }))
      .rejects.toThrow('reasoning effort needs a model (set a model first)')
    expect(getSession(h.db, 1)).toBeNull()
  })

  it('refuses a detached HEAD with no --branch', async () => {
    const h = setup()
    fixtureGit(h.repo, 'checkout', '-q', '--detach', 'HEAD')
    await expect(issueCliOpen({ dir: h.repo, generate: true }))
      .rejects.toThrow('no branch checked out — pass --branch')
    expect(getSession(h.db, 1)).toBeNull()
  })

  it('takes an explicit --branch on a detached HEAD', async () => {
    const h = setup()
    fixtureGit(h.repo, 'checkout', '-q', '--detach', 'HEAD')
    const result = await issueCliOpen({ dir: h.repo, generate: true, compare: 'feature' })
    await settled(h, await kickedOpId(h))
    expect(result.path).toBe('/review/1')
    expect(getSession(h.db, 1)!.pair.compare.symbol).toBe('feature')
  })
})
