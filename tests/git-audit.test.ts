import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fixtureGit as git } from './helpers/fixtureRepo'
import { defaultBase, getDiff, listBranches, workingTreeDiff } from '../src/server/git'

// A throwaway repo we can point hostile git config at. The app must read the same
// diffs no matter what the end user's ~/.gitconfig (or the repo's own config) says.
let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limn-audit-'))
  git(dir, 'init', '-b', 'main')
  git(dir, 'config', 'user.name', 'Fixture')
  git(dir, 'config', 'user.email', 'fix@test')
  fs.mkdirSync(path.join(dir, 'src'))
  fs.mkdirSync(path.join(dir, 'b'))
  fs.writeFileSync(path.join(dir, 'src/a.ts'), 'one\ntwo\n')
  fs.writeFileSync(path.join(dir, 'b/keep.ts'), 'x\n')
  fs.writeFileSync(path.join(dir, 'mode.sh'), 'echo hi\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-m', 'base')
  git(dir, 'checkout', '-q', '-b', 'feature')
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('diff prefixes are pinned against user git config', () => {
  it('reads working-tree paths verbatim under diff.mnemonicPrefix', async () => {
    // mnemonicPrefix rewrites the working-tree diff's a//b/ to c//w/
    git(dir, 'config', 'diff.mnemonicPrefix', 'true')
    fs.writeFileSync(path.join(dir, 'src/a.ts'), 'one\ntwo\nthree\n')
    const files = await workingTreeDiff(dir)
    expect(files.map((f) => f.path)).toEqual(['src/a.ts'])
  })

  it('reads committed paths verbatim under diff.noprefix', async () => {
    // noprefix strips a//b/ entirely; a path that itself starts with `b/` would then
    // lose its first segment to the parser's blind prefix strip.
    git(dir, 'config', 'diff.noprefix', 'true')
    fs.writeFileSync(path.join(dir, 'b/keep.ts'), 'x\ny\n')
    git(dir, 'add', '-A')
    git(dir, 'commit', '-m', 'edit b/keep.ts')
    const sk = await getDiff(dir, 'main', 'feature')
    expect(sk.files.map((f) => f.path)).toEqual(['b/keep.ts'])
  })

  it('still renders a mode-only change under diff.noprefix', async () => {
    // a chmod carries no ---/+++ headers, so the path comes from the `diff --git`
    // header — which noprefix reshapes into a bare `<path> <path>`.
    git(dir, 'config', 'diff.noprefix', 'true')
    fs.chmodSync(path.join(dir, 'mode.sh'), 0o755)
    git(dir, 'add', '-A')
    git(dir, 'commit', '-m', 'chmod +x')
    const sk = await getDiff(dir, 'main', 'feature')
    expect(sk.files.map((f) => f.path)).toEqual(['mode.sh'])
    expect(sk.files[0].modeChange).toEqual({ from: '100644', to: '100755' })
  })
})

describe('listBranches on a detached HEAD', () => {
  it('omits git\'s "(HEAD detached at …)" pseudo-entry', async () => {
    git(dir, 'checkout', '-q', '--detach')
    expect(await listBranches(dir)).toEqual(['feature', 'main'])
  })

  it('keeps defaultBase off the pseudo-entry when there is no main/master', async () => {
    git(dir, 'checkout', '-q', '--detach')
    git(dir, 'branch', '-D', 'feature')
    git(dir, 'branch', '-m', 'main', 'trunk')
    expect(await defaultBase(dir)).toBe('trunk')
  })
})
