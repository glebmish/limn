import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fixtureGit as git, fixtureWrite as write } from './helpers/fixtureRepo'
import {
  mergeTreeProbe, isMergeTreeUnsupported,
  updateRefCas, setRef, commitTree, mergeInWorktree, deleteBranch, removeWorktree, rebaseOnto,
  isDirty, listBranches, listWorktrees, addWorktree
} from '../src/main/git'

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

describe('updateRefCas / setRef', () => {
  it('moves the ref when expectedOldSha matches', async () => {
    const dir = makeMergeRepo()
    const mainHead = git(dir, 'rev-parse', 'main')
    const featureTip = git(dir, 'rev-parse', 'feature')
    await updateRefCas(dir, 'refs/heads/main', featureTip, mainHead)
    expect(git(dir, 'rev-parse', 'main')).toBe(featureTip)
  })

  it('refuses a stale expectedOldSha and leaves the ref untouched', async () => {
    const dir = makeMergeRepo()
    const mainHead = git(dir, 'rev-parse', 'main')
    const featureTip = git(dir, 'rev-parse', 'feature')
    // claim main already sits at featureTip (it does not) — git must fail closed
    await expect(updateRefCas(dir, 'refs/heads/main', featureTip, featureTip)).rejects.toThrow(/update-ref/)
    expect(git(dir, 'rev-parse', 'main')).toBe(mainHead)
  })

  it('setRef plants a keep-ref resolvable by rev-parse', async () => {
    const dir = makeMergeRepo()
    const featureTip = git(dir, 'rev-parse', 'feature')
    await setRef(dir, 'refs/limn/keep/42', featureTip)
    expect(git(dir, 'rev-parse', 'refs/limn/keep/42')).toBe(featureTip)
  })
})

describe('commitTree (plumbing squash/merge)', () => {
  it('squash over the probe treeOid equals a real merge tree', async () => {
    const dir = makeMergeRepo()
    // move main without overlapping feature: probe stays clean but is a true 3-way
    write(dir, 'other.txt', 'main moved\n')
    git(dir, 'add', '-A')
    git(dir, 'commit', '-m', 'main moves')
    const mainHead = git(dir, 'rev-parse', 'main')
    const probe = await mergeTreeProbe(dir, 'main', 'feature')
    expect(probe.status).toBe('clean')
    const sha = await commitTree(dir, probe.treeOid!, [mainHead], 'Squash: feature')
    expect(git(dir, 'rev-parse', `${sha}^{tree}`)).toBe(probe.treeOid)
    expect(git(dir, 'rev-parse', `${sha}^`)).toBe(mainHead)
    // ground truth: a real checked-out merge produces the identical tree
    git(dir, 'checkout', '-q', '-b', 'real', 'main')
    git(dir, 'merge', '--no-ff', '-m', 'real merge', 'feature')
    expect(git(dir, 'rev-parse', 'real^{tree}')).toBe(probe.treeOid)
  })

  it('two parents synthesize a merge commit', async () => {
    const dir = makeMergeRepo()
    const mainHead = git(dir, 'rev-parse', 'main')
    const featureTip = git(dir, 'rev-parse', 'feature')
    const tree = git(dir, 'rev-parse', 'feature^{tree}')
    const sha = await commitTree(dir, tree, [mainHead, featureTip], 'Merge feature')
    const parents = git(dir, 'rev-list', '--parents', '-n1', sha).split(' ').slice(1)
    expect(parents).toEqual([mainHead, featureTip])
  })
})

describe('mergeInWorktree', () => {
  it('ff advances the checked-out base to the branch tip', async () => {
    const dir = makeMergeRepo()  // main checked out, feature strictly ahead
    const mainHead = git(dir, 'rev-parse', 'main')
    const featureTip = git(dir, 'rev-parse', 'feature')
    const newHead = await mergeInWorktree(dir, 'feature', 'ff', mainHead)
    expect(newHead).toBe(featureTip)
    expect(git(dir, 'rev-parse', 'main')).toBe(featureTip)
  })

  it('squash lands one commit whose tree equals the branch tree', async () => {
    const dir = makeMergeRepo()
    const mainHead = git(dir, 'rev-parse', 'main')
    const newHead = await mergeInWorktree(dir, 'feature', 'squash', mainHead, 'feat: squashed')
    expect(git(dir, 'rev-parse', `${newHead}^{tree}`)).toBe(git(dir, 'rev-parse', 'feature^{tree}'))
    expect(git(dir, 'rev-parse', `${newHead}^`)).toBe(mainHead)
    expect(git(dir, 'log', '-1', '--format=%s')).toBe('feat: squashed')
  })

  it('merge creates a two-parent commit', async () => {
    const dir = makeMergeRepo()
    const mainHead = git(dir, 'rev-parse', 'main')
    const featureTip = git(dir, 'rev-parse', 'feature')
    const newHead = await mergeInWorktree(dir, 'feature', 'merge', mainHead, 'Merge feature')
    const parents = git(dir, 'rev-list', '--parents', '-n1', newHead).split(' ').slice(1)
    expect(parents).toEqual([mainHead, featureTip])
  })

  it('a conflicted squash aborts: rejects, HEAD unmoved, tree clean', async () => {
    const dir = makeConflictRepo()
    const mainHead = git(dir, 'rev-parse', 'main')
    await expect(mergeInWorktree(dir, 'feature', 'squash', mainHead, 'boom')).rejects.toThrow()
    expect(git(dir, 'rev-parse', 'main')).toBe(mainHead)
    expect(await isDirty(dir)).toBe(false)
  })

  it('refuses when the checked-out base no longer matches expectHead (CAS analog)', async () => {
    const dir = makeMergeRepo()
    const staleHead = git(dir, 'rev-parse', 'main')
    // the base moves after preflight was gathered
    fs.writeFileSync(path.join(dir, 'z.txt'), 'moved\n')
    git(dir, 'add', '-A')
    git(dir, 'commit', '-m', 'external commit on base')
    const movedHead = git(dir, 'rev-parse', 'main')

    // no-ff would happily merge onto the moved head — the guard must refuse first
    await expect(mergeInWorktree(dir, 'feature', 'merge', staleHead, 'Merge feature')).rejects.toThrow(/moved|expected/i)
    expect(git(dir, 'rev-parse', 'main')).toBe(movedHead) // nothing landed
    expect(await isDirty(dir)).toBe(false)
  })
})

