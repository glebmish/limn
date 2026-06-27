# README media TODO

Goal: produce a compact README demo set that shows Limn's core loop without turning the README into a gallery.

## Final asset set

- [ ] `docs/media/hero-review-question.png`
  - Clean guided-review still, preferably without the chat drawer.
  - Must show the generated summary, queued comments, the "Agent needs decision" card, section/file spine, and approve/follow-up/regenerate controls.

- [ ] `docs/media/generate-guided-review.gif`
  - Show raw changed files, agent/model selection, "Generate guided review", brief tool activity, and the final grouped sections + summary.

- [ ] `docs/media/review-questions.gif`
  - Show the dynamic review question card, choosing or typing an answer, "Send answers to the agent", progress, and the resolved/updated review state.

- [ ] `docs/media/chat-tools.gif`
  - Show a chat follow-up where tool rows stream inline.
  - Include `grep`, `read`, and ideally `bash`; expand one tool row so the result is visible before the final answer.

- [ ] `docs/media/spec-plan-review.png`
  - Clean still of the rendered plan/spec view.
  - Must show divergence, document-line comments, and plan/spec approval.

- [ ] `docs/media/git-drift-tracking.png`
  - Still showing branch freshness: drift/fetch pill, changed-since-viewed or changed-since-approval indicators, and the update-review affordance.

## README order

1. Hero still: guided review with dynamic question.
2. GIF: raw diff to guided review.
3. GIF: dynamic review questions.
4. GIF: chat with dynamic tools.
5. Still: spec/plan intent review.
6. Still: git drift/freshness tracking.

## Demoted surfaces

Do not spend main README space on these unless the README grows a secondary tour section:

- dashboard / repo hub
- session archive
- worktree picker
- execution mode menu
- standalone agent picker
- approval prompt

## Exploration captures

Temporary captures from the initial exploration were written to `/tmp/limn-readme-shots`:

- `/tmp/limn-readme-shots/raw-diff-before.png`
- `/tmp/limn-readme-shots/review.png`
- `/tmp/limn-readme-shots/chat-tools.png`
- `/tmp/limn-readme-shots/plan-doc-clean.png`
- `/tmp/limn-readme-shots/session-hub.png`

These are useful references, but they are not final README assets.
