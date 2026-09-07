import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/server/db/db'
import { approveSessionSha, createSession, listChatThreads, markSessionMerged, touchRepo } from '../src/server/db/sessions'
import { registerIpc, shutdownIpc } from '../src/server/ipc'
import { resolveRefInput } from '../src/server/git'
import { makeFixtureRepo, fixtureGit, fixtureWrite } from './helpers/fixtureRepo'
import type { AgentRef, MergeExecuteRequest, MergeExecuteResult, RefPair } from '../src/shared/types'
import type { DashboardData, RepoChangedMsg } from '../src/shared/ipc'
import type { Transport } from '../src/server/transport'

const agent: AgentRef = { engine: 'claude' }

interface Harness {
  db: ReturnType<typeof openDb>['db']
  handlers: Map<string, (...args: unknown[]) => Promise<unknown>>
  repoChanged: RepoChangedMsg[]
}

function setup(): Harness {
  const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'limn-audit-')), 'db')).db
  const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>()
  const repoChanged: RepoChangedMsg[] = []
  const transport: Transport = {
    handle(name, fn) { handlers.set(name, fn as (...a: unknown[]) => Promise<unknown>) },
    broadcast(channel, msg) { if (channel === 'repo:changed') repoChanged.push(msg as RepoChangedMsg) },
    notify() { /* unused */ },
    async pickDirectory() { return null }
  }
  registerIpc(db, [], transport)
  return { db, handlers, repoChanged }
}

// every test arms the module-global watcher; call it down so its polls can't leak
// broadcasts into the next test's collector.
afterEach(() => { shutdownIpc() })

async function pairFor(dir: string, baseInput: string, compareInput: string): Promise<RefPair> {
  const base = await resolveRefInput(dir, baseInput)
  const compare = await resolveRefInput(dir, compareInput)
  return {
    base: { kind: base.kind, symbol: base.symbol, anchorSha: base.sha },
    compare: { kind: compare.kind, symbol: compare.symbol, anchorSha: compare.sha }
  }
}

/** Wait (up to 3s, well past the 500ms poll cadence) for a broadcast about `repo`+`branch`. */
async function waitForChange(h: Harness, repo: string, branch: string): Promise<RepoChangedMsg | null> {
  const start = Date.now()
  while (Date.now() - start < 3000) {
    const hit = h.repoChanged.find((m) => m.repo === repo && m.branch === branch)
    if (hit) return hit
    await new Promise((r) => setTimeout(r, 50))
  }
  return null
}

