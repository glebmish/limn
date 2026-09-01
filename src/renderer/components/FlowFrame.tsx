import { useEffect, useRef, useState } from 'react'
import type { FileDiff } from '../../shared/types'
import { useStore } from '../store'
import { getEditDraft, setEditDraft } from '../store/edits'
import { api } from '../lib/api'
import {
  caretAfterGrowth, frameDeletesLines, frameGutter, frameHint, frameKeyAction, lineColToCaret,
  narrowEdit, seedFrameCaret, seedFrameText, selectionAfterSave
} from '../lib/edits'

/** `frameId` identifies the edit session, not the region — see `EditFrame` in
 *  store/edits.ts for the full rationale (#6 fix-round-1) and why it's a
 *  `crypto.randomUUID()` string rather than a counter (fix-round-2). */
interface FrameScope { file: string; start: number; end: number; caretCol?: number; frameId: string }

/** Caret position inside a textarea, as (line, column) plus the line count. */
function caretPos(ta: HTMLTextAreaElement): { line: number; col: number; lineCount: number } {
  const before = ta.value.slice(0, ta.selectionStart)
  const line = before.split('\n').length - 1
  const col = before.length - (before.lastIndexOf('\n') + 1)
  return { line, col, lineCount: ta.value.split('\n').length }
}

/** The single in-place editor (specs/inplace-edits — board 12's "flow frame").
 *  Covers a contiguous run of working-tree lines; arrowing the caret past an edge
 *  admits the neighbouring file line (the growth gesture). ⏎ always makes a new
 *  line — splitting a line and inserting lines are ordinary edits (#10) — and ⌘⏎
 *  (or ctrl+⏎) saves. Saving narrows to the changed core and CAS-writes via the
 *  store's save pipeline; the written region may hold more (or fewer) lines than it
 *  replaced — including none, when the region is typed away to nothing and ⌫ takes
 *  its lines out of the file (#8, cued in the head before the keystroke lands).
 *  A same-line conflict keeps the typed text with one-keystroke re-apply. */
