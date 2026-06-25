# Agent (Engine) Layer

How Limn drives an AI agent — Claude (Agent SDK) or Codex (Codex SDK) — to turn a git diff into a structured, narrated review and to apply reviewer comments back to the branch as commits.

> **Audience:** developers working on the main process. This describes the engine abstraction, the two SDK implementations, the prompt/schema contract, the engine-agnostic tool layer, execution modes & approvals, anchoring, and the three flows. Source lives in `src/main/engines/` and is orchestrated by `src/main/ipc.ts`.

## Guiding principle: git is ground truth

The displayed diff is **always** computed from `git diff`, never from the agent. The agent only *annotates* the diff (sections, narration, risk flags, diagrams, spec cross-check) and, on a write-enabled batch turn, *edits and commits* on the branch using its own engine shell (git) — after which the app re-reads git. The agent can never assert what changed or alter what you see. The validation layer enforces this: any agent reference to a file not in the diff is dropped, and every file in the diff is guaranteed coverage.

## Engine abstraction

All engines implement one interface (`engines/types.ts`) — just **two methods**:

```ts
interface ReviewEngine {
  id: EngineId  // 'claude' | 'codex'
  generateReview(req: ReviewRequest): EngineRun<ReviewAnnotations>
  chat(turn: ChatTurn): EngineRun<string>  // read-only Q&A OR write batch — tools decide
}
```

Three product operations map onto these two methods — **generate** (explore the repo and produce structured annotations), **chat** (Q&A next to the diff), and **batch** (apply queued comments: edits + commits). Batch is *not* a separate method: it is `chat()` with `writeEnabled` set, which lets the engine's own shell/edit tools (Bash/Edit/Write — git via bash) act under the execution-mode gate. Limn hosts no write tool of its own; the agent edits files and commits on the branch itself. What the agent can do is decided by the engine/tool policy for the turn. All three return the same dual-channel envelope:

```ts
interface EngineRun<T> {
  events: AsyncIterable<EngineEvent>            // live progress stream
  result: Promise<{ value: T; sessionId: string }>  // terminal validated payload
  cancel: () => void
}
```

The two channels run concurrently: `ipc.ts` pumps `events` to the renderer (IPC channel `op:event`) for live progress while awaiting `result` for the terminal payload (the validated `ReviewAnnotations` for generate; the final assistant text for chat/batch).

- **`EngineEvent`** (`shared/types.ts`) is a **7-variant** union: `status`, `tool` (tool-call lifecycle), `text` (streamed assistant text), `action` (a Limn-tool side effect — focus, comment_added, comment_resolved…), `approval_request` (needs reviewer go-ahead), `done`, `error`. Each real engine normalizes its SDK's native event stream into this union via a local `toEvents()`/`toEvent()` mapper.
- **`EventQueue`** bridges push-style SDK callbacks to a pull-style `AsyncIterable`. It is **single-consumer** (one FIFO waiter queue) and **drops events pushed after `close()`**. It does not surface errors as rejections — errors travel as an `{type:'error'}` event plus a rejected `result` promise.

**`ChatTurn`** (`engines/types.ts`) is the carrier for both chat and batch. Beyond `repo`/`message`/`anchor`/`model`/`reasoningEffort` it threads the context that distinguishes the two: `engineSessionId` (resume this session, else start fresh + seed from `context`), `tools` (the per-turn `AgentToolHost`), `writeEnabled` (code-editing tools allowed this turn), `opId` (keys the approval registry), and `executionMode` (the autonomy tier).

**Selection** — `makeEngine(id)`:

```ts
if (process.env.LIMN_DEMO === '1') return new FakeEngine()
return id === 'claude' ? new ClaudeEngine() : new CodexEngine()
```

A fresh engine instance is constructed per operation. `LIMN_DEMO=1` overrides everything.

