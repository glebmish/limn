# Storage Layer

How Limn persists review state: SQLite schema, the session-identity model, migrations, and the data-access layer.

> **Audience:** developers working on the main process. This describes architecture and the invariants you can break, not every function. See the source in `src/server/db/` and the shapes in `src/shared/types.ts`.

## Overview

All review state — sessions, comments, chat, iterations, approvals, prefs — lives in a single SQLite file. Everything else (diffs, file content, branch SHAs) is read live from git and is **never** persisted; git is ground truth, the DB only stores the *review layer* on top of it.

- **Engine:** Node's built-in `node:sqlite` (`DatabaseSync`). No third-party driver. All access is **synchronous**.
- **Location:** `<app userData>/limn.db`, opened once at app-ready in `src/server/index.ts` and threaded explicitly into `registerIpc(db, …)`.
- **No singleton:** the `db` handle is passed as the first argument to nearly every DAO function. There is no module-level global — this is deliberate, so tests open throwaway temp DBs.
- **Concurrency model:** WAL mode with a 5 s `busy_timeout`. More than one Limn process can open the same file (an installed service plus a foreground `limn service serve` on another port, say); readers never block, and a writer colliding with another writer waits up to 5 s for the lock before throwing rather than failing instantly. There is no application-level `SQLITE_BUSY` retry loop beyond that wait.

### Files

| File | Responsibility |
|------|----------------|
| `db/db.ts` | Open, pragmas, corruption recovery, migration runner |
| `db/migrations.ts` | The forward-only migration list (the schema *is* the migrations) |
| `db/sessions.ts` | The session/comment/chat/iteration/artifact DAO |

## Connection setup & resilience

`openDb(file)` performs, in order:

1. `new DatabaseSync(file)`
2. `PRAGMA journal_mode = WAL`
3. `PRAGMA busy_timeout = 5000`
4. `PRAGMA foreign_keys = ON`
5. `PRAGMA integrity_check` → throws if not `ok`
6. `migrate(db)`

Three failure modes are handled **differently**, and the distinctions are load-bearing:

- **Corruption** — if `open()` (steps 1–4) throws *and* `isCorruptionError(err)` matches (an `integrity_check` failure, `SQLITE_NOTADB`, "file is encrypted", "malformed", etc.), the file is renamed aside to `<file>.corrupt-<timestamp>`, the `-wal`/`-shm` sidecars are removed, and a fresh DB is created. The backup path is returned as `recoveredFrom` and surfaced to the UI as a boot notice. **This loses data** (recreated empty).
- **Transient open failure** — if `open()` throws but the error is *not* corruption (lock contention from a concurrent desktop+web open, a permissions error, `SQLITE_BUSY`), it is **rethrown with the file intact**. The recovery path is never taken, so a momentary failure can't drop the user's real database.
- **Migration failure** — if `migrate()` throws, the DB is closed and the error rethrown, leaving the file **intact**.

> ⚠️ The discriminator is `isCorruptionError(err)` (a message match), **not** "which function threw." If you ever change that classifier, be conservative: a false positive routes recoverable errors down the data-losing corruption path. When unsure, rethrow rather than recover.

> ⚠️ Always open the database through `openDb` — it is **lint-enforced as the sole entrypoint** (`no-restricted-imports` on `node:sqlite`, everywhere in `src/` except `db/db.ts`; type-only imports stay allowed). A raw `new DatabaseSync()` would skip WAL, `busy_timeout`, the integrity check, and migrations. (FK enforcement specifically would *not* be lost — `node:sqlite` defaults `enableForeignKeyConstraints: true`, so `PRAGMA foreign_keys` is already `ON` on a bare connection; the explicit pragma is belt-and-suspenders.)

## Schema

Migration v1 creates the bulk of the schema; later migrations extend it (v2 chat-message segments, v3/v4 `session_approvals` and its surface-hash re-key, v5 `chat_messages.comment_refs_json`, v6 `excluded_files`, v7 `iterations.scope`). `meta(key, value)` is created separately by `migrate()` itself and holds only `schema_version`.

### Core entity graph

```text
repos ──1:N──> sessions ──1:N──> comments
                        ├──1:N──> chat_threads ──1:N──> chat_messages
                        ├──1:N──> iterations
                        ├──1:N──> viewed_files
                        ├──1:N──> reviewed_sections
                        ├──1:N──> artifacts
                        ├──1:N──> artifact_approvals
                        ├──1:N──> session_approvals
                        └──1:N──> excluded_files
```

