import { describe, expect, it } from 'vitest'
import type { FileDiff, Section } from '../src/shared/types'
import { groupByDir, orderFilesForReview, sectionIndex } from '../src/renderer/lib/fileOrder'

function file(path: string): FileDiff {
  return { path, status: 'modified', binary: false, add: 1, del: 0, hunks: [] }
}

describe('orderFilesForReview', () => {
  it('uses the sidebar tree order when no explicit review order exists', () => {
    const files = [
      file('HANDOFF.md'),
      file('src/main/git.ts'),
      file('src/renderer/App.tsx'),
      file('tests/git.test.ts'),
      file('README.md')
    ]

    expect(orderFilesForReview(files).map((f) => f.path)).toEqual([
      'src/main/git.ts',
      'src/renderer/App.tsx',
      'tests/git.test.ts',
      'HANDOFF.md',
      'README.md'
    ])
  })

  it('uses the agent path order when an explicit review order exists', () => {
    const files = [
      file('src/main/git.ts'),
      file('HANDOFF.md'),
      file('tests/git.test.ts'),
      file('README.md')
    ]

    expect(orderFilesForReview(files, [
      'README.md',
      'src/main/git.ts',
      'HANDOFF.md',
      'tests/git.test.ts'
    ]).map((f) => f.path)).toEqual([
      'README.md',
      'src/main/git.ts',
      'HANDOFF.md',
      'tests/git.test.ts'
    ])
  })

  it('drops duplicate and unknown explicit paths without inventing files', () => {
    const files = [file('src/main/git.ts'), file('README.md')]

    expect(orderFilesForReview(files, [
      'README.md',
      'missing.ts',
      'README.md',
      'src/main/git.ts'
    ]).map((f) => f.path)).toEqual([
      'README.md',
      'src/main/git.ts'
    ])
  })
})

describe('groupByDir', () => {
  it('groups duplicate basenames in two dirs into two groups in first-appearance order', () => {
    const files = [file('src/renderer/ipc.ts'), file('src/main/ipc.ts')]

    expect(groupByDir(files).map((g) => ({ dir: g.dir, paths: g.files.map((f) => f.path) }))).toEqual([
      { dir: 'src/renderer/', paths: ['src/renderer/ipc.ts'] },
      { dir: 'src/main/', paths: ['src/main/ipc.ts'] }
    ])
  })

  it('keeps interleaved input grouped by first-appearance order, preserving in-group order', () => {
    const files = [file('a/x.ts'), file('b/y.ts'), file('a/z.ts')]

    expect(groupByDir(files).map((g) => ({ dir: g.dir, paths: g.files.map((f) => f.path) }))).toEqual([
      { dir: 'a/', paths: ['a/x.ts', 'a/z.ts'] },
      { dir: 'b/', paths: ['b/y.ts'] }
    ])
  })

  it('gives root-level files an empty dir', () => {
    const files = [file('README.md')]

    expect(groupByDir(files)).toEqual([{ dir: '', files: [files[0]] }])
  })

  it('does not merge nested dirs', () => {
    const files = [file('src/App.tsx'), file('src/store/index.ts')]

    expect(groupByDir(files).map((g) => g.dir)).toEqual(['src/', 'src/store/'])
  })

  it('returns an empty array for empty input', () => {
    expect(groupByDir([])).toEqual([])
  })
})

describe('sectionIndex', () => {
  function section(id: string, files: string[]): Section {
    return { id, name: id, files, narration: [] }
  }

  it('maps every listed path to its section id', () => {
    const index = sectionIndex([section('s1', ['src/a.ts', 'src/b.ts']), section('s2', ['README.md'])])

    expect(index.get('src/a.ts')).toBe('s1')
    expect(index.get('src/b.ts')).toBe('s1')
    expect(index.get('README.md')).toBe('s2')
  })

  it('gives a path listed in two sections to the first one', () => {
    const index = sectionIndex([section('s1', ['src/a.ts']), section('s2', ['src/a.ts'])])

    expect(index.get('src/a.ts')).toBe('s1')
  })

  it('has no entry for an unsectioned path', () => {
    const index = sectionIndex([section('s1', ['src/a.ts'])])

    expect(index.get('untracked.ts')).toBeUndefined()
  })

  it('is empty for no sections', () => {
    expect(sectionIndex([]).size).toBe(0)
  })
})
