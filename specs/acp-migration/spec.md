# Migrate engine adapters to ACP (Agent Client Protocol)

## Status: DONE — Phases 0–3 shipped (both engines on AcpEngine; consolidation + packaging complete)

Phase 0 (spike), Phase 1 (AcpEngine + Claude cutover), Phase 2 (Codex cutover;
`codexAppServer.ts`/`codexMcp.ts`/`codex.ts`/`docs/codex-app-server.md` deleted), and
Phase 3 (consolidation) are all landed. Phase 3 result: `binaryEnv` feeds
`CLAUDE_CODE_EXECUTABLE`/`CODEX_PATH` from `binaries.ts`; direct `@anthropic-ai/
claude-agent-sdk` dep dropped (transitive-pinned via the adapter); adapters pinned
exact; electron-builder bundles adapters + JS SDKs and excludes the ~225M/~242M native
binaries (app 238M), verified by spawning both packaged adapters through a real
`initialize`; docs rewritten + `docs/acp-adapters.md` playbook added.

**Non-obvious finding:** codex-acp's only fallback when `CODEX_PATH` is unset is the
*bundled* `@openai/codex` binary — which packaging strips — so Codex hard-requires
`CODEX_PATH` (`CODEX_ACP_CONFIG.binaryRequired` + a `runAcpTurn` preflight). claude-
agent-acp self-discovers `claude`, so Claude does not.

Grounding pass done 2026-07-01. **Phase-0 spike run 2026-07-02** against the real
`@agentclientprotocol/claude-agent-acp@0.55.0` adapter + live `~/.claude` creds
(`scripts/acp-probe.ts`, output `scripts/acp-probe-out.json`, local and gitignored). Measured decisions
below govern implementation; where they contradict the draft body, the spike wins.

### Resolved decisions (Phase-0 spike, Claude)
- **Protocol version negotiated = `1`** (== `PROTOCOL_VERSION`). OQ10: hard-fail any
  adapter answering ≠1 (adopted).
- **`agentCapabilities.loadSession = true`**; `sessionCapabilities` also advertises
  `resume`, `fork`, `list`, `delete`, `close` → prefer cheaper `session/resume`
  (no replay) when present, else `session/load` with replay suppressed (D1/D6). OQ2
  (Claude): yes.
- **`mcpCapabilities.http = true`** (also `sse`) → OQ4: single localhost HTTP MCP
  host, no stdio-proxy shim needed for Claude. `mcpStdioProxy.ts` NOT built in Phase 1.
- **ACP mode ids** (from `newSession().modes.availableModes`): `auto`, `default`,
  `acceptEdits`, `plan`, `dontAsk`, `bypassPermissions` (all switchable via
  `setSessionMode`). **`modeFor` (Claude):** ask→`default`, edits→`acceptEdits`,
  auto→`acceptEdits`, full→`bypassPermissions`, read-only chat→`default` + client-side
  deny of edit requests (D3 confirmed). Native engine-`auto` DOES exist (Risk-4's
  "not exposed" was wrong) but `auto` still moves client-side for cross-engine uniformity.
- **Model/effort passthrough (OQ6, Claude):** model via **`ANTHROPIC_MODEL` spawn env**
  (per-turn, one-process-per-turn makes this exact); reasoning effort via
  **`setSessionConfigOption({ configId: 'effort', … })`** post-`session/new` (opts:
  default/low/medium/high/xhigh/max) — there is no effort env var. `configOptions` also
  exposes `model` (opus/fable/sonnet/haiku) as an alternative; env is primary.
- **`config_option_update`** is an ADDITIONAL `session/update` discriminator the adapter
  emits (mode/model/effort publication) — add it to D2's ignored row alongside
  `current_mode_update`/`available_commands_update`/`usage_update`.
- **`authMethods: []`** (already authenticated via `~/.claude`) — no `authenticate` step.
- Canonical client wiring: `@agentclientprotocol/sdk` `ClientSideConnection(toClient, ndJsonStream(child.stdin-web, child.stdout-web))` — mirror in `acp.ts` (see `scripts/acp-probe.ts`).
- **Deferred to Phase-2 spike** (Codex adapter not yet installed): OQ1 (codex-acp
  production-readiness), OQ2/OQ4/OQ6 for Codex. Phase 1 is Claude-only; Codex stays on
  `codexAppServer.ts` behind the `ReviewEngine` seam.
- Non-spike OQs adopted per recommendation: OQ3 schema-in-prompt + one repair turn (both
  engines, D5); OQ5 conservative `isSafeCommand` allowlist; OQ8 per-turn process; OQ9 keep
  Settings adapter-path override.
