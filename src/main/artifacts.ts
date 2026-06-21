import fs from 'node:fs'
import path from 'node:path'
import type { Artifact, ArtifactFormat } from '../shared/types.js'

export interface ArtifactRef { role: 'spec' | 'plan'; format: ArtifactFormat; path: string }

const SCAN_ROOTS = ['docs', 'specs']
const MAX_FILES = 400
const MAX_DEPTH = 4

/** Recognized spec/plan formats. Classification is purely by path convention:
 *  a markdown file is an artifact iff one of these matchers claims it. Each
 *  matcher returns the role it assigns, or null when the path doesn't conform.
 *  Adding a format is one entry. */
const FORMATS: { id: ArtifactFormat; match: (rel: string) => 'spec' | 'plan' | null }[] = [
  {
    id: 'superpowers',
    match: (rel) => {
      if (/(^|\/)docs\/superpowers\/specs\/[^/]+\.md$/.test(rel)) return 'spec'
      if (/(^|\/)docs\/superpowers\/plans\/[^/]+\.md$/.test(rel)) return 'plan'
      return null
    }
  },
  {
    id: 'sdd',
    match: (rel) => {
      if (/(^|\/)specs\/[^/]+\/spec\.md$/.test(rel)) return 'spec'
      if (/(^|\/)specs\/[^/]+\/(plan|tasks)\.md$/.test(rel)) return 'plan'
      return null
    }
  }
]

/** The single classifier: does this path match a known format's convention?
 *  Returns the assigned role and the detected format, or null. First match wins. */
export function classify(rel: string): { role: 'spec' | 'plan'; format: ArtifactFormat } | null {
  const norm = rel.split(path.sep).join('/')
  for (const f of FORMATS) {
    const role = f.match(norm)
    if (role) return { role, format: f.id }
  }
  return null
}

function* walk(dir: string, depth: number): Generator<string> {
  if (depth > MAX_DEPTH) return
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git') continue
    const full = path.join(dir, e.name)
    if (e.isDirectory()) yield* walk(full, depth + 1)
    else if (e.isFile() && e.name.endsWith('.md')) yield full
  }
}

/** Narrow, format-aware detection. Classification is by path convention only
 *  (see FORMATS); the heuristics here decide *selection* — which recognized
 *  artifacts belong to this review. Anything in the branch diff is surfaced;
 *  only when nothing recognized is in the diff do we fall back to the best
 *  per-role guess by a light relevance score (branch/ticket mention, newest). */
export async function detectArtifacts(repo: string, branch: string, changedPaths: string[] = []): Promise<ArtifactRef[]> {
  const ticket = branch.match(/[A-Z]+-\d+/)?.[0]
  const branchTail = branch.split('/').pop() ?? branch
  const changed = new Set(changedPaths)
  const seen = new Set<string>()
  const matched: { ref: ArtifactRef; inDiff: boolean; score: number }[] = []

  const consider = (rel: string): void => {
    if (seen.has(rel) || seen.size > MAX_FILES) return
    seen.add(rel)
    const hit = classify(rel)
    if (!hit) return
    const inDiff = changed.has(rel)
    let score = inDiff ? 6 : 0
    // light relevance signal, only used to break ties in the no-diff fallback
    try {
      const head = fs.readFileSync(path.join(repo, rel), 'utf8').split('\n').slice(0, 50).join('\n')
      if (head.includes(branch) || head.includes(branchTail)) score += 3
      if (ticket && head.includes(ticket)) score += 3
    } catch {
      return
    }
    matched.push({ ref: { role: hit.role, format: hit.format, path: rel }, inDiff, score })
  }

  // branch-diff markdown first — the artifact written for this change
  for (const p of changedPaths) {
    if (p.endsWith('.md')) consider(p)
  }
  for (const rootRel of SCAN_ROOTS) {
    const root = path.join(repo, rootRel)
    if (!fs.existsSync(root)) continue
    for (const full of walk(root, 0)) consider(path.relative(repo, full))
  }

  // A branch can bundle several features, each with its own spec/plan. When any
  // recognized artifact is part of the diff, surface ALL of them (newest first)
  // rather than collapsing to one per role. Only when nothing recognized is in
  // the diff do we fall back to the single best-per-role guess.
  const inDiff = matched.filter((m) => m.inDiff).sort((a, b) => byScoreThenPath(a, b))
  if (inDiff.length > 0) return inDiff.map((m) => m.ref)

  const out: ArtifactRef[] = []
  for (const role of ['spec', 'plan'] as const) {
    const best = matched.filter((m) => m.ref.role === role).sort((a, b) => byScoreThenPath(a, b))[0]
    if (best) out.push(best.ref)
  }
  return out
}

// higher score first; ties broken by path descending so newer date-stamped files win
function byScoreThenPath(a: { ref: ArtifactRef; score: number }, b: { ref: ArtifactRef; score: number }): number {
  return b.score - a.score || b.ref.path.localeCompare(a.ref.path)
}

export function loadArtifact(repo: string, rel: string, role: 'spec' | 'plan' | 'doc'): Artifact {
  const raw = fs.readFileSync(path.join(repo, rel), 'utf8')
  const lines = raw.split('\n')
  const heading = lines.find((l) => l.startsWith('# '))
  // format is a pure function of the path — re-derive it rather than storing it
  const format = classify(rel)?.format ?? 'superpowers'
  return { role, format, path: rel, title: heading ? heading.slice(2).trim() : path.basename(rel), lines }
}
