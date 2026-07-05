import { useEffect, useState, type ReactNode } from 'react'
import type {
  DependentReview, MergeExecuteRequest, MergeGate, MergeGateId, MergePreflight, MergeStrategy
} from '../../shared/types'
import type { LoadedReview } from '../../shared/ipc'
import { anyExclusiveRunning, useStore } from '../store'
import { api } from '../lib/api'
import { usePopover } from '../lib/usePopover'
import { I, shortSha } from '../kit'

/** Strategy preselection (spec resolution 6): the remembered per-repo choice while it
 *  is still available, else squash (agent-authored commit piles are the norm), else
 *  merge, else fast-forward. */
export function pickStrategy(
  remembered: MergeStrategy | undefined,
  strategies: Record<MergeStrategy, boolean>
): MergeStrategy {
  if (remembered && strategies[remembered]) return remembered
  if (strategies.squash) return 'squash'
  if (strategies.merge) return 'merge'
  return 'ff'
}

/** CTA label follows the strategy (design board 1 footer). */
export function ctaLabel(strategy: MergeStrategy, base: string): string {
  return strategy === 'ff' ? `Fast-forward ${base}`
    : strategy === 'squash' ? 'Squash & merge'
    : `Merge into ${base}`
}

/** The strategy option's sub-label (design boards C1/G2): the static description when
 *  available, else the reason it isn't — a disabled control must carry its reason.
 *  ff is unavailable when the base diverged; squash/merge are unavailable exactly when
 *  the conflict probe tripped (see `strategyAvailability` in src/main/merge.ts). */
export function strategySubLabel(
  s: MergeStrategy, strategies: Record<MergeStrategy, boolean>, base: string
): string {
  if (strategies[s]) {
    return s === 'ff' ? 'History exactly as reviewed'
      : s === 'squash' ? 'Flatten the branch' : 'Keeps the branch shape'
  }
  return s === 'ff' ? `Not possible — ${base} diverged` : 'Not possible — merging would conflict'
}

/** Red gates always block; amber gates block until explicitly acked ("Merge anyway");
 *  info gates never block. Mirrors main's `mergeOk` so the CTA and the authoritative
 *  re-check agree. */
export function mergeBlocked(gates: MergeGate[], acked: ReadonlySet<MergeGateId>): boolean {
  return gates.some((g) => g.severity === 'red' || (g.severity === 'amber' && !acked.has(g.id)))
}

/** Dependents that keep the merged branch alive: not selected for retarget, or not
 *  rebasable. While any exist, branch deletion is refused (spec §4 step 5). */
export function deleteBranchBlockers(
  dependents: DependentReview[],
  retarget: ReadonlySet<number>
): DependentReview[] {
  return dependents.filter((d) => !d.rebasable || !retarget.has(d.sessionId))
}

/** The one-line reason beside a disabled CTA (design boards G1/C1; spec resolution 7). */
export function gateFooterNote(
  gates: MergeGate[],
  acked: ReadonlySet<MergeGateId>,
  busy: boolean
): string | null {
  if (busy) return 'Waiting for the running iteration.'
  if (gates.some((g) => g.id === 'conflicts')) return 'Gated until the probe is clean.'
  if (gates.some((g) => g.id === 'base-site-dirty' || g.id === 'branch-dirty')) return 'Gated until the worktree is clean.'
  if (gates.some((g) => g.id === 'stale-approval' && !acked.has('stale-approval'))) return 'Gated until approval covers HEAD.'
  if (gates.some((g) => g.id === 'base-moved' && !acked.has('base-moved'))) return 'Gated until the branch is rebased — or merge anyway.'
  return null
}

/** Callbacks the sheet raises; the container (and Task 14's wiring) provides them. */
export interface MergeSheetActions {
  onClose(): void
  /** re-run `mergePreflight` (dirty-tree gates, after the user cleans up outside). */
  onRecheck(): void
  /** "Review the N commits" — switch the diff baseline to Since approved and close. */
  onReviewCommits(): void
  /** "Rebase onto <base> — with agent" / "Resolve with agent" (same turn, spec §6). */
  onRebaseWithAgent(): void
  onExecute(req: MergeExecuteRequest): void
}

const SEV_RANK: Record<MergeGate['severity'], number> = { red: 0, amber: 1, info: 2 }

/** design-style checkbox row (button with role=checkbox so SSR/tests see the state). */
function Chk({ on, disabled, detect, sub, onToggle, children }: {
  on: boolean; disabled?: boolean; detect?: boolean
  sub?: ReactNode; onToggle(): void; children: ReactNode
}) {
  return (
    <button type="button" role="checkbox" aria-checked={on} disabled={disabled}
      className={'msh-chk' + (on ? '' : ' off') + (detect ? ' detect' : '')} onClick={onToggle}>
      <span className="cb"><I.check style={{ width: 9, height: 9 }} /></span>
      <span className="ch-t">{children}{sub != null && <span className="ch-sub">{sub}</span>}</span>
    </button>
  )
}

