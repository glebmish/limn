import type { Diagram, DiagramNode2 } from '../../shared/types'

/** Two-tier "chain-plus-branches" layout for a Diagram (spec A2, Decision 5).
 *  A simple linear chain lays out as one ordered row. A single fan-out node
 *  (out-degree > 1) puts its targets on a second "branch" row below the main
 *  chain leading up to it. Anything the two tiers can't draw — a cycle, a
 *  node with more than one incoming edge (fan-in), more than one fan-out
 *  point, or a branch target that itself fans further out — reports
 *  `ok:false` so the caller falls back to a flat node-list + edge-list
 *  rendering. Never throws; never produces a false chain. */
export function layoutDiagram(d: Diagram): { rows: DiagramNode2[][]; ok: boolean } {
  const byId = new Map(d.nodes.map((n) => [n.id, n]))
  const ids = d.nodes.map((n) => n.id)
  // defensive: only consider edges between known node ids (the integrity gate
  // should already have dropped the rest, but this helper must never crash).
  const edges = d.edges.filter((e) => byId.has(e.from) && byId.has(e.to))

  const outMap = new Map<string, string[]>()
  const inDegree = new Map<string, number>()
  for (const id of ids) { outMap.set(id, []); inDegree.set(id, 0) }
  for (const e of edges) {
    outMap.get(e.from)!.push(e.to)
    inDegree.set(e.to, (inDegree.get(e.to) ?? 0) + 1)
  }

  if (hasCycle(ids, outMap)) return { rows: [], ok: false }
  if (ids.some((id) => (inDegree.get(id) ?? 0) > 1)) return { rows: [], ok: false }

  const fanoutNodes = ids.filter((id) => (outMap.get(id) ?? []).length > 1)
  if (fanoutNodes.length > 1) return { rows: [], ok: false }

  if (fanoutNodes.length === 0) {
    // a forest of simple chains (out-degree/in-degree <= 1 everywhere) — one row.
    const visited = new Set<string>()
    const row: DiagramNode2[] = []
    for (const id of ids) {
      if (visited.has(id) || (inDegree.get(id) ?? 0) > 0) continue
      let cur: string | undefined = id
      while (cur && !visited.has(cur)) {
        visited.add(cur)
        row.push(byId.get(cur)!)
        cur = outMap.get(cur)?.[0]
      }
    }
    // any node not reached above (shouldn't happen for an acyclic graph with
    // in-degree <= 1, but stay defensive) is appended in array order.
    for (const id of ids) if (!visited.has(id)) { visited.add(id); row.push(byId.get(id)!) }
    return { rows: [row], ok: true }
  }

  const [fanout] = fanoutNodes
  const branchTargets = outMap.get(fanout) ?? []
  // a branch target that itself fans further out is a third tier — unsupported.
  if (branchTargets.some((t) => (outMap.get(t) ?? []).length > 0)) return { rows: [], ok: false }

  // main row: the chain leading up to (and including) the fan-out node. Walk
  // backward to find the chain's start, using the single predecessor each
  // node has (in-degree <= 1 was already checked above).
  const predecessor = new Map<string, string>()
  for (const e of edges) predecessor.set(e.to, e.from)
  const chainToFanout: string[] = [fanout]
  let p = predecessor.get(fanout)
  while (p && !chainToFanout.includes(p)) { chainToFanout.unshift(p); p = predecessor.get(p) }

  const mainRow: DiagramNode2[] = []
  const visited = new Set<string>()
  for (const id of chainToFanout) { mainRow.push(byId.get(id)!); visited.add(id) }

  const branchRow: DiagramNode2[] = branchTargets.map((t) => byId.get(t)!)
  for (const t of branchTargets) visited.add(t)

  // any leftover nodes (disconnected from the fan-out chain/branches) — best
  // effort: append as their own row rather than silently dropping them.
  const leftover = ids.filter((id) => !visited.has(id)).map((id) => byId.get(id)!)
  const rows = leftover.length > 0 ? [mainRow, branchRow, leftover] : [mainRow, branchRow]
  return { rows, ok: true }
}

function hasCycle(ids: string[], outMap: Map<string, string[]>): boolean {
  const WHITE = 0, GRAY = 1, BLACK = 2
  const color = new Map<string, number>(ids.map((id) => [id, WHITE]))
  const stack: string[] = []
  const visit = (id: string): boolean => {
    color.set(id, GRAY)
    stack.push(id)
    for (const next of outMap.get(id) ?? []) {
      const c = color.get(next)
      if (c === GRAY) return true
      if (c === WHITE && visit(next)) return true
    }
    stack.pop()
    color.set(id, BLACK)
    return false
  }
  for (const id of ids) if (color.get(id) === WHITE && visit(id)) return true
  return false
}
