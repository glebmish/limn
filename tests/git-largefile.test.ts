import { describe, it, expect, beforeAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { workingTreeDiff } from '../src/main/git'

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd: dir, encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 'F', GIT_AUTHOR_EMAIL: 'f@x', GIT_COMMITTER_NAME: 'F', GIT_COMMITTER_EMAIL: 'f@x' }
  }).trim()
}

let dir: string
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limn-big-'))
  git(dir, 'init', '-b', 'main')
  fs.writeFileSync(path.join(dir, 'seed.txt'), 'seed\n')
  git(dir, 'add', '-A'); git(dir, 'commit', '-m', 'base')
})

describe('workingTreeDiff: large untracked files', () => {
  it('does not inline an oversized untracked text file (avoids reading it whole)', async () => {
    // 5 MiB of text — well past any sane inline cap. The old code read the entire
    // file into a utf8 string and split it into lines (OOM risk on the main process).
    const big = 'a'.repeat(5 * 1024 * 1024) + '\n'
    fs.writeFileSync(path.join(dir, 'big.txt'), big)

    const files = await workingTreeDiff(dir)
    const entry = files.find((f) => f.path === 'big.txt')
    fs.rmSync(path.join(dir, 'big.txt'))

    expect(entry).toBeTruthy()
    expect(entry!.binary).toBe(true) // shown as a non-inlined (too-large) blob
    expect(entry!.hunks).toHaveLength(0)
    expect(entry!.add).toBe(0)
  })

  it('still inlines a small untracked text file', async () => {
    fs.writeFileSync(path.join(dir, 'small.txt'), 'one\ntwo\n')
    const files = await workingTreeDiff(dir)
    const entry = files.find((f) => f.path === 'small.txt')
    fs.rmSync(path.join(dir, 'small.txt'))

    expect(entry).toBeTruthy()
    expect(entry!.binary).toBe(false)
    expect(entry!.add).toBe(2)
  })
})
