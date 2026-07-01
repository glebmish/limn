# Diff-scoped update generation

## Status: Draft — awaiting answers to open questions

## Problem (cost evidence: what a full update re-reads today)

"Update review" (`update: true`) is a **full fresh generation** lightly seeded with the prior structure:

- `src/main/ipc.ts` (`generate` handler, ~L359–488): builds `prior = { title, summary, sections: [names only], sinceSha: state.reviewedAtSha }` (~L378–385) and calls `engine.generateReview` with the **full diff skeleton** (merge-base → head, plus up to 40 untracked candidates).
- `src/main/engines/prompts.ts` `buildReviewPrompt` (~L58–64): the `UPDATING AN EXISTING REVIEW` block carries only the prior title, summary, and section *names* — not the narration (`what`/`desc`), not file assignments, not section ids — and instructs "fold new commits in, keep unchanged sections".
- Both engines start a **fresh engine session** for every generation (`ClaudeEngine.generateReview` never passes `resume`; `CodexEngine.generateReview` calls `runAppServerTurn` without `engineSessionId`), and the prompt opens with "EXPLORE FIRST — read the changed files in full". So even when drift is one commit touching one file, the engine re-reads every changed file on the branch, re-runs `git log`/`git show`, re-greps callers/tests, and re-writes the entire structured document from scratch.

Note the cost shape precisely: the *prompt* embeds only the file list (path, status, ±counts, hunk ranges) — the 50k-token diff is not inlined. The cost lives in (a) the fresh session's exploration tool calls re-reading the whole branch surface, (b) the engine re-emitting the full `ReviewAnnotations` document (every section's narration, diagrams, planMap), and (c) wall-clock minutes for the reviewer. A one-file drift commit costs the same as the original generation.

Secondary wart this design fixes: section ids are engine-minted per generation, and the update prompt only passes *names*, so a full update mints **new ids** for every section. Section-anchored comments (`CommentAnchor { kind: 'section', sectionId }`), `reviewedSections` marks (persisted by id in the `reviewed_sections` table), and `planMap.steps[].sectionId` can all dangle after today's update. A splice keeps prior ids for untouched sections by construction.

What a new iteration writes today (must be preserved by any scoped path): `ipc.ts` ~L425–459 wraps `dao.addIteration` (`{ n, engine, sessionId: engineSession, endSha: skeleton.headSha, at, title, summary, annotations }` → `iterations` table), `dao.updateSessionMeta` (annotations + `reviewedAtSha = skeleton.headSha`), and review-thread finalization (bind engine session, persist agent turn) in one transaction. Comments and viewed marks survive because they live in the Limn session, not the annotations.

Drift detection today (reused as-is): the 500ms watcher (`ipc.ts` ~L49–100) hashes head + porcelain + `diff HEAD` + untracked blob hashes into a change signature and broadcasts `driftSummary(repo, branch, loadedSha, workdir)` = `{ headSha, commits, files, add, del, dirty }`. The "since" machinery in `src/main/review.ts` (`assembleReview` ~L136–160) computes `diffSince(repo, baseline, compare)` where `baseline = approvedSha ?? reviewedAtSha` — i.e. **exactly the last iteration's `endSha` after a generate** — and `diffSinceWorking(workdir, sha)` for dirty trees. These are the primitives the scoped path needs; nothing new has to be invented in `git.ts`.

## Goals / Non-goals

**Goals**

- When drift since the last iteration is small, produce iteration N+1 at a small fraction of full-generation cost (target: engine reads only the since-diff files; output tokens proportional to touched sections).
- Preserve the invariant enforced by `mergeAnnotations` (`src/main/engines/validate.ts`): every tracked file in the current full diff ends up in exactly one section. The engine returns a **patch**; Limn splices it into the prior annotations and runs the *same* `mergeAnnotations` validation as today.
- Preserve section ids for untouched sections, so section comments, `reviewedSections`, and planMap step references survive updates.
- Automatic: the reviewer clicks the same "Update review" button; Limn picks scoped vs full and says what it did ("updated N of M sections").
- Robust fallback ladder — a scoped attempt can never leave the review in a worse state than today's full update; worst case it *becomes* today's full update.

**Non-goals**

- No change to fresh generation or "Regenerate" (full replacement stays the escape hatch).
- No change to the drift watcher, the since-rails rendering, comments, or viewed marks.
- No incremental *rendering* — the spliced result is a complete `ReviewAnnotations` persisted exactly like today's.
- No cross-engine session portability (a Claude session is never resumed by Codex).
- No user-facing scope picker (see UI surface).

