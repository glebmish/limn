import { describe, it, expect } from 'vitest'
import { fileViewed, sectionViewState } from '../src/renderer/store'
import type { FileDiff, ViewMark } from '../src/shared/types'

// minimal FileDiff: the derivation only reads `path` and `hunks[].sinceViewed`.
function file(path: string, sinceViewed = false): FileDiff {
  return { path, hunks: [{ sinceViewed }] } as unknown as FileDiff
}
// legacy-style mark (no content hash) → drift is detected by since-marks alone
const vm = (sha = 's'): ViewMark => ({ sha, hash: '' })

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
