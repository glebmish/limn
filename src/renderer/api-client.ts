import { API_CHANNELS } from '../shared/ipc'
import type { OpEventMsg, OpResultMsg, RepoChangedMsg, RendererApi } from '../shared/ipc'
// The reconnect resync reaches back into the store (see `ensureStream`'s onopen): a
// gap in the push stream is only recoverable by refetching what the page is showing,
// and the store owns that path. A static import — only the `getState()` CALL is
// deferred to the handler, so nothing is read from the store at install time.
import { useStore } from './store'

// The only `window.api` backing: RendererApi carried over HTTP (request/response
// channels) + Server-Sent Events (the push streams). Installed by main.tsx before render.

// A token may be passed in the page URL (?token=…); persist it so reloads keep it.
function authToken(): string {
  const fromUrl = new URLSearchParams(window.location.search).get('token')
  if (fromUrl) {
    try { sessionStorage.setItem('limn-token', fromUrl) } catch { /* private mode */ }
    return fromUrl
  }
  try { return sessionStorage.getItem('limn-token') || '' } catch { return '' }
}

const TOKEN = authToken()

/** EventSource cannot set headers, so the SSE stream is the one place the token has to
 *  ride in the URL. Everything else uses the Authorization header — a query token ends
 *  up in the browser's history, in referrers, and in any proxy log on the way. */
function withToken(url: string): string {
  return TOKEN ? url + (url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(TOKEN) : url
}

async function rpc(channel: string, args: unknown[]): Promise<unknown> {
  const res = await fetch('/rpc/' + encodeURIComponent(channel), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}) },
    body: JSON.stringify(args)
  })
  let payload: { value?: unknown; error?: string }
  try { payload = await res.json() } catch { throw new Error(`${channel}: ${res.status} ${res.statusText}`) }
  if (!res.ok || payload.error) throw new Error(payload.error || `${channel}: ${res.status}`)
  return payload.value
}

// ── one SSE connection, fanned out to per-channel subscribers ──
type AnyMsg = OpEventMsg | OpResultMsg | RepoChangedMsg
const subscribers: Record<string, Set<(msg: AnyMsg) => void>> = {}
let source: EventSource | null = null

/** How long to wait before replacing a stream the browser failed for good. Matches
 *  the `retry: 2000` the server sends for the drops the browser handles itself. */
const REBUILD_DELAY_MS = 2000
/** true once the page has had a live stream: every open after that closed a gap. */
let everOpened = false

/** Resync retry backoff: first retry after 1s, doubling, capped. */
const RESYNC_RETRY_BASE_MS = 1000
const RESYNC_RETRY_MAX_MS = 30_000
let resyncAttempt = 0
let resyncTimer: ReturnType<typeof setTimeout> | null = null

/** Refetch what the page shows after a gap in the push stream. A failed refetch is
 *  retried with backoff — otherwise an op that finished in the gap keeps spinning,
 *  and an approval raised in it never shows, until something else happens to reload.
 *  A fresh open restarts the schedule. */
function resync(): void {
  if (resyncTimer) { clearTimeout(resyncTimer); resyncTimer = null }
  void useStore.getState().refreshLoaded({ resync: true }).then((ok) => {
    if (ok !== false) { resyncAttempt = 0; return }
    const delay = Math.min(RESYNC_RETRY_MAX_MS, RESYNC_RETRY_BASE_MS * 2 ** resyncAttempt++)
    resyncTimer = setTimeout(resync, delay)
  })
}

function ensureStream(): void {
  if (source) return
  const es = new EventSource(withToken('/events'))
  source = es
  es.onmessage = (e) => {
    let parsed: { channel: string; msg: AnyMsg }
    try { parsed = JSON.parse(e.data) } catch { return }
    const subs = subscribers[parsed.channel]
    if (subs) for (const cb of subs) cb(parsed.msg)
  }
  es.onopen = () => {
    // Only ONE open needs no catch-up: the page's own first connection, made over the
    // same round trip that fetched the screen. Every other one — after a drop, or
    // after a failed stream was replaced — sits at the end of a gap, and nothing
    // replays what the server pushed during it: the frames carry no `id:`, so there
    // is no Last-Event-ID replay. Refetching what is on screen is the resync (it
    // re-adopts the session's live ops and reconciles the ones this tab already
    // knows), and it is a no-op when nothing is loaded.
    if (everOpened) { resyncAttempt = 0; resync() }
    everOpened = true
  }
  es.onerror = () => {
    // CONNECTING: an ordinary drop. The browser reconnects on its own and `onopen`
    // above closes the gap. CLOSED: the connection FAILED — a response that is not
    // 200 `text/event-stream` (the service's own 401/403, or anything a proxy or
    // captive portal injects on the way) — and per the HTML spec the browser never
    // retries that one. Without a replacement the tab goes silent for good: no
    // op:event, no op:result, a finished generation stuck showing as running.
    if (es.readyState !== EventSource.CLOSED || source !== es) return
    es.close()
    source = null
    // A stream that failed before it ever opened still leaves a gap behind it (this
    // one starts at the RPC load), so the replacement's open must resync even though
    // it is the first open the page ever gets.
    everOpened = true
    setTimeout(ensureStream, REBUILD_DELAY_MS)
  }
}

function subscribe<T extends AnyMsg>(channel: string, cb: (msg: T) => void): () => void {
  ensureStream()
  const set = (subscribers[channel] ??= new Set())
  set.add(cb as (msg: AnyMsg) => void)
  return () => { set.delete(cb as (msg: AnyMsg) => void) }
}

export function installApiClient(): void {
  const api: Record<string, unknown> = {}
  for (const ch of API_CHANNELS) {
    api[ch] = (...args: unknown[]) => rpc(ch, args)
  }
  // pickRepo is inherently client-side on the web — there is no server dialog.
  // Prompt for a path on the host the server runs on.
  api.pickRepo = async () => {
    const dir = window.prompt('Repository path on this machine:', '')
    return dir && dir.trim() ? dir.trim() : null
  }
  api.onOpEvent = (cb: (msg: OpEventMsg) => void) => subscribe('op:event', cb)
  api.onOpResult = (cb: (msg: OpResultMsg) => void) => subscribe('op:result', cb)
  api.onRepoChanged = (cb: (msg: RepoChangedMsg) => void) => subscribe('repo:changed', cb)

  ;(window as unknown as { api: RendererApi }).api = api as unknown as RendererApi
}
