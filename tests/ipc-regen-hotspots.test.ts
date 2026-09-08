import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/server/db/db'
import { createSession, loadReviewState, upsertComment } from '../src/server/db/sessions'
import { registerIpc } from '../src/server/ipc'
import { resolveRefInput } from '../src/server/git'
import { makeFixtureRepo } from './helpers/fixtureRepo'
import type { AgentRef, RefPair } from '../src/shared/types'
import type { Transport } from '../src/server/transport'

const agent: AgentRef = { engine: 'claude' }

interface Harness {
  db: ReturnType<typeof openDb>['db']
  handlers: Map<string, (...args: unknown[]) => Promise<unknown>>
  sessionId: number
  repo: string
}

async function setup(): Promise<Harness> {
  const { dir } = makeFixtureRepo()
  const base = await resolveRefInput(dir, 'main')
  const compare = await resolveRefInput(dir, 'feature')
  const pair: RefPair = {
    base: { kind: base.kind, symbol: base.symbol, anchorSha: base.sha },
    compare: { kind: compare.kind, symbol: compare.symbol, anchorSha: compare.sha }
  }
  const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'limn-hs-regen-')), 'db')).db
  const sessionId = createSession(db, dir, pair, agent).id
  const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>()
  const transport: Transport = {
    handle(name, fn) { handlers.set(name, fn as (...a: unknown[]) => Promise<unknown>) },
    broadcast() { /* not asserted here */ },
    notify() { /* not asserted here */ },
    async pickDirectory() { return null }
  }
  registerIpc(db, [], transport)
  return { db, handlers, sessionId, repo: dir }
}

async function generateFull(h: Harness, opId: string): Promise<void> {
  const threadId = await h.handlers.get('beginReview')!(h.sessionId, agent, false, undefined) as number
  await h.handlers.get('generate')!(h.sessionId, agent, opId, threadId, undefined, false)
}

function hotspotComments(h: Harness) {
  return loadReviewState(h.db, h.sessionId).comments.filter((c) => c.id.startsWith('hs-'))
}

beforeEach(() => { process.env.LIMN_DEMO = '1' })
afterEach(() => {
  vi.restoreAllMocks()
  delete process.env.LIMN_DEMO
})

describe('full regeneration — hotspot comments are replaced, not duplicated', () => {
  it('a second full pass leaves exactly one set of hotspot comments', async () => {
    const h = await setup()
    await generateFull(h, 'op-1')
    const first = hotspotComments(h)
    expect(first.length).toBeGreaterThan(0) // FakeEngine mints one hotspot

    await generateFull(h, 'op-2')
    const second = hotspotComments(h)
    // same count as one generation — the stale set from op-1 is gone
    expect(second).toHaveLength(first.length)
    expect(second.map((c) => c.id)).not.toEqual(first.map((c) => c.id))
  })

  it('a re-queued or replied hotspot comment survives regeneration', async () => {
    const h = await setup()
    await generateFull(h, 'op-1')
    const [minted] = hotspotComments(h)

    // reviewer engaged: accepted it (status no longer a proposal)
    upsertComment(h.db, h.sessionId, { ...minted, status: 'queued' })

    await generateFull(h, 'op-2')
    const after = hotspotComments(h)
    // the engaged comment survives alongside the fresh mint
    expect(after.some((c) => c.id === minted.id)).toBe(true)
    expect(after.some((c) => c.id !== minted.id)).toBe(true)
  })
})
