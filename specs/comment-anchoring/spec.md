# Diff-mapped comment anchoring

## Status: Resolved — all open questions answered (recommendations adopted); ready to implement

Replace the exact-text re-anchoring in `src/main/anchor.ts` with a three-stage
pipeline: (1) deterministic Gerrit-style position mapping through a blob diff
between the surface the comment was written against and the current surface,
(2) Hypothesis-style fuzzy context matching for lines inside actually-edited
regions, (3) the current exact-text match as the floor, then `outdated`.

---

## Problem

### Current algorithm

`reanchorComments` (`src/main/anchor.ts:5-55`) runs on every review assembly
(`src/main/review.ts:225`, called from `buildLoadedReview` → IPC `loadSession`
at `src/main/ipc.ts:313`, and again on `approve`/`unapprove` at
`src/main/ipc.ts:717,724`). For each unresolved `diff`/`artifact` comment it:

1. Scans every rendered hunk line for **exact string equality** with
   `anchor.lineContent` (`src/main/anchor.ts:19`).
2. Among duplicates, picks the candidate **nearest to the stale line number**
   (`pickNearest`, `src/main/anchor.ts:57-60`).
3. No match → `status = 'outdated'` (`src/main/anchor.ts:33`).
4. On success it **overwrites** `anchor.line`/`hunkRange` and the result is
   persisted (`src/main/review.ts:226`) — the original position is lost.

The anchor carries no notion of *what state of the file* the comment was
written against. `CommentAnchor` (`src/shared/types.ts:107-120`):

```ts
| { kind: 'diff'; file: string; side: 'new' | 'old'; line: number; hunkRange: string; lineContent: string }
| { kind: 'artifact'; path: string; line: number; lineContent: string }
```

Anchors are created in the renderer with only the rendered line's text
(`src/renderer/components/DiffView.tsx:252`,
`src/renderer/components/ArtifactDoc.tsx:66`) and by agent tools — which may
even pass `lineContent: ''` (`src/main/engines/tools.ts:91`). Persistence is a
JSON blob per comment (`comments.json` column,
`src/main/db/sessions.ts:253-257`); there is no anchor-specific schema.

### Concrete failure classes

1. **Trivial reformat ⇒ outdated.** Any change to the commented line's bytes —
   re-indent, trailing-whitespace strip, prettier pass, a renamed variable on
   the same line — fails the equality test at `src/main/anchor.ts:19` and the
   comment dies as `outdated` even though the code it discusses is untouched.
2. **Repeated identical lines mis-anchor.** A comment on `}` / `})` / blank
   line / `import ...` matches many candidates; `pickNearest`
   (`src/main/anchor.ts:57-60`) picks by line-number proximity, so an
   insertion above the target silently re-anchors the comment to a *different*
   `}`. A comment on an **unchanged** line can break or move purely because of
   duplicates elsewhere — this must never happen.
3. **Drift compounds and is unrecoverable.** Because the successful match
   overwrites `anchor.line` and is persisted (`src/main/anchor.ts:30`,
   `src/main/review.ts:226`), one wrong nearest-duplicate pick becomes the new
   proximity hint for every later load. There is no immutable record of where
   the comment originally lived.
4. **Context-window eviction ⇒ outdated.** Only hunk lines are searched
   (`src/main/anchor.ts:17-18`). A comment on a context line that later falls
   outside the `-U3` window (`DIFF_ARGS`, `src/main/git.ts:345`) — e.g. the
   nearby change gets reverted — goes `outdated` although the line is intact.
5. **Agent anchors with empty `lineContent`.** `src/main/engines/tools.ts:91`
   defaults `lineContent` to `''`, which either matches an arbitrary blank
   line or goes straight to `outdated` on the next load.
6. **Dirty-surface line-space flips.** When the tree is dirty, comments are
   created against the merged base→working-tree diff (worktree line numbers,
   `src/main/review.ts:220-224`); once committed, numbers are tip-space. Only
   the text match papers over this — with all the weaknesses above.

Pinned behavior today: `tests/anchor.test.ts` (exact match moves line,
missing text → outdated, nearest duplicate wins, side discipline, artifact
re-anchor by text, resolved/non-positional untouched).

---

## Prior art

**Gerrit patch-set position mapping.** Gerrit stores a comment against a
specific patch set and, when displaying it on a later one, maps its line
number through the edit list (diff) between the two file versions: lines in
unchanged regions map deterministically by offset accumulation; lines inside
edited regions are flagged and shown at the edge of the replacement region.
The key property: a comment on an unchanged line can *never* break or jump,
no matter how many identical lines exist elsewhere — the mapping is positional,
not textual.

