# Chat while generation runs — two-lane operation model

## Status: RESOLVED — building on `07-concurrent-chat` (stacked on the acp-migration tip)

### Resolved open questions (2026-07-02) — all recommendations adopted
1. `generate` stays **exclusive** (not tightened to enforced read-only); profile tightening filed separately.
2. Shared-lane capacity: **exactly one** concurrent chat turn.
3. An exclusive op **may** start while a shared turn streams (read-only ⇒ no tree conflict).
4. **Coerce** to read-only + badge + leading status event (no explicit confirm step).
5. Read-only tool set = **strict minimum** (Read/Grep/Glob + Limn only; no network, no subagents).
6. The review thread **cannot** take chat turns during its own generation (composer stays disabled); shared turns go to other threads.
7. ~~The renderer learns an op's lane via an optional `lane` field on the IPC
   envelope.~~ **Superseded during implementation:** the renderer predicts the lane at
   `startOp` from its own `ops` map (`exclusive = !anyExclusiveRunning(ops)`). Within a
   single renderer this is *exact* — any exclusive op (generate/batch) was started by
   that same renderer and is already in `ops` before a chat send reads it. The only
   cross-source is a second window, whose op is dropped by the unknown-opId rule anyway,
   and main stays authoritative (a wrong guess → `RepoBusyError`, not corruption). So a
   `lane` envelope field would be dead plumbing; it was not added.
8. Shared-lane-full: **disable** the send button with a tooltip; keep the typed draft; never silent-drop.
9. Feedback (no silent no-ops) is a **property of every rewritten guard**, landed with the lane split rather than as a throwaway pre-phase.

### Re-grounding onto ACP (the spec predates the acp-migration, now in the stack below)
The engine layer is no longer `claude.ts` + `codexAppServer.ts`; both engines run through
one `AcpEngine` (`acp.ts`) + `AcpEngineConfig` (`adapters.ts`) + the shared
`ladderPolicy`/`modeFor` (`shared/approvalPolicy.ts`). So §3's two per-engine
profile changes collapse into **one** cross-engine change:

- Add `readOnly?: boolean` to `ChatTurn` (`engines/types.ts`); `FakeEngine` records it.
- In `runAcpTurn`, a `readOnly` turn forces the read-only session mode
  (`modeFor(mode, /*writeEnabled*/ false)` → claude `default`, codex `read-only`) **and**
  routes permissions through a read-only ladder that **denies** every non-Limn tool
  request (command / file_change / tool_use) regardless of the thread's tier — so a
  shared turn never parks an approval. Limn tools stay allowed (`isLimnTool`). This is
  strictly stronger than today's `!writeEnabled` (which only denies `file_change`).
- Codex read-only additionally gets the engine's OS-sandbox `read-only` mode via
  `modeFor`; Claude read-only is harness/ladder-enforced (adequate, not a security
  boundary — same honesty caveat as the original §3).

Everything else in the spec (lock split §1, ipc routing §2, renderer demux §4,
approvals §5, watcher §6, cancellation §7) applies as written; `operations.ts`
(`OperationCoordinator` + `repoOwners`) and the sliced store (`store/ops.ts`, still a
single `gen`) match the design's assumptions.

## Status: Draft — awaiting answers to open questions (original draft below)

## Problem (evidence)

A reviewer cannot ask the agent anything while a review generates. Generation of a
non-trivial branch takes minutes; the diff is already on screen; a read-only question
("what does this migration touch?") is exactly what you want to ask while you wait.
Today it is blocked twice over:

1. **Main process — one lock for everything.** `OperationCoordinator`
   (`src/main/operations.ts`) keeps a per-repo owner map (`repoOwners:
   Map<repo, opId>`); `run(opId, repo, work)` fails immediately with `RepoBusyError`
   ("Another agent operation is running for this repository") when the repo is owned
   (`operations.ts:66`). All three flows take this same lock: `generate`
   (`src/main/ipc.ts:362`), `sendChat` (`ipc.ts:525`), `sendBatch` (`ipc.ts:634`).
   There is no queue — a second op is rejected, not deferred.

