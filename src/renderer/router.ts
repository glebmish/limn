/** Screen-level routing for the SPA. `parseRoute` / `routeUrl` / `sameRoute` are pure
 *  string in / string out. `installRouter` wires them to the store and the history API,
 *  but takes both as PARAMETERS — this file imports neither, so the whole module still
 *  unit-tests under node with a hand-faked window. */

export type Route =
  | { kind: 'dashboard' }
  | { kind: 'hub'; repo: string }
  | { kind: 'review'; sessionId: number }
  | { kind: 'transient'; repo: string; base?: string; compare?: string }

/** Strip trailing slashes so `/hub/` behaves like `/hub` (but leave `/` as `/`). */
function normalizePath(pathname: string): string {
  return pathname.replace(/\/+$/, '') || '/'
}

export function parseRoute(pathname: string, search: string): Route | null {
  const path = normalizePath(pathname)
  const params = new URLSearchParams(search)

  if (path === '/') return { kind: 'dashboard' }

  if (path === '/hub') {
    const repo = params.get('repo')
    return repo ? { kind: 'hub', repo } : null
  }

  const reviewId = /^\/review\/(\d+)$/.exec(path)
  if (reviewId) return { kind: 'review', sessionId: Number(reviewId[1]) }

  if (path === '/review') {
    const repo = params.get('repo')
    if (!repo) return null
    const base = params.get('base')
    const compare = params.get('compare')
    return {
      kind: 'transient',
      repo,
      ...(base ? { base } : {}),
      ...(compare ? { compare } : {})
    }
  }

  return null
}

export function routeUrl(route: Route, currentSearch: string): string {
  const params = new URLSearchParams()
  let path: string

  switch (route.kind) {
    case 'dashboard':
      path = '/'
      break
    case 'hub':
      path = '/hub'
      params.set('repo', route.repo)
      break
    case 'review':
      path = `/review/${route.sessionId}`
      break
    case 'transient':
      path = '/review'
      params.set('repo', route.repo)
      if (route.base) params.set('base', route.base)
      if (route.compare) params.set('compare', route.compare)
      break
  }

  const token = new URLSearchParams(currentSearch).get('token')
  if (token) params.set('token', token)

  const qs = params.toString()
  return qs ? `${path}?${qs}` : path
}

export function sameRoute(a: Route | null, b: Route | null): boolean {
  if (a === null || b === null) return a === b
  if (a.kind !== b.kind) return false
  switch (a.kind) {
    case 'dashboard':
      return true
    case 'hub':
      return a.repo === (b as typeof a).repo
    case 'review':
      return a.sessionId === (b as typeof a).sessionId
    case 'transient': {
      const other = b as typeof a
      return a.repo === other.repo && a.base === other.base && a.compare === other.compare
    }
  }
}

/** The store fields + navigation actions the router reads — structurally a subset of
 *  AppStore, spelled out here so router.ts needn't import the store. */
export interface RouterState {
  screen: 'dashboard' | 'hub' | 'review'
  sessionId: number | null
  repo: string | null
  /** the review's compare ref (openReview/resumeExisting set it from the loaded review) */
  branch: string
  base: string
  resumeExisting(sessionId: number): Promise<void>
  enterHub(repoPath?: string): Promise<void>
  openReview(repo: string, refs?: { base?: string; compare?: string }, opts?: { fresh?: boolean }): Promise<void>
  backToDashboard(): void
}

export interface RouterStore {
  getState(): RouterState
  subscribe(listener: () => void): () => void
}

/** The slice of `window` the router touches (so tests can hand it a fake). */
export interface RouterWindow {
  location: { pathname: string; search: string }
  history: {
    pushState(data: unknown, unused: string, url: string): void
    replaceState(data: unknown, unused: string, url: string): void
  }
  addEventListener(type: 'popstate', listener: () => void): void
}

/** Which URL the current store state stands for. A hub/review screen with no repo
 *  can't be addressed, so it reads as the dashboard rather than a broken link. */
