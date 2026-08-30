// Pure request guards for the HTTP service — extracted so they can be unit
// tested without standing up a server (see startServer in http.ts).

/** The vanity name the service advertises. Browsers resolve it to loopback under
 *  RFC 6761 without consulting DNS, so it needs no hosts-file entry. */
export const CANONICAL_HOST = 'limn.localhost'

/** Strictly a loopback *address*: an IP literal or the reserved `localhost` name.
 *  Use this for anything we hand to `listen()` — a bind name is resolved by the
 *  system resolver, not by RFC 6761, so `something.localhost` is not guaranteed
 *  to land on loopback and must not be treated as a safe bind target. */
export function isLoopbackName(name: string): boolean {
  const n = name.toLowerCase().replace(/^\[|\]$/g, '')
  return n === 'localhost' || n === '127.0.0.1' || n === '::1'
}

/** A `Host` *header* we accept as same-machine. Wider than isLoopbackName by exactly
 *  one name — CANONICAL_HOST — because that is the address we tell browsers to use
 *  and they resolve it themselves. Deliberately NOT the whole `.localhost` TLD: a
 *  client that resolves it through ordinary DNS would let an attacker serve a page
 *  from `attacker.localhost`, rebind it to 127.0.0.1, and satisfy both this check
 *  and the Origin-equals-Host check. Hostname only — strip the port first. */
export function isLoopbackHost(host: string): boolean {
  return isLoopbackName(host) || host.toLowerCase() === CANONICAL_HOST
}

/** Only endpoints that expose repository state or execute actions need auth.
 * Static app assets must remain readable so the token-aware client can boot. */
export function isProtectedPath(pathname: string): boolean {
  return pathname === '/events' || pathname.startsWith('/rpc/')
}

/** Guard against cross-site drive-by (CSRF) and DNS-rebinding on the RPC/SSE
 *  surface. The `/rpc/*` endpoint runs the agent and mutates repos, so a same-site
 *  check is essential even on loopback: a malicious page the user visits can POST
 *  cross-origin `text/plain` (no CORS preflight) to 127.0.0.1.
 *  - Reject when an `Origin` is present and its host differs from the request Host.
 *  - When there is no token perimeter, additionally require a loopback `Host`
 *    (blocks DNS-rebinding, where Host is the attacker's domain pointed at 127.0.0.1).
 *    isLoopbackHost, not isLoopbackName: the browser sends the vanity name it was
 *    given (`limn.localhost`), which is same-machine, while every other name is not.
 *    With a token set, the token is the perimeter and any Host (Tailscale name) is fine. */
export function sameSiteOk(headers: { host?: string; origin?: string }, hasToken: boolean): boolean {
  const host = (headers.host || '').toLowerCase()
  const origin = headers.origin
  if (typeof origin === 'string' && origin !== 'null') {
    try { if (new URL(origin).host.toLowerCase() !== host) return false }
    catch { return false }
  }
  if (!hasToken && !isLoopbackHost(host.split(':')[0])) return false
  return true
}
