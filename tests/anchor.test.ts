import { describe, it, expect } from 'vitest'
import {
  reanchorComments,
  mapLine,
  fuzzyFind,
  normalizeWs,
  similarity,
  ACCEPT_THRESHOLD,
  type EditHunk
} from '../src/server/anchor'
import type { Artifact, Comment, DiffSkeleton, AnchorContext, SessionMeta } from '../src/shared/types'
import type { ReanchorCtx } from '../src/server/anchor'

function mkSkeleton(lines: { new: number | null; old: number | null; kind: '' | 'add' | 'del'; text: string }[]): DiffSkeleton {
  return {
    base: 'main', branch: 'f', mergeBase: 'x', headSha: 'y',
    files: [{
      path: 'src/a.ts', status: 'modified', binary: false, add: 1, del: 0,
      hunks: [{ range: '@@ -1,3 +1,4 @@', header: '', lines }]
    }]
  }
}

function mkComment(over: Partial<Comment> & { anchor: Comment['anchor'] }): Comment {
  return { id: 'c1', author: 'user', text: 't', status: 'queued', replies: [], createdAt: 'now', iteration: 1, ...over }
}

// Legacy (unstamped) anchors take stage 3 (today's exact-match floor). These pins
// use a non-existent workdir: heal-forward's stampAnchor git calls fail there and
// are swallowed (never throws), so the observed behavior is pure stage 3.
const fakeSession: SessionMeta = {
  id: 1, repo: '/nonexistent',
  pair: { base: { kind: 'branch', symbol: 'main', anchorSha: 'x' }, compare: { kind: 'branch', symbol: 'f', anchorSha: 'y' } },
  createdAt: 'now', updatedAt: 'now'
}
function mkCtx(forAnchor: DiffSkeleton): ReanchorCtx {
  return { workdir: '/nonexistent', hasWorktree: false, forAnchor, currentTip: 'y', currentMergeBase: 'x', session: fakeSession }
}

