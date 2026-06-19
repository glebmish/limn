# Handoff — Agent UI tools (next phase)

**You are picking up mid-project on `local-review`** (a macOS Electron app for agentic
review of local git branches; TypeScript + React + zustand, SQLite via `node:sqlite`).
Orientation: `README.md`, `docs/agent-layer.md` (engine layer), `docs/storage-layer.md`
(DB). This file is a living handoff — not a frozen spec.

> **On the specs/plans:** `docs/superpowers/specs/*` and `docs/superpowers/plans/*` are
> **point-in-time snapshots** of decisions when they were made. Read them for design
> intent, but treat the **code + this file** as current truth; verify before trusting a
> spec line.

---

## 1. Repo state right now

- **Uncommitted working-tree changes** implementing the "previous work" track plus
  the **entire agent tool layer — Phases 1–6 + tests are DONE** (§3). Nothing is
  committed yet — decide branch/commit with the user.
- `npm run typecheck` → **clean**. `npx vitest run` → **129 passed (19 files)**.
  `npm run build` → **clean** (main bundle ~608 kB — the MCP server SDK is bundled in).
- **What's verified visually** (screenshot harness, §5): focus/suggest chips + the
  cross-surface focus flash; agent-authored comments with identity click-through +
  reply/verdict round-trip; all action chips (focus/comment/resolve/edit/commit);
  the batch CTA; and a **real end-to-end batch run** under `LR_DEMO=1` (the FakeEngine
  edited `src/a.ts`, committed via `commit_changes`, recorded iteration 2, resolved the
  queued comment, and the review re-tagged "since approved").
- **New tool-layer files**: `src/main/engines/tools.ts`, `src/main/engines/codexMcp.ts`,
  `src/renderer/lib/focus.ts`, `src/renderer/components/ActionChips.tsx`,
  `tests/{tools,focus,codex-events}.test.ts`. Heavily touched: the engine layer
  (`claude/codex/fake/types/prompts/schema`), `ipc.ts`, `db/{migrations,sessions}.ts`,
  `shared/{types,ipc}.ts`, and the renderer (`store/App/Review/SectionView/DiffView/
  Threads/ChatDrawer/lib.comments/api.d.ts/styles`), plus `preload` + `shoot.mts`
  (dev hooks: `LR_FOCUS`/`LR_HOLD_FOCUS`/`LR_RUN_BATCH`) and `scripts/shot.sh` (capture helper).

---

## 2. What was just completed — "previous work" (wireframe-driven changes to landed features)

These were UI/plumbing refinements the Agent-UI wireframes introduced to the
**already-shipped** multi-agent picker + multi-chat sidebar. All done + screenshot-verified.

- **W2 — reasoning effort for both engines + Codex catalog refresh.**
  `ReasoningEffort` gained `'max'`. Catalog (`shared/agents.ts`): Claude `opus`/`sonnet`
  → `low/medium/high/xhigh/max`, `haiku` → none (SDK errors on Haiku effort); Codex →
  `gpt-5.5`/`gpt-5.4`/`gpt-5.4-mini`, all `low/medium/high/xhigh`. `claude.ts` now passes
  the SDK `effort` option (was Codex-only); `codex.ts` drops the Claude-only `max`.
  **Decisions locked with the user:** Codex lineup mirrors the live CLI (gpt-5.5 default);
  default selection stays **Auto / no effort** until a concrete model is picked.
- **W1 — agent picker redesign.** `AgentPicker.tsx` is now a single trigger + structured
  popover (engine+auth dots, model guidance, segmented effort shown for both engines,
  explained Auto). Replaced the 3 bare `<select>`s. Compare-screen rail unchanged but now
  shows Claude effort for free (same `selModel?.reasoningEfforts` gate).
- **W3 — chat selector as a dropdown.** New `ChatDropdown.tsx` replaces the tab strip in
  `ChatDrawer.tsx`.
- **Dev-only screenshot hooks** added (gated by `window.lrDev`, set from env in the
  preload): `LR_ACTIVE_CHAT=<id>`, `LR_OPEN_PICKER=1`, `LR_OPEN_CHATLIST=1`.
- **Known harmless leftover:** the old `.chat-tab*` CSS in `app.css` is now dead (the tab
  strip is gone). Safe to delete; left to keep the diff tight.

---

## 3. The agent **tool layer** — Phases 1–6 + tests are DONE