describe('the one global branch watch survives unrelated sessions (finding 24)', () => {
  it('archiving another session leaves the open review watching its own branch', async () => {
    const h = setup()
    const watched = makeFixtureRepo()
    const other = makeFixtureRepo()
    const watchedId = createSession(h.db, watched.dir, await pairFor(watched.dir, 'main', 'feature'), agent).id
    const otherId = createSession(h.db, other.dir, await pairFor(other.dir, 'main', 'feature'), agent).id
    await h.handlers.get('loadSession')!(watchedId) // arms the watch on watched/feature

    await h.handlers.get('archiveSession')!(otherId)

    // the watched branch moves: a live watch broadcasts within a poll or two
    fixtureWrite(watched.dir, 'src/z.ts', 'export const z = 1\n')
    fixtureGit(watched.dir, 'add', '-A')
    fixtureGit(watched.dir, 'commit', '-m', 'outside hands')
    expect(await waitForChange(h, watched.dir, 'feature')).toBeTruthy()
  })

  it('merging another session leaves the open review watching its own branch', async () => {
    const h = setup()
    const watched = makeFixtureRepo()
    const other = makeFixtureRepo()
    const watchedId = createSession(h.db, watched.dir, await pairFor(watched.dir, 'main', 'feature'), agent).id
    const otherId = createSession(h.db, other.dir, await pairFor(other.dir, 'main', 'feature'), agent).id
    await h.handlers.get('loadSession')!(watchedId)

    approveSessionSha(h.db, otherId, other.shas.head)
    const req: MergeExecuteRequest = {
      strategy: 'squash', overrides: [], message: 'Ship it',
      cleanup: { archiveSession: false, deleteBranch: false, removeWorktree: false, retarget: [] },
      expect: { baseHead: other.shas.base, tipSha: other.shas.head }
    }
    const res = await h.handlers.get('mergeExecute')!(otherId, req) as MergeExecuteResult
    expect(res.status).toBe('merged')

    fixtureWrite(watched.dir, 'src/z.ts', 'export const z = 1\n')
    fixtureGit(watched.dir, 'add', '-A')
    fixtureGit(watched.dir, 'commit', '-m', 'outside hands')
    expect(await waitForChange(h, watched.dir, 'feature')).toBeTruthy()
  })

  it('marking another session merged leaves the open review watching its own branch', async () => {
    const h = setup()
    const watched = makeFixtureRepo()
    const other = makeFixtureRepo()
    const watchedId = createSession(h.db, watched.dir, await pairFor(watched.dir, 'main', 'feature'), agent).id
    const otherId = createSession(h.db, other.dir, await pairFor(other.dir, 'main', 'feature'), agent).id
    await h.handlers.get('loadSession')!(watchedId)

    approveSessionSha(h.db, otherId, other.shas.head)
    fixtureGit(other.dir, 'update-ref', 'refs/heads/main', other.shas.head) // external ff
    const res = await h.handlers.get('markMerged')!(otherId, {
      archiveSession: false, deleteBranch: false, removeWorktree: false, retarget: []
    }) as MergeExecuteResult
    expect(res.status).toBe('merged')

    fixtureWrite(watched.dir, 'src/z.ts', 'export const z = 1\n')
    fixtureGit(watched.dir, 'add', '-A')
    fixtureGit(watched.dir, 'commit', '-m', 'outside hands')
    expect(await waitForChange(h, watched.dir, 'feature')).toBeTruthy()
  })

  it('opening a commit-kind review releases the branch watch instead of orphaning it', async () => {
    const h = setup()
    const fx = makeFixtureRepo()
    const branchId = createSession(h.db, fx.dir, await pairFor(fx.dir, 'main', 'feature'), agent).id
    const commitId = createSession(h.db, fx.dir, {
      base: { kind: 'branch', symbol: 'main', anchorSha: fx.shas.base },
      compare: { kind: 'commit', symbol: fx.shas.head.slice(0, 7), anchorSha: fx.shas.head }
    }, agent).id
    await h.handlers.get('loadSession')!(branchId) // arms the watch on feature

    // nothing to watch for a commit-kind review: the armed watch must come down…
    await h.handlers.get('loadSession')!(commitId)
    expect(h.repoChanged.find((m) => m.branch === 'feature')?.watchStopped?.reason).toBeTruthy()

    // …and stay down: no poll survives to broadcast the branch moving
    const before = h.repoChanged.length
    fixtureWrite(fx.dir, 'src/z.ts', 'export const z = 1\n')
    fixtureGit(fx.dir, 'add', '-A')
    fixtureGit(fx.dir, 'commit', '-m', 'outside hands')
    await new Promise((r) => setTimeout(r, 1500)) // three poll cadences
    expect(h.repoChanged.length).toBe(before)
  })

  it('a second review displacing the watch tells the first one its watch stopped', async () => {
    const h = setup()
    const fx = makeFixtureRepo()
    fixtureGit(fx.dir, 'branch', 'other', fx.shas.firstFeature)
    const sessionId = createSession(h.db, fx.dir, await pairFor(fx.dir, 'main', 'feature'), agent).id
    await h.handlers.get('loadSession')!(sessionId) // arms the watch on feature

    // a second tab opens a different branch — one watcher, so `feature` loses it
    await h.handlers.get('previewReview')!(fx.dir, 'main', 'other', agent)

    const displaced = h.repoChanged.find((m) => m.repo === fx.dir && m.branch === 'feature')
    expect(displaced?.watchStopped?.reason).toBeTruthy()
  })
})

