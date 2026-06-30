import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../src/main/db/db'
import { createSession, upsertComment, replaceUiState, updateSessionMeta } from '../src/main/db/sessions'
import { fileViewed } from '../src/renderer/store'
import { buildLoadedReview, previewReview } from '../src/main/review'
import { headSha, resolveRefInput } from '../src/main/git'
import { fixtureGit as git, fixtureWrite as write } from './helpers/fixtureRepo'
import type { Comment, RefPair } from '../src/shared/types'

async function sessionFor(dir: string): Promise<ReturnType<typeof createSession>> {
  const base = await resolveRefInput(dir, 'main')
  const compare = await resolveRefInput(dir, 'feature')
  const pair: RefPair = {
    base: { kind: base.kind, symbol: base.symbol, anchorSha: base.sha },
    compare: { kind: compare.kind, symbol: compare.symbol, anchorSha: compare.sha }
  }
  return createSession(db, dir, pair, { engine: 'claude' })
}

let db: DatabaseSync

/** A repo with a recognized superpowers spec added on the feature branch, so the
 *  artifact detector surfaces it from the diff (exercises the persist flag). */
function makeRepoWithArtifact(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limn-rev-'))
  git(dir, 'init', '-b', 'main')
  write(dir, 'src/a.ts', 'export const a = 1\n')
  git(dir, 'add', '-A'); git(dir, 'commit', '-m', 'base')

  git(dir, 'checkout', '-q', '-b', 'feature')
  write(dir, 'src/a.ts', 'export const a = 2\n')
  write(dir, 'src/b.ts', 'export const b = 3\n')
  write(dir, 'docs/superpowers/specs/2026-feature-design.md', '# Feature spec\n\nGoal: ship the feature.\n')
  git(dir, 'add', '-A'); git(dir, 'commit', '-m', 'feature work')
  return dir
}

const count = (table: string): number =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n

beforeEach(() => {
  db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'limn-revdb-')), 'db')).db
})

describe('previewReview', () => {
  it('builds a transient review (sentinel id, empty state, real diff) without any DB writes', async () => {
    const dir = makeRepoWithArtifact()
    const loaded = await previewReview(db, dir, 'main', 'feature', { engine: 'claude' })

    // sentinel identity — never persisted
    expect(loaded.sessionId).toBe(0)
    expect(loaded.session.id).toBe(0)

    // empty in-memory state (nothing generated/commented yet)
    expect(loaded.state.comments).toEqual([])
    expect(loaded.state.chats).toEqual([])
    expect(loaded.state.annotations).toBeUndefined()
    expect(loaded.state.viewedAt).toEqual({})

    // real assembled diff + detected artifact
    expect(loaded.skeleton.files.length).toBeGreaterThan(0)
    expect(loaded.commits.length).toBeGreaterThan(0)
    expect(loaded.artifacts.some((a) => a.role === 'spec')).toBe(true)

    // no rows minted anywhere — transient means transient
    expect(count('sessions')).toBe(0)
    expect(count('artifacts')).toBe(0)
  })

  it('throws when a ref does not resolve', async () => {
    const dir = makeRepoWithArtifact()
    await expect(previewReview(db, dir, 'no-such-ref', 'feature', { engine: 'claude' }))
      .rejects.toThrow(/not a branch or commit/)
  })
})

describe('merged base→working-tree view (dirty)', () => {
  it('is absent on a clean tree', async () => {
    const dir = makeRepoWithArtifact() // feature is committed & clean
    const loaded = await previewReview(db, dir, 'main', 'feature', { engine: 'claude' })
    expect(loaded.dirty).toBe(false)
    expect(loaded.merged).toBeUndefined()
  })

  it('attributes each line to committed vs uncommitted when dirty', async () => {
    const dir = makeRepoWithArtifact()
    // b.ts is committed as `b = 3`; append a brand-new uncommitted line
    write(dir, 'src/b.ts', 'export const b = 3\nexport const d = 4\n')

    const loaded = await previewReview(db, dir, 'main', 'feature', { engine: 'claude' })
    expect(loaded.dirty).toBe(true)
    const b = loaded.merged?.find((f) => f.path === 'src/b.ts')
    expect(b).toBeDefined()
    const lines = b!.hunks.flatMap((h) => h.lines)
    expect(lines.find((l) => l.text.includes('b = 3'))?.origin).toBe('committed')
    expect(lines.find((l) => l.text.includes('d = 4'))?.origin).toBe('unstaged')
  })
})

