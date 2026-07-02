import type { ReviewAnnotations } from '../../shared/types.js'
import { type ChatTurn, type EngineRun, type ReviewEngine, type ReviewRequest, type ScopedUpdateRequest } from './types.js'
import { parseReviewOutput, parseScopedOutput, reviewJsonSchema, scopedReviewJsonSchema, type ScopedReviewPatch } from './schema.js'
import { buildReviewPrompt, buildScopedUpdatePrompt } from './prompts.js'
import { chatViaAppServer, runAppServerTurn } from './codexAppServer.js'

function jsonSlice(text: string): string | null {
  const start = text.search(/[[{]/)
  if (start < 0) return null
  const open = text[start]
  const close = open === '{' ? '}' : ']'
  let depth = 0
  let inString = false
  let esc = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') { inString = true; continue }
    if (ch === open) depth++
    else if (ch === close && --depth === 0) return text.slice(start, i + 1)
  }
  return null
}

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    // schema-constrained output occasionally arrives fenced — strip and retry
    const m = text.match(/```(?:json)?\n?([\s\S]*?)```/)
    if (m) return JSON.parse(m[1])
    const slice = jsonSlice(text)
    if (slice) return JSON.parse(slice)
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

  generateScopedUpdate(req: ScopedUpdateRequest): EngineRun<ScopedReviewPatch> {
    // Same lifecycle as generateReview (structured output), plus resume via
    // engineSessionId: thread/resume + outputSchema compose on the one turn. The
    // resumed thread already holds the prior exploration; when absent it starts a
    // fresh (self-contained) thread. A resume failure rejects; the caller retries fresh.
    const run = runAppServerTurn({
      repo: req.repo,
      prompt: buildScopedUpdatePrompt(req),
      engineSessionId: req.priorEngineSessionId,
      model: req.model,
      reasoningEffort: req.reasoningEffort,
      writeEnabled: true,
      executionMode: 'edits',
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