2. **Renderer — one global op slot.** The store holds a single `gen: GenState`
   (`src/renderer/store.ts:173-193`) with one `opId`, one `threadId`, one `log`.
   Every send path bails silently while anything runs: `sendChat`
   (`store.ts:1062`), `followUp` (`store.ts:1076`), `sendBatch` (`store.ts:1108`),
   `sendQueuedComments` (`store.ts:1135`) all start with
   `if (get().gen.running) return`.

How the blocked state surfaces today: **mostly it doesn't.** The ChatDrawer composer
is disabled only when the *active* thread is the one streaming
(`streaming = gen.running && gen.threadId === active?.id`, `ChatDrawer.tsx:51`, used
at `:264`/`:271`). While a review generates, switch to any *other* chat and the
composer looks fully enabled — typing and hitting Enter silently does nothing
(`store.sendChat`'s `gen.running` guard eats it). No error, no tooltip, no queue.
The `RepoBusyError` message only ever reaches a user when a *second client* (web
serve / second window) sends — it lands as a persisted "Turn failed: Another agent
operation is running for this repository" chat note (`ipc.ts:586`).

What each op actually does:

| Op | Working tree | App DB | Engine enforcement today |
|---|---|---|---|
| `generate` | intended read-only exploration; **not enforced**: Claude gen runs `allowedTools: ['Read','Grep','Glob','Bash']` with `permissionMode: 'auto'` (`claude.ts:51,179`) — Bash can write; Codex gen runs `writeEnabled: true, executionMode: 'edits'` → `workspaceWrite` sandbox (`codex.ts:52-54`, `codexAppServer.ts:86-94`) | writes at the end: `setArtifacts`, then one `inTx` block (iteration + session meta + review-thread finalization, `ipc.ts:423-459`); streams events throughout | see left |
| `sendChat` | `writeEnabled` falsy → Claude gets `disallowedTools: ['Edit','Write']` (`claude.ts:219`) **but Bash is not disallowed** (approval-gated in ask/edits; permissive in auto/full); Codex gets `readOnly` sandbox in every tier except `full` → `dangerFullAccess` (`sandboxPolicyFor`) | chat messages, thread title/engine-session binding; Limn tools write comments/review metadata (`tools.ts` — no working-tree write tool) | partially read-only, tier-dependent |
| `sendBatch` | edits + commits via the engine's own tools (`writeEnabled = !refine`) | comments status churn, chat messages | write-capable by design — **must stay exclusive** |

Why the lock exists (all verified):
(a) two agents mutating the working tree concurrently;
(b) the watcher reacting to our own agent's activity — the 500 ms poll skips owned
repos (`if (operations.repoBusy(repo)) return`, `ipc.ts:79`);
(c) DB write races on the same session.

On (c), the storage reality: one shared in-process `node:sqlite` `DatabaseSync`
connection, WAL, **no `busy_timeout`** (`src/main/db/db.ts:46-58`). `DatabaseSync`
is synchronous, so every dao call — including the whole `inTx` BEGIN…COMMIT block,
whose `fn` is synchronous — completes within one JS tick. Two concurrent ops *in
this process* cannot interleave mid-transaction on this connection. The
single-writer/busy risk is cross-process (desktop app + `limn serve` on the same DB
file — the scenario `db.ts:20-22` already comments about), which is the pending
robustness-sweep item (see Dependencies).

**The renderer's single-op assumption is the real blocker — established precisely:**

- The IPC envelope is already demux-ready: `OpEventMsg { opId, event }` and
  `OpResultMsg { opId, ... }` (`src/shared/ipc.ts:129-137`). No protocol change
  needed.
- The store is not: `App.tsx:13-21` **drops** any `op:event` / `op:result` whose
  `opId !== gen.opId`. A second concurrent op's stream would vanish, and its
  terminal result would never call `finishOp` — the renderer would consider it
  running forever.
- `startOp` replaces the whole `gen` slot (`store.ts:942`), so starting a chat op
  mid-generation would *orphan* the generation stream client-side (main would keep
  running it).
- `respondApproval` answers against `gen.opId` only (`store.ts:1046-1049`);
  `cancelOp` cancels `gen.opId` only (`store.ts:1051-1058`).
- ChatDrawer derives pending approvals from the single `gen.log`
  (`ChatDrawer.tsx:67-69`) and renders **one** `ApprovalCard` (the head of the
  queue) — it cannot show approvals from two ops, and `ApprovalCard` itself has no
  opId concept.
- `App.tsx:25` also gates `repo:changed` handling on `st.gen.running`.

The main process, by contrast, is nearly ready: the approval registry is keyed
`${opId}\0${requestId}` (`src/main/engines/approvals.ts:8`), `resolveDecision` and
`clearPending` are strictly per-op, and `pendingCount(opId)` exists for tests.
Two live opIds coexist fine there today. `OperationCoordinator.cancel(opId)` is
opId-keyed and per-op (`operations.ts:59-63`); the only single-op assumption in
main is the `repoOwners` lock itself.

## Goals / Non-goals

**Goals**

- A reviewer can send read-only chat turns (questions about the diff, the review,
  the repo) while a review generates in the same repo.
- The user always gets feedback when a send is deferred or restricted — kill the
  silent no-op.
- `sendBatch` and any working-tree-writing turn remain strictly serialized.
- Cancelling one lane never cancels the other.
- Approvals from two live ops are answerable and routed correctly.
- No IPC protocol changes (the envelope already carries `opId`).

**Non-goals**

- Two concurrent *generations*, or generation concurrent with a *batch*.
- More than one concurrent chat turn (the shared lane holds one op).
- Cross-process DB concurrency hardening (`busy_timeout`) — that belongs to the
  robustness sweep (see Dependencies).
- Multi-repo concurrency — the lock is already per-repo and unaffected.
- Making `generate` itself shareable/read-only-enforced (kept exclusive; see
  Option A discussion and Open question 1).

## Design options

### Option A — read-only shared lane (full design)

Two lanes per repo:

- **EXCLUSIVE lane** (at most one op, exactly today's lock): `generate`,
  `sendBatch`, and any chat turn that runs with a write-capable profile.
- **SHARED lane** (at most one op, may coexist with an exclusive op): a chat turn
  *forced* to a read-only tool profile.

**Is generate exclusive or shared?** Exclusive. Even though it is conceptually
read-only exploration, it is not *enforced* read-only today (Claude gen has Bash
under `permissionMode: 'auto'`; Codex gen runs a `workspaceWrite` sandbox), it owns
the watcher-suppression semantics, and its terminal `reload` assumes it was the only
thing changing review state. Making it shared would require first tightening both
engines' generation profiles — orthogonal work, deliberately out of scope (Open
question 1). Two truly-read-only ops side by side is exactly what the shared lane
gives us anyway: generate (exclusive) + read-only chat (shared).

**DB writes from both lanes concurrently** (generate finalizing its `inTx` while a
chat turn persists messages / Limn tool comments): safe in-process. Both lanes share
the one synchronous `DatabaseSync` connection; each dao call and each `inTx` block
runs to completion within a JS tick, so statements never interleave inside a
transaction and SQLite's single-writer rule is never contended *within the app*.
The residual risk is a second process on the same DB file (desktop + web serve),
which exists today already and is the robustness-sweep `busy_timeout` item — this
feature widens the write-overlap window slightly but introduces no new class of
race. Dependency noted below.

**Lock model** (`operations.ts`):

```ts
type Lane = 'exclusive' | 'shared'
// repoOwners: Map<repo, { exclusive?: opId; shared?: opId }>
run(opId, repo, work)                    // unchanged semantics: exclusive lane
runShared(opId, repo, work)              // shared lane: fails RepoBusyError only if
                                         // another SHARED op holds the repo
repoBusy(repo)        → exclusive lane occupied (watcher + write-guard semantics)
repoAnyBusy(repo)     → either lane occupied (diagnostics)
```

Rules:
- `run` (exclusive) fails iff another exclusive op holds the repo. A running
  *shared* op does not block it — the shared op is read-only, so a generate or
  batch starting under it cannot conflict on the tree; at worst the shared turn
  reads a tree the batch is mid-editing, same as the human does (Open question 3).
- `runShared` fails iff another shared op holds the repo (cap: one).
- `cancel`, `registerCancel`, `throwIfCancelled`, `clearPending` are already
  per-opId — unchanged.
- `markReviewThread` / `activeReviewThreadIds` — unchanged.

**Routing in `ipc.ts`:**

- `generate`, `sendBatch`: `operations.run` as today.
- `sendChat`: if the repo's exclusive lane is free → `operations.run` with the
  thread's own `executionMode` (today's behavior, byte for byte). If the exclusive
  lane is held → `operations.runShared` with the turn **forced read-only**
  (`readOnly: true` on the engine `ChatTurn`), and a `status` event up front so the
  stream shows "read-only turn — a review is generating". The decision is made in
  main (authoritative), not the renderer.