**FakeEngine** is a deterministic engine for contract tests and demo mode — no AI, canned review, and a `chat` that, on a write-enabled batch turn (`turn.tools && turn.writeEnabled`), drives the **real** tool host: it edits a file, commits via `git` through `execGit` (as the real agent does through its own shell), then calls `resolve_comment` per comment id so the actual edit/commit/resolution path runs offline. Read-only chat turns exercise the `focus` + `tour` + `suggest_mark_viewed` action pipe. It covers the full generate→comment→batch→"since" cycle without an AI.

> ⚠️ `FakeEngine.id` is hardcoded `'claude'` regardless of the requested engine — a latent inconsistency if any code keys behavior off the reported id.

## Claude engine (`claude.ts`)

- **SDK:** `@anthropic-ai/claude-agent-sdk` — `query({ prompt, options })`, an async-iterable of `SDKMessage`. In-process SDK driving the `claude` CLI subprocess.
- **Auth:** delegated to the CLI. `authStatus` reports healthy if `ANTHROPIC_API_KEY` is set or `~/.claude` exists.
- **Tools / permissions:**
  - `generateReview`: `allowedTools: [Read, Grep, Glob, Bash]`, `permissionMode: 'auto'`. (Bash is allowed even in review, for `git log` / `git show`.)
  - `chat`/batch: read-safe tools (`Read, Grep, Glob`) auto-allow; the Limn MCP tools are added to `allowedTools` (write tools only when `writeEnabled`). `permissionMode` comes from the turn's execution tier (`executionPolicy(...).claudePermissionMode`). `Bash`/`Edit`/`Write` are left out of `allowedTools` so the mode + the `canUseTool` callback gate them; read-only chat additionally sets `disallowedTools: [Edit, Write]`.
- **Approvals:** the SDK's `canUseTool` callback (`makeCanUseTool`) auto-allows Limn + read-safe tools and **parks** every other tool on a reviewer decision via `awaitDecision` (see *Execution modes & approvals*).
- **Working dir:** the user's repo (`cwd: repo`).
- **Structured output:** `outputFormat: { type: 'json_schema', schema }`; the terminal `result` message carries `structured_output` (first-class).
- **Sessions:** the Claude session id is captured from `system/init` and the terminal `result`. A resuming chat/batch turn passes `resume: engineSessionId` to continue the review's conversation; a turn with no session starts fresh (seeded prompt).
- **Model & effort:** `modelOpt(model, effort)` sets the SDK `model` and `effort` options (`low → max`; the Codex-only `minimal` is dropped). See *Model & reasoning effort*.

## Codex engine (`codex.ts`)

> The bidirectional `codex app-server` wire protocol — framing, handshake, the v2
> approval methods and their `accept`/`decline` vocabulary — has its own reference:
> [codex-app-server.md](codex-app-server.md). It is not publicly documented; that doc
> is pinned to a `generate-ts` capture of the bundled binary.