describe('reanchorComments', () => {
  it('updates line when content moved', async () => {
    const sk = mkSkeleton([
      { old: 1, new: 1, kind: '', text: 'context' },
      { old: null, new: 2, kind: 'add', text: 'const x = 1' },
      { old: null, new: 3, kind: 'add', text: 'target line' }
    ])
    const c = mkComment({ anchor: { kind: 'diff', file: 'src/a.ts', side: 'new', line: 9, hunkRange: '@@ old @@', lineContent: 'target line' } })
    await reanchorComments(mkCtx(sk), [c], [])
    expect(c.status).toBe('queued')
    expect(c.anchor).toMatchObject({ line: 3, hunkRange: '@@ -1,3 +1,4 @@' })
  })

  it('marks outdated when content gone', async () => {
    const sk = mkSkeleton([{ old: 1, new: 1, kind: '', text: 'context' }])
    const c = mkComment({ anchor: { kind: 'diff', file: 'src/a.ts', side: 'new', line: 2, hunkRange: '@@', lineContent: 'vanished' } })
    await reanchorComments(mkCtx(sk), [c], [])
    expect(c.status).toBe('outdated')
  })

  it('nearest duplicate wins', async () => {
    const sk = mkSkeleton([
      { old: null, new: 1, kind: 'add', text: 'dup' },
      { old: null, new: 2, kind: 'add', text: 'x' },
      { old: null, new: 8, kind: 'add', text: 'dup' }
    ])
    const c = mkComment({ anchor: { kind: 'diff', file: 'src/a.ts', side: 'new', line: 7, hunkRange: '@@', lineContent: 'dup' } })
    await reanchorComments(mkCtx(sk), [c], [])
    expect((c.anchor as { line: number }).line).toBe(8)
  })

  it('does not anchor new-side comments to deleted lines', async () => {
    const sk = mkSkeleton([{ old: 1, new: null, kind: 'del', text: 'removed thing' }])
    const c = mkComment({ anchor: { kind: 'diff', file: 'src/a.ts', side: 'new', line: 1, hunkRange: '@@', lineContent: 'removed thing' } })
    await reanchorComments(mkCtx(sk), [c], [])
    expect(c.status).toBe('outdated')
  })

  it('re-anchors artifact comments by text', async () => {
    const art: Artifact = { role: 'spec', format: 'superpowers', path: 'docs/spec.md', title: 'Spec', lines: ['# Spec', '', 'the goal moved here'] }
    const c = mkComment({ anchor: { kind: 'artifact', path: 'docs/spec.md', line: 1, lineContent: 'the goal moved here' } })
    await reanchorComments(mkCtx(mkSkeleton([])), [c], [art])
    expect((c.anchor as { line: number }).line).toBe(3)
    expect(c.status).toBe('queued')
  })

  it('leaves non-positional comments untouched; re-anchors resolved ones without re-statusing them', async () => {
    const sk = mkSkeleton([])
    const sec = mkComment({ id: 's', anchor: { kind: 'section', sectionId: 's1' } })
    const resolved = mkComment({
      id: 'r', status: 'resolved',
      anchor: { kind: 'diff', file: 'src/a.ts', side: 'new', line: 5, hunkRange: '@@', lineContent: 'gone' }
    })
    await reanchorComments(mkCtx(sk), [sec, resolved], [])
    expect(sec.status).toBe('queued')
    // #18: a resolved comment IS re-anchored, but a resolution is a historical record —
    // it never becomes 'outdated'. An unlocatable anchor is flagged notInDiff instead.
    expect(resolved.status).toBe('resolved')
    expect(resolved.notInDiff).toBe(true)
    expect((resolved.anchor as { line: number }).line).toBe(5)
  })

  it('re-anchors a resolved comment onto the line its content moved to', async () => {
    const sk = mkSkeleton([
      { old: 1, new: 1, kind: '', text: 'context' },
      { old: null, new: 2, kind: 'add', text: 'const x = 1' },
      { old: null, new: 3, kind: 'add', text: 'target line' }
    ])
    const c = mkComment({
      id: 'r', status: 'resolved', resolution: { verdict: 'addressed', note: 'done' },
      anchor: { kind: 'diff', file: 'src/a.ts', side: 'new', line: 9, hunkRange: '@@ old @@', lineContent: 'target line' }
    })
    await reanchorComments(mkCtx(sk), [c], [])
    expect(c.status).toBe('resolved')
    expect(c.resolution?.verdict).toBe('addressed')
    expect(c.anchor).toMatchObject({ line: 3, hunkRange: '@@ -1,3 +1,4 @@' })
  })

  it('leaves a legacy blank-line comment untouched on an unchanged file (mirrors the focus-target skip)', async () => {
    const sk = mkSkeleton([{ old: 1, new: 1, kind: '', text: 'context' }])
    // A pre-stamp comment anchored on a blank rendered line carries no evidence to
    // re-anchor from — an empty quote exact-matches every blank line, so stage 3
    // would decline it and mark it outdated on every load even though nothing
    // changed. Mirrors the skip in reanchorFocusTargets (N7 in anchor-git.test.ts).
    const c = mkComment({ anchor: { kind: 'diff', file: 'src/a.ts', side: 'new', line: 1, hunkRange: '@@', lineContent: '' } })
    await reanchorComments(mkCtx(sk), [c], [])
    expect(c.status).toBe('queued')
    expect(c.notInDiff).toBeUndefined()
    expect(c.anchor).toMatchObject({ line: 1, lineContent: '' })
  })
})

describe('normalizeWs', () => {
  it('trims and collapses internal whitespace runs', () => {
    expect(normalizeWs('  a   b  \t c  ')).toBe('a b c')
  })
  it('leaves an already-normalized string untouched', () => {
    expect(normalizeWs('a b c')).toBe('a b c')
  })
  it('collapses to empty for whitespace-only input', () => {
    expect(normalizeWs('   \t  ')).toBe('')
  })
})

