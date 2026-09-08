import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Finding 111: the SPA's one SSE stream (src/renderer/api-client.ts) is the only way
// op:event / op:result / repo:changed reach the page. These drive the real client
// through a fake EventSource — the browser's, and the reconnect semantics the HTML
// spec gives it, are the whole subject of the finding:
//   • readyState CONNECTING on error → the browser is retrying; leave it alone.
//   • readyState CLOSED on error     → the connection FAILED (non-200 / wrong
//     content-type) and the browser never retries; the client must rebuild it.
//   • any open after the first       → a gap just closed, and the server sends no
//     `id:` frames, so nothing replays: the page has to refetch its state.

class FakeEventSource {
  static readonly instances: FakeEventSource[] = []
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 2
  readyState = 0
  closed = false
  onmessage: ((ev: { data: string }) => unknown) | null = null
  onopen: ((ev: unknown) => unknown) | null = null
  onerror: ((ev: unknown) => unknown) | null = null
  constructor(readonly url: string) { FakeEventSource.instances.push(this) }
  close(): void { this.closed = true; this.readyState = FakeEventSource.CLOSED }
  /** the browser's own state machine, as far as these tests care */
  open(): void { this.readyState = FakeEventSource.OPEN; this.onopen?.({}) }
  fail(): void { this.readyState = FakeEventSource.CLOSED; this.onerror?.({}) }
  drop(): void { this.readyState = FakeEventSource.CONNECTING; this.onerror?.({}) }
}

const g = globalThis as unknown as { window: unknown; EventSource: unknown }
g.window = { location: { search: '' } }
g.EventSource = FakeEventSource

/** A fresh module graph per test: `source` is module state in api-client, and the
 *  store singleton has to come from the SAME graph for a stub to be visible to it. */
async function boot(): Promise<{ refreshLoaded: ReturnType<typeof vi.fn> }> {
  vi.resetModules()
  FakeEventSource.instances.length = 0
  const { useStore } = await import('../src/renderer/store')
  const { installApiClient } = await import('../src/renderer/api-client')
  installApiClient()
  const refreshLoaded = vi.fn(async () => {})
  useStore.setState({ refreshLoaded: refreshLoaded as never })
  // subscribing is what opens the stream (App.tsx does exactly this on mount)
  window.api.onOpEvent(() => {})
  return { refreshLoaded }
}

const streams = FakeEventSource.instances

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('SSE stream recovery (finding 111)', () => {
  it('rebuilds a stream the browser failed for good', async () => {
    await boot()
    expect(streams).toHaveLength(1)

    streams[0].fail() // 401/403/proxy junk: readyState CLOSED, no browser retry
    vi.advanceTimersByTime(2000)

    expect(streams).toHaveLength(2)
    expect(streams[1].url).toBe(streams[0].url)
    expect(streams[0].closed).toBe(true)
  })

  it('leaves a transient drop to the browser — no second stream', async () => {
    await boot()

    streams[0].drop() // readyState CONNECTING: the browser reconnects on its own
    vi.advanceTimersByTime(10_000)

    expect(streams).toHaveLength(1)
    expect(streams[0].closed).toBe(false)
  })

  it('refetches the page state on every open after the first', async () => {
    const { refreshLoaded } = await boot()

    streams[0].open() // the page's first connection: nothing was missed
    expect(refreshLoaded).not.toHaveBeenCalled()

    streams[0].open() // the browser reconnected after a drop: the gap dropped events
    expect(refreshLoaded).toHaveBeenCalledTimes(1)
  })

  it('resyncs after a rebuild too — the gap is the same gap', async () => {
    const { refreshLoaded } = await boot()
    streams[0].open()

    streams[0].fail()
    vi.advanceTimersByTime(2000)
    streams[1].open()

    expect(refreshLoaded).toHaveBeenCalledTimes(1)
  })

  it('resyncs after a stream that failed before it ever opened', async () => {
    const { refreshLoaded } = await boot()

    // the 401 / proxy case: the very first connection never reaches OPEN, so its
    // replacement's open is the page's first — but a gap still ran from the RPC load
    // to that open, and whatever the server pushed in it is gone.
    streams[0].fail()
    vi.advanceTimersByTime(2000)
    streams[1].open()

    expect(refreshLoaded).toHaveBeenCalledTimes(1)
  })

  it('keeps delivering events to subscribers over the rebuilt stream', async () => {
    await boot()
    const seen: unknown[] = []
    window.api.onOpResult((msg) => { seen.push(msg) })

    streams[0].fail()
    vi.advanceTimersByTime(2000)
    streams[1].onmessage?.({ data: JSON.stringify({ channel: 'op:result', msg: { opId: 'o1' } }) })

    expect(seen).toEqual([{ opId: 'o1' }])
  })
})
