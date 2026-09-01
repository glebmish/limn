import { describe, it, expect } from 'vitest'
import { parseRoute, routeUrl, sameRoute, type Route } from '../src/renderer/router'

/** Splits a routeUrl() result into the (pathname, search) pair parseRoute() expects,
 *  the way the browser would hand them to us from window.location. */
function split(url: string): [string, string] {
  const i = url.indexOf('?')
  return i === -1 ? [url, ''] : [url.slice(0, i), url.slice(i)]
}

function roundTrip(route: Route, currentSearch = ''): Route | null {
  const [pathname, search] = split(routeUrl(route, currentSearch))
  return parseRoute(pathname, search)
}

describe('parseRoute / routeUrl round-trip', () => {
  it('dashboard', () => {
    const r: Route = { kind: 'dashboard' }
    expect(roundTrip(r)).toEqual(r)
  })

  it('hub', () => {
    const r: Route = { kind: 'hub', repo: '/Users/gleb/projects/limn' }
    expect(roundTrip(r)).toEqual(r)
  })

  it('review', () => {
    const r: Route = { kind: 'review', sessionId: 42 }
    expect(roundTrip(r)).toEqual(r)
  })

  it('transient with no base/compare', () => {
    const r: Route = { kind: 'transient', repo: '/Users/gleb/projects/limn' }
    expect(roundTrip(r)).toEqual(r)
  })

  it('transient with base and compare', () => {
    const r: Route = { kind: 'transient', repo: '/Users/gleb/projects/limn', base: 'main', compare: 'HEAD' }
    expect(roundTrip(r)).toEqual(r)
  })

  it('repo path with spaces and # characters survives the round trip', () => {
    const r: Route = { kind: 'hub', repo: '/Users/gleb/my projects/#1 limn' }
    expect(roundTrip(r)).toEqual(r)
  })
})

describe('routeUrl', () => {
  it('carries ?token= from currentSearch for a review route', () => {
    expect(routeUrl({ kind: 'review', sessionId: 7 }, '?token=abc')).toBe('/review/7?token=abc')
  })

  it('carries ?token= from currentSearch for a hub route, after repo', () => {
    expect(routeUrl({ kind: 'hub', repo: '/Users/gleb/limn' }, '?token=abc'))
      .toBe('/hub?repo=%2FUsers%2Fgleb%2Flimn&token=abc')
  })

  it('never emits ? with an empty query', () => {
    expect(routeUrl({ kind: 'dashboard' }, '')).toBe('/')
  })

  it('drops other params from currentSearch, keeping only token', () => {
    expect(routeUrl({ kind: 'dashboard' }, '?foo=bar&token=xyz')).toBe('/?token=xyz')
  })

  it('omits token entirely when currentSearch has none', () => {
    expect(routeUrl({ kind: 'dashboard' }, '?foo=bar')).toBe('/')
  })
})

describe('parseRoute null cases', () => {
  it('hub with missing repo -> null', () => {
    expect(parseRoute('/hub', '')).toBeNull()
  })

  it('unknown path -> null', () => {
    expect(parseRoute('/nope', '')).toBeNull()
  })

  it('non-numeric session id -> null', () => {
    expect(parseRoute('/review/abc', '')).toBeNull()
  })

  it('trailing garbage after session id -> null', () => {
    expect(parseRoute('/review/12/x', '')).toBeNull()
  })

  it('/review with no repo and no digits -> null', () => {
    expect(parseRoute('/review', '')).toBeNull()
  })
})

describe('parseRoute trailing slash tolerance', () => {
  it('/hub/ with repo behaves like /hub', () => {
    expect(parseRoute('/hub/', '?repo=%2Ffoo')).toEqual({ kind: 'hub', repo: '/foo' })
  })

  it('root with trailing slash still dashboard-equivalent via bare /', () => {
    expect(parseRoute('/', '')).toEqual({ kind: 'dashboard' })
  })
})

describe('sameRoute', () => {
  it('null equals only null', () => {
    expect(sameRoute(null, null)).toBe(true)
    expect(sameRoute(null, { kind: 'dashboard' })).toBe(false)
    expect(sameRoute({ kind: 'dashboard' }, null)).toBe(false)
  })

  it('dashboard equals dashboard', () => {
    expect(sameRoute({ kind: 'dashboard' }, { kind: 'dashboard' })).toBe(true)
  })

  it('different kinds are never equal', () => {
    expect(sameRoute({ kind: 'dashboard' }, { kind: 'hub', repo: '/foo' })).toBe(false)
  })

  it('hub compares repo', () => {
    expect(sameRoute({ kind: 'hub', repo: '/foo' }, { kind: 'hub', repo: '/foo' })).toBe(true)
    expect(sameRoute({ kind: 'hub', repo: '/foo' }, { kind: 'hub', repo: '/bar' })).toBe(false)
  })

  it('review compares sessionId', () => {
    expect(sameRoute({ kind: 'review', sessionId: 1 }, { kind: 'review', sessionId: 1 })).toBe(true)
    expect(sameRoute({ kind: 'review', sessionId: 1 }, { kind: 'review', sessionId: 2 })).toBe(false)
  })

  it('transient compares repo, base, and compare', () => {
    const a: Route = { kind: 'transient', repo: '/foo', base: 'main', compare: 'HEAD' }
    const b: Route = { kind: 'transient', repo: '/foo', base: 'main', compare: 'HEAD' }
    const c: Route = { kind: 'transient', repo: '/foo', base: 'main' }
    expect(sameRoute(a, b)).toBe(true)
    expect(sameRoute(a, c)).toBe(false)
  })
})
