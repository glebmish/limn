# UX & accessibility sweep

## Status: Ready to implement — all open questions resolved (2026-07-02)

Resolutions: Q1 accept natural tab order (keyboard-reachable "+"); **Q2 invisible at rest
(`opacity:0`, still focusable) — NOT the subdued-visible variant (§1 updated)**; Q3 nudge
+ deep-link (full card only on the owning thread); Q4 badge unconditionally on pending
approvals; Q5 native `indeterminate` only; Q6 `CHAT_WINDOW = 100` (single const); Q7 the
simple Tab-wrap focus trap.

Five small, independently shippable renderer fixes from a UX audit. Each item below was
re-grounded against the code; where the audit's claim was off, the corrected finding is
stated and the fix targets the corrected reality. No main-process behavior changes except
one optional store-shape addition for item 3.

---

## Problem (per item, with evidence)

### 1. Line-comment affordance is hover-only and keyboard-unreachable

The per-line "+" button is always rendered in the DOM
(`src/renderer/components/DiffView.tsx:235-241`, `className="gutter-add limn-line-add"`),
but CSS hides it with `display: none`:

- `src/renderer/styles/app.css:307-309`
  ```css
  .dline .limn-line-add { display: none; border: none; cursor: pointer; }
  .dline:hover .limn-line-add { display: flex; }
  ```
- `src/renderer/styles/wf.css:226-230` (base `.gutter-add` style) *already tries* to
  handle keyboard: `.dline:hover .gutter-add, .dline:focus-within .gutter-add,
  .gutter-add:focus-visible { display: flex }` — **but this can never fire**: a
  `display: none` element is removed from the tab order and the accessibility tree, so
  it can never receive focus, so `:focus-visible` / `:focus-within` never match. The
  keyboard path was intended and is dead code.

Net effect: the only way to comment on a line is to discover an invisible hover target
with a mouse. Undiscoverable for new users; unusable for keyboard and touch.

### 2. Accessibility gaps

**(a) Viewed checkboxes are invisible to assistive tech and keyboard, and tri-state is
visual-only.**

- The native input is `display: none` — `src/renderer/styles/review.css:442`
  (`.file-viewed input{display:none}`). `display: none` removes the checkbox from both
  the tab order and the accessibility tree entirely, so the "Viewed" controls are not
  merely mislabeled — they are completely unreachable by keyboard/screen reader. This is
  the biggest finding in the sweep and worse than the audit's original claim.
- Section checkbox tri-state: `src/renderer/components/SectionView.tsx:69-79` renders
  `checked={done}` with a purely visual dash (`.fv-dash`, `review.css:465`) for the
  `some` state — never sets `input.indeterminate`, never sets `aria-checked="mixed"`.
- File checkbox amber state: `src/renderer/components/DiffView.tsx:145-155` renders
  `checked={isViewed}` with a visual `~` for "changed since viewed" — semantically it
  reads as a plain unchecked box; the amber middle ground is conveyed only by color and
  glyph.

**(b) `clickable()` disclosure triggers — corrected.** The audit claimed the helper
lacks aria-expanded; it doesn't. `src/renderer/lib/clickable.ts:23` supports an
`expanded` opt, and most disclosure call sites pass it (DiffView.tsx:116,
ToolCallLog.tsx:49, FileTree.tsx:33, Review.tsx:773). The one gap:
`src/renderer/components/SectionView.tsx:43` — the collapsed section header is a
disclosure trigger (`clickable(() => openSection(s.id))`) with no `expanded`, so a
screen reader hears an unlabeled generic button.

**(c) Modal focus restoration is inconsistent — scope corrected.** ChatDrawer restores
focus correctly (`src/renderer/components/ChatDrawer.tsx:104-116`: saves
`document.activeElement` on open, focuses the drawer, restores on close — the house
precedent). `src/renderer/components/SettingsDialog.tsx` (the app's only
`role="dialog"` / `aria-modal="true"` modal, line 103) does none of it: no initial
focus into the dialog, no restore on close, no focus trap — after Escape (lines 75-81)
focus is stranded on `<body>`. The audit also named GenPanel; that claim is **dropped**:
GenPanel is inline (not a modal), and its popovers (`usePopover` → `useDismiss`,
`src/renderer/lib/usePopover.ts:26-35`) never move focus off the trigger, so there is
nothing to restore there.