- **OQ7 REFINED by user (2026-07-02): bundle the JS, not the native binaries.**
  Bundle the ACP adapters (`claude-agent-acp`, `codex-acp`) AND the JS SDK glue
  (`@anthropic-ai/claude-agent-sdk`) into the `.app`; do NOT bundle native BINARIES.
  **BOTH engines drive a native binary — Claude via the claude-code executable, Codex via
  the codex binary — and NEITHER is bundled**; resolve both from the user's PATH or a
  Settings path (Claude is NOT self-contained: the Claude Agent SDK spawns the claude-code
  CLI, exactly as today's `binaries.ts` PATH-resolves `claude` and electron-builder strips
  the SDK's bundled CLI). **Concrete mechanism, verified in the installed adapters:**
  `claude-agent-acp` reads `pathToClaudeCodeExecutable = process.env.CLAUDE_CODE_EXECUTABLE
  ?? claudeCliPath()` → set **`CLAUDE_CODE_EXECUTABLE`**; `codex-acp` reads
  `codexPath = process.env.CODEX_PATH ?? 'codex'` → set **`CODEX_PATH`**. Both env vars
  ride the existing `AcpEngineConfig.env(turn)` → `spawnAdapter` seam (already carries
  `ANTHROPIC_MODEL`). Phase 3: source the binary paths from `binaries.ts` (PATH probe +
  `ENGINE_PATH_PREF_KEYS` Settings prefs), add them to each config's `env`, and configure
  `electron-builder` to bundle the adapters + JS SDKs while EXCLUDING the native binaries
  (claude-code executable + `@openai/codex` binary). `binaries.ts` is NOT retired — it
  feeds `CLAUDE_CODE_EXECUTABLE`/`CODEX_PATH`.

---

## Status: Draft — awaiting answers to open questions (original draft below)

Grounding pass done 2026-07-01: all cited Limn files re-read and verified; external
claims carry source URLs with fetch dates. Nothing here is implemented.

## Problem / Motivation (evidence)

Limn drives two engines through two completely different integration styles, and a
third would add a third:

- **Claude** — in-process `@anthropic-ai/claude-agent-sdk` (`^0.3.173`,
  `package.json:31`) in `src/main/engines/claude.ts` (240 lines). Session resume via
  the SDK `resume` option, structured output via `outputFormat: json_schema`
  (`claude.ts:180`), custom tools mounted as an in-process MCP server
  (`createSdkMcpServer`, `claude.ts:56-67`), approvals via the `canUseTool` callback
  → `awaitDecision` registry (`claude.ts:35-49`, `src/main/engines/approvals.ts`).
- **Codex** — a hand-written, reverse-engineered `codex app-server` JSON-RPC-over-stdio
  client: `src/main/engines/codexAppServer.ts` (513 lines) + a per-turn localhost
  streamable-HTTP MCP server for the same custom tools (`codexMcp.ts`, 80 lines) +
  `codex.ts` with a 3-fallback JSON extractor (`parseJson`: direct parse → fence-strip
  → balanced-brace slice, `codex.ts:7-41`) because the text path around `outputSchema`
  is fragile. The protocol contract lives in `docs/codex-app-server.md` (226 lines),
  pinned by hand against `codex app-server generate-ts` output ("Verified: 2026-06-25,
  against Codex app-server 0.139.0") and re-verified manually on every Codex bump.

Concrete pain this migration removes:

1. **Protocol maintenance burden.** `codexAppServer.ts` + `docs/codex-app-server.md`
   track an *undocumented* protocol that has already broken across versions (the doc
   records a 0.135 → 0.139 migration that removed the legacy approval methods and
   changed the decision vocabulary). Every Codex CLI update is a potential silent break.
2. **Dual tool hosting.** The same 9 read/annotation tools (`tools.ts`, `LIMN_TOOLS`)
   are hosted two ways: in-process SDK MCP for Claude (`claude.ts:56`), per-turn
   localhost HTTP MCP for Codex (`codexMcp.ts`). Two code paths, two failure modes
   (see the `mcpServer/elicitation/request` auto-accept workaround in
   `codexAppServer.ts:437-446`).
3. **Divergent approval semantics — a known product bug.** The four-tier ladder
   (`ask/edits/auto/full`, `src/shared/executionMode.ts`) means different things per
   engine at the `auto` tier: Claude gets `permissionMode: 'auto'` (the SDK decides
   which ops are safe), Codex gets `codexApprovalPolicy: 'on-failure'` (asks only when
   a sandboxed attempt *fails*). The reviewer-facing copy — "Only asks for actions
   detected as potentially unsafe" — is true for neither engine consistently.
4. **No version pinning.** `binaries.ts` resolves `claude`/`codex` from the user's
   PATH only ("Nothing is bundled", `binaries.ts:6-9`;
   `electron-builder.yml:12-16` explicitly strips the SDK's bundled CLI). Any user CLI
   update can change protocol behavior under Limn with no compatibility gate.
5. **Two event mappers.** `toEvents` (Claude SDK messages, `claude.ts:98-128`) and
   `appServerNotifToEvent`/`appServerItemToEvent` (Codex notifications,
   `codexAppServer.ts:111-208`) both target the same `EngineEvent` union
   (`src/shared/types.ts:215-222`); every renderer feature (tool chips, approval
   cards) is implemented and tested twice.

ACP is an open, versioned, documented protocol that standardizes exactly this seam —
sessions, prompt turns, streaming updates, permission requests, MCP passthrough —
with maintained adapters for both engines, distributed as **pinnable npm packages**.

## External research findings (with sources + dates)

All fetched/searched 2026-07-01 unless noted.

### 1. ACP protocol state

- **Protocol version: `1`** — "a single integer that identifies a MAJOR protocol
  version"; client sends its latest, agent echoes it or answers with its own latest;
  mismatch → close. Source: https://agentclientprotocol.com/protocol/initialization
- **Transport:** JSON-RPC 2.0; local agents run as a subprocess speaking NDJSON over
  stdio (this is how Zed drives adapters). Sources:
  https://agentclientprotocol.com/protocol/overview , https://zed.dev/acp
- **Lifecycle:** `initialize` → (`authenticate`) → `session/new` | `session/load` →
  `session/prompt` (repeat) ; `session/cancel` notification interrupts. Source:
  https://agentclientprotocol.com/protocol/overview
- **`session/new`:** params `cwd` (absolute, required) + `mcpServers` (optional array).
  Returns `sessionId`. **`session/load`:** params `sessionId`, `cwd`, `mcpServers`;
  gated by the agent's `loadSession: true` capability; the agent "MUST replay the
  entire conversation to the Client in the form of `session/update` notifications"
  **before** responding to the load request. Newer agents may additionally support
  `session/resume` (restore context *without* history replay) via
  `sessionCapabilities.resume`. Source:
  https://agentclientprotocol.com/protocol/session-setup
- **Prompt turn:** `session/prompt` takes `sessionId` + `prompt` (ContentBlock array),
  returns `stopReason ∈ end_turn | max_tokens | max_turn_requests | refusal |
  cancelled`. Progress streams as `session/update` notifications with discriminator
  `sessionUpdate ∈ plan | agent_message_chunk | agent_thought_chunk | tool_call |
  tool_call_update | usage_update | available_commands_update | current_mode_update`.
  Source: https://agentclientprotocol.com/protocol/prompt-turn
- **Tool calls:** `toolCallId`, `title`, `kind ∈ read | edit | delete | move | search |
  execute | think | fetch | other`, `status ∈ pending | in_progress | completed |
  failed`, `rawInput`/`rawOutput`, `content` (text blocks | `diff {path, oldText,
  newText}` | `terminal`), `locations [{path, line?}]`. `tool_call_update` is sparse —
  only `toolCallId` required. Source: https://agentclientprotocol.com/protocol/tool-calls
- **Permission requests:** agent → client method `session/request_permission`,
  carrying the tool call + an `options` array (`optionId` + kind, e.g. `allow_once` /
  `reject_once`); client answers with the chosen `optionId`, or a `cancelled` outcome
  for requests pending at turn-cancel. Source:
  https://agentclientprotocol.com/protocol/prompt-turn
- **Session modes:** advertised in the `session/new` response (`modes: {currentModeId,
  availableModes[{id, name, description?}]}`); mode ids are **agent-defined, not
  standardized**; client switches via `session/set_mode`; agent-initiated switches
  arrive as `current_mode_update`. ⚠ The docs note "Dedicated session mode methods
  will be removed in a future version" in favor of **Session Config Options** — churn
  risk, isolate behind one function. Source:
  https://agentclientprotocol.com/protocol/session-modes
- **MCP passthrough:** `mcpServers` entries are stdio (`{name, command, args, env}` —
  support required) or HTTP (`{type: "http", name, url, headers}` — gated on the
  agent's `mcpCapabilities.http`); SSE exists but is deprecated. Source:
  https://agentclientprotocol.com/protocol/session-setup ,
  https://agentclientprotocol.com/protocol/initialization
- **Client capabilities** (`fs.readTextFile/writeTextFile`, `terminal`) are optional —
  Limn can decline them all and let agents use their own file/shell tools, as today.
  Source: https://agentclientprotocol.com/protocol/initialization
- **Client library:** `@agentclientprotocol/sdk` v1.1.0 (TypeScript, Apache-2.0,
  repo `agentclientprotocol/typescript-sdk`, published by Zed Industries; ships
  `schema/schema.json` + experimental HTTP/WS transports). Source:
  https://registry.npmjs.org/@agentclientprotocol/sdk/latest

### 2. Claude adapter: `@agentclientprotocol/claude-agent-acp`

- Repo `agentclientprotocol/claude-agent-acp` (previously
  `zed-industries/claude-agent-acp`, née `claude-code-acp`): **2.2k stars, 116
  releases, latest v0.54.1 (June 2026), actively maintained, TypeScript.** Feature
  list: tool calls **with permission requests**, client MCP servers, edit review,
  terminals, slash commands. Sources: https://github.com/zed-industries/claude-agent-acp ,
  https://github.com/agentclientprotocol/claude-agent-acp
- npm `@agentclientprotocol/claude-agent-acp` v0.54.1, bin `claude-agent-acp`,
  **pins `@anthropic-ai/claude-agent-sdk` at exact `0.3.197`** and
  `@agentclientprotocol/sdk` `1.1.0`. Apache-2.0. This is the version-pinning surface:
  bumping the adapter in `package.json` bumps the engine deliberately. Source:
  https://registry.npmjs.org/@agentclientprotocol/claude-agent-acp/latest
- **Permission modes** map through: `default` (ask), `acceptEdits`, `bypassPermissions`
  (disabled when running as root); Zed's agent panel switches them at runtime, i.e.
  they surface as ACP session modes; Plan mode arrived later. Known Zed-side bug where
  the Bypass selection reverts (zed#39392) — mode state must be re-asserted per
  turn/session by the client, which Limn does anyway. Sources:
  https://zed.dev/blog/claude-code-via-acp ,
  https://github.com/zed-industries/zed/issues/39392
- **Session load:** the adapter persists SDK sessions and on `loadSession` "replays
  the session history from the JSONL file"; `resumeSession` (no replay) also exists in
  its session lifecycle. Source (community-maintained architecture doc for the
  adapter): https://deepwiki.com/zed-industries/claude-code-acp/4.3-session-lifecycle-management
- **Reasoning effort** is configurable through the adapter (`low/medium/high/max` +
  default; an open issue asks for newer levels — i.e. effort passthrough exists
  today). Source: https://github.com/agentclientprotocol/claude-agent-acp/issues/725
- **Structured output (`outputFormat: json_schema`) is NOT reachable**: neither the
  ACP schema (no output-schema field on `session/prompt`) nor the adapter README/issues
  mention exposing the SDK's `outputFormat`. Searched 2026-07-01
  ("claude-agent-acp structured output outputFormat json schema") — no support found.
  Structured review generation must move to schema-in-prompt + client-side validation
  (see Detailed design). Sources: https://agentclientprotocol.com/protocol/prompt-turn ,
  https://github.com/agentclientprotocol/claude-agent-acp

### 3. Codex ACP story — an adapter EXISTS and is org-maintained

- `zed-industries/codex-acp` (Rust, wraps Codex; 57 releases, v0.16.0 June 2026)
  carries the notice **"Development is moving to `agentclientprotocol/codex-acp`"**.
  Sources: https://github.com/zed-industries/codex-acp ,
  https://zed.dev/blog/codex-is-live-in-zed
- The successor **npm `@agentclientprotocol/codex-acp` v1.0.2 (published 2026-06-29,
  provenance-attested via GitHub Actions OIDC)** is TypeScript, bin `codex-acp`, and
  **pins `@openai/codex` at `^0.142.4`** as a dependency — so the Codex CLI itself
  becomes an npm-pinned artifact too. Features: permission requests + approval
  workflows, modes **`read-only` / `agent` / `agent-full-access`**, **MCP servers via
  both stdio and HTTP**, ChatGPT/API-key auth. Sources:
  https://github.com/agentclientprotocol/codex-acp ,
  https://registry.npmjs.org/@agentclientprotocol/codex-acp/latest
- Maturity caveats: v1.0.x is weeks old as a TS rewrite of the Rust adapter; the
  ecosystem shows real resume bugs at the codex layer (JetBrains ACP: `session/resume`
  fails "no rollout found for thread id", openai/codex#11693). Session load/resume is
  implemented in the codex ACP ecosystem (history replay before responding to
  `session/load` is called out as the reference behavior for the Codex ACP server),
  but Limn must verify it empirically in the Phase-0 spike. Sources:
  https://github.com/openai/codex/issues/11693 ,
  https://github.com/NousResearch/hermes-agent/pull/26957 (references "every other
  reference ACP server (Codex, Claude Code, …) replays history BEFORE responding to
  the load request")
- Verdict for the load-bearing question (Open question 1): **an official-track,
  maintained Codex ACP adapter exists** under the same org as the protocol and the
  Claude adapter. It is *young*. The spec therefore phases Codex second, behind
  explicit exit criteria, with `codexAppServer.ts` kept intact behind the
  `ReviewEngine` seam until those criteria pass.

### 4. MCP transport through ACP

Confirmed above: stdio config support is mandatory for agents; HTTP is capability-gated
(`mcpCapabilities.http`). `@agentclientprotocol/codex-acp` documents both; Codex CLI
already consumes Limn's streamable-HTTP server today (`codexMcp.ts`), and the Claude
SDK supports HTTP MCP servers natively, so the expectation is both adapters advertise
`mcpCapabilities.http` — **verify in the spike**; if either doesn't, fall back to a
~30-line stdio→HTTP proxy entry point (spawned by the agent, forwarding to Limn's
localhost server). Sources: https://agentclientprotocol.com/protocol/session-setup ,
https://github.com/agentclientprotocol/codex-acp

### 5. Session persistence / resume

`session/load` (capability `loadSession`) restores a session by id with full history
replay before the response; `session/resume` (newer, `sessionCapabilities.resume`)
restores without replay. Both adapters persist sessions on disk keyed by the same ids
their engines use natively (Claude JSONL sessions; Codex threads/rollouts) — Zed
imports existing agent threads through this. Mapping onto Limn's `engineSessionId`
model is §Detailed design. Sources:
https://agentclientprotocol.com/protocol/session-setup ,
https://zed.dev/docs/ai/external-agents ,
https://deepwiki.com/zed-industries/claude-code-acp/4.3-session-lifecycle-management

## Goals / Non-goals

### Goals

1. One `AcpEngine implements ReviewEngine` drives every engine; per-engine code shrinks
   to a small config record (adapter command, mode-id mapping, quirks).
2. Adapters (and through them the engine runtimes) become **pinned npm dependencies**;
   engine upgrades are deliberate `package.json` bumps guarded by tests.
3. **Uniform approval semantics**: the four tiers mean exactly the same thing on every
   engine, decided in one Limn-owned policy function at the ACP
   `session/request_permission` layer.
4. One tool-hosting path: `LIMN_TOOLS` served from a single localhost MCP server,
   passed to every agent via the ACP `mcpServers` param.
5. Delete the reverse-engineered Codex protocol client and its shadow documentation.
6. Existing reviews/threads keep working; persisted `engineSessionId`s resume when the
   adapter can load them and degrade gracefully (seeded fresh session) when not.

### Non-goals

- No renderer/UX changes: `EngineEvent`, approval cards, tool chips, the tier picker
  copy all stay as-is (the `auto` tier finally *matches* its copy).
- No new engines in this change (the point is that adding one later is ~a config record).
- No adoption of ACP client `fs`/`terminal` capabilities (agents keep using their own
  tools against the worktree, as today).
- No move off `EngineRun`/`EventQueue` (`types.ts:45-89`) — the seam consumed by
  `ipc.ts` `pumpEvents` (`ipc.ts:147`) is untouched.
- Not switching chat/generation prompts (`prompts.ts`) or the review wire schema
  (`schema.ts`).

## Target architecture

```
                       ┌───────────────────────────── Electron main ─────────────────────────────┐
 ipc.ts (unchanged)    │                                                                          │
  sendChat/sendBatch ──►  makeEngine(id) ──► AcpEngine(engineConfig[id])          approvals.ts    │
  generateReview       │        │                 │                                (unchanged)    │
                       │        │                 │ spawn per turn (ELECTRON_RUN_AS_NODE)         │
                       │        │                 ▼                                               │
                       │        │        AcpConnection (@agentclientprotocol/sdk, stdio NDJSON)   │
                       │        │                 │ initialize → session/new|load → set_mode      │
                       │        │                 │ → session/prompt                              │
                       │        │                 ▼                                               │
                       │        │   ┌─ claude-agent-acp (npm, pins agent-sdk 0.3.197) ─ claude    │
                       │        │   └─ codex-acp        (npm, pins @openai/codex 0.142) ─ codex   │
                       │        │                 │                                               │
                       │        │                 │ session/update ─► acpToEvents ─► EventQueue   │
                       │        │                 │ session/request_permission ─► ladderPolicy    │
                       │        │                 │       ├─ auto-answer (tier rules)             │
                       │        │                 │       └─ awaitDecision → approval card        │
                       │        │                 ▼                                               │
                       │        │        mcpHost.ts — ONE localhost streamable-HTTP MCP server    │
                       │        │        (generalized codexMcp.ts) serving LIMN_TOOLS,            │
                       │        │        per-turn token path, passed via mcpServers[]             │
                       └──────────────────────────────────────────────────────────────────────────┘
```

Key structural decisions:

- **One adapter process per turn**, spawned at turn start, killed at turn end — this
  matches today's lifecycle exactly (Claude: one `query()` per turn; Codex: one
  `AppServerConn` per turn, `codexAppServer.ts:404`), keeps cancel = process-group
  kill, and lets per-turn model/effort be passed as spawn env/config. Cross-turn
  continuity comes from `session/load`, exactly as Codex continuity comes from
  `thread/resume` today. (Per-thread process reuse is a later optimization — Open
  question 8.)
- Adapters are **spawned via Electron's own Node** (`process.execPath` +
  `ELECTRON_RUN_AS_NODE=1`, argv = the adapter's `dist/index.js` from
  `node_modules`) — no reliance on a user Node install.
- `binaries.ts` PATH resolution is retired for engine protocol purposes. Engine
  *auth* still comes from the user's `~/.claude` / `~/.codex` (both adapters use the
  standard credential locations). A Settings escape hatch to point at a different
  adapter build is kept (Open question 9).
- `executionMode.ts`'s `EnginePolicy` becomes `{acpModeId per engine}` + one shared
  client-side `ladderPolicy(mode, approvalRequest) → 'allow' | 'deny' | 'ask'`.

## Detailed design

### D1. `AcpEngine`

```ts
// src/main/engines/acp.ts
interface AcpEngineConfig {
  id: EngineId
  adapterEntry: string                       // resolved node_modules path to dist/index.js
  modeFor: (mode: ExecutionMode, writeEnabled: boolean) => string  // ACP session mode id
  env?: (turn: { model?: string; reasoningEffort?: ReasoningEffort }) => Record<string, string>
}
export class AcpEngine implements ReviewEngine { … }
```

`generateReview(req)` and `chat(turn)` share one `runAcpTurn` (mirror of
`runAppServerTurn`, `codexAppServer.ts:385`):

1. If `turn.tools`: `mcpHost.registerTurn(host)` → `{url, release}` (same contract as
   `registerCodexTurn`, `codexMcp.ts:49`).
2. Spawn adapter (detached, own process group — same reasoning as
   `codexAppServer.ts:238-241`).
3. `initialize` with `protocolVersion: 1`, client capabilities `{fs: {readTextFile:
   false, writeTextFile: false}, terminal: false}`. Check the response's
   `agentCapabilities.loadSession` and `mcpCapabilities.http`.
4. `session/load(engineSessionId)` when resuming *and* `loadSession` is advertised;
   on load error or missing capability → `session/new` and treat the turn as seeded
   (the caller already handles this: `ChatTurn.context` seeds a fresh session,
   `types.ts:22-24`, `ipc.ts:552-554`). **Replay suppression:** all `session/update`
   for the session are dropped until the `session/load` response resolves — replay is
   history Limn already has in its own DB.
5. `session/set_mode(modeFor(executionMode, writeEnabled))` (ignore method-not-found —
   forward-compat with the announced move to Session Config Options).
6. `session/prompt` with the built prompt as a single text ContentBlock.
7. Stream `session/update` → `acpToEvents` → `EventQueue.push`; answer
   `session/request_permission` via `ladderPolicy` (D3).
8. Prompt response: `end_turn` → push `{type:'done'}`, resolve
   `{value, sessionId}`; `cancelled` → settle as cancelled (the `aborted` sentinel
   dance from `codexAppServer.ts:393-415` carries over); `refusal`/`max_*` → error.
9. `finally`: close queue, kill process group, `release()` the MCP turn.

`cancel()` sends `session/cancel`, then kills the process group after a short grace
(ACP requires answering pending permission requests with `cancelled` — do that from
`clearPending`-equivalent before teardown).

### D2. Event mapping — ACP `session/update` ↔ `EngineEvent`

`EngineEvent` union (`src/shared/types.ts:215-222`) is unchanged. One pure mapper
`acpToEvents(update): EngineEvent[]` (unit-tested like `toEvents` /
`appServerNotifToEvent` today):

| ACP incoming | `EngineEvent` | Notes |
|---|---|---|
| `agent_message_chunk` (text content) | `{type:'text', text}` | streamed; suppressed for structured-generation turns exactly like `streamText:false` today (`codexAppServer.ts:390,428`) |
| `agent_thought_chunk` | `{type:'status', text: chunk.slice(0,160)}` | same treatment as Codex reasoning deltas (`codexAppServer.ts:116-118`) |
| `plan` | `{type:'status', text: 'plan: <n> steps'}` | Limn has no plan UI; keep visible as status |
| `tool_call` (status `pending`/`in_progress`) | `{type:'tool', call:{id: toolCallId, verb: verbOf(kind), name: title, arg: primaryLocation/rawInput arg, kv: kvOf(rawInput), state:'run'}}` | `verbOf`: read→`read`, search→`grep`, edit/delete/move→`edit`, execute→`bash`, think/fetch/other→`other` (reuses `deriveVerb` heuristics on `title` when kind is `other`) |
| `tool_call_update` status `completed` | `{type:'tool', call:{id, state:'ok', out/outMore: clampOut(text of content ∪ rawOutput)}}` | sparse update; same fold-by-id contract `reduceToolCalls` expects (`shared/types.ts:156-158`) |
| `tool_call_update` status `failed` | `{type:'tool', call:{id, state:'err', out}}` | |
| `tool_call_update` `content: diff` | fold into the same tool event; `verb:'edit'`, `arg: path`, `meta: 'N files'` | replaces `appServerItemToEvent`'s fileChange branch (`codexAppServer.ts:202-206`) |
| `current_mode_update`, `available_commands_update`, `usage_update` | ignored (`null`) | |
| `session/request_permission` (agent→client *request*, not an update) | `{type:'approval_request', request}` via `awaitDecision` when the ladder says ask (D3) | |
| prompt response `end_turn` | `{type:'done'}` | |
| prompt response `refusal` / `max_tokens` / `max_turn_requests` | `{type:'error', message}` | |
| transport/adapter death mid-turn | `{type:'error'}` unless cancel-initiated | port of `onExit` settling (`codexAppServer.ts:415`) |

`{type:'action'}` events are untouched: they are emitted by the tool host itself
(`tools.ts:333`), which keeps running in main behind the MCP server — the actions
path does not travel through ACP at all.

### D3. Permission ladder — uniform semantics (fixes the known `auto` divergence)

Two layers, deliberately:

**(a) Baseline engine mode** — set once per session via `session/set_mode`, chosen so
the engine is *permissive enough* that everything Limn may want to allow is possible,
and *restrictive enough* that everything Limn may want to gate produces a
`session/request_permission` instead of silently executing:

| Tier | claude-agent-acp mode | codex-acp mode | rationale |
|---|---|---|---|
| `ask` | `default` | `read-only` | everything non-read asks |
| `edits` | `acceptEdits` | `agent` | edits auto-apply engine-side; commands ask |
| `auto` | `acceptEdits` | `agent` | **not** the engines' own "auto" — safety judgment moves to Limn (b) |
| `full` | `bypassPermissions` | `agent-full-access` | nothing asks |
| read-only chat turn (`writeEnabled` false) | `default` + client-side deny of edit requests | `read-only` | replaces `disallowedTools: ['Edit','Write']` (`claude.ts:219`) — ACP has no tool-disable knob, so denial is enforced at the permission layer |

(Exact mode ids verified in the Phase-0 spike; `modeFor` is the only place they live.
Mode ids are agent-defined per the spec — source:
https://agentclientprotocol.com/protocol/session-modes)

**(b) One shared decision function** — runs in Limn on every incoming
`session/request_permission`, identical for every engine:

```ts
// src/shared/approvalPolicy.ts  (new; pure; unit-tested)
function ladderPolicy(mode: ExecutionMode, req: ApprovalRequest, writeEnabled: boolean):
  'allow' | 'deny' | 'ask'
```

| Tier | limn MCP tools | `file_change` | `command` (safe) | `command` (unsafe) | other `tool_use` |
|---|---|---|---|---|---|
| `ask` | allow | ask | ask | ask | ask |
| `edits` | allow | allow | ask | ask | ask |
| `auto` | allow | allow | **allow** | **ask** | ask |
| `full` | allow | allow | allow | allow | allow |

- The request is first normalized to Limn's `ApprovalRequest`
  (`shared/types.ts:197-211`) from the ACP payload: tool call `kind === 'execute'` →
  `kind:'command'` (command text from `rawInput`/`title`); `kind ∈ edit|delete|move`
  or diff content → `kind:'file_change'` (files from `locations[].path`); else
  `kind:'tool_use'`. This replaces both `toApprovalRequest` (`claude.ts:19-31`) and
  `approvalRequestFromParams` (`codexAppServer.ts:99-106`).
- *safe command* is defined by a Limn-owned conservative classifier
  (`isSafeCommand(cmd)`: allowlist of read/build/test verbs — `git status/log/diff`,
  `ls`, `cat`, `grep`, `rg`, package-manager `test`/`typecheck`/`lint` scripts, etc.;
  anything with network, `sudo`, redirects into files outside the worktree, `git
  push`, `rm`, or unrecognized verbs → unsafe). This single definition is what makes
  `auto` **mean the same thing on both engines** — the tier's copy ("Only asks for
  actions detected as potentially unsafe") finally holds, with "detected" defined by
  Limn, not by two different engine heuristics.
- `ask` results park on `awaitDecision(opId, request, emit)` — `approvals.ts` is
  reused byte-for-byte; the renderer approval flow (`ipc.ts:501-503`
  `respondApproval` → `resolveDecision`) is untouched. Decision `allow` → answer with
  the option whose kind is `allow_once`; `deny` → `reject_once`; op cancel → the
  ACP-required `cancelled` outcome for all pending requests.
- `allow_always`/`reject_always` options are ignored (Limn's model is per-operation
  only, `shared/types.ts:212-213`).

### D4. Tool hosting — one MCP server

`codexMcp.ts` is renamed/generalized to `src/main/engines/mcpHost.ts` with the same
per-turn contract (`registerTurn(host) → {url, release}`; unguessable UUID path
token; DNS-rebinding protection; loopback only — all existing hardening at
`codexMcp.ts:60-69` carries over). Every ACP session gets:

```jsonc
mcpServers: [{ "type": "http", "name": "limn", "url": "http://127.0.0.1:<port>/mcp/<token>", "headers": [] }]
```

- Claude's in-process `createSdkMcpServer` path (`claude.ts:56-67`) is deleted; the
  dual-hosting duplication (`tools.ts:7-9` comment) collapses to one host.
- `allowedTools`/`limnAllowedToolNames()` has no ACP equivalent; instead limn-tool
  permission requests (name-prefixed `limn`/`mcp__limn__` depending on adapter) are
  auto-allowed by `ladderPolicy` row 1 — same effect as today's auto-allow
  (`claude.ts:40`, `codexAppServer.ts:437-446`), and the fragile Codex elicitation
  auto-accept workaround disappears with the code that needed it.
- If the spike finds an adapter without `mcpCapabilities.http`: add
  `src/main/engines/mcpStdioProxy.ts` (tiny stdio↔HTTP bridge started by the agent
  from the `mcpServers` stdio config, forwarding to the same localhost URL).

### D5. Structured output strategy (per engine)

ACP has no output-schema channel (research §2), so `generateReview` converges on one
strategy for both engines:

1. `buildReviewPrompt(req)` gains a structured-output epilogue: the JSON Schema
   (`reviewJsonSchema`, `schema.ts:59`) inlined, plus "respond with a single JSON
   object only, no fences, no prose".
2. Text is collected (streaming suppressed, as `streamText:false` does today).
3. Extraction: `parseJson` moves from `codex.ts:30-41` to
   `src/main/engines/structured.ts` unchanged (direct parse → fence strip → balanced
   slice) and now serves both engines, then `parseReviewOutput` zod-validates.
4. **One automatic repair turn**: on extraction/zod failure, send a follow-up
   `session/prompt` on the same session — "your output failed validation: <zod
   issues>; reply with only the corrected JSON" — then re-parse. One retry, then fail
   (the ZodError → friendly-message path in `ipc.ts:468-472` still applies). This
   replicates what the Claude SDK's `outputFormat` did engine-side (the SDK
   "validates the output against it, re-prompting on mismatch" — source:
   https://code.claude.com/docs/en/agent-sdk/structured-outputs).

Per-engine deltas: **Claude** loses SDK-native `structured_output` (claude.ts:148) —
regression risk covered by the repair turn; **Codex** loses the app-server
`outputSchema` turn param (`codexAppServer.ts:470`) — but Codex output already needed
the 3-fallback parser even *with* `outputSchema`, so the practical delta is small.
The schema constraints comment in `schema.ts:4-9` (no prefixItems, OpenAI strict
quirks) stays valid since the same schema is now prompt-embedded.

### D6. Session resume — mapping ACP onto `engineSessionId`

Limn's model (verified): threads store `engineSessionId`; `sendChat`/`sendBatch`
resume it when present, else seed with `ChatContext` and persist the new id afterward
(`ipc.ts:542-576` chat, `ipc.ts:669-692` batch, `ipc.ts:451` review-thread binding;
`dao.setThreadEngineSession` at 451/576/692).

Under ACP: **`engineSessionId` := ACP `sessionId`**, no schema change, no migration.

- New session → `session/new` returns `sessionId` → persisted exactly where the SDK
  session id / codex thread id is persisted today.
- Resume → `session/load(sessionId)` with replay suppressed (D1 step 4).
- **Existing persisted ids** (pre-migration Claude SDK session ids / Codex thread
  ids): both adapters key their sessions by the engine-native ids (research §5), so
  old ids are *expected* to load — but this is spike-verified, not assumed. Failure
  path is already graceful and already exercised: `session/load` error → `AcpEngine`
  falls back to `session/new` + seeded context, the same behavior a cross-agent chat
  gets today (`types.ts:22-24`). Worst case: old threads lose deep engine memory but
  keep their full Limn-side history and review context. No data is invalidated.
- `sessionCapabilities.resume` (no replay) is used instead of `session/load` when
  advertised — cheaper; optional optimization, capability-gated.

### D7. Execution-mode module changes

`src/shared/executionMode.ts`: `EnginePolicy {claudePermissionMode,
codexApprovalPolicy, codexSandbox}` and `POLICY` are replaced by (a) the per-engine
`modeFor` tables (they live with `AcpEngineConfig` in main, since mode ids are
adapter-specific) and (b) the shared `ladderPolicy` + `isSafeCommand` in
`src/shared/approvalPolicy.ts`. `EXECUTION_TIERS`, `ExecutionMode`,
`isExecutionMode`, `DEFAULT_EXECUTION_MODE` are unchanged (renderer copy unchanged).

## What is deleted / what remains

### Deleted (net ≈ −900 lines of protocol code + 226 lines of shadow docs)

| Artifact | Why |
|---|---|
| `src/main/engines/codexAppServer.ts` (513) | replaced by `AcpEngine` + adapter |
| `src/main/engines/claude.ts` (240) | replaced by `AcpEngine` (Phase 1) |
| `src/main/engines/codex.ts` (71) | engine shell gone; `parseJson` moves to `structured.ts` |
| `src/main/engines/codexMcp.ts` (80) | generalized → `mcpHost.ts` (moved, not lost) |
| `docs/codex-app-server.md` (226) | the protocol it documents is no longer spoken |
| `tests/codex-app-server.test.ts`, `tests/codex-events.test.ts` (81+81) | test the deleted mappers |
| `tests/codex-json.test.ts` (17) | follows `parseJson` → becomes `structured.test.ts` |
| `engines.test.ts` Claude-specific suites (`toEvents`, `makeCanUseTool`, `toApprovalRequest` — lines 180-267) | replaced by `acpToEvents`/`ladderPolicy` suites |
| `binaries.ts` PATH-probing role for protocol clients | adapters resolve from `node_modules`; file shrinks to the settings-override escape hatch (or is folded into `adapters.ts`) |
| `@anthropic-ai/claude-agent-sdk` direct dependency | arrives pinned inside `claude-agent-acp` |
| electron-builder excludes for the SDK CLI (`electron-builder.yml:12-16`) | inverted: adapters are now deliberately packaged |

### Remains (unchanged unless noted)

- `types.ts` (`ReviewEngine`, `EngineRun`, `EventQueue`), `approvals.ts`, `tools.ts`
  (minus the "hosted two ways" comment), `prompts.ts` (plus the structured epilogue),
  `schema.ts`, `validate.ts`, `fake.ts`, `index.ts` (`makeEngine` now returns
  `AcpEngine` configs).
- `ipc.ts` — zero changes to the engine seam (`pumpEvents`, `respondApproval`,
  session-id persistence).
- `EngineEvent` union and every renderer consumer.
- `executionMode.ts` tier list + type; policy internals replaced per D7.

### New

`acp.ts` (engine), `acpEvents.ts` (pure mapper), `shared/approvalPolicy.ts`
(ladder + safe-command classifier), `mcpHost.ts` (from codexMcp), `structured.ts`
(from codex.ts), `adapters.ts` (adapter entry resolution + spawn helper),
`tests/helpers/fakeAcpAgent.ts`, new deps: `@agentclientprotocol/sdk`,
`@agentclientprotocol/claude-agent-acp`, `@agentclientprotocol/codex-acp`.

## Phasing plan

**Phase 0 — spike (timeboxed, ~1–2 days).** A scripted probe (`scripts/acp-probe.ts`)
runs both adapters headlessly and records: initialize capabilities
(`loadSession`, `mcpCapabilities.http`, `sessionCapabilities`), advertised mode ids
per tier, whether a pre-existing native session id loads via `session/load`
(Claude SDK id + Codex thread id from a real Limn DB), model/effort passthrough
mechanism, and a full permission round-trip per adapter. Deliverable: answers to Open
questions 1, 2, 4, 6 recorded in this spec.

**Phase 1 — AcpEngine + Claude cutover.** Build `acp.ts`, `acpEvents.ts`,
`approvalPolicy.ts`, `mcpHost.ts`, `structured.ts`, FakeAcpAgent tests. Flip
`makeEngine('claude')` to `AcpEngine`. Codex stays on `codexAppServer.ts` untouched
(the seam guarantees coexistence). Claude-first because the Claude path is the
simpler port (no protocol reverse-engineering to preserve) and `claude-agent-acp` is
the mature adapter (116 releases vs v1.0.x) — it derisks `AcpEngine` itself before
the younger Codex adapter is in the loop. Exit: all engine tests green, manual smoke
of generate/chat/batch/approvals/cancel/resume on Claude, packaged-app run.

**Phase 2 — Codex cutover.** Add the codex `AcpEngineConfig`; flip
`makeEngine('codex')`. Exit criteria (each spike/smoke-verified): approval round-trip
at all four tiers, limn MCP tools callable, old thread ids resume or degrade to
seeded, structured generation passes the repair-turn path, cancel kills the tree.
Then delete `codexAppServer.ts`, `codexMcp.ts`, `codex.ts`, `docs/codex-app-server.md`
and their tests. **If exit criteria fail:** ship Phase 1 only; Codex remains on
app-server behind the seam until the adapter matures (this is the scoped fallback —
see Open question 1).

**Phase 3 — consolidation.** Remove the direct `@anthropic-ai/claude-agent-sdk` dep,
rework `binaries.ts`→`adapters.ts` + Settings copy, invert electron-builder
packaging, update `docs/architecture.md`/`docs/agent-layer.md`, add a short
`docs/acp-adapters.md` (version-bump playbook: bump adapter → run engine suite →
smoke).

Each phase is a separately mergeable, revertable unit.

## Test strategy

1. **Pure mapper tests** (replace `codex-events.test.ts` + `engines.test.ts:219-267`):
   `acpEvents.test.ts` — every row of the D2 table, sparse `tool_call_update` folding,
   replay suppression flag; `approvalPolicy.test.ts` — the full tier×kind matrix of D3
   plus `isSafeCommand` cases; `structured.test.ts` — the three extraction fallbacks +
   repair-turn trigger.
2. **FakeAcpAgent integration tests** (replace `codex-app-server.test.ts`'s role): a
   ~150-line script in `tests/helpers/fakeAcpAgent.ts` speaking real NDJSON ACP over
   stdio (initialize/session-new/session-load-with-replay/session-prompt with a
   scripted update sequence, a permission request, a cancellable long turn).
   `acp-engine.test.ts` runs `AcpEngine` against it end-to-end: event stream shape,
   approval park/resolve via `resolveDecision` (mirroring
   `engines.test.ts:146-178`), cancel → `cancelled` outcome for pending permissions,
   `session/load` failure → seeded fallback, MCP url present in `session/new` params.
   This is the contract fixture for *future* engines too.
3. **ReviewEngine contract tests stay**: the `FakeEngine` suites in `engines.test.ts`
   (lines 65-178) test the seam `ipc.ts` consumes and are engine-implementation-
   agnostic — unchanged. `approvals.test.ts`, `executionMode.test.ts` (rewritten to
   `approvalPolicy`), `tools.test.ts`, `write-capability.test.ts` unchanged.
4. **Adapter pin canaries** (new, env-gated `LIMN_LIVE_ENGINE_TESTS=1`, manual/CI-
   nightly): against the real pinned adapters, assert initialize capabilities and mode
   ids match what `AcpEngineConfig` encodes — this is the tripwire for adapter bumps.
5. **Manual smoke per phase** via the packaged app (rebuild `.app`, screenshot
   proofs): generation, chat with focus/tour tools, batch with an approval at each
   tier on each engine.

## Risks

1. **Codex adapter youth.** `@agentclientprotocol/codex-acp` 1.0.2 is a weeks-old TS
   rewrite; ecosystem resume bugs exist at the codex layer (openai/codex#11693
   "no rollout found for thread id"). *Mitigation:* Phase-2 exit criteria + the
   app-server fallback retained until they pass.
2. **Adapter abandonment / ownership churn.** The adapters have already moved orgs
   twice (zed-industries → agentclientprotocol; claude-code-acp → claude-agent-acp).
   *Mitigation:* Apache-2.0 (vendorable/forkable), pinned versions, the `ReviewEngine`
   seam keeps a native reimplementation possible, canary tests catch drift at bump
   time — strictly better than today's *undocumented* Codex protocol dependency.
3. **Protocol churn.** Session modes are explicitly slated for replacement by Session
   Config Options (source: https://agentclientprotocol.com/protocol/session-modes).
   *Mitigation:* protocol version pin (`1`) at initialize; mode-setting isolated in
   one function; adapter bumps are deliberate.
4. **Feature loss vs the native Claude SDK** — every SDK feature used today
   (`claude.ts`), checked:

   | SDK feature (usage site) | Via ACP? | Resolution |
   |---|---|---|
   | `resume` (claude.ts:213) | ✅ `session/load` / `session/resume` | D6 |
   | `outputFormat: json_schema` (claude.ts:180) | ❌ | D5 schema-in-prompt + repair turn — the one real loss |
   | `createSdkMcpServer` in-process tools (claude.ts:56-67) | ✅ `mcpServers` http config | D4; transport hop added (loopback) |
   | `canUseTool` (claude.ts:35-49) | ✅ `session/request_permission` | D3 |
   | `permissionMode` incl. `'auto'` (claude.ts:179,205) | ⚠ modes exist; engine-`auto` not exposed | deliberate: `auto` moves client-side for uniformity (D3) |
   | `allowedTools`/`disallowedTools` (claude.ts:215,219) | ❌ no tool-disable knob | enforced at permission layer (D3 read-only row) |
   | `effort` (claude.ts:238) | ✅ adapter supports low→max (issue #725) | spike-verify passthrough mechanism |
   | `model` (claude.ts:237) | ⚠ config options / adapter env; ecosystem bugs seen elsewhere (opencode#13644) | per-turn spawn env; spike-verify |
   | `abortController` (claude.ts:141) | ✅ `session/cancel` + process kill | D1 |
   | `cwd` (claude.ts:176) | ✅ `session/new.cwd` | |
   | `pathToClaudeCodeExecutable` (claude.ts:137) | n/a | superseded by pinning; escape hatch remains (OQ 9) |
   | `structured_output` on result (claude.ts:148) | ❌ | folded into D5 |

5. **`auto`-tier classifier is cruder than the SDK's own safety detection.** A regex
   allowlist can't match a model-informed judgment. *Accepted:* predictable + uniform
   beats clever + divergent (the divergence is the bug being fixed); classifier is
   pure, unit-tested, and tunable.
6. **Structured-review quality regression** (esp. Claude, which had native enforcement).
   *Mitigation:* repair turn (D5); measured during Phase-1 smoke by regenerating
   reviews on known branches.
7. **Per-turn spawn + `session/load` replay latency.** Long threads replay full
   history on every resumed turn. *Mitigation:* replay is suppressed (not rendered)
   and local; prefer `session/resume` when advertised; per-thread process reuse is the
   escape hatch (OQ 8).
8. **Packaging growth + signing.** Bundling `codex-acp` pulls `@openai/codex` platform
   binaries into the .app (tens of MB; unsigned-ship model the app ships unsigned). electron-
   builder config must include exactly one platform's binary. *Mitigation:* Phase-3
   packaging pass + `manual-install-verification` before release.
9. **Silent behavior drift inside adapters** (e.g. claude-agent-acp injects its own
   system-prompt/tool framing around the SDK). *Mitigation:* prompts are already
   engine-agnostic; canary tests + phase smokes compare tool-call behavior before/after.

## Open questions to resolve before implementation

1. **[LOAD-BEARING] Is `@agentclientprotocol/codex-acp` production-grade for Limn's
   four requirements (approval round-trip, session/load of existing Codex thread ids,
   HTTP MCP, mode set per tier)?** It exists, is org-official and npm-pinned
   (v1.0.2, 2026-06-29, pins `@openai/codex ^0.142.4`), which upgrades the original
   framing from "does one exist?" to "is this one ready?" — but it is weeks old.
   *Recommended answer:* adopt, but only through the Phase-2 exit criteria; keep
   `codexAppServer.ts` intact behind the seam until they pass, and pre-authorize the
   fallback of shipping Phase 1 (Claude-only ACP + AcpEngine established) if they
   don't. Decided by the Phase-0 spike, not by opinion.
2. **Do pre-migration `engineSessionId`s load through the adapters** (Claude JSONL
   session id via `claude-agent-acp`, Codex thread id via `codex-acp`)? *Recommended
   answer:* expect yes for Claude (adapter loads SDK sessions by native id), treat
   Codex as unknown; either way ship the seeded-session fallback (D6) so the answer
   only affects continuity quality, never correctness. Spike item.
3. **Structured output: schema-in-prompt for both engines (D5), or keep
   `generateReview` on the native Claude SDK short-term?** *Recommended answer:*
   schema-in-prompt + repair turn for both. Keeping the SDK for generation would
   retain the dep, the dual tool hosting, and two event mappers for exactly one call
   site — most of the migration's payoff — for a marginal validation win that the
   repair turn approximates.
4. **Do both adapters advertise `mcpCapabilities.http`?** *Recommended answer:* expect
   yes (codex-acp documents HTTP MCP; the Claude SDK supports HTTP MCP servers); if
   either says no, ship the stdio→HTTP proxy shim (D4) rather than reviving dual
   hosting. Spike item.
5. **What exactly counts as a "safe" command for the `auto` tier?** *Recommended
   answer:* start with the conservative allowlist in D3 (read-only git/fs inspection,
   project test/lint/typecheck scripts), deny-by-default everything else, and tune
   from real usage; document the list in Settings-adjacent help so the tier's promise
   is inspectable.
6. **Per-turn model + reasoning-effort passthrough mechanism per adapter** (spawn env
   vs session config options — `session/set_config_option` has known no-op bugs in
   other agents, e.g. opencode#13644). *Recommended answer:* pass via adapter
   env/args at spawn (one process per turn makes this exact), verify in the spike;
   only fall back to config options where env is unsupported.
7. **Bundle the pinned engine runtimes in the .app, or keep engines on the user's
   PATH?** Bundling is the version-pinning win (and codex-acp *requires* its pinned
   `@openai/codex`); it grows the artifact and changes the current "user supplies the
   CLIs" stance (`binaries.ts:6-9`, README). *Recommended answer:* bundle the adapters
   + their pinned runtimes; auth still comes from the user's `~/.claude`/`~/.codex`
   logins, so the user-facing requirement becomes "log in once with the official CLI"
   rather than "keep a compatible version installed".
8. **Adapter process per turn or per thread?** *Recommended answer:* per turn (matches
   today's lifecycle, trivial cancel, per-turn env for model/effort); revisit only if
   resume-replay latency is felt in practice, since `AcpEngine` isolates the choice.
9. **Keep the Settings engine-path override?** *Recommended answer:* keep a single
   "advanced: adapter path" override per engine (repurposing `ENGINE_PATH_PREF_KEYS`)
   as the escape hatch for users needing a newer/patched adapter, with the same
   "explicit override wins even when broken" semantics `binaries.ts` deliberately has.
10. **Protocol-version guard behavior:** if an adapter bump answers `initialize` with
    a version ≠ 1, hard-fail the turn with an actionable error (not silent
    downgrade)? *Recommended answer:* yes — surface "adapter requires newer Limn"
    exactly like the CLI-version-skew stderr surfacing today
    (`codexAppServer.ts:474-477`), and let the canary test catch it pre-release.