## Design

### 1. Trigger / threshold

In the `generate` handler, when `update && state.annotations && latestIteration`:

```
sinceBase = latestIteration.endSha            // == state.reviewedAtSha after any generate
since     = dirty ? diffSinceWorking(workdir, sinceBase)   // committed + uncommitted
                  : diffSince(repo, sinceBase, compareEff).files
```

Both helpers exist in `src/main/git.ts`. If `sinceBase` is unreachable (rebase/amend — the same case `GenPanel` already classifies as `generatedOutOfHistory` and routes to Regenerate), the scoped path is off.

Decision function (pure, unit-testable, new `src/main/engines/scope.ts`):

```
scopedEligible(since: FileDiff[], full: DiffSkeleton): boolean =
     changedFiles(since) ≤ K                       // K = 8
  && changedLines(since) ≤ T                       // T = 1000 (Σ add+del; binary files count 0 lines but 1 file)
  && changedFiles(since) ≤ 0.5 × full.files.length // drift touching most of the branch isn't "small"
```

Rationale for a line budget alongside a file cap: a single regenerated lockfile or snapshot can be one file and 20k lines; a token proxy of `add+del` lines is cheap (already parsed) and close enough. Values are Open Question 1.

### 2. Scoped prompt

New `buildScopedUpdatePrompt(req)` in `prompts.ts`. Inputs:

