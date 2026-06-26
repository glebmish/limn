# limn

A native macOS app for **agentic review of local git branches** — before the code leaves your machine.

Pick a repo and a branch; the app shows the diff against a base branch in a guided-review UI. An AI agent — **Claude (Agent SDK) or Codex (Codex SDK), your choice per review** — explores the repository (callers, tests, history, specs) and turns the raw diff into a narrated review: logical sections, plain-language "what changed" notes, risk flags, mechanism diagrams, and a cross-check against the spec/plan the change was built from. You comment on anything — diff lines, spec lines, plan steps, section narration — chat with the agent about the code, then send your comments back: the agent applies fixes as a new iteration on the branch, and the app shows you only what changed since you approved.

Git is ground truth throughout: diffs are always parsed from `git diff`; the agent only annotates them and can never alter the code you see.

## Download

Download the latest macOS Apple Silicon DMG from [GitHub Releases](https://github.com/glebmish/limn/releases/latest). The release asset is named `Limn-<version>-arm64.dmg`.

The app is currently ad-hoc signed but not notarized. If macOS says it is damaged or cannot verify the developer, run this after dragging `Limn.app` to `/Applications`:

```bash
xattr -dr com.apple.quarantine /Applications/Limn.app
```

## Prerequisites

- `git` on your PATH.
- **Claude engine**: a [Claude Code](https://code.claude.com) login (run `claude` once) or `ANTHROPIC_API_KEY`.
- **Codex engine**: `codex login` (ChatGPT plan) or `OPENAI_API_KEY`.

Either engine alone is enough — the picker shows what's authenticated. Subscription logins are inherited from the local Claude/Codex credentials; usage is billed to them.

## Using it

1. **Open a repository** (*Open repository…* / ⌘O) via the native dialog — Limn adds
   it to the **Dashboard**'s repository index and remembers it across launches.
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

The app **watches the branch** — when commits land from outside (e.g. a Claude Code session in a terminal), a titlebar fetch pill shows the drift and lets you reload when ready. After reload, "changed since viewed" / "changed since approval" rails highlight what moved. You also get a **macOS notification** when an agent run finishes while the app is in the background. Diffs are syntax-highlighted with word-level change marks.

Review state (sessions, comments, chat, approvals) lives in a SQLite database in the app's userData.

## Trust & safety

Limn runs a coding agent against your repo. The execution tier (set per review)
controls how much it can do on its own:

- **Ask for approval** / **Accept edits** — the agent confirms before running
  commands; safe defaults for unfamiliar code.
- **Auto mode** / **Full access** — the agent runs shell commands and edits/commits
  without confirming each step; **Full access** also lifts the sandbox (network and
  any file).

The agent reads the repository to do its job, so a repo's contents can influence
what it does. Only use **Auto mode** or **Full access** on repos you trust. For code
you haven't vetted, stay on **Ask for approval** or **Accept edits**.

## Limitations

- **macOS, Apple Silicon (arm64) only** — the build target is arm64; there is no Intel or non-macOS build.
- **Unsigned build** — distributed ad-hoc signed, so first launch needs the `xattr` / right-click → Open step above.
- **Local credentials required** — a Claude and/or Codex login (or `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`) must be present on the machine.
- **Single-machine state** — review state is a local SQLite file; it does not sync across machines.
- Early, active development — storage layout and APIs may change.

## Development

Requires Node 20+. Local install/build commands are for development only; released
DMGs are produced by CI and published on GitHub Releases.

```bash
npm install
npm run dev        # live-reload app
npm test           # vitest: diff parser, ref resolution, sessions DAO, launch args, anchoring, engine contract
npm run typecheck
npm run lint
npm run package    # local package: dist/mac-arm64/Limn.app, plus DMG and zip in dist/
```

Release builds are created by pushing a `v*` tag that matches `package.json`
(`v0.1.1`, for example). The release workflow builds macOS arm64 artifacts and
attaches the DMG, zip, and blockmaps to the GitHub Release.

Useful dev env vars: `LIMN_DEMO=1` (deterministic fake engine), `LIMN_OPEN_REPO` / `LIMN_OPEN_BRANCH` (open straight to the review for a repo/branch), `LIMN_FLOW=generate|chat` (auto-run a flow / open the chat drawer), `LIMN_SHOT=/path.png` (capture the window, with `LIMN_SHOT_DELAY` / `LIMN_SHOT_QUIT`). Real-engine smoke scripts: `npx tsx scripts/smoke-claude.ts` / `smoke-codex.ts`.

**Screenshots:** `npx tsx scripts/shoot.mts` seeds a fixture repo + db and prints `{ repo, db, sessionId, reviewChat, userChat }`; launch Electron with `LIMN_DB` / `LIMN_OPEN_SESSION` + the dev hooks `LIMN_ACTIVE_CHAT=<id>` (activate a chat), `LIMN_OPEN_PICKER=1` (open the agent popover), `LIMN_OPEN_CHATLIST=1` (open the chat dropdown) to capture a specific UI state.

Architecture: see [docs/architecture.md](docs/architecture.md), with deeper dives in [docs/agent-layer.md](docs/agent-layer.md), [docs/storage-layer.md](docs/storage-layer.md), and the [Codex app-server protocol](docs/codex-app-server.md).
