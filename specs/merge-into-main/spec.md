# Merge into main — land the approved branch

## Status: Decided (2026-07-05) — all open questions resolved, ready for planning

Resolutions (user-locked; original questions at the bottom):
1. Record durability: **keep-ref + compare retarget** (recommended adopted).
2. Merge mechanics: **plumbing path** (`commit-tree`/`update-ref` CAS) when the
   base isn't checked out; G4's checkout requirement dropped.
3. Archive checkbox: **kept, default ON** — per the design, the merged session
   archives unless the user unticks it; the merged badge renders in both hub
   groups.
4. Dependent (stacked) reviews: **full retarget ships in v1** — checkbox in
   the sheet; mechanics in §6b.
5. Retarget mechanics: **plain git `rebase --onto`, abort on conflict** — no
   agent on the happy path; conflicts fall back to "Resolve with agent" from
   the dependent review.
6. Default strategy: **squash, last choice remembered per repo**.
7. Busy exclusive lane: **CTA disables with reason** — no queueing.
8. "Mark merged" (S12): **included in v1**.
9. Merged-record interactivity: mutations blocked, **read-only chat allowed**
   (recommendation adopted).
10. `sendRebase` is a **new channel** (not a `sendBatch` mode flag);
    `merge-tree --write-tree` is **not a hard floor** (info gate + confirm-time
    check on old git). (Recommendations adopted.)

Implements design screens `08-merge.html` (4 boards) and the behavioral contract from
`09-merge-scenarios.html` (scenario catalog S1–S13, sequences A–C) from the
project's design boards. Grounded against the stack tip
`320e88d` (branch `09-review-fixes`); implementation happens on `10-merge-into-main`
stacked on top.

Out of scope: everything on design screens 10/11 (GitHub remotes, pushes, PRs).
Merging is **local only** — Limn moves the base branch locally and never pushes.

## Problem (evidence)

A review that ends in Approve currently just… stops. The verdict is recorded
(`session_approvals`, `src/main/db/sessions.ts:635`), but landing the branch —
the entire point of approving — happens outside Limn, in a terminal, with none
of the review's knowledge applied: no check that the approval still covers
HEAD, no conflict probe before `git merge` wedges the working tree, no cleanup
of the review worktree, and the session never learns the branch landed. The
arc review → approve → **merge** is the natural completion of the app's flow
(design 08, board 1), and every gate it needs is derivable from state Limn
already tracks.

## The design in one paragraph

An approved review's header grows a **Merge into `<base>`…** button beside the
verdict. It opens a preflight **merge sheet**: read-only checks (approval
freshness, base freshness, conflict probe, tree cleanliness), a one-tap
strategy picker (fast-forward / squash / merge commit), a commit message
drafted from the review narration, and cleanup toggles (delete branch, remove
worktree). Amber gates loop back into review (since-approved view, agent
rebase) with "Merge anyway" as a recorded override; red gates block. The
confirm runs on the exclusive op lane with an authoritative re-check —
preflight is advisory, the lock-time check is the promise, and a mismatch
aborts before any ref moves. After landing, the session settles into a
terminal read-only **merged** record that outlives the deleted branch.

## Critical deviations from the wireframe

The design was reviewed against the code; four of its claims don't survive
contact, and the spec deviates deliberately:

1. **"The diff … captured at approval time, so the record renders even though
   the ref is gone" (board 4, note 4) is false.** Limn never snapshots diff
   content — `assembleReview` reads git live and a missing ref renders zero
   files (`src/main/review.ts:93-111`). The record needs the reviewed tip to
   stay resolvable: §2 pins the compare side to the merged tip SHA and plants a
   keep-ref so squash-orphaned commits survive GC.