export function FlowFrame({ f, frame }: { f: FileDiff; frame: FrameScope }) {
  const { loaded, setEditFrame, saveEdit, refreshLoaded } = useStore()
  const [fileLines, setFileLines] = useState<string[] | null>(null)
  const [text, setText] = useState('')
  /** the save held across a CAS conflict, offered back via Re-apply. `removes` carries
   *  the #8 delete intent with it: an emptied frame's typed text is '' either way, so
   *  without it Re-apply after a conflicted deletion would write a blank line instead
   *  of removing the lines — a different edit than the one the user asked for. */
  const [yours, setYours] = useState<{ text: string; removes: boolean } | null>(null)
  const taRef = useRef<HTMLTextAreaElement | null>(null)
  const caretRef = useRef<number | null>(null)
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])

  /** Persist the live draft under this session's `frameId` (#6 fix-round-1) — a
   *  plain module-level write (store/edits.ts's `setEditDraft`, outside zustand's
   *  reactive state — fix-round-2, see its doc comment), not React state, so it
   *  survives even when *this* component instance is about to be torn down (growth
   *  crossing a real git-hunk boundary still forces a remount; DiffBody's
   *  key-matched reconciliation only reaches within one hunk's own flattened row
   *  array). Called at every point `text` intentionally changes: typing, the ↑/↓
   *  growth gesture, and the same-line-conflict/Re-apply paths in `save()`. */
  const draft = (nextText: string, caret: number | null): void => {
    setEditDraft({ frameId: frame.frameId, text: nextText, caret })
  }

  // fetch the working file once per open frame; growth reuses the fetched lines.
  // Deliberately not re-run on scope growth — hence the ref guard, not a dep list.
  const fetched = useRef(false)
  useEffect(() => {
    if (fetched.current || !loaded) return
    fetched.current = true
    void (async () => {
      try {
        const wf = await api().readWorkingFile(loaded.state.repo, loaded.session.pair.compare, f.path)
        if (!alive.current) return
        if (!wf.ok) { setEditFrame(null); return }
        setFileLines(wf.lines)
        // a remount that preserved this session's frameId (growth across a real
        // hunk boundary) restores the live draft instead of re-reading disk and
        // silently discarding what was typed — see seedFrameText's doc comment.
        const diskText = wf.lines.slice(frame.start - 1, frame.end).join('\n')
        setText(seedFrameText(getEditDraft(), frame.frameId, diskText))
      } catch {
        if (alive.current) setEditFrame(null)
      }
    })()
  })

  // restore the caret after a growth step re-seeded the textarea
  useEffect(() => {
    if (caretRef.current == null || !taRef.current) return
    taRef.current.focus()
    taRef.current.setSelectionRange(caretRef.current, caretRef.current)
    caretRef.current = null
  }, [text])

  // #5: focus the textarea once it becomes usable, and put the caret at (or near)
  // the double-clicked position. Root cause of the bug this replaces: the textarea
  // mounts `disabled` (fileLines hasn't loaded yet) and a disabled control cannot
  // receive focus, so the `autoFocus` prop React used to set was a no-op at mount —
  // and nothing ever re-focused it once `fileLines` arrived and the control enabled.
  // This effect fires once, the first time `fileLines` is non-null: `frame.caretCol`
  // (raw-text units, captured from the double-click that opened the frame — see
  // DiffBody's `caretColumnFromEvent`) places the caret precisely; its absence
  // (opened via the pencil button, the post-save ⏎, or a browser with neither
  // caret-from-point API) falls back to end-of-line via `lineColToCaret`'s clamping
  // (`Infinity` clamps to the line's length).
  const focusedOnce = useRef(false)
  useEffect(() => {
    if (focusedOnce.current || fileLines == null || !taRef.current) return
    focusedOnce.current = true
    const ta = taRef.current
    ta.focus()
    // a restored draft's own caret wins over the double-click column — the text it
    // was captured against no longer matches what's on screen otherwise
    const fallback = lineColToCaret(text.split('\n'), 0, frame.caretCol ?? Infinity)
    const pos = seedFrameCaret(getEditDraft(), frame.frameId, fallback)
    ta.setSelectionRange(pos, pos)
  }, [fileLines, text, frame.caretCol, frame.frameId])

  /** Commit the frame. `removeLines` (#8 — the ⌫ gesture on an emptied region) is the
   *  one thing the textarea's own value cannot express: it saves *zero* lines, so the
   *  narrowed payload has an empty `newLines` and the server splices the region out
   *  of the file. Saving the empty value instead would write a blank line — a
   *  different, also-legitimate outcome, which is why the hint names both. */
  async function save(value: string, removeLines = false): Promise<void> {
    if (!fileLines) { setEditFrame(null); return }
    const typed = removeLines ? [] : value.split('\n')
    const snapshot = fileLines.slice(frame.start - 1, frame.end)
    const edit = narrowEdit(frame.start, snapshot, typed)
    if (!edit) { setEditFrame(null); return } // unchanged save is a cancel
    const res = await saveEdit(f.path, edit)
    if (!res) { setEditFrame(null); return } // transport error already surfaced
    if (res.ok) {
      // keyboard round trip: the save leaves a selection on the edited line —
      // ↑/↓ move it, ⏎ re-enters edit, esc clears (handled by DiffBody). A deletion
      // has no edited line; `selectionAfterSave` picks what took its place.
      setEditFrame(null)
      const line = selectionAfterSave(edit, fileLines.length)
      useStore.getState().setLineSelect(line == null ? null : { file: f.path, line })
      return
    }
    // Same-line conflict: the review refreshes around the frame, which reopens on
    // the fresh content with the typed text kept — never a retype (spec inv 6).
    const end = Math.min(frame.end, res.current.length)
    const start = Math.max(1, Math.min(frame.start, end || 1))
    const fresh = res.current.slice(start - 1, end).join('\n')
    setYours({ text: value, removes: removeLines })
    setFileLines(res.current)
    setText(fresh)
    // the draft must move with `text` here too (fix-round-2 minor): `refreshLoaded`
    // below can shift which row is "first" (folds fall in/out), and a remount at
    // that moment must not reseed the stale pre-conflict text under the same
    // frameId — no caret to restore across a conflict reset, hence null
    draft(fresh, null)
    // same edit session, re-anchored after a conflict — carry the id forward so
    // this stays the live instance (no remount) and no draft gets dropped under it
    setEditFrame({ file: f.path, start, end, frameId: frame.frameId })
    await refreshLoaded()
  }

  /** #8: the region is typed away to nothing, so the next ⌫ takes its lines out of
   *  the file. Drives the keymap and the cue together — one predicate, so what the
   *  head advertises and what the keystroke does can never disagree. */
  const deletesLines = frameDeletesLines(text, fileLines != null)

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>): void {
    const ta = e.currentTarget
    // Destructured rather than passed whole so every field the keymap reads — the
    // held-⌫ gate's `repeat` above all — is a checked read off React's event type:
    // `frameKeyAction`'s fields are optional, so a silently missing one would
    // disable a branch instead of failing the build.
    const { key, metaKey, ctrlKey, shiftKey, altKey, repeat } = e
    const action = frameKeyAction({ key, metaKey, ctrlKey, shiftKey, altKey, repeat }, deletesLines)
    if (action === 'cancel') { e.preventDefault(); setEditFrame(null); return }
    if (action === 'save') { e.preventDefault(); void save(text); return }
    if (action === 'delete') { e.preventDefault(); void save(text, true); return }
    // plain ⏎ falls through to the textarea: it inserts a newline (#10)
    if (!fileLines) return
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const { line, col, lineCount } = caretPos(ta)
      if (e.key === 'ArrowUp' && line === 0 && frame.start > 1) {
        e.preventDefault()
        const joined = fileLines[frame.start - 2]
        // prepended above everything else — nothing comes before it in the new text
        const pos = caretAfterGrowth(0, joined, col)
        caretRef.current = pos
        const next = `${joined}\n${text}`
        setText(next)
        // written directly (not via an effect on `text`) so it lands even if this
        // very growth step crosses a real git-hunk boundary and tears this instance
        // down before any of its effects get to run
        draft(next, pos)
        setEditFrame({ ...frame, start: frame.start - 1 })
      } else if (e.key === 'ArrowDown' && line === lineCount - 1 && frame.end < fileLines.length) {
        e.preventDefault()
        const joined = fileLines[frame.end]
        // appended after the old text plus its joining '\n'
        const pos = caretAfterGrowth(text.length + 1, joined, col)
        caretRef.current = pos
        const next = `${text}\n${joined}`
        setText(next)
        draft(next, pos)
        setEditFrame({ ...frame, end: frame.end + 1 })
      }
    }
  }

  const typedLines = text.split('\n')
  const lineCount = typedLines.length
  const chip = frame.start === frame.end ? `line ${frame.start}` : `lines ${frame.start}–${frame.end}`
  // Before the working file arrives the frame is empty and disabled — nothing has
  // been typed, so the rows are trivially the region's own lines.
  const original = fileLines ? fileLines.slice(frame.start - 1, frame.end) : typedLines
  // The emptied frame holds exactly one (blank) row, and it is not a row that will
  // survive — '+' would promise a line the next ⌫ is about to remove, so it wears
  // the key that removes it instead (#8).
  const gutter = deletesLines ? ['⌫'] : frameGutter(frame.start, original, typedLines)
  return (
    <div className={`flow-frame${deletesLines ? ' ff-emptied' : ''}`} data-limn-frame={f.path}>
      <div className="ff-head">
        <span className="ff-chip">editing {chip}</span>
        <span className="ff-hint">{frameHint(deletesLines, chip)}</span>
        <span className="grow" />
        {deletesLines && (
          <button className="ff-btn ff-del" title={`Remove ${chip} from the file (⌫)`} aria-label={`Delete ${chip}`} onClick={() => void save(text, true)}>⌫</button>
        )}
        <button className="ff-btn ff-ok" title="Save (⌘⏎) — writes the working tree" aria-label="Save edit" onClick={() => void save(text)}>✓</button>
        <button className="ff-btn" title="Cancel (esc)" aria-label="Cancel edit" onClick={() => setEditFrame(null)}>✕</button>
      </div>
      {yours != null && (
        <div className="ff-yours">
          <span>These lines changed while you were editing — refreshed to the new version; {yours.removes ? 'your deletion is kept' : 'your text is kept'}:</span>
          <code>{yours.removes ? '⌫ delete these lines' : yours.text}</code>
          <button className="ff-btn ff-ok" onClick={() => { const y = yours; setYours(null); setText(y.text); draft(y.text, null); void save(y.text, y.removes) }}>Re-apply</button>
        </div>
      )}
      <div className="ff-body">
        <span className="ff-gutter" aria-hidden>
          {gutter.map((n, i) => <span key={i}>{n}</span>)}
        </span>
        <textarea
          ref={taRef}
          className="ff-ta"
          rows={lineCount}
          value={text}
          spellCheck={false}
          disabled={fileLines == null}
          aria-label={`Edit ${f.path}, ${chip}`}
          onChange={(e) => { setText(e.target.value); draft(e.target.value, e.target.selectionStart) }}
          onKeyDown={onKeyDown}
        />
      </div>
    </div>
  )
}
