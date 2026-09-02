import { hostForUrl } from '../server/guard.js'
import type { ServiceTarget } from './target.js'

export interface RpcResult<T> { value?: T; status: number }

/** Thrown from the `!res.ok` branch of `rpc()` — a server-side rejection (a thrown
 *  handler error, a non-2xx answer) as opposed to a transport failure (the fetch
 *  itself rejecting: connection refused, DNS, etc., which stay a bare `Error`). A
 *  caller that reaches a live server distinguishes the two: a server-side error is a
 *  verbatim, user-facing message (`limn: <message>`); a transport failure means the
 *  server it just probed as healthy is no longer reachable and gets its own note. */
export class RpcError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'RpcError'
    this.status = status
  }
}

/** POST `/rpc/<channel>` on a running service — the header/host rules shared by every
 *  CLI→service call (`issueRemote` in open.ts, the `config` prefs store): a Bearer
 *  token header when the target has one, never a `?token=` (that would land in logs
 *  and shell history), and the same `{ value }` / `{ error }` envelope shape. Status
 *  is checked before JSON.parse so an error page (a proxy's HTML, say) on a non-2xx
 *  answer can't blow up as a parse exception; a thrown handler error on the service
 *  arrives here as `{ error }` on a non-2xx response and is rethrown as an `RpcError`
 *  (a transport rejection — the fetch call itself throwing — stays a bare `Error`). */
export async function rpc<T>(t: ServiceTarget, channel: string, args: unknown[]): Promise<RpcResult<T>> {
  const res = await fetch(`http://${hostForUrl(t.host)}:${t.port}/rpc/${channel}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(t.token ? { Authorization: `Bearer ${t.token}` } : {}) },
    body: JSON.stringify(args)
  })
  if (!res.ok) {
    const body = await res.json().catch(() => null) as { error?: string } | null
    throw new RpcError(body?.error || `${channel} failed (${res.status})`, res.status)
  }
  const body = (await res.json()) as { value?: T }
  return { value: body.value, status: res.status }
}