**Hypothesis fuzzy anchoring.** The Hypothesis web annotator stores a quote
plus surrounding prefix/suffix context at creation, and re-anchors by fuzzy
string search (normalized, similarity-scored, position-hinted) when the exact
document offset no longer matches. It degrades gracefully: strong context
survives edits near the target. Limn already uses the quote+prefix+suffix
scheme for prose `selection` anchors (`src/shared/types.ts:120`,
`src/renderer/lib/selection.ts:32-57`).

**Why this combination.** Diff mapping is exact and cheap where it applies
(the overwhelmingly common case: the commented line itself didn't change) but
by definition cannot answer "where did this line go" inside an edited region.
Fuzzy context matching answers exactly that, at the cost of being heuristic —
so it is confined to the region the diff already proved was edited. Exact-text
match remains as the floor so legacy anchors (no v2 fields) never behave worse
than today.

---

## Goals / Non-goals

### Goals

- A comment on a line that is unchanged between its creation surface and the
  current surface **never** moves incorrectly and never goes `outdated` —
  regardless of duplicate lines, reformats elsewhere, rebases, or dirty edits
  in other parts of the file.
- Comments survive whitespace-only / trivial reformats of the commented line
  itself (via stage 2) above a similarity threshold.
- Anchors record the surface they were created against (SHA / blob), stamped
  in the **main process** so user- and agent-created comments both get it.
- Renames tracked; deleted files and truly-vanished lines still go `outdated`
  (correctly, with the original text preserved for the outdated card).
- Legacy comments (created before v2) degrade to today's behavior or better;
  they are healed forward (backfilled) when they anchor successfully.
- No new runtime dependency: all diffs computed via the existing `execGit`
  helper (`src/main/exec.ts`) + `parseUnifiedDiff` (`src/main/git.ts:247`).

### Non-goals

- Anchoring comments to lines **outside** any rendered diff as a first-class
  UI concept (a minimal "anchored, but not visible at this baseline" bucket is
  in scope; a full file viewer is not).
- Re-anchoring `selection` anchors (already content-addressed,
  `src/shared/types.ts:118-120`) or the other non-positional kinds
  (`section`, `summary`, `file`, `question`, `plan-step`, `title`,
  `acceptance`, `deviation`).
- Cross-file comment migration (a commented block moved to another file).
- Character-precision (sub-line) anchoring for diff comments.
- Changing how comments are *created* in the renderer UI.

---

## Design

### 1. Anchor data model v2

All new fields are **optional and additive** — anchors live inside the
`comments.json` blob (`src/main/db/migrations.ts:51-58`), so **no SQL schema
migration is required**. A comment without the v2 fields is a "legacy" anchor
and follows the degraded path (below).

```ts
// src/shared/types.ts

/** Immutable record of the surface a positional comment was created against.
 *  Written once by the main process at upsert time; never mutated afterwards. */
export interface AnchorStamp {
  /** compare tip (skeleton.headSha) at creation */
  headSha: string
  /** merge-base at creation — the blob source for side:'old' anchors */
  mergeBase: string
  /** git blob sha of THE FILE CONTENT the commented line lives in:
   *  - side 'new', clean tree:   blob of `headSha:path`
   *  - side 'new', dirty tree:   `git hash-object -w` of the on-disk file
   *  - side 'new', untracked:    `git hash-object -w` of the on-disk file
   *  - side 'old':               blob of `mergeBase:path`
   *  Undefined only if blob resolution failed (comment still gets context). */
  blobSha?: string
  /** line-number space of `line` at creation: tip-space ('committed') or
   *  worktree-space ('dirty' — the merged base→working-tree diff was shown) */
  surface: 'committed' | 'dirty'
  /** immutable original line + path (rename tracking starts from origPath) */
  origLine: number
  origPath: string
}

/** ±N exact context lines captured from the same content `blobSha` names.
 *  The durability floor: survives in SQLite even if the blob is GC'd. */
export interface AnchorContext {
  before: string[]   // up to CONTEXT_N lines above, in order
  after: string[]    // up to CONTEXT_N lines below, in order
}

// extended positional anchors (existing fields unchanged):
| { kind: 'diff'; file: string; side: 'new' | 'old'; line: number; hunkRange: string;
    lineContent: string; stamp?: AnchorStamp; context?: AnchorContext }
| { kind: 'artifact'; path: string; line: number; lineContent: string;
    stamp?: AnchorStamp; context?: AnchorContext }
```

`CONTEXT_N = 3` (mirrors `-U3`; enough to disambiguate every duplicate-line
case in practice while keeping comment JSON small).

**Mutability discipline** (fixes failure class 3): `stamp` and `context` are
written once and never touched. Re-anchoring may only update `line`,
`hunkRange`, `file` (on rename), and `status`. `lineContent` is refreshed to
the current text only on a *stage-2 (fuzzy)* success so the outdated-card
quote stays honest; stage 1 by construction lands on an identical line.

### 2. Stamping (creation-time enrichment, main process)

Enrich in one place so renderer comments, agent-tool comments
(`src/main/engines/tools.ts` `add_comment`), and any future producer are all
covered: in the IPC `upsertComment` handler (`src/main/ipc.ts:509`) and in the
tool host's comment path, via a new helper:

```ts
// src/main/anchor.ts (or a new src/main/anchorStamp.ts)
async function stampAnchor(workdir: string, session: SessionMeta, anchor: CommentAnchor): Promise<CommentAnchor>
```

Behavior for `kind: 'diff'` / `kind: 'artifact'` anchors **without** a stamp:

1. Resolve `headSha` = `headSha(repo, compareEff)`, `mergeBase` =
   `mergeBase(repo, baseEff, compareEff)` (both helpers exist,
   `src/main/git.ts:23-29`).
2. Determine surface: `isDirty(workdir)` **and the file has uncommitted
   changes / is untracked** → `'dirty'`, else `'committed'`. (Per-file check:
   `git status --porcelain -- <path>`; a clean file in a dirty tree is still
   tip-content, but the merged diff renders worktree line numbers — so the
   tree-level `dirty` flag from the load decides the *line space*, the
   per-file state decides the *blob source*.)
3. Resolve content + `blobSha`:
   - side `'old'` → `git rev-parse <mergeBase>:<path>` for the sha,
     `git show <mergeBase>:<path>` for content.
   - side `'new'`, committed → `git rev-parse <headSha>:<path>` /
     `git show <headSha>:<path>`.
   - side `'new'`, dirty or untracked → read the on-disk file (like
     `syntheticAddedFile`, `src/main/git.ts:185`), and persist the blob with
     **`git hash-object -w -- <path>`** so the content is recoverable later
     (see feasibility, §5). Note: the existing `hashObjects`
     (`src/main/git.ts:206-216`) computes the same sha but **without `-w`** —
     the blob is *not* in the object DB today. Add a `-w` variant.
4. Slice `context.before/after` (±3 lines) and — if the producer supplied an
   empty/absent `lineContent` (agent tools) — fill `lineContent` from the
   resolved content at `line`. This heals failure class 5.
5. Any git failure → stamp what resolved, leave the rest undefined; the
   comment is never rejected because stamping failed.

If a comment anchor arrives with a line/text that doesn't exist in the
resolved content (agent hallucination), stamp `blobSha`/shas but leave
`context` empty; the pipeline will treat it as legacy-grade.

Cost: a handful of git calls on each *comment creation* (rare, interactive) —
negligible.

### 3. The three-stage re-anchor pipeline

`reanchorComments` keeps its signature but becomes async and gains a git
context (`workdir`, current `skeleton`, `merged`/`volatile` state — all
already in scope at the call site `src/main/review.ts:220-226`):

```ts
export async function reanchorComments(
  ctx: { workdir: string; skeleton: DiffSkeleton; forAnchor: DiffSkeleton; dirty: boolean },
  comments: Comment[], artifacts: Artifact[]
): Promise<void>
```

Per positional, unresolved comment:

**Stage 0 — identity short-circuit.** Resolve the file's *current* blob sha:
`fileHash` is already attached to every rendered file when a worktree exists
(`src/main/review.ts:194-203`); for the old side use
`git rev-parse <currentMergeBase>:<path>`. If it equals `stamp.blobSha`, the
content is byte-identical → the line number is already correct in file space;
skip to the **render placement** step. This makes the steady state (nothing
changed since last load) free of git diff calls.

**Stage 1 — deterministic diff mapping** (requires `stamp.blobSha` and the
blob to be recoverable):

1. *Old content*: `git cat-file blob <stamp.blobSha>` (works for commit-tree
   blobs and `hash-object -w` loose blobs alike). If `cat-file` fails (blob
   GC'd) → stage 2.
2. *Rename tracking*: if the anchor's path is absent from the current surface,
   ask `git diff -M --name-status <stamp.headSha> <currentTip>` (committed
   stamps only) and follow an `R… old new` row from `stamp.origPath`; update
   `anchor.file` on success. Untracked/dirty-stamped files skip this (no
   commit to diff from) — a rename of an uncommitted file is a delete+add and
   falls through to stage 2 / outdated.
3. *New content*: side `'new'` → on-disk file in `workdir` when a worktree
   exists (matches what is rendered, dirty or clean), else
   `git show <currentTip>:<path>`. Side `'old'` →
   `git show <currentMergeBase>:<path>`.
4. *Edit list*: materialize both contents into the scratchpad-tmp dir and run
   `git diff --no-index --no-color -U0 -- old new` (exit code 1 is "differs",
   not an error — the exec wrapper must tolerate it). Parse with the existing
   `parseUnifiedDiff`. One code path covers every scenario combination.
   (`git diff <blobShaA> <blobShaB>` is an alternative when both are blobs;
   `--no-index` on temp files is the single universal form — chosen for
   uniformity.)
5. *Map* `L = anchor.line` (in old-content space; for legacy worktree-space vs
   tip-space mismatches see §Legacy) through the `-U0` hunks:

   ```
   delta = 0
   for each hunk (oldStart, oldLen, newStart, newLen) in order:
     if L < oldStart:               return L + delta          // unchanged region
     if L < oldStart + max(oldLen,1)                          // inside edited region
        and not (oldLen == 0):      return EDITED             // → stage 2
     delta += newLen - oldLen
   return L + delta                                           // after last hunk
   ```

   (`oldLen == 0` hunks are pure insertions — they sit *between* old lines and
   never contain L.) A line in an unchanged region maps **deterministically**;
   duplicates elsewhere are irrelevant. `EDITED` → stage 2 with the hunk's
   `newStart..newStart+newLen` range as the position hint.
6. On success: `anchor.line = mapped`, then **render placement** (below).

**Stage 2 — fuzzy context fallback** (edited region, GC'd blob, or legacy
anchor with context):

1. Candidate set: every line of the *new content* (full file, not just hunk
   lines — fixes failure class 4 for the matching step).
2. Normalize: trim, collapse internal whitespace runs to one space.
3. Score each candidate line `i`:
   `score = 0.5·sim(norm(line_i), norm(lineContent))`
   `      + 0.35·ctxSim(context, lines around i)`
   `      + 0.15·proximity(i, hint)`
   where `sim` is a token/character similarity (normalized Levenshtein or
   Dice on character bigrams — small hand-rolled helper, no dependency),
   `ctxSim` averages `sim` over the up-to-3 before/after context lines
   (missing context → weight redistributed onto the quote), and `proximity`
   decays with distance from the stage-1 hint (or `origLine` when no hint).
4. Accept the best candidate iff `score ≥ 0.75` (constant, table-tested).
   Empty-after-normalization quotes (`}`-only lines still normalize non-empty;
   truly blank quotes) are rejected outright — context must carry them, i.e.
   require `ctxSim ≥ 0.8` when `norm(lineContent) == ''`.
5. On success: `anchor.line = candidate`, refresh `lineContent` to the new
   text, → render placement. On failure → stage 3.

**Stage 3 — exact-text floor, then outdated.** Today's algorithm verbatim
(exact `lineContent` equality over rendered hunk lines, `pickNearest` on the
current `line` hint, side discipline) — this is the whole pipeline for legacy
anchors without `stamp`/`context`, so no legacy comment behaves worse than
today. No match → `status = 'outdated'` (and `line`/`lineContent` keep their
last values for the outdated card, `src/renderer/components/DiffView.tsx:264-271`).

**Render placement** (stages 0–2 successes): the mapped line is correct in
*file space*; the UI can only attach threads to rendered diff lines
(`src/renderer/components/DiffView.tsx:101-106`). Find the rendered line in
`forAnchor` hunks at (`side`, mapped line):

- found → set `hunkRange` from its hunk; if `status === 'outdated'` restore
  `'queued'` (matches today, `src/main/anchor.ts:31`).
- not found (line fell out of the diff at this baseline — reverted nearby
  change, `-U3` eviction) → the comment is **anchored but not visible**: keep
  it queued with the mapped line, and render it in a small per-file bucket
  ("N comments on lines not in this diff") next to the existing outdated
  bucket. It must *not* be marked outdated (failure class 4). ⇒ Open Q3.

**Artifact anchors** run the same pipeline with: new content = the artifact
file on disk (`loadArtifact` already reads it), old content = `stamp.blobSha`,
no side/mergeBase dimension, and render placement against `Artifact.lines`.

### 4. Legacy anchors and backfill

Comments created before v2 have no `stamp`/`context`.

- **Pipeline**: they run stage 2 *only if* a heal-forward stamp exists (it
  won't at first), so effectively stage 3 (today's behavior) on first load.
- **Heal-forward backfill**: whenever a legacy anchor re-anchors successfully
  (stage 3 exact match), immediately stamp it against the *current* surface —
  `stamp` from the current tip/mergeBase/on-disk blob (with `-w` when dirty),
  `context` sliced from the current content — and persist (the load path
  already persists every comment, `src/main/review.ts:226`). From the next
  change onward the comment enjoys the full pipeline.
- **No SQL migration**: the JSON is additive. If reviewers want an explicit
  marker, a `migrations.ts` version 7 could stamp-eagerly across all sessions,
  but that requires git access per repo inside a DB migration — wrong layer.
  Lazy heal-forward is the recommended story (Open Q6).
- Comments that are already `outdated` and stampless stay outdated (nothing
  to recover); their card still shows the stored quote.

### 5. Git plumbing (new helpers in `src/main/git.ts`)

All via the existing `execGit` (`src/main/exec.ts:3` — note: `--no-index`
needs an exec variant that treats exit code 1 as success):

```ts
/** blob sha of ref:path, or null if absent at that ref */
blobShaAt(dir, ref, path): Promise<string | null>          // git rev-parse <ref>:<path>
/** content of a blob by sha (committed or hash-object -w), null if missing/GC'd */
catBlob(dir, blobSha): Promise<string | null>              // git cat-file blob <sha>
/** content at ref:path */
showFile(dir, ref, path): Promise<string | null>           // git show <ref>:<path>
/** like hashObjects but persists loose blobs (-w) */
hashObjectsWrite(dir, paths): Promise<Map<string, string>> // git hash-object -w -- ...
/** -U0 edit list between two contents (temp files + --no-index), parsed */
diffContents(a: string, b: string): Promise<FileDiff | null>
/** rename map old→new between two committed states */
renameMap(dir, fromSha, toSha): Promise<Map<string, string>> // git diff -M --name-status
```

Plus pure functions in `src/main/anchor.ts`: `mapLine(editList, L)` (the
stage-1 walker), `fuzzyFind(content, quote, context, hint)` (stage 2 scorer),
`normalizeWs`, `similarity`.

### 6. Blob-recovery feasibility (verified against the code)

| Anchor scenario at creation | Old content recoverable? | How / caveat |
|---|---|---|
| Committed file, clean tree (side `new`) | **Yes** | `stamp.headSha:path`; blob remains in odb even after rebase (unreachable ≠ pruned; reflog keeps commits ~90 days, `git gc` prunes unreachable objects after `gc.pruneExpire`, default 2 weeks for loose / until repack for packed). After a prune → stage 2 via stored `context`. |
| Deleted/old-side line (side `old`) | **Yes** | `stamp.mergeBase:path`; merge-base commits are normally reachable from the base branch indefinitely. |
| Dirty tracked file | **Only if we write it** | Today `hashObjects` (`src/main/git.ts:206-216`) hashes **without `-w`** — the working-tree content is *not* in the odb, and nothing else snapshots it. v2 must run `git hash-object -w` at stamp time. Loose unreferenced blobs survive until `git gc` prune (≥ 2 weeks by default). After prune → stage 2 via `context`. |
| Untracked file | **Only if we write it** | Same as dirty: content exists solely on disk (`syntheticAddedFile` reads it, `src/main/git.ts:185-201`). `hash-object -w` at stamp time; else context-only. |
| Legacy comment (no stamp) | **No** | Nothing recorded but `lineContent`; stage 3 + heal-forward. |

**Verdict**: blob-vs-blob mapping is feasible in *every* scenario going
forward, provided (a) each anchor records `blobSha`+`headSha`+`mergeBase` at
creation and (b) dirty/untracked content is persisted with `hash-object -w`.
It is *not* guaranteed forever (gc pruning, expired reflogs), which is exactly
why the ±3 `context` lines live in SQLite as the durability floor — the
pipeline degrades from stage 1 to stage 2, never to a hard failure.

### 7. Per-scenario behavior matrix

"Creation surface" is what the stamp recorded; "event" is what happened before
the next load. ✔1 = stage-1 deterministic map, ✔2 = stage-2 fuzzy, — = not
applicable.

| Creation surface ↓ / Event → | file unchanged | file edited elsewhere | commented line edited | file renamed | file deleted | dirty work committed | branch rebased/amended |
|---|---|---|---|---|---|---|---|
| **Committed, clean tree** (side `new`) | stage 0 identity; line keeps | ✔1 maps through unchanged region — never breaks | ✔1 flags EDITED → ✔2 fuzzy; below threshold → stage 3 → outdated | rename map from `stamp.headSha` (git `-M` flows through `renameMap`); then ✔1 against renamed content | side `new` has no target → outdated (quote preserved) | — (was committed) | old blob still in odb → ✔1; if pruned → ✔2 via context |
| **Committed, side `old`** (comment on deleted line) | stage 0 vs current mergeBase blob | base moved: ✔1 through `diff(stamp.mergeBase:path, curMergeBase:path)` | line no longer deleted (change reverted/rebased away): mapped line absent from rendered old side → "not visible" bucket or outdated per Q3 | old-side path from base; rename map from `stamp.mergeBase` | file gone from base too → outdated | — | mergeBase blob normally still reachable → ✔1 |
| **Dirty tracked file** (worktree lines) | stage 0 vs on-disk `fileHash` | ✔1: old = `-w` blob, new = on-disk file | ✔2 | uncommitted rename = delete+add → ✔2 against the added file if the reviewer's flow re-creates it, else outdated | reverted/checkout-discarded → line gone from surface → outdated | ✔1: old = `-w` blob, new = `tip:path` — worktree-space maps cleanly to tip-space because the committed content *is* the old content (or one diff away) | `-w` blob unaffected by rebase → ✔1 |
| **Untracked file** | stage 0 (on-disk hash) | ✔1 (`-w` blob vs disk) | ✔2 | untracked rename invisible to git → outdated unless ✔2 re-finds text after the file reappears | file deleted → outdated | file gets committed: ✔1 (`-w` blob vs `tip:path`) | n/a |
| **Legacy (no stamp)** | stage 3 exact match; heal-forward stamps it | stage 3 (nearest-dup risk remains until healed) | stage 3 → outdated (today's behavior) | stage 3 fails (path keyed) → outdated (today's behavior) | outdated | stage 3 | stage 3 |

Cross-cutting: excluded untracked files carry no review state
(`fileEffectivelyExcluded`) — comments can't be created there; binary files
never get positional comments (no rendered lines).

---

## Performance considerations

Re-anchor runs inside `assembleReview` on every `loadSession`, `previewReview`
(no comments → no-op), `approve`, `unapprove`, plus after generation reloads.
Realistic scale: tens of comments per session, only the `diff`/`artifact`
subset is positional; files up to a few thousand lines.

- **Stage 0 dominates.** `fileHash` is already computed for every rendered
  file (`hashObjects` batch, `src/main/review.ts:196-201`); comparing it to
  `stamp.blobSha` costs nothing. In the steady state (load → nothing changed
  since the stamp or since the last heal) the whole pass makes **zero**
  additional git calls.
- **Group by blob pair.** Comments cluster on files: compute one edit list per
  distinct `(oldBlobSha, newBlobSha)` pair per pass, not per comment.
- **Content-addressed cache.** Edit lists are immutable for a blob pair —
  keep an in-process LRU (`Map<`${old}:${new}`, hunks>`, cap ~200 entries)
  across loads. Old-content strings themselves need no cache (cat-file is
  ~ms); cache only parsed edit lists.
- **Serialize per pass, not per comment.** One `git cat-file --batch` (or
  per-blob `cat-file blob`) round per distinct old blob; temp-file writes go
  to the session scratchpad dir.
- **Worst case** (rebase touched every commented file): ~1 `cat-file` +
  1 `diff --no-index -U0` per commented file — for 20 commented files well
  under 200 ms on a warm disk, and it happens once because the persisted
  re-anchor + stage-0 identity absorb the next load.
- **No quadratic fuzz.** Stage 2 scans only the target file's lines (O(lines ×
  quote length) with cheap similarity) and only for comments the diff proved
  edited — typically 0–2 per load.
