import { describe, it, expect, beforeAll, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeFixtureRepo, type FixtureRepo, fixtureGit, fixtureWrite } from './helpers/fixtureRepo'
import * as git from '../src/server/git'
import { blobShaAt, catBlob, showFile, hashObjectsWrite, diffContents, renameMap, hashObjects, getDiff, isDirty } from '../src/server/git'
import { execGitDiff } from '../src/server/exec'
import { reanchorComments, type ReanchorCtx } from '../src/server/anchor'
import { stampAnchor } from '../src/server/anchorStamp'
import type { Comment, CommentAnchor, SessionMeta } from '../src/shared/types'

let fx: FixtureRepo

beforeAll(() => {
  fx = makeFixtureRepo()
})

describe('blobShaAt', () => {
  it('matches git rev-parse <ref>:<path> for a known committed file', async () => {
    const expected = fixtureGit(fx.dir, 'rev-parse', `${fx.shas.head}:src/a.ts`)
    expect(await blobShaAt(fx.dir, fx.shas.head, 'src/a.ts')).toBe(expected)
  })

  it('returns null for an absent path', async () => {
    expect(await blobShaAt(fx.dir, fx.shas.head, 'does/not/exist.ts')).toBeNull()
  })
})

describe('catBlob', () => {
  it('round-trips the exact bytes of a known blob, including trailing newline', async () => {
    const sha = fixtureGit(fx.dir, 'rev-parse', `${fx.shas.base}:src/old.ts`)
    const content = await catBlob(fx.dir, sha)
    expect(content).toBe('export const gone = true\n')
  })

  it('returns null for a bogus 40-hex sha', async () => {
    const bogus = '0'.repeat(40)
    expect(await catBlob(fx.dir, bogus)).toBeNull()
  })
})

describe('showFile', () => {
  it('returns content at a ref for a present path', async () => {
    const content = await showFile(fx.dir, fx.shas.head, 'src/moved.ts')
    expect(content).toBe(['export const stay1 = 1', 'export const stay2 = 2', 'export const stay3 = 3', ''].join('\n'))
  })

  it('returns null for an absent path', async () => {
    expect(await showFile(fx.dir, fx.shas.head, 'src/moveme.ts')).toBeNull()
  })
})

describe('hashObjectsWrite', () => {
  it('matches hashObjects for identical content, and the sha survives via catBlob (proving -w persisted)', async () => {
    fixtureWrite(fx.dir, 'dirty-write.txt', 'uncommitted content for -w test\n')
    try {
      const plain = await hashObjects(fx.dir, ['dirty-write.txt'])
      const written = await hashObjectsWrite(fx.dir, ['dirty-write.txt'])
      const sha = written.get('dirty-write.txt')
      expect(sha).toBe(plain.get('dirty-write.txt'))
      expect(sha).toMatch(/^[0-9a-f]{40}$/)
      // remove the working-tree file — only the loose object should still hold the content
      execFileSync('rm', [`${fx.dir}/dirty-write.txt`])
      const recovered = await catBlob(fx.dir, sha!)
      expect(recovered).toBe('uncommitted content for -w test\n')
    } finally {
      try { execFileSync('rm', ['-f', `${fx.dir}/dirty-write.txt`]) } catch { /* already removed */ }
    }
  })
})

describe('diffContents', () => {
  it('pure insertion', async () => {
    const a = 'one\ntwo\nthree\n'
    const b = 'one\ntwo\nnew\nthree\n'
    const hunks = await diffContents(a, b)
    expect(hunks).toEqual([{ oldStart: 2, oldLen: 0, newStart: 3, newLen: 1 }])
  })

  it('pure deletion', async () => {
    const a = 'one\ntwo\nthree\n'
    const b = 'one\nthree\n'
    const hunks = await diffContents(a, b)
    expect(hunks).toEqual([{ oldStart: 2, oldLen: 1, newStart: 1, newLen: 0 }])
  })

  it('replacement', async () => {
    const a = 'one\ntwo\nthree\n'
    const b = 'one\nTWO\nthree\n'
    const hunks = await diffContents(a, b)
    expect(hunks).toEqual([{ oldStart: 2, oldLen: 1, newStart: 2, newLen: 1 }])
  })

  it('two hunks at different offsets', async () => {
    const a = 'one\ntwo\nthree\nfour\nfive\n'
    const b = 'ONE\ntwo\nthree\nfour\nFIVE\n'
    const hunks = await diffContents(a, b)
    expect(hunks).toEqual([
      { oldStart: 1, oldLen: 1, newStart: 1, newLen: 1 },
      { oldStart: 5, oldLen: 1, newStart: 5, newLen: 1 }
    ])
  })

  it('identical contents return null', async () => {
    const same = 'one\ntwo\nthree\n'
    expect(await diffContents(same, same)).toBeNull()
  })
})

