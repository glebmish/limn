import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import { SettingsDialog } from '../src/renderer/components/SettingsDialog'
import { useStore } from '../src/renderer/store'
import type { AgentRef } from '../src/shared/types'
import { initialStateOf } from './helpers/store'

// seed `defaultAgent` by mutating the initial state object directly (see
// tests/helpers/store.ts).
type State = ReturnType<typeof useStore.getState>
const initial = (): State => initialStateOf(useStore)
function seedDefaultAgent(a: AgentRef): void {
  ;(initial() as unknown as { defaultAgent: AgentRef }).defaultAgent = a
}
afterEach(() => seedDefaultAgent({ engine: 'claude' }))

describe('SettingsDialog — default review agent', () => {
  it('shows the "Agents" heading, a "Default review agent" label, and an AgentPicker trigger seeded from the store', () => {
    seedDefaultAgent({ engine: 'codex' })
    const html = renderToStaticMarkup(<SettingsDialog onClose={() => {}} />)
    expect(html).toContain('Agents')
    expect(html).toContain('Default review agent')
    expect(html).toMatch(/class="ag-trigger"[^>]*>[\s\S]*?Codex/)
  })

  it('associates the "Default review agent" label with the picker trigger via aria-labelledby, not a generic aria-label', () => {
    const html = renderToStaticMarkup(<SettingsDialog onClose={() => {}} />)
    const labelMatch = html.match(/<label id="([^"]+)">Default review agent<\/label>/)
    expect(labelMatch).not.toBeNull()
    const labelId = labelMatch![1]
    const triggerMatch = html.match(/<button class="ag-trigger"[^>]*>/)
    expect(triggerMatch).not.toBeNull()
    const trigger = triggerMatch![0]
    expect(trigger).toContain(`aria-labelledby="${labelId}"`)
    expect(trigger).not.toContain('aria-label="agent"')
  })
})