- **hash-object -w growth**: one loose blob per dirty-surface comment
  creation, deduplicated by content; effectively bounded by comment count.
  gc prunes them naturally after they stop mattering.

---

## Test plan

Extend `tests/anchor.test.ts` (unit, synthetic contents) and add
`tests/anchor-git.test.ts` using the existing `makeFixtureRepo` /
`fixtureWrite` helpers (`tests/helpers/fixtureRepo.ts`) for end-to-end
scenarios through real git.

**Keep/adapt current pins** (behavioral floor, now routed through stage 3 for
legacy anchors): text moved → line updates; text gone → outdated; side
discipline (new-side never lands on `del` lines); resolved/non-positional
untouched; artifact re-anchor.

**Pure mapping unit tests** (`mapLine`): table-driven over edit lists —
before-first-hunk, between-hunks with mixed +/− deltas, after-last-hunk,
inside pure-insert hunk (must NOT flag EDITED), inside replace hunk (flags
EDITED), line at exact hunk boundaries.

**Fuzzy unit tests** (`fuzzyFind`): whitespace-only reformat accepted;
rename-one-token accepted; unrelated line rejected (< threshold); blank/`}`
quote requires strong context; proximity breaks ties between two identical
candidates *in favor of the hinted region*.

**Table-driven pipeline scenarios** (each row: fixture setup → create comment
→ mutate → reload → expected `{status, line, file}`):

