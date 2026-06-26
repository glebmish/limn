// Pure request guards for the web-serve mode — extracted so they can be unit
// tested without standing up the HTTP server (index.ts runs main() on import).

export function isLoopbackName(name: string): boolean {
  const n = name.toLowerCase().replace(/^\[|\]$/g, '')
  return n === 'localhost' || n === '127.0.0.1' || n === '::1'
}

/** Guard against cross-site drive-by (CSRF) and DNS-rebinding on the RPC/SSE
 *  surface. The `/rpc/*` endpoint runs the agent and mutates repos, so a same-site
 *  check is essential even on loopback: a malicious page the user visits can POST
 *  cross-origin `text/plain` (no CORS preflight) to 127.0.0.1.
 *  - Reject when an `Origin` is present and its host differs from the request Host.
 *  - When there is no token perimeter, additionally require a loopback `Host`
 *    (blocks DNS-rebinding, where Host is the attacker's domain pointed at 127.0.0.1).
 *    With a token set, the token is the perimeter and any Host (Tailscale name) is fine. */
export function sameSiteOk(headers: { host?: string; origin?: string }, hasToken: boolean): boolean {
  const host = (headers.host || '').toLowerCase()
  const origin = headers.origin
  if (typeof origin === 'string' && origin !== 'null') {
    try { if (new URL(origin).host.toLowerCase() !== host) return false }
    catch { return false }
  }
  if (!hasToken && !isLoopbackName(host.split(':')[0])) return false
  return true
}