Every child→parent FK is `ON DELETE CASCADE`. Deleting a session drops all of its children — comments, chat_threads (and their chat_messages), iterations, viewed_files, reviewed_sections, artifacts, artifact_approvals, session_approvals, excluded_files — in one statement.

### Tables

| Table | Purpose / notable columns |
|-------|---------------------------|
| `meta` | `schema_version` only. Created outside migrations. |
| `prefs` | App key/value (e.g. `engine`). Accessed directly, not via a DAO. |
| `repos` | `path UNIQUE`, `last_opened_at` (drives recents), `first_commit_sha` (identity hint). |
| `sessions` | The core table — see below. |
| `comments` | PK `(session_id, id)`; full `Comment` in the `json` blob; `status` duplicated as a column for `unresolvedCount`. |
| `chat_threads` | Autoincrement id; parent of `chat_messages`. `kind IN ('review','user')`, `engine`/`model`/`reasoning_effort`/`execution_mode`, `engine_session_id` (resume key), `title`. |
| `chat_messages` | Autoincrement id (read order); hangs off `chat_threads` (`thread_id`), not the session directly. `role`, `text`, `at`; optional `anchor_json`, `segments_json` (v2 — ordered text↔tool segments for inline tool-call rendering), `comment_refs_json` (v5), `actions_json`, `tools_json`. |
| `iterations` | PK `(session_id, n)`; `engine_session_id` is the **external engine's thread id** used to resume chat; `end_sha`, `summary`, `scope` (v7 — `full` \| `scoped`). |
| `viewed_files` | PK `(session_id, file)`; per-file "viewed at SHA" markers. |
| `reviewed_sections` | PK `(session_id, section_id)`; set membership. |
| `artifacts` | PK `(session_id, path)`; `role IN ('spec','plan')` — spec/plan markdown the review is judged against. |
| `artifact_approvals` | PK `(session_id, path)`; per-artifact approved SHA. |
| `session_approvals` | PK `(session_id, hash)`; every branch surface explicitly approved for the session. Clean surfaces use `hash = sha`; dirty surfaces use a hash of the commit plus uncommitted working-tree content/status. |
| `excluded_files` | PK `(session_id, file)`; per-file exclude override for untracked files. `excluded` 1 = hidden from the review, 0 = an explicit keep overriding the auto "orphan untracked file in a narrated review is excluded" default; absent rows fall back to that default. |

JSON-blob columns: `sessions.annotations_json` (the full `ReviewAnnotations`), `comments.json` (the full `Comment`), `chat_messages.anchor_json` (a `CommentAnchor`).

> Several columns are **denormalized for cheap list queries**: `sessions.title`/`summary` mirror fields inside `annotations_json`; `comments.status` mirrors a field inside `comments.json`. These mirrors are single-write-path enforced, not kept in sync by hand: `sessions.title`/`summary` are derived from `annotations` inside `updateSessionMeta` (the `SessionMetaPatch` type has no `title`/`summary` fields, so they cannot be written independently), and `comments.status` is written from the `Comment` object by `upsertComment`.

The only explicit index is the session-pair index below. Child tables are covered by their composite primary keys; there is no standalone index on `sessions.repo_id` (volume is small).

## Session identity — the central invariant

A session represents a review of one **(base, compare) ref pair** in one repo. Each side is a `RefPair` of `kind` (`branch` | `commit`), a `symbol` (branch name), and an `anchorSha`.

Identity is computed per side as:

- **branch** → `b:<branch name>`
- **commit** → `c:<sha>`

So **branch sides key on name** (the branch follows its tip; anchor-SHA drift is ignored and used only to display "since you reviewed") and **commit sides key on SHA** (frozen).

This rule exists in **two places that must stay in lockstep**:

- `refIdentity()` in `src/shared/types.ts` (JavaScript, used by `findSession`)
- the `base_ident` / `compare_ident` **`GENERATED ALWAYS AS … STORED`** columns on `sessions` (SQL)

> ⚠️ If you change one without the other, `findSession` computes one key while the DB stores another — resumes silently miss and the app opens a new transient review instead of the expected saved one. Same rule, two implementations.

Multiple live sessions may share the same `(repo, base identity, compare identity)`.
This is intentional: "New review" creates another live session rather than archiving
or overwriting the old one. `findSession` returns the most recently touched live row
for an exact identity, which is the resume hint used by the default open path.

