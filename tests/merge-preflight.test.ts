import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/main/db/db'
import { approveSessionSha, createSession, markSessionMerged } from '../src/main/db/sessions'
import { gatherMergePreflight } from '../src/main/merge'
import { resolveRefInput } from '../src/main/git'
import { makeFixtureRepo, fixtureGit, fixtureWrite, type FixtureRepo } from './helpers/fixtureRepo'
import type { AgentRef, MergeRecord, RefPair } from '../src/shared/types'

const agent: AgentRef = { engine: 'claude' }

interface Ctx {
  db: ReturnType<typeof openDb>['db']
  dir: string
  shas: FixtureRepo['shas']
  sessionId: number
}

async function setup(): Promise<Ctx> {
  const { dir, shas } = makeFixtureRepo()
  const base = await resolveRefInput(dir, 'main')
  const compare = await resolveRefInput(dir, 'feature')
  const pair: RefPair = {
    base: { kind: base.kind, symbol: base.symbol, anchorSha: base.sha },
    compare: { kind: compare.kind, symbol: compare.symbol, anchorSha: compare.sha }
  }
  const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'limn-mpf-')), 'db')).db
  const sessionId = createSession(db, dir, pair, agent).id
  return { db, dir, shas, sessionId }
}

/** A linked worktree OUTSIDE the repo dir (inside it would dirty the primary tree).
 *  `flags` (e.g. '-b', 'dep') go before the path; `ref` is the checkout target. */
function externalWorktree(dir: string, ref: string, ...flags: string[]): string {
  const wt = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'limn-wt-')), 'wt')
  fixtureGit(dir, 'worktree', 'add', ...flags, wt, ref)
  return wt
}

