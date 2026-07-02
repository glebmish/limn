import { describe, it, expect, beforeAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { makeFixtureRepo, type FixtureRepo, fixtureGit, fixtureWrite } from './helpers/fixtureRepo'
import { blobShaAt, catBlob, showFile, hashObjectsWrite, diffContents, renameMap, hashObjects } from '../src/main/git'
import { execGitDiff } from '../src/main/exec'

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
