import { describe, it, expect, beforeAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getDiff, workingTreeDiff } from '../src/main/git'

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd: dir, encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 'F', GIT_AUTHOR_EMAIL: 'f@x', GIT_COMMITTER_NAME: 'F', GIT_COMMITTER_EMAIL: 'f@x' }
  }).trim()
}

const UNICODE = 'café déjà.txt' // non-ASCII + space: git C-quotes this by default

let dir: string
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limn-quote-'))
  git(dir, 'init', '-b', 'main')
  fs.writeFileSync(path.join(dir, 'seed.txt'), 'seed\n')
  git(dir, 'add', '-A'); git(dir, 'commit', '-m', 'base')
  git(dir, 'checkout', '-q', '-b', 'feature')
  fs.writeFileSync(path.join(dir, UNICODE), 'hello\n')
  git(dir, 'add', '-A'); git(dir, 'commit', '-m', 'add unicode file')
})

describe('diff path decoding (core.quotePath)', () => {
  it('reports a non-ASCII committed path verbatim, not C-quoted', async () => {
    const sk = await getDiff(dir, 'main', 'feature')
    const paths = sk.files.map((f) => f.path)
    expect(paths).toContain(UNICODE)
    // and never the escaped/quoted form
    expect(paths.some((p) => p.includes('\\') || p.startsWith('"'))).toBe(false)
  })

  it('reports a non-ASCII untracked path verbatim', async () => {
    const name = 'naïve file.md'
    fs.writeFileSync(path.join(dir, name), 'x\n')
    const files = await workingTreeDiff(dir)
    const paths = files.map((f) => f.path)
    fs.rmSync(path.join(dir, name))
    expect(paths).toContain(name)
  })
})