describe('renameMap', () => {
  it('contains the old→new entry for a committed rename', async () => {
    const map = await renameMap(fx.dir, fx.shas.base, fx.shas.firstFeature)
    expect(map.get('src/moveme.ts')).toBe('src/moved.ts')
  })

  it('has no entry for non-renamed paths', async () => {
    const map = await renameMap(fx.dir, fx.shas.base, fx.shas.firstFeature)
    expect(map.has('src/a.ts')).toBe(false)
  })
})

describe('execGitDiff', () => {
  it('rejects on a genuinely bad invocation (exit >= 2)', async () => {
    await expect(execGitDiff(fx.dir, ['diff', '--no-index', '--this-flag-does-not-exist'])).rejects.toThrow()
  })
})

// ── end-to-end re-anchor pipeline (stages 0→1→2→3 through real git) ──────────
// Each scenario: build a repo, create a STAMPED comment against the current
// surface (stampAnchor), mutate the repo, run reanchorComments, assert the
// re-anchored {status, line, file, notInDiff}. base = main, compare = feature.

/** A fresh scenario repo with main as the base branch; the caller adds feature. */
function mkRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limn-anchor-e2e-'))
  fixtureGit(dir, 'init', '-b', 'main')
  fixtureGit(dir, 'config', 'user.name', 'Fixture')
  fixtureGit(dir, 'config', 'user.email', 'fix@test')
  return dir
}
function commit(dir: string, msg: string): void { fixtureGit(dir, 'add', '-A'); fixtureGit(dir, 'commit', '-q', '-m', msg) }
function lines(...ls: string[]): string { return ls.join('\n') + '\n' }

function mkSession(repo: string): SessionMeta {
  return {
    id: 1, repo, createdAt: 'now', updatedAt: 'now',
    pair: { base: { kind: 'branch', symbol: 'main', anchorSha: '' }, compare: { kind: 'branch', symbol: 'feature', anchorSha: '' } }
  }
}
function mkComment(anchor: CommentAnchor): Comment {
  return { id: 'c1', anchor, author: 'user', text: 't', status: 'queued', replies: [], createdAt: 'now', iteration: 1 }
}
/** Stamp a diff anchor against the repo's current surface, returning a queued comment. */
async function stampedComment(repo: string, session: SessionMeta, opts: { file: string; line: number; text: string; side?: 'new' | 'old' }): Promise<Comment> {
  const anchor: CommentAnchor = { kind: 'diff', file: opts.file, side: opts.side ?? 'new', line: opts.line, hunkRange: '@@', lineContent: opts.text }
  return mkComment(await stampAnchor(repo, session, anchor))
}
/** Build the ReanchorCtx exactly as assembleReview does: base→feature skeleton as
 *  the rendered surface, with on-disk fileHash attached (so stage 0 can short-circuit). */
async function buildCtx(repo: string, session: SessionMeta): Promise<ReanchorCtx> {
  const skeleton = await getDiff(repo, 'main', 'feature')
  const paths = [...new Set(skeleton.files.map((f) => f.path))]
  const hashes = await hashObjects(repo, paths)
  for (const f of skeleton.files) { const h = hashes.get(f.path); if (h) f.fileHash = h }
  return { workdir: repo, wt: repo, forAnchor: skeleton, dirty: await isDirty(repo), currentTip: skeleton.headSha, currentMergeBase: skeleton.mergeBase, session }
}
const anchorLine = (c: Comment): number => (c.anchor as { line: number }).line
const anchorFile = (c: Comment): string => (c.anchor as { file: string }).file
const anchorText = (c: Comment): string => (c.anchor as { lineContent: string }).lineContent

