import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeFixtureRepo, fixtureWrite, type FixtureRepo } from './helpers/fixtureRepo'
import { stampAnchor } from '../src/server/anchorStamp'
import { headSha, blobShaAt, catBlob, mergeBase } from '../src/server/git'
import { openDb } from '../src/server/db/db'
import { createSession, createChatThread, loadReviewState } from '../src/server/db/sessions'
import { createToolHost, type ToolHostCtx } from '../src/server/engines/tools'
import type { CommentAnchor, RefPair, SessionMeta } from '../src/shared/types'

let fx: FixtureRepo
beforeEach(() => { fx = makeFixtureRepo() })
afterEach(() => fs.rmSync(fx.dir, { recursive: true, force: true }))

function makePair(f: FixtureRepo): RefPair {
  return {
    base: { kind: 'branch', symbol: 'main', anchorSha: f.shas.base },
    compare: { kind: 'branch', symbol: 'feature', anchorSha: f.shas.head }
  }
}
function makeSession(f: FixtureRepo): SessionMeta {
  return { id: 1, repo: f.dir, pair: makePair(f), createdAt: 'now', updatedAt: 'now' }
}

type DiffAnchor = Extract<CommentAnchor, { kind: 'diff' }>
type ArtifactAnchor = Extract<CommentAnchor, { kind: 'artifact' }>
const asDiff = (a: CommentAnchor): DiffAnchor => a as DiffAnchor
const asArtifact = (a: CommentAnchor): ArtifactAnchor => a as ArtifactAnchor

describe('stampAnchor — diff anchors', () => {
  it('1. committed clean file (side new): blob from headSha, surface committed, context sliced', async () => {
    const anchor: CommentAnchor = { kind: 'diff', file: 'src/a.ts', side: 'new', line: 4, hunkRange: '@@', lineContent: 'export const K = 10' }
    const out = asDiff(await stampAnchor(fx.dir, makeSession(fx), anchor))
    const head = await headSha(fx.dir, 'feature')
    expect(out.stamp).toBeDefined()
    expect(out.stamp!.surface).toBe('committed')
    expect(out.stamp!.origLine).toBe(4)
    expect(out.stamp!.origPath).toBe('src/a.ts')
    expect(out.stamp!.headSha).toBe(head)
    expect(out.stamp!.blobSha).toBe(await blobShaAt(fx.dir, head, 'src/a.ts'))
    expect(out.context).toEqual({ before: ['export function a() {', '  return 2', '}'], after: ['export const J = 20'] })
  })

  it('2. dirty tracked file (side new): -w blob recoverable via catBlob, worktree context', async () => {
    const content2 = ['export function a() {', '  return 2', '}', 'export const K = 10', 'export const J = 20', 'export const DIRTY = 1', ''].join('\n')
    fixtureWrite(fx.dir, 'src/a.ts', content2)
    const anchor: CommentAnchor = { kind: 'diff', file: 'src/a.ts', side: 'new', line: 6, hunkRange: '@@', lineContent: 'export const DIRTY = 1' }
    const out = asDiff(await stampAnchor(fx.dir, makeSession(fx), anchor))
    expect(out.stamp!.surface).toBe('dirty')
    expect(out.stamp!.blobSha).toBeTruthy()
    // clobber the working file — the -w loose blob must still resolve to the stamped worktree content
    fixtureWrite(fx.dir, 'src/a.ts', 'totally different\n')
    expect(await catBlob(fx.dir, out.stamp!.blobSha!)).toBe(content2)
    expect(out.context).toEqual({ before: ['}', 'export const K = 10', 'export const J = 20'], after: [] })
  })

  it('3. untracked file (side new): -w blob + on-disk context', async () => {
    const content = ['line one', 'line two', 'line three', 'line four', ''].join('\n')
    fixtureWrite(fx.dir, 'src/fresh.ts', content)
    const anchor: CommentAnchor = { kind: 'diff', file: 'src/fresh.ts', side: 'new', line: 2, hunkRange: '@@', lineContent: 'line two' }
    const out = asDiff(await stampAnchor(fx.dir, makeSession(fx), anchor))
    expect(out.stamp!.surface).toBe('dirty') // an untracked file dirties the tree
    expect(await catBlob(fx.dir, out.stamp!.blobSha!)).toBe(content)
    expect(out.context).toEqual({ before: ['line one'], after: ['line three', 'line four'] })
  })

  it('4. side old: blob from mergeBase, base-space context', async () => {
    const mb = await mergeBase(fx.dir, 'main', 'feature')
    const anchor: CommentAnchor = { kind: 'diff', file: 'src/a.ts', side: 'old', line: 2, hunkRange: '@@', lineContent: '  return 1' }
    const out = asDiff(await stampAnchor(fx.dir, makeSession(fx), anchor))
    expect(out.stamp!.mergeBase).toBe(mb)
    expect(out.stamp!.blobSha).toBe(await blobShaAt(fx.dir, mb, 'src/a.ts'))
    expect(out.context).toEqual({ before: ['export function a() {'], after: ['}', 'export const K = 10'] })
  })

  it('5. heals empty lineContent to the real line text at L', async () => {
    const anchor: CommentAnchor = { kind: 'diff', file: 'src/a.ts', side: 'new', line: 4, hunkRange: '@@', lineContent: '' }
    const out = asDiff(await stampAnchor(fx.dir, makeSession(fx), anchor))
    expect(out.lineContent).toBe('export const K = 10')
  })

  it('6. out-of-range line (hallucinated): shas present, context undefined, no heal, no throw', async () => {
    const anchor: CommentAnchor = { kind: 'diff', file: 'src/a.ts', side: 'new', line: 9999, hunkRange: '@@', lineContent: '' }
    const out = asDiff(await stampAnchor(fx.dir, makeSession(fx), anchor))
    expect(out.stamp!.headSha).toBeTruthy()
    expect(out.context).toBeUndefined()
    expect(out.lineContent).toBe('') // untouched
  })

  it('7. already-stamped anchor returned unchanged (identity)', async () => {
    const stamp = { headSha: 'x', mergeBase: 'y', blobSha: 'z', surface: 'committed' as const, origLine: 1, origPath: 'src/a.ts' }
    const anchor: CommentAnchor = { kind: 'diff', file: 'src/a.ts', side: 'new', line: 2, hunkRange: '@@', lineContent: '  return 2', stamp }
    const out = await stampAnchor(fx.dir, makeSession(fx), anchor)
    expect(out).toBe(anchor)
    expect(asDiff(out).stamp).toBe(stamp)
  })

  it('8. non-positional anchor returned unchanged', async () => {
    const anchor: CommentAnchor = { kind: 'summary' }
    const out = await stampAnchor(fx.dir, makeSession(fx), anchor)
    expect(out).toBe(anchor)
  })

  it('10. git failure (bogus workdir): returns the anchor unchanged, never throws', async () => {
    const anchor: CommentAnchor = { kind: 'diff', file: 'src/a.ts', side: 'new', line: 2, hunkRange: '@@', lineContent: '  return 2' }
    const out = await stampAnchor('/no/such/limn/dir', makeSession(fx), anchor)
    expect(out).toBe(anchor)
    expect(asDiff(out).stamp).toBeUndefined()
  })
})

