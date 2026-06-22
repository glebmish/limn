# limn

A native macOS app for **agentic review of local git branches** — before the code leaves your machine.

Pick a repo and a branch; the app shows the diff against a base branch in a guided-review UI. An AI agent — **Claude (Agent SDK) or Codex (Codex SDK), your choice per review** — explores the repository (callers, tests, history, specs) and turns the raw diff into a narrated review: logical sections, plain-language "what changed" notes, risk flags, mechanism diagrams, and a cross-check against the spec/plan the change was built from. You comment on anything — diff lines, spec lines, plan steps, section narration — chat with the agent about the code, then send your comments back: the agent applies fixes as a new iteration on the branch, and the app shows you only what changed since you approved.

Git is ground truth throughout: diffs are always parsed from `git diff`; the agent only annotates them and can never alter the code you see.

## Install

```bash
npm install
npm run package          # → dist/mac-arm64/limn.app
```

Move `limn.app` to `/Applications` (or run in place). The build is unsigned — on first launch, right-click → Open, or:

```bash
xattr -dr com.apple.quarantine dist/mac-arm64/limn.app
```

## Prerequisites

- `git` on your PATH.
- **Claude engine**: a [Claude Code](https://code.claude.com) login (run `claude` once) or `ANTHROPIC_API_KEY`.
- **Codex engine**: `codex login` (ChatGPT plan) or `OPENAI_API_KEY`.

Either engine alone is enough — the picker shows what's authenticated. Subscription logins are inherited from the CLI credentials; usage is billed to them.

## Using it

1. **Pin a directory** (📌 *Pin directory…*) — the app scans it recursively for git
   repos and shows them as a tree on the **Dashboard**; pinned dirs persist across
   launches and rescan on demand (⟳). *Open repository…* opens a one-off repo via the
   native dialog; it lands under **Recent**.
2. On the Dashboard: type to filter, ↑/↓ to move, ⏎ (or click) to open a repo.
   Each repo row shows its current branch and a dot when the working tree is dirty.
3. **Opening a repo lands directly on the review** for its current branch — the diff
   against the default base (`main` → `master` → first branch), already loaded. No
   session is minted until you act (comment, mark something viewed, generate, or
   approve); until then the header reads **Draft**.
4. Change the **base** with the ref picker (branches, recent commits, or a typed
   SHA / `HEAD~N` / tag); switch the **branch** — and where it's checked out — with the
   branch/worktree picker. Pick an engine — and optionally a model and reasoning effort
   (Claude Opus/Sonnet `low→max`, Codex GPT-5.x `low→xhigh`; *Auto* uses the CLI
   default) — then **Generate guided review**.
5. **Review**: mark files viewed, mark sections reviewed, comment on any diff line,
   section, agent question, or spec/plan line; **Chat** shares the agent's session.
   The **Session** switcher (and *All sessions…* → the repo hub) lists every saved
   review for the repo.
6. **Send N changes to agent** — it edits, commits on your branch, and reports
   per-comment resolutions. **Approve** records the reviewed SHA.

### Command-line tool

Install the `limn` shim from the app menu (**Limn → Install Command-Line Tool…**).
Then, from any git repo:

```bash
limn                            # review the current branch of the repo containing the cwd
limn --branch wip               # review a specific branch
limn --base main --branch wip   # set the base too
limn /path/to/repo              # a specific repo
limn --new                      # a fresh review (don't resume an existing one)
limn --hub                      # open the repo's session list
limn --help                     # usage
```

Bare `limn` lands on the review for the current branch — resuming the latest saved
session for it, or a fresh (unsaved) **Draft** otherwise (`--compare` is still accepted
as an alias for `--branch`). `limn` reuses the running app (focusing and navigating it) or
launches it. Outside a git repo, the app opens on the Dashboard with an explanatory toast.

The app **watches the branch** — when commits land from outside (e.g. a Claude Code session in a terminal), the drift banner and "since you reviewed" diffs update live, and you get a **macOS notification** when an agent run finishes while the app is in the background. Diffs are syntax-highlighted with word-level change marks.

Review state (sessions, comments, chat, approvals, pinned dirs) lives in a SQLite database in the app's userData.

## Development

```bash
npm run dev        # live-reload app
npm test           # vitest: diff parser, scanner, ref resolution, sessions DAO, CLI args, anchoring, engine contract
npm run typecheck
```

Useful dev env vars: `LIMN_DEMO=1` (deterministic fake engine), `LIMN_OPEN_REPO` / `LIMN_OPEN_BRANCH` (open straight to the review for a repo/branch — these map onto the `limn` CLI open path), `LIMN_FLOW=generate|fix|chat` (auto-run a flow / open the chat drawer), `LIMN_SHOT=/path.png` (capture the window, with `LIMN_SHOT_DELAY` / `LIMN_SHOT_QUIT`). Real-engine smoke scripts: `npx tsx scripts/smoke-claude.ts` / `smoke-codex.ts`.

**Screenshots:** `npx tsx scripts/shoot.mts` seeds a fixture repo + db and prints `{ repo, db, sessionId, reviewChat, userChat }`; launch Electron with `LIMN_DB` / `LIMN_OPEN_SESSION` + the dev hooks `LIMN_ACTIVE_CHAT=<id>` (activate a chat), `LIMN_OPEN_PICKER=1` (open the agent popover), `LIMN_OPEN_CHATLIST=1` (open the chat dropdown) to capture a specific UI state.

Design source: the Guided Review wireframes in `docs/superpowers/specs/` (see the design spec for architecture and decisions).
