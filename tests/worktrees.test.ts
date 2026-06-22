import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeFixtureRepo, type FixtureRepo, fixtureWrite } from './helpers/fixtureRepo'
import {
  listWorktrees, branchCheckedOutAt, checkoutBranch, workingTreeDiff, dirtyCount, repoState
} from '../src/main/git'

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim()
}

let fx: FixtureRepo
let linked: string

beforeAll(() => {
  fx = makeFixtureRepo()
  // make sure the primary tree is clean and on main for predictable switching
  git(fx.dir, 'checkout', '-q', 'main')
  linked = fs.mkdtempSync(path.join(os.tmpdir(), 'limn-wt-'))
  git(fx.dir, 'worktree', 'add', '-q', linked, 'feature')
})

afterAll(() => {
  try { git(fx.dir, 'worktree', 'remove', '--force', linked) } catch { /* best effort */ }
})

describe('worktrees', () => {
  it('lists the primary and linked worktrees with their branches', async () => {
    const trees = await listWorktrees(fx.dir)
    expect(trees.length).toBe(2)
    expect(trees[0].primary).toBe(true)
    expect(trees[0].branch).toBe('main')
    const link = trees.find((w) => !w.primary)
    expect(link?.branch).toBe('feature')
    expect(fs.realpathSync(link!.path)).toBe(fs.realpathSync(linked))
  })

  it('branchCheckedOutAt finds where a branch lives', async () => {
    expect(await branchCheckedOutAt(fx.dir, 'feature')).not.toBeNull()
    expect(await branchCheckedOutAt(fx.dir, 'nope')).toBeNull()
  })

  it('repoState reflects current branch and worktrees', async () => {
    const st = await repoState(fx.dir)
    expect(st.current).toBe('main')
    expect(st.branches).toContain('feature')
    expect(st.worktrees.length).toBe(2)
    expect(st.dirty).toBe(false)
  })
})

describe('checkout guard', () => {
  it('refuses to switch with a dirty tree, succeeds when clean', async () => {
    fixtureWrite(fx.dir, 'wip.txt', 'work in progress')
    expect(await dirtyCount(fx.dir)).toBeGreaterThan(0)
    await expect(checkoutBranch(fx.dir, 'feature')).rejects.toThrow(/uncommitted/)
    fs.rmSync(path.join(fx.dir, 'wip.txt'))
    // 'feature' is checked out in the linked worktree, so switch to a free branch
    git(fx.dir, 'branch', 'spare')
    await checkoutBranch(fx.dir, 'spare')
    expect((await repoState(fx.dir)).current).toBe('spare')
    git(fx.dir, 'checkout', '-q', 'main')
  })
})

describe('volatile band routes to the worktree holding the branch', () => {
  it('reads the linked worktree dirtiness, not the primary tree', async () => {
    // primary is on main and clean; dirty the LINKED worktree (on feature)
    expect(await dirtyCount(fx.dir)).toBe(0)
    fixtureWrite(linked, 'src/b.ts', 'export function b() {\n  return 7777\n}\n')
    fixtureWrite(linked, 'wip-in-worktree.ts', 'export const here = true\n')

    // the workdir for branch `feature` is the linked worktree
    expect(fs.realpathSync((await branchCheckedOutAt(fx.dir, 'feature'))!)).toBe(fs.realpathSync(linked))
    expect(await dirtyCount(fx.dir)).toBe(0)            // primary still clean
    expect(await dirtyCount(linked)).toBeGreaterThan(0) // the branch's tree is dirty

    const vol = await workingTreeDiff(linked)
    const paths = vol.map((f) => f.path)
    expect(paths).toContain('src/b.ts')
    expect(paths).toContain('wip-in-worktree.ts')
    // the primary tree shows none of it
    expect((await workingTreeDiff(fx.dir)).length).toBe(0)

    git(linked, 'checkout', '--', 'src/b.ts')
    fs.rmSync(path.join(linked, 'wip-in-worktree.ts'))
  })
})

describe('working-tree diff (volatile band)', () => {
  it('captures tracked edits and untracked files, ignores the index state', async () => {
    fixtureWrite(fx.dir, 'src/a.ts', 'export function a() {\n  return 999\n}\n')
    fixtureWrite(fx.dir, 'fresh.ts', 'export const brand = "new"\n')
    const files = await workingTreeDiff(fx.dir)
    const paths = files.map((f) => f.path)
    expect(paths).toContain('src/a.ts')      // tracked modification
    expect(paths).toContain('fresh.ts')      // untracked, synthesized as added
    const fresh = files.find((f) => f.path === 'fresh.ts')!
    expect(fresh.status).toBe('added')
    expect(fresh.add).toBeGreaterThan(0)
    // non-mutating: the untracked file is NOT staged by the diff
    const status = git(fx.dir, 'status', '--porcelain', 'fresh.ts')
    expect(status.startsWith('??')).toBe(true)
    // cleanup
    git(fx.dir, 'checkout', '--', 'src/a.ts')
    fs.rmSync(path.join(fx.dir, 'fresh.ts'))
  })
})
