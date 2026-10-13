# Browser Pivot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the Electron shell and ship Limn as `@glebmish/limn` on npm — a local Node HTTP/SSE service serving the existing React SPA at `http://limn.localhost:5466`, with a `limn` CLI that opens reviews and manages an always-on LaunchAgent / systemd user service.

**Architecture:** The orchestrator (`registerIpc`) already speaks only the `Transport` seam and the SPA already has an HTTP/SSE `Api` client, so the pivot is: (1) extract today's `src/server/index.ts` into a testable `startServer()` with `/health` and a ticket-based `cli:open`; (2) make the HTTP client the renderer's only backing; (3) delete Electron and build with plain `vite` + `tsc`; (4) add `src/cli/` (args, dual-role `open`, `service serve|install|uninstall|status|logs`, launchd/systemd backends); (5) bundle the JS-only adapter closure for npm; (6) port dev screenshot tooling to headless Chrome; (7) docs + CI; (8) rename `src/main` → `src/server`.

**Tech Stack:** Node ≥ 22.5 (`node:sqlite`, `node:http`), TypeScript 6 (`tsc` emit for server/cli), Vite 7 + React 19 (renderer), vitest 4, launchd (`launchctl`), systemd `--user`, npm `bundleDependencies`.

**Spec:** `specs/browser-pivot/spec.md` — read it first. One deliberate deviation, recorded in Task 11: `cli:open` is delivered by a **ticket in the URL** (`/?open=<ticket>` → `takeCliOpen(ticket)`) instead of an SSE broadcast, because a CLI cannot focus a background browser tab; opening a tab with the ticket reliably surfaces the review, and it removes the `pending`/`rendererReady` state machine.

## Global Constraints

- Node floor: `"engines": { "node": ">=22.5" }` — `bin/limn.js` refuses older Node with `Limn needs Node >= 22.5 (found X)`.
- Package: name `@glebmish/limn`, bin `limn`, `"files": ["bin", "dist"]`, `bundleDependencies` = all four runtime deps. Users run `npm i -g @glebmish/limn` with no flags.
- Canonical URL `http://limn.localhost:5466`; default port **5466**; the server binds `127.0.0.1` unless `LIMN_WEB_HOST` is set; non-loopback bind without `LIMN_WEB_TOKEN` refuses to start (unchanged).
- Port env var is `LIMN_PORT` (replaces `LIMN_WEB_PORT`). `LIMN_WEB_HOST`, `LIMN_WEB_TOKEN`, `LIMN_DB`, `LIMN_WEB_STATIC` keep their names.
- `npm i -g` / `npx` never install the service — no `postinstall`.
- `limn service serve` is foreground only; no `stop`/`restart` subcommands.
- LaunchAgent label `dev.glebmish.limn`; plist at `~/Library/LaunchAgents/dev.glebmish.limn.plist`; log at `~/Library/Logs/limn.log`. systemd unit `~/.config/systemd/user/limn.service`.
- Every task ends with `npm test`, `npm run typecheck`, `npm run lint` green, then a commit. Commit messages follow the repo style (`feat(cli): …`, `chore(build): …`).
- Do not touch `src/main/ipc.ts` business logic beyond what a task names.

## File map

| Path | Responsibility |
|---|---|
| `src/server/http.ts` (new, from `src/server/index.ts`) | `startServer(opts)` — HTTP RPC + SSE + static + `/health`; no side effects on import |
| `src/server/guard.ts` (unchanged) | pure request guards |
| `src/main/cliOpen.ts` (new, replaces `src/main/cli.ts`) | `CliOpenArgs`, `issueCliOpen()` (repoRoot → ticket), `takeCliOpen(ticket)` |
| `src/main/paths.ts` (new) | `userDataDir()`, `defaultDbPath()`, `cliStatePath()`, `logPath()` — one place for host paths |
| `src/renderer/api-client.ts` (renamed from `web-api.ts`) | the only `RendererApi` backing (fetch + EventSource) |
| `src/renderer/main.tsx` | install client, parse `?dev=` hooks, render |
| `src/cli/index.ts` | entry: `main(process.argv.slice(2))` |
| `src/cli/main.ts` | command dispatch, `--help`, `--version` |
| `src/cli/args.ts` | pure argv parser → `CliCommand` |
| `src/cli/health.ts` | `probeHealth(port)` |
| `src/cli/browser.ts` | `openBrowser(url)` |
| `src/cli/serve.ts` | `service serve`: bind, busy-port classification |
| `src/cli/open.ts` | dual-role `open`: `decideOpen()` + `runOpen()` |
| `src/cli/state.ts` | `cli.json` read/write (`servicePromptDeclined`) |
| `src/cli/service/types.ts` | `ServiceBackend`, `ActivationInfo` |
| `src/cli/service/launchd.ts` | plist text, `launchctl` calls + parsing |
| `src/cli/service/systemd.ts` | unit text, `systemctl --user` calls + parsing |
| `src/cli/service/index.ts` | backend selection, `install/uninstall/status/logs` commands, status rendering |
| `src/cli/shim.ts` | detect + offer removal of the old Electron shim |
| `bin/limn.js` | Node-version gate, imports `dist/cli/index.js` |
| `vite.config.ts`, `tsconfig.server.json` | renderer build / server+cli emit |
| `scripts/dev-url.mts`, `scripts/cdp-shot.mts` | dev screenshot tooling for the web app |
| `scripts/pack-smoke.sh` | pack → install to temp prefix → assert no platform binaries → `/health` |

---

### Task 1: Extract `startServer()` with `/health` and ticket-based `cli:open`

**Files:**
- Create: `src/server/http.ts`, `src/main/cliOpen.ts`, `src/main/paths.ts`
- Modify: `src/server/index.ts` (becomes a 25-line `main()`), `src/main/ipc.ts:1,1280-1281`, `src/main/transport.ts` (doc comment only), `src/shared/ipc.ts:149-150,206`
- Delete: `src/main/cli.ts`, `tests/cli.test.ts` (the `--cli` argv grammar dies with Electron; the new grammar is Task 4)
- Test: `tests/cli-open.test.ts`, `tests/server-http.test.ts`

**Interfaces:**
- Produces `startServer(opts: ServerOptions): Promise<RunningServer>` where
  `ServerOptions = { port: number; host?: string; token?: string; staticRoot?: string; dbPath: string; vanityPort80?: boolean; log?: (line: string) => void }`
  and `RunningServer = { port: number; url: string; close(): Promise<void> }`.
- Produces `GET /health` → `{ app: 'limn', version: string, pid: number, startedAt: string, port: number }` (public, no token).
- Produces `POST /rpc/cli:open` body `[CliOpenArgs]` → `{ value: { ticket: string } }`, and `Api.takeCliOpen(ticket: string)`.
- Produces `CliOpenArgs = { dir: string; base?: string; compare?: string; hub?: boolean; fresh?: boolean }`.
- Produces `userDataDir()`, `defaultDbPath()`, `cliStatePath()`, `logPath()` in `src/main/paths.ts`.

- [ ] **Step 1: Write the failing ticket tests**

`tests/cli-open.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { issueCliOpen, takeCliOpen, _resetTickets } from '../src/main/cliOpen'
import { makeFixtureRepo } from './helpers/fixtureRepo'

describe('cli:open tickets', () => {
  it('issues a ticket whose message resolves the repo root and carries the refs', async () => {
    _resetTickets()
    const fx = makeFixtureRepo()
    const { ticket } = await issueCliOpen({ dir: fx.dir, base: 'main', compare: 'feature', hub: false, fresh: true })
    expect(ticket).toMatch(/^[0-9a-f]{32}$/)
    expect(takeCliOpen(ticket)).toEqual({ repo: fx.dir, baseInput: 'main', compareInput: 'feature', hub: false, fresh: true })
  })
  it('a ticket is single-use', async () => {
    _resetTickets()
    const fx = makeFixtureRepo()
    const { ticket } = await issueCliOpen({ dir: fx.dir })
    expect(takeCliOpen(ticket)).not.toBeNull()
    expect(takeCliOpen(ticket)).toBeNull()
  })
  it('a non-git dir yields an error message the UI can show', async () => {
    _resetTickets()
    const { ticket } = await issueCliOpen({ dir: '/' })
    expect(takeCliOpen(ticket)).toEqual({ error: '/ is not inside a git repository' })
  })
  it('unknown / expired tickets are null', () => {
    _resetTickets()
    expect(takeCliOpen('nope')).toBeNull()
  })
})
```

Check `tests/helpers/fixtureRepo.ts` for the exact export name of the fixture helper (`makeFixtureRepo` is used by `scripts/shoot.mts`); its repo has branches `main` and `feature`.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/cli-open.test.ts`
Expected: FAIL — cannot resolve `../src/main/cliOpen`.

- [ ] **Step 3: Create `src/main/paths.ts` and `src/main/cliOpen.ts`**

`src/main/paths.ts` (move `defaultDbPath` out of `src/server/index.ts`):

```ts
import os from 'node:os'
import path from 'node:path'

/** Mirrors Electron's app.getPath('userData') for app name 'limn' so the service
 *  keeps using the database the desktop app created. */
export function userDataDir(): string {
  const home = os.homedir()
  const base = process.platform === 'darwin'
    ? path.join(home, 'Library', 'Application Support')
    : process.platform === 'win32'
      ? (process.env.APPDATA || path.join(home, 'AppData', 'Roaming'))
      : (process.env.XDG_CONFIG_HOME || path.join(home, '.config'))
  return path.join(base, 'limn')
}

export function defaultDbPath(): string {
  return process.env.LIMN_DB || path.join(userDataDir(), 'limn.db')
}

/** CLI-only state (first-run prompt answer). Kept out of the DB so the CLI never
 *  opens SQLite while the service holds it. */
export function cliStatePath(): string {
  return path.join(userDataDir(), 'cli.json')
}

export function logPath(): string {
  return process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Logs', 'limn.log')
    : path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'limn', 'limn.log')
}
```

`src/main/cliOpen.ts`:

```ts
import crypto from 'node:crypto'
import type { CliOpenMsg } from '../shared/ipc.js'
import { repoRoot } from './git.js'

export interface CliOpenArgs {
  dir: string
  base?: string
  /** the compare side (`--branch`) */
  compare?: string
  hub?: boolean
  fresh?: boolean
}

const TICKET_TTL_MS = 60_000
const tickets = new Map<string, { msg: CliOpenMsg; expires: number }>()

/** Resolve the repo root for a CLI open and park the resulting message under a
 *  one-time ticket. The CLI puts the ticket in the page URL (`/?open=<ticket>`);
 *  the booting tab redeems it with takeCliOpen(). */
export async function issueCliOpen(args: CliOpenArgs): Promise<{ ticket: string }> {
  const root = await repoRoot(args.dir)
  const msg: CliOpenMsg = root
    ? { repo: root, baseInput: args.base, compareInput: args.compare, hub: args.hub, fresh: args.fresh }
    : { error: `${args.dir} is not inside a git repository` }
  const ticket = crypto.randomBytes(16).toString('hex')
  const now = Date.now()
  for (const [k, v] of tickets) if (v.expires < now) tickets.delete(k)
  tickets.set(ticket, { msg, expires: now + TICKET_TTL_MS })
  return { ticket }
}

/** Redeem a ticket (single use). Null for unknown, used, or expired tickets. */
export function takeCliOpen(ticket: string): CliOpenMsg | null {
  const hit = tickets.get(ticket)
  if (!hit) return null
  tickets.delete(ticket)
  return hit.expires < Date.now() ? null : hit.msg
}

/** test hook */
export function _resetTickets(): void { tickets.clear() }
```

`repoRoot` already exists in `src/main/git.ts` (it was imported by `src/main/cli.ts`); keep its `undefined`-vs-`null` return as-is and adapt the ternary if it returns `undefined`.

- [ ] **Step 4: Rewire `Api` and `registerIpc`**

`src/shared/ipc.ts`: replace lines 149-150 with `takeCliOpen(ticket: string): Promise<CliOpenMsg | null>` (drop `installCli`), and remove `'installCli'` from `API_CHANNELS` (line 206 → `'refOptions', 'retargetSession', 'takeCliOpen'`). Remove `onCliOpen` and `onSettingsOpen` from `RendererApi` (lines 194-195). The renderer breaks until Task 2 — that is expected; Task 2 is the next commit.

`src/main/ipc.ts`: line 1 → `import { takeCliOpen } from './cliOpen.js'`; lines 1280-1281 → `handle('takeCliOpen', async (ticket: string) => takeCliOpen(ticket))`.

Delete `src/main/cli.ts` and `tests/cli.test.ts`. `src/main/index.ts` (Electron main) now fails to compile — Task 3 deletes it; until then exclude nothing, just accept `npm run typecheck` failing on that one file for this commit and the next (state this in the commit body).

- [ ] **Step 5: Run ticket tests**

Run: `npx vitest run tests/cli-open.test.ts`
Expected: 4 PASS.

- [ ] **Step 6: Write the failing server test**

`tests/server-http.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startServer, type RunningServer } from '../src/server/http'
import { makeFixtureRepo } from './helpers/fixtureRepo'

let running: RunningServer | null = null
afterEach(async () => { await running?.close(); running = null })

async function boot(): Promise<RunningServer> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limn-http-'))
  running = await startServer({ port: 0, dbPath: path.join(dir, 'limn.db'), staticRoot: dir, log: () => {} })
  return running
}

describe('startServer', () => {
  it('serves /health with the package version and an ephemeral port', async () => {
    const s = await boot()
    expect(s.port).toBeGreaterThan(0)
    const res = await fetch(`${s.url}/health`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ app: 'limn', pid: process.pid, port: s.port })
    expect(body.version).toMatch(/^\d+\.\d+\.\d+/)
    expect(typeof body.startedAt).toBe('string')
  })

  it('cli:open issues a ticket that takeCliOpen redeems once', async () => {
    const s = await boot()
    const fx = makeFixtureRepo()
    const issue = await fetch(`${s.url}/rpc/cli:open`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: s.url },
      body: JSON.stringify([{ dir: fx.dir, compare: 'feature' }])
    })
    const { value } = await issue.json()
    expect(value.ticket).toMatch(/^[0-9a-f]{32}$/)
    const take = async () => (await (await fetch(`${s.url}/rpc/takeCliOpen`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: s.url },
      body: JSON.stringify([value.ticket])
    })).json()).value
    expect(await take()).toEqual({ repo: fx.dir, compareInput: 'feature' })
    expect(await take()).toBeNull()
  })

  it('falls back to index.html for unknown paths and 404s when there is no build', async () => {
    const s = await boot()
    const res = await fetch(`${s.url}/some/spa/route`)
    expect(res.status).toBe(404)
  })

  it('refuses a non-loopback bind without a token', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limn-http-'))
    await expect(startServer({ port: 0, host: '0.0.0.0', dbPath: path.join(dir, 'limn.db'), staticRoot: dir, log: () => {} }))
      .rejects.toThrow(/LIMN_WEB_TOKEN/)
  })
})
```

Note `toEqual` treats `undefined` properties as absent, so `{ repo, compareInput }` matches the message with `baseInput: undefined` etc.

- [ ] **Step 7: Run to verify failure**

Run: `npx vitest run tests/server-http.test.ts`
Expected: FAIL — cannot resolve `../src/server/http`.

- [ ] **Step 8: Create `src/server/http.ts`**

Move everything from `src/server/index.ts` except `main()`'s env reading into `startServer`. Keep `MIME`, `safeEqual`, `authorized`, `readBody`, `serveStatic` as module-private functions with their current bodies (parameterise `TOKEN` and `STATIC_ROOT` instead of reading module constants). Skeleton:

```ts
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { registerIpc } from '../main/ipc.js'
import { openDb } from '../main/db/db.js'
import { issueCliOpen, type CliOpenArgs } from '../main/cliOpen.js'
import { isLoopbackName, isProtectedPath, sameSiteOk } from './guard.js'
import type { Transport, BroadcastChannel, BroadcastMsg } from '../main/transport.js'

