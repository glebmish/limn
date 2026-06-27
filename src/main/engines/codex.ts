import type { ReviewAnnotations } from '../../shared/types.js'
import { type ChatTurn, type EngineRun, type ReviewEngine, type ReviewRequest } from './types.js'
import { parseReviewOutput, reviewJsonSchema } from './schema.js'
import { buildReviewPrompt } from './prompts.js'
import { chatViaAppServer, runAppServerTurn } from './codexAppServer.js'

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    // schema-constrained output occasionally arrives fenced — strip and retry
    const m = text.match(/```(?:json)?\n?([\s\S]*?)```/)
    if (m) return JSON.parse(m[1])
    throw new Error('Codex returned non-JSON output')
  }
}

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

  chat(turn: ChatTurn): EngineRun<string> {
    return chatViaAppServer(turn)
  }
}
