# Architecture

A system-level map of how Limn is put together. For the two heaviest subsystems
see [agent-layer.md](agent-layer.md) (the AI engines) and
[storage-layer.md](storage-layer.md) (persistence); this doc ties them together
and covers the cross-process topology and event model that neither owns.

## Overview

Limn is an Electron macOS app (electron-vite) with the standard three-process
split. It turns `git diff` into an AI-guided review: git is ground truth and the
agent only annotates — it never alters the code you see. Review state (sessions,
comments, viewed/reviewed flags, chat) lives in one SQLite file; diff content is
always read live from git, never cached as truth.

## Processes and layers

- **`src/shared/`** — process-agnostic contracts, no runtime dependency on main
  or renderer. Domain types (`types.ts`: the git skeleton, `ReviewAnnotations`,
  `Comment`/`CommentAnchor`, the `EngineEvent` union), the IPC surface (`ipc.ts`:
  the `Api` interface and the `API_CHANNELS` list), the agent catalog
  (`agents.ts`), and the execution-mode ladder (`executionMode.ts`).
- **`src/main/`** — the Node side. `index.ts` boots the app and opens the single
  DB handle; `ipc.ts` is the orchestrator (it owns the IPC handlers, per-repo
  locking, and the three flows below); `git.ts`/`exec.ts` are the git
  ground-truth layer; `review.ts` assembles diff skeletons and "since" marking;
  `db/` persists the review layer; `engines/` drives the AI.
- **`src/preload/index.ts`** — a thin `contextBridge`. It mirrors `API_CHANNELS`
  onto `ipcRenderer.invoke` and relays the two event streams to the renderer. It
  exposes no arbitrary-channel escape hatch.
- **`src/renderer/`** — React 19 with a single Zustand store (`store.ts`) that
  owns screen routing (Dashboard, RepoHub, Review) and the op lifecycle.

The dependency graph runs one way: renderer → (preload bridge) → `ipc.ts` →
`{git, db, engines}`, with `engines` also reaching `db` and `git`.

## Data flow: generating a review

A single user action — "Generate guided review" — traces through every layer:

1. The Review screen calls `api.generate(...)`; the preload bridge forwards it as
   an IPC `invoke`.
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
`approval_request` events and are answered back over a dedicated IPC call; see
[agent-layer.md](agent-layer.md) for the approval registry.

## External dependencies

- **`git`** (subprocess) — the source of truth for all diff, ref, and worktree
  state. Invoked via `execFile` (never a shell) with `core.quotePath=false`.
- **Claude Agent SDK / OpenAI Codex SDK** — drive the `claude` / `codex` CLIs.
  Authentication and billing inherit from the CLI logins; Limn never stores keys.
- **`node:sqlite`** — the bundled SQLite binding; no third-party driver.
