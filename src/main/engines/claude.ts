import type { Comment, CommentAnchor, FixResult, ReviewAnnotations } from '../../shared/types.js'
import type { EngineRun, ReviewEngine, ReviewRequest } from './types.js'

// Implemented in Task 11.
export class ClaudeEngine implements ReviewEngine {
  id = 'claude' as const
  generateReview(_req: ReviewRequest): EngineRun<ReviewAnnotations> {
    throw new Error('Claude engine not implemented yet')
  }
  chat(_repo: string, _sessionId: string, _message: string, _anchor?: CommentAnchor): EngineRun<string> {
    throw new Error('Claude engine not implemented yet')
  }
  applyFeedback(_repo: string, _sessionId: string, _comments: Comment[], _steer?: string): EngineRun<FixResult> {
    throw new Error('Claude engine not implemented yet')
  }
}
