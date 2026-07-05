import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '../src/main/db/db'
import { createSession, createChatThread, getChatThread } from '../src/main/db/sessions'
import { registerIpc } from '../src/main/ipc'
import { resolveRefInput } from '../src/main/git'
import { lastFakeChatTurn, releaseFakeHolds } from '../src/main/engines/fake'
import { makeFixtureRepo, fixtureWrite } from './helpers/fixtureRepo'
import type { AgentRef, RefPair } from '../src/shared/types'
import type { OpEventMsg, OpResultMsg } from '../src/shared/ipc'
import type { Transport } from '../src/main/transport'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const agent: AgentRef = { engine: 'claude' }

interface Harness {
  dir: string
  db: ReturnType<typeof openDb>['db']
  handlers: Map<string, (...args: unknown[]) => Promise<unknown>>
  results: OpResultMsg[]
  events: OpEventMsg[]
  sessionId: number
}

async function setup(): Promise<Harness> {
  const { dir } = makeFixtureRepo() // leaves `feature` checked out at dir, tree clean
  const base = await resolveRefInput(dir, 'main')
  const compare = await resolveRefInput(dir, 'feature')
  const pair: RefPair = {
    base: { kind: base.kind, symbol: base.symbol, anchorSha: base.sha },
    compare: { kind: compare.kind, symbol: compare.symbol, anchorSha: compare.sha }
  }
  const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'limn-rb-')), 'db')).db
  const sessionId = createSession(db, dir, pair, agent).id
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
  return { dir, db, handlers, results, events, sessionId }
}

beforeEach(() => { process.env.LIMN_DEMO = '1' })
afterEach(() => { releaseFakeHolds(); delete process.env.LIMN_DEMO })

/** Wait until the `[hold]` turn has actually parked (its 'holding…' status event
 *  streamed), so releases/asserts can't race the turn's async setup. */
async function waitForHold(h: Harness, opId: string): Promise<void> {
  const start = Date.now()
  while (!h.events.some((e) => e.opId === opId && e.event.type === 'status' && e.event.text.startsWith('holding'))) {
    if (Date.now() - start > 10000) throw new Error(`op ${opId} never reached its hold`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('sendRebase — the agent rebase turn (merge §6)', () => {
  it('hands buildRebasePrompt to engine.chat write-enabled and settles with reload', async () => {
    const h = await setup()
    const t = createChatThread(h.db, h.sessionId, { kind: 'review', agent }).id
    await h.handlers.get('sendRebase')!(t, 'op-r', ['src/a.ts'])

    // the exact prompt reached the engine, write-enabled, at the thread's tier
    const turn = lastFakeChatTurn()!
    expect(turn.message).toContain('Rebase `feature` onto `main`')
    expect(turn.message).toContain('git rebase main')
    expect(turn.message).toContain('- src/a.ts')
    expect(turn.message).toContain('NEVER touch the branch `main` itself')
    expect(turn.writeEnabled).toBe(true)
    expect(turn.executionMode).toBe('ask')

    // op settles: succeeded + reload (the branch was rewritten under the review)
    const res = h.results.find((r) => r.opId === 'op-r')!
    expect(res.status).toBe('succeeded')
    expect(res.reload).toBe(true)
    expect(res.exclusive).toBe(true)
    // …and every streamed envelope announced the exclusive lane
    const evs = h.events.filter((e) => e.opId === 'op-r')
    expect(evs.length).toBeGreaterThan(0)
    expect(evs.every((e) => e.exclusive === true)).toBe(true)

    // persisted like any turn: short user label (not the prompt) + the agent answer
    const msgs = getChatThread(h.db, t)!.messages
    expect(msgs.map((m) => m.role)).toEqual(['user', 'agent'])
    expect(msgs[0].text).toBe('Rebase feature onto main — resolve 1 conflicted file.')
  })

  it('omits the probe block and pluralizes the label when no conflict files are passed', async () => {
    const h = await setup()
    const t = createChatThread(h.db, h.sessionId, { kind: 'review', agent }).id
    await h.handlers.get('sendRebase')!(t, 'op-r2')
    expect(lastFakeChatTurn()!.message).not.toContain('A merge probe found conflicts')
    expect(getChatThread(h.db, t)!.messages[0].text).toBe('Rebase feature onto main.')
    expect(h.results.find((r) => r.opId === 'op-r2')!.status).toBe('succeeded')
  })

  it('fails fast while another op holds the exclusive lane (S11 — no queueing)', async () => {
    const h = await setup()
    const held = createChatThread(h.db, h.sessionId, { kind: 'user', agent }).id
    const t = createChatThread(h.db, h.sessionId, { kind: 'review', agent }).id
    const holding = h.handlers.get('sendChat')!(held, '[hold] keep the repo busy', 'op-1')
    await waitForHold(h, 'op-1')

    await h.handlers.get('sendRebase')!(t, 'op-r')
    const res = h.results.find((r) => r.opId === 'op-r')!
    expect(res.status).toBe('failed')
    expect(res.error).toContain('Another agent operation is running')
    // the lane refused before any work — no user turn was persisted
    expect(getChatThread(h.db, t)!.messages.filter((m) => m.role === 'user')).toHaveLength(0)

    releaseFakeHolds()
    await holding
    expect(h.results.find((r) => r.opId === 'op-1')!.status).toBe('succeeded')
  })

  it('a second send into the same thread mid-turn fails fast (per-thread guard)', async () => {
    const h = await setup()
    const t = createChatThread(h.db, h.sessionId, { kind: 'review', agent }).id
    const holding = h.handlers.get('sendChat')!(t, '[hold] first turn', 'op-1')
    await waitForHold(h, 'op-1')
    await h.handlers.get('sendRebase')!(t, 'op-r')
    const res = h.results.find((r) => r.opId === 'op-r')!
    expect(res.status).toBe('failed')
    expect(res.error).toContain('A turn is already running in this chat')
    releaseFakeHolds()
    await holding
  })

  it('refuses on a dirty compare worktree (writeCapability precheck)', async () => {
    const h = await setup()
    const t = createChatThread(h.db, h.sessionId, { kind: 'review', agent }).id
    fixtureWrite(h.dir, 'src/a.ts', 'uncommitted local edit\n')
    await h.handlers.get('sendRebase')!(t, 'op-r')
    const res = h.results.find((r) => r.opId === 'op-r')!
    expect(res.status).toBe('failed')
    expect(res.error).toContain('uncommitted changes')
    // FakeEngine was never launched with a rebase prompt
    expect(lastFakeChatTurn()?.message ?? '').not.toContain('git rebase main')
  })
})