### 3. A pending approval is invisible unless you're looking at exactly the right place

Corrected finding: the audit said an approval "cannot be dismissed without cancelling
the whole turn" — in fact a per-request **Deny already exists**
(`src/renderer/components/ApprovalCard.tsx:36-38`, distinct from "Stop turn" on line
39, routing to `resolveDecision` in `src/main/engines/approvals.ts:25-31`). The real
problem is **reachability**: the card renders only when *all* of these hold —

- the chat drawer is open (`ChatDrawer.tsx:118` — `if (!open) return null`; mounted at
  `src/renderer/screens/Review.tsx:921` gated on `chatOpen`), and
- the active chat is the streaming thread (`ChatDrawer.tsx:51` —
  `streaming = gen.running && gen.threadId === active?.id`; `pendingApprovals` at lines
  67-69 is `[]` when not streaming).

If the drawer is closed, or the user switched to another chat, there is **zero
indication anywhere** that the turn is parked on an approval:

- The header Chat button (`Review.tsx:626-628`) has no badge.
- GenPanel's progress strip (`src/renderer/components/GenPanel.tsx:154-179`) shows the
  same spinner + "Claude is thinking…" whether the agent is working or parked — a hung
  turn is indistinguishable from a thinking one.

The no-timeout design (`approvals.ts:5-6`) is deliberate and **stays**.

One more latent detail: `answered` request-ids are tracked in ChatDrawer local state
(`ChatDrawer.tsx:65-69`), so any second surface deriving pending approvals from
`gen.log` would disagree with the drawer after a decision. The pending-approval
derivation must move to one shared place.

### 4. ChatDrawer renders unbounded message lists; per-event re-render re-does all work

- `ChatDrawer.tsx:172-202`: `active.messages.map(...)` renders every persisted message
  on every render — no windowing, no memoization. Each agent message re-parses its
  markdown (`<Markdown text={m.text} />`) on every render.
- While streaming, every engine event updates `gen` (fresh `log` array each event —
  `src/renderer/store.ts:946-950`), re-rendering the whole drawer: N settled messages ×
  markdown parse, per event.
- `reduceSegments(gen.log)` / `reduceToolCalls(gen.log)` re-run on every render
  (`ChatDrawer.tsx:54-55`; also `GenPanel.tsx:158`). Corrected claim: the audit said
  ToolCallLog re-reduces — ToolCallLog itself doesn't reduce; its *callers* do,
  unmemoized.
- Verified: the op log **is** capped at ~200 events (`store.ts:949`,
  `gen.log.slice(-200)`), so the live-stream side is bounded. The unbounded side is
  persisted `active.messages` (chat threads accumulate forever in the DB).
- Verified: large tool outputs are already collapse-by-default — ToolCallLog rows render
  their body only when expanded (`ToolCallLog.tsx:58-67`) and `.tcall-out` is
  scroll-capped at 260px (`app.css:111`). No work needed there.

### 5. "Update review" hint says "Same session…" — half false

`src/renderer/components/GenPanel.tsx:320` (audit said ~317):

> "Same session. Folds the new commits into the existing review narration; your
> comments and viewed marks survive."

Ground truth: an update is a **fresh engine run** seeded with the prior review's
structure —

- `src/main/ipc.ts:376-396`: `prior = { title, summary, sections: [names], sinceSha }`
  is passed to `engine.generateReview(...)`; `ReviewRequest`
  (`src/main/engines/types.ts:7-20`) has **no** resume/`engineSessionId` field (contrast
  `ChatTurn`, types.ts:28-29, which does) — so the agent starts a brand-new session with
  no memory of the previous pass.
- `src/main/engines/prompts.ts:58-63`: the prior structure is injected as an
  "UPDATING AN EXISTING REVIEW … FOLD them into the review below rather than starting
  blank" prompt block.
- What *is* true: the **Limn** side survives — `beginReview` reuses the existing review
  chat thread on update (`ipc.ts:343-357`), and comments/viewed marks live in review
  state untouched by generation.

So "Same session" is false for the agent, true-ish for the Limn thread — the copy must
be honest about both halves. (The sibling hints already model the right language:
line 309 "Fresh pass for this branch history…", line 341 "Fresh agent, new session…",
line 331 "Same session…" for Follow up — which genuinely resumes.)

