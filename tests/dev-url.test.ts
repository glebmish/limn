import { describe, it, expect } from 'vitest'
import { buildDevHooks, HOOK_KEYS } from '../scripts/dev-url-map.mjs'

describe('buildDevHooks', () => {
  it('maps LIMN_* env vars to the exact camelCase hook keys window.limnDev expects', () => {
    const hooks = buildDevHooks({
      LIMN_OPEN_CMPREF: '1',
      LIMN_OPEN_CHATLIST: '1',
      LIMN_ACTIVE_CHAT: '2',
      LIMN_FLOW: 'chat'
    } as NodeJS.ProcessEnv)
    // Regression for the camel()-derivation bug: it produced `openCmpref`/`openChatlist`
    // (lowercase tail), which RefPicker.tsx / ChatDropdown.tsx never read.
    expect(hooks).toEqual({ openCmpRef: true, openChatList: true, activeChat: 2, flow: 'chat' })
  })

  it('ignores unset env vars', () => {
    expect(buildDevHooks({} as NodeJS.ProcessEnv)).toEqual({})
  })

  it('every HOOK_KEYS value is a real key declared on Window["limnDev"]', () => {
    // Type-level guarantee: assigning into this type fails `tsc --noEmit` the moment
    // HOOK_KEYS (scripts/dev-url-map.mts) holds a key that isn't an actual limnDev
    // field (src/renderer/api.d.ts) — a typo or a stale/renamed hook can't compile.
    type LimnDevHook = keyof NonNullable<Window['limnDev']>
    const values = Object.values(HOOK_KEYS)
    expect(values.length).toBe(30)
    for (const v of values) {
      const k: LimnDevHook = v
      expect(typeof k).toBe('string')
    }
  })
})
