import { create } from 'zustand'
import type { CliOpenMsg } from '../../shared/ipc'
import { api } from '../lib/api'
import { dev } from '../dev'
import type { OpsSlice } from './ops'
import { createOpsSlice } from './ops'
import type { DashboardSlice } from './dashboard'
import { createDashboardSlice } from './dashboard'
import type { PrefsSlice } from './prefs'
import { createPrefsSlice } from './prefs'
import type { RepoSlice } from './repo'
import { createRepoSlice } from './repo'
import type { ChatSlice } from './chat'
import { createChatSlice } from './chat'
import type { ReviewSlice } from './review'
import { createReviewSlice } from './review'
import type { ProgressSlice } from './progress'
import { createProgressSlice } from './progress'

// Re-export the pure derivation layer so every `from '../store'` import (renderer +
// tests) keeps resolving to the same names and types as when they lived in store.ts.
export {
  DRAFT_CHAT_ID,
  DENSITY,
  GUIDANCE,
  loadWarningStrip,
  checkoutGate,
  synthesizeSections,
  effectiveSections,
  fileViewed,
  diffHunksForMode,
  viewMarkFor,
  sectionViewState,
  sectionDisclosureState,
  fileIsExcluded,
  genSessionLost,
  genCancelled,
  genForLoaded,
  pendingApprovals,
  activeChat,
  chatsWithDraft
} from './derive'
export type { Density, Guidance, SectionDisclosureState, DiffMode, GenState } from './derive'
// The OPS slice (generation / operation lifecycle) lives in ./ops; re-export its
// public names so `from '../store'` keeps resolving newOpId + the startGenerate pair.
export { newOpId, startGenerate, startGenerateNow } from './ops'
export type { OpsSlice } from './ops'
// Dashboard + prefs slices (extracted from this barrel); re-export their types so
// `from '../store'` keeps resolving them.
export type { DashboardSlice } from './dashboard'
export type { PrefsSlice } from './prefs'
// Repo slice (active repo + git state + hub); re-export its type and the promoted
// helpers so tests can reach them and `from '../store'` keeps resolving them.
export type { RepoSlice } from './repo'
export { afterCheckout, loadRepoContext, openBranchReview } from './repo'
// Chat slice (active chat selection + draft composer + send paths); re-export its type.
export type { ChatSlice } from './chat'
// Review slice (loaded-review lifecycle + single-flight materialize) and progress slice
// (viewed marks + section disclosure + in-review nav + presentation); re-export their types.
export type { ReviewSlice } from './review'
export type { ProgressSlice } from './progress'
// App.tsx's push-event bridge, now named + unit-testable handlers.
export { handleOpEvent, handleOpResult, handleRepoChanged, handleCliOpen, handleSettingsOpen } from './bridge'

export interface AppStore extends OpsSlice, DashboardSlice, PrefsSlice, RepoSlice, ChatSlice, ReviewSlice, ProgressSlice {
  screen: 'dashboard' | 'hub' | 'review'
  settingsOpen: boolean
  error: string | null

  /** set by the watcher (onRepoChanged) when the branch poller can no longer read
   *  the repo/branch — drives the muted "Live updates paused" titlebar pill; the
   *  string is the git error reason (tooltip). null = the watch is live. Cleared by a
   *  self-healing probe (a normal onRepoChanged) or any reload/navigation. */
  watchStopped: { reason: string } | null

  boot(): Promise<void>
  applyCliOpen(msg: CliOpenMsg): void
  backToDashboard(): void
  /** mark the branch watcher stopped (carrying its reason) or live (null). */
  setWatchStopped(v: { reason: string } | null): void
  openSettings(): void
  closeSettings(): void
}

export const useStore = create<AppStore>()((...a) => {
  const [set, get] = a
  return {
    ...createOpsSlice(...a),
    ...createDashboardSlice(...a),
    ...createPrefsSlice(...a),
    ...createRepoSlice(...a),
    ...createChatSlice(...a),
    ...createReviewSlice(...a),
    ...createProgressSlice(...a),
    screen: 'dashboard',
    settingsOpen: false,
    error: null,
    watchStopped: null,

    async boot() {
      await get().loadPrefs()
      await get().loadDashboard()
      // Apply a pending CLI open AFTER the dashboard has loaded — otherwise its
      // error toast (e.g. "<dir> is not inside a git repository") races with,
      // and is clobbered by, loadDashboard's `error: null` reset. takeCliOpen
      // also marks the renderer ready, so later second-instance forwards arrive
      // live via onCliOpen (wired in App.tsx).
      try {
        const cli = await api().takeCliOpen()
        if (cli) get().applyCliOpen(cli)
      } catch { /* no pending cli open */ }
      // dev/screenshot: LIMN_OPEN_SESSION auto-resumes a seeded session onto Review
      const openSession = dev.openSession
      if (openSession) await get().resumeExisting(Number(openSession))
      // dev/screenshot: LIMN_OPEN_HUB lands on the repo hub for a given repo path
      const openHub = dev.openHub
      if (openHub) {
        if (dev.showArchived) set({ showArchived: true })
        await get().enterHub(openHub)
      }
    },

    applyCliOpen(msg) {
      if (msg.error) { set({ error: msg.error }); return }
      const repo = msg.repo
      if (!repo) return
      if (msg.hub) { void get().enterHub(repo); return }              // `limn --hub` → session list
      if (msg.fresh) { void get().openReview(repo, { base: msg.baseInput, compare: msg.compareInput }, { fresh: true }); return }
      if (msg.baseInput || msg.compareInput) { void get().openReview(repo, { base: msg.baseInput, compare: msg.compareInput }); return }
      // bare `limn` → behave like opening from the dashboard (resume the latest session
      // on the current branch, else a transient review)
      void get().openRepo(repo)
    },

    backToDashboard() {
      set({
        screen: 'dashboard', loaded: null, sessionId: null, transientFresh: false,
        repoState: null, repoSessions: [], pendingDrift: null, watchStopped: null
      })
      void get().loadDashboard()
    },

    setWatchStopped(v) {
      set({ watchStopped: v })
    },

    openSettings() {
      set({ settingsOpen: true })
    },

    closeSettings() {
      set({ settingsOpen: false })
    }
  }
})
