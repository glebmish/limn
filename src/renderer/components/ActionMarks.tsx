import type { ActionDef, EngineId } from '../../shared/types'
import type { CommandAvailability } from '../../shared/actions'
import { EngineGlyph } from '../kit'
import { markFor, markTitle, type Mark } from '../lib/actions'

const MARK_CLASS: Record<Mark, string> = { ok: '', no: ' no', chk: ' chk', unk: ' unk', bad: ' bad' }

/** One engine's availability mark (design board 14 L1): solid = reported, struck =
 *  did not, pulsing = checking, hollow = never checked, red = unreachable. */
export function EngineMark({ engine, mark, title }: { engine: EngineId; mark: Mark; title: string }) {
  return (
    <span className={'ax-eng' + MARK_CLASS[mark]} title={title} data-mark={mark}>
      <EngineGlyph engine={engine} />
    </span>
  )
}

/** The marks an action carries for each listed engine. */
export function ActionMarks({ action, engines, avail }: { action: ActionDef; engines: readonly EngineId[]; avail: readonly CommandAvailability[] }) {
  if (engines.length === 0) return null
  return (
    <span className="ax-engs">
      {engines.map((engine) => {
        const a = avail.find((x) => x.engine === engine)
        const mark = markFor(action, a)
        return <EngineMark key={engine} engine={engine} mark={mark} title={markTitle(action, engine, a, mark)} />
      })}
    </span>
  )
}

/** The kind glyph: `/` for a skill, `“` for a prompt. */
export function KindGlyph({ kind, small }: { kind: ActionDef['kind']; small?: boolean }) {
  return <span className={'ax-kind' + (kind === 'skill' ? ' skill' : '') + (small ? ' sm' : '')} aria-label={kind}>{kind === 'skill' ? '/' : '“'}</span>
}

/** "checked 2 min ago" for a probe line. */
export function checkedAgo(avail: CommandAvailability | undefined): string {
  if (!avail) return 'not checked'
  if (avail.state === 'checking') return 'checking…'
  if (avail.state === 'unknown') return 'not checked'
  if (avail.state === 'failed') return 'could not be reached'
  const s = Math.max(0, Math.floor((Date.now() - new Date(avail.checkedAt).getTime()) / 1000))
  if (Number.isNaN(s) || s < 60) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.floor(m / 60)
  return h < 24 ? `${h} h ago` : `${Math.floor(h / 24)} d ago`
}
