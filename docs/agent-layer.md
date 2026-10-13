# Agent (Engine) Layer

How Limn drives an AI agent — Claude and Codex, both through the **Agent Client Protocol (ACP)** — to turn a git diff into a structured, narrated review and to apply reviewer comments back to the branch as commits.

> **Audience:** developers working on the server (`src/server/`). This describes the engine abstraction, the single ACP engine and its per-engine adapter configs, the prompt/schema contract, the engine-agnostic tool layer, execution modes and approvals, anchoring, the core flows, and actions. Source lives mainly in `src/server/engines/` (with anchoring in `src/server/anchor.ts` and artifact detection in `src/server/artifacts.ts`) and is orchestrated by `src/server/ipc.ts`.

> **One protocol, two adapters.** Both engines are driven by one `AcpEngine` (`acp.ts`) speaking ACP over stdio to a per-engine **adapter** — a pinned npm package (`@agentclientprotocol/claude-agent-acp`, `@agentclientprotocol/codex-acp`) that translates ACP into each engine's native CLI. Per-engine code is a small `AcpEngineConfig` record (`adapters.ts`): the mode-id mapping, per-turn spawn env, effort config-options, and which native-binary env var to feed. The adapter version *is* the pinned engine version — see [acp-adapters.md](acp-adapters.md).

## Guiding principle: git is ground truth

The displayed diff is **always** computed from `git diff`, never from the agent. The agent only *annotates* the diff (sections, narration, risk flags, diagrams, spec cross-check) and, on a write-enabled turn, *edits and commits* on the branch using its own engine shell (git) — after which the app re-reads git. The agent can never assert what changed or alter what you see. The validation layer enforces this: any agent reference to a file not in the diff is dropped, and every file in the diff is guaranteed coverage.

## Engine abstraction

All engines implement one interface (`engines/types.ts`) with four methods:

```ts
interface ReviewEngine {
  id: EngineId  // 'claude' | 'codex'
  generateReview(req: ReviewRequest): EngineRun<ParsedReview>
  generateScopedUpdate(req: ScopedUpdateRequest): EngineRun<ScopedReviewPatch>
  chat(turn: ChatTurn): EngineRun<string>  // chat, action runs, batch and rebase turns
  extractFindings(req: ExtractRequest): EngineRun<WireFinding[]>  // the findings pass after an action run
}
```

The product operations map onto these methods: **generate** (explore the repo and produce structured annotations; a small drift can use the scoped update instead), **chat** (conversation next to the diff), **actions** (a pinned skill or prompt, then a findings pass), and **batch** (apply queued comments: edits and commits). Batch is not a separate method. It is `chat()` with `writeEnabled` set, which lets the engine's own shell/edit tools (Bash/Edit/Write, git via bash) act under the execution-mode gate. Limn hosts no write tool of its own; the agent edits files and commits on the branch itself. What the agent can do is decided by the engine/tool policy for the turn. All three return the same dual-channel envelope:

```ts
interface EngineRun<T> {
  events: AsyncIterable<EngineEvent>            // live progress stream
  result: Promise<{ value: T; sessionId: string }>  // terminal validated payload
  cancel: () => void
}
```

The two channels run concurrently: `ipc.ts` pumps `events` to the renderer (IPC channel `op:event`) for live progress while awaiting `result` for the terminal payload (the validated `ReviewAnnotations` for generate; the final assistant text for chat/batch).

- **`EngineEvent`** (`shared/types.ts`) is an **8-variant** union: `status`, `tool` (tool-call lifecycle), `text` (streamed assistant text), `action` (a Limn-tool side effect: point, comment_added, finding_added…), `approval_request` (needs reviewer go-ahead), `lane` (the op's place in the repo's task queue: `queued` with a 1-based `position` and the `behind` label, then `running`), `done`, `error`. The ACP event mapper normalizes each adapter's stream into this union; `lane` comes from `ipc.ts`, not from an engine.
- **`EventQueue`** bridges push-style SDK callbacks to a pull-style `AsyncIterable`. It is **single-consumer** (one FIFO waiter queue) and **drops events pushed after `close()`**. It does not surface errors as rejections — errors travel as an `{type:'error'}` event plus a rejected `result` promise.

**`ChatTurn`** (`engines/types.ts`) is the carrier for both chat and batch. Beyond `repo`/`message`/`anchor`/`model`/`reasoningEffort` it threads the context that distinguishes the two: `engineSessionId` (resume this session, else start fresh and seed from `context`), `tools` (the per-turn `AgentToolHost`), `writeEnabled` (code-editing tools allowed this turn), `opId` (keys the approval registry), and `executionMode` (the autonomy tier).

**Selection** — `makeEngine(id)`:

```ts
if (process.env.LIMN_DEMO === '1') return new FakeEngine(id)
return id === 'claude' ? new AcpEngine(CLAUDE_ACP_CONFIG) : new AcpEngine(CODEX_ACP_CONFIG)
```

A fresh engine instance is constructed per operation — the same `AcpEngine` class, differing only by its config record. `LIMN_DEMO=1` overrides everything.