export interface ServerOptions {
  port: number
  host?: string
  token?: string
  staticRoot?: string
  dbPath: string
  /** also listen on 127.0.0.1:80 when free, so http://limn.localhost works bare */
  vanityPort80?: boolean
  log?: (line: string) => void
}
export interface RunningServer {
  port: number
  url: string
  /** true when the :80 alias is bound */
  vanity: boolean
  close(): Promise<void>
}

export const DEFAULT_PORT = 5466
export const APP_VERSION: string = (createRequire(import.meta.url)('../../package.json') as { version: string }).version

export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const host = opts.host || '127.0.0.1'
  const token = opts.token || ''
  const staticRoot = opts.staticRoot || path.join(import.meta.dirname, '../renderer')
  const log = opts.log ?? ((l) => console.log(l))
  if (!isLoopbackName(host) && !token) {
    throw new Error(`refusing to bind ${host} with no LIMN_WEB_TOKEN — that would let anyone who can reach this port read this host's repos and use its agent credentials. Set LIMN_WEB_TOKEN to require auth, or use the loopback default.`)
  }
  fs.mkdirSync(path.dirname(opts.dbPath), { recursive: true })
  const { db, recoveredFrom } = openDb(opts.dbPath)
  const notices = recoveredFrom ? [`Database was corrupted and recreated. The old file was saved to ${recoveredFrom}.`] : []
  const startedAt = new Date().toISOString()

  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const sseClients = new Set<http.ServerResponse>()
  const transport: Transport = {
    handle(name, fn) { handlers.set(name, fn) },
    broadcast(channel: BroadcastChannel, msg: BroadcastMsg) {
      const frame = `data: ${JSON.stringify({ channel, msg })}\n\n`
      for (const res of sseClients) res.write(frame)
    },
    notify() { /* browser notifications are a follow-up */ },
    async pickDirectory() { return null }
  }
  registerIpc(db, notices, transport)
  transport.handle('cli:open', (args: unknown) => issueCliOpen(args as CliOpenArgs))

  let boundPort = opts.port
  const requestListener = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
        .end(JSON.stringify({ app: 'limn', version: APP_VERSION, pid: process.pid, startedAt, port: boundPort }))
      return
    }
    // …existing protectedPath / authorized / sameSiteOk / SSE / RPC / static branches, verbatim,
    // using `token` and `staticRoot` instead of the old module constants…
  }

  const server = http.createServer(requestListener)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(opts.port, host, () => { server.off('error', reject); resolve() })
  })
  const addr = server.address()
  boundPort = typeof addr === 'object' && addr ? addr.port : opts.port

  let vanity: http.Server | null = null
  if (opts.vanityPort80) {
    vanity = http.createServer(requestListener)
    await new Promise<void>((resolve) => {
      vanity!.once('error', (err) => { log(`[limn] :80 alias not bound (${(err as NodeJS.ErrnoException).code}); use :${boundPort}`); vanity = null; resolve() })
      vanity!.listen(80, '127.0.0.1', () => resolve())
    })
  }

  const url = `http://${isLoopbackName(host) ? 'limn.localhost' : host}:${boundPort}`
  log(`[limn] serving ${url}  (db: ${opts.dbPath})`)
  if (!fs.existsSync(path.join(staticRoot, 'index.html'))) log(`[limn] WARNING: ${staticRoot}/index.html missing — run "npm run build" first.`)
  return {
    port: boundPort, url, vanity: vanity != null,
    close: () => new Promise<void>((resolve) => {
      for (const c of sseClients) c.end()
      vanity?.close()
      server.close(() => { db.close(); resolve() })
    })
  }
}
```

`serveStatic` must return 404 (not 200 with index.html) when `index.html` itself is missing — it already does (`res.writeHead(404)` in the inner readFile callback). `startedAt`/`boundPort` are closed over so `/health` sees the ephemeral port after listen.

`src/server/index.ts` shrinks to:

```ts
import { execSync } from 'node:child_process'
import { startServer, DEFAULT_PORT } from './http.js'
import { defaultDbPath } from '../main/paths.js'

function bootstrapPath(): void {
  try {
    const shell = process.env.SHELL || '/bin/zsh'
    const p = execSync(`${shell} -ilc 'echo -n "$PATH"'`, { timeout: 5000 }).toString()
    if (p) process.env.PATH = p
  } catch { /* keep default PATH */ }
}

bootstrapPath()
startServer({
  port: Number(process.env.LIMN_PORT || DEFAULT_PORT),
  host: process.env.LIMN_WEB_HOST,
  token: process.env.LIMN_WEB_TOKEN,
  staticRoot: process.env.LIMN_WEB_STATIC,
  dbPath: defaultDbPath()
}).catch((err) => { console.error(`[limn] ${err instanceof Error ? err.message : err}`); process.exit(1) })
```

(Task 5 replaces this file with the CLI's `serve`.) Update `staticRoot` default to `../renderer` relative to `dist/server/` — during Task 1 the build still emits to `out/`, so `npm run serve` passes `LIMN_WEB_STATIC=out/renderer` until Task 3; note it in the commit body.

- [ ] **Step 9: Run the server tests and the guard tests**

Run: `npx vitest run tests/server-http.test.ts tests/server-guard.test.ts tests/cli-open.test.ts`
Expected: all PASS.

- [ ] **Step 10: Full suite, lint**

Run: `npm test && npm run lint`
Expected: PASS (typecheck fails only in `src/main/index.ts` and the renderer files touched by Task 2 — verify with `npm run typecheck 2>&1 | grep -v 'src/main/index.ts\|src/renderer' | grep error` printing nothing).

- [ ] **Step 11: Commit**

```bash
git add -A src/server src/main/cliOpen.ts src/main/paths.ts src/main/ipc.ts src/shared/ipc.ts tests/cli-open.test.ts tests/server-http.test.ts
git rm -q src/main/cli.ts tests/cli.test.ts
git commit -m "feat(server): startServer() with /health and ticket-based cli:open

Extracts the web server into a side-effect-free startServer() (ephemeral
ports for tests), adds GET /health, and replaces the Electron
second-instance cli:open with a one-time ticket the CLI puts in the page
URL. Drops installCli and the shim installer. Typecheck is red in
src/main/index.ts and the renderer until the next two commits."
```

---

### Task 2: Renderer — HTTP client is the only backing; `?open=` ticket; `?dev=` hooks

**Files:**
- Rename: `src/renderer/web-api.ts` → `src/renderer/api-client.ts`
- Modify: `src/renderer/main.tsx`, `src/renderer/App.tsx`, `src/renderer/store/index.ts:112-122`, `src/renderer/store/bridge.ts:47-53`, `src/renderer/lib/api.ts`, `src/renderer/dev.ts`, `src/renderer/api.d.ts`
- Test: `tests/renderer-boot.test.ts`

**Interfaces:**
- Consumes `Api.takeCliOpen(ticket: string)` from Task 1.
- Produces `installApiClient(): void` (sets `window.api`), `readDevHooks(search: string): Partial<DevConfig>`, `readOpenTicket(search: string): string | null`, `stripQuery(keys: string[]): void`.

- [ ] **Step 1: Write the failing tests**

`tests/renderer-boot.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { readDevHooks, readOpenTicket } from '../src/renderer/boot-params'

