import { describe, it, expect } from 'vitest'
import { reanchorComments } from '../src/main/anchor'
import type { Artifact, Comment, DiffSkeleton } from '../src/shared/types'

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

describe('reanchorComments', () => {
  it('updates line when content moved', () => {
    const sk = mkSkeleton([
      { old: 1, new: 1, kind: '', text: 'context' },
      { old: null, new: 2, kind: 'add', text: 'const x = 1' },
      { old: null, new: 3, kind: 'add', text: 'target line' }
    ])
    const c = mkComment({ anchor: { kind: 'diff', file: 'src/a.ts', side: 'new', line: 9, hunkRange: '@@ old @@', lineContent: 'target line' } })
    reanchorComments([c], sk, [])
    expect(c.status).toBe('queued')
    expect(c.anchor).toMatchObject({ line: 3, hunkRange: '@@ -1,3 +1,4 @@' })
  })

  it('marks outdated when content gone', () => {
    const sk = mkSkeleton([{ old: 1, new: 1, kind: '', text: 'context' }])
    const c = mkComment({ anchor: { kind: 'diff', file: 'src/a.ts', side: 'new', line: 2, hunkRange: '@@', lineContent: 'vanished' } })
    reanchorComments([c], sk, [])
    expect(c.status).toBe('outdated')
  })

  it('nearest duplicate wins', () => {
    const sk = mkSkeleton([
      { old: null, new: 1, kind: 'add', text: 'dup' },
      { old: null, new: 2, kind: 'add', text: 'x' },
      { old: null, new: 8, kind: 'add', text: 'dup' }
    ])
    const c = mkComment({ anchor: { kind: 'diff', file: 'src/a.ts', side: 'new', line: 7, hunkRange: '@@', lineContent: 'dup' } })
    reanchorComments([c], sk, [])
    expect((c.anchor as { line: number }).line).toBe(8)
  })

  it('does not anchor new-side comments to deleted lines', () => {
    const sk = mkSkeleton([{ old: 1, new: null, kind: 'del', text: 'removed thing' }])
    const c = mkComment({ anchor: { kind: 'diff', file: 'src/a.ts', side: 'new', line: 1, hunkRange: '@@', lineContent: 'removed thing' } })
    reanchorComments([c], sk, [])
    expect(c.status).toBe('outdated')
  })

  it('re-anchors artifact comments by text', () => {
    const art: Artifact = { role: 'spec', format: 'superpowers', path: 'docs/spec.md', title: 'Spec', lines: ['# Spec', '', 'the goal moved here'] }
    const c = mkComment({ anchor: { kind: 'artifact', path: 'docs/spec.md', line: 1, lineContent: 'the goal moved here' } })
    reanchorComments([c], mkSkeleton([]), [art])
    expect((c.anchor as { line: number }).line).toBe(3)
    expect(c.status).toBe('queued')
  })

  it('leaves non-positional and resolved comments untouched', () => {
    const sk = mkSkeleton([])
    const sec = mkComment({ id: 's', anchor: { kind: 'section', sectionId: 's1' } })
    const resolved = mkComment({
      id: 'r', status: 'resolved',
      anchor: { kind: 'diff', file: 'src/a.ts', side: 'new', line: 5, hunkRange: '@@', lineContent: 'gone' }
    })
    reanchorComments([sec, resolved], sk, [])
    expect(sec.status).toBe('queued')
    expect(resolved.status).toBe('resolved')
    expect((resolved.anchor as { line: number }).line).toBe(5)
  })
})