**FakeEngine** is a deterministic engine for contract tests and demo mode — no AI, canned review, and a `chat` that, on a write-enabled batch turn (`turn.tools && turn.writeEnabled`), drives the **real** tool host: it edits a file, commits via `git` through `execGit` (as the real agent does through its own shell), then calls `resolve_comment` per comment id so the actual edit/commit/resolution path runs offline. Tool-enabled turns that are not write-enabled exercise the `point` (single and multi-stop) + `suggest_mark_viewed` action pipe. It covers the full generate→comment→batch→"since" cycle without an AI. `FakeEngine` carries the requested engine id (`new FakeEngine(id)`), so demo mode reports the engine the caller asked for.

## ACP engine (`acp.ts`)

One `AcpEngine implements ReviewEngine` drives both engines; the only per-engine data is the `AcpEngineConfig` record (`adapters.ts`) selected by `makeEngine`. All four methods funnel into one `runAcpTurn`, which owns the whole turn lifecycle:

1. **MCP host** — for tool-enabled turns, `registerTurn(host)` opens the per-turn localhost MCP server and yields its `{url, release}` (see *The tool layer*); the url is passed as an ACP `mcpServers: [{type:'http', name:'limn', …}]` entry.
2. **Preflight + spawn** — when the config marks the native binary **required** (Codex), an unresolved binary fails fast with the `engineBinaryStatus` hint (see *Binary resolution*). Otherwise the adapter is spawned with the service's own Node (`process.execPath`), **one process per turn**, in its own process group so cancel kills the tree. Per-turn spawn env layers on `binaryEnv()` (the native-binary path) and `env(turn)` (e.g. `ANTHROPIC_MODEL`).
3. **`initialize`** — declines all client capabilities (`fs.readTextFile/writeTextFile: false`, `terminal: false`) so the agent uses its own tools against the worktree, as before. The negotiated protocol version must be `1` — anything else throws an actionable "update Limn" error (spec OQ10).
4. **Session.** With an `engineSessionId`, the turn calls `session/resume` when the adapter advertises it (`sessionCapabilities.resume`), else `session/load`. If that call fails, the turn throws `EngineSessionLostError` (surfaced as `ENGINE_SESSION_LOST`, "start a new chat"); it is never silently re-seeded into a fresh session. An adapter that advertises neither fails with a generic error. Without an `engineSessionId` the turn calls `session/new`. **Replay is suppressed:** every `session/update` before the session call resolves is dropped, since that history already lives in Limn's DB.
   - **Session `_meta` (Claude).** Every `session/new`, `session/load` and `session/resume` carries `_meta.claudeCode.options.settingSources: ['user']` (`CLAUDE_ACP_CONFIG.sessionMeta`; the command probe opens its sessions the same way). The reviewed repo is untrusted input, so its `.claude/settings*.json` (hooks, permission rules, env), project `.claude/skills` and `.claude/commands`, project `.mcp.json` and its `CLAUDE.md` are not loaded. The user's own `~/.claude` settings, skills and `CLAUDE.md` are. One residual: the adapter's own settings manager still reads `<cwd>/.claude/settings*.json` to pick its starting permission mode and model settings. That is why a failed `set_mode` (next step) fails the turn instead of continuing in the adapter's default.
5. **`session/set_mode`.** Limn sends the tier's ACP mode id (`config.modeFor(mode, writeEnabled, availableModes)`, using the mode ids the session advertised). If the adapter rejects it, Limn retries once with the conservative fallback (`modeFor` with an empty mode list; for Claude `auto` that is `acceptEdits`). If both fail and the session does not already report one of those two ids as its current mode, the turn fails before any prompt is sent, on every tier, read-only included. If the adapter advertises no session modes at all, the mode step is skipped. The per-engine config options (Claude effort; Codex model and effort) follow. Those are advisory: a rejected option id is ignored.
6. **`session/prompt`** — the built prompt as one text block; `session/update` notifications stream through `acpToEvents` (`acpEvents.ts`) into the `EventQueue`, and `session/request_permission` requests route through `ladderPolicy`, or `generationLadder` on a generation turn (see *Execution modes & approvals*).
7. **Terminal** — `end_turn` resolves `{value, sessionId}`; `cancelled` settles quietly; `refusal`/`max_*` error. `finally` closes the queue, kills the process group, and `release()`s the MCP turn.

- **Auth** is unchanged and per-engine: `authStatus` reports healthy for Claude if `ANTHROPIC_API_KEY` is set or `~/.claude` exists, for Codex if `OPENAI_API_KEY` or `~/.codex/auth.json` exists. The adapters read those same credential locations.
- **Sessions.** `engineSessionId` is the ACP `sessionId`. `session/new` returns it and Limn stores it on the chat thread (and on the iteration for a generation). Pre-migration ids (Claude JSONL ids, Codex thread ids) are keyed the same way by the adapters, so they resume. A failed resume is not degraded to a fresh session: it raises `ENGINE_SESSION_LOST` and the reviewer starts a new chat (see *Invariants & sharp edges*). The thread's visible history stays in Limn's DB either way.
- **Event mapping (`acpEvents.ts`)** — one pure `acpToEvents(update): EngineEvent[]` mapper (unit-tested per row) folds ACP `agent_message_chunk` / `agent_thought_chunk` / `plan` / `tool_call` / `tool_call_update` into the same `EngineEvent` union both engines already produced. Sparse `tool_call_update`s fold by `toolCallId`; `current_mode_update` / `available_commands_update` / `usage_update` / `config_option_update` are ignored.
- **Model & effort** are per-turn config, not turn params — see *Model & reasoning effort*.
- **Structured output** has no ACP channel, so `generateReview` uses schema-in-prompt + a repair turn — see *Schema & validation*.