1. **Reformat**: re-indent the whole file (every line changes byte-wise) —
   comment on a semantically-unchanged line survives via stage 2; comment line
   itself only whitespace-changed → survives; assert NOT outdated (the current
   algorithm's headline failure).
2. **Duplicate lines**: file with five identical `}` lines; insert 10 lines
   above the commented one; assert the comment stays on *its* `}` (stage 1
   positional — the current `pickNearest` would jump); sibling test where the
   commented `}` itself is deleted → outdated, not silently re-attached to
   another `}`.
3. **Rename**: `git mv src/a.ts src/b.ts` + commit; comment follows to
   `src/b.ts` with same line; rename+edit-elsewhere combined.
4. **Unchanged line, new commits elsewhere in file**: stage 1 maps exactly;
   line number shifts by the net insertion delta.
5. **Commented line edited**: small edit → stage 2 re-anchors with refreshed
   `lineContent`; total rewrite → outdated.
6. **Old-side comment** on a deleted line: base unchanged → stable; base
   branch advances (mergeBase moves) → maps through base diff.
7. **Dirty surface**: comment created on an uncommitted line (worktree
   numbers); then (a) more dirty edits above it → follows; (b) the dirty state
   is committed → survives commit (stage 0/1 vs `tip:path`); (c) the dirty
   edit is discarded → outdated.
8. **Untracked file**: comment on untracked file; file later committed →
   survives; file deleted → outdated.
9. **Blob pruned simulation**: stamp with a bogus `blobSha` (cat-file fails) →
   degrades to stage 2 via stored context, still re-anchors after an
   edit-elsewhere.
10. **Legacy anchor** (hand-built comment without stamp): behaves exactly as
    today's tests pin; after one successful load carries a stamp
    (heal-forward) and then survives a reformat that would previously have
    killed it.
11. **Agent anchor with empty `lineContent`**: stamped at upsert with the real
    line text; survives a later reformat.
12. **Context-window eviction**: comment on a context line; revert the nearby
    change so the hunk disappears at `-U3` → comment is queued in the
    "not visible" bucket, not outdated (or per Q3 resolution).
13. **File deleted / re-added**: deleted → outdated; re-added with same
    content → (current behavior: revives via stage 1 if blobSha matches —
    pin whichever Q4 decides).

**Regression guard**: run the full suite over `assembleReview` with a fixture
repo to confirm the persisted re-anchor (`upsertComment`) stores the mapped
values and that a second load is stage-0-only (assert via injected exec spy —
zero `diff --no-index` calls).

---

## Resolved decisions (2026-07-02)

All ten open questions are resolved by adopting the spec's recommended answer.
Binding decisions for implementation:

1. **Persist dirty/untracked blobs with `git hash-object -w`** at stamp time
   (new `hashObjectsWrite` `-w` variant). Degrade to stage-2 context after gc.
2. **No gc-pin ref** (`refs/limn/anchors/*`). Accept gc-window degradation to
   stage 2 via the stored ±3 context lines.
3. **Mapped-but-not-rendered ⇒ new per-file "not shown in this diff" bucket,
   `status` stays `queued`.** Never mark such a comment `outdated`.
4. **`stamp` and `context` are immutable** once written. Re-anchoring persists
   only `line`/`hunkRange`/`file`, and `lineContent` on a *stage-2* success.
5. **Stage-2 weights 0.5 quote / 0.35 context / 0.15 proximity, accept ≥ 0.75,
   blank-quote requires `ctxSim ≥ 0.8`** — as named constants with table tests
   pinning accept/reject examples.
6. **Lazy heal-forward backfill** on first successful stage-3 load. No eager DB
   migration.
7. **Inline re-anchor pass** (no `branchHash` memo for now). Stage 0 keeps the
   steady-state pass free of git calls; add the memo later only if profiling
   shows it matters.
8. **Retargeted base ⇒ same stage-1 mapping** through
   `diff(stamp.mergeBase:path, newMergeBase:path)`. No special casing.
9. **Add a narrow `execGitDiff` variant** accepting exit codes {0,1}, used only
   by `diffContents`. Do not loosen the general `execGit` wrapper.
10. **Artifact anchors use the same `-w` stamping** as dirty files (one code
    path).

---

## Open questions to resolve before implementation

1. **Persist dirty/untracked blobs with `git hash-object -w` at stamp time?**
   Writes loose objects into the user's repo odb (invisible to status/log,
   gc-prunable). Alternative: store full old-file content in SQLite (bloats
   comments.json) or rely on context-only (loses stage 1 for dirty anchors).
   **Recommended: yes, use `-w`** — it is the idiomatic git snapshot, costs one
   deduplicated loose blob, and degrades gracefully to stage 2 after gc.
