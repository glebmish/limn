# limn

[![CI](https://github.com/glebmish/limn/actions/workflows/ci.yml/badge.svg)](https://github.com/glebmish/limn/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%40glebmish%2Flimn)](https://www.npmjs.com/package/@glebmish/limn)
[![License](https://img.shields.io/github/license/glebmish/limn)](LICENSE)

A local service + browser app for **agentic review of local git branches** that helps you understand the code.

![A 27-file branch under guided review in Limn: the diff grouped into logical sections with per-section narration in the sidebar, a plain-language summary of what the branch does, and an "Agent needs 2 decisions" panel where the agent asks the reviewer to make a call before it proceeds.](docs/media/hero-review-question.png)

- **Guided review** — Agent explains what has changed, splits changes on semantical groups and asks clarifying questions.
- **Agentic tools** — Tools for agent to help user navigate: navigate to a file that builds a database query, explain the auth workflow across multiple files, etc.
- **Spec/plan cross-check** — flags where the implementation diverged from what the spec and plan define.
- **Comment on anything** — diff lines, spec lines, plan steps, section narration — comment and agent will follow up on it.
- **Agent agnostic** — Supports both Claude and Codex via SDKs.
- **Native support for quick local iterations** — see diff from the last reviewed state, update narration for the new commits.


## What it does

**Narrates the change.** The agent explores callers, tests, and history, then explains how the change actually works — here, a seven-stop tour that follows one value from the UI selector through IPC down to the engine, scrolling the diff to each stop.

![The chat drawer showing a seven-stop "propagation tour"; each stop is a file and line, and selecting one jumps the diff to that code.](docs/media/review-tour.webp)

**Checks the change against the spec.** Limn auto-discovers specs and plans based on popular conventions and flags where the implementation diverged, criteria by criteria.

![The spec view with a "Where the implementation diverged" callout listing four divergences, beside a list of acceptance criteria tagged DONE or PARTIAL.](docs/media/spec-divergence.png)

**Follows up on comments.** Leave comments on any line, section, or spec point, send them to the agent — it will read callers, run commands, edit files — then report a resolution per comment and commit the changes.

![Queued reviewer comments sent to the agent; the chat drawer streams its tool calls — grep, read, edit — and returns one resolution per comment.](docs/media/apply-loop.webp)

**Shows updates as they come.** When new commits land — from the agent or the user — a titlebar pill shows the drift; after reload, diff shows just the delta. Agent can also update the narration based on the new changes.

![A titlebar drift pill showing the branch is a commit behind; after reload the "Since viewed" filter highlights the changed section and a new working-tree file, ready to re-approve.](docs/media/drift-freshness.webp)

## Security & privacy

Limn is a local app with no telemetry, accounts, hosted backend, or cloud sync of
its own. It does not store Claude, Codex, Anthropic, or OpenAI credentials. It uses
the credentials and command-line agents already installed and authorized on your
machine (`claude`, `codex`). Limn also does not use macOS Keychain. The service binds
`127.0.0.1` only; any other bind requires `LIMN_WEB_TOKEN` and refuses to start without
it.

Review state lives in one local SQLite database at a per-user location
(`~/Library/Application Support/limn/limn.db` on macOS). That database stores the
review layer: repositories you opened, sessions, comments, chat, generated review
notes, viewed flags, and approvals. Git remains the source of truth for code:
diffs, file contents, and branch state are read from your working tree.

When you choose Claude or Codex, the selected provider receives the prompts and
repository context needed for the review, using your existing provider account or
API key. Limn itself does not send data anywhere else.

Limn runs a coding agent against your repo. The execution tier, set per agent,
controls how much it can do on its own:

- **Ask for approval** / **Accept edits** — the agent confirms before running
  commands; safe defaults for unfamiliar code.
- **Auto mode** / **Full access** — the agent runs shell commands and edits/commits
  without confirming each step.

Only use **Auto mode** or **Full access** on repos you trust. For code you have not
vetted, stay on **Ask for approval** or **Accept edits**.

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
`limn service status` prints (`launchctl kickstart -k gui/$UID/dev.glebmish.limn` on
macOS, `systemctl --user restart limn` on Linux).

Coming from the desktop app: delete `Limn.app`; your reviews are in the same database
and `limn` offers to remove the old shell shim it installed.

## Prerequisites

- `git` on your PATH.
- **Claude engine**: a [Claude Code](https://code.claude.com) login (run `claude` once) or `ANTHROPIC_API_KEY`.
- **Codex engine**: `codex login` (ChatGPT plan) or `OPENAI_API_KEY`.

Either engine alone is enough — the picker shows what's authenticated. Subscription logins are inherited from the local Claude/Codex credentials; usage is billed to them.

## Using it

1. **Open a repository** (*Open repository…*) by typing its path (the picker is a
   follow-up) — Limn adds it to the **Dashboard**'s repository index and remembers it
   across launches.
2. On the Dashboard: type to filter the list, ↑/↓ to move, ⏎ (or click) to open a
   repo's sessions. Each row shows its current branch (click the branch chip to open
   that branch's review) and when it was last active.
3. **Opening a repo lands directly on the review** for its current branch — the diff
   against the default base (`main` → `master` → first branch), already loaded. No
   session is minted until you act (comment, mark something viewed, generate, or
   approve); until then the header reads **Draft**.
4. Change the **base** with the ref picker (branches, recent commits, or a typed
   SHA / `HEAD~N` / tag); switch the **branch** — and where it's checked out — with the
   branch/worktree picker. Pick an engine — and optionally a model and reasoning effort
   (Claude Opus/Sonnet `low→max`, Codex GPT-5.x `low→xhigh`; *Auto* uses the engine
   default) — then **Generate guided review**.
5. **Review**: mark files viewed, mark sections reviewed, comment on any diff line,
   section, agent question, or spec/plan line; **Chat** shares the agent's session.
   The **Sessions** button opens the repo hub with every saved review for the repo.
6. **Send N changes to agent** — it edits, commits on your branch, and reports
   per-comment resolutions. **Approve** records the reviewed SHA.

Limn **watches the branch** — when commits land from outside (e.g. a Claude Code session in a terminal), a titlebar fetch pill shows the drift and lets you reload when ready. After reload, "changed since viewed" / "changed since approval" rails highlight what moved. (Browser notifications for finished runs are a follow-up.) Diffs are syntax-highlighted with word-level change marks.

### The `limn` command

The CLI ships with the package. If the service is running it opens there; otherwise it
starts a server for you.

```bash
limn                                 # review the current branch of the repo you're in
limn ~/code/myrepo                   # same, for another repo (any path inside it works)
limn --base main --branch feature/x  # review a specific pair
limn --new                           # start a fresh review instead of resuming
limn --hub                           # open the repo's saved-review list
```

| Flag | Meaning |
| --- | --- |
| `DIR` (positional) | A path inside the repo to review — defaults to the current directory. |
| `--base REF` | The base ref (branch, tag, SHA) — defaults to the repo's default base. |
| `--branch BRANCH` | The branch to review — defaults to the current branch. |
| `--new` | Force a fresh review rather than resuming the latest one for the pair. |
| `--hub` | Open the repo hub (every saved review) instead of a review. |
| `--no-service` | Skip the service prompt; run in the foreground. |

```bash
limn service serve [--port N]     # foreground server (default 5466)
limn service install [--port-80]  # always-on background service (+ optional http://limn.localhost alias on :80)
limn service status               # activation (service / foreground / not running), URL, pid, node path, native stop/restart commands
limn service uninstall            # remove the service; database untouched
limn service logs [-f]
```

Bare `limn` behaves exactly like opening the repo from the Dashboard: it resumes the
most recent review for the current branch, or shows a draft review if there is none.
The review opens in a new browser tab.

More in-flow details — excluding untracked files, multiple reviews per branch,
dirty-worktree review — plus the service lifecycle and the Tailscale recipe are in
[docs/using-limn.md](docs/using-limn.md).

## Limitations

- **macOS and Linux** — Windows can run `limn service serve` in the foreground; there is no Windows background service yet.
- **Safari** does not resolve `limn.localhost`; use `127.0.0.1:5466`.
- **Local credentials required** — a Claude and/or Codex login (or `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`) must be present on the machine.
- **Single-machine state** — review state is a local SQLite file; it does not sync across machines.
- Early, active development — storage layout and APIs may change.

## Development

Requires Node 22.5+.

```bash
npm install
npm run dev        # vite on :5173, proxying /rpc, /events, /health to a server started with `npm run dev:server`
npm test           # vitest: diff parser, ref resolution, sessions DAO, CLI args, service units, anchoring, engine contract
npm run typecheck
npm run lint
npm run build      # dist/renderer (vite) + dist/{server,cli} (tsc)
npm run pack:smoke # npm pack → install into a temp prefix → /health, asserting no platform binaries shipped
```

Pushing a `v*` tag that matches `package.json` publishes `@glebmish/limn` to npm
(bundled JS-only adapter closure, no platform binaries) and creates a GitHub Release
with the tarball.

Useful dev env vars: `LIMN_DEMO=1` (deterministic fake engine), `LIMN_PORT` (server port), `LIMN_DB` (SQLite path), `LIMN_WEB_HOST` / `LIMN_WEB_TOKEN` (bind somewhere other than loopback — e.g. a Tailscale address — with a required token; the service records them when they are set in the shell that runs `limn service install`), `LIMN_OPEN_REPO` / `LIMN_OPEN_BRANCH` (open straight to the review for a repo/branch), `LIMN_FLOW=generate|chat` (auto-run a flow / open the chat drawer). Real-engine smoke scripts: `npx tsx scripts/acp-smoke.ts` / `smoke-codex.ts`.

**Screenshots:** `scripts/shot.sh <out.png> [LIMN_* hooks]` seeds a fixture repo + db, serves it on an ephemeral port, and captures the page with headless Chrome over CDP (`CHROME_BIN` overrides the binary). The hooks — `LIMN_ACTIVE_CHAT=<id>` (activate a chat), `LIMN_OPEN_PICKER=1` (open the agent popover), `LIMN_OPEN_CHATLIST=1` (open the chat dropdown), … — travel to the page as `?dev=<json>` built by `scripts/dev-url.mts`.

Architecture: see [docs/architecture.md](docs/architecture.md), with deeper dives in [docs/agent-layer.md](docs/agent-layer.md), [docs/storage-layer.md](docs/storage-layer.md), and the [ACP adapter playbook](docs/acp-adapters.md).

## License

[MIT](LICENSE) © Gleb Mishchenko
