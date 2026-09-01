# In-place edits — fixing it yourself, in review

Grounded against the code as of `d896f37` (main tip). Behavioral reference:
Claude Design board `screens/12-inline-edits.html` ("12 ·
In-place edits") — its live demos are the intended DOM transitions; this spec
restates them as an implementation contract against the real codebase. All
board deviations from the 2026-08-07 draft (rail ↺ discard, no agent-run
pause, line-anchored CAS) are **accepted**.

Note on grounding: line references below are valid at `d896f37`. The audit
stack (branches `06-acp-migration`, `07-concurrent-chat`) rewrote the engine
layer and the renderer op model — re-ground those references if this lands
after the stack merges.

## Goal

While reviewing an agent branch, change file content directly in the review —
fix a word, rename a variable, tweak a comment — in seconds, without leaving
the app. An edit lands as a plain uncommitted change in the branch's working
tree: no commit, nothing staged, no bespoke edit layer. The measured success
criterion: a one-line fix is double-click → type → ⏎, ~3 seconds, and the
result renders exactly as if typed in an IDE.

## Invariants

1. **One source of truth.** An edit is an uncommitted working-tree change. It
   renders with the existing unstaged treatment (dotted amber rail from the
   merged-diff origin tagging) — never a separate "my edits" list or journal.
2. **No self-drift pill.** Your own save folds in immediately. The update pill
   stays reserved for outside hands: IDE, terminal, the agent.
3. **Viewed stays viewed.** An in-review edit re-stamps the file's view mark;
   files changed by anyone else still lose their tick as today.
4. **Comments may outdate.** Editing under a comment behaves like any code
   change under a comment — the thread goes `outdated` via the existing
   re-anchor pass. Accepted for v1.
5. **Discard = git.** The rail's ↺ affordance is `git checkout --` surfaced,
   scoped to a contiguous uncommitted span. No undo layer, no history. It acts
   on any uncommitted span, not just in-review edits — there is no difference.
6. **Never clobber.** Save is compare-and-swap **anchored to the edited lines
   only**. Writes elsewhere in the file never block a save; if the edited
   lines themselves changed on disk, the save is refused, the review
   refreshes, and the editor reopens on the new content with the typed text
   kept (one-keystroke re-apply). Never a silent clobber, never lost typing.
7. **Available where agent writes are.** Compare side must be a branch checked
   out in a worktree (`writeCapabilityFor` minus the dirty check); otherwise
   the review is read-only and edit affordances are *absent*, not disabled.
   Agent runs never pause editing — anchored CAS arbitrates every write.
8. **Agent shares the tree.** The `dirty` refusal in `writeCapabilityFor` is
   deleted. When the agent commits, uncommitted edits to files it touched may
   be swept into its commit — accepted; git history is the only record.

## Control surface (decided by board 12)

One editor — the **flow frame** — reached by every entry gesture:

- **Enter**: hover pencil or double-click on a context/`+` row opens the frame
  on that line, caret at the click point. Drag-select ≥2 rows (≥1 editable)
  shows an "Edit n lines" pill that opens the frame over the selection.
  `−` rows are never editable (no working-tree text behind them); they ride
  inside a grown frame as inert grey slivers.
- **Grow**: arrowing the caret past the frame's edge admits exactly one
  working-tree line per step. Crossing a fold reveals the fold's lines in one
  batch but only the adjacent line joins. A scope chip reads "editing lines
  a–b". At most one frame per review; opening a second closes the first
  (cancel if unchanged).
- **Reach beyond hunks**: expand-context arrows between/around hunks reveal
  unchanged rows; revealed rows obey the same editable predicate. No
  whole-file toggle.
- **Save/cancel**: ⏎ always makes a new line (so a region can be split or grown
  like in any editor); ✓/⌘⏎ (or ctrl+⏎) saves — the written region may hold more
  or fewer lines than it replaced. Esc cancels (pure DOM restore — no disk read).
  **Delete**: once the region is typed away to nothing, ⌫ (or the ⌫ button)
  removes its lines from the file outright — the save writes zero lines, where
  ⌘⏎ on the same empty frame would write one blank line. The head cues which is
  which before the keystroke lands (hint text + the diff's deletion tint).
  Blur never saves and never closes. Batched multi-spot save is dropped (a
  pending-edits set would violate invariant 1).
- **Keyboard round trip**: a save leaves a line selection; ↑/↓ move it (folds
  reveal in batches when crossed), ⏎ re-enters edit, Esc clears.
- **Discard**: hovering an unstaged (dotted) span shows a ↺ dot pinned to the
  amber rail at the far left (comment `+` keeps the code-side gutter — the
  two affordances never contend). Click discards the whole contiguous dotted
  span — the −/+ pair collapses back to the committed line. Tooltip names the
  mechanism ("discard — git checkout --"). CAS-guarded like save.

`editable(row)` — all must hold: review is writable (invariant 7, computed
once per review); row is a context or `+` row; file is not binary and not
conflicted (`UU` — out for v1).

## Sharp edges (from board §5, all in scope)

- Editing a context line yields a −/+ pair — that is simply what a
  working-tree change looks like. No third "modified in place" render.
- Editing a staged line produces a partially staged file: unstaged edit on
  top of a staged change. The existing solid+dotted rail pair already draws
  this; no new state.
- The −/+ pair from an edit gets word-level marks like any other pair,
  recomputed on save — a free proofread of exactly what changed.
- Binary files: no affordance. Conflicted (`UU`) files: out for v1 (noted: a
  multi-line frame over a conflicted span is the natural manual resolution
  surface later).
- Untracked files are editable — they are on disk and render as all-`+`
  synthetic diffs already.
- Every count must tick synchronously with the save render: file-header ±,
  sidebar deltas, progress, titlebar working-tree marker. Any lagging surface
  breaks "indistinguishable from an IDE edit".

## Implementation

### New IPC surface

Three methods on the `Api` seam. Pattern per method: add to the `Api`
interface (`src/shared/ipc.ts:52`) + `API_CHANNELS` (`:154`) + one `handle()`
in `src/main/ipc.ts`; the preload loop and the HTTP/SSE server transport pick
them up automatically.

- `readFileLines(repo, path, range?)` → working-tree text for expanders and
  frame growth beyond hunk lines. Guards: realpath containment (model on
  `loadArtifact`, `src/main/artifacts.ts:134-142`), binary/NUL detection and
  the existing 2 MB cap (reuse `syntheticAddedFile`'s limits,
  `src/main/git.ts:185-204`). Reads from `resolveWorkdir(repo, pair)`
  (`src/main/review.ts:35-38`), never the base repo blindly.
- `applyEdit(repo, path, edit)` where
  `edit = { startLine, endLine, snapshot: string[], newLines: string[] }`,
  line numbers in working-tree space. Main re-reads the file, verifies
  `snapshot` still matches lines `startLine..endLine` **exactly** (the
  anchored CAS — content match at the anchored position; on mismatch, return
  a typed `conflict` result carrying the current lines, no write). On match:
  splice, write atomically (temp file + rename, preserve mode), return ok.
  Discard is the same call with the span's pre-change text as `newLines` —
  the old side of the span from the merged diff, which the renderer already
  holds. (True `git checkout --` restores from the *index*, not HEAD; the two
  coincide exactly when the span has no staged interleave, which is what open
  question 3 restricts v1's ↺ to.)
- `refreshFile(repo, path)` → recompute the merged `FileDiff` for this one
  path (scoped `mergedWorkingDiff` + `tagOrigins`, `src/main/git.ts:162-179`
  / `src/main/mergeDiff.ts:38`), re-run `reanchorComments`
  (`src/main/anchor.ts:5-54`) for comments on this file against the new
  surface, recompute the on-disk `fileHash`, and return
  `{ file: FileDiff, comments, fileHash }`. The renderer splices it into
  `loaded` — no review regeneration, no re-narration, no scroll jump.

Trim-before-write lives in the renderer: drop the common prefix/suffix
between the frame's on-screen lines and the typed result; an empty delta
closes the frame and writes nothing (an unchanged save is a cancel).

### Write serialization and concurrency

- Within main, serialize `applyEdit` per repo with a lightweight queue (a
  promise chain keyed by workdir is enough — do **not** use
  `OperationCoordinator`'s exclusive lock: agent ops hold it for minutes and
  invariant 7 says runs never pause editing). This makes check-and-splice
  atomic against the app's *own* writes.
- External writers (agent CLI process, IDE) are arbitrated by the CAS itself:
  the re-read happens inside the serialized section, so a mismatch is always
  detected, never raced. TOCTOU against an external write between re-read and
  rename is accepted — the window is microseconds and the alternative is file
  locking git itself doesn't use.

### Save pipeline (renderer)

`save(scope, newLines)`:
1. Unchanged text ⇒ close frame, done (a no-op save is a cancel). Empty text is
   *not* a no-op: ⌘⏎ writes one blank line, ⌫ writes zero lines (`newLines: []`,
   a pure deletion — see Save/cancel).
2. `applyEdit` → on `conflict`: run `refreshFile`, splice, reopen the frame on
   the fresh content with the typed text held in a "yours" bar — Re-apply
   re-runs the pipeline anchored to the new lines; Esc keeps theirs.
3. On ok: `refreshFile`, splice into the store, re-render the file card
   (changed context lines appear as −/+ pairs, all changed rows get the
   dotted rail, word marks recompute via the existing
   `src/renderer/lib/worddiff.ts` overlay).
4. Re-stamp the view mark if the file was viewed at save time: write
   `viewedAt[path] = { sha, hash: newFileHash }` through the existing mark
   API (hash source: `refreshFile`'s return; stamping mirrors
   `src/main/review.ts:196-206`).
5. Counters tick from the spliced `FileDiff` (they derive from it already).
6. Close frame, leave the line selection.

Discard runs the same pipeline with the committed text as payload.

### Drift watcher

The 500 ms poller (`watchState`/`startWatch`, `src/main/ipc.ts:57-97`) hashes
working-tree state and pops the drift pill on change. `applyEdit` must
re-baseline the watcher's signature synchronously with the write (recompute
`loadSig` inside the serialized section, before the next poll can run) so a
self-write never surfaces as drift. External writes keep pinging as today.
`refreshFile` splices do not go through `store.reload()`, so `pendingDrift`
handling is untouched.

### Capability gate change

`writeCapabilityFor` (`src/main/review.ts:41-55`): delete the `isDirty` check
(lines 49–51) and the `'dirty'` reason from `AgentWriteCapability`. Ripples:
- `sendBatch` enforcement (`src/main/ipc.ts:638-648`) no longer throws on
  dirty.
- UI disabled-states at `ChatDrawer.tsx:256` and `GenPanel.tsx:51` lose the
  dirty branch.
- `tests/write-capability.test.ts`: dirty cases flip from blocked to allowed.
- Editing availability = the same capability, computed once per review and
  broadcast with `LoadedReview`.

### Renderer components

- **Flow frame**: new component mounted inside `DiffView` replacing the
  frame's rows while open. A `<textarea>` (or per-line inputs — implementor's
  choice, but selection/caret growth semantics favor one textarea) overlaid
  on the existing `ch`-offset geometry; re-highlight per line with
  `highlightLine` (`src/renderer/lib/highlight.ts`) on render. The frame's
  gutter keeps line numbers and signs; swallowed `−` rows grey out in place.
  State machine: `idle → editing(scope) → saving → idle`, per the board's
  event table (§6 there is normative).
- **Pencil affordance** on hover of editable rows, right edge — coexists with
  the comment `+` gutter button (`DiffView.tsx:243-258`), which is unchanged.
- **Edit-n-lines pill** on selection release, positioned at the pointer;
  n = editable rows in the selection; absent when n = 0.
- **Expanders**: new row type between/around hunks, sourced from
  `readFileLines`; revealed rows enter the same rendering path as hunk
  context rows (they need synthetic `DiffLine`s with `kind: ''` and correct
  old/new numbers).
- **↺ discard dot** on the origin rail for contiguous unstaged spans.
- **Read-only reviews** render zero new affordances (predicate short-circuit).

### Comments

No transactional anchor rewriting in v1. `refreshFile` re-runs the existing
re-anchor for the file, so a thread on an edited line goes `outdated`
immediately (not on next full reload) and un-outdates if a later edit
restores the text. V2 nicety (out of scope): when your own edit outdates your
own unsent comment, offer to resolve it.

## Testing

Fixture-repo tests (`tests/helpers/fixtureRepo.ts`) alongside the existing
suites:

- **applyEdit**: CAS ok / conflict (same-line change) / no-conflict
  (elsewhere-in-file change); containment guard; binary and >2 MB refusal;
  not-checked-out refusal; untracked-file edit; staged-line edit produces
  partial staging; atomic write preserves mode.
- **refreshFile**: scoped merged diff matches full `mergedWorkingDiff` for
  that path; comment re-anchor outdates/un-outdates; fileHash correctness.
- **Capability flip**: `tests/write-capability.test.ts` dirty cases inverted;
  `sendBatch` on a dirty tree proceeds.
- **Watcher**: `applyEdit` then a poll tick → no drift event; external write
  then poll → drift event (regression guard for re-baselining).
- **Store**: splice-on-refresh updates counters; view-mark re-stamp on save;
  no re-stamp when file wasn't viewed.
- **Acceptance (from the board's demos, DOM-level)**: frame opens on
  double-click with caret at point; growth across a fold reveals batch,
  admits one line; a ⌘⏎ save renders −/+ with dotted rail and word
  marks; discard collapses the span; conflict reopens with typed text kept
  and Re-apply lands.

## Open questions

1. **`readFileLines` vs whole-file read.** Range reads keep payloads small
   but need line addressing; a whole-file read is simpler and the 2 MB cap
   bounds it. *Recommended: whole-file read, renderer slices — simpler, one
   fewer failure mode.*
2. **Where the "yours" text lives during a conflict.** Board shows a bar
   above the refreshed hunk. Component state is enough (it dies if you
   navigate away mid-conflict). *Recommended: component state only; losing it
   on navigation is acceptable for v1.*
3. **Discard span granularity when origins interleave** (unstaged span
   adjacent to staged span in one visual run). *Recommended: ↺ acts on the
   maximal contiguous run of unstaged-origin lines only; staged lines need
   `git restore --staged` semantics we are not building in v1.*
4. **Does `applyEdit` require a materialized session?** Edits touch only the
   working tree, not the DB. *Recommended: no materialization — a review you
   never comment on stays transient even if you edit files.*
