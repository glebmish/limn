import { z } from 'zod'
import type { FixResult, ReviewAnnotations } from '../../shared/types.js'

// Wire schemas: what the engines are asked to return. No tuples — the CLI-side
// structured-output validator rejects schemas with prefixItems, so diagram nodes
// travel as objects and are mapped to the DiagramNode tuples after parsing.

const wireDiagramNode = z.object({
  label: z.string(),
  kind: z.enum(['', 'hi', 'new']),
  sub: z.string()
})

const wireSection = z.object({
  id: z.string(),
  name: z.string(),
  desc: z.string(),
  what: z.string(),
  files: z.array(z.string()),
  order: z.number(),
  diagram: z.array(wireDiagramNode).optional(),
  insight: z.object({ caption: z.string() }).optional(),
  flags: z.array(z.object({
    file: z.string(),
    hunkRange: z.string().optional(),
    risk: z.boolean(),
    label: z.string(),
    text: z.string()
  })),
  plainNotes: z.record(z.string(), z.string()).optional()
})

const wirePlanMap = z.object({
  acceptance: z.array(z.object({ text: z.string(), met: z.union([z.boolean(), z.literal('partial')]) })),
  steps: z.array(z.object({
    n: z.number(), text: z.string(), sectionId: z.string(),
    status: z.enum(['done', 'changed', 'missing'])
  })),
  deviations: z.array(z.object({ text: z.string(), sectionId: z.string() }))
})

export const reviewWireSchema = z.object({
  title: z.string(),
  summary: z.string(),
  sections: z.array(wireSection),
  planMap: wirePlanMap.optional(),
  questions: z.array(z.object({ id: z.string(), text: z.string(), context: z.string().optional() })),
  artifactPaths: z.array(z.string()).optional()
})

export const fixWireSchema = z.object({
  summary: z.string(),
  resolutions: z.array(z.object({
    commentId: z.string(),
    verdict: z.enum(['addressed', 'reworked', 'skipped']),
    note: z.string()
  }))
})

function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const js = z.toJSONSchema(schema) as Record<string, unknown>
  delete js.$schema
  return js
}

// JSON Schemas for the SDKs' structured-output options
export const reviewJsonSchema = toJsonSchema(reviewWireSchema)
export const fixJsonSchema = toJsonSchema(fixWireSchema)

export function parseReviewOutput(raw: unknown): ReviewAnnotations {
  const wire = reviewWireSchema.parse(raw)
  return {
    ...wire,
    sections: wire.sections.map((s) => ({
      ...s,
      diagram: s.diagram?.map((n) => [n.label, n.kind, n.sub] as [string, '' | 'hi' | 'new', string])
    }))
  }
}

export function parseFixOutput(raw: unknown): FixResult {
  return fixWireSchema.parse(raw)
}
