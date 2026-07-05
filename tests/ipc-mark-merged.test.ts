import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/main/db/db'
import { approveSessionSha, createSession, getSession, loadReviewState, markSessionMerged, retargetSession } from '../src/main/db/sessions'
import { registerIpc } from '../src/main/ipc'
import { resolveRefInput } from '../src/main/git'
import { makeFixtureRepo, fixtureGit, fixtureWrite, type FixtureRepo } from './helpers/fixtureRepo'
import type { AgentRef, MergeExecuteResult, MergeRecord, RefPair } from '../src/shared/types'
import type { LoadedReview, RepoChangedMsg } from '../src/shared/ipc'
import type { Transport } from '../src/main/transport'

const agent: AgentRef = { engine: 'claude' }

interface Harness {
  db: ReturnType<typeof openDb>['db']
  dir: string
  shas: FixtureRepo['shas']
  sessionId: number
  handlers: Map<string, (...args: unknown[]) => Promise<unknown>>
  repoChanged: RepoChangedMsg[]
}

async function setup(): Promise<Harness> {
  const { dir, shas } = makeFixtureRepo()
  const base = await resolveRefInput(dir, 'main')
  const compare = await resolveRefInput(dir, 'feature')
  const pair: RefPair = {
    base: { kind: base.kind, symbol: base.symbol, anchorSha: base.sha },
    compare: { kind: compare.kind, symbol: compare.symbol, anchorSha: compare.sha }
  }
  const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'limn-mm-')), 'db')).db
  const sessionId = createSession(db, dir, pair, agent).id
  const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>()
  const repoChanged: RepoChangedMsg[] = []
  const transport: Transport = {
    handle(name, fn) { handlers.set(name, fn as (...a: unknown[]) => Promise<unknown>) },
    broadcast(channel, msg) { if (channel === 'repo:changed') repoChanged.push(msg as RepoChangedMsg) },
    notify() { /* unused */ },
    async pickDirectory() { return null }
  }
  registerIpc(db, [], transport)
  return { db, dir, shas, sessionId, handlers, repoChanged }
}

function fakeMergeRecord(over: Partial<MergeRecord> = {}): MergeRecord {
  return {
    strategy: 'squash', mergedSha: 'f'.repeat(40), reviewedTipSha: 'e'.repeat(40),
    baseSymbol: 'main', baseShaBefore: 'a'.repeat(40), mergedAt: new Date().toISOString(),
    overrides: [],
    cleanup: { archived: false, branchDeleted: false, worktreeRemoved: false, retargeted: [], failures: [] },
    dependents: [],
    ...over
  }
}

describe('mergedExternally detection (S12)', () => {
  it('approved tip reachable from the base head → mergedExternally: true', async () => {
    const h = await setup()
    approveSessionSha(h.db, h.sessionId, h.shas.head)
    fixtureGit(h.dir, 'update-ref', 'refs/heads/main', h.shas.head) // external ff merge
    const loaded = await h.handlers.get('loadSession')!(h.sessionId) as LoadedReview
    expect(loaded.mergedExternally).toBe(true)
    expect(loaded.state.merged).toBeUndefined() // detected, not yet settled
  })

  it('no detection without approval', async () => {
    const h = await setup()
    fixtureGit(h.dir, 'update-ref', 'refs/heads/main', h.shas.head)
    const loaded = await h.handlers.get('loadSession')!(h.sessionId) as LoadedReview
    expect(loaded.mergedExternally).toBeUndefined()
  })

  it('no detection while the tip is not an ancestor of the base head', async () => {
    const h = await setup()
    approveSessionSha(h.db, h.sessionId, h.shas.head)
    const loaded = await h.handlers.get('loadSession')!(h.sessionId) as LoadedReview
    expect(loaded.mergedExternally).toBeUndefined()
  })
})

describe('loadSession watcher gating for merged sessions', () => {
  it('does not start the branch watcher on a merged session', async () => {
    const h = await setup()
    // merged flag directly via the DAO (compare left branch-kind so ONLY the merged
    // gate can be what suppresses the watch)
    markSessionMerged(h.db, h.sessionId, fakeMergeRecord({ reviewedTipSha: h.shas.head }))
    const loaded = await h.handlers.get('loadSession')!(h.sessionId) as LoadedReview
    expect(loaded.state.merged).toBeDefined()
    // move the branch — an armed watcher would broadcast within LIVE_INTERVAL_MS
    const before = h.repoChanged.length
    fixtureWrite(h.dir, 'src/z.ts', 'export const z = 1\n') // primary holds feature
    fixtureGit(h.dir, 'add', '-A')
    fixtureGit(h.dir, 'commit', '-m', 'post-merge commit')
    await new Promise((r) => setTimeout(r, 1200))
    expect(h.repoChanged.length).toBe(before)
  })
})