describe('reanchorComments — pipeline scenarios', () => {
  it('1. reformat: re-indented commented line survives via stage 2, NOT outdated, quote refreshed', async () => {
    const repo = mkRepo()
    fixtureWrite(repo, 'README.md', 'root\n'); commit(repo, 'base')
    fixtureGit(repo, 'checkout', '-q', '-b', 'feature')
    fixtureWrite(repo, 'app.ts', lines('function compute(x) {', '  const y = x + 1', '  return y * 2', '}')); commit(repo, 'add app')
    const session = mkSession(repo)
    const c = await stampedComment(repo, session, { file: 'app.ts', line: 3, text: '  return y * 2' })
    // re-indent the whole body (every inner line changes byte-wise)
    fixtureWrite(repo, 'app.ts', lines('function compute(x) {', '    const y = x + 1', '    return y * 2', '}')); commit(repo, 'reindent')
    await reanchorComments(await buildCtx(repo, session), [c], [])
    expect(c.status).not.toBe('outdated')
    expect(anchorLine(c)).toBe(3)
    expect(anchorText(c)).toBe('    return y * 2') // stage-2 refresh keeps the quote honest
    expect(c.notInDiff).toBeFalsy()
  })

  it('2a. duplicate braces: insertion above keeps the comment on ITS brace via stage-1 positional map', async () => {
    const repo = mkRepo()
    fixtureWrite(repo, 'README.md', 'root\n'); commit(repo, 'base')
    fixtureGit(repo, 'checkout', '-q', '-b', 'feature')
    const blocks: string[] = []
    for (let i = 1; i <= 5; i++) blocks.push(`function f${i}() {`, `  return ${i}`, '}')
    fixtureWrite(repo, 'braces.ts', lines(...blocks)); commit(repo, 'add braces')
    const session = mkSession(repo)
    // the 3rd `}` sits at line 9
    const c = await stampedComment(repo, session, { file: 'braces.ts', line: 9, text: '}' })
    // prepend a 10-line block — the commented `}` shifts to line 19
    fixtureWrite(repo, 'braces.ts', lines('function pre() {', '  const a = 0', '  const b = 1', '  const c = 2', '  const d = 3', '  const e = 4', '  const g = 5', '  const h = 6', '  return a', '}', ...blocks)); commit(repo, 'prepend block')
    await reanchorComments(await buildCtx(repo, session), [c], [])
    expect(c.status).not.toBe('outdated')
    expect(anchorLine(c)).toBe(19)      // pickNearest would have jumped to a different brace
    expect(anchorText(c)).toBe('}')
  })

  it('2b. sibling: the commented line itself deleted → outdated (not re-attached)', async () => {
    const repo = mkRepo()
    fixtureWrite(repo, 'README.md', 'root\n'); commit(repo, 'base')
    fixtureGit(repo, 'checkout', '-q', '-b', 'feature')
    // distinctive lines: the deleted quote is dissimilar to the survivors, so a wrong
    // sibling can't clear stage 2 on shared prefixes/context — the comment must die.
    fixtureWrite(repo, 'consts.ts', lines('alpha_first_value = 100', 'zzz_delete_target_qwerty = 42', 'omega_last_value = 200')); commit(repo, 'add consts')
    const session = mkSession(repo)
    const c = await stampedComment(repo, session, { file: 'consts.ts', line: 2, text: 'zzz_delete_target_qwerty = 42' })
    fixtureWrite(repo, 'consts.ts', lines('alpha_first_value = 100', 'omega_last_value = 200')); commit(repo, 'delete line')
    await reanchorComments(await buildCtx(repo, session), [c], [])
    expect(c.status).toBe('outdated')
  })

  it('3. rename: comment follows a git mv to the new path, same line', async () => {
    const repo = mkRepo()
    fixtureWrite(repo, 'README.md', 'root\n'); commit(repo, 'base')
    fixtureGit(repo, 'checkout', '-q', '-b', 'feature')
    fixtureWrite(repo, 'src/a.ts', lines('export const A = 1', 'export const B = 2')); commit(repo, 'add a')
    const session = mkSession(repo)
    const c = await stampedComment(repo, session, { file: 'src/a.ts', line: 2, text: 'export const B = 2' })
    fixtureGit(repo, 'mv', 'src/a.ts', 'src/b.ts'); commit(repo, 'rename a→b')
    await reanchorComments(await buildCtx(repo, session), [c], [])
    expect(c.status).not.toBe('outdated')
    expect(anchorFile(c)).toBe('src/b.ts')
    expect(anchorLine(c)).toBe(2)
  })

  it('4. unchanged line, edits elsewhere: stage 1 maps by the net insertion delta', async () => {
    const repo = mkRepo()
    fixtureWrite(repo, 'README.md', 'root\n'); commit(repo, 'base')
    fixtureGit(repo, 'checkout', '-q', '-b', 'feature')
    fixtureWrite(repo, 'app.ts', lines('a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'target-line', 'a8', 'a9')); commit(repo, 'add app')
    const session = mkSession(repo)
    const c = await stampedComment(repo, session, { file: 'app.ts', line: 7, text: 'target-line' })
    // insert two lines near the top; target-line (line 7) shifts to line 9
    fixtureWrite(repo, 'app.ts', lines('a1', 'INS-1', 'INS-2', 'a2', 'a3', 'a4', 'a5', 'a6', 'target-line', 'a8', 'a9')); commit(repo, 'insert above')
    await reanchorComments(await buildCtx(repo, session), [c], [])
    expect(c.status).not.toBe('outdated')
    expect(anchorLine(c)).toBe(9)
    expect(anchorText(c)).toBe('target-line')
  })

  it('4b. regression: insertion immediately AFTER the commented line keeps it put (pure-insertion off-by-one)', async () => {
    const repo = mkRepo()
    fixtureWrite(repo, 'README.md', 'root\n'); commit(repo, 'base')
    fixtureGit(repo, 'checkout', '-q', '-b', 'feature')
    fixtureWrite(repo, 'app.ts', lines('a1', 'a2', 'a3', 'a4', 'target-line', 'a6', 'a7')); commit(repo, 'add app')
    const session = mkSession(repo)
    const c = await stampedComment(repo, session, { file: 'app.ts', line: 5, text: 'target-line' })
    // insert two lines right AFTER line 5 — git emits `@@ -5,0 +6,2 @@`; the
    // commented line sits above the insertion and must NOT shift (the old
    // boundary bug mapped it onto the inserted block at line 7)
    fixtureWrite(repo, 'app.ts', lines('a1', 'a2', 'a3', 'a4', 'target-line', 'INS-1', 'INS-2', 'a6', 'a7')); commit(repo, 'insert after')
    await reanchorComments(await buildCtx(repo, session), [c], [])
    expect(c.status).not.toBe('outdated')
    expect(anchorLine(c)).toBe(5)
    expect(anchorText(c)).toBe('target-line')
    expect(c.notInDiff).toBeFalsy()
  })

  it('5a. commented line lightly edited: stage 2 re-anchors and refreshes the quote', async () => {
    const repo = mkRepo()
    fixtureWrite(repo, 'README.md', 'root\n'); commit(repo, 'base')
    fixtureGit(repo, 'checkout', '-q', '-b', 'feature')
    fixtureWrite(repo, 'config.ts', lines("export const name = 'svc'", 'const timeout = 30', 'export default name')); commit(repo, 'add config')
    const session = mkSession(repo)
    const c = await stampedComment(repo, session, { file: 'config.ts', line: 2, text: 'const timeout = 30' })
    const stampBefore = structuredClone((c.anchor as { stamp: unknown }).stamp)
    const contextBefore = structuredClone((c.anchor as { context?: unknown }).context)
    fixtureWrite(repo, 'config.ts', lines("export const name = 'svc'", 'const timeout = 60', 'export default name')); commit(repo, 'tweak timeout')
    await reanchorComments(await buildCtx(repo, session), [c], [])
    expect(c.status).not.toBe('outdated')
    expect(anchorLine(c)).toBe(2)
    expect(anchorText(c)).toBe('const timeout = 60') // refreshed
    // the stage-2 lineContent refresh must NOT mutate the immutable stamp/context
    expect((c.anchor as { stamp: unknown }).stamp).toEqual(stampBefore)
    expect((c.anchor as { context?: unknown }).context).toEqual(contextBefore)
  })

  it('5b. commented line totally rewritten: outdated', async () => {
    const repo = mkRepo()
    fixtureWrite(repo, 'README.md', 'root\n'); commit(repo, 'base')
    fixtureGit(repo, 'checkout', '-q', '-b', 'feature')
    fixtureWrite(repo, 'calc.ts', lines('const head = 1', 'const alpha = compute(seed)', 'const tail = 2')); commit(repo, 'add calc')
    const session = mkSession(repo)
    const c = await stampedComment(repo, session, { file: 'calc.ts', line: 2, text: 'const alpha = compute(seed)' })
    fixtureWrite(repo, 'calc.ts', lines('const head = 1', 'while (running) { flush() }', 'const tail = 2')); commit(repo, 'rewrite line')
    await reanchorComments(await buildCtx(repo, session), [c], [])
    expect(c.status).toBe('outdated')
  })

  it('6. old-side comment on a deleted line: base unchanged → stable, not outdated', async () => {
    const repo = mkRepo()
    fixtureWrite(repo, 'legacy.ts', lines('export const keep1 = 1', 'export const legacy = true', 'export const keep2 = 2')); commit(repo, 'base')
    fixtureGit(repo, 'checkout', '-q', '-b', 'feature')
    fixtureWrite(repo, 'legacy.ts', lines('export const keep1 = 1', 'export const keep2 = 2')); commit(repo, 'drop legacy')
    const session = mkSession(repo)
    const c = await stampedComment(repo, session, { file: 'legacy.ts', line: 2, text: 'export const legacy = true', side: 'old' })
    await reanchorComments(await buildCtx(repo, session), [c], [])
    expect(c.status).not.toBe('outdated')
    expect(anchorLine(c)).toBe(2)
    expect(c.notInDiff).toBeFalsy() // the deleted line is rendered on the old side
  })

  it('7. blob pruned (bogus blobSha): degrades to stage-2 context, still re-anchors after edit-elsewhere', async () => {
    const repo = mkRepo()
    fixtureWrite(repo, 'README.md', 'root\n'); commit(repo, 'base')
    fixtureGit(repo, 'checkout', '-q', '-b', 'feature')
    fixtureWrite(repo, 'data.ts', lines('const w = 1', 'const x = 2', 'const y = 3', 'const MARKER = 42', 'const z = 4', 'const q = 5')); commit(repo, 'add data')
    const session = mkSession(repo)
    const c = await stampedComment(repo, session, { file: 'data.ts', line: 4, text: 'const MARKER = 42' })
    // simulate a GC'd blob: cat-file will fail for this sha
    ;(c.anchor as { stamp?: { blobSha?: string } }).stamp!.blobSha = '0'.repeat(40)
    fixtureWrite(repo, 'data.ts', lines('INS-a', 'INS-b', 'INS-c', 'const w = 1', 'const x = 2', 'const y = 3', 'const MARKER = 42', 'const z = 4', 'const q = 5')); commit(repo, 'insert above')
    await reanchorComments(await buildCtx(repo, session), [c], [])
    expect(c.status).not.toBe('outdated')
    expect(anchorLine(c)).toBe(7) // stage-2 found it via the stored context
  })

  it('8a. legacy anchor (no stamp): stage-3 success heals it forward with a stamp', async () => {
    const repo = mkRepo()
    fixtureWrite(repo, 'README.md', 'root\n'); commit(repo, 'base')
    fixtureGit(repo, 'checkout', '-q', '-b', 'feature')
    fixtureWrite(repo, 'util.ts', lines('export const A = 1', 'export const B = 2', 'export const C = 3')); commit(repo, 'add util')
    const session = mkSession(repo)
    const c = mkComment({ kind: 'diff', file: 'util.ts', side: 'new', line: 2, hunkRange: '@@', lineContent: 'export const B = 2' })
    expect((c.anchor as { stamp?: unknown }).stamp).toBeUndefined()
    await reanchorComments(await buildCtx(repo, session), [c], [])
    expect(c.status).not.toBe('outdated')
    expect((c.anchor as { stamp?: unknown }).stamp).toBeDefined() // healed forward
  })

  it('8b. an UNHEALED legacy anchor dies on a reformat; a healed one survives it', async () => {
    const repo = mkRepo()
    fixtureWrite(repo, 'README.md', 'root\n'); commit(repo, 'base')
    fixtureGit(repo, 'checkout', '-q', '-b', 'feature')
    fixtureWrite(repo, 'util.ts', lines('export const A = 1', '  export const B = 2', 'export const C = 3')); commit(repo, 'add util')
    const session = mkSession(repo)
    // healed comment: load once (heals forward), THEN reformat
    const healed = mkComment({ kind: 'diff', file: 'util.ts', side: 'new', line: 2, hunkRange: '@@', lineContent: '  export const B = 2' })
    await reanchorComments(await buildCtx(repo, session), [healed], [])
    // control: a fresh legacy comment that never got a chance to heal
    const unhealed = mkComment({ kind: 'diff', file: 'util.ts', side: 'new', line: 2, hunkRange: '@@', lineContent: '  export const B = 2' })
    // reformat: re-indent the commented line so stage-3 exact match can no longer see it
    fixtureWrite(repo, 'util.ts', lines('export const A = 1', 'export const B = 2', 'export const C = 3')); commit(repo, 'reindent')
    const ctx = await buildCtx(repo, session)
    await reanchorComments(ctx, [healed], [])
    await reanchorComments(await buildCtx(repo, session), [unhealed], [])
    expect(healed.status).not.toBe('outdated') // survived via its healed stamp → stage 2
    expect(unhealed.status).toBe('outdated')   // stage-3-only, reindent killed the exact match
  })

  it('9. off-diff line: notInDiff set (never outdated); cleared once the line is back in a hunk', async () => {
    const repo = mkRepo()
    const body: string[] = []
    for (let i = 1; i <= 30; i++) body.push(`line ${i}`)
    fixtureWrite(repo, 'page.ts', lines(...body)); commit(repo, 'base')
    fixtureGit(repo, 'checkout', '-q', '-b', 'feature')
    fixtureWrite(repo, 'page.ts', lines(...body.map((l, i) => (i === 1 ? 'line 2 EDITED' : l)))); commit(repo, 'edit line 2')
    const session = mkSession(repo)
    // comment on line 20 — unchanged, far from the only hunk (around line 2)
    const c = await stampedComment(repo, session, { file: 'page.ts', line: 20, text: 'line 20' })
    await reanchorComments(await buildCtx(repo, session), [c], [])
    expect(c.status).not.toBe('outdated')
    expect(c.notInDiff).toBe(true)          // valid line, just not shown in this diff
    expect(anchorLine(c)).toBe(20)
    // now edit line 18 → a hunk appears around line 20, which re-enters the diff
    const body2 = body.map((l, i) => (i === 1 ? 'line 2 EDITED' : i === 17 ? 'line 18 EDITED' : l))
    fixtureWrite(repo, 'page.ts', lines(...body2)); commit(repo, 'edit line 18')
    await reanchorComments(await buildCtx(repo, session), [c], [])
    expect(c.status).not.toBe('outdated')
    expect(c.notInDiff).toBeFalsy()         // cleared: the line is on a rendered hunk again
    expect(anchorLine(c)).toBe(20)
  })

  it('11. regression: a line-shifting change re-anchors ONCE and stays put on a no-op reload (no compounding drift)', async () => {
    const repo = mkRepo()
    fixtureWrite(repo, 'README.md', 'root\n'); commit(repo, 'base')
    fixtureGit(repo, 'checkout', '-q', '-b', 'feature')
    fixtureWrite(repo, 'app.ts', lines('a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'target-line', 'a8', 'a9')); commit(repo, 'add app')
    const session = mkSession(repo)
    const c = await stampedComment(repo, session, { file: 'app.ts', line: 7, text: 'target-line' })
    // insert two lines near the top; target-line (line 7) shifts to line 9
    fixtureWrite(repo, 'app.ts', lines('a1', 'INS-1', 'INS-2', 'a2', 'a3', 'a4', 'a5', 'a6', 'target-line', 'a8', 'a9')); commit(repo, 'insert above')
    await reanchorComments(await buildCtx(repo, session), [c], []) // load 1: 7 → 9
    expect(anchorLine(c)).toBe(9)
    // load 2: file unchanged since load 1, but stage 0 can't short-circuit (the blob has
    // diverged from creation state), so stage 1 re-runs. It must map the IMMUTABLE
    // stamp.origLine through the original→current diff, NOT the already-shifted a.line —
    // else the +delta compounds every reload (9 → 11 → …) until the comment detaches.
    await reanchorComments(await buildCtx(repo, session), [c], []) // load 2: no-op reload
    expect(c.status).not.toBe('outdated')
    expect(anchorLine(c)).toBe(9) // STABLE — no compounding drift
  })

  it('10. regression guard: an unchanged second load makes ZERO diff --no-index calls (stage 0)', async () => {
    const repo = mkRepo()
    fixtureWrite(repo, 'README.md', 'root\n'); commit(repo, 'base')
    fixtureGit(repo, 'checkout', '-q', '-b', 'feature')
    fixtureWrite(repo, 'app.ts', lines('const a = 1', 'const b = 2', 'const c = 3')); commit(repo, 'add app')
    const session = mkSession(repo)
    const c = await stampedComment(repo, session, { file: 'app.ts', line: 2, text: 'const b = 2' })
    const spy = vi.spyOn(git, 'diffContents')
    try {
      await reanchorComments(await buildCtx(repo, session), [c], []) // load 1
      spy.mockClear()
      await reanchorComments(await buildCtx(repo, session), [c], []) // load 2 — nothing changed
      expect(spy).not.toHaveBeenCalled()
      expect(c.status).not.toBe('outdated')
    } finally {
      spy.mockRestore()
    }
  })
})