describe('similarity', () => {
  it('both empty -> 1', () => {
    expect(similarity('', '')).toBe(1)
  })
  it('exactly one empty -> 0', () => {
    expect(similarity('a', '')).toBe(0)
    expect(similarity('', 'a')).toBe(0)
  })
  it('single-character strings fall back to exact equality', () => {
    expect(similarity('a', 'a')).toBe(1)
    expect(similarity('a', 'b')).toBe(0)
  })
  it('classic Dice coefficient example (night/nacht)', () => {
    // bigrams(night)={ni,ig,gh,ht} bigrams(nacht)={na,ac,ch,ht}; 1 shared of 4+4
    expect(similarity('night', 'nacht')).toBeCloseTo(0.25, 10)
  })
  it('identical multi-char strings -> 1', () => {
    expect(similarity('hello world', 'hello world')).toBe(1)
  })
  it('counts duplicate bigrams via multiset intersection', () => {
    // bigrams(aaaa) = {aa:3}; bigrams(aaa) = {aa:2}; intersection = min(3,2) = 2
    expect(similarity('aaaa', 'aaa')).toBeCloseTo((2 * 2) / (3 + 2), 10)
  })
})

describe('mapLine', () => {
  it('before the first hunk: passes through unchanged', () => {
    const hunks: EditHunk[] = [{ oldStart: 5, oldLen: 1, newStart: 5, newLen: 1 }]
    expect(mapLine(hunks, 2)).toBe(2)
  })

  it('between two hunks with mixed +/- deltas: accumulates only the earlier delta', () => {
    const hunks: EditHunk[] = [
      { oldStart: 2, oldLen: 1, newStart: 2, newLen: 3 },  // net +2
      { oldStart: 10, oldLen: 2, newStart: 12, newLen: 0 } // net -2
    ]
    expect(mapLine(hunks, 6)).toBe(8)
  })

  it('after the last hunk: accumulates every delta', () => {
    const hunks: EditHunk[] = [
      { oldStart: 2, oldLen: 1, newStart: 2, newLen: 3 },  // net +2
      { oldStart: 10, oldLen: 2, newStart: 12, newLen: 0 } // net -2
    ]
    expect(mapLine(hunks, 15)).toBe(15)
  })

  // Pure insertions use git's `-N,0 +M,k` convention: the block is inserted
  // AFTER old line N (insert-after-5 emits `@@ -5,0 +6,2 @@`; insert-before-5
  // emits `@@ -4,0 +5,4 @@`). Never EDITED; L === oldStart is above the block.
  it('pure insertion AFTER L (`@@ -5,0 +6,2 @@`): L keeps its position', () => {
    const hunks: EditHunk[] = [{ oldStart: 5, oldLen: 0, newStart: 6, newLen: 2 }]
    expect(mapLine(hunks, 5)).toBe(5)
  })

  it('pure insertion BEFORE L (`@@ -4,0 +5,4 @@`): L shifts by newLen', () => {
    const hunks: EditHunk[] = [{ oldStart: 4, oldLen: 0, newStart: 5, newLen: 4 }]
    expect(mapLine(hunks, 5)).toBe(9)
  })

  it('L far past a pure-insertion hunk: accumulates the full insertion delta', () => {
    const hunks: EditHunk[] = [{ oldStart: 5, oldLen: 0, newStart: 6, newLen: 2 }]
    expect(mapLine(hunks, 20)).toBe(22)
  })

  it('inside a replace hunk: EDITED', () => {
    const hunks: EditHunk[] = [{ oldStart: 5, oldLen: 2, newStart: 5, newLen: 3 }]
    expect(mapLine(hunks, 5)).toBe('EDITED')
    expect(mapLine(hunks, 6)).toBe('EDITED')
  })

  it('exact boundary: L === oldStart of a replace hunk -> EDITED', () => {
    const hunks: EditHunk[] = [{ oldStart: 5, oldLen: 2, newStart: 5, newLen: 3 }]
    expect(mapLine(hunks, 5)).toBe('EDITED')
  })

  it('exact boundary: L === oldStart + oldLen (first line after) -> mapped, not EDITED', () => {
    const hunks: EditHunk[] = [{ oldStart: 5, oldLen: 2, newStart: 5, newLen: 3 }]
    expect(mapLine(hunks, 7)).toBe(8)
  })
})

