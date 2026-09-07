import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fixtureGit as git } from './helpers/fixtureRepo'
import { catBlob, defaultBase, getDiff, hashObjects, hashObjectsWrite, listBranches, workingTreeDiff } from '../src/server/git'

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

describe('hash-object containment', () => {
  // An artifact anchor's path is client/agent-supplied and reaches hashObjects*
  // verbatim; `git hash-object -w` happily reads and stores a file outside the
  // worktree, and catBlob reads it straight back out again.
  const secret = 'SECRET\nSECOND\nTHIRD\n'

  it('skips a traversal path and stores nothing', async () => {
    const outside = path.join(dir, '..', `limn-outside-${process.pid}.txt`)
    fs.writeFileSync(outside, secret)
    try {
      const rel = path.relative(dir, outside)
      const sha = git(dir, 'hash-object', '--', rel) // computes only — no -w, no write
      expect(await catBlob(dir, sha)).toBeNull()
      expect([...(await hashObjects(dir, [rel])).keys()]).toEqual([])
      expect([...(await hashObjectsWrite(dir, [rel])).keys()]).toEqual([])
      expect(await catBlob(dir, sha)).toBeNull() // still absent from the object store
    } finally {
      fs.rmSync(outside, { force: true })
    }
  })

  it('skips a symlink whose target escapes the worktree', async () => {
    const outside = path.join(dir, '..', `limn-link-target-${process.pid}.txt`)
    fs.writeFileSync(outside, secret)
    try {
      fs.symlinkSync(outside, path.join(dir, 'leak.md'))
      const sha = git(dir, 'hash-object', '--', 'leak.md')
      expect([...(await hashObjects(dir, ['leak.md'])).keys()]).toEqual([])
      expect([...(await hashObjectsWrite(dir, ['leak.md'])).keys()]).toEqual([])
      expect(await catBlob(dir, sha)).toBeNull()
    } finally {
      fs.rmSync(outside, { force: true })
    }
  })

  it('still hashes an ordinary path inside the worktree', async () => {
    expect((await hashObjects(dir, ['src/a.ts'])).get('src/a.ts')).toMatch(/^[0-9a-f]{40}$/)
  })
})

// running as root defeats chmod 000 — the unreadable-file scenario can't be staged
const asUser = (process.getuid?.() ?? 1) !== 0

describe('hash-object partial failures', () => {
  it.runIf(asUser)('one unreadable file costs only itself, not the whole batch', async () => {
    // `git hash-object a b c` aborts (exit 128) at the first operand it can't open —
    // a file deleted in the stat→spawn window, or one the user can't read.
    const locked = path.join(dir, 'locked.txt')
    fs.writeFileSync(locked, 'nope\n')
    fs.chmodSync(locked, 0o000)
    try {
      const map = await hashObjects(dir, ['src/a.ts', 'locked.txt', 'mode.sh'])
      expect(map.get('src/a.ts')).toMatch(/^[0-9a-f]{40}$/)
      expect(map.get('mode.sh')).toMatch(/^[0-9a-f]{40}$/)
      expect(map.has('locked.txt')).toBe(false)
      // the -w flavor degrades the same way
      const written = await hashObjectsWrite(dir, ['src/a.ts', 'locked.txt'])
      expect(written.get('src/a.ts')).toBe(map.get('src/a.ts'))
      expect(written.has('locked.txt')).toBe(false)
    } finally {
      fs.chmodSync(locked, 0o644)
    }
  })
})
