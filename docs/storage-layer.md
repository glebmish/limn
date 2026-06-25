# Storage Layer

How Limn persists review state: SQLite schema, the session-identity model, migrations, and the data-access layer.

> **Audience:** developers working on the main process. This describes architecture and the invariants you can break, not every function. See the source in `src/main/db/` and the shapes in `src/shared/types.ts`.

## Overview

All review state — sessions, comments, chat, iterations, approvals, pinned dirs, scan caches, prefs — lives in a single SQLite file. Everything else (diffs, file content, branch SHAs) is read live from git and is **never** persisted; git is ground truth, the DB only stores the *review layer* on top of it.

- **Engine:** Node's built-in `node:sqlite` (`DatabaseSync`). No third-party driver. All access is **synchronous**.
- **Location:** `<app userData>/limn.db`, opened once at app-ready in `src/main/index.ts` and threaded explicitly into `registerIpc(db, …)`.
- **No singleton:** the `db` handle is passed as the first argument to nearly every DAO function. There is no module-level global — this is deliberate, so tests open throwaway temp DBs.
- **Concurrency model:** single writer. One connection, on the main process, in WAL mode. There is no `SQLITE_BUSY` retry logic and the design assumes nothing else writes the file.

### Files

| File | Responsibility |
|------|----------------|
| `db/db.ts` | Open, pragmas, corruption recovery, migration runner |
| `db/migrations.ts` | The forward-only migration list (the schema *is* the migrations) |
| `db/sessions.ts` | The session/comment/chat/iteration/artifact DAO |
| `db/pins.ts` | Pinned dirs + scan-cache DAO |

## Connection setup & resilience

`openDb(file)` performs, in order:

1. `new DatabaseSync(file)`
2. `PRAGMA journal_mode = WAL`
3. `PRAGMA foreign_keys = ON`
4. `PRAGMA integrity_check` → throws if not `ok`
5. `migrate(db)`

Two failure modes are handled **differently**, and the distinction is load-bearing:

- **Corruption** — if steps 1–4 throw, the file is renamed aside to `<file>.corrupt-<timestamp>`, the `-wal`/`-shm` sidecars are removed, and a fresh DB is created. The backup path is returned as `recoveredFrom` and surfaced to the UI as a boot notice. **This loses data** (recreated empty).
- **Migration failure** — if `migrate()` throws, the DB is closed and the error rethrown, leaving the file **intact**. A migration failure must never be mistaken for corruption, or user data is silently sacrificed.

> ⚠️ The discriminator is purely *which function throws*. If you ever make `open()` throw for a recoverable reason, you route it down the data-losing corruption path.

> ⚠️ `PRAGMA foreign_keys = ON` is **per-connection**. Every `ON DELETE CASCADE` in the schema depends on it. Any code that opens its own `DatabaseSync` without going through `openDb` silently loses FK enforcement.

## Schema

One migration (v1) creates the whole schema. `meta(key, value)` is created separately by `migrate()` itself and holds only `schema_version`.

### Core entity graph

```text
repos ──1:N──> sessions ──1:N──> comments
                        ├──1:N──> chat_messages
                        ├──1:N──> iterations
                        ├──1:N──> viewed_files
                        ├──1:N──> reviewed_sections
                        ├──1:N──> artifacts
                        └──1:N──> artifact_approvals

pinned_dirs ──1:1──> scan_cache
```

Every child→parent FK is `ON DELETE CASCADE`. Deleting a session drops all of its children in one statement — relied on by `removePin`.

### Tables

| Table | Purpose / notable columns |
|-------|---------------------------|
| `meta` | `schema_version` only. Created outside migrations. |
| `prefs` | App key/value (e.g. `engine`). Accessed directly, not via a DAO. |
| `pinned_dirs` | Dashboard pins. `path UNIQUE`, `position` for ordering. |
| `scan_cache` | One row per pin; `tree_json` is the serialized directory scan. Cascades on pin delete. |
| `repos` | `path UNIQUE`, `last_opened_at` (drives recents), `first_commit_sha` (identity hint). |
| `sessions` | The core table — see below. |
| `comments` | PK `(session_id, id)`; full `Comment` in the `json` blob; `status` duplicated as a column for `unresolvedCount`. |
| `chat_messages` | Autoincrement id (read order), `role`, `text`, optional `anchor_json`. |
| `iterations` | PK `(session_id, n)`; `engine_session_id` is the **external engine's thread id** used to resume chat/fix; `end_sha`, `summary`. |
| `viewed_files` | PK `(session_id, file)`; per-file "viewed at SHA" markers. |
| `reviewed_sections` | PK `(session_id, section_id)`; set membership. |
| `artifacts` | PK `(session_id, path)`; `role IN ('spec','plan')` — spec/plan markdown the review is judged against. |
| `artifact_approvals` | PK `(session_id, path)`; per-artifact approved SHA. |

