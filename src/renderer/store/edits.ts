import type { StateCreator } from 'zustand'
import type { ApplyEditResult, FileEdit } from '../../shared/types'
import { api } from '../lib/api'
import type { AppStore } from './index'
import { fileViewed, renderedFiles } from './derive'

/** In-place edits (specs/inplace-edits): the single open flow frame plus the save
 *  pipeline. The frame's *text* lives in the FlowFrame component — the store holds
 *  only the scope, so DiffBody can hide the covered rows and enforce "at most one
 *  frame per review". */
export interface EditsSlice {
  /** the open flow frame's scope in working-tree (new-side) line numbers, or null.
   *  `caretCol` (raw-text units, only meaningful for `start`'s line) carries the
   *  double-clicked column through to FlowFrame's initial focus (#5) — absent when
   *  the frame opened another way (pencil button, post-save ⏎) or the browser gave
   *  no caret-from-point reading, in which case FlowFrame falls back to end-of-line. */
  editFrame: { file: string; start: number; end: number; caretCol?: number } | null
  setEditFrame(frame: EditsSlice['editFrame']): void

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

export const createEditsSlice: StateCreator<AppStore, [], [], EditsSlice> = (set, get) => ({
  editFrame: null,
  lineSelect: null,

  setEditFrame(frame) {
    // opening a frame swallows any line selection; closing leaves it to the caller
    // (a save re-establishes it on the saved line, a cancel keeps none)
    set(frame ? { editFrame: frame, lineSelect: null } : { editFrame: null })
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
