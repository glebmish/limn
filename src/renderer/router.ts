/** Screen-level routing for the SPA. Pure string in / string out — no window, no store.
 *  A later task (`routeFromState` / `installRouter`) wires these to the store and
 *  `window.history`; this file stays free of those imports so it can be unit-tested
 *  without jsdom. */

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
