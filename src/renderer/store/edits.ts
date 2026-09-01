import type { StateCreator } from 'zustand'
import type { ApplyEditResult, FileEdit } from '../../shared/types'
import type { FrameDraft } from '../lib/edits'
import { api } from '../lib/api'
import type { AppStore } from './index'
import { fileViewed, renderedFiles } from './derive'

/** the open flow frame's scope in working-tree (new-side) line numbers.
 *  `caretCol` (raw-text units, only meaningful for `start`'s line) carries the
 *  double-clicked column through to FlowFrame's initial focus (#5) — absent when
 *  the frame opened another way (pencil button, post-save ⏎) or the browser gave
 *  no caret-from-point reading, in which case FlowFrame falls back to end-of-line.
 *  `frameId` identifies the *edit session* rather than the region: it survives the
 *  ↑/↓ growth gesture changing `start`/`end` (growth spreads the current frame, so
 *  the id rides along), but a brand-new open — a different line, or the same line
 *  reopened after a save — always mints a fresh one (see `setEditFrame`). DiffBody
 *  keys `<FlowFrame>` by it: same id ⇒ React matches the element and reuses the live
 *  instance (growth), different id ⇒ a full remount (an unrelated edit — see #6
 *  fix-round-1's Critical finding: a shared, position-independent-but-*constant* key
 *  let a same-hunk re-open reuse a stale instance and silently save the old typed
 *  text under the new line numbers). */
export interface EditFrame { file: string; start: number; end: number; caretCol?: number; frameId: number }

/** In-place edits (specs/inplace-edits): the single open flow frame plus the save
 *  pipeline. The frame's *text* lives in the FlowFrame component — the store holds
 *  only the scope (plus a draft safety net, below), so DiffBody can hide the covered
 *  rows and enforce "at most one frame per review". */
export interface EditsSlice {
  editFrame: EditFrame | null
  /** Pass `frameId` to preserve the edit session (growth, same-line-conflict
   *  reopen — both spread/carry the current frame); omit it to open fresh, which
   *  mints a new id and drops any leftover draft from a previous session. Passing
   *  `null` closes the frame and always drops the draft. */
  setEditFrame(frame: (Omit<EditFrame, 'frameId'> & { frameId?: number }) | null): void

  /** The open frame's live draft — typed text plus caret — keyed to
   *  `editFrame.frameId` (#6 fix-round-1). See `FrameDraft`/`seedFrameText` in
   *  lib/edits.ts for why this exists: it lets a frame that's forced to remount
   *  while remaining the *same* edit session (growth crossing a real git-hunk
   *  boundary) restore what the user typed instead of silently re-seeding from disk.
   *  Cleared whenever a frame closes or a genuinely new one opens. */
  editDraft: FrameDraft | null
  setEditDraft(draft: EditsSlice['editDraft']): void

  /** The post-save keyboard round trip (board 12): saving leaves a selection on the
   *  line — ↑/↓ move it (DiffBody reveals folds as they're crossed), ⏎ re-enters
   *  edit there, esc clears. No caret, no input — just the highlighted row. */
  lineSelect: { file: string; line: number } | null
  setLineSelect(sel: EditsSlice['lineSelect']): void

  /** CAS write via applyEdit. On success: re-stamp the viewed mark (a deliberate
   *  in-view edit keeps the file viewed — spec inv 3) and refresh the review (the
   *  fold-in — spec inv 2). A conflict is returned to the caller unrefreshed so the
   *  frame can reopen with the typed text kept. Null on transport failure. */
  saveEdit(file: string, edit: FileEdit): Promise<ApplyEditResult | null>

  /** Refresh the loaded review in place: reload a persisted session, or re-run the
   *  transient preview. Never materializes (spec open question 4). */
  refreshLoaded(): Promise<void>
}

// module-level, not store state: a plain monotonic counter, never persisted or
// serialized — it only needs to be unique within this running app, the same way a
// React key only needs to be unique within its siblings.
let nextFrameId = 1

export const createEditsSlice: StateCreator<AppStore, [], [], EditsSlice> = (set, get) => ({
  editFrame: null,
  editDraft: null,
  lineSelect: null,

  setEditFrame(frame) {
    if (!frame) {
      // closing always drops the draft — there's nothing left to restore it into
      set({ editFrame: null, editDraft: null })
      return
    }
    // opening a frame swallows any line selection; closing leaves it to the caller
    // (a save re-establishes it on the saved line, a cancel keeps none)
    const isNewSession = frame.frameId == null
    const editFrame: EditFrame = { ...frame, frameId: frame.frameId ?? nextFrameId++ }
    set({
      editFrame,
      lineSelect: null,
      // a brand-new session (a different line, or a fresh re-open) never inherits a
      // leftover draft from whatever was open before — only growth/reopen paths that
      // explicitly carry `frameId` forward are "the same edit" for this purpose
      ...(isNewSession ? { editDraft: null } : {})
    })
  },

  setEditDraft(draft) {
    set({ editDraft: draft })
  },

  setLineSelect(sel) {
    set({ lineSelect: sel })
  },

  async saveEdit(file, edit) {
    const { loaded } = get()
    if (!loaded) return null
    let result: ApplyEditResult
    try {
      result = await api().applyEdit(loaded.state.repo, loaded.session.pair.compare, file, edit)
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) })
      return null
    }
    if (!result.ok) return result
    // Viewed re-stamp BEFORE the refresh: the edit changed the file's content hash,
    // which would otherwise silently un-view a file you edited on purpose, in view.
    const { viewedAt, sessionId } = get()
    const f = renderedFiles(loaded).find((x) => x.path === file)
    if (f && fileViewed(f, viewedAt, loaded.skeleton.headSha)) {
      const next = { ...viewedAt, [file]: { sha: loaded.skeleton.headSha, hash: result.fileHash } }
      set({ viewedAt: next })
      // persist only when a session exists — an edit alone never mints one
      if (sessionId != null) {
        try { await api().saveUiState(sessionId, { viewedAt: next }) } catch { /* refresh re-syncs */ }
      }
    }
    await get().refreshLoaded()
    return result
  },

  async refreshLoaded() {
    const { sessionId, loaded, repo } = get()
    if (sessionId != null) { await get().reload(); return }
    if (!loaded || !repo) return
    const pair = loaded.session.pair
    try {
      const keepViewed = get().viewedAt
      const fresh = await api().previewReview(repo, pair.base.symbol, pair.compare.symbol, loaded.session.agent ?? get().agent)
      // transient: viewedAt lives at the store's top level — carry it across the swap
      set({ loaded: fresh, pendingDrift: null, viewedAt: keepViewed })
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) })
    }
  }
})
