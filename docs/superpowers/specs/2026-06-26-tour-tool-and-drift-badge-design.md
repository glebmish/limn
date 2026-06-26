# Tour tool + drift fetch-pill — design

Two features ported from the `04-drift-close` and `05-reference` design screens
(claude.ai/design project `d3c098e6`) into the live app.

- **A. `tour` agent tool** — a multi-file walkthrough the agent can drop in chat
  (from `05-reference`, "Custom review tools the agent can call").
- **B. drift fetch-pill** — a dynamic badge in the titlebar commit timeline that
  surfaces what landed on the branch since the loaded snapshot (from
  `04-drift-close`, "Review — what changed since you reviewed").

Both ride existing patterns: `tour` is a sibling of the existing `focus` tool;
the fetch-pill enriches the existing 2 s HEAD-watcher and the existing `.ctmark`
timeline.

> **Status (2026-06-26):** **A. `tour`** was already implemented and committed in
> HEAD before this work began (tool + `TourCard` + `I.tour` + tests all present and
> green) — the section below documents it but no code change was needed. **B. the
> drift fetch-pill** is the work built in this branch.

---

## A. `tour` agent tool

The agent already has `focus` (scroll + flash one spot). `tour` is the same
mechanism applied to an ordered list of stops spanning multiple files — for
pointing out something the diff spreads across (a value's path, a call chain).
The chat renders a stepper card; the reviewer walks Prev/Next or clicks a stop,
and each stop drives the existing `focusAnchor`.

### Data model — `src/shared/types.ts`
- New `export interface TourStop { anchor: FocusTarget; note?: string }`.
- `AgentAction` gains `| { kind: 'tour'; stops: TourStop[]; loop?: boolean }`.

### Tool — `src/main/engines/tools.ts`
- New `tour` tool. Input: `stops: z.array(z.object({ target: focusTarget, note: z.string().optional() })).min(1)`,
  `loop: z.boolean().optional()`. Description mirrors the design copy.
- Factor the existing inline diff-target → `FocusTarget` normalization (today
  buried in the `focus` run) into a shared `toFocusTarget(target)` helper; both
  `focus` and `tour` use it.
- `run` maps each stop's `target` through `toFocusTarget`, emits
  `{ kind: 'tour', stops, loop }`, and returns a result string naming the stops
  (e.g. `Started a 3-stop walkthrough: limiter.ts:11 → server.ts:14 → queue.ts:8.`).

### Card — `src/renderer/components/ActionChips.tsx`
- New `TourCard` (rendered as a `'card'` from `renderAction`, new `case 'tour'`):
  - Head: `I.tour` glyph · "Walkthrough" · `ah-anchor` = `N stops` (+ ` · loops` when `loop`).
  - One `lt-stop` button per stop, numbered (`lt-n`), current highlighted (`on`);
    `lt-name` = `focusTarget(anchor).text`; `note` becomes the hover `title`.
  - Bar: Prev / `Stop i of N` (`lt-pos`) / Next. Loop wraps; non-loop clamps.
  - Local `useState` cursor. Clicking a stop or stepping calls `focusAnchor(stop.anchor)`
    and moves the cursor.

### Live behavior — `src/renderer/App.tsx`
- When a `tour` action streams in live, focus the first stop (mirrors how `focus`
  runs live): `if (event.action.kind === 'tour' && event.action.stops[0]) focusAnchor(event.action.stops[0].anchor)`.

### Glyph — `src/renderer/kit.tsx`
- Add `I.tour` (the design's `#i-tour`: two circles joined by an elbow path).

### CSS
- Port `.limn-act.tour`, `.limn-tour-stops`, `.lt-stop`/`.lt-n`/`.lt-name`,
  `.limn-tour-bar`, `.lt-ctl`, `.lt-pos` from the design lib css into the app's
  review css.

---

## B. drift fetch-pill (badge)

The app already runs a 2 s watcher (`startWatch` in `ipc.ts`) that polls the
compare branch head and, today, **silently auto-reloads** the review when it
moves. Per the chosen behavior, replace the auto-reload with a notify-badge: the
watcher reports a drift summary, the renderer stashes it, and the `.ctmark`
timeline grows a pulsing fetch-pill. Clicking it reloads (folds the new snapshot
in). The numbers cover **both** new commits and uncommitted working-tree edits
since the loaded snapshot SHA.

### Data model
- `src/shared/types.ts`: `export interface DriftSummary { headSha: string; commits: number; files: number; add: number; del: number }`.
- `src/shared/ipc.ts`: `RepoChangedMsg` gains `drift: DriftSummary | null`.

### Drift computation — `src/main/git.ts`
- New `driftSummary(repo, branch, workdir, loadedSha): Promise<DriftSummary>`,
  composing existing helpers (no new diff parser):
  - `commits` = `rev-list --count <loadedSha>..<branch>`.
  - From `diffSinceWorking(workdir, loadedSha)` (committed + dirty since the SHA,
    in worktree space): `files` = length, `add`/`del` = summed per-file. When the
    branch is checked out nowhere (`workdir` null) fall back to a committed-only
    `<loadedSha>..<branch>` diff.
  - `headSha` = current `headSha(repo, branch)`.
- Untracked files are out of scope for the delta (documented).

### Watcher — `src/main/ipc.ts`
- `startWatch(repo, branch, loadedSha)` resolves `workdir = branchCheckedOutAt(repo, branch)`
  once, captures a baseline change-signature (`headSha` + `status --porcelain`),
  and stores `loadedSha`.
- Each poll (still skipped while `repoLocks.has(repo)`): compute the cheap
  signature; if unchanged since last poll, return. On change, compute
  `driftSummary`; emit `repo:changed` with `drift = (sig === baseline ? null : summary)`
  so reverting edits clears the badge. Fires on commits **or** working-tree edits.
- A reload re-calls `startWatch` with the new head, resetting the baseline — so
  clicking the pill (→ `reload`) clears the drift.

### Renderer — `src/renderer/App.tsx` + `src/renderer/store.ts`
- `onRepoChanged` no longer auto-reloads; it calls `store.setPendingDrift(drift)`
  (same `repo/branch`, not gen-running guard). `drift` may be `null` (clears).
- Store: `pendingDrift: DriftSummary | null` (init `null`), `setPendingDrift(d)`;
  cleared in `reload()` and when leaving the review (openReview/backToDashboard).

### Badge — `src/renderer/screens/Review.tsx`
- When `pendingDrift` is set, append a `<button className="cm-fetch">` to `.ctmark`
  after the timeline groups:
  - `cmf-dot` (pulsing amber), `cmf-chip` (commit count + `I.changed`),
    `cmf-delta` `+{add} −{del}` (`cmf-del` on the deletions).
  - `title` names the loaded short-SHA and the full breakdown incl. file count.
  - `onClick` → `store.reload()`.

### CSS
- Port `.cm-fetch`, `.cmf-dot` (+ pulse keyframes), `.cmf-rest`, `.cmf-chip`,
  `.cmf-delta`, `.cmf-del` from the design lib css into the app's review css.

---

## Testing
- `tour` tool: extend `tests/tools.test.ts` — valid/invalid stops (≥1 enforced),
  diff-target normalization, emitted `{ kind: 'tour', stops, loop }` action.
- `driftSummary`: new `tests/git-helpers.test.ts` cases against a temp repo —
  commits-only, dirty-only, combined, and none (zeros).
- Full `npm test` + typecheck green.
- Visual proof via `scripts/shot.sh`: the walkthrough card in chat and the
  fetch-pill in the timeline.

## Out of scope (v1)
- Untracked-file deltas in the pill.
- Advancing the loaded snapshot without a full reload (the design's "folds in" —
  a plain `reload()` already yields the correct new snapshot).
- Per-section amber re-review re-flagging on refresh beyond what the existing
  "Since approved/viewed" drift rails already produce on reload.