describe('boot params', () => {
  it('reads the cli:open ticket from ?open=', () => {
    expect(readOpenTicket('?open=abc123')).toBe('abc123')
    expect(readOpenTicket('?token=t&open=abc123')).toBe('abc123')
    expect(readOpenTicket('')).toBeNull()
  })
  it('parses ?dev= as JSON dev hooks and ignores garbage', () => {
    const hooks = readDevHooks('?dev=' + encodeURIComponent(JSON.stringify({ flow: 'chat', openSession: '7', fakeGen: true })))
    expect(hooks).toEqual({ flow: 'chat', openSession: '7', fakeGen: true })
    expect(readDevHooks('?dev=%7Bnot-json')).toEqual({})
    expect(readDevHooks('')).toEqual({})
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/renderer-boot.test.ts`
Expected: FAIL — cannot resolve `boot-params`.

- [ ] **Step 3: Create `src/renderer/boot-params.ts`**

```ts
type DevConfig = NonNullable<Window['limnDev']>

/** `?open=<ticket>` — a cli:open ticket minted by `limn open` (see src/main/cliOpen.ts). */
export function readOpenTicket(search: string): string | null {
  return new URLSearchParams(search).get('open')
}

/** `?dev=<json>` — screenshot/dev hooks (formerly injected by the Electron preload as
 *  window.limnDev from LIMN_* env vars). scripts/dev-url.mts builds this. */
export function readDevHooks(search: string): Partial<DevConfig> {
  const raw = new URLSearchParams(search).get('dev')
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed as Partial<DevConfig> : {}
  } catch { return {} }
}

/** Remove consumed params so a reload doesn't replay them. */
export function stripQuery(keys: string[]): void {
  const url = new URL(window.location.href)
  let changed = false
  for (const k of keys) if (url.searchParams.has(k)) { url.searchParams.delete(k); changed = true }
  if (changed) window.history.replaceState(null, '', url.pathname + (url.search || '') + url.hash)
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/renderer-boot.test.ts`
Expected: PASS.

- [ ] **Step 5: Rename the client and wire boot**

`git mv src/renderer/web-api.ts src/renderer/api-client.ts`. In it: rename `installWebApi` → `installApiClient`; delete the `onCliOpen` and `onSettingsOpen` lines and the comment above them; change the `pickRepo` prompt text to `'Repository path on this machine:'`; drop `CliOpenMsg` from the `AnyMsg` union and import. Keep the token handling.

`src/renderer/main.tsx` becomes:

```tsx
import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { installApiClient } from './api-client'
import { readDevHooks } from './boot-params'
import './styles/wf.css'
import './styles/review.css'
import './styles/document.css'
import './styles/app.css'
import './styles/repo.css'

window.limnDev = readDevHooks(window.location.search)
installApiClient()
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
```

`src/renderer/dev.ts` keeps reading `window.limnDev` (now set synchronously before any module that imports `dev` evaluates — verify `main.tsx` sets it *before* importing `App`: move the `window.limnDev = …` line into a tiny module `src/renderer/dev-init.ts` imported first in `main.tsx`, because ES imports are hoisted above statements).

`src/renderer/api.d.ts`: change `limnDev?: { flow: string | null; … }` so `flow` is `flow?: string | null` (everything is optional now).

`src/renderer/lib/api.ts` comment → `window.api is installed by api-client.ts before render`.

`src/renderer/App.tsx`: remove the `offSettings` and `offCli` subscriptions and their imports (`handleSettingsOpen`, `handleCliOpen`); keep `if (dev.openSettings) …`.

`src/renderer/store/bridge.ts`: delete `handleCliOpen` and `handleSettingsOpen`; `src/renderer/store/index.ts:73` drop them from the re-export.

`src/renderer/store/index.ts` boot: replace the `takeCliOpen` block with

```ts
      // `limn open` puts a one-time ticket in the URL; redeem it after the dashboard
      // loads so its error toast survives loadDashboard's `error: null` reset.
      const ticket = readOpenTicket(window.location.search)
      if (ticket) {
        stripQuery(['open'])
        try {
          const cli = await api().takeCliOpen(ticket)
          if (cli) get().applyCliOpen(cli)
        } catch { /* expired ticket — land on the dashboard */ }
      }
```

with `import { readOpenTicket, stripQuery } from '../boot-params'`.

- [ ] **Step 6: Typecheck the renderer, run the suite**

Run: `npm run typecheck 2>&1 | grep error | grep -v 'src/main/index.ts'` → prints nothing. `npm test && npm run lint` → PASS.

- [ ] **Step 7: Commit**

```bash
git add -A src/renderer tests/renderer-boot.test.ts
git commit -m "feat(renderer): HTTP client is the only Api backing; ?open ticket + ?dev hooks

Removes the preload branch and the desktop-only onCliOpen/onSettingsOpen
subscriptions. Boot redeems the cli:open ticket from the URL; screenshot
hooks arrive as ?dev=<json> instead of a preload-injected window.limnDev."
```

---

### Task 3: Remove Electron; build with `vite` + `tsc`; package skeleton

**Files:**
- Delete: `src/main/index.ts`, `src/preload/index.ts`, `electron.vite.config.ts`, `electron-builder.yml`, `build/icon.icns`
- Create: `vite.config.ts`, `tsconfig.server.json`, `bin/limn.js`, `src/renderer/public/favicon.svg` (copy of `build/icon.svg`), `src/cli/index.ts` (temporary stub, replaced in Task 5)
- Modify: `package.json`, `eslint.config.js`, `src/main/engines/adapters.ts:55-70`, `src/renderer/index.html`, `.gitignore`, `tsconfig.json`
- Test: `npm run build` output + `node dist/cli/index.js --version`

**Interfaces:**
- Produces `dist/renderer/` (SPA), `dist/server/**`, `dist/cli/**`, `dist/shared/**`; `bin/limn.js` → `dist/cli/index.js` which exports nothing and calls `main()` from `./main.js` (Task 5) — for this task the stub prints the version.

- [ ] **Step 1: Delete Electron sources and config**

```bash
git rm -q src/main/index.ts src/preload/index.ts electron.vite.config.ts electron-builder.yml build/icon.icns
git mv build/icon.svg src/renderer/public/favicon.svg
rmdir build 2>/dev/null || true
```

- [ ] **Step 2: `vite.config.ts`**

```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Renderer only. The server/cli are emitted by `tsc -p tsconfig.server.json`.
export default defineConfig({
  root: 'src/renderer',
  publicDir: 'public',
  plugins: [react()],
  build: { outDir: '../../dist/renderer', emptyOutDir: true },
  server: {
    port: 5173,
    proxy: {
      '/rpc': 'http://127.0.0.1:5466',
      '/events': 'http://127.0.0.1:5466',
      '/health': 'http://127.0.0.1:5466'
    }
  }
})
```

`src/renderer/index.html`: add `<link rel="icon" href="/favicon.svg" />` after `<title>`.

- [ ] **Step 3: `tsconfig.server.json`**

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": false,
    "outDir": "dist",
    "rootDir": "src",
    "lib": ["ES2022"],
    "types": ["node"],
    "sourceMap": true
  },
  "include": ["src/main", "src/server", "src/cli", "src/shared"]
}
```

All server-side relative imports already carry `.js` (verified: none without), so `module: ESNext` + `moduleResolution: bundler` emits Node-runnable ESM. `tsconfig.json` `include` stays `["src", "tests", "scripts"]`.

- [ ] **Step 4: `bin/limn.js` and the stub entry**

`bin/limn.js`:

```js
#!/usr/bin/env node
// Node-version gate before anything that touches node:sqlite is imported.
const [maj, min] = process.versions.node.split('.').map(Number)
if (maj < 22 || (maj === 22 && min < 5)) {
  console.error(`Limn needs Node >= 22.5 (found ${process.versions.node}). Install a newer Node and re-run.`)
  process.exit(1)
}
import('../dist/cli/index.js').catch((err) => { console.error(err instanceof Error ? err.stack ?? err.message : String(err)); process.exit(1) })
```

`src/cli/index.ts` (stub for this task only):

```ts
import { APP_VERSION } from '../server/http.js'
console.log(`limn ${APP_VERSION}`)
```

- [ ] **Step 5: `package.json`**

Edit to:

```json
{
  "name": "@glebmish/limn",
  "version": "0.4.0",
  "description": "Agentic local branch review — guided code review backed by Claude or Codex, served to your browser",
  "bin": { "limn": "bin/limn.js" },
  "files": ["bin", "dist"],
  "engines": { "node": ">=22.5" },
  "scripts": {
    "dev": "vite",
    "dev:server": "tsx watch src/cli/index.ts service serve",
    "build": "vite build && tsc -p tsconfig.server.json",
    "serve": "npm run build && node bin/limn.js service serve",
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "lint": "eslint .",
    "pack:smoke": "scripts/pack-smoke.sh"
  },
  "bundleDependencies": [
    "@agentclientprotocol/claude-agent-acp",
    "@agentclientprotocol/codex-acp",
    "@agentclientprotocol/sdk",
    "zod"
  ]
}
```

Keep `private` **removed** (publishing), keep `repository`/`homepage`/`bugs`/`license`/`type`/`author`/`dependencies`. `devDependencies`: remove `electron`, `electron-builder`, `electron-vite`; keep the rest. Then `npm install` to refresh the lock (verify `grep -c '"node_modules/electron' package-lock.json` → 0). `pack:smoke` is created in Task 9; leave the script line in now.

`.gitignore`: `out/` stays harmless; no change needed. Delete the local `out/` dir.

- [ ] **Step 6: Adapters spawn under plain Node**

`src/main/engines/adapters.ts`: in `resolveAdapterEntry` delete the asar comment + `.replace(...)` (return `path.join(pkgDir, binRel)` directly); in `spawnAdapter` drop `ELECTRON_RUN_AS_NODE: '1'` and fix the doc comment to "using the same Node that runs the service (`process.execPath`)". Grep `tests/` for `ELECTRON_RUN_AS_NODE` and update any assertion.

- [ ] **Step 7: ESLint paths**

`eslint.config.js`: `files: ['src/main/**/*.ts', 'src/preload/**/*.ts']` → `['src/main/**/*.ts', 'src/server/**/*.ts', 'src/cli/**/*.ts']`; add `'bin/**'` to the globals-node block by adding a separate `{ files: ['bin/**/*.js'], languageOptions: { globals: globals.node } }`.

- [ ] **Step 8: Build, run, verify**

```bash
rm -rf out dist && npm run build
ls dist/renderer/index.html dist/server/http.js dist/cli/index.js dist/main/ipc.js
node bin/limn.js            # → "limn 0.4.0"
npm test && npm run typecheck && npm run lint
```

Expected: all four files exist; version prints; suite/typecheck/lint green (typecheck is fully green from here on).

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "chore(build): remove Electron; vite + tsc build; npm package skeleton

Deletes the Electron main/preload/builder config, builds the renderer
with plain vite and emits server/cli/shared with tsc into dist/, adds
bin/limn.js with a Node >= 22.5 gate, renames the package to
@glebmish/limn 0.4.0 and bundles the four runtime deps."
```

---

### Task 4: CLI argument parser

**Files:**
- Create: `src/cli/args.ts`
- Test: `tests/cli-args.test.ts`

**Interfaces:**
- Produces:

```ts
export type CliCommand =
  | { kind: 'open'; dir: string; base?: string; compare?: string; hub: boolean; fresh: boolean; noService: boolean }
  | { kind: 'serve'; port?: number; port80: boolean }
  | { kind: 'service-install'; port80: boolean }
  | { kind: 'service-uninstall' }
  | { kind: 'service-status' }
  | { kind: 'service-logs'; follow: boolean }
  | { kind: 'version' }
  | { kind: 'help'; topic?: 'service' }
export function parseArgs(argv: string[], cwd: string): CliCommand   // throws CliUsageError
export class CliUsageError extends Error {}
```

- [ ] **Step 1: Write the failing tests**

`tests/cli-args.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { parseArgs, CliUsageError } from '../src/cli/args'

const cwd = '/work/repo'

describe('parseArgs', () => {
  it('bare invocation is `open` on cwd', () => {
    expect(parseArgs([], cwd)).toEqual({ kind: 'open', dir: cwd, hub: false, fresh: false, noService: false })
  })
  it('open takes a positional dir (absolute or relative to cwd) and ref flags', () => {
    expect(parseArgs(['open', '/x', '--base', 'main', '--branch', 'feat'], cwd)).toMatchObject({ kind: 'open', dir: '/x', base: 'main', compare: 'feat' })
    expect(parseArgs(['sub/dir'], cwd)).toMatchObject({ kind: 'open', dir: '/work/repo/sub/dir' })
    expect(parseArgs(['--base=main', '--branch=feat', '--new', '--hub', '--no-service'], cwd))
      .toMatchObject({ kind: 'open', dir: cwd, base: 'main', compare: 'feat', fresh: true, hub: true, noService: true })
  })
  it('service subcommands', () => {
    expect(parseArgs(['service', 'serve'], cwd)).toEqual({ kind: 'serve', port80: false })
    expect(parseArgs(['service', 'serve', '--port', '7000', '--port-80'], cwd)).toEqual({ kind: 'serve', port: 7000, port80: true })
    expect(parseArgs(['service', 'install', '--port-80'], cwd)).toEqual({ kind: 'service-install', port80: true })
    expect(parseArgs(['service', 'uninstall'], cwd)).toEqual({ kind: 'service-uninstall' })
    expect(parseArgs(['service', 'status'], cwd)).toEqual({ kind: 'service-status' })
    expect(parseArgs(['service', 'logs', '-f'], cwd)).toEqual({ kind: 'service-logs', follow: true })
  })
  it('version and help', () => {
    expect(parseArgs(['--version'], cwd)).toEqual({ kind: 'version' })
    expect(parseArgs(['-v'], cwd)).toEqual({ kind: 'version' })
    expect(parseArgs(['--help'], cwd)).toEqual({ kind: 'help' })
    expect(parseArgs(['service'], cwd)).toEqual({ kind: 'help', topic: 'service' })
    expect(parseArgs(['service', '--help'], cwd)).toEqual({ kind: 'help', topic: 'service' })
  })
  it('rejects unknown commands, flags, and bad ports', () => {
    expect(() => parseArgs(['frobnicate'], cwd)).toThrow(CliUsageError)
    expect(() => parseArgs(['open', '--bogus'], cwd)).toThrow(/unknown flag --bogus/)
    expect(() => parseArgs(['service', 'serve', '--port', 'x'], cwd)).toThrow(/--port/)
    expect(() => parseArgs(['service', 'dance'], cwd)).toThrow(/unknown service command/)
  })
})
```

Note: a positional that is not a known command word (`open`, `service`) is treated as the `open` dir — `limn sub/dir` works. Directory-like positionals are resolved with `path.resolve(cwd, p)`.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/cli-args.test.ts` → FAIL, module not found.

- [ ] **Step 3: Implement `src/cli/args.ts`**

```ts
import path from 'node:path'

export class CliUsageError extends Error {}

export type CliCommand =
  | { kind: 'open'; dir: string; base?: string; compare?: string; hub: boolean; fresh: boolean; noService: boolean }
  | { kind: 'serve'; port?: number; port80: boolean }
  | { kind: 'service-install'; port80: boolean }
  | { kind: 'service-uninstall' }
  | { kind: 'service-status' }
  | { kind: 'service-logs'; follow: boolean }
  | { kind: 'version' }
  | { kind: 'help'; topic?: 'service' }

/** `--name value` / `--name=value` reader shared by every command. */
function takeValue(argv: string[], i: number, name: string): [string, number] {
  const tok = argv[i]
  if (tok.startsWith(`${name}=`)) return [tok.slice(name.length + 1), i]
  const next = argv[i + 1]
  if (next === undefined || next.startsWith('-')) throw new CliUsageError(`${name} needs a value`)
  return [next, i + 1]
}

function parsePort(raw: string): number {
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new CliUsageError(`--port must be an integer 0-65535, got "${raw}"`)
  return n
}

function parseOpen(argv: string[], cwd: string): CliCommand {
  const out: Extract<CliCommand, { kind: 'open' }> = { kind: 'open', dir: cwd, hub: false, fresh: false, noService: false }
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]
    if (tok === '--base' || tok.startsWith('--base=')) { [out.base, i] = takeValue(argv, i, '--base'); continue }
    if (tok === '--branch' || tok.startsWith('--branch=')) { [out.compare, i] = takeValue(argv, i, '--branch'); continue }
    if (tok === '--new') { out.fresh = true; continue }
    if (tok === '--hub') { out.hub = true; continue }
    if (tok === '--no-service') { out.noService = true; continue }
    if (tok.startsWith('-')) throw new CliUsageError(`unknown flag ${tok}`)
    out.dir = path.resolve(cwd, tok)
  }
  return out
}

function parseService(argv: string[]): CliCommand {
  const [sub, ...rest] = argv
  if (!sub || sub === '--help' || sub === '-h') return { kind: 'help', topic: 'service' }
  const flag = (name: string): boolean => rest.includes(name)
  const reject = (allowed: string[]): void => {
    for (const t of rest) if (t.startsWith('-') && !allowed.some((a) => t === a || t.startsWith(`${a}=`))) throw new CliUsageError(`unknown flag ${t}`)
  }
  switch (sub) {
    case 'serve': {
      reject(['--port', '--port-80'])
      const out: Extract<CliCommand, { kind: 'serve' }> = { kind: 'serve', port80: flag('--port-80') }
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] === '--port' || rest[i].startsWith('--port=')) { const [v, j] = takeValue(rest, i, '--port'); out.port = parsePort(v); i = j }
      }
      return out
    }
    case 'install': reject(['--port-80']); return { kind: 'service-install', port80: flag('--port-80') }
    case 'uninstall': reject([]); return { kind: 'service-uninstall' }
    case 'status': reject([]); return { kind: 'service-status' }
    case 'logs': reject(['-f', '--follow']); return { kind: 'service-logs', follow: flag('-f') || flag('--follow') }
    default: throw new CliUsageError(`unknown service command "${sub}" (serve, install, uninstall, status, logs)`)
  }
}

export function parseArgs(argv: string[], cwd: string): CliCommand {
  const [first, ...rest] = argv
  if (first === '--version' || first === '-v') return { kind: 'version' }
  if (first === '--help' || first === '-h') return { kind: 'help' }
  if (first === 'service') return parseService(rest)
  if (first === 'open') return parseOpen(rest, cwd)
  if (first !== undefined && !first.startsWith('-') && first !== 'open') {
    // `limn <dir>` — a bare positional is the open dir unless it is a known word
    if (['serve', 'install', 'uninstall', 'status', 'logs'].includes(first)) throw new CliUsageError(`unknown command "${first}" — did you mean "limn service ${first}"?`)
    if (!first.includes('/') && !first.includes('.') && !['.', '..'].includes(first) && first !== cwd) {
      // a lone word that isn't a path: still treat as a dir, but a nonexistent one is caught by `open` at runtime
    }
  }
  return parseOpen(argv, cwd)
}
```

Simplify the tail: the `if (first !== undefined …)` block reduces to the "did you mean" check — keep only that `if` and drop the empty inner `if`. `frobnicate` then parses as `open` with `dir=/work/repo/frobnicate`, which the test expects to throw — so add: when `first` has no `/` and does not exist on disk relative to `cwd` (`fs.existsSync(path.resolve(cwd, first))` is false) throw `CliUsageError(\`unknown command "${first}"\`)`. Import `fs` for that check; in the test, `/work/repo/frobnicate` does not exist, and `sub/dir` must be created with `fs.mkdtempSync`-based `cwd` in the test instead of the literal `/work/repo` — adjust the test to build a real temp `cwd` with a `sub/dir` inside.

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/cli-args.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/args.ts tests/cli-args.test.ts
git commit -m "feat(cli): argv parser for open / service subcommands"
```

---

### Task 5: `limn service serve`, `/health` probe, browser opener, dispatch

**Files:**
- Create: `src/cli/health.ts`, `src/cli/browser.ts`, `src/cli/serve.ts`, `src/cli/main.ts`
- Modify: `src/cli/index.ts` (replace the Task 3 stub)
- Delete: `src/server/index.ts` (its `main()` is now `serve`)
- Test: `tests/cli-serve.test.ts`, `tests/cli-health.test.ts`

**Interfaces:**
- Produces `probeHealth(port: number, host = '127.0.0.1'): Promise<HealthInfo | null>` with `HealthInfo = { app: 'limn'; version: string; pid: number; startedAt: string; port: number }`.
- Produces `openBrowser(url: string): void` (spawns `open` / `xdg-open` / `cmd /c start`, detached, never throws).
- Produces `classifyBusyPort(port: number): Promise<'limn' | 'other' | 'free'>` and `runServe(cmd: { port?: number; port80: boolean }, io: Io): Promise<number>` (exit code).
- Produces `Io = { out(line: string): void; err(line: string): void; isTTY: boolean; ask(question: string): Promise<boolean> }` in `src/cli/main.ts`, `main(argv: string[], io?: Io): Promise<number>`.
- Produces `bootstrapPath()` in `src/cli/serve.ts` (moved from `src/server/index.ts`).

- [ ] **Step 1: Write the failing tests**

`tests/cli-health.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import http from 'node:http'
import { probeHealth } from '../src/cli/health'

function listen(handler: http.RequestListener): Promise<{ port: number; close(): void }> {
  return new Promise((resolve) => {
    const s = http.createServer(handler)
    s.listen(0, '127.0.0.1', () => resolve({ port: (s.address() as { port: number }).port, close: () => s.close() }))
  })
}

describe('probeHealth', () => {
  it('returns the health body for a Limn server', async () => {
    const s = await listen((_req, res) => res.end(JSON.stringify({ app: 'limn', version: '0.4.0', pid: 1, startedAt: 'x', port: 1 })))
    expect(await probeHealth(s.port)).toMatchObject({ app: 'limn', version: '0.4.0' })
    s.close()
  })
  it('returns null for a non-Limn listener and for a closed port', async () => {
    const s = await listen((_req, res) => res.end('<html>hi</html>'))
    expect(await probeHealth(s.port)).toBeNull()
    const port = s.port
    s.close()
    await new Promise((r) => setTimeout(r, 50))
    expect(await probeHealth(port)).toBeNull()
  })
})
```

`tests/cli-serve.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { classifyBusyPort, runServe } from '../src/cli/serve'

function listen(handler: http.RequestListener): Promise<{ port: number; close(): void }> {
  return new Promise((resolve) => {
    const s = http.createServer(handler)
    s.listen(0, '127.0.0.1', () => resolve({ port: (s.address() as { port: number }).port, close: () => s.close() }))
  })
}
const io = () => { const lines: string[] = []; return { lines, io: { out: (l: string) => lines.push(l), err: (l: string) => lines.push(l), isTTY: false, ask: async () => false } } }

describe('serve', () => {
  it('classifies a Limn listener, a foreign listener, and a free port', async () => {
    const limn = await listen((_r, res) => res.end(JSON.stringify({ app: 'limn', version: '0', pid: 1, startedAt: '', port: 0 })))
    const other = await listen((_r, res) => res.end('nope'))
    expect(await classifyBusyPort(limn.port)).toBe('limn')
    expect(await classifyBusyPort(other.port)).toBe('other')
    const freePort = other.port; other.close(); await new Promise((r) => setTimeout(r, 50))
    expect(await classifyBusyPort(freePort)).toBe('free')
    limn.close()
  })
  it('exits 1 with the "already running" message when a Limn server holds the port', async () => {
    const limn = await listen((_r, res) => res.end(JSON.stringify({ app: 'limn', version: '0', pid: 1, startedAt: '', port: 0 })))
    const { lines, io: o } = io()
    process.env.LIMN_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'limn-serve-')), 'limn.db')
    expect(await runServe({ port: limn.port, port80: false }, o)).toBe(1)
    expect(lines.join('\n')).toMatch(/already running .*limn service status/)
    limn.close()
  })
  it('exits 1 with the "another program" message for a foreign listener', async () => {
    const other = await listen((_r, res) => res.end('nope'))
    const { lines, io: o } = io()
    expect(await runServe({ port: other.port, port80: false }, o)).toBe(1)
    expect(lines.join('\n')).toMatch(/in use by another program.*--port/)
    other.close()
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/cli-health.test.ts tests/cli-serve.test.ts` → FAIL, modules not found.

- [ ] **Step 3: Implement `health.ts`, `browser.ts`, `serve.ts`, `main.ts`, `index.ts`**

`src/cli/health.ts`:

```ts
export interface HealthInfo { app: 'limn'; version: string; pid: number; startedAt: string; port: number }

/** GET /health on loopback. Null when nothing answers or the answer isn't Limn. */
export async function probeHealth(port: number, host = '127.0.0.1'): Promise<HealthInfo | null> {
  try {
    const res = await fetch(`http://${host}:${port}/health`, { signal: AbortSignal.timeout(1500) })
    if (!res.ok) return null
    const body = (await res.json()) as Partial<HealthInfo>
    return body && body.app === 'limn' && typeof body.version === 'string' ? (body as HealthInfo) : null
  } catch { return null }
}
```

`src/cli/browser.ts`:

```ts
import { spawn } from 'node:child_process'

/** Open a URL in the user's default browser. Fire-and-forget; never throws. */
export function openBrowser(url: string): void {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
      : ['xdg-open', [url]]
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref()
  } catch { /* no opener available — the URL is printed anyway */ }
}
```

`src/cli/serve.ts`:

```ts
import net from 'node:net'
import { execSync } from 'node:child_process'
import { startServer, DEFAULT_PORT, type RunningServer } from '../server/http.js'
import { defaultDbPath } from '../main/paths.js'
import { probeHealth } from './health.js'
import type { Io } from './main.js'

/** GUI/launchd launches don't inherit the login-shell PATH; engines need git/claude/codex. */
export function bootstrapPath(): void {
  try {
    const shell = process.env.SHELL || '/bin/zsh'
    const p = execSync(`${shell} -ilc 'echo -n "$PATH"'`, { timeout: 5000 }).toString()
    if (p) process.env.PATH = p
  } catch { /* keep default PATH */ }
}

export function resolvePort(explicit?: number): number {
  if (explicit !== undefined) return explicit
  const env = Number(process.env.LIMN_PORT)
  return Number.isInteger(env) && env > 0 ? env : DEFAULT_PORT
}

export async function classifyBusyPort(port: number): Promise<'limn' | 'other' | 'free'> {
  if (await probeHealth(port)) return 'limn'
  const free = await new Promise<boolean>((resolve) => {
    const s = net.createServer()
    s.once('error', () => resolve(false))
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)))
  })
  return free ? 'free' : 'other'
}

export function serverOptions(port: number, port80: boolean) {
  return {
    port,
    host: process.env.LIMN_WEB_HOST,
    token: process.env.LIMN_WEB_TOKEN,
    staticRoot: process.env.LIMN_WEB_STATIC,
    dbPath: defaultDbPath(),
    vanityPort80: port80
  }
}

/** Foreground server. Resolves with an exit code only on failure; on success it
 *  runs until SIGINT/SIGTERM. `onReady` lets `open` reuse this for the server role. */
export async function runServe(cmd: { port?: number; port80: boolean }, io: Io, onReady?: (s: RunningServer) => void): Promise<number> {
  const port = resolvePort(cmd.port)
  if (port !== 0) {
    const state = await classifyBusyPort(port)
    if (state === 'limn') { io.err(`error: a Limn service is already running on ${port} (limn service status)`); return 1 }
    if (state === 'other') { io.err(`error: port ${port} is in use by another program; try --port N`); return 1 }
  }
  bootstrapPath()
  let server: RunningServer
  try {
    server = await startServer({ ...serverOptions(port, cmd.port80), log: io.out })
  } catch (err) {
    io.err(`error: ${err instanceof Error ? err.message : String(err)}`)
    return 1
  }
  onReady?.(server)
  await new Promise<void>((resolve) => {
    const stop = (): void => { io.out('[limn] shutting down'); void server.close().then(resolve) }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  })
  return 0
}
```

`src/cli/main.ts`:

```ts
import readline from 'node:readline'
import { parseArgs, CliUsageError } from './args.js'
import { APP_VERSION } from '../server/http.js'
import { runServe } from './serve.js'
import { runOpen } from './open.js'
import { runServiceCommand } from './service/index.js'

export interface Io {
  out(line: string): void
  err(line: string): void
  isTTY: boolean
  /** y/N prompt; resolves false when not a TTY */
  ask(question: string): Promise<boolean>
}

export function defaultIo(): Io {
  const isTTY = Boolean(process.stdin.isTTY && process.stdout.isTTY)
  return {
    out: (l) => console.log(l),
    err: (l) => console.error(l),
    isTTY,
    ask: (q) => new Promise((resolve) => {
      if (!isTTY) { resolve(false); return }
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
      rl.question(`${q} [Y/n] `, (a) => { rl.close(); resolve(!/^n/i.test(a.trim())) })
    })
  }
}

export const HELP = `limn — agentic local branch review, in your browser

usage:
  limn [DIR] [--base REF] [--branch BRANCH] [--new] [--hub] [--no-service]
  limn open …                      same as above
  limn service <command>           background service (limn service --help)
  limn --version | --help

open: review DIR (default: current directory). If a Limn service is running it
opens there; otherwise a server is started for you.`

export const HELP_SERVICE = `limn service — the always-on Limn server

  serve [--port N] [--port-80]   run the server in the foreground (default port 5466)
  install [--port-80]            install + start the background service (launchd / systemd --user)
  uninstall                      stop and remove the background service (database untouched)
  status                         activation, URL, pid, node path, native stop/restart commands
  logs [-f]                      show (or follow) the service log`

export async function main(argv: string[], io: Io = defaultIo()): Promise<number> {
  let cmd
  try { cmd = parseArgs(argv, process.cwd()) } catch (err) {
    if (err instanceof CliUsageError) { io.err(`limn: ${err.message}`); io.err(HELP); return 2 }
    throw err
  }
  switch (cmd.kind) {
    case 'version': io.out(`limn ${APP_VERSION}`); return 0
    case 'help': io.out(cmd.topic === 'service' ? HELP_SERVICE : HELP); return 0
    case 'serve': return runServe(cmd, io)
    case 'open': return runOpen(cmd, io)
    default: return runServiceCommand(cmd, io)
  }
}
```

Tasks 6 and 7 create `open.ts` and `service/index.ts`; for this task create them as stubs that return `io.err('not implemented'); return 1` so the build compiles, and replace them in their tasks.

`src/cli/index.ts`:

```ts
import { main } from './main.js'

main(process.argv.slice(2)).then((code) => { process.exitCode = code }, (err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err))
  process.exitCode = 1
})
```

Delete `src/server/index.ts` (`git rm`).

- [ ] **Step 4: Run tests, build, smoke**

```bash
npx vitest run tests/cli-health.test.ts tests/cli-serve.test.ts     # PASS
npm run build
LIMN_DB=/tmp/limn-smoke.db node bin/limn.js service serve --port 0 &   # prints "[limn] serving http://limn.localhost:<port>"
```

Then `curl -s http://127.0.0.1:<port>/health` → JSON with `"app":"limn"`, `curl -s http://limn.localhost:<port>/` → the SPA HTML; `kill %1`. `npm test && npm run typecheck && npm run lint` → green.