---

## Goals / Non-goals

**Goals**

- Make the per-line comment affordance discoverable and keyboard-operable.
- Make the Viewed checkboxes real, reachable form controls with correct tri-state
  semantics.
- Close the two remaining aria/focus gaps (SectionView disclosure, SettingsDialog
  focus lifecycle).
- Make a parked approval visible and answerable from anywhere in the review screen.
- Keep long chats responsive at ~500 messages with the lightest fix that holds
  (memoization + windowing — no virtualization library).
- Fix the "Update review" hint copy.

**Non-goals**

- No approval timeout (deliberate design, stays).
- No virtualization library (react-window etc.) unless the light fix demonstrably fails.
- No redesign of the approval flow, engines, or main-process approval registry
  (`approvals.ts` is untouched except as read-only grounding).
- No global keyboard-navigation system for diff lines (roving tabindex/j-k navigation
  is out of scope; noted as a possible follow-up in open question 2).
- No changes to GenPanel popover focus behavior (claim dropped — see Problem 2c).

---

## Design

Design-language notes used throughout (from `src/renderer/styles/app.css`,
`review.css`, `wf.css`): amber (`--amber` / `--amber-soft` / `--amber-line`) is the
"needs your attention / waiting" color (drift banner, approval card, re-review pills);
accent green is affirmative; pills are 999px-radius mono-font badges; buttons are
`.btn .btn-sm [.btn-ghost|.btn-primary]`; the app already has a global focus-ring rule
for inputs (`app.css:7`) but nothing for custom controls.

### 1. Persistent-but-subdued line-comment "+"

**Current:** button in DOM on every `.dline`, `display: none` until `.dline:hover`
(app.css:307-309); dead `:focus-within`/`:focus-visible` reveal rules in wf.css:230.

**Proposed:** switch from `display` toggling to opacity/color states so the button is
always focusable and always faintly visible.

Files touched: `src/renderer/styles/app.css` (lines 307-309), `src/renderer/styles/wf.css`
(lines 226-230), `src/renderer/components/DiffView.tsx` (button aria-label only).

- wf.css `.gutter-add` base (line 226-229): keep `position:absolute; left:22px;
  top:50%; transform:translateY(-50%); width:18px; height:18px; border-radius:5px;`
  but change the rest state from `display:none` to **invisible-but-present-and-focusable**
  (resolved open question 2 — *invisible at rest*, not subdued): `display:flex;
  opacity:0; background:transparent; color:var(--muted-2); box-shadow:none;`. The key
  difference from today: `display:flex` (not `none`) keeps the button in the tab order
  and the accessibility tree, so hover **or focus** can reveal it; `opacity:0` means it
  adds no visible glyph column at rest. (Discoverability-at-rest is intentionally traded
  away; reachability via hover/focus is the goal.)
- Active state (replaces wf.css:230 and app.css:308-309):
  ```css
  .dline:hover .gutter-add,
  .dline:focus-within .gutter-add,
  .gutter-add:focus-visible {
    opacity: 1; background: var(--accent); color: #fff;
    box-shadow: 0 1px 3px rgba(0,0,0,.22);
  }
  .gutter-add:focus-visible { outline: 2px solid var(--accent-line); outline-offset: 1px; }
  ```
  With the button focusable, the existing `:focus-within` / `:focus-visible` selectors
  (previously dead) start working as originally intended: Tab reaches the button,
  focus lights it up exactly like hover, Enter/Space opens the composer (it is already
  a real `<button>` with an onClick — DiffView.tsx:235-241).
- Delete the app.css:307-309 `display:none` block (it exists only to re-hide what
  wf.css shows; after the wf.css change it would fight the new rest state). Keep
  `border:none; cursor:pointer` by folding them into the wf.css base rule.
- DiffView.tsx: extend the button with a per-line label for screen readers:
  `aria-label={`Comment on line ${lineNo}`}` (keep the `title`). No structural change.

Interaction summary: the "+" is present on every diff line but invisible at rest
(`opacity:0`); hovering the line or tabbing to the button reveals it as the familiar
solid green badge; clicking or pressing Enter opens the existing inline Composer
(unchanged). Because the button stays `display:flex`, Tab reaches it and focus reveals
it even though it is not painted at rest.

