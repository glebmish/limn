// ACP has no native output-schema channel, so structured review generation is
// schema-in-prompt + client-side JSON extraction + one automatic repair turn
// (spec `specs/acp-migration/spec.md` §D5). These pure helpers serve exactly one
// consumer, the ACP engine (`acp.ts`): it appends `structuredEpilogue` to the
// review/scoped prompts from prompts.ts, extracts the payload with `parseJson`,
// and sends `buildRepairPrompt` as the single repair turn when validation fails.

/** From `start` (an opening `{` or `[`), find the index of the bracket that
 *  balances it, string-aware so braces inside JSON string values don't
 *  unbalance the count. Returns -1 when the run never balances. */
function matchBalanced(text: string, start: number): number {
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
    else if (ch === close && --depth === 0) return i
  }
  return -1
}

/** Every top-level balanced `{...}` / `[...]` run in `text`, in order. An
 *  opener that never balances is skipped (scan resumes just past it) so a
 *  stray brace in prose can't hide a later complete payload. */
function jsonSlices(text: string): string[] {
  const slices: string[] = []
  let from = 0
  while (from < text.length) {
    const rel = text.slice(from).search(/[[{]/)
    if (rel < 0) break
    const start = from + rel
    const end = matchBalanced(text, start)
    if (end < 0) { from = start + 1; continue }
    slices.push(text.slice(start, end + 1))
    from = end + 1
  }
  return slices
}

/** Parse an engine's structured-output text via a 3-fallback ladder: direct
 *  `JSON.parse`, then a fenced ```json``` block, then a balanced-brace slice
 *  out of surrounding prose — trying the LAST slice first, because the payload
 *  trails any preamble and a preamble may itself contain a balanced fragment
 *  ("I'll produce {...} first. Here it is: {...}"). Throws if nothing yields
 *  valid JSON. */
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    // schema-constrained output occasionally arrives fenced — strip and retry. The
    // regex takes the FIRST fence, which need not be the payload (a ```bash preamble;
    // a payload whose own string content holds a ``` fence, cut short mid-string), so
    // a parse failure here falls THROUGH to the brace-slice rung instead of throwing
    // the rest of the ladder away.
    const m = text.match(/```(?:json)?\n?([\s\S]*?)```/)
    if (m) {
      try { return JSON.parse(m[1]) } catch { /* not the payload — the slice rung may still find it */ }
    }
    const slices = jsonSlices(text)
    for (let i = slices.length - 1; i >= 0; i--) {
      try { return JSON.parse(slices[i]) } catch { /* an earlier slice may parse */ }
    }
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
