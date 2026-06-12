import type { DatabaseSync } from 'node:sqlite'
import type { CompareData, RefSideInfo } from '../shared/ipc.js'
import type { RefPair, RefSide } from '../shared/types.js'
import { describeSide, getDiff, log, resolveRefInput } from './git.js'
import type { ResolvedRef } from './git.js'
import { findSession, unresolvedCount } from './db/sessions.js'

function sideInfo(resolved: ResolvedRef, context: string): RefSideInfo {
  return { kind: resolved.kind, symbol: resolved.symbol, sha: resolved.sha, context }
}

function toSide(r: ResolvedRef): RefSide {
  return { kind: r.kind, symbol: r.symbol, anchorSha: r.sha }
}

/** Resolve both sides independently, then (when both resolve and differ)
 *  compute the diff/log/context and find any existing session for the exact
 *  pair identity. Per-side resolution failures are returned as field errors;
 *  never throws for bad ref input. */
export async function buildCompareData(
  db: DatabaseSync, repo: string, baseInput: string, compareInput: string
): Promise<CompareData> {
  let base: ResolvedRef | undefined
  let compare: ResolvedRef | undefined
  let baseError: string | undefined
  let compareError: string | undefined

  try { base = await resolveRefInput(repo, baseInput) }
  catch (err) { baseError = err instanceof Error ? err.message : String(err) }
  try { compare = await resolveRefInput(repo, compareInput) }
  catch (err) { compareError = err instanceof Error ? err.message : String(err) }

  const empty: CompareData = {
    baseError, compareError,
    commits: [], files: [], add: 0, del: 0, existingSession: null
  }

  if (!base || !compare) {
    // still attach context for whichever side resolved (helps the user)
    const out = { ...empty }
    if (base) out.base = sideInfo(base, await describeSide(repo, toSide(base)))
    if (compare) out.compare = sideInfo(compare, await describeSide(repo, toSide(compare)))
    return out
  }

  if (base.sha === compare.sha) {
    return {
      ...empty,
      base: sideInfo(base, await describeSide(repo, toSide(base))),
      compare: sideInfo(compare, await describeSide(repo, toSide(compare))),
      compareError: 'base and compare point at the same commit'
    }
  }

  const baseEff = base.kind === 'branch' ? base.symbol : base.sha
  const compareEff = compare.kind === 'branch' ? compare.symbol : compare.sha
  const skeleton = await getDiff(repo, baseEff, compareEff)
  const commits = await log(repo, baseEff, compareEff)
  const add = skeleton.files.reduce((n, f) => n + f.add, 0)
  const del = skeleton.files.reduce((n, f) => n + f.del, 0)

  const pair: RefPair = { base: toSide(base), compare: toSide(compare) }
  const session = findSession(db, repo, pair)

  return {
    base: sideInfo(base, await describeSide(repo, pair.base)),
    compare: sideInfo(compare, await describeSide(repo, pair.compare)),
    commits, files: skeleton.files, add, del,
    existingSession: session ? { id: session.id, unresolved: unresolvedCount(db, session.id) } : null
  }
}
