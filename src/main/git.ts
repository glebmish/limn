import fs from 'node:fs'
import nodePath from 'node:path'
import { execGit } from './exec.js'
import { tagOrigins } from './mergeDiff.js'
import type { CommitInfo, DiffLine, DiffSkeleton, DriftSummary, FileDiff, Hunk, RefKind, RefLoc, RefSide, WorktreeInfo } from '../shared/types.js'

export async function listBranches(dir: string): Promise<string[]> {
  const out = await execGit(dir, ['branch', '--format=%(refname:short)'])
  return out.split('\n').map((s) => s.trim()).filter(Boolean)
}

export async function currentBranch(dir: string): Promise<string> {
  return (await execGit(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
}

export async function defaultBase(dir: string): Promise<string> {
  const branches = await listBranches(dir)
  if (branches.includes('main')) return 'main'
  if (branches.includes('master')) return 'master'
  return branches[0] ?? 'HEAD'
}

export async function mergeBase(dir: string, base: string, branch: string): Promise<string> {
  return (await execGit(dir, ['merge-base', base, branch])).trim()
}

export async function headSha(dir: string, ref = 'HEAD'): Promise<string> {
  return (await execGit(dir, ['rev-parse', ref])).trim()
}

export async function isDirty(dir: string): Promise<boolean> {
  return (await execGit(dir, ['status', '--porcelain'])).trim().length > 0
}

/** Number of changed (staged + unstaged + untracked) paths in the working tree. */
export async function dirtyCount(dir: string): Promise<number> {
  return (await execGit(dir, ['status', '--porcelain'])).split('\n').filter((l) => l.trim().length > 0).length
}

/** What landed on `branch` since `sinceSha`: the count of new commits, and the
 *  file/line delta from `sinceSha` to the working tree of `workdir` (committed +
 *  uncommitted). When the branch is checked out nowhere pass `workdir` null — the
 *  delta then falls back to committed-only (`sinceSha..branch`) and uncommitted edits
 *  are invisible. Untracked files are excluded (numstat). Backs the fetch pill. */
export async function driftSummary(repo: string, branch: string, sinceSha: string, workdir: string | null): Promise<DriftSummary> {
  const head = await headSha(repo, branch)
  const commits = Number((await execGit(repo, ['rev-list', '--count', `${sinceSha}..${branch}`])).trim()) || 0
  // numstat lines: `<add>\t<del>\t<path>` — binary files report `-`/`-` (→ 0 here).
  const numstat = workdir
    ? await execGit(workdir, ['diff', '--numstat', sinceSha])               // sinceSha → working tree (incl. dirty)
    : await execGit(repo, ['diff', '--numstat', `${sinceSha}..${branch}`])  // committed-only
  let files = 0, add = 0, del = 0
  for (const line of numstat.split('\n')) {
    if (!line.trim()) continue
    files++
    const [a, d] = line.split('\t')
    add += Number(a) || 0
    del += Number(d) || 0
  }
  // `dirty` distinguishes the working-tree-edit chip from the commit chip in the pill.
  const dirty = workdir ? await isDirty(workdir) : false
  return { headSha: head, commits, files, add, del, dirty }
}

/** Parse `git worktree list --porcelain`. The first entry is the primary
 *  worktree (the repo's main checkout). `branch` is null for a detached HEAD. */
export async function listWorktrees(dir: string): Promise<WorktreeInfo[]> {
  const out = await execGit(dir, ['worktree', 'list', '--porcelain'])
  const trees: WorktreeInfo[] = []
  let cur: Partial<WorktreeInfo> | null = null
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (cur?.path) trees.push({ path: cur.path, branch: cur.branch ?? null, head: cur.head ?? '', primary: false, locked: cur.locked ?? false })
      cur = { path: line.slice('worktree '.length).trim() }
    } else if (cur) {
      if (line.startsWith('HEAD ')) cur.head = line.slice('HEAD '.length).trim()
      else if (line.startsWith('branch ')) cur.branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '')
      else if (line === 'detached') cur.branch = null
      else if (line.startsWith('locked')) cur.locked = true
    }
  }
  if (cur?.path) trees.push({ path: cur.path, branch: cur.branch ?? null, head: cur.head ?? '', primary: false, locked: cur.locked ?? false })
  if (trees[0]) trees[0].primary = true
  return trees
}

