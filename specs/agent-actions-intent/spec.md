# Agent turns: intent by the agent, findings by extraction

**Date:** 2026-09-13 · **Status:** approved in discussion, implementing · **Branch:** `37-action-intent` off `36-actions-triage`

## 1. Problem

Every chat message and every action run went out wrapped in the chat prompt: "answer
conversationally and concisely, this is a chat panel", "Do NOT modify any files", and
the channel policy. Action runs also carried the `add_finding` harness paragraph
unconditionally. Observed on 2026-09-12 with a pinned prompt action "Rebase onto
main": Codex refused twice, quoting Limn's own wrapper, and explained that it added no
findings because a rebase is not a review. The reviewer read both as the app fighting
them.

Underneath: the turn model assumed one intent (review the code, report findings) and
set the agent's posture per surface. A reviewer has three needs — understand the
change, judge it, shape it — and wants to express the third in their own words from a
comment, a chat, or an action.

## 2. Decisions

1. **The agent reads the intent.** One framing prompt for chat messages and action
   runs: the review context, then *read and explain by default; change files only when
   the reviewer explicitly asks for a change, and commit on the branch when you do*,
   then the existing channel policy. No "do not modify". No "answer conversationally".
   The comment batch and the rebase button keep their own prompts (`raw` turns).
2. **Nothing runs against a branch that is not checked out.** Chat, action runs and the
   batch require the compare branch to be checked out somewhere; every turn runs in
   that checkout with the engine's write-capable session mode, and the thread's
   execution mode remains the approval axis. When the branch is not checked out the
   composer and the launcher show one line — *Check out `<branch>` to chat or run
   actions* — with the workspace picker inline. The server refuses such turns too.
   Non-branch compares (a commit) stay read-only, as today.
3. **Collect findings is a property of the action.** `ActionDef.findings` (boolean;
   absent = on for skills, off for prompts). The editor shows it as a checkbox. The
   harness paragraph is gone: an action run sends the framing plus the skill spelling
   or the verbatim text, nothing else.
4. **Findings come from a second pass.** When the switch is on and the run's turn
   finished, Limn resumes the same engine session with a structured-output request —
   a JSON list of `{file, line, endLine?, severity, body, suggestion?}` or `[]` — using
   the walkthrough's parse-and-one-repair machinery. Parsed findings mint as proposals
   under the run (same sweep rules as today). A final parse failure leaves the report
   as prose; the result card says so and offers the existing manual *Attach findings*.
5. **`add_finding` stays, everywhere.** Any chat or action turn may call it; outside a
   run the proposal is sourced to a chat-scoped run id so triage can group it.
6. **One receipt.** Every finished action run ends with a card: findings (when
   collected) and the branch delta since the run started — *branch unchanged*,
   *N commits · M files*, or *uncommitted changes*. The run ref records the head at
   launch; the result records the delta. *Update review* stays on the drift banner.

## 3. Shapes

```ts
// shared/types.ts
interface ActionDef { id; kind; name; body; findings?: boolean }
interface ActionRunRef { …; findings: boolean; headAtStart?: string }
interface ActionRunResult { …; delta?: { commits: number; files: number; dirty: boolean }; extraction?: 'ok' | 'failed' | 'skipped' }
// engines/types.ts
interface ChatTurn { …; raw?: boolean }          // batch/rebase: message is the whole prompt
interface ReviewEngine { …; extractFindings(req: ExtractRequest): EngineRun<WireFinding[]> }
```

`actionFindings(a)` resolves the default. `actionPrompt(a, engine)` is the head only.

## 4. Server flow (action run)

1. `runAction`: refuse when the compare branch is not checked out; record
   `headAtStart`; sweep untouched proposals of the action; persist the launch message.
2. Turn: framing + prompt through `engine.chat` with `writeEnabled = capability.enabled`
   and the thread's mode; tools = the full Limn host (`add_finding` included).
3. If `run.findings`: status *Collecting findings…*; `engine.extractFindings` on the
   resumed session; mint proposals via the same helper `add_finding` uses; persist the
   new engine session id (Claude forks on resume). Failure → `extraction: 'failed'`.
4. Delta: `driftSummary(repo, branch, headAtStart, workdir)` → `commits/files/dirty`.
5. The ending agent message carries `runResult` with the delta and extraction state;
   the op result asks the renderer to reload.

Chat turns are step 2 only, with the same framing and gate.

## 5. Renderer

- Actions editor: *Collect findings after the run* checkbox; run bar copy says
  *collects findings* only when on; result card = receipt (§2.6) for every finished
  run, plus the triage pair when findings exist, plus *Attach findings* when
  extraction failed or was skipped and the run wrote prose.
- Launch bubble: no harness fold; the Attach follow-up is still labelled.
- Gate line (composer and launcher) as in §2.2.

## 6. Tests

Prompts (framing content, no "modify"), ipc run-action (no harness; extraction mints
under the run; `findings:false` skips it; receipt delta; not-checked-out refusal),
tools (`add_finding` outside a run), shared (`parseActions` keeps `findings`,
`actionFindings` defaults), runs-lib (receipt states), settings editor (checkbox),
launcher and thread (copy).