- **SDK:** generation uses `@openai/codex-sdk` — `new Codex(...)`, `startThread`, `thread.runStreamed(prompt, { outputSchema, signal })` yielding `ThreadEvent`s. Chat/batch use `codex app-server` over JSON-RPC stdio so Limn can answer approval requests.
- **Auth:** `OPENAI_API_KEY` or `~/.codex/auth.json`.
- **Sandbox (the permission analogue):** generation uses `sandboxMode: 'workspace-write'` with `approvalPolicy: 'on-request'`, matching Claude's command-capable review exploration. Chat/batch map the reviewer's execution tier through `codexAppServer.ts`: read-only for ordinary chat, workspace-write for write-enabled batch, and danger-full-access for Full access.
- **Tools:** the engine-agnostic Limn tools are reflected into a **per-turn localhost MCP server** (`registerCodexTurn`) and `codex app-server` is pointed at it via config args.
- **Interactive approvals:** chat/batch always route through the bidirectional **app-server** path (`codexAppServer.ts`), which maps the tier to Codex's approval/sandbox policy and surfaces guardian approval requests as `approval_request` events.
- **Sessions:** the thread id is the session id (`startThread` for generate / a fresh chat, `resumeThread` for a continued chat/batch).
- **Model & effort:** `modelOpts(model, reasoningEffort)` sets `model` and `modelReasoningEffort` on `ThreadOptions` (`low → xhigh`; the Claude-only `max` is dropped). See *Model & reasoning effort*.
- **Key difference from Claude:** Codex returns its review result as the final `agent_message` **text**, not a structured field. The engine runs it through `parseJson()`, which tries `JSON.parse` and, on failure, strips a ```` ```json ```` fence and retries before throwing. This fence-stripping is the only robustness net for schema-constrained output occasionally arriving fenced.

## Model & reasoning effort

The agent for a review — and for each chat thread — is an `AgentRef` = `{ engine, model?, reasoningEffort? }` (`shared/types.ts`), chosen from a curated catalog (`shared/agents.ts`). `model`/`reasoningEffort` left undefined means **Auto**: let the CLI pick its default (the original behavior).

- **Catalog** (`AGENT_CATALOG`) — Claude offers `opus`/`sonnet` with reasoning effort `low → max`, and `haiku` with **no effort** (the agent SDK errors on Haiku effort). Codex offers `gpt-5.5`/`gpt-5.4`/`gpt-5.4-mini`, all `low → xhigh`. Model ids pass straight to each SDK's `model` option, so the lists are tuned here with no schema/IPC change.
- **Plumbing** — `model` and `reasoningEffort` ride on `ReviewRequest` / `ChatTurn` (the chat/batch carrier) and reach the SDK two ways: Claude → the agent SDK's `effort` option (via `modelOpt`, which drops the Codex-only `minimal`); Codex → `modelReasoningEffort` on `ThreadOptions` (via `modelOpts`, which drops the Claude-only `max`). The shared `ReasoningEffort` union spans both ladders (`minimal | low | medium | high | xhigh | max`); each model's `reasoningEfforts` gates which values the UI offers.
- **Selection UI** — `AgentPicker` (a single trigger opening a structured popover: engine + auth, model guidance, a segmented effort control) in the chat agent bar, plus the engine cards + model/effort controls on the Compare "Review agent" rail. The chosen `AgentRef` is persisted on the session, seeds chat 1, and each chat thread can retarget its own agent.

## Binary resolution (`binaries.ts`)

Each CLI is resolved from the user's **system PATH** only (`claude` / `codex`) — each candidate is checked for executability and that it's a file/symlink. Nothing is bundled: the SDKs' platform binaries are excluded from the app package (`electron-builder.yml`), so the user supplies and updates the CLIs via their own installs.

> There is **no version pinning or checking** anywhere; whatever CLI is first on PATH is used and assumed SDK-compatible.

## Prompts (`prompts.ts`)

Plain-string builders. `describeAnchor()` renders each of the 7 `CommentAnchor` kinds into prose the agent can act on. Four builders cover every turn:

- **`buildReviewPrompt(req)`** — frames the agent as a review guide and instructs an **explore-first** pass (read changed files in full, grep callers/tests, walk `git log base..branch`, read artifacts). It supplies a pre-computed changed-files list (status, ±counts, hunk ranges, merge-base/head SHAs) and an artifact block ("the intent this change is judged against"). The output contract: group **all** files into **2–8 logical sections** (by purpose, not directory; each file in exactly one section), per-section `desc` + plain-language `what`, **risk flags** keyed to exact file + hunk range, an optional **mechanism diagram** (2–5 nodes), `title` + `summary`, a **spec/plan cross-check** (`planMap`: acceptance criteria met/partial/false, plan steps mapped to sections, deviations), and `questions` needing a human decision.
- **`buildChatPrompt(message, anchor?)`** — the thin conversational wrapper for a **resuming** read-only chat: the message, optional anchor prose, "Do NOT modify any files."
- **`buildSeededChatPrompt(ctx, message, anchor?)`** — for a **fresh** chat whose agent did *not* produce the review (so there is no engine session to resume). Re-orients the new agent from scratch: branch/base, the review summary so far, full read access, "Do NOT modify any files."
- **`buildBatchPrompt(comments, steer?, context?)`** — the unified apply turn. Lists each queued comment with its **stable id**, anchor, text, and reply thread, plus an optional reviewer `steer`. Instructs the agent to address each comment by editing the code (or `reply_to_comment` when no change is needed); to **commit its edits itself with git through its own shell** — "stage exactly the files you changed and commit with a short message (`limn: …`)"; and to record each outcome with `resolve_comment` (its `commentId` plus a verdict — `addressed` / `reworked` / `skipped` — and a note), whether or not a code change was needed. It also says to keep existing code style, treat answers to earlier open questions as decisions, and finish with a 2–3 sentence summary. `context` seeds the review framing when the thread has no engine session to resume.

## Schema & validation

Two layers sit between the SDK and the persisted review. Only the **generate** output is schema-constrained — chat/batch return free text plus tool-driven side effects.

**Wire schema (`schema.ts`)** — Zod schemas distinct from the internal `shared/types.ts` shapes, because of two SDK constraints:
- Claude CLI **silently drops schemas containing `prefixItems`** → no tuples. Diagram nodes travel as `{label, kind, sub}` objects and are mapped to `[label, kind, sub]` tuples after parse.
- OpenAI strict mode **requires every property in `required` and forbids records** → optionals are modeled as `.nullable()` (not `.optional()`), and per-file notes travel as an array of `{file, note}` rather than a record, reassembled afterward.

`reviewJsonSchema` (derived via `z.toJSONSchema()`) is handed to the SDKs. `parseReviewOutput` Zod-parses the raw payload and translates wire→internal (object→tuple, array→record, `null`→`undefined`). **There are no retries** — an invalid payload throws, the engine pushes an `error` event, `result` rejects, and the IPC handler reports failure.

**Reconciliation against git (`validate.ts` → `mergeAnnotations(skeleton, parsed)`)** — the layer that enforces "git is ground truth". It:
- drops files/flags that reference files not in the diff;
- enforces each file in exactly one section (duplicates: keep first);
- drops sections left with zero valid files;
- collects any unassigned diff file into a synthetic **`Other changes`** section — guaranteeing **100% file coverage**;
- sanitizes `planMap` cross-references to existing section ids.

Returned warnings are surfaced to the UI as `status` events. Note this runs in `ipc.generate`, **not** inside the engine — engines return raw `ReviewAnnotations`; the IPC layer validates.

## The tool layer (`tools.ts`)

Beyond reading the repo (Read/Grep/Glob/Bash), the agent acts on the review through one **engine-agnostic** tool set defined once and hosted two ways. A `ToolDef` is `{ name, description, input: z.ZodRawShape }`; a handler runs in the Electron **main** process — it may touch the DB/git, emit a live `action` event, and returns the text the model sees. These are all read/annotate tools: **Limn hosts no write tool**. Code edits and commits go through the engine's *own* shell/edit tools (Bash/Edit/Write — git via bash), gated by the execution mode, not through a Limn tool.

| Tool | Effect |
| --- | --- |
| `focus` | scroll + highlight a spot; leaves a clickable chip |
| `tour` | create an interactive multi-stop walkthrough across files, sections, summary, or diff lines |
| `suggest_mark_viewed` | propose marking files/sections viewed (reviewer confirms) |
| `list_comments` / `get_review` | read current DB state (ids, anchors, narration) |
| `add_comment` / `reply_to_comment` | author an agent comment / reply, anchored to diff/file/section/summary |
| `resolve_comment` | resolve a comment (by id) with verdict + note |
| `edit_review` | amend title / summary / a section's `what`/`desc` in place |

- **Hosting:** Claude consumes the Zod `input` shape directly via the in-process MCP server (`createSdkMcpServer` + `tool(...)`); Codex app-server connects to a per-turn localhost MCP server that reflects the same shapes into JSON Schema. Both expose the tools to the model as `mcp__limn__<name>`.
- **The write path is the engine's own:** since Limn has no write tool, `limnAllowedToolNames()` always returns the same set; the *code-editing* capability is the engine's Bash/Edit/Write tools, gated by the turn's `writeEnabled` + execution mode (see *Execution modes & approvals*). A non-write turn degrades to review/comment-only.
- **Call path:** `createToolHost(ctx).call(name, args)` validates args against the Zod shape at the boundary, runs the handler, and — if it produced an `AgentAction` — emits it live (`type:'action'`) *and* collects it for persistence on the chat message (so chips rebuild on reload). A handler throw becomes `{isError:true}` text, not a crash.
- **The comment id is the join key** that survives the whole batch round-trip: prompt → the agent's `resolve_comment` / `reply_to_comment` call → the DB row's `resolution`.

## Execution modes & approvals

One product vocabulary — a 4-rung autonomy ladder the reviewer picks per chat (`ExecutionMode` = `ask | edits | auto | full`, persisted on the thread, default `ask`) — maps to each engine's native knobs via `executionPolicy(mode)` (`shared/executionMode.ts`):

| Tier | Reviewer sees | Claude `permissionMode` | Codex `approvalPolicy` / `sandbox` |
| --- | --- | --- | --- |
| `ask` | Ask for approval | `default` | `on-request` / `read-only` |
| `edits` | Accept edits | `acceptEdits` | `on-request` / `workspace-write` |
| `auto` | Auto mode | `auto` | `on-failure` / `workspace-write` |
| `full` | Full access | `bypassPermissions` | `never` / `danger-full-access` |

**Approval registry (`approvals.ts`)** — engine-agnostic. When a tier requires a go-ahead, the adapter parks on `awaitDecision(opId, request, emit)`: it emits an `approval_request` event (the renderer shows a blocking card) and returns a promise that settles when the reviewer answers. The answer flows back through the `respondApproval` IPC → `resolveDecision(opId, requestId, decision)`, unblocking the parked promise. `clearPending(opId)` auto-denies everything still parked on cancel / turn end (no leak). The raw tool call is normalized into an engine-agnostic `ApprovalRequest` (`toApprovalRequest` on Claude; `approvalRequestFromParams` on the Codex app-server) so one card renders for either engine. **There is no timeout** — a request waits until answered or cancelled.

## Anchoring & artifacts

**Anchoring (`anchor.ts`)** keeps **comments** attached to the right lines after the branch moves — it is *not* how narration ties to the diff (that's `section.files` + `flag.hunkRange`, validated above). `reanchorComments(...)` runs on every session load. For diff/artifact anchors it searches the new skeleton for a line whose text **exactly equals** the stored `lineContent` on the correct side and picks the candidate nearest the old line number; no match → `outdated` (and a previously-outdated comment that re-matches is revived). Section/summary/file/question/plan-step anchors reference ids/paths and are left untouched.

> ⚠️ Matching is **exact-text + nearest-line**, not semantic. Comments can go `outdated` on trivial reformatting, and repeated identical lines (boilerplate) can mis-anchor.

**Artifacts (`artifacts.ts`)** are the spec/plan markdown the review is judged against — *not* agent-produced diagrams (mechanism diagrams live inside `ReviewAnnotations` as structured data). `detectArtifacts(...)` heuristically scores `.md` files (strongest signal: a `.md` already in the diff; then spec/design/plan names, conventional `docs/` or `.claude/` locations, and branch/ticket mentions in the file head) and returns the top spec and top plan. They are auto-detected and persisted on first load if the session has none.

## The three flows

### Generate (initial review) — `ipc.generate`

1. Acquire the per-repo lock (`repoLocks`); throws if another op is running for the repo.
2. Build the diff skeleton (`getDiff`), load review state + artifacts.
3. `engine.generateReview({ repo, branch, base, diff, artifacts })`.
4. Pump events; await `result`.
5. `mergeAnnotations(skeleton, value)` → validated annotations + warnings (emitted as status events).
6. Persist discovered artifact paths; `updateSessionMeta` (annotations/title/summary, `reviewed_at_sha = head`); `resetIterations` to iteration 1 recording the engine session id + end SHA.
7. Emit `op:result {kind:'review', reload:true}`; desktop-notify if the window is unfocused.

### Chat (read-only Q&A) — `ipc.sendChat`

1. Acquire the per-repo lock. Build a read-only `createToolHost` (`writeEnabled:false`) bound to `{db, sessionId, threadId, opId, repo, agent, emit}`.
2. `engine.chat({ engineSessionId, message, anchor, tools, opId, executionMode, context })` — **resume** the thread's engine session if it has one, else **seed** a fresh session from `context` (branch/base/summary).
3. Pump `text` + `tool` + `action` + `approval_request` events; await the final assistant text.
4. Persist the agent message with its collected actions & settled tool calls. Emit `op:result {kind:'chat'}`. Finally: release lock, `clearPending(opId)`.

### Batch (apply comments) — `ipc.sendBatch`

Batch is **chat with write tools** — it returns ordinary chat text plus tool side effects, not a separate structured fix result.

1. Acquire the per-repo lock. Compute `writeEnabled` from the batch preconditions: the compare side is a **branch** (can't push to a frozen commit), the working tree (the primary repo or its linked worktree) is **clean**, and that worktree is **on that branch**. **When unmet, the turn runs write-disabled (review/comment-only) instead of failing.**
2. Mark the selected comments `sent` and persist (a crash leaves a recoverable trail).
3. Build the tool host (now `writeEnabled`, carrying `engineSessionId` for the commit's iteration) and `buildBatchPrompt(comments, steer, context?)` — `context` only when there's no session to resume.
4. `engine.chat({ engineSessionId, message: <batch prompt>, tools, writeEnabled, executionMode, … })`. The agent edits files and **commits on the branch using its own engine shell** (running `git add`/`git commit`), and calls `resolve_comment`/`reply_to_comment` per comment id. **The agent commits via git in its shell — the app never commits.**
5. Reconcile: reload state; **any comment still `sent` (un-addressed) rolls back to `queued`** so it isn't lost. (Resolutions were already written by the `resolve_comment` handler; the commit landed in git directly.)
6. Emit `op:result {kind:'chat', reload:true}`; notify. Finally: release lock, `clearPending(opId)`.

After a batch, the next `loadSession` re-diffs against git and tags the new commits as "since you reviewed" — the agent's output is never trusted for what changed.

## Invariants & sharp edges

- **Concurrency:** one agent op per repo (`repoLocks`, a `Set<string>`). The watch-mode poller skips a locked repo so the app's own commits don't trigger a spurious reload. `EventQueue` is single-consumer.
- **Cancellation:** `EngineRun.cancel` → `AbortController.abort()` (Claude `abortController`, Codex `signal`). **There is no timeout** anywhere — a wedged run, or a parked approval, hangs until the user cancels.
- **Errors:** propagate as both an `{type:'error'}` event and a rejected `result`. No retry/backoff, including on invalid structured output — one bad parse fails the whole op.
- **Session resumption assumption:** a chat/batch turn whose thread *has* an `engineSessionId` resumes it (the review's session, from the last iteration). If that session is gone (CLI store pruned) the resume targets a missing session with **no fallback to a fresh session**. A thread that never produced the review has no id and is seeded fresh by design.
- **Write degradation, not failure:** an un-met batch precondition (dirty tree, wrong branch, fixed-commit compare) silently withholds the write tools rather than erroring — the agent answers/comments instead of editing.
- **Codex output fragility:** the review payload rides the final `agent_message` text (valid or fenced JSON); Claude gets first-class `structured_output`.
