import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { execSync } from 'node:child_process'
import { registerIpc } from '../main/ipc.js'
import { openDb } from '../main/db/db.js'
import { isLoopbackName, isProtectedPath, sameSiteOk } from './guard.js'
import type { Transport, BroadcastChannel, BroadcastMsg } from '../main/transport.js'

// ── config ──
const PORT = Number(process.env.LIMN_WEB_PORT || process.env.PORT || 8787)
// Secure by default: bind loopback only. To expose the server on a LAN/Tailscale
// IP set LIMN_WEB_HOST explicitly (e.g. 0.0.0.0) AND set LIMN_WEB_TOKEN — a
// non-loopback bind with no token is refused at startup (see main()).
const HOST = process.env.LIMN_WEB_HOST || '127.0.0.1'
// optional shared secret. When set, RPC and event requests must carry it (?token=
// or a Bearer header). Static assets stay public so the token-aware client can boot.
// Strongly recommended since active endpoints expose the host's repos, git working
// trees, and locally-installed agent credentials.
const TOKEN = process.env.LIMN_WEB_TOKEN || ''
const STATIC_ROOT = process.env.LIMN_WEB_STATIC || path.join(import.meta.dirname, '../../out/renderer')

// GUI/non-login launches don't inherit the shell PATH; engines need git/claude/codex
// from it. A terminal launch already has it — this is a best-effort top-up.
function bootstrapPath(): void {
  try {
    const shell = process.env.SHELL || '/bin/zsh'
    const p = execSync(`${shell} -ilc 'echo -n "$PATH"'`, { timeout: 5000 }).toString()
    if (p) process.env.PATH = p
  } catch { /* keep default PATH */ }
}

// Mirror Electron's app.getPath('userData') for app name 'limn', so the web server
// shares one database with the desktop app (same repos, sessions, prefs).
function defaultDbPath(): string {
  const home = os.homedir()
  const base = process.platform === 'darwin'
    ? path.join(home, 'Library', 'Application Support')
    : process.platform === 'win32'
      ? (process.env.APPDATA || path.join(home, 'AppData', 'Roaming'))
      : (process.env.XDG_CONFIG_HOME || path.join(home, '.config'))
  return path.join(base, 'limn', 'limn.db')
}

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

function authorized(req: http.IncomingMessage, url: URL): boolean {
  if (!TOKEN) return true
  // header is preferred (doesn't land in logs/history); query param kept for convenience
  const h = req.headers.authorization
  if (typeof h === 'string' && h.startsWith('Bearer ') && safeEqual(h.slice(7), TOKEN)) return true
  const q = url.searchParams.get('token')
  return q != null && safeEqual(q, TOKEN)
}


function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c as Buffer))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function main(): void {
  // Fail closed: a non-loopback bind with no token is unauthenticated network
  // access to this host's repos, working trees, and agent credentials. Refuse to
  // start rather than expose it on a warning the user may never see.
  if (!isLoopbackName(HOST) && !TOKEN) {
    console.error(`[limn] refusing to bind ${HOST} with no LIMN_WEB_TOKEN — that would let anyone who can reach :${PORT} read this host's repos and use its agent credentials. Set LIMN_WEB_TOKEN to require auth, or use the loopback default (LIMN_WEB_HOST unset / 127.0.0.1).`)
    process.exit(1)
  }
  bootstrapPath()
  const dbPath = process.env.LIMN_DB || defaultDbPath()
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  const { db, recoveredFrom } = openDb(dbPath)
  const notices = recoveredFrom
    ? [`Database was corrupted and recreated. The old file was saved to ${recoveredFrom}.`]
    : []

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

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)

    const protectedPath = isProtectedPath(url.pathname)
    if (protectedPath && !authorized(req, url)) { res.writeHead(401).end('unauthorized'); return }

    // CSRF / DNS-rebinding guard on the active endpoints (RPC mutates repos / runs
    // the agent; SSE leaks the live op stream). Static assets stay open.
    if (protectedPath && !sameSiteOk(req.headers, Boolean(TOKEN))) {
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
          res.writeHead(500, { 'Content-Type': 'application/json' })
            .end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }))
        }
      })()
      return
    }

    // ── static renderer (SPA: unknown non-file paths fall back to index.html) ──
    if (req.method === 'GET' || req.method === 'HEAD') {
      serveStatic(url.pathname, res)
      return
    }

    res.writeHead(405).end('method not allowed')
  })

  server.listen(PORT, HOST, () => {
    const where = HOST === '0.0.0.0' ? `http://<this-host>:${PORT}` : `http://${HOST}:${PORT}`
    console.log(`[limn] web server on ${where}  (db: ${dbPath})`)
    if (!fs.existsSync(path.join(STATIC_ROOT, 'index.html'))) {
      console.warn(`[limn] WARNING: ${STATIC_ROOT}/index.html missing — run "npm run build" first.`)
    }
    if (!TOKEN) {
      // Reachable only on a loopback bind (a non-loopback bind with no token is
      // refused before listen). Local-only is fine without a token.
      console.log('[limn] no LIMN_WEB_TOKEN set — fine on loopback (local-only).')
    } else if (!isLoopbackName(HOST)) {
      console.log(`[limn] bound to ${HOST} with token auth required.`)
    }
  })
}

function serveStatic(pathname: string, res: http.ServerResponse): void {
  // resolve against STATIC_ROOT and refuse to escape it
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
  const full = path.join(STATIC_ROOT, rel)
  // stay within STATIC_ROOT — require an exact match or a real path-separator boundary
  // (a bare startsWith would also accept a sibling like `${STATIC_ROOT}-other`)
  if (full !== STATIC_ROOT && !full.startsWith(STATIC_ROOT + path.sep)) { res.writeHead(403).end('forbidden'); return }

  fs.readFile(full, (err, buf) => {
    if (err) {
      // SPA fallback for client-side routes / unknown paths
      const indexPath = path.join(STATIC_ROOT, 'index.html')
      fs.readFile(indexPath, (e2, idx) => {
        if (e2) { res.writeHead(404).end('not found'); return }
        res.writeHead(200, { 'Content-Type': MIME['.html'] }).end(idx)
      })
      return
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream' }).end(buf)
  })
}

main()
