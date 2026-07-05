import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fixtureGit as git, fixtureWrite as write } from './helpers/fixtureRepo'
import { mergeTreeProbe, isMergeTreeUnsupported } from '../src/main/git'

/** Throwaway repo: main has f.txt + g.txt; feature branches off editing f.txt and
 *  adding h.txt; main stays at the merge base and is left checked out. */
function makeMergeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limn-merge-'))
  git(dir, 'init', '-b', 'main')
  // Repo-local identity: the app's own git calls (commit-tree, merge, rebase) don't
  // carry the fixture GIT_AUTHOR_* env — CI runners have no global identity.
  git(dir, 'config', 'user.name', 'Fixture')
  git(dir, 'config', 'user.email', 'fix@test')
  write(dir, 'f.txt', 'base\n')
  write(dir, 'g.txt', 'one\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-m', 'base')
  git(dir, 'checkout', '-q', '-b', 'feature')
  write(dir, 'f.txt', 'feature change\n')
  write(dir, 'h.txt', 'new file\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-m', 'feature work')
  git(dir, 'checkout', '-q', 'main')
  return dir
}

/** main and feature edit f.txt AND x.txt incompatibly — every merge path conflicts. */
function makeConflictRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limn-merge-'))
  git(dir, 'init', '-b', 'main')
  git(dir, 'config', 'user.name', 'Fixture')
  git(dir, 'config', 'user.email', 'fix@test')
  write(dir, 'f.txt', 'base\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-m', 'base')
  git(dir, 'checkout', '-q', '-b', 'feature')
  write(dir, 'f.txt', 'feature side\n')
  write(dir, 'x.txt', 'feature adds\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-m', 'feature edit')
  git(dir, 'checkout', '-q', 'main')
  write(dir, 'f.txt', 'main side\n')
  write(dir, 'x.txt', 'main adds\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-m', 'main edit')
  return dir
}

describe('mergeTreeProbe', () => {
  it('clean when base is an ancestor: treeOid is exactly the branch tree', async () => {
    const dir = makeMergeRepo()
    const probe = await mergeTreeProbe(dir, 'main', 'feature')
    expect(probe.status).toBe('clean')
    expect(probe.treeOid).toBe(git(dir, 'rev-parse', 'feature^{tree}'))
    expect(probe.conflictFiles).toEqual([])
  })

  it('clean three-way when the base moved without overlap', async () => {
    const dir = makeMergeRepo()
    write(dir, 'other.txt', 'main moved\n')
    git(dir, 'add', '-A')
    git(dir, 'commit', '-m', 'main moves')
    const probe = await mergeTreeProbe(dir, 'main', 'feature')
    expect(probe.status).toBe('clean')
    expect(probe.treeOid).toMatch(/^[0-9a-f]{40}$/)
    // base moved → the true 3-way result, NOT the branch tip's tree
    expect(probe.treeOid).not.toBe(git(dir, 'rev-parse', 'feature^{tree}'))
  })

  it('conflict lists the NUL-separated conflicted paths', async () => {
    const dir = makeConflictRepo()
    const probe = await mergeTreeProbe(dir, 'main', 'feature')
    expect(probe.status).toBe('conflict')
    expect(probe.conflictFiles).toEqual(['f.txt', 'x.txt'])  // sorted, NUL-parsed
    expect(probe.treeOid).toBeUndefined()
  })

  it('throws (never a false clean) on an unmergeable ref — exit 1 with empty stdout', async () => {
    const dir = makeMergeRepo()
    await expect(mergeTreeProbe(dir, 'main', 'no-such-branch')).rejects.toThrow(/produced no tree/)
  })
})

describe('isMergeTreeUnsupported', () => {
  it('matches unknown-option and pre-2.38 usage failures, not real merge errors', () => {
    // git ≥ 2.38 rejecting a flag (parse_options), as execGit wraps it:
    expect(isMergeTreeUnsupported("git merge-tree --write-tree --name-only -z main feature failed: error: unknown option `write-tree'")).toBe(true)
    // pre-2.38 merge-tree took three positional trees and printed usage:
    expect(isMergeTreeUnsupported('git merge-tree --write-tree --name-only -z main feature failed: usage: git merge-tree <base-tree> <branch1> <branch2>')).toBe(true)
    expect(isMergeTreeUnsupported('git merge-tree --write-tree --name-only -z main feature failed: fatal: not a git repository')).toBe(false)
  })
})
