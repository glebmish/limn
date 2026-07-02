import type { ReviewAnnotations } from '../../shared/types.js'
import { type ChatTurn, type EngineRun, type ReviewEngine, type ReviewRequest, type ScopedUpdateRequest } from './types.js'
import { parseReviewOutput, parseScopedOutput, reviewJsonSchema, scopedReviewJsonSchema, type ScopedReviewPatch } from './schema.js'
import { buildReviewPrompt, buildScopedUpdatePrompt } from './prompts.js'
import { chatViaAppServer, runAppServerTurn } from './codexAppServer.js'
import { parseJson } from './structured.js'
// Re-exported for callers/tests that historically imported the JSON extractor
// from this module — the implementation now lives in structured.ts, shared
// with the ACP engine (spec `specs/acp-migration/spec.md` §D5).
export { parseJson }

export class CodexEngine implements ReviewEngine {
  id = 'codex' as const

  generateReview(req: ReviewRequest): EngineRun<ReviewAnnotations> {
    const run = runAppServerTurn({
      repo: req.repo,
      prompt: buildReviewPrompt(req),
      model: req.model,
      reasoningEffort: req.reasoningEffort,
      writeEnabled: true,
      executionMode: 'edits',
      outputSchema: reviewJsonSchema,
      streamText: false,
      status: 'Starting Codex…'
    })
    return {
      events: run.events,
      result: run.result.then(({ value, sessionId }) => ({
        value: parseReviewOutput(parseJson(value)),
        sessionId
      })),
      cancel: run.cancel
    }
  }

  generateScopedUpdate(req: ScopedUpdateRequest): EngineRun<ScopedReviewPatch> {
    // Structured-output turn (like generateReview) plus resume via engineSessionId:
    // thread/resume + outputSchema compose on the one turn. The resumed thread
    // already holds the prior exploration; when absent it starts a fresh
    // (self-contained) thread. A resume failure rejects; the caller retries fresh.
    // READ-ONLY: the scoped patch only reads the since-diff and emits a JSON review
    // patch — no file writes. Omitting writeEnabled/executionMode defaults to the
    // 'ask' tier → read-only sandbox (matches Claude's READ_TOOLS scoped turn). The
    // read-only sandbox restricts writes, not reads, so file reads + git log/show
    // exploration still work.
    const run = runAppServerTurn({
      repo: req.repo,
      prompt: buildScopedUpdatePrompt(req),
      engineSessionId: req.priorEngineSessionId,
      model: req.model,
      reasoningEffort: req.reasoningEffort,
      writeEnabled: false,
      outputSchema: scopedReviewJsonSchema,
      streamText: false,
      status: 'Updating the review…'
    })
    return {
      events: run.events,
      result: run.result.then(({ value, sessionId }) => ({
        value: parseScopedOutput(parseJson(value)),
        sessionId
      })),
      cancel: run.cancel
    }
  }

  chat(turn: ChatTurn): EngineRun<string> {
    return chatViaAppServer(turn)
  }
}
