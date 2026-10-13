import type { StateCreator } from 'zustand'
import type { FileDiff, ViewMark } from '../../shared/types'
import { api } from '../lib/api'
import type { AppStore } from './index'
import { useStore } from './index'
import { UNIFIED, type Stack } from '../../shared/diffStack'
import { sameStack } from '../lib/stack'
import { collapseCompletedSections, fileIsExcluded, viewMarkFor } from './derive'

// ── promoted persist helpers ─────────────────────────────────
// These were closures over set/get inside the store factory; they now reach the
// store via useStore.getState() (the step-4/6 pattern) so the persist chain still
// funnels through get().materialize() — now across a named import boundary. The
// viewed/exclude mark is always set in state BEFORE these run, so the wholesale
// `loaded` swap inside materialize() keeps it.

// ── viewed-map saves: one in flight, newest map wins ─────────
// The server REPLACES the whole viewed map on every save, so two saves that land out
// of order (two quick ticks over a slow link) would leave the older map on disk and
// silently un-tick the newer file. One flight at a time; whatever was queued behind it
// collapses into a single follow-up carrying the newest map. Queued per session, so a
// tick on the review the reviewer just left still reaches ITS session.
let viewedFlight: Promise<void> | null = null
const viewedNext = new Map<number, Record<string, ViewMark>>()

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Queue a full viewed-map save for session `id`. Resolves once this map (or a newer
 *  one queued after it) has been written; a failed save goes to the error strip. */
export function saveViewedAt(id: number, viewedAt: Record<string, ViewMark>): Promise<void> {
  viewedNext.set(id, viewedAt)
  if (viewedFlight) return viewedFlight
  const flight = (async () => {
    try {
      for (let job = viewedNext.entries().next(); !job.done; job = viewedNext.entries().next()) {
        const [jobId, map] = job.value
        viewedNext.delete(jobId)
        try { await api().saveUiState(jobId, { viewedAt: map }) } catch (err) { useStore.setState({ error: errText(err) }) }
      }
    } finally {
      viewedFlight = null
    }
  })()
  viewedFlight = flight
  return flight
}

// ── tick bookkeeping for reloads ─────────────────────────────
// A reload answers with the server's viewed map as of when it was READ; a tick made
// while it was in flight is not in it. Every local viewed change bumps a generation
// and stamps the paths it touched, so reload can tell whether — and which — local
// marks are newer than its snapshot.
let viewedGen = 0
const touchedAt = new Map<string, number>()

/** Record a local change to these paths' viewed marks. */
export function touchViewed(paths: string[]): void {
  viewedGen++
  for (const p of paths) touchedAt.set(p, viewedGen)
}

/** The current tick generation — capture it before a reload's request goes out. */
export function viewedGeneration(): number {
  return viewedGen
}

/** The viewed map a reload that started at generation `since` should install: the
 *  server's, with every path the reviewer touched since then taken from `local`
 *  (local wins — including an un-tick). `null` when nothing was touched (replace). */
export function mergeViewedSince(since: number, server: Record<string, ViewMark>, local: Record<string, ViewMark>): Record<string, ViewMark> | null {
  if (viewedGen === since) return null
  const out = { ...server }
  for (const [p, g] of touchedAt) {
    if (g <= since) continue
    if (local[p]) out[p] = local[p]
    else delete out[p]
  }
  return out
}

const persistUi = async (): Promise<void> => {
  const id = await useStore.getState().materialize()        // first viewed mark mints the session
  if (id == null) return
  await saveViewedAt(id, useStore.getState().viewedAt)
}

/** The review's default stack, remembered with the session (design board 13: "the
 *  default is whichever file's stack you chose to spread"). The first spread on a
 *  transient review mints the session, exactly like the first viewed mark. */
const persistStack = async (): Promise<void> => {
  const id = await useStore.getState().materialize()
  if (id == null) return
  try { await api().saveUiState(id, { diffStack: useStore.getState().diffStack }) } catch (err) { useStore.setState({ error: errText(err) }) }
}