/** The worktree (path) where `branch` is currently checked out, or null. A branch
 *  can be checked out in at most one worktree at a time. */
export async function branchCheckedOutAt(dir: string, branch: string): Promise<string | null> {
  const trees = await listWorktrees(dir)
  return trees.find((w) => w.branch === branch)?.path ?? null
}

/** Check out `branch` in `dir`. Refuses on a dirty tree — the caller surfaces the
 *  "commit or stash first" message. Throws git's own error otherwise (e.g. the
 *  branch is already checked out in another worktree). */
export async function checkoutBranch(dir: string, branch: string): Promise<void> {
  assertSafeRef(branch) // a client-supplied branch reaches here as a positional git operand
  if (await isDirty(dir)) {
    const n = await dirtyCount(dir)
    throw new Error(`Working tree has ${n} uncommitted change${n === 1 ? '' : 's'} — commit or stash first.`)
  }
  await execGit(dir, ['checkout', branch])
}

/** Create a linked worktree at `dir` checked out on `branch`. `branch` must exist
 *  and not already be checked out in another worktree (git enforces both, throwing
 *  its own message). The new worktree dir must not already exist. */
export async function addWorktree(repo: string, branch: string, dir: string): Promise<void> {
  assertSafeRef(branch) // positional git operand; guard against a leading-dash "option" ref
  await execGit(repo, ['worktree', 'add', dir, branch])
}

/** Working-tree diff against an arbitrary ref, with untracked files synthesized as
 *  fully-added files (so brand-new work shows) without mutating the index. */
async function workingTreeDiffFrom(dir: string, fromRef: string): Promise<FileDiff[]> {
  const raw = await execGit(dir, ['diff', ...DIFF_ARGS, fromRef])
  const files = parseUnifiedDiff(raw)
  const untracked = (await execGit(dir, ['ls-files', '--others', '--exclude-standard']))
    .split('\n').map((s) => s.trim()).filter(Boolean)
  for (const path of untracked) {
    const file = await syntheticAddedFile(dir, path)
    if (file) files.push(file)
  }
  return files
}

/** Uncommitted changes (staged + unstaged) of the working tree against HEAD —
 *  the "volatile band". */
export async function workingTreeDiff(dir: string): Promise<FileDiff[]> {
  return workingTreeDiffFrom(dir, 'HEAD')
}

/** The base→working-tree diff with each changed line attributed to the committed
 *  delta (base→HEAD) or the uncommitted delta (HEAD→working-tree). git produces the
 *  merged hunks; `tagOrigins` labels each line via an exact line-number join against
 *  the committed (skeleton) and dirty (volatile) diffs that share HEAD as pivot. */
export async function mergedWorkingDiff(dir: string, base: string, branch: string): Promise<FileDiff[]> {
  const mb = await mergeBase(dir, base, branch).catch(() => EMPTY_TREE) // no common history → empty tree
  const merged = await workingTreeDiffFrom(dir, mb)
  const skeleton = parseUnifiedDiff(await execGit(dir, ['diff', ...DIFF_ARGS, mb, await headSha(dir, branch)]))
  const volatile = await workingTreeDiff(dir)
  tagOrigins(merged, skeleton, volatile)
  return merged
}

/** Largest untracked file we inline into a diff. Past this we render it as a
 *  non-inlined blob (like a binary) rather than read it whole into the main
 *  process — a big stray file (dataset, log, build artifact) would otherwise
 *  risk OOM. */
const MAX_INLINE_BYTES = 2 * 1024 * 1024

/** A new untracked file rendered as an all-additions FileDiff. Binary, oversized,
 *  or unreadable files get an empty hunk list, like the parser produces for
 *  `Binary files … differ`. */
