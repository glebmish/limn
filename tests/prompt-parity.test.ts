import { describe, it, expect } from 'vitest'
import { buildReviewPrompt } from '../src/server/engines/prompts'
import { reviewJsonSchema } from '../src/server/engines/schema'
import type { ReviewRequest } from '../src/server/engines/types'

// The `plainNotes` lesson: a schema field the prompt never argues for goes dead —
// the model omits it and nothing catches the drift. This test locks prompt↔schema
// parity: every property name reachable in reviewJsonSchema must appear in
// buildReviewPrompt's output as a QUOTED literal ("name" — quotes required, a
// bare-word mention does not count).

const fakeReq: ReviewRequest = {
  repo: '/tmp/repo', branch: 'feat/x', base: 'main', artifacts: [],
  diff: { base: 'main', branch: 'feat/x', mergeBase: 'a'.repeat(40), headSha: 'b'.repeat(40), files: [] }
}

/** Walk a JSON schema collecting every property name under any `properties`
 *  map, recursing through items/anyOf/allOf/oneOf/additionalProperties. */
function collectPropertyNames(node: unknown, out: Set<string>): void {
  if (Array.isArray(node)) {
    for (const n of node) collectPropertyNames(n, out)
    return
  }
  if (node === null || typeof node !== 'object') return
  const obj = node as Record<string, unknown>
  const props = obj.properties
  if (props && typeof props === 'object' && !Array.isArray(props)) {
    for (const [key, sub] of Object.entries(props as Record<string, unknown>)) {
      out.add(key)
      collectPropertyNames(sub, out)
    }
  }
  for (const k of ['items', 'prefixItems', 'anyOf', 'allOf', 'oneOf', 'additionalProperties']) {
    if (obj[k] !== undefined) collectPropertyNames(obj[k], out)
  }
}

describe('prompt↔schema parity (quoted literals)', () => {
  const names = new Set<string>()
  collectPropertyNames(reviewJsonSchema, names)

  it('the walker actually reaches the nested v2 fields (guards a vacuous pass)', () => {
    for (const expected of [
      'title', 'summary', 'sections', 'narration', 'text', 'anchor', 'endLine',
      'diagram', 'why', 'caption', 'nodes', 'edges', 'from', 'to',
      'contrast', 'was', 'now',
      'planMap', 'acceptance', 'met', 'source', 'path',
      'hotspots', 'severity', 'questions', 'artifactPaths'
    ]) {
      expect(names, `walker missed "${expected}"`).toContain(expected)
    }
  })

  it('every schema property name appears as a quoted literal in buildReviewPrompt', () => {
    const prompt = buildReviewPrompt(fakeReq)
    const missing = [...names].filter((n) => !prompt.includes(`"${n}"`)).sort()
    expect(missing).toEqual([])
  })

  it('a bare-word mention would not count — the check requires the quotes', () => {
    // Sanity on the mechanism itself: the word "hotspots" bare is not enough.
    const bare = 'risks go in hotspots at the exact spot'
    expect(bare.includes('hotspots')).toBe(true)
    expect(bare.includes('"hotspots"')).toBe(false)
  })
})
