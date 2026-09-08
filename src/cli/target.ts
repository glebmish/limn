import { DEFAULT_PORT } from '../server/http.js'
import { CANONICAL_HOST, hostForUrl, isLoopbackName } from '../server/guard.js'

/** The port this shell means: an explicit `--port`, else LIMN_PORT, else 5466. */
export function resolvePort(explicit?: number): number {
  if (explicit !== undefined) return explicit
  const env = Number(process.env.LIMN_PORT)
  return Number.isInteger(env) && env > 0 && env <= 65535 ? env : DEFAULT_PORT
}

/** Where *this shell* thinks the Limn service is. Every CLI surface that talks to the
 *  service — the health probe, the port clash check, `service status`, `cli:open` —
 *  must agree, or a `LIMN_WEB_HOST` deployment ends up probing a loopback address the
 *  server never bound and reporting a healthy service as down. */
export interface ServiceTarget {
  /** the bind address as configured — NOT bracketed, so it can go straight to listen() */
  host: string
  port: number
  /** LIMN_WEB_TOKEN, or '' when there is no token perimeter */
  token: string
  /** the address to hand a browser: the vanity name on loopback, the real host otherwise */
  url: string
}

export function serviceTarget(explicitPort?: number): ServiceTarget {
  const host = process.env.LIMN_WEB_HOST || '127.0.0.1'
  const port = resolvePort(explicitPort)
  const token = process.env.LIMN_WEB_TOKEN || ''
  // limn.localhost resolves to loopback in the browser with no hosts-file entry, and is
  // the name the docs use; for any other bind the browser must be sent the real host.
  const url = `http://${isLoopbackName(host) ? CANONICAL_HOST : hostForUrl(host)}:${port}`
  return { host, port, token, url }
}