> ⚠️ `assertResolved()` guards a trap: a commit side with an empty `anchorSha` would collapse all unresolved commits onto identity `c:`. Creation/retarget throws rather than allow it.

### Lifecycle

- **Start vs resume:** resolve both ref inputs → `findSession`; if found, resume; else `createSession`. The renderer asks main for this lookup so branch and commit refs use the same identity logic.
- **Start fresh:** pass `fresh` to `startSession`; it skips `findSession` and creates another live session for the same pair. `archiveSession` only soft-deletes a row so it no longer appears in live lists or resume hints.
- **Reviewed / approved SHAs:** `sessions` carries `reviewed_at_sha` (set on every generate, = diff head) and `approved_sha` (the latest approval baseline pointer). `session_approvals` stores the full set of approved branch surfaces. Clean approvals are keyed by commit SHA; dirty approvals are keyed by a branch surface hash (`HEAD` plus uncommitted working-tree content/status). Reopening or checking out any previously approved surface shows as approved again. If the commit is approved but the dirty surface is not, the approval control shows the uncommitted-change approval affordance. The review's "since approved" baseline is the loaded HEAD when it is in the approved commit set, otherwise `approved_sha ?? reviewed_at_sha`. `viewed_files.sha` does the same per file; `artifact_approvals` per artifact.

## Migrations

- **Versioning:** a string in `meta.schema_version` (default `0`), **not** the `user_version` pragma and **not** a migrations table.
- **Application:** for each `MIGRATIONS` entry with `version > current`, run inside an explicit `BEGIN`/`COMMIT` calling `up(db)` then upserting the new version. Any throw triggers `ROLLBACK` and rethrows — each migration is atomic, and a failure leaves `schema_version` and the schema untouched.
- **Forward-only.** Never edit a shipped migration; append a new `{ version, up }`. There are no down-migrations.
- **DDL uses bare `CREATE TABLE` (no `IF NOT EXISTS`) on purpose** — re-running a migration must fail loudly rather than silently no-op. The test suite exploits exactly this to confirm a migration failure preserves data. Do not "helpfully" add `IF NOT EXISTS`.

## Data-access layer

Every function takes `db` first. Highlights and contracts:

**`sessions.ts`**
- `ensureRepo` / `touchRepo` / `recentRepoPaths` / `repoIndexRows` — repo upserts keyed on path; `first_commit_sha` only fills if currently null. The dashboard index includes repos that were opened even if no review session has been generated yet.
- `createSession`, `getSession`, `findSession` (keyed on identity + `archived_at IS NULL`), `archiveSession`, `retargetSession`.
- `updateSessionMeta(db, id, patch)` — dynamic partial UPDATE; **no-ops on an empty patch and does not bump `updated_at`**. Each field is gated on `!== undefined`, so you **cannot clear a column to NULL** through this API.
- `upsertComment` / `deleteComment` / `unresolvedCount` (counts `status IN ('queued','sent')`).
- `addChat`, `addIteration`.
- **Transactional, replace-semantics** helpers: `resetIterations` (regenerate — wipes stale `n>1` rows so a fix can't resume the wrong engine thread), `setArtifacts`, `replaceUiState` (delete-all-then-reinsert per field — replace, not merge).
- `loadReviewState(db, id)` — the assembler. Reads one row-set per child table, JSON-parses blobs, maps DB column names back to TS shapes. **Comments are ordered `(created_at, id)`, chat by `id`, iterations by `n`; the set-like tables are read without `ORDER BY`** (fine because they become sets/objects — don't start relying on their row order).

### Transaction model — sharp edges

- Transactions are raw `db.exec('BEGIN'|'COMMIT'|'ROLLBACK')`. **There is no savepoint / reentrancy support.** The transactional DAOs assume they are top-level — wrapping one inside an outer transaction throws on the nested `BEGIN`.
- **Guarded JSON parsing — salvages and reports:** every persisted blob (`comments.json`, `sessions.annotations_json`, chat `anchor_json`/`actions_json`/`tools_json`/`segments_json`/`comment_refs_json`, `iterations.annotations_json`) is parsed through `safeJson` in `loadReviewState` and its helpers. A malformed blob is salvaged per its kind (skip the comment/iteration row, drop the chat field, render annotations as not-yet-generated) rather than failing the whole session load; the degradations are summarized into `ReviewState.loadWarnings` and shown in the renderer's dismissible error strip. Stored data is never mutated or deleted on the read path.
