# Agent (Engine) Layer

How local-review drives an AI agent — Claude (Agent SDK) or Codex (Codex SDK) — to turn a git diff into a structured, narrated review and to apply reviewer comments back to the branch as commits.

> **Audience:** developers working on the main process. This describes the engine abstraction, the two SDK implementations, the prompt/schema contract, anchoring, and the two flows. Source lives in `src/main/engines/` and is orchestrated by `src/main/ipc.ts`.

## Guiding principle: git is ground truth

The displayed diff is **always** computed from `git diff`, never from the agent. The agent only *annotates* the diff (sections, narration, risk flags, diagrams, spec cross-check) and, in the fix flow, *edits and commits* on the branch — after which the app re-reads git. The agent can never assert what changed or alter what you see. The validation layer enforces this: any agent reference to a file not in the diff is dropped, and every file in the diff is guaranteed coverage.

## Engine abstraction

All engines implement one interface (`engines/types.ts`):

```ts
interface ReviewEngine {
  id: EngineId  // 'claude' | 'codex'
  generateReview(req: ReviewRequest): EngineRun<ReviewAnnotations>
  chat(repo, sessionId, message, anchor?): EngineRun<string>
  applyFeedback(repo, sessionId, comments, steer?, model?, reasoningEffort?): EngineRun<FixResult>
}
```

Three operations — **generate** (read-only review), **chat** (read-only Q&A), **apply** (writes + commits) — all returning the same dual-channel envelope:

```ts
interface EngineRun<T> {
  events: AsyncIterable<EngineEvent>            // live progress stream
  result: Promise<{ value: T; sessionId: string }>  // terminal validated payload
  cancel: () => void
}
```

The two channels run concurrently: `ipc.ts` pumps `events` to the renderer (IPC channel `op:event`) for live progress while awaiting `result` for the structured payload.

- **`EngineEvent`** (`shared/types.ts`) is a 5-variant union: `status`, `tool`, `text`, `done`, `error`. Each real engine normalizes its SDK's native event stream into this union via a local `toEvent()` mapper.
- **`EventQueue`** bridges push-style SDK callbacks to a pull-style `AsyncIterable`. It is **single-consumer** (one FIFO waiter queue) and **drops events pushed after `close()`**. It does not surface errors as rejections — errors travel as an `{type:'error'}` event plus a rejected `result` promise.

**Selection** — `makeEngine(id)`:

```ts
if (process.env.LR_DEMO === '1') return new FakeEngine()
return id === 'claude' ? new ClaudeEngine() : new CodexEngine()
```

A fresh engine instance is constructed per operation. `LR_DEMO=1` overrides everything.

**FakeEngine** is a deterministic engine for contract tests and demo mode — no AI, canned review, and an `applyFeedback` that really commits (appends a line, `git add -A`, commit with synthetic author env). It exercises the full generate→comment→fix→"since" cycle offline.

> ⚠️ `FakeEngine.id` is hardcoded `'claude'` regardless of the requested engine — a latent inconsistency if any code keys behavior off the reported id.

## Claude engine (`claude.ts`)

- **SDK:** `@anthropic-ai/claude-agent-sdk` — `query({ prompt, options })`, an async-iterable of `SDKMessage`. In-process SDK driving the `claude` CLI subprocess.
- **Auth:** delegated to the CLI. `authStatus` reports healthy if `ANTHROPIC_API_KEY` is set or `~/.claude` exists.
- **Tools / permissions:**
  - `generateReview`: `allowedTools: [Read, Grep, Glob, Bash]`, `permissionMode: 'default'`. (Bash is allowed even in review, for `git log` / `git show`.)
  - `chat`: same read tools, plus explicit `disallowedTools: [Edit, Write]`.
  - `applyFeedback`: read tools + `Edit, Write`, `permissionMode: 'acceptEdits'` (non-interactive auto-accept).
- **Working dir:** the user's repo (`cwd: repo`).
- **Structured output:** `outputFormat: { type: 'json_schema', schema }`; the terminal `result` message carries `structured_output` (first-class).
- **Sessions:** the Claude session id is captured from `system/init` and the terminal `result`. `chat`/`applyFeedback` pass `resume: sessionId` to continue the review's conversation.
- **Model & effort:** `modelOpt(model, effort)` sets the SDK `model` and `effort` options (`low → max`; the Codex-only `minimal` is dropped). See *Model & reasoning effort*.

## Codex engine (`codex.ts`)

