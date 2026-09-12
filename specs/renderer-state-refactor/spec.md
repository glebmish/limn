# Renderer state & component decomposition

## Status: Ready to implement — all open questions resolved (2026-07-02)

Resolutions (all recommendations accepted): Q1 single store + slice creators; Q2 barrel
`store/index.ts` (keep `'../store'` paths); Q3 lazy `api(): RendererApi` function seam;
Q4 keep `sendComments`/`sendAnswers`, make `setComments` slice-internal, update the 6
`addComment` call sites; **Q5 ACCEPT the `composerAt` → `{hunkIdx, lineIdx}` fix (drops
the unreachable duplicate-line double-composer quirk; note it in the commit)**; Q6 move
`startGenerate`/`startGenerateNow` into `store/ops.ts` with a transitional GenPanel
re-export; Q7 defer the selector lint rule; Q8 `DENSITY`/`GUIDANCE` in `store/derive.ts`;
Q9 add `ReviewTitlebar.tsx` only if the orchestrator still exceeds ~350 lines after
extractions 1–6; Q10 assert only UI-rendered `err.message` passthrough strings.

Pure refactoring. Zero behavior change, zero visual change. Every step below must leave
`npm run typecheck` (tsc) and `vitest` green and produce a UI that is pixel- and
interaction-identical.

## Problem (evidence)

Verified against the tree as of `main` (d896f37):

| File | Lines | What it holds |
|---|---|---|
| `src/renderer/store.ts` | 1,162 | ONE zustand store: screen routing, boot/CLI-open, dashboard data, repo/hub context, review lifecycle (transient → materialized), viewed marks & section disclosure, doc overlay, diff-baseline mode, generation/op lifecycle, chat threads + drafts, prefs, global error — plus ~20 exported pure derivation functions |
| `src/renderer/screens/Review.tsx` | 925 | screen orchestration + titlebar/timeline + sidebar (artifacts, peek panels, section nav) + summary band + jump/scroll plumbing + dev screenshot hooks + section rendering |
| `src/renderer/components/DiffView.tsx` | 277 | file header (path/pills/viewed/exclude/artifact badge) interleaved with diff body (hunks, word marks, inline threads, line composer) |
| `src/renderer/lib/comments.ts` | 64 | comment CRUD that mutates the store from outside it |

### The actual store inventory (verified, not the audit's list)

**32 state fields** (all named in "Target shape" below with destinations) and **54 public
actions**, plus 8 closure-scoped helpers inside `create()` (`persistUi`, `persistExcluded`,
`setChats`, `materializeActiveChat`, `sendChatToThread`, `openBranchReview`,
`afterCheckout`, `loadRepoContext`) and one closure variable (`materializing` — the
single-flight guard for `materialize()`, line 476).

### Traced cross-action call chains (the real coupling)

Chains inside the store (→ = calls):

