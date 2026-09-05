import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '../src/main/db/db'
import { createSession, createChatThread, getChatThread, setThreadEngineSession } from '../src/main/db/sessions'
import { registerIpc } from '../src/main/ipc'
import { resolveRefInput } from '../src/main/git'
import { makeFixtureRepo } from './helpers/fixtureRepo'
import type { AgentRef, RefPair } from '../src/shared/types'
import type { OpResultMsg } from '../src/shared/ipc'
import type { Transport } from '../src/main/transport'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const agent: AgentRef = { engine: 'codex', model: 'gpt-5.5', reasoningEffort: 'low' }

interface Harness {
  db: ReturnType<typeof openDb>['db']
  handlers: Map<string, (...args: unknown[]) => Promise<unknown>>
  results: OpResultMsg[]
  sessionId: number
}

async function setup(): Promise<Harness & { repo: string }> {
  const { dir } = makeFixtureRepo()
  const base = await resolveRefInput(dir, 'main')
  const compare = await resolveRefInput(dir, 'feature')
  const pair: RefPair = {
    base: { kind: base.kind, symbol: base.symbol, anchorSha: base.sha },
    compare: { kind: compare.kind, symbol: compare.symbol, anchorSha: compare.sha }
  }
  const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'limn-esl-')), 'db')).db
  const sessionId = createSession(db, dir, pair, agent).id
  const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>()
  const results: OpResultMsg[] = []
  const transport: Transport = {
    handle(name, fn) { handlers.set(name, fn as (...a: unknown[]) => Promise<unknown>) },
    broadcast(channel, msg) { if (channel === 'op:result') results.push(msg as OpResultMsg) },
    notify() { /* not used */ },
    async pickDirectory() { return null }
  }
  registerIpc(db, [], transport)
  return { db, handlers, results, sessionId, repo: dir }
}

/** A user chat thread, optionally already bound to an engine session (a resume target). */
function thread(h: Harness, engineSessionId?: string): number {
  const t = createChatThread(h.db, h.sessionId, { kind: 'user', agent })
  if (engineSessionId) setThreadEngineSession(h.db, t.id, engineSessionId)
  return t.id
}

beforeEach(() => { process.env.LIMN_DEMO = '1' })
afterEach(() => { delete process.env.LIMN_DEMO })

describe('ENGINE_SESSION_LOST classification (item 7)', () => {
  it('(a) resume fails with zero text/tool events → ENGINE_SESSION_LOST, thread untouched', async () => {
    const h = await setup()
    const id = thread(h, 'stale-session-42')
    await h.handlers.get('sendChat')!(id, '[fail-immediately] why did this change?', 'op-a')

    const res = h.results.find((r) => r.opId === 'op-a')!
    expect(res.status).toBe('failed')
    expect(res.errorCode).toBe('ENGINE_SESSION_LOST')
    expect(res.error).toContain('agent session is no longer available')
    expect(res.error).toContain('Start a new chat')

    // thread NOT rebound: the pruned session id is left exactly as it was, and no
    // fresh turn ran (no second engine session, no agent note).
    const after = getChatThread(h.db, id)!
    expect(after.engineSessionId).toBe('stale-session-42')
    expect(after.messages.map((m) => m.role)).toEqual(['user'])
  })

  it('(b) failure AFTER a tool event → generic, not ENGINE_SESSION_LOST', async () => {
    const h = await setup()
    const id = thread(h, 'stale-session-42')
    await h.handlers.get('sendChat')!(id, '[fail-after-tool] keep going', 'op-b')

    const res = h.results.find((r) => r.opId === 'op-b')!
    expect(res.status).toBe('failed')
    expect(res.errorCode).toBeUndefined()
    // generic path records an agent note
    expect(getChatThread(h.db, id)!.messages.map((m) => m.role)).toEqual(['user', 'agent'])
  })

  it('(c) cancelled resume → generic, not ENGINE_SESSION_LOST', async () => {
    const h = await setup()
    const id = thread(h, 'stale-session-42')
    await h.handlers.get('sendChat')!(id, '[cancel] never mind', 'op-c')

    const res = h.results.find((r) => r.opId === 'op-c')!
    expect(res.status).toBe('cancelled')
    expect(res.errorCode).toBeUndefined()
    // a user cancel stays quiet — no agent note
    expect(getChatThread(h.db, id)!.messages.map((m) => m.role)).toEqual(['user'])
  })

  it('(d) no engine session on the thread → generic, not ENGINE_SESSION_LOST', async () => {
    const h = await setup()
    const id = thread(h) // no engineSessionId → nothing to resume
    await h.handlers.get('sendChat')!(id, '[fail-immediately] first message', 'op-d')

    const res = h.results.find((r) => r.opId === 'op-d')!
    expect(res.status).toBe('failed')
    expect(res.errorCode).toBeUndefined()
    expect(getChatThread(h.db, id)!.messages.map((m) => m.role)).toEqual(['user', 'agent'])
  })

  it('(e) the user message is persisted exactly once on the lost-session path', async () => {
    const h = await setup()
    const id = thread(h, 'stale-session-42')
    await h.handlers.get('sendChat')!(id, '[fail-immediately] only once please', 'op-e')

    const msgs = getChatThread(h.db, id)!.messages
    expect(msgs).toHaveLength(1)
    expect(msgs[0].role).toBe('user')
    expect(msgs[0].text).toBe('[fail-immediately] only once please')
  })

  it('(f) pre-model app throw on a session-bound thread → generic, not ENGINE_SESSION_LOST', async () => {
    // "Nothing to send" throws before the engine is ever invoked. Even though the
    // shape (session id set + zero events + failed) matches, engineInvoked stays false.
    const h = await setup()
    const id = thread(h, 'stale-session-42')
    await h.handlers.get('sendBatch')!(id, [], undefined, 'op-nts')

    const res = h.results.find((r) => r.opId === 'op-nts')!
    expect(res.status).toBe('failed')
    expect(res.errorCode).toBeUndefined()
    expect(res.error).toContain('Nothing to send')
    expect(res.error).not.toContain('agent session is no longer available')
  })

  it('(g) dirty-tree precondition throw on a session-bound thread → generic', async () => {
    const h = await setup()
    const id = thread(h, 'stale-session-42')
    fs.writeFileSync(path.join(h.repo, 'src/a.ts'), 'uncommitted change\n') // dirty the compare worktree
    await h.handlers.get('sendBatch')!(id, [], 'please edit', 'op-dirty')

    const res = h.results.find((r) => r.opId === 'op-dirty')!
    expect(res.status).toBe('failed')
    expect(res.errorCode).toBeUndefined()
    expect(res.error).toContain('uncommitted changes')
  })

  it('sendBatch classifies a lost session the same way (thread untouched)', async () => {
    const h = await setup()
    const id = thread(h, 'stale-session-42')
    // steer carries the fake trigger; empty commentIds is fine because steer is set.
    await h.handlers.get('sendBatch')!(id, [], '[fail-immediately]', 'op-batch')

    const res = h.results.find((r) => r.opId === 'op-batch')!
    expect(res.status).toBe('failed')
    expect(res.errorCode).toBe('ENGINE_SESSION_LOST')
    const after = getChatThread(h.db, id)!
    expect(after.engineSessionId).toBe('stale-session-42')
    // user turn persisted once, no agent failure note
    expect(after.messages.map((m) => m.role)).toEqual(['user'])
  })
})