- [ ] **Step 5: Commit**

```bash
git add -A src/cli src/server tests/cli-health.test.ts tests/cli-serve.test.ts
git commit -m "feat(cli): limn service serve, /health probe, browser opener, dispatch"
```

---

### Task 6: Dual-role `limn open` (client / server / first-run prompt) + old-shim migration

**Files:**
- Create: `src/cli/open.ts` (replace stub), `src/cli/state.ts`, `src/cli/shim.ts`
- Test: `tests/cli-open-role.test.ts`, `tests/cli-shim.test.ts`

**Interfaces:**
- Consumes `probeHealth`, `runServe`, `openBrowser`, `Io`, `CliCommand` (open), `cliStatePath()`.
- Consumes from Task 7 (stub until then): `serviceBackend(): ServiceBackend | null` and `ServiceBackend.status()` — for this task import `isServiceInstalled(): Promise<boolean>` from `./service/index.js` and stub it to `false`.
- Produces:

```ts
export type OpenRole = { role: 'client' } | { role: 'server'; offerService: boolean }
export function decideOpen(input: { health: HealthInfo | null; noService: boolean; isTTY: boolean; serviceInstalled: boolean; declinedBefore: boolean }): OpenRole
export function isNpxInvocation(entryPath: string): boolean
export async function runOpen(cmd, io): Promise<number>
export function readCliState(): CliState; export function writeCliState(patch: Partial<CliState>): void   // CliState = { servicePromptDeclined?: boolean }
export function findOldShim(candidates?: string[]): string | null   // src/cli/shim.ts
```

- [ ] **Step 1: Write the failing tests**

`tests/cli-open-role.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { decideOpen, isNpxInvocation } from '../src/cli/open'

const health = { app: 'limn' as const, version: '0.4.0', pid: 1, startedAt: '', port: 5466 }
const base = { health: null, noService: false, isTTY: true, serviceInstalled: false, declinedBefore: false }

describe('decideOpen', () => {
  it('client role whenever a server answers', () => {
    expect(decideOpen({ ...base, health })).toEqual({ role: 'client' })
    expect(decideOpen({ ...base, health, noService: true })).toEqual({ role: 'client' })
  })
  it('server role offers the service only on a TTY, when not installed, not declined, not --no-service', () => {
    expect(decideOpen(base)).toEqual({ role: 'server', offerService: true })
    expect(decideOpen({ ...base, isTTY: false })).toEqual({ role: 'server', offerService: false })
    expect(decideOpen({ ...base, noService: true })).toEqual({ role: 'server', offerService: false })
    expect(decideOpen({ ...base, declinedBefore: true })).toEqual({ role: 'server', offerService: false })
    // installed but not answering → KeepAlive is respawning it, or node moved; don't re-offer, run foreground
    expect(decideOpen({ ...base, serviceInstalled: true })).toEqual({ role: 'server', offerService: false })
  })
})

describe('isNpxInvocation', () => {
  it('detects the npx cache path', () => {
    expect(isNpxInvocation('/Users/x/.npm/_npx/abc123/node_modules/@glebmish/limn/dist/cli/index.js')).toBe(true)
    expect(isNpxInvocation('/opt/homebrew/lib/node_modules/@glebmish/limn/dist/cli/index.js')).toBe(false)
  })
})
```

`tests/cli-shim.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { findOldShim } from '../src/cli/shim'

describe('findOldShim', () => {
  it('finds a shim generated by the Electron app and ignores other files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limn-shim-'))
    const shim = path.join(dir, 'limn')
    fs.writeFileSync(shim, '#!/bin/sh\n# limn — open Limn for a repository (generated by the app; reinstall via app menu if the app moves)\nexec open -n -a "/Applications/Limn.app" --args "$@"\n')
    const other = path.join(dir, 'limn-other')
    fs.writeFileSync(other, '#!/bin/sh\necho hi\n')
    expect(findOldShim([shim])).toBe(shim)
    expect(findOldShim([other])).toBeNull()
    expect(findOldShim([path.join(dir, 'missing')])).toBeNull()
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/cli-open-role.test.ts tests/cli-shim.test.ts` → FAIL.

- [ ] **Step 3: Implement**

`src/cli/state.ts`:

```ts
import fs from 'node:fs'
import path from 'node:path'
import { cliStatePath } from '../main/paths.js'

export interface CliState { servicePromptDeclined?: boolean }

export function readCliState(): CliState {
  try { return JSON.parse(fs.readFileSync(cliStatePath(), 'utf8')) as CliState } catch { return {} }
}

export function writeCliState(patch: Partial<CliState>): void {
  const file = cliStatePath()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ ...readCliState(), ...patch }, null, 2) + '\n')
}
```

`src/cli/shim.ts`:

```ts
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const SHIM_MARK = '# limn — open Limn for a repository (generated by the app'

/** The Electron app used to install a shell shim named `limn`; it would shadow (or be
 *  shadowed by) the npm bin depending on PATH order. */
export function findOldShim(candidates = [path.join(os.homedir(), '.local', 'bin', 'limn'), '/usr/local/bin/limn']): string | null {
  for (const p of candidates) {
    try {
      const head = fs.readFileSync(p, 'utf8').slice(0, 400)
      if (head.includes(SHIM_MARK)) return p
    } catch { /* missing / unreadable */ }
  }
  return null
}
```

`src/cli/open.ts`:

