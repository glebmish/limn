import { execGit } from './exec.js'
import type { CommitInfo, DiffLine, DiffSkeleton, FileDiff, Hunk } from '../shared/types.js'

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

export async function log(dir: string, base: string, branch: string): Promise<CommitInfo[]> {
  const out = await execGit(dir, ['log', '--format=%H%x00%s%x00%an%x00%aI', `${base}..${branch}`])
  return out.split('\n').filter(Boolean).map((line) => {
    const [sha, subject, author, date] = line.split('\0')
    return { sha, subject, author, date }
  })
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

    const path = newPath ?? oldPath
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

export async function getDiff(dir: string, base: string, branch: string): Promise<DiffSkeleton> {
  const mb = await mergeBase(dir, base, branch)
  const tip = await headSha(dir, branch)
  const raw = await execGit(dir, ['diff', ...DIFF_ARGS, mb, tip])
  return { base, branch, mergeBase: mb, headSha: tip, files: parseUnifiedDiff(raw) }
}

/** Diff of the branch tip against an earlier sha on the branch (for "since approved"). */
export async function diffSince(dir: string, sinceSha: string, branch: string): Promise<DiffSkeleton> {
  const tip = await headSha(dir, branch)
  const raw = await execGit(dir, ['diff', ...DIFF_ARGS, sinceSha, tip])
  return { base: sinceSha, branch, mergeBase: sinceSha, headSha: tip, files: parseUnifiedDiff(raw) }
}

/** Tag hunks/lines in `full` that overlap changes present in `since` (mutates `full`). */
export function markSince(full: DiffSkeleton, since: DiffSkeleton): void {
  const sinceByPath = new Map(since.files.map((f) => [f.path, f]))
  for (const file of full.files) {
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
          l.since = true
          any = true
        }
      }
      if (any) h.since = true
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
