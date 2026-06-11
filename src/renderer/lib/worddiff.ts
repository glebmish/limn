import type { DiffLine } from '../../shared/types'

export interface CharRange { start: number; len: number }

interface Token { text: string; start: number }

function tokenize(s: string): Token[] {
  const out: Token[] = []
  const re = /[A-Za-z0-9_]+|\s+|[^A-Za-z0-9_\s]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(s))) out.push({ text: m[0], start: m.index })
  return out
}

const MAX_TOKENS = 300

/** Character ranges that differ between a paired old/new line (LCS on tokens).
 *  Returns empty ranges when the lines share too little — full-line coloring
 *  reads better than marking everything. */
export function wordDiffRanges(oldText: string, newText: string): { old: CharRange[]; new: CharRange[] } {
  const a = tokenize(oldText)
  const b = tokenize(newText)
  if (a.length > MAX_TOKENS || b.length > MAX_TOKENS) return { old: [], new: [] }

  // LCS table over tokens
  const n = a.length
  const m = b.length
  const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i].text === b[j].text ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const inLcsA = new Array<boolean>(n).fill(false)
  const inLcsB = new Array<boolean>(m).fill(false)
  let i = 0
  let j = 0
  let common = 0
  while (i < n && j < m) {
    if (a[i].text === b[j].text) {
      inLcsA[i] = true
      inLcsB[j] = true
      common++
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i++
    else j++
  }

  // too little in common → unrelated lines, no word marks
  const significant = (t: Token[]): number => t.filter((x) => x.text.trim()).length
  const sig = Math.max(significant(a), significant(b))
  if (sig > 0 && common / Math.max(a.length, b.length) < 0.5) return { old: [], new: [] }

  const ranges = (tokens: Token[], inLcs: boolean[]): CharRange[] => {
    const out: CharRange[] = []
    for (let k = 0; k < tokens.length; k++) {
      if (inLcs[k] || !tokens[k].text.trim()) continue // skip whitespace-only marks
      const start = tokens[k].start
      const len = tokens[k].text.length
      const last = out[out.length - 1]
      if (last && last.start + last.len >= start) last.len = start + len - last.start
      else out.push({ start, len })
    }
    return out
  }
  return { old: ranges(a, inLcsA), new: ranges(b, inLcsB) }
}

/** Pair consecutive del-run/add-run lines in a hunk index-wise (GitHub-style).
 *  Returns map of del-line index → add-line index within the given array. */
export function pairHunkLines(lines: DiffLine[]): Map<number, number> {
  const pairs = new Map<number, number>()
  let k = 0
  while (k < lines.length) {
    if (lines[k].kind !== 'del') {
      k++
      continue
    }
    const delStart = k
    while (k < lines.length && lines[k].kind === 'del') k++
    const addStart = k
    while (k < lines.length && lines[k].kind === 'add') k++
    const delCount = addStart - delStart
    const addCount = k - addStart
    for (let p = 0; p < Math.min(delCount, addCount); p++) {
      pairs.set(delStart + p, addStart + p)
    }
  }
  return pairs
}