const persistExcluded = async (): Promise<void> => {
  const id = await useStore.getState().materialize()        // first exclude toggle mints the session
  if (id == null) return
  try { await api().saveUiState(id, { fileExcluded: useStore.getState().loaded?.state.fileExcluded ?? {} }) } catch (err) { useStore.setState({ error: errText(err) }) }
}

/** Drop a focus hold when it sits on one of the files just marked viewed — a focus
 *  target force-shows its file's body and force-opens its section, so a Viewed tick
 *  on the very file (or a section containing it) you jumped to would otherwise
 *  leave it force-open even though it now reads done. Shared by toggleViewed
 *  (single file) and setSectionViewed (a section's files). */
function releaseHold(ft: { file?: string; sectionId?: string } | null, paths: string[]): typeof ft {
  return ft?.file && paths.includes(ft.file) ? null : ft
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
  /** the review's default diff stack — which sheets are out beside current and what
   *  Unified is measured against. Every file without an override shows this. Loaded
   *  from `state.diffStack`; written by a spread. */
  diffStack: Stack
  /** per-file stacks (path → stack), from the file's own strip and captions. In
   *  memory only; cleared wholesale by a spread. */
  fileStack: Record<string, Stack>

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
  /** One file's own stack. An override equal to the default is dropped rather than
   *  stored, so the ✓ (which shows while a file differs) goes away by itself. */
  setFileStack(path: string, stack: Stack): void
  /** ✓ — make every file show this file's stack: it becomes the review's default
   *  (persisted) and every override is dropped. */
  spreadStack(path: string): void
  /** Set the default outright (⇧ + key, dev hooks, "Review commits"). */
  setDefaultStack(stack: Stack): void
}

export const createProgressSlice: StateCreator<AppStore, [], [], ProgressSlice> = (set, get) => ({
  viewedAt: {},
  collapsed: new Set<string>(),
  expanded: new Set<string>(),
  cur: null,
  curFile: null,
  focusTarget: null,
  docPath: null,
  diffStack: UNIFIED,
  fileStack: {},

  toggleViewed(file, currentlyViewed) {
    const viewedAt = { ...get().viewedAt }
    // unchecking removes the record; checking (or re-checking after drift) snapshots
    // the current head AND the file's on-disk content hash, so later commits or
    // uncommitted edits both re-flag it.
    if (currentlyViewed) delete viewedAt[file]
    else viewedAt[file] = viewMarkFor(get().loaded, file)
    const expanded = collapseCompletedSections(get().loaded, viewedAt, get().expanded)
    // the tick ends the focus hold on this file — see releaseHold's doc comment.
    const focusTarget = releaseHold(get().focusTarget, [file])
    touchViewed([file])
    set({ viewedAt, expanded, focusTarget })
    void persistUi()
  },

  toggleExcluded(file) {
    const loaded = get().loaded
    if (!loaded || !file.untracked) return  // tracked files can never be excluded
    const next = !fileIsExcluded(loaded, file)
    const fileExcluded = { ...(loaded.state.fileExcluded ?? {}), [file.path]: next }
    // excluding a file drops any viewed mark it carried — it leaves the review
    const viewedAt = { ...get().viewedAt }
    if (next && viewedAt[file.path]) { delete viewedAt[file.path]; touchViewed([file.path]) }
    set({ loaded: { ...loaded, state: { ...loaded.state, fileExcluded } }, viewedAt })
    void persistExcluded()
    if (next) void persistUi()
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
    // same hold-release as toggleViewed — see releaseHold's doc comment.
    const focusTarget = viewed ? releaseHold(get().focusTarget, paths) : get().focusTarget
    touchViewed(paths)
    set({ viewedAt, expanded, focusTarget })
    void persistUi()
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
  setFileStack(path, stack) {
    set((s) => {
      const fileStack = { ...s.fileStack }
      if (sameStack(stack, s.diffStack)) delete fileStack[path]
      else fileStack[path] = stack
      return { fileStack }
    })
  },
  spreadStack(path) {
    const s = get()
    get().setDefaultStack(s.fileStack[path] ?? s.diffStack)
  },
  setDefaultStack(stack) {
    // the default reads as "all files" — leaving overrides in place would make it
    // silently skip the very files the reader had singled out
    set({ diffStack: stack, fileStack: {} })
    void persistStack()
  }
})