```ts
import { execFileSync } from 'node:child_process'
import type { CliCommand } from './args.js'
import type { HealthInfo } from './health.js'
import { probeHealth } from './health.js'
import { openBrowser } from './browser.js'
import { resolvePort, runServe } from './serve.js'
import { readCliState, writeCliState } from './state.js'
import { findOldShim } from './shim.js'
import { isServiceInstalled, installService } from './service/index.js'
import { issueCliOpen, type CliOpenArgs } from '../main/cliOpen.js'
import type { Io } from './main.js'

type OpenCmd = Extract<CliCommand, { kind: 'open' }>
export type OpenRole = { role: 'client' } | { role: 'server'; offerService: boolean }

export function decideOpen(i: { health: HealthInfo | null; noService: boolean; isTTY: boolean; serviceInstalled: boolean; declinedBefore: boolean }): OpenRole {
  if (i.health) return { role: 'client' }
  return { role: 'server', offerService: i.isTTY && !i.noService && !i.serviceInstalled && !i.declinedBefore }
}

export function isNpxInvocation(entryPath: string): boolean {
  return /[\\/]_npx[\\/]/.test(entryPath)
}

function toArgs(cmd: OpenCmd): CliOpenArgs {
  return { dir: cmd.dir, base: cmd.base, compare: cmd.compare, hub: cmd.hub, fresh: cmd.fresh }
}

async function issueRemote(port: number, args: CliOpenArgs): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/rpc/cli:open`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify([args])
  })
  const body = (await res.json()) as { value?: { ticket: string }; error?: string }
  if (!res.ok || !body.value) throw new Error(body.error || `cli:open failed (${res.status})`)
  return body.value.ticket
}

function pageUrl(port: number, ticket: string): string {
  return `http://limn.localhost:${port}/?open=${ticket}`
}

async function offerShimRemoval(io: Io): Promise<void> {
  const shim = findOldShim()
  if (!shim) return
  if (await io.ask(`Found the old desktop-app shim at ${shim}; it conflicts with this command. Delete it?`)) {
    try { execFileSync('rm', ['-f', shim]); io.out(`removed ${shim}`) } catch (err) { io.err(`could not remove ${shim}: ${err instanceof Error ? err.message : err}`) }
  }
}

export async function runOpen(cmd: OpenCmd, io: Io): Promise<number> {
  const port = resolvePort()
  await offerShimRemoval(io)
  const health = await probeHealth(port)
  const decision = decideOpen({
    health, noService: cmd.noService, isTTY: io.isTTY,
    serviceInstalled: await isServiceInstalled(), declinedBefore: Boolean(readCliState().servicePromptDeclined)
  })

  if (decision.role === 'client') {
    const ticket = await issueRemote(port, toArgs(cmd))
    const url = pageUrl(port, ticket)
    io.out(`opening ${url}`)
    openBrowser(url)
    return 0
  }

  if (decision.offerService) {
    const npx = isNpxInvocation(process.argv[1] ?? '')
    const q = npx
      ? `Install Limn globally (npm i -g @glebmish/limn) and as a background service so http://limn.localhost:${port} is always available?`
      : `Install Limn as a background service so http://limn.localhost:${port} is always available? (LaunchAgent in ~/Library/LaunchAgents)`
    if (await io.ask(q)) {
      if (npx) {
        io.out('installing @glebmish/limn globally…')
        try { execFileSync('npm', ['i', '-g', '@glebmish/limn'], { stdio: 'inherit' }) } catch { io.err('npm i -g failed; run it manually, then `limn service install`'); return 1 }
        // hand off to the freshly installed global binary so the unit records its stable path
        try { execFileSync('limn', ['service', 'install', ...(cmd.noService ? [] : [])], { stdio: 'inherit' }) } catch { return 1 }
      } else {
        const code = await installService({ port80: false }, io)
        if (code !== 0) return code
      }
      const ticket = await issueRemote(port, toArgs(cmd))
      const url = pageUrl(port, ticket)
      io.out(`opening ${url}`)
      openBrowser(url)
      return 0
    }
    writeCliState({ servicePromptDeclined: true })
    io.out('ok — running in the foreground (Ctrl-C to stop). Re-offer any time with `limn service install`.')
  }

  // server role: run the server in this process, open the browser once it is up
  return runServe({ port80: false }, io, (server) => {
    void issueCliOpen(toArgs(cmd)).then(({ ticket }) => {
      const url = pageUrl(server.port, ticket)
      io.out(`opening ${url}`)
      openBrowser(url)
    })
  })
}
```

`installService(opts, io): Promise<number>` and `isServiceInstalled(): Promise<boolean>` come from Task 7 — until then keep the stub module `src/cli/service/index.ts` exporting `isServiceInstalled = async () => false`, `installService = async () => 1`, and `runServiceCommand`.

- [ ] **Step 4: Run tests, then a real foreground round trip**

`npx vitest run tests/cli-open-role.test.ts tests/cli-shim.test.ts` → PASS.

```bash
npm run build
LIMN_DB=/tmp/limn-smoke.db LIMN_PORT=5499 node bin/limn.js open --no-service . &
```

Expected stdout: `[limn] serving http://limn.localhost:5499 …` then `opening http://limn.localhost:5499/?open=<hex>` and the default browser opens the review for the current repo. Then in a second shell `LIMN_PORT=5499 node bin/limn.js open --hub` → prints `opening …` (client role) and a new tab shows the repo hub. `kill %1`. `npm test && npm run typecheck && npm run lint` → green.

- [ ] **Step 5: Commit**

```bash
git add -A src/cli tests/cli-open-role.test.ts tests/cli-shim.test.ts
git commit -m "feat(cli): dual-role limn open with first-run service prompt and old-shim cleanup"
```

---

### Task 7: Service backends — launchd (macOS) and systemd `--user` (Linux)

**Files:**
- Create: `src/cli/service/types.ts`, `src/cli/service/launchd.ts`, `src/cli/service/systemd.ts`
- Test: `tests/service-launchd.test.ts`, `tests/service-systemd.test.ts`

**Interfaces:**
- Produces:

```ts
// types.ts
export interface UnitSpec { nodePath: string; entryPath: string; port80: boolean; pathEnv: string; logFile: string; home: string }
export type Activation =
  | { kind: 'service'; loaded: true; running: boolean; pid: number | null; unitPath: string; nodePath: string; nodeOk: boolean; restartCmd: string; stopCmd: string }
  | { kind: 'service'; loaded: false; unitPath: string }
export interface ServiceBackend {
  readonly name: 'launchd' | 'systemd'
  unitPath(): string
  renderUnit(spec: UnitSpec): string
  install(spec: UnitSpec, run: Exec): Promise<void>      // write + (re)load + start
  uninstall(run: Exec): Promise<void>
  activation(run: Exec): Promise<Activation>
  logsCommand(follow: boolean): { cmd: string; args: string[] }
}
export type Exec = (cmd: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>
```

- Produces `launchd.parseLaunchctlPrint(text: string): { pid: number | null; running: boolean }`, `systemd.parseShow(text: string): { active: boolean; pid: number | null }`.

- [ ] **Step 1: Write the failing tests**

`tests/service-launchd.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { launchd, parseLaunchctlPrint, LABEL } from '../src/cli/service/launchd'

const spec = { nodePath: '/opt/homebrew/bin/node', entryPath: '/opt/homebrew/lib/node_modules/@glebmish/limn/dist/cli/index.js', port80: false, pathEnv: '/opt/homebrew/bin:/usr/bin:/bin', logFile: '/Users/u/Library/Logs/limn.log', home: '/Users/u' }

describe('launchd unit', () => {
  it('renders a KeepAlive LaunchAgent that runs `service serve` with absolute paths', () => {
    const xml = launchd.renderUnit(spec)
    expect(xml).toContain(`<string>${LABEL}</string>`)
    expect(xml).toContain('<string>/opt/homebrew/bin/node</string>')
    expect(xml).toContain('<string>/opt/homebrew/lib/node_modules/@glebmish/limn/dist/cli/index.js</string>')
    expect(xml).toMatch(/<string>service<\/string>\s*<string>serve<\/string>/)
    expect(xml).not.toContain('--port-80')
    expect(xml).toContain('<key>RunAtLoad</key>')
    expect(xml).toContain('<key>KeepAlive</key>')
    expect(xml).toContain('<string>/opt/homebrew/bin:/usr/bin:/bin</string>')
    expect(xml).toContain('<string>/Users/u/Library/Logs/limn.log</string>')
    expect(xml).toContain('launchctl kickstart -k')
  })
  it('adds --port-80 when requested', () => {
    expect(launchd.renderUnit({ ...spec, port80: true })).toMatch(/<string>--port-80<\/string>/)
  })
  it('unit path is the user LaunchAgents dir', () => {
    expect(launchd.unitPath()).toMatch(/\/Library\/LaunchAgents\/dev\.glebmish\.limn\.plist$/)
  })
})

describe('parseLaunchctlPrint', () => {
  it('extracts pid and running state', () => {
    expect(parseLaunchctlPrint('dev.glebmish.limn = {\n\tactive count = 1\n\tpath = /x\n\tstate = running\n\tpid = 4211\n}')).toEqual({ pid: 4211, running: true })
    expect(parseLaunchctlPrint('dev.glebmish.limn = {\n\tstate = not running\n\tlast exit code = 1\n}')).toEqual({ pid: null, running: false })
  })
})
```

`tests/service-systemd.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { systemd, parseShow } from '../src/cli/service/systemd'

const spec = { nodePath: '/usr/bin/node', entryPath: '/usr/lib/node_modules/@glebmish/limn/dist/cli/index.js', port80: false, pathEnv: '/usr/bin:/bin', logFile: '/home/u/.local/state/limn/limn.log', home: '/home/u' }

describe('systemd unit', () => {
  it('renders a user unit with Restart=always and the absolute ExecStart', () => {
    const unit = systemd.renderUnit(spec)
    expect(unit).toContain('[Service]')
    expect(unit).toContain('ExecStart=/usr/bin/node /usr/lib/node_modules/@glebmish/limn/dist/cli/index.js service serve')
    expect(unit).toContain('Restart=always')
    expect(unit).toContain('Environment=PATH=/usr/bin:/bin')
    expect(unit).toContain('WantedBy=default.target')
    expect(systemd.renderUnit({ ...spec, port80: true })).toContain('service serve --port-80')
  })
  it('unit path is ~/.config/systemd/user/limn.service', () => {
    expect(systemd.unitPath()).toMatch(/\/\.config\/systemd\/user\/limn\.service$/)
  })
  it('parseShow reads ActiveState/MainPID', () => {
    expect(parseShow('ActiveState=active\nMainPID=123\n')).toEqual({ active: true, pid: 123 })
    expect(parseShow('ActiveState=inactive\nMainPID=0\n')).toEqual({ active: false, pid: null })
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/service-launchd.test.ts tests/service-systemd.test.ts` → FAIL.

- [ ] **Step 3: Implement**

`src/cli/service/types.ts` — exactly the interfaces above, plus:

```ts
import { execFile } from 'node:child_process'
export const execAsync: Exec = (cmd, args) => new Promise((resolve) => {
  execFile(cmd, args, { encoding: 'utf8' }, (err, stdout, stderr) => {
    const code = err && typeof (err as NodeJS.ErrnoException & { code?: number }).code === 'number' ? (err as unknown as { code: number }).code : err ? 1 : 0
    resolve({ code, stdout: String(stdout), stderr: String(stderr) })
  })
})
```

`src/cli/service/launchd.ts`:

```ts
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Activation, Exec, ServiceBackend, UnitSpec } from './types.js'

export const LABEL = 'dev.glebmish.limn'
const uid = (): number => os.userInfo().uid
const target = (): string => `gui/${uid()}/${LABEL}`

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function parseLaunchctlPrint(text: string): { pid: number | null; running: boolean } {
  const pid = /^\s*pid = (\d+)/m.exec(text)
  const state = /^\s*state = (.+)$/m.exec(text)?.[1]?.trim()
  return { pid: pid ? Number(pid[1]) : null, running: state === 'running' }
}

export const launchd: ServiceBackend = {
  name: 'launchd',
  unitPath: () => path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`),
  renderUnit(spec: UnitSpec): string {
    const args = [spec.nodePath, spec.entryPath, 'service', 'serve', ...(spec.port80 ? ['--port-80'] : [])]
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!--
  Limn background service (generated by \`limn service install\`; re-run it to repair
  after Node moves). launchd keeps the process in memory: after \`npm i -g @glebmish/limn@latest\`
  restart it with
      launchctl kickstart -k ${target()}
  stop it with
      launchctl bootout ${target()}
  or remove it entirely with \`limn service uninstall\`.
-->
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${xmlEscape(a)}</string>`).join('\n')}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xmlEscape(spec.pathEnv)}</string>
    <key>HOME</key>
    <string>${xmlEscape(spec.home)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(spec.logFile)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(spec.logFile)}</string>
</dict>
</plist>
`
  },
  async install(spec, run) {
    const file = this.unitPath()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.mkdirSync(path.dirname(spec.logFile), { recursive: true })
    fs.writeFileSync(file, this.renderUnit(spec))
    await run('launchctl', ['bootout', target()])                 // ignore failure: not loaded yet
    const boot = await run('launchctl', ['bootstrap', `gui/${uid()}`, file])
    if (boot.code !== 0) throw new Error(`launchctl bootstrap failed: ${boot.stderr.trim() || boot.stdout.trim()}`)
    await run('launchctl', ['kickstart', '-k', target()])
  },
  async uninstall(run) {
    await run('launchctl', ['bootout', target()])
    fs.rmSync(this.unitPath(), { force: true })
  },
  async activation(run): Promise<Activation> {
    const unitPath = this.unitPath()
    const res = await run('launchctl', ['print', target()])
    if (res.code !== 0) return { kind: 'service', loaded: false, unitPath }
    const { pid, running } = parseLaunchctlPrint(res.stdout)
    let nodePath = ''
    try { nodePath = /<array>\s*<string>([^<]+)<\/string>/.exec(fs.readFileSync(unitPath, 'utf8'))?.[1] ?? '' } catch { /* unit missing */ }
    let nodeOk = false
    try { fs.accessSync(nodePath, fs.constants.X_OK); nodeOk = true } catch { /* missing */ }
    return { kind: 'service', loaded: true, running, pid, unitPath, nodePath, nodeOk, restartCmd: `launchctl kickstart -k ${target()}`, stopCmd: `launchctl bootout ${target()}` }
  },
  logsCommand: (follow) => ({ cmd: 'tail', args: [follow ? '-f' : '-n', ...(follow ? [] : ['200'])] })
}
```

`logsCommand` returns only the flags; the caller appends the log file (see Task 8).

`src/cli/service/systemd.ts` (same shape):

```ts
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Activation, ServiceBackend, UnitSpec } from './types.js'

export const UNIT = 'limn'

export function parseShow(text: string): { active: boolean; pid: number | null } {
  const active = /^ActiveState=(\S+)/m.exec(text)?.[1] === 'active'
  const pid = Number(/^MainPID=(\d+)/m.exec(text)?.[1] ?? 0)
  return { active, pid: pid > 0 ? pid : null }
}

export const systemd: ServiceBackend = {
  name: 'systemd',
  unitPath: () => path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'systemd', 'user', `${UNIT}.service`),
  renderUnit(spec: UnitSpec): string {
    return `# Limn background service (generated by \`limn service install\`; re-run it to repair).