describe('fuzzyFind', () => {
  it('accepts a whitespace-only reformat of the target line', () => {
    const content = ['a', '  target   line  ', 'c']
    const result = fuzzyFind(content, 'target line', undefined, 2)
    expect(result).not.toBeNull()
    expect(result?.line).toBe(2)
    expect(result?.score).toBeGreaterThanOrEqual(ACCEPT_THRESHOLD)
  })

  it('accepts a one-token rename on the line', () => {
    const content = ['x', 'let total = items.length', 'y']
    const result = fuzzyFind(content, 'let count = items.length', undefined, 2)
    expect(result).not.toBeNull()
    expect(result?.line).toBe(2)
  })

  it('rejects an unrelated line', () => {
    const content = ['completely different text here', 'another random line entirely']
    const result = fuzzyFind(content, 'const foo = getValue()', undefined, 1)
    expect(result).toBeNull()
  })

  it('accepts a blank quote only with strong surrounding context', () => {
    const content = ['function foo() {', 'return 1', '}', 'other']
    const context: AnchorContext = { before: ['function foo() {', 'return 1'], after: ['other'] }
    const result = fuzzyFind(content, '   ', context, 3)
    expect(result).not.toBeNull()
    expect(result?.line).toBe(3)
  })

  it('accepts a blank quote with strong context even when the hint is far away', () => {
    // Regression: acceptance is gated on ctxSim >= BLANK_QUOTE_CTX_MIN alone,
    // NOT additionally on ACCEPT_THRESHOLD. ctxSim here is exactly 0.8
    // (similarity('abcdef','abcdeg') === 0.8 for both neighbors), so under the
    // old proximity-coupled formula a far hint dropped the score to ~0.71 and
    // silently rejected this eligible candidate.
    const content = ['abcdef', '   ', 'abcdef'] // blank candidate on line 2
    const context: AnchorContext = { before: ['abcdeg'], after: ['abcdeg'] }
    expect(similarity('abcdef', 'abcdeg')).toBeCloseTo(0.8, 10) // guards the fixture
    const result = fuzzyFind(content, '   ', context, 100)
    expect(result).not.toBeNull()
    expect(result?.line).toBe(2)
  })

  it('rejects a blank quote when context is weak', () => {
    const content = ['function foo() {', 'return 1', '}', 'other']
    const context: AnchorContext = { before: ['nothing like it', 'also unrelated'], after: ['still unrelated'] }
    const result = fuzzyFind(content, '   ', context, 3)
    expect(result).toBeNull()
  })

  it('rejects a blank quote with no context at all', () => {
    const content = ['function foo() {', 'return 1', '}', 'other']
    const result = fuzzyFind(content, '', undefined, 3)
    expect(result).toBeNull()
  })

  it('accepts a `}`-only quote via ordinary scoring when a `}` line sits near the hint', () => {
    // `}` normalizes non-empty, so it takes the ordinary (non-blank) path: an
    // exact `}` candidate near the hint clears the threshold on its own.
    const content = ['function foo() {', '  return 1', '}', 'other']
    const result = fuzzyFind(content, '}', undefined, 3)
    expect(result).not.toBeNull()
    expect(result?.line).toBe(3)
    expect(result?.score).toBeGreaterThanOrEqual(ACCEPT_THRESHOLD)
  })

  it('rejects a `}`-only quote when no `}` line is nearby', () => {
    const content = ['const a = 1', 'const b = 2', 'const c = 3']
    const result = fuzzyFind(content, '}', undefined, 2)
    expect(result).toBeNull()
  })

  it('proximity breaks ties between two byte-identical candidates, favoring the hint', () => {
    const content = ['x', 'TARGET', 'y1', 'y2', 'y3', 'y4', 'y5', 'y6', 'TARGET', 'z']
    const result = fuzzyFind(content, 'TARGET', undefined, 2)
    expect(result).not.toBeNull()
    expect(result?.line).toBe(2)
  })

  it('proximity tie-break also favors the hint when it is nearer the later candidate', () => {
    const content = ['x', 'TARGET', 'y1', 'y2', 'y3', 'y4', 'y5', 'y6', 'TARGET', 'z']
    const result = fuzzyFind(content, 'TARGET', undefined, 9)
    expect(result).not.toBeNull()
    expect(result?.line).toBe(9)
  })
})