## Model & reasoning effort

The agent for a review — and for each chat thread — is an `AgentRef` = `{ engine, model?, reasoningEffort? }` (`shared/types.ts`), chosen from a curated catalog (`shared/agents.ts`). `model`/`reasoningEffort` left undefined means **Auto**: let the CLI pick its default (the original behavior).

- **Catalog** (`AGENT_CATALOG`) — Claude offers `fable`/`opus`/`sonnet` with reasoning effort `low → max`, and `haiku` with **no effort**; these are Claude Code's model *aliases*, so each resolves to the latest model of its tier without a Limn release. Codex offers `gpt-6-astra`/`gpt-5.6-sol`/`gpt-5.6-terra`/`gpt-5.6-luna` (`low → max`) and `gpt-5.5` (`low → xhigh`), mirroring the ladders the Codex CLI reports in its own model catalog (`~/.codex/models_cache.json`). Model ids pass straight through, so the lists are tuned here with no schema/IPC change.
- **Plumbing** — `model` and `reasoningEffort` ride on `ReviewRequest` / `ChatTurn` (the chat/batch carrier) and reach each adapter through the `AcpEngineConfig` (`adapters.ts`), which is where the two engines' quirks live:
  - **Claude** — model via the **`ANTHROPIC_MODEL` spawn env** (`config.env`; one process per turn makes it exact); effort via a post-session `setSessionConfigOption({configId:'effort'})` (`config.configOptions`). `claudeEffort` clamps the Codex-only `minimal` up to `low`.
  - **Codex** — no model env var: **both** model and effort go through `setSessionConfigOption` (`configId` `model` / `reasoning_effort`). `codexEffort` clamps `minimal → low`; everything else (including `max`) passes through, since the catalog already gates which values each model offers.
  - Config-option passthrough is advisory — the adapter swallows unknown/unsupported ids. The shared `ReasoningEffort` union spans both ladders (`minimal | low | medium | high | xhigh | max`); each model's `reasoningEfforts` gates which values the UI offers.
- **Selection UI** — `AgentPicker` (a single trigger opening a structured popover: engine + auth, model guidance, a segmented effort control) in the chat agent bar, plus the engine cards + model/effort controls on the Compare "Review agent" rail. The chosen `AgentRef` is persisted on the session, seeds chat 1, and each chat thread can retarget its own agent.

## Binary resolution (`binaries.ts`)

Two kinds of artifact, resolved differently:

- **The ACP adapters + their JS SDK glue are bundled** in the npm package (pinned npm packages, vendored via `bundleDependencies` so the spawned Node children resolve them from the installed tree). The adapter version is the pinned engine-protocol version.
- **The native CLIs are NOT bundled.** Each of `claude` / `codex` is resolved from the user's **system PATH** (checked for executability + that it's a file/symlink), with a Settings absolute-path override that wins even when broken (so a stale path surfaces as an error, not a silent swap). `binaries.ts` feeds the resolved path to the adapter via the env var it reads — `CLAUDE_CODE_EXECUTABLE` for claude-agent-acp, `CODEX_PATH` for codex-acp (`AcpEngineConfig.binaryEnv`, spec OQ7). The multi-hundred-MB platform binaries the SDKs would otherwise bundle are never installed (`npm ci --omit=optional` at pack time; npm installs the bundled subtree as-is).

> **Codex hard-requires its binary.** claude-agent-acp can self-discover `claude`, but codex-acp's only fallback is the *bundled* `@openai/codex` binary — which packaging strips — so a missing `codex` must be caught before spawn. `CODEX_ACP_CONFIG.binaryRequired` + the `runAcpTurn` preflight turn that into the actionable `engineBinaryStatus` hint instead of a raw `MODULE_NOT_FOUND`. The same preflight also fires on **either** engine when the user configured a path in Settings and it is broken — the override is handed to the adapter unvalidated, so it must fail with the hint rather than a raw spawn error; an *unconfigured* unresolved binary is left to the adapter's own discovery.

> **Version reporting, not gating** — `probeEngineVersion` best-effort-reads `<cli> --version` and warns below a known-good floor (Codex only), but never blocks. The *protocol* version, by contrast, is hard-pinned: `initialize` must negotiate `1`. Deliberate engine upgrades are adapter-version bumps — see [acp-adapters.md](acp-adapters.md).

## Prompts (`prompts.ts`)

Plain-string builders. `describeAnchor()` renders each of the 11 `CommentAnchor` kinds (`shared/types.ts`) into prose the agent can act on. The main builders:

- **`buildReviewPrompt(req)`** — frames the agent as a review guide and instructs an **explore-first** pass (read changed files in full, grep callers/tests, walk `git log base..branch`, read artifacts). It supplies a pre-computed changed-files list (status, ±counts, hunk ranges, merge-base/head SHAs) and an artifact block ("the intent this change is judged against"). The output contract: group **all** files into **2–8 logical sections** (by purpose, not directory; each file in exactly one section), per-section `desc` + plain-language `what`, **risk flags** keyed to exact file + hunk range, an optional **mechanism diagram** (2–5 nodes), `title` + `summary`, a **spec/plan cross-check** (`planMap`: acceptance criteria met/partial/false, plan steps mapped to sections, deviations), and `questions` needing a human decision.
- **`buildChatPrompt(message, anchor?)`**: the wrapper for a turn that **resumes** a session (chat messages and action runs alike). The message, optional anchor prose, then `DEFAULT_POSTURE` ("Read and explain by default. Change files only when the reviewer explicitly asks for a change; when you do, commit on the branch and say what you committed.") and `CHAT_TOOL_POLICY` (pick one channel per answer: prose, `point`, a comment reply, or one `add_comment`).
- **`buildSeededChatPrompt(ctx, message, anchor?)`**: for a **fresh** thread whose agent did not produce the review, so there is no engine session to resume. Re-orients the new agent: branch/base, the review summary so far, how to ground itself in git, then the same posture and channel policy.
- **`buildScopedUpdatePrompt(input)`**: the patch-shaped update over a small since-diff (revised/new/deleted sections plus a `keptSectionIds` handshake), spliced by `splice.ts`.
- **`buildExtractFindingsPrompt()`**: the findings pass after an action run (see *Actions, findings, rebase & merge*).
- **`buildRebasePrompt(base, branch, conflictFiles?)`** and **`buildAnswerPrompt(comments, context?)`**: the agent rebase turn from the merge sheet, and the write-disabled refine turn that folds answered intent questions into the narration.
- **`buildBatchPrompt(comments, steer?, context?)`** — the unified apply turn. Lists each queued comment with its **stable id**, anchor, text, and reply thread, plus an optional reviewer `steer`. Instructs the agent to address each comment by editing the code (or `reply_to_comment` when no change is needed); to **commit its edits itself with git through its own shell** — "stage exactly the files you changed and commit with a short message (`limn: …`)"; and to record each outcome with `resolve_comment` (its `commentId` plus a verdict — `addressed` / `reworked` / `skipped` — and a note), whether or not a code change was needed. It also says to keep existing code style, treat answers to earlier open questions as decisions, and finish with a 2–3 sentence summary. `context` seeds the review framing when the thread has no engine session to resume.

## Schema & validation

Two layers sit between the SDK and the persisted review. Only the **generate** output (full or scoped) and the findings pass are schema-constrained. Chat and batch return free text plus tool-driven side effects.

**Wire schema (`schema.ts`)** — Zod schemas distinct from the internal `shared/types.ts` shapes, because of two engine constraints (still valid now that the schema is prompt-embedded rather than passed as an output-format param):
- Some CLIs **silently drop schemas containing `prefixItems`** → no tuples. Diagram nodes travel as `{label, kind, sub}` objects and are mapped to `[label, kind, sub]` tuples after parse.
- OpenAI strict mode **requires every property in `required` and forbids records** → optionals are modeled as `.nullable()` (not `.optional()`), and per-file notes travel as an array of `{file, note}` rather than a record, reassembled afterward.