async function syntheticAddedFile(dir: string, path: string): Promise<FileDiff | null> {
  const abs = nodePath.join(dir, path)
  let stat: fs.Stats
  try { stat = fs.statSync(abs) } catch { return null } // gone or unreadable
  if (!stat.isFile()) return null
  if (stat.size > MAX_INLINE_BYTES) return { path, status: 'added', binary: true, add: 0, del: 0, hunks: [] }
  let content: string
  try { content = fs.readFileSync(abs, 'utf8') }
  catch { return null } // gone, unreadable, or binary read failure
  if (content.includes(' ')) return { path, status: 'added', binary: true, add: 0, del: 0, hunks: [] }
  const lines = content.split('\n')
  if (lines[lines.length - 1] === '') lines.pop() // trailing newline → drop the empty tail
  return {
    path, status: 'added', binary: false, add: lines.length, del: 0,
    hunks: [{ range: `@@ -0,0 +1,${lines.length} @@`, header: '', lines: lines.map((text, i) => ({ old: null, new: i + 1, kind: 'add' as const, text })) }]
  }
}

/** Content hash (git blob sha) of each given path as it currently is on disk, keyed
 *  by path. Missing paths (e.g. deleted files) are skipped. The `--` guards filenames
 *  that look like options. This is the "did the file change since viewed" key. */
export async function hashObjects(dir: string, paths: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const existing = paths.filter((p) => {
    try { return fs.statSync(nodePath.join(dir, p)).isFile() } catch { return false }
  })
  if (existing.length === 0) return out
  const raw = await execGit(dir, ['hash-object', '--', ...existing])
  const shas = raw.split('\n').map((s) => s.trim()).filter(Boolean)
  existing.forEach((p, i) => { if (shas[i]) out.set(p, shas[i]) })
  return out
}

/** Assemble the live git state a repo's hub + review header read. */
export async function repoState(dir: string): Promise<import('../shared/types.js').RepoState> {
  const [branches, current, base, worktrees, n] = await Promise.all([
    listBranches(dir), currentBranch(dir), defaultBase(dir), listWorktrees(dir), dirtyCount(dir)
  ])
  // per-worktree dirtiness powers the checkout picker (greys dirty targets); cheap
  // since worktrees are few, and kept here rather than in the hot listWorktrees path.
  await Promise.all(worktrees.map(async (w) => { w.dirty = await isDirty(w.path) }))
  return { path: dir, branches, current, defaultBase: base, dirty: n > 0, dirtyCount: n, worktrees }
}

export async function log(dir: string, base: string, branch: string): Promise<CommitInfo[]> {
  const out = await execGit(dir, ['log', '--format=%H%x00%s%x00%an%x00%aI', `${base}..${branch}`])
  return out.split('\n').filter(Boolean).map((line) => {
    const [sha, subject, author, date] = line.split('\0')
    return { sha, subject, author, date }
  })
}

/** Recover the path from a `diff --git ` header remainder (`lines[0]`, the
 *  `a/<old> b/<new>` the chunk split left behind) — the fallback for mode-only
 *  changes that carry no ---/+++ headers. Such changes never rename, so both
 *  sides name the same path; anchoring on that resolves the space-ambiguity, and
 *  the quoted (`"a/x" "b/x"`) form is handled for paths git still C-quotes. */
function pathFromDiffHeader(line: string): string | undefined {
  return line.match(/^"a\/(.+)" "b\/\1"$/)?.[1] ?? line.match(/^a\/(.+) b\/\1$/)?.[1]
}

