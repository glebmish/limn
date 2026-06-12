import { create } from 'zustand'
import type { LoadedReview } from '../shared/ipc'
import type { Comment, EngineEvent, EngineId, FileDiff, RepoInfo, Section } from '../shared/types'

export type Density = 'compact' | 'comfortable' | 'spacious'
export type Guidance = 'minimal' | 'guided' | 'narrated'

export const ACCENTS: string[][] = [
  ['#3a7d54', '#2c6342', '#e7efe9', '#bcd6c5'],
  ['#46505d', '#33363d', '#ecedf0', '#d2d6dc'],
  ['#3a6ea5', '#2b5680', '#e6eef6', '#bdd2e6'],
  ['#8a5a3c', '#6c4327', '#f3e9e0', '#e0cbb8']
]

let opCounter = 0
export function newOpId(): string {
  return `op-${Date.now()}-${++opCounter}`
}

/** Fallback grouping before AI annotations exist: one section per top-level dir. */
export function synthesizeSections(files: FileDiff[]): Section[] {
  const byDir = new Map<string, string[]>()
  for (const f of files) {
    const dir = f.path.includes('/') ? f.path.split('/')[0] : 'top-level'
    byDir.set(dir, [...(byDir.get(dir) ?? []), f.path])
  }
  return [...byDir.entries()].map(([dir, paths], i) => ({
    id: `dir-${dir}`,
    name: dir === 'top-level' ? 'Top-level files' : dir + '/',
    desc: '',
    what: '',
    files: paths,
    order: i + 1,
    flags: []
  }))
}

export function effectiveSections(loaded: LoadedReview | null): Section[] {
  if (!loaded) return []
  return loaded.state.annotations?.sections ?? synthesizeSections(loaded.skeleton.files)
}

export interface GenState {
  running: boolean
  opId: string | null
  kind: 'review' | 'chat' | 'fix' | null
  log: EngineEvent[]
  error: string | null
}

interface AppStore {
  screen: 'welcome' | 'setup' | 'review'
  recents: string[]
  repo: string | null
  repoInfo: RepoInfo | null
  branch: string
  base: string
  engine: EngineId
  sessionId: number | null
  loaded: LoadedReview | null
  error: string | null

  viewedAt: Record<string, string>
  reviewedSections: Set<string>
  collapsed: Set<string>
  cur: string | null

  density: Density
  guidance: Guidance
  accent: string[]

  gen: GenState

  boot(): Promise<void>
  pickRepo(): Promise<void>
  openRepoPath(path: string): Promise<void>
  setBranch(b: string): void
  setBase(b: string): void
  setEngine(e: EngineId): void
  startReview(): Promise<void>
  reload(): Promise<void>
  backToSetup(): void
  toggleViewed(file: string, currentlyViewed: boolean): void
  markReviewed(id: string): void
  openSection(id: string): void
  setCur(id: string): void
  setTweak(key: 'density' | 'guidance' | 'accent', value: unknown): void
  startOp(kind: 'review' | 'chat' | 'fix', opId: string): void
  pushOpEvent(ev: EngineEvent): void
  finishOp(error?: string): void
  setComments(comments: Comment[]): void
}

