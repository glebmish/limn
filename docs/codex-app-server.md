# Codex app-server protocol

How Limn talks to the `codex` CLI's **app-server** — a JSON-RPC-over-stdio
protocol that is not publicly documented. This is the contract the hand-written
client in `src/main/engines/codexAppServer.ts` is pinned to.

> **Audience:** developers working on the Codex engine. The shapes here are not in
> any published spec; treat this doc and the pure helpers in `codexAppServer.ts`
> (which are unit-tested in `tests/codex-app-server.test.ts`) as the source of
> truth, and re-verify against the binary when bumping the Codex CLI protocol.

## Provenance

Every method name, param field, and enum value below was generated from the
bundled binary, not inferred from traffic:

```bash
codex app-server generate-ts --out <dir>   # emits the full TS protocol surface
```

- **Verified:** 2026-06-25, against Codex app-server **0.139.0**.
- The client was originally conformed to **0.135.0** and supported that release's
  *legacy* approval methods alongside the v2 ones. As of the 0.139 pass it is
  **v2-only** — the legacy methods and their `approved|denied` decision vocabulary
  were removed (see [Approvals](#approvals)).

## Why a hand-written client

All Codex flows use `codex app-server`. Its protocol exposes the server→client
approval requests that Limn must route through the reviewer UI, and it also
supports `outputSchema` for structured review generation. Keeping generation,
chat, and batch on the same path avoids maintaining two event/protocol mappers.

```text
generate/chat/batch ──► runAppServerTurn ──► AppServerConn ──► codex app-server
```

## Framing

The wire format is **NDJSON**: one compact JSON object per line, newline-delimited.
It is *not* LSP-style `Content-Length` framing.

```text
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{…}}\n
{"jsonrpc":"2.0","method":"initialized"}\n
```

- `encodeFrame(msg)` → `JSON.stringify(msg) + '\n'`.
- `decodeChunk(buffer)` splits on `\n`, parses each complete line, and returns the
  trailing partial line so the next stdout chunk can prepend it. A trailing `\r` is
  stripped and **non-JSON lines are skipped** — the binary interleaves plain-text
  diagnostics on stdout, and they must not crash the parser.

## Message classification

Frames carry no envelope tag saying "this is a request vs a response." They are
classified by **shape** (`classifyMessage`):

| Shape | Kind | Meaning |
|-------|------|---------|
| `method` + `id` | `request` | server→client request we **must** answer |
| `method`, no `id` | `notification` | fire-and-forget event |
| `id` + (`result` \| `error`) | `response` | a reply to one of *our* requests |

Our outgoing requests carry an incrementing numeric `id`; replies are matched back
to the pending promise by that id. Server→client requests carry the server's own
`id`, which we echo in our response.

## Handshake

`AppServerConn.handshake(resumeThreadId?)` runs:

```text
→ request   initialize   { clientInfo: { name: "limn", version: "0" },
                           capabilities: { experimentalApi: true } }
← response  { … }
→ notify    initialized
→ request   thread/start {}                     (or thread/resume { threadId })
← response  { thread: { id, sessionId, … } }
```

- `capabilities.experimentalApi: true` opts into the **v2** surface (the
  `item/.../requestApproval` methods below). Without it the server falls back to the
  legacy surface we no longer answer.
- `clientInfo.version: "0"` is a placeholder — the server only logs it.
- The thread id from `thread/start` (`thread.id`) is what we persist as the engine
  session id and pass to `thread/resume` on later turns.

## Running a turn

```text
→ request turn/start {
    threadId,
    input: [{ type: "text", text: <prompt>, text_elements: [] }],
    cwd: <repo>,
    approvalPolicy: <on-request | never | …>,   // executionPolicy(mode).codexApprovalPolicy
    approvalsReviewer: "user",                   // route approvals to US
    sandboxPolicy: { type: "readOnly" | "workspaceWrite" | "dangerFullAccess", … },
    model?: <id>, effort?: <low … xhigh>,        // omitted ⇒ CLI default; effort dropped for "max"
    outputSchema?: <json schema>                 // review generation only
  }
```

`approvalsReviewer: "user"` is the load-bearing flag: without it the binary's own
guardian subagent auto-denies untrusted exec/MCP in headless mode, and the turn
wedges. Pointing approvals at `"user"` makes the server send us the requests below.

`sandboxPolicy` is derived from the reviewer's execution tier and the write guard
(`sandboxPolicyFor`): `readOnly` for ordinary chat, `workspaceWrite`
(`writableRoots: [repo]`, no network) for a write-enabled batch, `dangerFullAccess`
for Full access. Review generation deliberately uses the `edits` tier with
`writeEnabled: true`, matching the old `workspace-write` / `on-request` behavior.

`runAppServerTurn` is the reusable lifecycle wrapper around this request. It
handles optional MCP registration, thread start/resume, approval requests,
notification mapping, final assistant text accumulation, cancellation, and cleanup.
`chatViaAppServer` and Codex review generation are thin wrappers around it.

## Approvals

When `approvalPolicy` requires a go-ahead, the server sends a **request** (method +
id) that we answer with a decision. Only the **v2** methods are supported:

| Method | Params (key fields) | Response |
|--------|---------------------|----------|
| `item/commandExecution/requestApproval` | `command: string`, `cwd`, `reason?` | `{ decision }` |
| `item/fileChange/requestApproval` | `itemId`, `reason?` (no file list) | `{ decision }` |

`approvalRequestFromParams` reads these leniently into the engine-agnostic
`ApprovalRequest`. Note the asymmetry, straight from `generate-ts`:
`CommandExecutionRequestApprovalParams` carries the `command` and `cwd`, but
`FileChangeRequestApprovalParams` carries **only** `itemId` + `reason` — there is no
list of changed paths, so a patch approval surfaces its `reason` as the summary.

### Decision vocabulary

The v2 decision enums are **`accept` / `decline`** (plus `acceptForSession`,
`cancel`, and amendment variants we don't emit):

```text
CommandExecutionApprovalDecision = "accept" | "acceptForSession" | … | "decline" | "cancel"
FileChangeApprovalDecision       = "accept" | "acceptForSession" | "decline" | "cancel"
```

`mapApprovalDecision` maps Limn's `allow`/`deny` onto `accept`/`decline`:

```ts
allow → "accept"
deny  → "decline"
```

> ⚠️ The **legacy** methods (`execCommandApproval`, `applyPatchApproval`) used a
> different enum — `ReviewDecision = "approved" | "denied" | …`. The pre-0.139 client
> emitted `approved`/`denied` for *all* methods, which is wrong for the v2 methods
> the server actually sends. Emitting `accept`/`decline` is required; getting this
> wrong silently fails every approval.

### MCP tool-call elicitation (auto-accept)

Limn's own review tools (`mcp__limn__add_comment`, …) are surfaced **not** as an
approval but as an RMCP **elicitation**:

```text
← request mcpServer/elicitation/request
            { …, _meta: { codex_approval_kind: "mcp_tool_call" } }
→ respond { action: "accept", content: null, _meta: null }
```

Note the response is `{ action, content, _meta }`, **not** `{ decision }`. The limn
tools only mutate review metadata (comments, viewed flags), so an `mcp_tool_call`
elicitation is auto-**accepted**; any other elicitation kind is declined. Without
this the server cancels the turn's tool calls with "user cancelled MCP tool call."

### Unsupported surfaces

Every other server→client request — `item/tool/requestUserInput`,
`item/permissions/requestApproval`, `item/tool/call`, etc. — is answered with a
JSON-RPC error so the turn backs off instead of hanging:

```text
→ respondError  { code: -32601, message: "methodNotFound" }
```

## Notifications → EngineEvents

Server notifications are mapped to the engine-agnostic `EngineEvent` union by
method (`appServerNotifToEvent`), so the renderer reduces the same stream it gets
from Claude:

| Notification | EngineEvent |
|--------------|-------------|
| `item/agentMessage/delta` `{ delta }` | `text` for chat turns (also accumulated into the turn's final result) |
| `item/reasoning/textDelta`, `item/reasoning/summaryTextDelta` `{ delta }` | `status` (first 160 chars) |
| `item/started`, `item/completed` `{ item }` | `tool` chip via `appServerItemToEvent` |
| `turn/completed`, `turn/aborted` | resolves the turn |
| `error` `{ message }` | fails the turn |

### ThreadItem → tool chip

`appServerItemToEvent` maps a **v2 ThreadItem** to a `tool` call chip
(`item/started` ⇒ `run`, `item/completed` ⇒ `ok`/`err`):

- `mcpToolCall` — `tool` + `arguments` (kv pairs); `result.content` text on success,
  `error.message` on failure.
- `commandExecution` — `command` as the arg, `aggregatedOutput` as the body; failed
  when `status === "failed"` or a non-zero `exitCode`. Verb is `bash`.
- `fileChange` — `changes[].path` list; verb is `edit`. (This is the *completed
  item*, distinct from the `fileChange` **approval** above.)

## Lifecycle & cleanup

`AppServerConn` is one long-lived child process reused across a thread's turns. On
turn end / cancel / error the connection is disposed (`child.kill()`) and the
per-turn localhost MCP server (see [agent-layer.md](agent-layer.md), *Tool layer*)
is released. A child exit rejects every pending request so no promise leaks.

## Bumping the Codex app-server protocol

When the Codex CLI/app-server version changes:

1. Re-run `codex app-server generate-ts --out <dir>` against the new binary.
2. Diff `ServerRequest`, the `*ApprovalParams` / `*ApprovalDecision` types, and the
   `initialize`/`thread/*`/`turn/*` shapes against this doc.
3. Update `APPROVAL_METHODS`, `mapApprovalDecision`, `approvalRequestFromParams`, and
   the notification map as needed; update `tests/codex-app-server.test.ts`.
4. Update the **Provenance** version + date above.