Design reference: `docs/superpowers/specs/2026-06-19-agent-ui-tools.md` (snapshot).
**Decisions locked with the user:** both engines get tools; one **unified batch path**
(answer + edit review + reply/resolve comments + edit & commit code in one turn, folding
in the old fix flow); previous-work-first (done). All five capabilities — **focus**,
**suggest-mark-viewed**, **comment round-trip**, **in-place review edits**,
**identity click-through** — shipped, grown from the existing abstractions.

**Phased build order (all ✅ DONE):**

1. **Action model + Claude tool host. ✅** `src/main/engines/tools.ts`: `LR_TOOLS`,
   `ToolDef`, `ToolHostCtx`, `AgentToolHost`, `createToolHost`, `lrAllowedToolNames(write)`.
   `EngineEvent += {type:'action'}`; `AgentAction` union + `FocusTarget` in `shared/types.ts`.
   `ChatTurn += tools?/writeEnabled?`. Claude `chat` wires `createSdkMcpServer` +
   `mcp__localreview__*`. The host emits actions via its `emit` callback (a side channel,
   **not** the engine `EventQueue`); both land on `op:event`.
2. **Renderer focus/highlight + chips + `actions_json`. ✅** `data-lr-summary/section/file/line`
   targeting attrs; `renderer/lib/focus.ts` (`focusAnchor` + `lrSelector`, retries across
   React commits); `lr-flash` keyframes + floating "focus" badge; store `focusTarget`
   (non-destructive force-render — does **not** mutate `viewedAt`/`reviewedSections`) +
   live action stream from `gen.log`. `ActionChips.tsx` renders every kind (chips +
   the suggest card). `actions_json` migration (v2) on `chat_messages` round-trips.
3. **Comment tools + identity. ✅** `add_comment`/`reply_to_comment`/`resolve_comment`/
   `list_comments`; `Comment.author` widened to `'user'|'agent'` + `agentRef?`/`threadId?`
   (JSON blob, no column migration); `Threads.tsx` renders the agent card + replies; the
   identity chip opens that chat via the store (`chatOpen` + `openChat(threadId)` lifted
   into the store from `Review.tsx` local state). Agent comments use status `'resolved'`
   (no `resolution`) so they're inert in the queued-batch / verdict flows.
4. **Review edits. ✅** `get_review`/`edit_review` patch annotations via `updateSessionMeta`
   (blob ↔ denormalized `title`/`summary` columns kept in sync); a `review_edited` chip
   focuses the edited spot. (Before/after struck-through narration was **not** built — the
   action carries only `field`/`sectionId`, so the edited text just updates after reload.)
5. **Unified batch turn. ✅** `sendBatch(threadId, commentIds, steer?, opId)` IPC (reports
   `kind:'chat'`); `commit_changes` tool (write-gated, git add+commit, `addIteration`,
   resolution backfill with the commit ref) — emits `code_committed` **only** when something
   was actually staged. Write tools withheld via `lrAllowedToolNames(writeEnabled)` +
   guarded at runtime. Resolution rollup = the `comment_resolved` chips + commit chip.
   Rerouted `sendComments` (Review CTA / DiffView Regenerate) + a chat-footer batch CTA to
   `store.sendBatch`. **Retired** `applyFeedback`/`sendFeedback`/`fixJsonSchema`/
   `buildFixPrompt`/`parseFixOutput`/`FixResult`/`CommentResolution`. Verified end-to-end
   under `LR_DEMO=1` (FakeEngine batch path).
6. **Codex tool host. ✅ (live path unverified).** `src/main/engines/codexMcp.ts` runs one
   lazily-started localhost streamable-HTTP MCP server in main (`@modelcontextprotocol/sdk`
   `McpServer` + `StreamableHTTPServerTransport`), per-turn path token → `AgentToolHost`,
   `registerCodexTurn(host) → { url, release }`. `codex.ts chat` is now async: per tool-turn
   it mints a per-turn `new Codex({ config: { mcp_servers: { localreview: { url } } } })`,
   runs, and `release`s in `finally`. `toEvent` (now exported, unit-tested) handles
   `mcp_tool_call` + `item.updated`; `sandboxMode` per `writeEnabled`. **Caveat:** the live
   Codex path (real `codex exec` connecting over HTTP-MCP) could not be e2e-tested here (no
   Codex CLI/auth/network) — only `toEvent` + typecheck + build are verified.
7. **Tests woven throughout. ✅** 129 passing (`tools`, `focus`, `codex-events`, plus the
   updated `db-sessions`/`engines` for `actions_json` + the batch path).

### Deferred — DO THESE IN ORDER