### 2a. Real, tri-state-correct Viewed checkboxes

**Current:** `input { display:none }` (review.css:442); `.fv-box` span paints the
check/dash/`~`; SectionView never sets `indeterminate`.

**Proposed:** visually-hidden-but-present input + native `indeterminate` + focus ring.

Files touched: `src/renderer/styles/review.css` (line 442 + one new rule),
`src/renderer/components/SectionView.tsx` (lines 69-79),
`src/renderer/components/DiffView.tsx` (lines 145-155).

- review.css: replace `.file-viewed input{display:none}` with the standard sr-only
  pattern so the input stays in the tab order and a11y tree:
  ```css
  .file-viewed input { position: absolute; width: 1px; height: 1px; margin: -1px;
    padding: 0; border: 0; clip-path: inset(50%); overflow: hidden; white-space: nowrap; }
  .file-viewed input:focus-visible + .fv-box { outline: 2px solid var(--accent-line); outline-offset: 1px; }
  ```
  (`.fv-box` immediately follows the input in both components, so the sibling selector
  works. The label wrappers already `stopPropagation` so Space on the input won't
  toggle the surrounding header.)
- SectionView.tsx: set native indeterminate via a ref callback on the input —
  ```tsx
  ref={(el) => { if (el) el.indeterminate = viewState === 'some' }}
  ```
  Native `indeterminate` is announced as "mixed" by screen readers; no
  `aria-checked` attribute needed (setting both is redundant — prefer the native
  property; see open question 5). Also add an `aria-label` that carries the section
  name: `aria-label={`Mark all files in “${s.name}” viewed`}` (the visible text
  "Viewed" is ambiguous across N sections).
- DiffView.tsx: the file checkbox is genuinely two-state for interaction (clicking
  always re-views), but the amber "changed since viewed" middle ground should be
  announced. Keep `checked={isViewed}` and add
  `aria-label={`Viewed ${f.path}${changedSinceViewed ? ' — changed since you viewed it' : ''}`}`.
  Do *not* set indeterminate here — the `~` is not a partial-selection state, it's
  drift; mixed would mislead.

### 2b. SectionView disclosure aria-expanded

**Current:** `SectionView.tsx:43` — `{...(open ? {} : clickable(() => openSection(s.id)))}`.

**Proposed:** pass the disclosure state and a label:
`clickable(() => openSection(s.id), { expanded: false, label: `Review section: ${s.name}` })`.
(`expanded` is always `false` here because the header is only a control while closed —
when open it stops being interactive, which is fine; the attribute disappears with the
role.) One-line change; `clickable()` itself is already correct and untouched.

### 2c. SettingsDialog focus lifecycle

**Current:** no initial focus, no restore, no trap (`SettingsDialog.tsx:41-131`).

**Proposed:** mirror the ChatDrawer precedent (ChatDrawer.tsx:104-116), adapted for a
modal. Files touched: `src/renderer/components/SettingsDialog.tsx` only.

- On mount: save `document.activeElement`, then focus the first input
  (`#settings-claude`) — a settings dialog's purpose is editing, so first-field focus
  beats container focus here.
- On unmount: restore focus to the saved element (cleanup of the same `useEffect`; the
  dialog is conditionally rendered from App.tsx:50, so unmount == close for every path:
  Escape, ✕, Cancel, backdrop).
- Minimal focus trap: `onKeyDown` on `.settings-modal` — when `e.key === 'Tab'`,
  query `button, input, [tabindex="0"]` within the modal, wrap first↔last. ~10 lines,
  no dependency. (aria-modal is already set; the trap makes it true in practice.)

### 3. Approval reachability + "waiting on approval" indicator

**Current:** ApprovalCard (with its existing Approve / Deny / Stop-turn buttons) only
renders inside an open ChatDrawer viewing the streaming thread; no indicator anywhere
else; `answered` ids live in ChatDrawer local state.

**Proposed:** one shared derivation, three surfaces. No main-process changes; the
no-timeout registry is untouched.

Files touched: `src/renderer/store.ts`, `src/renderer/components/ChatDrawer.tsx`,
`src/renderer/components/GenPanel.tsx`, `src/renderer/screens/Review.tsx`,
`src/renderer/styles/app.css` (a few rules).

