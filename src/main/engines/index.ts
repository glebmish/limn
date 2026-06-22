import type { EngineId } from '../../shared/types.js'
import type { ReviewEngine } from './types.js'
import { FakeEngine } from './fake.js'
import { ClaudeEngine } from './claude.js'
import { CodexEngine } from './codex.js'

export function makeEngine(id: EngineId): ReviewEngine {
  if (process.env.LIMN_DEMO === '1') return new FakeEngine()
  return id === 'claude' ? new ClaudeEngine() : new CodexEngine()
}