**Schema-in-prompt + one repair turn (`structured.ts`).** ACP exposes no output-schema channel, so `generateReview` converges on one strategy for both engines: `buildReviewPrompt` appends a `structuredEpilogue(reviewJsonSchema)` ("respond with a single JSON object only, no fences, no prose"); streamed text is suppressed and collected; `parseJson` extracts it (direct `JSON.parse` → strip a ```` ```json ```` fence → balanced-brace slice); `parseReviewOutput` Zod-parses and translates wire→internal (object→tuple, array→record, `null`→`undefined`). On extraction/validation failure there is **one** automatic repair turn — a follow-up `session/prompt` on the same session quoting the Zod issues and asking for corrected JSON — then re-parse. A second failure fails the op (error event + rejected `result`; the ZodError → friendly-message path in `ipc.ts` still applies). This replaces the Claude SDK's native `outputFormat` enforcement and Codex's app-server `outputSchema`; the same `parseJson` net now serves both.

**Reconciliation against git (`validate.ts` → `mergeAnnotations(skeleton, parsed)`)** — the layer that enforces "git is ground truth". It:
- drops section files that are not in the diff (or the offered untracked candidates);
- enforces each file in exactly one section (duplicates: keep first);
- drops sections left with zero valid files;
- collects any unassigned tracked file into a synthetic **`Other changes`** section, guaranteeing coverage of every committed or staged file (an unsectioned untracked file stays orphan and is auto-excluded);
- sanitizes `planMap` cross-references to existing section ids.

Returned warnings are surfaced to the UI as `status` events. Note this runs in `ipc.generate`, **not** inside the engine — engines return raw `ReviewAnnotations`; the IPC layer validates.

## The tool layer (`tools.ts`)

Beyond reading the repo (Read/Grep/Glob/Bash), the agent acts on the review through one **engine-agnostic** tool set defined once and hosted two ways. A `ToolDef` is `{ name, description, input: z.ZodRawShape }`; a handler runs in the **server** process — it may touch the DB/git, emit a live `action` event, and returns the text the model sees. These are all read/annotate tools: **Limn hosts no write tool**. Code edits and commits go through the engine's *own* shell/edit tools (Bash/Edit/Write — git via bash), gated by the execution mode, not through a Limn tool.

| Tool | Effect |
| --- | --- |
| `point` | point the reviewer at one spot (a clickable chip) or 2–8 stops (an interactive walkthrough card) across the summary, sections, files, or diff lines |
| `suggest_mark_viewed` | propose marking files/sections viewed (reviewer confirms) |
| `list_comments` / `get_review` | read current DB state (comment ids, anchors, status; title, summary, section narration) |
| `get_review_progress` | which files are marked viewed (and at which sha), comment counts by status |
| `add_comment` / `reply_to_comment` | author an agent comment / reply, anchored to diff/file/section/summary |
| `add_finding` | report one finding as a **proposed** comment anchored to a file and line, with a severity (`risk` / `note`) |
| `resolve_comment` | resolve a comment (by id) with verdict + note |
| `edit_review` | amend the title, the summary, or a section's narration block or behavior contrast in place |
| `update_plan_status` | flip a `planMap` acceptance criterion's met status, with a note |

- **Each turn registers a subset** (`toolsForTurn`): a chat turn gets the catalog; an action run gets `list_comments` / `get_review` / `get_review_progress` only — it reads the review but cannot post, because its findings come from the structured pass after the run (one path, no twins); the Attach-findings follow-up is the one action turn with `add_finding`. `createToolHost` refuses a call outside the turn's list, and `registerTurn` serves exactly that list.
- **Hosting is now one path:** `mcpHost.ts` (generalized from the old Codex-only `codexMcp.ts`) runs **one** per-turn localhost streamable-HTTP MCP server reflecting the Zod `input` shapes into JSON Schema, passed to every adapter via the ACP `mcpServers` param. Claude's old in-process `createSdkMcpServer` path is gone — the dual-hosting duplication collapsed to this single host. claude-agent-acp names the tools `mcp__limn__<name>`; codex-acp titles them `mcp.limn.<name>` (`isLimnTool` in `shared/approvalPolicy.ts` accepts both). Hardening (unguessable UUID path token, DNS-rebinding protection, loopback-only) carries over unchanged. Set `LIMN_MCP_DEBUG=1` in the service's environment to log every MCP request and tool invocation to stderr.
- **The write path is the engine's own:** since Limn has no write tool, the *code-editing* capability is the engine's Bash/Edit/Write tools, gated by the turn's `writeEnabled` + execution mode (see *Execution modes & approvals*). A non-write turn degrades to review/comment-only.
- **Limn tools auto-allow at the permission layer:** ACP has no tool-allowlist knob, so limn-tool permission requests are auto-allowed by `ladderPolicy` (row 1: `isLimnTool` → `allow`) — the same effect as the old per-engine auto-accept, minus the fragile Codex elicitation-auto-accept workaround, which disappeared with the code that needed it.
- **Call path:** `createToolHost(ctx).call(name, args)` validates args against the Zod shape at the boundary, runs the handler, and — if it produced an `AgentAction` — emits it live (`type:'action'`) *and* collects it for persistence on the chat message (so chips rebuild on reload). A handler throw becomes `{isError:true}` text, not a crash.
- **The comment id is the join key** that survives the whole batch round-trip: prompt → the agent's `resolve_comment` / `reply_to_comment` call → the DB row's `resolution`.

## Execution modes & approvals

One product vocabulary — a 4-rung autonomy ladder the reviewer picks per chat (`ExecutionMode` = `ask | edits | auto | full`, persisted on the thread, default `auto` for new chats — pre-existing threads created before this column carried a value keep `ask`) — is enforced in **two deliberate layers**. The tiers mean the same *product* thing on both engines — how much the reviewer is asked — but the mechanism is delegated to each engine's native equivalent: Claude's own model classifier decides what's safe to auto-run, Codex's sandbox decides what's safe to execute unattended. Limn no longer classifies anything itself.

**(a) Baseline engine mode** — set once per session via `session/set_mode` (`AcpEngineConfig.modeFor`), chosen to hand each engine its closest native equivalent of the tier:

| Tier | Reviewer sees | claude-agent-acp mode | codex-acp mode |
| --- | --- | --- | --- |
| `ask` | Ask for approval | `default` | `read-only` |
| `edits` | Accept edits | `acceptEdits` | `workspace-write` |
| `auto` | Auto mode | native `auto` (→ `acceptEdits` when the session doesn't advertise it) | `agent` |
| `full` | Full access | `bypassPermissions` (→ `auto`, then `acceptEdits`, when the session doesn't advertise it) | `agent-full-access` |
| not write-enabled (`writeEnabled` false: a commit compare, a refine turn, every generation turn) | — | `default` + client-side deny | `read-only` |

Claude's `default` mode asks before any file edit, so on a turn that is not write-enabled every edit reaches Limn as a permission request and is denied. Read-only bash still runs inside the engine without asking.

Codex's `read-only` mode runs the turn in a read-only sandbox with network off (codex-acp 2.2.2; 1.7–1.12 used a workspace-write sandbox under that id, so Codex could edit the tree without asking). Commands run and can read the tree; a write or a network call fails inside the sandbox unless Codex asks to escalate, and every file edit asks. On a turn that is not write-enabled Limn denies those requests; under `ask` they wait for the reviewer. Codex's reject option for a file edit (and for a command that offers no "continue without it") is a cancel, so a denial there ends the Codex turn.

`workspace-write` and `agent` share one sandbox (the workspace is writable, network off) and differ in who answers an escalation: the user under `workspace-write`, so `edits` parks it on the reviewer; Codex's own auto-reviewer under `agent`, so `auto` sees only what that reviewer passes up.

The two layers change at different rates: the ladder tier is re-read from the thread at **each** permission request (so a mid-turn tier change applies from the next request on), while this engine-session mode is negotiated **once** at turn start. In practice the only mid-turn transition with live effect is `full` ↔ a lower tier: dropping out of `full` mid-turn makes the ladder start parking subsequent requests again, and rising into `full` mid-turn makes it start auto-allowing them; moving among `ask`/`edits`/`auto` mid-turn changes nothing, since `ladderPolicy` treats those three identically (all `ask`) until the next turn renegotiates the session mode.

**(b) One shared decision function** — `ladderPolicy(mode, req, writeEnabled)` (`shared/approvalPolicy.ts`, pure, unit-tested) runs on **every** incoming `session/request_permission`, identical for both engines. The ACP payload is normalized to Limn's `ApprovalRequest` (`acpPermissionToRequest`: `execute` → `command`, `edit|delete|move`/diff → `file_change`, else `tool_use`), then it decides:

| Tier | limn MCP tools | `file_change` (writeEnabled) | `command` | other `tool_use` |
| --- | --- | --- | --- | --- |
| `ask` | allow | ask | ask | ask |
| `edits` | allow | ask | ask | ask |
| `auto` | allow | ask | ask | ask |
| `full` | allow | allow | allow | allow |
| any tier, `writeEnabled:false` | allow | **deny** | ask | ask |

**Generation turns use their own policy.** A full review, a scoped update and the findings pass after an action run route permissions through `generationLadder(req)` instead of the tier ladder. It allows only Limn's own MCP tools and denies everything else, commands included. It never parks a request on the reviewer. A command that reaches this point is one the engine itself wanted a human for (a write, a network call, a sandbox escalation), and Limn does not second-guess that with a classifier of its own.

No self-rolled classification: by the time a request reaches Limn, the *engine* has already decided the action needs a human — claude-agent-acp's CLI auto-allows read-only bash and applies its own model classifier under native `auto`; codex-acp runs commands inside its sandbox and surfaces only escalations (see layer (a) above). Limn never re-classifies what the engine chose to surface — it parks everything on the reviewer below `full`. The only decisions left to Limn's own policy are its own MCP tools (always safe, always allowed — `isLimnTool` → row 1) and the `full` tier (the reviewer told Limn to stop asking, so anything that still reaches here is auto-approved); a read-only turn denies `file_change` outright (replacing the old `disallowedTools:[Edit,Write]`) regardless of tier.

**Approval registry (`approvals.ts`)** — engine-agnostic and reused byte-for-byte. When `ladderPolicy` says `ask`, the turn parks on `awaitDecision(opId, request, emit)`: it emits an `approval_request` event (the renderer shows a blocking card) and returns a promise that settles when the reviewer answers. The answer flows back through the `respondApproval` IPC → `resolveDecision(opId, requestId, decision)`; `allow` → the option whose kind is `allow_once`, `deny` → `reject_once`. `clearPending(opId)` answers everything still parked with the ACP-required `cancelled` outcome on cancel / turn end (no leak). **There is no timeout** — a request waits until answered or cancelled.

## Anchoring & artifacts

**Anchoring (`anchor.ts`)** keeps comments, and the review's own diff targets (narration blocks, diagram nodes, `point` stops), attached to the right lines after the branch moves. `reanchorComments(...)` runs on every session load. Only `diff` and `artifact` anchors are repositioned; every other kind (`section`, `summary`, `file`, `question`, `plan-step`, `title`, `acceptance`, `deviation`, `selection`) references ids, paths or quoted text and is left untouched.

Anchors are stamped at creation (`anchorStamp.ts`: the compare tip, the file's blob sha, the original line and path) and carry up to three lines of context on each side. A stamped anchor runs a staged pipeline:

- **Stage 0**: the file's current blob equals the stamped one, so the anchor goes back to its stamped line with no diff call.
- **Stage 1**: deterministic diff mapping (`mapLine`) from the stamped blob to the current content. If the anchored line itself was rewritten, the comment is flagged as edited and the pipeline falls through.
- **Stage 2**: fuzzy match of the quoted line plus its context over the whole new content (`fuzzyFind`), seeded with the stage 1 position.
- **Stage 3**: exact-text match of the stored `lineContent` on the correct side, nearest the old line.

A legacy anchor (no stamp) runs stage 3 only and is healed forward with a fresh stamp when it matches. A comment that is not located goes `outdated` (a previously outdated one that re-matches is revived), except that resolved, proposed and dismissed comments keep their status and are flagged as outside the diff instead.

> ⚠️ Stage 3 is still exact-text + nearest-line. A legacy anchor, or a stamped one whose old blob can't be read, can go `outdated` on reformatting, and repeated identical lines can mis-anchor.

**Artifacts (`artifacts.ts`)** are the spec/plan markdown the review is judged against, not agent-produced diagrams (mechanism diagrams live inside `ReviewAnnotations` as structured data). A markdown file counts as an artifact only when its path matches a known convention (`docs/superpowers/specs|plans/*.md`, `specs/<name>/spec.md` / `plan.md` / `tasks.md`). `detectArtifacts(...)` returns every recognized artifact that is part of the diff; when none is, it falls back to the best-scored spec and plan (branch or ticket mentions in the file head). The rail is reconciled with the current diff on every load (`loadArtifactsFor` in `review.ts`): detected rows follow the diff, so a rebase that drops a spec from the diff drops it from the rail. Rows the agent reported (`artifacts.source = 'agent'`, migration 8), and rows the reviewer approved or commented on, stay even when off the diff.

## The core flows

Every agent task on a repo (a generation, a chat turn, an action run, a batch, a rebase, and the native merge) runs through `OperationCoordinator.run` (`operations.ts`): **one FIFO task queue per repo**. A task that finds the repo busy waits its turn instead of being refused. While it waits, `ipc.ts` emits `{type:'lane', state:'queued', position, behind}` to it (1-based place, label of the running task), then `{type:'lane', state:'running'}` when it takes over. A thread also hosts at most one in-flight turn: a second send on the same thread fails fast with `ThreadBusyError`.

### Generate (review or update) — `ipc.generate`

1. Take the repo's lane (`operations.run`, label "Generating the review" / "Updating the review").
2. Build the diff skeleton (`getDiff`), add up to 40 untracked files as optional section candidates, load review state, and reconcile the artifact rail.
3. For an update, decide scoped vs full: a scoped pass needs a prior review whose end SHA is still reachable from head, a small drift, and fewer than the cap of consecutive scoped passes. Otherwise, or when anything in that decision throws, run a full pass.
4. Run `engine.generateScopedUpdate(...)` (resuming the prior iteration's session on the same engine; retried fresh if that session is lost) or `engine.generateReview(...)`. An unusable scoped patch falls back to one full pass with a status note.
5. Reconcile: `mergeAnnotations(skeleton, …)` for a full pass, `spliceScopedUpdate(…)` for a scoped one. Warnings become status events. Then stamp the annotations' anchors.
6. Mint the iteration number (`nextIterationNumber`, a pure `MAX(n)+1` read). A full pass's hotspots become **proposed** agent comments; the previous full pass's untouched hotspot proposals are deleted first, and anything the reviewer engaged with stays.
7. Keep agent-reported artifact paths that match a known format (`source: 'agent'`).
8. In one transaction: `addIteration` (append-only; earlier iterations are kept), `updateSessionMeta` (annotations, `reviewed_at_sha = head`), and bind the review thread to the engine session with the agent's turn.
9. Emit `op:result {kind:'review', reload:true}`.

### Chat — `ipc.sendChat` (shared `chatTurn`)

1. Persist the user message up front, then take the repo's lane.
2. Check the compare side: if it is a branch that is not checked out anywhere, the turn fails with `Check out <branch> to chat or run actions`. Otherwise the turn is **write-capable whenever the branch is checked out** (`writeEnabled = capability.enabled`); a commit compare stays read-only. The prompt's `DEFAULT_POSTURE` makes reading the default, and the thread's execution mode is the approval axis.
3. Build the tool host for the turn (`toolsForTurn('chat')`: the full catalog) and call `engine.chat({ engineSessionId, message, anchor, tools, writeEnabled, opId, executionMode, context })`. The turn resumes the thread's engine session if it has one, else seeds a fresh session from `context` (branch/base/summary).
4. Pump events; persist the agent message with its collected actions, tool calls and segments; store the engine session id on the thread. Emit `op:result {kind:'chat'}`.

### Batch (apply comments) — `ipc.sendBatch`

Batch is chat with write tools. It returns ordinary chat text plus tool side effects, not a separate structured fix result.

1. Take the repo's lane. Compute write capability: the compare side must be a **branch** that is **checked out** in the primary repo or a linked worktree. A dirty tree does not block: reviewer in-place edits and agent writes share the working tree on purpose. If the branch is not writable, a normal batch turn throws `Agent edits are unavailable because …` instead of running read-only. Only a `refine` turn (answering the agent's intent questions) runs write-disabled.
2. Mark the selected comments `sent` and persist (a crash leaves a recoverable trail).
3. Build the tool host and `buildBatchPrompt(comments, steer, context?)`, with `context` only when there's no session to resume.
4. `engine.chat({ engineSessionId, message: <batch prompt>, tools, writeEnabled, executionMode, raw: true, … })`. The agent edits files, **commits on the branch with git in its own shell**, and calls `resolve_comment`/`reply_to_comment` per comment id. The app never commits.
5. Reconcile: reload state; **any comment still `sent` (un-addressed) rolls back to `queued`** so it isn't lost.
6. Emit `op:result {kind:'chat', reload:true}`.

After a batch, the next `loadSession` re-diffs against git and tags the new commits as "since you reviewed". The agent's output is never trusted for what changed.

## Actions, findings, rebase & merge

**Actions** (`runAction`) pin agent work to a button: a **skill** the engine already has, or a **prompt** in the reviewer's words. Actions are stored globally in prefs. A launch from the bolt creates a fresh action thread; Re-run, or picking a thread in the launcher, runs inside an existing one. Like chat, it refuses when the compare branch is not checked out. The run is an ordinary `chatTurn` on the repo's lane, with three differences:

- **Tools.** `toolsForTurn('action')` exposes only `list_comments`, `get_review` and `get_review_progress`. The run can read the review but cannot post.
- **Skill check.** A skill run waits briefly for the session's `available_commands_update` and refuses (`SkillUnavailableError`) before any prompt is sent when the skill is missing. A session that sends no list falls back to the cached probe result.
- **Findings pass.** After the run, unless the action turned findings off (default: on for a skill, off for a prompt), `engine.extractFindings` resumes the run's own session with `buildExtractFindingsPrompt()` plus the findings JSON schema, under `generationLadder`. Each finding is minted by `mintFinding` as a **proposed** comment. If the pass fails, the report stays as prose and the reviewer can run **Attach findings**, a follow-up turn that gets `add_finding` (`toolsForTurn('attach')`).

A re-run first deletes the action's untouched proposals; accepted, kept and replied-to ones stay. Each run's closing message records a receipt of what moved on the branch since launch, or that the branch was rewritten.

**Command probe** (`engines/probe.ts`, `CommandProber`). When a review opens and a skill action is pinned, Limn spawns each spawnable adapter, opens a session (with the same `sessionMeta`), reads its one `available_commands_update`, and kills it: no prompt, no tokens. Results are cached per engine and repo in prefs and drive the per-engine marks in the launcher and Settings.

**Proposals** are comments with status `proposed` (or `dismissed`). They never count as unresolved and never enter a batch on their own; triage moves them to `queued` (accept), `resolved` (keep), `dismissed`, or back to `proposed` (`triageFindings`). A full generation's hotspots are proposals from the review run (`hotspots.ts`).

**Rebase** (`sendRebase`) is batch-shaped: always write-enabled, on the repo's lane, under the thread's execution mode, with `buildRebasePrompt` and none of the comment bookkeeping. The prompt forbids touching the base branch or pushing.

**Merge** (`merge.ts`) is native git, not an agent turn. `mergePreflight` evaluates the gates (merge-tree conflict probe, dirty base or branch worktree, stale approval, moved base). `mergeExecute` runs inside the repo's lane, re-checks the preflight, and lands the branch: a real merge in the base's worktree when it is checked out, otherwise ref moves guarded by compare-and-swap (`commit-tree` + `update-ref`). It then writes a terminal merged record. `markMerged` records a merge made outside Limn.

## Invariants & sharp edges

- **Concurrency:** one task at a time per repo, the rest queued in order (`OperationCoordinator`). The watch-mode poller checks `operations.repoBusy(repo)` and skips while a task holds the lane, so the app's own commits don't trigger a spurious reload. `EventQueue` is single-consumer.
- **Cancellation:** `EngineRun.cancel` answers pending permission requests `cancelled`, sends a `session/cancel` notification, and kills the adapter process group. A task cancelled while still queued leaves the queue without running. **There is no timeout** anywhere: a wedged run, or a parked approval, hangs until the user cancels.
- **Errors:** propagate as both an `{type:'error'}` event and a rejected `result`. Beyond the one repair turn for structured output, there is no retry or backoff.
- **Session resumption:** a turn whose thread has an `engineSessionId` resumes it. If that session is gone (CLI store pruned), the resume call rejects and the engine throws the typed `EngineSessionLostError`; the turn surfaces `ENGINE_SESSION_LOST`, telling the reviewer to start a new chat. **The thread is never auto-rebound or retried**, and its visible history stays intact. (A scoped update is the one exception: it retries once with a fresh session.) A thread that never produced the review has no id and is seeded fresh by design.
- **Write preconditions are enforced, not degraded:** a batch or rebase on a compare that is not a checked-out branch **throws** `Agent edits are unavailable because …` instead of silently degrading to read-only. Chat and action runs refuse outright when the branch is not checked out. Only a `refine` turn runs write-disabled by design.
- **Structured output is best-effort for both engines now:** no engine gets a native output-schema guarantee — the review payload rides prompt-embedded JSON, extracted by `parseJson` with one repair turn (see *Schema & validation*). One retry, then the op fails.
- **Adapters are pinned, protocol is pinned:** the engine runtime moves only when the adapter `package.json` pin moves (a deliberate bump guarded by tests + canaries); `initialize` hard-fails any adapter not negotiating protocol `1`. See [acp-adapters.md](acp-adapters.md).