**1. FIRST — Full wf-D tool-call log to parity. ✅ DONE (merged to main).** Now a
persisted, flat, expandable tool-call log (`src/renderer/components/ToolCallLog.tsx` +
`src/shared/toolcalls.ts` `reduceToolCalls`) replacing the last-4-lines summary. The
`tool` `EngineEvent` now carries a structured `ToolCall` (`run`→`ok`/`err` lifecycle,
keyed by call-id); both engines emit start+completion; persisted on `ChatMessage.tools`
(**migration v3** `tools_json`). Decisions: **persisted** transcript log; **flat list,
no grouping** in v1; `meta` best-effort. Spec `2026-06-19-tool-call-log-design.md`, plan
`2026-06-19-tool-call-log.md`. Screenshot-verified (collapsed / running / expanded /
error) via new `LR_RUN_CHAT` + `LR_HOLD_STREAM` + `LR_EXPAND_TOOL` dev hooks. 164 tests.

**2. THEN — Interactive approvals for BOTH engines. ✅ IMPLEMENTED (Claude + UI + model
verified; Codex app-server live-unverified).** Spec
[`docs/superpowers/specs/2026-06-19-agent-approvals.md`](docs/superpowers/specs/2026-06-19-agent-approvals.md).
What landed (196 tests):
- **Execution-mode ladder** (wireframe J): `ExecutionMode = ask|edits|auto|full` +
  `src/shared/executionMode.ts` `executionPolicy(mode)` → `{claudePermissionMode,
  codexApprovalPolicy, codexSandbox}`. Per-chat persisted (**migration v4**
  `chat_threads.execution_mode`, default `ask`) + `setChatMode` IPC. `ModeSelector.tsx`
  pill+dropdown in the composer (screenshot-verified); `full` needs a confirming 2nd click.
- **Reactive approvals:** `ApprovalRequest`/`ApprovalDecision` + `EngineEvent.approval_request`;
  `src/main/engines/approvals.ts` registry (`awaitDecision`/`resolveDecision`/`clearPending`
  keyed by `(opId,requestId)`, no timeout); `respondApproval` IPC; `clearPending` on
  cancel/turn-end. `ApprovalCard.tsx` blocking card in `ChatDrawer` (screenshot-verified).
  `ChatTurn` now carries `opId` + `executionMode`.
- **Claude adapter:** `makeCanUseTool` (auto-allow localreview + read-safe; park Bash/Edit/Write);
  `permissionMode` from `executionPolicy`; `full` → `bypassPermissions` +
  `allowDangerouslySkipPermissions`. Unit-tested.
- **Codex adapter:** `src/main/engines/codexAppServer.ts` — full JSON-RPC-over-stdio client
  behind **`LR_CODEX_APP_SERVER=1`** (codex exec stays the default fallback). Pure helpers
  unit-tested. ✅ **LIVE-VERIFIED against codex-cli 0.135.0 (2026-06-20):** full turn
  lifecycle (initialize→thread/start→turn/start→agentMessage deltas→turn/completed) **and a
  real approval round-trip** (a sandbox-blocked write surfaced `execCommandApproval` → `deny`
  routed back → file not written). Protocol pinned from `codex app-server generate-ts`; key
  facts: `turn/start` needs **`approvalsReviewer:'user'`** (the guardian auto-deny unblock),
  threadId at `result.thread.id`, text via `item/agentMessage/delta`. **Still unexercised:**
  `thread/resume` + the localreview **MCP-tool path under app-server** — validate those before
  flipping the default on.
- **Decision reversal (user, 2026-06-19):** the **Full access** tier ships `danger-full-access`
  (sandbox off) via the app-server `sandboxPolicy` param — reversing the earlier "no sandbox
  bypass" rule — but **never** via `--dangerously-bypass-approvals-and-sandbox` (that flag
  stays unused). `writeEnabled` still fences `commit_changes` regardless of tier.

**Remaining to flip Codex on:** validate the app-server path against a real binary (pin
bindings; confirm method names + notification shapes), then default `LR_CODEX_APP_SERVER` on
(spec build step 10).

**Other / lower priority:**
- **Before/after narration for `edit_review`** (wf-G) — would need the action to carry the
  prior text (or a diff) so the card can strike-through removed / highlight added.

---

## 4. Ground truth the next agent should NOT re-derive

Verified against the installed SDKs and the codebase:

