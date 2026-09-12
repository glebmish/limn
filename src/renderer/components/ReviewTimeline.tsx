import { Fragment } from 'react'
import type { LoadedReview } from '../../shared/ipc'
import type { DriftSummary } from '../../shared/types'
import type { TimelineGroup } from '../lib/reviewTimeline'
import { I, shortSha, ago } from '../kit'
import { Tooltip } from './Tooltip'
import { DriftFetchPill, WatchPausedPill } from './DriftFetchPill'

/** The titlebar commit-timeline (`ctmark`): the off-history mark, the branch-start pin,
 *  the per-commit arrows + role stops (generated / approved / HEAD, working-tree dirty),
 *  then the drift fetch pill / watch-paused pill. Every value is derived in the Review
 *  orchestrator and handed down so this renders today's exact markup. */
export function ReviewTimeline({
  loaded,
  base,
  approved,
  generatedSha,
  generatedShaInTimeline,
  generatedOffTimeline,
  timelineGroups,
  dirtyAdd,
  dirtyDel,
  pendingDrift,
  watchStopped,
  onReload,
  fakeDriftOpen
}: {
  loaded: LoadedReview
  base: string
  approved: boolean
  generatedSha: string | undefined
  generatedShaInTimeline: boolean
  generatedOffTimeline: boolean
  timelineGroups: TimelineGroup[]
  dirtyAdd: number
  dirtyDel: number
  pendingDrift: DriftSummary | null
  watchStopped: { reason: string } | null
  onReload: () => void
  fakeDriftOpen: boolean
}) {
  const { skeleton, commits } = loaded
  const timelineTitle = (sha: string, labels: string[]): string => {
    const c = commits.find((item) => item.sha === sha)
    return [
      labels.join(' · '),
      shortSha(sha),
      c?.date ? ago(c.date) : null,
      c?.subject ?? null
    ].filter(Boolean).join(' · ')
  }
  // tooltip body for a timeline mark — wrapped by <Tooltip> which positions the
  // `.cm-tip` bubble on-screen (it flips below the bar instead of clipping off the
  // top, and clamps to the viewport instead of spilling left/right).
  const timelineTipContent = (sha: string, labels: string[]) => {
    const c = commits.find((item) => item.sha === sha)
    return (
      <>
        <span className="l1">
          <span className="lead">{labels.join(' · ')}</span>
          <span className="sep">·</span>
          <span className="sha">{shortSha(sha)}</span>
          {c?.date ? <><span className="sep">·</span>{ago(c.date)}</> : null}
        </span>
        {c?.subject ? <span className="l2">{c.subject}</span> : null}
      </>
    )
  }

  const renderTimelineStop = (group: TimelineGroup) => {
    const hasHead = group.roles.includes('head')
    const hasGenerated = group.roles.includes('generated')
    const hasApproved = group.roles.includes('approved')
    const hasLoadedDirty = hasHead && loaded.dirty && !pendingDrift
    const commitOnlyApproved = hasApproved && hasLoadedDirty && !approved
    const labels = group.roles.map((role) => role === 'generated' ? 'Review generated' : role === 'approved' ? 'Approved by you' : 'HEAD')
    const title = timelineTitle(group.sha, labels)
    const roleIcons = (
      <>
        {hasGenerated && <I.changed />}
        {hasGenerated && hasApproved && <span className="cm-div"></span>}
        {hasApproved && <I.check className={commitOnlyApproved ? 'cm-commit-approved' : undefined} />}
      </>
    )

    const tip = (
      <>
        {timelineTipContent(group.sha, labels)}
        {hasLoadedDirty && <span className="l2">Working tree: +{dirtyAdd} -{dirtyDel} uncommitted</span>}
      </>
    )
    if (hasHead && (hasGenerated || hasApproved || hasLoadedDirty)) {
      return (
        <Tooltip key={group.sha} className="cm-merge" tipClassName="cm-tip" tabIndex={0} role="button" content={tip} aria-label={title}>
          {roleIcons}
          {(hasGenerated || hasApproved) && <span className="cm-div"></span>}
          <span className="cm-sha">{shortSha(group.sha)}</span>
          {hasLoadedDirty && <I.edit className="cm-dirty-ico" />}
        </Tooltip>
      )
    }
    if (hasHead) {
      return <Tooltip key={group.sha} className="cm-head" tipClassName="cm-tip" tabIndex={0} role="button" content={tip} aria-label={title}>{shortSha(group.sha)}</Tooltip>
    }
    if (hasGenerated && hasApproved) {
      return <Tooltip key={group.sha} className="cm-merge" tipClassName="cm-tip" tabIndex={0} role="button" content={tip} aria-label={title}>{roleIcons}</Tooltip>
    }
    return (
      <Tooltip key={group.sha} className={'cm-pin ' + (hasApproved ? 'appr' : 'gen')} tipClassName="cm-tip" tabIndex={0} role="button" content={tip} aria-label={title}>
        {hasApproved ? <I.check /> : <I.changed />}
      </Tooltip>
    )
  }

  return (
    <span className="ctmark">
      {generatedSha && generatedOffTimeline && (
        <Tooltip className="cm-off" tipClassName="cm-tip" tabIndex={0} role="button"
          aria-label={`Review is off history · ${shortSha(generatedSha)}`}
          content={timelineTipContent(generatedSha, ['Review is off history'])}>
          <I.changed />
          <span className="cm-off-text">off history</span>
        </Tooltip>
      )}
      <Tooltip className="cm-pin" tipClassName="cm-tip" tabIndex={0} role="button" aria-label={`Branch start · ${shortSha(skeleton.mergeBase)}`}
        content={timelineTipContent(skeleton.mergeBase, [base || 'Branch start'])}>
        <I.branch />
      </Tooltip>
      {timelineGroups.map((group, i) => {
        const prevPos = i === 0 ? commits.length : timelineGroups[i - 1].pos
        const n = Math.max(0, prevPos - group.pos)
        const drift = group.roles.includes('head') && generatedShaInTimeline && generatedSha !== skeleton.headSha
        return (
          <Fragment key={group.sha}>
            <span className={'cm-arr' + (drift ? ' drift' : '')}>{n > 0 ? n : ''}</span>
            {renderTimelineStop(group)}
          </Fragment>
        )
      })}
      {pendingDrift && (
        <DriftFetchPill drift={pendingDrift} loadedSha={skeleton.headSha} onPull={onReload} open={fakeDriftOpen} />
      )}
      {watchStopped && (
        <WatchPausedPill reason={watchStopped.reason} />
      )}
    </span>
  )
}