**Tool-profile enforcement per engine** (new `readOnly` flag on `ChatTurn`,
strictly stronger than today's `!writeEnabled`):

- *Claude* (`claude.ts chat`): switch from denylist to allowlist —
  `allowedTools: [...READ_SAFE, ...limnTools]` (Read/Grep/Glob + Limn only),
  `disallowedTools: ['Edit','Write','MultiEdit','NotebookEdit','Bash','WebFetch']`,
  `permissionMode: 'default'` regardless of the thread's tier, and a `canUseTool`
  that **denies** (not parks) anything outside the allowlist with "read-only turn
  while a review generates". Trust level: harness/tool-list enforcement, no OS
  sandbox — good but not bulletproof; the deny-all `canUseTool` is the second belt.
  Honest note: this is the weaker of the two engines.
- *Codex* (`codexAppServer.ts`): force `sandboxPolicy: { type: 'readOnly',
  networkAccess: false }` and `approvalPolicy: 'untrusted'` when `readOnly`,
  ignoring the thread's tier (today a `full`-tier chat gets `dangerFullAccess`).
  Trust level: OS-level (seatbelt) sandbox — strong.
- *Limn tools* stay available in both cases: they write only review metadata /
  comments to the app DB (`tools.ts` hosts no working-tree write tool), which is
  the point of the shared lane.

The thread's persisted `executionMode` is untouched — the coercion is per-turn.

**Event demux (the renderer work — the bulk of this feature):**

- `GenState` becomes a keyed map: `ops: Record<string /*opId*/, OpState>` where
  `OpState` = today's `GenState` minus the global-ness. Selectors:
  - `reviewOp(ops)` → the running op with `kind === 'review'` (GenPanel, Review.tsx
    header, `dev` flows).
  - `opForThread(ops, threadId)` → the running op streaming into a thread
    (ChatDrawer `streaming`, live segments, status line).
  - `anyRunning(ops)` where a global gate is genuinely wanted (watcher pill gate in
    `App.tsx:25`; see watcher rule below).
- `App.tsx`: `onOpEvent` routes by `msg.opId` into `ops[opId].log` (create-if-known:
  only opIds the renderer started — keeps the drop-unknown-opId behavior for
  second-window streams, matching today). `onOpResult` finishes `ops[opId]` and
  removes it after the outcome is consumed; `reload` handling unchanged but keyed.
- `startOp(kind, opId, threadId)` adds an entry instead of replacing the slot.
- Send guards change from `if (gen.running) return` to per-target checks:
  - `sendChat` / `followUp`: blocked only if the *target thread* already has a
    running op, or a shared op is already running (cap 1) — with visible feedback,
    not a silent return.
  - `sendBatch` / `sendQueuedComments` / `startGenerateNow` (GenPanel:34): blocked
    while any exclusive op runs (today's rule), with feedback.
- `genForLoaded` scoping (`store.ts:199`) generalizes: an op is shown only if its
  `threadId` belongs to the loaded review's chats (same rule, applied per entry).
- `cancelOp(opId)` — explicit opId; GenPanel's stop cancels the review op,
  ChatDrawer's stop cancels the active thread's op.

**Approval UI:** main already supports two live opIds (opId-keyed registry). The
renderer changes:

- Pending approvals derive per op: ChatDrawer shows the card for approvals from
  `opForThread(ops, active.id)` — i.e. you see a chat turn's approval when looking
  at that chat, and the generation's approval when looking at the review thread.
  GenPanel additionally surfaces a "needs approval" chip on the running strip when
  the review op has a parked request and the drawer isn't on that thread.
- `store.respondApproval(opId, requestId, decision)` — the card passes the opId of
  the op whose log carried the request.
- `ApprovalCard` itself needs no change (presentational); its *mount points* become
  per-op. Two cards can be live simultaneously only when they belong to different
  threads, and each thread view shows at most one — no stacked-card design needed.
- Note: a shared read-only turn should essentially never park approvals (deny-all
  on Claude, `untrusted` + readOnly sandbox on Codex auto-denies/never-asks), so in
  practice concurrent approvals means "generation asks while a chat streams" —
  rare, but now correct.

**UI copy:**

- Composer hint while the exclusive lane is busy and the user is in another chat:
  small badge above the composer — "Review is generating — replies run read-only
  until it finishes", ModeSelector rendered disabled with the same tooltip.
- The review thread itself stays non-sendable during its own generation (Open
  question 6): its composer keeps today's `streaming` disable.
- First status event of a shared turn: "read-only turn — a review is generating"
  (also lands in the persisted tool/status log, so history explains why the agent
  refused to edit).

**Watcher rule:** the poll's guard stays `operations.repoBusy(repo)` but that now
means *exclusive lane only*. A shared read-only turn cannot move the tree, so the
watcher keeps running under it — pure improvement (today a long chat turn blinds
the watcher for its whole duration even though the agent can't write). While
generate/batch hold the exclusive lane, the watcher skips exactly as today.
`App.tsx:25`'s renderer-side gate follows the same rule: ignore `repo:changed`
while an exclusive op runs (`reviewOp`/batch running), not while a shared chat
streams.

**Cancellation matrix:**

| Action | generate (exclusive) | chat (shared) |
|---|---|---|
| Cancel generate (GenPanel stop) | cancelled; its parked approvals denied via `clearPending(genOpId)` | unaffected — different opId, different `AbortController`, approvals keyed separately |
| Cancel chat (drawer stop) | unaffected | cancelled; `clearPending(chatOpId)` |
| Generate finishes → `reload` | op entry cleared | keeps streaming; `ops` map survives `reload()` (store `set` on `loaded` doesn't touch `ops`) — verify with a test |
| Chat turn fails (`reload: true` on failure, `ipc.ts:587`) | generation stream unaffected; reload is a read (`loadSession`) — safe mid-generate | entry finished |
| App-level `resumeExisting` reset (`store.ts:776`) | resets the whole `ops` map — acceptable: switching sessions mid-op already orphans the stream today; main keeps running and the op:result is dropped by the unknown-opId rule | same |

Main-side cancellation needs zero changes: `cancel(opId)` → per-op
`AbortController` (Claude) / `conn.dispose()` (Codex), already isolated.

### Option B — queueing with feedback (full design)

Keep one lane; make the second request wait instead of failing.

- `OperationCoordinator.run` gains a FIFO: if the repo is owned, park the work as
  `{ opId, resolve }` in a per-repo queue; emit an immediate synthetic
  `op:event { type: 'status', text: 'Queued behind the running review…' }` so the
  renderer stream shows something; dequeue in `finally`.
- Pre-start cancel must work while queued: `cancel(opId)` on a queued entry removes
  it and settles the outcome `cancelled` (the existing `cancelled` set +
  `throwIfCancelled` at `run` entry already almost does this — the queue check
  happens before `work()` runs).
- Renderer: `startOp` as today but the op begins in a `queued: true` state until
  the first real engine event; ChatDrawer shows "Queued — a review is generating
  (n ahead)" in the live bubble; composer stays enabled for typing but sends stack
  up (or stay disabled with the queue note — simpler).
- The renderer still tracks ONE running op at a time from its own perspective…
  except it doesn't: the queued op has an opId and a `startOp` entry while the
  running generation also streams. **So even Option B needs the per-op `ops` map
  (or at minimum a second "queued op" slot) and the `App.tsx` demux fix** — the
  op:result for the queued op must not be dropped because `gen.opId` points at the
  generation. This is the underappreciated cost of B: the renderer's single-op
  assumption has to be broken either way; B only avoids the tool-profile and
  approval-routing work.
- Watcher, approvals, cancellation semantics: unchanged (still strictly serial).

**What B does not deliver:** the actual feature. The answer to "what does this
migration touch?" arrives *after* a multi-minute generation finishes. B is a UX
patch for the silent no-op, not "chat while generation runs".

### Recommendation

**Option A, phased.** Phase 1 lands the renderer demux (`ops` map, per-op events,
per-op cancel/approval routing) plus the lock split and the forced read-only chat
profile — that is the feature. Queueing (B) is *not* recommended as a stepping
stone: its main-process half is throwaway (the FIFO dies when the lane split
lands) while its hard part (renderer demux) is the same work A needs. If a cheaper
interim is wanted, ship only B's feedback subset — disable the composer with a
"review is generating" note wherever sends are currently silent no-ops — which is
~20 lines of ChatDrawer/store and fully survives A.

The one honest caveat on A: the renderer demux touches every consumer of `gen`
(GenPanel, ChatDrawer, Review.tsx, Questions.tsx, App.tsx, dev flows — 20+ usage
sites found) and is the majority of the diff. It is mechanical (selector-shaped)
but wide.

## Detailed design for the recommended option

### 1. Lock model (`src/main/operations.ts`)

```ts
interface RepoLanes { exclusive?: string; shared?: string }   // opIds
private repoOwners = new Map<string, RepoLanes>()

repoBusy(repo)                 // exclusive lane occupied — watcher + gating keep this name
async run(opId, repo, work)    // exclusive: RepoBusyError iff lanes.exclusive
async runShared(opId, repo, work)  // shared: RepoBusyError iff lanes.shared
```

Both acquire at entry, release their own lane in `finally`, keep the existing
`cancelled`-set / `registerCancel` / `clearPending` plumbing untouched (all already
opId-keyed). `RepoBusyError` gains a `lane` field for better messages
("Another chat turn is already running" vs "…operation…").

### 2. `ipc.ts` routing

`sendChat` (`ipc.ts:519`):

```ts
const exclusiveHeld = operations.repoBusy(repo)
const outcome = exclusiveHeld
  ? await operations.runShared(opId, repo, () => turn({ readOnly: true }))
  : await operations.run(opId, repo, () => turn({}))
```

`turn({ readOnly })` is today's body with `readOnly` forwarded into
`engine.chat({ ..., readOnly })` and, when set, a leading
`recorder.emit({ type: 'status', text: 'Read-only turn — a review is generating' })`.
Small TOCTOU note: `repoBusy` is checked, then `run` acquires — if the generation
finishes in between, the turn simply runs exclusive with full tier; if a generation
*starts* in between, `run` returns `RepoBusyError` and the renderer may retry as
shared (or we re-check inside; either is fine — recommend one internal retry in the
handler).

`generate` / `sendBatch`: unchanged (`operations.run`).

### 3. Tool-profile enforcement (`ChatTurn.readOnly?: boolean` in `engines/types.ts`)

- **Claude** (`claude.ts:194-229`): when `readOnly` —
  `allowedTools: [...READ_SAFE, ...limn.allowedTools]` only;
  `disallowedTools: ['Edit','Write','MultiEdit','NotebookEdit','Bash','WebFetch','WebSearch']`;
  `permissionMode: 'default'` (ignore `executionPolicy(turn.executionMode)`);
  `canUseTool` variant that returns `deny` with a read-only explanation instead of
  parking on `awaitDecision`. Never pass `allowDangerouslySkipPermissions`.
- **Codex** (`codexAppServer.ts`): when `readOnly` — `sandboxPolicy: { type:
  'readOnly', networkAccess: false }`, `approvalPolicy: 'untrusted'`, `writeEnabled`
  forced false, regardless of tier (this specifically overrides `full` →
  `dangerFullAccess`).
- **FakeEngine** (`fake.ts`): accept and record the flag for tests.

Trustworthiness, stated plainly: Codex read-only is OS-sandbox-enforced (strong);
Claude read-only is harness-enforced tool filtering plus a deny-all permission
callback (adequate, not a security boundary). Since the alternative today is *no*
concurrent turn at all, and the failure mode is an approval-denied tool call rather
than a silent write, this is acceptable; the deny message tells the model why.

### 4. Renderer event demux (`store.ts`, `App.tsx`)

- `gen: GenState` → `ops: Record<string, OpState>`; `OpState` keeps today's fields
  (`kind`, `threadId`, `log`, `error`, `startedAt`, `outcome`, `running`) plus
  `readOnly?: boolean` (set from the leading status event or a new envelope field —
  status-event sniffing is fine for v1).
- Selectors exported from `store.ts`: `reviewOp(ops)`, `opForThread(ops, id)`,
  `anyExclusiveRunning(ops)` (kind 'review' or batch-flagged chat — see below),
  `genForLoaded` reimplemented per-op.
- Batch turns are `kind: 'chat'` today (`OpResultMsg.kind`); the renderer needs to
  know a chat op is exclusive/write-capable to gate Generate correctly. Simplest:
  `startOp` already knows the send path — record `exclusive: boolean` at start
  (`sendBatch` → true; `sendChat` → decided by main… renderer doesn't know). Good
  enough v1 rule: Generate is disabled while *any* op runs in this repo except a
  read-only shared chat; the renderer learns read-only from the status sniff, and
  main is authoritative anyway (a wrong guess = RepoBusyError toast, not corruption).
- `App.tsx`: route by `msg.opId` into the map; unknown opIds still dropped.
  `onOpResult`: `finishOp(opId, status, error)`; reload behavior unchanged.
- Guard rewrites (all currently `if (gen.running) return`):
  - `store.sendChat` / `sendChatToThread` / `followUp`: block iff
    `opForThread(ops, targetId)` running or a shared op is already running; on
    block, set a visible notice instead of returning silently.
  - `store.sendBatch` / `sendQueuedComments`: block iff `anyRunning` (batch always
    needs the exclusive lane and queueing isn't in scope).
  - `GenPanel.startGenerateNow` (`GenPanel.tsx:34`) and its `disabled={gen.running}`
    sites: `anyExclusiveRunning`.
  - `Questions.tsx`, `Review.tsx:543`, dev flows: mechanical selector swaps.
- `cancelOp(opId)`; `respondApproval(opId, requestId, decision)`.

### 5. Approval UI

- ChatDrawer: `pendingApprovals` computed from `opForThread(ops, active.id).log`;
  the answered-set resets keyed by that op's id (`ChatDrawer.tsx:65-69`).
  `onDecide` → `respondApproval(op.opId, ...)`; `onStop` → `cancelOp(op.opId)`.
- GenPanel running strip: when `reviewOp` has an unanswered `approval_request`,
  show an "Approval needed → open review chat" chip that opens the review thread
  (`openChat(reviewThreadId)`), where the normal card renders. No new card surface.
- `approvals.ts`: no changes (verified multi-op-safe).

### 6. Watcher rule

Unchanged line, changed meaning: `if (operations.repoBusy(repo)) return`
(`ipc.ts:79`) now suppresses polling only while the *exclusive* lane is held.
Shared read-only turns no longer blind the watcher (behavioral improvement over
today for plain chats, which currently suppress it despite being unable to write —
except via approved Claude Bash, which the shared profile now forbids). Plain
*exclusive* chats (repo idle, write-capable tier) still suppress it, as today.
Renderer `App.tsx:25` gate mirrors: ignore `repo:changed` while
`anyExclusiveRunning`, process it during shared-only activity.

### 7. Cancellation

See matrix above. Implementation deltas: none in main; renderer `cancelOp(opId)`
plus per-surface stop buttons already map 1:1 to ops (GenPanel stop → review op;
drawer stop → active thread's op; ApprovalCard stop → owning op).

## Dependencies

- **`busy_timeout` + cross-process SQLite hardening** — pending item in the
  robustness-sweep spec (`specs/robustness-sweep/`; not yet written as of this
  draft — the `specs/` tree starts with this document). In-process concurrency is
  safe on the single synchronous connection (see Problem), but desktop + `limn
  serve` sharing the DB file can hit `SQLITE_BUSY` today, and this feature widens
  write-overlap windows. The shared lane should not *block* on that item, but the
  robustness sweep should land `PRAGMA busy_timeout` before or alongside it.
- Codex app-server sandbox/approval enums pinned per binary version
  (`executionMode.ts:12-14` note) — the forced-read-only mapping reuses existing
  enum values (`readOnly`, `untrusted`), no new pinning needed.
- No IPC schema changes; no DB migrations.

## Test plan

**Main (vitest, extends `tests/operations.test.ts`):**
- `runShared` succeeds while `run` holds the repo; second `runShared` fails
  `RepoBusyError`; both lanes release independently in `finally`.
- `run` succeeds while only a shared op holds the repo (Open question 3's chosen
  answer, encoded).
- `cancel(sharedOpId)` cancels only the shared op; the exclusive op's
  `registerCancel` never fires (and vice versa) — extends the pattern of
  `operations.test.ts:18-32`.
- `repoBusy` true only for the exclusive lane.
- Approvals: park one request under each of two live opIds; `resolveDecision`
  routes to the right one; `clearPending(opA)` leaves opB parked (extends
  `tests/approvals.test.ts`).

**Engine profiles:**
- Claude: `readOnly` turn builds options with no Bash/Edit/Write in
  `allowedTools`, `permissionMode 'default'` even for `full` tier, deny-all
  `canUseTool` (unit-test the options builder — extract it if needed).
- Codex: `sandboxPolicyFor`-equivalent path emits `readOnly` sandbox +
  `untrusted` approval for a `readOnly` turn in every tier including `full`.
- FakeEngine records the flag; ipc-level test drives `sendChat` during a
  FakeEngine `generate` and asserts the chat ran shared + read-only.

**Renderer (vitest + happy-dom, extends `gen-cancel.test.ts` style):**
- `ops` reducer: two `startOp`s coexist; `pushOpEvent` routes by opId; `finishOp`
  of one leaves the other streaming; unknown opId dropped.
- `opForThread` / `reviewOp` selectors; `genForLoaded` per-op scoping.
- ChatDrawer: while a review op streams into thread R, composer on thread C is
  enabled and shows the read-only badge; approvals from op-R render only when R is
  active; `respondApproval` called with R's opId.
- Send-guard feedback: `sendChat` to a thread with a running op sets the visible
  notice (no silent return).

**Manual/e2e (FakeEngine flows):** generate a review, mid-stream ask a question in
a second chat; observe both streams; cancel each independently; confirm the watcher
pill still updates on an external commit during a shared-only chat turn.

## Open questions to resolve before implementation

1. **Should `generate` be tightened to enforced read-only** (drop Bash from
   Claude's gen `allowedTools`; Codex gen `readOnly` sandbox instead of
   `writeEnabled: true`/`edits`) so it could later become shareable?
   *Recommended:* not in this spec — keep generate exclusive; file the profile
   tightening separately (it may regress agents that use scratch files during
   exploration, and Codex gen's `workspaceWrite` looks deliberate).
2. **Shared-lane capacity: exactly one concurrent chat turn?** *Recommended:* yes.
   One exclusive + one shared bounds renderer complexity (two live streams max) and
   matches real usage; lift later if needed.
3. **May an exclusive op start while a shared turn is streaming** (user hits
   Generate mid-question)? *Recommended:* yes — the shared turn is read-only, so
   there is no tree conflict; the alternative (reject with "wait for the chat")
   feels arbitrary. The shared turn may observe the batch's intermediate tree
   state, same as the human.
4. **Coerce silently or ask?** When a send happens during generation, do we coerce
   to read-only with a badge, or require an explicit "send as read-only?" step?
   *Recommended:* coerce + badge + leading status event; an extra confirm adds
   friction to the exact flow we're unblocking.
5. **Claude read-only allowlist contents** — Read/Grep/Glob + Limn only, or also
   WebFetch/WebSearch/Task? *Recommended:* strict minimum (Read, Grep, Glob, Limn
   tools); no network, no subagents. Expand only on demonstrated need.
6. **Can the review thread itself take chat turns during its own generation?**
   (The generation streams into that thread and binds its engine session only at
   the end — a concurrent turn would race the session binding and interleave two
   live streams in one thread view.) *Recommended:* no — keep the review thread's
   composer disabled while its op runs; shared turns go to other threads (or a new
   draft chat, which the drawer already mints lazily).
7. **How does the renderer learn a running op is read-only/shared** — sniff the
   leading status event, or add an optional `lane`/`readOnly` field to
   `OpEventMsg`/`OpResultMsg`? *Recommended:* add an optional `lane` field to the
   envelope (`src/shared/ipc.ts`) — one line, typed, no sniffing; still no breaking
   protocol change.
8. **Failure copy for the shared-lane-full case** (a second concurrent chat while
   one is streaming): silent disable with tooltip, or toast on attempt?
   *Recommended:* disable the composer send button with tooltip "Another chat turn
   is running — it'll be sendable when it finishes"; never silent-drop a typed
   message (keep the draft in the box).
9. **Does Phase-1-style feedback ship first** (B's feedback subset: disabled
   composer + explanation everywhere sends currently no-op silently), or land only
   with the full lane split? *Recommended:* ship the feedback subset immediately —
   it is small, user-visible, and every line survives Option A.
