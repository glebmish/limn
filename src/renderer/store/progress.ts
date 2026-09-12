import type { StateCreator } from 'zustand'
import type { FileDiff, ViewMark } from '../../shared/types'
import { api } from '../lib/api'
import type { AppStore } from './index'
import { useStore } from './index'
import type { DiffMode } from './derive'
import { collapseCompletedSections, fileIsExcluded, viewMarkFor } from './derive'

// ── promoted persist helpers ─────────────────────────────────
// These were closures over set/get inside the store factory; they now reach the
// store via useStore.getState() (the step-4/6 pattern) so the persist chain still
// funnels through get().materialize() — now across a named import boundary. The
// viewed/exclude mark is always set in state BEFORE these run, so the wholesale
// `loaded` swap inside materialize() keeps it.

const persistUi = async (): Promise<void> => {
  const id = await useStore.getState().materialize()        // first viewed mark mints the session
  if (id == null) return
  const { viewedAt } = useStore.getState()
  void api().saveUiState(id, { viewedAt })
}

const persistExcluded = async (): Promise<void> => {
  const id = await useStore.getState().materialize()        // first exclude toggle mints the session
  if (id == null) return
  void api().saveUiState(id, { fileExcluded: useStore.getState().loaded?.state.fileExcluded ?? {} })
}

/** The review-progress domain: viewed marks, section disclosure (collapsed/expanded),
 *  in-review navigation (cur/curFile/focusTarget), the artifact-doc overlay, and the
 *  global diff baseline. Its persisted mutations funnel through the promoted helpers
 *  above into get().materialize(). */
export interface ProgressSlice {
  viewedAt: Record<string, ViewMark>
  collapsed: Set<string>
  /** sections force-opened for re-viewing after they were completed (all files
   *  viewed). Lets you re-open a done section without un-viewing its files. */
  expanded: Set<string>
  cur: string | null
  /** the file nearest the top of the viewport — highlighted in the sidebar tree
   *  and kept in sync as you scroll. */
  curFile: string | null
  /** transient: force-render a focus target (a viewed file / done section)
   *  without mutating viewedAt. Set by focusAnchor. */
  focusTarget: { file?: string; sectionId?: string } | null
  /** path of the artifact whose rendered doc view is open (overlay), or null.
   *  Lifted out of Review so the diff's spec/plan badge can open it too. */
  docPath: string | null
  /** global diff baseline (Full diff / Since approved / Since viewed) applied to every file */
  diffMode: DiffMode

  toggleViewed(file: string, currentlyViewed: boolean): void
  /** Flip an untracked file's exclude override (the per-row exclude / add-back button).
   *  Excluded files carry no review state and move to the collapsed Excluded group. */
  toggleExcluded(file: FileDiff): void
  /** Bulk-set the viewed mark for a section's files (the section-level checkbox).
   *  Marking viewed also collapses the section (clears its force-open override). */
  setSectionViewed(sectionId: string, paths: string[], viewed: boolean): void
  openSection(id: string): void
  toggleSection(id: string, currentlyOpen: boolean): void
  setCur(id: string): void
  setCurFile(file: string | null): void
  setFocusTarget(t: { file?: string; sectionId?: string } | null): void
  openDoc(path: string): void
  closeDoc(): void
  /** Set the global diff baseline applied to every file. */
  setGlobalDiffMode(mode: DiffMode): void
}

export const createProgressSlice: StateCreator<AppStore, [], [], ProgressSlice> = (set, get) => ({
  viewedAt: {},
  collapsed: new Set<string>(),
  expanded: new Set<string>(),
  cur: null,
  curFile: null,
  focusTarget: null,
  docPath: null,
  diffMode: 'branch',

  toggleViewed(file, currentlyViewed) {
    const viewedAt = { ...get().viewedAt }
    // unchecking removes the record; checking (or re-checking after drift) snapshots
    // the current head AND the file's on-disk content hash, so later commits or
    // uncommitted edits both re-flag it.
    if (currentlyViewed) delete viewedAt[file]
    else viewedAt[file] = viewMarkFor(get().loaded, file)
    const expanded = collapseCompletedSections(get().loaded, viewedAt, get().expanded)
    set({ viewedAt, expanded })
    persistUi()
  },

  toggleExcluded(file) {
    const loaded = get().loaded
    if (!loaded || !file.untracked) return  // tracked files can never be excluded
    const next = !fileIsExcluded(loaded, file)
    const fileExcluded = { ...(loaded.state.fileExcluded ?? {}), [file.path]: next }
    // excluding a file drops any viewed mark it carried — it leaves the review
    const viewedAt = { ...get().viewedAt }
    if (next && viewedAt[file.path]) delete viewedAt[file.path]
    set({ loaded: { ...loaded, state: { ...loaded.state, fileExcluded } }, viewedAt })
    persistExcluded()
    if (next) persistUi()
  },

  setSectionViewed(sectionId, paths, viewed) {
    const viewedAt = { ...get().viewedAt }
    for (const p of paths) {
      if (viewed) viewedAt[p] = viewMarkFor(get().loaded, p)
      else delete viewedAt[p]
    }
    // marking the section viewed collapses it (and, on remount, its files):
    // drop the force-open override so the now-complete section folds away.
    const expanded = new Set(get().expanded)
    if (viewed) expanded.delete(sectionId)
    set({ viewedAt, expanded })
    persistUi()
  },

  openSection(id) {
    // force-open a (possibly completed) section for re-viewing — without
    // touching viewed marks or other sections. UI-only, not persisted.
    const expanded = new Set(get().expanded)
    const collapsed = new Set(get().collapsed)
    collapsed.delete(id)
    expanded.add(id)
    set({ collapsed, expanded, cur: id })
  },

  toggleSection(id, currentlyOpen) {
    const collapsed = new Set(get().collapsed)
    const expanded = new Set(get().expanded)
    if (currentlyOpen) {
      collapsed.add(id)
      expanded.delete(id)
      set({ collapsed, expanded })
    } else {
      collapsed.delete(id)
      expanded.add(id)
      set({ collapsed, expanded, cur: id })
    }
  },

  setCur(id) {
    if (get().cur !== id) set({ cur: id })
  },

  setCurFile(file) {
    if (get().curFile !== file) set({ curFile: file })
  },

  setFocusTarget(t) {
    set({ focusTarget: t })
  },

  openDoc(path) {
    set({ docPath: path })
  },
  closeDoc() {
    set({ docPath: null })
  },
  setGlobalDiffMode(mode) {
    set({ diffMode: mode })
  }
})