/** Parse `git diff` unified output into FileDiff[]. */
export function parseUnifiedDiff(raw: string): FileDiff[] {
  const files: FileDiff[] = []
  // split into per-file chunks
  const chunks = raw.split(/^diff --git /m).filter((c) => c.trim().length > 0)
  for (const chunk of chunks) {
    const lines = chunk.split('\n')
    let oldPath: string | undefined
    let newPath: string | undefined
    let status: FileDiff['status'] = 'modified'
    let binary = false
    const hunks: Hunk[] = []
    let cur: Hunk | null = null
    let oldNo = 0
    let newNo = 0

    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i]
      if (i === 0) {
        // "a/<old> b/<new>" — paths may contain spaces; use --- / +++ lines as authority when present
        continue
      }
      if (ln.startsWith('--- ')) {
        const p = ln.slice(4).trim()
        if (p !== '/dev/null') oldPath = p.replace(/^a\//, '')
      } else if (ln.startsWith('+++ ')) {
        const p = ln.slice(4).trim()
        if (p !== '/dev/null') newPath = p.replace(/^b\//, '')
      } else if (ln.startsWith('rename from ')) {
        oldPath = ln.slice('rename from '.length).trim()
        status = 'renamed'
      } else if (ln.startsWith('rename to ')) {
        newPath = ln.slice('rename to '.length).trim()
        status = 'renamed'
      } else if (ln.startsWith('new file mode')) {
        status = 'added'
      } else if (ln.startsWith('deleted file mode')) {
        status = 'deleted'
      } else if (ln.startsWith('Binary files ')) {
        binary = true
        // "Binary files a/x and b/x differ" — recover path if not set
        const m = ln.match(/^Binary files (?:a\/(.+?)|\/dev\/null) and (?:b\/(.+?)|\/dev\/null) differ/)
        if (m) {
          oldPath = oldPath ?? m[1]
          newPath = newPath ?? m[2]
        }
      } else if (ln.startsWith('@@')) {
        const m = ln.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/)
        if (!m) continue
        oldNo = parseInt(m[1], 10)
        newNo = parseInt(m[2], 10)
        cur = { range: ln.match(/^(@@[^@]*@@)/)![1], header: m[3] ?? '', lines: [] }
        hunks.push(cur)
      } else if (cur) {
        if (ln.startsWith('\\')) continue // "\ No newline at end of file"
        if (ln.startsWith('+')) {
          cur.lines.push({ old: null, new: newNo++, kind: 'add', text: ln.slice(1) })
        } else if (ln.startsWith('-')) {
          cur.lines.push({ old: oldNo++, new: null, kind: 'del', text: ln.slice(1) })
        } else if (ln.startsWith(' ')) {
          cur.lines.push({ old: oldNo++, new: newNo++, kind: '', text: ln.slice(1) })
        }
        // anything else (e.g. trailing empty string from split) is ignored
      }
    }

    // mode-only (chmod) changes emit no ---/+++ headers, no hunks — recover the path
    // from the `diff --git a/<x> b/<x>` header (lines[0]) so the file still renders.
    const path = newPath ?? oldPath ?? pathFromDiffHeader(lines[0])
    if (!path) continue
    const file: FileDiff = {
      path,
      status,
      binary,
      add: 0,
      del: 0,
      hunks: binary ? [] : hunks
    }
    if (status === 'renamed' && oldPath && oldPath !== path) file.oldPath = oldPath
    for (const h of file.hunks) {
      for (const l of h.lines) {
        if (l.kind === 'add') file.add++
        else if (l.kind === 'del') file.del++
      }
    }
    files.push(file)
  }
  return files
}

const DIFF_ARGS = ['--no-color', '--no-ext-diff', '-U3', '-M']

/** git's empty-tree object: the diff base when two sides share NO common ancestor
 *  (unrelated roots, a grafted/imported branch) — `merge-base` exits non-zero there,
 *  so we fall back to this and the review renders as a full-add diff. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

export async function getDiff(dir: string, base: string, branch: string): Promise<DiffSkeleton> {
  const mb = await mergeBase(dir, base, branch).catch(() => EMPTY_TREE) // no common history → empty tree
  const tip = await headSha(dir, branch)
  const raw = await execGit(dir, ['diff', ...DIFF_ARGS, mb, tip])
  return { base, branch, mergeBase: mb, headSha: tip, files: parseUnifiedDiff(raw) }
}

/** baseline→working-tree diff (untracked synthesized) — the working-tree analogue
 *  of `diffSince`, used to carry the since/viewed rails onto the merged
 *  base→working-tree view, whose new-side line numbers live in worktree space. */
