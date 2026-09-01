import { useEffect, useRef, useState } from 'react'
import type { FileDiff } from '../../shared/types'
import { useStore } from '../store'
import { api } from '../lib/api'
import { frameGutter, frameKeyAction, lineColToCaret, narrowEdit } from '../lib/edits'

interface FrameScope { file: string; start: number; end: number; caretCol?: number }

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
 *  replaced. A same-line conflict keeps the typed text with one-keystroke re-apply. */
export function FlowFrame({ f, frame }: { f: FileDiff; frame: FrameScope }) {
  const { loaded, setEditFrame, saveEdit, refreshLoaded } = useStore()
  const [fileLines, setFileLines] = useState<string[] | null>(null)
  const [text, setText] = useState('')
  /** typed text held across a CAS conflict, offered back via Re-apply */
  const [yours, setYours] = useState<string | null>(null)
  const taRef = useRef<HTMLTextAreaElement | null>(null)
  const caretRef = useRef<number | null>(null)
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])

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
        setText(wf.lines.slice(frame.start - 1, frame.end).join('\n'))
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
    const pos = lineColToCaret(text.split('\n'), 0, frame.caretCol ?? Infinity)
    ta.setSelectionRange(pos, pos)
  }, [fileLines, text, frame.caretCol])

  async function save(value: string): Promise<void> {
    if (!fileLines) { setEditFrame(null); return }
    const typed = value.split('\n')
    const snapshot = fileLines.slice(frame.start - 1, frame.end)
    const edit = narrowEdit(frame.start, snapshot, typed)
    if (!edit) { setEditFrame(null); return } // unchanged save is a cancel
    const res = await saveEdit(f.path, edit)
    if (!res) { setEditFrame(null); return } // transport error already surfaced
    if (res.ok) {
      // keyboard round trip: the save leaves a selection on the edited line —
      // ↑/↓ move it, ⏎ re-enters edit, esc clears (handled by DiffBody)
      setEditFrame(null)
      useStore.getState().setLineSelect({ file: f.path, line: edit.start })
      return
    }
    // Same-line conflict: the review refreshes around the frame, which reopens on
    // the fresh content with the typed text kept — never a retype (spec inv 6).
    const end = Math.min(frame.end, res.current.length)
    const start = Math.max(1, Math.min(frame.start, end || 1))
    setYours(value)
    setFileLines(res.current)
    setText(res.current.slice(start - 1, end).join('\n'))
    setEditFrame({ file: f.path, start, end })
    await refreshLoaded()
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>): void {
    const ta = e.currentTarget
    const action = frameKeyAction(e)
    if (action === 'cancel') { e.preventDefault(); setEditFrame(null); return }
    if (action === 'save') { e.preventDefault(); void save(text); return }
    // plain ⏎ falls through to the textarea: it inserts a newline (#10)
    if (!fileLines) return
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const { line, col, lineCount } = caretPos(ta)
      if (e.key === 'ArrowUp' && line === 0 && frame.start > 1) {
        e.preventDefault()
        const joined = fileLines[frame.start - 2]
        caretRef.current = Math.min(col, joined.length)
        setText(`${joined}\n${text}`)
        setEditFrame({ ...frame, start: frame.start - 1 })
      } else if (e.key === 'ArrowDown' && line === lineCount - 1 && frame.end < fileLines.length) {
        e.preventDefault()
        const joined = fileLines[frame.end]
        const next = `${text}\n${joined}`
        caretRef.current = next.length - joined.length + Math.min(col, joined.length)
        setText(next)
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
  const gutter = frameGutter(frame.start, original, typedLines)
  return (
    <div className="flow-frame" data-limn-frame={f.path}>
      <div className="ff-head">
        <span className="ff-chip">editing {chip}</span>
        <span className="ff-hint">⌘⏎ save · ⏎ new line · esc cancel · ↑/↓ past the edge extends</span>
        <span className="grow" />
        <button className="ff-btn ff-ok" title="Save (⌘⏎) — writes the working tree" aria-label="Save edit" onClick={() => void save(text)}>✓</button>
        <button className="ff-btn" title="Cancel (esc)" aria-label="Cancel edit" onClick={() => setEditFrame(null)}>✕</button>
      </div>
      {yours != null && (
        <div className="ff-yours">
          <span>These lines changed while you were editing — refreshed to the new version; your text is kept:</span>
          <code>{yours}</code>
          <button className="ff-btn ff-ok" onClick={() => { const t = yours; setYours(null); setText(t); void save(t) }}>Re-apply</button>
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
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
        />
      </div>
    </div>
  )
}