describe('deleteBranch / removeWorktree', () => {
  it('deletes an unmerged branch (-D flavor)', async () => {
    const dir = makeMergeRepo()
    await deleteBranch(dir, 'feature')
    expect(await listBranches(dir)).not.toContain('feature')
  })

  it('removes a clean linked worktree', async () => {
    const dir = makeMergeRepo()
    const wt = path.join(dir, '.worktrees', 'feature')
    await addWorktree(dir, 'feature', wt)
    await removeWorktree(dir, wt)
    // compare by suffix: git prints realpaths (/private/var vs /var on macOS)
    expect((await listWorktrees(dir)).some((w) => w.path.endsWith('.worktrees/feature'))).toBe(false)
    expect(fs.existsSync(wt)).toBe(false)
  })

  it('refuses a dirty worktree (no --force) and leaves it intact', async () => {
    const dir = makeMergeRepo()
    const wt = path.join(dir, '.worktrees', 'feature')
    await addWorktree(dir, 'feature', wt)
    write(wt, 'scratch.txt', 'uncommitted\n')
    await expect(removeWorktree(dir, wt)).rejects.toThrow()
    expect((await listWorktrees(dir)).some((w) => w.path.endsWith('.worktrees/feature'))).toBe(true)
  })
})

describe('rebaseOnto (dependent retarget)', () => {
  it('replays only the dependent commits onto the new base', async () => {
    const dir = makeMergeRepo()
    const featureTip = git(dir, 'rev-parse', 'feature')
    // dep stacks one commit on feature
    git(dir, 'checkout', '-q', '-b', 'dep', 'feature')
    write(dir, 'dep.txt', 'stacked work\n')
    git(dir, 'add', '-A')
    git(dir, 'commit', '-m', 'dep work')
    // land feature on main, as the merge op would (ff)
    git(dir, 'checkout', '-q', 'main')
    git(dir, 'merge', '--ff-only', 'feature')
    const newBaseHead = git(dir, 'rev-parse', 'main')
    const res = await rebaseOnto(dir, newBaseHead, featureTip, 'dep')
    expect(res).toEqual({ ok: true })
    expect(git(dir, 'rev-parse', 'dep^')).toBe(newBaseHead)
    expect(git(dir, 'log', '-1', '--format=%s', 'dep')).toBe('dep work')
  })

  it('a conflicted rebase aborts and leaves the branch and tree untouched', async () => {
    const dir = makeMergeRepo()
    const featureTip = git(dir, 'rev-parse', 'feature')
    // dep re-edits f.txt on top of feature; main edits f.txt incompatibly
    git(dir, 'checkout', '-q', '-b', 'dep', 'feature')
    write(dir, 'f.txt', 'dep version\n')
    git(dir, 'add', '-A')
    git(dir, 'commit', '-m', 'dep edit')
    const depTip = git(dir, 'rev-parse', 'dep')
    git(dir, 'checkout', '-q', 'main')
    write(dir, 'f.txt', 'main version\n')
    git(dir, 'add', '-A')
    git(dir, 'commit', '-m', 'main edit')
    const res = await rebaseOnto(dir, git(dir, 'rev-parse', 'main'), featureTip, 'dep')
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/rebase/)
    expect(git(dir, 'rev-parse', 'dep')).toBe(depTip)   // branch untouched
    expect(await isDirty(dir)).toBe(false)              // tree restored by --abort
  })

  it('when the abort itself fails, the failure is surfaced (not swallowed)', async () => {
    const dir = makeMergeRepo()
    const featureTip = git(dir, 'rev-parse', 'feature')
    git(dir, 'checkout', '-q', '-b', 'dep', 'feature')
    // uncommitted change → `git rebase` refuses to start, so there is no rebase to
    // abort and `rebase --abort` also fails. The recovery-failed branch must report
    // that, not return the bare (empty-catch) conflict message.
    write(dir, 'f.txt', 'dirty\n')
    const res = await rebaseOnto(dir, git(dir, 'rev-parse', 'main'), featureTip, 'dep')
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/rebase --abort.*ALSO failed|may be left mid-rebase/)
  })
})
