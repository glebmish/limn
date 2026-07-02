# Agent (Engine) Layer

How Limn drives an AI agent — Claude and Codex, both through the **Agent Client Protocol (ACP)** — to turn a git diff into a structured, narrated review and to apply reviewer comments back to the branch as commits.

> **Audience:** developers working on the main process. This describes the engine abstraction, the single ACP engine + its per-engine adapter configs, the prompt/schema contract, the engine-agnostic tool layer, execution modes & approvals, anchoring, and the three flows. Source lives mainly in `src/main/engines/` (with anchoring in `src/main/anchor.ts` and artifact detection in `src/main/artifacts.ts`) and is orchestrated by `src/main/ipc.ts`.

> **One protocol, two adapters.** Both engines are driven by one `AcpEngine` (`acp.ts`) speaking ACP over stdio to a per-engine **adapter** — a pinned npm package (`@agentclientprotocol/claude-agent-acp`, `@agentclientprotocol/codex-acp`) that translates ACP into each engine's native CLI. Per-engine code is a small `AcpEngineConfig` record (`adapters.ts`): the mode-id mapping, per-turn spawn env, effort config-options, and which native-binary env var to feed. The adapter version *is* the pinned engine version — see [acp-adapters.md](acp-adapters.md).

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

- **`EngineEvent`** (`shared/types.ts`) is a **7-variant** union: `status`, `tool` (tool-call lifecycle), `text` (streamed assistant text), `action` (a Limn-tool side effect — focus, comment_added, comment_resolved…), `approval_request` (needs reviewer go-ahead), `done`, `error`. Each real engine normalizes its native event stream into this union.
- **`EventQueue`** bridges push-style SDK callbacks to a pull-style `AsyncIterable`. It is **single-consumer** (one FIFO waiter queue) and **drops events pushed after `close()`**. It does not surface errors as rejections — errors travel as an `{type:'error'}` event plus a rejected `result` promise.

**`ChatTurn`** (`engines/types.ts`) is the carrier for both chat and batch. Beyond `repo`/`message`/`anchor`/`model`/`reasoningEffort` it threads the context that distinguishes the two: `engineSessionId` (resume this session, else start fresh + seed from `context`), `tools` (the per-turn `AgentToolHost`), `writeEnabled` (code-editing tools allowed this turn), `opId` (keys the approval registry), and `executionMode` (the autonomy tier).

**Selection** — `makeEngine(id)`:

```ts
if (process.env.LIMN_DEMO === '1') return new FakeEngine(id)
return id === 'claude' ? new AcpEngine(CLAUDE_ACP_CONFIG) : new AcpEngine(CODEX_ACP_CONFIG)
```

A fresh engine instance is constructed per operation — the same `AcpEngine` class, differing only by its config record. `LIMN_DEMO=1` overrides everything.

**FakeEngine** is a deterministic engine for contract tests and demo mode — no AI, canned review, and a `chat` that, on a write-enabled batch turn (`turn.tools && turn.writeEnabled`), drives the **real** tool host: it edits a file, commits via `git` through `execGit` (as the real agent does through its own shell), then calls `resolve_comment` per comment id so the actual edit/commit/resolution path runs offline. Read-only chat turns exercise the `focus` + `tour` + `suggest_mark_viewed` action pipe. It covers the full generate→comment→batch→"since" cycle without an AI. `FakeEngine` carries the requested engine id (`new FakeEngine(id)`), so demo mode reports the engine the caller asked for.

## ACP engine (`acp.ts`)

One `AcpEngine implements ReviewEngine` drives both engines; the only per-engine data is the `AcpEngineConfig` record (`adapters.ts`) selected by `makeEngine`. `generateReview` and `chat` both funnel into one `runAcpTurn`, which owns the whole turn lifecycle:

1. **MCP host** — for tool-enabled turns, `registerTurn(host)` opens the per-turn localhost MCP server and yields its `{url, release}` (see *The tool layer*); the url is passed as an ACP `mcpServers: [{type:'http', name:'limn', …}]` entry.
2. **Preflight + spawn** — when the config marks the native binary **required** (Codex), an unresolved binary fails fast with the `engineBinaryStatus` hint (see *Binary resolution*). Otherwise the adapter is spawned via Electron's own Node (`process.execPath` + `ELECTRON_RUN_AS_NODE`), **one process per turn**, in its own process group so cancel kills the tree. Per-turn spawn env layers on `binaryEnv()` (the native-binary path) and `env(turn)` (e.g. `ANTHROPIC_MODEL`).
3. **`initialize`** — declines all client capabilities (`fs.readTextFile/writeTextFile: false`, `terminal: false`) so the agent uses its own tools against the worktree, as before. The negotiated protocol version must be `1` — anything else throws an actionable "update Limn" error (spec OQ10).
4. **Session** — resume via `session/load(engineSessionId)` when the adapter advertises `loadSession`, else `session/new` and treat the turn as seeded. **Replay is suppressed:** every `session/update` before the load response resolves is dropped — that history already lives in Limn's DB.
5. **`session/set_mode`** — the tier's ACP mode id (`config.modeFor(mode, writeEnabled)`); a method-not-found is swallowed (forward-compat with modes' announced move to config options).
6. **`session/prompt`** — the built prompt as one text block; `session/update` notifications stream through `acpToEvents` (`acpEvents.ts`) into the `EventQueue`, and `session/request_permission` requests route through `ladderPolicy` (see *Execution modes & approvals*).
7. **Terminal** — `end_turn` resolves `{value, sessionId}`; `cancelled` settles quietly; `refusal`/`max_*` error. `finally` closes the queue, kills the process group, and `release()`s the MCP turn.

- **Auth** is unchanged and per-engine: `authStatus` reports healthy for Claude if `ANTHROPIC_API_KEY` is set or `~/.claude` exists, for Codex if `OPENAI_API_KEY` or `~/.codex/auth.json` exists. The adapters read those same credential locations.
- **Sessions** — `engineSessionId` **is** the ACP `sessionId`; no schema change. New session → `session/new` returns it → persisted where the SDK session id / thread id was persisted before. Pre-migration ids (Claude JSONL ids, Codex thread ids) are keyed the same way by the adapters, so they load; on any load failure the turn degrades to a seeded fresh session — history and review context are never lost.
- **Event mapping (`acpEvents.ts`)** — one pure `acpToEvents(update): EngineEvent[]` mapper (unit-tested per row) folds ACP `agent_message_chunk` / `agent_thought_chunk` / `plan` / `tool_call` / `tool_call_update` into the same `EngineEvent` union both engines already produced. Sparse `tool_call_update`s fold by `toolCallId`; `current_mode_update` / `available_commands_update` / `usage_update` / `config_option_update` are ignored.
- **Model & effort** are per-turn config, not turn params — see *Model & reasoning effort*.
- **Structured output** has no ACP channel, so `generateReview` uses schema-in-prompt + a repair turn — see *Schema & validation*.

## Model & reasoning effort

The agent for a review — and for each chat thread — is an `AgentRef` = `{ engine, model?, reasoningEffort? }` (`shared/types.ts`), chosen from a curated catalog (`shared/agents.ts`). `model`/`reasoningEffort` left undefined means **Auto**: let the CLI pick its default (the original behavior).

- **Catalog** (`AGENT_CATALOG`) — Claude offers `opus`/`sonnet` with reasoning effort `low → max`, and `haiku` with **no effort**. Codex offers `gpt-5.5`/`gpt-5.4`/`gpt-5.4-mini`, all `low → xhigh`. Model ids pass straight through, so the lists are tuned here with no schema/IPC change.
- **Plumbing** — `model` and `reasoningEffort` ride on `ReviewRequest` / `ChatTurn` (the chat/batch carrier) and reach each adapter through the `AcpEngineConfig` (`adapters.ts`), which is where the two engines' quirks live:
  - **Claude** — model via the **`ANTHROPIC_MODEL` spawn env** (`config.env`; one process per turn makes it exact); effort via a post-session `setSessionConfigOption({configId:'effort'})` (`config.configOptions`). `claudeEffort` clamps the Codex-only `minimal` up to `low`.
  - **Codex** — no model env var: **both** model and effort go through `setSessionConfigOption` (`configId` `model` / `reasoning_effort`). `codexEffort` clamps `minimal → low` and the Claude-only `max → xhigh`.
  - Config-option passthrough is advisory — the adapter swallows unknown/unsupported ids. The shared `ReasoningEffort` union spans both ladders (`minimal | low | medium | high | xhigh | max`); each model's `reasoningEfforts` gates which values the UI offers.
