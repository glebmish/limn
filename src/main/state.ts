import fs from 'node:fs'
import path from 'node:path'
import type { ReviewState } from '../shared/types.js'

function slug(branch: string): string {
  return branch.replace(/[^a-zA-Z0-9._-]+/g, '-')
}

export function statePath(repo: string, branch: string): string {
  return path.join(repo, '.local-review', `review-${slug(branch)}.json`)
}

export function defaultState(repo: string, branch: string, base: string): ReviewState {
  return {
    repo, branch, base,
    comments: [], chat: [],
    viewedFiles: [], reviewedSections: [],
    iterations: [], artifacts: []
  }
}

export function loadState(repo: string, branch: string, base: string): ReviewState {
  const p = statePath(repo, branch)
  if (!fs.existsSync(p)) return defaultState(repo, branch, base)
  try {
    const st = JSON.parse(fs.readFileSync(p, 'utf8')) as ReviewState
    return { ...defaultState(repo, branch, base), ...st, repo }
  } catch {
    return defaultState(repo, branch, base)
  }
}

export function saveState(state: ReviewState): void {
  const p = statePath(state.repo, state.branch)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  const tmp = `${p}.tmp-${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2))
  fs.renameSync(tmp, p)
  ensureExcluded(state.repo)
}

export function ensureExcluded(repo: string): void {
  const excludePath = path.join(repo, '.git', 'info', 'exclude')
  try {
    fs.mkdirSync(path.dirname(excludePath), { recursive: true })
    const cur = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, 'utf8') : ''
    if (!cur.includes('.local-review/')) {
      fs.writeFileSync(excludePath, cur + (cur.endsWith('\n') || cur === '' ? '' : '\n') + '.local-review/\n')
    }
  } catch {
    // non-fatal: worst case the dir shows in git status
  }
}
