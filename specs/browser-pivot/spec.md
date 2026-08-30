# Browser pivot: Limn as a local service + browser app

**Date:** 2026-08-30 · **Status:** draft for review · **Branch:** off `12-inplace-edits`

## 1. Decision

Limn stops being an Electron desktop app and becomes a **local Node service with a
browser front end**, distributed on npm as `@glebmish/limn` with a `limn` binary.

Why: the `.app` cannot be Developer‑ID signed or notarized (no paid Apple developer
account), so every install starts with a Gatekeeper scare and an `xattr` incantation.
npm installs carry no quarantine flag; Node is already on every target machine
(Codex CLI is npm; Claude Code needs it too). The headless web server already exists
on this branch (`src/server/index.ts`, the `Transport` seam, `src/renderer/web-api.ts`)
and shares the desktop DB — the pivot promotes it from hidden dev mode to the product
and removes the Electron shell.

Scope of *this* pivot: remove Electron; package for npm; a `limn` CLI that opens
reviews and manages an always‑on background service; `http://limn.localhost:5466`;
docs and release pipeline. Everything else is listed in §11 as follow‑ups.

## 2. User-facing shape

### Install

```
npm i -g @glebmish/limn        # puts `limn` on PATH; installs nothing else
limn                           # first run: offers to install the background service, opens the browser
```

`npm i -g` / `npx` must never install the service themselves (no `postinstall`): it
would run silently on every upgrade, be skipped by `--ignore-scripts`, and under
`npx` would point the LaunchAgent at npm's ephemeral cache.

One‑off, nothing persisted: `npx @glebmish/limn` — runs a foreground server and opens
the browser; Ctrl‑C stops it. (The SQLite DB persists at the same user‑data path as
today.)

Node ≥ 22.5 is required (`node:sqlite`); `engines` is bumped from `>=20`.

### Address

`http://limn.localhost:5466`.

- `*.localhost` resolves to loopback natively in Chrome, Edge, Arc, Firefox — no DNS
  setup — and is a **secure context**, which the PWA‑install and Web‑Notifications
  follow‑ups need. Safari does not resolve `*.localhost` (documented; the `limn.local`
  mDNS follow‑up covers it).
- **5466 = L‑I‑M‑N on a phone keypad.** IANA‑unassigned, far from the dev‑server
  crowd. (Today's default 8787 is RStudio Server's port.)
- A port‑less URL means TCP port 80: DNS cannot carry a port for HTTP, and any
  redirect (`pf`) would need `sudo` and still hijack all of `localhost:80`. Squatting
  80 by default would break the user's next `docker -p 80:80`. So `:80` is **opt‑in**:
  `limn service install --port-80` additionally binds `127.0.0.1:80` when free, and
  the CLI then opens the short URL. 5466 stays canonical either way.

### CLI

```
limn                               alias for `limn open`
limn open [DIR] [--base REF] [--branch BRANCH] [--new] [--hub] [--no-service]
limn service serve [--port N]      foreground server (what the LaunchAgent runs)
limn service install [--port-80]   write + load the unit, start it, print URL + native restart command
limn service uninstall             stop, unload, delete the unit; DB untouched
limn service status                activation, URL, pid, node-path check, native stop/restart commands
limn service logs [-f]             tail the service log
limn --version | --help
```

`limn open` is a dual‑role entry point:

1. `GET http://127.0.0.1:5466/health` — if it answers with a Limn version → **client
   role**: `POST /rpc/cli:open` with `{dir, base, branch, hub, fresh}`, open the
   browser, exit.
2. Otherwise → **server role**: start the server in this process. If no service unit
   is installed and stdin is a TTY, prompt once:
   `Install Limn as a background service so http://limn.localhost:5466 is always
   available? (LaunchAgent in ~/Library/LaunchAgents) [Y/n]`
   - `y` → `service install` (under `npx` — detected by the executable living in an
     `_npx` cache dir — say so and run `npm i -g @glebmish/limn` first, since the
     unit needs a stable path), then continue as the client.
   - `n` / non‑TTY / `--no-service` → foreground server in this process (Ctrl‑C stops
     it), plus the open. The prompt is remembered (`prefs.serviceDeclined`) so it is
     asked once.

`limn service serve` is **foreground only**. If 5466 is busy: when `/health` answers
Limn → `error: a Limn service is already running on 5466 (limn service status)`;
otherwise → `error: port 5466 is in use by another program; try --port N`. Exit 1.
No `stop`/`restart` subcommands — `status` prints the native commands.

`limn service status` (exit 0 running / 1 not):