**Store (single source of truth).** Move answered-tracking into the store:

- Add `answeredApprovals: Set<string>` to the gen slice; reset in `startOp`
  (store.ts:942-944); add ids in `respondApproval` (store.ts:1046-1049) before the IPC
  call.
- Add a derived helper (same file, next to `genForLoaded`):
  ```ts
  export function pendingApprovals(gen: GenState): ApprovalRequest[] {
    if (!gen.running) return []
    return gen.log.flatMap((e) => e.type === 'approval_request' ? [e.request] : [])
      .filter((r) => !gen.answeredApprovals.has(r.id))
  }
  ```
- ChatDrawer.tsx:64-69 deletes its local `answered` state and uses the helper +
  `store.respondApproval` (which now also records the id).
- Note: requests park the engine (`awaitDecision`), so the log can't advance 200 events
  past a pending request and evict it from the capped log (store.ts:949) — the
  derivation is safe against the cap.

**Surface A — ChatDrawer, any chat.** Un-gate the card from `streaming`: render it
whenever `gen.running && gen.threadId != null && pendingApprovals(gen).length > 0`,
even when the active chat isn't the gen thread. When viewing a different chat, render a
compact variant instead of the full card: an amber one-liner in the same slot
(`ChatDrawer.tsx:218-226`) —

```
⚠ The review agent is waiting on an approval.   [Go to approval]
```

`Go to approval` = `store.switchChat(gen.threadId)`. (Full card only on the owning
thread, so Approve/Deny are always seen next to their context — see open question 3.)
Style: reuse `.chat-oldsession` (app.css:512-516) with amber already built in; add a
`.chat-approval-nudge` alias if a separate hook is wanted.

**Surface B — GenPanel progress strip.** In the `gen.running` branch
(GenPanel.tsx:154-179), when `pendingApprovals(gen).length > 0`:

- swap the spinner for `<I.warn>` in amber and the title to
  `Waiting on your approval…` (`.gs-title` colored `var(--amber)` via a `.gen-strip.waiting`
  modifier class: `border-color: var(--amber-line); background: var(--amber-soft);` —
  exactly the existing `.gen-strip.err` pattern at app.css:80-81, amber instead of red);
- add a `btn btn-sm` "Review request" button beside Cancel that opens the drawer on the
  gen thread: `store.openChat(gen.threadId)`.