1. **The persist chain** (the audit's headline hazard, confirmed):
   `toggleViewed` / `setSectionViewed` → `persistUi()` → `materialize()` →
   `api.startSession` + `api.loadSession` → **wholesale `loaded` swap** (with a manual
   carry-over of in-memory `fileExcluded`; `viewedAt` survives only because it lives at
   the top level) → `loadRepoContext()` → `api.repoState` + `api.listRepoSessions`;
   then back in `persistUi` → `api.saveUiState(id, { viewedAt })`.
2. `toggleExcluded` → `persistExcluded()` → `materialize()` (same chain) →
   `api.saveUiState({ fileExcluded })`, **plus** `persistUi()` when excluding (a viewed
   mark was dropped) — two racing materialize-guarded persists.
3. **Boot/routing fan-out**: `boot` → `api.getPrefs` → `loadDashboard` →
   `api.takeCliOpen` → `applyCliOpen` → one of `enterHub` | `openReview` | `openRepo`;
   `openRepo` → `resumeExisting` | `openReview`; `openReview` → `api.findSession` →
   `resumeExisting` | `api.previewReview` → `loadRepoContext`; `resumeExisting` →
   `api.loadSession` → `loadRepoContext`.
4. **Checkout payoff**: `checkoutInto` / `addWorktreeFor` → `afterCheckout` →
   `reload` (same-branch) | `openBranchReview` → `resumeExisting` | `openReview`.
5. `setSessionBase` / `newReview` → `openReview`. `copyReviewFrom` → `materialize` →
   `api.copyReviewFrom` + `api.loadSession`. `reload` → `api.loadSession` +
   regenerated-review-thread detection (compares review-chat counts) → `loadRepoContext`.
6. **Chat send paths** (three entry points funneling into two helpers):
   `sendChat` → `materializeActiveChat` (mints draft via `api.createChat`, mutates
   `activeChatId`/`draftChat`) → `sendChatToThread` → optimistic `setChats` →
   `startOp('chat')` → `api.sendChat`;
   `followUp` → find-or-create review thread (`materialize` + `api.createChat`) →
   `openChat` → `sendChatToThread`;
   `sendBatch` → optimistic `setChats` → `openChat` → `startOp` → `api.sendBatch`;
   `sendQueuedComments` → `materializeActiveChat` → `sendBatch`.

Imperative store entry points **outside** the store (all via `useStore.getState()` /
`useStore.setState()`):

- `App.tsx` event bridge: `onOpEvent` → `pushOpEvent` (guarded by `gen.opId === opId`);
  `onOpResult` → `finishOp` + `reload` when `succeeded || reload`; `onRepoChanged` →
  `setPendingDrift` + `refreshRepoContext` (guarded by screen/gen.running/repo/branch);
  `onCliOpen` → `applyCliOpen`; `onSettingsOpen` → `openSettings`.
- `components/GenPanel.tsx` `startGenerate`/`startGenerateNow` (module functions, not
  component code): `checkoutGate` → `materialize` → `api.beginReview` → `reload` →
  `switchChat` → `startOp('review')` → `api.generate`. Store orchestration living in a
  component file.
- `lib/comments.ts` `addComment`/`editComment`/`deleteComment`: `materialize` →
  `api.upsertComment`/`api.deleteComment` → `setComments`. Comment ownership is split:
  the store owns the setter, the lib owns the writes.
- `screens/Review.tsx` approve button: `materialize` → `api.approve`/`unapprove` → `reload`.
- `lib/focus.ts` `focusAnchor`: `closeDoc` / `openSection` / `setFocusTarget`.
- Dev screenshot hooks in `Review.tsx`: raw `useStore.setState({ gen: fakeGenState() })`.

### Other verified pain points

- **`window.api` has no seam.** 22 call sites in `store.ts` plus `comments.ts`,
  `GenPanel.tsx`, `Review.tsx`, `ArtifactDoc.tsx`, `RefPicker.tsx`, `AgentPicker.tsx`,
  `SettingsDialog.tsx` hit the global directly. Tests work only because the store reads
  it lazily inside actions (`tests/chat-mode-draft.test.ts` line 3 comments on exactly
  this). On the web build `window.api` is installed **asynchronously** by
  `main.tsx`/`web-api.ts` before render — so any seam must stay lazy too.
- **Subscription discipline is mixed**: `Review.tsx`, `ChatDrawer.tsx`, `Dashboard.tsx`,
  `RepoHub.tsx`, `DiffView.tsx`, `GenPanel.tsx`, `SectionView.tsx`, `WorkspacePicker.tsx`,
  `UntrackedGroup.tsx`, `ArtifactDoc.tsx` subscribe to the **whole store**
  (`useStore()` bare); `Questions.tsx`, `Threads.tsx`, `Commentable.tsx`, `RefPicker.tsx`,
  `ActionChips.tsx` use fine-grained selectors. Any store split must not accidentally
  change which components re-render *observable behavior-wise* (renders are free to
  stay identical; see Non-goals).
- **`DiffView.tsx` `composerAt`** is `{ line, side, hunkRange, content } | null` and the
  open-composer match is `composerAt.line === lineNo && composerAt.side === side &&
  composerAt.content === l.text` — content-equality as a tiebreaker means two identical
  lines at the same line number in different hunks both show the composer.
- **Zustand usage**: single `create<AppStore>((set, get) => …)`, zustand 5.0.14, **no
  middleware** (no devtools/persist/immer). Nothing blocks the slice pattern.

## Goals / Non-goals

### Goals
- Decompose `store.ts` into slice files composed into the **same single zustand store**,
  with an explicit, typed inventory so no field or action is orphaned.
- Make every cross-slice chain above *explicit* (a named function in a named module)
  instead of implicit closure reach-through.
- One owner for comment mutations (ruling below).
- A lazy `api` seam so tests stop stubbing a global and main/web builds keep working.
- Split `DiffView.tsx` into `FileHeader` + `DiffBody`; carve `Review.tsx` into
  focused components/hooks.
- Pin current behavior with characterization tests **before** moving code.

### Non-goals (explicit)
- **NO behavior change.** Same actions, same ordering, same optimistic updates, same
  error strings, same persistence timing.
- **NO visual change.** No CSS, class-name, or DOM-structure changes beyond mechanical
  component extraction that renders identical markup.
- No switch to multiple zustand stores (subscription semantics would change).
- No forced migration of whole-store subscribers to selectors (render-count tuning is a
  follow-up; see Open question 7).
- No new state, no new features, no IPC changes, no main-process changes.

## Target shape

`src/renderer/store.ts` becomes `src/renderer/store/` with `index.ts` composing slice
creators into one `create<AppStore>()`. Because imports throughout the renderer say
`from '../store'` / `'./store'`, the directory's `index.ts` keeps **every existing import
path and export name working unchanged** (all current exports re-exported from index).

Slice creators use the standard zustand slices pattern:
`const createXSlice: StateCreator<AppStore, [], [], XSlice> = (set, get) => ({ … })`
— `get()` still sees the whole store, so cross-slice calls keep today's exact semantics.

### Slice inventory (every current field/action → destination)

**`store/app.ts` — `AppSlice`** (shell routing, boot, global error, settings)
- state: `screen`, `error`, `settingsOpen`
- actions: `boot`, `applyCliOpen`, `backToDashboard`, `openSettings`, `closeSettings`
- note: `error` is written by many slices (via plain `set({ error })`); it stays a single
  top-level field owned here.

**`store/prefs.ts` — `PrefsSlice`** (persisted preferences)
- state: `agent`
- actions: `setAgent` (keeps its documented cross-patch of `loaded.state/session.agent`),
  plus a `loadPrefs()` extracted from `boot`'s `getPrefs`/parse block.

**`store/dashboard.ts` — `DashboardSlice`**
- state: `dashboard`, `recents`, `filter`, `sel`
- actions: `loadDashboard`, `setFilter`, `openRepository`

**`store/repo.ts` — `RepoSlice`** (repo context + hub)
- state: `repo`, `repoInfo`, `repoState`, `repoSessions`, `showArchived`, `hubReturn`
- actions: `openRepo`, `enterHub`, `refreshRepoContext`, `checkoutInto`,
  `addWorktreeFor`, `deleteSession`, `restoreSession`, `toggleArchived`
- promoted helpers (module-scope, exported for tests): `loadRepoContext`,
  `afterCheckout`, `openBranchReview`

**`store/review.ts` — `ReviewSlice`** (loaded-review lifecycle + comment ownership)
- state: `loaded`, `sessionId`, `branch`, `base`, `transientFresh`, `pendingDrift`
- actions: `openReview`, `materialize` (keeps the single-flight `materializing` closure —
  now module/closure scope of this slice file), `copyReviewFrom`, `resumeExisting`,
  `newReview`, `setSessionBase`, `reload`, `setPendingDrift`
- comments (ruling below): `addComment`, `editComment`, `deleteComment` move here from
  `lib/comments.ts`; `setComments` stays as the internal apply step they share.

**`store/progress.ts` — `ProgressSlice`** (review progress, disclosure, in-review nav, presentation)
- state: `viewedAt`, `collapsed`, `expanded`, `cur`, `curFile`, `focusTarget`,
  `docPath`, `diffMode`
- actions: `toggleViewed`, `setSectionViewed`, `toggleExcluded`, `openSection`,
  `toggleSection`, `setCur`, `setCurFile`, `setFocusTarget`, `openDoc`, `closeDoc`,
  `setGlobalDiffMode`
- promoted helpers: `persistUi`, `persistExcluded` (both still route through
  `get().materialize()` — the chain stays, but now it's a named import boundary),
  `collapseCompletedSections`

**`store/ops.ts` — `OpsSlice`** (generation / operation lifecycle)
- state: `gen`
- actions: `startOp`, `pushOpEvent`, `finishOp`, `cancelOp`, `respondApproval`
- module fns: `newOpId`, `IDLE_GEN`
- relocated here: `startGenerate` / `startGenerateNow` from `GenPanel.tsx` (they are
  store orchestration, not rendering — Open question 6)

**`store/bridge.ts`** (push-event reducers, extracted from `App.tsx`'s `useEffect`)
- `handleOpEvent(msg: OpEventMsg)`, `handleOpResult(msg: OpResultMsg)`,
  `handleRepoChanged(msg: RepoChangedMsg)`, `handleCliOpen`, `handleSettingsOpen` —
  each containing exactly today's guard + dispatch (`opId` equality, screen/gen.running
  checks, `finishOp` → conditional `reload` ordering). `App.tsx` keeps only
  subscribe/unsubscribe wiring. This makes the `op:event`/`op:result` coupling unit-testable.

**`store/chat.ts` — `ChatSlice`**
- state: `activeChatId`, `draftChat`, `chatOpen`
- actions: `switchChat`, `openChat`, `closeChat`, `newChat`, `setActiveChatAgent`,
  `setChatMode`, `dismissSuggestion`, `sendChat`, `followUp`, `sendBatch`,
  `sendQueuedComments`, `deleteChat`
- promoted helpers: `setChats`, `materializeActiveChat`, `sendChatToThread`,
  `pickActiveChat`, `batchUserPreview`; constants `DRAFT_CHAT_ID`, type `ChatDraft`

**`store/derive.ts`** (pure derivations — no `set`/`get`, no api; already the
best-tested code in the store)
- `checkoutGate`, `synthesizeSections`, `effectiveSections`, `fileViewed`,
  `diffHunksForMode`, `viewMarkFor`, `sectionViewState`, `sectionDisclosureState`,
  `fileIsExcluded`, `genCancelled`, `genForLoaded`, `activeChat`, `chatsWithDraft`,
  private `renderedFiles`, `sectionedPathSet`, `filesForSection`
- types: `Density`, `Guidance`, `DiffMode`, `GenState`, `SectionDisclosureState`
- constants: `DENSITY`, `GUIDANCE`

**`store/index.ts`** — `interface AppStore extends AppSlice, PrefsSlice, …`;
`export const useStore = create<AppStore>()((...a) => ({ ...createAppSlice(...a), … }))`;
re-exports everything `store.ts` exports today.

Field audit: `screen, recents, repo, repoInfo, repoState, repoSessions, showArchived,
branch, base, agent, loaded, sessionId, hubReturn, activeChatId, draftChat, chatOpen,
settingsOpen, error, dashboard, filter, sel, transientFresh, viewedAt, collapsed,
expanded, cur, curFile, focusTarget, pendingDrift, docPath, diffMode, gen` — 32/32
assigned above; no orphans.

### Comment ownership ruling

**The store (ReviewSlice) owns all comment mutations.** Rationale: `addComment` /
`editComment` / `deleteComment` already depend on `materialize()` and mutate
`loaded.state.comments` — they are store actions in exile. Moving them in removes the
`setComments` public seam (it becomes slice-internal).

`lib/comments.ts` keeps only what is genuinely lib-shaped:
- `currentReviewChat` (pure), `queuedComments` (pure over `loaded`)
- `sendComments` / `sendAnswers` — thin wrappers over `sendQueuedComments`/`sendBatch`;
  they stay (call sites: `Review.tsx`, `ChatDrawer.tsx`, `ActionChips.tsx`, `Questions.tsx`)
  or become direct store calls (Open question 4).

Call sites of `addComment` (`Review.tsx`, `DiffView.tsx`, `SectionView.tsx`,
`Commentable.tsx`, `ArtifactDoc.tsx`, `Questions.tsx`) switch to
`useStore.getState().addComment` / destructured action — mechanical.

### The api-injection seam

New module `src/renderer/lib/api.ts`:

```ts
import type { RendererApi } from '../../shared/ipc'
/** Lazy accessor: window.api is set by the Electron preload, or installed
 *  asynchronously by web-api.ts before render — never capture it at module init. */
export function api(): RendererApi {
  return window.api
}
```

- All renderer call sites (`store/*`, `lib/comments.ts` remnants, `GenPanel`,
  `Review.tsx`, `ArtifactDoc`, `RefPicker`, `AgentPicker`, `SettingsDialog`) switch
  `window.api.x(…)` → `api().x(…)`. Mechanical; behavior identical because today's reads
  are already lazy.
- Existing tests that stub `window.api` (`chat-mode-draft`, `comments-routing`) keep
  passing unmodified — the seam delegates to the same global. New tests may instead
  `vi.mock('../src/renderer/lib/api')`.
- `web-api.ts` / `main.tsx` are untouched (they *install* the global; the seam only reads it).

### DiffView split (`src/renderer/components/DiffView.tsx`, 277 lines)

- `components/FileHeader.tsx`: the `gfile-head` block — path split, `FileGlyph`,
  renamed/deleted/conflict/mode pills, artifact badge (`openDoc`), `Delta`, the Viewed
  checkbox (with its `setManualOpen(null)` reset), the untracked exclude/include button.
  Props: `{ f, excluded, isViewed, changedSinceViewed, fileStatus, showBody,
  effectiveOpen, artifact, onToggleOpen, onToggleViewed, onToggleExcluded }` — all
  computed in the parent so header stays presentational.
- `components/DiffBody.tsx`: hunks, `CodeLine`/word-marks, per-line comment gutter +
  `InlineThread`s + `Composer`, empty-state messaging, outdated-comments footer,
  plain-note band. Module-private helpers `splitPath`, `describeModeChange`, `disp`,
  `hunkWordMarks`, `CodeLine` move with their consumers.
- `DiffView.tsx` remains the stateful shell (~60 lines): store reads, `composerAt`,
  `fileCommenting`, `manualOpen`, derived flags; renders `FileHeader` + file-level
  threads + `DiffBody`.
- `composerAt` becomes `{ hunkIdx: number; lineIdx: number } | null` — an unambiguous
  identity for the rendered line. Anchor fields (`line`, `side`, `hunkRange`,
  `lineContent`) are derived from `hunks[hunkIdx].lines[lineIdx]` at submit time,
  producing byte-identical `addComment` anchors. (This *fixes* the duplicate-line
  double-composer edge; see Open question 5 for whether to preserve that quirk instead.)

### Review.tsx carve (925 lines → ~300-line orchestrator)

Extractions (each renders today's exact markup):
1. `components/DriftFetchPill.tsx`, `components/MarkersKey.tsx` (or one
   `ReviewHeaderBits.tsx`), `components/HeaderDiffControls.tsx` — already self-contained
   function components inside the file (lines 57–169).
2. `components/ReviewTimeline.tsx` — the `ctmark` block: `timelineTitle`,
   `timelineTipContent`, `renderTimelineStop`, the `timelineGroups` mapping (lines
   352–432 + 594–621). Props: `loaded`, `commits`, `timelineGroups`, `pendingDrift`,
   `onReload`.
3. `components/ReviewSidebar.tsx` — the `<nav className="gside">`: artifact groups +
   peek panels (spec acceptance / plan steps with their comment composers) + `gnav`
   section tree + working-tree/flat `FileTree`s (lines 645–807). Callback props for
   `jumpTo`/`jumpToFile`/`jumpToRawFile`/`toggleDoc`.
4. `components/ReviewSummary.tsx` — title threads + `rr-summary` bands + summary
   threads/selection threads (lines 835–896).
5. `lib/useReviewScroll.ts` — `scrollRef`/`headRef`/`secRefs`, the header-height CSS-var
   effect, the scroll-sync effect, `jumpTo`, `jumpToFile`, `jumpToRawFile`,
   `restoreScroll`, doc scroll-memory (`goToDoc`/`closeDocBack`/`toggleDoc`). One hook
   returning refs + jump functions; the retry-loop and `behavior:'instant'` comments move
   verbatim.
6. `lib/useDevReviewHooks.ts` — the dev-only `useEffect` block (flow/focus/batch/
   fakeGen/fakeDrift/openDoc one-shots) + `fakeGenState`, keeping the module-level
   `devXRan` flags' run-once semantics.

## Migration plan (ordered; each step lands green on its own)

1. **Characterization tests** (see next section). No production code moves.
2. **api seam**: add `lib/api.ts`; mechanically replace `window.api.` → `api().` across
   the renderer. Typecheck + full vitest.
3. **`store.ts` → `store/` directory**: create `store/index.ts` + `store/derive.ts`
   (pure functions + types + constants move; `index.ts` re-exports all). The store
   creator body itself is not yet split. All `from '../store'` imports resolve unchanged.
4. **Extract `OpsSlice`** (`gen` + op actions; smallest, clearest boundary) and
   **`store/bridge.ts`** (App.tsx handlers → named functions + tests). App.tsx shrinks
   to subscription wiring. Move `startGenerate`/`startGenerateNow` from `GenPanel.tsx`
   here (GenPanel re-exports them transitionally if anything imports from it — only
   `Review.tsx` does).
5. **Extract `DashboardSlice` + `PrefsSlice`** (few dependents; `boot` stays in app
   slice calling `loadPrefs`/`loadDashboard`).
6. **Extract `RepoSlice`** (promote `loadRepoContext`/`afterCheckout`/`openBranchReview`
   to named module functions).
7. **Extract `ChatSlice`** (promote `setChats`/`materializeActiveChat`/
   `sendChatToThread`; the routing tests from step 1 + existing `comments-routing`,
   `chat-mode-draft` pin it).
8. **Extract `ReviewSlice` + `ProgressSlice` together** (they share the
   persist/materialize chain; splitting them across two landings would leave a
   half-moved closure). `materializing` stays a module-closure single-flight guard.
9. **Comment ownership**: move `addComment`/`editComment`/`deleteComment` into
   `ReviewSlice`; slim `lib/comments.ts`; update the six call sites; make `setComments`
   non-public (or keep exported if tests demand — Open question 4).
10. **DiffView split**: `FileHeader` + `DiffBody` + `composerAt` retyping.
11. **Review.tsx carve**: steps in the order 1→6 listed above, one or two extractions
    per landing (pill/controls first — pure moves; the scroll hook last — it touches the
    most refs).
12. **(Deferred, separate decision)** selector adoption for whole-store subscribers +
    a lint guard. Out of this refactor's scope (Open question 7).

Each step: `tsc --noEmit` + `vitest run` + a manual smoke (open a seeded session,
toggle viewed, send a chat turn) before commit. Commit per step (
commit as you go; rebuild the .app with `npm run package` after landing).

## Characterization-test plan

Pinned **before step 2**. The repo runs vitest including `.tsx` (see
`tests/file-tree.test.tsx`, `action-chips.test.tsx`). Existing coverage already pins the
pure layer: `viewed`, `section-viewed`, `diff-mode`, `gen-cancel`, `gen-session-scope`,
`focus` (selector), `selection`; and two action flows: `chat-mode-draft` (draft
setChatMode short-circuit), `comments-routing` (sendQueuedComments → active chat,
draft minting, batch preview text). New tests (store-level, stubbing `window.api` the
way `comments-routing.test.ts` does):

1. **`tests/store-materialize.test.ts`** — the persist chain:
   - `toggleViewed` on a transient review mints a session exactly once
     (`startSession` called once) even when two toggles race (single-flight guard);
   - `saveUiState` is called with the minted id and the post-toggle `viewedAt`;
   - the `loaded` swap carries over in-memory `fileExcluded` and keeps top-level
     `viewedAt` (the line-731 comment's contract);
   - `materialize` returns the existing id when already persisted, null on failure
     (error string surfaced to `error`).
2. **`tests/store-excluded.test.ts`** — `toggleExcluded`: untracked-only guard; exclude
   drops the viewed mark and issues both `saveUiState({fileExcluded})` and
   `saveUiState({viewedAt})`; include-back issues only the exclusion save.
3. **`tests/store-op-lifecycle.test.ts`** — `startOp` resets log/outcome/startedAt;
   `pushOpEvent` no-ops when not running and caps the log at 200; `finishOp` maps
   `failed`+error / `succeeded`; `cancelOp` records `cancelled` optimistically and calls
   `api.cancel`; via `store/bridge` handlers (or inline copies pre-extraction):
   op-id mismatch drops events; `onOpResult(succeeded)` triggers `reload`,
   `failed` without `reload` flag does not.
4. **`tests/store-routing.test.ts`** — `applyCliOpen` dispatch table (error / hub /
   fresh / refs / bare); `openRepo` resume-vs-transient choice (branch match, DESC
   fallback, none → `openReview`); `resumeExisting` resets gen/collapsed/diffMode and
   picks the active chat (`pickActiveChat` behavior via observable `activeChatId`).
5. **`tests/store-reload.test.ts`** — regenerated-review detection: reload with one more
   review-kind chat selects the newest review thread; otherwise keeps/re-picks the
   current one; `pendingDrift` clears.
6. **`tests/store-chat-send.test.ts`** — `sendChat` while `gen.running` is a no-op;
   draft minting then send lands in the minted thread with the optimistic user message
   appended; `followUp` targets the latest review thread, else creates one;
   `sendBatch` writes the `batchUserPreview` text and `commentRefs`.
7. **`tests/store-section-disclosure.test.ts`** — `toggleViewed`/`setSectionViewed`
   auto-collapse of completed sections (`collapseCompletedSections` via observable
   `expanded`), `openSection`/`toggleSection` set interplay, `setCur`/`setCurFile`
   identity short-circuits.
8. **Component pins for the splits** (`.tsx`): a `DiffView` render test asserting
   header markup (pills, viewed checkbox state, exclude button), composer
   open/submit anchor payload, empty-state strings per mode — run unchanged across
   step 10; a light `Review` sidebar test is impractical (too much store setup) —
   rely on `file-tree.test.tsx` + manual smoke + `scripts/shot.sh` screenshot diffing
   for the Review carve (note: shots need a GUI session).

## Risks

- **The implicit chains are load-bearing.** `persistUi → materialize` ordering (mark set
  *before* materialize so the swap keeps it), the `fileExcluded` carry-over, and the
  `materializing` single-flight closure are the exact places a slice split can silently
  regress. Mitigation: tests 1–2 land first; ReviewSlice+ProgressSlice move as one step.
- **Event-reducer coupling to `op:event`/`op:result`.** The `gen.opId === opId` guard,
  the `finishOp` → conditional `reload` ordering, and `genForLoaded`'s thread-scoping
  together prevent cross-session bleed (already bitten once — see
  `gen-session-scope.test.ts`'s "leak" test). Extracting bridge handlers must not
  reorder guard vs. dispatch. Mitigation: test 3 + verbatim moves.
- **Whole-store subscribers.** `useStore()` bare subscriptions re-render on any store
  change; composing slices keeps one store so nothing changes — but any "tidy-up" to
  selectors mid-refactor could change effect timing in components with `useEffect`
  deps on destructured values. Rule: no subscription changes in this refactor.
- **Set-valued state** (`collapsed`/`expanded`): every mutation clones (`new Set(...)`);
  moved code must preserve clone-before-mutate or React equality breaks.
- **`window.api` timing on the web build**: the seam must never capture `window.api` at
  module init (it's installed async by `web-api.ts`). The `api()` function form is safe;
  a `const api = window.api` binding is not. Also a stale open SPA tab
  keeps an old bundle — restart serve + hard-reload when smoke-testing web.
- **Dev screenshot hooks** write raw store shapes (`useStore.setState({ gen: … })`,
  `showArchived`, `activeChat`) — slice renames/moves must keep these field names, and
  `dev.ts`/`LIMN_*` flows are how screenshots get made; breaking them blocks visual
  verification itself.
- **`GenPanel.startGenerate` relocation** changes an import path used by `Review.tsx`
  (`startGenerateNow`); a transitional re-export avoids a cross-file rename landing in
  the same commit as slice moves.
- **`store/index.ts` re-export completeness**: 20+ named exports (`fileViewed`,
  `checkoutGate`, `DENSITY`, `DRAFT_CHAT_ID`, types…) are imported by 18 renderer files
  and 8 test files; a missed re-export is a compile error (caught by tsc) but a missed
  *type* re-export can degrade to `any` silently — audit with `tsc --noEmit` on tests too.

## Open questions to resolve before implementation

1. **Store composition: single store with slice creators (recommended) vs. multiple
   stores per domain?** Recommended: single store, zustand slices pattern. Multiple
   stores change subscription and `get()` cross-call semantics — a behavior change this
   spec forbids.
2. **Keep the `'../store'` import path via `store/index.ts` barrel, or update all 26
   importers to deep slice paths?** Recommended: barrel now (zero-churn, keeps tests'
   imports stable); deep imports later only if bundle-size or cycle pressure appears.
3. **Seam shape: `api(): RendererApi` lazy function (recommended), a Proxy-backed
   `api.x()` object, or DI through the store creator?** Recommended: the lazy function —
   dumbest thing that works, keeps existing `window.api`-stubbing tests green, avoids
   Proxy edge cases, and web-build async install stays correct.
4. **After moving comment CRUD into ReviewSlice, do `lib/comments.ts` wrappers
   (`sendComments`, `sendAnswers`) stay as the lib API, and does `setComments` remain
   exported?** Recommended: keep `sendComments`/`sendAnswers` (4 call sites, they add
   routing logic), make `setComments` slice-internal, update the 6 `addComment` call
   sites directly.
5. **`composerAt` retyping to `{hunkIdx, lineIdx}` fixes the duplicate-line
   double-composer quirk …** — **RESOLVED: accept the fix.** Use `{hunkIdx, lineIdx}`;
   the double-composer quirk disappears (unreachable in practice). Note the fix in the
   commit message. This is the one intentional behavior change in an otherwise
   zero-change refactor.
6. **Move `startGenerate`/`startGenerateNow` from `GenPanel.tsx` into `store/ops.ts`?**
   Recommended: yes — they are pure store/api orchestration and the ops slice is their
   natural home; leave a re-export in `GenPanel.tsx` for one release of the branch, then
   drop it.
7. **Enforce fine-grained selectors (lint rule banning bare `useStore()`) as part of
   this work?** Recommended: no — defer to a follow-up. It only affects render counts,
   but "only" is doing work there (effects keyed off re-renders); keeping subscriptions
   untouched is the cheapest way to guarantee the zero-change bar.
8. **Where do `DENSITY`/`GUIDANCE` (baked-in presentation constants) live?**
   Recommended: `store/derive.ts` with re-export from the barrel — they're consumed
   alongside derivations (`App.tsx`, `Review.tsx`, `DiffView.tsx`); a separate
   `ui-constants.ts` is a nicety, not worth an extra module.
9. **Review.tsx carve depth: stop at the six extractions listed, or also split the
   titlebar (RefPickers + Workspace/Sessions/Chat/Settings buttons) into a
   `ReviewTitlebar.tsx`?** Recommended: include `ReviewTitlebar.tsx` only if the
   orchestrator still exceeds ~350 lines after extractions 1–6; it's the least tangled
   region and can land any time.
10. **Do the new characterization tests assert on `error` message strings?**
    Recommended: yes for the strings the UI renders verbatim today (`err.message`
    passthrough), no for anything main-process-generated — those belong to existing
    main-side tests (`operations.test.ts`, `ipc-begin-review.test.ts`).
