import { describe, it, expect } from 'vitest'
import {
  scopedReviewJsonSchema,
  parseScopedOutput,
  reviewWireSchema,
  type ScopedReviewPatch
} from '../src/server/engines/schema'

// Walk a JSON-schema tree collecting every node so wire-format guards can assert
// global invariants (no tuples, no open records) over the whole projection.
function walk(node: unknown, visit: (n: Record<string, unknown>) => void): void {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  if (node && typeof node === 'object') {
    const obj = node as Record<string, unknown>
    visit(obj)
    for (const v of Object.values(obj)) walk(v, visit)
  }
}

describe('scopedReviewJsonSchema wire-format guards', () => {
  it('contains no prefixItems (Claude CLI silently drops tuple schemas)', () => {
    let found = false
    walk(scopedReviewJsonSchema, (n) => {
      if ('prefixItems' in n) found = true
    })
    expect(found).toBe(false)
  })

  it('contains no open records (OpenAI strict: additionalProperties must be closed)', () => {
    let open = false
    walk(scopedReviewJsonSchema, (n) => {
      if ('additionalProperties' in n && n.additionalProperties !== false) open = true
    })
    expect(open).toBe(false)
  })
})

const validPatch = {
  title: 'Updated title',
  summary: null,
  revisedSections: [
    {
      id: 's1',
      name: 'Auth',
      narration: [{ text: 'w' }],
      files: ['src/auth.ts']
    }
  ],
  deletedSectionIds: ['s2'],
  keptSectionIds: ['s3', 's4'],
  newQuestions: [
    { id: 'q9', text: 'New question?', context: null, options: ['yes', 'no'] }
  ],
  resolvedQuestionIds: ['q1'],
  planMap: null
}

describe('parseScopedOutput', () => {
  it('round-trips a valid scoped patch', () => {
    const patch: ScopedReviewPatch = parseScopedOutput(validPatch)
    expect(patch.title).toBe('Updated title')
    expect(patch.summary).toBeNull()
    expect(patch.revisedSections).toHaveLength(1)
    expect(patch.revisedSections[0].id).toBe('s1')
    expect(patch.deletedSectionIds).toEqual(['s2'])
    expect(patch.keptSectionIds).toEqual(['s3', 's4'])
    expect(patch.newQuestions[0].id).toBe('q9')
    expect(patch.resolvedQuestionIds).toEqual(['q1'])
    expect(patch.planMap).toBeNull()
  })

  it('rejects a full-document generation output (has `sections`, lacks the scoped handshake fields)', () => {
    const fullDoc = {
      title: 't',
      summary: 's',
      sections: [
        { id: 's1', name: 'A', narration: [{ text: 'w' }], files: ['src/a.ts'] }
      ],
      planMap: null,
      questions: [],
      artifactPaths: null,
      hotspots: []
    }
    // Sanity: the full doc IS a valid full-review output...
    expect(() => reviewWireSchema.parse(fullDoc)).not.toThrow()
    // ...but must NOT be accepted as a scoped patch (drives ladder step 3's
    // "engine returned a full doc" detection).
    expect(() => parseScopedOutput(fullDoc)).toThrow()
  })

  it('rejects a patch with a missing required handshake array', () => {
    const { keptSectionIds: _omitted, ...missingKept } = validPatch
    void _omitted
    expect(() => parseScopedOutput(missingKept)).toThrow()
  })
})
