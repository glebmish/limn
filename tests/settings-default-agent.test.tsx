import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import { SettingsDialog } from '../src/renderer/components/SettingsDialog'
import { useStore } from '../src/renderer/store'
import type { AgentRef } from '../src/shared/types'

// zustand v5's bare `useStore()` reads getInitialState() for the SSR snapshot (see
// review-sidebar.test.tsx) — seed `defaultAgent` by mutating that object directly.
type State = ReturnType<typeof useStore.getState>
const initial = (): State => (useStore as unknown as { getInitialState: () => State }).getInitialState()
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
})
