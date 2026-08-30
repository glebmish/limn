# Specs

Drafts produced from the 2026-07-01 architecture/UX/feature audit. Every spec is
grounded against the code as of `d896f37` and ends with numbered open questions
(each with a recommended answer) to resolve before implementation.

## Sweeps (small fixes, one pass each)

| Spec | Scope |
| --- | --- |
| [robustness-sweep](robustness-sweep/spec.md) | busy_timeout, guarded JSON loads, DB entrypoint guard, identity property test, title/summary sync, watcher error surfacing, engine-session resume fallback, auto-accept tool allowlist, prompt delimiters, CLI version probe |
| [ux-a11y-sweep](ux-a11y-sweep/spec.md) | persistent line-comment affordance, checkbox/disclosure ARIA, approval-waiting visibility, chat windowing, honest "Update review" copy |
| [docs-sweep](docs-sweep/spec.md) | README section for the `limn` CLI, `docs/using-limn.md` for in-flow features, stale-doc flags — DONE on branch `08-docs-sweep` |

## Large changes (one spec each)

| Spec | Scope |
| --- | --- |
| [acp-migration](acp-migration/spec.md) | Replace both engine adapters with one `AcpEngine` over ACP; uniform four-tier permission semantics; single MCP tool host |
| [renderer-state-refactor](renderer-state-refactor/spec.md) | Split the 1,162-line store into slices; extract event bridge; DiffView/Review.tsx decomposition. Pure refactor |
| [comment-anchoring](comment-anchoring/spec.md) | Anchor v2 stamps + Gerrit-style diff mapping + fuzzy-context fallback; exact-text match becomes last resort |
| [scoped-update-generation](scoped-update-generation/spec.md) | Patch-shaped update turn over the since-diff for small drift; stable section ids; splice + existing validation |
| [concurrent-chat](concurrent-chat/spec.md) | Two-lane op model: read-only chat lane alongside exclusive generate/batch; renderer multi-op support |

## Later additions

| Spec | Scope |
| --- | --- |
| [merge-into-main](merge-into-main/spec.md) | Design screens 08/09 (2026-07-05): merge sheet with preflight gates (approval/base freshness, merge-tree probe, dirty-tree blocks), ff/squash/merge strategies (plumbing `commit-tree`+`update-ref` CAS when base isn't checked out), agent rebase loop for conflicts, terminal read-only merged record (keep-ref durability), "Mark merged" for external merges, full dependent-review retarget (native `rebase --onto`, abort-on-conflict). DONE 2026-07-05 on branch `10-merge-into-main` (automated coverage green; GUI smoke pending before merge to `main`) |
| [educational-review](educational-review/spec.md) | From the 2026-07-04 agentic-workflow analysis, decided + re-grounded against the stack tip (`7536961`): anchored narration blocks replace `what`/`desc`/`plainNotes`/`insight` (flat wire anchor → `FocusTarget`, stamped via comment-anchoring); diagrams typed/edged/anchored; hotspots as queueable agent comments; `contrast`/`verify`/planMap grounding; `order` → `afterSectionId` on the scoped patch; `focus`+`tour` → `point`; `get_review_progress`; one-turn-one-channel discipline. Staged: structure first, behavioral enforcement gated on post-ACP measurement |
| [browser-pivot](browser-pivot/spec.md) | 2026-08-30: drop Electron (unsignable `.app`), ship as npm `@glebmish/limn` — local Node service + browser SPA at `http://limn.localhost:5466`; dual-role `limn` CLI (`open` = client-or-server, `service serve/install/uninstall/status/logs` over launchd / systemd `--user`); `cli:open` as a one-time ticket + new tab; `npm publish` release. PWA, notifications, dir picker, update pill, Tailscale, mDNS captured as follow-ups — DONE 2026-08-30 on branch `13-browser-pivot` (automated coverage green; human GUI smoke pending) |

## Ordering and dependencies

1. **robustness-sweep** first — no dependencies, and its `busy_timeout` item is a
   prerequisite for concurrent-chat.
2. **ux-a11y-sweep** and **docs-sweep** any time. — docs-sweep DONE last, on branch
   `08-docs-sweep` (stacked on `07-concurrent-chat`): its stale-doc flags were
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
5. **concurrent-chat** last. — DONE on branch `07-concurrent-chat` (stacked on
   `06-acp-migration`); adopted acp-migration's schema-in-prompt structured output.
6. **educational-review** after the stack above merges — it rewrites `wireSection`
   (shared with scoped-update-generation's patch schema, whose splice/prompt updates
   it owns) and is re-grounded against the stack tip `7536961`; Stage 2 (behavioral
   enforcement) additionally waits on the post-ACP measurement gate.
