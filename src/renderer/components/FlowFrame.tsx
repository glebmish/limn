import { useEffect, useRef, useState } from 'react'
import type { FileDiff } from '../../shared/types'
import { useStore } from '../store'
import { getEditDraft, setEditDraft } from '../store/edits'
import { api } from '../lib/api'
import { saveChordLabel } from '../lib/platform'
import type { FrameDraft, FrameYours } from '../lib/edits'
import {
  caretAfterGrowth, frameDeletesLines, frameGutter, frameHint, frameKeyAction, lineColToCaret,
  narrowEdit, reapplyCue, seedFrameCaret, seedFrameRestore, seedFrameText, selectionAfterSave
} from '../lib/edits'

/** `frameId` identifies the edit session, not the region — see `EditFrame` in
 *  store/edits.ts for the full rationale (#6 fix-round-1) and why it's a random
 *  string rather than a counter (fix-round-2). */
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
  /** the save held across a CAS conflict, offered back via Re-apply (see `FrameYours`).
   *  Mirrored into the draft, not merely component state: the conflict branch below
   *  calls `refreshLoaded()`, which can reshuffle hunks and remount this very frame —
   *  local-only state would lose the banner on the one path it exists for. */
  const [yours, setYours] = useState<FrameYours | null>(null)
  const taRef = useRef<HTMLTextAreaElement | null>(null)
  const caretRef = useRef<number | null>(null)
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])

  /** Persist the live draft under this session's `frameId` (#6 fix-round-1) — a
   *  plain module-level write (store/edits.ts's `setEditDraft`, outside zustand's
   *  reactive state — fix-round-2, see its doc comment), not React state, so it
   *  survives even when *this* component instance is about to be torn down (a
   *  `refreshLoaded()` that reshuffles the diff still forces a remount; since #11
   *  DiffBody's key-matched reconciliation spans the whole file, so growth across
   *  what used to be a hunk boundary no longer does). Called at every point `text`
   *  intentionally changes: typing, the ↑/↓ growth gesture, and the
   *  same-line-conflict/Re-apply paths in `save()`.
   *
   *  `over` overrides the two fields that ride along from component state — the CAS
   *  anchor and the conflict banner — for the callers that change them *in the same
   *  tick* as the text (the conflict path, Re-apply), where the closure still holds
   *  the pre-`setState` values. */
  const draft = (
    nextText: string,
    caret: number | null,
    over: Partial<Pick<FrameDraft, 'fileLines' | 'yours'>> = {}
  ): void => {
    setEditDraft({ frameId: frame.frameId, text: nextText, caret, fileLines, yours, ...over })
  }

  // fetch the working file once per open frame; growth reuses the fetched lines.
  // Deliberately not re-run on scope growth — hence the ref guard, not a dep list.
  const fetched = useRef(false)
  // the `fetched` ref is the guard the missing dep list would otherwise be: the body
  // runs at most once per mounted frame, so the state it sets can't feed back into it
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (fetched.current || !loaded) return
    fetched.current = true
    // A remount that preserved this session's frameId (the refresh the conflict path
    // itself triggers, say) restores the whole
    // edit from the draft — text, the working-tree snapshot it was typed against, and
    // any conflict banner — and skips the re-read entirely. Re-reading here would
    // re-anchor the CAS to content the user never saw: an external write landing
    // between the first fetch and the remount would then save *silently* instead of
    // conflicting (final review, findings 2 + 3; see `seedFrameRestore`). It also
    // takes the remount's disabled-textarea flash out.
    const restored = seedFrameRestore(getEditDraft(), frame.frameId)
    if (restored) {
      setFileLines(restored.fileLines)
      setText(restored.text)
      setYours(restored.yours)
      return
    }
    void (async () => {
      try {
        const wf = await api().readWorkingFile(loaded.state.repo, loaded.session.pair.compare, f.path)
        if (!alive.current) return
        if (!wf.ok) { setEditFrame(null); return }
        setFileLines(wf.lines)
        // an anchor-less draft for this session (written before the working file
        // arrived) still contributes its text rather than losing it to disk
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
    // This instance is gone (⌘⏎ then an immediate double-click elsewhere, say): both
    // branches below drive the *global* frame, so a late resolution would close the
    // frame the user just opened — or reopen this dead session on top of it.
    if (!alive.current) return
    if (!res) { setEditFrame(null); return } // transport error already surfaced
    if (!res.ok && res.reason !== 'conflict') {
      // The file left the editable set while the frame was open (it outgrew the cap,
      // or stopped being text — a generation writing to it is exactly this feature's
      // concurrency). There is no fresh content to re-anchor on, so unlike a conflict
      // this save can never be retried against the file. The frame stays open all the
      // same: closing it would throw away text the reviewer typed and cannot get back
      // (spec inv 6's "never a retype"), so they keep it until they copy it out.
      const why = res.reason === 'too-large' ? 'too large' : 'no longer text'
      useStore.setState({ error: `${f.path} can no longer be edited here — it is ${why}. Your text is still in the frame; copy it out before closing.` })
      return
    }
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
    // The line numbers a deletion Re-apply would remove — the region as it stood
    // right before the conflict, since by the time the banner renders `frame` has
    // already been re-anchored onto the fresh post-conflict scope (see below).
    const removedLines = removeLines
      ? Array.from({ length: frame.end - frame.start + 1 }, (_, i) => frame.start + i)
      : []
    const kept: FrameYours = { text: value, removes: removedLines }
    setYours(kept)
    setFileLines(res.current)
    setText(fresh)
    // The whole conflict state must move into the draft here (fix-round-2 minor,
    // extended by the final review's finding 3): `refreshLoaded` below can shift
    // which row is "first" (folds fall in/out) and remount the frame, and that
    // remount must reseed the *post*-conflict text, against the *fresh* lines the
    // CAS just handed back, with the banner still up — anything less is either a
    // stale save or the retype spec inv 6 forbids. No caret to restore across a
    // conflict reset, hence null.
    draft(fresh, null, { fileLines: res.current, yours: kept })
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
        // very growth step tears this instance down before any of its effects get
        // to run
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
  const cue = yours ? reapplyCue(yours.removes) : null
  const chord = saveChordLabel(typeof navigator !== 'undefined' ? navigator.platform : '')
  return (
    <div className={`flow-frame${deletesLines ? ' ff-emptied' : ''}`} data-limn-frame={f.path}>
      <div className="ff-head">
        <span className="ff-chip">editing {chip}</span>
        <span className="ff-hint">{frameHint(deletesLines, chip, chord)}</span>
        <span className="grow" />
        {deletesLines && (
          <button className="ff-btn ff-del" title={`Remove ${chip} from the file (⌫)`} aria-label={`Delete ${chip}`} onClick={() => void save(text, true)}>⌫</button>
        )}
        <button className="ff-btn ff-ok" title={`Save (${chord}) — writes the working tree`} aria-label="Save edit" onClick={() => void save(text)}>✓</button>
        <button className="ff-btn" title="Cancel (esc)" aria-label="Cancel edit" onClick={() => setEditFrame(null)}>✕</button>
      </div>
      {yours != null && cue != null && (
        <div className="ff-yours">
          <span>These lines changed while you were editing — refreshed to the new version; {yours.removes.length > 0 ? 'your deletion is kept' : 'your text is kept'}:</span>
          <code>{yours.removes.length > 0 ? '⌫ delete these lines' : yours.text}</code>
          <button
            className={`ff-btn${cue.danger ? ' ff-danger' : ' ff-ok'}`}
            title={cue.title}
            onClick={() => { const y = yours; setYours(null); setText(y.text); draft(y.text, null, { yours: null }); void save(y.text, y.removes.length > 0) }}
          >Re-apply</button>
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