```
Limn 0.4.0
  activation:  launchd agent dev.glebmish.limn — loaded, RunAtLoad+KeepAlive, running
               (or: foreground, pid 4211, since 14:02 · or: not running)
  server:      http://limn.localhost:5466  (127.0.0.1:5466)  pid 4211  up 3d 2h
  node:        /opt/homebrew/bin/node v24.15.0 — matches unit
               (or: MISSING at /Users/x/.nvm/…/node — run `limn service install` to repair)
  database:    ~/Library/Application Support/limn/limn.db
  logs:        ~/Library/Logs/limn.log
  restart:     launchctl kickstart -k gui/501/dev.glebmish.limn
  stop:        launchctl bootout gui/501/dev.glebmish.limn   (or: limn service uninstall)
```

Activation is exactly one of **service** (unit loaded; running or respawning),
**foreground** (`/health` answers but no unit is loaded — e.g. `npx`), **not running**.

Port/host overrides: `--port` on `serve`, `LIMN_PORT` for `open`/`status` to target a
custom server; `LIMN_WEB_HOST` / `LIMN_WEB_TOKEN` keep today's Tailscale semantics
(non‑loopback bind refuses to start without a token).

## 3. Package layout

```
@glebmish/limn
├── bin/limn.js            #!/usr/bin/env node → dist/cli/index.js
├── dist/
│   ├── cli/               limn CLI (open, service *)
│   ├── server/            HTTP/SSE server + orchestrator (today's src/server + src/main sans Electron)
│   └── renderer/          built SPA (vite)
├── package.json           "bin": {"limn": "bin/limn.js"}, "files": ["bin","dist"], "engines": {"node": ">=22.5"}
└── node_modules/…            bundled JS-only closure of the runtime deps (bundleDependencies; no platform binaries)
```

Source moves:

| today | after |
|---|---|
| `src/main/{git,db,engines,ipc,transport,…}.ts` | `src/server/…` (same files; `ipc.ts` keeps its name — it is the RPC registry) |
| `src/server/{index,guard}.ts` | `src/server/{http,guard}.ts` (`http.ts` exports `startServer(opts)`; no `main()` on import) |
| `src/main/index.ts`, `src/preload/index.ts`, `src/main/cli.ts` (shim/second‑instance parts) | **deleted** |
| `src/renderer/web-api.ts` | `src/renderer/api-client.ts` — the only `Api` backing; `main.tsx` calls it unconditionally |
| — | `src/cli/{index,open,service,launchd,systemd,status}.ts` |
| `electron.vite.config.ts`, `electron-builder.yml`, `build/` icons for the .app | `vite.config.ts` (renderer, root `src/renderer`, outDir `dist/renderer`); `tsc -p tsconfig.server.json` → `dist/{server,cli}` |

Build: `npm run build` = `vite build && tsc -p tsconfig.server.json`. `npm run dev` =
`vite` dev server on 5173 proxying `/rpc`, `/events`, `/health` to `tsx src/cli/index.ts
service serve --port 5466` (concurrently). `npm run package` and the Electron deps
(`electron`, `electron-builder`, `electron-vite`) are removed.

**Dependency footprint — bundled, JS‑only.** The ACP adapters depend on SDKs whose
platform binaries are `optionalDependencies` (≈220 MB Claude + ≈240 MB Codex on
darwin‑arm64). Limn never uses them — engines resolve the user's own `claude`/`codex`
via `CLAUDE_CODE_EXECUTABLE` / `CODEX_PATH` (`binaryRequired` preflight unchanged), and
the Electron build already strips them. Under npm the same is achieved with
`bundleDependencies`: the runtime deps are listed in `bundleDependencies`, and the
publish job runs `npm ci --omit=optional` before `npm pack`, so the tarball vendors the
JS closure and npm installs it as‑is without resolving the optional platform packages.
CI asserts the packed tarball contains no `claude-agent-sdk-*` / `codex-<platform>`
directories. Users need no special flags.

**As built (deviations from the numbers above).**

- **Five runtime deps, not four.** `@modelcontextprotocol/sdk` turned out to be a
  *direct* runtime dependency — `src/main/engines/mcpHost.ts` hosts the per‑turn MCP
  server on it — so it is a `dependency` and is bundled alongside
  `@agentclientprotocol/{claude-agent-acp,codex-acp,sdk}` and `zod`.
- **Size: ≈ 4.9 MB tarball, ≈ 35 MB installed** — not the 2.5 MB / 16 MB measured in
  the scratch spike, which predated the MCP SDK's own express/hono tree. Still no
  platform binaries; slimming that tree is a follow‑up (§11).