2. **Pin stamped blobs against gc with a ref (`refs/limn/anchors/*`)?**
   Guarantees stage 1 forever but litters the repo with refs Limn must also
   clean up. **Recommended: no** — accept gc-window degradation to stage 2;
   revisit only if real-world reports show context matching failing.
3. **Mapped-but-not-rendered lines** (anchored line valid in the file but not
   present in any hunk at the current baseline): new "N comments on lines not
   shown in this diff" bucket per file vs. reuse of the outdated bucket with a
   different label vs. mark outdated as today. **Recommended: the new bucket,
   status stays `queued`** — the comment is not stale, the diff just doesn't
   show its line; marking it outdated silently drops it from the send queue.
4. **Refresh semantics after successful re-anchor**: today the mutated anchor
   is persisted each load. Keep `stamp` immutable forever, or roll it forward
   to the new surface on every stage-1/2 success (making stage 0 hit more
   often but losing the original provenance)? **Recommended: keep `stamp`
   immutable; persist only `line`/`hunkRange`/`file`/`lineContent`** — the
   edit-list cache makes repeated stage-1 mapping cheap, and provenance is
   what makes the pipeline debuggable.
5. **Stage-2 threshold and weights** (0.5 quote / 0.35 context / 0.15
   proximity, accept ≥ 0.75; context-must-carry rule for blank quotes):
   validate against a fixture corpus before freezing. **Recommended: adopt as
   initial constants, expressed as named constants with the table tests
   pinning accept/reject examples so tuning is a visible diff.**
