import fs from 'node:fs'
import path from 'node:path'
import type { Artifact } from '../shared/types.js'

interface Scored { rel: string; score: number; role: 'spec' | 'plan' }

const SCAN_ROOTS = ['docs', '.claude', '.']
const MAX_FILES = 200
const MAX_DEPTH = 3

function* walk(root: string, dir: string, depth: number): Generator<string> {
  if (depth > MAX_DEPTH) return
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === '.local-review') continue
    const full = path.join(dir, e.name)
    if (e.isDirectory()) yield* walk(root, full, depth + 1)
    else if (e.isFile() && e.name.endsWith('.md')) yield full
  }
}

/** Heuristic detection of spec/plan markdown near the branch.
 *  Strongest signal: a spec/plan .md that is part of the branch diff itself —
 *  the artifact most likely written for this change. Conventional locations
 *  (docs/specs, docs/plans, docs/superpowers, .claude/) and branch/ticket
 *  mentions rank next. */
export async function detectArtifacts(repo: string, branch: string, changedPaths: string[] = []): Promise<{ role: 'spec' | 'plan'; path: string }[]> {
  const ticket = branch.match(/[A-Z]+-\d+/)?.[0]
  const branchTail = branch.split('/').pop() ?? branch
  const changed = new Set(changedPaths)
  const seen = new Set<string>()
  const scored: Scored[] = []

  const scoreFile = (rel: string): void => {
    if (seen.has(rel) || seen.size > MAX_FILES) return
    seen.add(rel)
    const name = path.basename(rel).toLowerCase()
    const relLower = rel.toLowerCase()
    let score = 0
    if (changed.has(rel)) score += 6
    if (/\bspec/.test(name) || /\bdesign/.test(name)) score += 2
    if (/\bplan/.test(name)) score += 2
    if (/(^|\/)(docs\/(specs|plans|superpowers)|\.claude)\//.test(relLower)) score += 1
    let head = ''
    try {
      head = fs.readFileSync(path.join(repo, rel), 'utf8').split('\n').slice(0, 50).join('\n')
    } catch {
      return
    }
    if (head.includes(branch) || head.includes(branchTail)) score += 3
    if (ticket && head.includes(ticket)) score += 3
    if (score <= 0) return
    const role: 'spec' | 'plan' = /\bplan/.test(name) ? 'plan' : 'spec'
    scored.push({ rel, score, role })
  }

  // branch-diff markdown first — the artifact written for this change
  for (const p of changedPaths) {
    if (p.endsWith('.md')) scoreFile(p)
  }
  for (const rootRel of SCAN_ROOTS) {
    const root = path.join(repo, rootRel)
    if (!fs.existsSync(root)) continue
    for (const full of walk(root, root, rootRel === '.' ? MAX_DEPTH : 0)) {
      scoreFile(path.relative(repo, full))
    }
  }

  const out: { role: 'spec' | 'plan'; path: string }[] = []
  for (const role of ['spec', 'plan'] as const) {
    const best = scored.filter((s) => s.role === role).sort((a, b) => b.score - a.score)[0]
    if (best) out.push({ role, path: best.rel })
  }
  return out
}

export function loadArtifact(repo: string, rel: string, role: 'spec' | 'plan' | 'doc'): Artifact {
  const raw = fs.readFileSync(path.join(repo, rel), 'utf8')
  const lines = raw.split('\n')
  const heading = lines.find((l) => l.startsWith('# '))
  return { role, path: rel, title: heading ? heading.slice(2).trim() : path.basename(rel), lines }
}