- **`npm ci --omit=optional` cannot build.** rollup's native binary
  (`@rollup/rollup-<platform>`) is itself an `optionalDependency`, so an
  `--omit=optional` install has no working `vite build`. `scripts/pack-smoke.sh` builds
  under a full `npm ci`, then re‑installs with `--omit=optional` immediately before
  `npm pack` (which is what actually determines what the bundled packages carry).
  Job‑level installs in CI/release are therefore plain `npm ci`, with the strip step
  placed just before packing.

## 4. Server changes

`src/server/http.ts` — today's `index.ts` with:

- `startServer({ port, host, token, staticRoot, dbPath, vanityPort80 })` returning
  `{ close(), port, url }`; `main()` moves to the CLI. Lets tests stand it up on an
  ephemeral port.
- `GET /health` (unauthenticated, loopback‑only semantics via `sameSiteOk`) →
  `{ app: 'limn', version, pid, startedAt, port }` (no `db` — as built). Used by the CLI role check,
  `status`, `serve`'s clash message.
- `cli:open` becomes a real channel, delivered as a **one‑time ticket** rather than a
  push (as built): `POST /rpc/cli:open` resolves `repoRoot(dir)`, parks the resulting
  `CliOpenMsg` under a random ticket (`src/main/cliOpen.ts`) and returns `{ticket}`; the
  CLI opens `http://limn.localhost:5466/?open=<ticket>` in a **new** browser tab; the
  booting SPA redeems it over the `takeCliOpen(ticket)` RPC channel and strips the query
  param. Tickets are single‑use with a 60 s TTL. Rationale: a CLI cannot focus a
  background browser tab, so an SSE broadcast to already‑open tabs would fire the review
  into a tab the user is not looking at while the CLI still had to open *something*. A
  new tab is the one delivery that is always visible, and it needs no broadcast channel —
  so `cli:open` is not a `BroadcastChannel` member and the renderer has no `onCliOpen`.
- `Transport.notify` stays a no‑op on the server (Web Notifications is a follow‑up);
  `pickDirectory` stays `null` (client prompts, as today); `installCli` / `settings:open`
  channels and the `cli.ts` shim installer are deleted (the npm bin *is* the CLI; the
  Settings gear exists in every screen).
- ACP adapters are spawned with `process.execPath` + no `ELECTRON_RUN_AS_NODE`
  (`adapters.ts`), since `process.execPath` is now plain `node`.
- Optional second listener on `127.0.0.1:80` when `vanityPort80` (bind failure is
  logged, never fatal).
- `bootstrapPath()` (login‑shell PATH top‑up) stays — the LaunchAgent has a bare PATH.
- Default `dbPath` = today's `defaultDbPath()` (unchanged location; existing users keep
  their data). `LIMN_DB` override kept.

Everything under `registerIpc` is untouched: it already speaks only `Transport`.

## 5. Service manager

`src/cli/service.ts` dispatches to a platform backend; each backend implements
`install(opts) / uninstall() / status(): ActivationInfo / logPath()`.

**macOS — launchd** (`src/cli/launchd.ts`). Unit `~/Library/LaunchAgents/dev.glebmish.limn.plist`:

```xml
Label            dev.glebmish.limn
ProgramArguments <abs node> <abs …/dist/cli/index.js> service serve [--port-80]
EnvironmentVariables PATH=<login-shell PATH captured at install>, HOME
RunAtLoad true · KeepAlive true
StandardOutPath/StandardErrorPath ~/Library/Logs/limn.log
```

- `install`: capture `process.execPath` and the package's own `dist/cli/index.js`
  (absolute, resolved through symlinks so an nvm/Homebrew `node` and the global
  `node_modules` path are recorded as real files); write the plist; `launchctl bootout`
  any existing one; `launchctl bootstrap gui/$UID <plist>`; `launchctl kickstart -k`;
  wait for `/health` (≤10 s) and print URL + restart command. Idempotent — re‑running
  repairs a moved node.
- `uninstall`: `launchctl bootout gui/$UID/dev.glebmish.limn`, delete the plist.
- `status`: `launchctl print gui/$UID/dev.glebmish.limn` (loaded? pid? last exit),
  parse the plist's node path and `fs.access` it → "matches unit" / "MISSING".