describe('worktree excludes on a linked worktree (finding 27)', () => {
  it('excludes .worktrees/ via the common git dir, so the linked worktree stays clean', async () => {
    const h = setup()
    const fx = makeFixtureRepo()
    // open Limn on a LINKED worktree (its `.git` is a file, not a directory)
    const linked = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'limn-linked-')), 'wt')
    fixtureGit(fx.dir, 'worktree', 'add', linked, 'main')
    fixtureGit(fx.dir, 'branch', 'spare', 'main')

    await h.handlers.get('addWorktreeFor')!(linked, 'spare', 'spare')

    const exclude = fs.readFileSync(path.join(fx.dir, '.git', 'info', 'exclude'), 'utf8')
    expect(exclude.split('\n').map((l) => l.trim())).toContain('.worktrees/')
    expect(fixtureGit(linked, 'status', '--porcelain')).not.toContain('.worktrees')
  })
})

describe('dashboard repo index (finding 29)', () => {
  it('keeps index order, pairs each row with its own git state, and skips unreadable repos', async () => {
    const h = setup()
    const a = makeFixtureRepo()
    const b = makeFixtureRepo()
    const c = makeFixtureRepo()
    fixtureGit(b.dir, 'checkout', '-q', 'main') // so a shuffled result would be visible
    const notGit = fs.mkdtempSync(path.join(os.tmpdir(), 'limn-notgit-'))
    const gone = path.join(os.tmpdir(), 'limn-vanished-repo-that-never-existed')
    // newest activity first — interleave the two unreadable paths
    touchRepo(h.db, a.dir, '2026-01-01T00:00:05.000Z')
    touchRepo(h.db, notGit, '2026-01-01T00:00:04.000Z')
    touchRepo(h.db, b.dir, '2026-01-01T00:00:03.000Z')
    touchRepo(h.db, gone, '2026-01-01T00:00:02.000Z')
    touchRepo(h.db, c.dir, '2026-01-01T00:00:01.000Z')

    const data = await h.handlers.get('dashboard')!() as DashboardData

    expect(data.repos.map((r) => r.path)).toEqual([a.dir, b.dir, c.dir])
    expect(data.repos.map((r) => r.current)).toEqual(['feature', 'main', 'feature'])
  })
})

describe('review-thread prune exemption (finding 30)', () => {
  it('a generate rejected at preflight releases its thread to the orphan prune', async () => {
    const h = setup()
    const fx = makeFixtureRepo()
    const sessionId = createSession(h.db, fx.dir, await pairFor(fx.dir, 'main', 'feature'), agent).id
    // the renderer race the finding names: beginReview lands, then the session is
    // merged elsewhere before generate runs.
    const orphan = await h.handlers.get('beginReview')!(sessionId, agent) as number
    markSessionMerged(h.db, sessionId, {
      strategy: 'squash', mergedSha: 'f'.repeat(40), reviewedTipSha: fx.shas.head,
      baseSymbol: 'main', baseShaBefore: fx.shas.base, mergedAt: new Date().toISOString(),
      overrides: [], dependents: [],
      cleanup: { archived: false, branchDeleted: false, worktreeRemoved: false, retargeted: [], failures: [] }
    })
    await expect(h.handlers.get('generate')!(sessionId, agent, 'op-1', orphan))
      .rejects.toThrow('merged and read-only')

    // a later review thread makes the orphan prunable (the latest is never pruned)
    const latest = await h.handlers.get('beginReview')!(sessionId, agent) as number
    await h.handlers.get('loadSession')!(sessionId)

    expect(listChatThreads(h.db, sessionId).map((t) => t.id)).toEqual([latest])
  })
})
