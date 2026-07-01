# Specs

Drafts produced from the 2026-07-01 architecture/UX/feature audit. Every spec is
grounded against the code as of `d896f37` and ends with numbered open questions
(each with a recommended answer) to resolve before implementation.

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
| [concurrent-chat](concurrent-chat/spec.md) | Two-lane op model: read-only chat lane alongside exclusive generate/batch; renderer multi-op support |

## Ordering and dependencies

1. **robustness-sweep** first — no dependencies, and its `busy_timeout` item is a
   prerequisite for concurrent-chat.
2. **ux-a11y-sweep** and **docs-sweep** any time (docs-sweep's stale-doc flags
   for `storage-layer.md` / `codex-app-server.md` should be re-checked after
   robustness-sweep and acp-migration land).
3. **renderer-state-refactor** before **concurrent-chat** — the ops-slice work
   there is where concurrent-chat's `ops: Record<opId, OpState>` map naturally
   lands.
4. **acp-migration**, **comment-anchoring**, and **scoped-update-generation**
   are independent of each other and of the above. One coordination point:
   acp-migration changes the structured-output strategy (schema-in-prompt), and
   scoped-update-generation adds a new wire schema — whichever lands second
   adopts the other's mechanism.
5. **concurrent-chat** last.
