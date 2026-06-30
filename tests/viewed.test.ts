import { describe, it, expect } from 'vitest'
import { fileViewed } from '../src/renderer/store'
import type { FileDiff, ViewMark } from '../src/shared/types'

function file(path: string, fileHash: string, sinceViewed = false): FileDiff {
  return {
    path, status: 'modified', binary: false, add: 1, del: 0, fileHash,
    hunks: [{ range: '@@', header: '', sinceViewed: sinceViewed || undefined, lines: [{ old: null, new: 1, kind: 'add', text: 'x' }] }]
  }
}
const mark = (hash: string, sha = 'HEAD'): ViewMark => ({ sha, hash })

describe('fileViewed with content-hash drift', () => {
  it('viewed when the content hash matches and nothing changed in commits', () => {
    const f = file('a.ts', 'h1')
    expect(fileViewed(f, { 'a.ts': mark('h1') })).toBe(true)
  })

  it('un-viewed when the file content changed (dirty edit, case 3)', () => {
    const f = file('a.ts', 'h2') // current content hash drifted from the viewed snapshot
    expect(fileViewed(f, { 'a.ts': mark('h1') })).toBe(false)
  })

  it('un-viewed when a commit changed the file since viewing (case 1/2)', () => {
    const f = file('a.ts', 'h1', true) // content identical but diffSince marked it
    expect(fileViewed(f, { 'a.ts': mark('h1') })).toBe(false)
  })

  it('stays viewed across an unrelated commit (same content, no since marks)', () => {
    const f = file('a.ts', 'h1') // this file untouched; other files committed
    expect(fileViewed(f, { 'a.ts': mark('h1', 'newhead') })).toBe(true)
  })

  it('not viewed when there is no mark', () => {
    expect(fileViewed(file('a.ts', 'h1'), {})).toBe(false)
  })

  // Re-viewing a drifted file: the user clicks Viewed again, which stamps a fresh
  // mark at the current head. The hunk's `sinceViewed` flag is stale until the next
  // server reload (it was computed against the PRIOR, older mark sha). With the head
  // known, that stale flag must be ignored so the tick reflects the click immediately.
  it('viewed again at head despite stale sinceViewed marks', () => {
    const f = file('a.ts', 'h1', true) // hunks still carry the pre-reload sinceViewed flag
    expect(fileViewed(f, { 'a.ts': mark('h1', 'HEAD') }, 'HEAD')).toBe(true)
  })

  it('still un-viewed when the stale-flag file also drifted in content', () => {
    const f = file('a.ts', 'h2', true) // re-marked at head but content moved on (dirty edit)
    expect(fileViewed(f, { 'a.ts': mark('h1', 'HEAD') }, 'HEAD')).toBe(false)
  })

  it('a commit since viewing still un-views when the mark predates head', () => {
    const f = file('a.ts', 'h1', true)
    expect(fileViewed(f, { 'a.ts': mark('h1', 'oldsha') }, 'HEAD')).toBe(false)
  })
})
