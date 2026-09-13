import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import { SettingsDialog } from '../src/renderer/components/SettingsDialog'
import { ActionsSettings } from '../src/renderer/components/ActionsSettings'
import { useStore } from '../src/renderer/store'
import type { ActionDef } from '../src/shared/types'
import type { CommandAvailability } from '../src/shared/actions'
import { initialStateOf } from './helpers/store'

type State = ReturnType<typeof useStore.getState>
const initial = (): State => initialStateOf(useStore)
function seed(patch: Partial<State>): void {
  Object.assign(initial() as unknown as Record<string, unknown>, patch)
}
afterEach(() => seed({ settingsTab: 'agents', actions: [], commands: {}, seenCommands: [], loaded: null }))

const SIMPLIFY: ActionDef = { id: 'a', kind: 'skill', name: 'Simplify', body: 'simplify' }
const REBASE: ActionDef = { id: 'b', kind: 'prompt', name: 'Rebase onto main', body: 'Rebase this branch onto main and resolve conflicts. Keep both sides.' }
const avail = (engine: 'claude' | 'codex', over: Partial<CommandAvailability> = {}): CommandAvailability =>
  ({ engine, repo: '/r/acme-api', names: ['simplify'], checkedAt: new Date().toISOString(), state: 'ok', ...over })

describe('SettingsDialog — tabs', () => {
  it('shows Agents by default and switches its heading and body for the Actions tab', () => {
    const agents = renderToStaticMarkup(<SettingsDialog onClose={() => {}} />)
    expect(agents).toContain('role="tab" aria-selected="true" class="on">Agents')
    expect(agents).toContain('Default review agent')
    seed({ settingsTab: 'actions' })
    const actions = renderToStaticMarkup(<SettingsDialog onClose={() => {}} />)
    expect(actions).toContain('<h2 id="settings-title">Actions</h2>')
    expect(actions).toContain('Pinned actions')
    expect(actions).not.toContain('Default review agent')
    expect(actions).not.toContain('Actions are global')
  })
})

describe('ActionsSettings — the list', () => {
  it('renders the empty state and the New action button when nothing is pinned', () => {
    const html = renderToStaticMarkup(<ActionsSettings repo={null} />)
    expect(html).toContain('No actions yet')
    expect(html).toContain('New action')
    expect(html).not.toContain('ax-srow')
  })

  it('renders one row per action in order: kind glyph, name, sub-label, edit/delete', () => {
    seed({ actions: [SIMPLIFY, REBASE] })
    const html = renderToStaticMarkup(<ActionsSettings repo={null} />)
    const rows = html.split('class="ax-srow"').slice(1)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toContain('aria-label="skill">/')
    expect(rows[0]).toContain('<b>Simplify</b><i>/simplify · findings</i>')
    expect(rows[1]).toContain('aria-label="prompt">“')
    expect(rows[1]).toContain('<b>Rebase onto main</b><i>Rebase this branch onto main and resolve conflicts. Keep both sides.</i>')
    expect(html).toContain('aria-label="Edit Simplify"')
    expect(html).toContain('aria-label="Delete Rebase onto main"')
    expect(html).toContain('draggable="true"')
  })

  it('shows engine marks on skill rows only when two engines resolve, and the probe line for the repo', () => {
    seed({ actions: [SIMPLIFY, REBASE], commands: { '/r/acme-api': [avail('claude'), avail('codex', { names: ['review'], state: 'ok' })] } })
    const html = renderToStaticMarkup(<ActionsSettings repo="/r/acme-api" />)
    const rows = html.split('class="ax-srow"').slice(1)
    expect(rows[0]).toContain('data-mark="ok"')
    expect(rows[0]).toContain('data-mark="no"')
    expect(rows[0]).toContain('Codex did not report $simplify')
    expect(rows[1].split('ax-acts')[0]).not.toContain('ax-eng')
    expect(html).toContain("Availability from each engine")
    expect(html).toContain('acme-api')
    expect(html).toContain('Refresh')
  })

  it('hides marks with a single engine and the probe line without a repo', () => {
    seed({ actions: [SIMPLIFY], commands: { '/r/acme-api': [avail('claude')] } })
    const one = renderToStaticMarkup(<ActionsSettings repo="/r/acme-api" />)
    expect(one.split('class="ax-srow"')[1].split('ax-acts')[0]).not.toContain('ax-engs')
    expect(one).toContain('Refresh')
    const none = renderToStaticMarkup(<ActionsSettings repo={null} />)
    expect(none).not.toContain('Refresh')
  })

  it('a checking probe pulses the mark and spins Refresh', () => {
    seed({ actions: [SIMPLIFY], commands: { '/r/acme-api': [avail('claude'), avail('codex', { state: 'checking' })] } })
    const html = renderToStaticMarkup(<ActionsSettings repo="/r/acme-api" />)
    expect(html).toContain('data-mark="chk"')
    expect(html).toContain('class="spin"')
    expect(html).toContain('checking…')
  })
})
