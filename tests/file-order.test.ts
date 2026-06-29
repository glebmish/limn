import { describe, expect, it } from 'vitest'
import type { FileDiff } from '../src/shared/types'
import { orderFilesForReview } from '../src/renderer/lib/fileOrder'

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