- **SDK:** `@openai/codex-sdk` — `new Codex(...)`, `startThread` / `resumeThread`, `thread.runStreamed(prompt, { outputSchema, signal })` yielding `ThreadEvent`s.
- **Auth:** `OPENAI_API_KEY` or `~/.codex/auth.json`.
- **Sandbox (the permission analogue):** `sandboxMode: 'read-only'` for review/chat, `'workspace-write'` for fixes; `approvalPolicy: 'never'` throughout. `workingDirectory: repo`.
- **Sessions:** the thread id is the session id (`startThread` for generate, `resumeThread` for chat/fix).
- **Model & effort:** `modelOpts(model, reasoningEffort)` sets `model` and `modelReasoningEffort` on `ThreadOptions` (`low → xhigh`; the Claude-only `max` is dropped). See *Model & reasoning effort*.
- **Key difference from Claude:** Codex returns its result as the final `agent_message` **text**, not a structured field. The engine runs it through `parseJson()`, which tries `JSON.parse` and, on failure, strips a ```` ```json ```` fence and retries before throwing. This fence-stripping is the only robustness net for schema-constrained output occasionally arriving fenced.

## Model & reasoning effort

The agent for a review — and for each chat thread — is an `AgentRef` = `{ engine, model?, reasoningEffort? }` (`shared/types.ts`), chosen from a curated catalog (`shared/agents.ts`). `model`/`reasoningEffort` left undefined means **Auto**: let the CLI pick its default (the original behavior).

- **Catalog** (`AGENT_CATALOG`) — Claude offers `opus`/`sonnet` with reasoning effort `low → max`, and `haiku` with **no effort** (the agent SDK errors on Haiku effort). Codex offers `gpt-5.5`/`gpt-5.4`/`gpt-5.4-mini`, all `low → xhigh`. Model ids pass straight to each SDK's `model` option, so the lists are tuned here with no schema/IPC change.
- **Plumbing** — `model` and `reasoningEffort` ride on `ReviewRequest` / `ChatTurn` / `applyFeedback` and reach the SDK two ways: Claude → the agent SDK's `effort` option (via `modelOpt`, which drops the Codex-only `minimal`); Codex → `modelReasoningEffort` on `ThreadOptions` (via `modelOpts`, which drops the Claude-only `max`). The shared `ReasoningEffort` union spans both ladders (`minimal | low | medium | high | xhigh | max`); each model's `reasoningEfforts` gates which values the UI offers.
- **Selection UI** — `AgentPicker` (a single trigger opening a structured popover: engine + auth, model guidance, a segmented effort control) in the chat agent bar, plus the engine cards + model/effort controls on the Compare "Review agent" rail. The chosen `AgentRef` is persisted on the session, seeds chat 1, and each chat thread can retarget its own agent.

## Binary resolution (`binaries.ts`)

Per CLI, resolution order is:

1. **System PATH** (preferred — keeps the bundle small and tracks the user's own install). Each candidate is checked for executability and that it's a file/symlink.
2. **SDK-bundled platform binary** in `node_modules` (`@anthropic-ai/claude-agent-sdk-<platform>-<arch>/claude`; `@openai/codex-<platform>-<arch>/vendor/<rust-triple>/bin/codex`).

> ⚠️ **Packaging gotcha:** `child_process` cannot spawn an executable inside an `app.asar` archive (`ENOTDIR`). `unasar()` rewrites `app.asar/` → `app.asar.unpacked/` for bundled binaries.

> Codex's Rust triple is computed only for darwin/linux — **Windows is unhandled**. There is **no version pinning or checking** anywhere; whatever CLI is first on PATH is used and assumed SDK-compatible.

## Prompts (`prompts.ts`)

Plain-string builders. `describeAnchor()` renders each of the 7 `CommentAnchor` kinds into prose the agent can act on.

- **`buildReviewPrompt(req)`** — frames the agent as a review guide and instructs an **explore-first** pass (read changed files in full, grep callers/tests, walk `git log base..branch`, read artifacts). It supplies a pre-computed changed-files list (status, ±counts, hunk ranges, merge-base/head SHAs) and an artifact block ("the intent this change is judged against"). The output contract: group **all** files into **2–8 logical sections** (by purpose, not directory; each file in exactly one section), per-section `desc` + plain-language `what`, **risk flags** keyed to exact file + hunk range, an optional **mechanism diagram** (2–5 nodes), `title` + `summary`, a **spec/plan cross-check** (`planMap`: acceptance criteria met/partial/false, plan steps mapped to sections, deviations), and `questions` needing a human decision.
- **`buildChatPrompt(message, anchor?)`** — conversational, read-only git allowed, "Do NOT modify any files."
- **`buildFixPrompt(comments, steer?)`** — lists each comment with its id, anchor, text, and reply thread, plus an optional reviewer `steer`. Instructs: address every comment or explicitly skip with a reason; keep existing code style; run a quick typecheck/test if the repo has one; **commit on the current branch** with `"local-review: <desc>"` messages; treat answers to earlier open questions as decisions. Returns a `summary` and one **resolution per comment id** (`addressed` / `reworked` / `skipped`).

## Schema & validation

Two layers sit between the SDK and the persisted review.

**Wire schema (`schema.ts`)** — Zod schemas distinct from the internal `shared/types.ts` shapes, because of two SDK constraints:
- Claude CLI **silently drops schemas containing `prefixItems`** → no tuples. Diagram nodes travel as `{label, kind, sub}` objects and are mapped to `[label, kind, sub]` tuples after parse.
- OpenAI strict mode **requires every property in `required` and forbids records** → optionals are modeled as `.nullable()` (not `.optional()`), and per-file notes travel as an array of `{file, note}` rather than a record, reassembled afterward.

`reviewJsonSchema` / `fixJsonSchema` (derived via `z.toJSONSchema()`) are handed to the SDKs. `parseReviewOutput` / `parseFixOutput` Zod-parse the raw payload and translate wire→internal. **There are no retries** — an invalid payload throws, the engine pushes an `error` event, `result` rejects, and the IPC handler reports failure.

**Reconciliation against git (`validate.ts` → `mergeAnnotations(skeleton, parsed)`)** — the layer that enforces "git is ground truth". It:
- drops files/flags that reference files not in the diff;
- enforces each file in exactly one section (duplicates: keep first);
- drops sections left with zero valid files;
- collects any unassigned diff file into a synthetic **`Other changes`** section — guaranteeing **100% file coverage**;
- sanitizes `planMap` cross-references to existing section ids.

Returned warnings are surfaced to the UI as `status` events. Note this runs in `ipc.generate`, **not** inside the engine — engines return raw `ReviewAnnotations`; the IPC layer validates.

## Anchoring & artifacts

**Anchoring (`anchor.ts`)** keeps **comments** attached to the right lines after the branch moves — it is *not* how narration ties to the diff (that's `section.files` + `flag.hunkRange`, validated above). `reanchorComments(...)` runs on every session load. For diff/artifact anchors it searches the new skeleton for a line whose text **exactly equals** the stored `lineContent` on the correct side and picks the candidate nearest the old line number; no match → `outdated` (and a previously-outdated comment that re-matches is revived). Section/summary/file/question/plan-step anchors reference ids/paths and are left untouched.

> ⚠️ Matching is **exact-text + nearest-line**, not semantic. Comments can go `outdated` on trivial reformatting, and repeated identical lines (boilerplate) can mis-anchor.

**Artifacts (`artifacts.ts`)** are the spec/plan markdown the review is judged against — *not* agent-produced diagrams (mechanism diagrams live inside `ReviewAnnotations` as structured data). `detectArtifacts(...)` heuristically scores `.md` files (strongest signal: a `.md` already in the diff; then spec/design/plan names, conventional `docs/` or `.claude/` locations, and branch/ticket mentions in the file head) and returns the top spec and top plan. They are auto-detected and persisted on first load if the session has none.

## The two flows

### Generate (initial review) — `ipc.generate`

1. Acquire the per-repo lock (`repoLocks`); throws if another op is running for the repo.
2. Build the diff skeleton (`getDiff`), load review state + artifacts.
3. `engine.generateReview({ repo, branch, base, diff, artifacts })` — read-only.
4. Pump events; await `result`.
5. `mergeAnnotations(skeleton, value)` → validated annotations + warnings (emitted as status events).
6. Persist discovered artifact paths; `updateSessionMeta` (annotations/title/summary, `reviewed_at_sha = head`); `resetIterations` to iteration 1 recording the engine session id + end SHA.
7. Emit `op:result {kind:'review', reload:true}`; desktop-notify if the window is unfocused.

### Fix (apply comments) — `ipc.sendFeedback`

1. **Resume the engine session from the last iteration** so the fix continues the same agent conversation that produced the review (chat and fix share it).
2. Preconditions (each throws): the compare side must be a **branch** (can't push fixes to a frozen commit), the working tree must be **clean**, and the repo must currently be **on that branch**. Acquire the per-repo lock.
3. Mark the selected comments `sent` and persist (a crash leaves a recoverable trail).
4. `engine.applyFeedback(repo, sessionId, comments, steer)` — write tools / `workspace-write`. **The agent applies edits and commits on the branch itself; the app never commits.**
5. Read the new head; map `fix.resolutions` by comment id; set each sent comment `resolved` with `{verdict, note, commit}`. **If the engine omitted a resolution, that comment is reset to `queued`** so it isn't lost.
6. `addIteration` (n+1, engine, engine session id, end SHA, summary).
7. Emit `op:result {kind:'fix', reload:true}`; notify.
8. **On error, roll back any still-`sent` comments to `queued`** so nothing is stuck.

After a fix, the next `loadSession` re-diffs against git and tags the new commits as "since you reviewed" — the agent's output is never trusted for what changed.

## Invariants & sharp edges

- **Concurrency:** one agent op per repo (`repoLocks`, a `Set<string>`). The watch-mode poller skips a locked repo so the app's own commits don't trigger a spurious reload. `EventQueue` is single-consumer.
- **Cancellation:** `EngineRun.cancel` → `AbortController.abort()` (Claude `abortController`, Codex `signal`). **There is no timeout** anywhere — a wedged run hangs until the user cancels.
- **Errors:** propagate as both an `{type:'error'}` event and a rejected `result`. No retry/backoff, including on invalid structured output — one bad parse fails the whole op.
- **Session resumption assumption:** chat/fix resume the *review's* engine session id from the last iteration. If that session is gone (CLI store pruned) or the engine was switched mid-review, resume targets a missing/wrong session and there is **no fallback to a fresh session**.
- **Codex output fragility:** depends on the agent emitting valid (or fenced) JSON as its final message; Claude gets first-class `structured_output`.
