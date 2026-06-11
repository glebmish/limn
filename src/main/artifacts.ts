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

/** Heuristic detection of spec/plan markdown near the branch. */
export async function detectArtifacts(repo: string, branch: string): Promise<{ role: 'spec' | 'plan'; path: string }[]> {
  const ticket = branch.match(/[A-Z]+-\d+/)?.[0]
  const branchTail = branch.split('/').pop() ?? branch
  const seen = new Set<string>()
  const scored: Scored[] = []

  for (const rootRel of SCAN_ROOTS) {
    const root = path.join(repo, rootRel)
    if (!fs.existsSync(root)) continue
    for (const full of walk(root, root, rootRel === '.' ? MAX_DEPTH : 0)) {
      const rel = path.relative(repo, full)
      if (seen.has(rel) || seen.size > MAX_FILES) continue
      seen.add(rel)
      const name = path.basename(rel).toLowerCase()
      let score = 0
      if (/\bspec/.test(name) || /\bdesign/.test(name)) score += 2
      if (/\bplan/.test(name)) score += 2
      let head = ''
      try {
        head = fs.readFileSync(full, 'utf8').split('\n').slice(0, 50).join('\n')
      } catch {
        continue
      }
      if (head.includes(branch) || head.includes(branchTail)) score += 3
      if (ticket && head.includes(ticket)) score += 3
      if (score <= 0) continue
      const role: 'spec' | 'plan' = /\bplan/.test(name) ? 'plan' : 'spec'
      scored.push({ rel, score, role })
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
