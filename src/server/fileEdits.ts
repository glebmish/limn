import fs from 'node:fs'
import nodePath from 'node:path'
import { execGit } from './exec.js'
import type { ApplyEditResult, FileEdit, WorkingFile } from '../shared/types.js'

/** Largest file we read whole / edit in place — mirrors git.ts MAX_INLINE_BYTES. */
const MAX_EDIT_BYTES = 2 * 1024 * 1024

/** Resolve `rel` inside `workdir`, refusing traversal and symlink escapes (the same
 *  containment rule as artifacts.loadArtifact). Throws on escape; the underlying
 *  realpath throws ENOENT for missing files — callers map that to 'missing'.
 *  Shared with git.ts/anchorStamp.ts: every caller-supplied relative path git or
 *  fs sees goes through here. */
export function containedPath(workdir: string, rel: string): string {
  if (nodePath.isAbsolute(rel)) throw new Error(`absolute path not allowed: ${rel}`)
  const root = fs.realpathSync(workdir)
  const full = nodePath.resolve(root, rel)
  // containment must hold for the *intended* path before dereferencing, so a
  // traversal like ../x fails as an escape rather than as ENOENT
  if (full !== root && !full.startsWith(root + nodePath.sep)) {
    throw new Error(`path escapes worktree: ${rel}`)
  }
  const real = fs.realpathSync(full)
  if (real !== root && !real.startsWith(root + nodePath.sep)) {
    throw new Error(`path escapes worktree: ${rel}`)
  }
  return real
}

/** Current working-tree content of one file, split into lines. */
export function readWorkingFile(workdir: string, rel: string): WorkingFile {
  let real: string
  try {
    real = containedPath(workdir, rel)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ok: false, reason: 'missing' }
    throw err
  }
  let stat: fs.Stats
  try { stat = fs.statSync(real) } catch { return { ok: false, reason: 'missing' } }
  if (!stat.isFile()) return { ok: false, reason: 'missing' }
  if (stat.size > MAX_EDIT_BYTES) return { ok: false, reason: 'too-large' }
  const buf = fs.readFileSync(real)
  const content = buf.toString('utf8')
  // Every byte sequence that is not valid UTF-8 decodes to U+FFFD and would be
  // written back (applyEditToFile writes the joined lines as utf8) as EF BF BD —
  // silently corrupting a latin-1/cp1252 file everywhere, not just in the edited
  // span. Refuse it like a binary. A genuine NUL byte, by contrast, IS valid UTF-8
  // and round-trips, so the check below stays as the binary guard it always was.
  if (!Buffer.from(content, 'utf8').equals(buf)) return { ok: false, reason: 'binary' }
  if (content.includes('\0')) return { ok: false, reason: 'binary' }
  const lines = content.split('\n')
  const trailingNewline = lines[lines.length - 1] === ''
  if (trailingNewline) lines.pop()
  return { ok: true, lines, trailingNewline }
}

/** Apply one line-anchored edit. The compare-and-swap is against the edited lines
 *  only: `edit.snapshot` must equal the file's current lines start..end, otherwise
 *  the write is refused and the caller gets the file's current content back.
 *  `edit.newLines` may hold more lines than the span it replaces, fewer, or none at
 *  all — an empty `newLines` splices the anchored lines out of the file (#8).
 *  Writes are atomic (temp file + rename) and preserve the file mode. */
export async function applyEditToFile(workdir: string, rel: string, edit: FileEdit): Promise<ApplyEditResult> {
  const current = readWorkingFile(workdir, rel)
  // A file that vanished really does have no lines left, so 'missing' stays a
  // conflict with an empty `current`. 'too-large'/'binary' say something else — the
  // file left the editable set — and claiming `current: []` there would have the
  // frame re-seed itself against a file it wrongly believes is empty.
  if (!current.ok) {
    return current.reason === 'missing' ? { ok: false, reason: 'conflict', current: [] } : { ok: false, reason: current.reason }
  }
  const { lines, trailingNewline } = current
  const from = edit.start - 1
  const to = edit.end // slice end is exclusive → lines[from..to-1] = start..end inclusive
  const anchored = from >= 0 && from <= lines.length && to >= from && to <= lines.length
  const slice = anchored ? lines.slice(from, to) : null
  const matches = slice != null && slice.length === edit.snapshot.length && slice.every((l, i) => l === edit.snapshot[i])
  if (!matches) return { ok: false, reason: 'conflict', current: lines }

  const next = [...lines.slice(0, from), ...edit.newLines, ...lines.slice(to)]
  const real = containedPath(workdir, rel)
  const mode = fs.statSync(real).mode
  const tmp = `${real}.limn-edit-${process.pid}.tmp`
  // An edit that removes every line (#8: newLines is empty and the span was the whole
  // file) leaves *no* content — writing the trailing newline anyway would leave one
  // blank line behind and not round-trip through readWorkingFile, which reads an
  // empty file back as zero lines.
  const content = next.length === 0 ? '' : next.join('\n') + (trailingNewline ? '\n' : '')
  fs.writeFileSync(tmp, content)
  fs.chmodSync(tmp, mode)
  fs.renameSync(tmp, real)
  const fileHash = (await execGit(workdir, ['hash-object', '--', rel])).trim()
  return { ok: true, fileHash }
}

// Per-workdir promise chain: serializes the app's own writes so the CAS check +
// rename can't interleave with another in-app write. External writers (the agent
// CLI, an IDE) are exactly what the CAS itself arbitrates.
const queues = new Map<string, Promise<unknown>>()
export function withWriteQueue<T>(workdir: string, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(workdir) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  queues.set(workdir, next.catch(() => undefined))
  return next
}