- **Prior annotations in full** — serialized compactly (per section: `id`, `name`, `desc`, `what`, `files`, `order`; plus title, summary, open questions with ids, planMap). This is 1–3k tokens for a typical review; diagrams/insights/plainNotes are *named* but not inlined (the engine keeps them by not revising the section).
- **Only the since-diff**: the changed-file list *and the hunks themselves* inlined (they're small by the threshold), labelled per file with which prior section currently owns it (or "unsectioned — new file").
- **Untracked candidates**: only untracked files not already sectioned in the prior annotations, capped by the existing `MAX_UNTRACKED_OFFERED` (Open Question 7).
- The reviewer's `steer`, if any (same one-shot semantics).
- Instructions: "The branch gained a small amount of drift since `<sinceSha>`. Do NOT re-explore the whole branch. Read only the files listed below (and their immediate context) if the hunks aren't self-explanatory. Return ONLY the sections you revise, add, or delete, referencing every other prior section by id in `keptSectionIds`. Keep ids of revised sections unchanged; mint new ids only for new sections."

### 3. Scoped wire schema

Extend `src/main/engines/schema.ts`. Constraints already documented there: **no tuples** (Claude CLI silently drops schemas with `prefixItems` — `wireSection`'s diagram already models nodes as objects) and **no records / no optionals** (OpenAI strict mode: every property required, optionality via `nullable`). `wireSection` already complies and is reused verbatim.

```ts
export const scopedReviewWireSchema = z.object({
  title:   z.string().nullable(),           // null = keep prior
  summary: z.string().nullable(),           // null = keep prior
  // revised (id matches a prior section) or new (fresh id) sections — full section
  // bodies, same shape as a fresh generation.
  revisedSections: z.array(wireSection),
  deletedSectionIds: z.array(z.string()),
  // every prior section NOT revised/deleted, listed by id. This is the
  // anti-hallucination handshake: kept ∪ revised∩prior ∪ deleted must equal the
  // prior id set exactly, or the splice refuses.
  keptSectionIds: z.array(z.string()),
  newQuestions: z.array(wireQuestion),      // factor today's inline question object out to `wireQuestion`
  resolvedQuestionIds: z.array(z.string()),
  planMap: wirePlanMap.nullable()           // null = keep prior (re-sanitized after splice)
})
export const scopedReviewJsonSchema = toJsonSchema(scopedReviewWireSchema)
export function parseScopedOutput(raw: unknown): ScopedReviewPatch { … }
```

Engine plumbing: add `generateScopedUpdate(req: ScopedUpdateRequest): EngineRun<ScopedReviewPatch>` to the `ReviewEngine` interface (`engines/types.ts`), where `ScopedUpdateRequest = { repo, branch, base, since: FileDiff[], prior: ReviewAnnotations, priorEngineSessionId?, model?, reasoningEffort?, steer? }`. Claude: `runQuery(buildScopedUpdatePrompt(req), { resume: priorEngineSessionId, outputFormat: { type: 'json_schema', schema: scopedReviewJsonSchema }, allowedTools: READ_TOOLS, … })`. Codex: `runAppServerTurn({ engineSessionId: priorEngineSessionId, outputSchema: scopedReviewJsonSchema, … })` — both adapters already support resume + structured output on the same turn (chat proves it for resume; generateReview proves it for schema).

### 4. Section identity

Verified current state: sections **do** carry ids — `wireSection.id` is required, ids are persisted in `annotations_json`, and are consumed by section-anchored comments, the `reviewed_sections` table, planMap steps, and focus targets. `'other-changes'` is a reserved id minted by `mergeAnnotations`. But ids are **not stable across iterations today**: the update prompt passes names only, and each generation mints fresh ids (FakeEngine: `s1…sN`).

Scoped identity rules:

- The scoped prompt hands the engine the prior ids; **id is the sole matching key** (no name matching — names are prose and get edited). A `revisedSections` entry whose id ∈ prior = revision; id ∉ prior = new section.
- New-section id collisions: a "new" section colliding with `'other-changes'` or duplicating another output id → Limn re-mints deterministically (`<id>-2`, `<id>-3`, …) and rewrites any planMap step references in the same patch. Duplicate ids *within* `revisedSections` → splice refuses (fallback).
- Untouched sections keep their ids by construction — this is what makes comments/viewed/plan references survive.

### 5. Splice algorithm (new `src/main/engines/splice.ts`, pure)

Input: `prior: ReviewAnnotations`, `patch: ScopedReviewPatch`, `currentSkeleton: DiffSkeleton`, `untrackedPaths: Set<string>`.

1. **Handshake check**: partition patch ids. Require `keptSectionIds ⊎ (revised ids ∩ prior ids) ⊎ deletedSectionIds === prior section ids` (exact set equality, no overlaps). Any unknown id in `kept`/`deleted`, any prior id unaccounted for, any duplicate → `SpliceError` (fallback).
2. **Garbage guard**: if `deletedSectionIds` covers more than half the prior sections, or every prior section is revised (the engine ignored the scoping and rewrote everything), treat as `SpliceError` (Open Question 4).
3. **Assemble sections**: prior sections in prior order, minus deleted, with revised bodies substituted by id; new sections inserted by their `order` field; then re-normalize `order` to 1..n.
4. **File-move semantics**: `claimed` = union of files in revised + new sections. Remove every `claimed` path from the file lists of *kept* sections (a file moves by being claimed; the source section needs no revision). A kept section emptied this way is dropped (mirrors `mergeAnnotations`' empty-section drop, but done here so the handshake stays honest).
5. **Questions**: `questions = prior.questions.filter(q => !resolvedQuestionIds.includes(q.id)) ++ newQuestions` (new ids deduped against surviving ones).
6. **Scalars**: `title = patch.title ?? prior.title`, same for summary; `planMap = patch.planMap ?? prior.planMap`; `artifactPaths` carried from prior.
7. **Validate exactly like today**: feed the spliced `ReviewAnnotations` through the existing `mergeAnnotations(currentSkeleton, spliced, untrackedPaths)`. This is the load-bearing step: it re-guarantees 100% tracked-file coverage against the **current full skeleton** — files added by drift that no section claimed sweep into `'other-changes'`; files deleted by drift vanish from kept sections (unknown-file drop); planMap sectionIds are re-sanitized. The scoped path changes *what the engine is asked for*, never *what Limn accepts*.
8. **Post-merge quality signal**: if a since-diff file with status `added` landed in `'other-changes'` (the engine ignored a genuinely new file), emit a warning `note: …` (surfaced like today's merge warnings) but do **not** fall back (Open Question 5). Return `{ annotations, warnings, revisedCount, keptCount }` for the UI message.

### 6. Session resume: resume the prior iteration's engine session (recommended) vs fresh

**Evaluated:**

- *Fresh session (today's update behavior)*: predictable, no dependency on engine-side session retention; but the session has zero codebase context, so even a scoped prompt triggers re-exploration of at least the touched files' surroundings — and the whole point is avoiding re-reads.
- *Resume `latestIteration.sessionId`* (persisted per iteration in the `iterations` table): the session already holds the full exploration — files read, `git log`, callers, artifacts. A scoped turn becomes "here's what changed since your last answer, patch your review": near-zero re-reading, and the model's prior reasoning about the very sections being revised is in context. Cheaper *and* higher quality. Mechanically proven: Claude chat already resumes with `resume:`, and `outputFormat` composes with it; Codex `thread/resume` + `outputSchema` compose in `runAppServerTurn`.

**Recommendation: resume**, with guards:

- Same engine only: if the picker's agent engine ≠ `latestIteration.engine`, skip resume (model changes within an engine are fine — both adapters set model per turn).
- Resume is best-effort: engine-side session pruned/expired/corrupt → retry the same scoped turn **fresh** (the prompt is self-contained; the engine will read the few since-diff files itself — still scoped, mildly more expensive).
- The review thread re-binds to whatever session id the run returns (Claude mints a new id on resume-fork; Codex keeps the thread id) — same as today's `setThreadEngineSession`.
- Note: today's context grows per update; a long chain of resumed scoped updates accumulates context. Cap chains: after `N=5` consecutive scoped iterations, force a full update to re-ground (Open Question 2).

### 7. Fallback ladder

1. **Threshold exceeded / no prior iteration / `sinceSha` unreachable / engine changed + resume-only failure modes** → today's full update (prompt with `prior` names block), unchanged.
2. **Resume unavailable/fails** → same scoped turn on a fresh session.
3. **Scoped output unusable** — zod parse failure, handshake mismatch, duplicate ids, garbage guard → **one** automatic full update pass (today's path), with a status event `note: scoped update failed (<reason>) — running a full update`. No scoped retry (a model that botched the patch format once will likely botch it again; a full pass is the reliable spend).
4. **Full update fails** → existing error handling (ZodError → friendly message, thread note, op:result), unchanged.

The op stays a single `opId`/review-thread throughout the ladder; only one iteration row is ever written.

### 8. UI surface

Automatic — no scope picker. Changes:

- `GenPanel` "Update review" button and hint text unchanged in behavior; hint gains one clause: "small drift updates only the touched sections."
- During a scoped run, emit status events (`note: scoped update — 3 files changed since a1b2c3d`), which already stream into the tool-call log.
- The persisted agent turn on the review thread (today: `annotations.summary || 'Produced a N-section guided review.'`) becomes, for scoped runs: `Updated <revisedCount> of <sections.length> sections (+<added> new, −<deleted>).` The completion notification mirrors it.
- Iteration provenance: add a nullable `scope TEXT` column (`'full' | 'scoped'`) to `iterations` via migration; `Iteration` gains `scope?: 'full' | 'scoped'`. Timeline/history UI can badge scoped iterations later; the column is written now so history is honest from day one.

## Failure modes

- **Splice mismatch (handshake fails)**: engine omits a prior section from all three lists, or references a never-existed id. Detected deterministically before anything is persisted; falls to ladder step 3. No partial state — the iteration write stays atomic in the existing `inTx`.
- **Hallucinated section refs**: planMap steps pointing at deleted/nonexistent sections are already neutralized by `mergeAnnotations` (`sectionId: ''`); resolved-question ids that don't exist are ignored (no-op filter); files invented by the engine are dropped with today's "unknown file" warning.
- **Engine returns a full document instead of a patch**: fails `scopedReviewWireSchema` parse (missing `keptSectionIds` etc.) → ladder step 3. Conversely a patch that revises everything trips the garbage guard.
- **Drift during generation**: skeleton and since-diff are captured once at op start (same as today — the watcher stays quiet while `operations.repoBusy`); a commit landing mid-run is simply not folded in, `endSha` records the op-start head, and the drift pill reappears on the next poll. Identical semantics to today; no new handling.
- **Stale/pruned engine session on resume**: caught at run start (engine errors) → retried fresh-scoped (ladder step 2). A *resumable but semantically stale* session (e.g. the branch was force-pushed but `endSha` still resolves) is excluded by the `generatedOutOfHistory` gate — off-history updates never take the scoped path.
- **Dirty-tree drift**: scoped basis is `diffSinceWorking` (committed + uncommitted, untracked synthesized), matching what the watcher flagged. `endSha` remains the committed head, exactly as today's update records it for a dirty tree.
- **Comment/viewed integrity**: strictly better than today — untouched section ids survive, so section-anchored comments and `reviewedSections` marks stop dangling; revised sections keep their id too (only body changes). Deleted sections orphan their marks exactly as a full regen does today.

## Test plan (fake-engine driven)

Tests run against `src/main/engines/fake.ts` (`makeEngine` returns it under `LIMN_DEMO=1`). **Known fixture gotcha: FakeEngine emits no `planMap`** — planMap keep/replace splice cases must construct prior annotations by hand rather than via a fake generation. Extend FakeEngine with a deterministic `generateScopedUpdate`: revise the prior section owning each since-diff file's top-level dir, mint `s<N+1>` for an unowned dir, resolve no questions, list the rest in `keptSectionIds`; add env/message hooks (mirroring `LIMN_HOLD_STREAM` / `[approve]` style) to force garbage outputs.

- **`tests/scope.test.ts`** — `scopedEligible` pure cases: file cap, line budget (binary files: 1 file / 0 lines), ratio guard, unreachable `sinceSha` short-circuit.
- **`tests/splice.test.ts`** — pure splice: revise body keeps id/order; add with order insertion; delete; file move empties + drops a kept section; handshake violations (missing prior id, unknown kept id, duplicate id) throw `SpliceError`; garbage guard; question resolve/add; title/summary/planMap null=keep; id re-mint on collision incl. planMap ref rewrite; end-to-end through `mergeAnnotations` — a drift-added unclaimed file sweeps to `'other-changes'` with a warning, coverage stays 100%.
- **`tests/prompts.test.ts`** (extend) — `buildScopedUpdatePrompt`: embeds prior narration (`what`) and section ids; inlines since hunks only (a non-drift file's hunks absent); steer block; untracked candidates exclude already-sectioned paths.
- **`tests/schema-scoped.test.ts`** — `scopedReviewJsonSchema` contains no `prefixItems` and no `additionalProperties`-open records (mirror existing wire-format guards); parse round-trip; full-document output fails parse.
- **IPC integration** (pattern of `tests/ipc-begin-review.test.ts`, real temp git repo + FakeEngine): small drift → scoped path taken, iteration N+1 written with `scope:'scoped'`, untouched section ids identical across iterations, `reviewedSections`/section comments still resolve, `reviewedAtSha` advances; large drift → full path (`scope:'full'`); fake forced to emit a handshake-violating patch → exactly one fallback full run, single iteration row, status note emitted; cancel during scoped setup → no engine launch (existing `throwIfCancelled` window).
- **Renderer** — `gen-session-scope.test.ts` needs no changes (op scoping is orthogonal); add a GenPanel copy assertion if the hint text changes.

## Open questions to resolve before implementation

1. **Threshold values.** Recommended: K = 8 changed files, T = 1000 changed lines (Σ add+del of the since-diff), plus the ≤50%-of-full-diff ratio guard. Start conservative; the fallback makes a wrong "scoped" call cheap to detect via the garbage guard, and a wrong "full" call is just today's behavior.
2. **Scoped-chain cap on resumed sessions.** Recommended: force a full update after 5 consecutive scoped iterations (tracked via the new `scope` column) to re-ground the narration and bound context growth.
3. **Does a reviewer steer force a full pass?** Recommended: no — embed the steer in the scoped prompt; a steer like "restructure the sections" is served by the explicit Regenerate button, and most steers ("focus on error handling") apply fine to a patch turn.
4. **Garbage-guard limits.** Recommended: `SpliceError` when >50% of prior sections are deleted or 100% are revised; both indicate the engine ignored the scoping contract.
5. **Unclaimed drift-added file: warn or fall back?** Recommended: warn and let the `'other-changes'` sweep keep coverage — falling back to a full pass because one new file was missed spends 20× the tokens to fix a one-line miss the reviewer can see flagged.
6. **`scope` column migration now vs later.** Recommended: now — one nullable column, written at iteration insert, unblocks history badging and the chain cap without a second migration.
7. **Untracked candidates in the scoped prompt.** Recommended: include only untracked files not already sectioned in the prior annotations, reusing `MAX_UNTRACKED_OFFERED`; already-sectioned untracked files stay owned by their section unless the engine moves them.
8. **Can a scoped patch edit an existing question's text?** Recommended: no — add/resolve only (`newQuestions` / `resolvedQuestionIds`); question rewording already has a dedicated path (`edit_review` is title/summary/section-only today, and questions carry reviewer answers we must not orphan).
9. **Dirty-only drift ("working tree changed" pill, zero new commits).** Recommended: scoped path applies, basis `diffSinceWorking(workdir, lastEndSha)`; `endSha` stays the committed head exactly as today's full update records it.
10. **Where "updated N of M sections" surfaces.** Recommended: the persisted review-thread agent turn + the completion notification + a status event in the live log; no new UI chrome. If a per-iteration badge is wanted later, the `scope` column already carries it.