describe('stampAnchor — artifact anchors', () => {
  it('9. artifact anchor: -w blob + on-disk context', async () => {
    const anchor: CommentAnchor = { kind: 'artifact', path: 'docs/spec.md', line: 3, lineContent: 'Goal: protect the API on branch feature.' }
    const out = asArtifact(await stampAnchor(fx.dir, makeSession(fx), anchor))
    expect(out.stamp!.origPath).toBe('docs/spec.md')
    expect(out.stamp!.origLine).toBe(3)
    expect(await catBlob(fx.dir, out.stamp!.blobSha!)).toBe(fs.readFileSync(path.join(fx.dir, 'docs/spec.md'), 'utf8'))
    expect(out.context).toEqual({ before: ['# Rate limiting spec', ''], after: ['', '- criterion one', '- criterion two'] })
  })
})

describe('add_comment wiring — the agent path stamps the anchor', () => {
  it('populates anchor.stamp on an agent-added diff comment', async () => {
    const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'limn-anchorstamp-')), 'db')).db
    const s = createSession(db, fx.dir, makePair(fx), { engine: 'claude' })
    const t = createChatThread(db, s.id, { kind: 'user', agent: { engine: 'claude' } })
    const ctx: ToolHostCtx = {
      db, sessionId: s.id, threadId: t.id, opId: 'o', repo: fx.dir,
      agent: { engine: 'claude' }, emit: () => {}
    }
    await createToolHost(ctx).call('add_comment', { anchor: { kind: 'diff', file: 'src/a.ts', side: 'new', line: 4 }, text: 'note' })
    const added = loadReviewState(db, s.id).comments.find((c) => c.author === 'agent')!
    expect(added.anchor.kind).toBe('diff')
    expect(asDiff(added.anchor).stamp).toBeDefined()
    expect(asDiff(added.anchor).stamp!.origLine).toBe(4)
    expect(asDiff(added.anchor).context).toBeDefined()
  })
})
