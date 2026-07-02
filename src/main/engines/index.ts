import type { EngineId } from '../../shared/types.js'
import type { ReviewEngine } from './types.js'
import { FakeEngine } from './fake.js'
import { AcpEngine } from './acp.js'
import { CLAUDE_ACP_CONFIG } from './adapters.js'
import { CodexEngine } from './codex.js'

export function makeEngine(id: EngineId): ReviewEngine {
  if (process.env.LIMN_DEMO === '1') return new FakeEngine(id)
  return id === 'claude' ? new AcpEngine(CLAUDE_ACP_CONFIG) : new CodexEngine()
}