6. **Legacy backfill strategy**: lazy heal-forward on first successful load
   (recommended) vs. an eager one-shot migration pass that walks every session
   and stamps against each repo. **Recommended: lazy** — eager requires git
   access inside a DB migration (wrong layer, repos may be missing) for
   near-zero benefit.
7. **Should `reanchorComments` stay synchronous-per-load or move behind a
   freshness key?** `assembleReview` is already async and IO-heavy; stage 0
   keeps the pass cheap. A `(sessionId, branchHash)` memo could skip the pass
   entirely when the surface hash is unchanged since the last load.
   **Recommended: implement the pass inline first; add the branchHash memo
   only if load profiling shows it matters** (branchHash is computed right
   before the call site, `src/main/review.ts:212`, so the memo is a two-line
   addition later).
8. **Old-side comments when the base *branch* is retargeted** (session
   retarget IPC, `src/main/ipc.ts:779`): the mergeBase can jump arbitrarily —
   map through `diff(stamp.mergeBase:path, newMergeBase:path)` like any other
   old-content pair, or force stage 2? **Recommended: same stage-1 mapping**
   — it is just another blob pair; no special casing.
9. **`git diff --no-index` exit-code handling**: `execGit` treats any non-zero
   exit as failure (`src/main/exec.ts:9`); `--no-index` exits 1 on "files
   differ". Add an `execGitDiff` variant accepting {0,1}? **Recommended: yes,
   a narrow variant used only by `diffContents`** — do not loosen the general
   wrapper.
10. **Artifact anchors' old content**: artifacts are read from the working
    tree (`loadArtifact`) and may be untracked docs — same `-w` stamping as
    dirty files, or context-only (they change rarely and wholesale)?
    **Recommended: same `-w` stamping** — one code path, and plan/spec files
    are exactly where line-anchored review comments live longest.
