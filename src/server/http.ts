import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { NotFoundError, registerIpc, shutdownIpc } from './ipc.js'
import { openDb } from './db/db.js'
import { issueCliOpen, type CliOpenArgs } from './cliOpen.js'
import { CANONICAL_HOST, hostForUrl, isJsonContentType, isLoopbackName, isProtectedPath, sameSiteOk } from './guard.js'
import type { Transport, BroadcastChannel, BroadcastMsg } from './transport.js'

export interface ServerOptions {
  port: number
  host?: string
  token?: string
  staticRoot?: string
  dbPath: string
  /** serve the SPA with the `limn-dev` marker so `?dev=` screenshot hooks are honoured.
   *  Off unless the operator sets LIMN_DEV_HOOKS=1 — the hooks can run arbitrary prompts. */
  devHooks?: boolean
  /** also listen on 127.0.0.1:80 when free, so the canonical host works bare */
  vanityPort80?: boolean
  /** the alias port (default 80) — overridable so tests can exercise the alias
   *  without a privileged/contended port */
  aliasPort?: number
  log?: (line: string) => void
}
export interface RunningServer {
  port: number
  url: string
  /** true when the :80 alias is bound */
  vanity: boolean
  /** the port the alias actually bound, null when it isn't up */
  aliasPort: number | null
  close(): Promise<void>
}

export const DEFAULT_PORT = 5466
export const APP_VERSION: string = (createRequire(import.meta.url)('../../package.json') as { version: string }).version

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.ico': 'image/x-icon', '.map': 'application/json; charset=utf-8'
}

// constant-time string compare (avoids leaking the token via response timing).
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a), bb = Buffer.from(b)
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb)
}

function authorized(req: http.IncomingMessage, url: URL, token: string): boolean {
  if (!token) return true
  // header is preferred (doesn't land in logs/history); query param kept for convenience
  const h = req.headers.authorization
  if (typeof h === 'string' && h.startsWith('Bearer ') && safeEqual(h.slice(7), token)) return true
  const q = url.searchParams.get('token')
  return q != null && safeEqual(q, token)
}

/** Every RPC argument list is small (paths, ids, prompts); a body larger than this is a
 *  mistake or a memory-exhaustion attempt, so stop reading rather than buffer it all. */