# After \`npm i -g @glebmish/limn@latest\`: systemctl --user restart ${UNIT}
# Stop: systemctl --user stop ${UNIT}   Remove: limn service uninstall
[Unit]
Description=Limn — agentic local branch review
After=network.target

[Service]
ExecStart=${spec.nodePath} ${spec.entryPath} service serve${spec.port80 ? ' --port-80' : ''}
Restart=always
RestartSec=2
Environment=PATH=${spec.pathEnv}
Environment=HOME=${spec.home}
StandardOutput=append:${spec.logFile}
StandardError=append:${spec.logFile}

[Install]
WantedBy=default.target
`
  },
  async install(spec, run) {
    const file = this.unitPath()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.mkdirSync(path.dirname(spec.logFile), { recursive: true })
    fs.writeFileSync(file, this.renderUnit(spec))
    const reload = await run('systemctl', ['--user', 'daemon-reload'])
    if (reload.code !== 0) throw new Error(`systemctl daemon-reload failed: ${reload.stderr.trim()}`)
    const en = await run('systemctl', ['--user', 'enable', '--now', UNIT])
    if (en.code !== 0) throw new Error(`systemctl enable --now failed: ${en.stderr.trim()}`)
    await run('systemctl', ['--user', 'restart', UNIT])
  },
  async uninstall(run) {
    await run('systemctl', ['--user', 'disable', '--now', UNIT])
    fs.rmSync(this.unitPath(), { force: true })
    await run('systemctl', ['--user', 'daemon-reload'])
  },
  async activation(run): Promise<Activation> {
    const unitPath = this.unitPath()
    if (!fs.existsSync(unitPath)) return { kind: 'service', loaded: false, unitPath }
    const res = await run('systemctl', ['--user', 'show', UNIT, '-p', 'ActiveState', '-p', 'MainPID'])
    const { active, pid } = parseShow(res.stdout)
    const nodePath = /^ExecStart=(\S+)/m.exec(fs.readFileSync(unitPath, 'utf8'))?.[1] ?? ''
    let nodeOk = false
    try { fs.accessSync(nodePath, fs.constants.X_OK); nodeOk = true } catch { /* missing */ }
    return { kind: 'service', loaded: true, running: active, pid, unitPath, nodePath, nodeOk, restartCmd: `systemctl --user restart ${UNIT}`, stopCmd: `systemctl --user stop ${UNIT}` }
  },
  logsCommand: (follow) => ({ cmd: 'journalctl', args: ['--user', '-u', UNIT, ...(follow ? ['-f'] : ['-n', '200'])] })
}
```

For systemd `logsCommand` the caller must NOT append the log file (journalctl); Task 8 handles this via `backend.name`.

- [ ] **Step 4: Run tests**

`npx vitest run tests/service-launchd.test.ts tests/service-systemd.test.ts` → PASS. `npm run typecheck && npm run lint` → green.

- [ ] **Step 5: Commit**

```bash
git add src/cli/service tests/service-launchd.test.ts tests/service-systemd.test.ts
git commit -m "feat(cli): launchd and systemd --user service backends"
```

---

### Task 8: `limn service install|uninstall|status|logs` + status rendering + macOS smoke

**Files:**
- Create: `src/cli/service/index.ts` (replace stub), `src/cli/service/status.ts`
- Test: `tests/service-status.test.ts`

**Interfaces:**
- Consumes `launchd`, `systemd`, `Exec`, `Activation`, `UnitSpec`, `probeHealth`, `HealthInfo`, `logPath()`, `defaultDbPath()`, `resolvePort()`, `openBrowser`.
- Produces:

```ts
export function serviceBackend(platform = process.platform): ServiceBackend | null   // darwin → launchd, linux → systemd, else null
export async function isServiceInstalled(): Promise<boolean>
export async function installService(opts: { port80: boolean }, io: Io): Promise<number>
export async function runServiceCommand(cmd: CliCommand, io: Io): Promise<number>
// status.ts
export type StatusModel = { version: string; port: number; health: HealthInfo | null; activation: Activation | null; unsupported: boolean; dbPath: string; logFile: string; foregroundPid: number | null }
export function renderStatus(m: StatusModel): { lines: string[]; exitCode: number }
```

- [ ] **Step 1: Write the failing status-rendering tests**

`tests/service-status.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { renderStatus } from '../src/cli/service/status'

const health = { app: 'limn' as const, version: '0.4.0', pid: 4211, startedAt: new Date(Date.now() - 3 * 3600_000).toISOString(), port: 5466 }
const base = { version: '0.4.0', port: 5466, health: null, activation: null, unsupported: false, dbPath: '/Users/u/Library/Application Support/limn/limn.db', logFile: '/Users/u/Library/Logs/limn.log', foregroundPid: null }
const loaded = { kind: 'service' as const, loaded: true as const, running: true, pid: 4211, unitPath: '/Users/u/Library/LaunchAgents/dev.glebmish.limn.plist', nodePath: '/opt/homebrew/bin/node', nodeOk: true, restartCmd: 'launchctl kickstart -k gui/501/dev.glebmish.limn', stopCmd: 'launchctl bootout gui/501/dev.glebmish.limn' }

describe('renderStatus', () => {
  it('service activation: running', () => {
    const { lines, exitCode } = renderStatus({ ...base, health, activation: loaded })
    const text = lines.join('\n')
    expect(exitCode).toBe(0)
    expect(text).toMatch(/activation:\s+launchd agent dev\.glebmish\.limn — loaded, RunAtLoad\+KeepAlive, running/)
    expect(text).toMatch(/server:\s+http:\/\/limn\.localhost:5466 .*pid 4211 .*up 3h/)
    expect(text).toMatch(/node:\s+\/opt\/homebrew\/bin\/node — matches unit/)
    expect(text).toMatch(/restart:\s+launchctl kickstart -k/)
    expect(text).toMatch(/stop:\s+launchctl bootout .*limn service uninstall/)
  })
  it('service loaded but node missing → repair hint, exit 1', () => {
    const { lines, exitCode } = renderStatus({ ...base, activation: { ...loaded, running: false, pid: null, nodeOk: false } })
    expect(exitCode).toBe(1)
    expect(lines.join('\n')).toMatch(/node:\s+MISSING at \/opt\/homebrew\/bin\/node — run `limn service install` to repair/)
  })
  it('foreground activation', () => {
    const { lines, exitCode } = renderStatus({ ...base, health, activation: { kind: 'service', loaded: false, unitPath: '/x' }, foregroundPid: 4211 })
    expect(exitCode).toBe(0)
    expect(lines.join('\n')).toMatch(/activation:\s+foreground, pid 4211/)
    expect(lines.join('\n')).toMatch(/stop:\s+Ctrl-C in its terminal/)
  })
  it('not running', () => {
    const { lines, exitCode } = renderStatus({ ...base, activation: { kind: 'service', loaded: false, unitPath: '/x' } })
    expect(exitCode).toBe(1)
    expect(lines.join('\n')).toMatch(/activation:\s+not running/)
    expect(lines.join('\n')).toMatch(/limn service install/)
  })
  it('unsupported platform', () => {
    const { lines } = renderStatus({ ...base, unsupported: true })
    expect(lines.join('\n')).toMatch(/background service not supported on this platform/)
  })
})
```

- [ ] **Step 2: Run to verify failure**

`npx vitest run tests/service-status.test.ts` → FAIL.

- [ ] **Step 3: Implement `status.ts` and `service/index.ts`**

`src/cli/service/status.ts`:

```ts
import type { HealthInfo } from '../health.js'
import type { Activation } from './types.js'

export interface StatusModel {
  version: string; port: number; health: HealthInfo | null; activation: Activation | null
  unsupported: boolean; dbPath: string; logFile: string; foregroundPid: number | null
}

function uptime(startedAt: string): string {
  const ms = Date.now() - Date.parse(startedAt)
  if (!Number.isFinite(ms) || ms < 0) return ''
  const h = Math.floor(ms / 3600_000), d = Math.floor(h / 24), m = Math.floor((ms % 3600_000) / 60_000)
  return d > 0 ? `up ${d}d ${h % 24}h` : h > 0 ? `up ${h}h ${m}m` : `up ${m}m`
}

export function renderStatus(m: StatusModel): { lines: string[]; exitCode: number } {
  const L: string[] = [`Limn ${m.version}`]
  const a = m.activation
  const svc = a && a.loaded ? a : null
  const running = Boolean(m.health)
  if (m.unsupported) L.push('  activation:  background service not supported on this platform — run `limn service serve`')
  else if (svc) L.push(`  activation:  ${svc.restartCmd.startsWith('launchctl') ? 'launchd agent dev.glebmish.limn — loaded, RunAtLoad+KeepAlive' : 'systemd --user unit limn — enabled'}, ${svc.running ? 'running' : running ? 'respawning' : 'not running'}`)
  else if (running) L.push(`  activation:  foreground, pid ${m.foregroundPid ?? m.health!.pid}`)
  else L.push('  activation:  not running — `limn service install` (always-on) or `limn service serve` (foreground)')
  if (m.health) L.push(`  server:      http://limn.localhost:${m.port}  (127.0.0.1:${m.port})  pid ${m.health.pid}  ${uptime(m.health.startedAt)}`.trimEnd())
  else L.push(`  server:      http://limn.localhost:${m.port} — not answering`)
  if (svc) L.push(svc.nodeOk ? `  node:        ${svc.nodePath} — matches unit` : `  node:        MISSING at ${svc.nodePath} — run \`limn service install\` to repair`)
  L.push(`  database:    ${m.dbPath}`)
  L.push(`  logs:        ${m.logFile}`)
  if (svc) { L.push(`  restart:     ${svc.restartCmd}`); L.push(`  stop:        ${svc.stopCmd}   (or: limn service uninstall)`) }
  else if (running) L.push('  stop:        Ctrl-C in its terminal')
  return { lines: L, exitCode: running && (!svc || svc.nodeOk) ? 0 : 1 }
}
```

`src/cli/service/index.ts`:

```ts
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execSync, spawn } from 'node:child_process'
import type { CliCommand } from '../args.js'
import type { Io } from '../main.js'
import { probeHealth } from '../health.js'
import { openBrowser } from '../browser.js'
import { resolvePort } from '../serve.js'
import { APP_VERSION } from '../../server/http.js'
import { defaultDbPath, logPath } from '../../main/paths.js'
import { launchd } from './launchd.js'
import { systemd } from './systemd.js'
import { execAsync, type ServiceBackend, type UnitSpec } from './types.js'
import { renderStatus } from './status.js'

export function serviceBackend(platform = process.platform): ServiceBackend | null {
  return platform === 'darwin' ? launchd : platform === 'linux' ? systemd : null
}

export async function isServiceInstalled(): Promise<boolean> {
  const b = serviceBackend()
  return b ? fs.existsSync(b.unitPath()) : false
}

function loginShellPath(): string {
  try { return execSync(`${process.env.SHELL || '/bin/sh'} -ilc 'echo -n "$PATH"'`, { timeout: 5000, encoding: 'utf8' }) || process.env.PATH || '' }
  catch { return process.env.PATH || '/usr/local/bin:/usr/bin:/bin' }
}

function unitSpec(port80: boolean): UnitSpec {
  // realpath both so an nvm/Homebrew node and the global node_modules are recorded as
  // real files (symlink targets change on upgrade; the unit must keep working).
  const nodePath = fs.realpathSync(process.execPath)
  const entryPath = fs.realpathSync(path.join(import.meta.dirname, '..', 'index.js'))
  const pathEnv = [path.dirname(nodePath), ...loginShellPath().split(path.delimiter)].filter((p, i, a) => p && a.indexOf(p) === i).join(path.delimiter)
  return { nodePath, entryPath, port80, pathEnv, logFile: logPath(), home: os.homedir() }
}

async function waitHealthy(port: number, ms: number): Promise<boolean> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (await probeHealth(port)) return true
    await new Promise((r) => setTimeout(r, 300))
  }
  return false
}

export async function installService(opts: { port80: boolean }, io: Io): Promise<number> {
  const b = serviceBackend()
  if (!b) { io.err('error: background service is not supported on this platform yet; run `limn service serve` instead'); return 2 }
  const port = resolvePort()
  const fg = await probeHealth(port)
  if (fg && !(await isServiceInstalled())) { io.err(`error: a foreground Limn server (pid ${fg.pid}) holds port ${port}; stop it (Ctrl-C) and re-run`); return 1 }
  const spec = unitSpec(opts.port80)
  try { await b.install(spec, execAsync) } catch (err) { io.err(`error: ${err instanceof Error ? err.message : String(err)}`); return 1 }
  if (!(await waitHealthy(port, 10_000))) { io.err(`service installed but not answering on ${port} after 10s — see ${spec.logFile}`); return 1 }
  const a = await b.activation(execAsync)
  io.out(`✓ Limn service installed and running → http://limn.localhost:${port}${opts.port80 ? '  (also http://limn.localhost)' : ''}`)
  io.out(`  unit:     ${b.unitPath()}`)
  if (a.loaded) io.out(`  restart after an upgrade:  ${a.restartCmd}`)
  return 0
}

async function statusModel() {
  const b = serviceBackend()
  const port = resolvePort()
  const health = await probeHealth(port)
  const activation = b ? await b.activation(execAsync) : null
  return { version: APP_VERSION, port, health, activation, unsupported: !b, dbPath: defaultDbPath(), logFile: logPath(), foregroundPid: health?.pid ?? null }
}