/** One tripped gate: the severity band (detail verbatim from main), the conflict file
 *  list when present, and the gate's action row (design boards G1/G2/G3/C1). */
function GateBand({ gate, base, probeClean, acked, onAck, actions, copyCmd }: {
  gate: MergeGate; base: string; probeClean: boolean; acked: boolean
  onAck(): void; actions: MergeSheetActions; copyCmd: string
}) {
  const cls = gate.severity === 'red' ? ' bad' : gate.severity === 'info' ? ' info' : ''
  const hasActs = gate.id !== 'probe-unavailable'
  return (
    <div className="msh-gate-wrap">
      <div className={'msh-gate' + cls}>
        <span className="mg-ic">
          {gate.severity === 'info'
            ? <I.info style={{ width: 11, height: 11 }} />
            : <I.warn style={{ width: 11, height: 11 }} />}
        </span>
        <span className="mg-t">{gate.detail}{acked ? ' Merging anyway — recorded as an override.' : ''}</span>
      </div>
      {gate.id === 'conflicts' && (gate.files?.length ?? 0) > 0 && (
        <div className="msh-cfiles">
          {gate.files?.map((f) => (
            <div key={f} className="msh-cfile">{f}<span className="cf-pill">conflict</span></div>
          ))}
        </div>
      )}
      {hasActs && (
        <div className="msh-acts">
          {gate.id === 'stale-approval' && (
            <>
              <button className="btn btn-sm" onClick={actions.onReviewCommits}>
                Review the {gate.commits ?? 0} commit{gate.commits === 1 ? '' : 's'}
              </button>
              {!acked && <button className="btn btn-sm btn-ghost" onClick={onAck}>Merge anyway</button>}
            </>
          )}
          {gate.id === 'base-moved' && (
            <>
              <button className="btn btn-sm" onClick={actions.onRebaseWithAgent}>
                <I.changed style={{ width: 12, height: 12 }} />Rebase onto {base} — with agent
              </button>
              {/* "Merge anyway" only offered while the conflict probe is clean (spec §5) */}
              {probeClean && !acked && <button className="btn btn-sm btn-ghost" onClick={onAck}>Merge anyway</button>}
            </>
          )}
          {gate.id === 'conflicts' && (
            <>
              <button className="btn btn-sm btn-primary" onClick={actions.onRebaseWithAgent}>
                <I.changed style={{ width: 12, height: 12 }} />Resolve with agent
              </button>
              <button className="btn btn-sm btn-ghost" onClick={() =>
                void navigator.clipboard.writeText(copyCmd)}>Copy git commands</button>
            </>
          )}
          {(gate.id === 'base-site-dirty' || gate.id === 'branch-dirty') && (
            <button className="btn btn-sm" onClick={actions.onRecheck}>
              <I.changed style={{ width: 12, height: 12 }} />Re-check
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/** The sheet body — pure render over a MergePreflight + component-local selections.
 *  All state (strategy, message, checkboxes, acked overrides) lives here; nothing
 *  touches the store until the execute succeeds (spec §5). */
export function MergeSheetPanel({ pf, repo, busy, executing, initialStrategy, actions }: {
  pf: MergePreflight
  repo: string
  busy: boolean       // anyExclusiveRunning — CTA disables with the waiting note
  executing: boolean
  initialStrategy: MergeStrategy
  actions: MergeSheetActions
}) {
  const [strategy, setStrategy] = useState<MergeStrategy>(initialStrategy)
  const [message, setMessage] = useState(pf.draftMessage)
  const [acked, setAcked] = useState<ReadonlySet<MergeGateId>>(new Set())
  const [archive, setArchive] = useState(true)          // default ON (spec resolution 3)
  const [deleteBranch, setDeleteBranch] = useState(true)
  const [removeWorktree, setRemoveWorktree] = useState(true)
  const [retarget, setRetarget] = useState<ReadonlySet<number>>(
    () => new Set(pf.cleanup.dependents.filter((d) => d.rebasable).map((d) => d.sessionId))
  )

  const n = pf.counts.commits
  const base = pf.baseSymbol
  const probeClean = !pf.gates.some((g) => g.id === 'conflicts')
  const blockers = deleteBranchBlockers(pf.cleanup.dependents, retarget)
  const note = executing ? null : gateFooterNote(pf.gates, acked, busy)
  const disabled = mergeBlocked(pf.gates, acked) || busy || executing
  const copyCmd = 'git -C ' + (pf.cleanup.worktreePath ?? repo) + ' rebase ' + base

  const toggleRetarget = (id: number): void => {
    const next = new Set(retarget)
    if (next.has(id)) next.delete(id); else next.add(id)
    setRetarget(next)
  }
  const execute = (): void => actions.onExecute({
    strategy,
    message: strategy === 'ff' ? undefined : message,
    overrides: [...acked],
    cleanup: {
      archiveSession: archive,
      deleteBranch: deleteBranch && blockers.length === 0,
      removeWorktree: Boolean(pf.cleanup.worktreePath) && removeWorktree,
      retarget: [...retarget],
    },
    expect: { baseHead: pf.baseHead, tipSha: pf.tipSha },
  })

  return (
    <div className="msh" role="dialog" aria-label={`Merge ${pf.branch} into ${base}`}>
      <div className="msh-head">
        <span className="msh-hico"><I.merge style={{ width: 14, height: 14 }} /></span>
        <span>
          <span className="msh-ht">Merge <span className="mono">{pf.branch}</span> into <span className="mono">{base}</span></span>
          <span className="msh-hsub">
            {n} commit{n === 1 ? '' : 's'} · {pf.counts.files} files · +{pf.counts.add} / −{pf.counts.del} · approved at {shortSha(pf.tipSha)}
          </span>
        </span>
        <button className="msh-x" title="Close" aria-label="Close" onClick={actions.onClose}>×</button>
      </div>

      <div className="msh-sec">
        {pf.gates.length === 0 ? (
          <div className="msh-gate good">
            <span className="mg-ic"><I.check style={{ width: 11, height: 11 }} /></span>
            <span className="mg-t"><b>Clear to merge.</b> No gates tripped.</span>
          </div>
        ) : (
          [...pf.gates]
            .sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity])
            .map((g) => (
              <GateBand key={g.id} gate={g} base={base} probeClean={probeClean}
                acked={acked.has(g.id)} onAck={() => setAcked(new Set([...acked, g.id]))}
                actions={actions} copyCmd={copyCmd} />
            ))
        )}
      </div>

      <div className="msh-sec">
        <div className="msh-lab">How it merges</div>
        <div className="msh-strat">
          {(['ff', 'squash', 'merge'] as const).map((s) => (
            <button key={s} type="button" disabled={!pf.strategies[s]}
              className={'msh-opt' + (strategy === s ? ' on' : '')} aria-pressed={strategy === s}
              onClick={() => setStrategy(s)}>
              <span className="mo-t">{s === 'ff' ? 'Fast-forward' : s === 'squash' ? 'Squash' : 'Merge commit'}</span>
              <span className="mo-d">{strategySubLabel(s, pf.strategies, base)}</span>
            </button>
          ))}
        </div>
        <div className="msh-hint">
          {strategy === 'ff'
            ? <><span className="mono">{base}</span> moves to <span className="mono">{shortSha(pf.tipSha)}</span> — the {n} commits you reviewed apply unchanged; no new commit is created.</>
            : strategy === 'squash'
              ? <>The {n} branch commits become <b>one commit on {base}</b>. Message drafted from the review — edit freely.</>
              : <>A merge commit joins the branch to <span className="mono">{base}</span>, keeping all {n} commits reachable.</>}
        </div>
        {strategy === 'ff' ? (
          <div className="msh-clist">
            {pf.commits.map((c, i) => (
              <div key={c.sha} className="msh-crow">
                <span className="cr-sha">{shortSha(c.sha)}</span>
                <span className="cr-msg">{c.subject}</span>
                {i === 0 && <span className="cr-tag">tip</span>}
              </div>
            ))}
          </div>
        ) : (
          <>
            <textarea className="msh-msg" spellCheck={false} aria-label="Merge commit message"
              value={message} onChange={(e) => setMessage(e.target.value)} />
            <div className="msh-msg-meta">
              <I.edit style={{ width: 11, height: 11 }} />Drafted from the review summary — click to edit.
            </div>
          </>
        )}
      </div>

      <div className="msh-sec">
        <div className="msh-lab">After the merge</div>
        <Chk on={archive} onToggle={() => setArchive(!archive)}>Archive this review session</Chk>
        <Chk on={deleteBranch && blockers.length === 0} disabled={blockers.length > 0}
          onToggle={() => setDeleteBranch(!deleteBranch)}
          sub={blockers.length > 0
            ? `kept — ${blockers.map((d) => d.branch).join(', ')} still base${blockers.length === 1 ? 's' : ''} on it`
            : undefined}>
          Delete <span className="mono">{pf.branch}</span>
        </Chk>
        {pf.cleanup.worktreePath && (
          <Chk on={removeWorktree} onToggle={() => setRemoveWorktree(!removeWorktree)}>
            Remove worktree <span className="mono">{pf.cleanup.worktreePath}</span>
          </Chk>
        )}
        {pf.cleanup.dependents.map((d) => (
          <Chk key={d.sessionId} detect on={retarget.has(d.sessionId)} disabled={!d.rebasable}
            onToggle={() => toggleRetarget(d.sessionId)}
            sub={d.rebasable
              ? <><span className="mono">{d.branch}</span> is stacked on this branch. Repoint its base to <span className="mono">{base}</span> and rebase its {d.commits} commit{d.commits === 1 ? '' : 's'} — comes back as amber drift to skim.</>
              : <><span className="mono">{d.branch}</span> can’t retarget — {d.blockedReason ?? 'unavailable'}</>}>
            <span className="ch-hd"><I.changed style={{ width: 12, height: 12 }} />Retarget dependent review</span>
          </Chk>
        ))}
      </div>

      <div className="msh-foot">
        <button className="msh-cta" disabled={disabled} onClick={execute}
          title={disabled && note ? note : undefined}>
          {executing
            ? <span className="gen-spinner"></span>
            : <I.merge style={{ width: 13, height: 13 }} />}
          {ctaLabel(strategy, base)}
        </button>
        {note && <span className="msh-local">{note}</span>}
      </div>
    </div>
  )
}

/** Contract component: fetches the preflight when opened (read-only, callable anytime
 *  — spec §3), then renders the panel. Selections are panel-local; the `key` resets
 *  them whenever the CAS expectations change (a re-check found a different world). */
export function MergeSheet({ open, onClose }: { open: boolean; onClose(): void }) {
  const store = useStore()
  const busy = anyExclusiveRunning(store.ops)
  const repo = store.loaded?.state.repo ?? ''
  const [pf, setPf] = useState<MergePreflight | null>(null)
  const [error, setError] = useState<string | null>(null)

  const fetchPreflight = async (): Promise<void> => {
    setError(null)
    const id = await useStore.getState().materialize()  // transient review mints its session here
    if (id == null) return
    try {
      setPf(await api().mergePreflight(id))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  useEffect(() => {
    if (open) { setPf(null); void fetchPreflight() }
  }, [open])

  if (!open) return null
  if (error) {
    return (
      <div className="msh">
        <div className="msh-sec">
          <div className="msh-gate bad">
            <span className="mg-ic"><I.warn style={{ width: 11, height: 11 }} /></span>
            <span className="mg-t">{error}</span>
          </div>
          <div className="msh-acts">
            <button className="btn btn-sm" onClick={() => void fetchPreflight()}>
              <I.changed style={{ width: 12, height: 12 }} />Re-check
            </button>
          </div>
        </div>
      </div>
    )
  }
  if (!pf) {
    return (
      <div className="msh">
        <div className="msh-sec msh-loading"><span className="gen-spinner"></span>Running preflight…</div>
      </div>
    )
  }

  const actions: MergeSheetActions = {
    onClose,
    onRecheck: () => void fetchPreflight(),
    onReviewCommits: () => { useStore.getState().setGlobalDiffMode('approved'); onClose() },
    onRebaseWithAgent: () => onClose(),   // Task 14 prepends store.sendRebase()
    onExecute: () => undefined,           // Task 14 wires api().mergeExecute
  }
  return (
    <MergeSheetPanel key={pf.baseHead + ':' + pf.tipSha}
      pf={pf} repo={repo} busy={busy} executing={false}
      initialStrategy={pickStrategy(undefined, pf.strategies)} actions={actions} />
  )
}

/** The verdict-row trigger + its anchored sheet. Hidden unless both sides are
 *  branches (S9 — merges land branches on branches) and the session isn't merged;
 *  a branch that already landed outside Limn offers "Mark merged…" instead (S12).
 *  Trigger and popover live together so usePopover owns both refs (DriftCommits idiom). */
export function MergeButton({ loaded }: { loaded: LoadedReview }) {
  const pop = usePopover<HTMLButtonElement, HTMLDivElement>({ side: 'bottom', align: 'end', gap: 8 })
  const pair = loaded.session.pair
  if (pair.base.kind !== 'branch' || pair.compare.kind !== 'branch') return null
  if (loaded.state.merged) return null   // terminal — the verdict button takes over
  const base = pair.base.symbol
  const external = Boolean(loaded.mergedExternally)
  return (
    <>
      <button className="btn btn-sm rv-land" ref={pop.anchorRef} aria-expanded={pop.open}
        onClick={pop.toggle}
        title={external
          ? `${pair.compare.symbol} already landed on ${base} — record the merge`
          : `Preflight and merge this branch into ${base} — local only, nothing is pushed`}>
        <I.merge style={{ width: 13, height: 13 }} />
        {external ? 'Mark merged…' : `Merge into ${base}…`}
      </button>
      {pop.open && (
        <div className="msh-pop" ref={pop.floatingRef} style={pop.popStyle}>
          <MergeSheet open onClose={pop.close} />
        </div>
      )}
    </>
  )
}
