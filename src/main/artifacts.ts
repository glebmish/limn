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

/** Repository-relative artifact paths only. Agent-reported paths are untrusted:
 *  reject absolute paths, dot segments, and Windows drive prefixes before any
 *  path.join/path.resolve touches the filesystem. */
export function normalizeArtifactPath(rel: string): string | null {
  const norm = rel.replace(/\\/g, '/').trim()
  if (!norm || norm.startsWith('/') || /^[A-Za-z]:/.test(norm)) return null
  const parts = norm.split('/')
  if (parts.some((p) => !p || p === '.' || p === '..')) return null
  return norm
}

/** The single classifier: does this path match a known format's convention?
 *  Returns the assigned role and the detected format, or null. First match wins. */
export function classify(rel: string): { role: 'spec' | 'plan'; format: ArtifactFormat } | null {
  const norm = normalizeArtifactPath(rel)
  if (!norm) return null
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
  const changed = new Set(changedPaths.map((p) => normalizeArtifactPath(p)).filter((p): p is string => Boolean(p)))
  const seen = new Set<string>()
  const matched: { ref: ArtifactRef; inDiff: boolean; score: number }[] = []

  const consider = (rel: string): void => {
    const norm = normalizeArtifactPath(rel)
    if (!norm || seen.has(norm) || seen.size > MAX_FILES) return
    seen.add(norm)
    const hit = classify(norm)
    if (!hit) return
    const inDiff = changed.has(norm)
    let score = inDiff ? 6 : 0
    // light relevance signal, only used to break ties in the no-diff fallback
    try {
      const head = fs.readFileSync(path.join(repo, norm), 'utf8').split('\n').slice(0, 50).join('\n')
      if (head.includes(branch) || head.includes(branchTail)) score += 3
      if (ticket && head.includes(ticket)) score += 3
    } catch {
      return
    }
    matched.push({ ref: { role: hit.role, format: hit.format, path: norm }, inDiff, score })
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
  const norm = normalizeArtifactPath(rel)
  if (!norm) throw new Error(`unsafe artifact path: ${rel}`)
  const root = fs.realpathSync(repo)
  const full = path.resolve(root, norm)
  const real = fs.realpathSync(full)
  if (real !== root && !real.startsWith(root + path.sep)) {
    throw new Error(`artifact path escapes repository: ${rel}`)
  }
  const raw = fs.readFileSync(real, 'utf8')
  const lines = raw.split('\n')
  const heading = lines.find((l) => l.startsWith('# '))
  // format is a pure function of the path — re-derive it rather than storing it
  const format = classify(norm)?.format ?? 'superpowers'
  return { role, format, path: norm, title: heading ? heading.slice(2).trim() : path.basename(norm), lines }
}