const MAX_BODY_BYTES = 8 * 1024 * 1024
export class BodyTooLarge extends Error {
  constructor() { super(`request body exceeds ${MAX_BODY_BYTES} bytes`) }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let over = false
    req.on('data', (c) => {
      if (over) return
      const buf = c as Buffer
      size += buf.length
      if (size > MAX_BODY_BYTES) {
        // stop buffering and let the caller answer 413; the response itself tears the
        // socket down (an unread request body can't be kept alive), which ends the upload.
        over = true
        chunks.length = 0
        reject(new BodyTooLarge())
        return
      }
      chunks.push(buf)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** The marker `dev-init.ts` looks for before it will read `?dev=` hooks. Those hooks run
 *  attacker-supplied prompts through the user's agent, so they are opt-in *server-side*
 *  (LIMN_DEV_HOOKS=1) — a crafted link alone must never arm them. */
const DEV_META = '<meta name="limn-dev" content="1">'

/** Inject the dev marker into the SPA index. Only ever called for index.html — never
 *  for an asset — and only when the server was started with devHooks. */
function withDevMeta(html: Buffer): string {
  const s = html.toString('utf8')
  return s.includes('</head>') ? s.replace('</head>', `  ${DEV_META}\n  </head>`) : `${DEV_META}\n${s}`
}

function serveStatic(pathname: string, res: http.ServerResponse, staticRoot: string, devHooks: boolean): void {
  // resolve against staticRoot and refuse to escape it
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
  const full = path.join(staticRoot, rel)
  // stay within staticRoot — require an exact match or a real path-separator boundary
  // (a bare startsWith would also accept a sibling like `${staticRoot}-other`)
  if (full !== staticRoot && !full.startsWith(staticRoot + path.sep)) { res.writeHead(403).end('forbidden'); return }
  const indexPath = path.join(staticRoot, 'index.html')
  const sendIndex = (buf: Buffer): void => {
    res.writeHead(200, { 'Content-Type': MIME['.html'] }).end(devHooks ? withDevMeta(buf) : buf)
  }

  fs.readFile(full, (err, buf) => {
    if (err) {
      // SPA fallback for client-side routes / unknown paths
      fs.readFile(indexPath, (e2, idx) => {
        if (e2) { res.writeHead(404).end('not found'); return }
        sendIndex(idx)
      })
      return
    }
    if (full === indexPath) { sendIndex(buf); return }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream' }).end(buf)
  })
}

/** Stand up the Limn service: the SPA's static assets, the RPC/SSE carrier for the
 *  IPC handlers, and a public /health probe the CLI uses to find a live service.
 *  Side-effect free at import time so tests can boot it on an ephemeral port. */
export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const host = opts.host || '127.0.0.1'
  const token = opts.token || ''
  const staticRoot = opts.staticRoot || path.join(import.meta.dirname, '../renderer')
  const devHooks = Boolean(opts.devHooks)
  const log = opts.log ?? ((line: string) => { console.log(line) })

  // Fail closed: a non-loopback bind with no token is unauthenticated network
  // access to this host's repos, working trees, and agent credentials. Refuse to
  // start rather than expose it on a warning the user may never see.
  if (!isLoopbackName(host) && !token) {
    throw new Error(`refusing to bind ${host} with no LIMN_WEB_TOKEN — that would let anyone who can reach this port read this host's repos and use its agent credentials. Set LIMN_WEB_TOKEN to require auth, or use the loopback default.`)
  }

  fs.mkdirSync(path.dirname(opts.dbPath), { recursive: true })
  const { db, recoveredFrom } = openDb(opts.dbPath)
  const notices = recoveredFrom
    ? [`Database was corrupted and recreated. The old file was saved to ${recoveredFrom}.`]
    : []
  const startedAt = new Date().toISOString()

  // ── the web carrier for the IPC handlers ──
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const sseClients = new Set<http.ServerResponse>()

  const transport: Transport = {
    handle(name, fn) { handlers.set(name, fn) },
    broadcast(channel: BroadcastChannel, msg: BroadcastMsg) {
      const frame = `data: ${JSON.stringify({ channel, msg })}\n\n`
      for (const res of sseClients) res.write(frame)
    },
    // No desktop notifications over the wire; the live op:result stream already
    // tells the open tab the run finished.
    notify() { /* no-op */ },
    // Directory selection is client-side on the web (the browser can't open a
    // dialog on the server); the web client special-cases pickRepo and never
    // calls this. Returning null keeps the contract total.
    async pickDirectory() { return null }
  }

  registerIpc(db, notices, transport)
  // Not an Api channel: the `limn` CLI posts it, the browser never does.
  transport.handle('cli:open', (args: unknown) => issueCliOpen(args as CliOpenArgs))

  let boundPort = opts.port
  const requestListener = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)

    // Public probe: the CLI reads it before it has any token, and it leaks nothing
    // about the host beyond "a Limn of this version is running here".
    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
        .end(JSON.stringify({ app: 'limn', version: APP_VERSION, pid: process.pid, startedAt, port: boundPort }))
      return
    }

    const protectedPath = isProtectedPath(url.pathname)
    if (protectedPath && !authorized(req, url, token)) { res.writeHead(401).end('unauthorized'); return }

    // CSRF / DNS-rebinding guard on the active endpoints (RPC mutates repos / runs
    // the agent; SSE leaks the live op stream). Static assets stay open.
    if (protectedPath && !sameSiteOk(req.headers, Boolean(token))) {
      res.writeHead(403).end('forbidden origin'); return
    }