- The plist carries a header comment with the restart/stop commands (same style as
  the user's existing LaunchAgents).

**Linux — systemd `--user`** (`src/cli/systemd.ts`). Unit
`~/.config/systemd/user/limn.service` (`Restart=always`, `WantedBy=default.target`),
`systemctl --user daemon-reload && enable --now limn`; status via
`systemctl --user show limn -p ActiveState,MainPID`. Logs via `journalctl --user -u limn`
(the `logs` subcommand shells out to it). Note in docs that `loginctl enable-linger`
is needed for "always‑on without a login session".

**Windows**: `service install` prints "not supported yet; run `limn service serve`" and
exits 2. `open` and foreground `serve` work.

**Upgrade path:** `npm i -g @glebmish/limn@latest` swaps the files under the same
global path recorded in the unit; the running process still holds the old code until
`launchctl kickstart -k …` (printed by `install` and `status`). A `limn update` wrapper
is a follow‑up.

**Migration from the .app:** the old Electron‑installed shim at `~/.local/bin/limn`
(or `/usr/local/bin/limn`) would shadow or be shadowed by the npm bin depending on
PATH order. `limn open` / `service install` detect a shim whose first lines contain the
generated header (`# limn — open Limn for a repository (generated by the app`) and
offer to delete it. README tells users to trash `Limn.app`; the DB is untouched.

## 6. Renderer

- `main.tsx`: always `installApiClient()` then render — the `window.api` preload branch
  goes away. `dev.ts` / `window.limnDev` (screenshot hooks) become a query‑string /
  `localStorage` switch instead of a preload‑injected object.
- `api-client.ts`: `takeCliOpen` stays an RPC and is the *only* `cli:open` path —
  `onCliOpen` is **removed** from `Api` and the renderer rather than wired to SSE (see
  the ticket design in §4). `installCli` and `onSettingsOpen` are removed from `Api` and
  `API_CHANNELS` too. The store redeems `?open=<ticket>` at boot (`boot-params.ts` →
  `store/index.ts`).
- `pickRepo`: unchanged `window.prompt` (server‑side picker is a follow‑up), but the
  prompt text says "on this machine" when the page origin is loopback.
- CSP meta in `index.html` stays (`default-src 'self'`) — `fetch`/`EventSource` to the
  same origin are fine.

No screen/component changes otherwise.

## 7. Build, CI, release

- `ci.yml`: unchanged in spirit (`lint`, `typecheck`, `test`, `build` after a plain
  `npm ci` — **not** `--omit=optional`, which would strip rollup's own native binary and
  break `vite build`), plus `npm run pack:smoke`: it re‑installs with `--omit=optional`
  right before `npm pack`, asserts the tarball has no platform-binary packages, installs
  the tarball into a temp prefix with default npm flags, runs `limn service serve
  --port 0` (ephemeral port, printed on stdout) and curls `/health`.
- `release.yml`: on tag `v*` — plain `npm ci`, verify tag = `package.json` version,
  `npm run pack:smoke` (build + full artifact check), then an explicit
  `npm ci --omit=optional` strip step, `npm pack`, a second tarball assertion, `npm
  publish --access public --provenance`, then a GitHub Release with generated notes and
  the `.tgz` attached. All DMG/zip/Electron steps removed. `workflow_dispatch` dry‑run
  keeps `npm pack` + artifact upload. **As built:** publishing authenticates with an
  `NPM_TOKEN` repo secret (`NODE_AUTH_TOKEN`); npm trusted publishing via GitHub OIDC is
  not configured, so that secret must exist before the first `v*` tag — the `id-token`
  permission is already granted for provenance.
- `scripts/`: `shot.sh` / `record-inplace-demo.sh` / `smoke-installed.sh` switch from
  `npx electron .` to `limn service serve --port <ephemeral>` + headless Chrome over CDP
  (the approach already used for web screenshots); `smoke-installed.sh` smokes the
  globally installed package instead of `/Applications/Limn.app`.

## 8. Docs

- `README.md`: Install section → npm + first‑run prompt + URL; delete the Gatekeeper /
  `xattr` section and DMG download; Security section gains one paragraph on the
  service (loopback‑only by default, token required for any other bind). Screenshots
  unaffected (same UI).
- `docs/architecture.md` §Transport: one backing; add the CLI dual‑role diagram,
  `/health`, and the `cli:open` ticket flow.
- `docs/using-limn.md`: CLI reference (§2 above), service lifecycle, upgrade, Safari
  note, Tailscale recipe.
- `docs/acp-adapters.md`, `docs/agent-layer.md`: drop `ELECTRON_RUN_AS_NODE`/asar
  mentions.
- `CHANGELOG`/release notes: 0.4.0 "Limn is now a local service; the desktop app is
  discontinued", with the migration steps.

## 9. Error handling

| situation | behaviour |
|---|---|
| port busy on `serve` | distinguishes Limn vs foreign listener via `/health`; exit 1 with the matching message |
| `open` when server won't start (e.g. DB locked, node too old) | print the underlying error and `limn service logs`; exit 1 |
| node too old | `bin/limn.js` checks `process.versions.node` before importing anything that needs `node:sqlite`; prints "Limn needs Node ≥ 22.5 (found 20.11)" |
| unit references a missing node | `status` says MISSING and how to repair; `install` overwrites |
| `launchctl` missing / not macOS / not Linux | clear "not supported" message, exit 2 |
| `cli:open` for a non‑git dir | today's `{error}` message shown in the UI; CLI still opens the browser |
| `--port-80` bind fails | logged warning at startup; short URL not printed |
| non‑loopback bind without token | refuse to start (unchanged) |

## 10. Testing

Unit (vitest, in `tests/`):

- `cli-args.test.ts` — keep `parseCliArgs` coverage for the new `open` grammar.
- `service-launchd.test.ts` — plist generation (paths, PATH capture, `--port-80`),
  `launchctl print` parsing → `ActivationInfo`; `status` node‑path check with a fake fs.
- `service-systemd.test.ts` — unit generation and `systemctl show` parsing.
- `server-http.test.ts` — `startServer` on port 0: `/health` shape, `cli:open` RPC →
  ticket, `takeCliOpen` redemption (single use, 60 s TTL), guards unchanged
  (`guard.test.ts` keeps its tests).
- `cli-open-role.test.ts` — dual‑role decision table with a stubbed `/health` and a
  stubbed prompt (TTY / non‑TTY / `--no-service` / npx cache path).
- `renderer-boot.test.ts` — boot params and the `?open=<ticket>` redemption.

Integration (CI job): `npm pack` → install into a temp prefix → `limn service serve
--port 0` in background → `curl /health` → `limn open --hub` against `LIMN_PORT` →
assert the RPC returns a ticket that `takeCliOpen` redeems. (`scripts/pack-smoke.sh`,
run by CI as `npm run pack:smoke`, covers the pack/install/`/health` half.)

Manual smoke (human GUI, macOS): fresh `npm i -g`, first‑run prompt → service, reboot
survives, `limn open --branch x` from a repo opens the review in a new tab,
`status`/`uninstall`, Safari note verified. Existing 1092 tests must stay green; the
Electron‑only tests in `tests/cli.test.ts` (shim content) are deleted with the shim.

## 11. Follow-ups (captured, not built here)

1. **PWA install** — manifest + icons + "Install Limn" hint; standalone window and dock
   icon (the visual replacement for the Electron window). Needs the secure‑context
   origin this spec establishes.
2. **Web Notifications** — `Transport.notify` → browser notifications when the tab is
   in the background.
3. **Server‑side directory picker** — replace `pickRepo`'s `window.prompt` with a host
   directory browser RPC + recent repos.
4. **Update pill + `limn update`** — server checks npm for a newer version; pill in the
   titlebar; `limn update` = `npm i -g …@latest` + native restart.
5. **Tailscale first‑run** — `service install --tailscale` generates a token, binds the
   tailnet address, prints the remote URL.
6. **`limn.local` via mDNS** — separate LaunchAgent running `dns-sd -P` (decoupled from
   the server so restarts don't churn the name), for Safari and other LAN devices;
   not a secure context, so PWA/notifications don't apply there.
7. **`curl | sh` installer / Homebrew tap** — wrappers over `npm i -g` + first run.
8. **Windows service** (Task Scheduler / NSSM) if there is demand.
9. **Slim the `@modelcontextprotocol/sdk` tree** — it pulls express *and* hono for a
   server Limn only speaks to over loopback; it dominates the ≈ 35 MB installed
   footprint. Either a narrower entry point or a hand-rolled streamable-HTTP transport.
10. **Single-signal shutdown while a review watcher is armed** — the live-watch poll
    timer keeps the event loop alive past `server.close()`, so the first SIGINT/SIGTERM
    can hang; the screenshot-family scripts (`shot.sh`, `record-inplace-demo.sh`,
    `smoke-installed.sh`) escalate to SIGKILL to work around it, while `pack-smoke.sh`
    still uses a plain `kill`. Unref the timer (or cancel the watcher in `close()`)
    instead.

## 12. Open questions resolved during brainstorming

- Electron removed entirely (not kept as a secondary target).
- npm name `@glebmish/limn` (`limn` is taken by a 2D drawing library).
- Address `limn.localhost`, port 5466; `:80` opt‑in only.
- `serve` is foreground‑only; no `stop`/`restart` subcommands; `status` shows activation
  and native commands.
- `cli:open` parity is in scope — delivered as a ticket + new tab rather than a push
  into an already-open tab (§4).
