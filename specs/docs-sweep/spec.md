# Docs sweep — close the gap between shipped features and documentation

## Status: Draft — awaiting answers to open questions

## Problem

Three feature areas shipped without documentation, and two of the four deep-dive
docs contain statements the code has since invalidated:

1. **The `limn` CLI shim** (`src/main/cli.ts`, installed via the app menu) is a
   full entry point — `limn [DIR] [--base REF] [--branch BRANCH] [--new] [--hub]` —
   and appears nowhere in `README.md`. Decision already made: this **is** README
   material (it's an entry point, like `code .`).
2. **Three in-flow features are undocumented anywhere:** per-file exclusion of
   untracked files (with an invisible auto-exclusion default), multiple live
   sessions per `(base, compare)` pair via "New review" / `--new`, and the
   dirty-worktree visualization (line rails, drift-pill pencil chip, titlebar
   pencil, surface-hash approvals). Decision already made: these are **not**
   README material — they belong in `docs/` or deliberately nowhere.
3. **Stale statements** in `docs/storage-layer.md` and `docs/agent-layer.md`
   (verified against source below), plus two docs that planned work will
   invalidate: the robustness-sweep spec (`specs/robustness-sweep/` — may not
   exist yet) will touch `docs/storage-layer.md`, and the ACP-migration spec
   (`specs/acp-migration/` — may not exist yet) will retire the protocol
   `docs/codex-app-server.md` is pinned to.

All facts below were verified against the code on 2026-07-01; file/line
references point at the source of truth for each claim.

## Goals

- Add a `limn` CLI section to `README.md` with exact, code-verified flag
  semantics, in the README's existing voice.
- Create a user-facing doc for the three in-flow features (or record a
  deliberate "in-app discoverability suffices" call per feature, with
  justification — both are evaluated per feature below).
- Flag (not fix) every stale statement found in the four existing docs, and
  mark which sections the robustness-sweep and ACP-migration specs will own.

## Non-goals

- **No edits to README.md or docs/** in this spec — spec only; the drafted
  content below is the proposal for the implementation pass.
- No restructuring of the four existing deep-dive docs.
- No documentation of dev-only surfaces (`LIMN_*` env hooks are already covered
  in README "Development").
- No screenshots/media production (may be added at implementation time; see
  open question 7).

---

## Design

### 1. README: the `limn` command

**Placement.** As a new `###` subsection at the end of the existing
`## Using it` section (after the "The app watches the branch…" paragraph,
before `## Limitations`). Rationale: "Using it" is the how-do-I-drive-it
section and already owns entry-point behavior (step 1 is "Open a repository");
the CLI is a second way to do step 1–3. A top-level `##` section would
overweight it relative to its size.

**Tone match.** The README uses bolded action names, tight imperative
sentences, inline code for commands/paths, and short fenced blocks
(cf. "Install", "Using it"). The draft below follows that.

**Verified facts the section must state** (source: `src/main/cli.ts`,
`tests/cli.test.ts`, `src/main/index.ts:131`, `src/renderer/store.ts:558-568`):

- Installed from the app menu: **Limn → Install Command-Line Tool…**
  (`src/main/index.ts:131`). Installs a POSIX-sh shim to `~/.local/bin/limn`,
  falling back to `/usr/local/bin/limn`; the confirmation dialog says whether
  that directory is on `PATH` and how to add it (`installCli`,
  `src/main/cli.ts:131-168`). If the app moves, reinstall from the same menu
  item (the shim embeds the app path — header comment, `src/main/cli.ts:90`).
- Usage: `limn [DIR] [--base REF] [--branch BRANCH] [--new] [--hub]`
  (the shim's own `--help`, `src/main/cli.ts:102`).
- `DIR` is a positional first argument — any path inside the repo; it is
  resolved to the repo root (`repoRoot`, `src/main/cli.ts:71`). Defaults to the
  current directory (`src/main/cli.ts:52`, shim `pickDir`). A directory not
  inside a git repository shows an error in the app (`src/main/cli.ts:74`).
- Bare `limn` behaves like opening the repo from the Dashboard: it resumes the
  most recent live session for the current branch, else shows a transient
  draft review (`applyCliOpen`, `src/renderer/store.ts:565-567`).
- `--base REF` / `--branch BRANCH` set the base and compare side; passing
  either opens a review for that pair, resuming an existing live session for
  the exact pair if there is one (`src/renderer/store.ts:564`).
- `--new` forces a fresh review instead of resuming
  (`src/renderer/store.ts:563`; `fresh` in `src/main/ipc.ts:280`).
- `--hub` opens the repo hub (saved session list) instead of a review
  (`src/renderer/store.ts:562`).
- If the app is already running, the command forwards to the running instance
  (Electron second-instance argv; the attached `--name=value` handling in
  `parseCliArgs` exists exactly for this — `src/main/cli.ts:39-49`).

**Draft section content** (to be inserted verbatim, modulo review):

```markdown
### The `limn` command

Install it once from the app menu — **Limn → Install Command-Line Tool…** — and
open reviews straight from a terminal. The command installs to `~/.local/bin`
(or `/usr/local/bin`); the confirmation dialog tells you if that directory is
not on your `PATH`. If you move the app, reinstall from the same menu item.

```bash
limn                                 # review the current branch of the repo you're in
limn ~/code/myrepo                   # same, for another repo (any path inside it works)
limn --base main --branch feature/x  # review a specific pair
limn --new                           # start a fresh review instead of resuming
limn --hub                           # open the repo's saved-review list
```

| Flag | Meaning |
| --- | --- |
| `DIR` (positional) | A path inside the repo to review — defaults to the current directory. |
| `--base REF` | The base ref (branch, tag, SHA) — defaults to the repo's default base. |
| `--branch BRANCH` | The branch to review — defaults to the current branch. |
| `--new` | Force a fresh review rather than resuming the latest one for the pair. |
| `--hub` | Open the repo hub (every saved review) instead of a review. |

Bare `limn` behaves exactly like opening the repo from the Dashboard: it
resumes the most recent review for the current branch, or shows a draft review
if there is none. If the app is already running, the command hands the request
to the running window.
```

(Nested fence to be flattened at implementation time.)

**Deliberately omitted from the README section:** the space-vs-attached flag
forms and Chromium argv canonicalization (internal robustness detail), the
`--cli` internal marker flag, the userData fallback path on install failure
(the dialog already explains it), and dev-mode shim differences.

### 2. docs/using-limn.md — the in-flow features

**Context.** `docs/` today holds four *developer*-facing deep dives, each with
an "Audience: developers…" callout. There is no user-facing doc; README
"Using it" is the only user documentation. Extending an existing doc is
therefore wrong for user-facing feature docs — this spec proposes one new file.

**Proposed file:** `docs/using-limn.md`, titled "Using Limn — in-flow features",
with a one-line intro and an `> **Audience:** reviewers using the app…` callout
(matching the format convention of the other docs), linked from the end of
README "Using it" (see open question 5). Three sections, per-feature judgment
below.

#### 2a. Excluding untracked files — DOCUMENT (judgment: yes)

The buttons are discoverable (tooltips on the `+` / `×`), but the **auto-
exclusion default is invisible logic** that makes files appear to vanish from
a generated review — exactly the kind of behavior a doc must state. Verified
facts the section must state:

- Exclusion applies **only to untracked working-tree files**; tracked files can
  never be excluded (guard in `toggleExcluded`, `src/renderer/store.ts:865`;
  `FileDiff.untracked` contract, `src/shared/types.ts:32-35`).
- **Default rule:** in a *narrated* review (annotations exist), an untracked
  file not covered by any section (an "orphan") is auto-excluded; in a flat
  (not-yet-generated) review nothing is auto-excluded
  (`fileEffectivelyExcluded`, `src/shared/types.ts:18-28`).
- Excluded files leave their section and collect in a compact, collapsed
  **"Untracked"** group below the main diff (`UntrackedGroup`,
  `src/renderer/components/UntrackedGroup.tsx`; rendered from
  `src/renderer/screens/Review.tsx:317-321,915`). Each row expands in place to
  peek its diff and has an **Include** (`+`) button.
- An *included* untracked file shows a `×` in its file header to send it back
  to Untracked (`src/renderer/components/DiffView.tsx:156-166`).
- **Excluded files carry no review state:** no Viewed checkbox
  (`DiffView.tsx:144-145`), no section membership, and the group's open/closed
  state intentionally resets on every load (`UntrackedGroup.tsx:18-20`).
- Include/exclude overrides **persist per session** (`excluded_files` table,
  migration v6, `src/main/db/migrations.ts:187-203`); an explicit include (an
  `excluded = 0` row) overrides the auto-exclusion default. The first exclude
  toggle on a draft review mints the session (`persistExcluded`,
  `src/renderer/store.ts:405-408`).

#### 2b. Multiple reviews per branch ("New review") — DOCUMENT (judgment: yes)

The *button* is discoverable; the **resume semantics are not** — "which review
opens when I open this repo?" is invisible-state behavior. Verified facts:

- Opening a repo/pair **resumes the most-recently-touched live session** for
  the exact `(base identity, compare identity)` (`findSession`,
  `src/main/db/sessions.ts:147-156`; `src/main/ipc.ts:280`).
- Multiple live sessions may share one pair — **"New review"** in the repo hub
  creates another live session **without archiving or overwriting** the old one
  (`docs/storage-layer.md` "Session identity" already states this for
  developers; DAO comment `src/main/db/sessions.ts:148-150`).
- The hub's "New review" is a split control: the button starts a fresh review
  on the current branch; the caret opens a base ← compare picker
  (`NewReviewSplit`, `src/renderer/screens/RepoHub.tsx:69-109`).
- `limn --new` does the same from the CLI (cross-link the README section).
- Older sessions stay listed in the hub (most-recently-touched first) and can
  be resumed, archived (soft-delete: hidden from live lists and resume hints),
  and restored (`src/main/db/sessions.ts:158-163`, `archiveSession`).

#### 2c. Dirty-worktree visualization — DOCUMENT THE MODEL ONLY (judgment: partial)

The glyphs themselves are **self-documenting in-app**: the diff header shows an
"i" markers-key popover explaining the three per-line left-edge rails —
committed (solid grey), staged (solid amber), unstaged (dotted amber)
(`MarkersKey`, `src/renderer/screens/Review.tsx:92-107`, shown whenever the
tree is dirty, line 166), and the drift-pill chips carry tooltips. Re-stating
the legend in a doc would duplicate UI that already explains itself and rot
when the design moves. **However, the underlying model is non-obvious** and is
worth four sentences. Verified facts the section must state:

- When the working tree is dirty, the review shows the **merged
  base → working-tree diff** (committed + uncommitted in one view), with the
  rails distinguishing origin per line (`src/renderer/screens/Review.tsx:189-192`).
- The **titlebar drift pill** (branch moved while you read) distinguishes, on
  hover, a commit chip (commit-circle icon + count) from an uncommitted-edits
  chip (pencil icon), plus the combined ±delta; click reloads
  (`DriftFetchPill`, `src/renderer/screens/Review.tsx:52-90`).
- The **commit timeline** in the titlebar adds a pencil to the HEAD stop when
  the loaded tree is dirty, and its tooltip shows the uncommitted ±counts
  (`src/renderer/screens/Review.tsx:393,408,417`).
- **Approval is per surface:** a dirty tree is a different approved "surface"
  than its commit — approving a clean commit and then editing shows
  "Committed changes approved" + a "new uncommitted changes" nudge until the
  dirty surface is approved too (`dirtyNeedsApproval`,
  `src/renderer/screens/Review.tsx:350,546-561`; surface-hash approvals,
  `session_approvals` in `docs/storage-layer.md`).
- What the doc must **not** claim: that the agent can apply comments to a dirty
  tree — batch write requires a clean tree and now *errors* rather than
  degrading (see flag F4 below).

### 3. Stale-statement flags in the four existing docs (flag, don't fix)

**F1 — `docs/storage-layer.md` "Schema" intro (line 46):** "One migration (v1)
creates the whole schema." Stale — there are **six** migrations
(`src/main/db/migrations.ts`): v2 (chat message segments), v3/v4
(`session_approvals` + surface-hash re-key), v5 (`comment_refs_json`), v6
(`excluded_files`).

**F2 — `docs/storage-layer.md` entity graph + table list (lines 50-84):**
omit **`chat_threads`** (created in v1, `migrations.ts:60` — the graph draws
`sessions → chat_messages` directly) and **`excluded_files`** (v6,
`migrations.ts:195`). The cascade-delete enumeration (line 61) is likewise
missing both.

**F3 — `docs/storage-layer.md` `chat_messages` row (line 72):** column
description predates v2's segments column and v5's `comment_refs_json`.

**F4 — `docs/agent-layer.md` batch flow step 1 (line 185) and the "Write
degradation, not failure" invariant (line 200):** both claim an unmet batch
precondition "runs write-disabled … instead of failing". Stale —
`ipc.sendBatch` now **throws** `Agent edits are unavailable because …`
(dirty tree / branch not checked out / non-writable compare) for non-refine
turns; only `refine` turns run read-only (`src/main/ipc.ts:637-647`).

**F5 — `docs/architecture.md`:** no stale statements found this round. Minor
optional gap: the main-process file list (lines 23-27) omits `cli.ts` even
though the Transport section mentions `cli:open`; harmless.

**F6 — `docs/codex-app-server.md`:** accurate as pinned (verified 0.139.0,
provenance section present). **Do not invest in updates**: the ACP-migration
spec (`specs/acp-migration/` — referenced by name; may not exist yet) will
replace the app-server protocol client this doc describes. When that spec
lands, this doc gets a deprecation banner or is retired with the code.

**Ownership note:** the robustness-sweep spec (`specs/robustness-sweep/` —
may not exist yet) will touch `docs/storage-layer.md` (connection resilience /
transaction-model sections). F1–F3 are outside those sections and cheap to fix
in this sweep (open question 4); anything inside sections that spec rewrites
should be left to it. F4's section belongs to no planned spec.

---

## Verification

How to check the shipped docs match behavior, at implementation time:

1. **CLI section — run every documented form.** `npm run package`, install the
   shim via the menu, then from a scratch git repo run: `limn --help` (usage
   line matches the doc), bare `limn`, `limn <dir>` from outside the repo,
   `limn --base <ref> --branch <ref>`, `limn --new` (a second live session
   appears in the hub), `limn --hub`, and `limn` from a non-git directory
   (error surfaces in-app). Repeat one flagged form with the app already
   running (second-instance forwarding). Cross-check the flag table against
   `tests/cli.test.ts` — every documented behavior has a matching test case.
2. **Exclusion.** In a repo with an untracked file: before generation, the file
   is in the diff (no auto-exclusion); after `LIMN_DEMO=1` generation, an
   orphan untracked file sits in the collapsed Untracked group; Include lifts
   it (gains a Viewed checkbox), `×` returns it; reload the session and confirm
   the override persisted (`sqlite3` the dev DB: `SELECT * FROM excluded_files`).
   Confirm a tracked file's header has no `×`.
3. **Sessions.** Hub → "New review" twice on the same pair → two live rows;
   quit/reopen → default open resumes the newest; archive it → default open
   resumes the older one.
4. **Dirty worktree.** Dirty a file: rails + "i" legend appear, timeline pencil
   + tooltip counts appear; commit from a terminal while a review is open with
   further uncommitted edits → drift pill shows both chips on hover. Confirm
   the approve control shows the two-stage dirty-approval state after approving
   the commit only. (Needs a live GUI session; screenshots via
   `scripts/shot.sh`.)
5. **Stale-flag accuracy.** For each F1–F4, confirm the doc line still says
   what the flag claims (grep the quoted phrase) and the cited source line
   still contradicts it — flags rot too.

## Open questions to resolve before implementation

1. **README placement** — H3 under "Using it" vs a top-level "## Command line"
   section? **Recommended:** H3 `### The limn command` at the end of
   "Using it" — the CLI is a second door into the same flow, not a new topic.
2. **One doc or per-feature calls?** Create `docs/using-limn.md` with all three
   sections, vs documenting only 2a/2b and skipping 2c entirely? **Recommended:**
   one doc, three sections, with 2c held to the model-only scope above — the
   marginal cost is four sentences and it gives the two must-document features
   a natural home.
3. **Audience framing of the new doc** — the four existing docs are
   developer-facing with "Audience" callouts; a user-facing doc breaks that
   uniformity. Keep the callout convention with
   `> **Audience:** reviewers using the app`, or drop the callout?
   **Recommended:** keep the callout — format consistency across `docs/`
   matters more than audience uniformity.
4. **Fix F1–F4 in this sweep, or only flag?** The group decision was
   flag-don't-fix, but F1–F3 are one-line factual errors in sections no planned
   spec owns, and F4 actively misleads (claims a failure mode that no longer
   exists). **Recommended:** fix F1–F4 in this sweep's implementation pass;
   leave everything the robustness-sweep/ACP-migration specs will rewrite;
   leave F5/F6 untouched.
5. **README → new doc link?** Add one line at the end of "Using it" ("More
   in-flow details — excluding untracked files, multiple reviews per branch,
   dirty-worktree review: docs/using-limn.md")? **Recommended:** yes — an
   unlinked doc is undiscoverable, and README already links the four deep
   dives from "Development".
6. **Does the README CLI section mention that both `--base main` and
   `--base=main` work?** **Recommended:** no — both forms work (shim
   normalizes; `parseCliArgs` accepts both) but it's standard CLI behavior and
   the usage line stays cleaner without it.
7. **Screenshots in `docs/using-limn.md`?** The README leans on media; the
   deep dives use none. **Recommended:** ship text-only first (screenshots need
   a live GUI session and add media-weight); revisit if the doc reads poorly.