2. **"Squash and merge commits need `main` checked out" (gate G4) is
   unnecessary.** Both can be built with plumbing — `git merge-tree
   --write-tree` + `git commit-tree` + `git update-ref` with compare-and-swap —
   touching no working tree at all. The checkout-required path exists only
   when the base *is* checked out somewhere (then its working tree must be
   advanced through a real `git merge` so it doesn't go stale). G4's "Check
   out main in acme-api" unblocking step disappears entirely; only the
   tag/SHA-base half of G4 survives (as button suppression, not a gate).
3. **The design misses a gate: a dirty branch (compare) worktree.** Approval
   freshness is keyed by branch *surface* hash, which can legitimately be
   fresh over uncommitted changes (`approvedHashes` may contain dirty-surface
   hashes, `src/shared/types.ts:311`) — but a merge can only land commits. New
   red gate: uncommitted changes on the branch worktree block the merge.
4. **"Retarget dependent review" (board 1, cleanup) assumes stacked-review
   linkage that doesn't exist.** Sessions have no parent link and a session's
   base is immutable by design (`retargetSession` throws for base,
   `src/main/db/sessions.ts:243`). Detection is implicit — live sessions
   whose `base_symbol` matches the merged branch — and the retarget needs a
   deliberate base-immutability exception plus a native rebase with a
   conflict-abort path (§6b). Decided: ships in v1 anyway, as a checkbox.
   Two safety rules the design omits: the dependent's rebase must succeed
   *before* its base is repointed (atomic, no half-retargeted review), and
   **branch deletion is refused while any live dependent still bases on the
   merged branch** — deleting it would `refMissing` every stacked review.

Two design details that looked like model calls are not: the squash/merge
message is a **template** over the existing narration (title + summary +
trailer), and the conflict probe is plain `git merge-tree` — the happy path
involves no agent at all (design 09, Seq A note).

## 1. Git primitives (`src/main/git.ts`)

New functions, all through `execGit` (`src/main/exec.ts:16`), all guarding
user-supplied refs with `assertSafeRef` (`git.ts:542`):

- `mergeTreeProbe(dir, base, branch): { clean: boolean; treeOid?: string; conflictFiles: string[] }`
  — `git merge-tree --write-tree --name-only -z <base> <branch>`, exit 1
  tolerated (conflict outcome, same pattern as `execGitDiff`). Requires git ≥
  2.38 (2022); on older git the probe reports `unavailable` and the conflict
  gate degrades to "checked at confirm" (open question 9).
- `fastForwardRef(dir, branch, toSha, expectedOldSha)` —
  `git update-ref refs/heads/<branch> <toSha> <expectedOldSha>`. The
  compare-and-swap `expectedOldSha` **is** the race-at-confirm guarantee
  (S10/Seq C): if the base moved after preflight, git itself refuses.
- `commitTree(dir, treeOid, parents, message): sha` — `git commit-tree`, used
  to synthesize squash (one parent) and merge (two parents) commits without a
  checkout.
- `mergeInWorktree(dir, branch, strategy, message)` — the checked-out path:
  `git merge --ff-only <branch>` / `git merge --squash <branch>` + `git commit`
  / `git merge --no-ff -m <msg> <branch>`, run in the base branch's worktree.
  Only invoked when preflight verified that worktree clean; a surprise failure
  aborts the op with stderr surfaced.
- `deleteBranch(dir, branch, tipSha)` — `git branch -D` guarded by our own
  containment check (post-merge the tip is recorded in the merge record and
  kept alive by the keep-ref, so `-D` is safe where `-d` would refuse after a
  squash).
- `removeWorktree(dir, path)` — `git worktree remove <path>`, never `--force`:
  a dirty worktree fails cleanup and is reported, not bulldozed.
- `planKeepRef(sessionId)` / `updateRef(dir, ref, sha)` — plant
  `refs/limn/keep/<sessionId>` at the merged tip.

Strategy mechanics, decided by where the base lives:

| Base checked out? | fast-forward | squash | merge commit |
| --- | --- | --- | --- |
| No (or elsewhere-clean) | `update-ref` CAS | `commit-tree` (tree = probe's `treeOid`, parent = base head) + `update-ref` CAS | `commit-tree` (two parents) + `update-ref` CAS |
| Yes, worktree clean | `merge --ff-only` in that worktree | `merge --squash` + `commit` there | `merge --no-ff` there |
| Yes, worktree dirty | red gate G3 — blocked | blocked | blocked |

Using the probe's `treeOid` as the squash/merge tree is exact: when the base
hasn't moved it equals the branch tip's tree; when it has (merge-anyway over a
clean probe) it is the true three-way result.

## 2. Data model — the merged record (`src/main/db/`)

Migration **v8** (`migrations.ts`, append; nullable-column pattern like
`archived_at`):

- `sessions.merged_at TEXT` — NULL = not merged; set = terminal.
- `sessions.merge_json TEXT` — the full `MergeRecord`:

```ts
interface MergeRecord {
  strategy: 'ff' | 'squash' | 'merge';
  mergedSha: string;            // new base head
  reviewedTipSha: string;       // compare tip that landed
  baseSymbol: string;           // e.g. "main"
  baseShaBefore: string;
  mergedAt: string;             // ISO
  message?: string;             // squash/merge commit message as landed
  overrides: MergeOverride[];   // e.g. [{ gate: 'stale-approval', detail: '2 commits after c7e0d44' }]
  cleanup: { archived: boolean; branchDeleted: boolean;
             worktreeRemoved: string | false;
             retargeted: string[];        // dependent branches rebased + repointed
             failures: string[] };        // partial cleanup failures, verbatim
  dependents: string[];         // branch names of detected stacked reviews
  external?: boolean;           // true when settled via "Mark merged" (S12)
}
```

DAO: `markSessionMerged(db, id, record)` beside `archiveSession`
(`sessions.ts:239`); `SessionListItem` gains `merged?: { sha: string }`
(derived in `toListItem`, `sessions.ts:220`).

**Record durability.** Immediately after the base ref moves (before any
cleanup can delete the branch) the merge op (a) plants
`refs/limn/keep/<sessionId>` at `reviewedTipSha` and (b) in one DB transaction
writes the merge record and retargets the session's compare side to
commit-kind anchored at that SHA
(`retargetSession`'s compare path already exists, `sessions.ts:243`). From
then on `assembleReview` resolves the record diff (base anchor → kept tip)
live from git exactly as it does for any commit-kind compare — no snapshot
machinery, no `refMissing` hole after branch deletion. Fast-forward and
merge-commit tips are also reachable from the base branch; the keep-ref makes
squash (whose original commits become otherwise unreachable) uniform with
them.

## 3. Preflight (`src/main/merge.ts`, new)

One new module owns gate evaluation so it is a pure, unit-testable function
over inputs the git layer gathers:

```ts
type MergeGateId =
  | 'stale-approval'      // amber  (G1)  approval hash ∉ current surface
  | 'base-moved'          // amber  (G2)  base head ≠ merge-base(base, branch)
  | 'conflicts'           // red    (C1)  probe found conflicts (files listed)
  | 'base-site-dirty'     // red    (G3)  base checked out + that worktree dirty
  | 'branch-dirty'        // red    (new) compare worktree has uncommitted changes
  | 'probe-unavailable';  // info         git < 2.38 — conflicts checked at confirm

interface MergePreflight {
  ok: boolean;                       // no red gates, no un-overridden ambers
  gates: MergeGate[];                // id, severity, human detail, counts/files
  strategies: { ff: boolean; squash: boolean; merge: boolean };  // ff = isAncestor(baseHead, tip)
  commits: CommitInfo[];             // base..tip, for the FF list
  draftMessage: string;              // template over title/summary (below)
  counts: { commits: number; files: number; add: number; del: number };
  baseHead: string; tipSha: string;  // the CAS expectations for execute
  cleanup: {
    worktreePath?: string;                    // compare branch's linked worktree
    dependents: DependentReview[];            // stacked reviews on this branch
  };
}

interface DependentReview {
  sessionId: number;
  branch: string;                             // its compare branch
  commits: number;                            // aheadCount(mergedBranch..branch)
  rebasable: boolean;                         // checked out somewhere + that worktree clean
  blockedReason?: string;                     // when !rebasable: 'not checked out' | 'dirty worktree'
}
```

Inputs, all existing primitives: `approvalFresh` over `approvedShas` + clean
tree for the approval gate (`src/shared/types.ts:376`), `mergeBase`/`headSha`/
`isAncestor` (`git.ts:25,29,466`), the new `mergeTreeProbe`,
`branchCheckedOutAt` + `isDirty` for both tree gates (`git.ts:91,33`),
`aheadCount`/`log` for counts and the commit list (`git.ts:582,325`).
Dependents = live sessions in this repo whose `base_symbol` equals the merged
branch (one SQL query beside `findSession`), each annotated with its
rebasability (`branchCheckedOutAt` + `isDirty` on its worktree).

The **Merge button never renders** when `pair.base.kind !== 'branch'` or
`pair.compare.kind !== 'branch'` (S9 — merges land branches on branches), or
when the session is already merged. In every other state it renders and the
sheet's gates tell the truth (design note 1: merging is never hidden away).

**Draft message template** (no model call):

```
<session.title>

<session.summary, wrapped at 72>

Reviewed-with: Limn (approved <tip7>, base <baseSymbol> @ <baseAnchor7>)
```

IPC: `mergePreflight(sessionId): MergePreflight` — read-only, no lane, callable
anytime (like `loadSession`). Registered in `Api` + `API_CHANNELS`
(`src/shared/ipc.ts:55,174`) with the handler beside `approve`
(`src/main/ipc.ts:1012`).

## 4. Execute (`mergeExecute`)

```ts
mergeExecute(sessionId, req: {
  strategy: 'ff' | 'squash' | 'merge';
  message?: string;                          // edited draft, squash/merge only
  overrides: MergeGateId[];                  // amber gates the user acked
  cleanup: { archiveSession: boolean;        // default on (design board 1)
             deleteBranch: boolean; removeWorktree: boolean;
             retarget: number[] };           // dependent sessionIds to retarget
  expect: { baseHead: string; tipSha: string };   // what the sheet showed
}): MergeRecord
```

Runs inside `operations.run(opId, repo, …)` — the exclusive lane
(`src/main/operations.ts:100`), same as generate/batch, so it cannot
interleave with an agent iteration (S11) and the HEAD watcher's poll skips
while it holds the lane (`src/main/ipc.ts:122`). If the lane is busy the
renderer never calls it: the CTA disables with "waiting for the running
iteration" (via `anyExclusiveRunning`, `derive.ts:253`) — no queueing
machinery (open question 6).

Inside the lock, in order (Seq A/C):

1. **Authoritative re-check**: recompute the full preflight. Any red gate, any
   amber gate not in `overrides`, or `baseHead`/`tipSha` differing from
   `expect` → typed `MergePreflightChangedError` carrying the fresh
   `MergePreflight`; nothing was written; the sheet re-renders with the true
   gates (Seq C's contract).
2. **Land** by the strategy table in §1. The `update-ref` CAS uses
   `expect.baseHead`, so even a race inside step 1→2 fails closed.
3. **Record**: keep-ref, then `markSessionMerged` + compare retarget in one DB
   transaction (§2) — all before cleanup, so a cleanup failure can't lose the
   merge record or the reviewed tip.
4. **Retarget dependents** (§6b), for each selected id, each independently:
   rebase its branch onto the new base head, and only on success repoint its
   session base. A conflict aborts that one dependent's rebase cleanly and is
   collected into `record.cleanup.failures`.
5. **Cleanup** (each independently, failures collected into
   `record.cleanup.failures`): delete branch, remove worktree, archive the
   session when requested. **Branch deletion is skipped (with a recorded
   reason) while any live session still bases on the merged branch** — i.e.
   dependents that weren't selected, weren't rebasable, or whose rebase
   failed. The op result reports exactly what happened (design 09: "either
   both happen with the merge or the whole thing reports precisely what
   did").
6. **Settle**: `stopWatch()` (nothing left to drift against), broadcast fresh
   `repoState`, return the record. The renderer reloads the session, which now
   assembles as a merged read-only record.

`mergeExecute` is fast and native (no engine, no streaming); it's a plain
request/response `Api` call with the CTA in a spinner state — it does not
create renderer `OpState` machinery.

Errors are typed like the rest of the IPC surface (typed turn errors landed in
`7536961`): `MergePreflightChangedError` (sheet re-renders),
`RepoBusyError` (already surfaced), plain `Error` with git stderr for the
unexpected (merge left un-run — plumbing paths never leave a half-state; the
in-worktree `merge --squash` path is the one spot that can, and on failure we
`git merge --abort`/`reset --merge` and report).

## 5. The merge sheet (renderer)

New `src/renderer/components/MergeSheet.tsx`, opened from a new button in the
`.page-title-row` beside `approveButton` (`src/renderer/screens/Review.tsx:258`).
Anchored popover using the shared floating util (`src/renderer/lib/floating.ts`
— the computePosition/flip/clamp core the overlay work standardized).

Contents, top to bottom (board 1):

- **Header**: `Merge <branch> into <base>` + `N commits · M files · +A / −D ·
  approved at <sha7>` + close.
- **Gate band(s)**: green single line when `ok`; otherwise one band per
  tripped gate in severity order, each with its action row:
  - `stale-approval` (amber): **Review the N commits** → closes the sheet and
    switches the diff baseline to "Since approved"
    (`HeaderDiffControls`' existing `'approved'` mode) · **Merge anyway** →
    marks the gate acked in sheet state (recorded into `overrides`).
  - `base-moved` (amber): **Rebase onto <base> — with agent** (§6) · **Merge
    anyway** (only offered when the conflict probe is clean).
  - `conflicts` (red): conflict file list + **Resolve with agent** (§6) ·
    **Copy git commands** (puts `git -C <workdir> rebase <base>` on the
    clipboard).
  - `base-site-dirty` / `branch-dirty` (red): named worktree + file count +
    **Re-check** (re-runs preflight).
- **Strategy picker**: three options; unavailable ones disabled with the
  reason in the sub-label (ff: "Not possible — <base> diverged"). Selecting
  updates hint, commit-list (ff) vs message editor (squash/merge), and CTA
  label — same live behavior as the design board.
- **Message editor**: plain `<textarea>` seeded with `draftMessage`,
  monospace, "Drafted from the review summary — click to edit" meta line.
- **After the merge**: checkboxes, all default on — archive this review
  session, delete branch, remove worktree (worktree row hidden when the
  branch has no linked worktree). Each detected dependent review renders as
  the design's highlighted **Retarget dependent review** checkbox ("<branch>
  is stacked on this branch. Repoint its base to <base> and rebase its N
  commits — comes back as amber drift to skim"); a non-rebasable dependent
  renders unchecked + disabled with its reason, and the delete-branch row
  auto-unchecks with a note while any dependent won't be retargeted (§4 rule).
- **Footer CTA**: label follows strategy (Fast-forward `<base>` / Squash &
  merge / Merge into `<base>`); disabled while gates block, while
  `anyExclusiveRunning`, or while executing.

Sheet state is component-local (fetch preflight on open, hold
selections/overrides); nothing goes through the store until the execute
succeeds and `store.reload()` folds in the merged state.

## 6. Resolve / rebase with the agent

Both amber `base-moved` → "Rebase onto <base> — with agent" and red
`conflicts` → "Resolve with agent" send **the same turn**: a batch-shaped,
write-enabled, exclusive-lane chat turn on the review thread, modeled line for
line on `sendBatch` (`src/main/ipc.ts:928`): `writeCapabilityFor` precheck,
`withBusyThread` + `operations.run`, streamed via the ChatDrawer, subject to
the thread's execution tier.

- New prompt builder `buildRebasePrompt(base, branch, conflictFiles?)` in
  `src/main/engines/prompts.ts` beside `buildBatchPrompt` (:126): rebase the
  branch onto the base in the review workdir, resolve conflicts if named,
  narrate each resolution, commit with the existing `limn:`-style discipline —
  and **do not touch the base branch**.
- **No permission-policy change.** `git rebase` is already classified unsafe
  (`src/shared/approvalPolicy.ts:54`) so under ask/edits/auto tiers the
  command parks an `ApprovalCard` — which is exactly the design's "same
  approvals ladder as send comments" (C1 note). `full` runs it unattended.
- The loop closes with existing machinery (C2/Seq B): the turn ends →
  `op:result` reload → the rebase surfaces as ordinary since-approved drift →
  the user skims, re-approves, reopens the sheet → base is now an ancestor →
  clean fast-forward. No merge-specific review UI.

IPC: one new `Api` method `sendRebase(sessionId, opts)` (thin wrapper; reuses
the batch handler's shape rather than overloading `sendBatch`'s
comment-reconciliation logic).

## 6b. Dependent-review retarget (inside the merge op)

For each dependent the user ticked (`cleanup.retarget`), executed inside the
same exclusive-lane op, after the merge record is durable:

1. **Re-verify rebasability** (worktree still holds the branch, still clean —
   the sheet may have sat open). Failed re-check → collected failure, skip.
2. **Rebase natively**: `git -C <depWorktree> rebase --onto <newBaseHead>
   <reviewedTipSha> <depBranch>`. `reviewedTipSha` is the old stack point, so
   only the dependent's own commits replay — correct for all three merge
   strategies, including squash (where the old commits are otherwise
   unreachable but the keep-ref and the recorded SHA keep the boundary
   stable).
3. **On conflict**: `git rebase --abort`, restore untouched state, collect the
   failure. The dependent review is left exactly as it was; opening it later
   offers the ordinary "Resolve with agent" path (§6) which performs the same
   rebase agentically. Because the merged branch was *not* deleted (§4 rule),
   nothing `refMissing`s.
4. **On success, repoint the base** in one DB transaction:
   `retargetSessionBase(db, depId, { kind:'branch', symbol:<base>, anchorSha:
   <newBaseHead> })` — a new DAO function that is the *only* writer allowed to
   touch a session base (the public `retargetSession` keeps throwing;
   base immutability stays the rule, this is its one audited exception).
5. The dependent review's next load shows the rebase as ordinary
   since-approved amber drift over the new base — the design's promised
   "comes back as amber drift to skim", with zero new review UI.

The dependent's own HEAD watcher (if that review is open in another window)
is quiet during the op — the poll skips while the exclusive lane is held
(`src/main/ipc.ts:122`) — and re-baselines on its next reload.

## 7. The merged record (renderer)

When `merged_at` is set, the session is terminal and read-only:

- **`assembleReview`** (`src/main/review.ts`) short-circuits the write-side
  extras for merged sessions: no watcher start (`loadSession`'s
  `startWatch` call at `src/main/ipc.ts:466` gated on `!merged`), no drift
  computation against a branch that may be gone, `writeCapability`
  effectively `not-branch`.
- **Verdict button** (`Review.tsx:115-138`): renders **Merged into <base>**
  (solid green, merge glyph), non-interactive — no un-merge (board 4, note 1;
  undo is `git revert`, deliberately outside Limn).
- **Summary band** (`ReviewSummary.tsx`): "Merged into `<base>` at `<sha7>`
  (`<strategy>`) on `<date>`. `<branch>` and its worktree were removed.
  N sections, M comments — all resolved. This review is now a read-only
  record." — all fields from `MergeRecord`, including override notes
  ("approved `<sha7>`, landed with 2 unreviewed commits") when present (S13).
- **Timeline** (`ReviewTimeline.tsx` + `reviewTimeline.ts`): new
  `'merged'` role rendering the filled `cm-landed` pill with the merge SHA;
  hover shows strategy + timestamp. Branch chip in the refpicker gains the
  `deleted` tag when the ref is gone (the compare side is commit-kind
  post-merge, so this is presentational).
- **Mutations blocked**: approve/unapprove, generate/update, sendBatch, and
  comment composition are disabled for merged sessions (main-process guards +
  renderer affordances). Read-only chat on the shared lane stays available —
  asking questions about a landed review is legitimate (open question 7).
- **Hub** (`SessionRow.tsx:21`, `RepoHub.tsx:122`): `merged` becomes the
  first-checked status → green **Merged · <sha7>** badge, rendered in both
  the live and archived groups. With the archive checkbox on (the default)
  the record lands in the archived group; when unticked it stays in the live
  list, sorted below unmerged rows. Rows open the read-only record as usual.

## 8. Merged outside Limn (S12 — "Mark merged")

Detection is cheap and piggybacks on state loads (not the watcher hot path):
when assembling a non-merged, branch-kind session, if `isAncestor(tipSha,
baseHead)` and the tip is approved, `LoadedReview` gains
`mergedExternally: true`. The Review header then offers **Mark merged** in
place of the Merge button; it opens the same sheet in a reduced mode — no
strategy/message (the merge already happened), just the record summary +
cleanup checkboxes — and lands via `markMerged(sessionId, cleanup)`, which
writes the same `MergeRecord` (`external: true`, `mergedSha` = base head) and
runs the same settle path. Squash-merges done externally are not detectable by
ancestry and are out of scope (the branch just looks unmerged; archiving
remains the manual escape).

## 9. Testing

House style: pure logic unit-tested, git behavior tested against real temp
repos (as `git.test.ts`, `write-capability.test.ts` do), renderer selectors
and components via vitest + testing-library.

- `merge-gates.test.ts` — the pure gate evaluator: every gate id, amber
  override accounting, strategy availability matrix, `ok` derivation.
- `git-merge.test.ts` — temp-repo integration: probe clean/conflicted paths,
  ff CAS success + stale-expect refusal, plumbing squash/merge commit
  correctness (tree equality with a real merge), in-worktree strategy paths,
  branch delete + worktree remove + keep-ref, dirty-tree refusals.
- `ipc-merge.test.ts` — preflight/execute handlers over a fixture repo:
  authoritative re-check aborts on moved base (S10), exclusive-lane exclusion
  (S11), record written before cleanup, partial cleanup failure reporting,
  compare retarget + record renders after branch deletion; dependent
  retarget: clean rebase repoints base, conflicted rebase aborts + preserves
  the dependent untouched + blocks branch deletion.
- `merge-record.test.ts` — DAO + `toListItem` merged status; migration v8.
- `merge-sheet.test.tsx` — sheet rendering per gate fixture, strategy
  switching, CTA labels/disabling, override flow.
- `prompts.test.ts` — extend for `buildRebasePrompt`.
- Manual/screenshot evidence: `scripts/shot.sh` captures of (a) green sheet,
  (b) amber stale-approval gate, (c) conflict gate, (d) merged record header +
  hub badge, staged via the FakeEngine fixture path.

## Original open questions (all resolved — see Status block at the top)

1. **Record durability mechanism.** Keep-ref + compare-retarget (§2) keeps
   diffs live from git with zero snapshot machinery, at the cost of a hidden
   `refs/limn/keep/*` ref per merged session in the user's repo.
   Alternative: snapshot the rendered diff JSON into the DB at merge time
   (heavier, new render path, but no repo footprint). **Recommended:
   keep-ref.** It reuses the entire existing render path and the footprint is
   one ref; a future "purge record" action can delete it.

2. **Plumbing merges when the base isn't checked out.** The design requires a
   checkout for squash/merge (G4); §1 replaces that with
   `commit-tree`/`update-ref` plumbing, which also makes CAS the race guard.
   **Recommended: adopt the plumbing path** and drop G4's checkout
   requirement; it removes a whole gate and a user chore. (If declined, G4
   returns as an info gate with a "Check out <base>" action.)

3. **"Archive this review session" checkbox (design board 1).** The merged
   state already moves the session out of the active flow; archiving it too
   would hide it under "Show archived", contradicting board 4's "settles in
   the hub as the durable record". **Recommended: drop the checkbox** —
   merged is its own resting state; manual archive stays available for
   decluttering.

4. **Dependent (stacked) reviews.** Full design behavior = checkbox that
   retargets the dependent session's immutable base and agent-rebases its
   branch. That's a second write flow with its own gates, on top of a linkage
   model that doesn't exist. **Recommended: v1 detects and informs** (sheet
   info row + `dependents` in the record); the actual retarget ships as its
   own follow-up spec.

5. **Default strategy.** Design preselects squash (agent-authored commit
   piles are the norm). **Recommended: default squash, remember the last
   choice per repo** in prefs; fast-forward stays one tap away when available.

6. **Busy exclusive lane at CTA time (S11).** Design copy says the CTA
   "queues". `OperationCoordinator` deliberately errors rather than queues
   (`RepoBusyError`). **Recommended: disable the CTA with "waiting for the
   running iteration"** while `anyExclusiveRunning` — no queue machinery; the
   user confirms when the lane frees.

7. **Interactivity of the merged record.** Fully frozen vs read-only-plus-chat.
   **Recommended: block all mutations but keep shared-lane read-only chat** —
   "what did this migration do" is a fair question about landed code, and the
   read-only ladder already guarantees no writes.

8. **`sendRebase` surface.** Reuse `sendBatch` with a mode flag vs a new
   channel. **Recommended: new `sendRebase` channel** — batch's
   comment-reconciliation logic (sent→queued rollback, resolve_comment
   bookkeeping) doesn't apply, and typed channels are the house style.

9. **git version floor.** `merge-tree --write-tree` needs git ≥ 2.38 (2022).
   **Recommended: don't hard-require it** — emit the `probe-unavailable` info
   gate, keep amber/red tree+approval gates working, and let the confirm-time
   merge surface conflicts (plumbing `merge-tree` failure aborts cleanly).
   Modern git gets the full preflight.

10. **"Mark merged" (S12) in v1.** It's small (§8) and completes the story for
    people who merge in the terminal. **Recommended: include in v1**;
    external-squash detection stays out.
