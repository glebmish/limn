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

1. **Open a repository** (native dialog; recents are remembered).
2. **Pick branch + base** (defaults: current branch vs `main`) and an engine.
3. **Generate guided review** — watch the agent explore live; cancel anytime. Without AI you still get a full review UI grouped by directory.
4. **Review**: mark files viewed, mark sections reviewed, comment on any diff line via the hover **+**, on section narration, on agent questions, or on spec/plan lines (sidebar → *Open & comment*).
5. **Chat** (titlebar) shares the agent's session — ask "why did this change?" with full context.
6. **Send N changes to agent** — it edits, commits on your branch (`local-review: …`), and reports per-comment resolutions (✓ addressed / ↻ reworked / ✗ skipped). Sections that drifted since your approval turn amber with a *Since approved* filter.
7. **Approve** records the reviewed SHA.

Review state (comments, chat, approvals) lives in `<repo>/.local-review/` (auto-excluded from git).

## Development

```bash
npm run dev        # live-reload app
npm test           # vitest: diff parser, state, anchoring, engine contract
npm run typecheck
```

Useful dev env vars: `LR_DEMO=1` (deterministic fake engine), `LR_OPEN_REPO` / `LR_OPEN_BRANCH` (skip pickers), `LR_FLOW=generate|fix` (auto-run a flow), `LR_SHOT=/path.png` (capture window). Real-engine smoke scripts: `npx tsx scripts/smoke-claude.ts` / `smoke-codex.ts`.

Design source: the Guided Review wireframes in `docs/superpowers/specs/` (see the design spec for architecture and decisions).