export const useStore = create<AppStore>((set, get) => {
  const persistUi = (): void => {
    const { sessionId, viewedAt, reviewedSections } = get()
    if (sessionId == null) return
    void window.api.saveUiState(sessionId, { viewedAt, reviewedSections: [...reviewedSections] })
  }

  return {
    screen: 'welcome',
    recents: [],
    repo: null,
    repoInfo: null,
    branch: '',
    base: '',
    engine: 'claude',
    sessionId: null,
    loaded: null,
    error: null,

    viewedAt: {},
    reviewedSections: new Set<string>(),
    collapsed: new Set<string>(),
    cur: null,

    density: 'comfortable',
    guidance: 'guided',
    accent: ACCENTS[0],

    gen: { running: false, opId: null, kind: null, log: [], error: null },

    async boot() {
      try {
        // one-time migration of localStorage tweaks into the db
        if (!localStorage.getItem('lr-prefs-migrated')) {
          for (const key of ['density', 'guidance', 'accent', 'engine']) {
            const v = localStorage.getItem(`lr-${key}`)
            if (v != null) await window.api.setPref(key, v)
          }
          localStorage.setItem('lr-prefs-migrated', '1')
        }
        const prefs = await window.api.getPrefs()
        const parse = <T,>(k: string, fallback: T): T => {
          try { return prefs[k] != null ? (JSON.parse(prefs[k]) as T) : fallback } catch { return fallback }
        }
        set({
          density: parse<Density>('density', 'comfortable'),
          guidance: parse<Guidance>('guidance', 'guided'),
          accent: parse<string[]>('accent', ACCENTS[0]),
          // legacy formats: bare 'codex' (seeded from old config.json) or JSON '"codex"' (localStorage migration)
          engine: prefs['engine'] === 'codex' || prefs['engine'] === '"codex"' ? 'codex' : parse<EngineId>('engine', 'claude')
        })
      } catch { /* prefs unavailable — visual defaults stand */ }
      try {
        set({ recents: await window.api.recentRepos() })
      } catch {
        set({ recents: [] })
      }
    },

    async pickRepo() {
      const path = await window.api.pickRepo()
      if (path) await get().openRepoPath(path)
    },

    async openRepoPath(path) {
      try {
        const info = await window.api.openRepo(path)
        set({
          repo: path, repoInfo: info, error: null, screen: 'setup',
          branch: info.current !== 'HEAD' ? info.current : info.branches[0] ?? '',
          base: info.defaultBase
        })
      } catch (err) {
        set({ error: err instanceof Error ? err.message : String(err) })
      }
    },

    setBranch(b) {
      set({ branch: b })
    },
    setBase(b) {
      set({ base: b })
    },
    setEngine(e) {
      void window.api.setPref('engine', JSON.stringify(e))
      set({ engine: e })
    },

    async startReview() {
      const { repo, branch, base, engine } = get()
      if (!repo || !branch || !base) return
      try {
        const { sessionId } = await window.api.startSession(repo, base, branch, engine)
        const loaded = await window.api.loadSession(sessionId)
        set({
          sessionId, loaded, error: null, screen: 'review',
          viewedAt: loaded.state.viewedAt,
          reviewedSections: new Set(loaded.state.reviewedSections),
          collapsed: new Set<string>(),
          cur: null,
          engine: loaded.state.engine ?? get().engine
        })
      } catch (err) {
        set({ error: err instanceof Error ? err.message : String(err) })
      }
    },

    async reload() {
      const { sessionId } = get()
      if (sessionId == null) return
      const loaded = await window.api.loadSession(sessionId)
      set({
        loaded,
        viewedAt: loaded.state.viewedAt,
        reviewedSections: new Set(loaded.state.reviewedSections)
      })
    },

    backToSetup() {
      set({ screen: 'setup', loaded: null, sessionId: null })
    },

    toggleViewed(file, currentlyViewed) {
      const viewedAt = { ...get().viewedAt }
      // unchecking removes the record; checking (or re-checking after drift) stamps the current head
      if (currentlyViewed) delete viewedAt[file]
      else viewedAt[file] = get().loaded?.skeleton.headSha ?? ''
      set({ viewedAt })
      persistUi()
    },

    markReviewed(id) {
      const reviewedSections = new Set(get().reviewedSections)
      reviewedSections.add(id)
      set({ reviewedSections })
      persistUi()
    },

    openSection(id) {
      const reviewedSections = new Set(get().reviewedSections)
      const collapsed = new Set(get().collapsed)
      reviewedSections.delete(id)
      collapsed.delete(id)
      set({ reviewedSections, collapsed, cur: id })
      persistUi()
    },

    setCur(id) {
      if (get().cur !== id) set({ cur: id })
    },

    setTweak(key, value) {
      void window.api.setPref(key, JSON.stringify(value))
      set({ [key]: value } as Partial<AppStore>)
    },

    startOp(kind, opId) {
      set({ gen: { running: true, opId, kind, log: [], error: null } })
    },

    pushOpEvent(ev) {
      const gen = get().gen
      if (!gen.running) return
      set({ gen: { ...gen, log: [...gen.log.slice(-200), ev] } })
    },

    finishOp(error) {
      const gen = get().gen
      set({ gen: { ...gen, running: false, error: error ?? null } })
    },

    setComments(comments) {
      const loaded = get().loaded
      if (!loaded) return
      set({ loaded: { ...loaded, state: { ...loaded.state, comments } } })
    }
  }
})
