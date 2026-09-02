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
  backToDashboard(): Promise<void>
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
let installed = false

/** Boot seam: `store.boot()` calls this once per page load to apply whatever route
 *  the URL carries. Resolves `true` when a non-dashboard route was dispatched (so
 *  boot skips the dev hooks), `false` when the URL says nothing — including when no
 *  router is installed at all, which is how unit tests keep the old boot path. */
export function dispatchInitialRoute(): Promise<boolean> {
  return initialDispatch ? initialDispatch() : Promise.resolve(false)
}

/** Keep the address bar and the store in step, both ways. Called ONCE from main.tsx
 *  at module scope — never from an effect, where StrictMode would double-install it.
 *  A repeat call is ignored (Vite HMR re-evaluating main.tsx would otherwise stack a
 *  second subscription + popstate listener on the same page). */
export function installRouter(store: RouterStore, win: RouterWindow): void {
  if (installed) return
  installed = true
  // The URL is authoritative only for the initial dispatch (below). `last` therefore
  // starts at the store's own route — dashboard — so the state churn boot causes
  // before that dispatch can't push a bare `/` over the deep link we're about to open.
  let last: Route = routeFromState(store.getState())
  // How many URL-initiated navigations are in flight. A counter, not a flag: two Back
  // presses inside one round trip overlap, and the first one to finish must not
  // un-suppress the other's state landing (which would push during popstate handling).
  let suppressDepth = 0
  // What the address bar reads for the NEWEST URL-initiated navigation (null for a path
  // no route can parse). Whichever dispatch settles last reconciles against it.
  let pendingTarget: Route | null = null

  store.subscribe(() => {
    const next = routeFromState(store.getState())
    if (sameRoute(next, last)) return
    const prev = last
    last = next
    if (suppressDepth > 0) return
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
      case 'dashboard': await s.backToDashboard(); break
    }
  }

  /** Navigate to `route` without pushing (the URL is already there), then reconcile:
   *  if the store landed somewhere else — a dead /review/<id> leaves us on the
   *  dashboard, a transient pair resolves to a live session — replace the URL with
   *  where we actually are. `target` is what the address bar currently reads, which
   *  is `null` for a path no route can parse (always worth rewriting).
   *
   *  The reconcile belongs to whichever dispatch settles LAST, not to whichever started
   *  last: two Back presses can land out of order, and the one that finishes last is the
   *  one whose state the store ends up showing — so it owes the address bar. Reconciling
   *  mid-flight instead would read a store halfway through someone else's dispatch, so
   *  the one still running defers (`suppressDepth > 0`) and lets that one finish the job.
   *  The target it reconciles against is the NEWEST one — where the bar actually reads. */
  async function apply(route: Route, target: Route | null): Promise<void> {
    pendingTarget = target
    suppressDepth++
    try { await dispatch(route) } finally { suppressDepth-- }
    if (suppressDepth > 0) return
    const landed = routeFromState(store.getState())
    last = landed
    if (!sameRoute(landed, pendingTarget)) win.history.replaceState(null, '', routeUrl(landed, win.location.search))
  }

  win.addEventListener('popstate', () => {
    const parsed = parseRoute(win.location.pathname, win.location.search)
    void apply(parsed ?? { kind: 'dashboard' }, parsed)
  })

  initialDispatch = async () => {
    const route = parseRoute(win.location.pathname, win.location.search)
    // A URL no route can parse (/nope, /review/abc, /hub with no repo) renders the
    // dashboard, so say so in the bar — same reconcile the popstate path does. `/` and
    // `/?dev=…` parse AS the dashboard, so dev/screenshot boots are untouched.
    if (!route) {
      win.history.replaceState(null, '', routeUrl({ kind: 'dashboard' }, win.location.search))
      return false
    }
    if (route.kind === 'dashboard') return false
    await apply(route, route)
    return true
  }
}