export async function diffSinceWorking(dir: string, sinceSha: string): Promise<FileDiff[]> {
  return workingTreeDiffFrom(dir, sinceSha)
}

/** Diff of the branch tip against an earlier sha on the branch (for "since approved"). */
export async function diffSince(dir: string, sinceSha: string, branch: string): Promise<DiffSkeleton> {
  const tip = await headSha(dir, branch)
  const raw = await execGit(dir, ['diff', ...DIFF_ARGS, sinceSha, tip])
  return { base: sinceSha, branch, mergeBase: sinceSha, headSha: tip, files: parseUnifiedDiff(raw) }
}

/** Tag hunks/lines in `full` that overlap changes present in `since` (mutates `full`).
 *  `key` selects which flag to set; `onlyPaths` restricts tagging to those files. */
export function markSince(full: DiffSkeleton, since: DiffSkeleton, key: 'since' | 'sinceViewed' = 'since', onlyPaths?: Set<string>): void {
  const sinceByPath = new Map(since.files.map((f) => [f.path, f]))
  for (const file of full.files) {
    if (onlyPaths && !onlyPaths.has(file.path)) continue
    const sf = sinceByPath.get(file.path)
    if (!sf) continue
    const changedNew = new Set<number>()
    const changedTexts = new Set<string>()
    for (const h of sf.hunks) {
      for (const l of h.lines) {
        if (l.kind === 'add' && l.new != null) {
          changedNew.add(l.new)
          changedTexts.add(l.text)
        }
        if (l.kind === 'del') changedTexts.add(l.text)
      }
    }
    for (const h of file.hunks) {
      let any = false
      for (const l of h.lines) {
        const hit =
          (l.kind === 'add' && l.new != null && changedNew.has(l.new) && changedTexts.has(l.text)) ||
          (l.kind === 'del' && changedTexts.has(l.text) && sf.hunks.length > 0 && lineNearSince(l, sf))
        if (hit) {
          l[key] = true
          any = true
        }
      }
      if (any) h[key] = true
    }
    if (file.hunks.length === 0 && (sf.binary || sf.hunks.length > 0)) {
      // binary file changed since — nothing line-level to tag
    }
  }
}

function lineNearSince(l: DiffLine, sf: FileDiff): boolean {
  // deletions have no new-line number; consider them "since" when their text
  // appears as a deletion in the since diff
  return sf.hunks.some((h) => h.lines.some((x) => x.kind === 'del' && x.text === l.text))
}

export interface ResolvedRef { kind: RefKind; symbol: string; sha: string }

/** Reject a ref that git would parse as an option (leading dash) — argument
 *  injection guard for user-typed ref input passed as a positional git operand. */
export function assertSafeRef(ref: string): void {
  if (/^-/.test(ref.trim())) throw new Error(`invalid ref (looks like an option): ${ref}`)
}

/** Classify user ref input: exact local branch name → live branch side;
 *  anything else git can resolve to a commit (sha, HEAD~N, tag) → frozen commit side. */
export async function resolveRefInput(dir: string, input: string): Promise<ResolvedRef> {
  const ref = input.trim()
  if (!ref) throw new Error('not a branch or commit: (empty)')
  assertSafeRef(ref)
  const branches = await listBranches(dir)
  if (branches.includes(ref)) return { kind: 'branch', symbol: ref, sha: await headSha(dir, ref) }
  try {
    const sha = (await execGit(dir, ['rev-parse', '--verify', `${ref}^{commit}`])).trim()
    return { kind: 'commit', symbol: ref, sha }
  } catch {
    throw new Error(`not a branch or commit: ${input}`)
  }
}

/** Last `limit` commits reachable from `ref`, newest first (for the ref picker). */
export async function recentCommits(dir: string, ref: string, limit: number): Promise<CommitInfo[]> {
  assertSafeRef(ref)
  const out = await execGit(dir, ['log', '--format=%H%x00%s%x00%an%x00%aI', '-n', String(limit), ref])
  return out.split('\n').filter(Boolean).map((line) => {
    const [sha, subject, author, date] = line.split('\0')
    return { sha, subject, author, date }
  })
}

