import { describe, it, expect } from 'vitest'
import { fileViewed, sectionDisclosureState, sectionViewState } from '../src/renderer/store'
import { doneSectionIds } from '../src/renderer/store/derive'
import type { FileDiff, Section, ViewMark } from '../src/shared/types'

// minimal FileDiff: the derivation reads `path`, `fileHash`, and `hunks[].sinceViewed`.
function file(path: string, sinceViewed = false): FileDiff {
  return { path, fileHash: 'h', hunks: [{ sinceViewed }] } as unknown as FileDiff
}
// a viewed mark snapshots the file's content hash; matching it keeps the file viewed.
const vm = (sha = 's'): ViewMark => ({ sha, hash: 'h' })

describe('fileViewed', () => {
  it('is true only when marked and unchanged since', () => {
    expect(fileViewed(file('a.ts'), { 'a.ts': vm() })).toBe(true)
  })
  it('is false without a viewed mark', () => {
    expect(fileViewed(file('a.ts'), {})).toBe(false)
  })
  it('is false when the file changed after being viewed', () => {
    expect(fileViewed(file('a.ts', true), { 'a.ts': vm() })).toBe(false)
  })
  it('stays viewed when the file has no content hash (non-branch compare / hashing skipped)', () => {
    // viewMarkFor stamps '' when fileHash is absent; the read side must use the same
    // convention or the mark reads back as drifted and the tick never sticks.
    const noHash = { path: 'a.ts', hunks: [{ sinceViewed: false }] } as unknown as FileDiff
    expect(fileViewed(noHash, { 'a.ts': { sha: 's', hash: '' } })).toBe(true)
  })
})

describe('sectionViewState (derives section completion from its files)', () => {
  const files = [file('a.ts'), file('b.ts'), file('c.ts')]

  it('is "none" when no files are viewed', () => {
    expect(sectionViewState(files, {})).toBe('none')
  })
  it('is "some" when only part of the files are viewed', () => {
    expect(sectionViewState(files, { 'a.ts': vm(), 'b.ts': vm() })).toBe('some')
  })
  it('is "all" only when every file is viewed', () => {
    expect(sectionViewState(files, { 'a.ts': vm(), 'b.ts': vm(), 'c.ts': vm() })).toBe('all')
  })
  it('drops back to "some" when a viewed file changes (un-views the section)', () => {
    const withDrift = [file('a.ts'), file('b.ts'), file('c.ts', true)]
    expect(sectionViewState(withDrift, { 'a.ts': vm(), 'b.ts': vm(), 'c.ts': vm() })).toBe('some')
  })
  it('is "none" for an empty section', () => {
    expect(sectionViewState([], {})).toBe('none')
  })
})

// #92: this is the memo Review.tsx computes once (on [sections, viewedAt, loaded])
// instead of useReviewScroll's scroll handler recomputing sectionViewState per
// section per scroll frame — pinned at the pure-function level (no DOM needed).
describe('doneSectionIds', () => {
  const section = (id: string, paths: string[]): Section => ({ id, name: id, files: paths, narration: [] })
  const byPath = new Map([file('a.ts'), file('b.ts'), file('c.ts')].map((f) => [f.path, f]))
  const filesFor = (s: Section): FileDiff[] => s.files.map((p) => byPath.get(p)!).filter(Boolean)

  it('collects only the sections whose files are all viewed', () => {
    const sections = [section('s1', ['a.ts']), section('s2', ['b.ts', 'c.ts'])]
    const viewed = { 'a.ts': vm(), 'b.ts': vm() } // s1 done, s2 only partly

    expect(doneSectionIds(sections, filesFor, viewed)).toEqual(new Set(['s1']))
  })

  it('excludes a section with no files (sectionViewState treats it as "none")', () => {
    const sections = [section('empty', [])]

    expect(doneSectionIds(sections, filesFor, {})).toEqual(new Set())
  })

  it('is empty when nothing is viewed, and full when every section is', () => {
    const sections = [section('s1', ['a.ts']), section('s2', ['b.ts'])]

    expect(doneSectionIds(sections, filesFor, {})).toEqual(new Set())
    expect(doneSectionIds(sections, filesFor, { 'a.ts': vm(), 'b.ts': vm() })).toEqual(new Set(['s1', 's2']))
  })
})

describe('sectionDisclosureState', () => {
  const files = [file('a.ts'), file('b.ts')]
  const viewed = { 'a.ts': vm(), 'b.ts': vm() }

  it('opens unviewed sections by default', () => {
    expect(sectionDisclosureState(files, {}, { id: 's1', collapsed: new Set(), expanded: new Set() }).open).toBe(true)
  })

  it('collapses viewed sections by default', () => {
    const state = sectionDisclosureState(files, viewed, { id: 's1', collapsed: new Set(), expanded: new Set() })
    expect(state.done).toBe(true)
    expect(state.open).toBe(false)
    expect(state.amber).toBe(false)
  })

  it('force-opens a viewed section without changing completion', () => {
    const state = sectionDisclosureState(files, viewed, { id: 's1', collapsed: new Set(), expanded: new Set(['s1']) })
    expect(state.done).toBe(true)
    expect(state.open).toBe(true)
  })

  it('honors manual collapse for unviewed sections', () => {
    expect(sectionDisclosureState(files, {}, { id: 's1', collapsed: new Set(['s1']), expanded: new Set() }).open).toBe(false)
  })

  it('resets a completed section when one viewed file changes', () => {
    const changed = [file('a.ts'), file('b.ts', true)]
    const state = sectionDisclosureState(changed, viewed, { id: 's1', collapsed: new Set(), expanded: new Set() })
    expect(state.done).toBe(false)
    expect(state.viewState).toBe('some')
    expect(state.open).toBe(true)
    // a viewed file that drifted is the amber middle ground — the section rolls up
    // amber (changed-since-viewed), matching the file glyph, not plain unviewed.
    expect(state.amber).toBe(true)
  })

  it('is not amber when unviewed files were never looked at (no drift)', () => {
    const state = sectionDisclosureState(files, {}, { id: 's1', collapsed: new Set(), expanded: new Set() })
    expect(state.amber).toBe(false)
  })
})
