# Design specs

Historical design records written while Limn was being built (2026-07 → 2026-09), published as-is for context. Each was accurate against the code at the commit or date it names, not against today's code; statuses, branch names, file paths and Electron-era details inside them may be stale. For how Limn works now, read [docs/](../docs/).

## Sweeps (small fixes, one pass each)

| Spec | Scope |
| --- | --- |
| [robustness-sweep](robustness-sweep/spec.md) | busy_timeout, guarded JSON loads, DB entrypoint guard, identity property test, title/summary sync, watcher error surfacing, engine-session resume fallback, auto-accept tool allowlist, prompt delimiters, CLI version probe |
| [ux-a11y-sweep](ux-a11y-sweep/spec.md) | persistent line-comment affordance, checkbox/disclosure ARIA, approval-waiting visibility, chat windowing, honest "Update review" copy |
| [docs-sweep](docs-sweep/spec.md) | README section for the `limn` CLI, `docs/using-limn.md` for in-flow features, stale-doc flags |

## Large changes (one spec each)

| Spec | Scope |
| --- | --- |
| [acp-migration](acp-migration/spec.md) | Replace both engine adapters with one `AcpEngine` over ACP; uniform four-tier permission semantics; single MCP tool host |
| [renderer-state-refactor](renderer-state-refactor/spec.md) | Split the 1,162-line store into slices; extract event bridge; DiffView/Review.tsx decomposition. Pure refactor |
| [comment-anchoring](comment-anchoring/spec.md) | Anchor v2 stamps + Gerrit-style diff mapping + fuzzy-context fallback; exact-text match becomes last resort |
| [scoped-update-generation](scoped-update-generation/spec.md) | Patch-shaped update turn over the since-diff for small drift; stable section ids; splice + existing validation |
| [concurrent-chat](concurrent-chat/spec.md) | Two-lane op model: read-only chat lane alongside exclusive generate/batch; renderer multi-op support (later replaced by one task queue per repo) |

## Later additions

| Spec | Scope |
| --- | --- |
| [merge-into-main](merge-into-main/spec.md) | Merge sheet with preflight gates (approval/base freshness, merge-tree probe, dirty-tree blocks), ff/squash/merge strategies (plumbing `commit-tree`+`update-ref` CAS when base isn't checked out), agent rebase loop for conflicts, terminal read-only merged record (keep-ref durability), "Mark merged" for external merges, full dependent-review retarget (native `rebase --onto`, abort-on-conflict) |
| [educational-review](educational-review/spec.md) | Anchored narration blocks replace `what`/`desc`/`plainNotes`/`insight` (flat wire anchor → `FocusTarget`, stamped via comment-anchoring); diagrams typed/edged/anchored; hotspots as queueable agent comments; `contrast`/`verify`/planMap grounding; `order` → `afterSectionId` on the scoped patch; `focus`+`tour` → `point`; `get_review_progress`; one-turn-one-channel discipline |
| [inplace-edits](inplace-edits/spec.md) | Edit file content directly in the review: an edit is a plain uncommitted working-tree change, saved through a line-anchored compare-and-swap; rail discard for unstaged spans; agent runs never pause editing |
| [browser-pivot](browser-pivot/spec.md) | Drop Electron and ship as npm `@glebmish/limn`: local Node service + browser SPA at `http://limn.localhost:5466`; dual-role `limn` CLI (`open` = client-or-server, `service serve/install/uninstall/status/logs` over launchd / systemd `--user`); `cli:open` as a one-time ticket + new tab; `npm publish` release |
| [browser-pivot plan](browser-pivot/plan.md) | The task-by-task implementation plan for the browser pivot |
| [agent-actions-intent](agent-actions-intent/spec.md) | Agent turns read the reviewer's intent (one framing, no blanket "do not modify"); turns are write-capable when the branch is checked out; action findings come from a second structured pass |

## Ordering and dependencies

1. **robustness-sweep** first — no dependencies, and its `busy_timeout` item is a
   prerequisite for concurrent-chat.
2. **ux-a11y-sweep** and **docs-sweep** any time. docs-sweep's stale-doc flags were
   re-grounded after robustness-sweep and acp-migration landed (`codex-app-server.md`
   was retired for `acp-adapters.md`, so its F6 flag is moot).
3. **renderer-state-refactor** before **concurrent-chat** — the ops-slice work
   there is where concurrent-chat's `ops: Record<opId, OpState>` map naturally
   lands.
4. **acp-migration**, **comment-anchoring**, and **scoped-update-generation**
   are independent of each other and of the above. One coordination point:
   acp-migration changes the structured-output strategy (schema-in-prompt), and
   scoped-update-generation adds a new wire schema — whichever lands second
   adopts the other's mechanism.
5. **concurrent-chat** last; it adopted acp-migration's schema-in-prompt structured
   output.
6. **educational-review** after the stack above — it rewrites `wireSection`
   (shared with scoped-update-generation's patch schema, whose splice/prompt updates
   it owns); Stage 2 (behavioral enforcement) additionally waits on the post-ACP
   measurement gate.
