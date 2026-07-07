/** Three-color DFS cycle check over a directed graph of string ids. This is the
 *  ONE detector both sides of the process boundary use for diagrams: main
 *  (validate.ts) warns "kept, renderer falls back to a list" based on it, and
 *  the renderer (diagramLayout.ts) decides whether it can actually draw — the
 *  two must agree or the persisted warning lies about rendering behavior.
 *  Edges naming unknown ids are ignored (callers gate integrity separately). */
export function hasCycle(ids: Iterable<string>, edges: Iterable<{ from: string; to: string }>): boolean {
  const out = new Map<string, string[]>()
  for (const id of ids) out.set(id, [])
  for (const e of edges) if (out.has(e.to)) out.get(e.from)?.push(e.to)
  const WHITE = 0, GRAY = 1, BLACK = 2
  const color = new Map<string, number>([...out.keys()].map((id) => [id, WHITE]))
  const visit = (id: string): boolean => {
    color.set(id, GRAY)
    for (const next of out.get(id) ?? []) {
      const c = color.get(next)
      if (c === GRAY) return true
      if (c === WHITE && visit(next)) return true
    }
    color.set(id, BLACK)
    return false
  }
  for (const id of out.keys()) if (color.get(id) === WHITE && visit(id)) return true
  return false
}
