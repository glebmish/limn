import { describe, it, expect, beforeAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { workingTreeDiff } from '../src/server/git'
import { fixtureGit as git } from './helpers/fixtureRepo'

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
