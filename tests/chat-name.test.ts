import { describe, expect, it } from 'vitest'
import type { ChatThread } from '../src/shared/types'
import { chatName } from '../src/renderer/components/ChatDropdown'

const t = (id: number, extra: Partial<ChatThread> = {}): ChatThread => ({ id, kind: 'user', agent: { engine: 'claude' }, messages: [], createdAt: 't', ...extra } as ChatThread)
const act = (id: number, name: string): ChatThread => t(id, { title: name, action: { actionId: `act-${name}`, name, kind: 'prompt' } })

describe('chatName for action threads', () => {
  it('a lone action thread is named for the action; repeats of the same action are numbered in launch order', () => {
    const all = [act(1, 'Rebase onto main'), act(2, 'Simplify'), act(3, 'Rebase onto main'), act(4, 'Rebase onto main')]
    expect(chatName(all[1], all)).toBe('Simplify')
    expect(chatName(all[0], all)).toBe('Rebase onto main · 1')
    expect(chatName(all[2], all)).toBe('Rebase onto main · 2')
    expect(chatName(all[3], all)).toBe('Rebase onto main · 3')
  })
})