- **Selection UI** — `AgentPicker` (a single trigger opening a structured popover: engine + auth, model guidance, a segmented effort control) in the chat agent bar, plus the engine cards + model/effort controls on the Compare "Review agent" rail. The chosen `AgentRef` is persisted on the session, seeds chat 1, and each chat thread can retarget its own agent.

## Binary resolution (`binaries.ts`)

Two kinds of artifact, resolved differently:

- **The ACP adapters + their JS SDK glue are bundled** in the app (pinned npm packages, `asarUnpack`'d so the spawned Node children can load them). The adapter version is the pinned engine-protocol version.
- **The native CLIs are NOT bundled.** Each of `claude` / `codex` is resolved from the user's **system PATH** (checked for executability + that it's a file/symlink), with a Settings absolute-path override that wins even when broken (so a stale path surfaces as an error, not a silent swap). `binaries.ts` feeds the resolved path to the adapter via the env var it reads — `CLAUDE_CODE_EXECUTABLE` for claude-agent-acp, `CODEX_PATH` for codex-acp (`AcpEngineConfig.binaryEnv`, spec OQ7). The multi-hundred-MB platform binaries the SDKs would otherwise bundle are excluded from the package (`electron-builder.yml`).

> **Codex hard-requires its binary.** claude-agent-acp can self-discover `claude`, but codex-acp's only fallback is the *bundled* `@openai/codex` binary — which packaging strips — so a missing `codex` must be caught before spawn. `CODEX_ACP_CONFIG.binaryRequired` + the `runAcpTurn` preflight turn that into the actionable `engineBinaryStatus` hint instead of a raw `MODULE_NOT_FOUND`.

> **Version reporting, not gating** — `probeEngineVersion` best-effort-reads `<cli> --version` and warns below a known-good floor (Codex only), but never blocks. The *protocol* version, by contrast, is hard-pinned: `initialize` must negotiate `1`. Deliberate engine upgrades are adapter-version bumps — see [acp-adapters.md](acp-adapters.md).

## Prompts (`prompts.ts`)

Plain-string builders. `describeAnchor()` renders each of the 11 `CommentAnchor` kinds (`shared/types.ts`) into prose the agent can act on. Four builders cover every turn:

- **`buildReviewPrompt(req)`** — frames the agent as a review guide and instructs an **explore-first** pass (read changed files in full, grep callers/tests, walk `git log base..branch`, read artifacts). It supplies a pre-computed changed-files list (status, ±counts, hunk ranges, merge-base/head SHAs) and an artifact block ("the intent this change is judged against"). The output contract: group **all** files into **2–8 logical sections** (by purpose, not directory; each file in exactly one section), per-section `desc` + plain-language `what`, **risk flags** keyed to exact file + hunk range, an optional **mechanism diagram** (2–5 nodes), `title` + `summary`, a **spec/plan cross-check** (`planMap`: acceptance criteria met/partial/false, plan steps mapped to sections, deviations), and `questions` needing a human decision.
- **`buildChatPrompt(message, anchor?)`** — the thin conversational wrapper for a **resuming** read-only chat: the message, optional anchor prose, "Do NOT modify any files."
- **`buildSeededChatPrompt(ctx, message, anchor?)`** — for a **fresh** chat whose agent did *not* produce the review (so there is no engine session to resume). Re-orients the new agent from scratch: branch/base, the review summary so far, full read access, "Do NOT modify any files."
- **`buildBatchPrompt(comments, steer?, context?)`** — the unified apply turn. Lists each queued comment with its **stable id**, anchor, text, and reply thread, plus an optional reviewer `steer`. Instructs the agent to address each comment by editing the code (or `reply_to_comment` when no change is needed); to **commit its edits itself with git through its own shell** — "stage exactly the files you changed and commit with a short message (`limn: …`)"; and to record each outcome with `resolve_comment` (its `commentId` plus a verdict — `addressed` / `reworked` / `skipped` — and a note), whether or not a code change was needed. It also says to keep existing code style, treat answers to earlier open questions as decisions, and finish with a 2–3 sentence summary. `context` seeds the review framing when the thread has no engine session to resume.

## Schema & validation

Two layers sit between the SDK and the persisted review. Only the **generate** output is schema-constrained — chat/batch return free text plus tool-driven side effects.

