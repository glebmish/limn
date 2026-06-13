# local-review

A native macOS app for **agentic review of local git branches** — before the code leaves your machine.

Pick a repo and a branch; the app shows the diff against a base branch in a guided-review UI. An AI agent — **Claude (Agent SDK) or Codex (Codex SDK), your choice per review** — explores the repository (callers, tests, history, specs) and turns the raw diff into a narrated review: logical sections, plain-language "what changed" notes, risk flags, mechanism diagrams, and a cross-check against the spec/plan the change was built from. You comment on anything — diff lines, spec lines, plan steps, section narration — chat with the agent about the code, then send your comments back: the agent applies fixes as a new iteration on the branch, and the app shows you only what changed since you approved.

Git is ground truth throughout: diffs are always parsed from `git diff`; the agent only annotates them and can never alter the code you see.

## Install

```bash
npm install
npm run package          # → dist/mac-arm64/local-review.app
```

Move `local-review.app` to `/Applications` (or run in place). The build is unsigned — on first launch, right-click → Open, or:

```bash
xattr -dr com.apple.quarantine dist/mac-arm64/local-review.app
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
3. **Compare** (GitHub-compare-style) opens preselected — compare = current branch,
   base = default base (`main` → `master` → first branch) — with the diff already
   loading. Change either side with the ref picker (branches, recent commits, or a
   typed SHA / `HEAD~N` / tag), swap sides with ⇄, and read the commit list and
   per-file diffs before any session exists.
4. Pick an engine and **Start review** — or **Resume review** if a session already
   exists for the exact (base, compare) pair (with a *Start fresh* option that
   archives the old one).
5. **Review**: mark files viewed, mark sections reviewed, comment on any diff line,
   section, agent question, or spec/plan line; **Chat** shares the agent's session.
6. **Send N changes to agent** — it edits, commits on your branch, and reports
   per-comment resolutions. **Approve** records the reviewed SHA.

### Command-line tool

Install the `lr` shim from the app menu (**local-review → Install Command-Line Tool…**).
Then, from any git repo:

```bash
lr                            # open Compare for the repo containing the cwd
lr --base main --compare wip  # preselect both sides
lr /path/to/repo              # open a specific repo
```

`lr` reuses the running app (focusing and navigating it) or launches it. Outside a git
repo, the app opens on the Dashboard with an explanatory toast.

The app **watches the branch** — when commits land from outside (e.g. a Claude Code session in a terminal), the drift banner and "since you reviewed" diffs update live, and you get a **macOS notification** when an agent run finishes while the app is in the background. Diffs are syntax-highlighted with word-level change marks.

Review state (sessions, comments, chat, approvals, pinned dirs) lives in a SQLite database in the app's userData; legacy `.local-review/*.json` files are imported once on open and left renamed `*.imported`.

## Development

```bash
npm run dev        # live-reload app
npm test           # vitest: diff parser, scanner, ref resolution, sessions DAO, CLI args, anchoring, engine contract
npm run typecheck
```

Useful dev env vars: `LR_DEMO=1` (deterministic fake engine), `LR_OPEN_REPO` / `LR_OPEN_BRANCH` (open straight to Compare for a repo/branch — these now map onto the `lr` CLI open path), `LR_FLOW=generate|fix` (auto-run a flow), `LR_SHOT=/path.png` (capture window). Real-engine smoke scripts: `npx tsx scripts/smoke-claude.ts` / `smoke-codex.ts`.

Design source: the Guided Review wireframes in `docs/superpowers/specs/` (see the design spec for architecture and decisions).