JSON-blob columns: `scan_cache.tree_json`, `sessions.annotations_json` (the full `ReviewAnnotations`), `comments.json` (the full `Comment`), `chat_messages.anchor_json` (a `CommentAnchor`).

> Several columns are **denormalized for cheap list queries**: `sessions.title`/`summary` mirror fields inside `annotations_json`; `comments.status` mirrors a field inside `comments.json`. Keep them in sync when you write.

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
- **Reviewed / approved SHAs:** `sessions` carries `reviewed_at_sha` (set on every generate, = diff head) and `approved_sha` (set on explicit approve). The review's baseline is `approved_sha ?? reviewed_at_sha`; when it differs from the current head, a "since" diff highlights what moved. `viewed_files.sha` does the same per file; `artifact_approvals` per artifact.

## Migrations

- **Versioning:** a string in `meta.schema_version` (default `0`), **not** the `user_version` pragma and **not** a migrations table.
- **Application:** for each `MIGRATIONS` entry with `version > current`, run inside an explicit `BEGIN`/`COMMIT` calling `up(db)` then upserting the new version. Any throw triggers `ROLLBACK` and rethrows — each migration is atomic, and a failure leaves `schema_version` and the schema untouched.
- **Forward-only.** Never edit a shipped migration; append a new `{ version, up }`. There are no down-migrations.
- **DDL uses bare `CREATE TABLE` (no `IF NOT EXISTS`) on purpose** — re-running a migration must fail loudly rather than silently no-op. The test suite exploits exactly this to confirm a migration failure preserves data. Do not "helpfully" add `IF NOT EXISTS`.

## Data-access layer

Every function takes `db` first. Highlights and contracts:

**`sessions.ts`**
- `ensureRepo` / `touchRepo` / `recentRepoPaths` — repo upserts keyed on path; `first_commit_sha` only fills if currently null.
- `createSession`, `getSession`, `findSession` (keyed on identity + `archived_at IS NULL`), `archiveSession`, `retargetSession`.
- `updateSessionMeta(db, id, patch)` — dynamic partial UPDATE; **no-ops on an empty patch and does not bump `updated_at`**. Each field is gated on `!== undefined`, so you **cannot clear a column to NULL** through this API.
- `upsertComment` / `deleteComment` / `unresolvedCount` (counts `status IN ('queued','sent')`).
- `addChat`, `addIteration`.
- **Transactional, replace-semantics** helpers: `resetIterations` (regenerate — wipes stale `n>1` rows so a fix can't resume the wrong engine thread), `setArtifacts`, `replaceUiState` (delete-all-then-reinsert per field — replace, not merge).
- `loadReviewState(db, id)` — the assembler. Reads one row-set per child table, JSON-parses blobs, maps DB column names back to TS shapes. **Comments are ordered `(created_at, id)`, chat by `id`, iterations by `n`; the set-like tables are read without `ORDER BY`** (fine because they become sets/objects — don't start relying on their row order).

**`pins.ts`**
- `listPins` (by `position`), `addPin` (appends at `MAX(position)+1`; UNIQUE violation rethrown as "already pinned"), `removePin`.
- `getScanCache` **swallows JSON-parse errors** and returns null, so a corrupt cache row degrades to a rescan instead of crashing the dashboard. `setScanCache` upserts on `pin_id`.

### Transaction model — sharp edges

- Transactions are raw `db.exec('BEGIN'|'COMMIT'|'ROLLBACK')`. **There is no savepoint / reentrancy support.** The transactional DAOs assume they are top-level — wrapping one inside an outer transaction throws on the nested `BEGIN`.
- **Asymmetric JSON error handling:** `scan_cache` corruption is swallowed, but `comments.json` / `annotations_json` / chat `anchor_json` are `JSON.parse`d with no guard in `loadReviewState` — a malformed blob there fails the whole session load.