export function routeFromState(s: Pick<RouterState, 'screen' | 'sessionId' | 'repo' | 'branch' | 'base'>): Route {
  if (s.screen === 'hub') return s.repo ? { kind: 'hub', repo: s.repo } : { kind: 'dashboard' }
  if (s.screen === 'review') {
    if (s.sessionId != null) return { kind: 'review', sessionId: s.sessionId }
    if (!s.repo) return { kind: 'dashboard' }
    // transient review: no session row yet, so the ref pair IS the address
    return {
      kind: 'transient',
      repo: s.repo,
      ...(s.base ? { base: s.base } : {}),
      ...(s.branch ? { compare: s.branch } : {})
    }
  }
  return { kind: 'dashboard' }
}

let initialDispatch: (() => Promise<boolean>) | null = null

/** Boot seam: `store.boot()` calls this once per page load to apply whatever route
 *  the URL carries. Resolves `true` when a non-dashboard route was dispatched (so
 *  boot skips the dev hooks), `false` when the URL says nothing — including when no
 *  router is installed at all, which is how unit tests keep the old boot path. */
export function dispatchInitialRoute(): Promise<boolean> {
  return initialDispatch ? initialDispatch() : Promise.resolve(false)
}

/** Keep the address bar and the store in step, both ways. Called ONCE from main.tsx
 *  at module scope — never from an effect, where StrictMode would double-install it. */
export function installRouter(store: RouterStore, win: RouterWindow): void {
  // The URL is authoritative only for the initial dispatch (below). `last` therefore
  // starts at the store's own route — dashboard — so the state churn boot causes
  // before that dispatch can't push a bare `/` over the deep link we're about to open.
  let last: Route = routeFromState(store.getState())
  // set while a popstate or the initial dispatch is being applied: the address bar
  // already says where we're going, so the subscription only records the route.
  let suppress = false

  store.subscribe(() => {
    const next = routeFromState(store.getState())
    if (sameRoute(next, last)) return
    const prev = last
    last = next
    if (suppress) return
    const url = routeUrl(next, win.location.search)
    // materialize: the transient review already on screen just got a session id.
    // Same page, new address — upgrade the entry rather than adding a history step
    // (Back would otherwise return to the pre-session URL of the very same review).
    const upgrade = prev.kind === 'transient' && next.kind === 'review' && prev.repo === store.getState().repo
    if (upgrade) win.history.replaceState(null, '', url)
    else win.history.pushState(null, '', url)
  })

  async function dispatch(route: Route): Promise<void> {
    const s = store.getState()
    switch (route.kind) {
      case 'review': await s.resumeExisting(route.sessionId); break
      case 'hub': await s.enterHub(route.repo); break
      case 'transient': await s.openReview(route.repo, { base: route.base, compare: route.compare }); break
      case 'dashboard': s.backToDashboard(); break
    }
  }

  /** Navigate to `route` without pushing (the URL is already there), then reconcile:
   *  if the store landed somewhere else — a dead /review/<id> leaves us on the
   *  dashboard, a transient pair resolves to a live session — replace the URL with
   *  where we actually are. `target` is what the address bar currently reads, which
   *  is `null` for a path no route can parse (always worth rewriting). */
  async function apply(route: Route, target: Route | null): Promise<void> {
    suppress = true
    try { await dispatch(route) } finally { suppress = false }
    const landed = routeFromState(store.getState())
    last = landed
    if (!sameRoute(landed, target)) win.history.replaceState(null, '', routeUrl(landed, win.location.search))
  }

  win.addEventListener('popstate', () => {
    const parsed = parseRoute(win.location.pathname, win.location.search)
    void apply(parsed ?? { kind: 'dashboard' }, parsed)
  })

  initialDispatch = async () => {
    const route = parseRoute(win.location.pathname, win.location.search)
    if (!route || route.kind === 'dashboard') return false
    await apply(route, route)
    return true
  }
}