    // ── push stream: op:event / op:result / repo:changed ──
    if (req.method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive'
      })
      res.write('retry: 2000\n\n')
      sseClients.add(res)
      const keepalive = setInterval(() => res.write(': ping\n\n'), 25_000)
      req.on('close', () => { clearInterval(keepalive); sseClients.delete(res) })
      return
    }

    // ── request/response RPC: POST /rpc/<channel> with a JSON array of args ──
    if (req.method === 'POST' && url.pathname.startsWith('/rpc/')) {
      // An HTML form — the CSRF vector that needs no CORS preflight — can only send
      // text/plain, urlencoded or multipart, and `enctype=text/plain` can still carry
      // a body that parses as JSON. Requiring the JSON media type shuts that door.
      if (!isJsonContentType(req.headers['content-type'])) {
        res.writeHead(415, { 'Content-Type': 'application/json' })
          .end(JSON.stringify({ error: 'Content-Type must be application/json' }))
        return
      }
      const channel = decodeURIComponent(url.pathname.slice('/rpc/'.length))
      const fn = handlers.get(channel)
      if (!fn) { res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: `unknown channel ${channel}` })); return }
      void (async () => {
        try {
          const raw = await readBody(req)
          const args = raw ? JSON.parse(raw) : []
          const value = await fn(...(Array.isArray(args) ? args : []))
          res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ value: value ?? null }))
        } catch (err) {
          const status = err instanceof BodyTooLarge ? 413 : err instanceof NotFoundError ? 404 : 500
          res.writeHead(status, { 'Content-Type': 'application/json' })
            .end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }))
        }
      })()
      return
    }

    // ── static renderer (SPA: unknown non-file paths fall back to index.html) ──
    if (req.method === 'GET' || req.method === 'HEAD') {
      serveStatic(url.pathname, res, staticRoot, devHooks)
      return
    }

    res.writeHead(405).end('method not allowed')
  }

  const server = http.createServer(requestListener)
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(opts.port, host, () => { server.off('error', reject); resolve() })
    })
  } catch (err) {
    // A failed bind (EADDRINUSE when a service already holds the port) must not
    // leave the SQLite handle open — the caller retries or exits on this throw.
    db.close()
    throw err
  }
  const addr = server.address()
  boundPort = typeof addr === 'object' && addr ? addr.port : opts.port
  // Bound now: a post-listen 'error' (accept failure, EMFILE) must log, not crash —
  // an EventEmitter 'error' with no listener takes the whole service down.
  server.on('error', (err) => { log(`[limn] server error: ${err instanceof Error ? err.message : String(err)}`) })

  let vanityServer: http.Server | null = null
  if (opts.vanityPort80) {
    const wantPort = opts.aliasPort ?? 80
    vanityServer = await new Promise<http.Server | null>((resolve) => {
      const alias = http.createServer(requestListener)
      alias.once('error', (err) => {
        log(`[limn] :${wantPort} alias not bound (${(err as NodeJS.ErrnoException).code}); use :${boundPort}`)
        resolve(null)
      })
      alias.listen(wantPort, '127.0.0.1', () => resolve(alias))
    })
    vanityServer?.on('error', (err) => { log(`[limn] alias error: ${err instanceof Error ? err.message : String(err)}`) })
  }

  // hostForUrl: a bare IPv6 bind (LIMN_WEB_HOST=fd7a::1) has to be bracketed, or the
  // URL we log — and hand to `limn open`'s page — is not a URL at all.
  const url = `http://${isLoopbackName(host) ? CANONICAL_HOST : hostForUrl(host)}:${boundPort}`
  log(`[limn] serving ${url}  (db: ${opts.dbPath})`)
  if (!fs.existsSync(path.join(staticRoot, 'index.html'))) {
    log(`[limn] WARNING: ${staticRoot}/index.html missing — run "npm run build" first.`)
  }
  if (token && !isLoopbackName(host)) log(`[limn] bound to ${host} with token auth required.`)

  const alias = vanityServer
  const aliasAddr = alias?.address()
  return {
    port: boundPort,
    url,
    vanity: alias != null,
    aliasPort: typeof aliasAddr === 'object' && aliasAddr ? aliasAddr.port : null,
    close: () => new Promise<void>((resolve) => {
      // End the push streams first, then drop every remaining socket: a browser tab
      // holding an EventSource (or a keep-alive socket that ignores our FIN) would
      // otherwise keep server.close() pending and swallow the first SIGINT/SIGTERM.
      for (const c of sseClients) c.end()
      alias?.closeAllConnections()
      server.closeAllConnections()
      // Cancel the live-watch poll timer before the DB goes: an armed watcher would
      // otherwise keep the event loop alive long past close() and swallow the first
      // SIGINT (the reason the screenshot scripts used to need a SIGKILL escalation).
      shutdownIpc()
      // Resolve only when BOTH listeners are down — a caller that restarts on the
      // same ports right after close() must not race the alias's lingering socket.
      const aliasClosed = alias ? new Promise<void>((r) => alias.close(() => r())) : Promise.resolve()
      server.close(() => { void aliasClosed.then(() => { db.close(); resolve() }) })
    })
  }
}