describe('gatherMergePreflight', () => {
  it('green path: approved tip, clean probe, unmoved base — ok with all strategies', async () => {
    const { db, dir, shas, sessionId } = await setup()
    approveSessionSha(db, sessionId, shas.head)
    const p = await gatherMergePreflight(db, sessionId)
    expect(p.ok).toBe(true)
    expect(p.gates).toEqual([])
    expect(p.strategies).toEqual({ ff: true, squash: true, merge: true })
    expect(p.baseHead).toBe(shas.base)
    expect(p.tipSha).toBe(shas.head)
    expect(p.baseSymbol).toBe('main')
    expect(p.branch).toBe('feature')
    expect(p.commits.map((c) => c.subject)).toEqual(['add c', 'tweak b', 'feature work'])
    expect(p.counts.commits).toBe(3)
    expect(p.counts.files).toBeGreaterThan(0)
    // no narration yet — the draft falls back to "Merge <branch> into <base>"
    expect(p.draftMessage).toBe(
      `Merge feature into main\n\nReviewed-with: Limn (approved ${shas.head.slice(0, 7)}, base main @ ${shas.base.slice(0, 7)})`
    )
    // feature is checked out at the PRIMARY worktree in the fixture
    expect(fs.realpathSync(p.cleanup.worktreePath!)).toBe(fs.realpathSync(dir))
    expect(p.cleanup.dependents).toEqual([])
  })

  it('stale-approval: approval on an earlier sha yields amber with drift counts', async () => {
    const { db, shas, sessionId } = await setup()
    approveSessionSha(db, sessionId, shas.firstFeature)
    const p = await gatherMergePreflight(db, sessionId)
    expect(p.ok).toBe(false)
    const gate = p.gates.find((g) => g.id === 'stale-approval')!
    expect(gate.severity).toBe('amber')
    expect(gate.commits).toBe(2)     // 'tweak b' + 'add c'
    expect(gate.add).toBe(2)         // one changed line + one new line
    expect(gate.del).toBe(1)
    expect(gate.detail).toContain(shas.firstFeature.slice(0, 7))
  })

  it('base-moved (feature-untouched file): amber, probe clean, ff off, squash/merge on', async () => {
    const { db, dir, shas, sessionId } = await setup()
    approveSessionSha(db, sessionId, shas.head)
    const wt = externalWorktree(dir, 'main')
    fixtureWrite(wt, 'docs/spec.md', '# Rate limiting spec v2\n')
    fixtureGit(wt, 'add', '-A')
    fixtureGit(wt, 'commit', '-m', 'base drift')
    const p = await gatherMergePreflight(db, sessionId)
    const gate = p.gates.find((g) => g.id === 'base-moved')!
    expect(gate.severity).toBe('amber')
    expect(gate.commits).toBe(1)
    expect(p.gates.some((g) => g.id === 'conflicts')).toBe(false)
    expect(p.strategies).toEqual({ ff: false, squash: true, merge: true })
    expect(p.baseHead).not.toBe(shas.base)
  })

  it('conflicts: base commit touching a feature-edited file is a red gate with files', async () => {
    const { db, dir, shas, sessionId } = await setup()
    approveSessionSha(db, sessionId, shas.head)
    const wt = externalWorktree(dir, 'main')
    fixtureWrite(wt, 'src/a.ts', ['export function a() {', '  return 7', '}', 'export const K = 10', ''].join('\n'))
    fixtureGit(wt, 'add', '-A')
    fixtureGit(wt, 'commit', '-m', 'conflicting base edit')
    const p = await gatherMergePreflight(db, sessionId)
    const gate = p.gates.find((g) => g.id === 'conflicts')!
    expect(gate.severity).toBe('red')
    expect(gate.files).toContain('src/a.ts')
    expect(p.ok).toBe(false)
    expect(p.strategies).toEqual({ ff: false, squash: false, merge: false })
  })

  it('branch-dirty: uncommitted changes on the compare worktree are a red gate', async () => {
    const { db, dir, shas, sessionId } = await setup()
    approveSessionSha(db, sessionId, shas.head)
    fixtureWrite(dir, 'src/a.ts', 'dirty edit\n') // primary worktree holds feature
    const p = await gatherMergePreflight(db, sessionId)
    const gate = p.gates.find((g) => g.id === 'branch-dirty')!
    expect(gate.severity).toBe('red')
    expect(fs.realpathSync(gate.workdir!)).toBe(fs.realpathSync(dir))
    expect(p.ok).toBe(false)
  })

  it('base-site-dirty: base checked out with a dirty tree is a red gate', async () => {
    const { db, dir, shas, sessionId } = await setup()
    approveSessionSha(db, sessionId, shas.head)
    const wt = externalWorktree(dir, 'main')
    fixtureWrite(wt, 'scratch.txt', 'untracked mess\n')
    const p = await gatherMergePreflight(db, sessionId)
    const gate = p.gates.find((g) => g.id === 'base-site-dirty')!
    expect(gate.severity).toBe('red')
    expect(fs.realpathSync(gate.workdir!)).toBe(fs.realpathSync(wt))
  })

  it('dependents: live sessions based on the branch, with rebasability annotation', async () => {
    const { db, dir, shas, sessionId } = await setup()
    approveSessionSha(db, sessionId, shas.head)
    const wt = externalWorktree(dir, 'feature', '-b', 'dep')
    fixtureWrite(wt, 'src/d.ts', 'export const d = 4\n')
    fixtureGit(wt, 'add', '-A')
    fixtureGit(wt, 'commit', '-m', 'dep work')
    const depSha = fixtureGit(dir, 'rev-parse', 'dep')
    const depPair: RefPair = {
      base: { kind: 'branch', symbol: 'feature', anchorSha: shas.head },
      compare: { kind: 'branch', symbol: 'dep', anchorSha: depSha }
    }
    const depId = createSession(db, dir, depPair, agent).id

    let p = await gatherMergePreflight(db, sessionId)
    expect(p.cleanup.dependents).toEqual([
      { sessionId: depId, branch: 'dep', commits: 1, rebasable: true }
    ])

    // checked out nowhere → blocked with 'not checked out'
    fixtureGit(dir, 'worktree', 'remove', wt)
    p = await gatherMergePreflight(db, sessionId)
    expect(p.cleanup.dependents).toEqual([
      { sessionId: depId, branch: 'dep', commits: 1, rebasable: false, blockedReason: 'not checked out' }
    ])
  })

  it('rejects non-branch pairs (S9) and already-merged sessions', async () => {
    const { db, dir, shas } = await setup()
    const commitPair: RefPair = {
      base: { kind: 'branch', symbol: 'main', anchorSha: shas.base },
      compare: { kind: 'commit', symbol: shas.head.slice(0, 7), anchorSha: shas.head }
    }
    const commitSession = createSession(db, dir, commitPair, agent).id
    await expect(gatherMergePreflight(db, commitSession)).rejects.toThrow(/branch/)

    const { db: db2, dir: dir2, sessionId: sid2 } = await setup()
    void dir2
    const record: MergeRecord = {
      strategy: 'squash', mergedSha: 'f'.repeat(40), reviewedTipSha: 'e'.repeat(40),
      baseSymbol: 'main', baseShaBefore: 'a'.repeat(40), mergedAt: new Date().toISOString(),
      overrides: [],
      cleanup: { archived: false, branchDeleted: false, worktreeRemoved: false, retargeted: [], failures: [] },
      dependents: []
    }
    markSessionMerged(db2, sid2, record)
    await expect(gatherMergePreflight(db2, sid2)).rejects.toThrow(/already merged/)
  })
})
