import { assertSafeRef, branchCheckedOutAt, showFile } from './git.js'
import { readWorkingFile } from './fileEdits.js'
import { effectiveRef, type FileAt, type FileCheckpoint, type RefSide } from '../shared/types.js'

/** Mirrors MAX_EDIT_BYTES / MAX_INLINE_BYTES: past this a fold stays closed rather
 *  than shipping a huge file to the renderer for a 20-line reveal. */
const MAX_BYTES = 2 * 1024 * 1024

function fromContent(content: string | null): FileAt {
  if (content == null) return { ok: false, reason: 'absent' }
  if (content.length > MAX_BYTES) return { ok: false, reason: 'too-large' }
  if (content.includes('\0')) return { ok: false, reason: 'binary' }
  const lines = content.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return { ok: true, lines }
}

/** The lines of `path` at a checkpoint. `now` is the worktree holding the compare
 *  branch when there is one (dirty or not), else the compare tip; `sha` is
 *  `git show sha:path`. Reads never leave the repository: `readWorkingFile` refuses
 *  traversal and symlink escapes, and git resolves `sha:path` inside the object
 *  store. The sha is a positional git operand, hence the option-lookalike guard. */
export async function readFileAt(repo: string, compare: RefSide, path: string, at: FileCheckpoint): Promise<FileAt> {
  if (at.kind === 'sha') {
    assertSafeRef(at.sha)
    return fromContent(await showFile(repo, at.sha, path))
  }
  const wt = compare.kind === 'branch' ? await branchCheckedOutAt(repo, compare.symbol) : null
  if (wt) {
    // display only — never a source for a write-back, so a file whose bytes are not
    // valid UTF-8 still expands (see readWorkingFile's `readOnly`)
    const wf = readWorkingFile(wt, path, { readOnly: true })
    if (wf.ok) return { ok: true, lines: wf.lines }
    return { ok: false, reason: wf.reason === 'missing' ? 'absent' : wf.reason }
  }
  return fromContent(await showFile(repo, effectiveRef(compare), path))
}