**Wire schema (`schema.ts`)** — Zod schemas distinct from the internal `shared/types.ts` shapes, because of two engine constraints (still valid now that the schema is prompt-embedded rather than passed as an output-format param):
- Some CLIs **silently drop schemas containing `prefixItems`** → no tuples. Diagram nodes travel as `{label, kind, sub}` objects and are mapped to `[label, kind, sub]` tuples after parse.
- OpenAI strict mode **requires every property in `required` and forbids records** → optionals are modeled as `.nullable()` (not `.optional()`), and per-file notes travel as an array of `{file, note}` rather than a record, reassembled afterward.

**Schema-in-prompt + one repair turn (`structured.ts`).** ACP exposes no output-schema channel, so `generateReview` converges on one strategy for both engines: `buildReviewPrompt` appends a `structuredEpilogue(reviewJsonSchema)` ("respond with a single JSON object only, no fences, no prose"); streamed text is suppressed and collected; `parseJson` extracts it (direct `JSON.parse` → strip a ```` ```json ```` fence → balanced-brace slice); `parseReviewOutput` Zod-parses and translates wire→internal (object→tuple, array→record, `null`→`undefined`). On extraction/validation failure there is **one** automatic repair turn — a follow-up `session/prompt` on the same session quoting the Zod issues and asking for corrected JSON — then re-parse. A second failure fails the op (error event + rejected `result`; the ZodError → friendly-message path in `ipc.ts` still applies). This replaces the Claude SDK's native `outputFormat` enforcement and Codex's app-server `outputSchema`; the same `parseJson` net now serves both.

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

- **Hosting is now one path:** `mcpHost.ts` (generalized from the old Codex-only `codexMcp.ts`) runs **one** per-turn localhost streamable-HTTP MCP server reflecting the Zod `input` shapes into JSON Schema, passed to every adapter via the ACP `mcpServers` param. Claude's old in-process `createSdkMcpServer` path is gone — the dual-hosting duplication collapsed to this single host. Both engines see the tools as `mcp__limn__<name>` (or `limn__<name>`, adapter-dependent). Hardening (unguessable UUID path token, DNS-rebinding protection, loopback-only) carries over unchanged.
- **The write path is the engine's own:** since Limn has no write tool, the *code-editing* capability is the engine's Bash/Edit/Write tools, gated by the turn's `writeEnabled` + execution mode (see *Execution modes & approvals*). A non-write turn degrades to review/comment-only.
- **Limn tools auto-allow at the permission layer:** ACP has no tool-allowlist knob, so limn-tool permission requests are auto-allowed by `ladderPolicy` (row 1: `isLimnTool` → `allow`) — the same effect as the old per-engine auto-accept, minus the fragile Codex elicitation-auto-accept workaround, which disappeared with the code that needed it.
- **Call path:** `createToolHost(ctx).call(name, args)` validates args against the Zod shape at the boundary, runs the handler, and — if it produced an `AgentAction` — emits it live (`type:'action'`) *and* collects it for persistence on the chat message (so chips rebuild on reload). A handler throw becomes `{isError:true}` text, not a crash.
- **The comment id is the join key** that survives the whole batch round-trip: prompt → the agent's `resolve_comment` / `reply_to_comment` call → the DB row's `resolution`.

## Execution modes & approvals

One product vocabulary — a 4-rung autonomy ladder the reviewer picks per chat (`ExecutionMode` = `ask | edits | auto | full`, persisted on the thread, default `ask`) — is enforced in **two deliberate layers**, so the tiers finally mean the *same thing on both engines* (the old `auto`-tier divergence — Claude's `permissionMode:auto` vs Codex's `on-failure` — was a product bug this migration fixes).

**(a) Baseline engine mode** — set once per session via `session/set_mode` (`AcpEngineConfig.modeFor`), chosen so the engine is permissive enough to allow anything Limn might allow, yet restrictive enough that anything Limn might gate produces a `session/request_permission` rather than executing silently:

| Tier | Reviewer sees | claude-agent-acp mode | codex-acp mode |
| --- | --- | --- | --- |
| `ask` | Ask for approval | `default` | `read-only` |
| `edits` | Accept edits | `acceptEdits` | `agent` |
| `auto` | Auto mode | `acceptEdits` | `agent` |
| `full` | Full access | `bypassPermissions` | `agent-full-access` |
| read-only chat (`writeEnabled` false) | — | `default` + client-side deny | `read-only` |

**(b) One shared decision function** — `ladderPolicy(mode, req, writeEnabled)` (`shared/approvalPolicy.ts`, pure, unit-tested) runs on **every** incoming `session/request_permission`, identical for both engines. The ACP payload is normalized to Limn's `ApprovalRequest` (`acpPermissionToRequest`: `execute` → `command`, `edit|delete|move`/diff → `file_change`, else `tool_use`), then the tier × kind table decides:

| Tier | limn MCP tools | `file_change` | `command` (safe) | `command` (unsafe) | other `tool_use` |
| --- | --- | --- | --- | --- | --- |
| `ask` | allow | ask | ask | ask | ask |
| `edits` | allow | allow | ask | ask | ask |
| `auto` | allow | allow | **allow** | **ask** | ask |
| `full` | allow | allow | allow | allow | allow |

- *Safe command* is defined by one Limn-owned conservative classifier (`isSafeCommand` + `SAFE_COMMAND_ALLOWLIST`: read/build/test verbs — `git status/log/diff`, `ls`, `cat`, `grep`, `rg`, package `test`/`lint`/`typecheck`; anything with network, `sudo`, file redirects, `git push`, `rm`, or an unrecognized verb → unsafe). This single definition is what makes `auto` mean the same thing on both engines — the tier copy ("only asks for actions detected as potentially unsafe") finally holds.
- Limn MCP tools are auto-allowed (`isLimnTool` → row 1); a read-only turn denies `file_change` outright (replacing the old `disallowedTools:[Edit,Write]`).

**Approval registry (`approvals.ts`)** — engine-agnostic and reused byte-for-byte. When `ladderPolicy` says `ask`, the turn parks on `awaitDecision(opId, request, emit)`: it emits an `approval_request` event (the renderer shows a blocking card) and returns a promise that settles when the reviewer answers. The answer flows back through the `respondApproval` IPC → `resolveDecision(opId, requestId, decision)`; `allow` → the option whose kind is `allow_once`, `deny` → `reject_once`. `clearPending(opId)` answers everything still parked with the ACP-required `cancelled` outcome on cancel / turn end (no leak). **There is no timeout** — a request waits until answered or cancelled.

## Anchoring & artifacts

**Anchoring (`anchor.ts`)** keeps **comments** attached to the right lines after the branch moves — it is *not* how narration ties to the diff (that's `section.files` + `flag.hunkRange`, validated above). `reanchorComments(...)` runs on every session load. For diff/artifact anchors it searches the new skeleton for a line whose text **exactly equals** the stored `lineContent` on the correct side and picks the candidate nearest the old line number; no match → `outdated` (and a previously-outdated comment that re-matches is revived). Only `diff` and `artifact` anchors are repositioned; every other kind (`section`, `summary`, `file`, `question`, `plan-step`, `title`, `acceptance`, `deviation`, `selection`) references ids/paths/quoted text and is left untouched.

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
- **Cancellation:** `EngineRun.cancel` → `session/cancel` notification, pending permission requests answered `cancelled`, then the adapter process group is killed after a short grace. **There is no timeout** anywhere — a wedged run, or a parked approval, hangs until the user cancels.
- **Errors:** propagate as both an `{type:'error'}` event and a rejected `result`. No retry/backoff, including on invalid structured output — one bad parse fails the whole op.
- **Session resumption assumption:** a chat/batch turn whose thread *has* an `engineSessionId` resumes it (the review's session, from the last iteration). If that session is gone (CLI store pruned) the resume fails, and the turn is classified by its observable shape (session id present + zero text/tool events + failed, not cancelled) and surfaces a distinct `ENGINE_SESSION_LOST` error telling the reviewer to start a new chat; **the thread is never auto-rebound or retried** (its visible history stays intact). A thread that never produced the review has no id and is seeded fresh by design.
- **Write degradation, not failure:** an un-met batch precondition (dirty tree, wrong branch, fixed-commit compare) silently withholds the write tools rather than erroring — the agent answers/comments instead of editing.
- **Structured output is best-effort for both engines now:** no engine gets a native output-schema guarantee — the review payload rides prompt-embedded JSON, extracted by `parseJson` with one repair turn (see *Schema & validation*). One retry, then the op fails.
- **Adapters are pinned, protocol is pinned:** the engine runtime moves only when the adapter `package.json` pin moves (a deliberate bump guarded by tests + canaries); `initialize` hard-fails any adapter not negotiating protocol `1`. See [acp-adapters.md](acp-adapters.md).
