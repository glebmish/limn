# Architecture

A system-level map of how Limn is put together. For the two heaviest subsystems
see [agent-layer.md](agent-layer.md) (the AI engines) and
[storage-layer.md](storage-layer.md) (persistence); this doc ties them together
and covers the cross-process topology and event model that neither owns.

## Overview

Limn is a **local Node service with a browser front end**, distributed on npm as
`@glebmish/limn`. One process serves a React SPA and answers its calls over HTTP
POST + Server-Sent Events; the `limn` CLI is the same package (`bin/limn.js` →
`dist/cli`) and either talks to a running service or becomes one. It turns
`git diff` into an AI-guided review: git is ground truth and the agent only
annotates — it never alters the code you see. Review state (sessions, comments,
viewed/reviewed flags, chat) lives in one SQLite file; diff content is always
read live from git, never cached as truth.

## Processes and layers

- **`src/shared/`** — process-agnostic contracts, no runtime dependency on the
  server or the renderer. Domain types (`types.ts`: the git skeleton,
  `ReviewAnnotations`, `Comment`/`CommentAnchor`, the `EngineEvent` union), the
  IPC surface (`ipc.ts`: the `Api` interface and the `API_CHANNELS` list), the
  agent catalog (`agents.ts`), and the execution-mode ladder
  (`executionMode.ts`).
- **`src/server/`** — the service core.
  `ipc.ts` is the orchestrator (it owns the API handlers, per-repo locking, and
  the three flows below); `git.ts`/`exec.ts` are the git ground-truth layer;
  `review.ts` assembles diff skeletons and "since" marking; `db/` persists the
  review layer; `engines/` drives the AI; `paths.ts` resolves the database and
  log locations; `cliOpen.ts` mints the CLI's one-time open tickets.
- **`src/server/`** — the HTTP carrier. `http.ts` exports `startServer(opts)`
  (static SPA + `/rpc/*` + `/events` + `/health`, and it opens the single DB
  handle); `guard.ts` holds the pure host/origin checks so they are testable
  without a socket (the token comparison itself lives in `http.ts`).
- **`src/cli/`** — the `limn` binary: `args.ts` (grammar), `open.ts` (the
  dual-role entry point), `serve.ts` (foreground server), and `service/`
  (launchd / systemd `--user` backends, `status` rendering).
- **`src/renderer/`** — React 19 with one Zustand store assembled from slices in
  `store/` (`repo`, `review`, `chat`, `ops`, `edits`, `dashboard`, …) that owns
  screen routing (Dashboard, RepoHub, Review) and the op lifecycle.
  `api-client.ts` installs `window.api` over `fetch` + `EventSource`.

The dependency graph runs one way: renderer → (HTTP/SSE) → `ipc.ts` →
`{git, db, engines}`, with `engines` also reaching `db` and `git`.

## Data flow: generating a review

A single user action — "Generate guided review" — traces through every layer:

1. The Review screen calls `api.generate(...)`; `api-client.ts` forwards it as
   `POST /rpc/generate` with the arguments as a JSON array.
2. `ipc.ts` acquires the per-repo lock, reads the diff from git (`getDiff`) and
   the existing review state from the DB.
3. It starts the chosen engine's `generateReview`, which returns an
   `{ events, result, cancel }` triple.
4. **Dual channel:** `events` are pumped to the renderer as `op:event` for live
   progress while `ipc.ts` awaits the terminal `result`.
