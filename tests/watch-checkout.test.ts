import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { makeFixtureRepo } from './helpers/fixtureRepo'
import { watchState } from '../src/main/ipc'

describe('watchState notices checkouts (external worktree add/remove)', () => {
  it('resolves the workdir each call and folds it into the signature', async () => {
    const fx = makeFixtureRepo() // `feature` checked out at fx.dir; `main` nowhere
    const before = await watchState(fx.dir, 'main')
    expect(before.workdir).toBeNull()

    // an EXTERNAL checkout (terminal, not the app): main gets its own worktree
    const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'limn-wt-'))
    fs.rmSync(wt, { recursive: true })
    execFileSync('git', ['worktree', 'add', wt, 'main'], { cwd: fx.dir })

    const after = await watchState(fx.dir, 'main')
    expect(after.workdir).not.toBeNull()
    // the signature must move — this is what makes the poller broadcast a fresh
    // writeCapability so the "isn't checked out" gate clears live (bug 2026-08-08)
    expect(after.sig).not.toBe(before.sig)
  })
})
