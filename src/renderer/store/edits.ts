import type { StateCreator } from 'zustand'
import type { ApplyEditResult, FileEdit } from '../../shared/types'
import type { FrameDraft } from '../lib/edits'
import { newFrameId } from '../lib/edits'
import { api } from '../lib/api'
import type { AppStore } from './index'
import { fileViewed, renderedFiles } from './derive'
import { saveViewedAt, touchViewed } from './progress'

/** the open flow frame's scope in working-tree (new-side) line numbers.
 *  `caretCol` (raw-text units, only meaningful for `start`'s line) carries the
 *  double-clicked column through to FlowFrame's initial focus (#5) — absent when
 *  the frame opened another way (pencil button, post-save ⏎) or the browser gave
 *  no caret-from-point reading, in which case FlowFrame falls back to end-of-line.
 *  `frameId` identifies the *edit session* rather than the region: it survives the
 *  ↑/↓ growth gesture changing `start`/`end` (growth spreads the current frame, so
 *  the id rides along), but a brand-new open — a different line, or the same line
 *  reopened after a save — always mints a fresh one (see `setEditFrame`, and
 *  `newFrameId` for why it is not a bare `crypto.randomUUID()` call). DiffBody
 *  keys `<FlowFrame>` by it: same id ⇒ React matches the element and reuses the live
 *  instance (growth), different id ⇒ a full remount (an unrelated edit — see #6
 *  fix-round-1's Critical finding: a shared, position-independent-but-*constant* key
 *  let a re-open elsewhere in the same file reuse a stale instance and silently save the old typed
 *  text under the new line numbers). A random string, not a counter
 *  (fix-round-2): a module-level counter resets on a Vite HMR reload of this module
 *  while the live store can still hold a frame minted by the pre-reload counter —
 *  colliding ids would reopen the Critical bug in dev. */
export interface EditFrame { file: string; start: number; end: number; caretCol?: number; frameId: string }

/** In-place edits (specs/inplace-edits): the single open flow frame plus the save
 *  pipeline. The frame's *text* lives in the FlowFrame component — the store holds
 *  only the scope, so DiffBody can hide the covered rows and enforce "at most one
 *  frame per review". The live draft (the typed text and caret from fix-round-1's
 *  data-loss fix, plus the working-tree snapshot it was typed against and any
 *  conflict banner — final review, findings 2 + 3, see `FrameDraft`) is a safety
 *  net for a forced remount, not application state — see
 *  `getEditDraft`/`setEditDraft` below for why it deliberately lives outside this
 *  reactive slice. */
export interface EditsSlice {
  editFrame: EditFrame | null
  /** Pass `frameId` to preserve the edit session (growth, same-line-conflict
   *  reopen — both spread/carry the current frame); omit it to open fresh, which
   *  mints a new id and drops any leftover draft from a previous session. Passing
   *  `null` closes the frame and always drops the draft. */
  setEditFrame(frame: (Omit<EditFrame, 'frameId'> & { frameId?: string }) | null): void

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
   *  transient preview. Never materializes (spec open question 4). `resync` is the
   *  SSE-gap refetch (see `reload`); resolves false when the refetch failed. */
  refreshLoaded(opts?: { resync?: boolean }): Promise<boolean>
}

// The live draft (fix-round-1's data-loss fix) lives here, outside zustand's
// reactive state entirely — fix-round-2. Nothing subscribes to it reactively: both
// reads in FlowFrame.tsx go through `getEditDraft()`, called imperatively inside an
// effect/handler, never through a `useStore` selector. Putting it in store state
// (as fix-round-1 first did) meant every keystroke called `set({ editDraft })`, a
// new top-level state object that re-renders every selector-less `useStore()`
// subscriber in the app (Review.tsx, DiffView.tsx, SectionView.tsx, ActionChips.tsx,
// ChatDrawer.tsx, App.tsx — none memoized) — per-keystroke jank on a large review,
// for a value nothing but FlowFrame itself ever reads. Durability doesn't need
// reactivity; a plain module-level slot gives the same survive-a-remount guarantee
// (it's not tied to any component instance) without the render fan-out.
let draftSlot: FrameDraft | null = null

export function getEditDraft(): FrameDraft | null {
  return draftSlot
}

export function setEditDraft(draft: FrameDraft | null): void {
  draftSlot = draft
}

export const createEditsSlice: StateCreator<AppStore, [], [], EditsSlice> = (set, get) => ({
  editFrame: null,
  lineSelect: null,

  setEditFrame(frame) {
    if (!frame) {
      // closing always drops the draft — there's nothing left to restore it into
      setEditDraft(null)
      set({ editFrame: null })
      return
    }
    // opening a frame swallows any line selection; closing leaves it to the caller
    // (a save re-establishes it on the saved line, a cancel keeps none)
    const isNewSession = frame.frameId == null
    // a brand-new session (a different line, or a fresh re-open) never inherits a
    // leftover draft from whatever was open before — only growth/reopen paths that
    // explicitly carry `frameId` forward are "the same edit" for this purpose
    if (isNewSession) setEditDraft(null)
    const editFrame: EditFrame = { ...frame, frameId: frame.frameId ?? newFrameId() }
    set({ editFrame, lineSelect: null })
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
      touchViewed([file])
      set({ viewedAt: next })
      // persist only when a session exists — an edit alone never mints one. Through
      // the shared save queue, so it can't land out of order with a tick's save.
      if (sessionId != null) await saveViewedAt(sessionId, next)
    }
    await get().refreshLoaded()
    return result
  },

  async refreshLoaded(opts) {
    const { sessionId, loaded, repo } = get()
    if (sessionId != null) return get().reload(opts)
    if (!loaded || !repo) return true
    const pair = loaded.session.pair
    try {
      const fresh = await api().previewReview(repo, pair.base.symbol, pair.compare.symbol, loaded.session.agent ?? get().agent)
      // viewedAt is a sibling of `loaded`, not nested under it — zustand's merging
      // `set` leaves it alone, so it survives the swap without a write-back (and a
      // write-back would revert any tick made during the previewReview round trip).
      set({ loaded: fresh, pendingDrift: null })
      return true
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) })
      return false
    }
  }
})
