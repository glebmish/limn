import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getDiff, parseUnifiedDiff } from '../src/main/git'

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd: dir, encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 'F', GIT_AUTHOR_EMAIL: 'f@x', GIT_COMMITTER_NAME: 'F', GIT_COMMITTER_EMAIL: 'f@x' }
  }).trim()
}

describe('mode-only (chmod) path recovery', () => {
  it('recovers the path of a permission-only change with no ---/+++ headers', () => {
    const raw = ['diff --git a/run.sh b/run.sh', 'old mode 100644', 'new mode 100755', ''].join('\n')
    const files = parseUnifiedDiff(raw)
    expect(files.length).toBe(1)
    expect(files[0]).toMatchObject({ path: 'run.sh', status: 'modified', binary: false, add: 0, del: 0 })
    expect(files[0].hunks.length).toBe(0)
  })

  it('recovers a mode-only path that contains a space', () => {
    const raw = ['diff --git a/my script.sh b/my script.sh', 'old mode 100644', 'new mode 100755', ''].join('\n')
    const files = parseUnifiedDiff(raw)
    expect(files.map((f) => f.path)).toEqual(['my script.sh'])
  })

  it('end-to-end: a real chmod-only change appears in getDiff', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limn-chmod-'))
    git(dir, 'init', '-b', 'main')
    fs.writeFileSync(path.join(dir, 'run.sh'), '#!/bin/sh\necho hi\n')
    git(dir, 'add', '-A'); git(dir, 'commit', '-m', 'base')
    git(dir, 'checkout', '-q', '-b', 'feature')
    git(dir, 'update-index', '--chmod=+x', 'run.sh')
    git(dir, 'commit', '-m', 'make executable')
    const sk = await getDiff(dir, 'main', 'feature')
    const f = sk.files.find((x) => x.path === 'run.sh')
    expect(f).toBeTruthy()
    expect(f!.status).toBe('modified')
    expect(f!.hunks.length).toBe(0)
  })
})

describe('no-merge-base (unrelated histories) fallback', () => {
  it('diffs against the empty tree as a full-add when the sides share no ancestor', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limn-unrelated-'))
    git(dir, 'init', '-b', 'main')
    fs.writeFileSync(path.join(dir, 'main.txt'), 'on main\n')
    git(dir, 'add', '-A'); git(dir, 'commit', '-m', 'main root')
    // an orphan branch has its own root commit — no common ancestor with main
    git(dir, 'checkout', '-q', '--orphan', 'other')
    fs.rmSync(path.join(dir, 'main.txt'))
    fs.writeFileSync(path.join(dir, 'other.txt'), ['alpha', 'beta', ''].join('\n'))
    git(dir, 'add', '-A'); git(dir, 'commit', '-m', 'other root')

    const sk = await getDiff(dir, 'main', 'other')
    expect(sk.mergeBase).toBe('4b825dc642cb6eb9a060e54bf8d69288fbee4904')
    const f = sk.files.find((x) => x.path === 'other.txt')!
    expect(f.status).toBe('added')
    expect(f.add).toBe(2)
    expect(f.del).toBe(0)
  })
})