- **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`): first-class **in-process** tools
  via `createSdkMcpServer`. The `effort` option is real (low/medium/high/xhigh/max) and is
  now used. **No `mcpServers` is wired anywhere yet** — `claude.ts` Options carry only
  allowedTools/permissionMode/outputFormat.
- **Codex SDK** (`@openai/codex-sdk`): no in-process tools — it spawns `codex exec` and
  parses JSONL. Custom tools come **only** from external MCP servers configured via
  `Codex` **constructor** `config`. Today `codex.ts` reuses a single `this.codex` (~`:94`)
  — the tool layer needs a **per-turn** `new Codex({config})`. `toEvent` currently switches
  only on `item.started`/`item.completed`; add `mcp_tool_call` + `item.updated`. Headless
  `codex exec` forces `approval_policy=Never` (no approval prompts).
- **`EngineEvent`** = 5 variants (`status|tool|text|done|error`) in `src/shared/types.ts`.
  Flows to renderer via `ipc.ts pumpEvents` → `op:event`. Add `{type:'action'}` here.
- **Comments** are a JSON blob (`comments.json` column) — widening the shape needs no
  column migration. `Comment.author` is currently the literal `'user'`; `CommentReply.author`
  is already `'user'|'agent'`. **Verdict badges already exist** in `Threads.tsx`
  (`VERDICT_ICON = {addressed, reworked, skipped}`) — reuse them.
- **Write guards** for code edits live at the top of `sendFeedback` (`ipc.ts`, ~`:398-405`):
  compare side is a branch, working tree clean, repo on that branch. Reuse for
  `commit_changes` gating.
- **Fix flow to retire:** `sendFeedback` (ipc) / `applyFeedback` (engines) / `fixJsonSchema`
  (`schema.ts`) / `buildFixPrompt` (`prompts.ts`). Call sites to reroute: the queued-comments
  CTA in `Review.tsx` (~`:254-284`) and `sendComments` in `renderer/lib/comments.ts`.
- **Tool-call log today is minimal:** `ChatDrawer.tsx`'s streaming block shows only the
  **last 4** activity lines, live-only, not persisted, not expandable. Full wf-D parity
  (expandable args+result, grouping, error card) is a real build — the user chose to do it.
- **No `focusTarget`** in the store yet (the nearest is `cur` = current section).
  `markReviewed`/`reviewedSections`/`viewedAt` exist and back the suggest-mark-viewed flow.
- **Two picker surfaces** exist: the new popover `AgentPicker` (chat bar) and the inline
  controls in `Compare.tsx`'s "Review agent" rail. Agent-identity chips reuse
  `agentLabel(agentRef)` from `shared/agents.ts`.

---

## 5. Wireframes & screenshots

- **Wireframes:** `the wireframes (sibling project)`
  (sibling project; a pan/zoom canvas, sections A–J). A–C = the picker/multi-chat (done in
  the previous-work track); **D–I = the tool layer** (tool-call log ✅, action chips,
  focus/suggest cross-surface pairs, comment/identity, unified batch, storyboard);
  **J = execution mode** (`frames-mode.jsx`, J1–J3) — the approvals ladder, folded into
  the approvals spec (§3.2). The `Mini` panes are a stand-in for the **real** review
  surface — don't build a literal "Mini".
- **Screenshot harness:** `npx tsx scripts/shoot.mts` seeds a fixture repo + db and prints
  `{ repo, db, sessionId, reviewChat, userChat }`; then launch Electron with `LR_DB` /
  `LR_OPEN_SESSION` / `LR_FLOW=chat` + `LR_SHOT=/path.png LR_SHOT_DELAY LR_SHOT_QUIT=1` and
  the dev hooks above. Build first (`npm run build`), then `npx electron .` with the env.
  (GUI capture must run **outside** a sandbox.)

---

## 6. Suggested next move — do these in this order (see §3 "Deferred")

1. ~~**FIRST: the full wf-D tool-call log**~~ ✅ **DONE** — merged to `main` (see §3.1).
2. ~~**interactive approvals for both engines**~~ ✅ **IMPLEMENTED** (see §3.2). Claude
   path + mode ladder + approval card are verified; the **Codex `app-server` path is
   live-unverified** behind `LR_CODEX_APP_SERVER`.
3. **Flip the Codex app-server path on (mostly verified).** Core turn + approval round-trip
   are live-verified (§3.2). Remaining before defaulting `LR_CODEX_APP_SERVER` on: exercise
   `thread/resume` (multi-turn chat) + the localreview **MCP-tool path under app-server**
   (`-c mcp_servers.localreview.url=…` → tool calls + `commit_changes`), then flip the default
   (keep `codex exec` fallback one release).
4. Lower priority: **before/after narration** for `edit_review` (wf-G).

Verify each step with `npm run typecheck`, `npx vitest run`, `npm run build`, and a
screenshot via `scripts/shot.sh <out.png> [LR_* env...]` (wraps §5's harness).
