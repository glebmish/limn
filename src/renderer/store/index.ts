import { create } from 'zustand'
import type { CliOpenMsg } from '../../shared/ipc'
import { api } from '../lib/api'
import { dev } from '../dev'
import { readOpenTicket, stripQuery } from '../boot-params'
import { dispatchInitialRoute } from '../router'
import type { OpsSlice } from './ops'
import { createOpsSlice, RESET_REVIEW_SURFACE } from './ops'
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
import type { EditsSlice } from './edits'
import { createEditsSlice } from './edits'

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
  viewMarkFor,
  sectionViewState,
  sectionDisclosureState,
  fileIsExcluded,
  genSessionLost,
  genCancelled,
  opForThread,
  reviewOp,
  anyExclusiveRunning,
  anyRunning,
  anySharedRunning,
  chatSendBlocked,
  willRunReadOnly,
  pendingApprovals,
  activeChat,
  chatsWithDraft
} from './derive'
export type { Density, Guidance, SectionDisclosureState, GenState, OpState } from './derive'
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
// Edits slice (in-place edits: flow-frame scope + save pipeline); re-export its type.
export type { EditsSlice } from './edits'
// App.tsx's push-event bridge, now named + unit-testable handlers.
export { handleOpEvent, handleOpResult, handleRepoChanged } from './bridge'

export interface AppStore extends OpsSlice, DashboardSlice, PrefsSlice, RepoSlice, ChatSlice, ReviewSlice, ProgressSlice, EditsSlice {
  screen: 'dashboard' | 'hub' | 'review'
  settingsOpen: boolean
  error: string | null

  /** set by the watcher (onRepoChanged) when the branch poller can no longer read
   *  the repo/branch — drives the muted "Live updates paused" titlebar pill; the
   *  string is the git error reason (tooltip). null = the watch is live. Cleared by a
   *  self-healing probe (a normal onRepoChanged) or any reload/navigation. */
  watchStopped: { reason: string } | null

  /** true until boot()'s one-time entry dispatch (cli ticket / URL route / dev hooks)
   *  has settled. Dashboard renders an empty placeholder while it's true, so a deep
   *  link (`/review/12`, `/hub?repo=`) never flashes the plain dashboard first. */
  booting: boolean

  boot(): Promise<void>
  /** Redeem a `limn open` ticket onto a screen. Returns the navigation it started so
   *  boot() can hold `booting` until it lands (the URL-route and dev-hook branches are
   *  awaited the same way) — the dispatch itself still happens synchronously. */
  applyCliOpen(msg: CliOpenMsg): Promise<void>
  backToDashboard(): Promise<void>
  /** mark the branch watcher stopped (carrying its reason) or live (null). */
  setWatchStopped(v: { reason: string } | null): void
  openSettings(): void
  closeSettings(): void
}

// boot() runs from Dashboard's mount effect, so it re-fires on every return to the
// dashboard. Reloading prefs + the dashboard list each time is the point; replaying
// the one-time entry paths is not — redeeming a spent ticket, re-dispatching the URL
// or re-firing a dev hook would yank the user off the screen they just came back to.
let bootedOnce = false
/** test-only: let a suite exercise boot()'s once-per-page-load path more than once. */
export function __resetBootOnce(): void { bootedOnce = false }

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
    ...createEditsSlice(...a),
    screen: 'dashboard',
    settingsOpen: false,
    error: null,
    watchStopped: null,
    booting: true,

    async boot() {
      // `booting` gates Dashboard's placeholder — cleared in `finally` so every exit
      // from the entry dispatch below (the early bootedOnce return included, and a
      // route dispatch that rejects) still settles it, and a deep link never sees the
      // plain dashboard flash before its own screen takes over.
      try {
        await get().loadPrefs()
        await get().loadDashboard()
        if (bootedOnce) return
        bootedOnce = true
        // Entry precedence, highest first: a cli:open ticket, then the URL's own route,
        // then the dev/screenshot hooks. Each is exclusive — the winner decides the screen.
        //
        // `limn open` puts a one-time ticket in the URL; redeem it after the dashboard
        // loads so its error toast survives loadDashboard's `error: null` reset.
        const ticket = readOpenTicket(window.location.search)
        if (ticket) {
          stripQuery(['open'])
          // The catch covers the REDEEM only (a spent/unknown ticket comes back null, a
          // dead server rejects): both mean no ticket, so the boot falls through and
          // `/review/12?open=<expired>` still opens the review the URL names instead of
          // stranding the address bar on a dead link. The navigation below is
          // deliberately outside it — a REDEEMED ticket claims the boot outright, so a
          // navigation that fails must not fall through and dispatch the URL route on
          // top of it. It is awaited so `booting` holds until that screen lands.
          const cli = await api().takeCliOpen(ticket).catch(() => null)
          if (cli) { await get().applyCliOpen(cli); return }
        }
        // a deep link (/review/<id>, /hub?repo=, /review?repo=&base=&compare=) — the
        // router reconciles the address bar if it turns out to be dead.
        if (await dispatchInitialRoute()) return
        // dev/screenshot: LIMN_OPEN_SESSION auto-resumes a seeded session onto Review
        const openSession = dev.openSession
        if (openSession) await get().resumeExisting(Number(openSession))
        // dev/screenshot: LIMN_OPEN_HUB lands on the repo hub for a given repo path
        const openHub = dev.openHub
        if (openHub) {
          if (dev.showArchived) set({ showArchived: true })
          await get().enterHub(openHub)
        }
      } finally {
        set({ booting: false })
      }
    },

    async applyCliOpen(msg) {
      if (msg.error) { set({ error: msg.error }); return }
      const repo = msg.repo
      if (!repo) return
      if (msg.hub) return get().enterHub(repo)                        // `limn --hub` → session list
      if (msg.fresh) return get().openReview(repo, { base: msg.baseInput, compare: msg.compareInput }, { fresh: true })
      if (msg.baseInput || msg.compareInput) return get().openReview(repo, { base: msg.baseInput, compare: msg.compareInput })
      // bare `limn` → behave like opening from the dashboard (the session hub if the
      // repo has sessions, else a transient review of the current branch)
      return get().openRepo(repo)
    },

    async backToDashboard() {
      set({
        screen: 'dashboard', loaded: null, sessionId: null, transientFresh: false,
        repoState: null, repoSessions: [], pendingDrift: null, watchStopped: null,
        // the session we just left must not disable the next review's Generate button
        // or flush its parked turn into whatever is opened next.
        ...RESET_REVIEW_SURFACE
      })
      await get().loadDashboard()
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