5. The result is reconciled against the git skeleton (`mergeAnnotations` — any
   file the model named that isn't in the diff is dropped), persisted to the DB,
   and sent back as a single `op:result`.
6. The store's reducer applies `op:result` and updates the screen.

The interactive chat and apply-edits flows follow the same `op:event` /
`op:result` shape.

## The event model

Every engine operation returns `{ events, result, cancel }`. `ipc.ts` forwards
`events` on the `op:event` channel for live UI updates and resolves `result` on
the `op:result` channel when the operation finishes. `EngineEvent` is a tagged
union — `status`, `tool`, `text`, `action`, `approval_request`, `done`, `error` —
so the renderer reduces one event stream regardless of which engine produced it.
Approvals (when an execution tier requires a go-ahead) ride this same channel as
`approval_request` events and are answered back over a dedicated `Api` channel;
see [agent-layer.md](agent-layer.md) for the approval registry.

## Transport: HTTP + SSE

The orchestrator (`registerIpc`) never touches the HTTP layer. It speaks a small
`Transport` seam (`src/server/transport.ts`) — `handle` (register a request/response
channel), `broadcast` (fan a push message to every client), `notify` (out-of-band
notification), `pickDirectory` (host directory picker) — and one backing
implements it today:

- **The HTTP service** (`src/server/http.ts`) — `startServer({ port, host, token,
  staticRoot, dbPath, vanityPort80 })` returns `{ port, url, vanity, close() }`.
  `handle` becomes `POST /rpc/<channel>` with a JSON array of arguments;
  `broadcast` becomes one `/events` SSE stream carrying `op:event` /
  `op:result` / `repo:changed` frames; `notify` is a no-op (browser notifications
  are a follow-up) and `pickDirectory` returns `null` (the client prompts for a
  path). Everything else is the built SPA, served from `dist/renderer` with an
  index.html fallback for client-side routes.
- **`GET /health`** is public and unauthenticated — `{ app, version, pid,
  startedAt, port }`. It is how the CLI decides whether a service is already
  running, and it deliberately leaks nothing beyond "a Limn of this version is
  here".
- **Secure by default.** The server binds loopback (`LIMN_WEB_HOST` defaults to
  `127.0.0.1`) and **refuses to start** a non-loopback bind unless
  `LIMN_WEB_TOKEN` is set. `/rpc/*` and `/events` are the only protected paths:
  they require the token (`Authorization: Bearer` or `?token=`) when one is set,
  and pass a same-site / DNS-rebinding guard (`guard.ts`) — an `Origin`, when
  present, must match the request `Host` (and `Origin: null` is refused outright),
  a `Sec-Fetch-Site: cross-site` request is refused, and without a token perimeter
  the `Host` must be one of `limn.localhost`, `localhost`, `127.0.0.1`, `::1`.
  `POST /rpc/*` additionally requires `Content-Type: application/json` (415
  otherwise) — the one header an HTML form cannot set — and caps bodies at 8 MB.

So the renderer is transport-agnostic: `renderer → api-client → Transport →
{git, db, engines}`.

**`cli:open` is a ticket, not a push.** A CLI cannot focus a browser tab it does
not own, so there is no broadcast for it: `POST /rpc/cli:open` resolves the repo
root and parks the resulting message under a one-time ticket
(`src/server/cliOpen.ts`); the CLI opens `http://limn.localhost:5466/?open=<ticket>`
in a **new** tab; that tab redeems the ticket at boot with the `takeCliOpen`
channel. Tickets are single-use and expire after 60 s.

## CLI and service

`limn` is dual-role — the same command is a client when a service is up and a
server when it is not:

```
limn [DIR] …
  │
  ├─ GET <bind host>:5466/health ─► answers ──► client role
  │                                            POST /rpc/cli:open → { ticket }
  │                                            open  …/?open=<ticket>  (new tab)
  │
  └─────────────────────────────► silent ───► server role
                                               startServer() in this process,
                                               ticket issued in-process,
                                               first run offers `service install`
```

The bind host, port and token are one value — `serviceTarget()` in `src/cli/target.ts`
(`LIMN_WEB_HOST` / `LIMN_PORT` / `LIMN_WEB_TOKEN`) — shared by the health probe, the
port-clash check, `service install`'s readiness wait, `service status`, and `cli:open`.
It also carries the browser-facing URL: the vanity `limn.localhost` on loopback, the
real host (IPv6 bracketed) otherwise, plus `?token=` when there is a perimeter.

The background service runs `<node> <…/dist/cli/index.js> service serve
[--port-80]` from a generated unit — `~/Library/LaunchAgents/dev.glebmish.limn.plist`
(launchd, `RunAtLoad` + `KeepAlive`, logging to `~/Library/Logs/limn.log`) or
`~/.config/systemd/user/limn.service` (systemd `--user`, `Restart=always`, appending
to the same log file, though `limn service logs` reads the journal there). Both record absolute, symlink-resolved paths for `node` and the
entry script, a login-shell `PATH` (so the engines find `git`/`claude`/`codex`),
and any of `LIMN_PORT` / `LIMN_DB` / `LIMN_WEB_HOST` / `LIMN_WEB_TOKEN` that were
set in the installing shell. There are no `stop`/`restart` subcommands:
`limn service status` prints the native `launchctl` / `systemctl` commands
alongside the activation state, URL, pid, and a check that the recorded `node`
still exists.

## External dependencies

- **`git`** (subprocess) — the source of truth for all diff, ref, and worktree
  state. Invoked via `execFile` (never a shell) with `core.quotePath=false`.
- **ACP adapters** (`@agentclientprotocol/claude-agent-acp`, `codex-acp`) — pinned
  npm packages, spawned per turn with the service's own Node, that speak the Agent
  Client Protocol and drive the user's `claude` / `codex` CLIs. The adapters + their
  JS SDK glue are vendored into the npm tarball (`bundleDependencies`); the native
  CLIs are not (resolved from PATH/Settings). Authentication and billing inherit
  from the CLI logins; Limn never stores keys. See [agent-layer.md](agent-layer.md).
- **`@modelcontextprotocol/sdk`** — hosts the per-turn localhost MCP server that
  exposes Limn's review tools to the adapters (`engines/mcpHost.ts`).
- **`node:sqlite`** — the bundled SQLite binding; no third-party driver.
