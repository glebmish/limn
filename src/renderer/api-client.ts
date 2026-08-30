import { API_CHANNELS } from '../shared/ipc'
import type { OpEventMsg, OpResultMsg, RepoChangedMsg, RendererApi } from '../shared/ipc'

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

function ensureStream(): void {
  if (source) return
  source = new EventSource(withToken('/events'))
  source.onmessage = (e) => {
    let parsed: { channel: string; msg: AnyMsg }
    try { parsed = JSON.parse(e.data) } catch { return }
    const subs = subscribers[parsed.channel]
    if (subs) for (const cb of subs) cb(parsed.msg)
  }
  // EventSource auto-reconnects on error; nothing to do but keep it.
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
