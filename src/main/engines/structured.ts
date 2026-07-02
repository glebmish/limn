// ACP has no native output-schema channel, so structured review generation
// moves to schema-in-prompt + client-side JSON extraction + one repair turn
// (spec `specs/acp-migration/spec.md` §D5). These pure helpers are shared by
// both engines: Codex still passes a native `outputSchema` to the app-server
// but reuses `parseJson` here for its extraction fallback ladder; the ACP
// engine (a later task) composes `structuredEpilogue`/`buildRepairPrompt`
// around `buildReviewPrompt`/`buildScopedUpdatePrompt` from prompts.ts.

/** Slice the first balanced `{...}` or `[...]` out of `text`, string-aware so
 *  braces inside JSON string values don't unbalance the count. Returns null
 *  if no balanced bracket run is found. */
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

/** Parse an engine's structured-output text via a 3-fallback ladder: direct
 *  `JSON.parse`, then a fenced ```json``` block, then a balanced-brace slice
 *  out of surrounding prose. Throws if none of the three yield valid JSON. */
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    // schema-constrained output occasionally arrives fenced — strip and retry
    const m = text.match(/```(?:json)?\n?([\s\S]*?)```/)
    if (m) return JSON.parse(m[1])
    const slice = jsonSlice(text)
    if (slice) return JSON.parse(slice)
    throw new Error('Engine returned non-JSON output')
  }
}

/** Schema-in-prompt epilogue appended to a review/scoped prompt for engines
 *  with no native output-schema channel. Mirrors the intent of the SDK's
 *  `outputFormat`: a single JSON object, no markdown fences, no prose. */
export function structuredEpilogue(jsonSchema: unknown): string {
  return `\nRespond with a single JSON object matching the schema below. No markdown code fences, no prose before or after — the entire response must be the JSON object itself.
<json_schema>
${JSON.stringify(jsonSchema, null, 2)}
</json_schema>`
}

/** The ONE automatic repair turn (D5 step 4): sent when the extracted JSON
 *  fails zod validation. `issues` is a formatted ZodError string supplied by
 *  the caller. */
export function buildRepairPrompt(issues: string): string {
  return `Your previous response failed schema validation:
<validation_issues>
${issues}
</validation_issues>
Reply with ONLY the corrected JSON — no fences, no prose.`
}