export async function runServiceCommand(cmd: CliCommand, io: Io): Promise<number> {
  const b = serviceBackend()
  switch (cmd.kind) {
    case 'service-install': return installService({ port80: cmd.port80 }, io)
    case 'service-uninstall': {
      if (!b) { io.err('error: background service is not supported on this platform'); return 2 }
      if (!(await isServiceInstalled())) { io.out('no Limn service installed'); return 0 }
      await b.uninstall(execAsync)
      io.out(`✓ removed ${b.unitPath()} (database kept at ${defaultDbPath()})`)
      return 0
    }
    case 'service-status': {
      const { lines, exitCode } = renderStatus(await statusModel())
      for (const l of lines) io.out(l)
      return exitCode
    }
    case 'service-logs': {
      if (b?.name === 'systemd') {
        const { cmd: c, args } = b.logsCommand(cmd.follow)
        return new Promise((resolve) => spawn(c, args, { stdio: 'inherit' }).on('exit', (code) => resolve(code ?? 0)))
      }
      const file = logPath()
      if (!fs.existsSync(file)) { io.out(`no log yet at ${file}`); return 0 }
      const args = cmd.follow ? ['-f', file] : ['-n', '200', file]
      return new Promise((resolve) => spawn('tail', args, { stdio: 'inherit' }).on('exit', (code) => resolve(code ?? 0)))
    }
    default: io.err(`limn: unhandled command ${cmd.kind}`); return 2
  }
}
```

Remove the unused `openBrowser` import if lint flags it. `import.meta.dirname` of `dist/cli/service/index.js` → `..` → `dist/cli/index.js` — correct for both `dist/` and `src/` (tsx) layouts.

- [ ] **Step 4: Run tests + the real macOS smoke (this machine is macOS)**

`npx vitest run tests/service-status.test.ts` → PASS. Then, on an isolated port and DB so nothing collides with anything the user runs:

```bash
npm run build
export LIMN_PORT=5477 LIMN_DB=/tmp/limn-svc-smoke.db
node bin/limn.js service status          # exit 1, "not running"
node bin/limn.js service install         # "✓ Limn service installed and running → http://limn.localhost:5477"
node bin/limn.js service status          # exit 0, launchd agent … running, pid N, node matches unit
curl -s http://limn.localhost:5477/health
launchctl print gui/$(id -u)/dev.glebmish.limn | grep -E 'state|pid'
node bin/limn.js open --hub .            # client role: opens a hub tab in the browser
node bin/limn.js service logs | tail -3
node bin/limn.js service uninstall       # "✓ removed …"
node bin/limn.js service status          # exit 1 again
launchctl print gui/$(id -u)/dev.glebmish.limn; echo "exit $?"   # non-zero: unloaded
unset LIMN_PORT LIMN_DB
```

**Caveat:** the plist bakes in `LIMN_PORT`/`LIMN_DB`? It does **not** — `unitSpec` only records PATH and HOME, so the installed service listens on 5466 with the real DB regardless of the smoke env. To keep the smoke isolated add `LIMN_PORT` and `LIMN_DB` to the plist's `EnvironmentVariables` **only when set in the installing shell** (extend `UnitSpec` with `extraEnv: Record<string,string>` populated from `LIMN_PORT`, `LIMN_DB`, `LIMN_WEB_HOST`, `LIMN_WEB_TOKEN` when present, and render them in both backends; add one assertion to each unit test that `extraEnv: { LIMN_PORT: '5477' }` appears). That is also the documented way to pin a Tailscale bind into the service.

- [ ] **Step 5: Full suite + commit**

`npm test && npm run typecheck && npm run lint` → green.

```bash
git add -A src/cli tests
git commit -m "feat(cli): service install/uninstall/status/logs with launchd smoke"
```

---

### Task 9: npm packaging: bundled JS-only closure, pack smoke, CI + release workflows

**Files:**
- Create: `scripts/pack-smoke.sh`
- Modify: `.github/workflows/ci.yml`, `.github/workflows/release.yml`, `package.json` (only if Task 3 missed anything)

**Interfaces:** none new. `npm run pack:smoke` is the contract CI relies on.

- [ ] **Step 1: `scripts/pack-smoke.sh`**

```bash
#!/usr/bin/env bash
# Pack the package the way release does, install it into a throwaway prefix with
# DEFAULT npm flags, and prove: no platform binaries were fetched, the bin runs,
# the server answers /health. Usage: scripts/pack-smoke.sh
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d "${TMPDIR:-/tmp}/limn-pack.XXXXXX")"
trap 'rm -rf "$work"' EXIT

cd "$root"
npm ci --omit=optional --ignore-scripts --no-audit --no-fund >/dev/null
npm run build >/dev/null
tgz="$(npm pack --ignore-scripts --pack-destination "$work" 2>/dev/null | tail -1)"
echo "tarball: $tgz ($(du -h "$work/$tgz" | cut -f1))"

# 1. the tarball must not carry platform binaries
if tar -tzf "$work/$tgz" | grep -E 'claude-agent-sdk-(darwin|linux|win32)|codex-(darwin|linux|win32)'; then
  echo "::error::platform binaries found in tarball"; exit 1
fi

# 2. install with default flags into an isolated prefix
npm install -g --prefix "$work/prefix" --ignore-scripts --no-audit --no-fund "$work/$tgz" >/dev/null
pkg="$work/prefix/lib/node_modules/@glebmish/limn"
if find "$pkg" -maxdepth 4 -type d \( -name 'claude-agent-sdk-*' -o -name 'codex-darwin*' -o -name 'codex-linux*' -o -name 'codex-win32*' \) | grep .; then
  echo "::error::platform binaries were fetched on install"; exit 1
fi
echo "installed: $(du -sh "$pkg" | cut -f1)"

# 3. the bin runs and the server answers
"$work/prefix/bin/limn" --version
LIMN_DB="$work/limn.db" "$work/prefix/bin/limn" service serve --port 0 >"$work/serve.log" 2>&1 &
pid=$!
for _ in $(seq 1 50); do
  port="$(sed -n 's/.*limn\.localhost:\([0-9]*\).*/\1/p' "$work/serve.log" | head -1)"
  [ -n "$port" ] && curl -sf "http://127.0.0.1:$port/health" >/dev/null && break
  sleep 0.2
done
kill "$pid" 2>/dev/null || true
[ -n "${port:-}" ] || { echo "::error::server never came up"; cat "$work/serve.log"; exit 1; }
curl -s "http://127.0.0.1:$port/health" | grep -q '"app":"limn"' || { echo "::error::/health did not answer as limn"; exit 1; }
echo "pack smoke OK (port $port)"
```

`chmod +x scripts/pack-smoke.sh`. Restore the working tree afterwards with `npm ci` (the smoke ran `--omit=optional`; harmless, but `npm ci` returns the lock to its full state).

- [ ] **Step 2: Run it locally**

`npm run pack:smoke` → ends with `pack smoke OK`. Tarball ≈ 2.5–4 MB, installed ≈ 16–20 MB.

- [ ] **Step 3: `ci.yml`**

Replace the steps after checkout/setup-node with:

```yaml
      - name: Install dependencies (no platform binaries)
        run: npm ci --omit=optional

      - name: Lint
        run: npm run lint
      - name: Typecheck
        run: npm run typecheck
      - name: Test
        run: npm test
      - name: Build
        run: npm run build
      - name: Pack smoke (bundled deps, install into temp prefix, /health)
        run: npm run pack:smoke
```

- [ ] **Step 4: `release.yml`**

Rewrite the job:

```yaml
name: Release

on:
  push:
    tags: ['v*']
  workflow_dispatch:
    inputs:
      dry_run:
        description: 'Pack only, do not publish'
        type: boolean
        default: true

permissions:
  contents: write
  id-token: write          # npm provenance

jobs:
  publish:
    name: Publish @glebmish/limn
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v6
        with:
          node-version: '24'
          cache: 'npm'
          registry-url: 'https://registry.npmjs.org'
      - name: Install dependencies (no platform binaries)
        run: npm ci --omit=optional
      - name: Verify tag matches package.json version
        if: startsWith(github.ref, 'refs/tags/v')
        run: |
          TAG="${GITHUB_REF_NAME#v}"
          PKG="$(node -p "require('./package.json').version")"
          test "$TAG" = "$PKG" || { echo "::error::tag $TAG != package.json version $PKG"; exit 1; }
      - name: Build + pack smoke
        run: npm run pack:smoke
      - name: Pack
        run: npm pack --ignore-scripts
      - name: Upload tarball (inspection / dry-run)
        uses: actions/upload-artifact@v7
        with:
          name: limn-npm-tarball
          path: '*.tgz'
      - name: Publish to npm
        if: startsWith(github.ref, 'refs/tags/v') && !inputs.dry_run
        run: npm publish --access public --provenance
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
      - name: GitHub Release
        if: startsWith(github.ref, 'refs/tags/v') && !inputs.dry_run
        uses: softprops/action-gh-release@v3
        with:
          files: '*.tgz'
          generate_release_notes: true
```

Add a comment above `Publish to npm`: `# NPM_TOKEN: an npm automation token for @glebmish; with npm trusted publishing configured for this repo the env line can be dropped.` Note in the commit that `NPM_TOKEN` must be added as a repo secret before the first tag.

- [ ] **Step 5: Validate workflow YAML and commit**

`node -e "require('js-yaml')"` is not available; use `npx --yes yaml-lint .github/workflows/*.yml` or simply `python3 -c "import yaml,sys; [yaml.safe_load(open(f)) for f in sys.argv[1:]]" .github/workflows/*.yml`. Then:

```bash
npm ci   # restore full node_modules
git add scripts/pack-smoke.sh .github/workflows
git commit -m "chore(release): npm publish pipeline with bundled-deps pack smoke"
```

---

### Task 10: Dev screenshot tooling on the web app (headless Chrome over CDP)

**Files:**
- Create: `scripts/dev-url.mts`, `scripts/cdp-shot.mts`
- Modify: `scripts/shot.sh`, `scripts/record-inplace-demo.sh`, `scripts/smoke-installed.sh`, `scripts/shoot.mts:1-4` (comment), `scripts/shoot-transient.mts:1-4` (comment)

**Interfaces:**
- Produces `scripts/dev-url.mts`: reads `LIMN_*` env → prints `http://127.0.0.1:<LIMN_PORT>/?dev=<json>[&open=…]`. The env→key mapping is exactly the one the deleted preload used (`LIMN_FLOW→flow`, `LIMN_OPEN_SESSION→openSession`, `LIMN_OPEN_HUB→openHub`, `LIMN_SHOW_ARCHIVED→showArchived`, `LIMN_SCROLL_BOTTOM→scrollBottom`, `LIMN_ACTIVE_CHAT→activeChat` (Number), `LIMN_OPEN_PICKER→openPicker`, `LIMN_OPEN_WORKSPACE→openWorkspace`, `LIMN_OPEN_CMPREF→openCmpRef`, `LIMN_PICK_ENGINE→pickEngine`, `LIMN_OPEN_CHATLIST→openChatList`, `LIMN_FOCUS→focus`, `LIMN_HOLD_FOCUS→holdFocus`, `LIMN_RUN_BATCH→runBatch`, `LIMN_RUN_CHAT→runChat`, `LIMN_EXPAND_TOOL→expandTool`, `LIMN_OPEN_MODE→openMode`, `LIMN_FAKE_GEN→fakeGen`, `LIMN_FAKE_DRIFT→fakeDrift`, `LIMN_FAKE_DRIFT_OPEN→fakeDriftOpen`, `LIMN_OPEN_SETTINGS→openSettings`, `LIMN_OPEN_DOC→openDoc`, `LIMN_EDIT_FRAME→editFrame`, `LIMN_RUN_EDIT→runEdit`, `LIMN_SHOW_AFFORDANCES→showAffordances`, `LIMN_SCENARIO→scenario`, `LIMN_OPEN_PEEK→openPeek`); `=1` vars become booleans, the rest strings.
- Produces `scripts/cdp-shot.mts --url U --out FILE [--delay MS] [--width W --height H]` and `--frames DIR --every MS --count N` mode.

- [ ] **Step 1: `scripts/dev-url.mts`**

```ts
/* Build the web-app URL that carries the dev/screenshot hooks (formerly LIMN_* env
 * read by the Electron preload). Prints the URL. Usage:
 *   LIMN_OPEN_SESSION=3 LIMN_FLOW=chat npx tsx scripts/dev-url.mts */
const BOOL = ['SHOW_ARCHIVED', 'SCROLL_BOTTOM', 'OPEN_PICKER', 'OPEN_WORKSPACE', 'OPEN_CMPREF', 'OPEN_CHATLIST', 'HOLD_FOCUS', 'RUN_BATCH', 'OPEN_MODE', 'FAKE_GEN', 'FAKE_DRIFT', 'FAKE_DRIFT_OPEN', 'OPEN_SETTINGS', 'SHOW_AFFORDANCES']
const STR = ['FLOW', 'OPEN_SESSION', 'OPEN_HUB', 'PICK_ENGINE', 'FOCUS', 'RUN_CHAT', 'EXPAND_TOOL', 'OPEN_DOC', 'EDIT_FRAME', 'RUN_EDIT', 'SCENARIO', 'OPEN_PEEK']
const camel = (k: string): string => k.toLowerCase().replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())
  .replace('cmpref', 'CmpRef').replace('chatlist', 'ChatList')
const hooks: Record<string, unknown> = {}
for (const k of BOOL) if (process.env[`LIMN_${k}`] === '1') hooks[camel(k)] = true
for (const k of STR) if (process.env[`LIMN_${k}`]) hooks[camel(k)] = process.env[`LIMN_${k}`]
if (process.env.LIMN_ACTIVE_CHAT) hooks.activeChat = Number(process.env.LIMN_ACTIVE_CHAT)
const port = process.env.LIMN_PORT || '5466'
const q = new URLSearchParams()
if (Object.keys(hooks).length) q.set('dev', JSON.stringify(hooks))
if (process.env.LIMN_OPEN_TICKET) q.set('open', process.env.LIMN_OPEN_TICKET)
const s = q.toString()
process.stdout.write(`http://127.0.0.1:${port}/${s ? '?' + s : ''}`)
```

Check the produced keys against `src/renderer/api.d.ts` (`openCmpRef`, `openChatList` are the two non-trivial camel-cases — the `.replace` calls above fix them; verify by `LIMN_OPEN_CMPREF=1 LIMN_OPEN_CHATLIST=1 npx tsx scripts/dev-url.mts` printing `openCmpRef`/`openChatList`).

- [ ] **Step 2: `scripts/cdp-shot.mts`**

```ts
/* Headless-Chrome screenshot/frames over CDP (Node 24 globals: fetch + WebSocket).
 *   npx tsx scripts/cdp-shot.mts --url http://127.0.0.1:5466/?dev=… --out /tmp/a.png [--delay 6000]
 *   npx tsx scripts/cdp-shot.mts --url … --frames /tmp/frames --every 350 --count 36 [--delay 2500] */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const arg = (name: string, dflt?: string): string | undefined => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : dflt }
const url = arg('url'); if (!url) throw new Error('--url required')
const out = arg('out'); const frames = arg('frames')
const delay = Number(arg('delay', '6000')); const width = Number(arg('width', '1320')); const height = Number(arg('height', '860'))
const every = Number(arg('every', '400')); const count = Number(arg('count', '40'))

const CHROME = process.env.CHROME_BIN || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : 'google-chrome')
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'limn-chrome-'))
const chrome = spawn(CHROME, [`--headless=new`, '--remote-debugging-port=0', `--user-data-dir=${profile}`, `--window-size=${width},${height}`, '--no-first-run', '--hide-scrollbars', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] })
let devtoolsPort = 0
chrome.stderr.on('data', (b: Buffer) => { const m = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(b.toString()); if (m) devtoolsPort = Number(m[1]) })
const cleanup = (): void => { chrome.kill(); fs.rmSync(profile, { recursive: true, force: true }) }
process.on('exit', cleanup)