- the elapsed counter keeps ticking (it's honest — the turn is alive, just parked).

**Surface C — header Chat button badge.** `Review.tsx:626-628`: when approvals are
pending, append an amber pill: `<span className="pill pill-amber">approval</span>`
(class exists — used at DiffView.tsx:128, SectionView.tsx:50) inside the button, and
extend the title: `title="Chat with the agent — waiting on your approval"`. This is the
one always-visible surface when the drawer is closed.

Together: a parked turn is now visually distinct from a thinking one (amber strip +
badge), and Approve/Deny is reachable in ≤2 clicks from anywhere (badge → drawer opens
on gen thread → card). Deny remains per-request; Stop turn remains the whole-turn
escape hatch. No timeout.

### 4. Chat perf: memoized messages + windowing + memoized reduces

**Current:** full `messages.map` with inline JSX; markdown re-parse per message per
render; per-event re-renders while streaming; unmemoized `reduceSegments`/
`reduceToolCalls` in ChatDrawer.tsx:54-55 and GenPanel.tsx:158.

**Proposed (lightest fix that holds at ~500 messages):**

Files touched: `src/renderer/components/ChatDrawer.tsx`,
`src/renderer/components/GenPanel.tsx`, `src/renderer/styles/app.css` (one rule).

- **Memoized per-message component.** Extract the body of the map (ChatDrawer.tsx:
  175-201) into `const ChatMessage = memo(function ChatMessage({ m, submittedRefs,
  engine, threadId, comments }: …) { … })`. Persisted message objects are stable
  identities between streams (they only change on reload), so `memo` eliminates the
  N×markdown-parse per streamed event — the dominant cost. Key stays the index (list is
  append-only). `inferSubmittedCommentRefs` (line 173) is computed in the parent and
  passed as a prop; wrap that computation in `useMemo` keyed on `active?.messages`.
- **Windowing.** Render only the last `CHAT_WINDOW = 100` messages by default. Above the
  first rendered message, show a full-width ghost button:
  `Show earlier messages (N hidden)` which decreases the window start by 100 per click
  (state: `const [shown, setShown] = useState(CHAT_WINDOW)`, reset on `activeChatId`
  change). Style: a small centered `.chat-earlier` row — `font-size:11px; color:
  var(--muted); border:1px dashed var(--line-3); border-radius:var(--r-md); padding:6px;
  cursor:pointer; background:var(--panel-2);` (matches `.chat-hint`, app.css:358).
  Scroll behavior: after prepending, keep the viewport anchored by capturing
  `scrollHeight` before and adjusting `scrollTop += (newScrollHeight - old)` in a layout
  effect — otherwise the list jumps to the top.
- **Memoize the reduces.**
  - ChatDrawer.tsx:54-55: `const { liveSegments, liveCalls } = useMemo(() => streaming
    ? { liveSegments: reduceSegments(gen.log), liveCalls: reduceToolCalls(gen.log) }
    : { liveSegments: [], liveCalls: [] }, [streaming, gen.log])`. (The log array is
    fresh per event so this still recomputes per event — bounded by the 200 cap — but
    stops recomputing on unrelated renders: draft typing, scroll state, etc.)
  - Same treatment for `liveActions` and `statusLine` (lines 58-63) and for
    GenPanel.tsx:158 (`const calls = useMemo(() => reduceToolCalls(gen.log), [gen.log])`;
    hooks must move above GenPanel's conditional returns — place it with the other hooks
    around line 128).
- **Not doing:** virtualization library; collapse-by-default for tool outputs (already
  the behavior — ToolCallLog.tsx:58, app.css:111); changing the 200-event log cap
  (verified sufficient).

Holds-at-500 rationale: 100 mounted memoized messages × no markdown re-parse per event
≈ the same per-event work as a 10-message chat today; the other 400 messages cost
nothing until explicitly revealed.

### 5. Honest "Update review" hint

**Current** (`GenPanel.tsx:320`):
> Same session. Folds the new commits into the existing review narration; your comments and viewed marks survive.

**Proposed:**
> Fresh agent pass seeded with the existing review's structure — folds the new commits into the narration. Your comments and viewed marks survive.

- "Fresh agent pass" is truthful (no engine-session resume — types.ts:7-20) and reuses
  the vocabulary of the two sibling hints (lines 309, 341: "Fresh pass…", "Fresh agent,
  new session…").
- "seeded with the existing review's structure" is exactly what `prior` carries
  (ipc.ts:378-385 → prompts.ts:58-63: title, summary, section names, sinceSha).
- "Your comments and viewed marks survive" — the true Limn-session half, kept verbatim.

One string change; no other code touched. The "Follow up" hint (line 331) keeps
"Same session." — that one is genuinely a resumed session.

---

## Test plan

Existing patterns: renderer components are tested with `renderToStaticMarkup` in vitest
(`tests/toolcall-log.test.tsx`, `tests/file-tree.test.tsx`, `tests/action-chips.test.tsx`);
store logic in plain `.ts` tests (`tests/viewed.test.ts`, `tests/section-viewed.test.ts`);
the approval registry in `tests/approvals.test.ts`. Extend those, don't invent new
harnesses. (Note: `renderToStaticMarkup` can't assert the `indeterminate` DOM property
or focus behavior — those get jsdom `render`-style tests only if we already have a DOM
test util; otherwise manual verification, flagged below.)

**Unit (new/extended)**

- `tests/diff-line-add.test.tsx` (new): DiffView line render includes a
  `limn-line-add` button with `aria-label="Comment on line N"` for a numbered line.
- `tests/section-viewed-a11y.test.tsx` (new): SectionView header markup —
  collapsed header carries `role="button"` + `aria-expanded="false"`; the section
  checkbox carries the section-name aria-label; `viewState === 'some'` renders the
  `.fv-dash`. (The `indeterminate` property itself: manual, see below.)
- `tests/toolcall-log.test.tsx` (extend): unchanged behavior — rows still collapsed by
  default after the memoization refactor (guards against regressions from extraction).
- ChatDrawer windowing (new `tests/chat-window.test.tsx`): with 250 messages, static
  markup contains the last 100 messages + "Show earlier messages (150 hidden)"; with
  ≤100, no button. (Pure render assertions — no interaction needed at this layer;
  export the window-slicing as a small pure helper `windowMessages(messages, shown)` to
  unit test the arithmetic directly.)
- Pending-approval derivation (`tests/gen-approvals-store.test.ts`, new): feed a gen
  slice with `approval_request` events + `answeredApprovals`; assert
  `pendingApprovals()` filtering, reset on `startOp`, id recorded by `respondApproval`
  (mock `window.api`).
- GenPanel copy (extend `tests/` with a static render or plain string assertion):
  the Update hint contains "Fresh agent pass" and not "Same session." on the
  update-review button.
- `tests/approvals.test.ts`: untouched (main-process registry unchanged) — run it to
  confirm.

**Manual / screenshot** (the repo's screenshot rig: `scripts/shot.sh <out.png>` wraps
`scripts/shoot.mts` seeding + `LIMN_SHOT`/`LIMN_SHOT_DELAY`/`LIMN_SHOT_QUIT` env into
`npx electron .`; needs a GUI session — cannot run headless. Hover states can't be
captured synthetically; use the existing force-show pattern: a dev/env flag or a
temporary `.dline .gutter-add { opacity:1 }` override for the shot):

1. Item 1: shot of a diff showing the subdued always-visible "+" column; second shot
   (force-active) of the hover/focus state. Keyboard check by hand: Tab reaches a line
   "+", Enter opens the composer. (Note: synthetic key events don't reach the Electron
   renderer from agent runs — keyboard verification is human-manual.)
2. Item 2a: VoiceOver pass over a file checkbox ("checkbox, checked/unchecked/mixed…")
   and Tab-focus ring on `.fv-box`. Human-manual.
3. Item 2c: open Settings, Tab-cycle stays inside, Escape returns focus to the gear
   button. Human-manual.
4. Item 3: seeded approval state — shot of (a) GenPanel amber "Waiting on your
   approval…" strip, (b) header Chat button with the amber `approval` pill, (c) drawer
   on a different chat showing the compact nudge. May need a live generation run in a
   mode that triggers approvals, or a seeded `approval_request` event in the fixture
   log (extend `scripts/shoot.mts` if the fixture path is cheaper).
5. Item 4: manual smoke with a long seeded chat (extend shoot.mts to seed ~250
   messages): scroll anchoring after "Show earlier", typing latency in the composer
   while streaming.
6. Item 5: shot of the Update-review hover hint with the new copy (hover-mounted —
   force-show via the tooltip's `show` state in a dev flag, or crop from a manual run).

---

## Open questions to resolve before implementation

1. **Item 1 — tab-stop density.** — **RESOLVED: accept natural tab order.** Every line's
   "+" is focusable (one tab stop per diff line); Tab reaches it and focus reveals it.
   Roving tabindex / j-k line nav remains an out-of-scope possible follow-up.

2. **Item 1 — rest-state visibility.** — **RESOLVED: invisible at rest (`opacity:0`,
   still `display:flex` so focusable).** NOT the subdued-visible (opacity ~.4) variant.
   Reachability via hover/focus is the goal; discoverability-at-rest is intentionally
   traded away. §1 updated to match. (This removes the "decide on the screenshot" branch.)

3. **Item 3 — full card everywhere vs. nudge + deep-link.** — **RESOLVED: nudge +
   deep-link.** The full ApprovalCard (Approve/Deny) renders only on the owning thread;
   other chats show the compact "Go to approval" nudge. Keeps the decision next to its
   requesting context.

4. **Item 3 — badge scope.** — **RESOLVED: yes, unconditional.** The header Chat button
   badges whenever approvals are pending, even with the drawer open (harmless amber,
   simpler logic).

5. **Item 2a — native `indeterminate` vs. `aria-checked="mixed"`.** — **RESOLVED: native
   `indeterminate` only** (via ref callback); no `aria-checked`.

6. **Item 4 — window size.** — **RESOLVED: 100/100 via a single `CHAT_WINDOW` const.**

7. **Item 2c — trap strictness.** — **RESOLVED: the simple ~10-line Tab-wrap trap.** No
   sentinel elements / inert background; `aria-modal` already hides the background from AT.