describe('comments line up with the merged (rendered) surface while dirty', () => {
  it('re-anchors a committed-line comment to its worktree line number after a dirty shift', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limn-cmt-'))
    git(dir, 'init', '-b', 'main')
    write(dir, 'src/x.ts', 'L1\nL2\nL3\n')
    git(dir, 'add', '-A'); git(dir, 'commit', '-m', 'base')
    git(dir, 'checkout', '-q', '-b', 'feature')
    write(dir, 'src/x.ts', 'L1\nL2\nL3\nTARGET\n') // TARGET committed at line 4
    git(dir, 'add', '-A'); git(dir, 'commit', '-m', 'add target')

    const session = await sessionFor(dir)
    const comment: Comment = {
      id: 'c1',
      anchor: { kind: 'diff', file: 'src/x.ts', side: 'new', line: 4, hunkRange: '@@', lineContent: 'TARGET' },
      author: 'user', text: 'why TARGET?', status: 'queued', replies: [], createdAt: '2026-01-01T00:00:00Z', iteration: 0
    }
    upsertComment(db, session.id, comment)

    // dirty edit prepends two lines, shifting TARGET to worktree line 6
    write(dir, 'src/x.ts', 'NEW1\nNEW2\nL1\nL2\nL3\nTARGET\n')

    const loaded = await buildLoadedReview(db, session)
    const c = loaded.state.comments.find((x) => x.id === 'c1')!
    expect(c.status).not.toBe('outdated')
    // the comment's anchor must match the line the merged view actually renders
    const x = loaded.merged!.find((f) => f.path === 'src/x.ts')!
    const rendered = x.hunks.flatMap((h) => h.lines).find((l) => l.new === (c.anchor as { line: number }).line)
    expect(rendered?.text).toBe('TARGET')
    expect(rendered?.origin).toBe('committed')
  })

  it('marks uncommitted edits as changed since approval at the same HEAD', async () => {
    const dir = makeRepoWithArtifact()
    const session = await sessionFor(dir)
    const approved = await headSha(dir, 'feature')
    updateSessionMeta(db, session.id, { approvedSha: approved })

    write(dir, 'src/b.ts', 'export const b = 3\nexport const dirty = true\n')
    const loaded = await buildLoadedReview(db, session)
    const b = loaded.merged?.find((f) => f.path === 'src/b.ts')
    expect(b?.hunks.some((h) => h.lines.some((l) => l.origin === 'unstaged' && l.since))).toBe(true)
  })

  it('uses a branch surface hash that distinguishes dirty states from clean HEAD', async () => {
    const dir = makeRepoWithArtifact()
    const session = await sessionFor(dir)
    const clean = await buildLoadedReview(db, session)
    expect(clean.branchHash).toBe(clean.skeleton.headSha)

    write(dir, 'src/b.ts', 'export const b = 3\nexport const dirty = true\n')
    const dirty = await buildLoadedReview(db, session)
    expect(dirty.branchHash).toMatch(/^dirty:/)
    expect(dirty.branchHash).not.toBe(clean.branchHash)

    write(dir, 'src/b.ts', 'export const b = 3\n')
    const cleanAgain = await buildLoadedReview(db, session)
    expect(cleanAgain.branchHash).toBe(clean.branchHash)
  })
})

describe('viewed content-hash drift', () => {
  it('attaches a file content hash and un-views the file after an uncommitted edit', async () => {
    const dir = makeRepoWithArtifact() // feature committed & clean; src/b.ts = `b = 3`
    const session = await sessionFor(dir)

    // view src/b.ts at its current (committed) content
    const first = await buildLoadedReview(db, session)
    const b0 = first.skeleton.files.find((f) => f.path === 'src/b.ts')!
    expect(b0.fileHash).toBeTruthy()
    replaceUiState(db, session.id, { viewedAt: { 'src/b.ts': { sha: first.skeleton.headSha, hash: b0.fileHash! } } })

    // a later uncommitted edit (no commit movement) must re-flag the file
    write(dir, 'src/b.ts', 'export const b = 3\nexport const d = 4\n')
    const second = await buildLoadedReview(db, session)
    const b1 = (second.merged ?? second.skeleton.files).find((f) => f.path === 'src/b.ts')!
    expect(b1.fileHash).not.toBe(b0.fileHash)
    expect(fileViewed(b1, second.state.viewedAt)).toBe(false)
  })
})

describe('buildLoadedReview (persisted path) still writes', () => {
  it('resolves branch sessions to the latest branch head on each load', async () => {
    const dir = makeRepoWithArtifact()
    const session = await sessionFor(dir)
    const first = await buildLoadedReview(db, session)

    write(dir, 'src/latest.ts', 'export const latest = true\n')
    git(dir, 'add', '-A'); git(dir, 'commit', '-m', 'latest work')

    const second = await buildLoadedReview(db, session)
    expect(second.skeleton.headSha).toBe(await headSha(dir, 'feature'))
    expect(second.skeleton.headSha).not.toBe(first.skeleton.headSha)
    expect(second.skeleton.files.some((f) => f.path === 'src/latest.ts')).toBe(true)
  })

  it('caches detected artifacts to the DB for a real session', async () => {
    const dir = makeRepoWithArtifact()
    const base = await resolveRefInput(dir, 'main')
    const compare = await resolveRefInput(dir, 'feature')
    const pair: RefPair = {
      base: { kind: base.kind, symbol: base.symbol, anchorSha: base.sha },
      compare: { kind: compare.kind, symbol: compare.symbol, anchorSha: compare.sha }
    }
    const session = createSession(db, dir, pair, { engine: 'claude' })
    expect(count('artifacts')).toBe(0)

    const loaded = await buildLoadedReview(db, session)
    expect(loaded.artifacts.some((a) => a.role === 'spec')).toBe(true)
    // persisted path caches the detection
    expect(count('artifacts')).toBeGreaterThan(0)
  })
})