for (let i = 0; i < 100 && !devtoolsPort; i++) await new Promise((r) => setTimeout(r, 100))
if (!devtoolsPort) throw new Error('chrome did not expose a DevTools port')
const targets = (await (await fetch(`http://127.0.0.1:${devtoolsPort}/json`)).json()) as { type: string; webSocketDebuggerUrl: string }[]
const page = targets.find((t) => t.type === 'page'); if (!page) throw new Error('no page target')

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error('ws error')) })
let seq = 0
const pending = new Map<number, (v: { result?: Record<string, unknown>; error?: { message: string } }) => void>()
ws.onmessage = (e) => { const msg = JSON.parse(String(e.data)); if (msg.id && pending.has(msg.id)) { pending.get(msg.id)!(msg); pending.delete(msg.id) } }
const send = (method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> => new Promise((resolve, reject) => {
  const id = ++seq; pending.set(id, (m) => m.error ? reject(new Error(m.error.message)) : resolve(m.result ?? {})); ws.send(JSON.stringify({ id, method, params }))
})

await send('Page.enable')
await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: false })
await send('Page.navigate', { url })
await new Promise((r) => setTimeout(r, delay))
const shot = async (file: string): Promise<void> => {
  const { data } = await send('Page.captureScreenshot', { format: 'png' }) as { data: string }
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, Buffer.from(data, 'base64'))
}
if (frames) {
  fs.mkdirSync(frames, { recursive: true })
  for (let n = 1; n <= count; n++) { await shot(path.join(frames, `frame-${String(n).padStart(4, '0')}.png`)); await new Promise((r) => setTimeout(r, every)) }
} else if (out) {
  await shot(out)
} else throw new Error('--out or --frames required')
ws.close()
cleanup()
process.exit(0)
```

- [ ] **Step 3: Rewrite the shell wrappers**

`scripts/shot.sh`:

```bash
#!/usr/bin/env bash
# Dev screenshot helper: seed a fixture db, serve it on an ephemeral port, capture a
# PNG with headless Chrome, stop. Usage: scripts/shot.sh <out.png> [LIMN_* env ...]
#   scripts/shot.sh /tmp/a.png LIMN_ACTIVE_CHAT=2 LIMN_FOCUS='{"kind":"diff","file":"src/a.ts","side":"new","line":2}'
set -euo pipefail
out="${1:?usage: shot.sh <out.png> [ENV=val ...]}"; shift || true
seed="$(npx tsx scripts/shoot.mts)"
db="$(node -e "process.stdout.write(JSON.parse(process.argv[1]).db)" "$seed")"
sid="$(node -e "process.stdout.write(String(JSON.parse(process.argv[1]).sessionId))" "$seed")"
echo "seed: $seed" >&2
port="${LIMN_PORT:-$((20000 + RANDOM % 20000))}"
[ -f dist/renderer/index.html ] || npm run build >/dev/null
LIMN_DB="$db" LIMN_PORT="$port" node bin/limn.js service serve >/tmp/limn-serve.log 2>&1 &
srv=$!; trap 'kill $srv 2>/dev/null || true' EXIT
for _ in $(seq 1 50); do curl -sf "http://127.0.0.1:$port/health" >/dev/null && break; sleep 0.2; done
url="$(env LIMN_PORT="$port" LIMN_OPEN_SESSION="$sid" LIMN_FLOW=chat "$@" npx tsx scripts/dev-url.mts)"
npx tsx scripts/cdp-shot.mts --url "$url" --out "$out" --delay "${LIMN_SHOT_DELAY:-6000}"
echo "wrote $out" >&2
```

`scripts/record-inplace-demo.sh`: same shape — replace the `env … npx electron .` block with starting the server on an ephemeral port, building the URL via `dev-url.mts` with `LIMN_OPEN_SESSION="$SID" LIMN_FLOW=chat LIMN_SHOW_AFFORDANCES=1 LIMN_FOCUS=… LIMN_SCENARIO="$SCENARIO"`, then `cdp-shot.mts --url "$url" --frames "$frames" --every 350 --count 36 --delay 2500`.

`scripts/smoke-installed.sh`: smoke the **globally installed** package instead of `/Applications/Limn.app`: `limn="$(command -v limn)"`, start `LIMN_DB="$DB" LIMN_PORT=<ephemeral> "$limn" service serve` in the background, then `dev-url.mts` + `cdp-shot.mts --out "$out"`.

Update the header comments of `scripts/shoot.mts` and `scripts/shoot-transient.mts` ("launch Electron with …" → "serve with `LIMN_DB=<db> node bin/limn.js service serve` and open the URL from `scripts/dev-url.mts`").

- [ ] **Step 4: Prove it**

`scripts/shot.sh /tmp/limn-web-shot.png LIMN_SHOW_AFFORDANCES=1` → writes a PNG; open it (`Read` the file) and confirm the review screen rendered with the seeded session (sections in the sidebar, chat drawer open). If Chrome is missing on the machine the script must fail with a clear `chrome did not expose a DevTools port` / ENOENT message, not hang.

- [ ] **Step 5: Commit**

```bash
git add scripts
git commit -m "chore(dev): screenshot + demo tooling on the web app via headless Chrome/CDP"
```

---

### Task 11: Docs — README, architecture, using-limn, adapter docs, spec deviation note

**Files:**
- Modify: `README.md`, `docs/architecture.md`, `docs/using-limn.md`, `docs/acp-adapters.md:30-90`, `docs/agent-layer.md:58,86-87,123`, `specs/browser-pivot/spec.md` (§4 ticket note), `specs/README.md` (row status)

- [ ] **Step 1: README**

- Line 7: `A macOS app for` → `A local service + browser app for`. Remove the `Release` badge line or repoint it to npm: `[![npm](https://img.shields.io/npm/v/%40glebmish%2Flimn)](https://www.npmjs.com/package/@glebmish/limn)`.
- Replace the whole `## Install` section (both subsections) with:

````markdown
## Install

```bash
npm i -g @glebmish/limn
limn
```

The first `limn` offers to install Limn as a background service (a LaunchAgent on
macOS, a `systemd --user` unit on Linux) so **http://limn.localhost:5466** is always
there; say `n` (or pass `--no-service`) to just run it in the foreground. `npx
@glebmish/limn` runs it once without installing anything.

Requires Node ≥ 22.5 and `git`. `*.localhost` resolves to your machine in Chrome,
Edge, Arc and Firefox with no setup; Safari does not resolve it — use
`http://127.0.0.1:5466` there.

Upgrading: `npm i -g @glebmish/limn@latest`, then restart the service with the command
`limn service status` prints (`launchctl kickstart -k gui/$UID/dev.glebmish.limn`).

Coming from the desktop app: delete `Limn.app`; your reviews are in the same database
and `limn` offers to remove the old shell shim it installed.
````

- `## Using it` step 1: `via the native dialog` → `by typing its path (the picker is a follow-up)`; drop `⌘O`. Replace the sentence `You also get a **macOS notification** …` with `(Browser notifications for finished runs are a follow-up.)`.
- Replace `### The \`limn\` command` intro paragraph with: `The CLI ships with the package. If the service is running it opens there; otherwise it starts a server for you.` Keep the examples table; add rows `--no-service` (*skip the service prompt; run in the foreground*) and a second block:

````markdown
```bash
limn service serve [--port N]     # foreground server (default 5466)
limn service install [--port-80]  # always-on background service (+ optional http://limn.localhost alias on :80)
limn service status               # activation (service / foreground / not running), URL, pid, node path, native stop/restart commands
limn service uninstall            # remove the service; database untouched
limn service logs [-f]
```
````

  Remove `If the app is already running, the command hands the request to the running window.` → `The review opens in a new browser tab.`
- `## Limitations`: replace the first two bullets with `- **macOS and Linux** — Windows can run \`limn service serve\` in the foreground; there is no Windows background service yet.` and `- **Safari** does not resolve \`limn.localhost\`; use \`127.0.0.1:5466\`.`
- `## Development`: `Requires Node 20+` → `Requires Node 22.5+`; scripts block → `npm run dev` (vite on :5173, proxying to a server started with `npm run dev:server`), `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`, `npm run pack:smoke`. Release paragraph → `Pushing a v* tag that matches package.json publishes @glebmish/limn to npm (bundled JS-only adapter closure, no platform binaries) and creates a GitHub Release with the tarball.` Env-vars paragraph: drop `LIMN_SHOT*`; add `LIMN_PORT`, `LIMN_DB`, `LIMN_WEB_HOST`/`LIMN_WEB_TOKEN` (Tailscale: bind the tailnet IP + token; the service picks them up when set in the shell that runs \`limn service install\`). Screenshots paragraph → `scripts/shot.sh <out.png> [LIMN_* hooks]` (headless Chrome over CDP; `CHROME_BIN` overrides the binary).
- Security section: add one sentence: `The service binds 127.0.0.1 only; any other bind requires LIMN_WEB_TOKEN and refuses to start without it.`

- [ ] **Step 2: `docs/architecture.md`**

- Line 10: `Limn is an Electron macOS app (electron-vite) with the standard three-process` → describe: a Node service (`src/server`, `src/cli`) + a React SPA (`src/renderer`) talking over HTTP POST + SSE; the CLI is the same package (`bin/limn.js` → `dist/cli`).
- `## Transport: Electron and the headless web server` → `## Transport: HTTP + SSE`; keep the seam paragraph, delete the Electron bullet, describe `startServer()`, `/health`, and `cli:open` → ticket → `?open=` → `takeCliOpen(ticket)`; delete the `cli:open is the one exception` sentence. Add a short `## CLI and service` section with the dual-role diagram from the spec (§2) and the launchd/systemd units.

- [ ] **Step 3: `docs/using-limn.md`**

Append `## The service` (install/uninstall/status/logs, upgrade + restart, `--port-80`, Tailscale recipe: `LIMN_WEB_HOST=<tailnet-ip> LIMN_WEB_TOKEN=$(openssl rand -hex 16) limn service install`, open `http://<tailnet-ip>:5466/?token=…`) and `## Safari` (two lines).

- [ ] **Step 4: adapter docs**

`docs/acp-adapters.md`: line 34 `electron-builder.yml bundles…` → `package.json bundleDependencies vendors the adapters + JS SDK glue into the npm tarball (built after npm ci --omit=optional, so the SDKs' platform binaries are never shipped or fetched)`; lines 81-87: spawn with `node` (no `ELECTRON_RUN_AS_NODE`), unpacked path → `<global node_modules>/@glebmish/limn/node_modules/…`, "run the packaged .app" → `npm run pack:smoke`. `docs/agent-layer.md`: line 58 `via Electron's own Node (process.execPath + ELECTRON_RUN_AS_NODE)` → `with the service's own Node (process.execPath)`; 86-87: `bundled in the app … asarUnpack'd` → `bundled in the npm package (bundleDependencies)`, `excluded from the package (electron-builder.yml)` → `never installed (npm ci --omit=optional at pack time; the bundled subtree is installed as-is)`; 123: `runs in the Electron **main** process` → `runs in the server process`.

- [ ] **Step 5: spec + index**

`specs/browser-pivot/spec.md` §4 `cli:open` bullet: replace the SSE-broadcast description with the ticket design (one paragraph: RPC returns `{ticket}`, CLI opens `/?open=<ticket>`, boot redeems via `takeCliOpen(ticket)`, 60 s TTL, single use; rationale: a CLI cannot focus a background tab). §6 renderer bullet: `onCliOpen` is removed, not "wired to SSE". `specs/README.md` browser-pivot row: append `— DONE 2026-xx-xx on branch 13-browser-pivot` with the actual date.

- [ ] **Step 6: Proofread + commit**

`grep -rn -i "electron\|\.app\b\|dmg\|xattr" README.md docs/*.md` → only historical mentions in the "coming from the desktop app" paragraph and the acp-adapters history notes. Commit:

```bash
git add README.md docs specs
git commit -m "docs: browser-service install, CLI/service reference, architecture without Electron"
```

---

### Task 12: Rename `src/main` → `src/server` and final verification

**Files:**
- Move: `src/main/**` → `src/server/**` (`git mv`), merging with the existing `src/server/{http,guard}.ts`
- Modify: every import of `../main/`, `../../main/`, `src/main/` in `src`, `tests`, `scripts`, `eslint.config.js`, `tsconfig.server.json`, docs

- [ ] **Step 1: Move + rewrite imports mechanically**

```bash
git mv src/main/* src/server/          # db/, engines/, ipc.ts, git.ts, … land next to http.ts + guard.ts
rmdir src/main
# server-internal: files that were in src/main now sit in src/server; their own relative
# imports are unchanged. Fix the cross-references:
grep -rl "'\.\./main/" src/server src/cli | xargs sed -i '' "s#'\.\./main/#'./#g"          # src/server/http.ts etc.
grep -rl "'\.\./\.\./main/" src/cli/service | xargs sed -i '' "s#'\.\./\.\./main/#'../../server/#g"
grep -rl "'\.\./main/" src/cli | xargs sed -i '' "s#'\.\./main/#'../server/#g"
grep -rl "src/main" tests scripts docs README.md eslint.config.js tsconfig.server.json | xargs sed -i '' 's#src/main#src/server#g'
grep -rl "'\.\./src/main" tests scripts | xargs sed -i '' "s#'\.\./src/main#'../src/server#g"
```

Then `grep -rn "main/" src tests scripts | grep -v "src/renderer/main.tsx\|cli/main"` must print nothing. In `eslint.config.js` the `ignores: ['src/main/db/db.ts']` became `src/server/db/db.ts` via the sed — verify. In `tsconfig.server.json` drop `"src/main"` from `include`.

- [ ] **Step 2: Verify everything**

```bash
rm -rf dist && npm run build && npm test && npm run typecheck && npm run lint && npm run pack:smoke
LIMN_DB=/tmp/limn-final.db LIMN_PORT=5488 node bin/limn.js open --no-service . &   # opens the review in the browser
sleep 4; LIMN_PORT=5488 node bin/limn.js service status; kill %1
```

Expected: 1092+ tests pass (the deleted `tests/cli.test.ts` count is replaced by the new CLI/server tests), typecheck/lint clean, pack smoke OK, status shows `foreground, pid …`.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "refactor: rename src/main to src/server — there is no Electron main process anymore"
```

- [ ] **Step 4: Hand-off summary**

Update `specs/README.md`'s browser-pivot row (Task 11 Step 5) if the date changed, and report: commit list, test count, and the manual checks that need a real machine (real `limn service install` on 5466 with the real DB, reboot persistence, Safari note).

---

## Self-review (done while writing)

- **Spec coverage:** §2 install/first-run (T6), address + port (T1/T5), `--port-80` (T1/T7/T8), CLI grammar (T4), `serve` busy-port messages (T5), `status` layout (T8), env overrides (T5), §3 layout/build/bundled deps (T3/T9), §4 server changes (T1/T3), §5 launchd/systemd/Windows/upgrade/shim migration (T7/T8/T6), §6 renderer (T2), §7 CI/release/scripts (T9/T10), §8 docs (T11), §9 errors (T5/T6/T8), §10 tests (each task). Follow-ups §11 untouched by design.
- **Deviation:** ticket-based `cli:open` instead of SSE broadcast — documented in the header and written back into the spec in T11.
- **Type consistency:** `Io` (T5) used by T6/T8; `ServiceBackend`/`Activation`/`UnitSpec` (T7) used by T8; `HealthInfo` (T5) used by T6/T8; `CliOpenArgs` (T1) used by T6; `resolvePort` (T5) used by T6/T8; `installService`/`isServiceInstalled` (T8) imported by T6 via the stub.