/** Top-level directory of the git repo enclosing `dir`, or null if `dir` is
 *  not inside a git repository. */
export async function repoRoot(dir: string): Promise<string | null> {
  try {
    return (await execGit(dir, ['rev-parse', '--show-toplevel'])).trim()
  } catch {
    return null
  }
}

export async function aheadCount(dir: string, from: string, to: string): Promise<number> {
  return parseInt((await execGit(dir, ['rev-list', '--count', `${from}..${to}`])).trim(), 10)
}

export async function commitSubject(dir: string, sha: string): Promise<string> {
  return (await execGit(dir, ['show', '-s', '--format=%s', sha])).trim()
}

export async function branchesContaining(dir: string, sha: string): Promise<string[]> {
  const out = await execGit(dir, ['branch', '--format=%(refname:short)', '--contains', sha])
  return out.split('\n').map((s) => s.trim()).filter((s) => Boolean(s) && !s.startsWith('('))
}

/** Human context line for one session side (spec: precision underneath,
 *  friendliness on top — commit sides are never shown as bare shas). */
export async function describeSide(dir: string, side: RefSide): Promise<string> {
  if (side.kind === 'branch') {
    let drift = 0
    try {
      const tip = await headSha(dir, side.symbol)
      if (tip !== side.anchorSha && side.anchorSha) drift = await aheadCount(dir, side.anchorSha, tip)
    } catch {
      return `${side.symbol} — branch missing`
    }
    return drift > 0
      ? `${side.symbol} — branch tip, follows new commits (anchor ${side.anchorSha.slice(0, 7)}, +${drift} since)`
      : `${side.symbol} — branch tip`
  }
  const short = side.anchorSha.slice(0, 7)
  try {
    const subject = await commitSubject(dir, side.anchorSha)
    const containing = await branchesContaining(dir, side.anchorSha)
    const cur = await currentBranch(dir)
    const branch = containing.includes(cur) ? cur : containing[0]
    if (!branch) return `${short} "${subject}"`
    const behind = await aheadCount(dir, side.anchorSha, branch)
    return behind > 0
      ? `${short} "${subject}" — on ${branch}, ${behind} behind tip`
      : `${short} "${subject}" — on ${branch}, at tip`
  } catch {
    return `${short} — commit missing`
  }
}

/** Structured locator for a session side (the header chip "branch ~n sha"):
 *  which branch the ref lives on and how far behind that branch's HEAD it sits.
 *  A branch side is its own tip (behind 0); a commit side is resolved to the
 *  branch that contains it (current branch preferred) and counted from its tip. */
export async function locateSide(dir: string, side: RefSide): Promise<RefLoc> {
  if (side.kind === 'branch') {
    try {
      return { kind: 'branch', onBranch: side.symbol, behind: 0, sha: await headSha(dir, side.symbol) }
    } catch {
      return { kind: 'branch', onBranch: side.symbol, behind: 0, sha: side.anchorSha }
    }
  }
  const sha = side.anchorSha
  try {
    const containing = await branchesContaining(dir, sha)
    if (containing.length === 0) return { kind: 'commit', onBranch: null, behind: 0, sha }
    // Attribute the commit to the containing branch whose tip it sits CLOSEST to —
    // the branch it most specifically belongs to. Branches that merely inherited it
    // (e.g. a feature built on top) sit farther back, so they lose. This makes a main
    // commit read as "main ~n" even while a descendant branch is checked out.
    let onBranch = containing[0]
    let behind = await aheadCount(dir, sha, onBranch)
    for (const b of containing.slice(1)) {
      const n = await aheadCount(dir, sha, b)
      if (n < behind) { onBranch = b; behind = n }
    }
    return { kind: 'commit', onBranch, behind, sha }
  } catch {
    return { kind: 'commit', onBranch: null, behind: 0, sha }
  }
}
